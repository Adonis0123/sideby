import type { SharedItemDef } from '../types.ts'

/**
 * What one Shared Item looks like in an Account, in one fixed English sentence for `sideby families` (spec §3.16).
 * Agents quote it to users, so it follows the Share Mode rules of spec §3.3 and never promises more.
 */
export function shareMeaning(item: SharedItemDef): string {
  const main = item.mainPath ? `~/${item.mainPath}` : "the Main Account's"
  const base = ((): string => {
    switch (item.mode) {
      case 'link':
        return "A link to the Main Account's: one copy for every Account."
      case 'copy':
        return "A copy of the Main Account's, kept equal by `doctor --fix`; the Host does not accept a link here."
      case 'link-or-copy':
        return "A link to the Main Account's, or a copy kept equal by `doctor --fix`."
      case 'link-or-local':
        return "A link to the Main Account's, unless the Account keeps its own file."
      case 'local':
        return "The Account's own file, first copied from the Main Account and never synced."
      case 'local-if-api':
        return item.noSymlink
          ? "Subscription Accounts: a copy of the Main Account's, kept equal by `doctor --fix`. API Accounts: their own file."
          : "Subscription Accounts: a link to the Main Account's, or a copy kept equal. API Accounts: their own file."
      case 'info':
        return item.credential
          ? "The Account's own sign-in: never shared and never read; sideby checks only that it is mode 600."
          : "The Account's own; sideby only reports it."
      case 'json-key':
        return `The Account's own file; only its \`${item.key}\` entry is kept equal to ${main}${
          item.credential ? ', and sideby reads no other part of it' : ''
        }.`
    }
  })()
  return item.noSymlink && item.mode !== 'copy' ? `${base} Never a link: the Host refuses one.` : base
}
