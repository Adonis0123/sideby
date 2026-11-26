// ADR-0088: scenarios for `orca plugin check mods/orca` covering empty, populated, and error states.
import { defineCheck } from 'orca/testing'

export default defineCheck({
  empty: {
    requests: {
      'sessions.list': () => ({
        sessions: [],
        error: null,
        updatedAt: 1_700_000_000_000,
      }),
    },
  },
  populated: {
    requests: {
      'sessions.list': () => ({
        sessions: [
          {
            label: 'agy:main · Fix login · 61230c3d',
            sessionId: '61230c3d-1111-4111-8111-111111111111',
            reference:
              "agy:main's session 61230c3d (Fix login), working directory /work/demo-repo. Read its record for the context.",
            status: 'busy',
            cwd: '/work/demo-repo',
            startedFrom: 'orca',
            guessed: false,
            isCurrent: true,
          },
          {
            label: 'claude:work · Release notes · a4b5c6d7',
            sessionId: 'a4b5c6d7-2222-4222-8222-222222222222',
            reference:
              "claude:work's session a4b5c6d7 (Release notes), working directory /work/demo-repo. Read its record for the context.",
            status: 'needs-you',
            cwd: '/work/demo-repo',
            startedFrom: 'orca',
            guessed: false,
            isCurrent: false,
          },
          {
            label: 'codex:main · Lint pass · 99887766',
            sessionId: '99887766-3333-4333-8333-333333333333',
            reference: "codex:main's session 99887766 (Lint pass) (its newest session, a guess).",
            status: 'idle',
            cwd: '/work/other-repo',
            guessed: true,
            isCurrent: false,
          },
        ],
        error: null,
        updatedAt: 1_700_000_000_000,
      }),
    },
  },
  error: {
    requests: {
      'sessions.list': () => ({
        sessions: [],
        error: 'Could not run sideby. Make sure sideby is installed and on PATH, then press Refresh.',
        updatedAt: 1_700_000_000_000,
      }),
    },
  },
})
