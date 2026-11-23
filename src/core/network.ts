// Network Guard (spec §3.35, ADR-0053): which address each Account's Egress is checked at, the check before a
// Launch, and the hooks that keep checking inside a session sideby starts. The check itself is core/egress.ts.
import { mkdir, readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import type { Account, Env } from '../types.ts'
import type { Config } from './config.ts'
import {
  blockMessage,
  cacheKey,
  type EgressEntry,
  type EgressStatus,
  judge,
  NETWORK_ENV,
  prefersChinese,
  proxyFor,
  readEntry,
  refresh,
  routeLabel,
  type TraceFetcher,
  type Verdict,
  verdict,
} from './egress.ts'
import { UserError } from './errors.ts'
import { writeFileAtomic } from './fs-safe.ts'
import { type SessionHookPart, sessionHookArgs, sidebyHookCommand, withClaudeHooks } from './session-hooks.ts'
import { inCi } from './update.ts'

/** Families Network Guard covers in v1. */
export const GUARDED_FAMILIES = ['claude', 'codex'] as const

export const TRACE = {
  anthropic: 'https://api.anthropic.com/cdn-cgi/trace',
  chatgpt: 'https://chatgpt.com/cdn-cgi/trace',
} as const

/** Where an Account's Egress is checked, or why it is not. */
export type NetworkTarget = { url: string } | { skip: 'not-covered' | 'third-party' | 'api' }

function officialHost(value: string | undefined, host: string): boolean {
  if (!value) return true
  try {
    return new URL(value).hostname.toLowerCase() === host
  } catch {
    return false
  }
}

/**
 * The trace address that takes the same route as a Subscription Account's model requests: the vendor's own API
 * domain; none for an endpoint set to a third party. API Accounts are never checked (ADR-0079).
 * `env` is the Launch environment.
 */
export function networkTarget(account: Pick<Account, 'family' | 'kind'>, env: Env): NetworkTarget {
  if (!(GUARDED_FAMILIES as readonly string[]).includes(account.family)) return { skip: 'not-covered' }
  if (account.kind === 'api') return { skip: 'api' }
  if (account.family === 'claude') {
    return officialHost(env.ANTHROPIC_BASE_URL, 'api.anthropic.com')
      ? { url: TRACE.anthropic }
      : { skip: 'third-party' }
  }
  return { url: TRACE.chatgpt }
}

export const networkDir = (stateDir: string) => join(stateDir, 'network')

/** Network Guard is on: the switch, a non-empty list, and not in CI (where it makes no request). */
export function guardOn(config: Pick<Config, 'network'>, env: Env): boolean {
  return Boolean(config.network?.guard && config.network.allow?.length && !inCi(env))
}

export interface LaunchGuardResult {
  /** Variables `network-hook` reads, to add to the Host's environment. */
  env: Record<string, string>
  verdict: Verdict
}

/**
 * The check before a Launch (spec §3.35): throws a UserError that says what to do when the Egress is outside the
 * list or cannot be told; returns what the session's hooks need, or null when this Launch is not guarded.
 */
export async function guardLaunch(opts: {
  account: Account
  env: Env
  config: Pick<Config, 'network'>
  stateDir: string
  label?: string
  fetcher?: TraceFetcher
  now?: () => Date
  print?: string
}): Promise<LaunchGuardResult | null> {
  if (!guardOn(opts.config, opts.env)) return null
  const target = networkTarget(opts.account, opts.env)
  if (!('url' in target)) return null
  const allow = opts.config.network?.allow ?? []
  const dir = networkDir(opts.stateDir)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const v = await verdict({
    url: target.url,
    env: opts.env,
    allow,
    dir,
    moment: 'launch',
    ...(opts.fetcher ? { fetcher: opts.fetcher } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.print ? { print: opts.print } : {}),
  })
  if (v.status !== 'ok')
    throw new UserError(
      blockMessage(v, allow, {
        ref: opts.label || opts.account.ref,
        at: 'launch',
        zh: prefersChinese(opts.env),
        proxy: routeLabel(target.url, opts.env),
      }),
      { code: v.status === 'blocked' ? 'network-blocked' : 'network-unknown' },
    )
  return {
    env: { [NETWORK_ENV.url]: target.url, [NETWORK_ENV.allow]: allow.join(','), [NETWORK_ENV.dir]: dir },
    verdict: v,
  }
}

/** The line a Launch prints when the check saw the address change (a notice, never a block). */
export function ipChangedLine(v: Verdict, env: Env): string | undefined {
  if (!v.ipChanged) return undefined
  return prefersChinese(env)
    ? 'sideby：网络出口 IP 和上次不同（国家没变，没有拦截）。'
    : 'sideby: the network exit address changed since the last check (same country, nothing blocked).'
}

const hookCommand = (family: string, event: string) => sidebyHookCommand('network-hook', family, event)
const HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse'] as const

/**
 * Seconds Claude Code waits for `network-hook`. Its own default for `UserPromptSubmit` is 30, and a hook that runs out
 * of time lets the prompt through; the check may ask again for up to `RETRY_BUDGET_MS`, so it gets twice that.
 * Codex's default (600 seconds) is already long enough.
 */
export const CLAUDE_NETWORK_HOOK_TIMEOUT_S = 60

/**
 * Seconds the background `Held` entry may wait for the exit to be allowed again (5 hours, as Auto Handoff's
 * `IdleWatch`, ADR-0056). `network-hook` ends by itself a little earlier (`HELD_BUDGET_MS`).
 */
export const CLAUDE_NETWORK_HELD_TIMEOUT_S = 18_000

/**
 * Claude Code `hooks` entries for Network Guard, to put in a `--settings` file (alone or with Auto Handoff's). Next
 * to the check before a prompt runs `Held` in the background (`asyncRewake`): a prompt Claude Code made itself (a
 * background task's notification) is not sent again once blocked, so `Held` keeps it and wakes the session with it
 * when the exit is allowed again (spec §3.35). Codex has no such hook, and gets none.
 */
export function claudeNetworkHooks(): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {}
  for (const e of HOOK_EVENTS)
    out[e] = [
      {
        hooks: [
          { type: 'command', command: hookCommand('claude', e), timeout: CLAUDE_NETWORK_HOOK_TIMEOUT_S },
          ...(e === 'UserPromptSubmit'
            ? [
                {
                  type: 'command',
                  command: hookCommand('claude', 'Held'),
                  asyncRewake: true,
                  timeout: CLAUDE_NETWORK_HELD_TIMEOUT_S,
                },
              ]
            : []),
        ],
      },
    ]
  return out
}

/** The file holding Network Guard's Claude hooks alone. */
export const claudeNetworkSettings = (stateDir: string) => join(networkDir(stateDir), 'claude-settings.json')

/** Network Guard's session hooks (spec §3.35), to combine with others through `sessionHookArgs`. */
export function networkHookPart(): SessionHookPart {
  return {
    id: 'network',
    claude: claudeNetworkHooks(),
    codex: Object.fromEntries(
      HOOK_EVENTS.map((e) => [e, [`{hooks=[{type="command",command="${hookCommand('codex', e)}"}]}`]]),
    ),
  }
}

/**
 * Host arguments that add Network Guard's hooks alone to a session: Claude through a `--settings` file sideby writes,
 * Codex through `-c hooks.*`. Nothing is written into a Host directory.
 */
export async function networkHookArgs(family: string, stateDir: string): Promise<string[]> {
  return sessionHookArgs(family, stateDir, [networkHookPart()])
}

/** The line a Claude Launch prints when the user's own `--settings` leaves no room for the session hooks. */
export function networkSettingsLine(env: Env): string {
  return prefersChinese(env)
    ? 'sideby：已经给了 `--settings`，这个会话里不会每条消息前检查网络（启动前已检查）。'
    : 'sideby: `--settings` is already given, so this session is not checked before each prompt (it was checked before starting).'
}

/** Once per Codex Account: Codex runs the hooks only after the user trusts them in `/hooks`. */
export async function codexNetworkTrustLine(
  stateDir: string,
  ref: string,
  env: Env,
): Promise<string | undefined> {
  const file = join(networkDir(stateDir), 'codex-trust-notices.json')
  let seen: string[] = []
  try {
    const v = JSON.parse(await readFile(file, 'utf8')) as { refs?: unknown }
    if (Array.isArray(v.refs)) seen = v.refs.filter((r): r is string => typeof r === 'string')
  } catch {
    // first notice
  }
  if (seen.includes(ref)) return undefined
  try {
    await writeFileAtomic(file, `${JSON.stringify({ refs: [...seen, ref] })}\n`, 0o600)
  } catch {
    // shown again next time
  }
  return prefersChinese(env)
    ? `sideby：Codex 要先信任 hook 才会在会话中检查网络：在 ${ref} 里输入 /hooks，信任 \`network-hook\`。之前只在启动前检查。`
    : `sideby: Codex checks the network inside a session only after you trust the hook: in ${ref}, type /hooks and trust \`network-hook\`. Until then it is checked only before starting.`
}

/**
 * Auto Handoff's Claude hook arguments with Network Guard's hooks added to its `--settings` file, written as a new
 * file next to Network Guard's own (Claude Code takes one `--settings`).
 */
export async function withClaudeNetworkHooks(
  hookArgs: readonly string[],
  stateDir: string,
): Promise<string[]> {
  return withClaudeHooks(
    hookArgs,
    claudeNetworkHooks(),
    join(networkDir(stateDir), 'claude-settings-handoff.json'),
  )
}

/** `args` without one run of arguments sideby added (Auto Handoff merges its session hooks into its own file). */
export function withoutArgs(args: readonly string[], drop: readonly string[]): string[] {
  if (!drop.length) return [...args]
  for (let i = 0; i + drop.length <= args.length; i++) {
    if (drop.every((d, j) => args[i + j] === d)) return [...args.slice(0, i), ...args.slice(i + drop.length)]
  }
  return [...args]
}

/**
 * Where one Account is checked, or why not: an API Account (`api`), or an endpoint set to a third party.
 * `at-launch` is no longer given (API Accounts were once checked at Launch); it stays in the type for readers.
 */
export interface NetworkAccountRow {
  ref: string
  url?: string
  skip?: 'not-covered' | 'third-party' | 'at-launch' | 'api'
}

export interface NetworkTargetStatus {
  url: string
  /** Accounts checked at this address. */
  accounts: string[]
  status: EgressStatus | 'not-checked'
  loc?: string
  checkedAt?: string
  error?: string
  /** The address changed in the last day. */
  ipChanged: boolean
}

/**
 * What `sideby network` and the Panel show (spec §3.35): per address, the newest cached result, and per Account
 * where it is checked or why not. Reads only the cache; `check` asks every address now.
 */
export async function networkOverview(opts: {
  accounts: readonly Account[]
  config: Pick<Config, 'network'>
  stateDir: string
  env: Env
  envFor: (account: Account) => Promise<Env>
  check?: boolean
  fetcher?: TraceFetcher
  now?: () => Date
  print?: string
}): Promise<{
  guard: boolean
  allow: string[]
  active: boolean
  ci: boolean
  targets: NetworkTargetStatus[]
  accounts: NetworkAccountRow[]
}> {
  const allow = opts.config.network?.allow ?? []
  const dir = networkDir(opts.stateDir)
  const byUrl = new Map<string, { accounts: string[]; env: Env }>()
  const accounts: NetworkAccountRow[] = []
  for (const a of opts.accounts) {
    if (!(GUARDED_FAMILIES as readonly string[]).includes(a.family)) continue
    // API Accounts are never checked (ADR-0079), and their Secret File is not read for this.
    if (a.kind === 'api') {
      accounts.push({ ref: a.ref, skip: 'api' })
      continue
    }
    let env: Env
    try {
      env = await opts.envFor(a)
    } catch {
      env = opts.env
    }
    const t = networkTarget(a, env)
    if ('url' in t) {
      const got = byUrl.get(t.url) ?? { accounts: [], env }
      got.accounts.push(a.ref)
      byUrl.set(t.url, got)
      accounts.push({ ref: a.ref, url: t.url })
    } else accounts.push({ ref: a.ref, skip: t.skip })
  }
  const now = (opts.now?.() ?? new Date()).getTime()
  const targets: NetworkTargetStatus[] = []
  if (opts.check) await mkdir(dir, { recursive: true, mode: 0o700 })
  for (const [url, { accounts: refs, env }] of byUrl) {
    let entry: EgressEntry | null
    if (opts.check) {
      entry = (
        await refresh({
          url,
          env,
          dir,
          ...(opts.fetcher ? { fetcher: opts.fetcher } : {}),
          ...(opts.now ? { now: opts.now } : {}),
          ...(opts.print ? { print: opts.print } : {}),
        })
      ).entry
    } else entry = await readEntry(dir, cacheKey(url, env))
    const changed = entry?.ipChangedAt ? now - Date.parse(entry.ipChangedAt) < 24 * 3600_000 : false
    targets.push({
      url,
      accounts: refs,
      status: entry ? judge(entry, allow) : 'not-checked',
      ...(entry?.loc ? { loc: entry.loc } : {}),
      ...(entry ? { checkedAt: entry.checkedAt } : {}),
      ...(entry?.error ? { error: entry.error } : {}),
      ipChanged: changed,
    })
  }
  return {
    guard: Boolean(opts.config.network?.guard),
    allow,
    active: guardOn(opts.config, opts.env),
    ci: inCi(opts.env),
    targets,
    accounts,
  }
}

export type NetworkOverview = Awaited<ReturnType<typeof networkOverview>>

export type ListenerProbe = (
  host: string,
  port: number,
  timeoutMs: number,
) => Promise<{ reachable: boolean; error?: string }>

/** A local TCP connection attempt; its result says nothing about the proxy protocol or upstream connectivity. */
export const probeListener: ListenerProbe = (host, port, timeoutMs) =>
  new Promise((resolve) => {
    const socket = createConnection({ host, port })
    let done = false
    const finish = (reachable: boolean, error?: string) => {
      if (done) return
      done = true
      socket.destroy()
      resolve({ reachable, ...(error ? { error } : {}) })
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false, 'timeout'))
    socket.once('error', (e) => finish(false, (e as NodeJS.ErrnoException).code || 'failed'))
  })

export interface NetworkDiagnosis {
  /** When this offline diagnosis was made (ISO), not when the cached Guard entries were checked. */
  checkedAt: string
  targets: {
    url: string
    /** The current process's selected proxy with credentials/path removed, or `direct`. */
    proxy: string
    /** Whether Network Guard can use this route: HTTP CONNECT only; direct needs no proxy protocol. */
    guardSupport: 'direct' | 'http-connect' | 'unsupported' | 'invalid'
    /** Null for direct, a remote proxy, an unreadable address, or a non-HTTP proxy without an explicit port. */
    listener: null | { host: string; port: number; reachable: boolean; error?: string }
    guard: {
      status: NetworkTargetStatus['status']
      loc?: string
      checkedAt?: string
      error?: string
    }
  }[]
}

/**
 * Offline, read-only diagnosis: cached Guard state plus the route visible to this sideby process and a local TCP probe.
 * Unlike `networkOverview({check:true})`, it never calls a trace fetcher, resolves a remote proxy, or writes a cache entry.
 */
export async function networkDiagnose(
  opts: Parameters<typeof networkOverview>[0] & { probe?: ListenerProbe },
): Promise<NetworkDiagnosis> {
  const overview = await networkOverview({ ...opts, check: false })
  const targets: NetworkDiagnosis['targets'] = []
  for (const target of overview.targets) {
    const raw = proxyFor(target.url, opts.env)
    const proxy = routeLabel(target.url, opts.env)
    let guardSupport: NetworkDiagnosis['targets'][number]['guardSupport'] = raw ? 'invalid' : 'direct'
    let listener: NetworkDiagnosis['targets'][number]['listener'] = null
    if (raw && proxy !== 'invalid') {
      // `proxy` is already redacted; parse this rather than the raw environment value at the output boundary.
      const parsed = new URL(proxy.includes('://') ? proxy : `http://${proxy}`)
      guardSupport = parsed.protocol === 'http:' ? 'http-connect' : 'unsupported'
      // Offline diagnosis never resolves or connects to a remote proxy. URL keeps IPv6 brackets in `hostname`;
      // `createConnection` needs the bare address. Only HTTP has a defined default port for this check.
      const host = parsed.hostname.startsWith('[') ? parsed.hostname.slice(1, -1) : parsed.hostname
      const local = host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
      const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'http:' ? 80 : null
      if (local && port !== null)
        listener = {
          host,
          port,
          ...(await (opts.probe ?? probeListener)(host, port, 1000).catch(() => ({
            reachable: false,
            error: 'failed',
          }))),
        }
    }
    targets.push({
      url: target.url,
      proxy,
      guardSupport,
      listener,
      guard: {
        status: target.status,
        ...(target.loc ? { loc: target.loc } : {}),
        ...(target.checkedAt ? { checkedAt: target.checkedAt } : {}),
        ...(target.error ? { error: target.error } : {}),
      },
    })
  }
  return { checkedAt: (opts.now?.() ?? new Date()).toISOString(), targets }
}

export interface NetworkChange {
  guard?: boolean
  allow?: string[]
}

/** Country codes as config keeps them: upper case, two letters, each once, in the order given. */
export function normalizeAllow(codes: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of codes) {
    const c = raw.trim().toUpperCase()
    if (!/^[A-Z]{2}$/.test(c))
      throw new UserError(
        `"${raw}" is not a country code; use two letters such as US or JP (ISO 3166-1 alpha-2).`,
        { code: 'network-bad-country' },
      )
    if (!out.includes(c)) out.push(c)
  }
  return out
}

/**
 * `sideby network on|off|allow` and the Panel's network check (spec §3.35): changes config `network`, shown first
 * (`apply: false`) and written with `apply`. Turning it on with no allowed country is refused.
 */
export async function setNetwork(
  configFile: string,
  change: NetworkChange,
  opts: { apply: boolean },
): Promise<{
  changed: boolean
  applied: boolean
  file: string
  before: { guard: boolean; allow: string[] }
  after: { guard: boolean; allow: string[] }
}> {
  const { editConfigNetwork } = await import('./config.ts')
  const allow = change.allow ? normalizeAllow(change.allow) : undefined
  const r = await editConfigNetwork(
    configFile,
    (cur) => {
      const next = { ...cur }
      if (allow) {
        if (allow.length) next.allow = allow
        else delete next.allow
      }
      if (change.guard === true) next.guard = true
      if (change.guard === false) delete next.guard
      // Refused before anything is written.
      if (next.guard && !next.allow?.length)
        throw new UserError(
          change.guard
            ? 'Choose the countries first: `sideby network allow US JP` (the countries your requests may leave from), then `sideby network on`.'
            : 'Network checking is on, so at least one country must stay allowed; turn it off first with `sideby network off`.',
          { code: 'network-allow-empty' },
        )
      return next
    },
    { dryRun: !opts.apply },
  )
  const view = (c: { guard?: boolean; allow?: string[] } | undefined) => ({
    guard: Boolean(c?.guard),
    allow: c?.allow ?? [],
  })
  return {
    changed: r.changed,
    applied: opts.apply && r.changed,
    file: configFile,
    before: view(r.before),
    after: view(r.after),
  }
}
