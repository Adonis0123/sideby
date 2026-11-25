import { unlink } from 'node:fs/promises'
import type { Account } from '../types.ts'
import {
  aliasRefs,
  type Config,
  editConfigAccounts,
  editConfigDisplay,
  editConfigHandoff,
  removeConfigAlias,
} from './config.ts'
import { appDataDir } from './desktop-app.ts'
import { UserError } from './errors.ts'
import { lstatOrNull } from './fs-safe.ts'
import { quotaStoreFile } from './quota-store.ts'
import type { Trash } from './trash.ts'

export type RemoveBlockCode =
  | 'main-account'
  | 'live-sessions'
  | 'desktop-running'
  | 'missing-dir'
  | 'symlink-dir'

export interface RemovePlan {
  ref: string
  family: string
  name: string
  dir: string
  appData?: string
  aliases: string[]
  sameLogin: string[]
  configCleanup: string[]
  blocked?: {
    code: RemoveBlockCode
    message: string
  }
}

export interface RemoveResult {
  ref: string
  family: string
  name: string
  dir: string
  trashedTo: string
  appDataTrashedTo?: string
  removedAliases: string[]
  configCleanup: string[]
  sameLoginKept: string[]
}

export class RemoveError extends UserError {
  constructor(code: string, message: string) {
    super(message, { code })
    this.name = 'RemoveError'
  }
}

export interface RemoveDeps {
  account: Account
  familyTitle: string
  config: Config
  configFile: string
  home: string
  stateDir: string
  sameLogin: readonly string[]
  liveSessionCount: () => Promise<number>
  desktopRunning: () => Promise<boolean>
  trash: Trash
}

export async function planRemoveAccount(deps: RemoveDeps): Promise<RemovePlan> {
  const { account, familyTitle, config, home, stateDir } = deps
  const aliases = Object.entries(aliasRefs(config.aliases))
    .filter(([, ref]) => ref === account.ref)
    .map(([name]) => name)
    .sort()
  const sameLogin = [...deps.sameLogin]
  const appDataPath = account.isMain ? undefined : appDataDir(home, account)
  const appDataStat = appDataPath ? await lstatOrNull(appDataPath) : null
  const appData = appDataStat && !appDataStat.isSymbolicLink() ? appDataPath : undefined

  const configCleanup: string[] = []
  if (aliases.length) configCleanup.push(`aliases (${aliases.join(', ')})`)
  const d = config.display
  if (
    d?.accounts?.[account.family]?.includes(account.name) ||
    d?.pinned?.[account.family]?.includes(account.name) ||
    d?.hidden?.[account.family]?.includes(account.name)
  ) {
    configCleanup.push('display')
  }
  const refs = new Set([account.ref, ...aliases])
  const hasHandoffRef =
    Boolean(config.handoff?.crossOrganization?.some((x) => refs.has(x))) ||
    Object.values(config.handoff?.families ?? {}).some((f) => Boolean(f.order?.some((x) => refs.has(x))))
  if (hasHandoffRef) configCleanup.push('handoff')
  if (config.accounts && Object.hasOwn(config.accounts, account.ref))
    configCleanup.push(`accounts.${account.ref}`)
  const quotaFile = quotaStoreFile(stateDir, account.family, account.name)
  if (await lstatOrNull(quotaFile)) configCleanup.push('quota cache')

  const base: RemovePlan = {
    ref: account.ref,
    family: account.family,
    name: account.name,
    dir: account.dir,
    ...(appData ? { appData } : {}),
    aliases,
    sameLogin,
    configCleanup,
  }

  // ADR-0087: Main Accounts are the symlink source for Shared Items and can never be removed.
  if (account.isMain) {
    return {
      ...base,
      blocked: {
        code: 'main-account',
        message: `${account.ref} is the main account for ${familyTitle}; other accounts link to it, so it cannot be removed. Hide it instead with \`sideby hide ${account.ref}\`.`,
      },
    }
  }

  const dirStat = await lstatOrNull(account.dir)
  if (!dirStat) {
    return {
      ...base,
      blocked: {
        code: 'missing-dir',
        message: `${account.dir} is already gone.`,
      },
    }
  }
  if (dirStat.isSymbolicLink()) {
    return {
      ...base,
      blocked: {
        code: 'symlink-dir',
        message: `${account.dir} is a symlink, not a real folder; remove the link yourself so sideby never moves its target.`,
      },
    }
  }

  const live = await deps.liveSessionCount()
  if (live > 0) {
    return {
      ...base,
      blocked: {
        code: 'live-sessions',
        message: `${account.ref} has ${live} live session${live === 1 ? '' : 's'} running. Close ${live === 1 ? 'it' : 'them'} before removing this account.`,
      },
    }
  }

  if (await deps.desktopRunning()) {
    return {
      ...base,
      blocked: {
        code: 'desktop-running',
        message: `The desktop app for ${account.ref} is currently running. Quit it before removing this account.`,
      },
    }
  }

  return base
}

export async function applyRemoveAccount(deps: RemoveDeps): Promise<RemoveResult> {
  const plan = await planRemoveAccount(deps)
  if (plan.blocked) throw new RemoveError(plan.blocked.code, plan.blocked.message)

  const moved = await deps.trash(plan.dir)
  if (!moved.ok) throw new RemoveError('trash-failed', `Could not move ${plan.dir} to trash: ${moved.why}`)

  let appDataTrashedTo: string | undefined
  if (plan.appData) {
    const movedApp = await deps.trash(plan.appData)
    if (!movedApp.ok) {
      throw new RemoveError(
        'trash-app-data-failed',
        `${plan.dir} was moved to ${moved.to}, but its desktop app data (${plan.appData}) could not be moved: ${movedApp.why}`,
      )
    }
    appDataTrashedTo = movedApp.to
  }

  const removedAliases: string[] = []
  for (const alias of plan.aliases) {
    const r = await removeConfigAlias(deps.configFile, alias)
    if (r.status === 'removed') removedAliases.push(alias)
  }

  const { account, config, configFile, stateDir } = deps
  const d = config.display
  if (
    d &&
    (d.accounts?.[account.family]?.includes(account.name) ||
      d.pinned?.[account.family]?.includes(account.name) ||
      d.hidden?.[account.family]?.includes(account.name))
  ) {
    const drop = (rec?: Record<string, string[]>) => {
      if (!rec?.[account.family]) return rec
      const next = rec[account.family]!.filter((n) => n !== account.name)
      const copy = { ...rec }
      if (next.length) copy[account.family] = next
      else delete copy[account.family]
      return copy
    }
    await editConfigDisplay(configFile, {
      ...d,
      accounts: drop(d.accounts),
      pinned: drop(d.pinned),
      hidden: drop(d.hidden),
    })
  }

  const refs = new Set([account.ref, ...plan.aliases])
  const hasHandoffRef =
    Boolean(config.handoff?.crossOrganization?.some((x) => refs.has(x))) ||
    Object.values(config.handoff?.families ?? {}).some((f) => Boolean(f.order?.some((x) => refs.has(x))))
  if (hasHandoffRef && config.handoff) {
    await editConfigHandoff(configFile, (cur) => {
      const next = { ...cur }
      if (cur.crossOrganization) {
        const filtered = cur.crossOrganization.filter((x) => !refs.has(x))
        if (filtered.length) next.crossOrganization = filtered
        else delete next.crossOrganization
      }
      if (cur.families) {
        next.families = Object.fromEntries(
          Object.entries(cur.families).map(([fid, f]) => [
            fid,
            f.order ? { ...f, order: f.order.filter((x) => !refs.has(x)) } : f,
          ]),
        )
      }
      return next
    })
  }

  if (config.accounts && Object.hasOwn(config.accounts, account.ref)) {
    await editConfigAccounts(configFile, (cur) => {
      if (!Object.hasOwn(cur, account.ref)) return null
      const { [account.ref]: _gone, ...rest } = cur
      return rest
    })
  }

  const quotaFile = quotaStoreFile(stateDir, account.family, account.name)
  await unlink(quotaFile).catch(() => {})

  return {
    ref: plan.ref,
    family: plan.family,
    name: plan.name,
    dir: plan.dir,
    trashedTo: moved.to,
    ...(appDataTrashedTo ? { appDataTrashedTo } : {}),
    removedAliases,
    configCleanup: plan.configCleanup,
    sameLoginKept: plan.sameLogin,
  }
}
