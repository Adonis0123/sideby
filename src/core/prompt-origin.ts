// What sideby can tell about who wrote a prompt from the prompt alone (spec §3.35, §3.37 "有人在的会话", ADR-0075): a
// prompt Claude Code made itself, a Message `sideby send` delivered, and a prompt sideby passed on the Host's command
// line. A leaf module (Node built-ins only): `network-hook` and `unattended-hook` run it before every prompt.
import { createHash } from 'node:crypto'

/** A prompt Claude Code made itself starts with this (a background task's notification, a hook's wake-up). */
export const HOST_MADE = '<task-notification>'

/** Whether Claude Code made the prompt itself (checked with Claude Code 2.1.325). */
export const hostMade = (prompt: string): boolean => prompt.trimStart().startsWith(HOST_MADE)

/**
 * How Claude Code wraps a background hook's message when its exit 2 wakes the session (`asyncRewake`): `<task-notification>
 * <summary>Stop hook feedback</summary> </task-notification> <system-reminder> Stop hook blocking error from command
 * "Stop": <stderr> …` (Claude Code 2.1.325).
 */
const WAKE_UP = /^<task-notification>\s*<summary>Stop hook feedback<\/summary>/

/** Whether the prompt is a background hook's wake-up, which Claude Code made itself. */
export const hookWakeUp = (prompt: string): boolean => WAKE_UP.test(prompt.trimStart())

/** How every Progress Reminder starts (spec §3.42, ADR-0076); the model reads it, so it is plain words. */
export const PROGRESS_MARK = 'sideby progress reminder:'

/** The tags around a message Network Guard's `Held` held back and hands over later (spec §3.35, network/hook.ts). */
export const HELD_OPEN = '<sideby-held-message>'
export const HELD_CLOSE = '</sideby-held-message>'

/** One background hook's wake-up: Claude Code's wrapper and one hook's message (two at once may be joined). */
const oneWakeUp = (prompt: string): boolean =>
  hookWakeUp(prompt) &&
  prompt.split('Stop hook blocking error').length <= 2 &&
  prompt.split(HOST_MADE).length === 2

/**
 * Whether the prompt is the wake-up of a Progress Reminder and nothing else: Claude Code's wrapper, the reminder's
 * opening words, and only one hook's message (two wake-ups at once might be joined into one prompt). A reminder that
 * Network Guard held and handed over later counts too: `Held`'s own wake-up with one held message between the tags,
 * which is the reminder's wake-up alone.
 */
export function progressWakeUp(prompt: string): boolean {
  const from = prompt.indexOf(HELD_OPEN)
  const to = prompt.indexOf(HELD_CLOSE)
  if (from === -1 && to === -1) return oneWakeUp(prompt) && prompt.includes(PROGRESS_MARK)
  if (from === -1 || to < from) return false
  if (prompt.indexOf(HELD_OPEN, from + 1) !== -1 || prompt.indexOf(HELD_CLOSE, to + 1) !== -1) return false
  const held = prompt.slice(from + HELD_OPEN.length, to).trim()
  const outer = prompt.slice(0, from) + prompt.slice(to + HELD_CLOSE.length)
  return oneWakeUp(outer) && !outer.includes(PROGRESS_MARK) && oneWakeUp(held) && held.includes(PROGRESS_MARK)
}

/**
 * The mark every Message `sideby send` delivers, and the line it asks the user to paste, carries (`sideby message
 * <id>`, an id of 8 hex digits; core/messages.ts).
 */
const SIDEBY_MESSAGE = /\bsideby message [0-9a-f]{8}\b/

/** Whether the prompt is, or points to, a Message `sideby send` kept. */
export const sidebyMessage = (prompt: string): boolean => SIDEBY_MESSAGE.test(prompt)

/**
 * Set in the environment of a Claude session that has `unattended-hook`: the marks of the prompts sideby put on its
 * command line (`launchPromptMarks`). `?` until the Host starts, and for a command line with more than `MARKS_MAX`
 * of them; a session whose value is not a list counts no prompt as typed.
 */
export const LAUNCH_PROMPTS_ENV = 'SIDEBY_LAUNCH_PROMPTS'
/** The value before the final arguments are known, or when there are too many to list. */
export const LAUNCH_PROMPTS_UNSET = '?'
const MARKS_MAX = 64
const MARK = /^[0-9a-f]{16}$/

/** A prompt as compared: trimmed, with every run of white space as one space, so a Host that tidies it still matches. */
const mark = (text: string): string =>
  createHash('sha256').update(text.trim().replace(/\s+/g, ' ')).digest('hex').slice(0, 16)

/**
 * The marks of every argument that may be a prompt: each one that does not start with `-`, the value of each
 * `--x=value`, and every argument after a `--`, whole (there even `- review` or `--x=y` is prompt text). Over-counting
 * an option's value is harmless: a typed prompt equal to it is only not counted. More than `MARKS_MAX` of them give
 * `LAUNCH_PROMPTS_UNSET`: a list cut short would let a launch prompt past it count as typed.
 */
export function launchPromptMarks(args: readonly string[]): string {
  const out = new Set<string>()
  let dashes = false
  for (const a of args) {
    if (!dashes && a === '--') {
      dashes = true
      continue
    }
    const value = dashes || !a.startsWith('-') ? a : a.includes('=') ? a.slice(a.indexOf('=') + 1) : ''
    if (value.trim()) out.add(mark(value))
    if (out.size > MARKS_MAX) return LAUNCH_PROMPTS_UNSET
  }
  return [...out].join(',')
}

/**
 * Whether `prompt` may be one sideby put on the command line, read from the session's environment. Undefined, `?` or
 * anything that is not a list of marks means sideby cannot tell, and the answer is yes.
 */
export function launchPrompt(prompt: string, env: Record<string, string | undefined>): boolean {
  const value = env[LAUNCH_PROMPTS_ENV]
  if (value === undefined) return true
  const marks = value === '' ? [] : value.split(',')
  if (marks.length > MARKS_MAX || !marks.every((m) => MARK.test(m))) return true
  return marks.includes(mark(prompt))
}
