// Retakes the README Panel screenshots in docs/assets: light and dark, each with the browser language English
// and Chinese (the Panel follows navigator.language when no language was picked), 1280×860, from the `normal`
// demo HOME. Needs Node 22.18+ and Chrome or Chromium (set CHROME to its binary if it is elsewhere).
// Usage, from the repository root:
//   node scripts/shoot-panel.ts            write all four PNGs
//   node scripts/shoot-panel.ts --out <d>  write them to <d> instead, for a look before replacing
// Do not point it at a real HOME: everything runs inside a throwaway demo HOME.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { demoHome, openChrome, root, startPanel, workDir } from './chrome.ts'

const outArg = process.argv.indexOf('--out')
const out = outArg === -1 ? join(root, 'docs/assets') : resolve(process.argv[outArg + 1] ?? '.')
mkdirSync(out, { recursive: true })

const work = workDir('sideby-shoot-')
const panelUrl = await startPanel(demoHome(join(work, 'demo')), 17422)
const chrome = await openChrome(work)
// Scripts added for new documents run only once the Page domain is on.
await chrome.page('Page.enable')
await chrome.page('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 860,
  deviceScaleFactor: 1,
  mobile: false,
})

const shots = [
  { file: 'panel.png', scheme: 'light', lang: 'en-US' },
  { file: 'panel-dark.png', scheme: 'dark', lang: 'en-US' },
  { file: 'panel.zh-CN.png', scheme: 'light', lang: 'zh-CN' },
  { file: 'panel-dark.zh-CN.png', scheme: 'dark', lang: 'zh-CN' },
]
let langScript: string | undefined
for (const shot of shots) {
  if (langScript) await chrome.page('Page.removeScriptToEvaluateOnNewDocument', { identifier: langScript })
  langScript = (
    await chrome.page('Page.addScriptToEvaluateOnNewDocument', {
      source: `Object.defineProperty(navigator, 'language', { get: () => ${JSON.stringify(shot.lang)} })`,
    })
  ).identifier
  await chrome.page('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: shot.scheme }],
  })
  await chrome.page('Page.navigate', { url: panelUrl })
  await chrome.until(
    `document.documentElement.lang.startsWith(${JSON.stringify(shot.lang.slice(0, 2))}) &&
      /\\d+%/.test(document.querySelector('.row[data-ref="claude:work"] .quota')?.innerText ?? '')`,
    `the ${shot.lang} Panel to load quota`,
  )
  await new Promise((r) => setTimeout(r, 800))
  writeFileSync(join(out, shot.file), await chrome.screenshot())
  console.log(`wrote ${join(out, shot.file)}`)
}
await chrome.close()
process.exit(0)
