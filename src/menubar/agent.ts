// The Menu Bar Item's LaunchAgent (spec §3.31, ADR-0034): `osascript` runs the script, which sits whole in the plist,
// with the Node and sideby entry that turned it on. Same rules as the Panel's login item (ADR-0029).
import type { LoginAgent } from '../core/autostart.ts'
import { MENUBAR_SCRIPT } from './script.ts'

export const MENUBAR_LABEL = 'dev.sideby.menubar'

export const MENUBAR_AGENT: LoginAgent = {
  label: MENUBAR_LABEL,
  marker: 'Written by `sideby menubar`',
  command: 'menubar',
  comment: 'shows sideby quota in the menu bar from login',
  programArguments: (l) => ['/usr/bin/osascript', '-l', 'JavaScript', '-e', MENUBAR_SCRIPT, l.node, l.entry],
  launcherPaths: (args) => args.slice(-2),
  later: 'the menu bar item appears at your next login',
  restartOnCrash: true,
  // The Hosts `menubar snapshot` asks for Quota (Grok's CLI) are found on the PATH of whoever turned it on, and the
  // config and state folders stay the ones that person uses.
  environment: (env) => {
    const out: Record<string, string> = { PATH: env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin' }
    for (const k of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME'] as const) if (env[k]) out[k] = env[k]!
    return out
  },
}
