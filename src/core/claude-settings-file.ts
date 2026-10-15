// One Claude Account's `settings.json`, as the writers of a single key use it (tune apply, ADR-0012; Remote Control,
// ADR-0017): where it really lives, a safe read, and rendering it back with the file's own indentation.
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Account } from '../types.ts'
import { lstatOrNull, realpathOrNull } from './fs-safe.ts'

const MAX_BYTES = 5_000_000

export type Json = Record<string, unknown>

export const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

function detectIndent(text: string): string | number {
  const m = /^([ \t]+)"/m.exec(text)
  if (!m) return 2
  const lead = m[1] as string
  return lead.startsWith('\t') ? '\t' : lead.length
}

export function render(obj: Json, original: string): string {
  const out = JSON.stringify(obj, null, detectIndent(original))
  return original.endsWith('\n') || original === '' ? `${out}\n` : out
}

export async function readObject(file: string): Promise<{ text: string; obj: Json } | { error: string }> {
  const st = await stat(file).catch(() => null)
  if (!st?.isFile()) return { error: 'it is not a regular file' }
  if (st.size > MAX_BYTES) return { error: 'it is too large to be a settings file' }
  const text = await readFile(file, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { error: 'it is not valid JSON' }
  }
  if (!isObj(parsed)) return { error: 'it is not a JSON object' }
  return { text, obj: parsed }
}

/** Where the Account's settings really live, and whether `settings.json` is a link to it. */
export async function locate(
  account: Account,
): Promise<{ file: string; link: boolean; exists: boolean; broken?: boolean }> {
  const path = join(account.dir, 'settings.json')
  const lst = await lstatOrNull(path)
  // Every path is canonical (no link anywhere in it), so two Accounts that share a file compare equal and the undo
  // record is found from either of them, even when HOME itself sits behind a link.
  if (!lst) {
    const dir = (await realpathOrNull(account.dir)) ?? account.dir
    return { file: join(dir, 'settings.json'), link: false, exists: false }
  }
  const real = await realpathOrNull(path)
  if (!lst.isSymbolicLink()) return { file: real ?? path, link: false, exists: true }
  return real
    ? { file: real, link: true, exists: true }
    : { file: path, link: true, exists: false, broken: true }
}
