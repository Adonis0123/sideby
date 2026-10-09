// `sideby quota setup|teardown claude` (spec §3.7): wraps the Main Account's status line command with
// `sideby statusline-tap` so Claude Code's own `rate_limits` get cached, and restores the original bytes
// exactly on teardown, but only while the file is still what setup wrote.
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { lstatOrNull, realpathOrNull, sha256, writeFileAtomic, writeIfUnchanged } from '../core/fs-safe.ts'
import { sidebyBinProblem } from '../core/launch.ts'
import { tildify } from '../core/paths.ts'
import { CLAUDE_MAIN_DIR } from '../families/claude/layout.ts'
import type { QuotaSetup, QuotaSetupPlan, ReadContext } from '../types.ts'
import { ORIG_FLAG, TAP_COMMAND } from './statusline-tap.ts'

export interface StatuslineBackup {
  /** Real path that was changed (the symlink target when settings.json is a link). */
  file: string
  originalBase64: string
  originalHash: string
  wrappedHash: string
  appliedAt: string
}

export function backupFile(stateDir: string): string {
  return join(stateDir, 'statusline', 'claude-settings.backup.json')
}

export function mainSettingsFile(home: string): string {
  return join(home, CLAUDE_MAIN_DIR, 'settings.json')
}

export function isWrapped(command: unknown): boolean {
  return typeof command === 'string' && (command === TAP_COMMAND || command.startsWith(`${TAP_COMMAND} `))
}

export function wrapCommand(original: string | undefined): string {
  return original?.trim()
    ? `${TAP_COMMAND} ${ORIG_FLAG} ${Buffer.from(original, 'utf8').toString('base64')}`
    : TAP_COMMAND
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Keeps the file's own indentation so the diff shows only the changed lines. */
function serializeLike(original: string, value: unknown): string {
  const body = original.trimEnd()
  const indent = body.includes('\n') ? (/^([ \t]+)\S/m.exec(body)?.[1] ?? 2) : undefined
  const out = indent === undefined ? JSON.stringify(value) : JSON.stringify(value, null, indent)
  return original.endsWith('\n') ? `${out}\n` : out
}

interface Analysis {
  plan: QuotaSetupPlan
  target?: string
  original?: Buffer
  wrapped?: string
}

async function analyze(ctx: ReadContext): Promise<Analysis> {
  const shown = mainSettingsFile(ctx.home)
  const showName = tildify(shown, ctx.home)
  const blocked = (message: string, file = shown): Analysis => ({
    plan: { status: 'blocked', file, diff: '', message },
  })
  const lst = await lstatOrNull(shown)
  if (!lst)
    return blocked(`${showName} does not exist; start Claude Code once so it creates the file, then retry`)
  const target = lst.isSymbolicLink() ? await realpathOrNull(shown) : shown
  if (!target) return blocked(`${showName} is a link to a missing file; fix the link and retry`)
  const targetName = tildify(target, ctx.home)
  const note = target !== shown ? ` (${showName} is a link; its target ${targetName} is changed)` : ''

  let original: Buffer
  try {
    original = await readFile(target)
  } catch (err) {
    return blocked(`cannot read ${targetName}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`, target)
  }
  const text = original.toString('utf8')
  let settings: unknown
  try {
    settings = JSON.parse(text)
  } catch {
    return blocked(`${targetName} is not valid JSON; sideby will not rewrite it`, target)
  }
  if (!isPlainObject(settings)) return blocked(`${targetName} is not a JSON object`, target)
  const current = settings.statusLine ?? undefined
  if (current !== undefined && !isPlainObject(current))
    return blocked(`statusLine in ${targetName} is not an object; sideby will not rewrite it`, target)
  const command = current?.command
  if (command !== undefined && typeof command !== 'string')
    return blocked(`statusLine.command in ${targetName} is not a string`, target)
  if (isWrapped(command))
    return {
      plan: { status: 'enabled', file: target, diff: '', message: `already enabled in ${targetName}${note}` },
    }

  const problem = await sidebyBinProblem(ctx.env, `the status line runs \`${TAP_COMMAND}\` on every refresh`)
  if (problem) return blocked(problem, target)

  const statusLine = current
    ? { type: 'command', ...current, command: wrapCommand(command) }
    : { type: 'command', command: TAP_COMMAND }
  const wrapped = serializeLike(text, { ...settings, statusLine })
  return {
    plan: {
      status: 'ready',
      file: target,
      diff: statusLineDiff(current, statusLine, targetName),
      message: `wraps statusLine.command in ${targetName} so sideby can record Claude's rate limits${note}; undo with \`sideby quota teardown claude\``,
    },
    target,
    original,
    wrapped,
  }
}

async function readBackup(file: string): Promise<StatuslineBackup | null> {
  try {
    const b = JSON.parse(await readFile(file, 'utf8')) as Partial<StatuslineBackup>
    if (
      typeof b.file !== 'string' ||
      typeof b.originalBase64 !== 'string' ||
      typeof b.originalHash !== 'string' ||
      typeof b.wrappedHash !== 'string'
    )
      return null
    return b as StatuslineBackup
  } catch {
    return null
  }
}

export const claudeStatusline: QuotaSetup = {
  summary:
    "Wrap the status line command in ~/.claude/settings.json with `sideby statusline-tap` so sideby can cache Claude's 5h and 7d rate limits. Your status line keeps working; teardown restores the file byte for byte.",

  async plan(ctx) {
    return (await analyze(ctx)).plan
  },

  async apply(ctx) {
    const a = await analyze(ctx)
    if (a.plan.status !== 'ready' || !a.target || !a.original || a.wrapped === undefined) return a.plan
    const mode = (await stat(a.target)).mode & 0o777
    const backup: StatuslineBackup = {
      file: a.target,
      originalBase64: a.original.toString('base64'),
      originalHash: sha256(a.original),
      wrappedHash: sha256(a.wrapped),
      appliedAt: ctx.now.toISOString(),
    }
    const bf = backupFile(ctx.stateDir)
    await mkdir(dirname(bf), { recursive: true, mode: 0o700 })
    await writeFileAtomic(bf, `${JSON.stringify(backup, null, 2)}\n`, 0o600)
    let written = false
    try {
      written = await writeIfUnchanged(a.target, backup.originalHash, a.wrapped, mode)
    } finally {
      if (!written) await rm(bf, { force: true })
    }
    if (!written)
      return {
        ...a.plan,
        status: 'blocked',
        message: `${tildify(a.target, ctx.home)} changed while applying; nothing was written, run setup again`,
      }
    return { ...a.plan, status: 'enabled', message: `enabled: ${a.plan.message}` }
  },

  async teardown(ctx) {
    const bf = backupFile(ctx.stateDir)
    const b = await readBackup(bf)
    if (!b)
      return {
        ok: false,
        message: `the Claude status line wrapper is not enabled by sideby (no backup at ${tildify(bf, ctx.home)})`,
      }
    const name = tildify(b.file, ctx.home)
    const original = Buffer.from(b.originalBase64, 'base64')
    if (sha256(original) !== b.originalHash)
      return {
        ok: false,
        message: `the backup at ${tildify(bf, ctx.home)} is damaged; ${name} was not changed`,
      }
    let current: Buffer
    try {
      current = await readFile(b.file)
    } catch {
      return {
        ok: false,
        message: `${name} is missing; nothing restored, the backup stays at ${tildify(bf, ctx.home)}`,
      }
    }
    if (sha256(current) !== b.wrappedHash)
      return {
        ok: false,
        message: `${name} changed after quota setup, so sideby will not overwrite it. Remove the \`${TAP_COMMAND}\` wrapper by hand: set statusLine.command back to your original command (base64 after ${ORIG_FLAG}), or delete statusLine if you had none. The diff shows the statusLine change to make.`,
        diff: statusLineDiff(statusLineOf(current), statusLineOf(original), name),
      }
    try {
      const mode = (await stat(b.file)).mode & 0o777
      if (!(await writeIfUnchanged(b.file, b.wrappedHash, original, mode)))
        return { ok: false, message: `${name} changed while restoring; nothing was written` }
    } catch (err) {
      return { ok: false, message: `could not restore ${name}: ${(err as Error).message}` }
    }
    await rm(bf, { force: true })
    return { ok: true, message: `restored ${name} to its original bytes` }
  },
}

type Op = { t: ' ' | '-' | '+'; line: string }

function splitLines(a: string, b: string): [string[], string[]] {
  // Drop one shared trailing newline so files ending in "\n" do not diff an empty last line.
  if (a.endsWith('\n') && b.endsWith('\n')) return [a.slice(0, -1).split('\n'), b.slice(0, -1).split('\n')]
  return [a.split('\n'), b.split('\n')]
}

function middleOps(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  if (n * m > 4_000_000)
    return [...a.map((line) => ({ t: '-' as const, line })), ...b.map((line) => ({ t: '+' as const, line }))]
  // lcs[i][j] = longest common subsequence of a[i..] and b[j..]
  const w = m + 1
  const lcs = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i * w + j] =
        a[i] === b[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!)
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ t: ' ', line: a[i++]! })
      j++
    } else if (j >= m || (i < n && lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!))
      ops.push({ t: '-', line: a[i++]! })
    else ops.push({ t: '+', line: b[j++]! })
  }
  return ops
}

const SECRET_KEY = /(key|token|secret|password|passwd|auth|credential|cookie)/i

/**
 * Hides values of secret-looking JSON keys in a diff line. settings.json often keeps API keys in `env`,
 * right next to `statusLine`, so context lines could otherwise print them.
 */
export function redactLine(line: string): string {
  return line.replace(/("([^"\\]*)"\s*:\s*)"(?:[^"\\]|\\.)*"/g, (m, head: string, key: string) =>
    SECRET_KEY.test(key) ? `${head}"<redacted>"` : m,
  )
}

/**
 * Diff of the statusLine object only. The rest of settings.json never enters a diff: it often holds API keys
 * (for example in `env`), in shapes no line-based redaction can reliably catch.
 */
export function statusLineDiff(before: unknown, after: unknown, file: string): string {
  const show = (v: unknown) =>
    v === undefined ? '' : `${JSON.stringify({ statusLine: redactStatusLine(v) }, null, 2)}\n`
  return unifiedDiff(show(before), show(after), `${file} (statusLine only)`)
}

const SHOWN_STATUSLINE_KEYS = new Set(['type', 'command', 'padding'])

/** Shows the statusLine fields sideby touches as they are; any other value becomes "<redacted>". */
export function redactStatusLine(v: unknown): unknown {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return '<redacted>'
  return Object.fromEntries(
    Object.entries(v).map(([k, val]) => [
      k,
      SHOWN_STATUSLINE_KEYS.has(k) && (typeof val !== 'object' || val === null) ? val : '<redacted>',
    ]),
  )
}

function statusLineOf(bytes: Buffer): unknown {
  try {
    const v = JSON.parse(bytes.toString('utf8')) as { statusLine?: unknown } | null
    return v && typeof v === 'object' ? v.statusLine : undefined
  } catch {
    return undefined
  }
}

/** Minimal unified diff with 3 lines of context; empty when the texts are equal. Secret-looking values are redacted. */
export function unifiedDiff(oldText: string, newText: string, file: string, context = 3): string {
  if (oldText === newText) return ''
  const [a, b] = splitLines(oldText, newText)
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf])
    suf++
  const ops: Op[] = [
    ...a.slice(0, pre).map((line) => ({ t: ' ' as const, line })),
    ...middleOps(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf)),
    ...a.slice(a.length - suf).map((line) => ({ t: ' ' as const, line })),
  ]
  const changes = ops.flatMap((o, i) => (o.t === ' ' ? [] : [i]))
  if (!changes.length) return `--- a/${file}\n+++ b/${file}\n@@ line endings differ @@\n`

  const groups: [number, number][] = []
  for (const c of changes) {
    const last = groups[groups.length - 1]
    if (last && c - last[1] <= 2 * context) last[1] = c
    else groups.push([c, c])
  }
  let out = `--- a/${file}\n+++ b/${file}\n`
  for (const [first, lastChange] of groups) {
    const start = Math.max(0, first - context)
    const end = Math.min(ops.length, lastChange + 1 + context)
    const before = ops.slice(0, start)
    const slice = ops.slice(start, end)
    const oldLen = slice.filter((o) => o.t !== '+').length
    const newLen = slice.filter((o) => o.t !== '-').length
    const oldStart = before.filter((o) => o.t !== '+').length + (oldLen ? 1 : 0)
    const newStart = before.filter((o) => o.t !== '-').length + (newLen ? 1 : 0)
    out += `@@ -${oldStart},${oldLen} +${newStart},${newLen} @@\n`
    for (const o of slice) out += `${o.t}${redactLine(o.line)}\n`
  }
  return out
}
