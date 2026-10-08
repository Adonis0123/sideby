import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Account, FamilyDef } from '../types.ts'
import { ACCOUNT_NAME } from './account-name.ts'
import { UserError } from './errors.ts'
import { lstatOrNull, statOrNull } from './fs-safe.ts'

export { ACCOUNT_NAME }

const BACKUP_LIKE = /(bak|backup|old|tmp)/

export function looksLikeBackup(name: string): boolean {
  return BACKUP_LIKE.test(name)
}

export function mainDirOf(family: FamilyDef, home: string): string {
  return join(home, family.layout.main)
}

export function accountDirOf(family: FamilyDef, home: string, name: string): string {
  return name === 'main' ? mainDirOf(family, home) : join(home, family.layout.account.replace('<name>', name))
}

function splitLayout(family: FamilyDef): { prefix: string; suffix: string; rest: string } {
  const [first, ...rest] = family.layout.account.split('/')
  const at = first!.indexOf('<name>')
  if (at === -1)
    throw new Error(`family ${family.id}: layout.account must contain <name> in its first segment`)
  return { prefix: first!.slice(0, at), suffix: first!.slice(at + '<name>'.length), rest: rest.join('/') }
}

/**
 * The Account for this Family and name, read from its directory: the one place an Account is built.
 * Whether it is an API Account follows the Secret File on disk (and the Family's secretFileMeansApi).
 */
export async function accountAt(family: FamilyDef, home: string, name: string): Promise<Account> {
  const dir = accountDirOf(family, home, name)
  const secretFile = join(dir, 'proxy.env')
  const hasSecret = (await lstatOrNull(secretFile)) !== null
  return {
    family: family.id,
    name,
    ref: `${family.id}:${name}`,
    dir,
    isMain: name === 'main',
    kind: hasSecret && family.secretFileMeansApi !== false ? 'api' : 'subscription',
    ...(hasSecret ? { secretFile } : {}),
  }
}

/**
 * A directory that merely matches the name pattern (for example `~/.claude-code-router`, another tool's
 * config) is not an Account: it must hold a Secret File or one of the Family's Shared Items, or be empty.
 */
async function looksLikeAccount(family: FamilyDef, dir: string): Promise<boolean> {
  for (const p of ['proxy.env', ...(family.markers ?? family.sharedItems.map((i) => i.path))])
    if (await lstatOrNull(join(dir, p))) return true
  // A freshly created Account may have nothing to share yet; another tool's directory is never empty.
  try {
    return (await readdir(dir)).length === 0
  } catch {
    return false
  }
}

/** Discovers the Main Account (if its directory exists) and every `<prefix><name><suffix>` directory in HOME. */
export async function discoverAccounts(
  family: FamilyDef,
  home: string,
  ignore: ReadonlySet<string> = new Set(),
): Promise<Account[]> {
  const out: Account[] = []
  const main = mainDirOf(family, home)
  if ((await statOrNull(main))?.isDirectory()) out.push(await accountAt(family, home, 'main'))
  const { prefix, suffix, rest } = splitLayout(family)
  let entries: string[] = []
  try {
    entries = await readdir(home)
  } catch {
    return out
  }
  const names: string[] = []
  for (const e of entries) {
    if (!e.startsWith(prefix) || !e.endsWith(suffix)) continue
    const name = e.slice(prefix.length, e.length - suffix.length)
    if (!ACCOUNT_NAME.test(name) || name === 'main') continue
    if (ignore.has(`${family.id}:${name}`)) continue
    // A non-main Account must be a real directory at every level: a symlinked `~/.claude-work` pointing at
    // `~/.claude` would make every repair write into the Main Account. Only the Main Account may be a link.
    const top = join(home, e)
    const dir = rest ? join(top, rest) : top
    if (!(await lstatOrNull(top))?.isDirectory()) continue
    if (rest && !(await lstatOrNull(dir))?.isDirectory()) continue
    if (!(await looksLikeAccount(family, dir))) continue
    names.push(name)
  }
  names.sort()
  for (const name of names) out.push(await accountAt(family, home, name))
  return out
}

export class AccountRefError extends UserError {}

/** Resolves `<family>:<name>`, an alias from the config, or a name unique across Families. */
export function resolveRef(
  ref: string,
  accounts: readonly Account[],
  aliases: Readonly<Record<string, string>> = {},
): Account {
  if (!ref.includes(':') && Object.hasOwn(aliases, ref)) return resolveRef(aliases[ref]!, accounts)
  if (ref.includes(':')) {
    const hit = accounts.find((a) => a.ref === ref)
    if (hit) return hit
    throw new AccountRefError(
      `no account ${ref}; run \`sideby list\` to see accounts or \`sideby new\` to create one`,
    )
  }
  const hits = accounts.filter((a) => a.name === ref)
  if (hits.length === 1) return hits[0]!
  if (hits.length === 0)
    throw new AccountRefError(`no account named ${ref}; run \`sideby list\` to see accounts`)
  throw new AccountRefError(`${ref} is ambiguous; use one of: ${hits.map((a) => a.ref).join(', ')}`)
}

/** Alias names per Account ref, sorted. An alias whose target matches no Account is left out. */
export function aliasesByAccount(
  aliases: Readonly<Record<string, string>> | undefined,
  accounts: readonly Account[],
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [alias, target] of Object.entries(aliases ?? {})) {
    let ref: string
    try {
      ref = resolveRef(target, accounts).ref
    } catch {
      continue
    }
    out.set(ref, [...(out.get(ref) ?? []), alias].sort())
  }
  return out
}
