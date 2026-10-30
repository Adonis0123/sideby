// The Command List (spec §3.38, ADR-0061) is what `sideby --help`, `sideby commands` and the Panel show, so it must name
// every command `sideby` dispatches; entries only sideby itself runs are left out.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import {
  CLI_COMMANDS,
  COMMAND_GROUPS,
  cliHelp,
  commandWords,
  commonCommands,
  filterCommands,
} from './cli-commands.ts'
import { SEARCH_CATALOG } from './search-catalog.ts'

/** Entries sideby runs itself, never a person or their AI: hooks a Host runs and the background Update Check. */
const INTERNAL = new Set([
  'update-check',
  'statusline-tap',
  'handoff-hook',
  'network-hook',
  'unattended-hook',
])

const ids = (q: string) => filterCommands(q, CLI_COMMANDS, COMMAND_GROUPS).map((c) => c.id)

describe('Command List', () => {
  it('names every command `sideby` dispatches', async () => {
    const main = await readFile(new URL('../cli/main.ts', import.meta.url), 'utf8')
    const dispatched = [
      ...[...main.matchAll(/^ {4}case '([a-z-]+)':/gm)].map((m) => m[1]!),
      ...[...main.matchAll(/^ {2}if \(first === '([a-z-]+)'\) \{/gm)].map((m) => m[1]!),
    ]
    assert.ok(dispatched.length > 20, 'the command switch in src/cli/main.ts was not found')
    const listed = new Set(CLI_COMMANDS.flatMap((c) => commandWords(c.usage)))
    const missing = dispatched.filter((c) => !INTERNAL.has(c) && !listed.has(c))
    assert.deepEqual(
      missing,
      [],
      `Add each command to CLI_COMMANDS in src/core/cli-commands.ts (or, for an entry only sideby itself runs, to INTERNAL in this test): ${missing.join(', ')}`,
    )
    assert.ok(
      !listed.has('update-check') && !listed.has('statusline-tap'),
      'internal entries stay out of the list',
    )
  })

  it('has unique ids, both languages, a known group and Panel places that exist', () => {
    const seen = new Set<string>()
    const groups = new Set(COMMAND_GROUPS.map((g) => g.id))
    const features = new Set(SEARCH_CATALOG.map((e) => e.id))
    for (const c of CLI_COMMANDS) {
      assert.ok(!seen.has(c.id), `duplicate id ${c.id}`)
      seen.add(c.id)
      assert.ok(groups.has(c.group), `${c.id}: unknown group ${c.group}`)
      assert.match(c.usage, /^sideby( |$)/, `${c.id}: usage starts with sideby`)
      assert.ok(
        c.help && c.summary.en && c.summary.zh,
        `${c.id} needs help and English and Chinese summaries`,
      )
      assert.ok(!c.summary.en.includes('\n') && !c.summary.zh.includes('\n'), `${c.id}: one line`)
      if (c.example) assert.match(c.example, /sideby /, `${c.id}: the example runs sideby`)
      if (c.feature) assert.ok(features.has(c.feature), `${c.id}: Search Catalog has ${c.feature}`)
    }
    for (const g of COMMAND_GROUPS) assert.ok(g.title.en && g.title.zh, `${g.id} needs both titles`)
  })

  it('puts about eight common commands first, in rank order', () => {
    const common = commonCommands()
    assert.ok(common.length >= 6 && common.length <= 10, `${common.length} common commands`)
    assert.deepEqual(
      common.map((c) => c.common),
      [...new Set(common.map((c) => c.common))].sort((a, b) => a! - b!),
    )
    assert.equal(common[0]!.id, 'list')
  })
})

describe('sideby --help from the Command List', () => {
  const help = cliHelp()

  it('prints every usage line under its group heading, then the options and the notes for agents', () => {
    for (const c of CLI_COMMANDS) assert.ok(help.includes(`\n  ${c.usage}`), `help shows ${c.usage}`)
    for (const g of COMMAND_GROUPS) assert.ok(help.includes(`\n${g.title.en}:\n`), `help has ${g.title.en}`)
    assert.ok(help.indexOf('\nAccounts:') < help.indexOf('\nOptions:'))
    assert.match(help, /^sideby — run every AI coding account side by side/)
    assert.match(help, /For AI agents:/)
    assert.match(help, /-v, --version show the version/)
  })

  it('keeps every word of each command description', () => {
    const flat = help.replace(/\s+/g, ' ')
    for (const c of CLI_COMMANDS) assert.ok(flat.includes(c.help), `help shows the description of ${c.usage}`)
  })

  it('wraps descriptions into column 38 and stays within 132 columns', () => {
    const lines = help.split('\n')
    assert.ok(
      lines.some((l) => l.startsWith('  sideby run <account> [-- args]') && l.indexOf('start') === 38),
    )
    assert.ok(Math.max(...lines.map((l) => l.length)) <= 132)
  })
})

describe('filterCommands', () => {
  it('matches everything for an empty query', () => {
    assert.equal(filterCommands('  ', CLI_COMMANDS, COMMAND_GROUPS).length, CLI_COMMANDS.length)
  })

  it('needs every word, in the usage, the example or either language', () => {
    assert.ok(ids('handoff enable').includes('handoff.enable'))
    assert.ok(!ids('handoff enable').includes('handoff.disable'))
    assert.ok(ids('cc008').includes('alias.add'), 'by its example')
    assert.ok(ids('额度').includes('quota'), 'by the Chinese description')
    assert.ok(ids('自动接力').includes('handoff.rules'), "by the group's Chinese title")
    assert.deepEqual(ids('zzzz'), [])
  })
})
