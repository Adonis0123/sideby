// The native AI Tasks whose Task Prompts `native-prompts.json` holds as they were written before the Task Spec
// (ADR-0030): every task kind, both languages, with and without text, context and attachments. task-spec.test.ts
// checks that `sideby ask --spec` still writes each one byte for byte.
export const NATIVE_CONTEXT = {
  account: 'claude:work',
  family: 'claude',
  quotaReason: 'no-data: no status line yet',
  version: '0.0.0-test',
  terminalCustom: 'demo-term --cwd {cwd} -e {cmd}',
  terminals: ['Ghostty', 'Terminal'],
  handoff: ['Auto Handoff: on', 'Threshold: 90%'],
  findings: [
    { code: 'link.dangling', account: 'claude:work', item: 'settings.json', message: 'points nowhere', hint: 'relink it' },
    { message: 'second problem' },
  ],
}

export const NATIVE_ATTACHMENTS = [
  { path: '/tmp/sideby-test/ai/attachments/0123456789abcdef/1.png', kind: 'image' as const },
  { path: '/tmp/sideby-test/ai/attachments/0123456789abcdef/2.mp4', kind: 'video' as const },
]

export interface NativeCase {
  name: string
  input: { task: string; text?: string; context?: typeof NATIVE_CONTEXT; lang: string }
  attachments: { path: string; kind: 'image' | 'video' }[]
}

export function nativePromptCases(kinds: readonly string[]): NativeCase[] {
  const out: NativeCase[] = []
  for (const lang of ['en', 'zh'])
    for (const task of kinds) {
      out.push({ name: `${lang} ${task} bare`, input: { task, lang }, attachments: [] })
      out.push({
        name: `${lang} ${task} full`,
        input: { task, lang, text: 'please help with this', context: NATIVE_CONTEXT },
        attachments: NATIVE_ATTACHMENTS,
      })
    }
  return out
}
