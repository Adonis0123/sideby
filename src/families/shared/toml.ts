const TABLE_HEADER = /^\s*\[\[?[^\]\s][^\]]*\]\]?\s*(#.*)?$/

/**
 * `key = "value"` among the top-level keys of a TOML file, i.e. before the first `[table]` header.
 * Only a whole-line header ends the top level, so a multi-line array line such as `  ["a"],` does not.
 */
export function topLevelTomlString(text: string, key: string): string | undefined {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`)
  for (const line of text.split(/\r?\n/)) {
    if (TABLE_HEADER.test(line) && !/^\s*\[\s*["'\d]/.test(line)) return undefined
    const m = pattern.exec(line)
    if (m) return m[1] ?? m[2]
  }
  return undefined
}
