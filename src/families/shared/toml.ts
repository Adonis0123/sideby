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

/**
 * A string or boolean `key` in `[table]`, or as `table.key = …` at the top level; `table` '' means the top level.
 * Enough for the few policy keys sideby reads (Grok's sandbox profile); not a TOML parser.
 */
export function tomlValue(text: string, table: string, key: string): string | boolean | undefined {
  const value = /^\s*(?:"([^"]*)"|'([^']*)'|(true|false))\s*(#.*)?$/
  let current = ''
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[\s*([A-Za-z0-9_.-]+)\s*\]\s*(#.*)?$/.exec(line)
    if (header) {
      current = header[1]!
      continue
    }
    if (TABLE_HEADER.test(line)) {
      current = '\0'
      continue
    }
    const kv = /^\s*([A-Za-z0-9_.-]+)\s*=(.*)$/.exec(line)
    if (!kv) continue
    const full = current ? `${current}.${kv[1]}` : kv[1]!
    if (full !== (table ? `${table}.${key}` : key)) continue
    const m = value.exec(kv[2]!)
    if (!m) return undefined
    return m[3] ? m[3] === 'true' : (m[1] ?? m[2])
  }
  return undefined
}
