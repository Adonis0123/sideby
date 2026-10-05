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
    },
    { title: 'sideby new --json' },
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
  error: Type.Object({ schemaVersion: Version, error: Str }, { title: 'sideby error --json' }),
  config: ConfigSchema,
}
