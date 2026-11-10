import type { ProfileAppDef } from '../desktop.ts'

/**
 * Grok Bot (spec §3.20 "Grok Bot 窗口", ADR-0019). It signs in with a Cursor account, apart from every grok Account,
 * so its windows are App Profiles. SAND_USER_DATA_DIR is the app's isolated mode: userData and its data root
 * (`<dir>/sand-data`) move there. Up to 0.71.x `--user-data-dir` did the same; from 0.79.3 the app sets userData
 * back to its default and ignores the flag, so the new instance loses the single-instance lock to the main window
 * and quits at once. `open --env` sets the variable for the app; the flag stays for older versions and because
 * `instanceOf` finds the window by it. The caller's own SAND_DATA_ROOT and SAND_USER_DATA_DIR are cleared so only
 * this folder counts. All of this is internal to the app and may change.
 */
export const grokBot: ProfileAppDef = {
  id: 'grok-bot',
  title: 'Grok Bot',
  bundleId: 'com.anysphere.sand',
  bundleNames: ['Grok Bot.app'],
  installUrl: 'https://x.ai/bot/',
  openArgs: (app, appData) => [
    '-n',
    '-a',
    app,
    '--env',
    `SAND_USER_DATA_DIR=${appData}`,
    '--args',
    `--user-data-dir=${appData}`,
  ],
  clearVars: ['SAND_DATA_ROOT', 'SAND_USER_DATA_DIR'],
  mainUserData: 'Library/Application Support/Grok Bot',
  statusFile: 'desktop-status.json',
  relatedFamily: 'grok',
}
