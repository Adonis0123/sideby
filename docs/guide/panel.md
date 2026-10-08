# Panel

English | [中文](panel.zh-CN.md)

← [README](../../README.md)

```sh
sideby ui              # http://127.0.0.1:17420, opens your browser
sideby ui --port 8080
sideby ui --no-open    # print the address only
```

The panel listens on `127.0.0.1` only. If another sideby panel already runs on the port, sideby opens that one; if another program holds the port, it tries the next ones and prints the address it used. The page shows each account's quota windows in aligned columns, usage, last use, sign-in email and health, and refreshes itself every 20 seconds while it is open (every 5 seconds for a few minutes after you turn on quota, so the first numbers appear soon after a status line reports them). A "Hide emails" switch masks addresses as `a•••@example.com` for screen sharing. It runs Doctor with one-click fixes, creates accounts (with an optional short command), and can turn on Claude quota after showing the diff. One quota setup covers every Claude Code account, so the "Turn on quota" button sits in the Claude Code group header, not on each account. For a new subscription account it gives you the `sideby login <account>` command to copy; signing in always happens in your terminal.

### Desktop app

```sh
sideby app install       # macOS: ~/Applications/sideby.app; Linux: a "sideby" entry in the app menu
sideby app uninstall
sideby ui --background   # what the app runs: start the panel without a terminal, then open it
sideby ui --stop         # stop the background panel
```

Double-click the app to open the panel. It starts the panel in the background when none is running (`sideby ui --background`), reuses it when one is, and opens your browser. The background panel keeps running after you close the tab and logs to `${XDG_STATE_HOME:-~/.local/state}/sideby/panel.log`. Apps started from Finder or a desktop menu get a minimal PATH, so the background panel asks your login shell (`$SHELL -ilc`) for its PATH to find hosts in places like `~/.local/bin`.

The app runs the Node and sideby it was installed with: after upgrading either, run `sideby app install` again to update it in place. If your own page embeds the panel (see below), `sideby app install --url http://accounts.localhost:17333/` makes the app open that address instead. Install and uninstall only touch files that `sideby app install` created. The app is a local, unsigned launcher script; it is not meant to be copied to other machines.

### Embed the panel

Another local Node page can mount the panel under its own path. The handler keeps its own Host, Origin and token checks; you list the hosts your page answers on.

```ts
import { createServer } from 'node:http'
import { createPanelHandler, createRuntime } from 'sideby'

const panel = createPanelHandler({
  runtime: () => createRuntime(), // a factory: every request sees the disk as it is now
  basePath: '/accounts',
  allowedHosts: ['tools.localhost:8080'],
  theme: {
    colorScheme: 'light', // 'auto' (default) follows the system
    header: 'bar', // a full-width header strip instead of a title on the page background
    light: { font: '-apple-system, "PingFang SC", sans-serif', bg: '#f2f8fc', primary: '#e1f0fb', onPrimary: '#1f6396', radius: '10px', shadow: 'none' },
  },
  lang: 'en', // 'auto' (default) uses the language picked in the panel, then the browser's
})
createServer(async (req, res) => {
  if (!(await panel(req, res))) res.writeHead(404).end()
}).listen(8080, '127.0.0.1')
```

`theme` makes the page match yours. Its tokens become CSS custom properties inside the page's own nonce'd `<style>`, so the panel's strict CSP stays as it is. An iframe cannot read its parent's CSS variables, so pass concrete values.

- **Tokens** (all optional): type `font`, `monoFont`, `fontSize`, `smallSize`, `controlSize`, `headingSize`, `largeSize`, `titleSize`, `titleWeight`, `headingWeight`, `strongWeight`, `buttonWeight`, `primaryWeight`; colors `bg`, `surface`, `surfaceMuted`, `border`, `borderStrong`, `text`, `muted`, `faint`, `hover`, `active`, `accent`, `accentSoft`, `focus`, `primary`, `primaryHover`, `primaryActive`, `onPrimary`, `primaryBorder`, `primaryHoverBorder`, `buttonText`, `buttonHoverBorder`, `buttonHoverText`, `checkColor`, `ok`, `okSoft`, `warn`, `warnSoft`, `fail`, `failSoft`, `logoBg`, `logoColor`, `logoBorder`, `shadow`, `focusOutline`, `focusRing`; shape and layout `radius`, `controlRadius`, `chipRadius`, `controlHeight`, `controlHeightSmall`, `fieldHeight`, `contentWidth`, `gutter`. [`src/panel/theme.ts`](../../src/panel/theme.ts) documents each one.
- **Light and dark**: colors in `light` apply in light mode only; type, shape and layout tokens apply in both. Give `dark` for dark-mode colors, or set `colorScheme: 'light'` when your page has no dark mode.
- **Checked when the handler is created**: an unknown token, or a value with anything but letters, digits, spaces and `# % ( ) , . + - / ' " _` (so no `;`, `{`, `}`, `<`, `\`, `*` or `:`), with `url(`, unbalanced parentheses or quotes, or over 200 characters, throws a `TypeError` that names the token.
- Without `theme`, the page looks the same as `sideby ui`.

`lang` (`'auto'`, `'en'` or `'zh'`) keeps the panel's language in step with your page. `'en'` or `'zh'` wins over the language picked in the panel and hides the panel's language switch; the choice picked there stays saved and applies again under `'auto'`. `'auto'` (the default) uses the language picked in the panel, then the browser language. Any other value throws a `TypeError` when the handler is created. The handler reads `lang` once: to switch language, create the handler again.
