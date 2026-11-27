// WHY: Entry for `sideby runs-hook claude SessionStart`: injects a <=3-line Run pointer after Claude Code compaction
// (`source === "compact"`). Imports only leaf modules so cold start stays fast; never fails the Host (always exit 0).
import { resolvePaths } from '../core/paths.ts'
import { runCompactPointer } from '../core/run-board.ts'
import type { Env } from '../types.ts'

const STDIN_MAX = 1024 * 1024
const STDIN_WAIT_MS = 5000

type Input = AsyncIterable<string | Uint8Array> | string

async function readInput(input: Input): Promise<string> {
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
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      ;(input as { destroy?: () => unknown }).destroy?.()
      resolve('')
    }, STDIN_WAIT_MS).unref()
  })
  try {
    return await Promise.race([read, late])
  } finally {
    clearTimeout(timer)
  }
}

export async function runRunsHook(
  args: readonly string[],
  env: Env,
  input: Input,
  io: { out: { write(s: string): unknown } },
): Promise<number> {
  try {
    const [family, event] = args
    if (family !== 'claude' || event !== 'SessionStart') return 0
    const raw = await readInput(input)
    if (!raw.trim()) return 0
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 0
    if (parsed.source !== 'compact') return 0
    const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : undefined
    const cwd = typeof parsed.cwd === 'string' ? parsed.cwd : undefined
    if (!sessionId && !cwd) return 0
    const paths = resolvePaths(env)
    const pointer = await runCompactPointer(env, paths.home, { sessionId, cwd })
    if (!pointer.text) return 0
    io.out.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: pointer.text,
        },
      })}\n`,
    )
    return 0
  } catch {
    return 0
  }
}
