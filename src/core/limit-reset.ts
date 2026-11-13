// Spending a Limit Reset (spec §3.40, ADR-0072): the record of each attempt and the lock that makes the Panel, the CLI
// and the menu take turns. Each confirmation is one operation with one idempotency key, kept in
// `<state>/quota/limit-reset/<operation>.json` before the request is sent, so a retry, also from another process,
// reuses the key until the Host gives a final outcome. The Runtime owns the flow; a Family only sends the request.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { LimitResetOutcome, LimitResets, QuotaResult } from '../types.ts'
import { UserError } from './errors.ts'
import { writeFileAtomic } from './fs-safe.ts'
import { type ReleaseLock, takeFileLock } from './lock.ts'

/**
 * `planned`: shown, not confirmed. `pending`: a request was (or is about to be) sent and no final outcome came back.
 * An outcome: the Host answered. `not-sent`: the request never left this computer, so nothing was spent. `stopped`:
 * written by an older sideby only, for an operation it gave up on; it is read as ended and never written now, because
 * an operation whose outcome is unknown stays `pending` until the Host answers its own key.
 */
export type LimitResetState = 'planned' | 'pending' | LimitResetOutcome | 'not-sent' | 'stopped'

/**
 * A salted digest of a login's comparison key (`loginComparisonKey`, core/same-login.ts): `sha256(salt + key)` with a
 * salt of its own. It can only tell that the login of one operation is unchanged; it is never the Login Key or the
 * Identity, and two records of one login do not share it.
 */
export interface LoginDigest {
  salt: string
  digest: string
}

/** What the record of one operation holds. Never a Login Key, an Identity, a credit id or a credential. */
export interface LimitResetRecord {
  version: 1
  operationId: string
  /**
   * The refs of every Account of the Same Login when the operation was made, sorted. While it is unresolved, the
   * Accounts that resumed it are added; with its outcome, they are the Accounts of the login then.
   */
  accounts: string[]
  /**
   * The login the operation was made for, as a digest to compare only. A record without one (written by an older
   * sideby) cannot be shown to belong to any login, so it is never sent.
   */
  login?: LoginDigest
  /** Sent with every attempt of this operation, and with no other. */
  idempotencyKey: string
  state: LimitResetState
  createdAt: string
  /** When each request was about to be sent (ISO), written before sending. */
  attempts: string[]
  /** When the operation reached a state that is not `planned` or `pending`. */
  finishedAt?: string
  /** When the Quota read that followed a spend was kept. */
  quotaReadAt?: string
}

/** What a user is shown before confirming one spend (ADR-0072). It promises nothing about which windows refill. */
export interface LimitResetPlan {
  /** The Account the user named. */
  account: string
  /** The Account whose Host sends the request: the first signed-in Account of the Same Login. */
  via: string
  /** The other Accounts of its Same Login; a spend applies to all of them. */
  sameLogin: string[]
  /** Pass it back to confirm this plan; left out when the plan cannot be confirmed (`canUse` false). */
  operationId?: string
  /**
   * An earlier attempt for this login got no final answer. Confirming asks the Host again with the same request, so
   * it spends nothing more when that attempt already went through.
   */
  unresolved?: true
  /** The Quota as it was read for this plan: each window's used percent and own reset time. */
  quota: QuotaResult
  /** The Limit Resets the login holds now; left out when the Host did not tell. */
  limitResets?: LimitResets
  /** The count expected after one spend; left out when the count is unknown or zero. */
  expectedAfter?: number
  /** False when the plan cannot be confirmed; `blocked` then says why and what to do. */
  canUse: boolean
  blocked?: string
  /** In plain words: what confirming does, and that it cannot be undone. */
  message: string
}

/** What one confirmed spend ended as. */
export interface LimitResetResult {
  account: string
  via: string
  sameLogin: string[]
  operationId: string
  outcome: LimitResetOutcome
  /** This confirmation finished an earlier attempt instead of making a new request of its own. */
  resumed?: true
  /** The outcome was already known for this operation; no request to use one was sent now. */
  replayed?: true
  /**
   * The Quota for the Account the user named. After a spend, only numbers whose read began after it; left out when
   * that read failed.
   */
  quota?: QuotaResult
  /** The reset was used but the Quota could not be read afterwards: the numbers on show are still the old ones. */
  quotaPending?: true
  message: string
}

/** A refused or unfinished spend. `operationId` names the operation to retry, when there is one. */
export class LimitResetError extends UserError {
  readonly operationId?: string
  constructor(message: string, opts: { code: string; operationId?: string }) {
    super(message, { code: opts.code })
    if (opts.operationId) this.operationId = opts.operationId
  }
}

/** States a Host's answer ends an operation in. */
export const LIMIT_RESET_OUTCOMES: readonly LimitResetOutcome[] = [
  'reset',
  'nothing-to-reset',
  'none-left',
  'already-done',
]
const STATES: readonly LimitResetState[] = [
  'planned',
  'pending',
  ...LIMIT_RESET_OUTCOMES,
  'not-sent',
  'stopped',
]
/** A finished or never-confirmed record is removed this long after it was finished or made. */
export const RECORD_KEEP_MS = 24 * 3600_000
const ID_RE = /^lr-[a-z0-9]{6,12}-[a-f0-9]{8}$/
const HEX_RE = /^[a-f0-9]{32,64}$/
const REF_RE = /^[a-z][a-z0-9-]{0,31}:[a-z0-9][a-z0-9-]{0,31}$/

export const limitResetDir = (stateDir: string): string => join(stateDir, 'quota', 'limit-reset')

/** Whether `id` has the shape of an operation id, so it is safe as a file name. */
export const isOperationId = (id: unknown): id is string => typeof id === 'string' && ID_RE.test(id)

export function newOperationId(): string {
  return `lr-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

/** Whether a Host answered this operation: a spend happened (`reset`, `already-done`) or the Host said why not. */
export const isOutcome = (s: LimitResetState): s is LimitResetOutcome =>
  (LIMIT_RESET_OUTCOMES as readonly string[]).includes(s)

/** Whether the operation spent a Limit Reset. */
export const spent = (s: LimitResetState): boolean => s === 'reset' || s === 'already-done'

async function ensureDir(stateDir: string): Promise<string> {
  const dir = limitResetDir(stateDir)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  // mkdir's mode is reduced by the umask and leaves an existing folder as it is.
  await chmod(dir, 0o700)
  return dir
}

const isTime = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v))

const saltedDigest = (salt: string, key: string): string =>
  createHash('sha256')
    .update(salt + key)
    .digest('hex')

/** A new digest for the login whose comparison key is `key`, with a salt no other record has. */
export function newLoginDigest(key: string): LoginDigest {
  const salt = randomBytes(16).toString('hex')
  return { salt, digest: saltedDigest(salt, key) }
}

/**
 * Whether `key`, the comparison key of the login that would send the request now, is the one `record` was made for.
 * False when either is unknown: a record without a digest, or a login that cannot be read now (signed out, an
 * unreadable sign-in). False always means "do not send".
 */
export function loginUnchanged(record: LimitResetRecord, key: string | undefined): boolean {
  return Boolean(key && record.login && saltedDigest(record.login.salt, key) === record.login.digest)
}

function parseRecord(text: string): LimitResetRecord | null {
  let v: Partial<LimitResetRecord> | null
  try {
    v = JSON.parse(text) as Partial<LimitResetRecord> | null
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null || v.version !== 1) return null
  if (!isOperationId(v.operationId) || typeof v.idempotencyKey !== 'string' || !v.idempotencyKey) return null
  if (!Array.isArray(v.accounts) || !v.accounts.length || !v.accounts.every((r) => REF_RE.test(String(r))))
    return null
  if (!STATES.includes(v.state as LimitResetState) || !isTime(v.createdAt)) return null
  const m = v.login as Partial<LoginDigest> | undefined
  const login =
    typeof m === 'object' && m !== null && HEX_RE.test(String(m.salt)) && HEX_RE.test(String(m.digest))
      ? { salt: String(m.salt), digest: String(m.digest) }
      : undefined
  return {
    version: 1,
    operationId: v.operationId,
    accounts: [...v.accounts].sort(),
    ...(login ? { login } : {}),
    idempotencyKey: v.idempotencyKey,
    state: v.state as LimitResetState,
    createdAt: v.createdAt,
    attempts: Array.isArray(v.attempts) ? v.attempts.filter(isTime) : [],
    ...(isTime(v.finishedAt) ? { finishedAt: v.finishedAt } : {}),
    ...(isTime(v.quotaReadAt) ? { quotaReadAt: v.quotaReadAt } : {}),
  }
}

/** Where the record of `operationId` is kept. */
export const limitResetFile = (stateDir: string, operationId: string): string =>
  join(limitResetDir(stateDir), `${operationId}.json`)

const errorCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | null)?.code

/**
 * The file of `operationId`: its record, `missing` when there is no such file, or `unreadable` when the file is
 * there but cannot be read or is not a record sideby wrote. The two are never mixed up: a file that cannot be read
 * may be an unresolved spend.
 */
async function loadRecord(
  stateDir: string,
  operationId: string,
): Promise<LimitResetRecord | 'missing' | 'unreadable'> {
  let text: string
  try {
    text = await readFile(limitResetFile(stateDir, operationId), 'utf8')
  } catch (err) {
    return errorCode(err) === 'ENOENT' ? 'missing' : 'unreadable'
  }
  const r = parseRecord(text)
  return r && r.operationId === operationId ? r : 'unreadable'
}

/**
 * Why nothing may be sent while `paths` (operation files, or the folder itself) cannot be read, and what to do.
 * Names the paths, never their contents.
 */
export function unreadableRecordsMessage(stateDir: string, paths: readonly string[]): string {
  const [first, ...more] = paths
  const why =
    'so it cannot tell whether an earlier attempt is still unresolved and will not use a limit reset'
  if (first === limitResetDir(stateDir))
    return `sideby cannot read the folder ${first}, where it keeps its limit reset operations, ${why}. Make it readable again (\`chmod 700 ${first}\`), then try again`
  return `sideby cannot read ${first}${more.length ? ` (and ${more.length} more beside it)` : ''}, the record of an earlier limit reset operation, ${why}. Make it readable again (\`chmod 600 ${first}\`); if the file is damaged, check the count on the vendor's own usage page first, then move the file away`
}

/**
 * The record of `operationId`, or null when there is none. Throws a `LimitResetError` (`records-unreadable`) when
 * its file is there but cannot be read or is not a record sideby wrote.
 */
export async function readLimitResetRecord(
  stateDir: string,
  operationId: string,
): Promise<LimitResetRecord | null> {
  if (!isOperationId(operationId)) return null
  const r = await loadRecord(stateDir, operationId)
  if (r === 'unreadable')
    throw new LimitResetError(
      `${unreadableRecordsMessage(stateDir, [limitResetFile(stateDir, operationId)])}. Nothing was sent`,
      { code: 'records-unreadable' },
    )
  return r === 'missing' ? null : r
}

/** Keeps `record` (folder 700, file 600, written through a temp file and a rename). */
export async function writeLimitResetRecord(stateDir: string, record: LimitResetRecord): Promise<void> {
  const dir = await ensureDir(stateDir)
  await writeFileAtomic(
    join(dir, `${record.operationId}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    0o600,
  )
}

/**
 * A new operation for the Accounts of one login, not yet confirmed. `loginKey` is that login's comparison key; only
 * its salted digest is kept.
 */
export function newLimitResetRecord(
  accounts: readonly string[],
  now: Date,
  loginKey: string,
): LimitResetRecord {
  return {
    version: 1,
    operationId: newOperationId(),
    accounts: [...accounts].sort(),
    login: newLoginDigest(loginKey),
    idempotencyKey: randomUUID(),
    state: 'planned',
    createdAt: now.toISOString(),
    attempts: [],
  }
}

/** What the folder of operations holds: the records that can be read, and what is there but cannot be. */
export interface LimitResetScan {
  /** Every record that can be read, oldest first. */
  records: LimitResetRecord[]
  /**
   * Paths that are there but cannot be read: an operation file (no permission, damaged, not a record sideby wrote),
   * or the folder itself when it cannot be listed. Any of them may hide an unresolved spend, so while this is not
   * empty no new operation is made and nothing is sent.
   */
  unreadable: string[]
}

/** Reads every operation file. A folder that is not there yet holds nothing; any other failure is `unreadable`. */
export async function scanLimitResetRecords(stateDir: string): Promise<LimitResetScan> {
  const dir = limitResetDir(stateDir)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    return { records: [], unreadable: errorCode(err) === 'ENOENT' ? [] : [dir] }
  }
  const records: LimitResetRecord[] = []
  const unreadable: string[] = []
  for (const n of names.sort()) {
    if (!n.endsWith('.json') || !isOperationId(n.slice(0, -5))) continue
    const r = await loadRecord(stateDir, n.slice(0, -5))
    if (r === 'unreadable') unreadable.push(join(dir, n))
    else if (r !== 'missing') records.push(r)
  }
  records.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  return { records, unreadable }
}

/**
 * Every record that can be read, oldest first. For readers that spend nothing (pruning, Auto Handoff's look at
 * confirmed spends); a spend goes through `scanLimitResetRecords`, which also tells what could not be read.
 */
export async function listLimitResetRecords(stateDir: string): Promise<LimitResetRecord[]> {
  return (await scanLimitResetRecords(stateDir)).records
}

/** Whether a plan was made too long ago to confirm: its numbers are a day old, and pruning may remove it. */
export const planExpired = (record: LimitResetRecord, now: Date): boolean =>
  now.getTime() - Date.parse(record.createdAt) >= RECORD_KEEP_MS

/** Whether nobody needs `r` any more. Never an unresolved one. */
const removable = (r: LimitResetRecord, now: Date): boolean =>
  r.state === 'planned'
    ? planExpired(r, now)
    : r.state !== 'pending' && now.getTime() - Date.parse(r.finishedAt ?? r.createdAt) >= RECORD_KEEP_MS

/**
 * Removes records nobody needs any more: a finished one 24 hours after it finished, a plan nobody confirmed 24 hours
 * after it was made. An unresolved one (`pending`) is never removed: only its own key may ask the Host again. Nor is
 * a file that cannot be read: it may be one.
 *
 * A record is removed only under the spend lock of its Accounts, the one a confirmation holds from before it writes
 * `pending` until it has its answer, and only after it was read again there: a plan confirmed since this looked is
 * unresolved now, and its key must stay. A lock that is held is not waited for; the next pruning looks again.
 * `seam` is for tests: it runs after a record was read as removable and before its lock is taken.
 */
export async function pruneLimitResetRecords(
  stateDir: string,
  now: Date,
  seam?: { afterRead?: (record: LimitResetRecord) => Promise<void> },
): Promise<void> {
  for (const seen of await listLimitResetRecords(stateDir)) {
    if (!removable(seen, now)) continue
    await seam?.afterRead?.(seen)
    const release = await takeLimitResetLock(stateDir, seen.accounts, 0)
    if (!release) continue
    try {
      const r = await loadRecord(stateDir, seen.operationId)
      if (typeof r === 'object' && removable(r, now) && sameAccounts(r, seen.accounts))
        await rm(limitResetFile(stateDir, r.operationId), { force: true }).catch(() => {})
    } finally {
      await release()
    }
  }
}

/**
 * The unresolved operation of a login, the oldest first; undefined when there is none. `loginKey` is the comparison
 * key of the login that asks now: an operation made for that login comes first, whichever Accounts it names, so an
 * Account that signed in as the login since finds it too. Then one that names one of `accounts`: it may be another
 * login's by now, which `loginUnchanged` tells, but no new operation is made beside it.
 */
export function unresolvedFor(
  records: readonly LimitResetRecord[],
  accounts: readonly string[],
  loginKey?: string,
): LimitResetRecord | undefined {
  const open = records.filter((r) => r.state === 'pending')
  return (
    open.find((r) => loginUnchanged(r, loginKey)) ??
    open.find((r) => r.accounts.some((a) => accounts.includes(a)))
  )
}

/**
 * Whether a record's Accounts are exactly `accounts`: the group the operation was made for has not changed. Equal
 * refs do not show that the login behind them is the same; `loginUnchanged` does.
 */
export function sameAccounts(record: LimitResetRecord, accounts: readonly string[]): boolean {
  const now = [...accounts].sort()
  return record.accounts.length === now.length && record.accounts.every((r, i) => r === now[i])
}

/**
 * Spends that went through and whose following Quota read is kept (ADR-0072, amending ADR-0060): the Accounts they
 * were for and when that read landed. Auto Handoff may take such an Account back before its window's old reset time.
 */
export async function confirmedSpends(
  stateDir: string,
): Promise<{ accounts: string[]; quotaReadAt: string }[]> {
  return (await listLimitResetRecords(stateDir)).flatMap((r) =>
    spent(r.state) && r.quotaReadAt ? [{ accounts: r.accounts, quotaReadAt: r.quotaReadAt }] : [],
  )
}

const LOCK = { staleMs: 30_000, beatMs: 5_000, maxMs: 180_000 }

/**
 * The spend lock of one login, across processes: one lock file per Account of the Same Login, taken in sorted order
 * so two takers never wait on each other. Null when another sideby keeps it for longer than `waitMs`.
 */
export async function takeLimitResetLock(
  stateDir: string,
  accounts: readonly string[],
  waitMs: number,
): Promise<ReleaseLock | null> {
  const dir = join(await ensureDir(stateDir), 'locks')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const held: ReleaseLock[] = []
  const release = async () => {
    for (const r of held.reverse()) await r()
  }
  const deadline = Date.now() + waitMs
  for (const ref of [...new Set(accounts)].sort()) {
    const lock = await takeFileLock(join(dir, `${ref.replace(':', '.')}.lock`), {
      ...LOCK,
      wait: { timeoutMs: Math.max(0, deadline - Date.now()), pollMs: 100 },
    }).catch(() => null)
    if (!lock) {
      await release()
      return null
    }
    held.push(lock)
  }
  return release
}

/** What each outcome means for the user, in plain words. */
export function outcomeMessage(outcome: LimitResetOutcome, ref: string): string {
  switch (outcome) {
    case 'reset':
      return `A limit reset was used for ${ref}.`
    case 'already-done':
      return `This limit reset was already used for ${ref}; nothing more was spent.`
    case 'nothing-to-reset':
      return `Nothing was spent: no limit of ${ref} can be reset right now.`
    case 'none-left':
      return `Nothing was spent: ${ref} holds no limit reset.`
  }
}
