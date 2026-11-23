// Entry for `sideby network-hook <family> <event>` (spec §3.35, ADR-0053). A Host runs it before every prompt and tool
// call in a session sideby started with Network Guard on, so it imports only Node built-ins and leaf modules: never
// the Runtime, a Family index or core/accounts.ts. Unlike `handoff-hook` it exists to stop the Host: exit 2 with the
// reason on stderr blocks the prompt or the tool call; anything it cannot tell blocks too, after asking again for up to
// about 30 seconds. A prompt the Host made itself (a background task's notification) is not sent again once blocked,
// so Claude Code also runs the `Held` entry in the background: it keeps such a prompt in memory while the exit is not
// allowed, and wakes the session with it (exit 2) once a new check passes.
import { spawn } from 'node:child_process'
import { lstat, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  blockMessage,
  type CheckMoment,
  inCi,
  judge,
  NETWORK_ENV,
  prefersChinese,
  readNetworkConfig,
  refresh,
  routeLabel,
  type Sleep,
  type TraceFetcher,
  verdict,
} from '../core/egress.ts'
import { ownedFolder, readSmallFile, sha256, writeFileAtomic } from '../core/fs-safe.ts'
import { resolvePaths } from '../core/paths.ts'
import { HELD_CLOSE, HELD_OPEN, hookWakeUp, hostMade } from '../core/prompt-origin.ts'

export const NETWORK_HOOK_COMMAND = 'sideby network-hook'

/** The Host events this entry answers, and when each happens; `Refresh` is its own detached refresh. */
const MOMENTS: Record<string, CheckMoment> = { UserPromptSubmit: 'prompt', PreToolUse: 'tool' }

type Env = Record<string, string | undefined>

export interface NetworkHookDeps {
  fetcher?: TraceFetcher
  now?: () => Date
  print?: string
  /** Waits between tries of a check that could not tell; tests replace it. */
  sleep?: Sleep
  /** Starts the detached refresh; tests replace it. */
  background?: (family: string, env: Env) => void
  /** What the Host hands the hook on stdin; without it the hook decides as if it were given nothing. */
  input?: AsyncIterable<string | Uint8Array> | string
  /** Whether the Host that started the hook is gone (`ppid` 1 by default): nothing is left to wake. */
  parentGone?: () => boolean
}

/** A prompt larger than this is not read: the hook then decides as if it were given nothing. */
const STDIN_MAX = 1024 * 1024
/** Input that has not ended after this long is not waited for: the hook then decides as if it were given nothing. */
const STDIN_WAIT_MS = 5000
/** `Held` asks again after these waits, then every `HELD_EVERY_MS`: one request each time. */
export const HELD_DELAYS_MS = [15_000, 30_000] as const
export const HELD_EVERY_MS = 60_000
/** `Held` ends by itself after this long, two minutes before the 5 hours Claude Code gives it (core/network.ts). */
export const HELD_BUDGET_MS = 5 * 3600_000 - 120_000
/**
 * How long `Held` waits for the decision of the hook that checks the same prompt: the 60 seconds Claude Code gives
 * that hook (`CLAUDE_NETWORK_HOOK_TIMEOUT_S`, core/network.ts) and a little more.
 */
const DECISION_WAIT_MS = 65_000
const DECISION_POLL_MS = 200
/** A decision nobody read (a session started before `Held` existed) is removed after this long. */
const DECISION_KEPT_MS = 3600_000
/** The most of a held message that is handed over. */
const HELD_MAX_CHARS = 8000

type Decision = 'ok' | 'blocked'

async function readInput(input: NetworkHookDeps['input']): Promise<string> {
  if (input === undefined) return ''
  if (typeof input === 'string') return input
  const read = (async () => {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of input) {
      const b = Buffer.from(chunk)
      size += b.length
      if (size > STDIN_MAX) return ''
      chunks.push(b)
    }
    return Buffer.concat(chunks).toString('utf8')
  })()
  read.catch(() => {})
  // A Host that never ends the input must not keep the check from starting.
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      // Let go of the stream too: an open stdin would keep the process alive after the hook has decided.
      ;(input as { destroy?: () => unknown }).destroy?.()
      resolve('')
    }, STDIN_WAIT_MS)
  })
  try {
    return await Promise.race([read, late])
  } finally {
    clearTimeout(timer)
  }
}

/** The prompt and its id when the Host made the prompt itself; undefined for a typed prompt or unreadable input. */
async function hostMadePrompt(
  input: NetworkHookDeps['input'],
): Promise<{ id: string; prompt: string } | undefined> {
  try {
    const v = JSON.parse(await readInput(input)) as { prompt?: unknown; prompt_id?: unknown } | null
    if (!v || typeof v.prompt !== 'string' || typeof v.prompt_id !== 'string' || !v.prompt_id)
      return undefined
    return hostMade(v.prompt) ? { id: v.prompt_id, prompt: v.prompt } : undefined
  } catch {
    return undefined
  }
}

/** The file that tells `Held` what the checking hook decided for one prompt: named by a hash of the prompt's id. */
const decisionName = (id: string) => sha256(id).slice(0, 32)

/**
 * Keeps the decision for a prompt the Host made (`ok` or `blocked`, nothing of the prompt) where `Held` finds it, and
 * removes decisions nobody read. A failure changes nothing: `Held` then hands nothing over, as before it existed.
 */
async function keepDecision(dir: string, id: string, decision: Decision, now: number): Promise<void> {
  try {
    const folder = (await ownedFolder(dir, ['held'], { create: true, private: true }))!
    for (const name of await readdir(folder)) {
      const st = await lstat(join(folder, name)).catch(() => null)
      if (st && now - st.mtimeMs > DECISION_KEPT_MS) await unlink(join(folder, name)).catch(() => {})
    }
    await writeFileAtomic(join(folder, decisionName(id)), decision, 0o600)
  } catch {
    // no decision kept
  }
}

/** Reads the decision for a prompt and removes it; undefined while there is none. */
async function takeDecision(dir: string, id: string): Promise<Decision | undefined> {
  try {
    const folder = await ownedFolder(dir, ['held'], { create: false })
    if (!folder) return undefined
    const file = join(folder, decisionName(id))
    const text = await readSmallFile(file, 16)
    if (text === undefined) return undefined
    await unlink(file).catch(() => {})
    return text === 'ok' ? 'ok' : 'blocked'
  } catch {
    return undefined
  }
}

/** What the session is woken with: why the message is late, and the message between the two tags. */
function heldMessage(prompt: string, zh: boolean): string {
  // A wake-up that was blocked again carries the first message inside the tags: hand over that one alone.
  const from = prompt.indexOf(HELD_OPEN)
  const to = prompt.lastIndexOf(HELD_CLOSE)
  // Only a wake-up Claude Code made from a background hook's exit 2 carries a held message.
  const inner = hookWakeUp(prompt) && from !== -1 && to > from
  const whole = (inner ? prompt.slice(from + HELD_OPEN.length, to) : prompt).trim()
  const text = whole.slice(0, HELD_MAX_CHARS)
  const cut =
    whole.length > HELD_MAX_CHARS
      ? zh
        ? `\n（原文在 ${HELD_MAX_CHARS} 个字符处截断。）`
        : `\n(The message was cut at ${HELD_MAX_CHARS} characters.)`
      : ''
  const why = zh
    ? 'sideby 的网络检查在网络出口不被允许或查不出期间，扣住了一条 Claude Code 自己生成的消息（例如后台任务的结果）。现在可以送达了，原文如下：'
    : "sideby's Network Guard held back a message Claude Code made itself (such as a background task's result) while this network's exit was not allowed or could not be told. It can go through now. The message as it was:"
  return `${why}\n${HELD_OPEN}\n${text}\n${HELD_CLOSE}${cut}\n`
}

function startRefresh(family: string, env: Env): void {
  try {
    const entry = process.argv[1]
    if (!entry) return
    const child = spawn(process.execPath, [...process.execArgv, entry, 'network-hook', family, 'Refresh'], {
      detached: true,
      stdio: 'ignore',
      env: env as NodeJS.ProcessEnv,
    })
    child.on('error', () => {})
    child.unref()
  } catch {
    // the next call checks itself
  }
}

/** Returns the exit code: 0 lets the Host go on, 2 blocks (the reason is written to `err`). */
export async function runNetworkHook(
  argv: readonly string[],
  env: Env,
  err: { write(s: string): unknown },
  deps: NetworkHookDeps = {},
): Promise<number> {
  const [family = '', event = ''] = argv
  const url = env[NETWORK_ENV.url]
  const dir = env[NETWORK_ENV.dir]
  // Not a session sideby started with Network Guard (the hook was copied somewhere): nothing to guard.
  if (!url || !dir) return 0
  // In CI Network Guard makes no request (AGENTS.md, spec §3.35), also when a session's variables reach it there.
  if (inCi(env)) return 0
  // The switch and the list as config says now, so turning the check off or allowing a country in the Panel or with
  // `sideby network` reaches sessions already running. When config cannot be read, the list the session started with.
  const current = await readNetworkConfig(resolvePaths(env).configFile)
  // `Held` goes on when the check is off: a prompt blocked a moment before the switch still has to be handed over.
  const off = Boolean(current && !current.guard)
  if (off && event !== 'Held') return 0
  const allow = current?.allow ?? (env[NETWORK_ENV.allow] ?? '').split(',').filter(Boolean)
  const common = {
    url,
    env,
    dir,
    ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.print ? { print: deps.print } : {}),
  }
  if (event === 'Refresh') {
    await refresh(common)
    return 0
  }
  const clock = () => (deps.now?.() ?? new Date()).getTime()
  if (event === 'Held') {
    const made = await hostMadePrompt(deps.input)
    if (!made) return 0
    const sleep = deps.sleep ?? delay
    // The hook that checks this prompt says what it decided; no answer in time means it let the prompt through.
    const asked = clock()
    let decision: Decision | undefined
    while (true) {
      decision = await takeDecision(dir, made.id)
      if (decision || clock() - asked >= DECISION_WAIT_MS) break
      await sleep(DECISION_POLL_MS)
    }
    if (decision !== 'blocked') return 0
    const deliver = () => {
      err.write(heldMessage(made.prompt, prefersChinese(env)))
      return 2
    }
    if (off) return deliver()
    const parentGone = deps.parentGone ?? (() => process.ppid === 1)
    for (let i = 0; ; i++) {
      const wait = HELD_DELAYS_MS[i] ?? HELD_EVERY_MS
      if (clock() - asked + wait > HELD_BUDGET_MS) return 0
      await sleep(wait)
      if (parentGone()) return 0
      // As for every check: config as it is now, and the session's own list when config cannot be read.
      const now = await readNetworkConfig(resolvePaths(env).configFile)
      if (now && !now.guard) return deliver()
      const list = now?.allow ?? allow
      // Only a new answer that passes hands the message over; `refresh` never throws.
      if (judge((await refresh(common)).entry, list) === 'ok') return deliver()
    }
  }
  const moment = MOMENTS[event]
  if (!moment) return 0
  // A prompt the Host made itself is not sent again once blocked: tell `Held` what is decided for it.
  const made = event === 'UserPromptSubmit' ? await hostMadePrompt(deps.input) : undefined
  const decided = async (d: Decision) => {
    if (made) await keepDecision(dir, made.id, d, clock())
  }
  try {
    const v = await verdict({
      ...common,
      allow,
      moment,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      background: () => (deps.background ?? startRefresh)(family, env),
    })
    if (v.status === 'ok') {
      await decided('ok')
      return 0
    }
    await decided('blocked')
    err.write(
      `${blockMessage(v, allow, { ref: env.SIDEBY_LABEL || env.SIDEBY_ACCOUNT, at: moment, zh: prefersChinese(env), proxy: routeLabel(url, env) })}\n`,
    )
    return 2
  } catch {
    await decided('blocked')
    err.write(
      `${
        prefersChinese(env)
          ? `已拦截：sideby 的网络检查出错，没能确认网络出口。本次检查使用${routeLabel(url, env) === 'direct' ? '直连（direct）' : `代理 \`${routeLabel(url, env)}\``}。重新发送试试；旧会话可能要重开才能继承新的代理环境；一直出错就运行 \`sideby network diagnose\`。`
          : `Blocked: sideby's network check failed and could not tell this network's exit. This check used ${routeLabel(url, env) === 'direct' ? 'a direct connection (direct)' : `proxy \`${routeLabel(url, env)}\``}. Try again; an older session may need restarting to inherit a changed proxy environment; if it keeps failing, run \`sideby network diagnose\`.`
      }\n`,
    )
    return 2
  }
}
