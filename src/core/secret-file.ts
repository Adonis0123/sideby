import { lstat, readFile } from 'node:fs/promises'
import { UserError } from './errors.ts'

export class SecretFileError extends UserError {}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/

/**
 * Parses the dotenv subset sideby supports: KEY=VALUE, optional `export `, quotes and comments.
 * Nothing is executed or expanded. Errors name the line, never its content.
 */
export function parseSecretFile(text: string, file: string): Record<string, string> {
  const out: Record<string, string> = {}
  const lines = text.split(/\r?\n/)
  lines.forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const m = LINE.exec(raw)
    if (!m) throw new SecretFileError(`${file}:${i + 1}: expected KEY=VALUE`)
    const key = m[1]!
    let value = m[2]!
    const q = value[0]
    if (q === '"' || q === "'") {
      let end = -1
      for (let j = 1; j < value.length; j++) {
        if (q === '"' && value[j] === '\\') j++
        else if (value[j] === q) {
          end = j
          break
        }
      }
      if (end === -1) throw new SecretFileError(`${file}:${i + 1}: unterminated quote`)
      const rest = value.slice(end + 1).trim()
      if (rest && !rest.startsWith('#'))
        throw new SecretFileError(`${file}:${i + 1}: text after closing quote`)
      value = value.slice(1, end)
      if (q === '"') value = value.replace(/\\(n|"|\\)/g, (_, c: string) => (c === 'n' ? '\n' : c))
    } else {
      const hash = value.search(/\s#/)
      if (hash !== -1) value = value.slice(0, hash).trimEnd()
      if (/\$\(|`/.test(value))
        throw new SecretFileError(
          `${file}:${i + 1}: command substitution is not supported; write the value itself`,
        )
    }
    out[key] = value
  })
  return out
}

export type SecretFileState =
  | { kind: 'ok' }
  | { kind: 'missing' }
  | { kind: 'not-file' }
  | { kind: 'mode'; mode: number }

/**
 * The one Secret File rule, used by Launch and by Doctor: the Account's own regular file (never a link)
 * with mode 600. Only the file's type and mode are inspected, never its contents.
 */
export async function inspectSecretFile(file: string): Promise<SecretFileState> {
  let st: Awaited<ReturnType<typeof lstat>>
  try {
    st = await lstat(file)
  } catch {
    return { kind: 'missing' }
  }
  if (!st.isFile()) return { kind: 'not-file' }
  const mode = st.mode & 0o777
  return mode === 0o600 ? { kind: 'ok' } : { kind: 'mode', mode }
}

/** Reads a Secret File after inspectSecretFile accepts it. */
export async function readSecretFile(file: string): Promise<Record<string, string>> {
  const state = await inspectSecretFile(file)
  if (state.kind === 'missing') throw new SecretFileError(`${file} is missing`)
  if (state.kind === 'not-file')
    throw new SecretFileError(`${file} must be a regular file, not a link or directory`)
  if (state.kind === 'mode')
    throw new SecretFileError(
      `${file} has mode ${state.mode.toString(8)}; run \`chmod 600 ${file}\` so only you can read it`,
    )
  return parseSecretFile(await readFile(file, 'utf8'), file)
}

export function secretFileTemplate(vars: readonly string[], familyTitle: string): string {
  const lines = [
    `# ${familyTitle} API account. sideby loads these variables only into this account's process.`,
    '# Uncomment and fill in. Keep this file private (mode 600).',
    ...vars.map((v) => `# ${v}=`),
    '',
  ]
  return lines.join('\n')
}
