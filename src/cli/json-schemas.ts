// JSON Schemas for every `--json` output. Additive changes keep schemaVersion 1; removals, renames or
// meaning changes bump it (spec §3.9). `pnpm schemas` writes these to schemas/*.json.
import { type TSchema, Type } from 'typebox'
import { ConfigSchema } from '../core/config.ts'

const Str = Type.String()
const Level = Type.Union([Type.Literal('ok'), Type.Literal('warn'), Type.Literal('fail')])
const Kind = Type.Union([Type.Literal('subscription'), Type.Literal('api')])
const Version = Type.Literal(1)
const AppPlatform = Type.Union([Type.Literal('darwin'), Type.Literal('linux')])

const Account = Type.Object({
  family: Str,
  name: Str,
  ref: Str,
  dir: Str,
  isMain: Type.Boolean(),
  kind: Kind,
  secretFile: Type.Optional(Str),
})

const AccountStatus = Type.Intersect([
  Account,
  Type.Object({
    familyTitle: Str,
    hostInstalled: Type.Boolean(),
    login: Type.Union([
      Type.Literal('logged-in'),
      Type.Literal('logged-out'),
      Type.Literal('unknown'),
      Type.Literal('not-needed'),
    ]),
    model: Type.Optional(Str),
    identity: Type.Optional(
      Type.Object(
        { email: Type.Optional(Str), org: Type.Optional(Str) },
        {
          description:
            "Who the account is signed in as, from the host's login file: identity fields only, never a token (ADR-0003).",
        },
      ),
    ),
    problems: Type.Optional(Type.Array(Str)),
  }),
])

const FamilyInfo = Type.Object({
  id: Str,
  title: Str,
  bin: Str,
  installUrl: Str,
  installed: Type.Boolean(),
  plugin: Str,
})

const ShareModeSchema = Type.Union(
  ['link', 'copy', 'link-or-copy', 'link-or-local', 'local', 'local-if-api', 'info', 'json-key'].map((m) =>
    Type.Literal(m),
  ),
)

const FamilyDetail = Type.Intersect([
  FamilyInfo,
  Type.Object({
    layout: Type.Object(
      { main: Str, account: Str },
      { description: 'Relative to HOME, for example `.claude` and `.claude-<name>`.' },
    ),
    selectVar: Type.String({
      description: 'Environment variable that selects a non-main Account directory.',
    }),
    login: Type.Object({
      args: Type.Union([Type.Array(Str), Type.Null()], {
        description: "Arguments of the Host's sign-in command; null when sign-in happens inside the Host.",
      }),
      hint: Str,
    }),
    quota: Type.Boolean(),
    usage: Type.Boolean(),
    quotaSetup: Type.Boolean({ description: 'Quota needs `sideby quota setup <family>` once.' }),
    shared: Type.Array(
      Type.Object({
        path: Str,
        mode: ShareModeSchema,
        key: Type.Optional(Str),
        mainPath: Type.Optional(Str),
        credential: Type.Optional(Type.Boolean()),
        noSymlink: Type.Optional(Type.Boolean()),
        source: Type.Union([Type.Literal('family'), Type.Literal('config')]),
        meaning: Type.String({
          description: 'What the item looks like in each Account, in one fixed sentence.',
        }),
      }),
    ),
  }),
])

const PluginError = Type.Object({ where: Str, message: Str })

const Finding = Type.Object({
  level: Level,
  account: Str,
  item: Str,
  code: Str,
  message: Str,
  hint: Type.Optional(Str),
  source: Str,
  fixable: Type.Boolean(),
})

const QuotaWindow = Type.Object({
  label: Str,
  windowMinutes: Type.Number(),
  usedPercent: Type.Number(),
  resetsAt: Str,
})

const Quota = Type.Union([
  Type.Object({
    status: Type.Literal('ok'),
    windows: Type.Array(QuotaWindow),
    observedAt: Str,
    source: Str,
    plan: Type.Optional(Str),
  }),
  Type.Object({ status: Type.Literal('unavailable'), reason: Str, detail: Type.Optional(Str) }),
])

const Usage = Type.Union([
  Type.Object({
    status: Type.Literal('ok'),
    days: Type.Number(),
    sessions: Type.Number(),
    inputTokens: Type.Number(),
    outputTokens: Type.Number(),
    cacheReadTokens: Type.Number(),
    cacheWriteTokens: Type.Number(),
    totalTokens: Type.Number(),
    daily: Type.Optional(
      Type.Array(Type.Object({ date: Str, totalTokens: Type.Number() }), {
        description: 'Tokens per local day (YYYY-MM-DD), oldest first, days without records as 0.',
      }),
    ),
    lastActivityAt: Type.Optional(Str),
  }),
  Type.Object({ status: Type.Literal('unavailable'), reason: Str, detail: Type.Optional(Str) }),
])

const QuotaSetupPlan = Type.Object({
  status: Type.Union([Type.Literal('enabled'), Type.Literal('ready'), Type.Literal('blocked')]),
  file: Str,
  diff: Str,
  message: Str,
})

const ShellInitFiles = Type.Array(
  Type.Object({
    shell: Type.Union([Type.Literal('zsh'), Type.Literal('bash')]),
    path: Str,
    ok: Type.Boolean(),
    action: Type.Optional(Type.Union([Type.Literal('written'), Type.Literal('unchanged')])),
    message: Type.Optional(Str),
  }),
  { description: 'One entry per config `shellInitFile`, rewritten after the change.' },
)

export const OUTPUT_SCHEMAS: Record<string, TSchema> = {
  list: Type.Object(
    {
      schemaVersion: Version,
      families: Type.Array(FamilyInfo),
      accounts: Type.Array(AccountStatus),
      pluginErrors: Type.Array(PluginError),
    },
    { title: 'sideby list --json' },
  ),
  doctor: Type.Object(
    {
      schemaVersion: Version,
      status: Type.Union([Type.Literal('ok'), Type.Literal('issues')]),
      accounts: Type.Array(
        Type.Object({
          ref: Str,
          family: Str,
          name: Str,
          kind: Kind,
          dir: Str,
          shared: Type.Object({ ok: Type.Number(), total: Type.Number() }),
          backups: Type.Number(),
          findings: Type.Array(Finding),
        }),
      ),
      general: Type.Array(Finding),
      fixes: Type.Array(
        Type.Object({ account: Str, item: Str, code: Str, ok: Type.Boolean(), message: Str }),
      ),
    },
    { title: 'sideby doctor --json' },
  ),
  quota: Type.Object(
    {
      schemaVersion: Version,
      accounts: Type.Array(Type.Object({ ref: Str, kind: Kind, quota: Quota, usage: Usage })),
    },
    { title: 'sideby quota --json' },
  ),
  next: Type.Object(
    {
      schemaVersion: Version,
      family: Str,
      pick: Type.Union([Str, Type.Null()], {
        description: 'The recommended account; null when none can be used now (exit code 1).',
      }),
      accounts: Type.Array(
        Type.Object({
          ref: Str,
          kind: Kind,
          state: Type.Union(
            [
              Type.Literal('ready'),
              Type.Literal('unknown'),
              Type.Literal('api'),
              Type.Literal('full'),
              Type.Literal('logged-out'),
            ],
            {
              description:
                'ready and unknown can be picked; api only with --include-api; full and logged-out never.',
            },
          ),
          pressure: Type.Union([Type.Number(), Type.Null()], {
            description: 'Used percent of the fullest window not reset yet; null without quota.',
          }),
          resetsAt: Type.Optional(
            Type.String({ description: 'For full: when its last full window resets.' }),
          ),
          observedAt: Type.Optional(
            Type.String({ description: "When the account's quota was recorded (its last session)." }),
          ),
        }),
        { description: 'Every account of the family, best first.' },
      ),
      hasQuota: Type.Boolean({
        description:
          'False when no account has quota data: the pick is then a guess, and `sideby next` does not start it (exit 1).',
      }),
      earliestReset: Type.Optional(
        Type.Object(
          { ref: Str, at: Str },
          {
            description: 'Set when nothing can be picked and some accounts are full: the first to come back.',
          },
        ),
      ),
    },
    { title: 'sideby next --json' },
  ),
  'quota-setup': Type.Object(
    { schemaVersion: Version, family: Str, applied: Type.Boolean(), plan: QuotaSetupPlan },
    { title: 'sideby quota setup --json' },
  ),
  'quota-teardown': Type.Object(
    { schemaVersion: Version, family: Str, ok: Type.Boolean(), message: Str, diff: Type.Optional(Str) },
    { title: 'sideby quota teardown --json' },
  ),
  new: Type.Object(
    {
      schemaVersion: Version,
      ok: Type.Boolean(),
      account: Account,
      steps: Type.Array(
        Type.Object({ item: Str, action: Str, ok: Type.Boolean(), message: Type.Optional(Str) }),
      ),
      hookErrors: Type.Array(Type.Object({ plugin: Str, message: Str })),
      nextSteps: Type.Array(Str),
      alias: Type.Optional(
        Type.Object(
          { name: Str, added: Type.Boolean(), message: Type.Optional(Str) },
          { description: 'The `--alias` short command; `added: false` means the Account exists without it.' },
        ),
      ),
      shellInitFiles: Type.Optional(ShellInitFiles),
      suggestion: Type.Optional(
        Type.Object(
          { name: Str, alias: Type.Optional(Str), aliasProblem: Type.Optional(Str) },
          {
            description:
              'Only with `--next`: the picked name, the short command that follows the existing pattern, or why that short command was left out.',
          },
        ),
      ),
    },
    { title: 'sideby new --json' },
  ),
  alias: Type.Object(
    {
      schemaVersion: Version,
      ok: Type.Boolean({ description: 'False when a config `shellInitFile` was not rewritten.' }),
      alias: Str,
      status: Type.Union([
        Type.Literal('added'),
        Type.Literal('exists'),
        Type.Literal('removed'),
        Type.Literal('absent'),
      ]),
      account: Type.Optional(Str),
      args: Type.Optional(Type.Array(Str, { description: 'Host arguments `sideby run <alias>` adds.' })),
      shellInitFiles: Type.Optional(ShellInitFiles),
    },
    { title: 'sideby alias add|rm --json' },
  ),
  plugins: Type.Object(
    {
      schemaVersion: Version,
      plugins: Type.Array(
        Type.Object({
          name: Str,
          version: Str,
          source: Str,
          description: Type.Optional(Str),
          families: Type.Array(Str),
          configKeys: Type.Array(Str),
        }),
      ),
      errors: Type.Array(PluginError),
    },
    { title: 'sideby plugins --json' },
  ),
  families: Type.Object(
    { schemaVersion: Version, families: Type.Array(FamilyDetail) },
    { title: 'sideby families --json' },
  ),
  'app-install': Type.Object(
    {
      schemaVersion: Version,
      platform: AppPlatform,
      path: Str,
      files: Type.Array(Str),
      mode: Type.Union([Type.Literal('panel'), Type.Literal('url')]),
      url: Type.Optional(Str),
      node: Str,
      entry: Str,
      updated: Type.Boolean(),
      hints: Type.Array(Str),
    },
    { title: 'sideby app install --json' },
  ),
  'app-uninstall': Type.Object(
    {
      schemaVersion: Version,
      platform: AppPlatform,
      removed: Type.Array(Str),
      skipped: Type.Array(Type.Object({ path: Str, reason: Str })),
    },
    { title: 'sideby app uninstall --json' },
  ),
  error: Type.Object(
    {
      schemaVersion: Version,
      error: Type.String({ description: 'What went wrong and what to do next.' }),
      code: Type.String({
        description:
          '`usage` for a malformed command line (exit 2), a reason such as `no-quota-source` or `alias-invalid`, or `error`.',
      }),
    },
    { title: 'sideby error --json' },
  ),
  config: ConfigSchema,
}
