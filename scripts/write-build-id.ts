// Writes dist/build.json with a fresh id after each `pnpm build`, so running Panels can tell new code from old
// even when the version is the same (see buildId in src/core/version.ts).
import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'

const id = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}-${randomBytes(3).toString('hex')}`
await writeFile(new URL('../dist/build.json', import.meta.url), `${JSON.stringify({ id })}\n`)
console.log(`dist/build.json id = ${id}`)
