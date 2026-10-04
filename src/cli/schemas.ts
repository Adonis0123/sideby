// Writes schemas/*.json from OUTPUT_SCHEMAS. CI regenerates and fails if the result differs from git.
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OUTPUT_SCHEMAS } from './json-schemas.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas')
await mkdir(root, { recursive: true })
for (const [name, schema] of Object.entries(OUTPUT_SCHEMAS)) {
  const doc = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `sideby/${name}.json`,
    ...schema,
  }
  await writeFile(join(root, `${name}.json`), `${JSON.stringify(doc, null, 2)}\n`)
}
console.log(`wrote ${Object.keys(OUTPUT_SCHEMAS).length} schemas to schemas/`)
