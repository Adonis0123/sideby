// Test helpers for sideby and its Plugins. Every test runs against a throwaway HOME and fake Host binaries,
// so nothing a test does can reach the developer's real accounts.
import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Env } from '../src/types.ts'

export interface FakeHome {
  home: string
  /** Directory prepended to PATH; fake Host binaries live here. */
  bin: string
  /** Environment for code under test: HOME, XDG dirs and PATH all point inside the fake HOME. */
  env: Env
  path(...parts: string[]): string
  write(rel: string, data: string, mode?: number): Promise<string>
  mkdir(rel: string): Promise<string>
}

/** Runs `fn` with a fresh fake HOME and removes it afterwards. */
export async function withFakeHome<T>(fn: (h: FakeHome) => Promise<T>): Promise<T> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'sideby-test-')))
  const home = join(base, 'home')
  const bin = join(base, 'bin')
  await mkdir(home, { recursive: true })
  await mkdir(bin, { recursive: true })
  const realHome = homedir()
  if (home === realHome || home.startsWith(`${realHome}/.`))
    throw new Error('fake HOME resolved inside the real HOME')
  const env: Env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    PATH: `${bin}:/usr/bin:/bin`,
    NO_COLOR: '1',
  }
  const h: FakeHome = {
    home,
    bin,
    env,
    path: (...parts) => join(home, ...parts),
    async write(rel, data, mode = 0o644) {
      const p = join(home, rel)
      await mkdir(join(p, '..'), { recursive: true })
      await writeFile(p, data, { mode })
      await chmod(p, mode)
      return p
    },
    async mkdir(rel) {
      const p = join(home, rel)
      await mkdir(p, { recursive: true })
      return p
    },
  }
  try {
    return await fn(h)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

export interface FakeHostOptions {
  exitCode?: number
  /** Signal the fake Host sends itself after recording, for example `SIGTERM`. */
  selfSignal?: string
  /** Seconds to sleep before exiting, so tests can signal it. */
  sleep?: number
}

/**
 * Installs a fake Host executable named `name` that appends its argv, selected env and received signals
 * to `<bin>/<name>.log` as JSON lines.
 */
export async function fakeHost(h: FakeHome, name: string, opts: FakeHostOptions = {}): Promise<string> {
  const log = join(h.bin, `${name}.log`)
  const script = `#!/usr/bin/env node
const fs = require('node:fs')
const log = ${JSON.stringify(log)}
const rec = (o) => fs.appendFileSync(log, JSON.stringify(o) + '\\n')
rec({ argv: process.argv.slice(2), env: process.env, pid: process.pid })
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) process.on(s, () => { rec({ signal: s }); process.exit(${opts.sleep ? 100 : 0}) })
const finish = () => {
  ${opts.selfSignal ? `process.removeAllListeners(${JSON.stringify(opts.selfSignal)}); process.kill(process.pid, ${JSON.stringify(opts.selfSignal)})` : `process.exit(${opts.exitCode ?? 0})`}
}
${opts.sleep ? `setTimeout(finish, ${Math.round(opts.sleep * 1000)})` : 'finish()'}
`
  const p = join(h.bin, name)
  await writeFile(p, script.replace('#!/usr/bin/env node', `#!${process.execPath}`), { mode: 0o755 })
  return p
}

export interface HostRecord {
  argv: string[]
  env: Record<string, string>
  pid: number
  signal?: string
}

export async function readHostLog(h: FakeHome, name: string): Promise<HostRecord[]> {
  try {
    const raw = await readFile(join(h.bin, `${name}.log`), 'utf8')
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as HostRecord)
  } catch {
    return []
  }
}

/** Snapshot of every path under `root` with its type, symlink target or content hash, for write audits. */
export async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const { createHash } = await import('node:crypto')
  const { lstat } = await import('node:fs/promises')
  async function walk(dir: string, rel: string): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    for (const e of entries.sort()) {
      const p = join(dir, e)
      const r = rel ? `${rel}/${e}` : e
      const st = await lstat(p)
      if (st.isSymbolicLink()) out.set(r, `link:${await readlink(p)}`)
      else if (st.isDirectory()) {
        out.set(r, `dir:${(st.mode & 0o777).toString(8)}`)
        await walk(p, r)
      } else
        out.set(
          r,
          `file:${(st.mode & 0o777).toString(8)}:${createHash('sha256')
            .update(await readFile(p))
            .digest('hex')}`,
        )
    }
  }
  await walk(root, '')
  return out
}

/** Lists keys whose snapshot value differs, appeared or disappeared. */
export function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()])
  return [...keys].filter((k) => before.get(k) !== after.get(k)).sort()
}
