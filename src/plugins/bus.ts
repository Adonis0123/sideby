import type { HookEvent, HookEvents, HookFilter, HookHandler } from '../types.ts'

export const HOOK_TIMEOUT_MS: Record<HookEvent, number> = {
  'launch.before': 30_000,
  'account.created': 30_000,
  'doctor.check': 10_000,
}

interface Entry<E extends HookEvent> {
  plugin: string
  filter: HookFilter
  handler: HookHandler<E>
}

/** Error thrown by a hook, labelled with the Plugin that raised it. */
export class HookError extends Error {
  readonly plugin: string
  readonly aborted: boolean
  constructor(plugin: string, message: string, aborted: boolean) {
    super(`[${plugin}] ${message}`)
    this.plugin = plugin
    this.aborted = aborted
  }
}

/** Thrown by `api.abort()` to stop a Launch on purpose. */
export class AbortLaunch extends Error {}

export class HookBus {
  private readonly entries = new Map<HookEvent, Entry<HookEvent>[]>()
  private readonly timeouts: Record<HookEvent, number>

  constructor(timeouts: Partial<Record<HookEvent, number>> = {}) {
    this.timeouts = { ...HOOK_TIMEOUT_MS, ...timeouts }
  }

  add<E extends HookEvent>(plugin: string, event: E, filter: HookFilter, handler: HookHandler<E>): void {
    const list = this.entries.get(event) ?? []
    list.push({ plugin, filter, handler: handler as unknown as HookHandler<HookEvent> })
    this.entries.set(event, list)
  }

  count(event: HookEvent): number {
    return this.entries.get(event)?.length ?? 0
  }

  /**
   * Runs matching handlers in registration order. Each gets the event's timeout.
   * Returns per-plugin results; the first failure stops the chain and is thrown as HookError.
   */
  async run<E extends HookEvent>(
    event: E,
    family: string,
    ctx: HookEvents[E]['ctx'],
  ): Promise<{ plugin: string; result: HookEvents[E]['result'] }[]> {
    const out: { plugin: string; result: HookEvents[E]['result'] }[] = []
    for (const e of this.entries.get(event) ?? []) {
      if (e.filter.family && e.filter.family !== family) continue
      const result = await this.invoke(e as unknown as Entry<E>, event, ctx)
      out.push({ plugin: e.plugin, result })
    }
    return out
  }

  /** Like `run`, but a failing handler is reported and the others still run (used by Doctor). */
  async runIsolated<E extends HookEvent>(
    event: E,
    family: string,
    ctx: HookEvents[E]['ctx'],
  ): Promise<{ plugin: string; result?: HookEvents[E]['result']; error?: HookError }[]> {
    const out: { plugin: string; result?: HookEvents[E]['result']; error?: HookError }[] = []
    for (const e of this.entries.get(event) ?? []) {
      if (e.filter.family && e.filter.family !== family) continue
      try {
        out.push({ plugin: e.plugin, result: await this.invoke(e as unknown as Entry<E>, event, ctx) })
      } catch (err) {
        out.push({ plugin: e.plugin, error: err as HookError })
      }
    }
    return out
  }

  private async invoke<E extends HookEvent>(
    e: Entry<E>,
    event: E,
    ctx: HookEvents[E]['ctx'],
  ): Promise<HookEvents[E]['result']> {
    const ms = this.timeouts[event]
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new HookError(e.plugin, `${event} timed out after ${ms / 1000}s`, false)),
        ms,
      )
      timer.unref()
    })
    try {
      return await Promise.race([Promise.resolve().then(() => e.handler(ctx)), timeout])
    } catch (err) {
      if (err instanceof HookError) throw err
      const aborted = err instanceof AbortLaunch
      throw new HookError(e.plugin, (err as Error)?.message ?? String(err), aborted)
    } finally {
      clearTimeout(timer)
    }
  }
}
