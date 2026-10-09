// Finishing a Handoff Brief before the next Account starts (spec §3.17 "Handoff Brief"): keep what the session or
// the user wrote, else what sideby put together from the session's records, and add the repository state. No model.
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { writeFileAtomic } from './fs-safe.ts'
import type { ReadyFile } from './handoff-chain.ts'

const run = promisify(execFile)
const GIT_TIMEOUT_MS = 3000
const MAX_STATUS_LINES = 50

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 1 << 20 })
  return stdout.trimEnd()
}

/** Branch, uncommitted files and `git diff --stat`, as Markdown; '' outside a git work tree. Never commits or stashes. */
export async function gitSection(cwd: string): Promise<string> {
  try {
    if ((await git(cwd, ['rev-parse', '--is-inside-work-tree'])) !== 'true') return ''
  } catch {
    return ''
  }
  const out = ['## Repository state (added by sideby)', '', `Working directory: ${cwd}`]
  try {
    out.push(`Branch: ${(await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])) || '(detached)'}`)
  } catch {
    // a repository without commits
  }
  try {
    const status = (await git(cwd, ['status', '--porcelain'])).split('\n').filter(Boolean)
    out.push('', 'Uncommitted files:', '')
    out.push(...(status.length ? status.slice(0, MAX_STATUS_LINES).map((l) => `    ${l}`) : ['    (none)']))
    if (status.length > MAX_STATUS_LINES) out.push(`    … and ${status.length - MAX_STATUS_LINES} more`)
    const stat = await git(cwd, ['diff', '--stat'])
    if (stat) out.push('', 'Diff stat:', '', ...stat.split('\n').map((l) => `    ${l}`))
  } catch {
    // git refused; the branch line is still useful
  }
  return `${out.join('\n')}\n`
}

async function nonEmpty(path: string | undefined): Promise<string | null> {
  if (!path) return null
  try {
    const text = await readFile(path, 'utf8')
    return text.trim() ? text : null
  } catch {
    return null
  }
}

export const ASSEMBLED_NOTE =
  '> Put together by sideby from the previous session’s records, without a model; it may be incomplete. Check the repository before continuing.'

/**
 * Writes the final Brief to `target` (mode 600) and says where it came from: the user's or the session's Brief
 * named in `ready`, the session's Brief already at `target`, else `assembled`, plus the repository state.
 */
export async function finishBrief(opts: {
  target: string
  ready: Pick<ReadyFile, 'brief' | 'briefSource'>
  assembled?: string
  cwd: string
}): Promise<{ path: string; source: 'agent' | 'sideby' | 'user' }> {
  let body = await nonEmpty(opts.ready.brief)
  let source: 'agent' | 'sideby' | 'user' = opts.ready.briefSource ?? 'agent'
  if (!body) {
    body = await nonEmpty(opts.target)
    source = 'agent'
  }
  if (!body) {
    source = 'sideby'
    body = `${ASSEMBLED_NOTE}\n\n${opts.assembled ?? 'sideby could not read the previous session’s records.\n'}`
  }
  const repo = await gitSection(opts.cwd)
  await writeFileAtomic(opts.target, `${body.trimEnd()}\n${repo ? `\n${repo}` : ''}`, 0o600)
  return { path: opts.target, source }
}
