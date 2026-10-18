// How an AI Task starts Claude Code (spec §3.28 "权限检查", ADR-0031), checked against the permission modes page of
// the Claude Code docs on 2026-10-18 (Claude Code 2.1.301).

const BYPASS_FLAGS = ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions']
const MODE = '--permission-mode'

const isBypass = (mode: string) => mode.toLowerCase() === 'bypasspermissions'

/**
 * `args` without any argument that skips Claude Code's permission checks: the two bypass flags and a
 * `--permission-mode bypassPermissions` (either form). Unless the arguments still pick another permission mode,
 * `--permission-mode auto` comes first: no routine prompts, while auto mode's classifier blocks risky actions. It also
 * outranks a settings file's `permissions.defaultMode`, and a session where auto mode is unavailable starts in Manual.
 * Text after `--` is the Host's own and stays as it is.
 */
export function claudeAiTaskArgs(args: readonly string[]): string[] {
  const end = args.indexOf('--')
  const options = end === -1 ? args : args.slice(0, end)
  const out: string[] = []
  let picked = false
  for (let i = 0; i < options.length; i++) {
    const arg = options[i]!
    if (BYPASS_FLAGS.includes(arg)) continue
    if (arg.startsWith(`${MODE}=`)) {
      if (isBypass(arg.slice(MODE.length + 1))) continue
      picked = true
    } else if (arg === MODE && i + 1 < options.length) {
      const mode = options[++i]!
      if (isBypass(mode)) continue
      picked = true
      out.push(arg, mode)
      continue
    }
    out.push(arg)
  }
  return [...(picked ? [] : [MODE, 'auto']), ...out, ...(end === -1 ? [] : args.slice(end))]
}
