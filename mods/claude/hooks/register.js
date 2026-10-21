// sideby's Claude Code mod (spec §3.32 step 3, ADR-0039). `sideby run` loads it with `--plugin-dir` on Claude Code
// 2.1.287 or later. It only shows things and reads `sideby sessions --json`: a band above the prompt with this
// session's Session Label, a toast when a sideby Message arrives, and a `/sessions` pane of every running session
// with buttons that copy one for another AI. It changes no prompt, tool call or file.

const PANE = 'sideby-sessions'
/** The first line `sideby send` gives every Message it delivers (spec §3.32 step 2). */
const MESSAGE_LINE = /^sideby message (\S+) from (.+)$/
/** How often the band looks for the session's title, which Claude Code sets after the first turns. */
const LABEL_EVERY_MS = 30_000
/** Once the label stopped changing, only a rename is left to notice, so the band looks far less often. */
const LABEL_SETTLED_MS = 5 * 60_000
/** How many looks in a row must bring the same label before it counts as settled. */
const LABEL_SAME_LOOKS = 2
const PANE_EVERY_MS = 5_000

const TEXT = {
  en: {
    command: 'Show your running sessions across accounts (sideby)',
    title: 'Sessions',
    opened: 'Sessions pane opened.',
    loading: 'Reading your sessions…',
    empty: 'No running sessions. Start an account with sideby and it shows here.',
    noSideby: 'sideby did not answer. Check that `sideby` runs in a terminal, then reopen /sessions.',
    arrived: (from) => `Message from ${from}`,
    copied: 'Copied',
    copyRef: 'Copy for AI',
    copyId: 'Copy session id',
    thisOne: ' (this session)',
    guessed: 'newest session (guessed)',
    run: 'task: ',
    status: { 'needs-you': 'needs you', busy: 'working', idle: 'idle', unknown: 'running' },
    ago: (m) => (m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`),
    hint: 'Click "Copy for AI" and paste it into another session, so that session can read this one.',
  },
  zh: {
    command: '查看各账号正在运行的会话（sideby）',
    title: '会话',
    opened: '已打开会话面板。',
    loading: '正在读取会话…',
    empty: '还没有运行中的会话。用 sideby 启动账号后会显示在这里。',
    noSideby: '连不上 sideby。先在终端确认 `sideby` 能运行，再重开 /sessions。',
    arrived: (from) => `${from} 发来一条消息`,
    copied: '已复制',
    copyRef: '复制给 AI',
    copyId: '复制会话 id',
    thisOne: '（本会话）',
    guessed: '最新会话（推测）',
    run: '任务：',
    status: { 'needs-you': '需要你处理', busy: '运行中', idle: '空闲', unknown: '在运行' },
    ago: (m) => (m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : `${Math.floor(m / 60)} 小时前`),
    hint: '点「复制给 AI」，贴到另一个会话，对方就能读到这个会话。',
  },
}
const DOT = { 'needs-you': '!', busy: '●', idle: '○', unknown: '·' }

let text = TEXT.en
let home = ''
/** This Launch's Account (`SIDEBY_ACCOUNT`); unset when Claude Code was not started by sideby. */
let account
let label
/** The label sideby gave on the last look, and how many looks in a row brought it. A title can stand in for the one
 * Claude Code gives after the first turns (the folder name), so a label counts as settled only once it stops changing. */
let lastLook
let sameLooks = 0
let lastLabelLook = 0
let list = { loaded: false, sessions: [] }
let reading = false
let tick

/** Runs `sideby <args> --json` and returns its answer; throws with sideby's own message when it fails. */
async function sideby($, args) {
  let ran
  try {
    ran = await $.process.run(['sideby', ...args, '--json'], { timeoutMs: 20_000 })
  } catch {
    throw new Error(text.noSideby)
  }
  let out
  try {
    out = JSON.parse(ran.stdout)
  } catch {
    throw new Error(text.noSideby)
  }
  if (ran.exitCode !== 0) throw new Error(typeof out?.error === 'string' ? out.error : text.noSideby)
  return out
}

/** Grows the band from `cc002 · 61230c3d` into the full Session Label once Claude Code has titled the session. */
async function lookLabel($, force = false) {
  if (!account) return
  const now = await $.clock.now()
  const every = sameLooks >= LABEL_SAME_LOOKS ? LABEL_SETTLED_MS : LABEL_EVERY_MS
  if (!force && now - lastLabelLook < every) return
  lastLabelLook = now
  try {
    const id = await $.session.id()
    const out = await sideby($, ['sessions', account])
    const row = (out.sessions ?? []).find((s) => s.sessionId === id)
    if (row?.label) {
      sameLooks = row.label === lastLook ? sameLooks + 1 : 1
      lastLook = row.label
    }
    if (row?.label && row.label !== label) {
      label = row.label
      $.ui.invalidate('ui.render')
    }
  } catch {
    // The short label stays; the next turn tries again.
  }
}

async function paneIsOpen($) {
  return (await $.ui.panes()).some((pane) => pane.id === PANE)
}

/** Reads every Live Session for the pane, and redraws only when the answer changed. */
async function readSessions($) {
  if (reading) return
  reading = true
  try {
    let next
    try {
      const out = await sideby($, ['sessions'])
      next = { loaded: true, sessions: out.sessions ?? [] }
    } catch (err) {
      next = { loaded: true, sessions: list.sessions, error: err.message }
    }
    if (JSON.stringify(next) !== JSON.stringify(list)) {
      list = next
      $.ui.invalidate('ui.render')
    }
  } finally {
    reading = false
  }
}

/** Keeps the pane fresh while it is open, and stops once it is closed. */
function watchPane($) {
  if (tick) return
  tick = $.clock.every(PANE_EVERY_MS, () => {
    void paneIsOpen($).then((open) => {
      if (open) return readSessions($)
      tick?.cancel()
      tick = undefined
    })
  })
}

async function openPane($) {
  await $.ui.open({ id: PANE, title: text.title })
  void readSessions($)
  watchPane($)
}

function where(cwd) {
  return home && (cwd === home || cwd?.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : (cwd ?? '')
}

async function copy($, press, value) {
  await $.ui.copy({ text: value, surface: press?.surface })
  $.ui.toast(text.copied)
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    const locale =
      (await $.env.get('LC_ALL')) || (await $.env.get('LC_MESSAGES')) || (await $.env.get('LANG')) || ''
    text = /^zh/i.test(locale) ? TEXT.zh : TEXT.en
    home = (await $.env.get('HOME')) ?? ''
    account = await $.env.get('SIDEBY_ACCOUNT')
    if (account) {
      const short = (await $.env.get('SIDEBY_LABEL')) || account
      label = `${short} · ${(await $.session.id()).slice(0, 8)}`
      void lookLabel($, true)
    }
    await $.command.register({ name: 'sessions', description: text.command })
    // A reload keeps an open pane but starts the module over: pick its refresh up again.
    if (await paneIsOpen($)) {
      void readSessions($)
      watchPane($)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    void lookLabel($)
    return next(e)
  })

  // Only watches: every delivery goes on unchanged, also when the toast fails. `sideby send` arrives through the
  // session's message socket, which Claude Code marks as a peer's message; a relay quoting the line raises nothing.
  on('session.receive', async ($, e, next) => {
    const first = e.origin?.kind === 'peer' ? MESSAGE_LINE.exec(e.text.split('\n', 1)[0] ?? '') : null
    if (first) {
      $.ui.toast(text.arrived(first[2].trim()))
      void paneIsOpen($).then((open) => open && readSessions($))
    }
    return next(e)
  }).catch((_$, e, next) => next(e))

  on('command.run', { command: 'sessions' }, async ($) => {
    await openPane($)
    return { text: text.opened }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!label || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return h(Box, null, h(Text, { dimColor: true }, label))
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    if (!list.loaded) return h(Text, { dimColor: true }, text.loading)
    const now = await $.clock.now()
    const self = account ? await $.session.id() : undefined
    const rows = list.sessions.map((s) => {
      const minutes = Math.max(0, Math.floor((now - Date.parse(s.updatedAt ?? s.startedAt)) / 60_000))
      const details = [
        text.status[s.status] ?? s.status,
        where(s.cwd),
        Number.isFinite(minutes) ? text.ago(minutes) : '',
        s.guessed ? text.guessed : '',
        s.run?.title ? `${text.run}${s.run.title}` : '',
      ].filter(Boolean)
      return h(
        Box,
        { key: s.sessionId, flexDirection: 'column' },
        h(
          Text,
          { bold: s.sessionId === self },
          `${DOT[s.status] ?? '·'} ${s.label}${s.sessionId === self ? text.thisOne : ''}`,
        ),
        h(Text, { dimColor: true }, `  ${details.join(' · ')}`),
        h(
          Box,
          { gap: 1 },
          h(Button, {
            key: `ref-${s.sessionId}`,
            label: text.copyRef,
            onPress: (p) => copy($, p, s.reference),
          }),
          h(Button, {
            key: `id-${s.sessionId}`,
            label: text.copyId,
            onPress: (p) => copy($, p, s.sessionId),
          }),
        ),
      )
    })
    return h(
      Box,
      { flexDirection: 'column', gap: 1 },
      list.error ? h(Text, { color: 'error' }, list.error) : null,
      rows.length === 0 && !list.error ? h(Text, { dimColor: true }, text.empty) : null,
      ...rows,
      rows.length ? h(Text, { dimColor: true }, text.hint) : null,
    )
  })
}
