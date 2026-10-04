import type { ShareMode } from '../types.ts'

export const SHARE_MODES = [
  'link',
  'copy',
  'link-or-copy',
  'link-or-local',
  'local',
  'local-if-api',
  'info',
  'json-key',
] as const satisfies readonly ShareMode[]
