import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdtemp, open, readdir, realpath, rm, stat, unlink } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { AI_TASK_KINDS, type AiTaskKind, stripSecrets, taskPrompt } from '../panel/page-logic.ts'
import type { Runtime } from '../runtime.ts'
import type { Account, Env } from '../types.ts'
import {
  type Attachment,
  checkAttachmentFiles,
  copyAttachments,
  MAX_ATTACHMENTS,
  privateDir,
  removeOldAttachments,
  stagedAttachments,
  takeStaged,
} from './attachments.ts'
import { editConfigAsk, editConfigTerminal } from './config.ts'
import { depsFor } from './desktop-app.ts'
import { UserError } from './errors.ts'
import { writeFileAtomic } from './fs-safe.ts'
import { planHandoff } from './handoff.ts'
import { type Paths, resolvePaths } from './paths.ts'
import { type ProbeDeps, runProbe, spawnProbe } from './probe.ts'
import {
  type AskLauncher,
  askLauncher,
  askRunCommand,
  guessTerminal,
  installedTerminals,
  launcherProblem,
  openTerminal,
  TERMINALS,
  type TerminalId,
  validateCustomTemplate,
  wslDistro,
} from './terminal.ts'

export async function pickTaskAccount(
  rt: Runtime,
  opts: { family?: string; account?: string } = {},
): Promise<{ account: Account } | { reason: 'no-accounts' | 'none-signed-in' | 'all-full' }> {
  const all = (await rt.accounts()).filter((a) => !opts.family || a.family === opts.family)
  if (opts.account) {
    const a = await rt.resolve(opts.account)
    if (opts.family && a.family !== opts.family)
      throw new UserError('Choose an account of the requested family; run `sideby list`.')
    if (a.kind === 'api' || (await rt.status(a)).login === 'logged-in') return { account: a }
    return { reason: 'none-signed-in' }
  }
  // A remembered choice may be an API Account; only the automatic pick below skips them.
  const preferred = all.find((a) => a.ref === rt.config.ask?.account)
  if (preferred && (preferred.kind === 'api' || (await rt.status(preferred)).login === 'logged-in'))
    return { account: preferred }
  if (!all.length) return { reason: 'no-accounts' }
  const candidates = []
  for (const a of all) {
    if (a.kind !== 'subscription' || (await rt.status(a)).login !== 'logged-in') continue
    candidates.push({ ...a, login: 'logged-in' as const, quota: await rt.quota(a, { fetch: 'never' }) })
  }
  if (!candidates.length) return { reason: 'none-signed-in' }
  const plan = planHandoff('', candidates, rt.readContext().now)
  const account = all.find((a) => a.ref === plan.pick)
  return account ? { account } : { reason: 'all-full' }
}

export interface TaskFile {
  kind: 'prompt' | 'login'
  account: string
  prompt?: string
  cwd: string
  /** The Panel's paths when it wrote the task; `ask --run` starts the Host with the same HOME, config and state. */
  home?: string
  configDir?: string
  stateDir?: string
  /** Files attached to the task (spec §3.28 "附件"), saved under `ai/attachments/<task-id>/`; never their content. */
  attachments?: { path: string; kind: 'image' | 'video' }[]
  /**
   * The folder came from a Task Spec (ADR-0030): `cwd` is its real path, which must still be an existing folder inside
   * `home` when the task is written and again when `ask --run` has changed into it.
   */
  cwdInHome?: true
}

/**
 * Why `cwd` cannot be the folder of a Portal's task (ADR-0030), or its real path: it must be an absolute path whose
 * real path is an existing directory inside the real `home`. A link, or a link in an ancestor, counts where it points.
 */
export async function realCwdInHome(cwd: string, home: string): Promise<{ real: string } | { why: string }> {
  if (!isAbsolute(cwd) || cwd.includes('\0')) return { why: 'is not an absolute path' }
  let real: string
  try {
    real = await realpath(cwd)
    if (!(await stat(real)).isDirectory()) return { why: 'is not a folder' }
  } catch {
    return { why: 'does not exist' }
  }
  const realHome = await realpath(home).catch(() => home)
  if (real !== realHome && !real.startsWith(realHome + sep)) return { why: 'is outside your home' }
  return { real }
}

/** A Portal's task folder that stopped being a folder inside the HOME after it was checked. */
export function movedCwdError(why: string): UserError {
  return new UserError(
    `The task folder ${why} now; it changed after the task was prepared. Check the folder, then start the task again.`,
    { code: 'bad-cwd' },
  )
}
export async function taskWorkDir(paths: Paths = resolvePaths()): Promise<string> {
  return privateDir(join(paths.stateDir, 'ai'))
}
const TASK_TTL_MS = 3600000

// Tasks nobody ran (the terminal did not open, the command was not pasted) still hold a prompt: drop them.
async function removeStaleTasks(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[])
  for (const name of names) {
    if (!/^[a-f0-9]{16}\.json$/.test(name)) continue
    const file = join(dir, name)
    try {
      const s = await lstat(file)
      if (s.isFile() && s.uid === process.getuid?.() && Date.now() - s.mtimeMs > TASK_TTL_MS)
        await unlink(file)
    } catch {
      // Another process may have consumed it; a leftover is retried next time.
    }
  }
}
export const newTaskId = () => randomBytes(8).toString('hex')
export async function writeTask(
  task: TaskFile,
  paths: Paths = resolvePaths(),
  id: string = newTaskId(),
): Promise<string> {
  const dir = await privateDir(join(paths.stateDir, 'ask'))
  await removeStaleTasks(dir)
  await removeOldAttachments(paths)
  const where = { home: paths.home, configDir: paths.configDir, stateDir: paths.stateDir }
  await writeFileAtomic(join(dir, `${id}.json`), JSON.stringify({ ...task, ...where }), 0o600)
  return id
}

/**
 * The state folder `ask --run --state-dir` names, accepted only when it and its `ask` folder are real directories the
 * user owns that nobody else can write (the `ask` folder private, as writeTask makes it). Anything else is refused.
 */
export async function taskStateDir(dir: string): Promise<string> {
  const refuse = () =>
    new UserError('This task folder is not yours or not private; click again or rerun `sideby ask`.', {
      code: 'invalid-task',
    })
  if (!isAbsolute(dir) || dir.includes('\0')) throw refuse()
  try {
    const state = await lstat(dir)
    const ask = await lstat(join(dir, 'ask'))
    const uid = process.getuid?.()
    if (
      !state.isDirectory() ||
      !ask.isDirectory() ||
      state.uid !== uid ||
      ask.uid !== uid ||
      (state.mode & 0o022) !== 0 ||
      (ask.mode & 0o077) !== 0
    )
      throw refuse()
  } catch {
    throw refuse()
  }
  return dir
}

function validAttachments(list: unknown): boolean {
  return (
    Array.isArray(list) &&
    list.length <= MAX_ATTACHMENTS &&
    list.every(
      (a: Partial<Attachment> | null) =>
        typeof a?.path === 'string' && isAbsolute(a.path) && (a.kind === 'image' || a.kind === 'video'),
    )
  )
}

/**
 * The Host arguments `ask --run` adds for a prompt task: `<imageArg>=<path>` per attached image for a Family that
 * declares `imageArg` (spec §3.28 "附件"), then the prompt, always last. The `=` form keeps one value per option, so a
 * Host option that takes several values cannot swallow the prompt. An image that is gone, or whose path holds a comma
 * (a Host taking lists may split it), is left to the path in the prompt.
 */
export async function taskHostArgs(rt: Runtime, task: TaskFile): Promise<string[]> {
  const flag = rt.families.get((await rt.resolve(task.account)).family)?.imageArg
  const images: string[] = []
  if (flag)
    for (const a of task.attachments ?? []) {
      if (a.kind !== 'image' || a.path.includes(',')) continue
      if (
        await lstat(a.path).then(
          (s) => s.isFile(),
          () => false,
        )
      )
        images.push(`${flag}=${a.path}`)
    }
  return [...images, task.prompt ?? '']
}

/** `env` with the HOME and XDG folders the task was written under, so the Runtime sees what the Panel saw. */
export function taskEnv(task: TaskFile, env: Env): Env {
  if (!task.home || !task.configDir || !task.stateDir) return env
  return {
    ...env,
    HOME: task.home,
    XDG_CONFIG_HOME: dirname(task.configDir),
    XDG_STATE_HOME: dirname(task.stateDir),
  }
}
export async function readTask(
  id: string,
  paths: Pick<Paths, 'stateDir'> = resolvePaths(),
): Promise<TaskFile> {
  const invalid = () =>
    new UserError('This task is unavailable or expired; click again or rerun `sideby ask`.', {
      code: 'invalid-task',
    })
  if (!/^[a-f0-9]{16}$/.test(id)) throw invalid()
  const file = join(paths.stateDir, 'ask', `${id}.json`)
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const s = await handle.stat()
      if (
        !s.isFile() ||
        s.uid !== process.getuid?.() ||
        (s.mode & 0o7777) !== 0o600 ||
        Date.now() - s.mtimeMs > TASK_TTL_MS ||
        s.size > 1024 * 1024
      )
        throw invalid()
      const task = JSON.parse(await handle.readFile('utf8'))
      if (
        !task ||
        !['prompt', 'login'].includes(task.kind) ||
        typeof task.account !== 'string' ||
        typeof task.cwd !== 'string' ||
        !isAbsolute(task.cwd) ||
        (task.kind === 'prompt' && typeof task.prompt !== 'string') ||
        (task.attachments !== undefined && !validAttachments(task.attachments)) ||
        (task.cwdInHome !== undefined && task.cwdInHome !== true) ||
        // Paths are all there or all absent (a task written before they were recorded), and the state folder is the
        // one the task was read from.
        !(
          (task.home === undefined && task.configDir === undefined && task.stateDir === undefined) ||
          ([task.home, task.configDir, task.stateDir].every((p) => typeof p === 'string' && isAbsolute(p)) &&
            task.stateDir === paths.stateDir)
        )
      )
        throw invalid()
      await unlink(file)
      return task
    } finally {
      await handle.close()
    }
  } catch {
    throw invalid()
  }
}

export async function terminals(rt: Runtime) {
  const deps = depsFor(rt)
  // The Utilities folders are added only to the real defaults, so an injected appDirs stays the whole list.
  const appDirs = deps.appDirs.some((d) => d === '/Applications')
    ? [...deps.appDirs, '/System/Applications/Utilities', '/Applications/Utilities']
    : deps.appDirs
  const installed = await installedTerminals({
    home: rt.paths.home,
    env: rt.env,
    platform: deps.platform,
    appDirs,
    ...(deps.wslMount ? { wslMount: deps.wslMount } : {}),
  })
  if (rt.config.terminal?.custom) installed.push({ id: 'custom' })
  return {
    installed,
    preferred: rt.config.terminal?.preferred ?? null,
    guess: guessTerminal({ preferred: rt.config.terminal?.preferred, env: rt.env, installed }),
    terminals: TERMINALS.map((t) => ({ ...t, installed: installed.some((i) => i.id === t.id) })),
  }
}
export async function setPreferredTerminal(rt: Runtime, id?: string) {
  if (id !== undefined && !TERMINALS.some((t) => t.id === id))
    throw new UserError(
      `Unknown terminal ${JSON.stringify(id)}; choose one of ${TERMINALS.map((t) => t.id).join(', ')}. Run \`sideby terminal\` to see which are installed.`,
      { code: 'unknown-terminal' },
    )
  if (id === 'custom' && !rt.config.terminal?.custom)
    throw new UserError(
      "Set the custom command first: `sideby terminal --custom '<program> … {cwd} … {cmd}'`.",
      { code: 'custom-missing' },
    )
  const r = await editConfigTerminal(rt.paths.configFile, { preferred: id })
  rt.config.terminal = r.after
}
/** Saves `terminal.custom` after checking it names a program and both placeholders; selects it too. */
export async function setCustomTerminal(rt: Runtime, template: string) {
  try {
    validateCustomTemplate(template)
  } catch (err) {
    throw new UserError((err as Error).message, { code: 'custom-invalid' })
  }
  const r = await editConfigTerminal(rt.paths.configFile, { custom: template, preferred: 'custom' })
  rt.config.terminal = r.after
}
export interface AiTaskInput {
  task?: string
  text?: string
  context?: Parameters<typeof taskPrompt>[0]['context']
  lang?: string
  account?: string
  family?: string
  terminal?: string
  /** With an explicit `account`: save it as `ask.account`, the next default. */
  remember?: boolean
  /** Panel uploads (`/api/ask/attach` ids) to attach. */
  uploads?: string[]
  /** The user's own files to attach (`sideby ask --attach`). */
  files?: string[]
}

/**
 * The `context` of an AI Task as a page or a Task Spec sends it (spec §3.28): only the strings and findings a Task
 * Prompt shows; anything else is refused through `fail`, which makes the caller's error (a 400, a Task Spec error).
 */
export function taskContext(c: unknown, fail: (message: string) => Error): AiTaskInput['context'] {
  if (c === undefined || c === null) return undefined
  if (typeof c !== 'object' || Array.isArray(c)) throw fail('"context" must be an object')
  const out: NonNullable<AiTaskInput['context']> = {}
  const str = (v: unknown, what: string) => {
    if (typeof v !== 'string') throw fail(`${what} must be a string`)
    return v
  }
  for (const [k, v] of Object.entries(c)) {
    if (k === 'account' || k === 'family' || k === 'quotaReason' || k === 'version' || k === 'terminalCustom')
      out[k] = str(v, `"context.${k}"`)
    else if (k === 'terminals') {
      if (!Array.isArray(v) || v.length > 50) throw fail('"context.terminals" must be a list')
      out.terminals = v.map((x) => str(x, 'each of "context.terminals"'))
    } else if (k === 'handoff') {
      if (!Array.isArray(v) || v.length > 100) throw fail('"context.handoff" must be a list')
      out.handoff = v.map((x) => str(x, 'each of "context.handoff"'))
    } else if (k === 'findings') {
      if (!Array.isArray(v) || v.length > 100) throw fail('"context.findings" must be a list')
      out.findings = v.map((f) => {
        if (!f || typeof f !== 'object' || Array.isArray(f) || typeof f.message !== 'string')
          throw fail('each finding needs a "message"')
        const one: { code?: string; account?: string; item?: string; message: string; hint?: string } = {
          message: f.message,
        }
        for (const key of ['code', 'account', 'item', 'hint'] as const)
          if (f[key] !== undefined && f[key] !== null) one[key] = str(f[key], `"finding.${key}"`)
        return one
      })
    } else throw fail(`unknown context "${k}"`)
  }
  return out
}

/** The attachments a prompt shown before the task exists lists: uploads still staged, the user's files in place. */
export async function previewAttachments(rt: Runtime, input: AiTaskInput): Promise<Attachment[]> {
  if (input.uploads?.length) return stagedAttachments(rt.paths, input.uploads)
  if (input.files?.length) return checkAttachmentFiles(input.files)
  return []
}
async function takeAttachments(rt: Runtime, input: AiTaskInput, taskId: string): Promise<Attachment[]> {
  if (input.uploads?.length) return takeStaged(rt.paths, input.uploads, taskId)
  if (input.files?.length) return copyAttachments(rt.paths, input.files, taskId)
  return []
}

/** The language of a Task Prompt: the one asked for, else Chinese under a `zh` locale, else English. */
export function taskLang(rt: Runtime, lang?: string): string {
  return lang ?? (/^zh/i.test(rt.env.LC_ALL || rt.env.LC_MESSAGES || rt.env.LANG || '') ? 'zh' : 'en')
}

export function promptForTask(rt: Runtime, input: AiTaskInput, attachments: readonly Attachment[] = []) {
  if (input.task && !AI_TASK_KINDS.includes(input.task as AiTaskKind))
    throw new UserError(`Choose a task: ${AI_TASK_KINDS.join(', ')}; rerun \`sideby ask\`.`)
  let removedSecrets = false
  const prompt = taskPrompt(
    {
      ...input,
      task: input.task ?? 'free',
      attachments: attachments.map(({ path, kind }) => ({ path, kind })),
      lang: taskLang(rt, input.lang),
    },
    (text) => {
      const cleaned = stripSecrets(text)
      removedSecrets ||= cleaned.removed
      return cleaned
    },
  )
  return { prompt, removedSecrets }
}
/** Machine-readable reasons an AI Task did not open; `detail` says what to do. */
export type AiTaskReason =
  | 'no-accounts'
  | 'none-signed-in'
  | 'all-full'
  | 'not-installed'
  | 'automation-denied'
  | 'npx-cache'
  | 'unsafe-path'
  | 'failed'
  | 'unsupported-platform'

export const PICK_DETAIL: Record<'no-accounts' | 'none-signed-in' | 'all-full', string> = {
  'no-accounts':
    'No account yet: create one with `sideby new <family> --next`, or paste the prompt into any AI.',
  'none-signed-in':
    'No account is signed in: run `sideby list`, then `sideby login <account>`; or paste the prompt into any AI.',
  'all-full':
    'Every account has used its quota: wait for a reset (`sideby quota`), or paste the prompt into any AI.',
}

async function openTask(
  rt: Runtime,
  task: TaskFile,
  terminal?: string,
  launcher: AskLauncher = askLauncher(),
  taskId: string = newTaskId(),
) {
  const choices = await terminals(rt)
  const id = terminal ?? choices.guess.id
  if (!TERMINALS.some((t) => t.id === id))
    throw new UserError(
      `Unknown terminal; choose one of ${TERMINALS.map((t) => t.id).join(', ')}, or run \`sideby terminal\` to see which are installed.`,
    )
  // A Portal's folder was checked before the Account and terminal were chosen; it may have been swapped since.
  if (task.cwdInHome) {
    const now = await realCwdInHome(task.cwd, rt.paths.home)
    if ('why' in now) throw movedCwdError(now.why)
    if (now.real !== task.cwd) throw movedCwdError('points somewhere else')
  }
  await writeTask(task, rt.paths, taskId)
  const problem = launcherProblem(launcher, rt.paths.stateDir)
  // An unsafe path cannot go into the command; the user pastes it where sideby is on PATH.
  const command = askRunCommand(
    taskId,
    rt.paths.stateDir,
    problem?.reason === 'unsafe-path' ? null : launcher,
  )
  const deps = depsFor(rt)
  const result =
    problem ??
    (await openTerminal(
      id as TerminalId,
      {
        cwd: task.cwd,
        command,
        custom: rt.config.terminal?.custom,
        installed: choices.installed,
        platform: deps.platform,
        ...(id === 'windows-terminal'
          ? { wslDistro: await wslDistro(rt.env, deps.exec), shell: userInfo().shell ?? undefined }
          : {}),
      },
      deps.exec,
    ))
  return {
    schemaVersion: 1 as const,
    task: taskId,
    account: task.account,
    terminal: id,
    opened: result.ok,
    command,
    ...(!result.ok
      ? {
          reason: result.reason as AiTaskReason,
          detail:
            'detail' in result
              ? result.detail
              : 'This system has no supported terminal launcher; paste the task command into a terminal.',
        }
      : {}),
  }
}
export async function startAiTask(rt: Runtime, input: AiTaskInput) {
  // Checks the task before any attachment is moved or copied.
  promptForTask(rt, input)
  const taskId = newTaskId()
  const attachments = await takeAttachments(rt, input, taskId)
  const { prompt, removedSecrets } = promptForTask(rt, input, attachments)
  return openPromptTask(rt, input, { taskId, prompt, removedSecrets, attachments })
}

/**
 * Picks the Account and opens the Preferred Terminal for a written Task Prompt, as every AI Task does (spec §3.28):
 * sideby's own, and one a Portal hands over in a Task Spec (ADR-0030), which names its own `cwd`.
 */
export async function openPromptTask(
  rt: Runtime,
  input: Pick<AiTaskInput, 'account' | 'family' | 'terminal' | 'remember'>,
  written: {
    taskId: string
    prompt: string
    removedSecrets: boolean
    attachments: Attachment[]
    cwd?: string
  },
) {
  const { taskId, prompt, removedSecrets, attachments } = written
  const pick = await pickTaskAccount(rt, input)
  // Without an account the prompt is copied instead; the saved attachments stay where it says, until the cleanup.
  if ('reason' in pick)
    return {
      schemaVersion: 1 as const,
      task: null,
      account: null,
      terminal: null,
      opened: false,
      command: null,
      prompt,
      reason: pick.reason as AiTaskReason,
      detail: PICK_DETAIL[pick.reason],
      removedSecrets,
      attachments,
    }
  if (input.remember && input.account && rt.config.ask?.account !== pick.account.ref) {
    const saved = await editConfigAsk(rt.paths.configFile, pick.account.ref)
    rt.config.ask = saved.after
  }
  // A terminal the person picked is kept as their preferred one, as `sideby terminal --set` would.
  if (input.remember && input.terminal && rt.config.terminal?.preferred !== input.terminal)
    await setPreferredTerminal(rt, input.terminal)
  const task: TaskFile = {
    kind: 'prompt',
    account: pick.account.ref,
    prompt,
    cwd: written.cwd ?? (await taskWorkDir(rt.paths)),
    ...(written.cwd ? { cwdInHome: true as const } : {}),
  }
  if (attachments.length) task.attachments = attachments.map(({ path, kind }) => ({ path, kind }))
  return {
    ...(await openTask(rt, task, input.terminal, undefined, taskId)),
    removedSecrets,
    attachments,
  }
}
export async function openLoginInTerminal(rt: Runtime, ref: string) {
  const account = await rt.resolve(ref)
  return openTask(rt, { kind: 'login', account: account.ref, cwd: await taskWorkDir(rt.paths) })
}

/**
 * What `try` will run for an Account, computed as `sideby run` would (Family defaults, config arguments) but without
 * reading its Secret File or running `launch.before` hooks: nothing runs before the user agrees.
 */
export async function tryPreview(rt: Runtime, ref: string) {
  const account = await rt.resolve(ref)
  const family = rt.families.get(account.family)
  if (!family?.probe)
    throw new UserError(`This tool cannot be tried; use \`sideby run ${account.ref}\` instead.`, {
      code: 'no-probe',
    })
  const { bin, args } = await rt.launchCommand(account.ref, family.probe.args, 'run')
  return { account, family, command: [bin, ...args] }
}

/**
 * `sideby try` and the Panel (spec §3.28): runs the Family's probe once the way Launch starts the Host, in a temp
 * folder under the task directory that is removed afterwards. The caller has already said it spends a few tokens. The
 * launch is prepared once here, so `launch.before` hooks run once, and the command returned is what actually ran.
 * `spawn` replaces the process start (tests); by default the Host runs with stdin ignored and is killed at the timeout.
 */
export async function tryAccount(rt: Runtime, ref: string, spawn: ProbeDeps['spawn'] = spawnProbe) {
  const { account, family } = await tryPreview(rt, ref)
  const launch = await rt.prepareLaunch(account.ref, family.probe!.args, 'run')
  const cwd = await mkdtemp(join(await taskWorkDir(rt.paths), 'probe-'))
  try {
    const result = await runProbe(account, { family, baseEnv: rt.env, cwd, launch, spawn })
    return { account: account.ref, command: [launch.bin, ...launch.args], ...result }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}
