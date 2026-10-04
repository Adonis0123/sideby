// Checks and repairs one Shared Item in one Account. Every "never" in spec §3.3 is enforced here:
// links are never re-pointed, real files are never replaced by links, writes never pass through a symlink,
// and credential contents are never read (json-key reads only its own key).
import type { Stats } from 'node:fs'
import { chmod, mkdir, readFile, symlink, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { Account, CheckResult, SharedItemDef } from '../types.ts'
import {
  assertInside,
  fileHash,
  isEmptyDir,
  linksTo,
  lstatOrNull,
  permBits,
  realpathOrNull,
  replaceWithCopy,
  sameContent,
  statOrNull,
  writeIfUnchanged,
} from './fs-safe.ts'

export interface ItemContext {
  account: Account
  item: SharedItemDef
  /** Resolved main-side path. */
  mainPath: string
  /** Path inside the Account directory. */
  accountPath: string
  /** The Account directory; every repair must stay inside it. */
  accountDir: string
  /** Allows `json-key` to remove entries the Account has but the main file does not. */
  force: boolean
}

/** `counted` is false for `info` items, which never count toward the shared total. */
export interface ItemCheck {
  counted: boolean
  results: CheckResult[]
}

type Kind = 'missing' | 'link-ok' | 'link-other' | 'file' | 'dir' | 'other'

function kindOf(st: Stats | null): Exclude<Kind, 'link-ok' | 'link-other'> | 'link' {
  if (!st) return 'missing'
  if (st.isSymbolicLink()) return 'link'
  if (st.isFile()) return 'file'
  if (st.isDirectory()) return 'dir'
  return 'other'
}

async function classify(ctx: ItemContext): Promise<{ kind: Kind; st: Stats | null }> {
  const st = await lstatOrNull(ctx.accountPath)
  const k = kindOf(st)
  if (k !== 'link') return { kind: k, st }
  return { kind: (await linksTo(ctx.accountPath, ctx.mainPath)) ? 'link-ok' : 'link-other', st }
}

const ok = (item: string): CheckResult => ({ level: 'ok', item, code: 'ok', message: 'ok' })

function hostNote(item: SharedItemDef): string {
  return item.hostMessage ? ` (host says: "${item.hostMessage}")` : ''
}

async function makeLink(ctx: ItemContext): Promise<{ ok: boolean; message: string }> {
  await mkdir(dirname(ctx.accountPath), { recursive: true })
  await symlink(ctx.mainPath, ctx.accountPath)
  return { ok: true, message: `linked ${ctx.item.path}` }
}

async function makeCopy(ctx: ItemContext): Promise<{ ok: boolean; message: string }> {
  await mkdir(dirname(ctx.accountPath), { recursive: true })
  await replaceWithCopy(ctx.mainPath, ctx.accountPath)
  return { ok: true, message: `copied ${ctx.item.path} from the main account` }
}

/** Replaces a symlink that points at the main item with a real copy; refuses any other link. */
async function linkToCopy(ctx: ItemContext): Promise<{ ok: boolean; message: string }> {
  if (!(await linksTo(ctx.accountPath, ctx.mainPath)))
    return { ok: false, message: `${ctx.item.path} no longer points at the main account; left unchanged` }
  await unlink(ctx.accountPath)
  return makeCopy(ctx)
}

function realConflict(ctx: ItemContext, what: string): CheckResult {
  const p = ctx.accountPath
  return {
    level: 'fail',
    item: ctx.item.path,
    code: 'link.real-file',
    message: `${ctx.item.path} is a real ${what}; expected a link to the main account`,
    hint: `sideby never replaces it. Keep it with: mv "${p}" "${p}.local" && ln -s "${ctx.mainPath}" "${p}"`,
  }
}

/** Whether this item may legitimately be a link in this Account. */
function acceptsLink(ctx: ItemContext): boolean {
  const { item } = ctx
  if (item.noSymlink) return false
  if (item.mode === 'local-if-api') return ctx.account.kind !== 'api'
  return item.mode === 'link' || item.mode === 'link-or-copy' || item.mode === 'link-or-local'
}

/** A link that does not resolve to the main item: dangling is a failure, a deliberate other target a warning. */
async function wrongLink(ctx: ItemContext): Promise<CheckResult> {
  const target = await realpathOrNull(ctx.accountPath)
  if (target && !acceptsLink(ctx))
    return {
      level: 'fail',
      item: ctx.item.path,
      code: 'symlink-forbidden',
      message: `${ctx.item.path} must not be a link (it points to ${target})${hostNote(ctx.item)}`,
      hint: `sideby never re-points or replaces links it did not create. Replace it yourself: rm "${ctx.accountPath}" && cp -R "${ctx.mainPath}" "${ctx.accountPath}"`,
    }
  if (target)
    return {
      level: 'warn',
      item: ctx.item.path,
      code: 'link.other-target',
      message: `${ctx.item.path} links to ${target} instead of the main account's ${ctx.item.path}`,
      hint: 'fine if intended; sideby never re-points links',
    }
  return {
    level: 'fail',
    item: ctx.item.path,
    code: 'link.dangling',
    message: `${ctx.item.path} is a dangling link`,
    hint: `sideby never re-points links. Inspect it with: ls -l "${ctx.accountPath}"`,
  }
}

function missingFix(ctx: ItemContext, useCopy: boolean): CheckResult {
  return {
    level: 'fail',
    item: ctx.item.path,
    code: 'missing',
    message: `${ctx.item.path} is missing`,
    hint: 'run `sideby doctor --fix`',
    fixable: true,
    fix: () => (useCopy ? makeCopy(ctx) : makeLink(ctx)),
  }
}

async function compareCopy(ctx: ItemContext, mainSt: Stats, kind: Kind): Promise<CheckResult> {
  const item = ctx.item.path
  const mainKind = mainSt.isDirectory() ? 'dir' : 'file'
  if (kind !== mainKind)
    return {
      level: 'fail',
      item,
      code: 'copy.type-mismatch',
      message: `${item} is a ${kind} but the main account has a ${mainKind}`,
      hint: 'sideby does not change the type of an existing item; move it aside and run `sideby doctor --fix`',
    }
  if (await sameContent(ctx.accountPath, ctx.mainPath)) return ok(item)
  if (mainKind === 'dir' && (await isEmptyDir(ctx.mainPath)))
    return {
      level: 'warn',
      item,
      code: 'copy.main-empty',
      message: `${item} differs, but the main account's copy is empty; not mirroring an empty directory`,
    }
  return {
    level: 'fail',
    item,
    code: 'copy.stale',
    message: `${item} is an outdated copy of the main account`,
    hint: 'run `sideby doctor --fix`',
    fixable: true,
    fix: () => makeCopy(ctx),
  }
}

async function checkCopyLike(ctx: ItemContext, mainSt: Stats, allowLink: boolean): Promise<CheckResult> {
  const { kind } = await classify(ctx)
  const item = ctx.item.path
  switch (kind) {
    case 'link-ok':
      if (allowLink) return ok(item)
      return {
        level: 'fail',
        item,
        code: 'symlink-forbidden',
        message: `${item} must be a real copy, not a link${hostNote(ctx.item)}`,
        hint: 'run `sideby doctor --fix` to replace the link with a copy',
        fixable: true,
        fix: () => linkToCopy(ctx),
      }
    case 'link-other':
      return await wrongLink(ctx)
    case 'missing':
      return missingFix(ctx, !allowLink)
    case 'file':
    case 'dir':
      return compareCopy(ctx, mainSt, kind)
    default:
      return {
        level: 'fail',
        item,
        code: 'unsupported-type',
        message: `${item} is not a file, directory or link`,
      }
  }
}

async function checkJsonKey(ctx: ItemContext): Promise<CheckResult> {
  const item = `${ctx.item.path}#${ctx.item.key}`
  const key = ctx.item.key!
  const accSt = await lstatOrNull(ctx.accountPath)
  if (accSt?.isSymbolicLink())
    return {
      level: 'fail',
      item,
      code: 'json-key.symlink',
      message: `${ctx.item.path} is a symlink; sharing it would mix logins between accounts`,
      hint: `replace it with the account's own file; sideby will not write through it even with --force`,
    }
  let mainVal: unknown
  let mainText: string
  try {
    mainText = await readFile(ctx.mainPath, 'utf8')
  } catch {
    return { level: 'ok', item, code: 'ok', message: 'main file absent; nothing to share' }
  }
  try {
    mainVal = (JSON.parse(mainText) as Record<string, unknown>)[key]
  } catch {
    return {
      level: 'warn',
      item,
      code: 'json-key.main-unreadable',
      message: `cannot read ${key} from the main file`,
    }
  }
  if (mainVal === undefined) return { level: 'ok', item, code: 'ok', message: `main file has no ${key}` }
  if (!isPlainObject(mainVal))
    return { level: 'fail', item, code: 'json-key.main-not-object', message: `main ${key} is not an object` }
  const beforeHash = await fileHash(ctx.accountPath)
  let acc: Record<string, unknown> = {}
  if (beforeHash !== null) {
    try {
      const parsed: unknown = JSON.parse(await readFile(ctx.accountPath, 'utf8'))
      if (!isPlainObject(parsed)) throw new Error('not an object')
      acc = parsed
    } catch {
      return {
        level: 'fail',
        item,
        code: 'json-key.not-object',
        message: `${ctx.item.path} is not a JSON object; sideby will not rewrite it`,
      }
    }
  }
  const accVal = key in acc ? acc[key] : {}
  if (!isPlainObject(accVal))
    return {
      level: 'fail',
      item,
      code: 'json-key.not-object',
      message: `${key} in ${ctx.item.path} is not an object`,
    }
  if (canonical(accVal) === canonical(mainVal)) return ok(item)
  const removed = Object.keys(accVal).filter((k) => !(k in mainVal))
  const added = Object.keys(mainVal).filter((k) => !(k in accVal))
  const detail = [
    added.length ? `adds ${added.join(', ')}` : '',
    removed.length ? `removes ${removed.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('; ')
  const write = async () => {
    const next = `${JSON.stringify({ ...acc, [key]: mainVal }, null, 2)}\n`
    const done = await writeIfUnchanged(ctx.accountPath, beforeHash, next, 0o600)
    return done
      ? { ok: true, message: `synced ${key} (${detail || 'values changed'})` }
      : { ok: false, message: `${ctx.item.path} changed while syncing; run doctor again` }
  }
  if (removed.length && !ctx.force)
    return {
      level: 'fail',
      item,
      code: 'json-key.would-remove',
      message: `${key} differs from the main account and syncing would remove: ${removed.join(', ')}`,
      hint: 'add them to the main account first, or run `sideby doctor --fix --force` to remove them',
    }
  return {
    level: 'fail',
    item,
    code: 'json-key.drift',
    message: `${key} differs from the main account (${detail || 'values changed'})`,
    hint: 'run `sideby doctor --fix`',
    fixable: true,
    fix: write,
  }
}

async function checkCredentialMode(ctx: ItemContext): Promise<CheckResult | null> {
  const st = await lstatOrNull(ctx.accountPath)
  if (!st?.isFile() || permBits(st) === 0o600) return null
  return credentialModeFinding(ctx.item.path, ctx.accountPath, permBits(st))
}

export function credentialModeFinding(item: string, path: string, mode: number): CheckResult {
  return {
    level: 'fail',
    item,
    code: 'credential.mode',
    message: `${item} has mode ${mode.toString(8)}; credentials must be 600`,
    hint: 'run `sideby doctor --fix`',
    fixable: true,
    fix: async () => {
      await chmod(path, 0o600)
      return { ok: true, message: `set ${item} to 600` }
    },
  }
}

export async function checkItem(ctx: ItemContext): Promise<ItemCheck> {
  const { item } = ctx
  const out: CheckResult[] = []
  if (isAbsolute(item.path) || item.path.split(/[\\/]/).includes('..'))
    return {
      counted: false,
      results: [
        {
          level: 'fail',
          item: item.path,
          code: 'path.invalid',
          message: `shared item path ${item.path} must be relative and stay inside the account directory`,
          hint: 'fix the path in the sideby config or the plugin that defines it',
        },
      ],
    }
  // Every repair re-checks, at the moment it runs, that it writes inside this Account only.
  const guard = (r: CheckResult): CheckResult => {
    const fix = r.fix
    if (!fix) return r
    return {
      ...r,
      fix: async () => {
        await assertInside(ctx.accountDir, ctx.accountPath)
        return fix()
      },
    }
  }
  const done = async (r: CheckResult, counted = true): Promise<ItemCheck> => {
    out.push(guard(r))
    if (item.credential) {
      const c = await checkCredentialMode(ctx)
      if (c) out.push(guard(c))
    }
    return { counted, results: out }
  }

  if (item.mode === 'info') {
    const st = await lstatOrNull(ctx.accountPath)
    if (item.noSymlink && st?.isSymbolicLink())
      return done(
        {
          level: 'fail',
          item: item.path,
          code: 'symlink-forbidden',
          message: `${item.path} must not be a link${hostNote(item)}`,
          hint: `sideby does not copy credentials. Replace the link with the account's own file, e.g. log in again with \`sideby login ${ctx.account.ref}\``,
        },
        false,
      )
    return done(ok(item.path), false)
  }

  if (item.mode === 'json-key') return done(await checkJsonKey(ctx))

  // The main account has nothing to share here yet: not counted, but the Account's own entry must still
  // respect Host rules (a dangling link, or a link where the Host refuses links, is still a problem).
  const mainSt = await statOrNull(ctx.mainPath)
  if (!mainSt) {
    const st = await lstatOrNull(ctx.accountPath)
    if (st?.isSymbolicLink() && (!(await realpathOrNull(ctx.accountPath)) || !acceptsLink(ctx)))
      return done(await wrongLink(ctx), false)
    return done(ok(item.path), false)
  }

  const isApi = ctx.account.kind === 'api'
  const { kind } = await classify(ctx)
  switch (item.mode) {
    case 'link':
      if (kind === 'link-ok') return done(ok(item.path))
      if (kind === 'missing') return done(missingFix(ctx, false))
      if (kind === 'link-other') return done(await wrongLink(ctx))
      return done(realConflict(ctx, kind === 'dir' ? 'directory' : 'file'))
    case 'copy':
      return done(await checkCopyLike(ctx, mainSt, false))
    case 'link-or-copy':
      return done(await checkCopyLike(ctx, mainSt, !item.noSymlink))
    case 'link-or-local':
      if (kind === 'link-ok' || kind === 'file' || kind === 'dir') return done(ok(item.path))
      if (kind === 'missing') return done(missingFix(ctx, false))
      return done(await wrongLink(ctx))
    case 'local':
      if (kind === 'file' || kind === 'dir') return done(ok(item.path))
      if (kind === 'missing') return done(missingFix(ctx, true))
      return done({
        level: 'fail',
        item: item.path,
        code: 'local.is-link',
        message: `${item.path} must be the account's own file, not a link${hostNote(item)}`,
        hint: `sideby never replaces links here. Replace it yourself: rm "${ctx.accountPath}" && cp -R "${ctx.mainPath}" "${ctx.accountPath}"`,
      })
    case 'local-if-api':
      if (!isApi) return done(await checkCopyLike(ctx, mainSt, !item.noSymlink))
      if (kind === 'file') return done(ok(item.path))
      if (kind === 'missing')
        return done({
          level: 'fail',
          item: item.path,
          code: 'api.needs-own',
          message: `${item.path} is missing; an API account needs its own copy`,
          hint: `cp "${ctx.mainPath}" "${ctx.accountPath}" and edit it for this account's endpoint`,
        })
      return done({
        level: 'fail',
        item: item.path,
        code: 'api.needs-own',
        message: `${item.path} must be this API account's own file (found ${kind === 'link-ok' || kind === 'link-other' ? 'a link' : `a ${kind}`})`,
        hint: 'an API account changes its endpoint here, so sharing it would change the main account too',
      })
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    isPlainObject(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b))) : val,
  )
}

export function itemPaths(home: string, mainDir: string, accountDir: string, item: SharedItemDef) {
  return {
    mainPath: item.mainPath ? join(home, item.mainPath) : join(mainDir, item.path),
    accountPath: join(accountDir, item.path),
  }
}
