// `sideby network-hook` (spec §3.35): blocks with exit 2 and a reason, lets the Host go on with exit 0, and imports
// only leaf modules. Requests go through a fake fetcher.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { diffSnapshots, snapshot, withFakeHome } from '../../testing/index.ts'
import { NETWORK_ENV, RETRY_BUDGET_MS, TIMEOUT_MS } from '../core/egress.ts'
import { progressWakeUp } from '../core/prompt-origin.ts'
import { runNetworkHook } from './hook.ts'

const trace = (loc: string) => async () => `ip=203.0.113.7\nloc=${loc}\n`
const sink = () => {
  const lines: string[] = []
  return { lines, write: (s: string) => lines.push(s) }
}

/** A clock that moves only when the fake fetcher or the fake sleep says so: nothing really waits. */
const fakeTime = (start = Date.parse('2026-10-29T00:00:00Z')) => {
  let t = start
  const waits: number[] = []
  return {
    waits,
    elapsed: () => t - start,
    now: () => new Date(t),
    sleep: async (ms: number) => {
      waits.push(ms)
      t += ms
    },
    /** A request that runs out of time, as `fetchTrace` would after `TIMEOUT_MS` (or a little later). */
    timeout: (late = 0) => {
      t += TIMEOUT_MS + late
      throw new Error('timeout')
    },
  }
}

/** A session started with Network Guard on, and config that still says so (tests change it to see the hook follow). */
const sessionEnv = (dir: string, allow = 'US,JP') => {
  // Config is read from here, never from the real HOME.
  const config = join(dir, 'config')
  mkdirSync(join(config, 'sideby'), { recursive: true })
  writeFileSync(
    join(config, 'sideby', 'config.json'),
    JSON.stringify({ network: { guard: true, allow: allow.split(',') } }),
  )
  return {
    [NETWORK_ENV.url]: 'https://api.anthropic.com/cdn-cgi/trace',
    [NETWORK_ENV.allow]: allow,
    [NETWORK_ENV.dir]: dir,
    XDG_CONFIG_HOME: config,
    SIDEBY_LABEL: 'cc008',
    LANG: 'zh_CN.UTF-8',
  }
}

describe('network hook', () => {
  it('does nothing outside a session sideby started with Network Guard', async () => {
    const err = sink()
    assert.equal(await runNetworkHook(['claude', 'UserPromptSubmit'], {}, err, { fetcher: trace('HK') }), 0)
    assert.deepEqual(err.lines, [])
  })

  it('lets an allowed country through and blocks another with the reason', async () => {
    await withFakeHome(async (h) => {
      const ok = sink()
      const env = sessionEnv(h.path('net'))
      assert.equal(
        await runNetworkHook(['claude', 'UserPromptSubmit'], env, ok, { fetcher: trace('JP'), print: 'p' }),
        0,
      )
      assert.deepEqual(ok.lines, [])
      const bad = sink()
      const env2 = sessionEnv(h.path('net2'))
      assert.equal(
        await runNetworkHook(['codex', 'PreToolUse'], env2, bad, { fetcher: trace('HK'), print: 'p' }),
        2,
      )
      assert.match(bad.lines.join(''), /香港（HK）/)
      assert.match(bad.lines.join(''), /direct/)
      assert.match(bad.lines.join(''), /旧会话可能要重开/)
      assert.match(bad.lines.join(''), /sideby run cc008 --ignore-network/)
    })
  })

  it('keeps connection-refused guidance and redacts the session proxy', async () => {
    await withFakeHome(async (h) => {
      const err = sink()
      const env = {
        ...sessionEnv(h.path('net'), 'US'),
        LANG: 'en_US.UTF-8',
        HTTPS_PROXY: 'http://user:password@127.0.0.1:10809/private?token=secret',
      }
      const fetcher = async () => {
        const e = new Error('connect ECONNREFUSED') as NodeJS.ErrnoException
        e.code = 'ECONNREFUSED'
        throw e
      }
      const clock = fakeTime()
      assert.equal(
        await runNetworkHook(['claude', 'UserPromptSubmit'], env, err, {
          fetcher,
          print: 'p',
          now: clock.now,
          sleep: clock.sleep,
        }),
        2,
      )
      const text = err.lines.join('')
      assert.match(text, /http:\/\/127\.0\.0\.1:10809/)
      assert.match(text, /connection was refused/)
      assert.match(text, /older session may need restarting/)
      assert.doesNotMatch(text, /user|password|private|token|secret/)
    })
  })

  it('gives SOCKS and HTTPS proxies an HTTP CONNECT or direct next step', async () => {
    await withFakeHome(async (h) => {
      for (const [scheme, lang] of [
        ['socks5', 'en_US.UTF-8'],
        ['https', 'zh_CN.UTF-8'],
      ] as const) {
        const err = sink()
        const env = {
          ...sessionEnv(h.path(`net-${scheme}`), 'US'),
          LANG: lang,
          HTTPS_PROXY: `${scheme}://127.0.0.1:10808`,
        }
        const clock = fakeTime()
        const fetcher = async () => {
          throw new Error(`a ${scheme} proxy is not supported`)
        }
        assert.equal(
          await runNetworkHook(['claude', 'UserPromptSubmit'], env, err, {
            fetcher,
            print: 'p',
            now: clock.now,
            sleep: clock.sleep,
          }),
          2,
        )
        const text = err.lines.join('')
        assert.match(text, /HTTP CONNECT/)
        assert.match(text, lang.startsWith('zh') ? /HTTP 代理或直连/ : /HTTP proxy or a direct connection/)
      }
    })
  })

  it('follows config as it is now: off lets everything through, a newly allowed country passes', async () => {
    await withFakeHome(async (h) => {
      const env = sessionEnv(h.path('net'), 'US')
      const configFile = join(env.XDG_CONFIG_HOME, 'sideby', 'config.json')
      await mkdir(dirname(configFile), { recursive: true })
      await writeFile(configFile, JSON.stringify({ network: { allow: ['US'] } }))
      const off = sink()
      assert.equal(
        await runNetworkHook(['claude', 'UserPromptSubmit'], env, off, { fetcher: trace('HK'), print: 'p' }),
        0,
      )
      assert.deepEqual(off.lines, [])
      await writeFile(configFile, JSON.stringify({ network: { guard: true, allow: ['US', 'SG'] } }))
      const sg = sink()
      assert.equal(
        await runNetworkHook(['claude', 'PreToolUse'], env, sg, { fetcher: trace('SG'), print: 'p' }),
        0,
      )
      const hk = sink()
      assert.equal(
        await runNetworkHook(['claude', 'PreToolUse'], { ...env, [NETWORK_ENV.dir]: h.path('net-hk') }, hk, {
          fetcher: trace('HK'),
          print: 'p',
        }),
        2,
      )
      assert.match(hk.lines.join(''), /新加坡（SG）/)
    })
  })

  it('makes no request in CI, and follows a large config that says off', async () => {
    await withFakeHome(async (h) => {
      const env = sessionEnv(h.path('net'), 'US')
      let asked = 0
      const fetcher = async () => {
        asked++
        return 'loc=HK\n'
      }
      assert.equal(
        await runNetworkHook(['claude', 'PreToolUse'], { ...env, CI: 'true' }, sink(), { fetcher }),
        0,
      )
      assert.equal(asked, 0)
      const configFile = join(env.XDG_CONFIG_HOME, 'sideby', 'config.json')
      await writeFile(
        configFile,
        `${JSON.stringify({ network: { allow: ['US'] } })}${' '.repeat(5 * 1024 * 1024)}`,
      )
      assert.equal(await runNetworkHook(['claude', 'PreToolUse'], env, sink(), { fetcher, print: 'p' }), 0)
      assert.equal(asked, 0)
    })
  })

  it('treats a missing config as off, and keeps the started-with list when config is not JSON', async () => {
    await withFakeHome(async (h) => {
      const env = sessionEnv(h.path('net'), 'US')
      const configFile = join(env.XDG_CONFIG_HOME, 'sideby', 'config.json')
      await writeFile(configFile, '{ not json')
      const broken = sink()
      assert.equal(
        await runNetworkHook(['claude', 'UserPromptSubmit'], env, broken, {
          fetcher: trace('HK'),
          print: 'p',
        }),
        2,
      )
      assert.match(broken.lines.join(''), /美国（US）/)
      const gone = sink()
      const noConfig = { ...env, XDG_CONFIG_HOME: h.path('no-config') }
      assert.equal(
        await runNetworkHook(['claude', 'UserPromptSubmit'], noConfig, gone, {
          fetcher: trace('HK'),
          print: 'p',
        }),
        0,
      )
      assert.deepEqual(gone.lines, [])
    })
  })

  it('blocks when it cannot tell after asking again within the budget', async () => {
    await withFakeHome(async (h) => {
      const err = sink()
      const time = fakeTime()
      let calls = 0
      const fetcher = async () => {
        calls++
        return time.timeout()
      }
      const env = { ...sessionEnv(h.path('net')), LANG: 'en_US.UTF-8' }
      const deps = { fetcher, print: 'p', now: time.now, sleep: time.sleep }
      assert.equal(await runNetworkHook(['claude', 'UserPromptSubmit'], env, err, deps), 2)
      assert.equal(calls, 5)
      assert.deepEqual(time.waits, [1000, 2000, 4000, 8000])
      assert.ok(time.elapsed() <= RETRY_BUDGET_MS, `${time.elapsed()} ms is over the budget`)
      assert.match(err.lines.join(''), /could not tell this network's exit after 5 tries in about 30 s/)
      assert.match(err.lines.join(''), /no answer within 3 seconds/)
    })
  })

  it('says how long it tried in Chinese too', async () => {
    await withFakeHome(async (h) => {
      const err = sink()
      const time = fakeTime()
      const deps = { fetcher: async () => time.timeout(), print: 'p', now: time.now, sleep: time.sleep }
      assert.equal(await runNetworkHook(['claude', 'PreToolUse'], sessionEnv(h.path('net')), err, deps), 2)
      assert.match(err.lines.join(''), /试了 5 次（约 30 秒）仍没能确认网络出口（3 秒内没有回应）/)
    })
  })

  it('goes on when a later try answers with an allowed country', async () => {
    await withFakeHome(async (h) => {
      const err = sink()
      const time = fakeTime()
      let calls = 0
      const fetcher = async () => (++calls === 1 ? time.timeout() : trace('JP')())
      const deps = { fetcher, print: 'p', now: time.now, sleep: time.sleep }
      assert.equal(
        await runNetworkHook(['claude', 'UserPromptSubmit'], sessionEnv(h.path('net')), err, deps),
        0,
      )
      assert.equal(calls, 2)
      assert.deepEqual(time.waits, [1000])
      assert.deepEqual(err.lines, [])
    })
  })

  it('asks again when the answer names no country', async () => {
    await withFakeHome(async (h) => {
      const time = fakeTime()
      let calls = 0
      const fetcher = async () => (++calls === 1 ? 'ip=203.0.113.7\n' : trace('US')())
      const deps = { fetcher, print: 'p', now: time.now, sleep: time.sleep }
      assert.equal(await runNetworkHook(['codex', 'PreToolUse'], sessionEnv(h.path('net')), sink(), deps), 0)
      assert.equal(calls, 2)
    })
  })

  it('blocks a country outside the list at once, without asking again', async () => {
    await withFakeHome(async (h) => {
      const err = sink()
      const time = fakeTime()
      let calls = 0
      const fetcher = async () => {
        calls++
        return trace('HK')()
      }
      const deps = { fetcher, print: 'p', now: time.now, sleep: time.sleep }
      assert.equal(
        await runNetworkHook(['claude', 'UserPromptSubmit'], sessionEnv(h.path('net')), err, deps),
        2,
      )
      assert.equal(calls, 1)
      assert.deepEqual(time.waits, [])
      assert.match(err.lines.join(''), /香港（HK）/)
    })
  })

  it('stops asking when the next try would not fit the budget', async () => {
    await withFakeHome(async (h) => {
      const time = fakeTime()
      let calls = 0
      // Each timeout fires half a second late: a fifth try after the 8-second wait would end past the budget.
      const fetcher = async () => {
        calls++
        return time.timeout(500)
      }
      const deps = { fetcher, print: 'p', now: time.now, sleep: time.sleep }
      assert.equal(
        await runNetworkHook(['claude', 'UserPromptSubmit'], sessionEnv(h.path('net')), sink(), deps),
        2,
      )
      assert.equal(calls, 4)
      assert.deepEqual(time.waits, [1000, 2000, 4000])
      assert.ok(time.elapsed() <= RETRY_BUDGET_MS, `${time.elapsed()} ms`)
    })
  })

  it('a tool call in the middle tier goes on and starts a refresh; Refresh asks and keeps the answer', async () => {
    await withFakeHome(async (h) => {
      const env = sessionEnv(h.path('net'))
      const t0 = Date.parse('2026-10-27T00:00:00Z')
      await runNetworkHook(['claude', 'Refresh'], env, sink(), {
        fetcher: trace('US'),
        print: 'p',
        now: () => new Date(t0),
      })
      let started = 0
      const code = await runNetworkHook(['claude', 'PreToolUse'], env, sink(), {
        fetcher: async () => assert.fail('no request in this tier'),
        print: 'p',
        now: () => new Date(t0 + 90_000),
        background: () => started++,
      })
      assert.equal(code, 0)
      assert.equal(started, 1)
    })
  })

  it('ignores events it does not guard', async () => {
    await withFakeHome(async (h) => {
      const env = sessionEnv(h.path('net'))
      assert.equal(await runNetworkHook(['claude', 'Stop'], env, sink(), { fetcher: trace('HK') }), 0)
    })
  })
})

/** What Claude Code hands a `UserPromptSubmit` hook; every hook of one submit gets the same `prompt_id`. */
const promptInput = (prompt: string, id = 'prompt-1') =>
  JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt_id: id, prompt })
const NOTIFICATION =
  '<task-notification>\n<task-id>task-7</task-id>\n<status>failed</status>\n<summary>Agent "review" failed</summary>\n</task-notification>'
const markers = async (dir: string) => readdir(join(dir, 'held')).catch(() => [] as string[])

describe('network hook: a prompt the Host made itself (spec §3.35)', () => {
  it('holds a blocked background-task notification and hands it over once the exit is allowed again', async () => {
    await withFakeHome(async (h) => {
      const env = sessionEnv(h.path('net'), 'US')
      const before = await snapshot(h.home)
      const blocked = sink()
      assert.equal(
        await runNetworkHook(['claude', 'UserPromptSubmit'], env, blocked, {
          fetcher: trace('CN'),
          print: 'p',
          input: promptInput(NOTIFICATION),
        }),
        2,
      )
      assert.match(blocked.lines.join(''), /中国大陆（CN）/)
      const time = fakeTime()
      const locs = ['CN', 'US']
      let asked = 0
      const held = sink()
      const code = await runNetworkHook(['claude', 'Held'], env, held, {
        fetcher: async () => `ip=203.0.113.7\nloc=${locs[asked++] ?? 'US'}\n`,
        print: 'p',
        now: time.now,
        sleep: time.sleep,
        parentGone: () => false,
        input: promptInput(NOTIFICATION),
      })
      assert.equal(code, 2)
      assert.equal(asked, 2)
      assert.deepEqual(time.waits, [15_000, 30_000])
      const text = held.lines.join('')
      assert.ok(text.includes(`<sideby-held-message>\n${NOTIFICATION}\n</sideby-held-message>`), text)
      assert.match(text, /扣住/)
      assert.deepEqual(await markers(env[NETWORK_ENV.dir]), [])
      // Nothing outside sideby's own folders: no Host directory is written.
      assert.deepEqual(
        diffSnapshots(before, await snapshot(h.home)).filter(
          (f) => !f.includes('net') && !f.includes('config'),
        ),
        [],
      )
    })
  })

  it('hands nothing over while the exit stays outside the list, asking at 15 s, 30 s, then every 60 s', async () => {
    await withFakeHome(async (h) => {
      const env = sessionEnv(h.path('net'), 'US')
      await runNetworkHook(['claude', 'UserPromptSubmit'], env, sink(), {
        fetcher: trace('CN'),
        print: 'p',
        input: promptInput(NOTIFICATION),
      })
      const time = fakeTime()
      let asked = 0
      const held = sink()
      const code = await runNetworkHook(['claude', 'Held'], env, held, {
        fetcher: async () => {
          asked++
          return 'ip=203.0.113.7\nloc=CN\n'
        },
        print: 'p',
        now: time.now,
        sleep: time.sleep,
        parentGone: () => asked >= 4,
        input: promptInput(NOTIFICATION),
      })
      assert.equal(code, 0)
      assert.deepEqual(held.lines, [])
      assert.deepEqual(time.waits, [15_000, 30_000, 60_000, 60_000, 60_000])
      assert.equal(asked, 4)
    })
  })

  it('gives up without a word when its time runs out', async () => {
    await withFakeHome(async (h) => {
      const env = sessionEnv(h.path('net'), 'US')
      await runNetworkHook(['claude', 'UserPromptSubmit'], env, sink(), {
        fetcher: async () => {
          throw new Error('timeout')
        },
        print: 'p',
        sleep: async () => {},
        input: promptInput(NOTIFICATION),
      })
      const time = fakeTime()
      const held = sink()
      const code = await runNetworkHook(['claude', 'Held'], env, held, {
        fetcher: trace('CN'),
        print: 'p',
        now: time.now,
        sleep: time.sleep,
        parentGone: () => false,
        input: promptInput(NOTIFICATION),
      })
      assert.equal(code, 0)
      assert.deepEqual(held.lines, [])
      assert.ok(time.elapsed() < 5 * 3600_000, `${time.elapsed()} ms`)
      assert.ok(time.elapsed() > 4.9 * 3600_000, `${time.elapsed()} ms`)
      assert.ok(time.waits.slice(2).every((w) => w === 60_000))
    })
  })

  it('leaves a prompt the user typed as it was: blocked with the same words, nothing held', async () => {
    await withFakeHome(async (h) => {
      const env = sessionEnv(h.path('net'), 'US')
      const blocked = sink()
      assert.equal(
        await runNetworkHook(['claude', 'UserPromptSubmit'], env, blocked, {
          fetcher: trace('CN'),
          print: 'p',
          input: promptInput('continue'),
        }),
        2,
      )
      assert.match(blocked.lines.join(''), /然后重新发送这条消息/)
      assert.deepEqual(await markers(env[NETWORK_ENV.dir]), [])
      const held = sink()
      assert.equal(
        await runNetworkHook(['claude', 'Held'], env, held, {
          fetcher: async () => assert.fail('no request for a typed prompt'),
          sleep: async () => assert.fail('no wait for a typed prompt'),
          input: promptInput('continue'),
        }),
        0,
      )
      assert.deepEqual(held.lines, [])
    })
  })

  it('does nothing for a notification that went through', async () => {
    await withFakeHome(async (h) => {
      const env = sessionEnv(h.path('net'), 'US')
      assert.equal(
        await runNetworkHook(['claude', 'UserPromptSubmit'], env, sink(), {
          fetcher: trace('US'),
          print: 'p',
          input: promptInput(NOTIFICATION),
        }),
        0,
      )
      assert.equal((await markers(env[NETWORK_ENV.dir])).length, 1)
      const held = sink()
      assert.equal(
        await runNetworkHook(['claude', 'Held'], env, held, {
          fetcher: async () => assert.fail('the hook that decided already asked'),
          sleep: async () => assert.fail('no wait'),
          input: promptInput(NOTIFICATION),
        }),
        0,
      )
      assert.deepEqual(held.lines, [])
      assert.deepEqual(await markers(env[NETWORK_ENV.dir]), [])
    })
  })

  it('stops waiting for a decision that never comes', async () => {
    await withFakeHome(async (h) => {
      const env = sessionEnv(h.path('net'), 'US')
      const time = fakeTime()
      const held = sink()
      assert.equal(
        await runNetworkHook(['claude', 'Held'], env, held, {
          fetcher: async () => assert.fail('no request without a decision'),
          now: time.now,
          sleep: time.sleep,
          input: promptInput(NOTIFICATION),
        }),
        0,
      )
      assert.deepEqual(held.lines, [])
      assert.ok(time.elapsed() >= 65_000 && time.elapsed() <= 65_200)
    })
  })

  it('hands the notification over when the check is turned off while it waits', async () => {
    await withFakeHome(async (h) => {
      const env = sessionEnv(h.path('net'), 'US')
      await runNetworkHook(['claude', 'UserPromptSubmit'], env, sink(), {
        fetcher: trace('CN'),
        print: 'p',
        input: promptInput(NOTIFICATION),
      })
      const held = sink()
      const code = await runNetworkHook(['claude', 'Held'], { ...env, LANG: 'en_US.UTF-8' }, held, {
        fetcher: async () => assert.fail('off makes no request'),
        sleep: async () => {
          await writeFile(
            join(env.XDG_CONFIG_HOME, 'sideby', 'config.json'),
            JSON.stringify({ network: { guard: false, allow: ['US'] } }),
          )
        },
        parentGone: () => false,
        input: promptInput(NOTIFICATION),
      })
      assert.equal(code, 2)
      assert.match(held.lines.join(''), /held back/)
      assert.ok(held.lines.join('').includes(NOTIFICATION))
    })
  })

  it('hands the notification over at once when the check was turned off right after the block', async () => {
    await withFakeHome(async (h) => {
      const env = sessionEnv(h.path('net'), 'US')
      await runNetworkHook(['claude', 'UserPromptSubmit'], env, sink(), {
        fetcher: trace('CN'),
        print: 'p',
        input: promptInput(NOTIFICATION),
      })
      await writeFile(
        join(env.XDG_CONFIG_HOME, 'sideby', 'config.json'),
        JSON.stringify({ network: { guard: false, allow: ['US'] } }),
      )
      const held = sink()
      const code = await runNetworkHook(['claude', 'Held'], env, held, {
        fetcher: async () => assert.fail('off makes no request'),
        sleep: async () => assert.fail('the decision is already there'),
        input: promptInput(NOTIFICATION),
      })
      assert.equal(code, 2)
      assert.ok(held.lines.join('').includes(NOTIFICATION))
      assert.deepEqual(await markers(env[NETWORK_ENV.dir]), [])
    })
  })

  it('holds a blocked Progress Reminder and hands it over whole, its start time with it (spec §3.42)', async () => {
    await withFakeHome(async (h) => {
      const env = sessionEnv(h.path('net'), 'US')
      // How Claude Code 2.1.325 hands a background Stop hook's exit 2 to the session.
      const wake =
        '<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command "Stop": sideby progress reminder: you are waiting on background work (1 task: subagent "review"), since 11:40, 10 minutes as of this reminder.\n\n</system-reminder>'
      assert.equal(
        await runNetworkHook(['claude', 'UserPromptSubmit'], env, sink(), {
          fetcher: trace('CN'),
          print: 'p',
          input: promptInput(wake, 'prompt-wake'),
        }),
        2,
      )
      const time = fakeTime()
      const held = sink()
      const code = await runNetworkHook(['claude', 'Held'], env, held, {
        fetcher: trace('US'),
        print: 'p',
        now: time.now,
        sleep: time.sleep,
        parentGone: () => false,
        input: promptInput(wake, 'prompt-wake'),
      })
      assert.equal(code, 2)
      const text = held.lines.join('')
      assert.ok(text.includes('sideby progress reminder: you are waiting on background work'), text)
      assert.ok(text.includes('since 11:40'), text)
      // Claude Code wakes the session with it; the turn it starts is still a reminder's (spec §3.42).
      const delivered = `<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command "UserPromptSubmit": ${text}\n</system-reminder>`
      assert.equal(progressWakeUp(delivered), true)
    })
  })

  it('hands a notification over whole when its own text contains the tags', async () => {
    await withFakeHome(async (h) => {
      const env = sessionEnv(h.path('net'), 'US')
      const tagged = `${NOTIFICATION}\n<sideby-held-message>\nnot the message\n</sideby-held-message>`
      await runNetworkHook(['claude', 'UserPromptSubmit'], env, sink(), {
        fetcher: trace('CN'),
        print: 'p',
        input: promptInput(tagged),
      })
      const time = fakeTime()
      const held = sink()
      const code = await runNetworkHook(['claude', 'Held'], env, held, {
        fetcher: trace('US'),
        print: 'p',
        now: time.now,
        sleep: time.sleep,
        parentGone: () => false,
        input: promptInput(tagged),
      })
      assert.equal(code, 2)
      assert.ok(held.lines.join('').includes(NOTIFICATION), held.lines.join(''))
    })
  })

  it('does not wait for input that never ends: the check runs as if it were given none', async () => {
    await withFakeHome(async (h) => {
      const env = sessionEnv(h.path('net'), 'US')
      const never: AsyncIterable<string> = {
        [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<string>>(() => {}) }),
      }
      const err = sink()
      const code = await runNetworkHook(['claude', 'UserPromptSubmit'], env, err, {
        fetcher: trace('CN'),
        print: 'p',
        input: never,
        inputWaitMs: 50,
      })
      assert.equal(code, 2)
      assert.match(err.lines.join(''), /中国大陆（CN）/)
      assert.deepEqual(await markers(env[NETWORK_ENV.dir]), [])
    })
  })

  it('hands over the first message alone when its own wake-up was blocked again', async () => {
    await withFakeHome(async (h) => {
      const env = sessionEnv(h.path('net'), 'US')
      const wake = `<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command "UserPromptSubmit": held back.\n<sideby-held-message>\n${NOTIFICATION}\n</sideby-held-message>\n\n</system-reminder>`
      await runNetworkHook(['claude', 'UserPromptSubmit'], env, sink(), {
        fetcher: trace('CN'),
        print: 'p',
        input: promptInput(wake, 'prompt-2'),
      })
      const held = sink()
      const code = await runNetworkHook(['claude', 'Held'], env, held, {
        fetcher: trace('US'),
        print: 'p',
        sleep: async () => {},
        parentGone: () => false,
        input: promptInput(wake, 'prompt-2'),
      })
      assert.equal(code, 2)
      const text = held.lines.join('')
      assert.equal(text.split('<sideby-held-message>').length, 2)
      assert.ok(text.includes(`<sideby-held-message>\n${NOTIFICATION}\n</sideby-held-message>`), text)
      assert.ok(!text.includes('Stop hook feedback'))
    })
  })

  it('cuts a long message, keeps no text on disk, and removes decisions nobody read within an hour', async () => {
    await withFakeHome(async (h) => {
      const env = sessionEnv(h.path('net'), 'US')
      const dir = env[NETWORK_ENV.dir]
      await mkdir(join(dir, 'held'), { recursive: true, mode: 0o700 })
      const old = join(dir, 'held', 'a'.repeat(32))
      await writeFile(old, 'blocked')
      const twoHoursAgo = new Date(Date.now() - 2 * 3600_000)
      await utimes(old, twoHoursAgo, twoHoursAgo)
      const long = `<task-notification>\nSECRET-${'x'.repeat(9000)}END</task-notification>`
      await runNetworkHook(['claude', 'UserPromptSubmit'], env, sink(), {
        fetcher: trace('CN'),
        print: 'p',
        input: promptInput(long, 'prompt-3'),
      })
      const left = await markers(dir)
      assert.equal(left.length, 1)
      assert.match(left[0]!, /^[0-9a-f]{32}$/)
      assert.notEqual(left[0], 'a'.repeat(32))
      assert.equal(await readFile(join(dir, 'held', left[0]!), 'utf8'), 'blocked')
      for (const [file, hash] of await snapshot(dir)) assert.ok(!`${file}${hash}`.includes('prompt-3'))
      const held = sink()
      await runNetworkHook(['claude', 'Held'], { ...env, LANG: 'en_US.UTF-8' }, held, {
        fetcher: trace('US'),
        print: 'p',
        sleep: async () => {},
        parentGone: () => false,
        input: promptInput(long, 'prompt-3'),
      })
      const text = held.lines.join('')
      assert.ok(text.includes('SECRET-') && !text.includes('END</task-notification>'))
      assert.match(text, /cut at 8000 characters/)
    })
  })

  it('a hook that is given no input decides as before', async () => {
    await withFakeHome(async (h) => {
      const env = sessionEnv(h.path('net'), 'US')
      assert.equal(
        await runNetworkHook(['claude', 'UserPromptSubmit'], env, sink(), {
          fetcher: trace('CN'),
          print: 'p',
          input: 'not json',
        }),
        2,
      )
      assert.equal(await runNetworkHook(['claude', 'Held'], env, sink(), { input: 'not json' }), 0)
      assert.deepEqual(await markers(env[NETWORK_ENV.dir]), [])
    })
  })
})

describe('network hook imports', () => {
  it('reaches only leaf modules: never the Runtime, a Family index or core/accounts.ts', async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const seen = new Set<string>()
    const walk = async (file: string) => {
      if (seen.has(file)) return
      seen.add(file)
      const text = await readFile(file, 'utf8')
      for (const m of text.matchAll(/^import (?!type )[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm))
        await walk(resolve(dirname(file), m[1]!))
    }
    await walk(join(root, 'network/hook.ts'))
    assert.ok(seen.has(join(root, 'core/egress.ts')), 'the walk follows imports')
    const allowed = new Set([
      'network/hook.ts',
      'core/egress.ts',
      'core/fs-safe.ts',
      'core/paths.ts',
      'core/prompt-origin.ts',
    ])
    assert.deepEqual(
      [...seen].map((f) => relative(root, f)).filter((f) => !allowed.has(f)),
      [],
    )
  })
})
