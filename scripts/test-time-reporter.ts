// WHY: a node:test reporter that `pnpm test` sends to stderr next to the spec output. It only warns: a file's time
// depends on the machine, so a hard limit would fail CI by chance.
import { relative } from 'node:path'

const LIMIT_S = 15

type TestEvent = {
  type: string
  data: { nesting?: number; file?: string; details?: { duration_ms?: number } }
}

// WHY: the per-file maximum of top-level durations is the file's own run (Node 22 and 24 add one top-level event per
// file that spans its import and all its tests); without that event it falls back to the slowest top-level test.
export default async function* testTimeReporter(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  const files = new Map<string, number>()
  for await (const { type, data } of source) {
    if (type !== 'test:complete' || data.nesting !== 0 || !data.file) continue
    const ms = data.details?.duration_ms ?? 0
    if (ms > (files.get(data.file) ?? 0)) files.set(data.file, ms)
  }
  const slow = [...files].filter(([, ms]) => ms > LIMIT_S * 1000).sort((a, b) => b[1] - a[1])
  if (slow.length === 0) return
  yield [
    '',
    `WARNING: ${slow.length} test file(s) took more than ${LIMIT_S} s on their own:`,
    ...slow.map(([file, ms]) => `  ${relative(process.cwd(), file)}: ${(ms / 1000).toFixed(1)} s`),
    'Split the file, or run its CLI calls in-process with sideby()/runMain instead of a subprocess (AGENTS.md "Tests").',
    '',
  ].join('\n')
}
