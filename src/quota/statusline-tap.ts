// Entry for `sideby statusline-tap` (spec §3.7). Claude Code runs it on every status line refresh, so it
// imports only Node built-ins and leaf modules (the cache module, core/fs-safe, core/paths), never the
// Runtime or a Family index. It caches `rate_limits` for the Account, then runs the original command.
// Nothing about the cache may change what the original command receives, prints or returns.
import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import {
  accountNameFromEnv,
  type ClaudeQuotaCache,
  cacheStateDir,
  parseRateLimits,
  writeQuotaCache,
} from '../families/claude/quota-cache.ts'
import type { Env } from '../types.ts'

/** Command the wrapper starts with; `quota setup claude` detects an existing wrapper by this prefix. */
export const TAP_COMMAND = 'sideby statusline-tap'
export const ORIG_FLAG = '--orig-b64'

export function defaultLine(cache: ClaudeQuotaCache | null): string {
  return (cache?.windows ?? []).map((w) => `${w.label} ${Math.round(w.usedPercent)}%`).join(' · ')
}

function originalCommand(argv: readonly string[]): string | null {
  let b64: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === ORIG_FLAG) b64 = argv[i + 1]
    else if (a.startsWith(`${ORIG_FLAG}=`)) b64 = a.slice(ORIG_FLAG.length + 1)
  }
  if (!b64) return null
  const cmd = Buffer.from(b64, 'base64').toString('utf8')
  return cmd.trim() ? cmd : null
}

/** Reads the whole stream; on a read error returns what arrived so far instead of nothing. */
async function readAll(stream: AsyncIterable<Uint8Array | string>): Promise<Buffer> {
  const chunks: Buffer[] = []
  try {
    for await (const c of stream) chunks.push(typeof c === 'string' ? Buffer.from(c) : Buffer.from(c))
  } catch {
    // keep the partial input
  }
  return Buffer.concat(chunks)
}

function runOriginal(
  cmd: string,
  input: Buffer,
  env: Env,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  return new Promise((done) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('/bin/sh', ['-c', cmd], {
        env: env as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      stderr.write(`sideby statusline-tap: ${(err as Error).message}\n`)
      done(127)
      return
    }
    child.stdout!.pipe(stdout, { end: false })
    child.stderr!.pipe(stderr, { end: false })
    // The original command may exit without reading stdin; that is not an error.
    child.stdin!.on('error', () => {})
    child.stdin!.end(input)
    child.on('error', (err) => {
      stderr.write(`sideby statusline-tap: ${err.message}\n`)
      done(127)
    })
    child.on('close', (code, signal) => {
      if (code !== null) done(code)
      else done(128 + ((signal && constants.signals[signal]) || 0))
    })
  })
}

/**
 * Runs the tap. `argv` is everything after `statusline-tap`. Returns the original command's exit code,
 * or 0 when there is no original command and a default line was printed.
 */
export async function runStatuslineTap(
  argv: string[],
  env: Env,
  stdin: AsyncIterable<Uint8Array | string>,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream = process.stderr,
): Promise<number> {
  const cmd = originalCommand(argv)
  let input: Buffer = Buffer.alloc(0)
  try {
    input = await readAll(stdin)
  } catch {
    // Pass through whatever arrived; a broken stdin must not hide the status line.
  }
  let cache: ClaudeQuotaCache | null = null
  const record = (async () => {
    try {
      cache = parseRateLimits(input.toString('utf8'), new Date())
      const name = accountNameFromEnv(env)
      if (!cache || !name) return
      await writeQuotaCache(cacheStateDir(env), name, cache)
    } catch {
      // Caching is best effort.
    }
  })()
  if (cmd === null) {
    await record
    stdout.write(`${defaultLine(cache)}\n`)
    return 0
  }
  const [code] = await Promise.all([runOriginal(cmd, input, env, stdout, stderr), record])
  return code
}
