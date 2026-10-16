import type { DesktopAppDef } from '../desktop.ts'

/**
 * Claude Desktop (spec §3.20). Its Code tab honours CLAUDE_CONFIG_DIR; the data folder moves only with
 * `--user-data-dir` (signed builds ignore CLAUDE_USER_DATA_DIR).
 */
export const claudeDesktop: DesktopAppDef = {
  family: 'claude',
  title: 'Claude Desktop',
  bundleId: 'com.anthropic.claudefordesktop',
  bundleNames: ['Claude.app'],
  installUrl: 'https://claude.ai/download',
  openArgs: (app, dir, appData) => [
    '-n',
    '-a',
    app,
    '--env',
    `CLAUDE_CONFIG_DIR=${dir}`,
    '--args',
    `--user-data-dir=${appData}`,
  ],
  clearVars: ['CLAUDE_USER_DATA_DIR'],
  signInInApp: true,
  sharedFiles: [
    {
      path: 'claude_desktop_config.json',
      mainPath: 'Library/Application Support/Claude/claude_desktop_config.json',
      key: 'mcpServers',
    },
  ],
}
