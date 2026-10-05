/**
 * An error caused by what the user asked for or has on disk (unknown account, broken config, invalid name),
 * as opposed to a bug. Adapters map it without a stack: the CLI exits 1, the Panel answers 400.
 * Command-line shape errors (`UsageError`, exit 2) are deliberately not UserErrors.
 */
export class UserError extends Error {
  /** Machine-readable reason, such as `create-refused`; the Panel passes it to the page. */
  readonly code?: string
  constructor(message: string, opts: { code?: string } = {}) {
    super(message)
    if (opts.code) this.code = opts.code
  }
}
