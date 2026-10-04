// Where Claude Code keeps an Account. A leaf module (no imports) shared by the Family, the quota setup and
// the status line tap, which must not import the Family's index on every refresh.
export const CLAUDE_MAIN_DIR = '.claude'
export const CLAUDE_ACCOUNT_PREFIX = '.claude-'
export const CLAUDE_LAYOUT = { main: CLAUDE_MAIN_DIR, account: `${CLAUDE_ACCOUNT_PREFIX}<name>` }
