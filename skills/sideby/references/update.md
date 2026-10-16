# Updates and `_notice`

Every `--json` output can carry `_notice` (it comes from sideby's daily Update Check and the installed skill, and reads no network itself):

- `_notice.update`: `{ current, latest, command: "sideby update", message }`, a newer sideby is out.
- `_notice.skill`: `{ installed, current, command, message }`, the sideby skill agents read here is for another version (`installed: null` when it has no version), so it may describe commands this CLI does not have.

What to do:

1. Finish what the user asked first. Do not answer with the notice, and do not stop a task to update.
2. If the notice is still relevant at the end, say it in one line in the user's language, for example "sideby 0.14.0 is out (you have 0.13.0); want me to update it?", and offer to do it. Say it once per conversation, not after every command.
3. When they agree:
   - Run `sideby update --json`. It shows the version, the install method and the command it would run, and exits `10`. Show that to the user; after their yes, run `sideby update --yes --json`.
   - If it exits `1` with `canRun: false` (npx, Volta, a project dependency, a source checkout, a Local Build), sideby cannot update itself: give the user the `command` it printed as one line to run.
   - Then update the skill too when `_notice.skill` was there or the result names `skill`: run `npx skills add Adonis0123/sideby -g` after the user agrees (it changes their skills folder). Tell them that sessions already running keep the old version until they start again.
4. The user can turn notices off with `SIDEBY_NO_UPDATE_NOTIFIER=1` (or config `update.check: false`); set it for one command when a script needs JSON without `_notice`. A Local Build (`pnpm local`) never has one.
