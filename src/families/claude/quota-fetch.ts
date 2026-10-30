// Asks Claude Code for a subscription Account's Quota (spec §3.26, ADR-0063): `claude -p /usage
// --no-session-persistence --output-format json` runs the local `/usage` command with the Account's own sign-in and
// starts no model turn (`num_turns` 0, `total_cost_usd` 0, `local_command` "usage"; tried with Claude Code 2.1.314
// on 2026-10-30). sideby never reads the sign-in and sends no request of its own. Of the answer's text only the
// `Current session:` and `Current week (...)` lines are read; everything else in it (request counts, sessions,
// skills, subagents, MCP servers) is never kept, logged or returned.
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { ownedFolder } from '../../core/fs-safe.ts'
import type { Account, QuotaFetch, QuotaFetchContext, QuotaResult, QuotaWindow } from '../../types.ts'

/**
 * Hooks off and no MCP servers: a quota check is no session, so the user's hooks (notifications, loggers) must not
 * run for it and no MCP server needs starting. `/usage` itself needs neither.
 */
export const CLAUDE_QUOTA_ARGS = [
  '-p',
  '/usage',
  '--no-session-persistence',
  '--output-format',
  'json',
  '--settings',
  '{"disableAllHooks":true}',
  '--strict-mcp-config',
] as const
/** Claude Code answers in about 4 s with a few KB; anything far larger is not its answer. */
const MAX_OUTPUT = 512 * 1024
export const QUOTA_FETCH_SOURCE = 'claude /usage'

const failed = (detail: string): QuotaResult => ({ status: 'unavailable', reason: 'fetch-failed', detail })
const UNRECOGNISED = 'Claude Code answered /usage in a form sideby does not recognise; update sideby'

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const SESSION = { label: '5h', minutes: 300 }
const WEEK = { label: '7d', minutes: 7 * 24 * 60 }
/** A reset a little in the past still counts: the answer is a few seconds old when read. */
const PAST_SLACK_MS = 5 * 60_000

/** The offset (ms) of `timeZone` from UTC at the instant `utc`. */
function zoneOffset(utc: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(utc))
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  const wall = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour') % 24, n('minute'), n('second'))
  return wall - Math.floor(utc / 1000) * 1000
}

/** The instant a wall-clock time in `timeZone` names. */
function zonedInstant(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): number {
  const wall = Date.UTC(y, mo, d, h, mi)
  let utc = wall - zoneOffset(wall, timeZone)
  utc = wall - zoneOffset(utc, timeZone)
  return utc
}

/** The calendar date of `now` in `timeZone`. */
function zonedDate(now: number, timeZone: string): { y: number; mo: number; d: number } {
  const local = new Date(now + zoneOffset(now, timeZone))
  return { y: local.getUTCFullYear(), mo: local.getUTCMonth(), d: local.getUTCDate() }
}

const RESET =
  /^resets (?:([A-Za-z]{3,9})\.? (\d{1,2})(?:,? (\d{4}))? at )?(\d{1,2})(?::(\d{2}))?\s?(am|pm) \(([A-Za-z0-9_+\-/]+)\)$/i

/**
 * The instant "resets Nov 2 at 4am (Asia/Singapore)" names: the first such time after now (a few minutes of slack)
 * within `minutes`, since Claude Code writes no year. A time without a date is today's or a later day's. Null when the
 * text does not parse, the time zone is unknown, or no such time falls in the window.
 */
export function resetInstant(text: string, now: number, minutes: number): number | null {
  const m = RESET.exec(text.trim())
  if (!m) return null
  const [, mon, day, year, hour = '', minute, ampm = '', timeZone = ''] = m
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
  } catch {
    return null
  }
  const h12 = Number(hour)
  const mi = minute === undefined ? 0 : Number(minute)
  if (h12 < 1 || h12 > 12 || mi > 59) return null
  const h = (h12 % 12) + (ampm.toLowerCase() === 'pm' ? 12 : 0)
  const fits = (t: number) => t >= now - PAST_SLACK_MS && t <= now + minutes * 60_000 + PAST_SLACK_MS
  const today = zonedDate(now, timeZone)
  const candidates: number[] = []
  if (mon !== undefined) {
    const mo = MONTHS.indexOf(mon.slice(0, 3).toLowerCase())
    const d = Number(day)
    if (mo < 0 || d < 1 || d > 31) return null
    for (const y of year ? [Number(year)] : [today.y - 1, today.y, today.y + 1]) {
      // A day the month does not have (Feb 30) rolls over in Date.UTC; such a time is not the one named.
      if (new Date(Date.UTC(y, mo, d)).getUTCDate() !== d) continue
      candidates.push(zonedInstant(y, mo, d, h, mi, timeZone))
    }
  } else {
    for (let i = -1; i <= Math.ceil(minutes / 1440) + 1; i++)
      candidates.push(zonedInstant(today.y, today.mo, today.d + i, h, mi, timeZone))
  }
  const ok = candidates.filter(fits).sort((a, b) => a - b)
  return ok[0] ?? null
}

const LINE = /^Current (session|week \(([^)\n]{1,60})\)):\s*(\d{1,3}(?:\.\d+)?)% used(?:\s*·\s*(.+))?$/

/**
 * The Quota in the text of Claude Code's `/usage` answer, or null when any `Current …` line does not parse (no
 * partial guess). `Current session` is the 5-hour window, `Current week (all models)` the weekly one, and a week for
 * one model (`Current week (Fable)`) a window named after it, which never counts toward Quota Pressure.
 */
export function usageQuota(text: string, now: number): QuotaWindow[] | null {
  const windows: QuotaWindow[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('Current ')) continue
    const m = LINE.exec(line)
    if (!m) return null
    const [, kind, model = '', pct, reset] = m
    const used = Number(pct)
    if (!Number.isFinite(used) || used > 100) return null
    const all = kind === 'session' || model === 'all models'
    const w = kind === 'session' ? SESSION : WEEK
    if (!all && !/^[\w .\-+]+$/.test(model)) return null
    if (reset === undefined) {
      // A window nothing has used yet has no reset; there is nothing to show for it.
      if (used === 0) continue
      return null
    }
    const at = resetInstant(reset, now, w.minutes)
    if (at === null) return null
    windows.push({
      label: w.label,
      ...(all ? {} : { name: model.trim() }),
      windowMinutes: w.minutes,
      usedPercent: Math.round(used),
      resetsAt: new Date(at).toISOString(),
    })
  }
  return windows.some((w) => !w.name) ? windows : null
}

/**
 * The Quota in Claude Code's JSON answer, or why there is none. Claude Code's own words are only matched, never
 * repeated: the text holds this computer's sessions, skills and MCP servers.
 */
export function claudeUsageAnswer(answer: unknown, account: Account, now: number): QuotaResult {
  if (typeof answer !== 'object' || answer === null) return failed(UNRECOGNISED)
  const a = answer as { result?: unknown; local_command?: unknown; is_error?: unknown; num_turns?: unknown }
  const text = typeof a.result === 'string' ? a.result : ''
  const local =
    a.local_command === 'usage' &&
    a.is_error !== true &&
    !(typeof a.num_turns === 'number' && a.num_turns > 0)
  const windows = local ? usageQuota(text, now) : null
  if (windows)
    return { status: 'ok', windows, observedAt: new Date(now).toISOString(), source: QUOTA_FETCH_SOURCE }
  if (/not logged in|please (?:run )?\/login|please log ?in/i.test(text))
    return failed(`Claude Code is not signed in; run \`sideby login ${account.ref}\`, then refresh`)
  if (/using your API key|API usage billing/i.test(text))
    return failed('this account uses an API key, which has no subscription quota')
  if (!local)
    return failed(
      'this Claude Code version cannot report quota through /usage; update Claude Code, then refresh',
    )
  return failed(UNRECOGNISED)
}

export async function fetchClaudeQuota(account: Account, ctx: QuotaFetchContext): Promise<QuotaResult> {
  if (ctx.signal.aborted) return failed('the quota check was stopped; refresh to try again')
  if (account.kind === 'api') return failed('an API account has no subscription quota')
  // A folder of sideby's own, so Claude Code never starts in (or records) one of the user's projects.
  let cwd: string | null
  try {
    cwd = await ownedFolder(ctx.stateDir, ['quota', 'claude-run'], { create: true })
  } catch {
    cwd = null
  }
  if (!cwd)
    return failed(
      `sideby's folder ${join(ctx.stateDir, 'quota')} is not safe to use; check its owner and mode`,
    )
  const child = spawn('claude', [...CLAUDE_QUOTA_ARGS], {
    cwd,
    env: ctx.hostEnv,
    // stderr may name this computer's paths or settings: never read.
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  // Only this short-lived query process is ended, never a running Claude Code session.
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
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
              ? 'Claude Code is not installed or not on PATH; install it, then refresh'
              : `could not start Claude Code (${err.code ?? 'error'})`,
          ),
        ),
      )
      child.on('close', () => {
        if (ctx.signal.aborted) return resolve(failed('the quota check was stopped; refresh to try again'))
        if (size > MAX_OUTPUT) return resolve(failed(UNRECOGNISED))
        let answer: unknown
        try {
          answer = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          return resolve(failed('Claude Code exited without answering; sideby asks again later'))
        }
        resolve(claudeUsageAnswer(answer, account, ctx.now.getTime()))
      })
    })
  } finally {
    ctx.signal.removeEventListener('abort', stop)
    stop()
  }
}

export const claudeQuotaFetch: QuotaFetch = {
  everyMinutes: 15,
  summary: 'Ask Claude Code for each account’s quota (its /usage command, no model turn) every 15 minutes',
  fetch: fetchClaudeQuota,
}
