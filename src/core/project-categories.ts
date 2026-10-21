// Project Categories (spec §3.33, ADR-0044): a Plugin sorts Projects into categories, such as the workspaces of a
// project manager, so Session History can group and filter by them. Answers are kept for a minute; a Plugin that
// throws, answers with something else or takes longer than 3 s costs only the categories, never the listing.
import type { ProjectCategoriesDef } from '../types.ts'

export interface ProjectCategories {
  /** What the categories are called, "Category" when the Plugin gave no name. */
  label: string
  /** The Plugin that sorts them. */
  owner: string
  /** The category of each Project that has one. */
  of: Map<string, string>
  /** Why there are no categories this time, in plain words. */
  problem?: string
}

export const CATEGORY_TIMEOUT_MS = 3_000
const KEEP_MS = 60_000

/** Asks `def` for categories, remembering each answer for a minute. */
export function categoryReader(
  def: ProjectCategoriesDef,
  owner: string,
  now: () => number = Date.now,
): (projects: string[]) => Promise<ProjectCategories> {
  let kept: { at: number; asked: Set<string>; of: Map<string, string> } | undefined
  let pending: Promise<ProjectCategories> | undefined
  const label = def.label ?? 'Category'
  return (projects) => {
    const list = [...new Set(projects.filter(Boolean))].sort()
    if (kept && now() - kept.at < KEEP_MS && list.every((p) => kept!.asked.has(p)))
      return Promise.resolve({ label, owner, of: kept.of })
    pending ??= ask(def, list)
      .then((of): ProjectCategories => {
        kept = { at: now(), asked: new Set(list), of }
        return { label, owner, of }
      })
      .catch((err: Error) => ({
        label,
        owner,
        of: new Map(),
        problem: `${owner}: project categories failed (${err.message}); fix the plugin or remove it`,
      }))
      .finally(() => {
        pending = undefined
      })
    return pending
  }
}

async function ask(def: ProjectCategoriesDef, list: string[]): Promise<Map<string, string>> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no answer within ${CATEGORY_TIMEOUT_MS / 1000} s`)),
      CATEGORY_TIMEOUT_MS,
    )
  })
  try {
    const answer = await Promise.race([Promise.resolve().then(() => def.categoriesOf(list)), late])
    if (!answer || typeof answer !== 'object' || Array.isArray(answer))
      throw new Error('categoriesOf must return an object of project path to category')
    const asked = new Set(list)
    const of = new Map<string, string>()
    for (const [path, name] of Object.entries(answer))
      if (asked.has(path) && typeof name === 'string' && name.trim()) of.set(path, name.trim().slice(0, 80))
    return of
  } finally {
    clearTimeout(timer)
  }
}
