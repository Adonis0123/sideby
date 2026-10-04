import { packageVersion } from '../core/version.ts'
import { accountScript } from '../plugins/account-script.ts'
import type { BuiltinPlugin } from '../plugins/loader.ts'
import { claudePlugin } from './claude/index.ts'
import { codexPlugin } from './codex/index.ts'
import { grokPlugin } from './grok/index.ts'
import { piPlugin } from './pi/index.ts'

const VERSION = packageVersion()

/** Built-in Plugins in load order. Families register here; `account-script` is off unless enabled. */
export const BUILTIN_PLUGINS: BuiltinPlugin[] = [
  {
    plugin: claudePlugin,
    version: VERSION,
    description: 'Claude Code family (~/.claude, CLAUDE_CONFIG_DIR)',
    defaultEnabled: true,
  },
  {
    plugin: codexPlugin,
    version: VERSION,
    description: 'Codex family (~/.codex, CODEX_HOME)',
    defaultEnabled: true,
  },
  {
    plugin: grokPlugin,
    version: VERSION,
    description: 'Grok Build family (~/.grok, GROK_HOME)',
    defaultEnabled: true,
  },
  {
    plugin: piPlugin,
    version: VERSION,
    description: 'pi family (~/.pi/agent, PI_CODING_AGENT_DIR)',
    defaultEnabled: true,
  },
  {
    plugin: accountScript,
    version: VERSION,
    description: 'Run <account>/sideby-before-launch before each launch',
    defaultEnabled: false,
  },
]
