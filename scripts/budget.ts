// WHY: a ratchet on comment lines and test cases, so both only shrink unless a test is deliberately justified
// (AGENTS.md "Tests"). Baseline lives in .budget.json; a total above it fails `pnpm check`.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const BASELINE = '.budget.json'
const SCOPE = /^(src|scripts|testing|mods)\/.*\.(ts|js|mjs|sh)$/
const EXCLUDE =
  /^(src\/panel\/themes\.ts|src\/panel\/ui-css\.ts|src\/panel\/ui\/.*)$|(^|\/)(fixtures|dist|schemas)\//
const EXEMPT =
  /WHY:|HACK\(|ADR-\d+|biome-ignore|@ts-expect-error|@ts-ignore|eslint-disable|istanbul ignore|c8 ignore/
const TEST_CALL = /^\s*(?:it|test)(?:\.\w+)?\s*\(/

type Counts = { total: number; files: Record<string, number> }
type Raise = { date: string; reason: string; from: number; to: number }
type Baseline = { comments: Counts; tests: Counts & { history: Raise[] } }

function commentLineFlags(text: string, shell: boolean): boolean[] {
  const lines = text.split('\n')
  const flags: boolean[] = []
  let inBlock = false
  lines.forEach((line, i) => {
    const t = line.trim()
    if (shell) {
      flags.push(t.startsWith('#') && !(i === 0 && t.startsWith('#!')))
      return
    }
    if (inBlock) {
      const end = t.indexOf('*/')
      if (end === -1) flags.push(t !== '')
      else {
        inBlock = false
        flags.push(t.slice(end + 2).trim() === '')
      }
      return
    }
    if (t.startsWith('//')) {
      flags.push(true)
      return
    }
    if (t.startsWith('/*')) {
      const end = t.indexOf('*/', 2)
      if (end === -1) inBlock = true
      flags.push(end === -1 || t.slice(end + 2).trim() === '')
      return
    }
    flags.push(false)
  })
  return flags
}

export function countComments(text: string, shell = false): number {
  const lines = text.split('\n')
  const flags = commentLineFlags(text, shell)
  let counted = 0
  let i = 0
  while (i < flags.length) {
    if (!flags[i]) {
      i++
      continue
    }
    let j = i
    let exempt = false
    while (j < flags.length && flags[j]) {
      if (EXEMPT.test(lines[j] ?? '')) exempt = true
      j++
    }
    if (!exempt) counted += j - i
    i = j
  }
  return counted
}

export function countTests(text: string): number {
  const flags = commentLineFlags(text, false)
  return text.split('\n').filter((line, i) => !flags[i] && TEST_CALL.test(line)).length
}

function listFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  return [...new Set(out.split('\0'))]
    .filter((f) => SCOPE.test(f) && !EXCLUDE.test(f) && existsSync(resolve(ROOT, f)))
    .sort()
}

export function measure(): { comments: Counts; tests: Counts } {
  const comments: Counts = { total: 0, files: {} }
  const tests: Counts = { total: 0, files: {} }
  for (const file of listFiles()) {
    const text = readFileSync(resolve(ROOT, file), 'utf8')
    const c = countComments(text, file.endsWith('.sh'))
    if (c > 0) comments.files[file] = c
    comments.total += c
    if (file.endsWith('.test.ts')) {
      const t = countTests(text)
      if (t > 0) tests.files[file] = t
      tests.total += t
    }
  }
  return { comments, tests }
}

function grown(base: Counts, now: Counts): string[] {
  return Object.entries(now.files)
    .filter(([f, n]) => n > (base.files[f] ?? 0))
    .map(([f, n]) => `  ${f}: ${base.files[f] ?? 0} -> ${n}`)
}

function write(b: Baseline): void {
  writeFileSync(resolve(ROOT, BASELINE), `${JSON.stringify(b, null, 2)}\n`)
}

function main(argv: string[]): number {
  const tighten = argv.includes('--tighten')
  const raiseAt = argv.indexOf('--raise-tests')
  const reason = raiseAt === -1 ? undefined : (argv[raiseAt + 1] ?? '').trim()
  const known = new Set(['--tighten', '--raise-tests'])
  const unknown = argv.filter((a, i) => !known.has(a) && (raiseAt === -1 || i !== raiseAt + 1))
  if (unknown.length > 0 || reason === '') {
    console.error(
      'budget: usage: node scripts/budget.ts [--tighten | --raise-tests "<reason>"]; --raise-tests needs a reason from AGENTS.md "Tests"',
    )
    return 2
  }
  const now = measure()
  const path = resolve(ROOT, BASELINE)
  if (!existsSync(path)) {
    if (!tighten) {
      console.error(
        `budget: ${BASELINE} is missing; create it from the current tree with: pnpm budget --tighten`,
      )
      return 2
    }
    write({ comments: now.comments, tests: { ...now.tests, history: [] } })
    console.log(`budget: wrote ${BASELINE}: comments ${now.comments.total}, tests ${now.tests.total}`)
    return 0
  }
  const base = JSON.parse(readFileSync(path, 'utf8')) as Baseline
  base.tests.history ??= []
  let changed = false

  if (reason !== undefined) {
    if (now.tests.total <= base.tests.total) {
      console.log(
        `budget: tests ${now.tests.total} are within the baseline ${base.tests.total}; nothing to raise`,
      )
    } else {
      const date = new Date().toISOString().slice(0, 10)
      base.tests.history.push({ date, reason, from: base.tests.total, to: now.tests.total })
      base.tests = { ...now.tests, history: base.tests.history }
      changed = true
      console.log(`budget: test baseline raised to ${now.tests.total} (${reason})`)
    }
  }

  let failed = false
  if (now.comments.total > base.comments.total) {
    failed = true
    console.error(
      [
        `budget: comment lines grew from ${base.comments.total} to ${now.comments.total}. Files above their baseline:`,
        ...grown(base.comments, now.comments),
        'Fix: delete comments that restate the code or describe history. Keep a needed one by adding WHY:, ADR-<n> or HACK(<issue>) to its comment block. Comments have no raise flag.',
      ].join('\n'),
    )
  }
  if (now.tests.total > base.tests.total) {
    failed = true
    console.error(
      [
        `budget: test cases grew from ${base.tests.total} to ${now.tests.total}. Files above their baseline:`,
        ...grown(base.tests, now.tests),
        'Fix: a new test needs one reason from AGENTS.md "Tests": the user asked for it; it covers money, credits, permissions, data writes or migrations; it reproduces a bug by failing first; or it tests pure logic callable without rendering. Test one behaviour in one layer.',
        'If it qualifies, run: pnpm budget --raise-tests "<reason>". Otherwise delete the test or fold it into an existing one.',
      ].join('\n'),
    )
  }

  if (tighten && now.comments.total < base.comments.total) {
    console.log(`budget: comments baseline tightened from ${base.comments.total} to ${now.comments.total}`)
    base.comments = now.comments
    changed = true
  }
  if (tighten && now.tests.total < base.tests.total) {
    console.log(`budget: tests baseline tightened from ${base.tests.total} to ${now.tests.total}`)
    base.tests = { ...now.tests, history: base.tests.history }
    changed = true
  }
  if (changed) write(base)
  if (failed) return 1

  const slack = (n: number, b: number) =>
    n < b ? ` (${b - n} below baseline; lock it in with pnpm budget --tighten)` : ''
  console.log(
    `budget: ok; comments ${now.comments.total}/${base.comments.total}${slack(now.comments.total, base.comments.total)}, tests ${now.tests.total}/${base.tests.total}${slack(now.tests.total, base.tests.total)}`,
  )
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
