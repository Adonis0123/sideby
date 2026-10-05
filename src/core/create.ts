import { mkdir, readFile, symlink } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { type HookBus, HookError } from '../plugins/bus.ts'
import type { Account, FamilyDef, SharedItemDef } from '../types.ts'
import { ACCOUNT_NAME, accountAt, accountDirOf, mainDirOf } from './accounts.ts'
import { UserError } from './errors.ts'
import {
  assertInside,
  lstatOrNull,
  parseJsonSafely,
  replaceWithCopy,
  statOrNull,
  writeFileAtomic,
} from './fs-safe.ts'
import { secretFileTemplate } from './secret-file.ts'
import { itemPaths } from './share-modes.ts'

export interface CreateStep {
  item: string
  action: 'linked' | 'copied' | 'written' | 'skipped'
  ok: boolean
  message?: string
}

export interface CreateResult {
  account: Account
  steps: CreateStep[]
  hookErrors: { plugin: string; message: string }[]
  nextSteps: string[]
  ok: boolean
}

export class CreateError extends UserError {}

function actionFor(item: SharedItemDef, api: boolean): 'link' | 'copy' | 'json' | 'skip' {
  switch (item.mode) {
    case 'info':
      return 'skip'
    case 'json-key':
      return 'json'
    case 'link':
    case 'link-or-local':
      return 'link'
    case 'copy':
    case 'local':
      return 'copy'
    case 'link-or-copy':
      return item.noSymlink ? 'copy' : 'link'
    case 'local-if-api':
      // An API Account gets its own copy to edit; a subscription Account shares the main one.
      return api || item.noSymlink ? 'copy' : 'link'
  }
}

export async function createAccount(opts: {
  family: FamilyDef
  name: string
  api: boolean
  home: string
  bus: HookBus
  /** The Family's existing Accounts, for `account.create.before`. */
  accounts?: Account[]
}): Promise<CreateResult> {
  const { family, name, api, home } = opts
  if (!ACCOUNT_NAME.test(name) || name === 'main')
    throw new CreateError(
      `"${name}" is not a valid account name: use 1–32 lowercase letters, digits or "-", not "main"`,
    )
  const mainDir = mainDirOf(family, home)
  if (!(await statOrNull(mainDir))?.isDirectory())
    throw new CreateError(
      `${family.title} has no main account at ${mainDir}; install ${family.bin} (${family.installUrl}) and run it once first`,
    )
  const dir = accountDirOf(family, home, name)
  if (await lstatOrNull(dir))
    throw new CreateError(`${dir} already exists; pick another name or run \`sideby doctor\``)
  // Every level of the layout that already exists must be a real directory (as discovery requires), so a
  // symlinked `~/.pi-<name>` can never make creation write into its target.
  const segments = relative(home, dir).split(sep)
  for (let i = 1; i < segments.length; i++) {
    const prefix = join(home, ...segments.slice(0, i))
    const st = await lstatOrNull(prefix)
    if (st && !st.isDirectory())
      throw new CreateError(
        `${prefix} exists and is not a real directory (a link or file); move it aside first`,
      )
  }
  // Plugins may refuse before anything is written (Cursor keeps one subscription login besides main).
  try {
    await opts.bus.run('account.create.before', family.id, {
      family,
      name,
      api,
      accounts: opts.accounts ?? [],
      config: {},
    })
  } catch (err) {
    if (!(err instanceof HookError)) throw err
    if (err.aborted) throw new CreateError(err.message, { code: 'create-refused' })
    throw new CreateError(
      `${err.message}; nothing was created. Fix or disable plugin ${err.plugin} (see \`sideby plugins\`)`,
    )
  }
  await mkdir(dir, { recursive: true, mode: 0o700 })

  const steps: CreateStep[] = []
  for (const item of family.sharedItems) {
    const { mainPath, accountPath } = itemPaths(home, mainDir, dir, item)
    const action = actionFor(item, api)
    if (action === 'skip') continue
    if (!(await statOrNull(mainPath))) {
      steps.push({ item: item.path, action: 'skipped', ok: true, message: 'not in the main account' })
      continue
    }
    try {
      await assertInside(dir, accountPath)
      await mkdir(dirname(accountPath), { recursive: true })
      if (action === 'link') {
        await symlink(mainPath, accountPath)
        steps.push({ item: item.path, action: 'linked', ok: true })
      } else if (action === 'copy') {
        await replaceWithCopy(mainPath, accountPath)
        steps.push({ item: item.path, action: 'copied', ok: true })
      } else {
        // Never echo parse errors: this file holds credentials.
        const parsed = parseJsonSafely(await readFile(mainPath, 'utf8'), item.mainPath ?? item.path)
        const value = (parsed as Record<string, unknown> | null)?.[item.key!]
        await writeFileAtomic(
          accountPath,
          `${JSON.stringify(value === undefined ? {} : { [item.key!]: value }, null, 2)}\n`,
        )
        steps.push({ item: `${item.path}#${item.key}`, action: 'written', ok: true })
      }
    } catch (err) {
      steps.push({ item: item.path, action: 'skipped', ok: false, message: (err as Error).message })
    }
  }

  let secretFile: string | undefined
  if (api) {
    secretFile = join(dir, 'proxy.env')
    await writeFileAtomic(secretFile, secretFileTemplate(family.apiVars, family.title), 0o600)
    steps.push({ item: 'proxy.env', action: 'written', ok: true })
  }

  const account = await accountAt(family, home, name)
  const logs: string[] = []
  const hookErrors = (
    await opts.bus.runIsolated('account.created', family.id, {
      account,
      family,
      config: {},
      log: (m: string) => logs.push(m),
    })
  )
    .filter((r) => r.error)
    .map((r) => ({ plugin: r.plugin, message: r.error!.message }))

  const nextSteps = api
    ? [`fill in ${secretFile}`, `sideby run ${account.ref}`]
    : [`sideby login ${account.ref}`, `sideby run ${account.ref}`]
  return {
    account,
    steps,
    hookErrors,
    nextSteps: [...nextSteps, ...logs],
    ok: steps.every((s) => s.ok) && hookErrors.length === 0,
  }
}
