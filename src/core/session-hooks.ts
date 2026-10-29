// The hooks sideby adds to a session it starts (Network Guard §3.35, Unattended Mode §3.37) and how they go together
// with each other and with Auto Handoff's (§3.17). Claude Code takes one `--settings`, so every part goes into one file
// sideby writes in its state folder; Codex takes `-c hooks.<event>=[…]`, where a second value for the same event would
// replace the first, so the entries of one event go into one value. Nothing is written into a Host directory.
import { mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ownedFolder, writeFileAtomic } from './fs-safe.ts'

/** Claude Code `hooks` entries: per event, its matcher groups. */
export type ClaudeHooks = Record<string, unknown[]>

/** One feature's session hooks. */
export interface SessionHookPart {
  /** Its folder in the state directory, and its part of the settings file's name: `network`, `unattended`. */
  id: string
  claude: ClaudeHooks
  /** Per Codex event, the inline TOML tables of its list, such as `{matcher="…",hooks=[{type="command",command="…"}]}`. */
  codex: Record<string, string[]>
}

/**
 * The command a Host runs for a hook entry: this Node and this sideby by absolute path, never `sideby` by name. A
 * missing or older `sideby` on PATH would fail the hook, and a failing hook lets the Host go on.
 */
export function sidebyHookCommand(entry: string, family: string, event: string): string {
  const main = fileURLToPath(
    new URL(`../cli/main${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
  )
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const safe = (s: string) => !/["\\\n]/.test(s)
  const bin = safe(process.execPath) && safe(main) ? `${q(process.execPath)} ${q(main)}` : 'sideby'
  return `${bin} ${entry} ${family} ${event}`
}

/** Every part's Claude hooks in one object, each event's groups in part order. */
export function mergeClaudeHooks(...parts: readonly ClaudeHooks[]): ClaudeHooks {
  const out: ClaudeHooks = {}
  for (const part of parts)
    for (const [e, list] of Object.entries(part)) out[e] = [...(out[e] ?? []), ...list]
  return out
}

/**
 * Host arguments that add every part's hooks to a session: one `--settings` file for Claude (in the first part's
 * folder, named after the parts: `network/claude-settings.json`, `network/claude-settings-unattended.json`), one
 * `-c hooks.<event>=[…]` per event for Codex. Empty for other Families or no parts.
 */
export async function sessionHookArgs(
  family: string,
  stateDir: string,
  parts: readonly SessionHookPart[],
): Promise<string[]> {
  if (!parts.length) return []
  if (family === 'claude') {
    // A real folder of the user that nobody else can write to, so the file is never written through a link.
    const dir = (await ownedFolder(stateDir, [parts[0]!.id], { create: true, private: true }))!
    const name = `claude-settings${parts
      .slice(1)
      .map((p) => `-${p.id}`)
      .join('')}.json`
    const hooks = mergeClaudeHooks(...parts.map((p) => p.claude))
    await writeFileAtomic(join(dir, name), `${JSON.stringify({ hooks }, null, 2)}\n`, 0o600)
    return ['--settings', join(dir, name)]
  }
  if (family === 'codex') {
    const events = new Map<string, string[]>()
    for (const p of parts)
      for (const [e, list] of Object.entries(p.codex)) events.set(e, [...(events.get(e) ?? []), ...list])
    return [...events].flatMap(([e, list]) => ['-c', `hooks.${e}=[${list.join(',')}]`])
  }
  return []
}

async function settingsOf(
  args: readonly string[],
): Promise<{ hooks?: ClaudeHooks } & Record<string, unknown>> {
  const at = args.indexOf('--settings')
  const file = at === -1 ? undefined : args[at + 1]
  if (!file) return {}
  try {
    const v = JSON.parse(await readFile(file, 'utf8')) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Auto Handoff's Claude hook arguments with `extra` hooks added to its `--settings` file, written as `out` (Claude
 * Code takes one `--settings`). Auto Handoff's own hooks and options come first and are kept as they are.
 */
export async function withClaudeHooks(
  hookArgs: readonly string[],
  extra: ClaudeHooks,
  out: string,
): Promise<string[]> {
  const settings = await settingsOf(hookArgs)
  const hooks = mergeClaudeHooks(settings.hooks ?? {}, extra)
  await mkdir(dirname(out), { recursive: true, mode: 0o700 })
  await writeFileAtomic(out, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`, 0o600)
  const at = hookArgs.indexOf('--settings')
  return at === -1 ? [...hookArgs, '--settings', out] : hookArgs.map((a, i) => (i === at + 1 ? out : a))
}

/**
 * Auto Handoff's Claude hook arguments with the session's own sideby hooks (`sessionArgs`, from `sessionHookArgs`)
 * merged into one `--settings` file, written next to the session's file with `-handoff` added to its name.
 */
export async function withClaudeSessionHooks(
  hookArgs: readonly string[],
  sessionArgs: readonly string[],
): Promise<string[]> {
  const at = sessionArgs.indexOf('--settings')
  const file = at === -1 ? undefined : sessionArgs[at + 1]
  if (!file) return [...hookArgs]
  const extra = (await settingsOf(sessionArgs)).hooks ?? {}
  return withClaudeHooks(hookArgs, extra, join(dirname(file), `${basename(file, '.json')}-handoff.json`))
}
