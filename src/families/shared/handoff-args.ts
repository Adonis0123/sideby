// Host arguments for the next session of a Handoff (spec §3.17 "启动参数"): keep the user's options, drop the ones
// that resume or continue a session, and drop the old first prompt. Each Family lists which of its options take a
// value, from its `--help`, so a value is never mistaken for the prompt.

export interface ArgRules {
  /** Options whose value is the next argument. */
  valued: readonly string[]
  /** Options taking one or more values, up to the next option (Claude's `--add-dir <directories...>`). */
  variadic?: readonly string[]
  /** Options whose value may be left out: the next argument is theirs unless it starts with `-`. */
  optional?: readonly string[]
  /** Options left out of the next session, with their values. */
  drop: readonly string[]
}

/** The options to carry over; every positional (a subcommand, a session id, the old prompt) and `--` onwards go. */
export function carryArgs(args: readonly string[], rules: ArgRules): string[] {
  const kept: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--') break
    if (!a.startsWith('-') || a === '-') continue
    const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a
    const inline = name !== a
    const drop = rules.drop.includes(name)
    const take: string[] = [a]
    if (!inline) {
      if (rules.valued.includes(name) && i + 1 < args.length) take.push(args[++i]!)
      else if (rules.variadic?.includes(name))
        while (i + 1 < args.length && !args[i + 1]!.startsWith('-')) take.push(args[++i]!)
      else if (rules.optional?.includes(name) && i + 1 < args.length && !args[i + 1]!.startsWith('-'))
        take.push(args[++i]!)
    }
    if (!drop) kept.push(...take)
  }
  return kept
}

/** True when `args` (before `--`) contain any of `names`, alone or as `name=value`. */
export function hasOption(args: readonly string[], names: readonly string[]): boolean {
  for (const a of args) {
    if (a === '--') return false
    const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a
    if (names.includes(name)) return true
  }
  return false
}

/** The value of the first of `names` in `args` (`--x v` or `--x=v`), before `--`. */
export function optionValue(args: readonly string[], names: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--') return undefined
    const eq = a.indexOf('=')
    if (eq > 0 && names.includes(a.slice(0, eq))) return a.slice(eq + 1)
    if (names.includes(a)) return args[i + 1]
  }
  return undefined
}

/** First prompt after `--`, so an option that takes several values cannot swallow it. */
export const promptAfterDashes = (prompt: string): string[] => ['--', prompt]
