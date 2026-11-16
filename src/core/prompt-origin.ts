// What sideby can tell about who wrote a prompt from the prompt alone (spec §3.35, §3.37 "有人在的会话", ADR-0075): a
// prompt Claude Code made itself, a Message `sideby send` delivered, and a prompt sideby passed on the Host's command
// line. A leaf module (Node built-ins only): `network-hook` and `unattended-hook` run it before every prompt.
import { createHash } from 'node:crypto'

/** A prompt Claude Code made itself starts with this (a background task's notification, a hook's wake-up). */
export const HOST_MADE = '<task-notification>'

/** Whether Claude Code made the prompt itself (checked with Claude Code 2.1.325). */
export const hostMade = (prompt: string): boolean => prompt.trimStart().startsWith(HOST_MADE)

/**
 * The mark every Message `sideby send` delivers, and the line it asks the user to paste, carries (`sideby message
 * <id>`, an id of 8 hex digits; core/messages.ts).
 */
const SIDEBY_MESSAGE = /\bsideby message [0-9a-f]{8}\b/

/** Whether the prompt is, or points to, a Message `sideby send` kept. */
export const sidebyMessage = (prompt: string): boolean => SIDEBY_MESSAGE.test(prompt)

/**
 * Set in the environment of a Claude session that has `unattended-hook`: the marks of the prompts sideby put on its
 * command line (`launchPromptMarks`). `?` until the Host starts; a session whose value is not a list counts no prompt
 * as typed.
 */
export const LAUNCH_PROMPTS_ENV = 'SIDEBY_LAUNCH_PROMPTS'
/** The value before the final arguments are known. */
export const LAUNCH_PROMPTS_UNSET = '?'
const MARKS_MAX = 64
const MARK = /^[0-9a-f]{16}$/

/** A prompt as compared: trimmed, with every run of white space as one space, so a Host that tidies it still matches. */
const mark = (text: string): string =>
  createHash('sha256').update(text.trim().replace(/\s+/g, ' ')).digest('hex').slice(0, 16)

/**
 * The marks of every argument that may be a prompt: each one that does not start with `-`, and the value of each
 * `--x=value`. Over-counting an option's value is harmless: a typed prompt equal to it is only not counted.
 */
export function launchPromptMarks(args: readonly string[]): string {
  const out = new Set<string>()
  for (const a of args) {
    const value = a.startsWith('-') ? (a.includes('=') ? a.slice(a.indexOf('=') + 1) : '') : a
    if (value.trim()) out.add(mark(value))
    if (out.size >= MARKS_MAX) break
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
