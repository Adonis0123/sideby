// Progress Reminders (spec §3.42, ADR-0076): the session hooks sideby adds to a Claude session while config
// `progress.every` is set, the line a launch prints when it cannot add them, and what `sideby progress` and the Panel
// show and change. The hook itself is src/progress/hook.ts; its state is core/progress-state.ts.
import type { Env } from '../types.ts'
import { type Config, editConfigProgress } from './config.ts'
import {
  PROGRESS_CHOICES,
  PROGRESS_DEFAULT,
  PROGRESS_PROMPT_TIMEOUT_S,
  PROGRESS_STOP_TIMEOUT_S,
  validEvery,
} from './progress-state.ts'
import { type SessionHookPart, sidebyHookCommand } from './session-hooks.ts'

/** Families whose sessions get reminders: only Claude Code lets a hook wake an idle session. */
export const PROGRESS_FAMILIES: readonly string[] = ['claude']

/**
 * The session hooks of Progress Reminders: in the background after every turn (`Stop`, `asyncRewake`, so its exit 2
 * wakes the idle session) and on every prompt (`UserPromptSubmit`, `async`, so it never holds a prompt back). Codex
 * has no hook that can wake a session, so it gets none.
 */
export function progressHookPart(): SessionHookPart {
  const command = (event: string) => sidebyHookCommand('progress-hook', 'claude', event)
  return {
    id: 'progress',
    claude: {
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: command('Stop'),
              asyncRewake: true,
              timeout: PROGRESS_STOP_TIMEOUT_S,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: command('UserPromptSubmit'),
              async: true,
              timeout: PROGRESS_PROMPT_TIMEOUT_S,
            },
          ],
        },
      ],
    },
    codex: {},
  }
}

function prefersChinese(env: Env): boolean {
  return /^zh/i.test(env.LC_ALL || env.LC_MESSAGES || env.LANG || '')
}

/** The line a Claude Launch prints when the user's own `--settings` leaves no room for the hooks. */
export function progressSettingsLine(env: Env): string {
  return prefersChinese(env)
    ? 'sideby：已经给了 `--settings`，这个会话没有进度提醒（它的 hook 要通过 `--settings` 加入）。'
    : 'sideby: `--settings` is already given, so this session gets no progress reminders (their hooks go in through `--settings`).'
}

/** What `sideby progress` and the Panel show. */
export interface ProgressView {
  on: boolean
  /** Minutes between reminders; absent while off. */
  every?: number
  /** What turning it on picks. */
  defaultEvery: number
  /** The intervals the Panel offers. */
  choices: number[]
  /** The Families whose sessions get reminders. */
  families: string[]
}

export function progressView(config: Config): ProgressView {
  const every = config.progress?.every
  return {
    on: validEvery(every),
    ...(validEvery(every) ? { every } : {}),
    defaultEvery: PROGRESS_DEFAULT,
    choices: [...PROGRESS_CHOICES],
    families: [...PROGRESS_FAMILIES],
  }
}

/**
 * Turns Progress Reminders on with `every` minutes, or off (undefined). Writes only sideby's config, so it applies at
 * once with no preview; the caller prints the undo.
 */
export async function setProgress(
  configFile: string,
  every: number | undefined,
): Promise<{ changed: boolean; before?: number; after?: number; config: Config['progress'] }> {
  const r = await editConfigProgress(configFile, every)
  const before = r.before?.every
  const after = r.after?.every
  return {
    changed: r.changed,
    ...(validEvery(before) ? { before } : {}),
    ...(validEvery(after) ? { after } : {}),
    config: r.after,
  }
}
