// `sideby plugins new` (spec §3.28 "加一个新宿主"): writes a Family Plugin skeleton the loader accepts as it is, with a
// TODO on every fact the author has to look up in the Host's own docs.
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { UserError } from '../core/errors.ts'

/** Same rule the loader applies to a Family id: it becomes part of account refs and shell function names. */
export const FAMILY_ID_RE = /^[a-z][a-z0-9-]{0,31}$/

/** Marks each line of the skeleton the author still has to fill in; `checkPlugin` reports any that are left. */
export const TODO_MARK = 'TODO(sideby)'

export interface ScaffoldResult {
  /** The new plugin directory, `<dir>/<id>`. */
  dir: string
  /** Every file written, in the order written. */
  files: string[]
}

/** Why `id` cannot name a Family Plugin, or null when it can. */
export function pluginIdProblem(id: string): string | null {
  return FAMILY_ID_RE.test(id)
    ? null
    : `"${id}" cannot name a plugin: use lowercase letters, digits or "-", starting with a letter, at most 32 characters (for example "mytool")`
}

/**
 * Creates `<dir>/<id>/` with `plugin.json`, `index.ts` (an `api.family(def)` skeleton that only imports types from
 * sideby) and `index.test.ts` (a starter on `sideby/testing`). The directory is mode 700 and the files 600, owned by
 * the current user, so the loader's trust checks pass. Refuses a bad id or an existing directory before writing.
 */
export async function scaffoldPlugin(opts: { id: string; dir: string }): Promise<ScaffoldResult> {
  const problem = pluginIdProblem(opts.id)
  if (problem) throw new UserError(problem, { code: 'plugin-id-invalid' })
  await mkdir(opts.dir, { recursive: true, mode: 0o700 })
  const dir = join(opts.dir, opts.id)
  try {
    await mkdir(dir, { mode: 0o700 })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST')
      throw new UserError(
        `${dir} already exists; pick another id, or check the plugin there with \`sideby plugins check ${opts.id}\``,
        { code: 'plugin-exists' },
      )
    throw err
  }
  // mkdir's mode is narrowed by the umask; set it exactly.
  await chmod(dir, 0o700)
  const files: string[] = []
  for (const [name, text] of [
    ['plugin.json', manifestText(opts.id)],
    ['index.ts', indexText(opts.id)],
    ['index.test.ts', testText(opts.id)],
  ] as const) {
    const p = join(dir, name)
    await writeFile(p, text, { mode: 0o600, flag: 'wx' })
    await chmod(p, 0o600)
    files.push(p)
  }
  return { dir, files }
}

function manifestText(id: string): string {
  return `${JSON.stringify({ name: id, version: '0.1.0', description: `${id} family for sideby`, main: 'index.ts' }, null, 2)}\n`
}

function envPrefix(id: string): string {
  return id.toUpperCase().replace(/-/g, '_')
}

function indexText(id: string): string {
  const v = envPrefix(id)
  return `// Family Plugin for ${id}. This file runs with your full permissions, like any local code.
// Fill in every ${TODO_MARK} with a fact from the Host's own docs or \`--help\`, and write down where it came from as
// "<tool> <version>, <date>", for example "${id} 1.2.0 --help, 2026-10-17". Then run \`sideby plugins check ${id}\`.
// Only \`import type\` from sideby: the plugin gets everything else through \`api\`.
import type { FamilyDef, Plugin } from 'sideby'

const family: FamilyDef = {
  id: '${id}',
  // ${TODO_MARK}: the Host's name as its docs write it.
  title: '${id}',
  // ${TODO_MARK}: the executable the Host installs on PATH (its docs or install script).
  bin: '${id}',
  // ${TODO_MARK}: the Host's official install page.
  installUrl: 'https://example.com/${id}',
  // ${TODO_MARK}: the environment variable that moves the Host's whole config directory (its docs or \`--help\`).
  // sideby sets it for every Account but the Main Account.
  selectVar: '${v}_HOME',
  // ${TODO_MARK}: where the Host keeps its config, relative to HOME; the other Accounts put <name> in the first segment.
  layout: { main: '.${id}', account: '.${id}-<name>' },
  // ${TODO_MARK}: variables that would send every Account to the same login or endpoint (API keys, base URLs);
  // sideby clears them before each launch.
  hijackVars: ['${v}_API_KEY'],
  // ${TODO_MARK}: variables an API Account sets in its proxy.env.
  apiVars: ['${v}_API_KEY'],
  // ${TODO_MARK}: each file or folder the Accounts share, with its Share Mode (see \`sideby families claude\` for examples).
  // Paths are relative to the Account directory. Mark a file that holds a login \`credential: true\`; sideby never reads it.
  sharedItems: [{ path: 'settings.json', mode: 'link-or-copy' }],
  // ${TODO_MARK}: the Host's sign-in arguments, or null when it signs in inside the app.
  login: { args: ['login'], hint: 'run ${id} login' },
  // Optional: loginState(account) tells signed in from signed out by whether a file exists, never by reading it.
  // Optional: logo, one 24x24 SVG path with its source and license in a comment.
}

const plugin: Plugin = {
  name: '${id}',
  register(api) {
    api.family(family)
  },
}

export default plugin
`
}

function testText(id: string): string {
  return `// Starter test for the ${id} Family Plugin. Run it with \`node --test index.test.ts\` where sideby is installed
// (\`npm i -D sideby\`). It only uses a throwaway HOME from sideby/testing, never your real one.
import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { FamilyDef, PluginApi } from 'sideby'
import { withFakeHome } from 'sideby/testing'
import plugin from './index.ts'

it('registers the ${id} family', async () => {
  await withFakeHome(async (h) => {
    const families: FamilyDef[] = []
    await plugin.register({ family: (def: FamilyDef) => families.push(def) } as unknown as PluginApi)
    assert.equal(families.length, 1)
    const def = families[0]!
    assert.equal(def.id, '${id}')
    assert.ok(def.selectVar)
    // ${TODO_MARK}: write the files your Host keeps in a signed-in Account and assert what loginState reads.
    await h.mkdir(def.layout.main)
  })
})
`
}
