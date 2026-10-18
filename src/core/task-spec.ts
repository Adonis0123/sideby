// Task Specs (spec §3.28 "Portal 交来的任务", ADR-0030): a Portal hands sideby an AI Task as one JSON object on
// stdin, either a Task Prompt it wrote for another Tool or one of sideby's own tasks (`native`). sideby picks the
// Account, takes the attachments and opens the Preferred Terminal exactly as for its own AI Tasks; the prompt reaches
// the Host only through the task file, never a shell.
import { isAbsolute } from 'node:path'
import { AI_TASK_KINDS, attachedSection, stripSecrets } from '../panel/page-logic.ts'
import type { Runtime } from '../runtime.ts'
import {
  type AiTaskInput,
  newTaskId,
  openPromptTask,
  PICK_DETAIL,
  pickTaskAccount,
  previewAttachments,
  promptForTask,
  realCwdInHome,
  startAiTask,
  taskContext,
  taskLang,
  terminals,
} from './ask.ts'
import { type Attachment, checkAttachmentFiles, copyAttachments, MAX_ATTACHMENTS } from './attachments.ts'
import { UserError } from './errors.ts'
import { TERMINALS } from './terminal.ts'

/** The largest Task Spec read from stdin. */
export const MAX_SPEC_BYTES = 1024 * 1024

/** The Task Spec version this sideby understands; a Portal that sends another one is told to update sideby. */
export const SPEC_VERSION = 1

/** Why a Task Spec was refused; `spec-version` exits 2 so a Portal can tell "update sideby" apart. */
export type SpecErrorCode = 'spec-invalid' | 'spec-too-large' | 'spec-version' | 'bad-cwd'

export class SpecError extends UserError {
  override readonly code: SpecErrorCode
  constructor(code: SpecErrorCode, message: string) {
    super(message, { code })
    this.code = code
  }
}

interface SpecCommon {
  lang?: 'en' | 'zh'
  account?: string
  terminal?: string
  remember?: boolean
  files?: string[]
}
export type TaskSpec =
  | (SpecCommon & { prompt: string; cwd?: string })
  | (SpecCommon & { native: { task: string; text?: string; context?: AiTaskInput['context'] } })

const invalid = (message: string) =>
  new SpecError('spec-invalid', `${message}; fix the Task Spec and send it again.`)

const COMMON = ['specVersion', 'lang', 'account', 'terminal', 'remember', 'files']

/** Reads a Task Spec from `input` (stdin), refusing more than MAX_SPEC_BYTES before it is all read. */
export async function readSpecText(input: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of input) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buf.length
    if (size > MAX_SPEC_BYTES)
      throw new SpecError(
        'spec-too-large',
        `The Task Spec is larger than ${MAX_SPEC_BYTES} bytes; attach big content as files instead.`,
      )
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Checks a Task Spec's shape. Values are kept as given; `cwd` is checked later against the HOME. */
export function parseTaskSpec(text: string): TaskSpec {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw invalid('The Task Spec is not valid JSON')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw invalid('The Task Spec must be one JSON object')
  const o = raw as Record<string, unknown>
  if (o.specVersion !== SPEC_VERSION) {
    if (typeof o.specVersion === 'number')
      throw new SpecError(
        'spec-version',
        `This sideby reads Task Spec version ${SPEC_VERSION}, not ${o.specVersion}; update sideby with \`sideby update\`.`,
      )
    throw invalid(`"specVersion" must be ${SPEC_VERSION}`)
  }
  const hasPrompt = o.prompt !== undefined
  const hasNative = o.native !== undefined
  if (hasPrompt === hasNative)
    throw invalid('Give either "prompt" (with "cwd") or "native", not both or neither')
  const allowed = new Set([...COMMON, ...(hasPrompt ? ['prompt', 'cwd'] : ['native'])])
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw invalid(`Unknown field "${k}"`)
  const common: SpecCommon = {}
  if (o.lang !== undefined && o.lang !== null) {
    if (o.lang !== 'en' && o.lang !== 'zh') throw invalid('"lang" must be "en" or "zh"')
    common.lang = o.lang
  }
  for (const key of ['account', 'terminal'] as const) {
    const v = o[key]
    if (v === undefined || v === null) continue
    if (typeof v !== 'string' || !v) throw invalid(`"${key}" must be a string or null`)
    common[key] = v
  }
  if (common.terminal && !TERMINALS.some((t) => t.id === common.terminal))
    throw invalid(`"terminal" must be one of ${TERMINALS.map((t) => t.id).join(', ')}`)
  if (o.remember !== undefined && o.remember !== null) {
    if (typeof o.remember !== 'boolean') throw invalid('"remember" must be true or false')
    common.remember = o.remember
  }
  if (o.files !== undefined && o.files !== null) {
    const f = o.files
    if (
      !Array.isArray(f) ||
      f.length > MAX_ATTACHMENTS ||
      !f.every((p) => typeof p === 'string' && isAbsolute(p) && !p.includes('\0'))
    )
      throw invalid(`"files" must list at most ${MAX_ATTACHMENTS} absolute paths`)
    if (f.length) common.files = f as string[]
  }
  if (hasPrompt) {
    if (typeof o.prompt !== 'string' || !o.prompt.trim()) throw invalid('"prompt" must be a non-empty string')
    if (o.cwd !== undefined && o.cwd !== null && typeof o.cwd !== 'string')
      throw invalid('"cwd" must be a path')
    return { ...common, prompt: o.prompt, ...(typeof o.cwd === 'string' ? { cwd: o.cwd } : {}) }
  }
  const n = o.native
  if (!n || typeof n !== 'object' || Array.isArray(n)) throw invalid('"native" must be an object')
  const native = n as Record<string, unknown>
  for (const k of Object.keys(native))
    if (!['task', 'text', 'context'].includes(k)) throw invalid(`Unknown field "native.${k}"`)
  if (typeof native.task !== 'string' || !(AI_TASK_KINDS as readonly string[]).includes(native.task))
    throw invalid(`"native.task" must be one of ${AI_TASK_KINDS.join(', ')}`)
  if (native.text !== undefined && native.text !== null && typeof native.text !== 'string')
    throw invalid('"native.text" must be a string')
  const context = taskContext(native.context, (m) => invalid(m.replace('"context', '"native.context')))
  return {
    ...common,
    native: {
      task: native.task,
      ...(typeof native.text === 'string' && native.text ? { text: native.text } : {}),
      ...(context ? { context } : {}),
    },
  }
}

/**
 * The folder a Task Spec's prompt starts in: an existing directory inside the HOME, as its real path. Without one,
 * sideby's own task work folder (`"cwd": "engine"` in a Tool's declaration).
 */
export async function specCwd(rt: Runtime, cwd: string | undefined): Promise<string | undefined> {
  if (cwd === undefined) return undefined
  const bad = (why: string) =>
    new SpecError(
      'bad-cwd',
      `The task folder ${JSON.stringify(cwd)} ${why}; name an existing folder in your home.`,
    )
  const checked = await realCwdInHome(cwd, rt.paths.home)
  if ('why' in checked) throw bad(checked.why)
  return checked.real
}

function nativeInput(spec: Extract<TaskSpec, { native: unknown }>): AiTaskInput {
  return {
    task: spec.native.task,
    ...(spec.native.text ? { text: spec.native.text } : {}),
    ...(spec.native.context ? { context: spec.native.context } : {}),
    ...(spec.lang ? { lang: spec.lang } : {}),
    ...(spec.account ? { account: spec.account } : {}),
    ...(spec.terminal ? { terminal: spec.terminal } : {}),
    ...(spec.remember ? { remember: spec.remember } : {}),
    ...(spec.files ? { files: spec.files } : {}),
  }
}

/** A Portal's prompt as the Host gets it: keys removed again, then the attachments section at its heading level. */
function specPrompt(
  rt: Runtime,
  spec: Extract<TaskSpec, { prompt: string }>,
  attachments: readonly Attachment[],
) {
  const cleaned = stripSecrets(spec.prompt)
  const heading = /^(#{1,6} )\S/m.exec(cleaned.text)?.[1] ?? ''
  const files = attachments.map(({ path, kind }) => ({ path, kind }))
  const section = attachedSection(files, taskLang(rt, spec.lang), heading)
  return {
    prompt: section ? `${cleaned.text.trimEnd()}\n\n${section}` : cleaned.text,
    removedSecrets: cleaned.removed,
  }
}

/** `sideby ask --spec - --print`: the prompt the Host would get, without writing a task or copying a file. */
export async function previewTaskSpec(rt: Runtime, spec: TaskSpec) {
  if ('native' in spec) {
    const input = nativeInput(spec)
    const { prompt, removedSecrets } = promptForTask(rt, input, await previewAttachments(rt, input))
    return { schemaVersion: 1 as const, prompt, removedSecrets }
  }
  await specCwd(rt, spec.cwd)
  const files = spec.files ? await checkAttachmentFiles(spec.files) : []
  return { schemaVersion: 1 as const, ...specPrompt(rt, spec, files) }
}

/** `sideby ask --spec -`: starts the AI Task the spec describes; the result is `startAiTask`'s. */
export async function startTaskSpec(rt: Runtime, spec: TaskSpec) {
  if ('native' in spec) return startAiTask(rt, nativeInput(spec))
  // The folder is checked before any attachment is copied.
  const cwd = await specCwd(rt, spec.cwd)
  const taskId = newTaskId()
  const attachments = spec.files ? await copyAttachments(rt.paths, spec.files, taskId) : []
  const written = specPrompt(rt, spec, attachments)
  return openPromptTask(rt, spec, { taskId, ...written, attachments, ...(cwd ? { cwd } : {}) })
}

/**
 * `sideby ask --choices` (ADR-0030): what a Portal's dialog offers before it starts a task. `account` is what an AI
 * Task would pick now (null with `reason` and `detail` when nothing can be picked); `accounts` lists every API
 * Account and Subscription Account, signed-in ones first; `terminals` the supported terminals installed here, with
 * the one a task would open in `terminal`.
 */
export async function taskChoices(rt: Runtime) {
  const pick = await pickTaskAccount(rt)
  const signedIn: { ref: string; label: string; signedIn: boolean }[] = []
  const api: typeof signedIn = []
  const signedOut: typeof signedIn = []
  const all = [...(await rt.accounts())].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
  for (const a of all) {
    if (a.kind === 'api') api.push({ ref: a.ref, label: `${a.ref} · API`, signedIn: true })
    else if ((await rt.status(a)).login === 'logged-in')
      signedIn.push({ ref: a.ref, label: a.ref, signedIn: true })
    else signedOut.push({ ref: a.ref, label: a.ref, signedIn: false })
  }
  const t = await terminals(rt)
  const name = (id: string) => TERMINALS.find((x) => x.id === id)?.name ?? id
  return {
    schemaVersion: 1 as const,
    account: 'account' in pick ? pick.account.ref : null,
    accounts: [...signedIn, ...api, ...signedOut],
    terminal: t.guess.id,
    terminals: t.installed.map((i) => ({ id: i.id, label: name(i.id) })),
    reason: 'reason' in pick ? pick.reason : null,
    detail: 'reason' in pick ? PICK_DETAIL[pick.reason] : null,
  }
}
