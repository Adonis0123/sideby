/**
 * An error caused by what the user asked for or has on disk (unknown account, broken config, invalid name),
 * as opposed to a bug. Adapters map it without a stack: the CLI exits 1, the Panel answers 400.
 * Command-line shape errors (`UsageError`, exit 2) are deliberately not UserErrors.
 */
export class UserError extends Error {}
