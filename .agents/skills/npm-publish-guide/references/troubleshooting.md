# Troubleshooting by error text

Last verified: 2026-11-24

This page matches common npm publishing errors to what they mean and what to tell your Agent. When in doubt, send your Agent only the error code and the error lines (not the whole terminal output, and never a code, token, or link) and say "use npm-publish-guide".

## The one rule

When npm needs your Second Factor, your Agent gives you one line to paste into your Real Terminal; you approve in your own browser [F-43], [F-44]. Never type codes into the Agent chat.

## `E401 Unauthorized` / `npm whoami` fails

- **What it means**: usually, your computer does not have an active Login Session [F-62].
- **Why**: in our runs, running `npm whoami` or `npm publish` without a Login Session failed with `E401 Unauthorized`, and running `npm login` fixed it [F-62].
- **What to tell your Agent**: "I got `E401 Unauthorized`. Give me one line for my Real Terminal that logs in first using npm-publish-guide."

## `EOTP` / "OTP required for authentication" when an Agent ran it

- **What it means**: npm asked for a Second Factor, and the command was not running in a Real Terminal [F-43].
- **Why**: when input or output is not an interactive terminal (`TTY`), npm cannot open Browser Confirmation and stops immediately with `EOTP` [F-43]. In our runs, a handoff script that piped output through `| tee` still failed with `EOTP` in a Real Terminal; removing the pipe brought back the Browser Confirmation link [F-64].
- **What to tell your Agent**: "Prepare one line for my Real Terminal using npm-publish-guide, with no pipe."

## "This operation requires a one-time password." / "Enter OTP:" in your Real Terminal (Passkey only)

- **What it means**: npm did not receive Browser Confirmation links from the registry, so it fell back to asking for an OTP [F-45].
- **Why**: npm does not document when a Passkey-only Publisher still sees "Enter OTP:" [F-47]. The CLI sends its `auth-type` setting in the `npm-auth-type` request header [F-46]. Likely causes inferred from the CLI code are `auth-type=legacy`, a preset `otp` config value (which forces `legacy`) [F-36], or a registry response without browser links [F-45], [F-47].
- **What to do**: press `Ctrl+C` in your Real Terminal, do not type anything, and tell your Agent. Your Agent checks the `auth-type` setting and prepares a new line for your Real Terminal [F-45], [F-46], [F-47].
- **What to tell your Agent**: "My Real Terminal asked 'Enter OTP:' even though I only use a Passkey. Check my npm `auth-type` setting and prepare a new line for my Real Terminal using npm-publish-guide."

## Browser Confirmation link gave `E404` or opened the npm login page

- **What it means**: the Browser Confirmation link expired, or it opened in a browser not logged in to npm [F-42], [F-65].
- **Why**: npm does not document a timeout for this link [F-41]. In one test, the link stopped working after about 95 seconds and returned `E404` [F-42]. In our runs, opening the link in a browser that was not logged in to npm showed the npm login page instead of the approval page, and the link expired before the Publisher could finish; opening it in the Publisher's own logged-in browser worked [F-65].
- **What to tell your Agent**: "The browser link expired or opened a login page. Give me the one line again so I can open it right away in my logged-in browser."

## `ENEEDAUTH` / "Unable to authenticate" during a GitHub Actions publish

- **What it means**: npm rejected the Trusted Publishing identity from your workflow [F-12].
- **Why**: npm does not check Trusted Publishing settings when you save them, and all fields are case-sensitive [F-12]. Things to check (npm only confirms the workflow file name case [F-12]):
  - Workflow filename, repository name, or environment name does not match the Trusted Publishing link [F-07], [F-12].
  - `repository.url` in `package.json` does not match your GitHub repository exactly, or the workflow is missing `permissions: id-token: write` [F-11].
  - The workflow is running older than Node.js 22.14.0 or npm CLI 11.5.1 [F-02].
  - The Trusted Publishing link was never used within 2 days and expired [F-03].
- **What to tell your Agent**: "GitHub Actions failed with ENEEDAUTH. Check `release.yml`, `package.json` `repository.url`, Node and npm versions, and prepare one line for my Real Terminal to run `npx --yes npm@11 trust list your-package`." [F-06], [F-08]

## GitHub Actions uploaded a Staged Release instead of publishing live

- **What it means**: your Trusted Publishing link allows staging only, not direct `npm publish` [F-10].
- **Why**: Trusted Publishing links created after Sep 03, 2026 allow only staging by default unless `--allow-publish` was set [F-07], [F-10]. Existing links cannot be edited [F-10].
- **What to tell your Agent**: "My Trusted Publishing link only stages releases. Give me the one line to revoke the old link and recreate it with `--allow-publish`." (You can also approve the waiting version with `npm stage approve <stage-id>` or on npmjs.com [F-50].)

## `E_STAGE_REQUIRED` when publishing with an Access Token

- **What it means**: the Access Token is set to "Read and write (stage only)" [F-24].
- **Why**: since 2026-09-18, stage-only Access Tokens can run `npm stage publish`, but `npm publish` fails with `E_STAGE_REQUIRED` even if Bypass 2FA is turned on [F-24].
- **What to tell your Agent**: "Help me switch `your-package` to Trusted Publishing instead of an Access Token."

## GitHub environment rejected the `v*` tag

- **What it means**: the GitHub `npm` environment blocked the tag from running the release workflow.
- **Why**: in our runs, a GitHub environment deployment rule created without `type=tag` was stored as a branch rule, so pushing a `v*` tag could not use the environment; adding the rule with `type=tag` and pattern `v*` worked [F-63].
- **What to tell your Agent**: "My GitHub `npm` environment rejected the `v*` tag. Check the deployment rule and replace any branch rule with a `type=tag` rule for `v*`."

## Package page shows the wrong README language

- **What it means**: npm displayed a non-default README file on your package page.
- **Why**: in our runs, when a package folder had both `README.md` and `README.zh-CN.md`, the npm package page showed the Chinese file; a publish step that told npm to use `README.md` as the readme fixed it [F-66].
- **What to tell your Agent**: "My npm package page shows the wrong README language. Update the publish step so npm uses `README.md`."

## Account is frozen for 72 hours

- **What it means**: npm placed a temporary 72-hour security hold on your account [F-34].
- **Why**: logging in with a recovery code triggers a 72-hour hold that blocks publishing, token creation, and settings changes [F-34]. The hold cannot be lifted early [F-34].
- **What to tell your Agent**: "My npm account is in a 72-hour recovery hold. Remind me when it ends so we can resume."

If you're stuck: send your Agent only the error code and the error lines (not the whole terminal output, and never a code, token, or link) and say "use npm-publish-guide".

## Sources

- [F-02](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-03](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-06](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-07](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-08](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-10](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-11](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-12](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-24](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-34](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-36](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-41](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-42](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-43](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-44](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-45](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-46](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-47](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-50](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-62](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-63](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-64](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-65](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-66](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)

[F-02]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-03]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-06]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-07]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-08]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-10]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-11]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-12]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-24]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-34]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-36]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-41]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-42]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-43]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-44]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-45]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-46]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-47]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-50]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-62]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-63]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-64]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-65]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-66]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
