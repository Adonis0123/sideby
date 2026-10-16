import type { ProfileAppDef } from '../desktop.ts'

/**
 * Grok Bot (spec §3.20 "Grok Bot 窗口", ADR-0019). It signs in with a Cursor account, apart from every grok Account,
 * so its windows are App Profiles. `--user-data-dir` is the app's isolated mode: userData and its data root
 * (`<dir>/sand-data`) move there. SAND_DATA_ROOT and SAND_USER_DATA_DIR would override it; all of this is internal to
 * the app and may change.
 */
export const grokBot: ProfileAppDef = {
  id: 'grok-bot',
  title: 'Grok Bot',
  bundleId: 'com.anysphere.sand',
  bundleNames: ['Grok Bot.app'],
  installUrl: 'https://x.ai/bot/',
  openArgs: (app, appData) => ['-n', '-a', app, '--args', `--user-data-dir=${appData}`],
  clearVars: ['SAND_DATA_ROOT', 'SAND_USER_DATA_DIR'],
  mainUserData: 'Library/Application Support/Grok Bot',
  statusFile: 'desktop-status.json',
  relatedFamily: 'grok',
}
