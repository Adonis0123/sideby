// The Panel's `ask` option (ADR-0030): in a Portal that offers AI Tasks itself, the Panel hides its own "Let AI do
// it" button and every AI Task entry posts the task to the Portal instead of opening the Panel's dialog. Also the
// `ai-tasks.json` declaration the package ships, whose words must stay the Panel's.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import { withFakeHome } from '../../testing/index.ts'
import { SKILL_INSTALL } from '../core/skill-check.ts'
import { createRuntime } from '../runtime.ts'
import { createPanelHandler, type PanelHandlerOptions } from './handler.ts'
import { MESSAGES } from './i18n.ts'
import { AI_TASK_KINDS, askBridge, askBridged } from './page-logic.ts'
import { PAGE_SCRIPT } from './page-script.ts'

async function page(ask?: PanelHandlerOptions['ask']) {
  return withFakeHome(async (h) => {
    let handler: ReturnType<typeof createPanelHandler> | undefined
    const server = createServer((req, res) => {
      void handler!(req, res).then((done) => {
        if (!done) res.writeHead(404).end()
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    handler = createPanelHandler({
      runtime: () => createRuntime({ env: h.env }),
      allowedHosts: [`127.0.0.1:${port}`],
      ...(ask ? { ask } : {}),
    })
    try {
      return await new Promise<{ html: string; csp: string }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: '/' }, (res) => {
          let html = ''
          res.on('data', (d: Buffer) => (html += d))
          res.on('end', () => resolve({ html, csp: String(res.headers['content-security-policy']) }))
        })
        req.on('error', reject)
        req.end()
      })
    } finally {
      await new Promise<void>((r) => {
        server.close(() => r())
        server.closeAllConnections()
      })
    }
  })
}

const boot = (html: string) =>
  JSON.parse(/<script type="application\/json" id="sideby-boot">(.*?)<\/script>/s.exec(html)![1]!)
const askButton = (html: string) => /<button id="ask-ai"[^>]*>/.exec(html)![0]

describe('Panel ask bridge', () => {
  it('tells the page about the bridge only with the option, and never hides the button in the HTML', async () => {
    const plain = await page()
    const bridged = await page({ bridge: 'postMessage' })
    assert.ok(!askButton(plain.html).includes('hidden'))
    assert.equal(boot(plain.html).ask, null)
    // Regression: a Panel with the option opened on its own (not in a frame) must keep its "Let AI do it" button, so
    // the server cannot hide it; the page decides at load whether it sits in a frame.
    assert.ok(!askButton(bridged.html).includes('hidden'))
    assert.deepEqual(boot(bridged.html).ask, { bridge: 'postMessage' })
    // The CSP is the same either way, minus the per-response nonce.
    const noNonce = (csp: string) => csp.replace(/'nonce-[^']+'/g, "'nonce'")
    assert.equal(noNonce(bridged.csp), noNonce(plain.csp))
    assert.match(bridged.csp, /frame-ancestors 'self'/)
  })

  it('hides the header button at load only inside a frame with the bridge', () => {
    const ctx: { askBridged?: typeof askBridged } = {}
    runInNewContext(`${askBridged.toString()}; this.askBridged = askBridged`, ctx)
    const bridged = ctx.askBridged!
    const on = { ask: { bridge: 'postMessage' } }
    const framed = { parent: {} }
    const alone: { parent: unknown } = { parent: null }
    alone.parent = alone
    assert.equal(bridged(on, framed), true)
    assert.equal(bridged(on, alone), false, 'opened on its own: the button stays')
    assert.equal(bridged({ ask: null }, framed), false)
    assert.equal(bridged({}, alone), false)
    // The page applies it to the button when it loads.
    assert.ok(PAGE_SCRIPT.includes("$('ask-ai').hidden = askBridged(BOOT, window)"))
  })

  it('refuses any other ask option when the handler is created', () => {
    for (const ask of [{ bridge: 'dialog' }, { bridge: 'postMessage', extra: 1 }, 'postMessage', null])
      assert.throws(
        () =>
          createPanelHandler({
            runtime: async () => {
              throw new Error('not used')
            },
            allowedHosts: ['127.0.0.1:1'],
            ask: ask as PanelHandlerOptions['ask'],
          }),
        TypeError,
      )
  })

  it('posts each entry’s task to the parent at the Panel’s own origin, and opens no dialog', () => {
    // The function as the page runs it: serialized into the inline script, evaluated without Node or TypeScript.
    const ctx: { askBridge?: typeof askBridge } = {}
    runInNewContext(`${askBridged.toString()}; ${askBridge.toString()}; this.askBridge = askBridge`, ctx)
    const run = ctx.askBridge!
    const posted: { message: unknown; origin: string }[] = []
    const win = {
      parent: { postMessage: (message: unknown, origin: string) => posted.push({ message, origin }) },
      location: { origin: 'http://accounts.localhost:17420' },
    }
    const on = { ask: { bridge: 'postMessage' } }
    const context = { findings: [{ message: 'broken link' }], version: '0.0.0-test' }
    assert.equal(run(on, { task: 'fix', context }, win), true)
    assert.equal(run(on, { task: 'account', text: 'I have a key', context: { family: 'claude' } }, win), true)
    assert.equal(run(on, undefined, win), true)
    assert.deepEqual(JSON.parse(JSON.stringify(posted)), [
      {
        message: {
          type: 'local-tools:ask',
          version: 1,
          preset: 'fix',
          native: { task: 'fix', text: '', context },
          text: '',
        },
        origin: 'http://accounts.localhost:17420',
      },
      {
        message: {
          type: 'local-tools:ask',
          version: 1,
          preset: 'account',
          native: { task: 'account', text: 'I have a key', context: { family: 'claude' } },
          text: 'I have a key',
        },
        origin: 'http://accounts.localhost:17420',
      },
      {
        message: {
          type: 'local-tools:ask',
          version: 1,
          preset: 'free',
          native: { task: 'free', text: '', context: {} },
          text: '',
        },
        origin: 'http://accounts.localhost:17420',
      },
    ])
    // Without the option, or opened on its own (its own parent), the Panel keeps its dialog and posts nothing.
    const alone = { ...win, parent: null as unknown as typeof win.parent }
    const self: Record<string, unknown> = { location: win.location }
    self.parent = self
    assert.equal(run({ ask: null }, { task: 'fix' }, win), false)
    assert.equal(run({}, { task: 'fix' }, win), false)
    assert.equal(run(on, { task: 'fix' }, alone), false)
    assert.equal(run(on, { task: 'fix' }, self as unknown as typeof win), false)
    assert.equal(posted.length, 3)
  })

  it('routes every AI Task entry through the bridge before the dialog opens', () => {
    const open = /function openAsk\(opts\) \{([\s\S]*?)\n {2}\}/.exec(PAGE_SCRIPT)![1]!
    const bridge = open.indexOf('if (askBridge(BOOT, opts, window)) return')
    assert.ok(bridge > 0, 'openAsk asks the bridge first')
    assert.ok(bridge < open.indexOf("showDialog('ask')"), 'before the dialog opens')
    // No entry opens the dialog any other way.
    assert.equal(PAGE_SCRIPT.split("showDialog('ask')").length, 2)
    for (const task of AI_TASK_KINDS.filter((t) => t !== 'free'))
      assert.ok(PAGE_SCRIPT.includes(`openAsk({ task: '${task}'`), `the ${task} entry uses openAsk`)
  })
})

describe('ai-tasks.json', () => {
  it('declares one native preset per AI Task with the Panel’s own words', async () => {
    const decl = JSON.parse(await readFile(new URL('../../ai-tasks.json', import.meta.url), 'utf8'))
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
    assert.ok(pkg.files.includes('ai-tasks.json'), 'the package ships it')
    assert.equal(decl.version, 1)
    const tool = decl.tools.accounts
    assert.equal(tool.skill, 'sideby')
    assert.equal(tool.skillInstall, SKILL_INSTALL)
    assert.equal(tool.cwd, 'engine')
    assert.deepEqual(tool.contribute, {
      repo: 'https://github.com/Adonis0123/sideby',
      guide: 'CONTRIBUTING.md',
    })
    // `free` is the Portal's own button; every other AI Task is a native preset.
    assert.deepEqual(
      tool.presets.map((p: { id: string }) => p.id),
      AI_TASK_KINDS.filter((t) => t !== 'free'),
    )
    for (const p of tool.presets) {
      assert.equal(p.native, true)
      assert.equal(p.what, undefined)
      assert.equal(p.pointers, undefined)
      for (const lang of ['en', 'zh'] as const) {
        const m = MESSAGES[lang]
        assert.equal(p.title[lang], m[`ask.title.${p.id}`], `${p.id} title ${lang}`)
        assert.equal(p.placeholder[lang], m[`ask.ph.${p.id}`], `${p.id} placeholder ${lang}`)
        const examples = [1, 2, 3].map((n) => m[`ask.ex.${p.id}.${n}`]).filter(Boolean)
        assert.deepEqual(
          p.examples.map((e: Record<string, string>) => e[lang]),
          examples,
          `${p.id} examples ${lang}`,
        )
      }
    }
  })
})
