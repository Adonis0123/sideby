// Reading and writing a model or effort choice as Host arguments (spec §3.19): the value of `--name v`, `--name=v`
// or `-x v`, wherever it is. Built-in Families use it for `modelChoice`.

/** Takes every occurrence of the flags in `names` out of `args`; the last value wins. */
export function takeFlag(
  args: readonly string[],
  names: readonly string[],
): { value?: string; rest: string[] } {
  const rest: string[] = []
  let value: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    // Past `--` everything is the Host's prompt text, not an option.
    if (a === '--') {
      rest.push(...args.slice(i))
      break
    }
    const eq = names.find((n) => n.startsWith('--') && a.startsWith(`${n}=`))
    if (eq) {
      value = a.slice(eq.length + 1)
      continue
    }
    if (names.includes(a) && i + 1 < args.length) {
      value = args[++i]
      continue
    }
    rest.push(a)
  }
  return value === undefined ? { rest } : { value, rest }
}

/** A model name sideby passes on: letters, digits and `._:/[]-` (for example `claude-opus-5-5[1m]`). */
export const MODEL_NAME = /^[A-Za-z0-9._:/[\]-]{1,100}$/
