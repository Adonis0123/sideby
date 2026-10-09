// A Handoff Brief put together from a session's local records, without a model (spec §3.17 "sideby 拼的 Brief").
// Only conversation text and edited paths are taken, never tool output, each piece clipped.

export interface SessionDigest {
  /** The first thing the user asked. */
  firstUser?: string
  /** The last text messages, oldest first. */
  recent: { role: 'user' | 'assistant'; text: string }[]
  /** Files the session edited or wrote, in first-touched order. */
  files: string[]
}

export const MAX_PIECE = 2000
export const RECENT = 6

export const clip = (s: string, max = MAX_PIECE) => (s.length > max ? `${s.slice(0, max)}…` : s)

/** Keeps the last `RECENT` messages and each edited path once. */
export class DigestBuilder {
  private d: SessionDigest = { recent: [], files: [] }
  user(text: string) {
    const t = text.trim()
    if (!t) return
    this.d.firstUser ??= clip(t)
    this.push('user', t)
  }
  assistant(text: string) {
    const t = text.trim()
    if (t) this.push('assistant', t)
  }
  file(path: unknown) {
    if (typeof path === 'string' && path && !this.d.files.includes(path)) this.d.files.push(path)
  }
  private push(role: 'user' | 'assistant', text: string) {
    this.d.recent.push({ role, text: clip(text) })
    if (this.d.recent.length > RECENT) this.d.recent.shift()
  }
  result(): SessionDigest | undefined {
    return this.d.firstUser || this.d.recent.length || this.d.files.length ? this.d : undefined
  }
}

export function formatDigest(d: SessionDigest): string {
  const out = ['## Task (first request)', '', d.firstUser ?? '(not found)', '']
  out.push('## Last messages', '')
  for (const m of d.recent) out.push(`**${m.role}:** ${m.text}`, '')
  out.push('## Files edited', '')
  out.push(...(d.files.length ? d.files.map((f) => `- ${f}`) : ['(none found)']), '')
  return out.join('\n')
}
