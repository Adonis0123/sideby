// Built-in, off by default. Runs `<account>/sideby-before-launch` before each Launch: the general form of
// a common hand-rolled convention (for example, start a local gateway an API Account needs).
// It is local code with the user's permissions, so it gets the same ownership checks as Plugins.
import { spawn } from 'node:child_process'
import { access, constants, mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lstatOrNull } from '../core/fs-safe.ts'
import type { Plugin } from '../types.ts'
import { checkTrusted } from './loader.ts'

export const SCRIPT_NAME = 'sideby-before-launch'
export const SCRIPT_TIMEOUT_MS = 25_000
const TAIL_LINES = 20
/** How much of the end of stderr is read back for the error. */
const STDERR_TAIL_BYTES = 16_384

function tail(text: string): string {
  return text.trimEnd().split('\n').slice(-TAIL_LINES).join('\n')
}

async function readTail(file: string): Promise<string> {
  const fh = await open(file, 'r')
  try {
    const { size } = await fh.stat()
    const length = Math.min(size, STDERR_TAIL_BYTES)
    const buf = Buffer.alloc(length)
    await fh.read(buf, 0, length, size - length)
    return buf.toString()
  } finally {
    await fh.close()
  }
}

export const accountScript: Plugin = {
  name: 'account-script',
  register(api) {
    api.on('launch.before', async (ctx) => {
      const script = join(ctx.account.dir, SCRIPT_NAME)
      const st = await lstatOrNull(script)
      if (!st) return
      if (!st.isFile()) throw api.abort(`${script} must be a regular file`)
      const problem = await checkTrusted(script)
      if (problem) throw api.abort(`refusing to run ${SCRIPT_NAME}: ${problem}`)
      try {
        await access(script, constants.X_OK)
      } catch {
        throw api.abort(`${script} is not executable; run \`chmod u+x "${script}"\``)
      }
      // stderr goes to a private temp file rather than a pipe: once the script has exited, everything it wrote is
      // in the file, so its last lines are read back without racing the event loop, and a background process the
      // script started (a gateway, say) that inherits stderr cannot hold the launch open.
      const tmp = await mkdtemp(join(tmpdir(), 'sideby-before-launch-'))
      let code: number | null
      let timedOut: boolean
      let stderr = ''
      try {
        const file = join(tmp, 'stderr')
        const out = await open(file, 'w', 0o600)
        try {
          ;({ code, timedOut } = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
            const child = spawn(script, [], {
              cwd: ctx.account.dir,
              env: ctx.env as NodeJS.ProcessEnv,
              stdio: ['ignore', 'ignore', out.fd],
            })
            const timer = setTimeout(() => {
              child.kill('SIGKILL')
              resolve({ code: null, timedOut: true })
            }, SCRIPT_TIMEOUT_MS)
            child.on('error', (e) => {
              clearTimeout(timer)
              stderr = e.message
              resolve({ code: 1, timedOut: false })
            })
            child.on('exit', (c) => {
              clearTimeout(timer)
              resolve({ code: c, timedOut: false })
            })
          }))
        } finally {
          await out.close()
        }
        if (!stderr) stderr = await readTail(file)
      } finally {
        await rm(tmp, { recursive: true, force: true })
      }
      if (timedOut) throw api.abort(`${SCRIPT_NAME} did not finish within ${SCRIPT_TIMEOUT_MS / 1000}s`)
      if (code !== 0)
        throw api.abort(`${SCRIPT_NAME} exited with ${code}; the host was not started\n${tail(stderr)}`)
    })
  },
}
