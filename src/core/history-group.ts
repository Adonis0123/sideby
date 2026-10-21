// Grouping of Session History (spec §3.33): Sessions are ordered group by group, groups by their newest Session
// (their best match when searching), so one page of 50 can be shown under its group headers. A collapsed group is
// counted but leaves the paged list, so paging never walks through rows the user has folded away.
import type { Outline } from './history-index.ts'

export type GroupBy = 'project' | 'category' | 'account' | 'family' | 'day' | 'none'
export const GROUP_BYS: readonly GroupBy[] = ['project', 'category', 'account', 'family', 'day', 'none']

/** Day groups, newest first. */
export const DAY_GROUPS = ['today', 'yesterday', 'week', 'month', 'older'] as const

export interface GroupItem extends Outline {
  /** Higher first: the ranked score when searching, else the last activity. */
  score: number
}

export interface GroupCount {
  key: string
  sessions: number
  /** Newest last activity in the group, ms. */
  updatedAt: number
}

/** The day group of a time: today, yesterday, the last 7 days, the last 30 days, or older, by local midnight. */
export function dayGroup(t: number, now: Date = new Date()): (typeof DAY_GROUPS)[number] {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const daysAgo = (n: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n).getTime()
  if (t >= midnight) return 'today'
  if (t >= daysAgo(1)) return 'yesterday'
  if (t >= daysAgo(7)) return 'week'
  if (t >= daysAgo(30)) return 'month'
  return 'older'
}

/**
 * Orders `items` group by group: groups by their best score (or in the order of `fixed`, as days are), the group
 * without a key ('') last; inside a group by score. Returns the groups with their counts and the items outside
 * `collapsed`, in order.
 */
export function orderGroups(
  items: GroupItem[],
  keyOf: (o: Outline) => string,
  collapsed: ReadonlySet<string> = new Set(),
  fixed?: readonly string[],
): { groups: GroupCount[]; items: (GroupItem & { group: string })[] } {
  const stats = new Map<string, GroupCount & { best: number }>()
  const keyed = items.map((it) => {
    const group = keyOf(it)
    const s = stats.get(group)
    if (s) {
      s.sessions++
      s.best = Math.max(s.best, it.score)
      s.updatedAt = Math.max(s.updatedAt, it.updatedAt)
    } else stats.set(group, { key: group, sessions: 1, best: it.score, updatedAt: it.updatedAt })
    return { ...it, group }
  })
  const order = [...stats.values()].sort(
    (a, b) =>
      Number(a.key === '') - Number(b.key === '') ||
      (fixed ? fixed.indexOf(a.key) - fixed.indexOf(b.key) : 0) ||
      b.best - a.best ||
      b.updatedAt - a.updatedAt ||
      a.key.localeCompare(b.key),
  )
  const rank = new Map(order.map((g, i) => [g.key, i]))
  const visible = keyed
    .filter((it) => !collapsed.has(it.group))
    .sort((a, b) => rank.get(a.group)! - rank.get(b.group)! || b.score - a.score || b.id - a.id)
  return { groups: order.map(({ best: _best, ...g }) => g), items: visible }
}
