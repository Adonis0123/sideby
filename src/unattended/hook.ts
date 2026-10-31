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
// most three times in a row, and keeps a Pending Decision when that did not help (Turn Retry, ADR-0067). A failure
// before the decision is made does nothing: that is
// how a session behaves without the feature (unlike `network-hook`, which blocks when it cannot tell). Once the
// decision is to refuse, it refuses: keeping the Pending Decision and writing the reason are best effort, and their
// failure neither allows the call nor adds any output of its own.
import { resolvePaths } from '../core/paths.ts'
import { addPendingDecision } from '../core/unattended-pending.ts'
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

export const UNATTENDED_HOOK_COMMAND = 'sideby unattended-hook'

/** The tool each Host's model asks the user with. */
export const ASK_TOOLS: Readonly<Record<string, string>> = {
  claude: 'AskUserQuestion',
  codex: 'request_user_input',
}

const STDIN_MAX = 8 * 1024 * 1024

type Env = Record<string, string | undefined>

export interface UnattendedHookDeps {
  now?: () => Date
  /** Turn Retry's wait; a real timer by default. */
  sleep?: (ms: number) => Promise<void>
  /** Whether the Host that started the hook is gone (`ppid` 1 by default): nothing is left to wake. */
  parentGone?: () => boolean
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

/** What the model reads instead of an answer. */
export function questionReason(state: UnattendedState, now: Date, zh: boolean, kept: boolean): string {
  const until = state.until ? clockText(Date.parse(state.until), now.getTime(), zh) : undefined
  const session = state.reason === 'session'
  if (zh) {
    const when = session ? '（这个会话）' : until ? `（到 ${until}）` : '（没有结束时间）'
    const keep = kept ? 'sideby 已把这个问题记下，等用户回来看' : 'sideby 没能记下这个问题，请写进最终汇报'
    return `未显示：sideby 无人值守已开启${when}，现在没人能回答，${keep}。不要再问。能撤回的选择按推荐的选项继续，在最终汇报里写出这个问题和你的选择。删除、对外发送或发布、部署、付费等难撤回的操作不要做：跳过它，运行 \`sideby unattended defer "<一句话>"\` 记下，再继续做其余的事。`
  }
  const when = session ? 'for this session' : until ? `until ${until}` : 'with no end set'
  const keep = kept
    ? 'sideby kept this question for the user to look at later'
    : 'sideby could not keep this question, so put it in your final report'
  return `Not shown: sideby's Unattended Mode is on ${when}, so nobody is here to answer, and ${keep}. Do not ask again. Where the choice can be undone, go on with the recommended option, and list the question and your choice in your final report. Do not do anything hard to undo (deleting, sending or posting anything outside, publishing, deploying, paying): skip it, record it with \`sideby unattended defer "<one sentence>"\`, and go on with the rest.`
}

/** How much of the end of the model's last message is read to tell whether it ends on a question. */
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
 * question. Code blocks (``` and ~~~), inline code and quoted lines (`> …`) are left out first, then the last
 * {@link QUESTION_TAIL} characters are read: a line that starts with the `需要你拍板` marker (from it to the end); a last line that ends with `?`
 * or `？`, or a list of options at the end right after such a line; or one of {@link QUESTION_PATTERNS} in the last
 * paragraph (and the one before it when the last is a list), unless a negation comes just before it ("无需你来决定").
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
  const from = Math.max(0, stop - QUESTION_TAIL)
  const tail = plain.slice(from, stop)
  if (!tail.trim()) return undefined
  const kept = (at: number) => written.slice(from + at, stop).trim()
  const heading = DECIDE_HEADING.exec(tail)
  if (heading) return kept(heading.index)
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

/** What the model reads when it ended its turn on a question and nobody is here to answer. */
export function stopReason(state: UnattendedState, now: Date, zh: boolean, kept: boolean): string {
  const until = state.until ? clockText(Date.parse(state.until), now.getTime(), zh) : undefined
  const session = state.reason === 'session'
  if (zh) {
    const when = session ? '（这个会话）' : until ? `（到 ${until}）` : '（没有结束时间）'
    const keep = kept ? 'sideby 已把你的问题记下，等用户回来看' : 'sideby 没能记下你的问题，请写进最终汇报'
    return `没人能回答：sideby 无人值守已开启${when}，${keep}。不要等回复，也不要再问。能撤回的选择按推荐的选项继续，一直做到完。删除、对外发送或发布、部署、付费等难撤回的操作不要做：跳过它，运行 \`sideby unattended defer "<一句话>"\` 记下，再做完其余的事。最后写一份最终汇报，列出你做的每个选择和记下的每件事，不提任何问题。`
  }
  const when = session ? 'for this session' : until ? `until ${until}` : 'with no end set'
  const keep = kept
    ? 'sideby kept your question for the user to look at later'
    : 'sideby could not keep your question, so put it in your final report'
  return `Nobody is here to answer: sideby's Unattended Mode is on ${when}, and ${keep}. Do not wait for an answer and do not ask again. Where the choice can be undone, go on with the recommended option and carry on to the end. Do not do anything hard to undo (deleting, sending or posting anything outside, publishing, deploying, paying): skip it, record it with \`sideby unattended defer "<one sentence>"\`, and finish the rest. Then end with a final report that lists each choice you made and each item you recorded, without asking anything.`
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

/** Words that run the next word as the command: the program is the word after them (and their options). */
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

/** What the model reads instead of the permission prompt Claude Code would have shown. */
export function permissionReason(state: UnattendedState, now: Date, kept: boolean): string {
  const until = state.until ? clockText(Date.parse(state.until), now.getTime(), false) : undefined
  const when = state.reason === 'session' ? 'for this session' : until ? `until ${until}` : 'with no end set'
  const keep = kept ? ' sideby kept this request for the user to look at later.' : ''
  return `Not allowed: Claude Code wanted a person to confirm this action, and nobody is here (sideby's Unattended Mode is on ${when}).${keep} Rewrite it so it needs no confirmation: literal paths, "\${VAR:?}" for variables in rm targets, plain bash syntax, and rm as a command of its own. Or skip it, record it with \`sideby unattended defer "<what and why>"\`, and go on with the rest.`
}

/**
 * A refusal: the reason for the model, and what to keep, if anything. `json`: the answer is this object on stdout
 * with exit 0 (a PermissionRequest decision, a Stop block, an Elicitation decline); otherwise exit 2 with the reason
 * on stderr.
 */
interface Refusal {
  json?: (reason: string) => unknown
  reason: (kept: boolean) => string
  keep?: () => Promise<unknown>
}

/** What to do with this call: undefined allows it. Any error here allows it too (the caller catches it). */
async function decide(
  argv: readonly string[],
  env: Env,
  input: AsyncIterable<string | Uint8Array> | string,
  now: Date,
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
  const { schedule } = await readUnattendedConfig(paths.configFile)
  const override = await readUnattendedOverride(paths.stateDir)
  const state = unattendedState({ schedule, override, now, session: env[UNATTENDED_ENV] === '1' })
  if (!state.on) return undefined
  const raw = early ?? (await readInput(input))
  const zh = prefersChinese(env)
  const account = text(env.SIDEBY_ACCOUNT, 256)
  if (stop || elicitation) {
    const v = parseObject(raw)
    if (!v) return undefined
    const sessionId = text(v.session_id, 256)
    const cwd = text(v.cwd)
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
  const payload = parsePayload(raw)
  if (!payload) return undefined
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
      reason: (kept) => questionReason(state, now, zh, kept),
      keep: () =>
        addPendingDecision(
          paths.stateDir,
          {
            kind: 'question',
            family,
            ...(account ? { account } : {}),
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
  let refusal: Refusal | undefined
  const now = deps.now ? deps.now() : new Date()
  try {
    refusal = await decide(argv, env, input, now)
  } catch {
    return 0
  }
  if (!refusal) return 0
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

/** Whether Unattended Mode is on right now, read fresh from the Schedule and the manual state. */
async function isOn(env: Env, now: Date): Promise<boolean> {
  const paths = resolvePaths(env)
  const { schedule } = await readUnattendedConfig(paths.configFile)
  const override = await readUnattendedOverride(paths.stateDir)
  return unattendedState({ schedule, override, now, session: env[UNATTENDED_ENV] === '1' }).on
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
  if (!error || !passingFailure(error, said) || !(await isOn(env, now))) {
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
  if (!(await isOn(env, clock()))) return undefined
  return retryMessage(error, text(v.last_assistant_message, 1000) ?? '', streak.count, prefersChinese(env))
}
