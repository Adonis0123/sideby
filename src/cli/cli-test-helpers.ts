// Shared by the src/cli/cli-*.test.ts files (spec §5: 1, 2, 3, 11, 12 and the --json contract), which run `sideby`
// as real child processes against a fake HOME and fake Host binaries.
// Kept out of dist/ by tsconfig.build.json.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Value } from 'typebox/value'
import type { FakeHome } from '../../testing/index.ts'
import { OUTPUT_SCHEMAS } from './json-schemas.ts'

export const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url))

export interface Run {
  code: number | null
  signal: NodeJS.Signals | null
  out: string
  err: string
}

export function sideby(h: FakeHome, args: string[], extraEnv: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN, ...args], {
      env: { ...h.env, ...extraEnv } as NodeJS.ProcessEnv,
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d))
    child.stderr.on('data', (d: Buffer) => (err += d))
    child.on('exit', (code, signal) => resolve({ code, signal, out, err }))
  })
}

export function checkSchema(name: string, text: string) {
  const data: unknown = JSON.parse(text)
  const schema = OUTPUT_SCHEMAS[name]!
  assert.ok(
    Value.Check(schema, data),
    `${name}: ${JSON.stringify([...Value.Errors(schema, data)].slice(0, 3))}`,
  )
  return data as Record<string, unknown>
}

export async function codexMain(h: FakeHome) {
  await h.write('.codex/config.toml', 'model = "gpt-main"\n')
  await h.write('.codex/AGENTS.md', '# rules\n')
  await h.mkdir('.codex/skills')
}
