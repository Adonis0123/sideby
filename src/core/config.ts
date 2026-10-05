import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { type Static, Type } from 'typebox'
import { Value } from 'typebox/value'
import { UserError } from './errors.ts'
import { lstatOrNull, parseJsonSafely, realpathOrNull, sha256, writeIfUnchanged } from './fs-safe.ts'
import { SHARE_MODES } from './share-mode-names.ts'

const SharedItemSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, pattern: '^(?!/)(?!.*(^|/)\\.\\.(/|$)).+$' }),
    // json-key needs a key and a main-side path, which the config does not offer.
    mode: Type.Union(SHARE_MODES.filter((m) => m !== 'json-key').map((m) => Type.Literal(m))),
    noSymlink: Type.Optional(Type.Boolean()),
    credential: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)

export const ALIAS_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/

/** Shell keywords and builtins an alias must not shadow (`command() { command sideby … }` would recurse). */
export const RESERVED_ALIASES = new Set(
  'alias bg bind break builtin case cd command compgen complete continue declare dirs disown do done echo elif else enable esac eval exec exit export false fc fg fi for function getopts hash help history if in jobs kill let local logout popd printf pushd pwd read readonly return select set shift shopt source suspend test then time times trap true type typeset ulimit umask unalias unset until wait while sideby'.split(
    ' ',
  ),
)

export function aliasProblem(alias: string): string | null {
  if (!ALIAS_NAME.test(alias)) return `must match ${ALIAS_NAME.source}`
  if (RESERVED_ALIASES.has(alias)) return 'is a shell keyword, builtin or sideby itself'
  return null
}

export const ConfigSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    accounts: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Object({ args: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false }),
        { description: 'Per-Account settings keyed by `<family>:<name>`.' },
      ),
    ),
    aliases: Type.Optional(
      Type.Record(Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_-]*$' }), Type.String(), {
        description: 'Short shell function names created by `sideby shell-init`, mapped to Account refs.',
      }),
    ),
    ignore: Type.Optional(Type.Array(Type.String(), { description: 'Account refs that are not Accounts.' })),
    pluginDirs: Type.Optional(
      Type.Array(Type.String(), { description: 'Absolute or `~/` paths of Plugin directories.' }),
    ),
    plugins: Type.Optional(
      Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown()), {
        description: 'Per-Plugin settings; `enabled: false` turns a Plugin off.',
      }),
    ),
    extraSharedItems: Type.Optional(Type.Record(Type.String(), Type.Array(SharedItemSchema))),
    shellInitFile: Type.Optional(
      Type.Object(
        {
          zsh: Type.Optional(Type.String({ minLength: 1 })),
          bash: Type.Optional(Type.String({ minLength: 1 })),
        },
        {
          additionalProperties: false,
          description:
            'Absolute or `~/` paths of files sideby rewrites with the `sideby shell-init <shell>` output whenever it adds an Account or an alias; source the file from your shell rc.',
        },
      ),
    ),
  },
  { additionalProperties: false, title: 'sideby config' },
)

export type Config = Static<typeof ConfigSchema>

export class ConfigError extends UserError {}

export async function loadConfig(file: string): Promise<Config> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new ConfigError(`cannot read ${file}: ${(err as Error).message}`)
  }
  let data: unknown
  try {
    data = parseJsonSafely(raw, file)
  } catch {
    throw new ConfigError(`${file} is not valid JSON; fix the syntax or delete the file`)
  }
  if (!Value.Check(ConfigSchema, data)) {
    const first = [...Value.Errors(ConfigSchema, data)][0]
    const where = first?.instancePath || '/'
    throw new ConfigError(`${file}: ${where} ${first?.message ?? 'is invalid'}; see schemas/config.json`)
  }
  // TypeBox does not enforce key patterns on records; alias names become shell function names.
  for (const alias of Object.keys(data.aliases ?? {})) {
    const problem = aliasProblem(alias)
    if (problem)
      throw new ConfigError(`${file}: alias "${alias}" ${problem} (it becomes a shell function name)`)
  }
  return data
}

/** Where the config file is read and written: the target of a link (a dotfiles manager may link it). */
async function configTarget(file: string): Promise<string> {
  return (await lstatOrNull(file))?.isSymbolicLink() ? ((await realpathOrNull(file)) ?? file) : file
}

/**
 * Adds `alias → ref` to the config file's `aliases`. Re-reads the file, keeps every other key, their order and
 * `$schema`, and writes 2-space JSON with a trailing newline atomically, keeping the file's mode (0600 for a new
 * file). Refuses, without writing, a file that is not valid JSON or not a valid config, an invalid alias, or one
 * that already points elsewhere. Returns the aliases now in the file.
 */
export async function addConfigAlias(
  file: string,
  alias: string,
  ref: string,
): Promise<{ status: 'added' | 'exists'; aliases: Record<string, string> }> {
  const problem = aliasProblem(alias)
  if (problem) throw new ConfigError(`alias "${alias}" ${problem} (it becomes a shell function name)`)
  const target = await configTarget(file)
  let raw: string | null = null
  try {
    raw = await readFile(target, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new ConfigError(`cannot read ${file}: ${(err as Error).message}`)
  }
  let data: Record<string, unknown> = {}
  if (raw !== null) {
    let parsed: unknown
    try {
      parsed = parseJsonSafely(raw, file)
    } catch {
      throw new ConfigError(
        `${file} is not valid JSON; nothing was changed. Fix the syntax and add the alias again`,
      )
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new ConfigError(
        `${file} is not a JSON object; nothing was changed. Fix it and add the alias again`,
      )
    if (!Value.Check(ConfigSchema, parsed))
      throw new ConfigError(
        `${file} does not match schemas/config.json; nothing was changed. Run \`sideby list\` to see why`,
      )
    data = parsed as Record<string, unknown>
  }
  const current = (data.aliases ?? {}) as Record<string, string>
  if (Object.hasOwn(current, alias)) {
    if (current[alias] === ref) return { status: 'exists', aliases: current }
    throw new ConfigError(`alias "${alias}" already starts ${current[alias]}; pick another name`)
  }
  const aliases = { ...current, [alias]: ref }
  // A new file gets the schema link editors use for completion; an existing file keeps its keys in order.
  const next =
    raw === null ? { $schema: 'https://unpkg.com/sideby/schemas/config.json', aliases } : { ...data, aliases }
  const st = raw === null ? null : await lstatOrNull(target)
  if (raw === null) await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const written = await writeIfUnchanged(
    target,
    raw === null ? null : sha256(raw),
    `${JSON.stringify(next, null, 2)}\n`,
    st ? st.mode & 0o777 : 0o600,
  )
  if (!written)
    throw new ConfigError(`${file} changed while sideby was writing it; nothing was changed. Try again`)
  return { status: 'added', aliases }
}
