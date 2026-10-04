import { readdir } from 'node:fs/promises'
import type { HookBus } from '../plugins/bus.ts'
import type { Account, CheckResult, FamilyDef, Finding, FixResult } from '../types.ts'
import { looksLikeBackup, mainDirOf } from './accounts.ts'
import { lstatOrNull, permBits, statOrNull } from './fs-safe.ts'
import { inspectSecretFile } from './secret-file.ts'
import { checkItem, credentialModeFinding, itemPaths } from './share-modes.ts'

export interface AccountReport {
  ref: string
  family: string
  name: string
  kind: Account['kind']
  dir: string
  shared: { ok: number; total: number }
  backups: number
  findings: Finding[]
}

export interface FixOutcome {
  account: string
  item: string
  code: string
  ok: boolean
  message: string
}

export interface DoctorReport {
  status: 'ok' | 'issues'
  accounts: AccountReport[]
  /** Findings that are not about one Account (for example a missing Main Account). */
  general: Finding[]
  fixes: FixOutcome[]
}

export interface DoctorInput {
  home: string
  families: ReadonlyMap<string, FamilyDef>
  accounts: readonly Account[]
  bus: HookBus
  force?: boolean
}

const BACKUP_ENTRY = /(\.bak|backup|\.tmp)/i
const BACKUP_DIRS = new Set(['backups', 'tmp', '.tmp'])

async function countBackups(dir: string): Promise<number> {
  try {
    return (await readdir(dir)).filter((e) => BACKUP_ENTRY.test(e) && !BACKUP_DIRS.has(e)).length
  } catch {
    return 0
  }
}

function toFinding(r: CheckResult, account: string, source: string): Finding {
  return { ...r, account, source, fixable: Boolean(r.fixable && r.fix) }
}

async function checkAccount(input: DoctorInput, family: FamilyDef, account: Account): Promise<AccountReport> {
  const findings: Finding[] = []
  let okCount = 0
  let total = 0
  const mainDir = mainDirOf(family, input.home)
  const items = [...family.sharedItems]

  if (!account.isMain) {
    for (const item of items) {
      const { mainPath, accountPath } = itemPaths(input.home, mainDir, account.dir, item)
      const res = await checkItem({
        account,
        item,
        mainPath,
        accountPath,
        accountDir: account.dir,
        force: Boolean(input.force),
      })
      if (res.counted) {
        total++
        if (res.results[0]?.level === 'ok') okCount++
      }
      for (const r of res.results) if (r.level !== 'ok') findings.push(toFinding(r, account.ref, 'core'))
    }
    if (looksLikeBackup(account.name))
      findings.push({
        level: 'warn',
        account: account.ref,
        item: 'name',
        code: 'name.backup-like',
        message: `${account.ref} looks like a backup, not an account`,
        hint: `if it is a backup, add "${account.ref}" to "ignore" in the sideby config`,
        source: 'core',
        fixable: false,
      })
  } else {
    // The Main Account is the source of sharing; only its credential files are checked.
    for (const item of items.filter((i) => i.credential)) {
      const { mainPath } = itemPaths(input.home, mainDir, account.dir, item)
      const st = await lstatOrNull(mainPath)
      if (st?.isFile() && permBits(st) !== 0o600)
        findings.push(
          toFinding(
            credentialModeFinding(item.mainPath ?? item.path, mainPath, permBits(st)),
            account.ref,
            'core',
          ),
        )
    }
  }

  if (account.secretFile) {
    const state = await inspectSecretFile(account.secretFile)
    if (state.kind === 'not-file')
      findings.push({
        level: 'fail',
        account: account.ref,
        item: 'proxy.env',
        code: 'secret.not-file',
        message: 'proxy.env must be a regular file, not a link or directory',
        source: 'core',
        fixable: false,
      })
    else if (state.kind === 'mode')
      findings.push(
        toFinding(credentialModeFinding('proxy.env', account.secretFile, state.mode), account.ref, 'core'),
      )
  }

  for (const r of await input.bus.runIsolated('doctor.check', family.id, {
    account,
    family,
    config: {},
  })) {
    if (r.error) {
      findings.push({
        level: 'fail',
        account: account.ref,
        item: 'plugin',
        code: 'plugin.error',
        message: r.error.message,
        source: r.plugin,
        fixable: false,
      })
      continue
    }
    const results = r.result ?? []
    if (!Array.isArray(results)) {
      findings.push({
        level: 'fail',
        account: account.ref,
        item: 'plugin',
        code: 'plugin.error',
        message: `[${r.plugin}] doctor.check must return an array of findings`,
        source: r.plugin,
        fixable: false,
      })
      continue
    }
    for (const c of results) if (c?.level !== 'ok') findings.push(toFinding(c, account.ref, r.plugin))
  }

  return {
    ref: account.ref,
    family: account.family,
    name: account.name,
    kind: account.kind,
    dir: account.dir,
    shared: { ok: okCount, total },
    backups: await countBackups(account.dir),
    findings,
  }
}

export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const accounts: AccountReport[] = []
  const general: Finding[] = []
  for (const family of input.families.values()) {
    const list = input.accounts.filter((a) => a.family === family.id)
    if (list.length === 0) continue
    if (!list.some((a) => a.isMain) && !(await statOrNull(mainDirOf(family, input.home)))?.isDirectory())
      general.push({
        level: 'fail',
        account: `${family.id}:main`,
        item: 'main',
        code: 'main.missing',
        message: `${family.title} has accounts but no main account directory to share from`,
        hint: `run ${family.bin} once so it creates its default directory`,
        source: 'core',
        fixable: false,
      })
    for (const account of list) accounts.push(await checkAccount(input, family, account))
  }
  const failed = [...general, ...accounts.flatMap((a) => a.findings)].some((f) => f.level === 'fail')
  return { status: failed ? 'issues' : 'ok', accounts, general, fixes: [] }
}

/** Applies every fixable Finding once, in order; one failing fix never stops the others. */
export async function applyFixes(report: DoctorReport): Promise<FixOutcome[]> {
  const out: FixOutcome[] = []
  for (const f of report.accounts.flatMap((a) => a.findings)) {
    if (!f.fixable || !f.fix) continue
    let res: FixResult
    try {
      res = await f.fix()
    } catch (err) {
      res = { ok: false, message: (err as Error).message }
    }
    out.push({ account: f.account, item: f.item, code: f.code, ...res })
  }
  return out
}
