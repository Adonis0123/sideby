// Current quota through Codex's documented app-server protocol (ADR-0038). The Host handles its own login;
// no thread, model turn, credential extraction or direct HTTP request.
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import type { Account, QuotaFetch, QuotaFetchContext, QuotaResult } from '../../types.ts'
import { isObj, rateLimits } from './rate-limits.ts'

const failed = (detail: string): QuotaResult => ({ status: 'unavailable', reason: 'fetch-failed', detail })

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
  return {
    status: 'ok',
    ...parsed,
    observedAt: new Date().toISOString(),
    source: 'codex app-server account/rateLimits/read',
  }
}

export async function fetchCodexQuota(account: Account, ctx: QuotaFetchContext): Promise<QuotaResult> {
  if (ctx.signal.aborted) return failed('the Codex quota check was stopped; refresh to try again')
  const args = [...(!account.isMain ? ['-c', 'cli_auth_credentials_store="file"'] : []), 'app-server']
  const child = spawn('codex', args, {
    cwd: tmpdir(),
    env: ctx.hostEnv,
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const lines = createInterface({ input: child.stdout })
  return new Promise<QuotaResult>((resolve) => {
    let done = false
    let pending = 1
    const stop = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    }
    const settle = (q: QuotaResult) => {
      if (done) return
      done = true
      ctx.signal.removeEventListener('abort', abort)
      lines.close()
      child.stdin.end()
      // Only this short-lived query process is ended, never an existing Codex session.
      const timer = setTimeout(stop, 1000)
      timer.unref()
      child.once('close', () => clearTimeout(timer))
      resolve(q)
    }
    const abort = () => {
      stop()
      settle(failed('the Codex quota check was stopped; refresh to try again'))
    }
    const send = (request: unknown) => child.stdin.write(`${JSON.stringify(request)}\n`)
    child.stdin.on('error', () => settle(failed('Codex closed the quota query; refresh to try again')))
    child.on('error', (err: NodeJS.ErrnoException) =>
      settle(
        failed(
          err.code === 'ENOENT'
            ? 'Codex is not installed or not on PATH; install Codex, then refresh'
            : 'could not start Codex; check its installation, then refresh',
        ),
      ),
    )
    child.on('close', () => settle(failed('Codex exited without answering; update Codex, then refresh')))
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
        // Never include the Host's raw error: it may contain credentials or account identifiers.
        const detail =
          msg.error.code === -32601
            ? 'this Codex version cannot report quota; update Codex, then refresh'
            : `Codex could not read quota; refresh or run \`sideby login ${account.ref}\` if signed out`
        settle(failed(detail))
      } else if (pending === 1) {
        pending = 2
        send({ method: 'initialized' })
        send({ id: 2, method: 'account/rateLimits/read' })
      } else {
        settle(quotaAnswer(msg.result))
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

export const codexQuotaFetch: QuotaFetch = {
  everyMinutes: 15,
  summary: 'Ask Codex for each account’s current quota every 15 minutes',
  localFallbackOnly: true,
  fetch: fetchCodexQuota,
}
