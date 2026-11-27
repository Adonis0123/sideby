// ADR-0088: generic Orca trusted-worker for sideby Live Sessions. Runs `sideby sessions --json`
// without a shell, enriches workspace membership, Orca Chat titles, and sleeping local Orca Chats
// using read-only host/CLI APIs, updates the status bar, opens the sidebar panel on click, and
// forwards only minimal display/copy fields (never `orcaSessionId`, `pid`, or `transcript`).
import { execFile, spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'

const STATUS_BAR_ID = 'current-session'
const PLUGIN_KEY = 'local.sideby-sessions'
const PANEL_ID = 'sessions'
const COMMAND_TIMEOUT_MS = 12_000
const ORCA_LIST_TIMEOUT_MS = 4_500
const CLIPBOARD_TIMEOUT_MS = 3_000
const OPEN_PANEL_TIMEOUT_MS = 4_000
const DEFAULT_POLL_MS = 15_000
const FRESH_SNAPSHOT_MS = 2_500
const MAX_LABEL_LEN = 64
const VALID_STATUSES = new Set(['needs-you', 'busy', 'idle', 'sleeping', 'unknown'])
const GENERIC_ORCA_TITLE = /^antigravity\s+chat$/i
const ORCA_SESSION_PREFIX = 'orca_session_id:'

const NO_SIDEBY_MSG = 'Could not run sideby. Make sure sideby is installed and on PATH, then press Refresh.'
const TIMEOUT_MSG = 'sideby sessions timed out. Check `sideby sessions` in a terminal, then press Refresh.'
const BAD_OUTPUT_MSG = 'sideby did not return a valid session list. Check `sideby sessions` in a terminal.'

function normalizePath(p) {
  if (typeof p !== 'string') return ''
  const trimmed = p.trim()
  if (!trimmed) return ''
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed
}

function isInWorkspacePath(cwd, workspacePath) {
  const c = normalizePath(cwd)
  const w = normalizePath(workspacePath)
  if (!c || !w) return false
  return c === w || c.startsWith(`${w}/`)
}

function stripOrcaPrefix(id) {
  if (typeof id !== 'string') return ''
  return id.startsWith(ORCA_SESSION_PREFIX) ? id.slice(ORCA_SESSION_PREFIX.length) : id
}

function cleanTitle(raw) {
  if (typeof raw !== 'string') return ''
  const s = raw.replace(/\s+/g, ' ').trim()
  if (!s || GENERIC_ORCA_TITLE.test(s)) return ''
  return s
}

function extractShortId(sessionId) {
  const bare = stripOrcaPrefix(sessionId)
  return bare.length > 0 ? bare.slice(0, 8) : ''
}

function parseAccountFromLabel(label) {
  if (typeof label !== 'string') return ''
  const parts = label.split(' · ')
  return parts.length >= 2 ? parts[0].trim() : ''
}

function parseTitleFromLabel(label) {
  if (typeof label !== 'string') return ''
  const parts = label.split(' · ')
  return parts.length >= 3 ? parts.slice(1, -1).join(' · ').trim() : label.trim()
}

function cwdFromWorktreeId(worktreeId) {
  if (typeof worktreeId !== 'string') return ''
  const sep = worktreeId.indexOf('::')
  if (sep < 0) return ''
  const candidate = worktreeId.slice(sep + 2).trim()
  return candidate.startsWith('/') ? candidate : ''
}

function findMatchedAgentTitle(raw, agents) {
  if (!Array.isArray(agents) || !agents.length) return ''
  const sid = typeof raw?.sessionId === 'string' ? raw.sessionId : ''
  const oid = stripOrcaPrefix(raw?.orcaSessionId)
  if (!sid && !oid) return ''
  const matched = agents.filter((a) => {
    const aid = stripOrcaPrefix(a?.sessionId)
    return aid.length > 0 && (aid === sid || (oid.length > 0 && aid === oid))
  })
  if (matched.length !== 1) return ''
  return cleanTitle(matched[0]?.title)
}

function sleepingAgentLabel(agentName) {
  if (agentName === 'antigravity') return 'agy'
  if (typeof agentName === 'string' && agentName.trim()) return agentName.trim()
  return 'orca'
}

// WHY: strict field allowlist so internal ids (including orcaSessionId), pids, transcripts, and
// account metadata never cross from the worker to the UI panel (ADR-0088).
export function toPanelSession(raw, opts = {}) {
  const isCurrent = typeof opts === 'boolean' ? opts : Boolean(opts?.isCurrent)
  const inWorkspace = typeof opts === 'object' ? Boolean(opts?.inWorkspace) : false
  const agentTitle = typeof opts === 'object' ? cleanTitle(opts?.agentTitle) : ''
  const status = typeof raw?.status === 'string' && VALID_STATUSES.has(raw.status) ? raw.status : 'unknown'
  const sessionId = typeof raw?.sessionId === 'string' ? raw.sessionId : ''
  const shortId = extractShortId(sessionId)
  const rawLabel = typeof raw?.label === 'string' ? raw.label : ''
  const account =
    (typeof raw?.accountLabel === 'string' && raw.accountLabel.trim()) ||
    (typeof raw?.account === 'string' && raw.account.trim()) ||
    parseAccountFromLabel(rawLabel)
  const rawTitle = (typeof raw?.title === 'string' && raw.title.trim()) || parseTitleFromLabel(rawLabel)
  const title = agentTitle || rawTitle || shortId
  const label =
    agentTitle && account && shortId
      ? `${account} · ${agentTitle} · ${shortId}`
      : rawLabel || (account && shortId ? `${account} · ${title} · ${shortId}` : title)

  return {
    label,
    account,
    title,
    shortId,
    sessionId,
    reference: typeof raw?.reference === 'string' ? raw.reference : '',
    status,
    ...(typeof raw?.cwd === 'string' && raw.cwd ? { cwd: raw.cwd } : {}),
    ...(typeof raw?.startedFrom === 'string' && raw.startedFrom ? { startedFrom: raw.startedFrom } : {}),
    guessed: Boolean(raw?.guessed),
    isCurrent,
    inWorkspace,
  }
}

export function sleepingChatToPanelEntry(agent, opts = {}) {
  const bareId = stripOrcaPrefix(agent?.orcaSessionId)
  if (!bareId) return null
  const title =
    cleanTitle(agent?.title) ||
    (typeof agent?.workspace === 'string' ? agent.workspace.trim() : '') ||
    bareId.slice(0, 8)
  const cwd =
    cwdFromWorktreeId(agent?.worktreeId) || (typeof opts.workspacePath === 'string' ? opts.workspacePath : '')
  const account = sleepingAgentLabel(agent?.agent)
  const shortId = bareId.slice(0, 8)
  const addressableId = `${ORCA_SESSION_PREFIX}${bareId}`
  const label = `${account} · ${title} · ${shortId}`
  const reference = cwd
    ? `Orca ${account} chat ${addressableId} (${title}), working directory ${cwd}. Message it with \`sideby send ${addressableId} "<text>"\` (or \`orca orchestration send --to ${addressableId}\`) to wake it up.`
    : `Orca ${account} chat ${addressableId} (${title}). Message it with \`sideby send ${addressableId} "<text>"\` (or \`orca orchestration send --to ${addressableId}\`) to wake it up.`
  const panelSession = {
    label,
    account,
    title,
    shortId,
    sessionId: `sleeping:${shortId}:${bareId.slice(-4)}`,
    reference: '',
    status: 'sleeping',
    ...(cwd ? { cwd } : {}),
    startedFrom: 'orca',
    guessed: false,
    isCurrent: false,
    inWorkspace: Boolean(opts.inWorkspace),
  }
  return {
    panelSession,
    copyTarget: {
      idText: addressableId,
      referenceText: reference,
      label,
    },
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
// count and open the sidebar panel on click so clicks never copy the wrong Chat (ADR-0088).
export function findCurrentSessionId(rawSessions, agents) {
  if (!Array.isArray(agents) || !Array.isArray(rawSessions)) return null

  const focused = agents.filter((a) => a?.focused === true)
  if (focused.length !== 1) return null

  const agentSessionId = stripOrcaPrefix(focused[0]?.sessionId)
  if (!agentSessionId) return null

  const matched = rawSessions.filter(
    (s) =>
      typeof s?.sessionId === 'string' &&
      s.sessionId.length > 0 &&
      !s.guessed &&
      (s.sessionId === agentSessionId ||
        (typeof s?.orcaSessionId === 'string' &&
          s.orcaSessionId.length > 0 &&
          stripOrcaPrefix(s.orcaSessionId) === agentSessionId)),
  )
  return matched.length === 1 ? matched[0].sessionId : null
}

function sortSessions(sessions, orderById) {
  return [...sessions].sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
    if (a.inWorkspace !== b.inWorkspace) return a.inWorkspace ? -1 : 1
    const aSleep = a.status === 'sleeping'
    const bSleep = b.status === 'sleeping'
    if (aSleep !== bSleep) return aSleep ? 1 : -1
    const aAt = orderById.get(a.sessionId) ?? Number.MAX_SAFE_INTEGER
    const bAt = orderById.get(b.sessionId) ?? Number.MAX_SAFE_INTEGER
    if (aAt !== bAt) return aAt - bAt
    return a.sessionId.localeCompare(b.sessionId)
  })
}

async function readFileCreatedMs(filePath) {
  if (typeof filePath !== 'string' || !filePath) return 0
  try {
    const st = await stat(filePath)
    return Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs || 0
  } catch {
    return 0
  }
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
    tooltip: count > 0 ? 'Click to open the sideby Sessions panel' : 'No running sideby sessions',
    visible: true,
  }
}

function orcaBins() {
  return [process.env.ORCA_CLI_COMMAND, 'orca', '/Applications/Orca.app/Contents/Resources/bin/orca'].filter(
    (b) => typeof b === 'string' && b.length > 0,
  )
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

function defaultReadOrcaCliAgents(signal) {
  const bins = orcaBins()
  const tryBin = (idx) => {
    if (idx >= bins.length) return Promise.resolve([])
    return new Promise((resolve) => {
      execFile(
        bins[idx],
        ['agent', 'list', '--json'],
        { timeout: ORCA_LIST_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, signal },
        (err, stdout) => {
          if (err) {
            if (err.code === 'ABORT_ERR' || err.name === 'AbortError') {
              resolve([])
              return
            }
            resolve(tryBin(idx + 1))
            return
          }
          try {
            const parsed = JSON.parse(String(stdout ?? ''))
            const list = Array.isArray(parsed?.result?.agents) ? parsed.result.agents : []
            resolve(list)
          } catch {
            resolve([])
          }
        },
      )
    })
  }
  return tryBin(0)
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

function defaultOpenPanel() {
  const bins = orcaBins()
  const tryBin = (idx) => {
    if (idx >= bins.length) return Promise.resolve(false)
    return new Promise((resolve) => {
      execFile(
        bins[idx],
        ['plugin', 'open', PLUGIN_KEY, '--panel', PANEL_ID, '--json'],
        { timeout: OPEN_PANEL_TIMEOUT_MS, maxBuffer: 256 * 1024 },
        (err) => {
          if (!err) {
            resolve(true)
            return
          }
          resolve(tryBin(idx + 1))
        },
      )
    })
  }
  return tryBin(0)
}

let deps = {
  readSessions: defaultReadSessions,
  readOrcaCliAgents: defaultReadOrcaCliAgents,
  copyText: defaultCopyText,
  openPanel: defaultOpenPanel,
  pollIntervalMs: DEFAULT_POLL_MS,
}

// WHY: injectable seams let worker unit tests verify matching, projection, and copy paths without
// spawning real `sideby`, `orca`, or clipboard subprocesses.
export function setWorkerDepsForTest(overrides) {
  deps = {
    readSessions: overrides?.readSessions ?? defaultReadSessions,
    readOrcaCliAgents: overrides?.readOrcaCliAgents ?? defaultReadOrcaCliAgents,
    copyText: overrides?.copyText ?? defaultCopyText,
    openPanel: overrides?.openPanel ?? defaultOpenPanel,
    pollIntervalMs: overrides?.pollIntervalMs ?? DEFAULT_POLL_MS,
  }
}

let activeCleanup = null

export default function activate(orca) {
  activeCleanup?.()

  const controller = new AbortController()
  const disposables = []
  let lastWorkspaceId = null
  let lastWorkspaceName = null
  let lastSnapshot = null
  let lastSnapshotJson = ''
  let lastStatusBarJson = ''
  let copyTargets = new Map()
  let inFlight = null
  let pendingPost = false
  let pendingRefresh = false
  let disposed = false

  async function readOrcaContext(overrideContext) {
    let workspaceId =
      overrideContext !== undefined
        ? typeof overrideContext?.workspaceId === 'string'
          ? overrideContext.workspaceId
          : null
        : lastWorkspaceId
    let workspaceName =
      overrideContext !== undefined
        ? typeof overrideContext?.displayName === 'string' && overrideContext.displayName.trim()
          ? overrideContext.displayName.trim()
          : null
        : lastWorkspaceName

    if (overrideContext === undefined) {
      try {
        const ctx = await orca.host.call('workspace.readContext', {}, { signal: controller.signal })
        workspaceId = typeof ctx?.workspaceId === 'string' ? ctx.workspaceId : null
        workspaceName =
          typeof ctx?.displayName === 'string' && ctx.displayName.trim() ? ctx.displayName.trim() : null
        lastWorkspaceId = workspaceId
        lastWorkspaceName = workspaceName
      } catch {
        // WHY: Orca may have no focused workspace yet; session listing still works without it.
      }
    } else {
      lastWorkspaceId = workspaceId
      lastWorkspaceName = workspaceName
    }

    let workspacePath = null
    const workspaceById = new Map()
    let agents = []

    const [wsListRes, agentsRes] = await Promise.all([
      workspaceId
        ? orca.host
            .call('workspace.list', { includeStatus: false }, { signal: controller.signal })
            .catch(() => null)
        : Promise.resolve(null),
      workspaceId
        ? orca.host.call('agents.list', { workspaceId }, { signal: controller.signal }).catch(() => null)
        : Promise.resolve(null),
    ])

    if (Array.isArray(wsListRes?.workspaces)) {
      for (const w of wsListRes.workspaces) {
        if (typeof w?.id === 'string' && typeof w?.path === 'string' && w.path) {
          workspaceById.set(w.id, w.path)
        }
      }
      const ws = wsListRes.workspaces.find((w) => w?.id === workspaceId)
      if (typeof ws?.path === 'string' && ws.path) workspacePath = ws.path
      if (!workspaceName && typeof ws?.name === 'string' && ws.name.trim()) workspaceName = ws.name.trim()
    }
    if (Array.isArray(agentsRes?.agents)) {
      agents = agentsRes.agents
    }

    return { workspaceId, workspaceName, workspacePath, workspaceById, agents }
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

  async function runRefresh(postToPanels, overrideContext) {
    const [rawResult, orcaCtx, cliAgents] = await Promise.all([
      deps.readSessions(controller.signal),
      readOrcaContext(overrideContext),
      deps.readOrcaCliAgents(controller.signal).catch(() => []),
    ])
    if (disposed || rawResult?.aborted) {
      return (
        lastSnapshot ?? {
          sessions: [],
          workspaceName: orcaCtx.workspaceName,
          error: null,
          updatedAt: Date.now(),
        }
      )
    }
    const rawSessions = Array.isArray(rawResult?.sessions) ? rawResult.sessions : []
    const currentId = findCurrentSessionId(rawSessions, orcaCtx.agents)
    const nextCopyTargets = new Map()
    const liveOrcaIds = new Set()
    const orderById = new Map()

    const validRaw = rawSessions.filter((s) => typeof s?.sessionId === 'string' && s.sessionId.length > 0)
    const transcriptTimes = await Promise.all(validRaw.map((s) => readFileCreatedMs(s.transcript)))

    const mapped = validRaw.map((s, idx) => {
      const oid = stripOrcaPrefix(s.orcaSessionId)
      if (oid) liveOrcaIds.add(oid)
      const panelSession = toPanelSession(s, {
        isCurrent: currentId !== null && s.sessionId === currentId,
        inWorkspace: isInWorkspacePath(s.cwd, orcaCtx.workspacePath),
        agentTitle: findMatchedAgentTitle(s, orcaCtx.agents),
      })
      // WHY: sort by conversation creation time ascending (matching left-to-right tab opening order)
      // so rows never jump around while background chats produce output (ADR-0088).
      const createdMs =
        transcriptTimes[idx] ||
        Date.parse(s.startedAt ?? '') ||
        Date.parse(s.updatedAt ?? '') ||
        Number.MAX_SAFE_INTEGER
      orderById.set(panelSession.sessionId, createdMs)
      nextCopyTargets.set(panelSession.sessionId, {
        idText: panelSession.sessionId,
        referenceText: panelSession.reference,
        label: panelSession.label,
      })
      return panelSession
    })

    // WHY: Orca sleeps idle Antigravity Chat `agy acp` processes while keeping the tab open in `orca agent list`.
    // Include local sleeping Chats so open tabs stay visible and copyable even before sending a wake-up message (ADR-0088).
    if (!rawResult?.error && Array.isArray(cliAgents)) {
      for (const a of cliAgents) {
        if (a?.kind !== 'chat' || a?.hostId !== 'local') continue
        const bareId = stripOrcaPrefix(a?.orcaSessionId)
        if (!bareId || liveOrcaIds.has(bareId)) continue
        const wsPath =
          cwdFromWorktreeId(a?.worktreeId) ||
          (typeof a?.worktreeId === 'string' ? (orcaCtx.workspaceById.get(a.worktreeId) ?? '') : '')
        const inWs =
          (typeof a?.worktreeId === 'string' &&
            orcaCtx.workspaceId !== null &&
            a.worktreeId === orcaCtx.workspaceId) ||
          isInWorkspacePath(wsPath, orcaCtx.workspacePath)
        const entry = sleepingChatToPanelEntry(a, { workspacePath: wsPath, inWorkspace: inWs })
        if (!entry) continue
        mapped.push(entry.panelSession)
        const sleepCreated =
          typeof a?.updatedAt === 'number' && Number.isFinite(a.updatedAt)
            ? a.updatedAt
            : Number.MAX_SAFE_INTEGER
        orderById.set(entry.panelSession.sessionId, sleepCreated)
        nextCopyTargets.set(entry.panelSession.sessionId, entry.copyTarget)
      }
    }

    const sessions = sortSessions(mapped, orderById)
    copyTargets = nextCopyTargets
    const snapshot = {
      sessions,
      workspaceName: orcaCtx.workspaceName,
      error: typeof rawResult?.error === 'string' ? rawResult.error : null,
      updatedAt: Date.now(),
    }
    const contentKey = JSON.stringify({
      sessions: snapshot.sessions,
      workspaceName: snapshot.workspaceName,
      error: snapshot.error,
    })
    const changed = contentKey !== lastSnapshotJson
    lastSnapshot = snapshot
    lastSnapshotJson = contentKey
    await updateStatusBar(snapshot)
    if (postToPanels && changed && !disposed) {
      orca.panels.post('sessions.updated', snapshot)
    }
    return snapshot
  }

  async function refresh(postToPanels, overrideContext) {
    if (inFlight) {
      pendingRefresh = true
      pendingPost = pendingPost || postToPanels
      await inFlight
      if (disposed) {
        return (
          lastSnapshot ?? {
            sessions: [],
            workspaceName: lastWorkspaceName,
            error: null,
            updatedAt: Date.now(),
          }
        )
      }
      if (!pendingRefresh) {
        return (
          lastSnapshot ?? {
            sessions: [],
            workspaceName: lastWorkspaceName,
            error: null,
            updatedAt: Date.now(),
          }
        )
      }
      const nextPost = pendingPost
      pendingRefresh = false
      pendingPost = false
      return refresh(nextPost, overrideContext)
    }
    inFlight = runRefresh(postToPanels, overrideContext).finally(() => {
      inFlight = null
    })
    return inFlight
  }

  orca.panels.handle('sessions.list', async () => {
    if (lastSnapshot && Date.now() - lastSnapshot.updatedAt < FRESH_SNAPSHOT_MS) {
      void refresh(true)
      return lastSnapshot
    }
    return refresh(false)
  })
  orca.panels.handle('sessions.refresh', async () => refresh(true))
  orca.panels.handle('sessions.copy', async (input) => {
    const sessionId = typeof input?.sessionId === 'string' ? input.sessionId : ''
    const as = input?.as === 'id' ? 'id' : 'reference'
    if (!sessionId) {
      return { ok: false, copied: false, text: '', as, error: 'Missing session id.' }
    }
    const snapshot = lastSnapshot ?? (await refresh(false))
    const target = copyTargets.get(sessionId)
    const found = snapshot.sessions.find((s) => s.sessionId === sessionId)
    if (!found && !target) {
      return {
        ok: false,
        copied: false,
        text: '',
        as,
        error: 'Session is no longer available. Press Refresh to update the list.',
      }
    }
    const text = target
      ? as === 'id'
        ? target.idText
        : target.referenceText
      : as === 'id'
        ? found.sessionId
        : found.reference
    const label = target?.label ?? found?.label ?? sessionId
    const copied = await deps.copyText(text)
    return { ok: true, copied, text, label, as }
  })

  orca.commands.register('sideby-sessions.copy-current', async () => {
    const snapshot = await refresh(true)
    const current = snapshot.sessions.find((s) => s.isCurrent)
    if (current) {
      const target = copyTargets.get(current.sessionId)
      const text = target?.referenceText ?? current.reference
      const copied = await deps.copyText(text)
      return copied ? `Copied for AI: ${current.label}` : `Clipboard unavailable. Copy manually:\n${text}`
    }
    if (snapshot.error) return snapshot.error
    const opened = await deps.openPanel()
    const count = snapshot.sessions.length
    if (opened) {
      return count > 0
        ? `Opened sideby Sessions (${count} sessions). Pick a session there to copy.`
        : 'Opened sideby Sessions (no sessions).'
    }
    return count > 0
      ? `No single active Chat identified here (${count} sessions). Open the sideby Sessions right sidebar panel to pick and copy one.`
      : 'No running sideby sessions.'
  })

  orca.commands.register('sideby-sessions.refresh', async () => {
    const snapshot = await refresh(true)
    if (snapshot.error) return snapshot.error
    const count = snapshot.sessions.length
    return count === 1 ? 'Refreshed: 1 session.' : `Refreshed: ${count} sessions.`
  })

  disposables.push(
    orca.events.on('agent.status.changed', async () => {
      await refresh(true)
    }),
  )

  disposables.push(
    orca.events.on('workspace.changed', async (event) => {
      await refresh(true, event.context ?? null)
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
