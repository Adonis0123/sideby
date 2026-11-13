// Current quota through Codex's documented app-server protocol (ADR-0038), and the one request that spends a Limit
// Reset (ADR-0072). The Host handles its own login; no thread, model turn, credential extraction or direct HTTP request.
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import type {
  Account,
  LimitResetContext,
  LimitResetOutcome,
  LimitResets,
  QuotaFetch,
  QuotaFetchContext,
  QuotaResult,
} from '../../types.ts'
import { isObj, rateLimits } from './rate-limits.ts'

const failed = (detail: string): QuotaResult => ({ status: 'unavailable', reason: 'fetch-failed', detail })

/**
 * The Limit Resets the answer tells (`rateLimitResetCredits`, ADR-0072), or undefined when it does not tell: the
 * field is missing or null, or its count is not a whole number. `availableCount` is the count; the detail rows may be
 * missing or cut short, so the next expiry is kept only when they cover every available credit. No credit id, title
 * or description is kept.
 */
export function limitResetsOf(raw: unknown, observedAt: string): LimitResets | undefined {
  if (!isObj(raw)) return undefined
  const available = raw.availableCount
  if (typeof available !== 'number' || !Number.isInteger(available) || available < 0) return undefined
  const out: LimitResets = { available, observedAt }
  const rows = raw.credits
  if (available === 0 || !Array.isArray(rows)) return out
  const open = rows.filter((c) => isObj(c) && c.status === 'available')
  if (open.length < available) return out
  const expiries = open
    .map((c) => (isObj(c) ? c.expiresAt : null))
    .filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0)
  if (expiries.length) out.nextExpiresAt = new Date(Math.min(...expiries) * 1000).toISOString()
  return out
}

/** Prefer the general Codex bucket; a model-specific bucket is not the account's general quota. */
function quotaAnswer(result: unknown): QuotaResult {
  if (!isObj(result)) return failed('Codex returned no quota; update Codex, then refresh')
  const buckets = result.rateLimitsByLimitId
  const raw =
    buckets === undefined || buckets === null ? result.rateLimits : isObj(buckets) ? buckets.codex : null
  if (!isObj(raw) || (raw.limitId !== undefined && raw.limitId !== 'codex'))
    return failed('Codex returned no general quota; update Codex, then refresh')
  const window = (w: unknown) =>
    isObj(w)
      ? {
          used_percent: w.usedPercent,
          window_minutes: w.windowDurationMins,
          resets_at: w.resetsAt,
        }
      : w
  const parsed = rateLimits({
    rate_limits: {
      limit_id: 'codex',
      primary: window(raw.primary),
      secondary: window(raw.secondary),
      plan_type: raw.planType,
    },
  })
  if (!parsed) return failed('Codex returned an unrecognized quota; update Codex, then refresh')
  const observedAt = new Date().toISOString()
  const limitResets = limitResetsOf(result.rateLimitResetCredits, observedAt)
  return {
    status: 'ok',
    ...parsed,
    observedAt,
    source: 'codex app-server account/rateLimits/read',
    ...(limitResets ? { limitResets } : {}),
  }
}

/** What ended one request to `codex app-server` before the Host answered it. */
type AskFailure =
  | 'stopped'
  | 'not-installed'
  | 'no-start'
  | 'closed'
  | 'exited'
  | 'unsupported'
  | 'refused'
  /** The Host answered the request with an error; nothing of it is kept. */
  | 'error'

type AskAnswer = { ok: true; result: unknown } | { ok: false; why: AskFailure }

/**
 * One request to the Account's own `codex app-server`: starts it with the Account's launch environment, initializes,
 * sends `request` and resolves with its answer. Only this short-lived process is ended afterwards, never a session.
 * `sent` is called once the request has been written, so a caller can tell "never sent" from "sent, no answer".
 */
function askAppServer(
  account: Account,
  ctx: QuotaFetchContext,
  request: { method: string; params?: unknown },
  sent?: () => void,
): Promise<AskAnswer> {
  if (ctx.signal.aborted) return Promise.resolve({ ok: false, why: 'stopped' })
  const args = [...(!account.isMain ? ['-c', 'cli_auth_credentials_store="file"'] : []), 'app-server']
  const child = spawn('codex', args, {
    cwd: tmpdir(),
    env: ctx.hostEnv,
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const lines = createInterface({ input: child.stdout })
  return new Promise<AskAnswer>((resolve) => {
    let done = false
    let pending = 1
    const stop = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    }
    const settle = (a: AskAnswer) => {
      if (done) return
      done = true
      ctx.signal.removeEventListener('abort', abort)
      lines.close()
      child.stdin.end()
      // Only this short-lived query process is ended, never an existing Codex session.
      const timer = setTimeout(stop, 1000)
      timer.unref()
      child.once('close', () => clearTimeout(timer))
      resolve(a)
    }
    const fail = (why: AskFailure) => settle({ ok: false, why })
    const abort = () => {
      stop()
      fail('stopped')
    }
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`)
    child.stdin.on('error', () => fail('closed'))
    child.on('error', (err: NodeJS.ErrnoException) =>
      fail(err.code === 'ENOENT' ? 'not-installed' : 'no-start'),
    )
    child.on('close', () => fail('exited'))
    ctx.signal.addEventListener('abort', abort, { once: true })
    lines.on('line', (line) => {
      if (done) return
      let msg: unknown
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (!isObj(msg) || msg.id !== pending) return
      if (isObj(msg.error)) {
        // Never keep the Host's raw error: it may contain credentials or account identifiers.
        fail(msg.error.code === -32601 ? 'unsupported' : pending === 1 ? 'refused' : 'error')
      } else if (pending === 1) {
        pending = 2
        send({ method: 'initialized' })
        send({ id: 2, ...request })
        sent?.()
      } else {
        settle({ ok: true, result: msg.result })
      }
    })
    send({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'sideby', version: '1' }, capabilities: { experimentalApi: false } },
    })
    if (ctx.signal.aborted) abort()
  })
}

export async function fetchCodexQuota(account: Account, ctx: QuotaFetchContext): Promise<QuotaResult> {
  const a = await askAppServer(account, ctx, { method: 'account/rateLimits/read' })
  if (a.ok) return quotaAnswer(a.result)
  switch (a.why) {
    case 'stopped':
      return failed('the Codex quota check was stopped; refresh to try again')
    case 'not-installed':
      return failed('Codex is not installed or not on PATH; install Codex, then refresh')
    case 'no-start':
      return failed('could not start Codex; check its installation, then refresh')
    case 'closed':
      return failed('Codex closed the quota query; refresh to try again')
    case 'exited':
      return failed('Codex exited without answering; update Codex, then refresh')
    case 'unsupported':
      return failed('this Codex version cannot report quota; update Codex, then refresh')
    default:
      return failed(
        `Codex could not read quota; refresh or run \`sideby login ${account.ref}\` if signed out`,
      )
  }
}

const CONSUME = 'account/rateLimitResetCredit/consume'
const OUTCOMES: Readonly<Record<string, LimitResetOutcome>> = {
  reset: 'reset',
  nothingToReset: 'nothing-to-reset',
  noCredit: 'none-left',
  alreadyRedeemed: 'already-done',
}

/**
 * A spend that got no final answer. `sent` says whether the request left sideby: false means the Host never got it,
 * so nothing was spent; true means the outcome is unknown and only the same idempotency key may ask again.
 */
export class CodexLimitResetError extends Error {
  readonly sent: boolean
  constructor(message: string, sent: boolean) {
    super(message)
    this.sent = sent
  }
}

/**
 * Spends one Limit Reset of the Account through its own `codex app-server` (ADR-0072): the stable request
 * `account/rateLimitResetCredit/consume` with the idempotency key and no `creditId`, so the vendor picks the credit.
 * The Host sends it with its own login; no credential is read and nothing of the answer but its outcome is kept.
 * Throws when the Host gave no final outcome.
 */
export async function useCodexLimitReset(
  account: Account,
  ctx: LimitResetContext,
): Promise<LimitResetOutcome> {
  let sent = false
  const a = await askAppServer(
    account,
    ctx,
    { method: CONSUME, params: { idempotencyKey: ctx.idempotencyKey } },
    () => {
      sent = true
    },
  )
  if (a.ok) {
    const outcome =
      isObj(a.result) && typeof a.result.outcome === 'string' ? OUTCOMES[a.result.outcome] : undefined
    if (outcome) return outcome
    throw new CodexLimitResetError(
      'Codex answered the reset with something sideby does not know; update sideby',
      true,
    )
  }
  const why: Record<AskFailure, string> = {
    stopped: 'Codex did not answer in time',
    'not-installed': 'Codex is not installed or not on PATH; install Codex',
    'no-start': 'could not start Codex; check its installation',
    closed: 'Codex closed the connection before answering',
    exited: 'Codex exited without answering',
    unsupported: 'this Codex version cannot use a limit reset; update Codex',
    refused: `Codex did not start the connection; run \`sideby login ${account.ref}\` if signed out`,
    error: `Codex refused the reset; run \`sideby login ${account.ref}\` if signed out`,
  }
  // An error answer to the request itself is final for this attempt but not an outcome: the Host did not say whether
  // it spent one, so it stays unresolved like a lost answer. A method the Host does not know was never run.
  throw new CodexLimitResetError(why[a.why], sent && a.why !== 'unsupported')
}

export const codexQuotaFetch: QuotaFetch = {
  everyMinutes: 15,
  summary: 'Ask Codex for each account’s current quota every 15 minutes',
  localFallbackOnly: true,
  fetch: fetchCodexQuota,
}
