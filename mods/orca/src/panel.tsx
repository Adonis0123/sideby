// ADR-0088: Orca TSX components sidebar panel for sideby Live Sessions. Displays only minimal
// fields from the worker and delegates copy actions back to the worker.
import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  Code,
  EmptyState,
  Heading,
  IconButton,
  type PanelContext,
  plugin,
  RelativeTime,
  Row,
  read,
  Spinner,
  Stack,
  set,
  Text,
} from 'orca'

type SessionStatus = 'needs-you' | 'busy' | 'idle' | 'unknown'

interface PanelSession {
  label: string
  sessionId: string
  reference: string
  status: SessionStatus
  cwd?: string
  startedFrom?: string
  guessed: boolean
  isCurrent: boolean
}

interface SessionsSnapshot {
  sessions: PanelSession[]
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

interface CopyFeedback {
  key: string
  tone: 'success' | 'warning' | 'danger'
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

const STARTED_FROM_LABELS: Record<string, string> = {
  orca: 'Orca',
  'claude-desktop': 'Claude Desktop',
  'claude-vscode': 'VS Code',
  script: 'Script',
}

const sessionsAtom = atom<PanelSession[]>([])
const loadedAtom = atom(false)
const loadingAtom = atom(false)
const errorAtom = atom<string | null>(null)
const updatedAtAtom = atom<number | null>(null)
const feedbackAtom = atom<CopyFeedback | null>(null)

function statusLabel(status: SessionStatus): string {
  if (status === 'needs-you') return 'Needs you'
  if (status === 'busy') return 'Working'
  if (status === 'idle') return 'Idle'
  return 'Running'
}

function statusTone(status: SessionStatus): 'warning' | 'accent' | 'neutral' {
  if (status === 'needs-you') return 'warning'
  if (status === 'busy') return 'accent'
  return 'neutral'
}

function formatStartedFrom(id: string): string {
  return Object.hasOwn(STARTED_FROM_LABELS, id) ? STARTED_FROM_LABELS[id] : id
}

function applySnapshot(snapshot: SessionsSnapshot): void {
  const nextSessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : []
  const nextError = typeof snapshot?.error === 'string' ? snapshot.error : null
  const nextUpdatedAt = typeof snapshot?.updatedAt === 'number' ? snapshot.updatedAt : null
  if (JSON.stringify(read(sessionsAtom)) !== JSON.stringify(nextSessions)) {
    set(sessionsAtom, nextSessions)
  }
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
      set(feedbackAtom, {
        key,
        tone: 'danger',
        title: 'Could not copy session',
        detail: res.error ?? 'Refresh the list and try again.',
      })
      return
    }
    if (res.copied) {
      set(feedbackAtom, {
        key,
        tone: 'success',
        title: as === 'id' ? 'Copied session id' : 'Copied for AI',
        detail: res.label,
      })
      return
    }
    set(feedbackAtom, {
      key,
      tone: 'warning',
      title: 'Copy manually (no clipboard tool found)',
      fallbackText: res.text,
    })
  } catch (err) {
    set(feedbackAtom, {
      key,
      tone: 'danger',
      title: 'Could not copy session',
      detail: err instanceof Error ? err.message : 'Unexpected worker error.',
    })
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('sessions.updated', (snapshot) => applySnapshot(snapshot)))
  void loadSessions('sessions.list')
}

export default function SidebySessionsPanel() {
  const sessions = read(sessionsAtom)
  const loaded = read(loadedAtom)
  const loading = read(loadingAtom)
  const error = read(errorAtom)
  const updatedAt = read(updatedAtAtom)
  const feedback = read(feedbackAtom)

  return (
    <Stack gap="md">
      <Row justify="between" align="center" gap="xs">
        <Heading level={2}>sideby Sessions</Heading>
        <Row gap="xs" align="center">
          {loaded ? <Badge tone="neutral">{String(sessions.length)}</Badge> : null}
          <IconButton
            icon="refresh"
            label="Refresh sessions"
            tooltip="Refresh sessions"
            size="sm"
            variant="ghost"
            disabled={loading}
            onPress={() => void loadSessions('sessions.refresh')}
          />
        </Row>
      </Row>

      {feedback ? (
        <Callout
          tone={feedback.tone}
          icon={feedback.tone === 'success' ? 'check' : 'warning'}
          title={feedback.title}
        >
          {feedback.detail ? (
            <Text size="xs" muted>
              {feedback.detail}
            </Text>
          ) : null}
          {feedback.fallbackText ? <Code block>{feedback.fallbackText}</Code> : null}
        </Callout>
      ) : null}

      {error ? (
        <Callout tone="danger" icon="warning" title="Could not read sideby sessions">
          <Text size="xs">{error}</Text>
        </Callout>
      ) : null}

      {!loaded ? (
        <Row gap="sm" align="center">
          <Spinner label="Loading sessions" labelHidden />
          <Text muted size="sm">
            Reading running sessions…
          </Text>
        </Row>
      ) : null}

      {loaded && !error && sessions.length === 0 ? (
        <EmptyState
          icon="terminal"
          title="No running sessions"
          description="Start an account with sideby run, or open a local Agent Chat in Orca, and it will appear here."
        >
          <Button
            size="sm"
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
          {sessions.map((s) => {
            const refKey = `reference:${s.sessionId}`
            const idKey = `id:${s.sessionId}`
            const refCopied = feedback?.tone === 'success' && feedback.key === refKey
            const idCopied = feedback?.tone === 'success' && feedback.key === idKey
            return (
              <Card key={s.sessionId}>
                <Stack gap="xs">
                  <Row justify="between" align="center" gap="xs" wrap>
                    <Text weight="semibold" size="sm" truncate>
                      {s.label}
                    </Text>
                    <Row gap="xs" align="center">
                      {s.isCurrent ? <Badge tone="accent">This chat</Badge> : null}
                      <Badge tone={statusTone(s.status)}>{statusLabel(s.status)}</Badge>
                    </Row>
                  </Row>

                  {s.startedFrom || s.guessed || s.cwd ? (
                    <Row gap="xs" align="center" wrap>
                      {s.startedFrom ? (
                        <Badge tone="neutral">{formatStartedFrom(s.startedFrom)}</Badge>
                      ) : null}
                      {s.guessed ? <Badge tone="warning">Guessed</Badge> : null}
                      {s.cwd ? (
                        <Text muted size="xs" truncate>
                          {s.cwd}
                        </Text>
                      ) : null}
                    </Row>
                  ) : null}

                  <Row gap="xs" wrap>
                    <Button
                      size="xs"
                      variant={s.isCurrent ? 'solid' : 'outline'}
                      icon={refCopied ? 'check' : 'copy'}
                      onPress={() => void copySession(s.sessionId, 'reference')}
                    >
                      {refCopied ? 'Copied' : 'Copy for AI'}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      icon={idCopied ? 'check' : 'copy'}
                      onPress={() => void copySession(s.sessionId, 'id')}
                    >
                      {idCopied ? 'Copied' : 'Copy session id'}
                    </Button>
                  </Row>
                </Stack>
              </Card>
            )
          })}
        </Stack>
      ) : null}

      {loaded && sessions.length > 0 ? (
        <Row justify="between" align="center" gap="xs" wrap>
          <Text muted size="xs">
            Paste "Copy for AI" into another session so it can read this one.
          </Text>
          {updatedAt ? <RelativeTime at={updatedAt} muted /> : null}
        </Row>
      ) : null}
    </Stack>
  )
}
