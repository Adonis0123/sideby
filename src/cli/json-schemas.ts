// JSON Schemas for every `--json` output. Additive changes keep schemaVersion 1; removals, renames or
// meaning changes bump it (spec §3.9). `pnpm schemas` writes these to schemas/*.json.
import { type TSchema, Type } from 'typebox'
import { ConfigSchema } from '../core/config.ts'

const Str = Type.String()
const Level = Type.Union([Type.Literal('ok'), Type.Literal('warn'), Type.Literal('fail')])
const Kind = Type.Union([Type.Literal('subscription'), Type.Literal('api')])
const Version = Type.Literal(1)

const Choice = Type.Object({ model: Type.Optional(Str), effort: Type.Optional(Str) })
const Shown = Type.Object({
  value: Str,
  from: Type.Union([Type.Literal('sideby'), Type.Literal('host'), Type.Literal('last')]),
})
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
    sameLogin: Type.Optional(
      Type.Array(Str, {
        description:
          'The other accounts signed in as the same login (same family, email and organization), which share one quota (spec §3.21). Absent when there are none.',
      }),
    ),
    problems: Type.Optional(Type.Array(Str)),
    desktopApp: Type.Optional(
      Type.Object(
        { app: Str, installed: Type.Boolean(), running: Type.Boolean() },
        {
          description:
            "The family's desktop app for this account (macOS, subscription accounts of claude and codex): whether it is installed and whether this account's own window runs now. Open it with `sideby desktop <account>`.",
        },
      ),
    ),
  }),
])

const FamilyInfo = Type.Object({
  id: Str,
  title: Str,
  bin: Str,
  installUrl: Str,
  installed: Type.Boolean(),
  plugin: Str,
  tuning: Type.Boolean(),
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
    from: Type.Optional(
      Type.String({
        description:
          'The account this reading was taken from, when it is another account of the same login (spec §3.21); observedAt is its time.',
      }),
    ),
  }),
  Type.Object({ status: Type.Literal('unavailable'), reason: Str, detail: Type.Optional(Str) }),
])

const TuningModel = Type.Object({
  model: Str,
  calls: Type.Number(),
  contextWindow: Type.Number(),
  configured: Type.Union([Type.Number(), Type.Null()], {
    description: 'Configured threshold in tokens; null is the Host default.',
  }),
  effective: Type.Union([Type.Number(), Type.Null()]),
  compactions: Type.Object({
    total: Type.Number({
      description: 'All compactions, including those whose trigger the Host does not record.',
    }),
    auto: Type.Number(),
    manual: Type.Number(),
    idle: Type.Number({
      description:
        'Automatic compactions Claude Code did after the conversation sat idle; the size setting does not control them.',
    }),
    preTokensP50: Type.Union([Type.Number(), Type.Null()]),
    preTokensMax: Type.Union([Type.Number(), Type.Null()]),
  }),
  suggestion: Type.Union(
    [
      Type.Object({
        threshold: Type.Number(),
        savedPercent: Type.Union([Type.Number(), Type.Null()]),
        savedWeighted: Type.Union([Type.Number(), Type.Null()]),
      }),
      Type.Null(),
    ],
    { description: 'The estimated cheapest threshold; null when `reason` says why there is none.' },
  ),
  reason: Type.Union([
    Type.Literal('suggested'),
    Type.Literal('already-best'),
    Type.Literal('insufficient-calls'),
    Type.Literal('no-compactions'),
    Type.Literal('no-optimum'),
    Type.Literal('unknown-model'),
    Type.Literal('observe-only'),
  ]),
})

const Tuning = Type.Union([
  Type.Object({
    status: Type.Literal('ok'),
    days: Type.Number(),
    estimate: Type.Literal(true),
    models: Type.Array(TuningModel),
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
    lastModel: Type.Optional(Str),
    lastEffort: Type.Optional(Str),
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

const AppProfile = Type.Object(
  {
    ref: Type.String({ description: "`grok-bot:<name>`; `grok-bot:main` is the app's own default data." }),
    app: Type.String({ description: 'The app, for example `Grok Bot`.' }),
    name: Str,
    isMain: Type.Boolean(),
    appData: Type.Optional(
      Type.String({
        description: "This window's data folder; absent for the main one, which uses the app's default.",
      }),
    ),
    installed: Type.Boolean(),
    running: Type.Boolean({ description: "This window's own instance runs now." }),
    signedIn: Type.Optional(
      Type.Boolean({
        description:
          'What the app last wrote about its sign-in (it keeps the last value after the app quits); absent when unknown. Which account is signed in is not known.',
      }),
    ),
  },
  {
    description:
      'A window of a desktop app that signs in apart from every account (Grok Bot, ADR-0019). Open or create one with `sideby desktop grok-bot:<name>`.',
  },
)

export const OUTPUT_SCHEMAS: Record<string, TSchema> = {
  list: Type.Object(
    {
      schemaVersion: Version,
      families: Type.Array(FamilyInfo),
      accounts: Type.Array(AccountStatus),
      appProfiles: Type.Optional(
        Type.Array(AppProfile, {
          description:
            'Grok Bot windows (macOS, when Grok Bot is installed or has windows), the main one first. Not accounts.',
        }),
      ),
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
  'tune-change': Type.Object(
    {
      schemaVersion: Version,
      account: Str,
      action: Type.Union([Type.Literal('apply'), Type.Literal('undo')]),
      applied: Type.Boolean({ description: 'True once the change was written (or undone).' }),
      plan: Type.Optional(
        Type.Object({
          status: Type.Union([Type.Literal('ready'), Type.Literal('unchanged'), Type.Literal('blocked')]),
          file: Str,
          link: Type.Boolean(),
          affected: Type.Array(Str),
          current: Type.Union([Type.Number(), Type.Null()]),
          next: Type.Union([Type.Number(), Type.Null()]),
          creates: Type.Boolean(),
          overrides: Type.Optional(Type.Array(Type.Object({ model: Str, value: Type.Number() }))),
          reason: Type.Optional(Str),
        }),
      ),
      message: Type.Optional(Str),
    },
    { title: 'sideby tune apply|undo --json' },
  ),
  'remote-control': Type.Object(
    {
      schemaVersion: Version,
      action: Type.Union([Type.Literal('status'), Type.Literal('off'), Type.Literal('undo')]),
      applied: Type.Optional(Type.Boolean({ description: 'True once the change was written (or undone).' })),
      groups: Type.Optional(
        Type.Array(
          Type.Object({
            file: Str,
            accounts: Type.Array(Str, { description: 'Claude accounts whose settings.json is this file.' }),
            state: Type.Union(
              [
                Type.Literal('on'),
                Type.Literal('default'),
                Type.Literal('off'),
                Type.Literal('missing'),
                Type.Literal('blocked'),
              ],
              {
                description:
                  'on: remoteControlAtStartup is true; default: not set; off: false; missing: no settings.json; blocked: cannot be changed safely (see reason).',
              },
            ),
            reason: Type.Optional(Str),
            undo: Type.Boolean({
              description: 'sideby turned it off here and can put the earlier value back.',
            }),
          }),
          { description: 'For status, every file; for a preview, the files that would change.' },
        ),
      ),
      results: Type.Optional(
        Type.Array(Type.Object({ file: Str, accounts: Type.Array(Str), ok: Type.Boolean(), message: Str })),
      ),
      message: Type.Optional(Str),
    },
    { title: 'sideby remote-control [off|undo] --json' },
  ),
  model: Type.Object(
    {
      schemaVersion: Version,
      account: Str,
      family: Str,
      settable: Type.Boolean({
        description: 'Whether sideby can set the model and effort for this account.',
      }),
      reason: Type.Optional(Str),
      efforts: Type.Array(Str),
      models: Type.Array(Str, { description: 'Model names to offer; any other name may be given.' }),
      sideby: Choice,
      host: Choice,
      last: Choice,
      model: Type.Optional(Shown),
      effort: Type.Optional(Shown),
      change: Type.Optional(
        Type.Object({
          changed: Type.Boolean(),
          applied: Type.Boolean(),
          file: Str,
          diff: Str,
          args: Type.Array(Str, { description: 'The account arguments in the config after the change.' }),
        }),
      ),
    },
    { title: 'sideby model --json' },
  ),
  tune: Type.Object(
    {
      schemaVersion: Version,
      accounts: Type.Array(Type.Object({ ref: Str, family: Str, tuning: Tuning })),
    },
    { title: 'sideby tune --json' },
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
      from: Type.Optional(
        Type.String({
          description:
            'The account `sideby next` runs in (SIDEBY_ACCOUNT, set by sideby for the sessions it starts), when it belongs to this family.',
        }),
      ),
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
          quotaFrom: Type.Optional(
            Type.String({
              description:
                'The account the quota was read from, when it is another account of the same login.',
            }),
          ),
          sameLoginAs: Type.Optional(
            Type.String({
              description:
                'The current account (`from`), when this one is signed in as the same login: it shares that quota and is never picked.',
            }),
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
  'handoff-status': Type.Object(
    {
      schemaVersion: Version,
      auto: Type.Boolean(),
      sameFamily: Type.Boolean(),
      prepareAt: Type.Number(),
      threshold: Type.Number(),
      sideby: Type.Object({ ok: Type.Boolean(), problem: Type.Optional(Str) }),
      families: Type.Array(
        Type.Object({
          family: Str,
          starts: Type.Array(Type.Union([Type.Literal('quota'), Type.Literal('limit')])),
          ready: Type.Boolean(),
          problems: Type.Array(Str),
          notes: Type.Array(Str),
          order: Type.Object({
            policy: Type.Union([Type.Literal('pressure'), Type.Literal('order')]),
            order: Type.Array(Str),
            unknown: Type.Array(Str),
          }),
        }),
      ),
      nextSteps: Type.Array(Str),
    },
    { title: 'sideby handoff status --json' },
  ),
  ...Object.fromEntries(
    (['enable', 'disable'] as const).map((sub) => [
      `handoff-${sub}`,
      Type.Object(
        {
          schemaVersion: Version,
          applied: Type.Boolean(),
          file: Str,
          diff: Str,
          settings: Type.Object({
            auto: Type.Boolean(),
            sameFamily: Type.Boolean(),
            prepareAt: Type.Number(),
            threshold: Type.Number(),
            waitIfResetWithinMinutes: Type.Number(),
            countdownSeconds: Type.Number(),
            crossOrganization: Type.Array(Str),
            families: Type.Record(
              Str,
              Type.Object({
                policy: Type.Union([Type.Literal('pressure'), Type.Literal('order')]),
                order: Type.Array(Str),
              }),
            ),
          }),
          nextSteps: Type.Array(Str),
        },
        { title: `sideby handoff ${sub} --json` },
      ),
    ]),
  ),
  'handoff-ready': Type.Object(
    {
      schemaVersion: Version,
      requested: Type.Literal(true),
      next: Type.Optional(Str),
      brief: Type.Optional(Str),
      /** The session was waiting for its quota, so the handoff starts now instead of after a turn (ADR-0018). */
      now: Type.Optional(Type.Literal(true)),
    },
    { title: 'sideby handoff ready --json' },
  ),
  'handoff-setup': Type.Object(
    { schemaVersion: Version, family: Str, applied: Type.Boolean(), plan: QuotaSetupPlan },
    { title: 'sideby handoff setup --json' },
  ),
  'handoff-teardown': Type.Object(
    { schemaVersion: Version, family: Str, ok: Type.Boolean(), message: Str, diff: Type.Optional(Str) },
    { title: 'sideby handoff teardown --json' },
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
  desktop: Type.Object(
    {
      schemaVersion: Version,
      ref: Str,
      family: Type.String({ description: 'The family, or `grok-bot` for a Grok Bot window.' }),
      app: Type.String({ description: 'The desktop app, for example `Claude Desktop`.' }),
      appPath: Str,
      action: Type.Union(
        [Type.Literal('started'), Type.Literal('focused'), Type.Literal('already-running')],
        {
          description:
            '`started`: a new window for this account; `focused`: its running window was brought to the front; `already-running`: it runs but could not be brought to the front.',
        },
      ),
      appData: Type.Optional(
        Type.String({
          description:
            "This account's app data folder; absent for the main account, which uses the app's default.",
        }),
      ),
      createdAppData: Type.Boolean(),
      linked: Type.Array(Str, {
        description:
          "Files linked into a new app data folder from the main account's (claude_desktop_config.json).",
      }),
      command: Type.Optional(Type.Array(Str, { description: 'The `open` command sideby ran.' })),
      notices: Type.Array(Str),
    },
    { title: 'sideby desktop --json' },
  ),
  'desktop-remove': Type.Object(
    {
      schemaVersion: Version,
      ref: Str,
      app: Str,
      appData: Type.String({ description: 'The folder that is (or would be) deleted.' }),
      removed: Type.Boolean({
        description: 'False when only the plan was shown; run again with --yes (exit 10).',
      }),
    },
    { title: 'sideby desktop grok-bot:<name> --remove --json' },
  ),
  update: Type.Object(
    {
      schemaVersion: Version,
      current: Type.String({ description: 'The running sideby version.' }),
      latest: Type.String({ description: 'The `latest` version on the npm registry.' }),
      available: Type.Boolean({ description: '`latest` is newer than `current`.' }),
      method: Type.Object({
        kind: Type.Union(
          ['npm', 'pnpm', 'bun', 'volta', 'npx', 'project', 'source'].map((k) => Type.Literal(k)),
          { description: 'How this copy was installed.' },
        ),
        canUpdate: Type.Boolean({ description: 'sideby can run the Update itself.' }),
        reason: Type.Optional(Type.String({ description: 'Why it cannot.' })),
      }),
      command: Type.String({
        description: 'What an Update runs, or what to run by hand when `canRun` is false.',
      }),
      canRun: Type.Boolean(),
      releaseNotes: Type.String({ description: 'The release notes of `latest`.' }),
      updated: Type.Boolean({
        description: 'False when only the plan was shown (exit 10 with --yes still to add) or nothing to do.',
      }),
      message: Type.Optional(Type.String()),
      restartedPanel: Type.Optional(
        Type.Boolean({
          description: 'A background Panel was running and starts again with the new version.',
        }),
      ),
      skill: Type.Optional(
        Type.String({ description: 'The command that updates the sideby skill; sideby never runs it.' }),
      ),
      output: Type.Optional(Type.String({ description: 'What the failed install command printed.' })),
    },
    { title: 'sideby update --json' },
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
