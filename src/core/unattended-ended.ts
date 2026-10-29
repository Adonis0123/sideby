// The end of a stretch of Unattended Mode (spec §3.37, ADR-0057): the first sideby process that notices it emits the
// plugin event `unattended.ended`. The background Panel looks every 30 seconds and other commands look when they
// start; none of the session hooks does. `<state>/unattended/ended.json` keeps when it last looked, the stretch it saw
// running then, the events found but not yet delivered (the outbox) and the ids of those delivered.
//
// Delivery is at least once: an event stays in the outbox until the plugin hooks have run for it, and one a process
// claimed but did not finish (it crashed, or was ended) is tried again after a lease. Each event has a stable `id`, so
// a plugin can skip one it has seen. Stretches that ended while no sideby process ran are found from the last look
// onward, oldest first, at most 50 a look; the rest wait for the next look.
import { join } from 'node:path'
import type { Env, UnattendedEndedContext } from '../types.ts'
import { writeFileAtomic } from './fs-safe.ts'
import { takeFileLock } from './lock.ts'
import { type Paths, resolvePaths } from './paths.ts'
import { listPendingDecisions } from './unattended-pending.ts'
import {
  ensureUnattendedDir,
  readSmallJson,
  readUnattendedConfig,
  readUnattendedOverride,
  unattendedDir,
  unattendedTimeline,
} from './unattended-state.ts'

export type UnattendedEndedEmit = (ctx: UnattendedEndedContext) => Promise<void> | void

interface Seen {
  startedAt: string
  reason: 'slot' | 'manual'
}

/** An event found and not yet delivered. */
interface Notice {
  id: string
  startedAt: string
  endedAt: string
  reason: 'slot' | 'manual'
  late?: true
  /** When a process took it to deliver; another takes it again once this is older than the lease. */
  claimedAt?: string
}

interface Checkpoint {
  /** When a process last looked: stretches that ended after this are still to be found. */
  checkedAt: string
  /** The stretch running then, as that process saw it start. */
  current?: Seen
  /** Ids of the events delivered, newest last. */
  emitted: string[]
  /** Events found and not yet delivered, oldest first. */
  outbox: Notice[]
}

const DAY_MS = 24 * 60 * 60 * 1000
/** Noticed this long after its end, the event says `late`. */
const LATE_MS = 12 * 60 * 60 * 1000
/** A look that changes nothing is written down at most this often. */
const REWRITE_MS = 60 * 1000
const KEEP_EMITTED = 100
/** At most this many events wait in the outbox; a look that finds more takes the oldest and leaves the rest. */
export const MAX_OUTBOX = 50
/** A claimed event not delivered after this long is taken again (its process is gone or stuck). */
const LEASE_MS = 2 * 60 * 1000

const file = (stateDir: string) => join(unattendedDir(stateDir), 'ended.json')
const lockFile = (dir: string) => join(dir, 'ended.lock')
const LOCK = { staleMs: 30_000, beatMs: 10_000 }

const isTime = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v))
const isReason = (v: unknown): v is Seen['reason'] => v === 'slot' || v === 'manual'

function parseNotice(value: unknown): Notice | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || !isTime(v.startedAt) || !isTime(v.endedAt) || !isReason(v.reason))
    return undefined
  return {
    id: v.id,
    startedAt: v.startedAt,
    endedAt: v.endedAt,
    reason: v.reason,
    ...(v.late === true ? { late: true as const } : {}),
    ...(isTime(v.claimedAt) ? { claimedAt: v.claimedAt } : {}),
  }
}

function parseCheckpoint(value: unknown): Checkpoint | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  if (!isTime(v.checkedAt)) return undefined
  const c = v.current as Record<string, unknown> | undefined
  const current =
    c && isTime(c.startedAt) && isReason(c.reason) ? { startedAt: c.startedAt, reason: c.reason } : undefined
  const emitted = Array.isArray(v.emitted) ? v.emitted.filter((e): e is string => typeof e === 'string') : []
  const outbox = (Array.isArray(v.outbox) ? v.outbox : [])
    .map(parseNotice)
    .filter((n): n is Notice => n !== undefined)
  return {
    checkedAt: v.checkedAt,
    ...(current ? { current } : {}),
    emitted: emitted.slice(-KEEP_EMITTED),
    outbox: outbox.slice(0, MAX_OUTBOX),
  }
}

const iso = (ms: number) => new Date(ms).toISOString()
/** The event's id: its start and end, which do not change once it is found. */
const eventId = (startedAt: number, endedAt: number) => `${iso(startedAt)}/${iso(endedAt)}`

async function writeCheckpoint(stateDir: string, c: Checkpoint): Promise<void> {
  await writeFileAtomic(file(stateDir), `${JSON.stringify(c)}\n`, 0o600)
}

/**
 * Under the lock: finds the stretches that ended since the last look (oldest first, up to the outbox's room), adds
 * them to the outbox, and claims every event in it that no other process holds. Returns the claimed events, oldest
 * first; never throws.
 */
export async function claimUnattendedEnded(paths: Paths, now: Date = new Date()): Promise<Notice[]> {
  try {
    const { configured, schedule } = await readUnattendedConfig(paths.configFile)
    if (!configured && (await readSmallJson(file(paths.stateDir), 256 * 1024)) === undefined) return []
    const dir = await ensureUnattendedDir(paths.stateDir)
    const release = await takeFileLock(lockFile(dir), LOCK)
    // Another process is looking right now and will report what there is.
    if (!release) return []
    try {
      const before = parseCheckpoint(await readSmallJson(file(paths.stateDir), 256 * 1024))
      const t = now.getTime()
      // A clock that went back: look again once it has caught up.
      if (before && Date.parse(before.checkedAt) > t) return []
      const override = await readUnattendedOverride(paths.stateDir)
      const last = before ? Date.parse(before.checkedAt) : t
      const from = Math.min(last, before?.current ? Date.parse(before.current.startedAt) : last) - 9 * DAY_MS
      const timeline = unattendedTimeline(schedule, override, from, t + DAY_MS)
      const ended: { startedAt: number; endedAt: number; reason: Seen['reason'] }[] = []
      let current: Seen | undefined
      if (before) {
        // The stretch seen running at the last look: it went on as long as the Schedule and the manual state now say;
        // when they no longer cover that moment (the user turned it off), it ended now.
        const seen = before.current
        const cont = seen ? timeline.find((s) => s.start <= last && last < s.end) : undefined
        if (seen) {
          const end = cont ? cont.end : t
          if (end <= t)
            ended.push({ startedAt: Date.parse(seen.startedAt), endedAt: end, reason: seen.reason })
          else current = seen
        }
        for (const s of timeline) {
          if (s === cont || s.end <= last || s.start > t) continue
          // A stretch the last look did not see running counts from that look, at the earliest.
          const start = Math.max(s.start, last)
          if (s.end <= t) {
            if (start < s.end) ended.push({ startedAt: start, endedAt: s.end, reason: s.reason })
          } else if (!current) current = { startedAt: iso(start), reason: s.reason }
        }
      } else {
        const running = timeline.find((s) => s.start <= t && t < s.end)
        if (running) current = { startedAt: iso(running.start), reason: running.reason }
      }
      ended.sort((a, b) => a.endedAt - b.endedAt)
      const outbox = [...(before?.outbox ?? [])]
      const emitted = [...(before?.emitted ?? [])]
      const known = new Set([...emitted, ...outbox.map((n) => n.id)])
      const fresh = ended.filter((e) => !known.has(eventId(e.startedAt, e.endedAt)))
      const room = MAX_OUTBOX - outbox.length
      let checkedAt = t
      if (fresh.length > room) {
        // More than fit: take the oldest and look again from the end of the last one taken, so none is lost.
        fresh.length = Math.max(0, room)
        const lastTaken = fresh.at(-1)
        checkedAt = lastTaken ? lastTaken.endedAt : last
        current = lastTaken ? undefined : before?.current
      }
      for (const e of fresh)
        outbox.push({
          id: eventId(e.startedAt, e.endedAt),
          startedAt: iso(e.startedAt),
          endedAt: iso(e.endedAt),
          reason: e.reason,
          ...(t - e.endedAt > LATE_MS ? { late: true as const } : {}),
        })
      const claimed: Notice[] = []
      for (const n of outbox)
        if (!n.claimedAt || t - Date.parse(n.claimedAt) > LEASE_MS || Date.parse(n.claimedAt) > t) {
          n.claimedAt = iso(t)
          claimed.push(n)
        }
      const next: Checkpoint = { checkedAt: iso(checkedAt), ...(current ? { current } : {}), emitted, outbox }
      const same =
        before &&
        !fresh.length &&
        !claimed.length &&
        JSON.stringify(before.current ?? null) === JSON.stringify(current ?? null) &&
        t - last < REWRITE_MS
      // Claimed before any plugin runs: another process does not take the same events while the lease holds.
      if (!same) await writeCheckpoint(paths.stateDir, next)
      return claimed.map(({ claimedAt: _, ...n }) => n)
    } finally {
      await release()
    }
  } catch {
    return []
  }
}

/**
 * Runs `emit` for each claimed event, with the Pending Decisions kept during it that are still open, then marks the
 * ones whose `emit` returned as delivered. One whose `emit` threw stays in the outbox and is tried again after the
 * lease. Never throws.
 */
export async function deliverUnattendedEnded(
  paths: Paths,
  notices: readonly Notice[],
  emit: UnattendedEndedEmit,
  now: Date = new Date(),
): Promise<void> {
  if (!notices.length) return
  const pending = await listPendingDecisions(paths.stateDir, { now }).catch(() => [])
  const done: string[] = []
  for (const n of notices) {
    const [start, end] = [Date.parse(n.startedAt), Date.parse(n.endedAt)]
    try {
      await emit({
        id: n.id,
        startedAt: n.startedAt,
        endedAt: n.endedAt,
        reason: n.reason,
        ...(n.late ? { late: true as const } : {}),
        pending: pending.filter((p) => {
          const at = Date.parse(p.at)
          return at >= start && at <= end
        }),
      })
      done.push(n.id)
    } catch {
      // Not delivered: it stays in the outbox and is tried again.
    }
  }
  if (!done.length) return
  try {
    const dir = await ensureUnattendedDir(paths.stateDir)
    const release = await takeFileLock(lockFile(dir), { ...LOCK, wait: { timeoutMs: 5_000, pollMs: 50 } })
    // Not marked: the lease runs out and they are delivered again, which `id` lets a plugin notice.
    if (!release) return
    try {
      const c = parseCheckpoint(await readSmallJson(file(paths.stateDir), 256 * 1024))
      if (!c) return
      const ids = new Set(done)
      c.outbox = c.outbox.filter((n) => !ids.has(n.id))
      c.emitted = [...c.emitted.filter((id) => !ids.has(id)), ...done].slice(-KEEP_EMITTED)
      await writeCheckpoint(paths.stateDir, c)
    } finally {
      await release()
    }
  } catch {
    // as above
  }
}

/**
 * Looks once: claims what ended since the last look and what still waits to be delivered, then delivers it. Cheap
 * when the feature was never used (one read of the config). Never throws.
 */
export async function checkUnattendedEnded(
  paths: Paths,
  emit: UnattendedEndedEmit,
  now: Date = new Date(),
): Promise<void> {
  await deliverUnattendedEnded(paths, await claimUnattendedEnded(paths, now), emit, now)
}

/**
 * The background Panel's watch (spec §3.37): looks now and every 30 seconds until the returned function stops it.
 * Only a standalone Panel server starts one; a Panel embedded in a Portal through `createPanelHandler` does not.
 */
export function watchUnattendedEnded(paths: Paths, emit: UnattendedEndedEmit, everyMs = 30_000): () => void {
  let running = false
  const look = () => {
    if (running) return
    running = true
    void checkUnattendedEnded(paths, emit).finally(() => {
      running = false
    })
  }
  const timer = setInterval(look, everyMs)
  timer.unref()
  look()
  return () => clearInterval(timer)
}

/**
 * A command's look when it starts: waits only for the look itself (two small file reads when nothing ended), and
 * returns the delivery of what it found as `emitted`, which runs alongside the command. Plugins are loaded only when
 * there is something to deliver; an event whose delivery does not finish is delivered by a later look.
 */
export async function noticeUnattendedEnded(env: Env): Promise<{ emitted: Promise<void> }> {
  const paths = resolvePaths(env)
  const notices = await claimUnattendedEnded(paths)
  let rt: Promise<import('../runtime.ts').Runtime> | undefined
  const emitted = deliverUnattendedEnded(paths, notices, async (ctx) => {
    rt ??= import('../runtime.ts').then((m) => m.createRuntime({ env }))
    for (const f of await (await rt).unattendedEnded(ctx))
      console.error(`sideby: [${f.plugin}] unattended.ended failed: ${f.error}`)
  })
  return { emitted }
}

/** Reads the checkpoint, for tests and diagnostics. */
export async function readEndedCheckpoint(stateDir: string): Promise<Checkpoint | undefined> {
  return parseCheckpoint(await readSmallJson(file(stateDir), 256 * 1024))
}
