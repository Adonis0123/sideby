#!/usr/bin/env node
// Entry point. Keeps imports lazy so `statusline-tap` (run on every status line refresh) and `handoff-hook` (run on
// every tool call while Auto Handoff is on) start fast.
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MIN_NODE = [22, 18]

const HELP = `sideby — run every AI coding account side by side

Usage:
  sideby                              list accounts (same as \`sideby list\`)
  sideby run <account> [-- args]      start the host CLI for one account
  sideby new <family> <name>|--next [--api] [--alias <short>]
                                      create an account (families: claude, codex, grok, pi);
                                      --next picks the next name and short command (cc008);
                                      --alias also adds a short command such as cc008
  sideby families [family]            what each host's accounts share with the main account,
                                      where they live and how they sign in
  sideby alias add <short> <account> [-- args]
                                      add a short command, optionally with host arguments
                                      (sideby alias add pi-kimi pi:main -- --model kimi-coding/k3)
  sideby alias rm <short>             remove a short command
  sideby login <account>              sign in to an account
  sideby resume <family> [-- args]    run the host; a session resumed by id (claude --resume <id>,
                                      codex resume <id>) starts in the account that holds it
  sideby next <family> [--dry-run] [--include-api] [-- args]
                                      recommend the account with the most quota left (claude, codex)
                                      and start it; --dry-run only recommends
  sideby doctor [target] [--fix] [--force]
                                      check shared items and permissions; --fix repairs safe issues
  sideby quota [account]              quota and 7-day token usage
  sideby quota setup claude [--yes]   turn on Claude quota (shows the change first)
  sideby quota teardown claude        undo it, restoring the original file
  sideby handoff status               what Auto Handoff still needs on this machine
  sideby handoff enable [--yes]       turn it on (shows the config change first); --same-family,
                                      --order claude=codex001,cc002, --threshold n, --prepare-at n
  sideby handoff disable [--yes]      turn it off, keeping the other settings
  sideby handoff ready [--brief <f>]  inside a session sideby started with Auto Handoff: hand over to
                                      the next account when this turn ends (config \`handoff\`)
  sideby handoff setup grok [--yes]   add sideby's hook file so Grok can hand over at its limit
  sideby handoff teardown grok        remove it
  sideby ui [--port n] [--no-open]    open the local panel
  sideby ui --background              same, without a terminal: keeps running after this command exits
  sideby ui --stop                    stop the background panel
  sideby app install [--url <url>]    add a sideby app that opens the panel (macOS, Linux)
  sideby app uninstall                remove that app
  sideby shell-init zsh|bash          print shell functions, e.g. eval "$(sideby shell-init zsh)"
  sideby shell-init [zsh|bash] --write
                                      rewrite the config's shellInitFile with them
  sideby plugins                      list loaded plugins and load errors

Options:
  --json        machine-readable output (list, new, next, alias, doctor, quota, handoff, families, plugins, app)
  -h, --help    show this help; \`sideby <command> --help\` for new, alias, login, doctor, families
  -v, --version show the version

An <account> is <family>:<name> (claude:work) or just <name> when it is unique.

For AI agents:
  Add --json and read the result; JSON Schemas ship in the package under schemas/.
  Install the skill: npx skills add Adonis0123/sideby -g
  Setup steps and the full contract: https://github.com/Adonis0123/sideby/blob/main/llms.txt
  Run everything else yourself, but hand the user these as one line each: \`sideby login <account>\`
  (browser sign-in), filling in proxy.env, and \`sideby run\` or \`sideby next\` (interactive sessions).
  Exit 10 means a change was shown: ask the user, then run it again with --yes.`

/** `sideby <command> --help` for the commands agents use to set up and repair accounts (spec §3.16). */
const COMMAND_HELP: Record<string, string> = {
  new: `sideby new <family> <name> [--api] [--alias <short>] [--json]
sideby new <family> --next [--api] [--alias <short>] [--json]

Create an account directory (~/.claude-<name>, ~/.codex-<name>, ~/.grok-<name>, ~/.pi-<name>/agent) and link or
copy the main account's shared items into it. \`sideby families <family>\` lists them.

  --next          pick the name: the next number after the highest numbered account (001…007 → 008), else work;
                  without --alias, also add a short command that follows your existing ones (cc007 → cc008)
  --api           API account: also writes an empty proxy.env template (mode 600) for the user to fill in
  --alias <short> add a short command for it to the config (it becomes a shell function)

Examples:
  sideby new claude --next --json        # ~/.claude-008 plus cc008 when cc001…cc007 exist
  sideby new claude work                 # ~/.claude-work
  sideby new claude deepseek --api       # then the user fills in ~/.claude-deepseek/proxy.env

Writes: the account directory; the config \`aliases\` and every \`shellInitFile\` when a short command is added.
Next: the user signs in with \`sideby login <account>\` (subscription) or fills in proxy.env (API).
Exit: 0 done; 1 invalid name or alias, directory exists, or partly failed; 2 malformed command line.`,
  alias: `sideby alias add <short> <account> [-- host args] [--json]
sideby alias rm <short> [--json]

A short command starts one account: \`sideby run <short>\`, or just \`<short>\` once your shell loads
\`sideby shell-init\`. Host arguments after -- are added only when it starts through the short command; it is
the same account (same sign-in, same sessions), so do not create an account per model.

Examples:
  sideby alias add cc008 claude:008
  sideby alias add pi-kimi pi:main -- --model kimi-coding/k3
  sideby alias rm cc008

Writes: the config \`aliases\` and every \`shellInitFile\`. New shell functions work in a new shell, or after
eval "$(sideby shell-init zsh)" (put that line in ~/.zshrc once).
Exit: 0 done (also when it already exists or is absent); 1 invalid, reserved or taken; 2 malformed.`,
  login: `sideby login <account>

Run the host's own sign-in for one account: claude auth login, codex login, grok login. For pi it starts pi;
then type /login. It opens a browser and needs the person who owns the account, so an agent hands this
line to the user instead of running it (in Claude Code: ! sideby login claude:008).

sideby never reads, copies or stores the credentials the host writes.
Exit: the host's exit code.`,
  doctor: `sideby doctor [account|family] [--fix] [--force] [--json]

Check every account's shared items against the main account, credential file modes (600), backup leftovers,
and whether the installed sideby skill matches this version.

  --fix     repair what is safe: add missing links, refresh copies, chmod 600, sync MCP servers
  --force   with --fix, also let a synced MCP list (json-key) drop entries the account has

--fix never replaces a real file with a link and never changes where an existing link points; those are
reported with the command to run.

Examples:
  sideby doctor --json
  sideby doctor claude:008 --fix
Exit: 0 when nothing fails (warnings allowed); 1 when a check fails.`,
  families: `sideby families [family] [--json]

For each host (built in or from a plugin): where its accounts live, the variable that selects one, how to sign
in, whether quota and usage can be read, and every shared item with what it looks like in each account
(a link to the main account's, a copy, or the account's own file). Everything else in an account directory
(sign-in, sessions, history) belongs to that account.

Examples:
  sideby families
  sideby families claude --json
Exit: 0; 1 unknown family; 2 malformed command line.`,
}

/**
 * True below Node 22.18. npm's `engines` field only warns (`EBADENGINE`); this is the check that exits.
 * `version` defaults to the running Node so tests can pass a string.
 */
export function nodeTooOld(version = process.versions.node): boolean {
  const [maj = 0, min = 0] = version.split('.').map(Number)
  return maj < MIN_NODE[0]! || (maj === MIN_NODE[0] && min < MIN_NODE[1]!)
}

const COMMANDS: Record<string, { flags: string[]; valued?: string[] }> = {
  list: { flags: ['json'] },
  run: { flags: [] },
  resume: { flags: [] },
  login: { flags: [] },
  next: { flags: ['dry-run', 'include-api', 'json'] },
  new: { flags: ['api', 'json', 'next'], valued: ['alias'] },
  alias: { flags: ['json'] },
  doctor: { flags: ['fix', 'force', 'json'] },
  quota: { flags: ['json', 'yes'] },
  handoff: {
    flags: ['json', 'yes', 'same-family', 'no-same-family'],
    valued: ['brief', 'order', 'prepare-at', 'threshold', 'wait-minutes', 'countdown'],
  },
  ui: { flags: ['no-open', 'background', 'stop', 'serve-detached'], valued: ['port'] },
  app: { flags: ['json'], valued: ['url'] },
  'shell-init': { flags: ['write'] },
  plugins: { flags: ['json'] },
  families: { flags: ['json'] },
}

export async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv
  // Claude Code runs this on every status-line refresh. It must still launch the original command when Node is
  // older than 22.18, so the check below does not apply here (spec §3.1).
  if (first === 'statusline-tap') {
    const { runStatuslineTap } = await import('../quota/statusline-tap.ts')
    return runStatuslineTap(rest, process.env, process.stdin, process.stdout)
  }
  // The handoff hook runs on every tool call while Auto Handoff is on; like the tap it comes before the Node check,
  // so a Host never gets a version error from its own hook (spec §3.17).
  if (first === 'handoff-hook') {
    const { runHandoffHook } = await import('../handoff/hook.ts')
    return runHandoffHook(rest, process.env, process.stdin, process.stdout)
  }
  if (nodeTooOld()) {
    console.error(
      `sideby needs Node ${MIN_NODE.join('.')} or newer (you have ${process.versions.node}). Upgrade: https://nodejs.org`,
    )
    return 1
  }
  if (first === '-v' || first === '--version' || first === 'version') {
    const { packageVersion } = await import('../core/version.ts')
    console.log(packageVersion())
    return 0
  }
  if (first === '-h' || first === '--help' || first === 'help') {
    console.log((rest[0] !== undefined && first === 'help' && COMMAND_HELP[rest[0]]) || HELP)
    return 0
  }
  const cmd = first === undefined || first.startsWith('--') ? 'list' : first
  const args = first === undefined || first.startsWith('--') ? argv : rest
  const spec = COMMANDS[cmd]
  const io = { out: (s: string) => console.log(s), err: (s: string) => console.error(s) }
  const { parseArgs, UsageError } = await import('./args.ts')
  // Only sideby's own options count: arguments after `--` belong to the host.
  const own = args.includes('--') ? args.slice(0, args.indexOf('--')) : args
  const wantsJson = Boolean(spec?.flags.includes('json')) && own.includes('--json')
  try {
    if (!spec) throw new UsageError(`unknown command "${cmd}"; run \`sideby --help\``)
    // `run` and `resume` pass everything after the account or family through to the host, with or without `--`.
    let parsed: import('./args.ts').ParsedArgs
    if (cmd === 'run' || cmd === 'resume') {
      const sep = args.indexOf('--')
      const head = sep === -1 ? args : args.slice(0, sep)
      const [ref, ...more] = head
      parsed = {
        positionals: ref ? [ref] : [],
        flags: new Map(),
        rest: [...more, ...(sep === -1 ? [] : args.slice(sep + 1))],
      }
      if (ref === '-h' || ref === '--help') parsed.flags.set('help', true)
    } else {
      try {
        parsed = parseArgs(args, [...spec.flags, 'help'], spec.valued ?? [])
      } catch (err) {
        // `alias add` takes Host arguments too; the usual mistake is leaving out the `--` before them.
        if (cmd === 'alias' && err instanceof UsageError && err.message.startsWith('unknown option'))
          throw new UsageError(
            `${err.message}; put Host arguments after \`--\`, for example: sideby alias add pi-kimi pi:main -- --model kimi-coding/k3`,
          )
        if (cmd === 'next' && err instanceof UsageError && err.message.startsWith('unknown option'))
          throw new UsageError(
            `${err.message}; put Host arguments after \`--\`, for example: sideby next claude -- --model opus`,
          )
        throw err
      }
    }
    if (parsed.flags.has('help')) {
      console.log(COMMAND_HELP[cmd] ?? HELP)
      return 0
    }
    const cmds = await import('./commands.ts')
    switch (cmd) {
      case 'list':
        return await cmds.cmdList(parsed, io)
      case 'run':
        return await cmds.cmdRun(parsed, io, 'run')
      case 'login':
        return await cmds.cmdRun(parsed, io, 'login')
      case 'resume':
        return await cmds.cmdResume(parsed, io)
      case 'next':
        return await cmds.cmdNext(parsed, io)
      case 'new':
        return await cmds.cmdNew(parsed, io)
      case 'alias':
        return await cmds.cmdAlias(parsed, io)
      case 'doctor':
        return await cmds.cmdDoctor(parsed, io)
      case 'quota':
        return await cmds.cmdQuota(parsed, io)
      case 'handoff':
        return await cmds.cmdHandoff(parsed, io)
      case 'ui':
        return await cmds.cmdUi(parsed, io)
      case 'app':
        return await cmds.cmdApp(parsed, io)
      case 'shell-init':
        return await cmds.cmdShellInit(parsed, io)
      case 'plugins':
        return await cmds.cmdPlugins(parsed, io)
      case 'families':
        return await cmds.cmdFamilies(parsed, io)
    }
    return 2
  } catch (err) {
    const usage = err instanceof UsageError
    const message = err instanceof Error ? err.message : String(err)
    if (wantsJson) {
      const { UserError } = await import('../core/errors.ts')
      const code = usage ? 'usage' : err instanceof UserError && err.code ? err.code : 'error'
      console.log(JSON.stringify({ schemaVersion: 1, error: message, code }, null, 2))
    } else console.error(`sideby: ${message}`)
    if (!usage && process.env.SIDEBY_DEBUG && err instanceof Error) console.error(err.stack)
    return usage ? 2 : 1
  }
}

// Run when executed directly, also through symlinks (npm's bin shim, a user alias like `sb`).
function isEntry(): boolean {
  const arg = process.argv[1]
  if (!arg) return false
  try {
    return (
      pathToFileURL(realpathSync(arg)).href ===
      pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href
    )
  } catch {
    return false
  }
}
if (isEntry()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (err: unknown) => {
      console.error(`sideby: ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
    },
  )
}
