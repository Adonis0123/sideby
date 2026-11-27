// ADR-0088: Orca TSX components sidebar panel for sideby Live Sessions. Uses a compact,
// hairline-separated list that matches Orca's native sidebar density, persists the last
// snapshot to avoid blank reloads, supports workspace/attention tabs and live search, and
// confirms copy actions in-place without layout shift.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Code,
  EmptyState,
  Heading,
  IconButton,
  Input,
  type PanelContext,
  plugin,
  RelativeTime,
  Row,
  read,
  Separator,
  Skeleton,
  Stack,
  set,
  Tab,
  Tabs,
  Text,
} from 'orca'

type SessionStatus = 'needs-you' | 'busy' | 'idle' | 'sleeping' | 'unknown'
type FilterTab = 'workspace' | 'all' | 'needs-you'

interface PanelSession {
  label: string
  account?: string
  title?: string
  shortId?: string
  sessionId: string
  reference: string
  status: SessionStatus
  cwd?: string
  startedFrom?: string
  guessed: boolean
  isCurrent: boolean
  inWorkspace?: boolean
}

interface SessionsSnapshot {
  sessions: PanelSession[]
  workspaceName?: string | null
  error: string | null
  updatedAt: number | null
}

interface CopyResult {
  ok: boolean
  copied: boolean
  text: string
  label?: string
  as?: 'reference' | 'id'
  error?: string
}

interface CopyNotice {
  tone: 'warning' | 'danger'
  title: string
  detail?: string
  fallbackText?: string
}

declare module 'orca' {
  interface PluginRequests {
    'sessions.list': { output: SessionsSnapshot }
    'sessions.refresh': { output: SessionsSnapshot }
    'sessions.copy': { input: { sessionId: string; as: 'reference' | 'id' }; output: CopyResult }
  }
  interface PluginPanelEvents {
    'sessions.updated': SessionsSnapshot
  }
}

const sessionsAtom = atom<PanelSession[]>('sessions', [], { persist: 'plugin' })
const workspaceNameAtom = atom<string | null>('workspaceName', null, { persist: 'plugin' })
const loadedAtom = atom(false)
const loadingAtom = atom(false)
const errorAtom = atom<string | null>(null)
const updatedAtAtom = atom<number | null>(null)
const queryAtom = atom('')
const activeTabAtom = atom<FilterTab | null>(null)
const copiedKeyAtom = atom<string | null>(null)
const copyNoticeAtom = atom<CopyNotice | null>(null)

function statusMeta(status: SessionStatus): { text: string; tone?: 'warning' | 'accent'; muted?: boolean } {
  if (status === 'needs-you') return { text: '● Needs you', tone: 'warning' }
  if (status === 'busy') return { text: '● Working', tone: 'accent' }
  if (status === 'idle') return { text: '○ Idle', muted: true }
  if (status === 'sleeping') return { text: '○ Sleeping', muted: true }
  return { text: '○ Running', muted: true }
}

function shortPath(cwd: string): string {
  return cwd.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
}

function displayTitle(s: PanelSession): string {
  if (s.title?.trim()) return s.title.trim()
  const parts = s.label.split(' · ')
  return parts.length >= 3 ? parts.slice(1, -1).join(' · ') : s.label
}

function displayAccount(s: PanelSession): string {
  if (s.account?.trim()) return s.account.trim()
  const parts = s.label.split(' · ')
  return parts.length >= 2 ? parts[0].trim() : ''
}

function displayShortId(s: PanelSession): string {
  return s.shortId?.trim() || s.sessionId.slice(0, 8)
}

function matchesQuery(s: PanelSession, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase()
  if (!q) return true
  const haystack = [s.title, s.account, s.label, s.shortId, s.sessionId, s.cwd]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join('\n')
    .toLowerCase()
  return q.split(/\s+/).every((word) => haystack.includes(word))
}

function applySnapshot(snapshot: SessionsSnapshot): void {
  const nextSessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : []
  const nextWorkspaceName =
    typeof snapshot?.workspaceName === 'string' && snapshot.workspaceName.trim()
      ? snapshot.workspaceName.trim()
      : null
  const nextError = typeof snapshot?.error === 'string' ? snapshot.error : null
  const nextUpdatedAt = typeof snapshot?.updatedAt === 'number' ? snapshot.updatedAt : null

  if (JSON.stringify(read(sessionsAtom)) !== JSON.stringify(nextSessions)) {
    set(sessionsAtom, nextSessions)
  }
  if (read(workspaceNameAtom) !== nextWorkspaceName) set(workspaceNameAtom, nextWorkspaceName)
  if (read(errorAtom) !== nextError) set(errorAtom, nextError)
  if (read(updatedAtAtom) !== nextUpdatedAt) set(updatedAtAtom, nextUpdatedAt)
  if (!read(loadedAtom)) set(loadedAtom, true)
}

async function loadSessions(method: 'sessions.list' | 'sessions.refresh'): Promise<void> {
  if (read(loadingAtom)) return
  set(loadingAtom, true)
  try {
    const snapshot = await plugin.request(method)
    applySnapshot(snapshot)
  } catch (err) {
    set(errorAtom, err instanceof Error ? err.message : 'Could not reach the sideby worker.')
    set(loadedAtom, true)
  } finally {
    set(loadingAtom, false)
  }
}

async function copySession(sessionId: string, as: 'reference' | 'id'): Promise<void> {
  const key = `${as}:${sessionId}`
  try {
    const res = await plugin.request('sessions.copy', { sessionId, as })
    if (!res.ok) {
      set(copiedKeyAtom, null)
      set(copyNoticeAtom, {
        tone: 'danger',
        title: 'Could not copy session',
        detail: res.error ?? 'Refresh the list and try again.',
      })
      return
    }
    if (res.copied) {
      set(copyNoticeAtom, null)
      set(copiedKeyAtom, key)
      return
    }
    set(copiedKeyAtom, null)
    set(copyNoticeAtom, {
      tone: 'warning',
      title: 'Copy manually (no clipboard tool found)',
      fallbackText: res.text,
    })
  } catch (err) {
    set(copiedKeyAtom, null)
    set(copyNoticeAtom, {
      tone: 'danger',
      title: 'Could not copy session',
      detail: err instanceof Error ? err.message : 'Unexpected worker error.',
    })
  }
}

export function setup(ctx: PanelContext): void {
  set(loadedAtom, false)
  set(loadingAtom, false)
  set(errorAtom, null)
  set(copiedKeyAtom, null)
  set(copyNoticeAtom, null)
  ctx.subscriptions.push(plugin.on('sessions.updated', (snapshot) => applySnapshot(snapshot)))
  void loadSessions('sessions.list')
}

function renderSessionList(
  list: readonly PanelSession[],
  copiedKey: string | null,
  showFolder: boolean,
  emptyTitle: string,
  emptyDescription: string,
  hasQuery: boolean,
) {
  if (list.length === 0) {
    return (
      <EmptyState icon={hasQuery ? 'search' : 'layers'} title={emptyTitle} description={emptyDescription}>
        {hasQuery ? (
          <Button size="xs" variant="outline" onPress={() => set(queryAtom, '')}>
            Clear search
          </Button>
        ) : null}
      </EmptyState>
    )
  }

  return (
    <Box border radius="md" background="card" gap="none">
      {list.map((s, idx) => {
        const refKey = `reference:${s.sessionId}`
        const idKey = `id:${s.sessionId}`
        const refCopied = copiedKey === refKey
        const idCopied = copiedKey === idKey
        const account = displayAccount(s)
        const shortId = displayShortId(s)
        const title = displayTitle(s)
        const st = statusMeta(s.status)
        const subtitle = [shortId, account, s.guessed ? 'guessed' : ''].filter(Boolean).join(' · ')
        return (
          <Stack key={s.sessionId} gap="none">
            {idx > 0 ? <Separator /> : null}
            <Box paddingX="sm" paddingY="sm" gap="xs" background={s.isCurrent ? 'accent' : 'none'}>
              <Text weight="medium" size="sm">
                {title}
              </Text>

              {showFolder && s.cwd ? (
                <Text muted size="xs" truncate>
                  {shortPath(s.cwd)}
                </Text>
              ) : null}

              <Row justify="between" align="center" gap="xs" wrap>
                <Row gap="xs" align="center" wrap>
                  <Text size="xs" weight="medium" tone={st.tone} muted={st.muted}>
                    {st.text}
                  </Text>
                  {s.isCurrent ? <Badge tone="accent">This chat</Badge> : null}
                  <Text muted size="xs">
                    {subtitle}
                  </Text>
                </Row>

                <Row gap="xs" align="center">
                  <Button
                    size="xs"
                    variant={refCopied ? 'solid' : 'outline'}
                    tone={refCopied ? 'success' : undefined}
                    icon={refCopied ? 'check' : 'copy'}
                    tooltip="Copy for AI — paste into another chat to reference or message this session"
                    onPress={() => void copySession(s.sessionId, 'reference')}
                  >
                    {refCopied ? 'Copied' : 'Copy'}
                  </Button>
                  <Button
                    size="xs"
                    variant={idCopied ? 'outline' : 'ghost'}
                    tone={idCopied ? 'success' : undefined}
                    icon={idCopied ? 'check' : undefined}
                    tooltip="Copy bare session ID"
                    onPress={() => void copySession(s.sessionId, 'id')}
                  >
                    {idCopied ? 'Copied' : 'ID'}
                  </Button>
                </Row>
              </Row>
            </Box>
          </Stack>
        )
      })}
    </Box>
  )
}

export default function SidebySessionsPanel() {
  const sessions = read(sessionsAtom)
  const workspaceName = read(workspaceNameAtom)
  const loaded = read(loadedAtom)
  const loading = read(loadingAtom)
  const error = read(errorAtom)
  const updatedAt = read(updatedAtAtom)
  const query = read(queryAtom)
  const chosenTab = read(activeTabAtom)
  const copiedKey = read(copiedKeyAtom)
  const copyNotice = read(copyNoticeAtom)

  const workspaceSessions = sessions.filter((s) => s.inWorkspace)
  const needsYouSessions = sessions.filter((s) => s.status === 'needs-you')

  const hasWorkspaceGroup = workspaceSessions.length > 0
  const hasNeedsYouGroup = needsYouSessions.length > 0
  const effectiveTab: FilterTab =
    chosenTab === 'workspace' && hasWorkspaceGroup
      ? 'workspace'
      : chosenTab === 'needs-you' && hasNeedsYouGroup
        ? 'needs-you'
        : chosenTab === 'all'
          ? 'all'
          : hasWorkspaceGroup
            ? 'workspace'
            : 'all'

  const filteredAll = sessions.filter((s) => matchesQuery(s, query))
  const filteredWorkspace = workspaceSessions.filter((s) => matchesQuery(s, query))
  const filteredNeedsYou = needsYouSessions.filter((s) => matchesQuery(s, query))
  const hasQuery = query.trim().length > 0
  const shortWorkspace =
    workspaceName && workspaceName.length > 10 ? `${workspaceName.slice(0, 9)}…` : workspaceName
  const workspaceTabLabel = shortWorkspace
    ? `${shortWorkspace} (${workspaceSessions.length})`
    : `Here (${workspaceSessions.length})`

  return (
    <Stack gap="sm">
      <Row justify="between" align="center" gap="xs">
        <Row gap="xs" align="center">
          <Heading level={3}>sideby Sessions</Heading>
          {loaded || sessions.length > 0 ? (
            <Text muted size="xs">
              {String(sessions.length)}
            </Text>
          ) : null}
        </Row>
        <IconButton
          icon="refresh"
          label="Refresh sessions"
          tooltip="Refresh sessions"
          size="xs"
          variant="ghost"
          disabled={loading}
          onPress={() => void loadSessions('sessions.refresh')}
        />
      </Row>

      {copyNotice ? (
        <Callout tone={copyNotice.tone} icon="warning" title={copyNotice.title}>
          {copyNotice.detail ? (
            <Text size="xs" muted>
              {copyNotice.detail}
            </Text>
          ) : null}
          {copyNotice.fallbackText ? <Code block>{copyNotice.fallbackText}</Code> : null}
        </Callout>
      ) : null}

      {error ? (
        <Callout tone="danger" icon="warning" title="Could not read sideby sessions">
          <Stack gap="xs">
            <Text size="xs">{error}</Text>
            <Row gap="xs">
              <Button
                size="xs"
                variant="outline"
                icon="refresh"
                disabled={loading}
                onPress={() => void loadSessions('sessions.refresh')}
              >
                Try again
              </Button>
            </Row>
          </Stack>
        </Callout>
      ) : null}

      {!loaded && sessions.length === 0 ? (
        <Stack gap="sm">
          <Skeleton shape="block" lines={2} label="Loading sessions" />
          <Skeleton shape="block" lines={2} label="Loading sessions" />
        </Stack>
      ) : null}

      {loaded && !error && sessions.length === 0 ? (
        <EmptyState
          icon="terminal"
          title="No running sessions"
          description="Start an account with sideby run, or open a local Agent Chat in Orca, and it will appear here."
        >
          <Button
            size="xs"
            variant="outline"
            icon="refresh"
            onPress={() => void loadSessions('sessions.refresh')}
          >
            Refresh
          </Button>
        </EmptyState>
      ) : null}

      {sessions.length > 0 ? (
        <Stack gap="sm">
          <Input
            type="search"
            label="Filter sessions"
            labelHidden
            value={query}
            placeholder="Search title, folder, or id…"
            onChange={(value) => set(queryAtom, value)}
          />

          {hasWorkspaceGroup || hasNeedsYouGroup ? (
            <Tabs
              label="Session groups"
              value={effectiveTab}
              onChange={(next) => set(activeTabAtom, next as FilterTab)}
            >
              {hasWorkspaceGroup ? (
                <Tab value="workspace" label={workspaceTabLabel}>
                  {renderSessionList(
                    filteredWorkspace,
                    copiedKey,
                    false,
                    'No matching sessions here',
                    'Try another keyword or switch to All.',
                    hasQuery,
                  )}
                </Tab>
              ) : null}
              <Tab value="all" label={`All (${sessions.length})`}>
                {renderSessionList(
                  filteredAll,
                  copiedKey,
                  true,
                  'No matching sessions',
                  'Try a different keyword or clear the search box.',
                  hasQuery,
                )}
              </Tab>
              {hasNeedsYouGroup ? (
                <Tab value="needs-you" label={`Needs you (${needsYouSessions.length})`}>
                  {renderSessionList(
                    filteredNeedsYou,
                    copiedKey,
                    true,
                    'Nothing needs your attention',
                    'Sessions waiting for input appear here.',
                    hasQuery,
                  )}
                </Tab>
              ) : null}
            </Tabs>
          ) : (
            renderSessionList(
              filteredAll,
              copiedKey,
              true,
              'No matching sessions',
              'Try a different keyword or clear the search box.',
              hasQuery,
            )
          )}
        </Stack>
      ) : null}

      {(loaded || sessions.length > 0) && sessions.length > 0 ? (
        <Row justify="between" align="center" gap="xs" wrap>
          <Text muted size="xs">
            Paste Copy into another chat, or type /id inside any chat.
          </Text>
          {updatedAt ? <RelativeTime at={updatedAt} muted /> : null}
        </Row>
      ) : null}
    </Stack>
  )
}
