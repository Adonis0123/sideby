# Panel

English | [中文](panel.zh-CN.md)

← [README](../../README.md)

```sh
sideby ui              # http://127.0.0.1:17420, opens your browser
sideby ui --port 8080
sideby ui --no-open    # print the address only
```

The panel listens on `127.0.0.1` only. If another sideby panel already runs on the port, sideby opens that one; if another program holds the port, it tries the next ones and prints the address it used. The page shows each account's sign-in email, quota windows in aligned columns and last use; click an account to see how it runs, its token usage and its health. An orange or red dot after a name means it needs a look (a quota window near its limit, or a Doctor finding); hover it for why. The page refreshes itself every 20 seconds while it is open (every 5 seconds for a few minutes after you turn on quota, so the first numbers appear soon after a status line reports them). "Hide emails" under **Display** masks addresses as `a•••@example.com` for screen sharing. Two Claude Code accounts signed in as the same login say "Same login as …" in their details and show the same, freshest quota (hover it to see which account it was read from); the warning dot shows once, on the account the reading comes from (see [Two directories, one login](usage.md#two-directories-one-login)). **Display** also switches between used and left quota and between the list and cards. The panel remembers which accounts you opened, in your browser. An opened Claude Code or Codex account shows the model and effort it runs with; click it, or "Model and effort…" in the account's menu, to set them for that account alone (see [Model and effort](usage.md#model-and-effort)). On macOS, a Claude Code or Codex subscription account with the desktop app installed has "Open desktop app" in its menu, which opens Claude Desktop or the Codex app as that account (see [Desktop apps](usage.md#desktop-apps)). When Grok Bot is installed, a **Grok Bot** group after the accounts lists its windows, each with its own sign-in, and opens another one (see [Grok Bot windows](usage.md#grok-bot-windows)). Each account's menu has "Context tuning", the same estimate as `sideby tune`; its "Use" button writes the suggested size after showing the change, and "Undo" puts the old value back (see [Context tuning](usage.md#context-tuning)). It runs Doctor with one-click fixes, creates accounts (with an optional short command), and can turn on Claude quota after showing the diff. One quota setup covers every Claude Code account, so the "Turn on quota" button sits in the Claude Code group header, not on each account. For a new subscription account it gives you the `sideby login <account>` command to copy; signing in always happens in your terminal.

## Panel app

```sh
sideby app install       # macOS: ~/Applications/sideby.app; Linux: a "sideby" entry in the app menu
sideby app uninstall
sideby ui --background   # what the app runs: start the panel without a terminal, then open it
sideby ui --stop         # stop the background panel
```

Double-click the app to open the panel. It starts the panel in the background when none is running (`sideby ui --background`), reuses it when one is, and opens your browser. The background panel keeps running after you close the tab and logs to `${XDG_STATE_HOME:-~/.local/state}/sideby/panel.log`. Apps started from Finder or a desktop menu get a minimal PATH, so the background panel asks your login shell (`$SHELL -ilc`) for its PATH to find hosts in places like `~/.local/bin`.

The app runs the Node and sideby it was installed with. `sideby update` (and the panel's Update button, and Auto Update) installs the app again from the new version, with its new icon. Run `sideby app install` yourself after upgrading Node or installing sideby another way. If your own page embeds the panel (see below), `sideby app install --url http://accounts.localhost:17333/` makes the app open that address instead; installing again keeps that address. To make the app start the panel again, run `sideby app uninstall`, then `sideby app install`. Install and uninstall only touch files that `sideby app install` created. The app is a local, unsigned launcher script; it is not meant to be copied to other machines.

## Embed the panel

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

`updates` (default `true`) shows the running version and, when there is one, a "new version" label in the panel's header, and the update dialog with **Check for updates**, the **Update** button and the Auto Update switch (see [Updates](configuration.md#updates)). An update started there installs the new package; a page that loads sideby from the installed package, as the author's portal does, picks it up by itself, and the panel says to reload. Pass `updates: false` when your page manages sideby's version: the panel then shows nothing about updates and refuses `/api/update*`.

`<basePath>/icon.svg` serves the sideby mark (the panel uses `<basePath>/favicon.svg`, the small cut with the blue buddy alone, as its favicon). Show it in your own tab or menu instead of keeping a copy, so a new mark reaches your page with the next sideby.

`lang` (`'auto'`, `'en'` or `'zh'`) keeps the panel's language in step with your page. `'en'` or `'zh'` wins over the language picked in the panel and hides the panel's language switch; the choice picked there stays saved and applies again under `'auto'`. `'auto'` (the default) uses the language picked in the panel, then the browser language. Any other value throws a `TypeError` when the handler is created. The handler reads `lang` once: to switch language, create the handler again.
