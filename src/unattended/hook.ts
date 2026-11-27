// Entry for `sideby unattended-hook <family> <event>` (spec §3.37, ADR-0058). Claude Code and Codex run it before the
// ask tool and when the model ends its turn (`Stop`), and Claude Code also when it is about to ask the user for a
// permission (`PermissionRequest`) and when an MCP server asks the user to fill in a form (`Elicitation`), in every
// session sideby starts once the config has an `unattended` section. It imports only Node built-ins and leaf modules:
// never the Runtime, a Family index or core/accounts.ts. It reads the Schedule and the manual state on every call, so
// a session started before a Slot stops asking once the Slot begins.
//
// While Unattended Mode is off it does nothing (no output, exit 0). While on, it refuses the Host's ask tool (exit 2,
// the reason on stderr, which both Hosts hand to the model) and keeps the question as a Pending Decision; it answers
// Claude Code's permission requests with a denial (JSON on stdout: Claude Code does not honor exit 2 for that event),
// keeping the request as a Pending Decision too; it keeps a turn going once when the model ended it on a question
// written as plain text (`{"decision":"block","reason":…}` on stdout), keeping the question; and it declines an MCP
// server's form, keeping what the server asked. In Claude it also runs in the background after a turn that failed for
// a passing reason (`StopFailure`, `asyncRewake`): it waits, then wakes the session with exit 2 so the turn goes on, at
// most three times in a row, and keeps a Pending Decision when that did not help (Turn Retry, ADR-0067). And in Claude
// it runs in the background on every prompt (`UserPromptSubmit`, `async`): a prompt a person typed makes that session
// an Attended Session for 30 minutes, which it leaves alone as if the mode were off, telling the user once (ADR-0075).
// A question or a permission prompt Claude Code shows, in an Attended Session or while the mode is off, is watched in
// the background (Answer Wait, ADR-0077): once it has waited `unattended.answerWait` minutes with nobody answering and
// the mode is on, it is refused as the mode would refuse it, and so is a turn that ended on a question written as text
// (a second `Stop` entry, `asyncRewake`). It never answers anything with "yes".
// A failure before the decision is made does nothing: that is
// how a session behaves without the feature (unlike `network-hook`, which blocks when it cannot tell). Once the
// decision is to refuse, it refuses: keeping the Pending Decision and writing the reason are best effort, and their
// failure neither allows the call nor adds any output of its own.
import { constants as fsConstants, type Stats } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { lstatOrNull } from '../core/fs-safe.ts'
import { resolvePaths } from '../core/paths.ts'
import { hostMade, launchPrompt, sidebyMessage } from '../core/prompt-origin.ts'
import {
  ATTENDED_MS,
  markAttended,
  markTold,
  ownTranscript,
  promptOrigin,
  readAttended,
  sessionUnattended,
} from '../core/unattended-attended.ts'
import {
  addPendingDecision,
  type PendingDecision,
  type PendingInput,
  withdrawPendingDecision,
} from '../core/unattended-pending.ts'
import {
  clearRetryStreak,
  countFailure,
  passingFailure,
  RETRY_LIMIT,
  readRetryStreak,
  retryDelay,
  retryGaveUpText,
  retryMessage,
} from '../core/unattended-retry.ts'
import {
  clockText,
  readUnattendedConfig,
  readUnattendedOverride,
  UNATTENDED_ENV,
  type UnattendedState,
  unattendedState,
} from '../core/unattended-state.ts'
import { lastLook, type ScreenMark, waitedMinutes, watchScreen } from '../core/unattended-wait.ts'

export const UNATTENDED_HOOK_COMMAND = 'sideby unattended-hook'

/** The tool each Host's model asks the user with (ADR-0058, ADR-0089). */
export const ASK_TOOLS: Readonly<Record<string, string>> = {
  claude: 'AskUserQuestion',
  codex: 'request_user_input',
  agy: 'ask_question',
}

const AGY_TRANSCRIPT_TAIL = 2 * 1024 * 1024

const STDIN_MAX = 8 * 1024 * 1024

type Env = Record<string, string | undefined>

export interface UnattendedHookDeps {
  now?: () => Date
  /** Turn Retry's wait; a real timer by default. */
  sleep?: (ms: number) => Promise<void>
  /** Whether the Host that started the hook is gone (`ppid` 1 by default): nothing is left to wake. */
  parentGone?: () => boolean
  /** The Host's pid, whose session record says what is on screen (Answer Wait); `process.ppid` by default. */
  hostPid?: number
  /** Answer Wait, for tests: runs once the wait is over, before the last check. */
  beforeAct?: () => Promise<unknown>
  /** Answer Wait, for tests: runs after the Pending Decision is kept, before the check that may take it back. */
  afterKeep?: () => Promise<unknown>
}

function prefersChinese(env: Env): boolean {
  return /^zh/i.test(env.LC_ALL || env.LC_MESSAGES || env.LANG || '')
}

async function readInput(input: AsyncIterable<string | Uint8Array> | string): Promise<string> {
  if (typeof input === 'string') return input
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of input) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
    size += b.length
    if (size > STDIN_MAX) return ''
    chunks.push(b)
  }
  return Buffer.concat(chunks).toString('utf8')
}

interface Payload {
  tool: string
  input: Record<string, unknown>
  account?: string
  sessionId?: string
  cwd?: string
  /** Claude Code names the subagent a request comes from. */
  agentId?: string
  agentType?: string
}

const text = (v: unknown, max = 4096): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined

function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(raw) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** WHY: Antigravity CLI, Desktop App and IDE share `~/.gemini/config/hooks.json`; only handle CLI payloads across main and extra Accounts (ADR-0089, ADR-0090). */
const AGY_ACCOUNT_DIR_RE = /^antigravity-cli(?:-(?!main$)[a-z0-9][a-z0-9-]{0,31})?$/
const AGY_ACCOUNT_REF_RE = /^agy:(?:main|(?!main$)[a-z0-9][a-z0-9-]{0,31})$/
const AGY_CONV_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

interface AgyVerifiedPath {
  account: string
  realFile?: string
  lst?: Stats
}

async function verifyAgyHomePath(
  rawPath: string,
  home: string,
  opts: { isTranscript: boolean; requireFile: boolean; convId?: string },
): Promise<AgyVerifiedPath | undefined> {
  if (!rawPath || rawPath.includes('\0') || !isAbsolute(rawPath)) return undefined
  if (rawPath.split(/[/\\]/).includes('..')) return undefined
  if (opts.isTranscript && !rawPath.endsWith('.jsonl')) return undefined

  const geminiDir = join(home, '.gemini')
  const geminiLst = await lstatOrNull(geminiDir)
  if (!geminiLst?.isDirectory() || geminiLst.isSymbolicLink()) return undefined
  let realGemini: string
  try {
    realGemini = await realpath(geminiDir)
  } catch {
    return undefined
  }

  const lst = await lstatOrNull(rawPath)
  if (opts.isTranscript && lst && (lst.isSymbolicLink() || !lst.isFile())) return undefined
  if (opts.requireFile && (!lst || lst.isSymbolicLink() || !lst.isFile())) return undefined

  let rel: string | undefined
  let realFile: string | undefined
  if (lst) {
    try {
      realFile = await realpath(rawPath)
    } catch {
      return undefined
    }
    if (!realFile.startsWith(`${realGemini}${sep}`)) return undefined
    rel = realFile.slice(realGemini.length + sep.length)
  } else {
    const resolved = resolve(rawPath)
    for (const root of [resolve(geminiDir), realGemini]) {
      if (resolved.startsWith(`${root}${sep}`)) {
        rel = resolved.slice(root.length + sep.length)
        break
      }
    }
    if (!rel) return undefined
  }

  const segs = rel.split(sep).filter(Boolean)
  const accountSeg = segs[0]
  if (!accountSeg || !AGY_ACCOUNT_DIR_RE.test(accountSeg) || segs.length < 2) return undefined

  const accountDir = join(geminiDir, accountSeg)
  const accountLst = await lstatOrNull(accountDir)
  if (!accountLst?.isDirectory() || (accountSeg !== 'antigravity-cli' && accountLst.isSymbolicLink()))
    return undefined

  // Walk every intermediate existing segment under accountDir so symlinks cannot redirect outside.
  let cur = accountDir
  for (const s of segs.slice(1, opts.isTranscript && lst ? -1 : segs.length)) {
    cur = join(cur, s)
    const segLst = await lstatOrNull(cur)
    if (!segLst) break
    if (segLst.isSymbolicLink()) return undefined
  }

  if (opts.isTranscript && opts.convId) {
    if (segs[1] !== 'brain' || segs[2] !== opts.convId || segs.length < 4) return undefined
  }
  const account =
    accountSeg === 'antigravity-cli' ? 'agy:main' : `agy:${accountSeg.slice('antigravity-cli-'.length)}`
  return { account, ...(realFile ? { realFile } : {}), ...(lst ? { lst } : {}) }
}

interface AgyCliContext {
  account?: string
  transcript?: { realFile: string; lst: Stats }
}

async function resolveAgyCliContext(
  v: Record<string, unknown>,
  env: Env,
  home: string,
  requireTranscriptFile: boolean,
): Promise<AgyCliContext | undefined> {
  const rawSideby = text(env.SIDEBY_ACCOUNT, 256)
  if (rawSideby && !AGY_ACCOUNT_REF_RE.test(rawSideby)) return undefined
  if (
    v.conversationId !== undefined &&
    (typeof v.conversationId !== 'string' || !AGY_CONV_ID_RE.test(v.conversationId))
  )
    return undefined
  const convId = typeof v.conversationId === 'string' ? v.conversationId : undefined
  const rawTranscript =
    typeof v.transcriptPath === 'string' && v.transcriptPath ? v.transcriptPath : undefined
  const rawArtifact =
    typeof v.artifactDirectoryPath === 'string' && v.artifactDirectoryPath
      ? v.artifactDirectoryPath
      : undefined

  if (rawTranscript || rawArtifact) {
    const tr = rawTranscript
      ? await verifyAgyHomePath(rawTranscript, home, {
          isTranscript: true,
          requireFile: requireTranscriptFile,
          ...(convId ? { convId } : {}),
        })
      : undefined
    if (rawTranscript && !tr) return undefined
    const art = rawArtifact
      ? await verifyAgyHomePath(rawArtifact, home, { isTranscript: false, requireFile: false })
      : undefined
    if (rawArtifact && !art) return undefined
    const verifiedAccount = tr?.account ?? art?.account
    if (tr && art && tr.account !== art.account) return undefined
    if (rawSideby && rawSideby !== verifiedAccount) return undefined
    return {
      ...(verifiedAccount ? { account: verifiedAccount } : {}),
      ...(tr?.realFile && tr.lst ? { transcript: { realFile: tr.realFile, lst: tr.lst } } : {}),
    }
  }

  if (rawSideby || env[UNATTENDED_ENV] === '1') {
    return rawSideby ? { account: rawSideby } : {}
  }
  return undefined
}

async function parseAgyPayload(raw: string, env: Env, home: string): Promise<Payload | undefined> {
  const v = parseObject(raw)
  const tc = v?.toolCall
  if (!v || !tc || typeof tc !== 'object' || Array.isArray(tc)) return undefined
  const ctx = await resolveAgyCliContext(v, env, home, false)
  if (!ctx) return undefined
  const call = tc as Record<string, unknown>
  if (typeof call.name !== 'string') return undefined
  const input =
    call.args && typeof call.args === 'object' && !Array.isArray(call.args)
      ? (call.args as Record<string, unknown>)
      : {}
  const sessionId = text(v.conversationId, 256)
  const cwd = text(v.cwd) ?? (Array.isArray(v.workspacePaths) ? text(v.workspacePaths[0]) : undefined)
  return {
    tool: call.name,
    input,
    ...(ctx.account ? { account: ctx.account } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(cwd ? { cwd } : {}),
  }
}

/** WHY: ADR-0089 / ADR-0090 `agy` Stop omits `lastAssistantMessage`; read only the tail of a verified `.jsonl` inside `~/.gemini/antigravity-cli[-<name>]/` with fd identity checks. */
async function readAgyTranscriptTail(realFile: string, lst: Stats): Promise<string | undefined> {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(realFile, flags)
    const st = await fh.stat()
    if (!st.isFile() || st.dev !== lst.dev || st.ino !== lst.ino) return undefined
    const len = Math.min(st.size, AGY_TRANSCRIPT_TAIL)
    if (len <= 0) return undefined
    const buf = Buffer.alloc(len)
    const { bytesRead } = await fh.read(buf, 0, len, st.size - len)
    const chunk = buf.subarray(0, bytesRead).toString('utf8')
    let last: string | undefined
    for (const rawLine of chunk.split('\n')) {
      const line = rawLine.trim()
      if (!line.startsWith('{')) continue
      try {
        const obj = JSON.parse(line) as unknown
        if (
          obj &&
          typeof obj === 'object' &&
          !Array.isArray(obj) &&
          (obj as Record<string, unknown>).type === 'PLANNER_RESPONSE' &&
          typeof (obj as Record<string, unknown>).content === 'string'
        ) {
          last = ((obj as Record<string, unknown>).content as string).trim()
        }
      } catch {
        // WHY: ignore a partial first line after tail seek or malformed JSONL line (ADR-0089).
      }
    }
    return last || undefined
  } catch {
    return undefined
  } finally {
    await fh?.close().catch(() => {})
  }
}

function parsePayload(raw: string): Payload | undefined {
  try {
    const v = parseObject(raw)
    if (!v || typeof v.tool_name !== 'string') return undefined
    const input =
      v.tool_input && typeof v.tool_input === 'object' ? (v.tool_input as Record<string, unknown>) : {}
    const sessionId = text(v.session_id, 256)
    const cwd = text(v.cwd)
    // Kept only when plain: anything else from the Host is left out.
    const plain = (x: unknown) => (typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(x) ? x : undefined)
    const agentId = plain(v.agent_id)
    const agentType = plain(v.agent_type)
    return {
      tool: v.tool_name,
      input,
      ...(sessionId ? { sessionId } : {}),
      ...(cwd ? { cwd } : {}),
      ...(agentId ? { agentId } : {}),
      ...(agentType ? { agentType } : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * The question as the user should read it later: each question (with its short header) and its options' labels.
 * Claude's `AskUserQuestion` and Codex's `request_user_input` both take a `questions` list; anything else is kept as
 * the tool's input.
 */
export function questionText(input: Record<string, unknown>): string {
  const list = Array.isArray(input.questions) ? input.questions : [input]
  const parts: string[] = []
  for (const q of list) {
    if (!q || typeof q !== 'object') continue
    const r = q as Record<string, unknown>
    const question = text(r.question) ?? text(r.prompt) ?? text(r.message)
    const head = [text(r.header, 200), question].filter(Boolean).join(': ')
    const options = (Array.isArray(r.options) ? r.options : [])
      .map((o) => (typeof o === 'string' ? text(o) : text((o as Record<string, unknown> | null)?.label)))
      .filter((o): o is string => Boolean(o))
    const lines = [head, ...options.map((o) => `- ${o}`)].filter(Boolean)
    if (lines.length) parts.push(lines.join('\n'))
  }
  return parts.join('\n\n') || JSON.stringify(input)
}

/**
 * What the model reads instead of an answer. `waited`: the question was on screen this many minutes with nobody
 * answering (Answer Wait); the session shows the text too, so it opens with what happened for the person coming back.
 */
export function questionReason(
  state: UnattendedState,
  now: Date,
  zh: boolean,
  kept: boolean,
  waited?: number,
): string {
  const until = state.until ? clockText(Date.parse(state.until), now.getTime(), zh) : undefined
  const session = state.reason === 'session'
  if (zh) {
    const when = session ? '（这个会话）' : until ? `（到 ${until}）` : '（没有结束时间）'
    const keep = kept ? 'sideby 已把这个问题记下，等用户回来看' : 'sideby 没能记下这个问题，请写进最终汇报'
    const head = waited
      ? `${waited} 分钟没人回答：sideby 无人值守已开启${when}，会话不再等回答，${keep}。`
      : `未显示：sideby 无人值守已开启${when}，现在没人能回答，${keep}。`
    return `${head}不要再问。能撤回的选择按推荐的选项继续，在最终汇报里写出这个问题和你的选择。删除、对外发送或发布、部署、付费等难撤回的操作不要做：跳过它，运行 \`sideby unattended defer "<一句话>"\` 记下，再继续做其余的事。用户自己的规则或项目文档已对这类操作常设授权的，照那份授权做。`
  }
  const when = session ? 'for this session' : until ? `until ${until}` : 'with no end set'
  const keep = kept
    ? 'sideby kept this question for the user to look at later'
    : 'sideby could not keep this question, so put it in your final report'
  const head = waited
    ? `No answer after ${minutesText(waited)}: sideby's Unattended Mode is on ${when}, so the session goes on without one, and ${keep}.`
    : `Not shown: sideby's Unattended Mode is on ${when}, so nobody is here to answer, and ${keep}.`
  return `${head} Do not ask again. Where the choice can be undone, go on with the recommended option, and list the question and your choice in your final report. Do not do anything hard to undo (deleting, sending or posting anything outside, publishing, deploying, paying): skip it, record it with \`sideby unattended defer "<one sentence>"\`, and go on with the rest. Where the user's own rules or project docs already give standing permission for that kind of action, follow that permission instead.`
}

const minutesText = (n: number): string => (n === 1 ? '1 minute' : `${n} minutes`)

/**
 * How much of the end of the model's last message is read to tell whether it ends on a question. The `需要你拍板`
 * marker is looked for in the whole message instead (`endingQuestion`).
 */
export const QUESTION_TAIL = 600

/**
 * Ways a model asks the user in plain text, in English and Chinese, checked against the end of its last message (the
 * last paragraph, and the one before it when the last is a list of options). Kept to asks that wait for an answer:
 * a closing such as "Let me know if you have any questions" or "如有问题随时告诉我" is not one.
 */
export const QUESTION_PATTERNS: readonly RegExp[] = [
  /\b(?:do you )?want me to\b/i,
  /\b(?:should|shall) I\b/i,
  /\bwould you (?:like|prefer)\b/i,
  /\bdo you (?:want|prefer)\b/i,
  /\blet me know (?:which|whether|what you|how you|if I should|if you(?:'d| would)? (?:like|want|prefer) me to)\b/i,
  /\bwhich (?:one |option )?(?:do|would) you (?:prefer|like|choose|pick)\b/i,
  /\b(?:your call|up to you)\b/i,
  /\bplease confirm\b/i,
  /\b(?:when|once) you(?:'re| are) back\b/i,
  /\bwaiting (?:for|on) your\b/i,
  /要不要|需不需要|是否要|是否需要/,
  /你来决定|由你决定|需要你决定|你决定一下|你来定|你定一下|你拍板|你来选|你选一个|你选哪|选哪个/,
  /等你回来|你回来后|你回来再/,
  /请确认|请你确认|确认一下|帮我确认/,
  /你看呢|你觉得呢|你看怎么样|可以吗|行吗|好吗/,
]

/**
 * The marker agent rules often prescribe for a question written as text: at the start of a line, with or without
 * `#` and emphasis, and with or without text after a colon. Finished reports do not use it.
 */
const DECIDE_HEADING =
  /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?(?:需要你拍板|Needs your decision)(?:\*\*|__)?[ \t]*(?:[:：].*)?$/im
const LIST_LINE = /^[ \t]*(?:[-*+•]|\d+[.)、]|[A-Za-z][.)]|[（(]?[A-Za-z0-9一二三四五六七八九十][)）])[ \t]+/
/** A question mark at the end of a line, before only closing quotes, brackets, emphasis or spaces. */
const ENDS_ON_QUESTION = /[?？][\s*_"'”’)）\]】」』]*$/

/** Words that, just before an ask, turn it into a statement ("无需你来决定", "no need to confirm"). */
const NEGATION =
  /(?:无需|无须|不用|不需要|不必|没必要|没有|\bno need\b|\bdon'?t need\b|\bnot\b|\bnever\b)[^.!?。！？\n]{0,6}$/i

/** Whether `pattern` matches `text` somewhere that is not negated just before it. */
function asks(pattern: RegExp, text: string): boolean {
  for (const m of text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`)))
    if (!NEGATION.test(text.slice(Math.max(0, m.index - 16), m.index))) return true
  return false
}

/**
 * The part of the model's last message that asks the user something, or undefined when it does not end on a
 * question. Code blocks (``` and ~~~), inline code and quoted lines (`> …`) are left out first. A line anywhere in
 * the rest that starts with the `需要你拍板` / `Needs your decision` marker asks (from the first such line to the end):
 * a report often goes on for a long while after it. Otherwise only the last {@link QUESTION_TAIL} characters are
 * read: a last line that ends with `?` or `？`, or a list of options at the end right after such a line; or one of
 * {@link QUESTION_PATTERNS} in the last paragraph (and the one before it when the last is a list), unless a negation
 * comes just before it ("无需你来决定").
 */
export function endingQuestion(message: string): string | undefined {
  // Judged on a copy where code and quotes are blanked out at the same length, so a span of it is the same span of
  // the message as written: that span is what is kept for the user, inline code and all.
  const written = message.replace(/\r\n?/g, '\n')
  const blank = (m: string) => m.replace(/[^\n]/g, ' ')
  const plain = written
    .replace(/^[ \t]*(```|~~~)[\s\S]*?(?:^[ \t]*\1[^\n]*$|(?![\s\S]))/gm, blank)
    .replace(/`[^`\n]*`/g, (m) => 'x'.repeat(m.length))
    .replace(/^[ \t]*>.*$/gm, blank)
  const stop = plain.trimEnd().length
  const heading = DECIDE_HEADING.exec(plain.slice(0, stop))
  if (heading) return written.slice(heading.index, stop).trim()
  const from = Math.max(0, stop - QUESTION_TAIL)
  const tail = plain.slice(from, stop)
  if (!tail.trim()) return undefined
  const kept = (at: number) => written.slice(from + at, stop).trim()
  // Each paragraph with where it starts in the tail.
  const paragraphs: { at: number; text: string }[] = []
  let at = 0
  for (const sep of [...tail.matchAll(/\n[ \t]*\n/g), { index: tail.length, 0: '' }]) {
    const text = tail.slice(at, sep.index)
    if (text.trim()) paragraphs.push({ at: at + (text.length - text.trimStart().length), text: text.trim() })
    at = sep.index + sep[0].length
  }
  const last = paragraphs.at(-1)
  if (!last) return undefined
  const isList = last.text.split('\n').some((l) => LIST_LINE.test(l))
  const first = isList && paragraphs.length > 1 ? paragraphs.at(-2)! : last
  const zone = tail.slice(first.at)
  const question = kept(first.at)
  // The last line, or the line just before a list of options that ends the message.
  const lines = tail.split('\n').filter((l) => l.trim())
  let line = lines.length - 1
  if (ENDS_ON_QUESTION.test(lines[line] ?? '')) return question
  while (line >= 0 && LIST_LINE.test(lines[line]!)) line--
  if (line >= 0 && line < lines.length - 1 && ENDS_ON_QUESTION.test(lines[line]!)) return question
  if (QUESTION_PATTERNS.some((p) => asks(p, zone))) return question
  return undefined
}

/**
 * What the model reads when it ended its turn on a question and nobody is here to answer. `waited`: the question was
 * left this many minutes with no reply (Answer Wait); this note then wakes the session, and is not the user's reply.
 */
export function stopReason(
  state: UnattendedState,
  now: Date,
  zh: boolean,
  kept: boolean,
  waited?: number,
): string {
  const until = state.until ? clockText(Date.parse(state.until), now.getTime(), zh) : undefined
  const session = state.reason === 'session'
  if (zh) {
    const when = session ? '（这个会话）' : until ? `（到 ${until}）` : '（没有结束时间）'
    const keep = kept ? 'sideby 已把你的问题记下，等用户回来看' : 'sideby 没能记下你的问题，请写进最终汇报'
    const head = waited
      ? `${waited} 分钟没人回复你的问题：sideby 无人值守已开启${when}，${keep}。这条不是用户的回复。`
      : `没人能回答：sideby 无人值守已开启${when}，${keep}。`
    return `${head}不要等回复，也不要再问。能撤回的选择按推荐的选项继续，一直做到完。删除、对外发送或发布、部署、付费等难撤回的操作不要做：跳过它，运行 \`sideby unattended defer "<一句话>"\` 记下，再做完其余的事。用户自己的规则或项目文档已对这类操作常设授权的，照那份授权做。最后写一份最终汇报，列出你做的每个选择和记下的每件事，不提任何问题。`
  }
  const when = session ? 'for this session' : until ? `until ${until}` : 'with no end set'
  const keep = kept
    ? 'sideby kept your question for the user to look at later'
    : 'sideby could not keep your question, so put it in your final report'
  const head = waited
    ? `Nobody replied to your question for ${minutesText(waited)}: sideby's Unattended Mode is on ${when}, and ${keep}. This note is not the user's reply.`
    : `Nobody is here to answer: sideby's Unattended Mode is on ${when}, and ${keep}.`
  return `${head} Do not wait for an answer and do not ask again. Where the choice can be undone, go on with the recommended option and carry on to the end. Do not do anything hard to undo (deleting, sending or posting anything outside, publishing, deploying, paying): skip it, record it with \`sideby unattended defer "<one sentence>"\`, and finish the rest. Where the user's own rules or project docs already give standing permission for that kind of action, follow that permission instead. Then end with a final report that lists each choice you made and each item you recorded, without asking anything.`
}

/** What a declined MCP form is kept as: the server's name and what it asked, never a field's value. */
export function elicitationText(v: Record<string, unknown>): string {
  const server = text(v.mcp_server_name, 200)
  const message = text(v.message, 1000)
  return [server ? `MCP ${server}` : 'MCP', message].filter(Boolean).join(': ')
}

/** Tools whose kept summary is the file they work on, and the field it is in. */
const FILE_TOOLS: Readonly<Record<string, string>> = {
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
}

/** Programs that run another one, each with its options that take a value of their own (`sudo -u root`, `nice -n 10`). */
const WRAPPERS: Record<string, readonly string[]> = {
  sudo: ['-u', '-g', '-C', '-h', '-p', '-U', '-r', '-t', '-T', '-D', '--user', '--group'],
  doas: ['-u', '-C'],
  env: ['-u', '-C', '-P', '--unset', '--chdir'],
  nice: ['-n', '--adjustment'],
  time: ['-f', '-o', '--format', '--output'],
  exec: ['-a'],
  command: [],
  builtin: [],
  nohup: [],
}

/**
 * The program a command runs, by its file name only: the first word after `NAME=value` settings and wrappers such as
 * `sudo` and `env`. Undefined when it cannot be told plainly (a quote, a variable, a subshell, anything but a name).
 * Nothing else of the command is kept: its arguments can hold a token in any form.
 */
export function commandProgram(command: string): string | undefined {
  const words = command.trim().split(/\s+/)
  let i = 0
  let wrapper: readonly string[] | undefined
  while (i < words.length) {
    const w = words[i]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      // A setting before the command; a quoted value may hold spaces, which leaves the rest unclear.
      if (/^[A-Za-z_][A-Za-z0-9_]*=["']/.test(w)) return undefined
      i++
      continue
    }
    if (wrapper && w.startsWith('-')) {
      i += wrapper.includes(w) ? 2 : 1
      continue
    }
    const name = w.slice(w.lastIndexOf('/') + 1)
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(name)) return undefined
    if (Object.hasOwn(WRAPPERS, name)) {
      wrapper = WRAPPERS[name]
      i++
      continue
    }
    return name
  }
  return undefined
}

/**
 * What a refused permission request is kept as, from a short list of fields per tool and never the whole input (an
 * MCP tool's input can carry a header with a token): for Bash the program alone and the model's own description of
 * the command, never its arguments (the whole command stays in the session's own record, reached through "back to
 * the session"); the file of Read, Write, Edit, MultiEdit and NotebookEdit; the host WebFetch was to open; for any
 * other tool its name only.
 */
export function permissionText(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Bash') {
    const command = text(input.command)
    const program = command ? commandProgram(command) : undefined
    const about = text(input.description, 500)
    return `${program ? `${tool}: ${program}` : tool}${about ? `\n(${about})` : ''}`
  }
  const field = FILE_TOOLS[tool]
  if (field) {
    const file = text(input[field])
    return file ? `${tool}: ${file}` : tool
  }
  if (tool === 'WebFetch') {
    const url = text(input.url)
    try {
      return url ? `${tool}: ${new URL(url).hostname}` : tool
    } catch {
      return tool
    }
  }
  return tool
}

/**
 * What the model reads instead of the permission prompt Claude Code would have shown. `waited`: the prompt was on
 * screen this many minutes with nobody answering (Answer Wait).
 */
export function permissionReason(state: UnattendedState, now: Date, kept: boolean, waited?: number): string {
  const until = state.until ? clockText(Date.parse(state.until), now.getTime(), false) : undefined
  const when = state.reason === 'session' ? 'for this session' : until ? `until ${until}` : 'with no end set'
  const keep = kept ? ' sideby kept this request for the user to look at later.' : ''
  const head = waited
    ? `Not allowed: nobody confirmed this action in ${minutesText(waited)}, and sideby's Unattended Mode is on ${when}.`
    : `Not allowed: Claude Code wanted a person to confirm this action, and nobody is here (sideby's Unattended Mode is on ${when}).`
  return `${head}${keep} Rewrite it so it needs no confirmation: literal paths, "\${VAR:?}" for variables in rm targets, plain bash syntax, and rm as a command of its own. Or skip it, record it with \`sideby unattended defer "<what and why>"\`, and go on with the rest.`
}

/**
 * What the user reads once in an Attended Session while Unattended Mode is on (ADR-0075), as a `systemMessage`: shown
 * in the session, never to the model.
 */
export function attendedNotice(state: UnattendedState, zh: boolean): string {
  const session = state.reason === 'session'
  if (zh)
    return `sideby：你在，这个会话在你最后一条消息后 30 分钟内照常问你。${session ? '它是按无人值守启动的，30 分钟没人打字后恢复。' : '其他会话仍然无人值守。要全部关掉，运行 `sideby unattended off`。'}`
  return `sideby: you're here, so this session asks you as usual for 30 minutes after your last message. ${session ? 'It was started unattended, and goes back to that once nobody has typed for 30 minutes.' : 'Other sessions stay unattended. To turn Unattended Mode off everywhere, run `sideby unattended off`.'}`
}

/**
 * An answer to the Host: a refusal (the reason for the model, and what to keep, if anything), or in an Attended
 * Session a notice for the user that lets the call go on. `json`: the answer is this object on stdout with exit 0 (a
 * PermissionRequest decision, a Stop block, an Elicitation decline, a `systemMessage`); otherwise exit 2 with the
 * reason on stderr.
 */
interface Refusal {
  json?: (reason: string) => unknown
  reason: (kept: boolean) => string
  keep?: () => Promise<unknown>
}

/**
 * What to do with this call: undefined allows it. Any error here allows it too (the caller catches it). A permission
 * request (in Claude, also the ask tool's) that is not refused at once may first wait for a person (Answer Wait).
 */
async function decide(
  argv: readonly string[],
  env: Env,
  input: AsyncIterable<string | Uint8Array> | string,
  now: Date,
  deps: UnattendedHookDeps,
): Promise<Refusal | undefined> {
  const [family = '', event = ''] = argv
  const askTool = ASK_TOOLS[family]
  const permission = family === 'claude' && event === 'PermissionRequest'
  const elicitation = family === 'claude' && event === 'Elicitation'
  const stop = Boolean(askTool) && event === 'Stop'
  if (!permission && !elicitation && !stop && (event !== 'PreToolUse' || !askTool)) return undefined
  const paths = resolvePaths(env)
  // A turn that finished ends the session's run of retried failures (Turn Retry), whether Unattended Mode is on or
  // not: a wait left from earlier must never wake a session whose turn is already done.
  let early: string | undefined
  if (stop && family === 'claude') {
    early = await readInput(input)
    const sessionId = text(parseObject(early)?.session_id, 256)
    if (sessionId) await clearRetryStreak(paths.stateDir, sessionId).catch(() => {})
  }
  const { schedule, answerWait } = await readUnattendedConfig(paths.configFile)
  const override = await readUnattendedOverride(paths.stateDir)
  const state = unattendedState({ schedule, override, now, session: env[UNATTENDED_ENV] === '1' })
  // Answer Wait: what Claude Code shows is watched while the mode is off too, since it may come on before anyone answers.
  const watch = permission && answerWait !== null
  if (!state.on && !watch) return undefined
  const raw = early ?? (await readInput(input))
  const zh = prefersChinese(env)
  const account = text(env.SIDEBY_ACCOUNT, 256)
  /**
   * An Attended Session (ADR-0075) is left alone, as when the mode is off: undefined while the session is not one.
   * Where a `systemMessage` reaches the user (`Stop`, the ask tool's `PreToolUse`), the first such call of a stretch
   * tells them once.
   */
  const attended = async (
    sessionId: string | undefined,
    tell: boolean,
  ): Promise<{ answer?: Refusal } | undefined> => {
    if (family !== 'claude' || !sessionId) return undefined
    const r = await readAttended(paths.stateDir, sessionId, now)
    if (!r) return undefined
    if (!tell || r.toldAt) return {}
    return {
      answer: {
        json: (systemMessage) => ({ systemMessage }),
        reason: () => attendedNotice(state, zh),
        keep: () => markTold(paths.stateDir, sessionId, r.since, now),
      },
    }
  }
  if (stop || elicitation) {
    const v = parseObject(raw)
    if (!v) return undefined
    const isAgy = family === 'agy'
    const sessionId = isAgy ? text(v.conversationId, 256) : text(v.session_id, 256)
    const here = await attended(sessionId, stop)
    if (here) return here.answer
    const cwd =
      text(v.cwd) ?? (isAgy && Array.isArray(v.workspacePaths) ? text(v.workspacePaths[0]) : undefined)
    const where = {
      family,
      ...(account ? { account } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(cwd ? { cwd } : {}),
    }
    if (elicitation)
      return {
        json: () => ({ hookSpecificOutput: { hookEventName: 'Elicitation', action: 'decline' } }),
        reason: () => '',
        keep: () =>
          addPendingDecision(paths.stateDir, { kind: 'question', ...where, text: elicitationText(v) }, now, {
            dedupe: true,
          }),
      }
    if (isAgy) {
      if (v.continuationActive === true) return undefined
      const term = typeof v.terminationReason === 'string' ? v.terminationReason : ''
      if (term && term !== 'NO_TOOL_CALL') return undefined
      const direct =
        typeof v.lastAssistantMessage === 'string' && v.lastAssistantMessage.trim()
          ? v.lastAssistantMessage
          : typeof v.last_assistant_message === 'string' && v.last_assistant_message.trim()
            ? v.last_assistant_message
            : undefined
      const agyCtx = await resolveAgyCliContext(v, env, paths.home, !direct)
      if (!agyCtx) return undefined
      const agyWhere = {
        ...where,
        ...(agyCtx.account ? { account: agyCtx.account } : {}),
      }
      const message =
        direct ??
        (agyCtx.transcript
          ? ((await readAgyTranscriptTail(agyCtx.transcript.realFile, agyCtx.transcript.lst)) ?? '')
          : '')
      const question = endingQuestion(message)
      if (!question) return undefined
      return {
        json: (reason) => ({ decision: 'continue', reason }),
        reason: (kept) => stopReason(state, now, zh, kept),
        keep: () =>
          addPendingDecision(paths.stateDir, { kind: 'question', ...agyWhere, text: question }, now, {
            dedupe: true,
          }),
      }
    }
    // Once per stop: a turn the hook already kept going ends as the model leaves it.
    if (v.stop_hook_active !== false) return undefined
    const message = typeof v.last_assistant_message === 'string' ? v.last_assistant_message : ''
    const question = endingQuestion(message)
    if (!question) return undefined
    return {
      json: (reason) => ({ decision: 'block', reason }),
      reason: (kept) => stopReason(state, now, zh, kept),
      keep: () =>
        addPendingDecision(paths.stateDir, { kind: 'question', ...where, text: question }, now, {
          dedupe: true,
        }),
    }
  }
  const payload = family === 'agy' ? await parseAgyPayload(raw, env, paths.home) : parsePayload(raw)
  if (!payload) return undefined
  const payloadAccount = payload.account ?? account
  if (permission) {
    // Asked in front of someone (an Attended Session) or while the mode is off: shown, and watched while it waits.
    const shown = state.on ? await attended(payload.sessionId, false) : {}
    if (shown) return watch ? answerAfterWait(payload, env, now.getTime(), deps) : undefined
  } else if (payload.tool === askTool) {
    const here = await attended(payload.sessionId, true)
    if (here) return here.answer
  }
  if (permission)
    return {
      json: (message) => ({
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } },
      }),
      reason: (kept) => permissionReason(state, now, kept),
      keep: () =>
        addPendingDecision(
          paths.stateDir,
          {
            kind: 'permission',
            family,
            ...(account ? { account } : {}),
            ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
            ...(payload.cwd ? { cwd: payload.cwd } : {}),
            ...(payload.agentId ? { agentId: payload.agentId } : {}),
            ...(payload.agentType ? { agentType: payload.agentType } : {}),
            text: permissionText(payload.tool, payload.input),
          },
          now,
          { dedupe: true },
        ),
    }
  if (payload.tool === askTool) {
    const question = questionText(payload.input)
    return {
      ...(family === 'agy' ? { json: (reason: string) => ({ decision: 'deny', reason }) } : {}),
      reason: (kept) => questionReason(state, now, zh, kept),
      keep: () =>
        addPendingDecision(
          paths.stateDir,
          {
            kind: 'question',
            family,
            ...(payloadAccount ? { account: payloadAccount } : {}),
            ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
            ...(payload.cwd ? { cwd: payload.cwd } : {}),
            text: question,
          },
          now,
          { dedupe: true },
        ),
    }
  }
  return undefined
}

/**
 * Returns the exit code: 0 lets the Host go on, 2 refuses the tool call (the reason is written to `err`). A permission
 * request, a stop on a question and an MCP form are answered with exit 0 and the decision written to `out`. Errors
 * before the decision write nothing and exit 0; once it is a refusal, it is answered as one whatever happens to the
 * record.
 */
export async function runUnattendedHook(
  argv: readonly string[],
  env: Env,
  input: AsyncIterable<string | Uint8Array> | string,
  io: { out: { write(s: string): unknown }; err: { write(s: string): unknown } },
  deps: UnattendedHookDeps = {},
): Promise<number> {
  if (argv[0] === 'claude' && argv[1] === 'UserPromptSubmit') {
    // In the background: its output and exit code change nothing, and it never holds a prompt back.
    await notePrompt(env, input, deps).catch(() => {})
    return 0
  }
  if (argv[0] === 'claude' && argv[1] === 'StopWait') {
    // In the background (`asyncRewake`): exit 2 wakes the idle session with the note on stderr.
    try {
      const wake = await wakeAfterWait(env, input, deps)
      if (!wake) return 0
      io.err.write(`${wake}\n`)
      return 2
    } catch {
      return 0
    }
  }
  if (argv[0] === 'claude' && argv[1] === 'StopFailure') {
    try {
      const wake = await retryAfterFailure(env, input, deps)
      if (!wake) return 0
      io.err.write(`${wake}\n`)
      return 2
    } catch {
      return 0
    }
  }
  const agyStop = argv[0] === 'agy' && argv[1] === 'Stop'
  const allowStop = () => {
    if (agyStop) {
      try {
        io.out.write('{"decision":""}\n')
      } catch {
        // WHY: best effort on closed stdout (ADR-0089).
      }
    }
    return 0
  }
  let refusal: Refusal | undefined
  const now = deps.now ? deps.now() : new Date()
  try {
    refusal = await decide(argv, env, input, now, deps)
  } catch {
    return allowStop()
  }
  if (!refusal) return allowStop()
  let kept = true
  if (refusal.keep)
    try {
      await refusal.keep()
    } catch {
      // Best effort: the reason then asks for the question in the final report instead.
      kept = false
    }
  if (refusal.json) {
    try {
      io.out.write(`${JSON.stringify(refusal.json(refusal.reason(kept)))}\n`)
    } catch {
      // Nothing reached the Host: it goes on as it would without this hook (a prompt, a form, a stop).
    }
    return 0
  }
  try {
    io.err.write(`${refusal.reason(kept)}\n`)
  } catch {
    // The Host still sees exit 2 and refuses the call.
  }
  return 2
}

/**
 * Whether the session is unattended right now: Unattended Mode is on, read fresh from the Schedule and the manual
 * state, and the session is not an Attended Session.
 */
async function isOn(env: Env, now: Date, sessionId: string): Promise<boolean> {
  const paths = resolvePaths(env)
  return (
    await sessionUnattended({
      stateDir: paths.stateDir,
      configFile: paths.configFile,
      session: env[UNATTENDED_ENV] === '1',
      sessionId,
      now,
    })
  ).on
}

/** Unattended Mode for the whole computer (or this `--unattended` session) at `at`, read fresh; an Attended Session counts as on. */
async function modeAt(env: Env, at: Date): Promise<{ state: UnattendedState; answerWait: number | null }> {
  const paths = resolvePaths(env)
  const { schedule, answerWait } = await readUnattendedConfig(paths.configFile)
  const override = await readUnattendedOverride(paths.stateDir)
  return {
    state: unattendedState({ schedule, override, now: at, session: env[UNATTENDED_ENV] === '1' }),
    answerWait,
  }
}

/** The clock, the wait and the Host, as Answer Wait's watches use them. */
function waitTools(deps: UnattendedHookDeps) {
  const clock = () => (deps.now ? deps.now() : new Date()).getTime()
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const startPpid = process.ppid
  const parentGone = deps.parentGone ?? (() => process.ppid !== startPpid || process.ppid === 1)
  return { clock, sleep, parentGone, pid: deps.hostPid ?? startPpid }
}

/**
 * Watches what the session shows (`watchScreen`), then keeps the Pending Decision only while it is still so: one last
 * look just before keeping and again after, with the wait and the mode read afresh (a person may answer meanwhile, the
 * mode go off, or the wait be made longer). When the dialog ended or the wait is now never, nothing is decided
 * (undefined); when the longer wait has not passed or the mode is off, it goes on watching the same dialog. A decision
 * kept before such a change is taken back. Otherwise what the hook answers with: when it went on (`at`), how long it
 * waited, the mode then, and whether the decision was kept. What is left is the moment between the last look and the
 * Host reading the answer: a person who answers then has their answer applied and a denial that comes after it
 * changes nothing (ADR-0077); a wake-up is told it is not their reply.
 */
async function actAfterWait(opts: {
  env: Env
  deps: UnattendedHookDeps
  sessionId: string
  expect: 'waiting' | 'idle'
  start: number
  /** The dialog must have been put on screen by then (when the hook began); see `watchScreen`. */
  shownBy?: number
  moved?: () => Promise<boolean>
  keep: (at: Date, waited: number) => PendingInput
}): Promise<{ at: Date; waited: number; state: UnattendedState; kept: boolean } | undefined> {
  const { env, deps, sessionId } = opts
  const t = waitTools(deps)
  const settings = async () => {
    const m = await modeAt(env, new Date(t.clock()))
    return { wait: m.answerWait, on: m.state.on }
  }
  const look = {
    env,
    pid: t.pid,
    sessionId,
    startedAt: opts.start,
    clock: t.clock,
    parentGone: t.parentGone,
    settings,
    ...(opts.moved ? { moved: opts.moved } : {}),
  }
  const stateDir = resolvePaths(env).stateDir
  let mark: ScreenMark | undefined
  for (;;) {
    mark = await watchScreen({
      ...look,
      expect: opts.expect,
      sleep: t.sleep,
      ...(opts.shownBy !== undefined ? { shownBy: opts.shownBy } : {}),
      ...(mark ? { from: mark } : {}),
    })
    if (!mark) return undefined
    await deps.beforeAct?.()
    const first = await lastLook({ ...look, mark })
    if (first === 'stop') return undefined
    if (first === 'wait') continue
    const at = new Date(t.clock())
    const waited = waitedMinutes(opts.start, at.getTime())
    const { state } = await modeAt(env, at)
    let kept: PendingDecision | undefined
    try {
      kept = await addPendingDecision(stateDir, opts.keep(at, waited), at, { dedupe: true })
    } catch {
      // Best effort: the reason then asks for it in the final report instead.
    }
    await deps.afterKeep?.()
    const second = await lastLook({ ...look, mark })
    if (second === 'act') return { at, waited, state, kept: kept !== undefined }
    if (kept) await withdrawPendingDecision(stateDir, kept, at).catch(() => {})
    if (second === 'stop') return undefined
  }
}

/**
 * Answer Wait for a question or a permission prompt Claude Code shows (spec §3.37 item 7, ADR-0077): watches the
 * session record while the dialog stays on screen and, once it has waited `unattended.answerWait` minutes and
 * Unattended Mode is on (counting an Attended Session as on: nobody answered), refuses it as the mode would, keeping a
 * Pending Decision with how long it waited. Anything that says someone answered, or that it cannot tell, lets it be
 * (undefined): the record does not show a dialog (a subagent's request, which Claude Code shows only after the hooks,
 * or a session that shows none), the dialog ended or another took its place, the Host is gone, or the wait is now
 * never; looked at once more just before and after keeping the Pending Decision (`actAfterWait`); a dialog put on screen
 * after the hook began is another one (this one was answered meanwhile) and is never taken for it. It never answers
 * "yes": the only decision it gives is a denial.
 */
async function answerAfterWait(
  payload: Payload,
  env: Env,
  start: number,
  deps: UnattendedHookDeps,
): Promise<Refusal | undefined> {
  // Claude Code runs a subagent's hooks before it shows the prompt: holding one would hide it from the person.
  if (payload.agentId || !payload.sessionId) return undefined
  const sessionId = payload.sessionId
  const account = text(env.SIDEBY_ACCOUNT, 256)
  const where = {
    family: 'claude',
    ...(account ? { account } : {}),
    sessionId,
    ...(payload.cwd ? { cwd: payload.cwd } : {}),
  }
  const question = payload.tool === ASK_TOOLS.claude
  const done = await actAfterWait({
    env,
    deps,
    sessionId,
    expect: 'waiting',
    start,
    // The dialog this request put on screen was there before the hook began; one put up later is another dialog.
    shownBy: start,
    keep: (_at, waited) =>
      question
        ? { kind: 'question', ...where, text: questionText(payload.input), waited }
        : { kind: 'permission', ...where, text: permissionText(payload.tool, payload.input), waited },
  })
  if (!done) return undefined
  const { at, waited, state, kept } = done
  const deny = (message: string) => ({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } },
  })
  // Kept already (and checked after): the answer only says whether that worked.
  return {
    json: deny,
    reason: () =>
      question
        ? questionReason(state, at, prefersChinese(env), kept, waited)
        : permissionReason(state, at, kept, waited),
  }
}

/**
 * Answer Wait for a turn that ended on a question written as text (spec §3.37 item 7, ADR-0077): Claude's second `Stop`
 * entry, in the background (`asyncRewake`). When the session is not unattended right now (the mode is off, or it is an
 * Attended Session: otherwise the first `Stop` entry already keeps the turn going) and the last message ends on a
 * question, it watches the session record while the session waits for a prompt. Once nobody replied for
 * `unattended.answerWait` minutes and the mode is on, it keeps the question as a Pending Decision and returns the note
 * that wakes the session (exit 2). A new turn (a reply, a notification), a prompt someone typed after this `Stop` (the
 * Attended Session's record, which also catches a reply whose turn ended before this hook first read the record), the
 * Host gone, the wait set to never, or anything it cannot tell: undefined, nothing happens.
 */
async function wakeAfterWait(
  env: Env,
  input: AsyncIterable<string | Uint8Array> | string,
  deps: UnattendedHookDeps,
): Promise<string | undefined> {
  const t = waitTools(deps)
  const start = t.clock()
  const v = parseObject(await readInput(input))
  // Only a first Stop (`stop_hook_active` false) of the main session.
  if (v?.stop_hook_active !== false || v.agent_id !== undefined) return undefined
  const sessionId = text(v.session_id, 256)
  const message = typeof v.last_assistant_message === 'string' ? v.last_assistant_message : ''
  const question = sessionId ? endingQuestion(message) : undefined
  if (!sessionId || !question) return undefined
  if ((await modeAt(env, new Date(start))).answerWait === null) return undefined
  if (await isOn(env, new Date(start), sessionId)) return undefined
  const stateDir = resolvePaths(env).stateDir
  // Someone typed after this Stop: the question is answered, even when that turn already ended.
  const moved = async () => {
    const r = await readAttended(stateDir, sessionId, new Date(t.clock()))
    return r !== undefined && Date.parse(r.at) > start
  }
  const account = text(env.SIDEBY_ACCOUNT, 256)
  const cwd = text(v.cwd)
  const done = await actAfterWait({
    env,
    deps,
    sessionId,
    expect: 'idle',
    start,
    moved,
    keep: (_at, waited) => ({
      kind: 'question',
      family: 'claude',
      ...(account ? { account } : {}),
      sessionId,
      ...(cwd ? { cwd } : {}),
      text: question,
      waited,
    }),
  })
  if (!done) return undefined
  return stopReason(done.state, done.at, prefersChinese(env), done.kept, done.waited)
}

/** A prompt id as Claude Code writes it; anything else is not looked for. */
const PROMPT_ID = /^[A-Za-z0-9_.:-]{1,128}$/

/**
 * Claude's background `UserPromptSubmit` entry (spec §3.37 "有人在的会话", ADR-0075): makes the session an Attended
 * Session when a person typed the prompt. Not counted: a prompt Claude Code made itself, a Message `sideby send`
 * delivered, a prompt sideby put on the command line (or a session whose launch did not say which those are), a
 * subagent's, and any prompt whose line in the session's own transcript does not say `human` within the wait. The
 * transcript line decides, not the input: its text is checked as the prompt is, and its time is when the stretch is
 * counted from, so an input made by hand that names another file, the launch's prompt or an old prompt marks nothing
 * new. Nothing of the prompt is kept.
 */
async function notePrompt(
  env: Env,
  input: AsyncIterable<string | Uint8Array> | string,
  deps: UnattendedHookDeps,
): Promise<void> {
  const v = parseObject(await readInput(input))
  if (!v || v.agent_id !== undefined) return
  const sessionId = text(v.session_id, 256)
  const promptId = typeof v.prompt_id === 'string' && PROMPT_ID.test(v.prompt_id) ? v.prompt_id : undefined
  const prompt = typeof v.prompt === 'string' ? v.prompt : undefined
  const transcript = typeof v.transcript_path === 'string' ? v.transcript_path : undefined
  if (!sessionId || !promptId || prompt === undefined || !transcript) return
  const notTyped = (s: string) => hostMade(s) || sidebyMessage(s) || launchPrompt(s, env)
  if (notTyped(prompt) || !(await ownTranscript(transcript, sessionId, env))) return
  const clock = deps.now ?? (() => new Date())
  const line = await promptOrigin(transcript, promptId, {
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    clock: () => clock().getTime(),
  })
  if (line?.origin !== 'human' || line.text === undefined || line.at === undefined || notTyped(line.text))
    return
  const now = clock().getTime()
  const at = Math.min(line.at, now)
  if (at + ATTENDED_MS <= now) return
  const account = text(env.SIDEBY_ACCOUNT, 256)
  const cwd = text(v.cwd)
  await markAttended(
    resolvePaths(env).stateDir,
    { sessionId, family: 'claude', ...(account ? { account } : {}), ...(cwd ? { cwd } : {}) },
    new Date(at),
  )
}

/**
 * Turn Retry (spec §3.37 item 6, ADR-0067), Claude's background `StopFailure` hook (`asyncRewake`): Claude Code runs it
 * when a turn ends on an API error and ignores its output, but wakes the idle session when it exits 2, with its stderr
 * as the model's next note (checked with Claude Code 2.1.316). While Unattended Mode is on and the failure is a
 * passing one, it counts the failure for the session; up to `RETRY_LIMIT` in a row it waits 1, 2, then 4 minutes and
 * returns the note that wakes the session. Past the limit it keeps a Pending Decision and wakes nothing. It returns
 * nothing (exit 0) when the mode is off, the failure is not passing, there is no session id, or by the end of the wait
 * the mode went off, the Host is gone, or another failure or a finished turn has taken over the session's streak.
 */
async function retryAfterFailure(
  env: Env,
  input: AsyncIterable<string | Uint8Array> | string,
  deps: UnattendedHookDeps,
): Promise<string | undefined> {
  const clock = deps.now ?? (() => new Date())
  const now = clock()
  const v = parseObject(await readInput(input))
  if (!v) return undefined
  const sessionId = text(v.session_id, 256)
  if (!sessionId) return undefined
  const paths = resolvePaths(env)
  const error = typeof v.error === 'string' ? v.error : undefined
  const said = [text(v.last_assistant_message, 1000), text(v.error_details, 1000)].filter(Boolean).join(' ')
  // A later failure that is not retried (a used-up Quota, a lasting error) or comes while the mode is off still
  // takes over the session: the wait an earlier failure left must not wake it.
  if (!error || !passingFailure(error, said) || !(await isOn(env, now, sessionId))) {
    await clearRetryStreak(paths.stateDir, sessionId).catch(() => {})
    return undefined
  }
  const streak = await countFailure(paths.stateDir, sessionId, now)
  if (streak.count > RETRY_LIMIT) {
    const account = text(env.SIDEBY_ACCOUNT, 256)
    const cwd = text(v.cwd)
    await clearRetryStreak(paths.stateDir, sessionId).catch(() => {})
    await addPendingDecision(
      paths.stateDir,
      {
        kind: 'deferred',
        family: 'claude',
        ...(account ? { account } : {}),
        sessionId,
        ...(cwd ? { cwd } : {}),
        text: retryGaveUpText(error, text(v.last_assistant_message, 1000) ?? ''),
      },
      now,
      { dedupe: true },
    ).catch(() => {})
    return undefined
  }
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  await sleep(retryDelay(streak.count))
  if ((deps.parentGone ?? (() => process.ppid === 1))()) return undefined
  if ((await readRetryStreak(paths.stateDir, sessionId))?.token !== streak.token) return undefined
  if (!(await isOn(env, clock(), sessionId))) return undefined
  return retryMessage(error, text(v.last_assistant_message, 1000) ?? '', streak.count, prefersChinese(env))
}
