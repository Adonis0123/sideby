// docs/assets/manifest.json as `pnpm lint` wants it, for scripts/readme-assets.ts `--mark`.
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

/**
 * The manifest's text, formatted by this repository's biome settings. Biome reads its config from the directory it
 * runs in, so it runs in the repository root: from anywhere else it would fall back to its defaults (tabs).
 */
export function manifestText(manifest: unknown): string {
  return execFileSync(
    join(root, 'node_modules/.bin/biome'),
    ['format', '--stdin-file-path=docs/assets/manifest.json'],
    { cwd: root, input: `${JSON.stringify(manifest, null, 2)}\n`, encoding: 'utf8' },
  )
}
