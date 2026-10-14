// Desktop Apps of the built-in Families (spec §3.20, ADR-0015). Internal on purpose: not part of the public
// FamilyDef, so plugin Families cannot declare one in v1.
import { claudeDesktop } from './claude/desktop.ts'
import { codexDesktop } from './codex/desktop.ts'

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
