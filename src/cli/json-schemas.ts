// JSON Schemas for every `--json` output. Additive changes keep schemaVersion 1; removals, renames or
// meaning changes bump it (spec §3.9). `pnpm schemas` writes these to schemas/*.json.
import { type TSchema, Type } from 'typebox'
import { ConfigSchema, HandoffSettingsSchema, UnattendedSlotSchema } from '../core/config.ts'

const Str = Type.String()
/** Why sideby cannot do something itself (spec §3.23); `reason` keeps the English text. */
const ReasonCode = Type.Union(
  ['local-build', 'npx', 'volta', 'not-writable', 'project', 'source', 'skill-in-git'].map((k) =>
    Type.Literal(k),
  ),
  { description: 'Why, as a code a page can say in its own language.' },
)
const Level = Type.Union([Type.Literal('ok'), Type.Literal('warn'), Type.Literal('fail')])
const Kind = Type.Union([Type.Literal('subscription'), Type.Literal('api')])
const Version = Type.Literal(1)

/** One Pending Decision of Unattended Mode (spec §3.37). */
const PendingDecision = Type.Object({
  id: Str,
  at: Type.String({ description: 'When it was kept; ISO.' }),
  kind: Type.Union([Type.Literal('question'), Type.Literal('permission'), Type.Literal('deferred')], {
    description:
      'question: the ask tool was refused; permission: a permission request Claude Code was about to show was refused; deferred: kept with `sideby unattended defer`.',
  }),
  family: Str,
  account: Type.Optional(Type.String({ description: 'The account the session ran as.' })),
  sessionId: Type.Optional(Str),
  cwd: Type.Optional(Str),
  agentId: Type.Optional(Type.String({ description: 'The subagent a permission request came from.' })),
  agentType: Type.Optional(Type.String({ description: 'Its type, such as `general-purpose`.' })),
  text: Type.String({
    description:
      'The question and its options, the tool and what it was to do, or the deferred text; at most 4000 characters.',
  }),
  doneAt: Type.Optional(Type.String({ description: 'When it was marked done; ISO.' })),
})

/** The menu bar shortcut (`sideby menubar hotkey`, spec §3.31). */
const hotkeyProps = {
  keys: Type.String({
    description: 'As config `menubar.hotkey` holds it, or the default: `opt+x`, `off`.',
  }),
  label: Type.String({ description: 'As macOS writes it, such as `⌥⌘S`; empty when off.' }),
  enabled: Type.Boolean(),
  isDefault: Type.Boolean(),
  registered: Type.Union([Type.Boolean(), Type.Null()], {
    description:
      'Whether the menu bar item could register it: false means another app or macOS holds it; null when it has not said yet or it is off.',
  }),
  problem: Type.Optional(
    Type.Object(
      { code: Str, message: Str },
      { description: 'A value config allows but a new choice would be refused for; it still works.' },
    ),
  ),
}
const MenubarHotkeyView = Type.Object(hotkeyProps)

/** `sideby autostart` and `sideby menubar` (ADR-0029, ADR-0034, ADR-0055): the login item sideby writes. */
const loginItem = (current: string) =>
  Type.Object({
    schemaVersion: Version,
    supported: Type.Boolean({
      description: 'False on a system sideby cannot start at login yet; `reason` says so.',
    }),
    reason: Type.Optional(Str),
    state: Type.Union(
      ['off', 'on', 'stale', 'foreign'].map((k) => Type.Literal(k)),
      {
        description:
          '`stale`: the Node or sideby it starts no longer exists; `foreign`: a file at that path that sideby did not write.',
      },
    ),
    path: Str,
    mechanism: Type.Optional(
      Type.Union(
        ['launchd', 'xdg', 'wsl-startup'].map((k) => Type.Literal(k)),
        {
          description:
            'How it starts at login: a LaunchAgent (macOS), an XDG autostart entry (Linux desktop sessions), or a script in the Windows Startup folder (WSL). Absent when unsupported.',
        },
      ),
    ),
    programArguments: Type.Optional(Type.Array(Str)),
    current: Type.Boolean({ description: current }),
    missing: Type.Optional(Type.Array(Str)),
    action: Type.Optional(Type.Union([Type.Literal('on'), Type.Literal('off')])),
    changed: Type.Optional(Type.Boolean()),
    applied: Type.Optional(Type.Boolean()),
    content: Type.Optional(Type.String({ description: 'The file `on` writes.' })),
    commands: Type.Optional(Type.Array(Type.Array(Str))),
    loaded: Type.Optional(
      Type.Boolean({
        description:
          'After a change: launchd took it now. In a status of the menu bar item: launchd holds it now; false means it is on but not running until `sideby menubar on` or the next login.',
      }),
    ),
    note: Type.Optional(Str),
    hotkey: Type.Optional(MenubarHotkeyView),
    icon: Type.Optional(
      Type.Object(
        {
          visible: Type.Union([Type.Boolean(), Type.Null()], {
            description:
              'Whether macOS shows the menu bar icon right now: false when it sits behind « (the menu bar is full) or is covered; null when the item has not said in the last 15 minutes.',
          }),
        },
        { description: 'Only while the menu bar item is on.' },
      ),
    ),
  })

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
    pinned: Type.Optional(
      Type.Literal(true, {
        description:
          'Pinned to the top of its family in the Panel and `sideby list` (spec §3.25). Display only; absent when not pinned.',
      }),
    ),
    hidden: Type.Optional(
      Type.Literal(true, {
        description:
          'Hidden from the Panel, the menu bar and the text of `sideby list` (spec §3.25). Display only; set by `sideby list`, absent when shown.',
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
  installCommand: Type.Optional(Str),
  installed: Type.Boolean(),
  brokenBin: Type.Optional(Str),
  plugin: Str,
  tuning: Type.Boolean(),
  settingsFile: Type.Optional(
    Type.String({
      description: "The Host's settings file `sideby edit` opens, relative to the account directory.",
    }),
  ),
  mainOnly: Type.Optional(
    Type.Literal(true, {
      description:
        'The Host keeps one sign-in per computer, so sideby knows only its Main Account and refuses to create others (ADR-0047).',
    }),
  ),
  hidden: Type.Optional(
    Type.Literal(true, {
      description:
        'Hidden from the Panel, the menu bar and the text of `sideby list` (spec §3.25). Display only; set by `sideby list`, absent when shown.',
    }),
  ),
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
      { main: Str, account: Type.Optional(Str) },
      {
        description:
          'Relative to HOME, for example `.claude` and `.claude-<name>`. A Main-only Family has no `account`.',
      },
    ),
    selectVar: Type.Optional(
      Type.String({
        description:
          'Environment variable that selects a non-main Account directory. Left out for a Main-only Family.',
      }),
    ),
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
  name: Type.Optional(
    Type.String({
      description:
        'The group of models this limit covers, when it covers only some (spec §3.26); it does not count toward Quota Pressure.',
    }),
  ),
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
    fetched: Type.Optional(
      Type.Boolean({
        description: 'This reading is the kept answer of a quota check that costs a request (spec §3.26).',
      }),
    ),
    fetchError: Type.Optional(
      Type.String({ description: 'Why the latest quota check failed, while this older reading is shown.' }),
    ),
  }),
  Type.Object({
    status: Type.Literal('unavailable'),
    reason: Type.String({
      description: 'not-enabled, no-session, unrecognized, no-source, api-account or fetch-failed.',
    }),
    detail: Type.Optional(Str),
  }),
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
  upgrade: Type.Optional(
    Type.Boolean({
      description:
        'With `ready`: the setup is already on and only an addition from a newer sideby is missing (Claude: `statusLine.refreshInterval`).',
    }),
  ),
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

/**
 * On any `--json` output when there is something to mention once the task is done (spec §3.23): a newer sideby in the
 * cached Update Check, or an installed sideby skill for another version. Off with SIDEBY_NO_UPDATE_NOTIFIER.
 */
const Notice = Type.Object(
  {
    update: Type.Optional(
      Type.Object({
        current: Str,
        latest: Str,
        command: Type.String({
          description: 'Run it after the user agrees: it shows the plan and exits 10; then --yes.',
        }),
        message: Str,
      }),
    ),
    skill: Type.Optional(
      Type.Object({
        installed: Type.Union([Str, Type.Null()], {
          description: "The skill's version; null when it has none.",
        }),
        current: Str,
        command: Type.String({
          description:
            '`sideby update`, which updates the skill with sideby: run it after the user agrees; it shows the plan and exits 10, then --yes.',
        }),
        message: Str,
      }),
    ),
  },
  { description: 'Not the answer to the task: mention it briefly afterwards and offer to update.' },
)

const Display = Type.Object({
  families: Type.Optional(Type.Array(Str)),
  accounts: Type.Optional(Type.Record(Str, Type.Array(Str))),
  pinned: Type.Optional(Type.Record(Str, Type.Array(Str))),
  hiddenFamilies: Type.Optional(Type.Array(Str)),
  hidden: Type.Optional(Type.Record(Str, Type.Array(Str))),
})
const PinResult = Type.Object({
  schemaVersion: Version,
  ref: Str,
  pinned: Type.Boolean(),
  changed: Type.Boolean(),
  message: Str,
  display: Display,
})
const HideResult = Type.Object({
  schemaVersion: Version,
  target: Type.String({ description: 'The Family id or account ref that was hidden or shown again.' }),
  kind: Type.Union([Type.Literal('family'), Type.Literal('account')]),
  hidden: Type.Boolean(),
  changed: Type.Boolean(),
  message: Str,
  display: Display,
})
const Skipped = Type.Optional(Type.Array(Type.Object({ ref: Str, reason: Str })))
const HandoffSettingsOut = HandoffSettingsSchema
const Takeover = Type.Array(
  Type.Object({
    ref: Str,
    family: Str,
    starts: Type.Array(Type.Union([Type.Literal('quota'), Type.Literal('limit')])),
    decision: Type.Union([
      Type.Object({ kind: Type.Literal('pick'), ref: Str, skipped: Skipped }),
      Type.Object({ kind: Type.Literal('wait'), until: Str }),
      Type.Object({
        kind: Type.Literal('none'),
        reason: Str,
        earliestReset: Type.Optional(Type.Object({ ref: Str, at: Str })),
        skipped: Skipped,
      }),
    ]),
  }),
)
const Overview = Type.Object({
  settings: HandoffSettingsOut,
  takeover: Takeover,
  recent: Type.Array(
    Type.Object({
      from: Str,
      to: Str,
      at: Str,
      trigger: Type.Union([
        Type.Literal('threshold'),
        Type.Literal('limit'),
        Type.Literal('manual'),
        Type.Null(),
      ]),
      briefSource: Type.Union([
        Type.Literal('agent'),
        Type.Literal('sideby'),
        Type.Literal('user'),
        Type.Null(),
      ]),
    }),
  ),
})

const MenubarLevel = Type.Union(['ok', 'warn', 'fail', 'none'].map((k) => Type.Literal(k)))
const MenubarBar = Type.Union([
  Type.Object({ label: Str, percent: Type.Number(), level: MenubarLevel }),
  Type.Null(),
])
const MenubarRow = Type.Object({
  ref: Str,
  label: Str,
  detail: Type.String({ description: 'The whole row as one line of text.' }),
  level: MenubarLevel,
  recommended: Type.Boolean({ description: 'The account `sideby next` would pick in this Family.' }),
  observedAt: Type.Union([Str, Type.Null()], { description: 'When the quota was observed, not checked.' }),
  stale: Type.Boolean({ description: 'The quota is old, undated, or its last query failed.' }),
  tip: Type.String({
    description:
      "Hover text: when the numbers were read, each window's use and reset, and what a click does.",
  }),
  bars: Type.Union([Type.Tuple([MenubarBar, MenubarBar]), Type.Null()], {
    description:
      'The shorter window, then the longer one; a single window fills the second. Null without quota.',
  }),
  groups: Type.Union(
    [
      Type.Array(
        Type.Object({
          label: Str,
          bars: Type.Union([Type.Tuple([MenubarBar, MenubarBar]), Type.Null()]),
          reset: Str,
          tip: Str,
        }),
      ),
      Type.Null(),
    ],
    {
      description:
        "A Host whose every limit covers one model group: a line per group under the account, each with its own bars; the account's `bars` are then null.",
    },
  ),
  reset: Type.String({
    description: 'Until the fullest window resets, such as `4d 17h`; empty when nothing is used.',
  }),
  note: Type.String({
    description: 'A no-quota explanation, or an old-reading warning beside the bars.',
  }),
})

const MessageReceipt = Type.Object({
  id: Type.String({
    description: 'Short id, also in the delivered text, so the target record shows when it was read.',
  }),
  to: Type.String({ description: "The target session's Session Label." }),
  toSessionId: Str,
  toAccount: Type.String({ description: 'The account ref that holds the target session.' }),
  from: Type.Optional(
    Type.String({ description: 'The Session Label of the session that sent it, when sideby could tell.' }),
  ),
  status: Type.Union(
    ['stored', 'delivered', 'read', 'paste-needed'].map((k) => Type.Literal(k)),
    {
      description:
        "stored: kept as a file only; delivered: the host's own channel took it; read: it shows in the target's record; paste-needed: the user pastes pasteText into the target.",
    },
  ),
  file: Type.String({ description: "The Message file (mode 600) in sideby's state folder." }),
  attachments: Type.Array(Str, { description: 'Screenshots copied next to the Message file.' }),
  pasteText: Type.String({ description: 'One line that tells the target AI to read the Message file.' }),
  note: Type.Optional(
    Type.String({ description: 'Why a paste is needed, or that the target must approve it (bypass mode).' }),
  ),
  needsApproval: Type.Optional(
    Type.Boolean({
      description:
        'true while a delivered Message waits for the user to approve it in the target terminal (ADR-0045); dropped once it is read, and after 6 minutes unread the status becomes paste-needed.',
    }),
  ),
  sentAt: Str,
  handedOverFrom: Type.Optional(
    Type.String({
      description:
        'The session id that was named, when an Auto Handoff chain led from it to this target (ADR-0057).',
    }),
  ),
})

const IndexState = Type.Union(
  ['building', 'ready', 'off', 'unavailable'].map((k) => Type.Literal(k)),
  {
    description:
      '`building`: the History Index is still reading files (what is built answers already); `off`: config `history.index` is false or the index file could not be opened, so only titles and folders are searched; `unavailable`: this Node has no `node:sqlite`.',
  },
)
const IndexProgressCount = Type.Object(
  { done: Type.Integer(), total: Type.Integer() },
  { description: 'Files read in the current build of the History Index, and how many it has to read.' },
)
const HistorySource = Type.Object(
  {
    account: Str,
    accountLabel: Str,
    family: Str,
    sessions: Type.Integer({ description: 'Sessions stored for the account.' }),
    files: Type.Integer({ description: 'Session record files found.' }),
    failed: Type.Integer({ description: 'Record files that could not be read.' }),
    note: Type.Optional(
      Type.String({ description: 'Why the account has no sessions or could not be listed, in plain words.' }),
    ),
    reason: Type.Optional(
      Type.Union(
        [
          Type.Literal('empty'),
          Type.Literal('no-conversation'),
          Type.Literal('unreadable'),
          Type.Literal('unsupported'),
        ],
        {
          description:
            '`note` as a code: no record files, records without a conversation, a folder that could not be read, or a tool sideby reads no history for.',
        },
      ),
    ),
  },
  { description: 'How many sessions sideby read from one account.' },
)
const HistorySession = Type.Object({
  account: Type.String({ description: 'The Account ref, for example `claude:work`.' }),
  accountLabel: Type.String({ description: "The account's short command when it has one, else its ref." }),
  family: Str,
  sessionId: Type.String({ description: "The host's own session id." }),
  title: Type.String({
    description:
      "The Session Title: the name the user gave it, else the host's title, else the first prompt; may be empty.",
  }),
  titleFrom: Type.Union(['user', 'host', 'prompt', 'none'].map((k) => Type.Literal(k))),
  project: Type.String({
    description:
      'The Project: the git repository root of the working directory (worktrees folded in), else the folder.',
  }),
  projectName: Type.String({
    description: 'Its folder name, with the parent folder when two Projects share one.',
  }),
  cwd: Type.String({ description: 'The working directory the session ran in; may be empty.' }),
  cwdGone: Type.Optional(Type.Boolean({ description: 'True when that folder no longer exists.' })),
  branch: Type.Optional(Str),
  model: Type.Optional(Str),
  startedAt: Type.String({ description: 'ISO time; empty when the record gives none.' }),
  updatedAt: Type.String({ description: 'Last activity, ISO time; empty when the record gives none.' }),
  messages: Type.Integer({ description: 'Prompts plus replies.' }),
  script: Type.Boolean({ description: 'A Script Session: started by a script, an SDK or another agent.' }),
  parent: Type.Optional(
    Type.String({ description: 'For a subagent session: the session id that started it.' }),
  ),
  children: Type.Integer({ description: 'Subagent sessions it started.' }),
  preview: Type.Optional(
    Type.String({
      description: 'The first prompt on one line (at most 240 characters), when it says more than the title.',
    }),
  ),
  snippet: Type.Optional(
    Type.String({ description: 'Where the words matched, about 40 characters each side.' }),
  ),
  foundIn: Type.Optional(
    Type.Literal('tools', { description: '`tools` when the words matched only its tool output (--tools).' }),
  ),
  live: Type.Boolean({ description: 'True while the session is running.' }),
  transcript: Type.String({ description: "Path of the session's record." }),
  resumeCommand: Type.String({ description: 'The command that resumes it in the account that holds it.' }),
  continueCommand: Type.String({
    description:
      '`cd <cwd> && <resumeCommand>` (only the resume command when the folder is gone): continue it where it was.',
  }),
  reference: Type.String({
    description:
      'The Session Reference in English: one sentence that points another AI at the session and its record.',
  }),
  group: Type.Optional(
    Type.String({ description: 'With --group: the key of the group the session is listed under.' }),
  ),
})

const HistoryCategories = Type.Object(
  {
    label: Type.String({
      description: 'What the categories are called on screen; "Category" when the plugin gives none.',
    }),
    from: Type.String({ description: 'The plugin that sorts Projects into them.' }),
  },
  { description: 'Set when a plugin sorts Projects into Project Categories (ADR-0044).' },
)

export const OUTPUT_SCHEMAS: Record<string, TSchema> = {
  pin: PinResult,
  unpin: PinResult,
  order: Type.Object({
    schemaVersion: Version,
    display: Display,
    families: Type.Array(
      Type.Object({
        family: Str,
        hidden: Type.Boolean(),
        accounts: Type.Array(
          Type.Object({ name: Str, ref: Str, pinned: Type.Boolean(), hidden: Type.Boolean() }),
        ),
      }),
    ),
  }),
  hide: HideResult,
  unhide: HideResult,
  'quota-check': Type.Object({
    schemaVersion: Version,
    family: Str,
    on: Type.Boolean(),
    changed: Type.Boolean(),
  }),
  'update-auto': Type.Object({ schemaVersion: Version, auto: Type.Boolean(), changed: Type.Boolean() }),
  local: Type.Object(
    {
      schemaVersion: Version,
      running: Type.Union([Type.Literal('local'), Type.Literal('npm'), Type.Null()], {
        description:
          'What the global sideby runs: the Local Build, an npm package, or neither (not an npm global install).',
      }),
      local: Type.Union(
        [Type.Object({ commit: Str, dirty: Type.Boolean(), builtAt: Str, version: Str }), Type.Null()],
        {
          description: 'The newest Local Build, the one `on` switches to; null when `pnpm local` never ran.',
        },
      ),
      kept: Type.Union([Str, Type.Null()], {
        description: 'The npm package version kept aside while a Local Build runs.',
      }),
      to: Type.Optional(Type.Union([Type.Literal('local'), Type.Literal('npm')])),
      switched: Type.Boolean({
        description: 'A switch ran and succeeded; false for status, a preview (exit 10) or a failure.',
      }),
      blocked: Type.Optional(Type.String({ description: 'Why the switch cannot run, with what to do.' })),
      message: Type.Optional(Str),
      restartedPanel: Type.Optional(Type.Boolean()),
      skillSynced: Type.Optional(
        Type.Boolean({
          description:
            'Back on npm, `sideby update --skill --yes` brought the sideby skill to that version (true) or failed (false).',
        }),
      ),
    },
    { title: 'sideby local --json' },
  ),
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
      action: Type.Union([
        Type.Literal('status'),
        Type.Literal('on'),
        Type.Literal('off'),
        Type.Literal('undo'),
      ]),
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
      overview: Type.Optional(Overview),
      apiUndecided: Type.Optional(
        Type.Boolean({
          description:
            'Auto Handoff was on with API accounts before they became opt-in (ADR-0046): ask the user once whether they may take over, then set handoff.api.',
        }),
      ),
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
          settings: HandoffSettingsOut,
          nextSteps: Type.Array(Str),
        },
        { title: `sideby handoff ${sub} --json` },
      ),
    ]),
  ),
  'handoff-rules': Type.Object(
    {
      schemaVersion: Version,
      auto: Type.Boolean(),
      rules: Type.Array(
        Type.Object({
          id: Type.Union(
            (
              [
                'when',
                'windows',
                'takeover',
                'wait',
                'sameFamily',
                'otherFamilies',
                'api',
                'organization',
                'order',
                'countdown',
              ] as const
            ).map((id) => Type.Literal(id)),
          ),
          params: Type.Record(Str, Type.Unknown(), {
            description: 'What the sentence needs, such as numbers.',
          }),
          settings: Type.Array(Str, {
            description: 'The `handoff` config keys that change it; empty when fixed.',
          }),
          text: Type.String({ description: 'The rule in plain English.' }),
        }),
      ),
      apiUndecided: Type.Boolean({
        description:
          'Auto Handoff was on with API accounts before they became opt-in (ADR-0046): ask the user once, then set handoff.api.',
      }),
      takeover: Takeover,
    },
    { title: 'sideby handoff rules --json' },
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
      pickCommandOffer: Type.Optional(
        Type.Object(
          { name: Str, command: Str, shadows: Type.Optional(Str) },
          {
            description:
              'Set once, when this is the Family’s second subscription account and it has no pick command: the command that adds one.',
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
      status: Type.Union(
        [
          Type.Literal('added'),
          Type.Literal('exists'),
          Type.Literal('removed'),
          Type.Literal('absent'),
          Type.Literal('confirm'),
        ],
        {
          description:
            '`confirm` (exit 10): the pick command would hide a command on PATH, so nothing was written; run again with `--yes`.',
        },
      ),
      kind: Type.Optional(
        Type.Union([Type.Literal('account'), Type.Literal('pick')], {
          description: '`pick` for a Pick Command (`--pick`), `account` for a short command of one Account.',
        }),
      ),
      account: Type.Optional(Str),
      args: Type.Optional(Type.Array(Str, { description: 'Host arguments `sideby run <alias>` adds.' })),
      family: Type.Optional(Type.String({ description: 'The Family a Pick Command picks in.' })),
      shadows: Type.Optional(
        Type.String({
          description: 'The command on PATH this Pick Command hides in the shell, such as /usr/bin/cc.',
        }),
      ),
      shellInitFiles: Type.Optional(ShellInitFiles),
    },
    { title: 'sideby alias add|rm --json' },
  ),
  'shell-init-setup': Type.Object(
    {
      schemaVersion: Version,
      shell: Type.Union([Type.Literal('zsh'), Type.Literal('bash')]),
      rc: Type.String({ description: 'The rc file, with ~ for the home folder.' }),
      status: Type.Union(
        [
          Type.Literal('loaded'),
          Type.Literal('confirm'),
          Type.Literal('added'),
          Type.Literal('removed'),
          Type.Literal('not-added'),
        ],
        {
          description:
            '`loaded`: new terminals already load the short commands. `confirm` (exit 10): nothing written; `block` is what --yes appends. `not-added`: --undo found no line sideby added.',
        },
      ),
      block: Type.Optional(Type.String()),
    },
    { title: 'sideby shell-init setup --json' },
  ),
  'alias-list': Type.Object(
    {
      schemaVersion: Version,
      shortCommands: Type.Array(
        Type.Object({
          name: Str,
          kind: Type.Union([Type.Literal('account'), Type.Literal('pick')]),
          account: Type.Optional(
            Type.String({ description: 'The Account a short command of kind `account` starts.' }),
          ),
          args: Type.Optional(Type.Array(Str)),
          family: Type.Optional(Type.String({ description: 'The Family a Pick Command picks in.' })),
        }),
      ),
    },
    { title: 'sideby alias list --json' },
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
  commands: Type.Object(
    {
      schemaVersion: Version,
      results: Type.Array(
        Type.Object({
          id: Str,
          kind: Type.String({
            description: "'page', 'setting' or 'action'; an open set, so tolerate others.",
          }),
          title: Str,
          panel: Type.String({
            description: 'Where it lives in the Panel, such as "Settings → General → Language".',
          }),
          cliCommand: Type.Union([Str, Type.Null()]),
        }),
      ),
    },
    { title: 'sideby commands --json' },
  ),
  'commands-list': Type.Object(
    {
      schemaVersion: Version,
      common: Type.Array(Str, { description: 'Ids of the common commands, most common first.' }),
      groups: Type.Array(
        Type.Object({
          id: Type.String({ description: "A task group such as 'accounts' or 'quota'; an open set." }),
          title: Str,
          commands: Type.Array(
            Type.Object({
              id: Type.String({ description: "Stable, such as 'run' or 'handoff.enable'." }),
              usage: Type.String({ description: 'The command line as `sideby --help` shows it.' }),
              description: Str,
              example: Type.Union([Str, Type.Null()]),
              featureId: Type.Union([Str, Type.Null()], {
                description: 'The `sideby commands <words>` result id of its place in the Panel, or null.',
              }),
              panel: Type.Union([Str, Type.Null()], {
                description: 'Where it lives in the Panel, such as "Settings → General → Language", or null.',
              }),
            }),
          ),
        }),
      ),
    },
    { title: 'sideby commands --json (no words): the Command List' },
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
  sessions: Type.Object(
    {
      schemaVersion: Version,
      sessions: Type.Array(
        Type.Object({
          account: Type.String({ description: 'The Account ref, for example `claude:002`.' }),
          accountLabel: Type.String({
            description:
              "The account's short name: its short command when it has one (`cc002`), else its ref.",
          }),
          family: Str,
          sessionId: Type.String({ description: "The host's own session id." }),
          handedOverFrom: Type.Optional(
            Type.Array(Str, {
              description:
                "When an Auto Handoff chain led to this session: the earlier hops' session ids, oldest first (ADR-0057).",
            }),
          ),
          title: Type.String({
            description:
              "The host's own title for the session, or its working directory name when the host gives none; may be empty.",
          }),
          label: Type.String({
            description: 'The Session Label: `<accountLabel> · <title> · <first 8 of sessionId>`.',
          }),
          status: Type.Union(
            ['needs-you', 'busy', 'idle', 'unknown'].map((k) => Type.Literal(k)),
            {
              description:
                '`needs-you`: it waits for the user (a permission or a question); `unknown` where the host does not say.',
            },
          ),
          cwd: Type.Optional(Str),
          pid: Type.Optional(Type.Integer({ description: 'The host process running it.' })),
          startedAt: Type.Optional(Str),
          updatedAt: Type.Optional(Type.String({ description: 'Its most recent activity.' })),
          guessed: Type.Boolean({
            description:
              "True when sideby could not tie a running program to the session and took the account's newest one (Codex, pi).",
          }),
          transcript: Type.Optional(Type.String({ description: "Path of the session's record." })),
          reference: Type.String({
            description:
              'The Session Reference in English: one sentence that points another AI at the session and its record.',
          }),
          resumeCommand: Type.String({
            description: 'The command that resumes it in the account that holds it.',
          }),
          run: Type.Optional(
            Type.Object(
              {
                title: Type.String({ description: "The Run's title." }),
                laneTitle: Type.Optional(
                  Type.String({ description: 'The part of the Run this session does.' }),
                ),
                role: Type.Optional(
                  Type.String({
                    description: 'Its role in the Run, for example coordinator, write or review.',
                  }),
                ),
                board: Type.String({
                  description: "The Run Board, a static HTML file in the orchestrator's state folder.",
                }),
                url: Type.String({
                  description: '`file://<board>`, with `#lane-<id>` for the part this session does.',
                }),
                others: Type.Optional(
                  Type.Array(
                    Type.Object({
                      title: Str,
                      laneTitle: Type.Optional(Str),
                      role: Type.Optional(Str),
                      board: Str,
                    }),
                    { description: 'Other Runs the session also works for, after this one (by role).' },
                  ),
                ),
              },
              {
                description:
                  "The Run of a local orchestrator this session works for, from the orchestrator's Session Index (spec §3.32 step 2b); only when the index lists the session and its board file checks out. With several, the first by role (coordinator, write, review, research, other).",
              },
            ),
          ),
        }),
        { description: 'Running sessions, those that need the user first, then by most recent activity.' },
      ),
      problems: Type.Array(Str, {
        description: 'An account or family that could not be read, and what to do; never aborts the listing.',
      }),
    },
    { title: 'sideby sessions --json' },
  ),
  'sessions-open-run': Type.Object(
    {
      schemaVersion: Version,
      opened: Type.Literal(true, {
        description: 'The Run Board was handed to the default program; a failure is an error instead.',
      }),
      board: Type.String({ description: 'The Run Board file opened, with the home folder as ~.' }),
      sessionId: Str,
      label: Type.String({ description: 'The Session Label of the session whose run report was opened.' }),
      handedOverFrom: Type.Optional(
        Type.String({
          description:
            'The session id that was named, when an Auto Handoff chain led from it to this session (ADR-0057).',
        }),
      ),
    },
    { title: 'sideby sessions open-run --json' },
  ),
  'sessions-copy': Type.Object(
    {
      schemaVersion: Version,
      copied: Type.Boolean({
        description:
          'Whether the text went onto the clipboard; false when no clipboard program is installed.',
      }),
      as: Type.Union([Type.Literal('reference'), Type.Literal('id'), Type.Literal('resume')]),
      text: Type.String({ description: 'The text copied, also when it could not be.' }),
      sessionId: Str,
      label: Type.String({ description: 'The Session Label of the session copied.' }),
      handedOverFrom: Type.Optional(
        Type.String({
          description:
            'The session id that was named, when an Auto Handoff chain led from it to this session (ADR-0057).',
        }),
      ),
    },
    { title: 'sideby sessions copy --json' },
  ),
  history: Type.Object(
    {
      schemaVersion: Version,
      sessions: Type.Array(HistorySession, {
        description:
          'Sessions best match first (relevance times recency), or newest first without words; subagent sessions are counted in their parent. Matches found only in tool output (--tools) come last.',
      }),
      total: Type.Integer({
        description: 'All matching sessions; more than `sessions` when --limit or --offset cut the list.',
      }),
      index: Type.Object({ state: IndexState, progress: IndexProgressCount }),
      sources: Type.Array(HistorySource),
      problems: Type.Array(Str, {
        description: 'An account or file that could not be read, and what to do; never aborts the listing.',
      }),
      groups: Type.Optional(
        Type.Array(
          Type.Object({
            key: Type.String({
              description:
                'The Project path, category name, Account ref, Family id or day (`today`, `yesterday`, `week`, `month`, `older`); empty for sessions without one.',
            }),
            label: Str,
            sessions: Type.Integer({ description: 'Matching sessions in the group, collapsed or not.' }),
            updatedAt: Str,
            collapsed: Type.Optional(
              Type.Boolean({
                description: 'True when its sessions were left out of `sessions` (folded in the Panel).',
              }),
            ),
          }),
          {
            description:
              'With --group (not `none`): every group of the matches, best first and the one without a key last; days in time order.',
          },
        ),
      ),
      categories: Type.Optional(HistoryCategories),
      toolOutputMore: Type.Optional(
        Type.Literal(true, {
          description:
            'With --tools: more sessions matched in tool output than the page holds; a larger --limit lists them.',
        }),
      ),
    },
    { title: 'sideby history --json' },
  ),
  'history-show': Type.Object(
    {
      schemaVersion: Version,
      session: HistorySession,
      messages: Type.Array(
        Type.Object({
          n: Type.Integer({ description: 'Position in the session, from 1.' }),
          role: Type.Union([Type.Literal('user'), Type.Literal('assistant'), Type.Literal('tool')]),
          text: Type.String({
            description: 'For `tool`: only the tool name; its input and output are never shown.',
          }),
          at: Type.Optional(Str),
          tool: Type.Optional(Str),
        }),
        { description: 'Oldest first: the newest --limit (default 200) before --before.' },
      ),
      before: Type.Optional(
        Type.Integer({
          description: 'Pass as --before for the messages before these; absent at the first message.',
        }),
      ),
    },
    { title: 'sideby history show --json' },
  ),
  'history-projects': Type.Object(
    {
      schemaVersion: Version,
      projects: Type.Array(
        Type.Object({
          project: Type.String({ description: 'The Project path; empty for sessions without a folder.' }),
          name: Str,
          sessions: Type.Integer({ description: 'Top-level sessions, Script Sessions not counted.' }),
          updatedAt: Str,
          gone: Type.Optional(
            Type.Boolean({ description: 'True when every session ran in a folder that is gone.' }),
          ),
          category: Type.Optional(
            Type.String({ description: 'Its Project Category, when a plugin sorts Projects into them.' }),
          ),
        }),
        { description: 'Most recent activity first.' },
      ),
      categories: Type.Optional(HistoryCategories),
    },
    { title: 'sideby history projects --json' },
  ),
  'history-index': Type.Object(
    {
      schemaVersion: Version,
      enabled: Type.Boolean({ description: 'False under config `history.index: false`.' }),
      path: Type.String({ description: "The History Index file (mode 600) in sideby's state folder." }),
      state: IndexState,
      progress: IndexProgressCount,
      files: Type.Integer({ description: 'Session record files known.' }),
      sessions: Type.Integer({ description: 'Sessions stored, subagent sessions included.' }),
      bytes: Type.Integer({ description: 'Size of the index file and its journal; 0 when off.' }),
      sources: Type.Array(HistorySource),
      cleared: Type.Optional(
        Type.Boolean({ description: 'With --clear: whether there was a file to delete.' }),
      ),
    },
    { title: 'sideby history index --json' },
  ),
  send: Type.Object(
    {
      schemaVersion: Version,
      message: MessageReceipt,
      copied: Type.Boolean({
        description:
          'Whether pasteText went onto the clipboard; only tried when status is paste-needed, false otherwise.',
      }),
    },
    { title: 'sideby send --json' },
  ),
  messages: Type.Object(
    {
      schemaVersion: Version,
      messages: Type.Array(MessageReceipt, {
        description: 'Messages sideby kept, newest first (20 unless --limit says otherwise).',
      }),
    },
    { title: 'sideby messages --json' },
  ),
  'messages-inbound': Type.Object(
    {
      schemaVersion: Version,
      action: Type.Union([Type.Literal('status'), Type.Literal('accept'), Type.Literal('undo')]),
      applied: Type.Optional(Type.Boolean({ description: 'True once the change was written (or undone).' })),
      groups: Type.Optional(
        Type.Array(
          Type.Object({
            file: Str,
            accounts: Type.Array(Str, { description: 'Claude accounts whose settings.json is this file.' }),
            state: Type.Union(
              ['accept', 'hold', 'refuse', 'default', 'other', 'missing', 'blocked'].map((k) =>
                Type.Literal(k),
              ),
              {
                description:
                  'crossSessionInbound is accept, hold or refuse; default: not set (bypass sessions hold messages); other: a value sideby does not know; missing: no settings.json; blocked: cannot be changed safely (see reason).',
              },
            ),
            reason: Type.Optional(Str),
            undo: Type.Boolean({ description: 'sideby set it here and can put the earlier value back.' }),
            change: Type.Optional(
              Type.Object(
                {
                  key: Type.Literal('crossSessionInbound'),
                  from: Type.Union([Str, Type.Null()], { description: 'Its value now; null: not set.' }),
                  to: Type.Literal('accept'),
                },
                { description: 'In an accept preview: the one key this file gets and its new value.' },
              ),
            ),
          }),
          { description: 'For status, every file; for a preview, the files that would change.' },
        ),
      ),
      leftAlone: Type.Optional(
        Type.Array(
          Type.Object({
            file: Str,
            accounts: Type.Array(Str),
            state: Str,
            reason: Type.Optional(Str),
            undo: Type.Boolean(),
          }),
          {
            description:
              'In a preview: the files accept never changes (refuse, an unknown value, blocked, no settings.json), each with its reason.',
          },
        ),
      ),
      results: Type.Optional(
        Type.Array(Type.Object({ file: Str, accounts: Type.Array(Str), ok: Type.Boolean(), message: Str })),
      ),
      message: Type.Optional(Str),
    },
    { title: 'sideby messages inbound [accept|undo] --json' },
  ),
  edit: Type.Object(
    {
      schemaVersion: Version,
      ref: Str,
      family: Str,
      file: Type.String({
        description: 'The settings file as the family names it, such as `settings.json`.',
      }),
      path: Type.String({ description: 'The file inside the account directory.' }),
      target: Type.Optional(
        Type.String({ description: 'Where the file really is; only when `path` is a link.' }),
      ),
      sharedWith: Type.Array(Str, {
        description:
          'Other accounts of the family whose settings file is this same file, so a change applies to them too.',
      }),
      opened: Type.Boolean({ description: 'False with --path, which only says where the file is.' }),
      command: Type.Optional(
        Type.Array(Str, { description: 'The program and arguments that opened the file.' }),
      ),
    },
    { title: 'sideby edit --json' },
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
  network: Type.Object(
    {
      schemaVersion: Version,
      guard: Type.Boolean({ description: 'Config `network.guard`: Network Guard is switched on.' }),
      allow: Type.Array(Str, {
        description: 'Allowed countries (ISO 3166-1 alpha-2), config `network.allow`.',
      }),
      active: Type.Boolean({
        description: 'It checks Launches now: switched on, a country allowed, and not in CI.',
      }),
      ci: Type.Boolean({ description: 'Running in CI, where it makes no request and checks nothing.' }),
      targets: Type.Array(
        Type.Object({
          url: Type.String({ description: 'The `/cdn-cgi/trace` address asked.' }),
          accounts: Type.Array(Str, { description: 'Refs of the accounts checked at this address.' }),
          status: Type.Union(
            [
              Type.Literal('ok'),
              Type.Literal('blocked'),
              Type.Literal('unknown'),
              Type.Literal('not-checked'),
            ],
            {
              description:
                'ok: the country is allowed; blocked: it is not; unknown: the last check could not tell (it blocks); not-checked: no result yet.',
            },
          ),
          loc: Type.Optional(
            Type.String({ description: 'The country the vendor sees, from the newest result.' }),
          ),
          checkedAt: Type.Optional(Type.String({ description: 'When the newest result was asked (ISO).' })),
          error: Type.Optional(Type.String({ description: 'Why the newest check could not tell.' })),
          ipChanged: Type.Boolean({
            description: 'The exit address changed in the last day (a notice only).',
          }),
        }),
      ),
      accounts: Type.Array(
        Type.Object({
          ref: Str,
          url: Type.Optional(Type.String({ description: 'The address this account is checked at.' })),
          skip: Type.Optional(
            Type.Union(
              [Type.Literal('not-covered'), Type.Literal('third-party'), Type.Literal('at-launch')],
              {
                description:
                  'third-party: an API account on another endpoint, not checked; at-launch: an API account, whose address is known only when it starts.',
              },
            ),
          ),
        }),
      ),
    },
    { title: 'sideby network [check] --json' },
  ),
  'network-set': Type.Object(
    {
      schemaVersion: Version,
      changed: Type.Boolean(),
      applied: Type.Boolean({
        description: 'False when only the change was shown; run again with --yes (exit 10).',
      }),
      file: Type.String({ description: 'The config file changed.' }),
      before: Type.Object({ guard: Type.Boolean(), allow: Type.Array(Str) }),
      after: Type.Object({ guard: Type.Boolean(), allow: Type.Array(Str) }),
    },
    { title: 'sideby network on|off|allow --json' },
  ),
  unattended: Type.Object(
    {
      schemaVersion: Version,
      on: Type.Boolean({ description: 'Unattended Mode is on now.' }),
      reason: Type.Union(
        [
          Type.Literal('slot'),
          Type.Literal('manual'),
          Type.Literal('session'),
          Type.Literal('paused'),
          Type.Literal('off'),
        ],
        {
          description:
            'slot: a Slot of the Schedule turned it on; manual: the user did; session: only this session, started with --unattended; paused: off until the current Slot ends; off.',
        },
      ),
      until: Type.Optional(
        Type.String({
          description:
            'When it turns off (on), or when the pause ends (paused); ISO. Absent for a session alone, and when the Schedule covers every hour (on with no end, or paused until `on`).',
        }),
      ),
      slot: Type.Optional(
        Type.String({ description: 'The Slot it is in: its name, or its days and times when it has none.' }),
      ),
      slotNumber: Type.Optional(
        Type.Integer({ description: 'That Slot’s number in `schedule`, from 1.', minimum: 1 }),
      ),
      next: Type.Optional(
        Type.Object(
          {
            at: Type.String({ description: 'ISO.' }),
            slot: Str,
            slotNumber: Type.Optional(Type.Integer({ minimum: 1 })),
          },
          { description: 'The next time a Slot turns it on by itself.' },
        ),
      ),
      configured: Type.Boolean({
        description:
          'The config has an `unattended` section, so sideby adds its hook to the Claude and Codex sessions it starts.',
      }),
      schedule: Type.Array(UnattendedSlotSchema, {
        description: 'Config `unattended.schedule`, numbered from 1.',
      }),
      pending: Type.Integer({ description: 'Open Pending Decisions (`sideby unattended pending`).' }),
      coverage: Type.Record(
        Str,
        Type.Union([Type.Literal('covered'), Type.Literal('needs-trust'), Type.Literal('not-covered')]),
        {
          description:
            'Per family: covered (sessions sideby starts get the hook), needs-trust (Codex runs it once the user trusts it in /hooks), not-covered (no hook sideby can add, or the feature was never used).',
        },
      ),
      slotEnd: Type.Optional(
        Type.String({
          description:
            'When `on --slot-end` would end: the end of the current or next Slot, when that is within 72 hours; ISO.',
        }),
      ),
      manual: Type.Optional(
        Type.Object(
          {
            mode: Type.Union([Type.Literal('on'), Type.Literal('pause')]),
            until: Type.Optional(
              Type.String({
                description:
                  'ISO. Absent only for a pause made while the Schedule covers every hour: it lasts until `on`.',
              }),
            ),
            at: Type.String({ description: 'When the user chose it; ISO.' }),
          },
          { description: 'The manual state in effect now: on until, or paused until.' },
        ),
      ),
      problem: Type.Optional(
        Type.String({
          description:
            'Why sideby cannot keep its state: `<state>/unattended` is a link, someone else’s, or writable by others. Says what to do.',
        }),
      ),
      changed: Type.Optional(
        Type.Boolean({ description: 'Set by on, off and schedule changes: whether anything changed.' }),
      ),
      undo: Type.Optional(
        Type.String({ description: 'The command that puts back what the change replaced.' }),
      ),
    },
    { title: 'sideby unattended [on|off|schedule …] --json' },
  ),
  'unattended-pending': Type.Object(
    {
      schemaVersion: Version,
      pending: Type.Array(PendingDecision, {
        description: 'Open Pending Decisions, oldest first; with --all the done ones too.',
      }),
      done: Type.Optional(Type.Array(Str, { description: '`pending done`: the ids marked done.' })),
    },
    { title: 'sideby unattended pending [done <id>|--all] --json' },
  ),
  'unattended-defer': Type.Object(
    { schemaVersion: Version, decision: PendingDecision },
    { title: 'sideby unattended defer "<text>" --json' },
  ),
  browser: Type.Object(
    {
      schemaVersion: Version,
      enabled: Type.Boolean({
        description:
          'config `browser.signIns`. When false nothing of the browser was read and `profiles` is empty.',
      }),
      browser: Type.String({ description: 'The browser read, `Google Chrome`.' }),
      found: Type.Boolean({ description: "Chrome's user data folder exists on this Mac." }),
      profiles: Type.Array(
        Type.Object({
          dir: Type.String({ description: "The browser user's folder, such as `Default` or `Profile 7`." }),
          name: Type.String({ description: 'The name Chrome shows; it may be an email.' }),
          email: Type.Optional(
            Type.String({ description: 'The Google account this browser user is signed in to Chrome with.' }),
          ),
          signIns: Type.Array(Str, {
            description:
              "Refs of the accounts this browser user signed in to on the vendor's website, as far as its local data shows; it may be left over from before a sign-out. When several browser users show one account, only those whose Google account is the account's login email are kept; an account found nowhere gets the one browser user whose Google account is its login email. A user's choice replaces all of this.",
          }),
          changedAt: Type.Optional(
            Type.String({ description: 'When its Local Storage last changed (ISO 8601).' }),
          ),
        }),
        { description: 'Most recently changed first.' },
      ),
      families: Type.Object({
        matched: Type.Array(Str, {
          description:
            'Families whose accounts can be matched (claude, codex, and plugin families whose `website` has `match`).',
        }),
        openOnly: Type.Array(Str, {
          description: 'Families that can only be opened in a browser user given with --profile (grok).',
        }),
      }),
      sites: Type.Record(Str, Str, {
        description: 'Family → the https address its accounts open, for the families above.',
      }),
      choices: Type.Record(Str, Str, {
        description:
          "Account ref → the folder of the browser user the user chose for it (`sideby browser set`); such an account is in that profile's `signIns` alone. A choice whose folder is gone is left out and named in `problems`.",
      }),
      problems: Type.Array(Str),
    },
    { title: 'sideby browser --json' },
  ),
  'browser-set': Type.Object(
    {
      schemaVersion: Version,
      ref: Str,
      profile: Type.Union([Type.Object({ dir: Str, name: Str }), Type.Null()], {
        description: 'The browser user now chosen, or null with --auto (sideby finds it again by itself).',
      }),
      changed: Type.Boolean({ description: 'False when config already said so.' }),
    },
    { title: 'sideby browser set --json' },
  ),
  'browser-switch': Type.Object(
    {
      schemaVersion: Version,
      enabled: Type.Boolean({ description: 'The value asked for.' }),
      changed: Type.Boolean(),
      applied: Type.Boolean({
        description: 'False when only the change was shown; run again with --yes (exit 10).',
      }),
      file: Type.String({ description: 'The config file.' }),
      reads: Type.Array(Str, { description: 'What sideby reads while it is on, all on this computer.' }),
    },
    { title: 'sideby browser --enable|--disable --json' },
  ),
  'browser-open': Type.Object(
    {
      schemaVersion: Version,
      ref: Str,
      url: Str,
      profile: Type.Object({ dir: Str, name: Str }),
      command: Type.Array(Str, { description: 'The `open` command sideby ran.' }),
    },
    { title: 'sideby browser open --json' },
  ),
  update: Type.Object(
    {
      schemaVersion: Version,
      current: Type.String({ description: 'The running sideby version.' }),
      latest: Type.String({ description: 'The `latest` version on the npm registry.' }),
      available: Type.Boolean({ description: '`latest` is newer than `current`.' }),
      method: Type.Object({
        kind: Type.Union(
          ['npm', 'pnpm', 'bun', 'volta', 'npx', 'project', 'source', 'local'].map((k) => Type.Literal(k)),
          { description: 'How this copy was installed.' },
        ),
        canUpdate: Type.Boolean({ description: 'sideby can run the Update itself.' }),
        reason: Type.Optional(Type.String({ description: 'Why it cannot.' })),
        reasonCode: Type.Optional(ReasonCode),
        reasonAt: Type.Optional(
          Type.String({ description: 'The folders that are not writable (`not-writable`).' }),
        ),
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
      refreshedApp: Type.Optional(
        Type.Boolean({
          description:
            'The desktop app (`sideby app install`) was installed and was written again by the new version.',
        }),
      ),
      refreshedAutostart: Type.Optional(
        Type.Boolean({
          description:
            'A login item (`sideby autostart on`) was installed and now starts the new version (false: that failed). Absent without one.',
        }),
      ),
      skill: Type.Optional(
        Type.String({ description: 'The command that installs the sideby skill by hand.' }),
      ),
      skillUpdate: Type.Optional(
        Type.Object(
          {
            installed: Type.Array(Type.Union([Str, Type.Null()]), {
              description: 'Versions of the installed sideby skills; null for one without a version.',
            }),
            outdated: Type.Boolean({
              description: 'Some installed skill is for another version than sideby will run.',
            }),
            command: Str,
            canRun: Type.Boolean({
              description: 'False when sideby leaves the skill alone (see reason): give the user command.',
            }),
            reason: Type.Optional(Str),
            reasonCode: Type.Optional(ReasonCode),
            reasonAt: Type.Optional(
              Type.String({ description: 'The git repository that owns the skill (`skill-in-git`).' }),
            ),
          },
          {
            description:
              'The installed sideby skill, which the Update brings along; absent when none is installed.',
          },
        ),
      ),
      skillUpdated: Type.Optional(
        Type.Boolean({
          description: 'The skill was updated too (true) or that failed (false); absent when not tried.',
        }),
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
      reason: Type.Optional(
        Type.String({
          description:
            'Same as `code`, for a refused Task Spec (`sideby ask --spec -`): `spec-invalid`, `spec-too-large`, `bad-cwd`, or `spec-version` (exit 2: update sideby).',
        }),
      ),
    },
    { title: 'sideby error --json' },
  ),
  ask: Type.Object({
    schemaVersion: Version,
    task: Type.Union([Str, Type.Null()]),
    account: Type.Union([Str, Type.Null()]),
    terminal: Type.Union([Str, Type.Null()]),
    opened: Type.Boolean(),
    command: Type.Union([Str, Type.Null()]),
    removedSecrets: Type.Boolean(),
    reason: Type.Optional(
      Type.String({
        enum: [
          'no-accounts',
          'none-signed-in',
          'all-full',
          'not-installed',
          'automation-denied',
          'npx-cache',
          'unsafe-path',
          'failed',
          'unsupported-platform',
        ],
        description: 'Why nothing opened (only when `opened` is false); `detail` says what to do next.',
      }),
    ),
    detail: Type.Optional(Type.String({ description: 'What to do next, for a person.' })),
    prompt: Type.Optional(Str),
    attachments: Type.Array(
      Type.Object({
        path: Type.String({ description: 'Absolute path of the copy saved for the task.' }),
        kind: Type.String({ enum: ['image', 'video'] }),
        bytes: Type.Integer({ minimum: 0 }),
      }),
      { description: 'Files given with `--attach`, in order; empty without any.' },
    ),
  }),
  'ask-print': Type.Object(
    {
      schemaVersion: Version,
      prompt: Type.String({
        description: 'The Task Prompt the Host would get, attachments section included.',
      }),
      removedSecrets: Type.Boolean({ description: 'Whether key-shaped text was taken out of the prompt.' }),
    },
    { title: 'sideby ask --spec - --print --json' },
  ),
  'ask-choices': Type.Object(
    {
      schemaVersion: Version,
      account: Type.Union([Str, Type.Null()], {
        description: 'The Account an AI Task would use now; null when none can be picked (see `reason`).',
      }),
      accounts: Type.Array(
        Type.Object({
          ref: Str,
          label: Type.String({ description: 'What to show for it, as the Panel does.' }),
          signedIn: Type.Boolean({ description: 'False for a Subscription Account that is signed out.' }),
        }),
        {
          description:
            'Signed-in Subscription Accounts, then API Accounts, then signed-out ones; each by ref.',
        },
      ),
      terminal: Type.String({ description: 'The terminal a task opens: the preferred one, else the guess.' }),
      terminals: Type.Array(Type.Object({ id: Str, label: Str }), {
        description: 'The supported terminals installed here.',
      }),
      reason: Type.Union([Type.String({ enum: ['no-accounts', 'none-signed-in', 'all-full'] }), Type.Null()]),
      detail: Type.Union([Type.String({ description: 'What to do next, for a person.' }), Type.Null()]),
    },
    { title: 'sideby ask --choices --json' },
  ),
  terminal: Type.Object({
    schemaVersion: Version,
    preferred: Type.Union([Str, Type.Null()]),
    guess: Type.Object({ id: Str, source: Type.String({ enum: ['config', 'env', 'default'] }) }),
    installed: Type.Array(
      Type.Object({ id: Str, appPath: Type.Optional(Str), executable: Type.Optional(Str) }),
    ),
    terminals: Type.Array(Type.Object({ id: Str, name: Str, installed: Type.Boolean() })),
  }),
  key: Type.Object({
    schemaVersion: Version,
    account: Str,
    var: Str,
    written: Type.Literal(true),
    path: Str,
  }),
  try: Type.Object({
    schemaVersion: Version,
    account: Str,
    model: Type.Optional(Type.String({ description: 'The model `--model` chose, when given.' })),
    confirmed: Type.Boolean(),
    command: Type.Optional(Type.Array(Str)),
    ok: Type.Optional(Type.Boolean()),
    exitCode: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    output: Type.Optional(Str),
    timedOut: Type.Optional(Type.Boolean()),
  }),
  'plugins-new': Type.Object({ schemaVersion: Version, dir: Str, files: Type.Array(Str) }),
  'plugins-check': Type.Object({
    schemaVersion: Version,
    ok: Type.Boolean(),
    plugin: Type.Optional(Str),
    families: Type.Array(Str),
    problems: Type.Array(Type.Object({ code: Str, message: Str, fix: Str })),
  }),
  autostart: loginItem('The login item starts this sideby with this Node.'),
  menubar: loginItem('The menu bar item runs this sideby with this Node.'),
  'menubar-snapshot': Type.Object({
    schemaVersion: Version,
    title: Type.String({
      description:
        'The words next to the icon, such as `Codex 62%`, once the tightest tool reaches 60%; empty otherwise.',
    }),
    level: Type.Union(['ok', 'warn', 'fail', 'none'].map((k) => Type.Literal(k))),
    tooltip: Str,
    updatedAt: Type.String({ description: 'When this snapshot was made (ISO).' }),
    lang: Type.Union([Type.Literal('en'), Type.Literal('zh')]),
    card: Type.Union(
      [
        Type.Object({
          status: Str,
          detail: Str,
          level: Type.Union(['ok', 'warn', 'fail', 'none'].map((k) => Type.Literal(k))),
        }),
        Type.Null(),
      ],
      {
        description:
          'The card at the top of the menu: a bold status and a line naming the account; null without quota data.',
      },
    ),
    hotkey: Type.Union(
      [Type.Object({ keyCode: Type.Number(), modifiers: Type.Number(), label: Str }), Type.Null()],
      {
        description:
          'The shortcut that opens the menu (config `menubar.hotkey`): a macOS key code and Carbon modifiers.',
      },
    ),
    headline: Type.String({
      description:
        'The grey first line of the menu: which account the title belongs to; empty without quota data.',
    }),
    sections: Type.Array(
      Type.Object({
        family: Str,
        title: Str,
        logo: Type.Union([
          Type.Object({
            path: Str,
            fillRule: Type.Optional(Type.String({ enum: ['nonzero', 'evenodd'] })),
            color: Type.Optional(
              Type.String({ description: 'Brand colour; without one the mark follows the text colour.' }),
            ),
            gradients: Type.Optional(
              Type.Array(
                Type.Object({
                  from: Type.Tuple([Type.Number(), Type.Number()]),
                  to: Type.Tuple([Type.Number(), Type.Number()]),
                  color: Str,
                }),
                {
                  description:
                    'Colour washes over a multicoloured mark: each fades from `color` at `from` to clear at `to`.',
                },
              ),
            ),
          }),
          Type.Null(),
        ]),
        columns: Type.Tuple([Type.Union([Str, Type.Null()]), Type.Union([Str, Type.Null()])], {
          description: 'The window names over the two bar columns, such as `5h` and `7d`.',
        }),
        rows: Type.Array(MenubarRow, { description: 'The recommended account first, then Display Order.' }),
        more: Type.Union([Type.Object({ title: Str, rows: Type.Array(MenubarRow) }), Type.Null()], {
          description: 'API key and signed-out accounts behind one submenu; null when there are none.',
        }),
      }),
      { description: 'One per Family with accounts, in Display Order.' },
    ),
    labels: Type.Record(Str, Str, { description: 'Footer words; `{n}` in `updatedMinutes` is minutes.' }),
  }),
  'menubar-hotkey': Type.Union([
    Type.Object({ schemaVersion: Version, ...hotkeyProps }),
    Type.Object({
      schemaVersion: Version,
      changed: Type.Boolean(),
      nudged: Type.Boolean({
        description:
          'A running menu bar item was told (a macOS distributed notification); it takes the new shortcut within seconds, without a restart.',
      }),
      hotkey: MenubarHotkeyView,
    }),
  ]),
  'menubar-start': Type.Object({
    schemaVersion: Version,
    task: Str,
    account: Str,
    terminal: Str,
    opened: Type.Boolean(),
    command: Type.String({
      description: 'The command the terminal runs; paste it into a terminal when `opened` is false.',
    }),
    reason: Type.Optional(
      Type.String({
        enum: [
          'not-installed',
          'automation-denied',
          'npx-cache',
          'unsafe-path',
          'failed',
          'unsupported-platform',
        ],
      }),
    ),
    detail: Type.Optional(Type.String({ description: 'What to do next, for a person.' })),
  }),
  'config-get': Type.Object({
    schemaVersion: Version,
    file: Type.Optional(Str),
    keys: Type.Optional(
      Type.Array(
        Type.Object({
          key: Type.String({ description: 'Dot path; `<…>` marks a part you fill in.' }),
          meaning: Str,
          takes: Str,
          value: Type.Optional(Type.Unknown()),
          entries: Type.Optional(Type.Array(Type.Object({ key: Str, value: Type.Unknown() }))),
        }),
      ),
    ),
    key: Type.Optional(Str),
    set: Type.Optional(Type.Boolean()),
    value: Type.Optional(Type.Unknown()),
    meaning: Type.Optional(Str),
    takes: Type.Optional(Str),
  }),
  // `sideby theme` (spec §3.34, ADR-0050).
  theme: Type.Object({
    schemaVersion: Version,
    folder: Type.String({ description: 'Where Theme Files go, with ~ for the home folder.' }),
    themes: Type.Array(
      Type.Object({
        id: Type.String({ description: 'The name to pass to `sideby theme use`.' }),
        name: Str,
        source: Type.Union([Type.Literal('builtin'), Type.Literal('file')]),
        path: Type.Optional(Str),
        active: Type.Boolean(),
        problems: Type.Array(Str, { description: 'Why the Theme cannot be used; empty when it can.' }),
        warnings: Type.Array(Str, { description: 'Keys of the file that were ignored.' }),
      }),
    ),
  }),
  'theme-use': Type.Object({ schemaVersion: Version, before: Str, after: Str, changed: Type.Boolean() }),
  'theme-check': Type.Object({
    schemaVersion: Version,
    id: Str,
    ok: Type.Boolean({ description: 'Every pair passes; the command exits 1 otherwise.' }),
    pairs: Type.Array(
      Type.Object({
        mode: Type.Union([Type.Literal('light'), Type.Literal('dark')]),
        fg: Str,
        bg: Str,
        ratio: Type.Optional(
          Type.Number({ description: 'WCAG 2 contrast; missing when a value is not #rrggbb.' }),
        ),
        min: Type.Number(),
        ok: Type.Boolean(),
        suggest: Type.Optional(Type.String({ description: 'A value for fg that passes.' })),
      }),
    ),
    warnings: Type.Array(Str),
  }),
  'theme-preview': Type.Object({
    schemaVersion: Version,
    opened: Type.Boolean(),
    url: Type.Optional(Str),
    hint: Type.Optional(Str),
  }),
  'theme-import': Type.Object({
    schemaVersion: Version,
    id: Str,
    path: Str,
    replaced: Type.Boolean(),
    exists: Type.Optional(
      Type.Boolean({ description: 'A Theme File of that name exists; rerun with --yes to replace it.' }),
    ),
  }),
  'theme-export': Type.Object({
    schemaVersion: Version,
    id: Str,
    out: Type.Optional(Str),
    theme: Type.Optional(Type.Unknown({ description: 'The Theme File, when no --out was given.' })),
  }),
  'theme-remove': Type.Object({
    schemaVersion: Version,
    id: Str,
    removed: Type.Boolean(),
    wasActive: Type.Optional(Type.Boolean()),
  }),
  'config-set': Type.Object({
    schemaVersion: Version,
    action: Type.Union([Type.Literal('set'), Type.Literal('unset')]),
    key: Str,
    file: Str,
    changed: Type.Boolean(),
    applied: Type.Boolean(),
    before: Type.Optional(Type.Unknown()),
    after: Type.Optional(Type.Unknown()),
  }),
  config: ConfigSchema,
}
for (const [name, schema] of Object.entries(OUTPUT_SCHEMAS)) {
  const props = (schema as { properties?: Record<string, TSchema> }).properties
  if (name !== 'config' && props) props._notice = Type.Optional(Notice)
}
