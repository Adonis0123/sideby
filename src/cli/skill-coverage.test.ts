// Every user-facing command is also something an AI assistant can do for the user (AGENTS.md, "User experience
// first"): the shipped skill must name it, so a feature never exists only as a command nobody's AI knows about.
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Entries sideby runs itself, never a person or their AI: the background Update Check. */
const INTERNAL = new Set(['update-check'])

async function skillText(): Promise<string> {
  const dir = join(ROOT, 'skills/sideby')
  const files = ['SKILL.md', ...(await readdir(join(dir, 'references'))).map((f) => `references/${f}`)]
  return (await Promise.all(files.map((f) => readFile(join(dir, f), 'utf8')))).join('\n')
}

test('the shipped skill names every command `sideby` dispatches', async () => {
  const main = await readFile(join(ROOT, 'src/cli/main.ts'), 'utf8')
  const commands = [...main.matchAll(/^ {4}case '([a-z-]+)':/gm)].map((m) => m[1]!)
  assert.ok(commands.length > 20, 'the command switch in src/cli/main.ts was not found')
  const skill = await skillText()
  const missing = commands.filter((c) => !INTERNAL.has(c) && !new RegExp(`\\bsideby ${c}\\b`).test(skill))
  assert.deepEqual(
    missing,
    [],
    `Add each command to skills/sideby/: a routing row in SKILL.md and its use in the matching references/*.md (or, for an entry only sideby itself runs, to INTERNAL in this test): ${missing.join(', ')}`,
  )
})
