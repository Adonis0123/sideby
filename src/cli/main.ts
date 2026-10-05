#!/usr/bin/env node
// Entry point. Keeps imports lazy so `statusline-tap`, which Claude Code runs on every refresh, starts fast.
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MIN_NODE = [22, 18]

const HELP = `sideby — run every AI coding account side by side

Usage:
  sideby                              list accounts (same as \`sideby list\`)
  sideby run <account> [-- args]      start the host CLI for one account
  sideby new <family> <name> [--api] [--alias <short>]
                                      create an account (families: claude, codex, grok, pi);
                                      --alias also adds a short command such as cc008
  sideby alias add <short> <account> [-- args]
                                      add a short command, optionally with host arguments
                                      (sideby alias add pi-kimi pi:main -- --model kimi-coding/k3)
  sideby alias rm <short>             remove a short command
  sideby login <account>              sign in to an account
  sideby doctor [target] [--fix] [--force]
                                      check shared items and permissions; --fix repairs safe issues
  sideby quota [account]              quota and 7-day token usage
  sideby quota setup claude [--yes]   turn on Claude quota (shows the change first)
  sideby quota teardown claude        undo it, restoring the original file
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
  --json        machine-readable output (list, new, alias, doctor, quota, plugins, app)
  -h, --help    show this help
  -v, --version show the version

An <account> is <family>:<name> (claude:work) or just <name> when it is unique.`

function nodeTooOld(): boolean {
  const [maj = 0, min = 0] = process.versions.node.split('.').map(Number)
  return maj < MIN_NODE[0]! || (maj === MIN_NODE[0] && min < MIN_NODE[1]!)
}

const COMMANDS: Record<string, { flags: string[]; valued?: string[] }> = {
  list: { flags: ['json'] },
  run: { flags: [] },
  login: { flags: [] },
  new: { flags: ['api', 'json'], valued: ['alias'] },
  alias: { flags: ['json'] },
  doctor: { flags: ['fix', 'force', 'json'] },
  quota: { flags: ['json', 'yes'] },
  ui: { flags: ['no-open', 'background', 'stop', 'serve-detached'], valued: ['port'] },
  app: { flags: ['json'], valued: ['url'] },
  'shell-init': { flags: ['write'] },
  plugins: { flags: ['json'] },
}

export async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv
  if (first === 'statusline-tap') {
    const { runStatuslineTap } = await import('../quota/statusline-tap.ts')
    return runStatuslineTap(rest, process.env, process.stdin, process.stdout)
  }
  if (first === '-v' || first === '--version' || first === 'version') {
    const { packageVersion } = await import('../core/version.ts')
    console.log(packageVersion())
    return 0
  }
  if (first === '-h' || first === '--help' || first === 'help') {
    console.log(HELP)
    return 0
  }
  if (nodeTooOld()) {
    console.error(
      `sideby needs Node ${MIN_NODE.join('.')} or newer (you have ${process.versions.node}). Upgrade: https://nodejs.org`,
    )
    return 1
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
    // `run` passes everything after the account through to the host, with or without `--`.
    let parsed: import('./args.ts').ParsedArgs
    if (cmd === 'run') {
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
        throw err
      }
    }
    if (parsed.flags.has('help')) {
      console.log(HELP)
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
      case 'new':
        return await cmds.cmdNew(parsed, io)
      case 'alias':
        return await cmds.cmdAlias(parsed, io)
      case 'doctor':
        return await cmds.cmdDoctor(parsed, io)
      case 'quota':
        return await cmds.cmdQuota(parsed, io)
      case 'ui':
        return await cmds.cmdUi(parsed, io)
      case 'app':
        return await cmds.cmdApp(parsed, io)
      case 'shell-init':
        return await cmds.cmdShellInit(parsed, io)
      case 'plugins':
        return await cmds.cmdPlugins(parsed, io)
    }
    return 2
  } catch (err) {
    const usage = err instanceof UsageError
    const message = err instanceof Error ? err.message : String(err)
    if (wantsJson) console.log(JSON.stringify({ schemaVersion: 1, error: message }, null, 2))
    else console.error(`sideby: ${message}`)
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
