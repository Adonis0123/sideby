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

/** One `aliases` value: an Account ref, or a ref plus Host arguments that only `sideby run` adds (ADR-0005). */
const AliasSchema = Type.Union([
  Type.String(),
  Type.Object(
    {
      account: Type.String({ pattern: '^[^:]+:.+$', description: 'The Account ref, `<family>:<name>`.' }),
      args: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Host arguments `sideby run <alias>` adds after the Account `args`, before the user’s.',
        }),
      ),
    },
    { additionalProperties: false },
  ),
])

export type AliasValue = Static<typeof AliasSchema>

/** The Account ref an Alias starts. */
export const aliasAccount = (value: AliasValue): string => (typeof value === 'string' ? value : value.account)

/** The Host arguments an Alias adds to `sideby run`; none for a plain ref. */
export const aliasArgs = (value: AliasValue | undefined): string[] =>
  typeof value === 'object' ? [...(value.args ?? [])] : []

/** `aliases` as alias → Account ref, for lookups that ignore the arguments. */
export function aliasRefs(aliases: Readonly<Record<string, AliasValue>> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(aliases ?? {}).map(([name, v]) => [name, aliasAccount(v)]))
}

const sameAlias = (a: AliasValue, b: AliasValue) =>
  aliasAccount(a) === aliasAccount(b) && JSON.stringify(aliasArgs(a)) === JSON.stringify(aliasArgs(b))

const describeAlias = (v: AliasValue) => {
  const args = aliasArgs(v)
  return args.length ? `${aliasAccount(v)} with ${args.join(' ')}` : aliasAccount(v)
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
      Type.Record(Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_-]*$' }), AliasSchema, {
        description:
          'Short shell function names created by `sideby shell-init`, mapped to an Account ref or to `{ account, args }`.',
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
    accountTitle: Type.Optional(
      Type.Boolean({
        description:
          'Set the terminal title to `[<short command or account>]` when sideby starts an Account, and keep Hosts that allow it (Codex) from replacing it. Off by default.',
      }),
    ),
    resumeRouting: Type.Optional(
      Type.Boolean({
        description:
          'Make `sideby shell-init` also define Host-named functions (`claude`, `codex`, `grok`) that resume a session by id in the Account that holds it. Off by default.',
      }),
    ),
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
 * Re-reads the config file, lets `edit` change its `aliases`, and writes the result: every other key and their
 * order kept (with `$schema`), 2-space JSON with a trailing newline, atomically, keeping the file's mode (0600 for
 * a new file). Refuses, without writing, a file that is not valid JSON or not a valid config, or one that changed
 * while sideby wrote it. `edit` returns null to leave the file alone. `retry` names what to do again after a fix.
 */
async function editConfigAliases(
  file: string,
  retry: string,
  edit: (current: Record<string, AliasValue>) => Record<string, AliasValue> | null,
): Promise<Record<string, AliasValue>> {
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
        `${file} is not valid JSON; nothing was changed. Fix the syntax and ${retry} again`,
      )
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new ConfigError(`${file} is not a JSON object; nothing was changed. Fix it and ${retry} again`)
    if (!Value.Check(ConfigSchema, parsed))
      throw new ConfigError(
        `${file} does not match schemas/config.json; nothing was changed. Run \`sideby list\` to see why`,
      )
    data = parsed as Record<string, unknown>
  }
  const current = (data.aliases ?? {}) as Record<string, AliasValue>
  const aliases = edit(current)
  if (!aliases) return current
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
  return aliases
}

/**
 * Adds `alias → ref` to the config file's `aliases`, as `{ account, args }` when `args` is not empty (see
 * `editConfigAliases` for how the file is written). Refuses an invalid alias, or one that already starts another
 * Account or the same Account with other arguments. Returns the aliases now in the file.
 */
export async function addConfigAlias(
  file: string,
  alias: string,
  ref: string,
  args: readonly string[] = [],
): Promise<{ status: 'added' | 'exists'; aliases: Record<string, AliasValue> }> {
  const problem = aliasProblem(alias)
  if (problem) throw new ConfigError(`alias "${alias}" ${problem} (it becomes a shell function name)`)
  const value: AliasValue = args.length ? { account: ref, args: [...args] } : ref
  let status: 'added' | 'exists' = 'added'
  const aliases = await editConfigAliases(file, 'add the alias', (current) => {
    if (!Object.hasOwn(current, alias)) return { ...current, [alias]: value }
    if (!sameAlias(current[alias]!, value))
      throw new ConfigError(
        `alias "${alias}" already starts ${describeAlias(current[alias]!)}; pick another name, or remove it first with \`sideby alias rm ${alias}\``,
      )
    status = 'exists'
    return null
  })
  return { status, aliases }
}

/** Removes `alias` from the config file's `aliases`; `absent` when it was not there (nothing is written then). */
export async function removeConfigAlias(
  file: string,
  alias: string,
): Promise<{ status: 'removed' | 'absent'; aliases: Record<string, AliasValue> }> {
  let status: 'removed' | 'absent' = 'absent'
  const aliases = await editConfigAliases(file, 'remove the alias', (current) => {
    if (!Object.hasOwn(current, alias)) return null
    status = 'removed'
    const { [alias]: _gone, ...rest } = current
    return rest
  })
  return { status, aliases }
}
