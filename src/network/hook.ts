// Entry for `sideby network-hook <family> <event>` (spec §3.35, ADR-0053). A Host runs it before every prompt and tool
// call in a session sideby started with Network Guard on, so it imports only Node built-ins and leaf modules: never
// the Runtime, a Family index or core/accounts.ts. Unlike `handoff-hook` it exists to stop the Host: exit 2 with the
// reason on stderr blocks the prompt or the tool call; anything it cannot tell blocks too, after asking again for up to
// about 30 seconds (a prompt the Host made itself is not sent again once blocked).
import { spawn } from 'node:child_process'
import {
  blockMessage,
  type CheckMoment,
  NETWORK_ENV,
  prefersChinese,
  refresh,
  type Sleep,
  type TraceFetcher,
  verdict,
} from '../core/egress.ts'

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
  const allow = (env[NETWORK_ENV.allow] ?? '').split(',').filter(Boolean)
  // Not a session sideby started with Network Guard (the hook was copied somewhere): nothing to guard.
  if (!url || !dir) return 0
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
  const moment = MOMENTS[event]
  if (!moment) return 0
  try {
    const v = await verdict({
      ...common,
      allow,
      moment,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      background: () => (deps.background ?? startRefresh)(family, env),
    })
    if (v.status === 'ok') return 0
    err.write(
      `${blockMessage(v, allow, { ref: env.SIDEBY_LABEL || env.SIDEBY_ACCOUNT, at: moment, zh: prefersChinese(env) })}\n`,
    )
    return 2
  } catch {
    err.write(
      `${
        prefersChinese(env)
          ? '已拦截：sideby 的网络检查出错，没能确认网络出口。重新发送试试；一直出错就运行 `sideby network check`。'
          : "Blocked: sideby's network check failed and could not tell this network's exit. Try again; if it keeps failing, run `sideby network check`."
      }\n`,
    )
    return 2
  }
}
