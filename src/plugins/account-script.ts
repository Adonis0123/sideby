// Built-in, off by default. Runs `<account>/sideby-before-launch` before each Launch: the general form of
// a common hand-rolled convention (for example, start a local gateway an API Account needs).
// It is local code with the user's permissions, so it gets the same ownership checks as Plugins.
import { spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { join } from 'node:path'
import { lstatOrNull } from '../core/fs-safe.ts'
import type { Plugin } from '../types.ts'
import { checkTrusted } from './loader.ts'

export const SCRIPT_NAME = 'sideby-before-launch'
export const SCRIPT_TIMEOUT_MS = 25_000
const TAIL_LINES = 20

function tail(text: string): string {
  return text.trimEnd().split('\n').slice(-TAIL_LINES).join('\n')
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
      const { code, stderr, timedOut } = await new Promise<{
        code: number | null
        stderr: string
        timedOut: boolean
      }>((resolve) => {
        const child = spawn(script, [], {
          cwd: ctx.account.dir,
          env: ctx.env as NodeJS.ProcessEnv,
          stdio: ['ignore', 'ignore', 'pipe'],
        })
        let err = ''
        child.stderr.on('data', (d: Buffer) => {
          err = (err + d.toString()).slice(-16_384)
        })
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          child.stderr.destroy()
          resolve({ code: null, stderr: err, timedOut: true })
        }, SCRIPT_TIMEOUT_MS)
        child.on('error', (e) => {
          clearTimeout(timer)
          resolve({ code: 1, stderr: e.message, timedOut: false })
        })
        child.on('exit', (c) => {
          clearTimeout(timer)
          // A background process the script started (a gateway, say) inherits stderr; stop reading it.
          child.stderr.destroy()
          resolve({ code: c, stderr: err, timedOut: false })
        })
      })
      if (timedOut) throw api.abort(`${SCRIPT_NAME} did not finish within ${SCRIPT_TIMEOUT_MS / 1000}s`)
      if (code !== 0)
        throw api.abort(`${SCRIPT_NAME} exited with ${code}; the host was not started\n${tail(stderr)}`)
    })
  },
}
