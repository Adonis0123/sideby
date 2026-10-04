import { readFile } from 'node:fs/promises'
import { type Static, Type } from 'typebox'
import { Value } from 'typebox/value'
import { UserError } from './errors.ts'
import { parseJsonSafely } from './fs-safe.ts'
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
