---
name: npm-publish-guide
description: Publish an npm package for someone who cannot write code, without getting stuck on two-factor prompts. Checks the package, sets up GitHub Trusted Publishing so releases become a pushed tag, and hands every passkey or one-time-password step to the Publisher's own terminal as one pasted line. Use when the user wants to publish, release, deprecate or dist-tag a package on npm, or when npm publish or npm login fails with EOTP, E401, ENEEDAUTH, "Enter OTP" or a stuck 2FA/passkey confirmation; also for npm trusted publishing, npm tokens for publishing, and the npm two-factor settings page. Chinese - 发 npm 包, 发布到 npm, npm 发版, npm 发布两步验证卡住, npm 发布要验证码, 自动发布 npm, npm 受信发布, npm 设置页看不懂. Not for npm install or dependency errors, TypeScript errors, or registries other than npmjs.org.
---

# npm Publish Guide

You are the Agent. The Publisher owns the npm account and cannot write code. You do the file and Git work; the Publisher approves anything that needs a Second Factor, in their own Real Terminal and browser. Terms: [concepts.md](references/concepts.md). `F-xx` cites the guide's `docs/facts.md`.

Stay in the package folder. Call scripts by full path (`sh <skill-dir>/scripts/diagnose.sh`); `scripts/` and `templates/` below mean this skill's folders.

## Hard rules

1. **Never run a command that needs a Second Factor yourself**, with any package manager: `npm|pnpm|yarn|bun` login, `npm adduser`, a local publish (`npm publish`, `pnpm publish`, `yarn npm publish`, `bun publish`), `npm unpublish`, `npm deprecate`, `npm access set`, `npm trust`, `npm stage approve|reject`, `npm token create`, `npm profile set|enable-2fa` (F-30, F-08, F-13). Without a terminal npm fails with `EOTP` (F-43). A pseudo-terminal in your tool is still not the Publisher's Real Terminal; no `script`, `expect` or background-job workarounds.
2. **Never open an npm login or approval link** ("Authenticate your account at", "Login at:", any npmjs.com `/auth` or `/login` URL) in a browser you control, whoever printed it. Before a handoff, ask the Publisher to be logged in to npmjs.com in their own browser (F-65).
3. **Never ask for secrets or whole terminal output.** No one-time codes, tokens or links in chat. Ask only for the error code and the `npm error` lines. If `Enter OTP:` appears in the Publisher's terminal, they type it there.
4. **Hand over with `scripts/handoff.sh`, never with a pipe** (`| tee`, `| cat`): npm loses the terminal and fails with `EOTP` (F-43, F-64).
5. **Diagnosis is not permission.** Before any handoff or tag push, list package name, version, visibility (public or restricted), registry, and every extra setting change, and get a yes. On any path that ends in a publish, run the `npm pack --dry-run --ignore-scripts` preview first, so one yes covers everything. Propose `package.json` edits in that same list; make them only after the yes.
6. **Never run a project script you have not read.** Before `build`, `npm version` or a release script, read it and its hooks (`pre*`/`post*`, `prepack`, `prepublishOnly`, `version`); never run one that publishes. Preview files with `npm pack --dry-run --ignore-scripts`.
7. **No Access Tokens** unless the Publisher insists after hearing why: write tokens last at most 90 days (F-18) and token publishing ends in January 2027 (F-23).

## Talking to the Publisher

- Reply in the Publisher's language. One action per message: which window (Terminal app, browser), what to paste or click, what they will see, what to tell you after.
- The rule-5 confirmation asks only for yes or no. Put "log in to npmjs.com in your own browser" as the first line of the handoff message, never in the confirmation.
- No jargon without a plain explanation; translate errors into one plain sentence first.
- Handoff message: "Open the Terminal app (not this chat). Paste the line [I copied for you / below] and press Return. If you see 'Authenticate your account at', press Return and approve with your Passkey in your browser. When it says 'All steps finished', tell me 'done'." If `clipboard:` says no, show `run_line` in a code block and say "copy this line".

## Step 1: what does the Publisher want?

| Intent | Do only this |
|---|---|
| Explain something (a word, an error, the settings page) | Answer from [concepts.md](references/concepts.md) or [settings-page.md](references/settings-page.md). Change nothing. |
| Troubleshoot an error | Diagnose, then [troubleshooting.md](references/troubleshooting.md). Fix only what the error needs: get the original command through via a handoff. `next:` is background here; suggest Trusted Publishing only after this release succeeded. |
| Set up automatic releases | Diagnose, then "Set up Trusted Publishing". |
| Release a version | Diagnose, then follow `next:`. |
| Package maintenance (`deprecate`, `dist-tag`, `stage approve`) | "Package maintenance". Never route into a version bump or publish. |

## Step 2: diagnose

Run `sh <skill-dir>/scripts/diagnose.sh`. It only reads, runs no project scripts and writes no debug log (F-70). Act on `next:`; after `next: login`, put the login step first in the handoff for the section named by `after_login:`.

| `next:` | Do |
|---|---|
| `install-node` / `no-package-json` / `fix-package-json` | Help install Node.js LTS, find the package folder, or fix `name`/`version` |
| `check-registry` | Publish target is not registry.npmjs.org; ask, this skill covers npmjs.org only |
| `private-package` | `"private": true`; ask whether it should be public |
| `confirm-visibility` | Scoped name gave `E404`: free, or a private package this login cannot see. Ask the Publisher |
| `first-release` | First Release |
| `setup-trusted-publishing` / `finish-trusted-publishing` | Set up Trusted Publishing (finish: workflow exists, but no version came from it yet) |
| `release-by-tag` | Everyday release |
| `local-release` | Not on GitHub: [local-release.md](references/local-release.md) |
| `troubleshoot` | Registry lookup failed: [troubleshooting.md](references/troubleshooting.md) |

## Handing a command to the Publisher

```sh
sh <skill-dir>/scripts/handoff.sh -n "Plain sentence" 'command one' -n "Plain sentence" 'command two'
```

It writes a script and log into a private temp folder, copies `sh <file>` to the clipboard, and prints `run_line`, `log`, `runs_in` (must be the package folder) and `remote_fallback`. If you run on another machine than the Publisher, give them `remote_fallback` (the same steps as one line) instead. Start any step that needs npm credentials with `npm whoami >/dev/null 2>&1 || npm login`; Login Sessions are short (F-38, F-39) and `npm login` uses Browser Confirmation (F-36, F-37).

After "done", read the log: `step N exit 0` for each step and `finished` means success; confirm with a read-only command. If a step failed, the earlier ones already happened: fix the cause, then hand over a new line that starts at the failed step. Never repeat a step that succeeded, such as `npm trust github`.

## First Release

Trusted Publishing needs an existing package (F-05), so version one is a Local Release ([first-release.md](references/first-release.md)).

1. Check `package.json` (`name`, `version`, `description`, `license`, `repository`, `files`/`exports`). Read, then run, the build script if there is one.
2. `npm pack --dry-run --ignore-scripts`: no secrets (`.env`, keys, `.npmrc`), no agent folders (`.claude/`, `.agents/`, `.codex/`, `.cursor/`), nothing unneeded. If anything like that shows up and there is no `files` field, propose one. Tell the Publisher in one sentence what will be published and get the yes from rule 5.
3. Handoff: `npm whoami >/dev/null 2>&1 || npm login`, then `npm publish --access public`.
4. `npm view <pkg> version`. A `0.0.0-stage` placeholder is how npm shows a new name while processing (F-51; one run saw it for about 3 minutes, F-52): wait, do not publish again.
5. On GitHub? Offer "Set up Trusted Publishing".

## Set up Trusted Publishing

Afterwards a release is a pushed tag: no stored token (F-04) and no Second Factor when the link allows direct publishing (F-10). Needs GitHub-hosted runners (F-01); Provenance only for a public repository and package (F-14, F-15). Background: [trusted-publishing.md](references/trusted-publishing.md).

**Order:** a new link expires without a successful publish within 2 days (F-03). Push all repository work first, hand over the link last, push the first tag right after "done".

**Settings:** `<workflow>` and `<env>` below come from `publish.workflow` and `publish.environment` in `.agents/release.json` (nearest file from the package folder up to the Git root; a `packages[]` entry whose `dir` is this folder overrides the top level). Without the file, use `release.yml` and `npm`; you may offer to save them there (`{"version": 1, "publish": {"workflow": …, "environment": …}}`) after showing the content and getting a yes.

What you do (tell the Publisher the plan and get a yes first):

1. Copy `templates/release.yml` to `.github/workflows/<workflow>` at the Git root (`package_dir_in_repo` not `.`: set its `working-directory` lines; `<env>` not `npm`: set its `environment:` line). Edit only `PACKAGE MANAGER` lines; pnpm needs `packageManager` in `package.json`. Never rename the file later (F-12).
2. Set `"repository": { "type": "git", "url": "git+https://github.com/<owner>/<repo>.git" }` matching GitHub exactly, case included (F-11, F-12); add `"directory"` for a subfolder package.
3. Create the environment `<env>` for `v*` tags only (needs `gh auth status` and admin rights):

   ```sh
   printf '%s' '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' | gh api -X PUT repos/<owner>/<repo>/environments/<env> --input -
   gh api -X POST repos/<owner>/<repo>/environments/<env>/deployment-branch-policies -f name='v*' -f type=tag
   gh api repos/<owner>/<repo>/environments/<env>/deployment-branch-policies --jq '.branch_policies[] | "\(.name) \(.type)"'
   ```

   Expect `v* tag`; without `type=tag` it was stored as a branch rule and tags were rejected (F-63, observed).
4. Commit and push to the default branch by name: `git push origin <branch>`.

What the Publisher does (one handoff):

```sh
sh <skill-dir>/scripts/handoff.sh \
  -n "Log in to npm if needed." 'npm whoami >/dev/null 2>&1 || npm login' \
  -n "Let GitHub publish this package." 'npx --yes npm@11 trust github <pkg> --file <workflow> --repo <owner>/<repo> --env <env> --allow-publish --yes' \
  -n "Stop Access Tokens from publishing this package." 'npx --yes npm@11 access set mfa=publish <pkg>' \
  -n "Show the new link." 'npx --yes npm@11 trust list <pkg>'
```

- Use `--allow-publish`, not `--allow-stage-publish`. One `--allow-*` flag is required (F-07); a staging-only link makes every version a Staged Release (F-10).
- `npm trust` needs npm 11.15.0+ (F-06); `npx --yes npm@11` ran 11.21.3 when checked (F-69).
- The first request asks for a Second Factor; the page offers to skip 2FA for follow-ups for 5 minutes (F-08). They may still be asked more than once.
- `mfa=publish` sends `publish_requires_tfa=true, automation_token_overrides_tfa=false` (F-28); its match with the web choice "Require two-factor authentication and disallow tokens" is unconfirmed (F-29). Mention this change in the rule-5 list.

Then push the first tag as in "Everyday release". If a link exists but never published (`finish-trusted-publishing`), ask the Publisher; if unsure, hand over `npx --yes npm@11 trust list <pkg>` and ask what it shows. An expired link must be deleted and recreated (F-03, F-08).

## Everyday release

No Second Factor is needed once Trusted Publishing works (F-10).

1. Get one confirmed exact version (the planned version). If npm-version-guide handed over a package name, exact version, release type and local state, use them; do not pick again. Otherwise, if `<skill-dir>/../npm-version-guide/SKILL.md` exists, read it and follow its steps 2 to 4; without it, patch for fixes, minor for features, work out the exact version and get a yes. A requested beta stays a Pre-release. Check: default branch, `git status --porcelain` empty, not behind after `git fetch`.
2. **The repository's own release command comes first.** Look for one: a `release` script in `package.json`, or in the root `package.json` of a monorepo (npm-version-guide's script prints both as `release_script:`), or a release command named in the repository's `AGENTS.md`, `CLAUDE.md` or `CONTRIBUTING.md`. Read it and everything it calls (rule 6). Use it instead of steps 3 and 4 only when all of these hold:
   - It does not publish from this machine (rule 1). Pushing a tag or a branch is fine.
   - The planned version is not set yet (`package.json` and tag); otherwise it would bump a second time.
   - It makes exactly the planned version: it takes that version, or it takes a level such as `patch` and that level applied to the current version gives the planned version (F-85). Run it the way the repository's docs name it, with its own package manager; for an npm script the argument goes after the name, e.g. `npm run release -- patch` (F-120).
   - If it pushes with `--follow-tags`, no other local tag is missing from the remote (`git ls-remote --tags origin`).

   Say it in the one confirmation: "I will release with your repository's own command `npm run release -- patch`." Run it once, then continue at step 5. If a condition fails (for example a Pre-release or an exact version it cannot take, or a local publish), use steps 3 and 4 and say why in that same confirmation. If it stops partway, check what it already did (`git log`, `git tag`, the remote) before anything else; never rerun it blindly.
3. If `package.json` already has the planned version and `git tag -l v<version>` shows its tag, skip this step. Otherwise read the `version` hooks (rule 6), then `npm version <planned version> -m "<format>"` (F-85). `<format>` follows the repository's earlier release commits: `release_commit_format:` from npm-version-guide's script, or the subject of `git log -1 --format=%s <last release tag>` with its version replaced by `%s` (F-119); `chore(release): v%s` when there is none. Confirm the tag exists; in a subfolder package create the commit and tag yourself if it did not.
4. Before pushing, check that `node -p "require('./package.json').version"` and the tag both equal the planned version; if not, stop and tell the Publisher. Push only that commit and tag: `git push origin <branch>` and `git push origin refs/tags/v<version>`. Never `--follow-tags`: it also pushes other local tags.
5. Find this run: `gh run list --workflow <workflow> --branch v<version> --json databaseId,headSha,status`; match `headSha` to `git rev-parse v<version>^{commit}`, then `gh run watch <id> --exit-status`.
6. Rerun diagnose: `local_version_on_npm` yes, `latest_published_by: trusted-publishing (github)`, Provenance yes for public repositories (F-68, observed).
7. On failure (`gh run view <id> --log-failed`): a wrong workflow file name shows as `ENEEDAUTH` (F-12); also check environment name, owner/repo, `repository.url`. Fix it and release the next patch; never move a pushed tag. Pre-release versions publish under `next` (F-53).

## Package maintenance

For `npm deprecate`, `npm dist-tag add|rm` or `npm stage approve <id>`: hand over exactly the command the Publisher asked for, with the package and version spelled out, after the rule-5 yes. No version bump, no publish.

## Errors

Full table: [troubleshooting.md](references/troubleshooting.md).

- `E401` or `npm whoami` fails: no Login Session (F-62, observed); hand over the login step.
- `EOTP` in your shell: you ran a Second-Factor command. Hand it over instead.
- `Enter OTP:` for a Passkey-only Publisher: cause undocumented (F-47). They press Ctrl+C; check `auth_type` and `otp_config` in diagnose, then hand over again.
- `E404` after opening the browser link: likely expired (one run saw about 95 seconds, F-42) or opened in a browser not logged in to npm (F-65). Hand over again and approve right away.
- `E_STAGE_REQUIRED`: a stage-only Access Token tried `npm publish` (F-24).
