import { spawn } from 'node:child_process'
import { HookBus } from '../plugins/bus.ts'
import type { Account, Env, FamilyDef } from '../types.ts'
import { UserError } from './errors.ts'
import { type PreparedLaunch, prepareLaunch } from './launch.ts'
import { readSecretFile } from './secret-file.ts'

/** How long `sideby try` waits for the Host (spec §3.28). The spawner enforces it. */
export const PROBE_TIMEOUT_MS = 60_000

/** Combined stdout and stderr kept after redaction, in bytes. */
export const PROBE_OUTPUT_MAX_BYTES = 2048

/**
 * What the injected spawner receives. It must start `bin` with `args` only, in `cwd`, with `env`,
 * and with stdin ignored (not a terminal and not a pipe the Host can wait on). When `timeoutMs`
 * elapses it stops the process and resolves with `timedOut: true`. Errors must not include `env`
 * or anything read from a Secret File.
 */
export interface ProbeSpawnRequest {
  bin: string
  args: readonly string[]
  env: Env
  cwd: string
  timeoutMs: number
  /** Always `ignore`: the probe is not interactive. */
  stdin: 'ignore'
}

export interface ProbeSpawnResult {
  /** Process exit code, or null when it timed out or the code could not be read. */
  exitCode: number | null
  stdout: string
  stderr: string
  /** True when the spawner stopped the process because `timeoutMs` elapsed. */
  timedOut: boolean
}

export interface ProbeDeps {
  family: FamilyDef
  /** The environment sideby itself is running in: the same `baseEnv` Launch copies. */
  baseEnv: Env
  /** Working directory for the Host. The caller creates this temp directory. */
  cwd: string
  spawn: (req: ProbeSpawnRequest) => Promise<ProbeSpawnResult>
  /** Account arguments from config, passed through Launch the same way `sideby run` does. */
  accountArgs?: readonly string[]
  /** What Launch would set as `SIDEBY_LABEL`. Defaults to the account ref. */
  label?: string
  /** `launch.before` hooks. Pass the runtime bus so the probe sees the same environment as Launch. */
  bus?: HookBus
  /**
   * The Launch already prepared with `probe.args` as the user's arguments (the runtime's `prepareLaunch`), so its
   * hooks and config arguments are applied once; `accountArgs`, `label` and `bus` are then unused.
   */
  launch?: PreparedLaunch
  /** Defaults to {@link PROBE_TIMEOUT_MS}. */
  timeoutMs?: number
}

export interface ProbeResult {
  /** True when the Host exited 0 before the timeout. */
  ok: boolean
  exitCode: number | null
  /**
   * The first 2 KiB of stdout followed by stderr. Secret File values of length 4 or more are
   * replaced with `***` before this cut, so a value that straddles the cut cannot leak.
   */
  output: string
  /** True when the spawner stopped the Host at the timeout. `ok` is then false. */
  timedOut: boolean
}

/**
 * Runs the Family's probe the way Launch would start the Host: `prepareLaunch`'s environment and
 * arguments (with `probe.args` as the user's arguments), the caller's temp directory as cwd, stdin ignored, and a 60s
 * timeout the spawner enforces. Returns the exit code and the redacted output.
 * Throws a UserError when the Family has no probe; the message says this tool cannot be tried
 * and to start the account with `sideby run` instead.
 */
export async function runProbe(account: Account, deps: ProbeDeps): Promise<ProbeResult> {
  const probe = deps.family.probe
  if (!probe)
    throw new UserError(
      `This tool cannot be tried. Start ${account.ref} with \`sideby run ${account.ref}\` and send one short message instead.`,
      { code: 'no-probe' },
    )
  const prepared =
    deps.launch ??
    (await prepareLaunch({
      account,
      family: deps.family,
      baseEnv: deps.baseEnv,
      accountArgs: deps.accountArgs ?? [],
      userArgs: probe.args,
      command: 'run',
      bus: deps.bus ?? new HookBus(),
      ...(deps.label ? { label: deps.label } : {}),
    }))
  const secrets = account.secretFile
    ? Object.values(await readSecretFile(account.secretFile, deps.baseEnv))
    : []
  const spawned = await deps.spawn({
    bin: prepared.bin,
    // Family defaults, config arguments and `launch.before` changes, as `sideby run` passes them.
    args: prepared.args,
    env: prepared.env,
    cwd: deps.cwd,
    timeoutMs: deps.timeoutMs ?? PROBE_TIMEOUT_MS,
    stdin: 'ignore',
  })
  const output = clip(redactSecrets(spawned.stdout + spawned.stderr, secrets), PROBE_OUTPUT_MAX_BYTES)
  return {
    ok: spawned.exitCode === 0 && !spawned.timedOut,
    exitCode: spawned.exitCode,
    output,
    timedOut: spawned.timedOut,
  }
}

/** Output kept per stream before redaction, in characters. */
const SPAWN_KEEP = 65536

/**
 * The real spawner for {@link ProbeDeps.spawn}. The Host leads its own process group, so the timeout stops it and
 * any child it started; the result comes at once, even while a child still holds the output pipes open.
 */
export function spawnProbe(request: ProbeSpawnRequest): Promise<ProbeSpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(request.bin, [...request.args], {
      cwd: request.cwd,
      env: request.env as NodeJS.ProcessEnv,
      stdio: [request.stdin, 'pipe', 'pipe'],
      detached: true,
    })
    let stdout = '',
      stderr = '',
      timedOut = false,
      done = false
    const finish = (result: ProbeSpawnResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      child.stdout.destroy()
      child.stderr.destroy()
      // It may have exited already while a child of its own kept the pipes open.
      if (child.exitCode !== null || child.signalCode !== null)
        finish({ exitCode: null, stdout, stderr, timedOut })
    }, request.timeoutMs)
    child.stdout.on('data', (d) => {
      if (stdout.length < SPAWN_KEEP) stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      if (stderr.length < SPAWN_KEEP) stderr += d.toString()
    })
    child.on('error', () =>
      finish({
        exitCode: 1,
        stdout: '',
        stderr: 'Could not start the Host; check its installation and run `sideby try` again.',
        timedOut: false,
      }),
    )
    child.on('exit', () => {
      if (timedOut) finish({ exitCode: null, stdout, stderr, timedOut })
    })
    child.on('close', (exitCode) => finish({ exitCode, stdout, stderr, timedOut }))
  })
}

/** Replaces each secret of length 4 or more. Longer values go first so one cannot hide inside another. */
export function redactSecrets(text: string, values: readonly string[]): string {
  const needles = [...new Set(values.filter((v) => v.length >= 4))].sort((a, b) => b.length - a.length)
  let out = text
  for (const needle of needles) out = out.split(needle).join('***')
  return out
}

/** The first `max` bytes, never cutting a UTF-8 code point in half. */
function clip(text: string, max: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= max) return text
  let n = max
  while (n > 0 && (buf[n]! & 0xc0) === 0x80) n--
  return buf.subarray(0, n).toString('utf8')
}
