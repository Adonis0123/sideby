// Runs `sideby plugins check`'s rules over every built-in Family (spec §3.28), so a built-in passes the same bar a
// contributed plugin must. CI runs it after `pnpm check`; exit 1 lists each problem with its fix.
import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { BUILTIN_PLUGINS } from '../src/families/index.ts'
import { checkBuiltinPlugin } from '../src/plugins/check.ts'

const root = new URL('..', import.meta.url)
let failed = 0
for (const { plugin } of BUILTIN_PLUGINS) {
  const dir = fileURLToPath(new URL(`src/families/${plugin.name}/`, root))
  // Built-ins without a folder of their own (account-script) register no Family.
  if (!(await stat(dir).catch(() => null))?.isDirectory()) continue
  const result = await checkBuiltinPlugin({ plugin, dir })
  if (result.ok) {
    console.log(`check-families: ${plugin.name} ok (${result.families.join(', ')})`)
    continue
  }
  failed++
  for (const p of result.problems)
    console.error(`check-families: ${plugin.name}: [${p.code}] ${p.message}\n  fix: ${p.fix}`)
}
process.exit(failed ? 1 : 0)
