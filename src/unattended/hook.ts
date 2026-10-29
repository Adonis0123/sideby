// Entry for `sideby unattended-hook <family> <event>` (spec §3.37, ADR-0058). Claude Code and Codex run it before the
// ask tool, and Claude Code also when it is about to ask the user for a permission (`PermissionRequest`), in every
// session sideby starts once the config has an `unattended` section. It imports only Node built-ins and leaf modules:
// never the Runtime, a Family index or core/accounts.ts. It reads the Schedule and the manual state on every call, so
// a session started before a Slot stops asking once the Slot begins.
//
// While Unattended Mode is off it does nothing (no output, exit 0). While on, it refuses the Host's ask tool (exit 2,
// the reason on stderr, which both Hosts hand to the model) and keeps the question as a Pending Decision; and it
// answers Claude Code's permission requests with a denial (JSON on stdout: Claude Code does not honor exit 2 for that
// event), keeping the request as a Pending Decision too. A failure before the decision is made does nothing: that is
// how a session behaves without the feature (unlike `network-hook`, which blocks when it cannot tell). Once the
// decision is to refuse, it refuses: keeping the Pending Decision and writing the reason are best effort, and their
// failure neither allows the call nor adds any output of its own.
import { resolvePaths } from '../core/paths.ts'
import { addPendingDecision } from '../core/unattended-pending.ts'
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

function parsePayload(raw: string): Payload | undefined {
  try {
    const v = JSON.parse(raw) as Record<string, unknown> | null
    if (!v || typeof v !== 'object' || typeof v.tool_name !== 'string') return undefined
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
 * A refusal: the reason for the model, and what to keep, if anything. `json`: the answer is a PermissionRequest
 * decision on stdout; otherwise exit 2 with the reason on stderr.
 */
interface Refusal {
  json?: boolean
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
  if (!permission && (event !== 'PreToolUse' || !askTool)) return undefined
  const paths = resolvePaths(env)
  const { schedule } = await readUnattendedConfig(paths.configFile)
  const override = await readUnattendedOverride(paths.stateDir)
  const state = unattendedState({ schedule, override, now, session: env[UNATTENDED_ENV] === '1' })
  if (!state.on) return undefined
  const payload = parsePayload(await readInput(input))
  if (!payload) return undefined
  const zh = prefersChinese(env)
  const account = text(env.SIDEBY_ACCOUNT, 256)
  if (permission)
    return {
      json: true,
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
 * request is refused with exit 0 and the decision written to `out`. Errors before the decision write nothing and
 * exit 0; once it is a refusal, it is answered as one whatever happens to the record.
 */
export async function runUnattendedHook(
  argv: readonly string[],
  env: Env,
  input: AsyncIterable<string | Uint8Array> | string,
  io: { out: { write(s: string): unknown }; err: { write(s: string): unknown } },
  deps: UnattendedHookDeps = {},
): Promise<number> {
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
    const decision = { behavior: 'deny', message: refusal.reason(kept) }
    try {
      io.out.write(
        `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } })}\n`,
      )
    } catch {
      // Nothing reached Claude Code: it shows its prompt as it would without this hook.
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
