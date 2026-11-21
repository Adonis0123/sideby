// Where Claude Code keeps an Account. A leaf module (no imports) shared by the Family, the quota setup and
// the status line tap, which must not import the Family's index on every refresh.
export const CLAUDE_MAIN_DIR = '.claude'
export const CLAUDE_ACCOUNT_PREFIX = '.claude-'
export const CLAUDE_LAYOUT = { main: CLAUDE_MAIN_DIR, account: `${CLAUDE_ACCOUNT_PREFIX}<name>` }

/** The longest folder name Claude Code keeps under `projects/` before it shortens one and adds a hash. */
const PROJECT_NAME_MAX = 200

/**
 * The folder Claude Code keeps a path's sessions and memory in under `projects/`: every character that is not an
 * ASCII letter or digit becomes `-`; a name longer than 200 characters is cut there and gets `-` and a base-36 hash
 * of the whole path (the 32-bit `(h << 5) - h + c` string hash, UTF-16 units). Read from Claude Code 2.1.328 on
 * 2026-11-20 (ADR-0081).
 */
export function claudeProjectDirName(path: string): string {
  const name = path.replace(/[^a-zA-Z0-9]/g, '-')
  if (name.length <= PROJECT_NAME_MAX) return name
  let h = 0
  for (let i = 0; i < path.length; i++) h = ((h << 5) - h + path.charCodeAt(i)) | 0
  return `${name.slice(0, PROJECT_NAME_MAX)}-${Math.abs(h).toString(36)}`
}
