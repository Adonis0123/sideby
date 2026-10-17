// Doctor's look at an installed sideby Agent Skill (spec §3.11). Read-only: a skill written for another
// sideby version teaches commands this CLI may not have, so a version mismatch is a warning with the
// reinstall command. Not installed is not a problem.
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { FamilyDef, Finding } from '../types.ts'
import { mainDirOf } from './accounts.ts'
import { tildify } from './paths.ts'

export const SKILL_SOURCE = 'Adonis0123/sideby'
export const SKILL_INSTALL = `npx skills add ${SKILL_SOURCE} -g`
/** The command a person runs to update the skill where sideby leaves it alone. */
export const SKILL_UPDATE_SHOWN = 'npx skills update sideby -g'

/** The folder holding `dir` that is a git work tree, if any: a skill there is managed by that repository. */
export async function gitRootOf(dir: string): Promise<string | null> {
  for (let d = dir; ; d = dirname(d)) {
    try {
      await stat(join(d, '.git'))
      return d
    } catch {
      // keep looking up
    }
    if (dirname(d) === d) return null
  }
}

/**
 * Whether the skills tool's install record (`.skill-lock.json` beside the `skills` folder holding `dir`) names this
 * repository as the source of `sideby`: then `npx skills update` owns the skill, even inside a git repository (a
 * dotfiles clone of `~/.agents`, say). Reads only that one entry's `source`.
 */
export async function installedBySkillsTool(dir: string): Promise<boolean> {
  try {
    const lock = JSON.parse(await readFile(join(dirname(dirname(dir)), '.skill-lock.json'), 'utf8')) as {
      skills?: Record<string, { source?: unknown } | undefined>
    }
    const source = lock.skills?.sideby?.source
    return typeof source === 'string' && source.toLowerCase() === SKILL_SOURCE.toLowerCase()
  } catch {
    return false
  }
}

/**
 * The git repository that owns the sideby skill in `dir`, or null when sideby may update it: not in a repository, or
 * the skills tool installed it there.
 */
export async function skillOwnerRepo(dir: string): Promise<string | null> {
  const repo = await gitRootOf(dir)
  return repo && !(await installedBySkillsTool(dir)) ? repo : null
}

/** `metadata.version` from a SKILL.md frontmatter, or null when there is none. */
export function skillVersionOf(text: string): string | null {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]
  const meta = front && /^metadata:[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))*)/m.exec(front)?.[1]
  return (meta && /^[ \t]+version:[ \t]*['"]?([^'"\s]+)/m.exec(meta)?.[1]) || null
}

/**
 * The versions of the sideby skills an agent reads on this machine (`null`: a skill without one): where
 * `npx skills add -g` puts it (`~/.agents/skills`) and Claude Code's user skills. Read for a `--json` output's
 * `_notice`, so it looks at two fixed files only; Doctor checks every Family's main directory.
 */
export async function installedSkillVersions(home: string): Promise<(string | null)[]> {
  return (await installedSkills(home)).map((s) => s.version)
}

/** The same skills with the real folder each lives in (for `sideby update`, which may update them). */
export async function installedSkills(home: string): Promise<{ dir: string; version: string | null }[]> {
  const seen = new Set<string>()
  const out: { dir: string; version: string | null }[] = []
  for (const dir of [join(home, '.agents', 'skills'), join(home, '.claude', 'skills')]) {
    try {
      const real = await realpath(join(dir, 'sideby', 'SKILL.md'))
      if (seen.has(real)) continue
      seen.add(real)
      out.push({ dir: dirname(real), version: skillVersionOf(await readFile(real, 'utf8')) })
    } catch {
      // not installed there
    }
  }
  return out
}

/** The command `sideby update` runs to update an installed sideby skill: it keeps the agents it was installed for. */
export const SKILL_UPDATE = ['npx', '-y', 'skills', 'update', 'sideby', '-g', '-y'] as const

/**
 * Checks, for each given Family, the sideby skill its Host reads: `<main>/skills/sideby`, and for Codex also
 * `~/.agents/skills/sideby` (where `npx skills add -g` installs and Codex reads user skills). A file is read
 * once per Family, so the result for one Family never depends on which others are checked with it. Findings
 * are general and belong to that Family's Main Account.
 */
export async function checkInstalledSkills(
  home: string,
  families: readonly FamilyDef[],
  version: string,
): Promise<Finding[]> {
  const places = families.flatMap((f) => [
    { family: f, path: join(mainDirOf(f, home), 'skills', 'sideby', 'SKILL.md') },
    ...(f.id === 'codex' ? [{ family: f, path: join(home, '.agents', 'skills', 'sideby', 'SKILL.md') }] : []),
  ])
  const seen = new Set<string>()
  const out: Finding[] = []
  for (const { family, path } of places) {
    let real: string
    let text: string
    try {
      real = await realpath(path)
      if (seen.has(`${family.id}\0${real}`)) continue
      text = await readFile(real, 'utf8')
    } catch {
      continue
    }
    seen.add(`${family.id}\0${real}`)
    const found = skillVersionOf(text)
    if (found === version) continue
    const where = tildify(path, home)
    // `sideby update` brings the skill along, except one a git repository owns (a dotfiles clone, say).
    const repo = await skillOwnerRepo(dirname(real))
    out.push({
      level: 'warn',
      account: `${family.id}:main`,
      item: where,
      code: 'skill.outdated',
      message: `the sideby skill at ${where} is ${found ? `for sideby ${found}` : 'from before skills had a version'}; this sideby is ${version}`,
      hint: repo
        ? `it lives in the git repository ${tildify(repo, home)}: update it where that repository comes from (\`${SKILL_UPDATE_SHOWN}\` there), so agents learn this version's commands`
        : `run \`sideby update\`, which updates the skill too (or \`${SKILL_INSTALL}\` by hand), so agents learn this version's commands`,
      source: 'core',
      fixable: false,
    })
  }
  return out
}
