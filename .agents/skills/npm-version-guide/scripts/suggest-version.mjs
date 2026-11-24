#!/usr/bin/env node
// Read-only Bump Suggestion for the package in the current folder (or --package <dir>).
// Reads .agents/release.json when present, finds the last release tag, classifies the commits
// and package.json changes since then, and prints "key: value" lines ending with a "next:" line
// that matches a branch in SKILL.md. Items it cannot classify are listed as needs_ai.
// Writes no files and never changes git: every git call is a read, with optional locks off.
// Zero dependencies: Node.js built-ins and the git CLI only.
//
// Usage: node suggest-version.mjs [--package <dir>] [--since <ref>] [--json]

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const SCHEMA_URL =
  'https://raw.githubusercontent.com/Adonis0123/npm-release-guide/main/schemas/release.v1.schema.json'
const CONFIG_FILE = path.join('.agents', 'release.json')
const DEFAULTS = {
  publish: { workflow: 'release.yml', environment: 'npm', prereleaseTag: 'next' },
  versioning: { zeroMajor: 'minor', preid: 'beta', tagPrefix: 'v' },
}
const LEVELS = ['none', 'patch', 'minor', 'major']
const DEFAULT_COMMIT_FORMAT = 'chore(release): v%s'
const INTERFACE_SENSITIVE_TYPES = new Set(['fix', 'refactor', 'perf'])
const MAX_TEXT_COMMITS = 40

// ---------- arguments ----------

function parseArgs(argv) {
  const out = { json: false, package: null, since: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') out.help = true
    else if (a === '--package') out.package = argv[++i]
    else if (a.startsWith('--package=')) out.package = a.slice('--package='.length)
    else if (a === '--since') out.since = argv[++i]
    else if (a.startsWith('--since=')) out.since = a.slice('--since='.length)
    else throw new Error(`unknown argument: ${a}`)
  }
  if (out.package === undefined) throw new Error('--package needs a folder')
  if (out.since === undefined) throw new Error('--since needs a git ref')
  return out
}

// ---------- git (read-only) ----------

function git(cwd, args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    })
  } catch (e) {
    if (allowFail) return null
    throw e
  }
}

// ---------- versions (small SemVer subset, F-74, F-82) ----------

const VERSION_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/

function parseVersion(s) {
  const m = VERSION_RE.exec(String(s).trim())
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] }
}

function formatVersion(v) {
  return `${v.major}.${v.minor}.${v.patch}${v.pre.length ? `-${v.pre.join('.')}` : ''}`
}

function compareVersions(a, b) {
  for (const k of ['major', 'minor', 'patch']) if (a[k] !== b[k]) return a[k] > b[k] ? 1 : -1
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny && +x !== +y) return +x > +y ? 1 : -1
    if (nx !== ny) return nx ? -1 : 1
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

// The version `npm version <level>` would produce (F-85: on a Pre-release, patch only drops the suffix).
function incVersion(cur, level) {
  const v = { ...cur, pre: [...cur.pre] }
  const isPre = v.pre.length > 0
  switch (level) {
    case 'major':
      if (!(isPre && v.minor === 0 && v.patch === 0)) v.major++
      v.minor = 0; v.patch = 0; v.pre = []; break
    case 'minor':
      if (!(isPre && v.patch === 0)) v.minor++
      v.patch = 0; v.pre = []; break
    case 'patch':
      if (!isPre) v.patch++
      v.pre = []; break
    default: return null
  }
  return formatVersion(v)
}

// Ranges as unions of [low, high) intervals over [major, minor, patch]; null when the range is too
// complex for this parser (hyphen ranges, Pre-release comparators, workspace: and similar), Q16.
const INF = [Infinity, 0, 0]
const cmpT = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0 }

function comparatorInterval(comp) {
  const m = /^(\^|~|>=|<=|>|<|=)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(comp)
  if (!m) return null
  const op = m[1] || '='
  const parts = [m[2], m[3], m[4]]
  const nums = []
  for (const x of parts) { if (x === undefined || /[xX*]/.test(x)) break; nums.push(+x) }
  const [M, mi, P] = nums
  const n = nums.length
  const lo = [M ?? 0, mi ?? 0, P ?? 0]
  const upNext = () => (n === 3 ? [M, mi, P + 1] : n === 2 ? [M, mi + 1, 0] : [M + 1, 0, 0])
  if (n === 0) return op === '<' ? null : [[0, 0, 0], INF]
  switch (op) {
    case '=': return [lo, upNext()]
    case '^':
      if (M > 0 || n === 1) return [lo, [M + 1, 0, 0]]
      if (mi > 0 || n === 2) return [lo, [0, mi + 1, 0]]
      return [lo, [0, 0, P + 1]]
    case '~': return [lo, n === 1 ? [M + 1, 0, 0] : [M, mi + 1, 0]]
    case '>=': return [lo, INF]
    case '>': return [upNext(), INF]
    case '<': return [[0, 0, 0], lo]
    case '<=': return [[0, 0, 0], upNext()]
    default: return null
  }
}

function rangeIntervals(range) {
  if (range === undefined || range === null) return null
  const r = String(range).trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1')
  if (r === '' || r === '*') return [[[0, 0, 0], INF]]
  if (/\s-\s/.test(r)) return null
  const out = []
  for (const alt of r.split('||')) {
    let lo = [0, 0, 0]
    let hi = INF
    for (const comp of alt.trim().split(/\s+/).filter(Boolean)) {
      const iv = comparatorInterval(comp)
      if (!iv) return null
      if (cmpT(iv[0], lo) > 0) lo = iv[0]
      if (cmpT(iv[1], hi) < 0) hi = iv[1]
    }
    if (cmpT(lo, hi) < 0) out.push([lo, hi])
  }
  return out
}

// true: the new range drops versions the old one allowed; false: it does not; null: cannot tell.
function rangeNarrowed(oldRange, newRange) {
  const a = rangeIntervals(oldRange)
  const b = rangeIntervals(newRange)
  if (!a || !b) return null
  const merged = b.sort((x, y) => cmpT(x[0], y[0])).reduce((acc, iv) => {
    const last = acc[acc.length - 1]
    if (last && cmpT(iv[0], last[1]) <= 0) { if (cmpT(iv[1], last[1]) > 0) last[1] = iv[1] } else acc.push([...iv])
    return acc
  }, [])
  return a.some(([lo, hi]) => !merged.some(([l2, h2]) => cmpT(l2, lo) <= 0 && cmpT(hi, h2) <= 0))
}

// ---------- commits (F-99, F-100, Q19) ----------

const EMOJI_PREFIX_RE =
  /^(?::[a-z0-9_+-]+:|[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}][\u{FE0E}\u{FE0F}\u{20E3}\u{200D}\u{1F3FB}-\u{1F3FF}\p{Extended_Pictographic}]*)\s*/u
const HEADER_RE = /^([A-Za-z]+)(?:\(([^()]*)\))?(!)?:\s*(\S.*)$/
const RELEASE_RE = [
  /^chore\(release\)!?:\s*v?\d+\.\d+\.\d+\S*\s*$/i,
  /^release:\s*v?\d+\.\d+\.\d+\S*\s*$/i,
  /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, // npm version's default commit message is the bare version
]

function stripEmojiPrefix(subject) {
  let s = subject.trim()
  for (let i = 0; i < 4; i++) {
    const m = EMOJI_PREFIX_RE.exec(s)
    if (!m || m[0].length === 0) break
    s = s.slice(m[0].length)
  }
  return s.trim()
}

function classifyCommit(subject, body) {
  const s = stripEmojiPrefix(subject)
  if (RELEASE_RE.some((re) => re.test(s))) return { level: 'ignored', reason: 'release commit' }
  const m = HEADER_RE.exec(s)
  if (!m) return { level: 'needs_ai', reason: 'not a Conventional Commit header' }
  const type = m[1].toLowerCase()
  const breaking = Boolean(m[3]) || /^BREAKING[ -]CHANGE:/m.test(body || '')
  if (breaking) return { level: 'major', type, reason: m[3] ? '"!" after the type' : 'BREAKING CHANGE footer' }
  if (type === 'feat' || type === 'feature') return { level: 'minor', type, reason: 'feature' }
  if (type === 'fix' || type === 'perf') return { level: 'patch', type, reason: type === 'fix' ? 'bug fix' : 'performance fix' }
  // Every other type has no effect on the version unless it is breaking (F-100, Q19).
  return { level: 'none', type, reason: `${type} does not change the version` }
}

function readCommits(root, range, pathspec) {
  const args = ['log', '--no-merges', '--format=%x1e%H%x1f%s%x1f%b%x1d', '--name-only']
  args.push(range || 'HEAD')
  if (pathspec) args.push('--', pathspec)
  const out = git(root, args)
  const commits = []
  for (const chunk of out.split('\x1e')) {
    if (!chunk.trim()) continue
    const [head, filesPart = ''] = chunk.split('\x1d')
    const [sha, subject = '', body = ''] = head.split('\x1f')
    const files = filesPart.split('\n').map((f) => f.trim()).filter(Boolean)
    commits.push({ sha, subject, body, files })
  }
  return commits
}

// ---------- package.json signals (Q20) ----------

function normaliseExports(exp) {
  if (exp === undefined || exp === null) return null
  if (typeof exp === 'string' || Array.isArray(exp)) return { '.': exp }
  if (typeof exp === 'object') {
    const keys = Object.keys(exp)
    if (keys.length && keys.every((k) => k.startsWith('.'))) return exp
    return { '.': exp }
  }
  return null
}

function conditionKeys(target) {
  if (target && typeof target === 'object' && !Array.isArray(target)) return Object.keys(target)
  return []
}

function normaliseBin(bin, name) {
  if (!bin) return {}
  if (typeof bin === 'string') return { [String(name || '').replace(/^@[^/]+\//, '')]: bin }
  return typeof bin === 'object' ? bin : {}
}

function stringLeaves(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) stringLeaves(v, out)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) stringLeaves(v, out)
  return out
}

function packageSignals(before, after) {
  const signals = []
  const add = (level, text) => signals.push({ level, text })
  if (!before) return signals

  const be = normaliseExports(before.exports)
  const ae = normaliseExports(after.exports)
  if (!be && ae) add('needs_ai', 'exports added for the first time: deep imports that worked before may now fail')
  if (be && !ae) add('major', 'exports field removed')
  if (be && ae) {
    for (const sub of Object.keys(be)) {
      if (!(sub in ae)) { add('major', `exports entry "${sub}" removed`); continue }
      if (be[sub] !== null && ae[sub] === null) { add('major', `exports entry "${sub}" now points to null (blocked)`); continue }
      const bc = conditionKeys(be[sub])
      const ac = conditionKeys(ae[sub])
      if (bc.length && !ac.length) {
        add('needs_ai', `exports entry "${sub}" changed from conditions ${bc.map((c) => `"${c}"`).join(', ')} to one target: check that every condition still resolves`)
        continue
      }
      const lost = bc.filter((c) => !ac.includes(c))
      if (lost.length && ac.length) add('major', `exports entry "${sub}" lost condition ${lost.map((c) => `"${c}"`).join(', ')}`)
    }
  }

  const bb = normaliseBin(before.bin, before.name)
  const ab = normaliseBin(after.bin, after.name)
  for (const cmd of Object.keys(bb)) if (!(cmd in ab)) add('major', `bin command "${cmd}" removed`)

  for (const field of ['main', 'module', 'types', 'typings']) {
    if (before[field] === undefined) continue
    if (after[field] === undefined) add('major', `${field} removed (was "${before[field]}")`)
    else if (after[field] !== before[field]) add('major', `${field} changed from "${before[field]}" to "${after[field]}"`)
  }

  const bn = before.engines?.node
  const an = after.engines?.node
  if (an !== undefined && bn === undefined) add('needs_ai', `engines.node added ("${an}"): check whether any Node.js version that worked before is now excluded`)
  else if (an !== undefined && an !== bn) {
    const narrowed = rangeNarrowed(bn, an)
    if (narrowed === null) add('needs_ai', `engines.node changed from "${bn}" to "${an}" (range too complex to compare)`)
    else if (narrowed) add('major', `engines.node narrowed from "${bn}" to "${an}": some Node.js versions that worked are now excluded`)
  }

  const bp = before.peerDependencies || {}
  const ap = after.peerDependencies || {}
  const optional = (pkg, dep) => pkg.peerDependenciesMeta?.[dep]?.optional === true
  for (const dep of Object.keys(ap)) {
    if (!(dep in bp)) {
      if (optional(after, dep)) add('minor', `new optional peer dependency "${dep}"`)
      else add('major', `new required peer dependency "${dep}" ("${ap[dep]}")`)
      continue
    }
    if (optional(before, dep) && !optional(after, dep)) add('major', `peer dependency "${dep}" is now required`)
    if (ap[dep] !== bp[dep]) {
      const narrowed = rangeNarrowed(bp[dep], ap[dep])
      if (narrowed === null) add('needs_ai', `peer dependency "${dep}" changed from "${bp[dep]}" to "${ap[dep]}" (range too complex to compare)`)
      else if (narrowed && optional(after, dep)) add('needs_ai', `optional peer dependency "${dep}" narrowed from "${bp[dep]}" to "${ap[dep]}"`)
      else if (narrowed) add('major', `peer dependency "${dep}" narrowed from "${bp[dep]}" to "${ap[dep]}": some versions users have are now excluded`)
    }
  }
  return signals
}

// ---------- Public Interface paths (Q21) ----------

function defaultInterfacePatterns(pkg) {
  const raw = [
    ...stringLeaves(pkg.exports),
    ...['main', 'module', 'types', 'typings'].map((f) => pkg[f]).filter((v) => typeof v === 'string'),
    ...Object.values(normaliseBin(pkg.bin, pkg.name)).filter((v) => typeof v === 'string'),
  ]
  const seen = new Set()
  for (const p of raw) {
    const clean = p.replace(/^\.\//, '')
    // package.json changes are compared field by field above, not as a Public Interface file.
    if (clean && clean !== 'package.json') seen.add(clean)
  }
  return [...seen]
}

function patternToRegex(pattern) {
  const esc = pattern.replace(/^\.\//, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '[^/]')
  return new RegExp(`^${esc}(?:/.*)?$`)
}

// ---------- config ----------

function findConfig(pkgDir, root) {
  let dir = pkgDir
  for (;;) {
    const file = path.join(dir, CONFIG_FILE)
    if (existsSync(file)) return file
    if (dir === root || dir === path.dirname(dir)) return null
    dir = path.dirname(dir)
  }
}

function normDir(d) {
  const s = String(d || '.').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  return s === '' ? '.' : s
}

function inferPublish(root) {
  const dir = path.join(root, '.github', 'workflows')
  let files = []
  try { files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort() } catch { /* no workflows */ }
  for (const f of files) {
    let text = ''
    try { text = readFileSync(path.join(dir, f), 'utf8') } catch { continue }
    if (!/(npm|pnpm|bun) publish|yarn npm publish/.test(text)) continue
    const env = /^\s*environment:\s*(?:\n\s*name:\s*)?['"]?([A-Za-z0-9_.-]+)['"]?\s*$/m.exec(text)
    return { workflow: f, environment: env ? env[1] : undefined, from: `.github/workflows/${f}` }
  }
  return null
}

// Same rules as schemas/release.v1.schema.json, so a broken file stops the run instead of being half-used.
const PRERELEASE_TAG_RE = /^(?!latest$)(?![vV]?\d)(?![xX](?:\.|$))[A-Za-z][A-Za-z0-9._-]*$/
const PREID_RE = /^(?!0\d+$)[0-9A-Za-z-]+$/
const WORKFLOW_RE = /^[^/\\]+\.ya?ml$/
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)

function validateConfig(raw) {
  const errors = []
  const keys = (obj, where, allowed) => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${where}: unknown field "${k}"`)
  }
  const publish = (p, where) => {
    if (!isObj(p)) return errors.push(`${where} must be an object`)
    keys(p, where, ['workflow', 'environment', 'prereleaseTag'])
    if (p.workflow !== undefined && !(typeof p.workflow === 'string' && WORKFLOW_RE.test(p.workflow))) errors.push(`${where}.workflow must be a file name ending in .yml or .yaml`)
    if (p.environment !== undefined && !(typeof p.environment === 'string' && p.environment.length)) errors.push(`${where}.environment must be a non-empty string`)
    if (p.prereleaseTag !== undefined && !(typeof p.prereleaseTag === 'string' && PRERELEASE_TAG_RE.test(p.prereleaseTag))) errors.push(`${where}.prereleaseTag must be a name such as next or beta: not latest and not something npm reads as a version range (F-89)`)
  }
  const versioning = (v, where) => {
    if (!isObj(v)) return errors.push(`${where} must be an object`)
    keys(v, where, ['zeroMajor', 'preid', 'tagPrefix', 'publicInterface'])
    if (v.zeroMajor !== undefined && !['minor', 'major'].includes(v.zeroMajor)) errors.push(`${where}.zeroMajor must be "minor" or "major"`)
    if (v.preid !== undefined && !(typeof v.preid === 'string' && PREID_RE.test(v.preid))) errors.push(`${where}.preid must use letters, digits or "-", and a number must not start with 0`)
    if (v.tagPrefix !== undefined && typeof v.tagPrefix !== 'string') errors.push(`${where}.tagPrefix must be a string`)
    if (v.publicInterface !== undefined && !(Array.isArray(v.publicInterface) && v.publicInterface.every((x) => typeof x === 'string' && x.length))) errors.push(`${where}.publicInterface must be a list of paths`)
  }
  if (!isObj(raw)) return ['top level must be an object']
  keys(raw, 'top level', ['$schema', 'version', 'publish', 'versioning', 'packages'])
  if (raw.version !== 1) errors.push(`"version" must be 1 (found ${JSON.stringify(raw.version)})`)
  if (raw.$schema !== undefined && typeof raw.$schema !== 'string') errors.push('"$schema" must be a string')
  if (raw.publish !== undefined) publish(raw.publish, 'publish')
  if (raw.versioning !== undefined) versioning(raw.versioning, 'versioning')
  if (raw.packages !== undefined) {
    if (!Array.isArray(raw.packages)) errors.push('packages must be a list')
    else {
      const seen = new Set()
      raw.packages.forEach((e, i) => {
        const where = `packages[${i}]`
        if (!isObj(e)) return errors.push(`${where} must be an object`)
        keys(e, where, ['dir', 'publish', 'versioning'])
        if (!(typeof e.dir === 'string' && e.dir.length)) errors.push(`${where}.dir is required`)
        else if (seen.has(normDir(e.dir))) errors.push(`${where}.dir "${e.dir}" appears twice`)
        else seen.add(normDir(e.dir))
        if (e.publish !== undefined) publish(e.publish, `${where}.publish`)
        if (e.versioning !== undefined) versioning(e.versioning, `${where}.versioning`)
      })
    }
  }
  return errors
}

function loadConfig(pkgDir, root, pkgRel) {
  const file = findConfig(pkgDir, root)
  if (!file) return { source: 'inferred', file: null, raw: null, errors: [] }
  const rel = path.relative(root, file).split(path.sep).join('/')
  let raw
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch (e) {
    return { source: rel, file, raw: null, errors: [`not valid JSON: ${e.message}`] }
  }
  const errors = validateConfig(raw)
  const configDir = path.dirname(path.dirname(file))
  const relToConfig = normDir(path.relative(configDir, pkgDir).split(path.sep).join('/'))
  const entry = Array.isArray(raw?.packages) ? raw.packages.find((p) => normDir(p?.dir) === relToConfig) : undefined
  return { source: rel, file, raw, entry, errors, pkgRel }
}

function effectiveSettings(cfg) {
  const raw = cfg.raw && typeof cfg.raw === 'object' ? cfg.raw : {}
  return {
    publish: { ...DEFAULTS.publish, ...(raw.publish || {}), ...(cfg.entry?.publish || {}) },
    versioning: { ...DEFAULTS.versioning, ...(raw.versioning || {}), ...(cfg.entry?.versioning || {}) },
  }
}

// ---------- main analysis ----------

function maxLevel(levels) {
  return levels.reduce((acc, l) => (LEVELS.indexOf(l) > LEVELS.indexOf(acc) ? l : acc), 'none')
}

function zeroMap(level, current, zeroMajor) {
  if (current.major !== 0 || zeroMajor === 'major') return level
  return { major: 'minor', minor: 'patch', patch: 'patch', none: 'none' }[level]
}

// <name>@<version> tags always belong to this package. <prefix><version> tags (v1.2.3) count only in a
// single-package repository or when the settings name a tagPrefix; in a monorepo they may belong to
// another package, so the caller must give --since.
function findLastRelease(root, name, prefix, current, prefixTrusted) {
  const out = git(root, ['tag', '--merged', 'HEAD', '--list'], { allowFail: true }) || ''
  const tags = out.split('\n').map((t) => t.trim()).filter(Boolean)
  const parse = (t, p) => (t.startsWith(p) ? parseVersion(t.slice(p.length)) : null)
  const byName = name ? tags.map((t) => ({ tag: t, v: parse(t, `${name}@`) })).filter((x) => x.v) : []
  const byPrefix = tags.filter((t) => !byName.some((x) => x.tag === t)).map((t) => ({ tag: t, v: parse(t, prefix) })).filter((x) => x.v)
  let pool = byName
  if (!pool.length && byPrefix.length) {
    if (!prefixTrusted) return { ambiguous: byPrefix.map((x) => x.tag) }
    pool = byPrefix
  }
  if (!pool.length) return null
  const highest = [...pool].sort((a, b) => compareVersions(b.v, a.v))[0]
  const exact = pool.find((x) => compareVersions(x.v, current) === 0)
  if (exact) return { ref: exact.tag, how: 'tag for the current package.json version', highest: highest.v, version: exact.v }
  const notAbove = pool.filter((x) => compareVersions(x.v, current) <= 0)
  const best = (notAbove.length ? notAbove : pool).sort((a, b) => compareVersions(b.v, a.v))[0]
  return { ref: best.tag, how: 'highest version tag reachable from HEAD', highest: highest.v, version: best.v }
}

// ---------- the repository's own release habits ----------

// A "release" script in package.json (and in the root package.json of a monorepo). Printed, never run.
function releaseScripts(pkg, root, pkgRel) {
  const found = []
  if (typeof pkg.scripts?.release === 'string') found.push(`package.json scripts.release: ${pkg.scripts.release}`)
  if (pkgRel !== '.') {
    let rootPkg = null
    try { rootPkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) } catch { rootPkg = null }
    if (typeof rootPkg?.scripts?.release === 'string') found.push(`root package.json scripts.release: ${rootPkg.scripts.release}`)
  }
  return found
}

// The last release commit's subject with its version replaced by %s, ready for npm version -m (F-119).
function releaseCommitFormat(root, base) {
  if (!base) return { format: DEFAULT_COMMIT_FORMAT, from: 'default (no release tag yet)' }
  if (!base.version) return { format: DEFAULT_COMMIT_FORMAT, from: `default (${base.ref} names no version)` }
  const version = formatVersion(base.version)
  const subject = (git(root, ['log', '-1', '--format=%s', `${base.ref}^{commit}`], { allowFail: true }) || '').trim()
  if (!subject.includes(version)) return { format: DEFAULT_COMMIT_FORMAT, from: `default (the commit of ${base.ref} does not name ${version})` }
  return { format: subject.split(version).join('%s'), from: `the commit of ${base.ref}` }
}

function isMonorepo(root, pkgRel, cfg) {
  if (pkgRel !== '.') return true
  if (existsSync(path.join(root, 'pnpm-workspace.yaml'))) return true
  try { if (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).workspaces) return true } catch { /* no root package.json */ }
  return Array.isArray(cfg.raw?.packages) && cfg.raw.packages.length > 1
}

const baseOf = (v) => ({ ...v, pre: [] })

// Exact target versions. Release: the level applied as npm does (F-85), or the Pre-release made final.
// Pre-release: start a new line, or continue the current one without going backwards (rc.3 never -> beta.0).
function planVersions(current, level, preid) {
  const isPre = current.pre.length > 0
  const plan = {}
  if (level !== 'none') {
    plan.release = parseVersion(incVersion(current, level))
    plan.releaseMode = isPre && compareVersions(plan.release, baseOf(current)) === 0 ? 'promote the Pre-release' : 'new release'
  } else if (isPre) {
    plan.release = baseOf(current)
    plan.releaseMode = 'promote the Pre-release (no new changes)'
  }
  const target = level !== 'none' ? parseVersion(incVersion(current, level)) : isPre ? baseOf(current) : null
  if (!target) return plan
  if (!isPre || compareVersions(target, baseOf(current)) !== 0) {
    plan.pre = { ...target, pre: [preid, '0'] }
    plan.preMode = 'start'
    return plan
  }
  const bumpLast = (pre) => {
    const next = [...pre]
    const i = next.findLastIndex((x) => /^\d+$/.test(x))
    if (i > 0) next[i] = String(+next[i] + 1)
    else next.push('0')
    return next
  }
  if (current.pre[0] === preid) {
    plan.pre = { ...current, pre: bumpLast(current.pre) }
    plan.preMode = 'continue'
  } else {
    const switched = { ...current, pre: [preid, '0'] }
    if (compareVersions(switched, current) > 0) {
      plan.pre = switched
      plan.preMode = `continue with ${preid}`
    } else {
      plan.pre = { ...current, pre: bumpLast(current.pre) }
      plan.preMode = `continue with ${current.pre[0]} (${preid} would sort below ${formatVersion(current)})`
    }
  }
  return plan
}

function analyse({ cwd = process.cwd(), packageDir = null, since = null } = {}) {
  const r = { script: 'suggest-version (read-only)', next: null }
  const pkgDir = path.resolve(cwd, packageDir || '.')
  const pkgFile = path.join(pkgDir, 'package.json')
  if (!existsSync(pkgFile)) {
    r.package_json = 'missing in this folder'
    r.suggested_level = 'unknown'
    r.next = 'no-package-json'
    return r
  }
  let pkg
  try { pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) } catch {
    r.package_json = 'unreadable (not valid JSON)'
    r.suggested_level = 'unknown'
    r.next = 'fix-package-json'
    return r
  }
  r.package_name = pkg.name || 'missing'
  const current = parseVersion(pkg.version || '')
  r.current_version = pkg.version || 'missing'
  if (!pkg.name || !current) {
    r.suggested_level = 'unknown'
    r.next = 'fix-package-json'
    return r
  }

  const rootOut = git(pkgDir, ['rev-parse', '--show-toplevel'], { allowFail: true })
  const headOk = rootOut && git(pkgDir, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true })
  if (!rootOut || !headOk) {
    r.git_repo = rootOut ? 'no commits yet' : 'none'
    r.suggested_level = 'unknown'
    r.next = 'no-git'
    return r
  }
  const root = rootOut.trim()
  const pkgRel = normDir(path.relative(root, pkgDir).split(path.sep).join('/'))
  r.package_dir_in_repo = pkgRel === '.' ? '. (repository root)' : pkgRel

  // Config: .agents/release.json, else inferred values the Agent can propose to write.
  const cfg = loadConfig(pkgDir, root, pkgRel)
  const settings = effectiveSettings(cfg)
  r.config_source = cfg.source
  if (cfg.errors.length) {
    r.config_errors = cfg.errors
    r.suggested_level = 'unknown'
    r.next = 'fix-config'
    return r
  }
  if (cfg.raw && Array.isArray(cfg.raw.packages) && pkgRel !== '.' && !cfg.entry) r.config_package_entry = `none for "${pkgRel}" (using top-level settings)`
  if (cfg.source === 'inferred') {
    const wf = inferPublish(root)
    const proposal = { $schema: SCHEMA_URL, version: 1 }
    // Without a publishing workflow there is nothing to describe yet; npm-publish-guide adds it during setup.
    if (wf) proposal.publish = { workflow: wf.workflow, ...(wf.environment ? { environment: wf.environment } : {}) }
    if (wf) settings.publish = { ...settings.publish, workflow: wf.workflow, ...(wf.environment ? { environment: wf.environment } : {}) }
    proposal.versioning = { zeroMajor: DEFAULTS.versioning.zeroMajor, preid: DEFAULTS.versioning.preid }
    if (pkgRel !== '.') proposal.packages = [{ dir: pkgRel }]
    r.config_inferred_from = wf ? `${wf.from}; versioning defaults` : 'defaults (no publishing workflow found)'
    r.config_proposal = proposal
  }
  const v = settings.versioning
  r.zero_major = v.zeroMajor
  r.publish_workflow = settings.publish.workflow
  r.publish_environment = settings.publish.environment
  r.publish_workflow_found = existsSync(path.join(root, '.github', 'workflows', settings.publish.workflow)) ? 'yes' : 'no'
  r.prerelease_tag = settings.publish.prereleaseTag

  const status = git(root, ['status', '--porcelain', '--untracked-files=no'], { allowFail: true })
  r.working_tree_clean = status === null ? 'unknown' : status.trim() === '' ? 'yes' : 'no (npm version refuses to run, F-86)'
  r.release_script = releaseScripts(pkg, root, pkgRel)

  const prefix = v.tagPrefix ?? 'v'
  const prefixTrusted = !isMonorepo(root, pkgRel, cfg) || cfg.raw?.versioning?.tagPrefix !== undefined || cfg.entry?.versioning?.tagPrefix !== undefined

  // Last release.
  let base = null
  if (since) {
    if (!git(root, ['rev-parse', '--verify', '--quiet', `${since}^{commit}`], { allowFail: true })) {
      r.last_release = `"${since}" is not a commit`
      r.suggested_level = 'unknown'
      r.next = 'need-since'
      return r
    }
    base = { ref: since, how: 'given with --since' }
  } else {
    base = findLastRelease(root, pkg.name, prefix, current, prefixTrusted)
  }
  if (base?.ambiguous) {
    r.last_release = `unknown: ${base.ambiguous.slice(-3).join(', ')} may belong to another package of this monorepo`
    r.suggested_level = 'unknown'
    r.next = 'need-since'
    return r
  }
  r.last_release = base ? `${base.ref} (${base.how})` : `none (no ${prefix}* or ${pkg.name}@* tag reachable from HEAD)`
  const commitFormat = releaseCommitFormat(root, base)
  r.release_commit_format = commitFormat.format
  r.release_commit_format_from = commitFormat.from
  r.current_is_prerelease = current.pre.length ? 'yes' : 'no'

  const pathspec = pkgRel === '.' ? null : pkgRel
  const commits = readCommits(root, base ? `${base.ref}..HEAD` : 'HEAD', pathspec)

  if (!base) {
    r.commits_since = commits.length
    r.suggested_level = 'none'
    r.npm_version_command = 'none: publish the current version as the First Release'
    r.next = 'first-release'
    return r
  }

  // Public Interface paths, relative to the repository root.
  const patterns = (Array.isArray(v.publicInterface) && v.publicInterface.length ? v.publicInterface : defaultInterfacePatterns(pkg))
    .map((p) => (pkgRel === '.' ? p.replace(/^\.\//, '') : `${pkgRel}/${p.replace(/^\.\//, '')}`))
  const regexes = patterns.map(patternToRegex)
  const tracked = (git(root, ['ls-files', '--', pathspec || '.'], { allowFail: true }) || '').split('\n').filter(Boolean)
  const untracked = patterns.filter((_, i) => !tracked.some((f) => regexes[i].test(f)))
  const trackedCount = patterns.length - untracked.length
  r.public_interface = patterns.length ? patterns.join(', ') : 'none (no exports, main, module, types or bin)'
  r.public_interface_source = Array.isArray(v.publicInterface) && v.publicInterface.length ? 'config versioning.publicInterface' : 'package.json entry points'
  r.public_interface_tracked = `${trackedCount} of ${patterns.length}${untracked.length ? ' (untracked entry points are build output: every fix, perf and refactor goes to needs_ai)' : ''}`

  const needsAi = []
  const classified = []
  for (const c of commits) {
    const cls = classifyCommit(c.subject, c.body)
    const item = { sha: c.sha.slice(0, 7), subject: c.subject, level: cls.level, reason: cls.reason }
    if (cls.level !== 'ignored' && cls.level !== 'major' && INTERFACE_SENSITIVE_TYPES.has(cls.type)) {
      // The commit keeps its own level as a lower bound; the review can only raise it.
      const hit = c.files.find((f) => regexes.some((re) => re.test(f)))
      if (hit) item.review = `${cls.type} changes Public Interface file ${hit}: check whether users must change anything`
      else if (untracked.length) item.review = `${cls.type} may change untracked entry point ${untracked[0]}: check whether users must change anything`
    }
    if (item.level === 'needs_ai') needsAi.push({ ref: item.sha, subject: item.subject, reason: item.reason })
    else if (item.review) needsAi.push({ ref: item.sha, subject: item.subject, reason: item.review, at_least: item.level })
    classified.push(item)
  }
  r.commits_since = commits.length
  r.commits = classified

  // package.json at the last release versus the working tree.
  const oldPkgPath = pkgRel === '.' ? 'package.json' : `${pkgRel}/package.json`
  const oldText = git(root, ['show', `${base.ref}:${oldPkgPath}`], { allowFail: true })
  let before = null
  try { before = oldText ? JSON.parse(oldText) : null } catch { before = null }
  r.package_json_compared = before ? `${base.ref} -> working tree` : `no (package.json missing or unreadable at ${base.ref})`
  const signals = packageSignals(before, pkg)
  r.signals = signals
  for (const s of signals) if (s.level === 'needs_ai') needsAi.push({ ref: 'package.json', reason: s.text })

  const rawLevel = maxLevel([...classified.map((c) => c.level), ...signals.map((s) => s.level)].filter((l) => LEVELS.includes(l)))
  const level = zeroMap(rawLevel, current, v.zeroMajor)
  r.raw_level = rawLevel
  r.suggested_level = level
  r.level_rule = current.major === 0 && v.zeroMajor !== 'major'
    ? '0.x with zeroMajor "minor": breaking -> minor, feature or fix -> patch (F-94, F-102)'
    : 'breaking -> major, feature -> minor, fix -> patch (F-73, F-99)'
  r.needs_ai = needsAi
  const plan = planVersions(current, level, v.preid)
  const floor = base.highest && compareVersions(base.highest, current) > 0 ? base.highest : current
  const above = (x) => compareVersions(x, floor) > 0
  if (plan.release) {
    r.next_version = formatVersion(plan.release)
    r.release_mode = plan.releaseMode
    r.npm_version_command = `npm version ${r.next_version}`
    if (!above(plan.release)) needsAi.push({ ref: 'version', reason: `${r.next_version} is not above ${formatVersion(floor)}` })
  } else {
    r.npm_version_command = 'none'
  }
  if (plan.pre) {
    r.prerelease_version = formatVersion(plan.pre)
    r.prerelease_mode = plan.preMode
    r.prerelease_command = `npm version ${r.prerelease_version}`
    if (!above(plan.pre)) needsAi.push({ ref: 'version', reason: `${r.prerelease_version} is not above ${formatVersion(floor)}` })
  }
  r.needs_ai_count = needsAi.length
  r.level_is_final = needsAi.length ? 'no (lower bound until the needs_ai items are judged)' : 'yes'
  if (!needsAi.length && level === 'none' && plan.release) {
    r.next = 'confirm-bump'
    return r
  }
  r.next = needsAi.length ? 'ai-review' : level === 'none' ? 'nothing-to-release' : 'confirm-bump'
  return r
}

// ---------- output ----------

function printText(r) {
  const say = (k, val) => process.stdout.write(`${k}: ${val}\n`)
  for (const [k, val] of Object.entries(r)) {
    if (k === 'next' || val === undefined || val === null) continue
    if (k === 'commits') {
      const shown = val.filter((c) => (c.level !== 'none' && c.level !== 'ignored') || c.review)
      for (const c of shown.slice(0, MAX_TEXT_COMMITS)) say('commit', `${c.level}${c.review ? ' (review)' : ''} ${c.sha} ${c.subject}`)
      if (shown.length > MAX_TEXT_COMMITS) say('commits_truncated', `${shown.length - MAX_TEXT_COMMITS} more (use --json)`)
      const quiet = val.length - shown.length
      if (quiet) say('commits_without_bump', `${quiet} (docs, chore, release commits and similar)`)
    } else if (k === 'signals') {
      for (const s of val) say('signal', `${s.level} package.json ${s.text}`)
    } else if (k === 'needs_ai') {
      for (const n of val) say('needs_ai', `${n.ref}${n.at_least ? ` (at least ${n.at_least})` : ''} ${n.reason}${n.subject ? ` | ${n.subject}` : ''}`)
    } else if (k === 'release_script') {
      if (!val.length) say(k, 'none in package.json (check AGENTS.md, CLAUDE.md and CONTRIBUTING.md for a release command)')
      for (const s of val) say(k, s)
    } else if (k === 'config_errors') {
      for (const e of val) say('config_error', e)
    } else if (k === 'config_proposal') {
      say(k, JSON.stringify(val))
    } else {
      say(k, val)
    }
  }
  say('next', r.next)
}

function main() {
  let args
  try { args = parseArgs(process.argv.slice(2)) } catch (e) {
    process.stderr.write(`suggest-version: ${e.message}\nUsage: node suggest-version.mjs [--package <dir>] [--since <ref>] [--json]\n`)
    process.exit(2)
  }
  if (args.help) {
    process.stdout.write('Usage: node suggest-version.mjs [--package <dir>] [--since <ref>] [--json]\nRead-only Bump Suggestion for an npm package; see SKILL.md.\n')
    return
  }
  let r
  try {
    r = analyse({ packageDir: args.package, since: args.since })
  } catch (e) {
    r = { script: 'suggest-version (read-only)', error: String(e.message || e).split('\n')[0], suggested_level: 'unknown', next: 'ai-review' }
  }
  if (args.json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`)
  else printText(r)
}

main()
