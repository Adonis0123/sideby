# Updates and `_notice`

Every `--json` output can carry `_notice` (it comes from sideby's daily Update Check and the installed skill, and reads no network itself):

- `_notice.update`: `{ current, latest, command: "sideby update", message }`, a newer sideby is out.
- `_notice.skill`: `{ installed, current, command: "sideby update", message }`, the sideby skill agents read here is for another version (`installed: null` when it has no version), so it may describe commands this CLI does not have.

What to do:

1. Finish what the user asked first. Do not answer with the notice, and do not stop a task to update.
2. If the notice is still relevant at the end, say it in one line in the user's language, for example "sideby 0.14.0 is out (you have 0.13.0); want me to update it?", and offer to do it. Say it once per conversation, not after every command.
3. When they agree:
   - Run `sideby update --json`. It shows the version, the install method and the command it would run, and exits `10`. Show that to the user; after their yes, run `sideby update --yes --json`.
   - If it exits `1` with `canRun: false` (npx, Volta, a project dependency, a source checkout, a Local Build), sideby cannot update itself: give the user the `command` it printed as one line to run.
   - The same command updates the installed sideby skill (`skillUpdate` in the plan, `skillUpdated` in the result), so do not run a skill command yourself. With sideby already current and only the skill old (`_notice.skill`), `sideby update` updates the skill alone, after the same preview. To update only the skill and never the CLI, even when a newer sideby is out, run `sideby update --skill --json` (preview, exit `10`), then `--skill --yes --json`. When `skillUpdate.canRun` is false (the skill lives in a git repository the skills tool did not install it into), tell the user `reason` and give them `command`. Tell them that sessions already running keep the old version until they start again.
4. The user can turn notices off with `SIDEBY_NO_UPDATE_NOTIFIER=1` (or config `update.check: false`); set it for one command when a script needs JSON without `_notice`. A Local Build (`pnpm local`) never has one.

## Auto Update

When the user asks to change Auto Update, run `sideby update --auto on|off --json`. It saves immediately and returns `auto` and `changed` (exit 0, including no-op). It keeps the Update Check setting and does not check or install in this invocation. It needs no `--yes`; ordinary `sideby update --json` still previews an installation with exit 10. Never enable Auto Update unless the user asks.

## Local Build and the release

For people who work on sideby itself. A Local Build (`pnpm local` in a sideby checkout) runs the checkout's code behind the global `sideby`. When the user asks to go back to the release, or to the local build again ("切换到正式版", "切回 dev 版本"):

1. Run `sideby local --json`. `running` is what runs now (`local` or `npm`), `local` the kept Local Build (`version`, `commit`, `dirty`, `builtAt`), `kept` the npm version set aside.
2. Run `sideby local off --json` (back to npm) or `sideby local on --json` (the kept Local Build). It exits `10` with the change; after their yes, add `--yes`. `on` does not rebuild: `pnpm local` in the checkout makes a new build. `blocked` (exit 1) says why it cannot and what to do.
3. `off` brings the sideby skill to the npm version too (`skillSynced`; false means run `sideby update`). A background panel restarts by itself and open panels reload; a `sideby ui` in a terminal needs a restart.

