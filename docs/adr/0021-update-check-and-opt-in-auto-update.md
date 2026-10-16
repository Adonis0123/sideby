# 0021. sideby checks for updates once a day, and updates itself only when asked

Date: 2026-10-16 · Status: accepted

## Context

sideby makes no network request of its own (ADR-0003 "Built-in quota and usage readers make no network requests"). Users learn about a new version only by watching the repository. The Panel mounted in a Portal kept showing the old logo for days after 0.11.0 because nothing told anyone to update.

How other npm-distributed CLIs handle it (researched 2026-10-16):

- `update-notifier`, npm and `gh` check at most once a day, in the background, and print one line on stderr after the command. They stay quiet in CI, without a TTY, and when `NO_UPDATE_NOTIFIER` (npm, update-notifier) or a tool's own variable (`GH_NO_UPDATE_NOTIFIER`) is set.
- Claude Code's native build updates itself in the background and applies the update at the next start; its docs warn that an in-place `npm install -g` replaces files a running session still loads. Package-manager installs only get the command to run. `vercel upgrade` detects the package manager and refuses when it cannot.
- VS Code and Grafana show "update available" in the UI and apply nothing without a click.

Options considered:

- Never check; document `npm i -g sideby@latest`. Rejected: users who never read the changelog keep old fixes and old pages.
- Check, and update by default. Rejected: sideby only changes the machine after the user confirms (ADR-0001, Auto Handoff is opt-in in ADR-0010), and a 0.x minor can change behaviour.
- Check by default (off with one variable or one config key), update only after a confirmation, and offer Auto Update as an opt-in. Chosen.

## Decision

- **Update Check** (`CONTEXT.md`). At most once every 24 hours sideby sends one `GET` to `<registry>/-/package/sideby/dist-tags` (default `https://registry.npmjs.org`, `SIDEBY_UPDATE_REGISTRY` overrides it, for a mirror). The request carries no Account, path, identity or machine data; the answer is the `latest` version. The result is kept in `$XDG_STATE_HOME/sideby/update.json`, shared by the CLI and every Panel. A failed request is silent; the next attempt waits at least an hour (`triedAt`), so being offline costs one request an hour.
- It is off when `NO_UPDATE_NOTIFIER` or `SIDEBY_NO_UPDATE_NOTIFIER` is set, when config `update.check` is `false`, and in CI (`CI`, `CONTINUOUS_INTEGRATION`, `BUILD_NUMBER`). Off means no request and no notice; `sideby update` still asks the registry when the user runs it.
- **Update Notice**. The CLI prints one line on stderr after a command, at most once a day per new version, only when stderr is a terminal, never with `--json`, and never from `statusline-tap`, `handoff-hook`, `shell-init` or the internal commands. While a Host runs (`run`, `next`, `resume`) it waits until the Host exits. When the cached check is older than 24 hours, the CLI starts the next check as a detached process and does not wait for it, so a notice shows on a later run. A Panel checks in its own process when its state is read and the cache is old, and shows a "new version" label in its header only when there is one.
- **Install Method** decides what an **Update** does. A global npm (`…/lib/node_modules/sideby`), pnpm or bun install runs `npm install -g --prefix <prefix> sideby@<v>`, `pnpm add -g sideby@<v>` or `bun add -g sideby@<v>`. The npx cache, a Volta install, a project dependency, a source checkout and anything else only get the command to run themselves. With `SIDEBY_UPDATE_REGISTRY` the install uses the same registry. One Update runs at a time on the machine (a pid lock shared by the CLI, the Panel and Auto Update). The Panel's button sends the version the dialog showed and installs only that one. `sideby update` shows the command and runs it with `--yes` (exit 10 without it, as for every change sideby shows first). The Panel's button is the same plan and the same confirmation.
- **Auto Update** (config `update.auto`, off by default; the Panel's advanced settings switch it). After an Update Check finds a newer version, the background check installs it only when all of these hold: the Install Method can update itself, no `sideby run`, `next` or `resume` is running (each records its pid under `$XDG_STATE_HOME/sideby/running/` while it runs), and the new version keeps the major version (`0.11` → `0.12` is fine, `0.x` → `1.0` and `1.x` → `2.0` only get a notice). The next command prints that it updated, once.
- After an Update: a background Panel (`ui --background`) is started again from the new code, and open pages reload themselves when they see the new build (they already did for a reinstall). A foreground `sideby ui` is told to restart. A Portal loads the new code by itself (it watches the package); the Panel says to reload the page. Sessions that are running keep the old version until they start again; `statusline-tap` and `handoff-hook` run the new code on their next call. The installed sideby skill is not updated: the notice names `npx skills add Adonis0123/sideby -g`, and Doctor keeps reporting `skill.outdated` until it is run.
- `createPanelHandler` gains `updates?: boolean` (default `true`); `false` hides the update label, the button and the setting, for a Portal that manages updates itself. The Panel also serves its mark at `<basePath>/icon.svg` (and the small cut at `<basePath>/favicon.svg`, its own favicon), so a Portal can show the current logo without a copy of its own (ADR-0006 amendment).

## Consequences

- sideby now makes one network request a day by itself. ADR-0003's rule stays for Quota and Usage: their readers still make no request, and the Update Check reads nothing of a Host.
- First notice comes on the day after installing, like `update-notifier`.
- The pid files under `running/` are sideby's own state; a pid that no longer runs is ignored and removed.
- A mirror without the `dist-tags` endpoint makes every check fail silently; `sideby update` then says so and names the command.
