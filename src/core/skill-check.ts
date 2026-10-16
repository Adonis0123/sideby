// Doctor's look at an installed sideby Agent Skill (spec §3.11). Read-only: a skill written for another
// sideby version teaches commands this CLI may not have, so a version mismatch is a warning with the
// reinstall command. Not installed is not a problem.
import { readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { FamilyDef, Finding } from '../types.ts'
import { mainDirOf } from './accounts.ts'
import { tildify } from './paths.ts'

export const SKILL_INSTALL = 'npx skills add Adonis0123/sideby -g'

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
    out.push({
      level: 'warn',
      account: `${family.id}:main`,
      item: where,
      code: 'skill.outdated',
      message: `the sideby skill at ${where} is ${found ? `for sideby ${found}` : 'from before skills had a version'}; this sideby is ${version}`,
      hint: `update it with \`${SKILL_INSTALL}\`, so agents learn this version's commands`,
      source: 'core',
      fixable: false,
    })
  }
  return out
}
