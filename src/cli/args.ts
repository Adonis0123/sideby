export class UsageError extends Error {}

export interface ParsedArgs {
  positionals: string[]
  flags: Map<string, string | true>
  /** Everything after the first `--`, untouched. */
  rest: string[]
}

/**
 * Parses `--flag`, `--flag=value` and `--flag value` (for flags listed in `valued`).
 * Unknown flags are usage errors so typos never silently change behaviour.
 */
export function parseArgs(
  argv: readonly string[],
  known: readonly string[],
  valued: readonly string[] = [],
): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--') return { positionals, flags, rest: argv.slice(i + 1) }
    if (a.startsWith('--') && a.length > 2) {
      const [name, value] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined]
      if (!known.includes(name) && !valued.includes(name)) throw new UsageError(`unknown option --${name}`)
      if (valued.includes(name)) {
        const v = value ?? argv[++i]
        if (v === undefined) throw new UsageError(`--${name} needs a value`)
        flags.set(name, v)
      } else {
        if (value !== undefined) throw new UsageError(`--${name} does not take a value`)
        flags.set(name, true)
      }
      continue
    }
    if (a === '-h') {
      flags.set('help', true)
      continue
    }
    positionals.push(a)
  }
  return { positionals, flags, rest: [] }
}
