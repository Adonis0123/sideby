import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { type Static, Type } from 'typebox'
import { Value } from 'typebox/value'
import { RENAMED_THEMES } from '../panel/themes.ts'
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

const Percent = (description: string) =>
  Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description }))

/** Auto Handoff (spec §3.17, ADR-0010). Every key is optional; `handoffSettings` fills the defaults. */
const HandoffSchema = Type.Object(
  {
    auto: Type.Optional(
      Type.Boolean({
        description:
          'Hand a running session to the next account when its Quota runs low: within the family only with `sameFamily`, to other families only with `otherFamilies`, to API accounts only with `api`. Off by default.',
      }),
    ),
    sameFamily: Type.Optional(
      Type.Boolean({
        description:
          'Also hand off to an account of the same family (cc001 → cc002). The kind vendors are most likely to act on. Off by default.',
      }),
    ),
    otherFamilies: Type.Optional(
      Type.Boolean({
        description:
          'When no account of the family can take over, let accounts of other families take over, family by family in `familyOrder`. Off by default.',
      }),
    ),
    familyOrder: Type.Optional(
      Type.Array(Type.String(), {
        description:
          'Families to try with `otherFamilies`, first to last (for example ["codex", "grok"]); families left out come after, in the usual order.',
      }),
    ),
    api: Type.Optional(
      Type.Boolean({
        description:
          'Let API accounts take over as the last resort, when no subscription account can. They are billed per use and sideby does not cap spending. Off by default (ADR-0046).',
      }),
    ),
    prepareAt: Percent('Quota Pressure at which the session starts keeping a Handoff Brief (default 80).'),
    threshold: Percent(
      'Quota Pressure at which the Handoff begins (default 95). With `adaptive`, a window uses it until the run has measured a turn of it.',
    ),
    adaptive: Type.Optional(
      Type.Boolean({
        description:
          'Hand over by each window’s own pace: when it has less room left than 1.5 times its largest recent turn, between `prepareAt` and 99 (default true; ADR-0032). False uses `threshold` for every window.',
      }),
    ),
    waitIfResetWithinMinutes: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          'Stay and wait when the full window resets within this many minutes (default 30; 0 never waits).',
      }),
    ),
    countdownSeconds: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: 'Countdown before the next account starts; Enter cancels (default 10; 0 skips it).',
      }),
    ),
    crossOrganization: Type.Optional(
      Type.Array(Type.String(), {
        description:
          'Accounts (ref or short command) that may take over from an account of another organization.',
      }),
    ),
    families: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Object(
          {
            policy: Type.Optional(
              Type.Union([Type.Literal('pressure'), Type.Literal('order')], {
                description:
                  '`pressure` picks the account with the most Quota left; `order` follows `order`.',
              }),
            ),
            order: Type.Optional(
              Type.Array(Type.String(), { description: 'Accounts (ref or short command) to try, in order.' }),
            ),
          },
          { additionalProperties: false },
        ),
        {
          description:
            'Handoff Order per family the session starts in: `pressure` (default) or an `order` list.',
        },
      ),
    ),
  },
  { additionalProperties: false },
)

/**
 * The `handoff` settings with every default filled in (`handoffSettings`). One schema for the type, the `--json`
 * outputs that carry it and the Panel page.
 */
export const HandoffSettingsSchema = Type.Object({
  auto: Type.Boolean(),
  sameFamily: Type.Boolean(),
  otherFamilies: Type.Boolean({
    description: 'Other AIs may take over when this one has no account that can (ADR-0046).',
  }),
  familyOrder: Type.Array(Type.String(), { description: 'The order other AIs are tried in.' }),
  api: Type.Boolean({ description: 'API accounts may take over, last; billed per use (ADR-0046).' }),
  prepareAt: Type.Number(),
  threshold: Type.Number(),
  adaptive: Type.Boolean(),
  waitIfResetWithinMinutes: Type.Number(),
  countdownSeconds: Type.Number(),
  crossOrganization: Type.Array(Type.String()),
  families: Type.Record(
    Type.String(),
    Type.Object({
      policy: Type.Union([Type.Literal('pressure'), Type.Literal('order')]),
      order: Type.Array(Type.String()),
    }),
  ),
})

export type HandoffSettings = Static<typeof HandoffSettingsSchema>

const CLOCK = '^([01][0-9]|2[0-3]):[0-5][0-9]$'
/** One Slot of Unattended Mode's Schedule (spec §3.37). Checked by hand where `unattended-hook` reads it. */
export const UnattendedSlotSchema = Type.Object(
  {
    name: Type.Optional(
      Type.String({ minLength: 1, maxLength: 60, description: 'What the Slot is called.' }),
    ),
    days: Type.Array(
      Type.Union([
        Type.Literal('mon'),
        Type.Literal('tue'),
        Type.Literal('wed'),
        Type.Literal('thu'),
        Type.Literal('fri'),
        Type.Literal('sat'),
        Type.Literal('sun'),
      ]),
      { minItems: 1, uniqueItems: true, description: 'The days it starts on.' },
    ),
    start: Type.String({ pattern: CLOCK, description: 'When it starts, `HH:MM` in 24-hour local time.' }),
    end: Type.String({
      pattern: CLOCK,
      description:
        'When it ends, `HH:MM`. An end before the start is the next day; an end equal to the start lasts the whole day.',
    }),
  },
  { additionalProperties: false },
)

export const ConfigSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    panel: Type.Optional(
      Type.Object(
        {
          theme: Type.Optional(
            Type.String({
              enum: ['system', 'light', 'dark'],
              description: 'Panel colours: follow the system (default), always light, or always dark.',
            }),
          ),
          language: Type.Optional(
            Type.String({
              enum: ['auto', 'en', 'zh'],
              description: "Panel language: the browser's (default), English, or Chinese.",
            }),
          ),
          colorTheme: Type.Optional(
            Type.String({
              pattern: '^[a-z0-9][a-z0-9-]{0,39}$',
              description:
                'Panel Theme: a Built-in Theme (teal, the default, leaf, celeste, claude or codex; the old sky reads as celeste) or a Theme File in <config>/themes (spec §3.34).',
            }),
          ),
        },
        { additionalProperties: false, description: 'How the Panel looks (spec §3.29).' },
      ),
    ),
    menubar: Type.Optional(
      Type.Object(
        {
          hotkey: Type.Optional(
            Type.String({
              pattern: '^(off|((ctrl|opt|cmd|shift)\\+)+[a-z0-9])$',
              description:
                'The shortcut that opens the menu bar item from anywhere, such as `opt+x` (default), or `off`.',
            }),
          ),
        },
        { additionalProperties: false, description: 'The Menu Bar Item on macOS (spec §3.31).' },
      ),
    ),
    terminal: Type.Optional(
      Type.Object(
        {
          preferred: Type.Optional(
            Type.String({
              enum: [
                'terminal',
                'iterm2',
                'ghostty',
                'orca',
                'wezterm',
                'kitty',
                'alacritty',
                'windows-terminal',
                'custom',
              ],
              description: 'The terminal sideby opens for AI Tasks; without it sideby picks the one you use.',
            }),
          ),
          custom: Type.Optional(
            Type.String({
              description:
                'Your own launch command for `preferred: custom`, with `{cwd}` and `{cmd}` placeholders.',
            }),
          ),
        },
        { additionalProperties: false, description: 'The terminal AI Tasks open in (spec §3.28).' },
      ),
    ),
    ask: Type.Optional(
      Type.Object(
        {
          account: Type.Optional(
            Type.String({
              description:
                'The account AI Tasks start (`<family>:<name>` or a short command); sideby picks one without it.',
            }),
          ),
        },
        { additionalProperties: false, description: 'AI Tasks (spec §3.28).' },
      ),
    ),
    accounts: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Object(
          {
            args: Type.Optional(
              Type.Array(Type.String(), {
                description:
                  'Host arguments sideby starts the account with; `sideby config` and `sideby model` set only the model and effort ones.',
              }),
            ),
          },
          { additionalProperties: false },
        ),
        { description: 'Per-Account settings keyed by `<family>:<name>`.' },
      ),
    ),
    aliases: Type.Optional(
      Type.Record(Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_-]*$' }), AliasSchema, {
        description:
          'Short shell function names created by `sideby shell-init`, mapped to an Account ref or to `{ account, args }`.',
      }),
    ),
    pickCommands: Type.Optional(
      Type.Record(Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_-]*$' }), Type.String({ minLength: 1 }), {
        description:
          'Pick Commands: short shell function names created by `sideby shell-init`, mapped to a Family. Each run starts the Account of that Family with the most Quota left, or the Main Account when none has Quota data (ADR-0035). They share one namespace with `aliases`.',
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
    extraSharedItems: Type.Optional(
      Type.Record(Type.String(), Type.Array(SharedItemSchema), {
        description:
          'Per family, more items each account shares with the main account: `{ path, mode }` with a relative path.',
      }),
    ),
    accountTitle: Type.Optional(
      Type.Boolean({
        description:
          'Set the terminal title to `[<short command or account>]` when sideby starts an Account, and keep Hosts that allow it (Codex) from replacing it. Off by default.',
      }),
    ),
    claudeMod: Type.Optional(
      Type.Boolean({
        description:
          "Load sideby's Claude Code mod (`--plugin-dir`, Claude Code 2.1.287 or later) when sideby starts a Claude Code account: a band with the Session Label, a toast when a Message arrives and a `/sessions` pane. On by default; false turns it off.",
      }),
    ),
    resumeRouting: Type.Optional(
      Type.Boolean({
        description:
          'Make `sideby shell-init` also define Host-named functions (`claude`, `codex`, `grok`) that resume a session by id in the Account that holds it. Off by default.',
      }),
    ),
    handoff: Type.Optional(HandoffSchema),
    update: Type.Optional(
      Type.Object(
        {
          check: Type.Optional(
            Type.Boolean({
              description:
                'Ask the npm registry once a day whether a newer sideby exists, and say so after a command and in the Panel. On by default; `NO_UPDATE_NOTIFIER` or `SIDEBY_NO_UPDATE_NOTIFIER` also turn it off.',
            }),
          ),
          auto: Type.Optional(
            Type.Boolean({
              description:
                'Install a newer version by itself after a check, when no `sideby run` is running and the version is not a major one. Off by default.',
            }),
          ),
        },
        { additionalProperties: false, description: 'Update Check and Auto Update (ADR-0021).' },
      ),
    ),
    history: Type.Optional(
      Type.Object(
        {
          index: Type.Optional(
            Type.Boolean({
              description:
                "Keep a local History Index of every Session's title, Project, typed prompts and model replies (never tool output) in sideby's state folder, so Session History opens and searches at once. On by default; false stops it and deletes the index.",
            }),
          ),
        },
        { additionalProperties: false, description: 'Session History (spec §3.33, ADR-0042).' },
      ),
    ),
    network: Type.Optional(
      Type.Object(
        {
          guard: Type.Optional(
            Type.Boolean({
              description:
                "Network Guard: before a Launch and before each prompt and tool call in a session sideby starts, check the country Claude Code's and Codex's requests leave from, and stop when it is not in `allow` or cannot be told. Asks the vendor's own `/cdn-cgi/trace` through the Host's proxy settings, with no credential. Off by default.",
            }),
          ),
          allow: Type.Optional(
            Type.Array(Type.String({ pattern: '^[A-Z]{2}$' }), {
              uniqueItems: true,
              description:
                'Countries (ISO 3166-1 alpha-2, such as `US` or `JP`) a Host may send requests from. Network Guard cannot be turned on while it is empty.',
            }),
          ),
        },
        { additionalProperties: false, description: 'Network Guard (spec §3.35, ADR-0053).' },
      ),
    ),
    unattended: Type.Optional(
      Type.Object(
        {
          schedule: Type.Optional(
            Type.Array(UnattendedSlotSchema, {
              description:
                "Slots that turn Unattended Mode on and off by themselves, in this computer's time zone. Empty by default.",
            }),
          ),
        },
        {
          additionalProperties: false,
          description:
            'Unattended Mode (spec §3.37, ADR-0058): while it is on, sessions sideby starts never stop to wait for a person. Present once the feature is used; from then on sideby adds its hook to every Claude and Codex session it starts, so turning it on later covers sessions already running. `sideby config unset unattended` stops adding it.',
        },
      ),
    ),
    browser: Type.Optional(
      Type.Object(
        {
          signIns: Type.Optional(
            Type.Boolean({
              description:
                "Look in Google Chrome's local data for which browser user signed in to each Account's website (key names only, never cookies or passwords; nothing leaves this computer). Off by default.",
            }),
          ),
          choices: Type.Optional(
            Type.Record(
              Type.String({ pattern: '^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$' }),
              Type.String({ pattern: '^[\\w .-]{1,64}$' }),
              {
                description:
                  'The Chrome browser user (its folder, such as `Profile 7`) the user chose for an Account, by ref. It replaces what sideby found for that Account; set with `sideby browser set` or the Panel.',
              },
            ),
          ),
        },
        { additionalProperties: false, description: 'Browser Sign-ins (spec §3.24, ADR-0023).' },
      ),
    ),
    display: Type.Optional(
      Type.Object(
        {
          families: Type.Optional(
            Type.Array(Type.String({ minLength: 1 }), {
              uniqueItems: true,
              description:
                'Family ids in the order the Panel and `sideby list` show them; families not listed follow in their usual order.',
            }),
          ),
          accounts: Type.Optional(
            Type.Record(Type.String(), Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }), {
              description:
                'Per family, account names (not refs or short commands) in the order they are shown; accounts not listed follow, main first, then by name.',
            }),
          ),
          pinned: Type.Optional(
            Type.Record(Type.String(), Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }), {
              description:
                'Per family, the names of the accounts pinned to the top of their group, in the order they are shown; they lead the group in every sort. Resetting the order keeps them.',
            }),
          ),
          hiddenFamilies: Type.Optional(
            Type.Array(Type.String({ minLength: 1 }), {
              uniqueItems: true,
              description:
                'Family ids hidden from the Panel, the menu bar and `sideby list` (spec §3.25). Display only: they can still be started and picked by a Handoff.',
            }),
          ),
          hidden: Type.Optional(
            Type.Record(Type.String(), Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }), {
              description:
                'Per family, the names of the accounts hidden from the Panel, the menu bar and `sideby list`. Display only: they can still be started and picked by a Handoff.',
            }),
          ),
        },
        {
          additionalProperties: false,
          description:
            'Display Order (spec §3.25): the order you gave families and accounts in the Panel, the accounts you pinned, and what you hid. Display only: it never changes which account a Handoff picks.',
        },
      ),
    ),
    quota: Type.Optional(
      Type.Object(
        {
          check: Type.Optional(
            Type.Record(Type.String(), Type.Boolean(), {
              description:
                'Per family, whether sideby may ask for Quota in a way that costs a request (Grok: its own CLI asks xAI, at most every 15 minutes per account). On by default; `false` turns it off. Off in CI.',
            }),
          ),
        },
        { additionalProperties: false, description: 'Quota that sideby asks for (spec §3.26, ADR-0025).' },
      ),
    ),
    shellInitFile: Type.Optional(
      Type.Object(
        {
          zsh: Type.Optional(Type.String({ minLength: 1, description: 'The file for zsh.' })),
          bash: Type.Optional(Type.String({ minLength: 1, description: 'The file for bash.' })),
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

/** The `handoff` settings with every default filled in. */
export function handoffSettings(config: Config): HandoffSettings {
  const h = config.handoff ?? {}
  return {
    auto: h.auto ?? false,
    sameFamily: h.sameFamily ?? false,
    otherFamilies: h.otherFamilies ?? false,
    familyOrder: [...(h.familyOrder ?? [])],
    api: h.api ?? false,
    prepareAt: h.prepareAt ?? 80,
    threshold: h.threshold ?? 95,
    adaptive: h.adaptive ?? true,
    waitIfResetWithinMinutes: h.waitIfResetWithinMinutes ?? 30,
    countdownSeconds: h.countdownSeconds ?? 10,
    crossOrganization: [...(h.crossOrganization ?? [])],
    families: Object.fromEntries(
      Object.entries(h.families ?? {}).map(([f, v]) => [
        f,
        { policy: v.policy ?? 'pressure', order: [...(v.order ?? [])] },
      ]),
    ),
  }
}

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
  const handoff = handoffSettings(data)
  if (handoff.prepareAt >= handoff.threshold)
    throw new ConfigError(
      `${file}: handoff.prepareAt (${handoff.prepareAt}) must be lower than handoff.threshold (${handoff.threshold}); lower prepareAt or raise threshold`,
    )
  // TypeBox does not enforce key patterns on records; alias names become shell function names.
  for (const alias of Object.keys(data.aliases ?? {})) {
    const problem = aliasProblem(alias)
    if (problem)
      throw new ConfigError(`${file}: alias "${alias}" ${problem} (it becomes a shell function name)`)
  }
  const shortProblem = shortCommandProblem(data)
  if (shortProblem) throw new ConfigError(`${file}: ${shortProblem}`)
  // Built-in Themes renamed with the design system (sky is now celeste): an old name reads as the new one,
  // so a Panel set up before keeps a Theme instead of falling back.
  const color = data.panel?.colorTheme
  if (color && Object.hasOwn(RENAMED_THEMES, color))
    data.panel = { ...data.panel, colorTheme: RENAMED_THEMES[color] }
  return data
}

/** A Pick Command whose name is unsafe in a shell or also an Alias (they share one namespace), or null. */
function shortCommandProblem(data: Config): string | null {
  for (const name of Object.keys(data.pickCommands ?? {})) {
    const problem = aliasProblem(name)
    if (problem)
      return `pick command "${name}" ${problem} (it becomes a shell function name); pick another name`
    if (data.aliases && Object.hasOwn(data.aliases, name))
      return `"${name}" is both an alias and a pick command; remove one with \`sideby alias rm ${name}\` and add it again`
  }
  return null
}

/** Where the config file is read and written: the target of a link (a dotfiles manager may link it). */
async function configTarget(file: string): Promise<string> {
  return (await lstatOrNull(file))?.isSymbolicLink() ? ((await realpathOrNull(file)) ?? file) : file
}

/**
 * Re-reads the config file, lets `edit` change one top-level `key` (the keys sideby writes are listed in spec §3.10;
 * `sideby config set|unset` may change any but plugin settings, §3.29), and an `edit` that returns undefined removes it, and writes the result: every other key and their order kept (with `$schema`), 2-space JSON
 * with a trailing newline, atomically, keeping the file's mode (0600 for a new file). Refuses, without writing, a
 * file that is not valid JSON or not a valid config, a result that is not a valid config, or a file that changed
 * while sideby wrote it. `edit` returns null to leave the file alone; `dryRun` returns the change without writing.
 * `retry` names what to do again after a fix.
 */
async function editConfigKey<K extends Exclude<keyof Config, '$schema'>>(
  file: string,
  key: K,
  retry: string,
  edit: (current: Config[K] | undefined) => Config[K] | null,
  opts: { dryRun?: boolean } = {},
): Promise<{ changed: boolean; before: Config[K] | undefined; after: Config[K] | undefined }> {
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
  const before = data[key] as Config[K] | undefined
  const after = edit(before)
  if (after === null || JSON.stringify(after) === JSON.stringify(before))
    return { changed: false, before, after: before }
  // A new file gets the schema link editors use for completion; an existing file keeps its keys in order.
  const next: Record<string, unknown> =
    raw === null
      ? { $schema: 'https://unpkg.com/sideby/schemas/config.json', [key]: after }
      : { ...data, [key]: after }
  if (after === undefined) delete next[key]
  if (!Value.Check(ConfigSchema, next)) {
    const first = [...Value.Errors(ConfigSchema, next)][0]
    const where = (first?.instancePath ?? '').replace(/^\//, '').split('/').join('.') || key
    throw new ConfigError(
      `${where} ${first?.message ?? 'is invalid'}, so nothing was changed; \`sideby config get\` lists the keys and the values they take`,
      { code: 'bad-value' },
    )
  }
  for (const alias of Object.keys((next as Config).aliases ?? {})) {
    const problem = aliasProblem(alias)
    if (problem)
      throw new ConfigError(
        `alias "${alias}" ${problem} (it becomes a shell function name); pick another name`,
        {
          code: 'bad-value',
        },
      )
  }
  const shortProblem = shortCommandProblem(next as Config)
  if (shortProblem) throw new ConfigError(shortProblem, { code: 'bad-value' })
  const h = handoffSettings(next as Config)
  if (h.prepareAt >= h.threshold)
    throw new ConfigError(
      `handoff.prepareAt must be lower than handoff.threshold; fix them in ${file} and ${retry} again`,
    )
  if (opts.dryRun) return { changed: true, before, after }
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
  return { changed: true, before, after }
}

async function editConfigAliases(
  file: string,
  retry: string,
  edit: (current: Record<string, AliasValue>) => Record<string, AliasValue> | null,
): Promise<Record<string, AliasValue>> {
  const r = await editConfigKey(file, 'aliases', retry, (current) => edit(current ?? {}))
  return r.after ?? {}
}

export type HandoffConfig = NonNullable<Config['handoff']>

/**
 * `sideby handoff enable|disable` (spec §3.17): changes the config `handoff` key with `edit` (see `editConfigKey`
 * for how the file is written). With `dryRun`, shows the change without writing.
 */
export function editConfigHandoff(
  file: string,
  edit: (current: HandoffConfig) => HandoffConfig,
  opts: { dryRun?: boolean } = {},
): Promise<{ changed: boolean; before: HandoffConfig | undefined; after: HandoffConfig | undefined }> {
  return editConfigKey(file, 'handoff', 'run the command', (current) => edit(current ?? {}), opts)
}

export type UpdateConfig = NonNullable<Config['update']>

/**
 * The Panel's Auto Update switch (spec §3.23): changes the config `update` key with `edit` (see `editConfigKey` for
 * how the file is written). With `dryRun`, shows the change without writing.
 */
export function editConfigUpdate(
  file: string,
  edit: (current: UpdateConfig) => UpdateConfig,
  opts: { dryRun?: boolean } = {},
): Promise<{ changed: boolean; before: UpdateConfig | undefined; after: UpdateConfig | undefined }> {
  return editConfigKey(file, 'update', 'change the setting', (current) => edit(current ?? {}), opts)
}

export type NetworkConfig = NonNullable<Config['network']>

/**
 * `sideby network on|off|allow` and the Panel's network check (spec §3.35): changes the config `network` key with
 * `edit` (see `editConfigKey` for how the file is written). With `dryRun`, shows the change without writing.
 */
export function editConfigNetwork(
  file: string,
  edit: (current: NetworkConfig) => NetworkConfig,
  opts: { dryRun?: boolean } = {},
): Promise<{ changed: boolean; before: NetworkConfig | undefined; after: NetworkConfig | undefined }> {
  return editConfigKey(file, 'network', 'change the setting', (current) => edit(current ?? {}), opts)
}

export type UnattendedConfig = NonNullable<Config['unattended']>

/**
 * `sideby unattended on|schedule …` (spec §3.37): changes the config `unattended` key with `edit` (see `editConfigKey`
 * for how the file is written); `edit` gets `undefined` while the section is missing and returns null to leave it.
 */
export function editConfigUnattended(
  file: string,
  edit: (current: UnattendedConfig | undefined) => UnattendedConfig | null,
): Promise<{
  changed: boolean
  before: UnattendedConfig | undefined
  after: UnattendedConfig | undefined
}> {
  return editConfigKey(file, 'unattended', 'run the command', edit)
}

export type BrowserConfig = NonNullable<Config['browser']>

/**
 * `sideby browser --enable|--disable` and the Panel's switch (spec §3.24): changes the config `browser` key with
 * `edit` (see `editConfigKey` for how the file is written). With `dryRun`, shows the change without writing.
 */
export function editConfigBrowser(
  file: string,
  edit: (current: BrowserConfig) => BrowserConfig,
  opts: { dryRun?: boolean } = {},
): Promise<{ changed: boolean; before: BrowserConfig | undefined; after: BrowserConfig | undefined }> {
  return editConfigKey(file, 'browser', 'change the setting', (current) => edit(current ?? {}), opts)
}

export type DisplayConfig = NonNullable<Config['display']>

/**
 * The Panel's drag and drop (spec §3.25): replaces the config `display` key, or removes it when `display` is undefined
 * or empty (see `editConfigKey` for how the file is written).
 */
export function editConfigDisplay(
  file: string,
  display: DisplayConfig | undefined,
): Promise<{ changed: boolean; before: DisplayConfig | undefined; after: DisplayConfig | undefined }> {
  const lists = (r: Record<string, string[]> | undefined) =>
    Object.fromEntries(Object.entries(r ?? {}).filter(([, names]) => names.length))
  const accounts = lists(display?.accounts)
  const pinned = lists(display?.pinned)
  const hidden = lists(display?.hidden)
  const next: DisplayConfig = {
    ...(display?.families?.length ? { families: [...display.families] } : {}),
    ...(Object.keys(accounts).length ? { accounts } : {}),
    ...(Object.keys(pinned).length ? { pinned } : {}),
    ...(display?.hiddenFamilies?.length ? { hiddenFamilies: [...display.hiddenFamilies] } : {}),
    ...(Object.keys(hidden).length ? { hidden } : {}),
  }
  return editConfigKey(file, 'display', 'move it again', () => (Object.keys(next).length ? next : undefined))
}

export type QuotaConfig = NonNullable<Config['quota']>

/**
 * The Panel's Quota check switch (spec §3.26): `false` writes `quota.check.<family>: false`, `true` removes that key
 * (on is the default), and an empty `quota` goes away with it (see `editConfigKey` for how the file is written).
 */
export function editConfigQuotaCheck(
  file: string,
  family: string,
  on: boolean,
): Promise<{ changed: boolean; before: QuotaConfig | undefined; after: QuotaConfig | undefined }> {
  return editConfigKey(file, 'quota', 'change the setting', (current) => {
    const check = { ...(current?.check ?? {}) }
    if (on) delete check[family]
    else check[family] = false
    const { check: _old, ...rest } = current ?? {}
    const next: QuotaConfig = { ...rest, ...(Object.keys(check).length ? { check } : {}) }
    return Object.keys(next).length ? next : undefined
  })
}

export type AccountsConfig = NonNullable<Config['accounts']>

/**
 * `sideby model` (spec §3.19): changes the config `accounts` key with `edit` (see `editConfigKey` for how the file is
 * written). With `dryRun`, shows the change without writing.
 */
export function editConfigAccounts(
  file: string,
  /** Returns null to leave the file as it is. */
  edit: (current: AccountsConfig) => AccountsConfig | null,
  opts: { dryRun?: boolean } = {},
): Promise<{ changed: boolean; before: AccountsConfig | undefined; after: AccountsConfig | undefined }> {
  return editConfigKey(file, 'accounts', 'run the command', (current) => edit(current ?? {}), opts)
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

/**
 * Adds `name → family` to the config file's `pickCommands` (see `editConfigKey` for how the file is written). Refuses
 * an invalid name, one that is an Alias, or one that already picks in another Family.
 */
export async function addConfigPickCommand(
  file: string,
  name: string,
  family: string,
): Promise<{ status: 'added' | 'exists'; pickCommands: Record<string, string> }> {
  const problem = aliasProblem(name)
  if (problem) throw new ConfigError(`pick command "${name}" ${problem} (it becomes a shell function name)`)
  let status: 'added' | 'exists' = 'added'
  const r = await editConfigKey(file, 'pickCommands', 'add the pick command', (current) => {
    const now = current ?? {}
    if (!Object.hasOwn(now, name)) return { ...now, [name]: family }
    if (now[name] !== family)
      throw new ConfigError(
        `"${name}" already starts the ${now[name]} account with the most room; pick another name, or remove it first with \`sideby alias rm ${name}\``,
      )
    status = 'exists'
    return null
  })
  return { status, pickCommands: r.after ?? {} }
}

/** Removes `name` from `pickCommands`; `absent` when it was not there. An emptied key goes away with it. */
export async function removeConfigPickCommand(
  file: string,
  name: string,
): Promise<{ status: 'removed' | 'absent'; pickCommands: Record<string, string> }> {
  let status: 'removed' | 'absent' = 'absent'
  const r = await editConfigKey(file, 'pickCommands', 'remove the pick command', (current) => {
    if (!current || !Object.hasOwn(current, name)) return null
    status = 'removed'
    const { [name]: _gone, ...rest } = current
    return Object.keys(rest).length ? rest : undefined
  })
  return { status, pickCommands: r.after ?? {} }
}

export function editConfigTerminal(file: string, patch: { preferred?: string; custom?: string }) {
  return editConfigKey(file, 'terminal', 'run `sideby terminal`', (current) => {
    const next = { ...current, ...patch }
    for (const key of ['preferred', 'custom'] as const) if (next[key] === undefined) delete next[key]
    return Object.keys(next).length ? next : undefined
  })
}
export function editConfigAsk(file: string, account?: string) {
  return editConfigKey(file, 'ask', 'run `sideby ask`', () => (account ? { account } : undefined))
}

export type PanelConfig = NonNullable<Config['panel']>

/**
 * The Panel's light/dark, language and Theme (spec §3.29, §3.34): a value sets the key, null removes it (back to the default), and an
 * empty `panel` goes away with it (see `editConfigKey` for how the file is written).
 */
export function editConfigPanel(
  file: string,
  patch: {
    theme?: PanelConfig['theme'] | null
    language?: PanelConfig['language'] | null
    colorTheme?: PanelConfig['colorTheme'] | null
  },
  opts: { dryRun?: boolean } = {},
): Promise<{ changed: boolean; before: PanelConfig | undefined; after: PanelConfig | undefined }> {
  return editConfigKey(
    file,
    'panel',
    'change the setting',
    (current) => {
      const next: Record<string, unknown> = { ...current }
      for (const k of ['theme', 'language', 'colorTheme'] as const)
        if (patch[k] === null) delete next[k]
        else if (patch[k] !== undefined) next[k] = patch[k]
      return Object.keys(next).length ? (next as PanelConfig) : undefined
    },
    opts,
  )
}

// ---- `sideby config get|set|unset` (spec §3.29): any key of the schema except a plugin's own settings.

type SchemaNode = {
  type?: string
  description?: string
  properties?: Record<string, SchemaNode>
  patternProperties?: Record<string, SchemaNode>
  anyOf?: SchemaNode[]
  items?: SchemaNode
  enum?: string[]
  const?: unknown
  minimum?: number
  maximum?: number
}

/** The name shown for a key the user picks, per record in the schema. */
const PLACEHOLDERS: Record<string, string> = {
  accounts: '<family>:<name>',
  aliases: '<short>',
  pickCommands: '<short>',
  plugins: '<plugin>',
  extraSharedItems: '<family>',
  'handoff.families': '<family>',
  'display.accounts': '<family>',
  'display.pinned': '<family>',
  'display.hidden': '<family>',
  'quota.check': '<family>',
}

const BAD_SEGMENT = new Set(['__proto__', 'constructor', 'prototype'])

export interface SettableKey {
  /** Dot path; `<…>` marks a part the user fills in (`accounts.<family>:<name>.args`). */
  key: string
  /** One line on what it does. */
  meaning: string
  /** The values it takes, in words. */
  takes: string
  /** The current value of a key without `<…>`; absent when not set. */
  value?: unknown
  /** For a key with `<…>`: the keys set now and their values. */
  entries?: { key: string; value: unknown }[]
}

function takes(node: SchemaNode): string {
  if (node.anyOf) {
    const consts = node.anyOf.filter((n) => n.const !== undefined).map((n) => String(n.const))
    if (consts.length === node.anyOf.length) return `one of: ${consts.join(', ')}`
    return 'an account ref (`<family>:<name>`), or JSON {"account": …, "args": […]}'
  }
  if (node.enum) return `one of: ${node.enum.join(', ')}`
  if (node.type === 'boolean') return 'true or false'
  if (node.type === 'integer')
    return node.maximum !== undefined
      ? `a whole number from ${node.minimum ?? 0} to ${node.maximum}`
      : `a whole number, ${node.minimum ?? 0} or more`
  if (node.type === 'array')
    return node.items?.type === 'string' ? 'a JSON list of text, such as ["a","b"]' : 'a JSON list'
  if (node.type === 'string') return 'text'
  return 'a JSON object'
}

/** Every key `sideby config set` takes, with its meaning and current value, in schema order. */
export function settableKeys(config: Config): SettableKey[] {
  const out: SettableKey[] = []
  const walk = (node: SchemaNode, path: string[], meaning: string) => {
    const key = path.join('.')
    const here = node.description ?? meaning
    if (node.properties) {
      for (const [name, child] of Object.entries(node.properties))
        if (name !== '$schema') walk(child, [...path, name], here)
      return
    }
    const pattern = node.patternProperties && Object.values(node.patternProperties)[0]
    if (pattern) {
      const holder = PLACEHOLDERS[key] ?? '<name>'
      if (key === 'plugins') {
        walk(
          {
            type: 'boolean',
            description: 'false turns the plugin off; its own settings are not changed here.',
          },
          [...path, holder, 'enabled'],
          here,
        )
        return
      }
      if (pattern.properties) return walk(pattern, [...path, holder], here)
      return leaf(pattern, [...path, holder], here)
    }
    leaf(node, path, here)
  }
  const leaf = (node: SchemaNode, path: string[], meaning: string) => {
    const key = path.join('.')
    const item: SettableKey = { key, meaning: node.description ?? meaning, takes: takes(node) }
    const holder = path.findIndex((p) => p.startsWith('<'))
    if (holder < 0) {
      const v = getIn(config, path)
      if (v !== undefined) item.value = v
    } else {
      const entries: { key: string; value: unknown }[] = []
      const parent = getIn(config, path.slice(0, holder))
      if (parent && typeof parent === 'object')
        for (const name of Object.keys(parent)) {
          const concrete = [...path.slice(0, holder), name, ...path.slice(holder + 1)]
          const v = getIn(config, concrete)
          if (v !== undefined) entries.push({ key: concrete.join('.'), value: v })
        }
      if (entries.length) item.entries = entries
    }
    out.push(item)
  }
  walk(ConfigSchema as unknown as SchemaNode, [], '')
  return out
}

function getIn(value: unknown, path: readonly string[]): unknown {
  let at = value
  for (const seg of path) {
    if (!at || typeof at !== 'object' || Array.isArray(at) || !Object.hasOwn(at, seg)) return undefined
    at = (at as Record<string, unknown>)[seg]
  }
  return at
}

/** Splits and checks a dot path; refuses what `config` may not read or change. */
export function configKeyPath(key: string): string[] {
  return describeConfigKey(key).path
}

/** The path of `key`, what it does and the values it takes; refuses what `config` may not read or change. */
export function describeConfigKey(key: string): { path: string[]; meaning: string; takes: string } {
  const path = key.split('.')
  const list = '`sideby config get` lists the keys you can use'
  if (!key || path.some((p) => !p || BAD_SEGMENT.has(p)))
    throw new ConfigError(`"${key}" is not a config key; ${list}`, { code: 'bad-key' })
  if (path[0] === '$schema')
    throw new ConfigError(`$schema is for editors and is not a setting; ${list}`, { code: 'bad-key' })
  if (path[0] === 'plugins' && !(path.length === 3 && path[2] === 'enabled'))
    throw new ConfigError(
      `a plugin's own settings may hold secrets, so \`sideby config\` does not read or change them (only plugins.<plugin>.enabled); edit them in the config file`,
      { code: 'plugin-config' },
    )
  let node: SchemaNode | undefined = ConfigSchema as unknown as SchemaNode
  let meaning = ''
  for (const seg of path) {
    const n: SchemaNode | undefined = node
    if (!n) break
    const holder: SchemaNode[] = n.anyOf ?? [n]
    node = undefined
    for (const h of holder) {
      if (h.properties?.[seg]) node = h.properties[seg]
      else if (h.patternProperties) {
        const [re, child] = Object.entries(h.patternProperties)[0]!
        if (new RegExp(re).test(seg)) node = child
      }
      if (node) break
    }
    if (node?.description) meaning = node.description
  }
  if (!node) throw new ConfigError(`"${key}" is not a config key; ${list}`, { code: 'bad-key' })
  if (path[0] === 'plugins') return { path, meaning: 'false turns the plugin off.', takes: 'true or false' }
  return { path, meaning, takes: takes(node) }
}

/** A value from the command line: JSON when it parses (90, true, ["a"]), else the text itself. */
export function parseConfigValue(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** `sideby config get [key]`: the value at `key` (undefined when not set). */
export async function configGet(file: string, key: string): Promise<{ key: string; value: unknown }> {
  const path = configKeyPath(key)
  return { key, value: getIn(await loadConfig(file), path) }
}

function setIn(value: unknown, path: readonly string[], next: unknown, key: string): unknown {
  const [seg, ...rest] = path
  if (seg === undefined) return next
  if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value)))
    throw new ConfigError(
      `${key} cannot be set inside a value that is not an object; set the part before it as a whole (JSON), or unset it first`,
      { code: 'bad-key' },
    )
  const obj: Record<string, unknown> = { ...(value as Record<string, unknown> | undefined) }
  const child = setIn(obj[seg], rest, next, key)
  if (child === undefined || (rest.length && isEmptyObject(child) && next === undefined)) delete obj[seg]
  else obj[seg] = child
  return obj
}

const isEmptyObject = (v: unknown) =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0

export interface ConfigChange {
  key: string
  before: unknown
  after: unknown
  changed: boolean
}

/**
 * `sideby config set|unset` (spec §3.29): sets `key` to `value`, or removes it when `value` is undefined (and parents
 * left empty with it). The whole result must match the schema; `accounts.<ref>.args` takes only what `argsProblem`
 * accepts (the model and effort arguments, as `sideby model`), and without `argsProblem` it is refused; a
 * `handoff` change passes `checkHandoff`, the same check the Panel and `sideby handoff` use. Written as
 * every other config change (see `editConfigKey`); `dryRun` shows the change without writing.
 */
export async function editConfigPath(
  file: string,
  key: string,
  value: unknown,
  opts: {
    dryRun?: boolean
    argsProblem?: (ref: string, args: string[]) => string | null
    /** Throws when a changed `handoff` setting names a Family or Account that does not exist. */
    checkHandoff?: (before: HandoffConfig | undefined, after: HandoffConfig | undefined) => void
  } = {},
): Promise<ConfigChange> {
  const path = configKeyPath(key)
  if (path[0] === 'plugins' && value !== undefined && typeof value !== 'boolean')
    throw new ConfigError(`${key} takes true or false`, { code: 'bad-value' })
  const top = path[0] as Exclude<keyof Config, '$schema'>
  const r = await editConfigKey(
    file,
    top,
    'run the command',
    (current) => {
      const next = setIn(current, path.slice(1), value, key) as Config[typeof top]
      const result = path.length === 1 ? next : isEmptyObject(next) ? undefined : next
      if (top === 'accounts')
        checkAccountArgs(
          current as AccountsConfig | undefined,
          result as AccountsConfig | undefined,
          opts.argsProblem,
        )
      if (top === 'handoff')
        opts.checkHandoff?.(current as HandoffConfig | undefined, result as HandoffConfig | undefined)
      return result
    },
    opts,
  )
  const inner = path.slice(1)
  return { key, before: getIn(r.before, inner), after: getIn(r.after, inner), changed: r.changed }
}

function checkAccountArgs(
  before: AccountsConfig | undefined,
  after: AccountsConfig | undefined,
  argsProblem: ((ref: string, args: string[]) => string | null) | undefined,
): void {
  for (const [ref, entry] of Object.entries(after ?? {})) {
    const args = entry.args
    if (!args || JSON.stringify(args) === JSON.stringify(before?.[ref]?.args)) continue
    const problem = argsProblem ? argsProblem(ref, args) : 'sideby cannot check these arguments here'
    if (problem)
      throw new ConfigError(
        `accounts.${ref}.args: ${problem}. \`sideby config\` sets only the model and effort arguments, as \`sideby model ${ref}\` does; other host arguments go in a short command (\`sideby alias add <short> ${ref} -- <args>\`)`,
        { code: 'bad-value' },
      )
  }
}
