// Desktop Apps of the built-in Families (spec §3.20, ADR-0015) and apps with App Profiles (ADR-0019). Internal on
// purpose: not part of the public FamilyDef, so plugin Families cannot declare one in v1.
import { claudeDesktop } from './claude/desktop.ts'
import { codexDesktop } from './codex/desktop.ts'
import { grokBot } from './grok/bot.ts'

export interface DesktopAppDef {
  /** The Family id. */
  family: string
  /** How messages name the app, for example `Claude Desktop`. */
  title: string
  /** `CFBundleIdentifier` in the app's Info.plist. */
  bundleId: string
  /** Bundle names to look for first in /Applications and ~/Applications. */
  bundleNames: readonly string[]
  installUrl: string
  /**
   * `open` arguments for a non-main Account: a new instance (`-n`) with the Account's selecting variable and
   * App Data. `app` is the bundle path, `dir` the Account directory.
   */
  openArgs(app: string, dir: string, appData: string): string[]
  /** Inherited variables cleared before `open`, besides the Family's Hijack Variables and selecting variable. */
  clearVars: readonly string[]
  /** The first sign-in happens inside the app, through a URL callback another running instance may catch. */
  signInInApp: boolean
  /** Files of the App Data shared from the Main Account's default App Data as links (`mainPath` relative to HOME). */
  sharedFiles: readonly { path: string; mainPath: string }[]
}

const DESKTOP_APPS: ReadonlyMap<string, DesktopAppDef> = new Map(
  [claudeDesktop, codexDesktop].map((d) => [d.family, d]),
)

/** The Desktop App of a built-in Family id, if it has one. */
export function desktopDef(familyId: string): DesktopAppDef | undefined {
  return DESKTOP_APPS.get(familyId)
}

/**
 * A desktop app that signs in apart from every Account (Grok Bot), so each of its windows is an App Profile with its
 * own App Data, named by the user (ADR-0019).
 */
export interface ProfileAppDef {
  /** The ref prefix: `<id>:<name>`, and `<id>` alone for the Main Profile. */
  id: string
  title: string
  bundleId: string
  bundleNames: readonly string[]
  installUrl: string
  /** `open` arguments for a non-main Profile; `app` is the bundle path, `appData` the Profile's folder. */
  openArgs(app: string, appData: string): string[]
  /** Inherited variables cleared before `open`, which would point the app at other data. */
  clearVars: readonly string[]
  /** The Main Profile's app data folder, relative to HOME. */
  mainUserData: string
  /** The app's own status file in an app data folder, whose boolean `signedIn` sideby reads. */
  statusFile: string
  /** The Family whose users may look for this app under an Account (grok), for a pointer in its error. */
  relatedFamily: string
}

export const PROFILE_APPS: readonly ProfileAppDef[] = [grokBot]

/** The app with App Profiles related to a Family id, if any. */
export function profileAppFor(familyId: string): ProfileAppDef | undefined {
  return PROFILE_APPS.find((p) => p.relatedFamily === familyId)
}
