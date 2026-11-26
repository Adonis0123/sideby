// ADR-0088: generic Orca trusted-worker for sideby Live Sessions. Runs `sideby sessions --json`
// without a shell, correlates Orca's active Chat only when the focused workspace uniquely matches
// a single session, updates the status bar, and forwards only minimal display/copy fields to the panel.
import { execFile, spawn } from 'node:child_process'

const STATUS_BAR_ID = 'current-session'
const COMMAND_TIMEOUT_MS = 12_000
const CLIPBOARD_TIMEOUT_MS = 3_000
const DEFAULT_POLL_MS = 15_000
const MAX_LABEL_LEN = 64
const VALID_STATUSES = new Set(['needs-you', 'busy', 'idle', 'unknown'])

const NO_SIDEBY_MSG = 'Could not run sideby. Make sure sideby is installed and on PATH, then press Refresh.'
const TIMEOUT_MSG = 'sideby sessions timed out. Check `sideby sessions` in a terminal, then press Refresh.'
const BAD_OUTPUT_MSG = 'sideby did not return a valid session list. Check `sideby sessions` in a terminal.'

// WHY: strict field allowlist so internal ids (including orcaSessionId), pids, transcripts, and
// account metadata never cross from the worker to the UI panel (ADR-0088).
export function toPanelSession(raw, isCurrent) {
  const status = typeof raw?.status === 'string' && VALID_STATUSES.has(raw.status) ? raw.status : 'unknown'
  return {
    label: typeof raw?.label === 'string' ? raw.label : '',
    sessionId: typeof raw?.sessionId === 'string' ? raw.sessionId : '',
    reference: typeof raw?.reference === 'string' ? raw.reference : '',
    status,
    ...(typeof raw?.cwd === 'string' && raw.cwd ? { cwd: raw.cwd } : {}),
    ...(typeof raw?.startedFrom === 'string' && raw.startedFrom ? { startedFrom: raw.startedFrom } : {}),
    guessed: Boolean(raw?.guessed),
    isCurrent: Boolean(isCurrent),
  }
}

export function truncateLabel(label, maxLen = MAX_LABEL_LEN) {
  if (label.length <= maxLen) return label
  const parts = label.split(' · ')
  if (parts.length >= 3) {
    const prefix = parts[0]
    const suffix = parts[parts.length - 1]
    const budget = maxLen - prefix.length - suffix.length - 7
    if (budget >= 4) {
      const middle = parts.slice(1, -1).join(' · ')
      return `${prefix} · ${middle.slice(0, budget)}… · ${suffix}`
    }
  }
  return `${label.slice(0, Math.max(1, maxLen - 1))}…`
}

// WHY: Orca 1.4.277's `agents.list` omits focus and can return a partial subset of Chats.
// Only mark current when the host explicitly confirms a single focused agent; otherwise show the
// count and let the user pick in the sidebar panel so clicks never copy the wrong Chat (ADR-0088).
export function findCurrentSessionId(rawSessions, agents) {
  if (!Array.isArray(agents) || !Array.isArray(rawSessions)) return null

  const focused = agents.filter((a) => a?.focused === true)
  if (focused.length !== 1) return null

  const agentSessionId = typeof focused[0]?.sessionId === 'string' ? focused[0].sessionId : ''
  if (!agentSessionId) return null

  const matched = rawSessions.filter(
    (s) =>
      typeof s?.sessionId === 'string' &&
      s.sessionId.length > 0 &&
      !s.guessed &&
      (s.sessionId === agentSessionId ||
        (typeof s?.orcaSessionId === 'string' &&
          s.orcaSessionId.length > 0 &&
          s.orcaSessionId === agentSessionId)),
  )
  return matched.length === 1 ? matched[0].sessionId : null
}

export function buildStatusBarUpdate(snapshot) {
  const current = snapshot.sessions.find((s) => s.isCurrent)
  if (current) {
    const tone = current.status === 'needs-you' ? 'warning' : current.status === 'busy' ? 'accent' : 'neutral'
    return {
      id: STATUS_BAR_ID,
      text: truncateLabel(current.label),
      icon: 'layers',
      tone,
      tooltip: `${current.label} — click to copy for AI`,
      visible: true,
    }
  }
  if (snapshot.error) {
    return {
      id: STATUS_BAR_ID,
      text: 'sideby · unavailable',
      icon: 'layers',
      tone: 'warning',
      tooltip: snapshot.error,
      visible: true,
    }
  }
  const count = snapshot.sessions.length
  const label = count === 1 ? 'sideby · 1 session' : `sideby · ${count} sessions`
  const needsAttention = snapshot.sessions.some((s) => s.status === 'needs-you')
  return {
    id: STATUS_BAR_ID,
    text: label,
    icon: 'layers',
    tone: needsAttention ? 'warning' : 'neutral',
    tooltip:
      count > 0
        ? 'Open the sideby Sessions sidebar panel to pick and copy a session'
        : 'No running sideby sessions',
    visible: true,
  }
}

function defaultReadSessions(signal) {
  const bin = process.env.SIDEBY_BIN || 'sideby'
  return new Promise((resolve) => {
    execFile(
      bin,
      ['sessions', '--json'],
      { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, signal },
      (err, stdout) => {
        if (err) {
          if (err.code === 'ABORT_ERR' || err.name === 'AbortError') {
            resolve({ sessions: [], error: null, aborted: true })
            return
          }
          if (err.code === 'ENOENT') {
            resolve({ sessions: [], error: NO_SIDEBY_MSG })
            return
          }
          if (err.killed && err.signal === 'SIGTERM') {
            resolve({ sessions: [], error: TIMEOUT_MSG })
            return
          }
          try {
            const parsed = JSON.parse(String(stdout ?? ''))
            if (typeof parsed?.error === 'string' && parsed.error) {
              resolve({ sessions: [], error: parsed.error })
              return
            }
          } catch {
            // WHY: non-JSON stderr/stdout from a failed CLI call falls through to a plain message.
          }
          resolve({ sessions: [], error: BAD_OUTPUT_MSG })
          return
        }
        try {
          const parsed = JSON.parse(String(stdout ?? ''))
          if (!Array.isArray(parsed?.sessions)) {
            resolve({ sessions: [], error: BAD_OUTPUT_MSG })
            return
          }
          resolve({ sessions: parsed.sessions, error: null })
        } catch {
          resolve({ sessions: [], error: BAD_OUTPUT_MSG })
        }
      },
    )
  })
}

function clipboardPrograms() {
  if (process.platform === 'darwin') return [['pbcopy', []]]
  if (process.platform === 'win32') return [['clip', []]]
  const wayland = ['wl-copy', []]
  const x11 = ['xclip', ['-selection', 'clipboard']]
  return process.env.WAYLAND_DISPLAY ? [wayland, x11] : [x11, wayland]
}

function writeWithProgram(bin, args, text) {
  return new Promise((resolve) => {
    let done = false
    let child
    try {
      child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'ignore'] })
    } catch {
      resolve(false)
      return
    }
    const finish = (ok) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (!ok && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), CLIPBOARD_TIMEOUT_MS)
    timer.unref?.()
    child.once('error', () => finish(false))
    child.stdin.once('error', () => finish(false))
    child.once('exit', (code) => finish(code === 0))
    child.stdin.end(text)
  })
}

async function defaultCopyText(text) {
  for (const [bin, args] of clipboardPrograms()) {
    if (await writeWithProgram(bin, args, text)) return true
  }
  return false
}

let deps = {
  readSessions: defaultReadSessions,
  copyText: defaultCopyText,
  pollIntervalMs: DEFAULT_POLL_MS,
}

// WHY: injectable seams let worker unit tests verify matching, projection, and copy paths without
// spawning real `sideby` or clipboard subprocesses.
export function setWorkerDepsForTest(overrides) {
  deps = {
    readSessions: overrides?.readSessions ?? defaultReadSessions,
    copyText: overrides?.copyText ?? defaultCopyText,
    pollIntervalMs: overrides?.pollIntervalMs ?? DEFAULT_POLL_MS,
  }
}

let activeCleanup = null

export default function activate(orca) {
  activeCleanup?.()

  const controller = new AbortController()
  const disposables = []
  let lastWorkspaceId = null
  let lastSnapshot = null
  let lastSnapshotJson = ''
  let lastStatusBarJson = ''
  let inFlight = null
  let pendingPost = false
  let pendingRefresh = false
  let disposed = false

  async function readOrcaAgents(overrideWorkspaceId) {
    let workspaceId = overrideWorkspaceId !== undefined ? overrideWorkspaceId : lastWorkspaceId
    if (overrideWorkspaceId === undefined) {
      try {
        const ctx = await orca.host.call('workspace.readContext', {}, { signal: controller.signal })
        workspaceId = typeof ctx?.workspaceId === 'string' ? ctx.workspaceId : null
        lastWorkspaceId = workspaceId
      } catch {
        // WHY: Orca may have no focused workspace yet; session listing still works without it.
      }
    }
    if (!workspaceId) return []
    try {
      const res = await orca.host.call('agents.list', { workspaceId }, { signal: controller.signal })
      return Array.isArray(res?.agents) ? res.agents : []
    } catch {
      return []
    }
  }

  async function updateStatusBar(snapshot) {
    if (disposed) return
    const next = buildStatusBarUpdate(snapshot)
    const serialized = JSON.stringify(next)
    if (serialized === lastStatusBarJson) return
    lastStatusBarJson = serialized
    try {
      await orca.host.call('statusBar.update', next, { signal: controller.signal })
    } catch (err) {
      lastStatusBarJson = ''
      orca.log(`statusBar.update failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function runRefresh(postToPanels, overrideWorkspaceId) {
    const [rawResult, agents] = await Promise.all([
      deps.readSessions(controller.signal),
      readOrcaAgents(overrideWorkspaceId),
    ])
    if (disposed || rawResult?.aborted) {
      return lastSnapshot ?? { sessions: [], error: null, updatedAt: Date.now() }
    }
    const rawSessions = Array.isArray(rawResult?.sessions) ? rawResult.sessions : []
    const currentId = findCurrentSessionId(rawSessions, agents)
    const sessions = rawSessions
      .filter((s) => typeof s?.sessionId === 'string' && s.sessionId.length > 0)
      .map((s) => toPanelSession(s, currentId !== null && s.sessionId === currentId))
    const snapshot = {
      sessions,
      error: typeof rawResult?.error === 'string' ? rawResult.error : null,
      updatedAt: Date.now(),
    }
    const contentKey = JSON.stringify({ sessions: snapshot.sessions, error: snapshot.error })
    const changed = contentKey !== lastSnapshotJson
    lastSnapshot = snapshot
    lastSnapshotJson = contentKey
    await updateStatusBar(snapshot)
    if (postToPanels && changed && !disposed) {
      orca.panels.post('sessions.updated', snapshot)
    }
    return snapshot
  }

  async function refresh(postToPanels, overrideWorkspaceId) {
    if (inFlight) {
      pendingRefresh = true
      pendingPost = pendingPost || postToPanels
      await inFlight
      if (disposed) return lastSnapshot ?? { sessions: [], error: null, updatedAt: Date.now() }
      if (!pendingRefresh) return lastSnapshot ?? { sessions: [], error: null, updatedAt: Date.now() }
      const nextPost = pendingPost
      pendingRefresh = false
      pendingPost = false
      return refresh(nextPost, overrideWorkspaceId)
    }
    inFlight = runRefresh(postToPanels, overrideWorkspaceId).finally(() => {
      inFlight = null
    })
    return inFlight
  }

  orca.panels.handle('sessions.list', async () => refresh(false))
  orca.panels.handle('sessions.refresh', async () => refresh(true))
  orca.panels.handle('sessions.copy', async (input) => {
    const sessionId = typeof input?.sessionId === 'string' ? input.sessionId : ''
    const as = input?.as === 'id' ? 'id' : 'reference'
    if (!sessionId) {
      return { ok: false, copied: false, text: '', as, error: 'Missing session id.' }
    }
    const snapshot = lastSnapshot ?? (await refresh(false))
    const found = snapshot.sessions.find((s) => s.sessionId === sessionId)
    if (!found) {
      return {
        ok: false,
        copied: false,
        text: '',
        as,
        error: 'Session is no longer running. Press Refresh to update the list.',
      }
    }
    const text = as === 'id' ? found.sessionId : found.reference
    const copied = await deps.copyText(text)
    return { ok: true, copied, text, label: found.label, as }
  })

  orca.commands.register('sideby-sessions.copy-current', async () => {
    const snapshot = await refresh(true)
    const current = snapshot.sessions.find((s) => s.isCurrent)
    if (current) {
      const copied = await deps.copyText(current.reference)
      return copied
        ? `Copied for AI: ${current.label}`
        : `Clipboard unavailable. Copy manually:\n${current.reference}`
    }
    if (snapshot.error) return snapshot.error
    const count = snapshot.sessions.length
    return count > 0
      ? `No single active Chat identified here (${count} running). Open the sideby Sessions sidebar panel to pick and copy one.`
      : 'No running sideby sessions.'
  })

  orca.commands.register('sideby-sessions.refresh', async () => {
    const snapshot = await refresh(true)
    if (snapshot.error) return snapshot.error
    const count = snapshot.sessions.length
    return count === 1 ? 'Refreshed: 1 running session.' : `Refreshed: ${count} running sessions.`
  })

  disposables.push(
    orca.events.on('agent.status.changed', async () => {
      await refresh(true)
    }),
  )

  disposables.push(
    orca.events.on('workspace.changed', async (event) => {
      const nextWorkspaceId =
        typeof event.context?.workspaceId === 'string' ? event.context.workspaceId : null
      if (nextWorkspaceId !== lastWorkspaceId) {
        lastWorkspaceId = nextWorkspaceId
      }
      await refresh(true, nextWorkspaceId)
    }),
  )

  let timer = null
  if (deps.pollIntervalMs > 0) {
    timer = setInterval(() => {
      void refresh(true)
    }, deps.pollIntervalMs)
    timer.unref?.()
  }

  activeCleanup = () => {
    disposed = true
    controller.abort()
    if (timer) clearInterval(timer)
    for (const d of disposables) d?.dispose?.()
    activeCleanup = null
  }

  void refresh(false)
}

export function deactivate() {
  activeCleanup?.()
}
