import type { DesktopAppDef } from '../desktop.ts'

/**
 * The Codex app (`ChatGPT.app`, spec §3.20). It shares the Account's terminal sign-in through CODEX_HOME. Its own
 * code replaces the path `--user-data-dir` sets, so CODEX_ELECTRON_USER_DATA_PATH goes along (the app's "Codex Demo"
 * recipe); both are internal to the app and may change.
 */
export const codexDesktop: DesktopAppDef = {
  family: 'codex',
  title: 'Codex app',
  bundleId: 'com.openai.codex',
  bundleNames: ['ChatGPT.app', 'Codex.app'],
  installUrl: 'https://openai.com/codex/',
  openArgs: (app, dir, appData) => [
    '-n',
    '--env',
    `CODEX_HOME=${dir}`,
    '--env',
    `CODEX_ELECTRON_USER_DATA_PATH=${appData}`,
    app,
    '--args',
    `--user-data-dir=${appData}`,
  ],
  clearVars: ['CODEX_ELECTRON_USER_DATA_PATH'],
  signInInApp: false,
  sharedFiles: [],
}
