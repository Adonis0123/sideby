import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../testing/index.ts'
import { UserError } from '../core/errors.ts'
import { createRuntime } from '../runtime.ts'
import { pluginIdProblem, scaffoldPlugin, TODO_MARK } from './scaffold.ts'

describe('scaffoldPlugin', () => {
  it('writes a private skeleton the real loader accepts', async () => {
    await withFakeHome(async (h) => {
      const res = await scaffoldPlugin({ id: 'mytool', dir: h.path('.config/sideby/plugins') })
      assert.equal(res.dir, h.path('.config/sideby/plugins/mytool'))
      assert.deepEqual(
        res.files.map((f) => f.slice(res.dir.length + 1)),
        ['plugin.json', 'index.ts', 'index.test.ts'],
      )
      assert.equal((await stat(res.dir)).mode & 0o777, 0o700)
      for (const f of res.files) assert.equal((await stat(f)).mode & 0o777, 0o600)
      const index = await readFile(join(res.dir, 'index.ts'), 'utf8')
      assert.match(index, /^import type \{ FamilyDef, Plugin \} from 'sideby'$/m)
      for (const field of [
        'title',
        'bin',
        'installUrl',
        'selectVar',
        'layout',
        'hijackVars',
        'apiVars',
        'sharedItems',
        'login',
      ])
        assert.match(
          index,
          new RegExp(`${TODO_MARK.replace(/[()]/g, '\\$&')}[^\\n]*\\n(?:\\s*//[^\\n]*\\n)*\\s*${field}:`),
          field,
        )

      const rt = await createRuntime({ env: h.env, builtins: [] })
      assert.deepEqual(rt.pluginErrors, [])
      assert.deepEqual(
        rt.plugins.map((p) => [p.name, p.families]),
        [['mytool', ['mytool']]],
      )
      assert.equal(rt.families.get('mytool')?.selectVar, 'MYTOOL_HOME')
    })
  })

  it('refuses an existing directory and bad ids before writing', async () => {
    await withFakeHome(async (h) => {
      const dir = h.path('plugins')
      await scaffoldPlugin({ id: 'my-tool', dir })
      await assert.rejects(scaffoldPlugin({ id: 'my-tool', dir }), (err: unknown) => {
        assert.ok(err instanceof UserError)
        assert.equal(err.code, 'plugin-exists')
        assert.match(err.message, /sideby plugins check my-tool/)
        return true
      })
      for (const id of ['', 'MyTool', '1tool', 'a/b', '../x', 'a'.repeat(33), 'my_tool']) {
        assert.ok(pluginIdProblem(id), id)
        await assert.rejects(scaffoldPlugin({ id, dir }), (err: unknown) => {
          assert.ok(err instanceof UserError)
          assert.equal(err.code, 'plugin-id-invalid')
          return true
        })
      }
      assert.equal(pluginIdProblem('mytool'), null)
    })
  })
})
