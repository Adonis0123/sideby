// sideby chrome around the reusable Network document. Runtime data still comes only from the Panel's own routes.
import { renderNetworkPage as renderPortalNetworkPage } from 'network-portal'
import { FAVICON_VERSION } from '../panel/page.ts'
import { pageStyles } from '../panel/page-styles.ts'
import { type ResolvedTheme, resolveTheme } from '../panel/theme.ts'

export interface NetworkPageOptions {
  basePath: string
  token: string
  nonce?: string
  version?: string
  theme?: ResolvedTheme
  lang?: 'auto' | 'en' | 'zh'
}

/** The generic page owns diagnosis and interaction; sideby owns only its theme, icon, token header and footer. */
export function renderNetworkPage(opts: NetworkPageOptions): string {
  const theme = opts.theme ?? resolveTheme(undefined)
  // A Portal serves this page under /panel/; only the Host root favicon carries the current surface's Network icon.
  const favicon = `/favicon.svg?v=${FAVICON_VERSION}`
  return renderPortalNetworkPage({
    basePath: opts.basePath,
    token: opts.token,
    ...(opts.nonce ? { nonce: opts.nonce } : {}),
    ...(opts.version ? { version: opts.version } : {}),
    ...(opts.lang ? { lang: opts.lang } : {}),
    hostStyles: pageStyles(theme),
    favicon,
    tokenHeader: 'x-sideby-token',
    footer: 'sideby',
    chrome: { title: 'Network', header: theme.header },
  })
}
