// Sets `metadata.version` in skills/sideby/SKILL.md to the package version. npm runs it from the `version`
// script, so `npm version <x>` commits both together; src/core/skill-version.test.ts fails when they differ.
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('..', import.meta.url)
const { version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as { version: string }
const file = fileURLToPath(new URL('skills/sideby/SKILL.md', root))
const text = await readFile(file, 'utf8')
const next = text.replace(
  /^(metadata:[ \t]*\r?\n(?:[ \t]+.*\r?\n)*?[ \t]+version:[ \t]*)(['"]?)[^'"\s]*\2/m,
  `$1"${version}"`,
)
if (next === text && !text.includes(`version: "${version}"`)) {
  console.error(
    `sync-skill-version: no metadata.version in ${file}; add "metadata:\\n  version: \\"${version}\\"" to its frontmatter`,
  )
  process.exit(1)
}
await writeFile(file, next)
console.log(`skills/sideby/SKILL.md metadata.version = ${version}`)
