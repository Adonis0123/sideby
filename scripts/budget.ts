// WHY: a ratchet on comment lines, test cases, subprocess starts and long waits in tests, so all only shrink unless a
// test or subprocess is deliberately justified (AGENTS.md "Tests"). Baseline lives in .budget.json; a total above it
// fails `pnpm check`.
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
const SPAWN_SCOPE = /(\.test|-test-helpers)\.ts$/
const SPAWNERS = ['sidebySpawn', 'spawnMain']
const NODE_SPAWN = /\b(?:spawn|spawnSync|execFile|execFileSync|fork)\(\s*process\.execPath\b/g
const DEF =
  /^\s*(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)\s*[<(]|(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\()/
const TEST_OPEN = /^\s*(?:it|test|describe)(?:\.\w+)?\s*\(/
const WAIT =
  /\bsetTimeout\(\s*(?:\w+|\(\)\s*=>\s*\w+\(\))\s*,\s*(\d[\d_]*)\s*\)|\bawait\s+(?:sleep|delay|setTimeout)\(\s*(\d[\d_]*)\s*[,)]/g

type Counts = { total: number; files: Record<string, number> }
type Raise = { date: string; reason: string; from: number; to: number }
type Raised = Counts & { history: Raise[] }
type Baseline = { comments: Counts; tests: Raised; spawns?: Raised; waits?: Counts }
type Metrics = { comments: Counts; tests: Counts; spawns: Counts; waits: Counts }

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

// WHY: blanks comments and string contents (template literals may span lines) so a fake Host script written from
// a test string is not counted as the test's own subprocess or wait.
function codeLines(text: string): string[] {
  const flags = commentLineFlags(text, false)
  let inTemplate = false
  return text.split('\n').map((line, n) => {
    if (flags[n] && !inTemplate) return ''
    let out = ''
    let quote = inTemplate ? '`' : ''
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (quote) {
        if (c === '\\') i++
        else if (c === quote) {
          quote = ''
          out += c
        }
        continue
      }
      if (c === '/' && line[i + 1] === '/') break
      if (c === '/' && /(^|[(,=:[!&|?{};])\s*$/.test(out)) {
        let inClass = false
        for (i++; i < line.length; i++) {
          const r = line[i]
          if (r === '\\') i++
          else if (r === '[') inClass = true
          else if (r === ']') inClass = false
          else if (r === '/' && !inClass) break
        }
        out += '//'
        continue
      }
      if (c === "'" || c === '"' || c === '`') quote = c
      out += c
    }
    inTemplate = quote === '`'
    return out
  })
}

const indentOf = (s: string) => s.length - s.trimStart().length

// WHY: biome's indentation stands in for a parser: walking up through ever less indented lines visits the
// constructs that enclose line n; the first named function among them is the local wrapper, and a test body ends
// the search.
function wrapperOf(lines: string[], n: number): string | undefined {
  const own = DEF.exec(lines[n] ?? '')
  if (own) return own[1] ?? own[2]
  let min = indentOf(lines[n] ?? '')
  for (let i = n - 1; i >= 0 && min > 0; i--) {
    const l = lines[i] ?? ''
    if (l.trim() === '' || indentOf(l) >= min) continue
    min = /^\s*[)\]}]/.test(l) ? indentOf(l) + 1 : indentOf(l)
    if (TEST_OPEN.test(l)) return undefined
    const d = DEF.exec(l)
    if (d) return d[1] ?? d[2]
  }
  return undefined
}

// WHY: a local helper that wraps a subprocess (a file's own `cli()` or `sideby()`) would count once however many
// tests call it, so its call sites count instead. Shell commands written as strings ("$NODE" "$MAIN") are not seen.
export function countSpawns(text: string): number {
  const lines = codeLines(text)
  const code = lines.join('\n')
  const lineAt = (index: number) => code.slice(0, index).split('\n').length - 1
  const calls = (names: string[]) =>
    [...code.matchAll(new RegExp(`(?<![.\\w])(?<!function\\s+)(${names.join('|')})\\(`, 'g'))].map((m) => ({
      line: lineAt(m.index ?? 0),
      name: m[1],
    }))
  const sites = [
    ...[...code.matchAll(NODE_SPAWN)].map((m) => ({ line: lineAt(m.index ?? 0), name: '' })),
    ...calls(SPAWNERS),
  ]
  const wrappers = new Set<string>()
  const outside: string[] = []
  for (const s of sites) {
    const w = wrapperOf(lines, s.line)
    if (w && w !== s.name) wrappers.add(w)
    else outside.push(s.name ?? '')
  }
  let total = outside.filter((name) => !wrappers.has(name)).length
  if (wrappers.size === 0) return total
  const used = new Map<string, number>()
  for (const c of calls([...wrappers])) {
    const w = wrapperOf(lines, c.line)
    if (w && wrappers.has(w)) continue
    used.set(c.name ?? '', (used.get(c.name ?? '') ?? 0) + 1)
  }
  for (const w of wrappers) total += Math.max(1, used.get(w) ?? 0)
  return total
}

// WHY: only awaited timers count; `timeoutMs` and a fake Host's own timers are upper bounds a test rarely sits
// through, and counting them would block legitimate code with no raise flag. A `setTimeout(r, N)` on a line
// without `Promise` (a wait split over lines) is not seen.
export function countWaits(text: string): number {
  let total = 0
  for (const line of codeLines(text)) {
    for (const m of line.matchAll(WAIT)) {
      const ms = Number((m[1] ?? m[2] ?? '').replaceAll('_', ''))
      if (ms >= 1000 && (m[2] !== undefined || /\bPromise\b/.test(line))) total++
    }
  }
  return total
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

export function measure(): Metrics {
  const m: Metrics = {
    comments: { total: 0, files: {} },
    tests: { total: 0, files: {} },
    spawns: { total: 0, files: {} },
    waits: { total: 0, files: {} },
  }
  const add = (c: Counts, file: string, n: number) => {
    if (n > 0) c.files[file] = n
    c.total += n
  }
  for (const file of listFiles()) {
    const text = readFileSync(resolve(ROOT, file), 'utf8')
    add(m.comments, file, countComments(text, file.endsWith('.sh')))
    if (file.endsWith('.test.ts')) add(m.tests, file, countTests(text))
    if (SPAWN_SCOPE.test(file)) {
      add(m.spawns, file, countSpawns(text))
      add(m.waits, file, countWaits(text))
    }
  }
  return m
}

function grown(base: Counts, now: Counts): string[] {
  return Object.entries(now.files)
    .filter(([f, n]) => n > (base.files[f] ?? 0))
    .map(([f, n]) => `  ${f}: ${base.files[f] ?? 0} -> ${n}`)
}

function write(b: Baseline): void {
  writeFileSync(resolve(ROOT, BASELINE), `${JSON.stringify(b, null, 2)}\n`)
}

const RAISE_FLAGS = { '--raise-tests': 'tests', '--raise-spawns': 'spawns' } as const
type RaiseKey = (typeof RAISE_FLAGS)[keyof typeof RAISE_FLAGS]

function parseArgs(argv: string[]): { tighten: boolean; raises: Map<RaiseKey, string> } | undefined {
  const raises = new Map<RaiseKey, string>()
  let tighten = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a === '--tighten') tighten = true
    else if (a in RAISE_FLAGS) {
      const reason = (argv[++i] ?? '').trim()
      if (reason === '' || reason.startsWith('--')) return undefined
      raises.set(RAISE_FLAGS[a as keyof typeof RAISE_FLAGS], reason)
    } else return undefined
  }
  return { tighten, raises }
}

const FIX = {
  comments:
    'Fix: delete comments that restate the code or describe history. Keep a needed one by adding WHY:, ADR-<n> or HACK(<issue>) to its comment block. Comments have no raise flag.',
  tests: [
    'Fix: a new test needs one reason from AGENTS.md "Tests": the user asked for it; it covers money, credits, permissions, data writes or migrations; it reproduces a bug by failing first; or it tests pure logic callable without rendering. Test one behaviour in one layer.',
    'If it qualifies, run: pnpm budget --raise-tests "<reason>". Otherwise delete the test or fold it into an existing one.',
  ].join('\n'),
  spawns: [
    'Fix: run the CLI in-process with sideby() or runMain from src/cli/cli-test-helpers.ts (or call the cmd* function). A subprocess is for one exit-code/--json smoke test per command, or where only a real child behaves right (real stdin, signals, background processes).',
    'If it is truly needed, run: pnpm budget --raise-spawns "<reason>".',
  ].join('\n'),
  waits:
    'Fix: do not sleep 1 s or more in a test. Inject a fake clock or pass a short timeout option instead. Waits have no raise flag.',
}

function main(argv: string[]): number {
  const args = parseArgs(argv)
  if (!args) {
    console.error(
      'budget: usage: node scripts/budget.ts [--tighten] [--raise-tests "<reason>"] [--raise-spawns "<reason>"]; a raise needs a reason from AGENTS.md "Tests"',
    )
    return 2
  }
  const { tighten, raises } = args
  const now = measure()
  const path = resolve(ROOT, BASELINE)
  if (!existsSync(path)) {
    if (!tighten) {
      console.error(
        `budget: ${BASELINE} is missing; create it from the current tree with: pnpm budget --tighten`,
      )
      return 2
    }
    write({
      comments: now.comments,
      tests: { ...now.tests, history: [] },
      spawns: { ...now.spawns, history: [] },
      waits: now.waits,
    })
    console.log(
      `budget: wrote ${BASELINE}: comments ${now.comments.total}, tests ${now.tests.total}, spawns ${now.spawns.total}, waits ${now.waits.total}`,
    )
    return 0
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Baseline
  let changed = false
  const missing = (['spawns', 'waits'] as const).filter((k) => parsed[k] === undefined)
  if (missing.length > 0) {
    if (!tighten) {
      console.error(
        `budget: ${BASELINE} has no ${missing.join(' or ')} baseline yet; add it from the current tree with: pnpm budget --tighten`,
      )
      return 2
    }
    parsed.spawns ??= { ...now.spawns, history: [] }
    parsed.waits ??= now.waits
    changed = true
    console.log(`budget: added the ${missing.join(' and ')} baseline`)
  }
  const base = parsed as Required<Baseline>
  base.tests.history ??= []
  base.spawns.history ??= []

  for (const [key, reason] of raises) {
    if (now[key].total <= base[key].total) {
      console.log(
        `budget: ${key} ${now[key].total} are within the baseline ${base[key].total}; nothing to raise`,
      )
      continue
    }
    const date = new Date().toISOString().slice(0, 10)
    const history = [...base[key].history, { date, reason, from: base[key].total, to: now[key].total }]
    base[key] = { ...now[key], history }
    changed = true
    console.log(`budget: ${key} baseline raised to ${now[key].total} (${reason})`)
  }

  const label = {
    comments: 'comment lines',
    tests: 'test cases',
    spawns: 'subprocess starts',
    waits: 'waits of 1 s or more',
  }
  const keys = ['comments', 'tests', 'spawns', 'waits'] as const
  let failed = false
  for (const key of keys) {
    if (now[key].total <= base[key].total) continue
    failed = true
    console.error(
      [
        `budget: ${label[key]} grew from ${base[key].total} to ${now[key].total}. Files above their baseline:`,
        ...grown(base[key], now[key]),
        FIX[key],
      ].join('\n'),
    )
  }

  if (tighten) {
    for (const key of keys) {
      if (now[key].total >= base[key].total) continue
      console.log(`budget: ${key} baseline tightened from ${base[key].total} to ${now[key].total}`)
      if (key === 'tests' || key === 'spawns') base[key] = { ...now[key], history: base[key].history }
      else base[key] = now[key]
      changed = true
    }
  }
  if (changed) write(base)
  if (failed) return 1

  const show = (key: (typeof keys)[number]) => {
    const n = now[key].total
    const b = base[key].total
    return `${key} ${n}/${b}${n < b ? ` (${b - n} below baseline; lock it in with pnpm budget --tighten)` : ''}`
  }
  console.log(`budget: ok; ${keys.map(show).join(', ')}`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
