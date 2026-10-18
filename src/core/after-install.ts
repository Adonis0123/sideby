// What follows an install (spec §3.23, ADR-0024): new sideby code is on disk, and what records the old code follows
// it. An Update (`applyUpdate`) and a Local Build switch (`switchLocal`) share this one order:
//
//   1. local refreshes: the desktop app and the login item record the Node and entry they start;
//   2. the install lock is released;
//   3. the sideby skill: updated in place (still under the lock), or by the new code (`sideby update --skill --yes`,
//      waited for or started on its own), which takes the lock itself;
//   4. a running background Panel starts again from the new code, last: the new Panel stops the old one as soon as it
//      boots, and the old one may be the process running steps 1 to 3.
//
// Programs run through the machine the caller passes (update.ts's swappable `UpdateDeps`), so tests start nothing.
import type { Env } from '../types.ts'
import { SKILL_UPDATE } from './skill-check.ts'
import type { SkillUpdatePlan, UpdateDeps } from './update.ts'

/**
 * The skill step the new code runs by name. `--skill` updates only the installed skill: it never installs the CLI,
 * even when the registry has moved on since the user confirmed.
 */
export const SKILL_SYNC = ['sideby', 'update', '--skill', '--yes'] as const

/** Runs the skills tool when the plan says the skill is outdated and sideby may; null when it did nothing. */
export async function runSkillUpdate(
  m: UpdateDeps,
  plan: SkillUpdatePlan | undefined,
  env: Env,
  onOutput?: (text: string) => void,
): Promise<{ ok: boolean; message: string } | null> {
  if (!plan?.outdated || !plan.canRun) return null
  const [file, ...args] = SKILL_UPDATE
  const r = await m
    .exec(file, args, { env, ...(onOutput ? { onOutput } : {}) })
    .catch((e: unknown) => ({ code: 1, output: e instanceof Error ? e.message : String(e) }))
  return r.code === 0
    ? { ok: true, message: 'updated the sideby skill' }
    : { ok: false, message: `\`${plan.command}\` failed (exit ${r.code}); run it yourself to see why` }
}

export interface AfterInstallOptions {
  home: string
  /** Frees the install lock. Called once, before anything starts that takes the lock itself. */
  release: () => Promise<void>
  /** Write an installed desktop app again from the new code (an Update). */
  app?: boolean
  /**
   * Points an existing login item at the new code; undefined when there is none. Without it, `sideby autostart
   * --refresh` of the new code does that where a login item is installed.
   */
  autostart?: () => Promise<boolean | undefined>
  /**
   * The installed sideby skill: `plan` when the caller has looked at it (an Update), `by-name` when only the new code
   * can tell (a switch back to npm). Absent: nothing to bring along.
   */
  skill?: { plan: SkillUpdatePlan | undefined } | 'by-name'
  /**
   * `background` (the Panel): the new code updates the skill on its own after the answer. Its fetch can take minutes,
   * and a Portal that moves to the new code, or the Panel restarting from it, ends the request it runs in.
   */
  skillSync?: 'wait' | 'background'
  /** The port of the background Panel to start again, or null when none runs. */
  panelPort?: () => Promise<number | null>
  onOutput?: (text: string) => void
}

export interface AfterInstallResult {
  restartedPanel: boolean
  refreshedApp: boolean
  /** Absent when there is no login item. */
  refreshedAutostart?: boolean
  /** `plan`, waited for: the skill was updated (true) or that failed (false); absent when it was not tried. */
  skillUpdated?: boolean
  skillMessage?: string
  /** `by-name`, waited for: `sideby update --skill --yes` of the new code succeeded. */
  skillSynced?: boolean
  /** `background`: `sideby update --skill --yes` of the new code started on its own. */
  skillSyncStarted?: boolean
}

async function autostartByName(m: UpdateDeps, home: string, env: Env): Promise<boolean | undefined> {
  // Never created here: only a login item `sideby autostart on` wrote is refreshed (ADR-0029).
  if (!(await m.autostartInstalled(home).catch(() => false))) return undefined
  return m.refreshAutostart(env).catch(() => false)
}

/** Runs the steps above in their order. Never throws, and a failed step never fails the install before it. */
export async function afterInstall(
  m: UpdateDeps,
  env: Env,
  o: AfterInstallOptions,
): Promise<AfterInstallResult> {
  let freed = false
  const release = async () => {
    if (freed) return
    freed = true
    await o.release().catch(() => {})
  }
  try {
    // By name, from the new code: the app records its own Node and entry and carries the icon of the version that
    // wrote it. Only where one is installed.
    const refreshedApp =
      !!o.app &&
      (await m.appInstalled(o.home, env).catch(() => false)) &&
      (await m.refreshApp(env).catch(() => false))
    const refreshedAutostart = await (o.autostart ?? (() => autostartByName(m, o.home, env)))().catch(
      () => false,
    )
    const background = o.skillSync === 'background'
    const plan = o.skill && o.skill !== 'by-name' ? o.skill.plan : undefined
    const due = o.skill === 'by-name' || (!!plan?.outdated && plan.canRun)
    let skill: Partial<AfterInstallResult> = {}
    // In place, under the lock, so a skill update never runs beside another install.
    if (due && !background && plan) {
      const r = await runSkillUpdate(m, plan, env, o.onOutput)
      if (r) skill = { skillUpdated: r.ok, skillMessage: r.message }
    }
    await release()
    if (due && background)
      skill = {
        skillSyncStarted: await m.startDetached(SKILL_SYNC[0], SKILL_SYNC.slice(1), env).catch(() => false),
      }
    else if (due && !plan) {
      const u = await m
        .exec(SKILL_SYNC[0], SKILL_SYNC.slice(1), { env, ...(o.onOutput ? { onOutput: o.onOutput } : {}) })
        .catch(() => ({ code: 1, output: '' }))
      skill = { skillSynced: u.code === 0 }
    }
    const port = o.panelPort ? await o.panelPort().catch(() => null) : null
    const restartedPanel = port !== null && (await m.restartPanel(env, port).catch(() => false))
    return {
      restartedPanel,
      refreshedApp,
      ...(refreshedAutostart === undefined ? {} : { refreshedAutostart }),
      ...skill,
    }
  } finally {
    await release()
  }
}
