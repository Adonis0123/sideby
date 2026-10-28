// Retakes the README pictures of the Menu Bar Item's menu (spec §3.31) in docs/assets: light and dark, English and
// Chinese, from the `normal` demo HOME. macOS only. It runs the real menu bar script with the demo data, lays a
// plain backdrop where the menu drops, so its translucent material blurs nothing of the desktop, moves the pointer
// onto that backdrop so no row is highlighted, opens the menu from its icon and captures the screen area of the menu
// (a window capture would miss the material's colour). The pointer goes back afterwards. The screen shows a plain
// panel and the menu for about two seconds per picture.
// Usage, from the repository root:
//   node scripts/shoot-menubar.ts            write all four PNGs
//   node scripts/shoot-menubar.ts --out <d>  write them to <d> instead, for a look before replacing
// When the menu bar is too full to show one more icon, the script stops: hold ⌘ and drag icons to make room.
// Keep hands off the mouse and keyboard while it runs: a real move, click or key press while the menu is open
// highlights a row (a letter jumps to the row it starts) or closes the menu, so the picture is retaken.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { MENUBAR_SCRIPT } from '../src/menubar/script.ts'
import { cli, demoHome, fail, root, track, workDir } from './chrome.ts'

if (process.platform !== 'darwin') fail('shoot-menubar: the menu bar item runs on macOS only')

const outArg = process.argv.indexOf('--out')
const out = outArg === -1 ? join(root, 'docs/assets') : resolve(process.argv[outArg + 1] ?? '.')
mkdirSync(out, { recursive: true })

const work = workDir('sideby-shoot-menubar-')
const env = demoHome(join(work, 'demo'))

const shots = [
  { file: 'menubar.png', dark: false, lang: 'en' },
  { file: 'menubar-dark.png', dark: true, lang: 'en' },
  { file: 'menubar.zh-CN.png', dark: false, lang: 'zh' },
  { file: 'menubar-dark.zh-CN.png', dark: true, lang: 'zh' },
]

/** The menu bar script with a fixed language and appearance, no remembered place, and a timer that opens the menu. */
function harness(lang: string, dark: boolean): string {
  let s = MENUBAR_SCRIPT
  const swap = (from: RegExp | string, to: string) => {
    const next = s.replace(from, to)
    if (next === s)
      fail(`shoot-menubar: the menu bar script changed; update the harness near ${String(from)}`)
    s = next
  }
  swap(/ {2}var lang = 'en';\n {2}try \{[^\n]*\n/, `  var lang = ${JSON.stringify(lang)};\n`)
  swap(
    '  var app = $.NSApplication.sharedApplication;\n',
    `  var app = $.NSApplication.sharedApplication;\n  app.appearance = $.NSAppearance.appearanceNamed(${dark ? '$.NSAppearanceNameDarkAqua' : '$.NSAppearanceNameAqua'});\n`,
  )
  // A second item under the same name would move the real one.
  swap("  item.autosaveName = 'dev.sideby.menubar';\n", '')
  swap(
    '  app.run;\n',
    `  var shot = false;
  ObjC.registerSubclass({ name: 'ShootMenu', methods: { 'go:': { types: ['void', ['id']], implementation: function () {
    if (shot || !snap || task) return;
    shot = true;
    var w = item.button.window;
    if (!(w && !w.isNil() && (w.occlusionState & $.NSWindowOcclusionStateVisible))) $.exit(3);
    var f = w.frame;
    var back = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(f.origin.x - 60, f.origin.y - 1000, 760, 995), $.NSWindowStyleMaskBorderless, $.NSBackingStoreBuffered, false);
    back.backgroundColor = $.NSColor.colorWithSRGBRedGreenBlueAlpha(${dark ? '0.12, 0.12, 0.13' : '0.96, 0.96, 0.97'}, 1);
    back.level = $.NSStatusWindowLevel;
    back.orderFrontRegardless;
    // Off the menu, onto the backdrop, so no row is highlighted; back where it was a few seconds later.
    var top = $.NSScreen.screens.firstObject.frame.size.height, was = $.NSEvent.mouseLocation;
    $.CGWarpMouseCursorPosition($.CGPointMake(f.origin.x - 30, top - f.origin.y + 300));
    ObjC.registerSubclass({ name: 'ShootBack', methods: { 'back:': { types: ['void', ['id']], implementation: function () {
      $.CGWarpMouseCursorPosition($.CGPointMake(was.x, top - was.y));
    } } } });
    $.NSRunLoop.currentRunLoop.addTimerForMode($.NSTimer.timerWithTimeIntervalTargetSelectorUserInfoRepeats(2.5, $.ShootBack.alloc.init, 'back:', $(), false), $.NSRunLoopCommonModes);
    // A status item's menu follows the menu bar's appearance, not the app's.
    item.menu.appearance = app.appearance;
    item.button.performClick(null);
  } } } });
  var shooter = $.ShootMenu.alloc.init;
  $.NSRunLoop.currentRunLoop.addTimerForMode($.NSTimer.timerWithTimeIntervalTargetSelectorUserInfoRepeats(0.5, shooter, 'go:', $(), true), $.NSRunLoopCommonModes);
  app.run;
`,
  )
  return `ObjC.import('stdlib');\nObjC.import('CoreGraphics');\n${s}`
}

// The screen area (x,y,w,h, top-left origin) of `pid`'s open menu: its window above the menu bar level.
const FIND_MENU = `ObjC.import('CoreGraphics');
function run(argv) {
  var list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0));
  for (var i = 0; i < list.count; i++) {
    var w = list.objectAtIndex(i);
    if (ObjC.unwrap(w.objectForKey('kCGWindowOwnerPID')) !== Number(argv[0])) continue;
    if (ObjC.unwrap(w.objectForKey('kCGWindowBounds').objectForKey('Height')) < 200) continue;
    if (ObjC.unwrap(w.objectForKey('kCGWindowLayer')) < 100) continue;
    var b = w.objectForKey('kCGWindowBounds');
    return ['X', 'Y', 'Width', 'Height'].map(function (k) { return Math.round(ObjC.unwrap(b.objectForKey(k))); }).join(',');
  }
  return '';
}`
const findMenu = join(work, 'find-menu.js')
writeFileSync(findMenu, FIND_MENU)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Seconds since the last real mouse or keyboard input (the pointer moves made here do not count). */
function idleSeconds(): number {
  // kCGAnyInputEventType (~0) has no name in the JavaScript bridge.
  const js =
    "ObjC.import('CoreGraphics'); $.CGEventSourceSecondsSinceLastEventType($.kCGEventSourceStateHIDSystemState, 0xFFFFFFFF)"
  return Number(
    execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', js], { encoding: 'utf8' }).trim(),
  )
}

const TRIES = 5

async function shoot(shot: (typeof shots)[number]): Promise<void> {
  for (let i = 1; i <= TRIES; i++) {
    if (await shootOnce(shot)) return
    console.log(
      `${shot.file}: the mouse or keyboard was used while the menu was open; taking it again (${i}/${TRIES})`,
    )
  }
  fail(
    `shoot-menubar: ${shot.file} was disturbed ${TRIES} times; keep hands off the mouse and keyboard while it runs`,
  )
}

/** One picture; false when real input arrived while the menu was open, so the picture may show a highlighted row
 *  or no menu at all. */
async function shootOnce(shot: (typeof shots)[number]): Promise<boolean> {
  const file = join(work, `menubar-${shot.lang}-${shot.dark ? 'dark' : 'light'}.js`)
  writeFileSync(file, harness(shot.lang, shot.dark))
  const child: ChildProcess = track(
    spawn('/usr/bin/osascript', ['-l', 'JavaScript', file, process.execPath, cli], { env, stdio: 'ignore' }),
  )
  let exited: number | null = null
  child.on('exit', (code) => {
    exited = code ?? 1
  })
  for (let i = 0; i < 120; i++) {
    if (exited === 3)
      fail('shoot-menubar: the demo icon has no room in the menu bar; hold ⌘ and drag icons to make room')
    if (exited !== null) fail(`shoot-menubar: the menu bar script stopped (exit ${exited})`)
    const area = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', findMenu, String(child.pid)], {
      encoding: 'utf8',
    }).trim()
    if (area) {
      // The menu opened at most one poll and one window lookup (about 500 ms) before it was found.
      const opened = Date.now() - 500
      await sleep(700)
      execFileSync('/usr/sbin/screencapture', ['-x', '-R', area, join(out, shot.file)])
      const calm = idleSeconds() * 1000 > Date.now() - opened
      // The pointer goes back 2.5 s after the menu opened.
      await sleep(2200)
      child.kill()
      await sleep(400)
      if (calm) console.log(`wrote ${join(out, shot.file)}`)
      return calm
    }
    await sleep(250)
  }
  child.kill()
  return fail('shoot-menubar: the menu did not open within 30 s')
}

for (const shot of shots) await shoot(shot)
process.exit(0)
