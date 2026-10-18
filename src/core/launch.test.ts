import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { asBuiltin, demoFamily, demoPlugin, seedDemoMain } from '../../testing/demo.ts'
import { withFakeHome } from '../../testing/index.ts'
import { createRuntime } from '../runtime.ts'

const DROP = '--skip-checks'
const config = JSON.stringify({ accounts: { 'demo:main': { args: ['--model', 'm', DROP] } } })

describe('AI Task launches (ADR-0031)', () => {
  it('a Family without aiTaskArgs launches an AI Task with the arguments unchanged', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      await h.write('.config/sideby/config.json', config)
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin())] })
      const task = await rt.prepareLaunch('demo:main', ['hi'], 'run', { aiTask: true })
      assert.deepEqual(task.args, ['--model', 'm', DROP, 'hi'])
    })
  })

  it("applies the Family's aiTaskArgs to AI Tasks only, also after a launch.before hook", async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      await h.write('.config/sideby/config.json', config)
      const def = demoFamily({ aiTaskArgs: (args) => args.filter((a) => a !== DROP) })
      const plugin = demoPlugin(def, (api) => {
        api.on('launch.before', (ctx) => {
          ctx.args.push(DROP)
        })
      })
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(plugin)] })
      assert.deepEqual((await rt.prepareLaunch('demo:main', ['hi'], 'run', { aiTask: true })).args, [
        '--model',
        'm',
        'hi',
      ])
      assert.deepEqual((await rt.prepareLaunch('demo:main', ['hi'], 'run')).args, [
        '--model',
        'm',
        DROP,
        'hi',
        DROP,
      ])
    })
  })
})
