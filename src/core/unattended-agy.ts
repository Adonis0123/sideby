// WHY: ADR-0089 explicit global hook setup for Antigravity CLI (`agy`). Because `agy --settings` never loads
// lifecycle hooks, sideby manages one named top-level key (`sideby-unattended`) inside `~/.gemini/config/hooks.json`
// after user confirmation, preserving every other key, indentation, trailing newline and file mode.
import { constants as fsConstants } from 'node:fs'
import { mkdir, open, realpath, rm } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { Env, QuotaSetup, QuotaSetupPlan } from '../types.ts'
import { isObj, type Json, lockedSettingsChange, render } from './claude-settings-file.ts'
import { lstatOrNull, sha256, writeIfUnchanged } from './fs-safe.ts'
import { sidebyBinProblem } from './launch.ts'
import { tildify } from './paths.ts'

export const AGY_UNATTENDED_KEY = 'sideby-unattended'
const MAX_BYTES = 5_000_000

/** The exact `sideby-unattended` entry written into `~/.gemini/config/hooks.json` (ADR-0089). */
export function agyUnattendedHookEntry(): Json {
  return {
    PreToolUse: [
      {
        matcher: 'ask_question',
        hooks: [
          {
            type: 'command',
            command: 'sideby unattended-hook agy PreToolUse',
            timeout: 10,
          },
        ],
      },
    ],
    Stop: [
      {
        type: 'command',
        command: 'sideby unattended-hook agy Stop',
        timeout: 10,
      },
    ],
  }
}

/** WHY: earlier shapes of `sideby-unattended` accepted for upgrade/teardown (ADR-0089). */
const EARLIER_ENTRIES: readonly string[] = []

const canonical = (v: unknown): string => JSON.stringify(v)

function matchesSidebyEntry(value: unknown): boolean {
  const got = canonical(value)
  return got === canonical(agyUnattendedHookEntry()) || EARLIER_ENTRIES.includes(got)
}

export const agyHooksFile = (home: string): string => join(home, '.gemini', 'config', 'hooks.json')

export interface AgyUnattendedSummary {
  status: 'enabled' | 'ready' | 'blocked'
  file: string
  message: string
}

type ReadHooksResult =
  | { kind: 'missing' }
  | { kind: 'ok'; text: string; obj: Json; mode: number }
  | { kind: 'blocked'; reason: string }

/** WHY: verify every parent directory under HOME is a real directory, never a symlink (ADR-0089). */
async function checkParentDirs(home: string, create: boolean): Promise<string | null> {
  const realHome = await realpath(home).catch(() => null)
  if (!realHome) return 'HOME could not be resolved'
  let cur = realHome
  for (const seg of ['.gemini', 'config']) {
    const next = join(cur, seg)
    const lst = await lstatOrNull(next)
    if (!lst) {
      if (!create) return null
      try {
        await mkdir(next, { mode: 0o700 })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return `directory ${seg} could not be created`
      }
      const after = await lstatOrNull(next)
      if (!after || after.isSymbolicLink() || !after.isDirectory())
        return `parent directory ${seg} is a symbolic link or not a directory`
      cur = next
      continue
    }
    if (lst.isSymbolicLink()) return `parent directory ${seg} is a symbolic link`
    if (!lst.isDirectory()) return `parent path ${seg} is not a directory`
    cur = next
  }
  const realConfig = await realpath(cur).catch(() => null)
  if (!realConfig?.startsWith(`${realHome}${sep}`)) return 'parent directory resolves outside HOME'
  return null
}

/** WHY: open hooks.json once without following symlinks or blocking on FIFOs so type, size, mode and bytes share one fd (ADR-0089). */
async function readHooksFile(home: string, file: string): Promise<ReadHooksResult> {
  const parentErr = await checkParentDirs(home, false)
  if (parentErr) return { kind: 'blocked', reason: parentErr }
  const lst = await lstatOrNull(file)
  if (!lst) return { kind: 'missing' }
  if (lst.isSymbolicLink()) return { kind: 'blocked', reason: 'it is a symbolic link' }
  if (!lst.isFile()) return { kind: 'blocked', reason: 'it is not a regular file' }
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(file, flags)
    const st = await fh.stat()
    if (!st.isFile()) return { kind: 'blocked', reason: 'it is not a regular file' }
    if (st.size > MAX_BYTES) return { kind: 'blocked', reason: 'it is too large to be a hooks file' }
    const text = await fh.readFile('utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { kind: 'blocked', reason: 'it is not valid JSON' }
    }
    if (!isObj(parsed)) return { kind: 'blocked', reason: 'it is not a JSON object' }
    return { kind: 'ok', text, obj: parsed, mode: st.mode & 0o777 }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { kind: 'missing' }
    if (code === 'ELOOP') return { kind: 'blocked', reason: 'it is a symbolic link' }
    return { kind: 'blocked', reason: `it could not be read (${code ?? 'error'})` }
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** WHY: copy own keys via null-prototype object so even a literal `"__proto__"` key survives teardown (ADR-0089). */
function withoutKey(obj: Json, drop: string): Json {
  const out = Object.create(null) as Json
  for (const [k, v] of Object.entries(obj))
    if (k !== drop)
      Object.defineProperty(out, k, { value: v, enumerable: true, configurable: true, writable: true })
  return out
}

/** WHY: render a minimal unified diff from the actual before/after file text so compact JSON rewrites are shown truthfully (ADR-0089). */
function diffLines(before: string | null, after: string, shown: string): string {
  const split = (s: string) => (s === '' ? [] : s.replace(/\n$/, '').split('\n'))
  const a = before === null ? [] : split(before)
  const b = split(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++
  const ctx = 2
  const startA = Math.max(0, head - ctx)
  const endA = Math.min(a.length, a.length - tail + ctx)
  const endB = Math.min(b.length, b.length - tail + ctx)
  const oldCount = endA - startA
  const newCount = endB - startA
  const lines: string[] = [
    `--- ${before === null ? '/dev/null' : shown}`,
    `+++ ${shown}`,
    `@@ -${before === null ? 0 : startA + 1},${oldCount} +${startA + 1},${newCount} @@`,
  ]
  for (let i = startA; i < head; i++) lines.push(` ${a[i]}`)
  for (let i = head; i < a.length - tail; i++) lines.push(`-${a[i]}`)
  for (let i = head; i < b.length - tail; i++) lines.push(`+${b[i]}`)
  for (let i = a.length - tail; i < endA; i++) lines.push(` ${a[i]}`)
  return `${lines.join('\n')}\n`
}

export type AgyTeardownResult = Awaited<ReturnType<QuotaSetup['teardown']>> & { changed?: boolean }
export type AgyApplyResult = QuotaSetupPlan & { changed?: boolean }

export interface AgyUnattendedSetup {
  family: string
  summary: string
  plan(): Promise<QuotaSetupPlan>
  apply(): Promise<AgyApplyResult>
  teardown(): Promise<AgyTeardownResult>
}

/** Plan, apply and teardown for Antigravity CLI's global `hooks.json` entry (spec §3.37, ADR-0089). */
export function agyUnattendedSetup(opts: { home: string; stateDir: string; env: Env }): AgyUnattendedSetup {
  const file = agyHooksFile(opts.home)
  const shown = tildify(file, opts.home)
  const entry = agyUnattendedHookEntry()

  const plan = async (): Promise<QuotaSetupPlan> => {
    const read = await readHooksFile(opts.home, file)
    if (read.kind === 'blocked')
      return {
        status: 'blocked',
        file,
        diff: '',
        message: `${shown} cannot be changed safely (${read.reason}); fix it and retry`,
      }
    const problem = await sidebyBinProblem(
      opts.env,
      'Antigravity CLI runs `sideby unattended-hook` before questions and when a turn ends',
    )
    if (read.kind === 'ok' && Object.hasOwn(read.obj, AGY_UNATTENDED_KEY)) {
      if (canonical(read.obj[AGY_UNATTENDED_KEY]) === canonical(entry)) {
        if (problem)
          return {
            status: 'blocked',
            file,
            diff: '',
            message: `${shown} has "${AGY_UNATTENDED_KEY}", but ${problem}`,
          }
        return { status: 'enabled', file, diff: '', message: `already set up in ${shown}` }
      }
      if (!EARLIER_ENTRIES.includes(canonical(read.obj[AGY_UNATTENDED_KEY])))
        return {
          status: 'blocked',
          file,
          diff: '',
          message: `${shown} already has a "${AGY_UNATTENDED_KEY}" entry not written by sideby; remove or rename it and retry`,
        }
    }
    if (problem) return { status: 'blocked', file, diff: '', message: problem }
    const nextText =
      read.kind === 'missing'
        ? `${JSON.stringify({ [AGY_UNATTENDED_KEY]: entry }, null, 2)}\n`
        : render({ ...read.obj, [AGY_UNATTENDED_KEY]: entry }, read.text)
    const upgrade = read.kind === 'ok' && Object.hasOwn(read.obj, AGY_UNATTENDED_KEY)
    return {
      status: 'ready',
      file,
      diff: diffLines(read.kind === 'missing' ? null : read.text, nextText, shown),
      ...(upgrade ? { upgrade: true } : {}),
      message: `${upgrade ? 'updates' : 'adds'} "${AGY_UNATTENDED_KEY}" in ${shown} so Unattended Mode covers Antigravity CLI questions (every local agy session); undo any time with \`sideby unattended teardown agy\``,
    }
  }

  return {
    family: 'agy',
    summary:
      'Adds one named entry ("sideby-unattended") to ~/.gemini/config/hooks.json so Unattended Mode covers questions in Antigravity CLI sessions.',
    plan,
    async apply(): Promise<AgyApplyResult> {
      const initial = await plan()
      if (initial.status !== 'ready') return { ...initial, changed: false }
      let outcome: AgyApplyResult = { ...initial, changed: false }
      const lockErr = await lockedSettingsChange(opts.stateDir, file, async () => {
        const read = await readHooksFile(opts.home, file)
        if (read.kind === 'blocked') {
          outcome = {
            status: 'blocked',
            file,
            diff: '',
            changed: false,
            message: `${shown} cannot be changed safely (${read.reason}); fix it and retry`,
          }
          return null
        }
        if (read.kind === 'ok' && Object.hasOwn(read.obj, AGY_UNATTENDED_KEY)) {
          if (canonical(read.obj[AGY_UNATTENDED_KEY]) === canonical(entry)) {
            outcome = {
              status: 'enabled',
              file,
              diff: '',
              changed: false,
              message: `already set up in ${shown}`,
            }
            return null
          }
          if (!EARLIER_ENTRIES.includes(canonical(read.obj[AGY_UNATTENDED_KEY]))) {
            outcome = {
              status: 'blocked',
              file,
              diff: '',
              changed: false,
              message: `${shown} already has a "${AGY_UNATTENDED_KEY}" entry not written by sideby; remove or rename it and retry`,
            }
            return null
          }
        }
        if (read.kind === 'missing') {
          const dirErr = await checkParentDirs(opts.home, true)
          if (dirErr) {
            outcome = {
              status: 'blocked',
              file,
              diff: '',
              changed: false,
              message: `${shown} cannot be created safely (${dirErr}); fix it and retry`,
            }
            return null
          }
          const body = `${JSON.stringify({ [AGY_UNATTENDED_KEY]: entry }, null, 2)}\n`
          const flags =
            fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0)
          let fh: Awaited<ReturnType<typeof open>> | undefined
          try {
            fh = await open(file, flags, 0o600)
            await fh.writeFile(body, 'utf8')
            await fh.sync()
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code
            outcome = {
              status: 'blocked',
              file,
              diff: '',
              changed: false,
              message:
                code === 'EEXIST'
                  ? `${shown} was created while sideby was writing, so nothing was overwritten; try again`
                  : `${shown} could not be created (${code ?? 'error'}); try again`,
            }
            return null
          } finally {
            await fh?.close().catch(() => {})
          }
          outcome = {
            ...initial,
            status: 'enabled',
            changed: true,
            message: `added "${AGY_UNATTENDED_KEY}" to ${shown}; Antigravity CLI sessions are now covered while Unattended Mode is on`,
          }
          return null
        }
        const nextText = render({ ...read.obj, [AGY_UNATTENDED_KEY]: entry }, read.text)
        const wrote = await writeIfUnchanged(file, sha256(read.text), nextText, read.mode)
        if (!wrote) {
          outcome = {
            status: 'blocked',
            file,
            diff: '',
            changed: false,
            message: `${shown} changed while sideby was writing, so nothing was changed; try again`,
          }
          return null
        }
        outcome = {
          ...initial,
          status: 'enabled',
          changed: true,
          message: `added "${AGY_UNATTENDED_KEY}" to ${shown}; Antigravity CLI sessions are now covered while Unattended Mode is on`,
        }
        return null
      })
      if (lockErr) return { status: 'blocked', file, diff: '', changed: false, message: lockErr }
      return outcome
    },
    async teardown(): Promise<AgyTeardownResult> {
      let result: AgyTeardownResult = { ok: false, changed: false, message: '' }
      const lockErr = await lockedSettingsChange(opts.stateDir, file, async () => {
        const read = await readHooksFile(opts.home, file)
        if (read.kind === 'missing') {
          result = { ok: true, changed: false, message: `already removed (${shown} does not exist)` }
          return null
        }
        if (read.kind === 'blocked') {
          result = {
            ok: false,
            changed: false,
            message: `${shown} cannot be changed safely (${read.reason}); remove "${AGY_UNATTENDED_KEY}" by hand`,
          }
          return null
        }
        if (!Object.hasOwn(read.obj, AGY_UNATTENDED_KEY)) {
          result = {
            ok: true,
            changed: false,
            message: `already removed (no "${AGY_UNATTENDED_KEY}" in ${shown})`,
          }
          return null
        }
        if (!matchesSidebyEntry(read.obj[AGY_UNATTENDED_KEY])) {
          result = {
            ok: false,
            changed: false,
            message: `"${AGY_UNATTENDED_KEY}" in ${shown} was changed outside sideby; remove it by hand so nothing of yours is lost`,
          }
          return null
        }
        const rest = withoutKey(read.obj, AGY_UNATTENDED_KEY)
        const expectedHash = sha256(read.text)
        if (Object.keys(rest).length === 0) {
          // WHY: re-read right before unlink so a concurrent save from `agy /hooks` is never deleted (ADR-0089).
          const verify = await readHooksFile(opts.home, file)
          if (verify.kind !== 'ok' || sha256(verify.text) !== expectedHash) {
            result = {
              ok: false,
              changed: false,
              message: `${shown} changed while sideby was removing its entry, so nothing was deleted; try again`,
            }
            return null
          }
          await rm(file, { force: true })
          result = {
            ok: true,
            changed: true,
            message: `removed ${shown} (it held only "${AGY_UNATTENDED_KEY}")`,
          }
          return null
        }
        const wrote = await writeIfUnchanged(file, expectedHash, render(rest, read.text), read.mode)
        if (!wrote) {
          result = {
            ok: false,
            changed: false,
            message: `${shown} changed while sideby was writing, so nothing was changed; try again`,
          }
          return null
        }
        result = { ok: true, changed: true, message: `removed "${AGY_UNATTENDED_KEY}" from ${shown}` }
        return null
      })
      if (lockErr) return { ok: false, changed: false, message: lockErr }
      return result
    },
  }
}

/** Read-only summary of Antigravity CLI's Unattended Mode hook status for `sideby unattended` and the Panel (ADR-0089). */
export async function agyUnattendedStatus(opts: {
  home: string
  stateDir: string
  env: Env
}): Promise<AgyUnattendedSummary> {
  const p = await agyUnattendedSetup(opts).plan()
  return { status: p.status, file: tildify(p.file, opts.home), message: p.message }
}
