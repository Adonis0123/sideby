// Asks Antigravity CLI for the Main Account's Quota (spec §3.26, ADR-0048): `agy -p /usage --output-format json` runs
// the `/usage` command with agy's own sign-in and starts no model turn (`num_turns` 0, every token count 0; tried with
// agy 1.4.4 on 2026-10-21). sideby never reads the sign-in and sends no request of its own.
//
// A background check must never open a browser (ADR-0082). When agy cannot refresh its sign-in, `-p` prints a sign-in
// link, runs `open <link>` (`xdg-open` on Linux), looked up on PATH, and waits 60 s for the sign-in (agy 1.5.14,
// 2026-11-23). agy has no BROWSER or NO_BROWSER variable; it skips the browser in an SSH session, but then gives no
// sign that it waits. So the check puts sideby's own `open` first on agy's PATH: it opens nothing and leaves a mark,
// and sideby stops agy at once and says to sign in again.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rm, stat } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { ownedFolder, writeFileAtomic } from '../../core/fs-safe.ts'
import type { Account, QuotaFetch, QuotaFetchContext, QuotaResult, QuotaWindow } from '../../types.ts'

export const AGY_QUOTA_ARGS = ['-p', '/usage', '--output-format', 'json'] as const
/** agy answers in about 6 s; anything far larger than its answer is not one. */
const MAX_OUTPUT = 256 * 1024
/** agy's own limit, under sideby's `FETCH_TIMEOUT_MS`, so agy is stopped here and has time to exit. */
export const AGY_QUOTA_TIMEOUT_MS = 15_000
/** After SIGTERM, how long agy gets to exit before SIGKILL. */
const KILL_AFTER_MS = 2_000
/** How often the check looks for the sign-in mark. */
const MARK_POLL_MS = 200
/** Names agy may run to open its sign-in page. */
// Linux and WSL builds of agy may also try sensible-browser.
const OPENERS = ['open', 'xdg-open', 'sensible-browser'] as const
/** Where sideby's `open` leaves its mark; set only for the quota check. */
const MARK_VAR = 'SIDEBY_AGY_SIGN_IN_MARK'
const OPENER = `#!/bin/sh
# sideby's Antigravity CLI quota check (ADR-0082): agy asked to open its sign-in page. Open nothing, keep nothing of
# the address, only leave the mark sideby looks for.
[ -n "$${MARK_VAR}" ] && : > "$${MARK_VAR}"
exit 0
`

const failed = (detail: string): QuotaResult => ({ status: 'unavailable', reason: 'fetch-failed', detail })

const WINDOWS: Record<string, { label: string; minutes: number }> = {
  '5h': { label: '5h', minutes: 300 },
  weekly: { label: '7d', minutes: 7 * 24 * 60 },
}

/**
 * The Quota in agy's JSON answer: one window per bucket, named after its model group, since each limit covers only
 * that group's models. Only group names, windows, percentages and reset times are kept.
 */
export function agyQuota(answer: unknown, observedAt: string): QuotaResult | null {
  if (typeof answer !== 'object' || answer === null) return null
  const a = answer as { status?: unknown; error?: unknown; command?: { data?: { groups?: unknown } } }
  if (a.status !== 'SUCCESS') return null
  const groups = a.command?.data?.groups
  if (!Array.isArray(groups)) return null
  const windows: QuotaWindow[] = []
  for (const g of groups) {
    const name = typeof g?.name === 'string' ? g.name.slice(0, 60) : undefined
    if (!name || !Array.isArray(g.buckets)) continue
    for (const b of g.buckets) {
      const w = WINDOWS[b?.window]
      const left = b?.remaining_fraction
      if (!w || typeof left !== 'number' || !Number.isFinite(left)) continue
      const resets = typeof b.reset_time === 'string' ? Date.parse(b.reset_time) : Number.NaN
      if (!Number.isFinite(resets)) continue
      windows.push({
        label: w.label,
        name,
        windowMinutes: w.minutes,
        usedPercent: Math.round(Math.min(1, Math.max(0, 1 - left)) * 100),
        resetsAt: new Date(resets).toISOString(),
      })
    }
  }
  return windows.length ? { status: 'ok', windows, observedAt, source: 'agy /usage' } : null
}

/** Why agy's answer gave no Quota, and what to do. agy's own words are only matched, never repeated. */
function errorDetail(account: Account, answer: unknown): string {
  const { status, error } = (answer ?? {}) as { status?: unknown; error?: unknown }
  if (status === 'SUCCESS')
    return 'Antigravity CLI answered in a form sideby does not recognise; update sideby'
  if (typeof error === 'string' && /auth/i.test(error))
    return `Antigravity CLI is not signed in; run \`sideby login ${account.ref}\` and sign in with Google`
  return 'Antigravity CLI could not report the quota; sideby asks again later, or start agy once'
}

const needsSignIn = (account: Account): QuotaResult => ({
  status: 'unavailable',
  reason: 'fetch-failed',
  detail: `Antigravity CLI needs a new sign-in; run \`sideby login ${account.ref}\` and sign in with Google`,
  loginExpired: true,
})

/** sideby's folder for the check, with its `open` in `bin`; null when it is not safe to use. */
async function checkFolder(stateDir: string): Promise<{ dir: string; bin: string } | null> {
  try {
    const dir = await ownedFolder(stateDir, ['quota', 'agy-run'], { create: true })
    const bin = await ownedFolder(stateDir, ['quota', 'agy-run', 'bin'], { create: true })
    if (!dir || !bin) return null
    for (const name of OPENERS) {
      const p = join(bin, name)
      // agy looks openers up on PATH and skips files that are not executable, so the mode matters too.
      const same = (await readFile(p, 'utf8').catch(() => null)) === OPENER
      const mode = (await stat(p).catch(() => null))?.mode
      if (!same || mode === undefined || (mode & 0o777) !== 0o700) await writeFileAtomic(p, OPENER, 0o700)
    }
    return { dir, bin }
  } catch {
    return null
  }
}

export async function fetchAgyQuota(
  account: Account,
  ctx: QuotaFetchContext,
  opts: { timeoutMs?: number } = {},
): Promise<QuotaResult> {
  if (ctx.signal.aborted) return failed('the quota check was stopped')
  const folder = await checkFolder(ctx.stateDir)
  // Without sideby's `open` first on PATH, agy could open a browser: it is not asked.
  if (!folder)
    return failed(
      `sideby's folder ${join(ctx.stateDir, 'quota')} is not safe to use; check its owner and mode`,
    )
  // A folder whose path holds the PATH separator would split into other entries, and agy would find the real `open`.
  if (folder.bin.includes(delimiter))
    return failed(
      `sideby's folder ${folder.bin} has "${delimiter}" in its path, so it cannot go first on PATH; move sideby's state folder`,
    )
  if (ctx.signal.aborted) return failed('the quota check was stopped')
  const mark = join(folder.dir, `sign-in-${randomBytes(8).toString('hex')}`)
  const child = spawn('agy', [...AGY_QUOTA_ARGS], {
    cwd: folder.dir,
    env: {
      ...ctx.hostEnv,
      PATH: [folder.bin, ctx.hostEnv.PATH].filter(Boolean).join(delimiter),
      [MARK_VAR]: mark,
    },
    // stderr holds a sign-in link when signed out: never read.
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const alive = () => child.exitCode === null && child.signalCode === null
  let killTimer: NodeJS.Timeout | undefined
  // SIGTERM lets agy print its answer and exit (it does within a second); SIGKILL if it does not.
  const stop = () => {
    if (!alive()) return
    child.kill('SIGTERM')
    killTimer ??= setTimeout(() => alive() && child.kill('SIGKILL'), KILL_AFTER_MS)
  }
  let signIn = false
  let timedOut = false
  const poll = setInterval(() => {
    if (!signIn && existsSync(mark)) {
      signIn = true
      stop()
    }
  }, MARK_POLL_MS)
  const deadline = setTimeout(() => {
    timedOut = true
    stop()
  }, opts.timeoutMs ?? AGY_QUOTA_TIMEOUT_MS)
  ctx.signal.addEventListener('abort', stop, { once: true })
  try {
    return await new Promise<QuotaResult>((resolve) => {
      const chunks: Buffer[] = []
      let size = 0
      child.stdout.on('data', (b: Buffer) => {
        size += b.length
        if (size > MAX_OUTPUT) return stop()
        chunks.push(b)
      })
      child.on('error', (err: NodeJS.ErrnoException) =>
        resolve(
          failed(
            err.code === 'ENOENT'
              ? 'Antigravity CLI is not installed or not on PATH; install it, then refresh'
              : `could not start Antigravity CLI (${err.code ?? 'error'})`,
          ),
        ),
      )
      const done = () => {
        // A process agy started may still hold the output open; let go of it so sideby itself can exit.
        child.stdout.destroy()
        if (signIn || existsSync(mark)) return resolve(needsSignIn(account))
        if (ctx.signal.aborted) return resolve(failed('the quota check was stopped'))
        let answer: unknown
        try {
          answer = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          answer = undefined
        }
        const quota = answer === undefined ? null : agyQuota(answer, ctx.now.toISOString())
        if (quota) return resolve(quota)
        if (timedOut)
          return resolve(
            failed(
              `Antigravity CLI gave no answer within ${Math.round((opts.timeoutMs ?? AGY_QUOTA_TIMEOUT_MS) / 1000)} seconds; sideby asks again later`,
            ),
          )
        if (answer === undefined)
          return resolve(failed('Antigravity CLI exited without answering; sideby asks again later'))
        resolve(failed(errorDetail(account, answer)))
      }
      child.on('close', done)
      // A process agy started may keep its output open after agy ended: answer anyway.
      child.on('exit', () => setTimeout(done, 1_000).unref())
    })
  } finally {
    clearInterval(poll)
    clearTimeout(deadline)
    ctx.signal.removeEventListener('abort', stop)
    stop()
    if (killTimer && !alive()) clearTimeout(killTimer)
    await rm(mark, { force: true }).catch(() => {})
  }
}

export const agyQuotaFetch: QuotaFetch = {
  everyMinutes: 15,
  summary: 'Antigravity CLI asks Google for its quota, at most every 15 minutes',
  fetch: fetchAgyQuota,
}
