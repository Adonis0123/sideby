// Doctor history: the latest result per Account (and per Family for Family-level findings), kept in
// sideby's state directory so the Panel can tell "healthy" from "not checked". A run only replaces what
// it covered, so checking one Account never makes the others look healthy.
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Finding } from '../types.ts'
import type { DoctorReport } from './doctor.ts'
import { writeFileAtomic } from './fs-safe.ts'

export type StoredFinding = Omit<Finding, 'fix'>

export interface HistoryEntry {
  at: string
  findings: StoredFinding[]
}

export interface DoctorHistory {
  version: 2
  /** Latest result per Account ref; an Account absent here was never checked. */
  accounts: Record<string, HistoryEntry>
  /** Latest Family-level findings (for example a missing Main Account), per Family id. */
  general: Record<string, HistoryEntry>
}

/** What one Doctor run covered: every Family, one Family, or one Account. */
export type DoctorScope =
  | { kind: 'all' }
  | { kind: 'family'; family: string }
  | { kind: 'account'; ref: string }

const FILE = 'last-doctor.json'
const strip = ({ fix: _fix, ...f }: Finding): StoredFinding => f
const familyOfRef = (ref: string) => ref.slice(0, ref.indexOf(':'))

function inScope(scope: DoctorScope, ref: string): boolean {
  if (scope.kind === 'all') return true
  if (scope.kind === 'family') return familyOfRef(ref) === scope.family
  return ref === scope.ref
}

/**
 * Pure merge: Accounts inside the scope are replaced by this run (and dropped when the run no longer
 * reports them: deleted, ignored, no longer an Account); Accounts outside the scope are kept. Family-level
 * findings are replaced for every Family the run touched, even with an empty list.
 */
export function mergeDoctorHistory(
  prev: DoctorHistory | undefined,
  report: DoctorReport,
  scope: DoctorScope,
  at: Date,
): DoctorHistory {
  const when = at.toISOString()
  const accounts: Record<string, HistoryEntry> = {}
  for (const [ref, entry] of Object.entries(prev?.accounts ?? {}))
    if (!inScope(scope, ref)) accounts[ref] = entry
  for (const a of report.accounts) accounts[a.ref] = { at: when, findings: a.findings.map(strip) }

  const touched = new Set(
    scope.kind === 'all'
      ? [...report.accounts.map((a) => a.family), ...report.general.map((f) => familyOfRef(f.account))]
      : [scope.kind === 'family' ? scope.family : familyOfRef(scope.ref)],
  )
  const general: Record<string, HistoryEntry> = {}
  for (const [family, entry] of Object.entries(prev?.general ?? {}))
    if (scope.kind !== 'all' && !touched.has(family)) general[family] = entry
  for (const family of touched)
    general[family] = {
      at: when,
      findings: report.general.filter((f) => familyOfRef(f.account) === family).map(strip),
    }
  return { version: 2, accounts, general }
}

/** Every finding in the history, Family-level first. */
export function historyFindings(h: DoctorHistory): StoredFinding[] {
  return [...Object.values(h.general), ...Object.values(h.accounts)].flatMap((e) => e.findings)
}

/** Older formats (without per-Account entries) count as no history. */
export async function readDoctorHistory(stateDir: string): Promise<DoctorHistory | undefined> {
  try {
    const data = JSON.parse(await readFile(join(stateDir, FILE), 'utf8')) as Partial<DoctorHistory>
    if (data?.version !== 2 || typeof data.accounts !== 'object' || typeof data.general !== 'object')
      return undefined
    return data as DoctorHistory
  } catch {
    return undefined
  }
}

/** Best effort: recording a check never fails the check itself. */
export async function writeDoctorHistory(stateDir: string, history: DoctorHistory): Promise<void> {
  try {
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    await writeFileAtomic(join(stateDir, FILE), `${JSON.stringify(history, null, 2)}\n`)
  } catch {
    // ignore
  }
}
