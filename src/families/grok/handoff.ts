// How Grok Build takes part in a Handoff (spec §3.17). It has no public Quota, so it starts one only after a turn
// failed at the limit. Interactive `grok` has no launch option for hooks: `sideby handoff setup grok` adds
// `hooks/sideby-handoff.json` to the Main Account and Doctor copies it to the others (verified 2026-10-09).
// The hook inherits Grok's sandbox, so the profile decides whether a run may start or receive.
import { mkdir, readFile, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { sha256, writeFileAtomic } from '../../core/fs-safe.ts'
import { sidebyBinProblem } from '../../core/launch.ts'
import { tildify } from '../../core/paths.ts'
import type { Env, FamilyHandoff, QuotaSetup, QuotaSetupPlan, ReadContext } from '../../types.ts'
import {
  type ArgRules,
  carryArgs,
  hasOption,
  optionValue,
  promptAfterDashes,
} from '../shared/handoff-args.ts'
import { tomlValue } from '../shared/toml.ts'
import { grokBrief } from './brief.ts'

/** From `grok --help`. */
export const GROK_ARGS: ArgRules = {
  valued: [
    '--agent',
    '--agents',
    '--allow',
    '--cwd',
    '--debug-file',
    '--deny',
    '--disallowed-tools',
    '--json-schema',
    '--leader-socket',
    '-m',
    '--model',
    '--max-turns',
    '--output-format',
    '-p',
    '--single',
    '--permission-mode',
    '--prompt-file',
    '--prompt-json',
    '--reasoning-effort',
    '--rules',
    '-s',
    '--session-id',
    '--sandbox',
    '--system-prompt-override',
    '--tools',
    '--worktree-ref',
  ],
  optional: ['-r', '--resume', '-w', '--worktree'],
  drop: ['-c', '--continue', '-r', '--resume', '-s', '--session-id', '--fork-session', '--restore-code'],
}

export const ETC_GROK = '/etc/grok'
export const HOOK_FILE = 'sideby-handoff.json'

/** The text of Grok's config layers that decide the sandbox, leader and hook policy; missing files are null. */
export interface GrokLayers {
  etcRequirements: string | null
  homeRequirements: string | null
  config: string | null
  homeManaged: string | null
  etcManaged: string | null
}

const str = (v: string | boolean | undefined) => (typeof v === 'string' ? v : undefined)
const bool = (v: string | boolean | undefined) => (typeof v === 'boolean' ? v : undefined)
const first = <T>(...vs: (T | undefined)[]) => vs.find((v) => v !== undefined)

/**
 * The effective sandbox profile, leader setting and managed-hooks pin, in Grok's precedence (spec §3.17):
 * requirements (`/etc` over `$GROK_HOME`, a pin) > command line > environment > `config.toml` > managed config
 * (`$GROK_HOME` over `/etc`) > the default `off`.
 */
export function grokPolicy(layers: GrokLayers, args: readonly string[], env: Env) {
  const read = (key: [string, string]) => (t: string | null) =>
    t === null ? undefined : tomlValue(t, ...key)
  const profileIn = read(['sandbox', 'profile'])
  const leaderIn = read(['cli', 'use_leader'])
  const pinIn = read(['', 'allow_managed_hooks_only'])
  const profile =
    first(
      str(profileIn(layers.etcRequirements)),
      str(profileIn(layers.homeRequirements)),
      optionValue(args, ['--sandbox']),
      env.GROK_SANDBOX || undefined,
      str(profileIn(layers.config)),
      str(profileIn(layers.homeManaged)),
      str(profileIn(layers.etcManaged)),
    ) ?? 'off'
  const leaderFlag = hasOption(args, ['--no-leader'])
    ? false
    : hasOption(args, ['--leader'])
      ? true
      : undefined
  const leader =
    first(
      bool(leaderIn(layers.etcRequirements)),
      bool(leaderIn(layers.homeRequirements)),
      leaderFlag,
      bool(leaderIn(layers.config)),
      bool(leaderIn(layers.homeManaged)),
      bool(leaderIn(layers.etcManaged)),
    ) ?? false
  const managedHooksOnly = [
    layers.etcRequirements,
    layers.homeRequirements,
    layers.homeManaged,
    layers.etcManaged,
  ].some((t) => bool(pinIn(t)) === true)
  return { profile, leader, managedHooksOnly }
}

async function textOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

async function readLayers(home: string): Promise<GrokLayers> {
  return {
    etcRequirements: await textOrNull(join(ETC_GROK, 'requirements.toml')),
    homeRequirements: await textOrNull(join(home, 'requirements.toml')),
    config: await textOrNull(join(home, 'config.toml')),
    homeManaged: await textOrNull(join(home, 'managed_config.toml')),
    etcManaged: await textOrNull(join(ETC_GROK, 'managed_config.toml')),
  }
}

const HEADLESS = ['-p', '--single', '--prompt-file', '--prompt-json']

export function grokEligibility(
  policy: ReturnType<typeof grokPolicy>,
  args: readonly string[],
  home: string,
) {
  if (hasOption(args, HEADLESS))
    return { start: false, receive: false, reason: 'a headless run (`-p`) has nobody to hand over to' }
  const extra =
    policy.leader && !hasOption(args, ['--leader-socket'])
      ? { args: ['--leader-socket', join(home, 'leader.sock')] }
      : {}
  const { profile } = policy
  if (profile === 'off' || profile === 'devbox') {
    if (policy.managedHooksOnly)
      return {
        start: false,
        receive: true,
        reason: 'allow_managed_hooks_only keeps sideby’s hook from running',
        ...extra,
      }
    return { start: true, receive: true, ...extra }
  }
  if (profile === 'workspace' || profile === 'read-only')
    return {
      start: false,
      receive: true,
      reason: `the \`${profile}\` sandbox cannot write sideby’s handoff files, so this run can only take over`,
      ...extra,
    }
  return {
    start: false,
    receive: false,
    reason: `the \`${profile}\` sandbox profile cannot read sideby’s handoff files`,
  }
}

const hookCommand = (event: string) => `sideby handoff-hook grok ${event}`

/** The whole file setup writes; teardown removes it only while it is still exactly this. */
export function grokHookFileText(): string {
  const hooks = {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: hookCommand('Stop') }] }],
      // Observation hooks get 5 seconds by default; putting a Brief together may take longer.
      StopFailure: [{ hooks: [{ type: 'command', command: hookCommand('StopFailure'), timeout: 60 }] }],
    },
  }
  return `${JSON.stringify(hooks, null, 2)}\n`
}

const hookFile = (ctx: ReadContext) => join(ctx.home, '.grok', 'hooks', HOOK_FILE)

async function plan(ctx: ReadContext): Promise<QuotaSetupPlan> {
  const file = hookFile(ctx)
  const shown = tildify(file, ctx.home)
  const want = grokHookFileText()
  const have = await textOrNull(file)
  if (have === want) return { status: 'enabled', file, diff: '', message: `already set up in ${shown}` }
  if (have !== null)
    return {
      status: 'blocked',
      file,
      diff: '',
      message: `${shown} exists and is not sideby's; move it away and retry`,
    }
  const problem = await sidebyBinProblem(ctx.env, 'Grok runs `sideby handoff-hook` when a turn ends')
  if (problem) return { status: 'blocked', file, diff: '', message: problem }
  return {
    status: 'ready',
    file,
    diff: `--- /dev/null\n+++ ${shown}\n${want
      .trimEnd()
      .split('\n')
      .map((l) => `+${l}`)
      .join('\n')}\n`,
    message: `adds ${shown} so Grok tells sideby when a turn hits the usage limit; then run \`sideby doctor grok --fix\` to copy it to every Grok account; undo with \`sideby handoff teardown grok\``,
  }
}

export const grokHookSetup: QuotaSetup = {
  summary:
    'Adds one sideby hook file to ~/.grok/hooks so a Grok session that hits its usage limit can hand over.',
  plan,
  async apply(ctx) {
    const p = await plan(ctx)
    if (p.status !== 'ready') return p
    await mkdir(join(ctx.home, '.grok', 'hooks'), { recursive: true })
    await writeFileAtomic(p.file, grokHookFileText(), 0o644)
    return { ...p, status: 'enabled' }
  },
  async teardown(ctx) {
    const file = hookFile(ctx)
    const shown = tildify(file, ctx.home)
    const have = await textOrNull(file)
    if (have === null) return { ok: true, message: `${shown} is not there; nothing to undo` }
    if (sha256(have) !== sha256(grokHookFileText()))
      return {
        ok: false,
        message: `${shown} changed since setup; delete it yourself if you no longer want it`,
      }
    await rm(file)
    // Setup may have made the directory; an empty one goes too, so the Main Account is back as it was.
    await rmdir(join(ctx.home, '.grok', 'hooks')).catch(() => {})
    return {
      ok: true,
      message: `removed ${shown}; run \`sideby doctor grok --fix\` to remove the copies in other Grok accounts`,
    }
  },
}

export const grokHandoff: FamilyHandoff = {
  starts: ['limit'],
  promptArgs: promptAfterDashes,
  continueArgs: (args) => carryArgs(args, GROK_ARGS),
  resumeArgs: (id) => ['--resume', id],
  async eligibility(args, account, env) {
    let layers: GrokLayers
    try {
      layers = await readLayers(account.dir)
    } catch (err) {
      return {
        start: false,
        receive: false,
        reason: `cannot read Grok's config to tell its sandbox: ${(err as Error).message}`,
      }
    }
    return grokEligibility(grokPolicy(layers, args, env), args, account.dir)
  },
  briefFromSession: grokBrief,
  hookSetup: grokHookSetup,
}
