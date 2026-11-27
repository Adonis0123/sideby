import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Account, FamilyDef } from '../types.ts'
import { ACCOUNT_NAME } from './account-name.ts'
import { aliasArgs, aliasRefs, type Config } from './config.ts'
import { UserError } from './errors.ts'
import { lstatOrNull, statOrNull } from './fs-safe.ts'

export { ACCOUNT_NAME }

const BACKUP_LIKE = /(bak|backup|old|tmp)/

export function looksLikeBackup(name: string): boolean {
  return BACKUP_LIKE.test(name)
}

export function mainDirOf(family: FamilyDef, home: string): string {
  return join(home, ...family.layout.main.split('/'))
}

export function accountDirOf(family: FamilyDef, home: string, name: string): string {
  if (name === 'main') return mainDirOf(family, home)
  if (!family.layout.account) throw new UserError(mainOnlyMessage(family), { code: 'family-main-only' })
  return join(home, ...family.layout.account.replace('<name>', name).split('/'))
}

/** Why a Main-only Family (ADR-0047) has no other Account, and what the user can do instead. */
export function mainOnlyMessage(family: FamilyDef): string {
  return `${family.title} keeps one sign-in per computer, so sideby supports only its main account for now; run \`sideby run ${family.id}:main\` to use it`
}

/**
 * Shared validator for `FamilyDef.layout.{main,account}` across plugin validation, discovery and creation
 * (ADR-0090): uses `/` separators, rejects empty/`.`/`..` segments, and requires one `<name>` when `withName`.
 */
export function layoutPathProblem(rel: unknown, opts: { withName?: boolean } = {}): string | undefined {
  if (typeof rel !== 'string' || !rel.trim()) return 'path must be non-empty'
  if (rel.includes('\\') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel))
    return 'path must be relative to HOME using "/" separators'
  const segs = rel.split('/')
  if (segs.some((s) => !s || s === '.' || s === '..'))
    return 'path must not contain empty segments, ".", or ".."'
  const nameCount = rel.split('<name>').length - 1
  if (opts.withName && nameCount !== 1) return 'path must contain <name> once'
  if (!opts.withName && nameCount > 0) return 'path must not contain <name>'
  return undefined
}

function splitLayout(family: FamilyDef): {
  parentRel: string
  prefix: string
  suffix: string
  rest: string
} {
  const err = layoutPathProblem(family.layout.account, { withName: true })
  if (err) throw new Error(`family ${family.id}: layout.account ${err}`)
  const segs = family.layout.account!.split('/')
  const idx = segs.findIndex((s) => s.includes('<name>'))
  const seg = segs[idx]!
  const at = seg.indexOf('<name>')
  return {
    parentRel: segs.slice(0, idx).join('/'),
    prefix: seg.slice(0, at),
    suffix: seg.slice(at + '<name>'.length),
    rest: segs.slice(idx + 1).join('/'),
  }
}

/**
 * The Account for this Family and name, read from its directory: the one place an Account is built.
 * Whether it is an API Account follows the Secret File on disk (and `secretFileMeansApi` / `noApi`).
 */
export async function accountAt(family: FamilyDef, home: string, name: string): Promise<Account> {
  const dir = accountDirOf(family, home, name)
  const secretFile = join(dir, 'proxy.env')
  const allowSecret = !family.noApi
  const hasSecret = allowSecret && (await lstatOrNull(secretFile)) !== null
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
  const markers = [
    ...(family.noApi ? [] : ['proxy.env']),
    ...(family.markers ?? family.sharedItems.map((i) => i.path)),
  ]
  for (const p of markers) if (await lstatOrNull(join(dir, p))) return true
  // A freshly created Account may have nothing to share yet; another tool's directory is never empty.
  try {
    return (await readdir(dir)).length === 0
  } catch {
    return false
  }
}

/**
 * Discovers the Main Account (if its directory exists) and every `<prefix><name><suffix>` directory in HOME. A
 * Main-only Family (ADR-0047) has only its Main Account: HOME is not scanned for it.
 */
export async function discoverAccounts(
  family: FamilyDef,
  home: string,
  ignore: ReadonlySet<string> = new Set(),
): Promise<Account[]> {
  const out: Account[] = []
  const main = mainDirOf(family, home)
  if ((await statOrNull(main))?.isDirectory()) out.push(await accountAt(family, home, 'main'))
  if (!family.layout.account) return out
  const { parentRel, prefix, suffix, rest } = splitLayout(family)
  // WHY: every parent directory along a nested `layout.account` (e.g. `~/.gemini`, ADR-0090) must be a real directory.
  let scanDir = home
  if (parentRel) {
    for (const seg of parentRel.split('/')) {
      scanDir = join(scanDir, seg)
      if (!(await lstatOrNull(scanDir))?.isDirectory()) return out
    }
  }
  let entries: string[] = []
  try {
    entries = await readdir(scanDir)
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
    let dir = join(scanDir, e)
    if (!(await lstatOrNull(dir))?.isDirectory()) continue
    let nestedOk = true
    if (rest) {
      for (const seg of rest.split('/')) {
        dir = join(dir, seg)
        if (!(await lstatOrNull(dir))?.isDirectory()) {
          nestedOk = false
          break
        }
      }
    }
    if (!nestedOk) continue
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

/**
 * The argument lists an Account may start with: its config `accounts.<ref>.args`, then each of its short commands'
 * own arguments. Doctor and the Panel read them to tell whether its sessions start in bypass permission mode.
 */
export function startArgsOf(
  config: Pick<Config, 'accounts' | 'aliases'>,
  accounts: readonly Account[],
): (a: Account) => string[][] {
  const byAccount = aliasesByAccount(aliasRefs(config.aliases), accounts)
  return (a) => [
    config.accounts?.[a.ref]?.args ?? [],
    ...(byAccount.get(a.ref) ?? []).map((n) => aliasArgs(config.aliases?.[n])),
  ]
}
