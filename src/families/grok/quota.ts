// Asks the Grok CLI for an Account's Quota (spec §3.26, ADR-0025): `grok agent --no-leader stdio` answers the ACP
// extension method `_x.ai/billing` with the request it makes itself, using the login of the `GROK_HOME` it runs under.
// sideby never reads the token and never sends a request of its own; no session is started.
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import type { Account, QuotaFetch, QuotaFetchContext, QuotaResult } from '../../types.ts'
import { grokQuota } from './quota-log.ts'

export const GROK_QUOTA_ARGS = ['agent', '--no-leader', 'stdio'] as const
export const GROK_BILLING_METHOD = '_x.ai/billing'
/** How long Grok may take to exit after its stdin closes before sideby ends it. */
const EXIT_GRACE_MS = 10_000

/** How long to wait before asking again after a failed answer, while Grok refreshes an expired token. */
const RETRY_MS = 1500
const METHOD_NOT_FOUND = -32601
const AUTH_REQUIRED = -32000

const failed = (detail: string): QuotaResult => ({ status: 'unavailable', reason: 'fetch-failed', detail })

/** Why an error answer gave no Quota, and what to do. Grok's own message is never repeated (only matched). */
function errorDetail(account: Account, error: { code?: unknown; data?: unknown; message?: unknown }): string {
  if (error.code === METHOD_NOT_FOUND)
    return 'this Grok version cannot report the quota; update Grok, then refresh'
  if (error.code === AUTH_REQUIRED) {
    const text = `${typeof error.data === 'string' ? error.data : ''} ${typeof error.message === 'string' ? error.message : ''}`
    if (text.includes('grok.com'))
      return 'this account is signed in with an API key, which has no subscription quota'
    return `Grok is not signed in for this account; run \`sideby login ${account.ref}\``
  }
  return `Grok could not get the quota from xAI (error ${typeof error.code === 'number' ? error.code : 'unknown'}); sideby asks again later, or start Grok in this account once`
}

export async function fetchGrokQuota(account: Account, ctx: QuotaFetchContext): Promise<QuotaResult> {
  if (ctx.signal.aborted) return failed('the quota check was stopped')
  const child = spawn('grok', [...GROK_QUOTA_ARGS], {
    cwd: tmpdir(),
    env: { ...ctx.hostEnv, GROK_DISABLE_AUTOUPDATER: '1' },
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  const finish = () => {
    // Grok exits by itself once its stdin closes; it is ended only when it does not.
    child.stdin.end()
    const timer = setTimeout(stop, EXIT_GRACE_MS)
    timer.unref()
    child.once('exit', () => clearTimeout(timer))
    child.unref()
  }
  ctx.signal.addEventListener('abort', stop, { once: true })
  try {
    return await new Promise<QuotaResult>((resolve) => {
      const lines = createInterface({ input: child.stdout })
      let done = false
      const settle = (r: QuotaResult) => {
        if (done) return
        done = true
        lines.close()
        resolve(r)
      }
      child.on('error', (err: NodeJS.ErrnoException) =>
        settle(
          failed(
            err.code === 'ENOENT'
              ? 'Grok is not installed or not on PATH; install it, then refresh'
              : `could not start Grok (${err.code ?? 'error'})`,
          ),
        ),
      )
      // `close` comes after the last stdout line, so an answer written just before exiting still counts.
      child.on('close', () => settle(failed('Grok exited without answering; sideby asks again later')))
      ctx.signal.addEventListener('abort', () => settle(failed('the quota check was stopped')), {
        once: true,
      })
      child.stdin.on('error', () => {})
      let id = 1
      const ask = () =>
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id, method: GROK_BILLING_METHOD, params: {} })}\n`,
        )
      lines.on('line', (line) => {
        let msg: { id?: unknown; result?: unknown; error?: unknown }
        try {
          msg = JSON.parse(line)
        } catch {
          return
        }
        if (msg?.id !== id) return
        if (msg.error && typeof msg.error === 'object') {
          const error = msg.error as Record<string, unknown>
          // A login whose token just expired fails once: Grok sends the old token and refreshes it as it starts
          // (seen 2026-10-17), so the same process is asked once more after a moment.
          if (id === 1 && error.code !== METHOD_NOT_FOUND && error.code !== AUTH_REQUIRED) {
            id = 2
            setTimeout(() => {
              if (!done) ask()
            }, RETRY_MS).unref()
            return
          }
          settle(failed(errorDetail(account, error)))
          return
        }
        const q = grokQuota(msg.result, ctx.now.toISOString(), 'grok agent')
        settle(q ?? failed('Grok answered in a form sideby does not recognise; update sideby'))
      })
      ask()
    })
  } finally {
    ctx.signal.removeEventListener('abort', stop)
    finish()
  }
}

export const grokQuotaFetch: QuotaFetch = {
  everyMinutes: 15,
  summary: "Grok asks xAI for each account's weekly quota, at most every 15 minutes",
  fetch: fetchGrokQuota,
}
