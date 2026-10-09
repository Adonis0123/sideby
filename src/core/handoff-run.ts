// Auto Handoff (spec §3.17, ADR-0010): `sideby run` stays the Host's parent. The Host's hooks write `ready.json`
// when the session should hand over; then sideby ends the Host, finishes the Brief, counts down, and starts the next
// Account in the same terminal with a new session that reads the Brief. Nothing here reads a credential.
import { execFile } from 'node:child_process'
import { watch } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { HOOK_FAMILIES } from '../handoff/hook.ts'
import { firstPrompt } from '../handoff/messages.ts'
import type { Runtime } from '../runtime.ts'
import type { Account, Env, HandoffHookEvent } from '../types.ts'
import { aliasArgs } from './config.ts'
import { finishBrief } from './handoff-brief.ts'
import {
  briefPath,
  type ChainFile,
  chainDir,
  ensureChainDir,
  FILES,
  HANDOFF_ENV,
  newId,
  type PlanFile,
  type ReadyFile,
  readJsonFile,
  writeJsonFile,
} from './handoff-chain.ts'
import type { HandoffDecision } from './handoff-select.ts'
import { type PreparedLaunch, runHost, sidebyBinProblem, spawnHost } from './launch.ts'
import { quotaPressure } from './quota-levels.ts'

export interface HandoffIo {
  err(line: string): void
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (on: boolean) => unknown }
}

/** How long the Host gets to exit after SIGTERM (time for its SessionEnd hooks) before sideby gives up. */
export const EXIT_GRACE_MS = 10_000
const PLAN_REFRESH_MS = 60_000
const READY_POLL_MS = 1000

const hookCommand = (family: string) => (event: HandoffHookEvent) => `sideby handoff-hook ${family} ${event}`

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

export function explain(d: HandoffDecision): string {
  if (d.kind === 'wait') return `the full window resets at ${clock(d.until)}, so waiting beats moving on`
  if (d.kind === 'none')
    return d.earliestReset
      ? `${d.reason}; ${d.earliestReset.ref} is back first, at ${clock(d.earliestReset.at)}`
      : d.reason
  return `next: ${d.ref}`
}

/** Resolves with the ready file once the hook writes one for `runId`; `stop()` ends the watch. */
function watchReady(dir: string, runId: string): { ready: Promise<ReadyFile>; stop(): void } {
  let stop = () => {}
  const ready = new Promise<ReadyFile>((resolve) => {
    const check = async () => {
      const r = await readJsonFile<ReadyFile>(join(dir, FILES.ready))
      if (r && r.runId === runId) {
        stop()
        resolve(r)
      }
    }
    const timer = setInterval(() => void check(), READY_POLL_MS)
    let watcher: ReturnType<typeof watch> | undefined
    try {
      watcher = watch(dir, () => void check())
    } catch {
      // polling alone still works
    }
    stop = () => {
      clearInterval(timer)
      watcher?.close()
    }
    void check()
  })
  return { ready, stop: () => stop() }
}

const WHY: Record<ReadyFile['trigger'], string> = {
  threshold: 'its quota reached the hand-over level',
  limit: 'it hit its usage limit',
  manual: 'you asked to hand over',
}

/**
 * Counts down; resolves true when the person pressed Enter to cancel. On a terminal the line is rewritten in place,
 * elsewhere each second is a line of its own.
 */
function countdown(io: HandoffIo, seconds: number, to: string, from: string): Promise<boolean> {
  return new Promise((resolve) => {
    let left = seconds
    const raw = typeof io.stdin.setRawMode === 'function'
    const inPlace = process.stderr.isTTY === true
    const done = (cancelled: boolean) => {
      clearInterval(timer)
      io.stdin.off('data', onData)
      if (raw) io.stdin.setRawMode!(false)
      io.stdin.pause()
      if (inPlace) process.stderr.write('\n')
      resolve(cancelled)
    }
    const onData = (chunk: Buffer | string) => {
      const s = chunk.toString()
      if (s.includes('\r') || s.includes('\n')) done(true)
      // Ctrl-C while counting down cancels as well.
      else if (s.includes('\u0003')) done(true)
    }
    const tick = () => {
      const line = `sideby: starting ${to} in ${left}s; press Enter to stay in ${from}`
      if (inPlace) process.stderr.write(`\r${line}\x1b[K`)
      else io.err(line)
      if (left-- <= 0) done(false)
    }
    if (raw) io.stdin.setRawMode!(true)
    io.stdin.resume()
    io.stdin.on('data', onData)
    const timer = setInterval(tick, 1000)
    tick()
  })
}

/** Codex runs a hook only after the person trusted it in `/hooks`, once per Account; say so the first time. */
async function codexTrustNotice(rt: Runtime, account: Account, io: HandoffIo): Promise<void> {
  const file = join(rt.paths.stateDir, 'handoff', 'codex-trust-notices.json')
  const seen = (await readJsonFile<{ refs?: string[] }>(file))?.refs ?? []
  if (seen.includes(account.ref)) return
  io.err(
    `sideby: Codex runs sideby's handoff hooks only after you trust them: in ${account.ref}, type /hooks and trust \`sideby handoff-hook\`. Until then this account will not hand over.`,
  )
  await ensureChainDir(join(rt.paths.stateDir, 'handoff'))
  await writeJsonFile(file, { refs: [...seen, account.ref] })
}

interface Hop {
  ref: string
  /** The user's Host arguments for this hop (an Alias's arguments included for the first). */
  args: string[]
  prompt?: string
}

/** `args` with `extra` before the first `--`, so a user's own `--` cannot turn sideby's options into prompt text. */
export function beforeDashes(args: readonly string[], extra: readonly string[]): string[] {
  const at = args.indexOf('--')
  return at === -1 ? [...args, ...extra] : [...args.slice(0, at), ...extra, ...args.slice(at)]
}

/** Whether the `sideby` on PATH has the hook entry: an older install would fail every hook call. */
export function hookEntryWorks(env: Env): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'sideby',
      ['handoff-hook', '--check'],
      { env: env as NodeJS.ProcessEnv, timeout: 5000 },
      (err, out) => resolve(!err && String(out).trim() === 'ok'),
    )
  })
}

/** The decision, or `none` with the reason when sideby cannot tell (an account removed mid-chain, say). */
async function decide(rt: Runtime, account: Account, used: readonly string[]): Promise<HandoffDecision> {
  try {
    return await rt.handoffDecision(account, used)
  } catch (err) {
    return { kind: 'none', reason: (err as Error).message }
  }
}

/**
 * Runs `ref` with Auto Handoff when the config, the Family, the run and the terminal allow it, and returns the exit
 * code of the last Host; null when Auto Handoff does not apply and the caller should run the Host as usual.
 */
export async function runWithHandoff(
  rt: Runtime,
  ref: string,
  userArgs: readonly string[],
  io: HandoffIo,
  /** For tests: how long the Host gets to exit after SIGTERM. */
  opts: { exitGraceMs?: number } = {},
): Promise<number | null> {
  const grace = opts.exitGraceMs ?? EXIT_GRACE_MS
  const settings = rt.handoffSettings()
  if (!settings.auto || !io.stdin.isTTY) return null
  const firstLaunch = await rt.prepareLaunch(ref, userArgs, 'run')
  const firstHandoff = firstLaunch.family.handoff
  // Only built-in Families have a hook reader (spec §3.17); a Plugin Family can only take over.
  if (!firstHandoff?.starts.length || !HOOK_FAMILIES.includes(firstLaunch.family.id)) return null
  const firstElig = await firstHandoff.eligibility(firstLaunch.args, firstLaunch.account, firstLaunch.env)
  if (!firstElig.start) {
    // A headless run is simply not part of it; an interactive one that cannot start says why.
    if (firstElig.receive && firstElig.reason)
      io.err(`sideby: ${firstLaunch.account.ref} will not hand over: ${firstElig.reason}`)
    return null
  }
  const binProblem =
    (await sidebyBinProblem(rt.env, 'the Host runs `sideby handoff-hook` for Auto Handoff')) ??
    ((await hookEntryWorks(rt.env))
      ? null
      : 'the sideby on PATH is older than this one and has no `handoff-hook`; upgrade it with `npm i -g sideby`')
  if (binProblem) {
    io.err(`sideby: Auto Handoff is off for this run: ${binProblem}`)
    return null
  }

  const chain = newId()
  const dir = chainDir(rt.paths.stateDir, chain)
  await ensureChainDir(dir)
  const hops: ChainFile = { hops: [] }
  const used: string[] = []
  const own = rt.config.aliases?.[ref]
  let hop: Hop = { ref, args: [...aliasArgs(own), ...userArgs] }
  let n = 1

  for (;;) {
    const launch: PreparedLaunch = n === 1 ? firstLaunch : await rt.prepareLaunch(hop.ref, hop.args, 'run')
    const account = launch.account
    const h = launch.family.handoff
    if (!h) return runHost(launch)
    const elig = n === 1 ? firstElig : await h.eligibility(launch.args, account, launch.env)
    const canStart = h.starts.length > 0 && elig.start && HOOK_FAMILIES.includes(account.family)
    if (!canStart && elig.reason) io.err(`sideby: ${account.ref} will not hand over: ${elig.reason}`)

    const runId = newId()
    const brief = briefPath(dir, n, account.ref)
    const extra = [...(elig.args ?? [])]
    const env = { ...launch.env }
    if (canStart) {
      extra.push(...((await h.hookArgs?.(hookCommand(account.family), rt.paths.stateDir)) ?? []))
      env[HANDOFF_ENV.run] = runId
      env[HANDOFF_ENV.family] = account.family
      env[HANDOFF_ENV.dir] = dir
      if (account.family === 'codex') await codexTrustNotice(rt, account, io)
    }
    extra.push(...(h.dirArgs?.(dir) ?? []))
    const args = beforeDashes(launch.args, extra)
    // Later hops carry no `--` of their own (continueArgs drops it), so the prompt goes after a fresh one.
    if (hop.prompt) args.push(...h.promptArgs(hop.prompt))
    used.push(account.ref)
    hops.hops.push({ ref: account.ref, startedAt: new Date().toISOString() })
    await writeJsonFile(join(dir, FILES.chain), hops)
    if (launch.notice) io.err(launch.notice)
    if (!canStart) return runHost({ ...launch, args, env })

    // Plan writes run one after another, and none lands after this hop is over: a late one would carry this
    // run's id into the next hop's plan.json and silence its hook.
    let stopped = false
    let pending = Promise.resolve()
    const writePlan = () => {
      pending = pending.then(async () => {
        try {
          const d = await rt.handoffDecision(account, used)
          if (stopped) return
          const plan: PlanFile = {
            runId,
            brief,
            at: new Date().toISOString(),
            decision: d.kind,
            ...(d.kind === 'pick' ? { pick: d.ref } : {}),
            prepareAt: settings.prepareAt,
            threshold: settings.threshold,
            ...(elig.agentBrief === false ? { agentBrief: false } : {}),
          }
          await writeJsonFile(join(dir, FILES.plan), plan)
        } catch {
          // the hook treats a missing plan as "do not interrupt"
        }
      })
      return pending
    }
    await writePlan()
    const refresh = setInterval(() => void writePlan(), PLAN_REFRESH_MS)
    const host = spawnHost({ ...launch, args, env })
    const watcher = watchReady(dir, runId)
    const outcome = await Promise.race([
      host.exited.then((code) => ({ kind: 'exit' as const, code })),
      watcher.ready.then((ready) => ({ kind: 'ready' as const, ready })),
    ])
    clearInterval(refresh)
    watcher.stop()
    stopped = true
    await pending

    if (outcome.kind === 'exit') {
      await noteUnhandedHighQuota(rt, account, used, settings.threshold, io)
      return outcome.code
    }

    // Nothing to move on to (or better to wait): leave the session alone and say why once it ends.
    const decision = await decide(rt, account, used)
    if (decision.kind !== 'pick') {
      await rm(join(dir, FILES.ready), { force: true })
      const code = await host.exited
      io.err(`sideby: ${account.ref} did not hand over: ${explain(decision)}`)
      return code
    }

    // The session is ready: end the Host, give it time to save, never kill it.
    host.child.kill('SIGTERM')
    const ended = await Promise.race([
      host.exited.then((code) => ({ code })),
      new Promise<null>((r) => setTimeout(() => r(null), grace).unref()),
    ])
    if (!ended) {
      io.err(
        `sideby: ${account.ref} did not exit within ${grace / 1000}s, so nothing was handed over; exit it yourself, then start the next account with \`sideby run ${decision.ref}\``,
      )
      return host.exited
    }

    const ready = outcome.ready
    const assembled = await h
      .briefFromSession?.(account, {
        ...(ready.sessionId ? { id: ready.sessionId } : {}),
        ...(ready.transcriptPath ? { transcriptPath: ready.transcriptPath } : {}),
      })
      .catch(() => undefined)
    const done = await finishBrief({
      target: brief,
      ready,
      ...(assembled ? { assembled } : {}),
      cwd: process.cwd(),
    })
    const last = hops.hops[hops.hops.length - 1]!
    Object.assign(last, { trigger: ready.trigger, briefSource: done.source, brief: done.path })
    await writeJsonFile(join(dir, FILES.chain), hops)
    await rm(join(dir, FILES.ready), { force: true })
    await rm(join(dir, FILES.request), { force: true })

    io.err(
      `sideby: ${account.ref} saved its session and is handing over because ${WHY[ready.trigger]}; next is ${decision.ref}. Brief: ${done.path}`,
    )
    if (
      settings.countdownSeconds > 0 &&
      (await countdown(io, settings.countdownSeconds, decision.ref, account.ref))
    ) {
      io.err(`sideby: staying in ${account.ref}`)
      if (!ready.sessionId) {
        io.err(
          `sideby: the session id is unknown, so start ${account.ref} yourself; the Brief is at ${done.path}`,
        )
        return ended.code
      }
      const backArgs = [...h.continueArgs(hop.args), ...h.resumeArgs(ready.sessionId)]
      const back = await rt.prepareLaunch(account.ref, backArgs, 'run')
      // The same per-Account arguments as before (Grok's leader socket), without sideby's hooks.
      const backElig = await h.eligibility(back.args, account, back.env)
      return runHost({ ...back, args: beforeDashes(back.args, backElig.args ?? []) })
    }

    let next: Account
    try {
      next = await rt.resolve(decision.ref)
    } catch (err) {
      io.err(`sideby: cannot start ${decision.ref}: ${(err as Error).message}; the Brief is at ${done.path}`)
      return ended.code
    }
    io.err(`sideby: handing over from ${account.ref} to ${next.ref}`)
    hop = {
      ref: next.ref,
      args: next.family === account.family ? h.continueArgs(hop.args) : [],
      prompt: firstPrompt(account.ref, done.path),
    }
    n++
  }
}

/** After a session ended on its own: when its Quota passed the threshold but nothing could take over, say why. */
async function noteUnhandedHighQuota(
  rt: Runtime,
  account: Account,
  used: readonly string[],
  threshold: number,
  io: HandoffIo,
): Promise<void> {
  try {
    const pressure = quotaPressure(await rt.quota(account), new Date())
    if (pressure === null || pressure < threshold) return
    const d = await rt.handoffDecision(account, used)
    if (d.kind !== 'pick')
      io.err(`sideby: ${account.ref} is at ${Math.round(pressure)}%; no Auto Handoff: ${explain(d)}`)
  } catch {
    // a note only
  }
}

/**
 * For `sideby handoff ready`: where a Handoff from the session running under `env` would go now, using the chain's
 * Accounts so far; null when `env` is not a run sideby started with Auto Handoff.
 */
export async function readyDecision(rt: Runtime, env: Env): Promise<HandoffDecision | null> {
  const dir = env[HANDOFF_ENV.dir]
  const ref = env.SIDEBY_ACCOUNT
  if (!env[HANDOFF_ENV.run] || !dir || !ref) return null
  const account = await rt.resolve(ref)
  const chain = await readJsonFile<ChainFile>(join(dir, FILES.chain))
  return decide(rt, account, chain?.hops.map((h) => h.ref) ?? [account.ref])
}
