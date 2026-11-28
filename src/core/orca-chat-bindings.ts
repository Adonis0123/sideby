// WHY: ADR-0091 Orca Chat sticky account bindings. Orca launches `agy acp` without a conversation id on the command
// line and sends `session/load` over stdin after startup; pinning `ORCA_AGENT_SESSION_ID` to its originating `agy`
// account in `<stateDir>/orca-chat-accounts.json` prevents sleeping Orca Chats from waking into another account.
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { classifyAgyArgs } from '../families/agy/mod.ts'
import type { Env } from '../types.ts'
import { ownedFolder, writeFileAtomic } from './fs-safe.ts'
import { takeFileLock } from './lock.ts'
import { normalizeOrcaSessionId, ORCA_AGENT_SESSION_VAR, ORCA_STRUCTURED_VAR } from './orca-chat.ts'

const DIR = 'orca-chat'
const FILE = 'accounts.json'
const LOCK_FILE = 'accounts.lock'
const MAX_BINDINGS = 500
const MAX_FILE_BYTES = 256 * 1024
const LOCK = { staleMs: 10_000, beatMs: 2_000, maxMs: 30_000 }
const WAIT_MS = 3_000
const ACCOUNT_REF = /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/

export interface OrcaChatBinding {
  account: string
  family: string
  updatedAt: string
}

interface BindingStore {
  version: 1
  bindings: Record<string, OrcaChatBinding>
}

/**
 * WHY: only Orca's own structured `agy acp` launch binds an account; non-`acp` commands run from shells inside an
 * Orca Chat inherit `ORCA_AGENT_SESSION_ID` and must never read or overwrite the Chat's binding (ADR-0091).
 */
export function orcaChatSessionId(env: Env, familyId: string, args: readonly string[]): string | null {
  if (familyId !== 'agy') return null
  if (env[ORCA_STRUCTURED_VAR] !== '1') return null
  const id = normalizeOrcaSessionId(env[ORCA_AGENT_SESSION_VAR])
  if (!id) return null
  return classifyAgyArgs(args).subcommand === 'acp' ? id : null
}

function parseStore(raw: string): Record<string, OrcaChatBinding> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const top = parsed as { version?: unknown; bindings?: unknown }
  if (top.version !== 1 || !top.bindings || typeof top.bindings !== 'object' || Array.isArray(top.bindings))
    return {}
  const out: Record<string, OrcaChatBinding> = {}
  for (const [k, v] of Object.entries(top.bindings as Record<string, unknown>)) {
    const id = normalizeOrcaSessionId(k)
    if (!id || !v || typeof v !== 'object' || Array.isArray(v)) continue
    const e = v as { account?: unknown; family?: unknown; updatedAt?: unknown }
    if (
      typeof e.account !== 'string' ||
      !ACCOUNT_REF.test(e.account) ||
      typeof e.family !== 'string' ||
      typeof e.updatedAt !== 'string' ||
      Number.isNaN(Date.parse(e.updatedAt))
    )
      continue
    out[id] = { account: e.account, family: e.family, updatedAt: e.updatedAt }
  }
  return out
}

async function readStoreFile(file: string): Promise<Record<string, OrcaChatBinding>> {
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    const st = await fh.stat()
    const uid = process.getuid?.()
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return {}
    if (uid !== undefined && st.uid !== uid) return {}
    if ((st.mode & 0o077) !== 0) return {}
    return parseStore(await fh.readFile('utf8'))
  } catch {
    return {}
  } finally {
    await fh?.close().catch(() => {})
  }
}

export async function readOrcaChatBinding(
  stateDir: string,
  orcaSessionId: string,
  familyId: string,
): Promise<string | null> {
  const id = normalizeOrcaSessionId(orcaSessionId)
  if (!id) return null
  const dir = await ownedFolder(stateDir, [DIR], { create: false, private: true }).catch(() => null)
  if (!dir) return null
  const bindings = await readStoreFile(join(dir, FILE))
  const entry = bindings[id]
  return entry && entry.family === familyId ? entry.account : null
}

function pruneBindings(bindings: Record<string, OrcaChatBinding>): Record<string, OrcaChatBinding> {
  const entries = Object.entries(bindings)
  if (entries.length <= MAX_BINDINGS) return bindings
  entries.sort((a, b) => Date.parse(b[1].updatedAt) - Date.parse(a[1].updatedAt))
  return Object.fromEntries(entries.slice(0, MAX_BINDINGS))
}

export async function writeOrcaChatBinding(
  stateDir: string,
  orcaSessionId: string,
  accountRef: string,
  familyId: string,
  now: Date,
): Promise<boolean> {
  const id = normalizeOrcaSessionId(orcaSessionId)
  if (!id || !ACCOUNT_REF.test(accountRef)) return false
  const dir = await ownedFolder(stateDir, [DIR], { create: true, private: true }).catch(() => null)
  if (!dir) return false
  const release = await takeFileLock(join(dir, LOCK_FILE), {
    ...LOCK,
    wait: { timeoutMs: WAIT_MS, pollMs: 50 },
  }).catch(() => null)
  if (!release) return false
  try {
    const file = join(dir, FILE)
    const current = await readStoreFile(file)
    const next: BindingStore = {
      version: 1,
      bindings: pruneBindings({
        ...current,
        [id]: { account: accountRef, family: familyId, updatedAt: now.toISOString() },
      }),
    }
    await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`, 0o600)
    return true
  } catch {
    return false
  } finally {
    await release().catch(() => {})
  }
}

export async function readAllOrcaChatBindings(stateDir: string): Promise<Record<string, OrcaChatBinding>> {
  const dir = await ownedFolder(stateDir, [DIR], { create: false, private: true }).catch(() => null)
  if (!dir) return {}
  return readStoreFile(join(dir, FILE))
}

export const orcaChatBindingsFile = (stateDir: string): string => join(stateDir, DIR, FILE)
