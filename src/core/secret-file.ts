import { readFile } from 'node:fs/promises'
import type { FamilyDef } from '../types.ts'
import { UserError } from './errors.ts'
import { lstatOrNull, realpathOrNull, writeFileAtomic } from './fs-safe.ts'

export class SecretFileError extends UserError {}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/

/** Non-secret locations a Secret File may reference from the environment, such as `$HOME/bin/notify`. */
export const SECRET_FILE_ENV_REFS = [
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
] as const

const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|\$\{/g

/**
 * Parses the dotenv subset sideby supports: KEY=VALUE, optional `export `, quotes and comments.
 * `$NAME` and `${NAME}` in unquoted or double-quoted values expand to a key defined earlier in the
 * same file, else to one of SECRET_FILE_ENV_REFS from `env`; no other variable is read and nothing is
 * executed. Errors name the line, never its content.
 */
export function parseSecretFile(
  text: string,
  file: string,
  env: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const out: Record<string, string> = {}
  const lines = text.split(/\r?\n/)
  const expand = (s: string, line: number) =>
    s.replace(REF, (whole, braced?: string, bare?: string) => {
      const name = braced ?? bare
      if (!name) throw new SecretFileError(`${file}:${line}: unterminated \${`)
      if (Object.hasOwn(out, name)) return out[name]!
      const fromEnv = (SECRET_FILE_ENV_REFS as readonly string[]).includes(name) ? env[name] : undefined
      if (fromEnv !== undefined) return fromEnv
      throw new SecretFileError(
        `${file}:${line}: ${whole} is not defined earlier in this file; from the environment only ${SECRET_FILE_ENV_REFS.join(', ')} are read`,
      )
    })
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
      if (q === '"')
        // Escapes and references in one pass, so an escaped `\$` stays a literal dollar sign.
        value = value.replace(/\\(n|"|\\|\$)|\$[^$\\]*/g, (part, c?: string) =>
          c === undefined ? expand(part, i + 1) : c === 'n' ? '\n' : c,
        )
    } else {
      const hash = value.search(/\s#/)
      if (hash !== -1) value = value.slice(0, hash).trimEnd()
      if (/\$\(|`/.test(value))
        throw new SecretFileError(
          `${file}:${i + 1}: command substitution is not supported; write the value itself`,
        )
      value = expand(value, i + 1)
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
  const st = await lstatOrNull(file)
  if (!st) return { kind: 'missing' }
  if (!st.isFile()) return { kind: 'not-file' }
  const mode = st.mode & 0o777
  return mode === 0o600 ? { kind: 'ok' } : { kind: 'mode', mode }
}

/** Reads a Secret File after inspectSecretFile accepts it. */
export async function readSecretFile(
  file: string,
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<Record<string, string>> {
  const state = await inspectSecretFile(file)
  if (state.kind === 'missing') throw new SecretFileError(`${file} is missing`)
  if (state.kind === 'not-file')
    throw new SecretFileError(`${file} must be a regular file, not a link or directory`)
  if (state.kind === 'mode')
    throw new SecretFileError(
      `${file} has mode ${state.mode.toString(8)}; run \`chmod 600 ${file}\` so only you can read it`,
    )
  return parseSecretFile(await readFile(file, 'utf8'), file, env)
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

/** Variable names `sideby key` accepts, such as `ANTHROPIC_AUTH_TOKEN`. */
export const SECRET_VAR_NAME = /^[A-Z][A-Z0-9_]*$/

const KEY_VAR = /(?:_KEY|_TOKEN)$/
const ASSIGN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/

export interface SetSecretResult {
  /** Path whose bytes were written. When `file` is a symlink, this is its real target. */
  path: string
  /** True when `file` was a symlink. The link itself is unchanged. */
  viaLink: boolean
  name: string
  /** `replaced` keeps the assignment's line; `appended` adds one at the end. */
  action: 'replaced' | 'appended'
}

/**
 * The Secret File variable `sideby key` writes when the user does not pass `--var`.
 * Uses `family.secretVar` when the Family sets one, otherwise the first `apiVars` entry
 * that ends in `_KEY` or `_TOKEN`. Throws when the Family has neither, and says to pass `--var`.
 */
export function secretVarFor(family: Pick<FamilyDef, 'title' | 'apiVars' | 'secretVar'>): string {
  const name = family.secretVar ?? family.apiVars.find((v) => SECRET_VAR_NAME.test(v) && KEY_VAR.test(v))
  if (!name || !SECRET_VAR_NAME.test(name))
    throw new SecretFileError(
      `${family.title} has no default key variable. Run \`sideby key <account> --var <NAME>\` with the variable that tool's documentation names.`,
    )
  return name
}

/**
 * Writes one assignment into a Secret File. The line that assigns `name` is replaced and stays
 * where it was; every other line is kept byte for byte. When `name` is absent, a line is appended.
 * The write is atomic and the file ends at mode 600. A symlink is left in place and the bytes go
 * to its real target, which `path` reports. `name` must match {@link SECRET_VAR_NAME}. A value
 * that contains a newline is rejected. The value is never included in an error or in the result.
 */
export async function setSecret(file: string, name: string, value: string): Promise<SetSecretResult> {
  if (!SECRET_VAR_NAME.test(name))
    throw new SecretFileError(
      `variable name must match [A-Z][A-Z0-9_]* (for example ANTHROPIC_AUTH_TOKEN). Run \`sideby key <account> --var <NAME>\`.`,
    )
  if (value.includes('\n') || value.includes('\r'))
    throw new SecretFileError(
      `${name} must be a single line. Run \`sideby key <account>\` and enter one line, or fill the key in the Panel.`,
    )
  const formatted = `${name}=${formatSecretValue(value)}`
  const located = await locateSecretFile(file)
  let previous = ''
  if (located.existed) {
    try {
      previous = await readFile(located.path, 'utf8')
    } catch (err) {
      throw writeFailed(located.path, err)
    }
  }
  const next = assignLine(previous, name, formatted)
  try {
    await writeFileAtomic(located.path, next.text, 0o600)
  } catch (err) {
    throw writeFailed(located.path, err)
  }
  return { path: located.path, viaLink: located.viaLink, name, action: next.action }
}

/** Where the bytes go. A symlink is not followed by the writer; the caller passes the real target. */
async function locateSecretFile(file: string): Promise<{ path: string; viaLink: boolean; existed: boolean }> {
  const st = await lstatOrNull(file)
  if (!st) return { path: file, viaLink: false, existed: false }
  if (st.isSymbolicLink()) {
    const real = await realpathOrNull(file)
    if (!real)
      throw new SecretFileError(
        `${file} is a broken link. Point it at a proxy.env file, or replace the link with a file, then run \`sideby key\` again.`,
      )
    const target = await lstatOrNull(real)
    if (!target?.isFile())
      throw new SecretFileError(
        `${file} points at ${real}, which is not a file. Point the link at a proxy.env file, then run \`sideby key\` again.`,
      )
    return { path: real, viaLink: true, existed: true }
  }
  if (st.isDirectory())
    throw new SecretFileError(
      `${file} is a directory. \`sideby key\` writes the proxy.env file; move that directory aside, then run \`sideby key\` again.`,
    )
  if (!st.isFile())
    throw new SecretFileError(
      `${file} is not a regular file. Replace it with a proxy.env file, then run \`sideby key\` again.`,
    )
  return { path: file, viaLink: false, existed: true }
}

function assignLine(
  text: string,
  name: string,
  formatted: string,
): { text: string; action: 'replaced' | 'appended' } {
  const lines = splitKeepEnds(text)
  let replaced = false
  const rebuilt = lines
    .map((line) => {
      if (assignmentName(line.body) !== name) return line.body + line.eol
      replaced = true
      return formatted + line.eol
    })
    .join('')
  if (replaced) return { text: rebuilt, action: 'replaced' }
  const sep = text.length > 0 && !text.endsWith('\n') ? '\n' : ''
  return { text: `${text}${sep}${formatted}\n`, action: 'appended' }
}

function assignmentName(body: string): string | null {
  const trimmed = body.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  return ASSIGN.exec(body)?.[1] ?? null
}

/** A value `parseSecretFile` reads back unchanged. Single quotes stay literal; nothing is executed. */
function formatSecretValue(value: string): string {
  if (/^[A-Za-z0-9_./:@%+-]*$/.test(value)) return value
  if (!value.includes("'")) return `'${value}'`
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$')
  return `"${escaped}"`
}

function splitKeepEnds(text: string): { body: string; eol: string }[] {
  if (text === '') return []
  const out: { body: string; eol: string }[] = []
  const re = /\r\n|\n/g
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ body: text.slice(last, m.index), eol: m[0] })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ body: text.slice(last), eol: '' })
  return out
}

function writeFailed(file: string, err: unknown): SecretFileError {
  if (err instanceof SecretFileError) return err
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'ENOENT')
    return new SecretFileError(
      `${file} cannot be written because a parent directory is missing. Create the account with \`sideby new <family> <name> --api\`, then run \`sideby key\` again.`,
    )
  if (code === 'EACCES' || code === 'EPERM')
    return new SecretFileError(
      `${file} cannot be written (permission denied). Make the account directory yours, then run \`sideby key\` again.`,
    )
  return new SecretFileError(
    `${file} could not be written. Check that the account directory is a real folder you can write to, then run \`sideby key\` again.`,
  )
}
