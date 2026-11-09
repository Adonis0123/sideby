// When a sign-in that sideby started last finished (exit 0) for an Account (ADR-0071): one small file per Account in
// sideby's state directory, holding only that time. It never says the login works; it lets the Panel say "Sign-in
// finished, waiting for confirmation" until a successful turn or Quota answer clears the Expired Login.
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from './fs-safe.ts'

export function loginMarkFile(stateDir: string, family: string, name: string): string {
  return join(stateDir, 'login', family, `${name}.json`)
}

export async function readLoginMark(file: string): Promise<string | undefined> {
  try {
    const v = (JSON.parse(await readFile(file, 'utf8')) as { signedInAt?: unknown } | null)?.signedInAt
    return typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : undefined
  } catch {
    return undefined
  }
}

export async function writeLoginMark(file: string, at: Date): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeFileAtomic(file, `${JSON.stringify({ signedInAt: at.toISOString() })}\n`, 0o600)
}
