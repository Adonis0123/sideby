// A Family used only by tests: one Shared Item per Share Mode, a fake Host binary named `demo`.
import type { BuiltinPlugin } from '../src/plugins/loader.ts'
import type { FamilyDef, Plugin, SharedItemDef } from '../src/types.ts'

export const DEMO_ITEMS: SharedItemDef[] = [
  { path: 'skills', mode: 'link' },
  { path: 'rules.md', mode: 'link' },
  { path: 'hooks', mode: 'copy', hostMessage: 'hooks must be a real directory' },
  { path: 'theme.json', mode: 'link-or-copy' },
  { path: 'trusted.toml', mode: 'link-or-local' },
  { path: 'cli.json', mode: 'local' },
  { path: 'config.toml', mode: 'local-if-api' },
  { path: 'auth.json', mode: 'info', credential: true, noSymlink: true },
  { path: '.demo.json', mode: 'json-key', key: 'servers', mainPath: '.demo.json', credential: true },
]

export function demoFamily(overrides: Partial<FamilyDef> = {}): FamilyDef {
  return {
    id: 'demo',
    title: 'Demo',
    bin: 'demo',
    installUrl: 'https://example.invalid/demo',
    selectVar: 'DEMO_HOME',
    layout: { main: '.demo', account: '.demo-<name>' },
    hijackVars: ['DEMO_API_KEY', 'DEMO_BASE_URL'],
    apiVars: ['DEMO_BASE_URL', 'DEMO_API_KEY'],
    sharedItems: DEMO_ITEMS,
    login: { args: ['login'], hint: 'run demo login' },
    ...overrides,
  }
}

export function demoPlugin(def: FamilyDef = demoFamily(), extra?: Plugin['register']): Plugin {
  return {
    name: 'demo-family',
    async register(api) {
      api.family(def)
      await extra?.(api)
    },
  }
}

export function asBuiltin(plugin: Plugin, defaultEnabled = true): BuiltinPlugin {
  return { plugin, version: '0.0.0-test', description: 'test', defaultEnabled }
}

/** Populates a Main Account with one source for every demo Shared Item. */
export async function seedDemoMain(write: (rel: string, data: string, mode?: number) => Promise<string>) {
  await write('.demo/skills/a/SKILL.md', '# a\n')
  await write('.demo/rules.md', 'rules\n')
  await write('.demo/hooks/pre.sh', '#!/bin/sh\n', 0o755)
  await write('.demo/theme.json', '{"dark":true}\n')
  await write('.demo/trusted.toml', 'trusted = []\n')
  await write('.demo/cli.json', '{"model":"x"}\n')
  await write('.demo/config.toml', 'model = "main"\n')
  await write('.demo/auth.json', '{"token":"fake-main"}\n', 0o600)
  await write('.demo.json', '{"servers":{"a":{"cmd":"a"}},"user":"main"}\n', 0o600)
}
