# Let GitHub publish for you (Trusted Publishing)

Last verified: 2026-11-24

This page explains how to link `your-package` to GitHub Actions so future versions publish with no Access Token and no Second Factor prompts.

## What Trusted Publishing is

Trusted Publishing creates a link between your package on npm and a CI workflow. It works with GitHub Actions on GitHub-hosted runners, GitLab CI/CD on GitLab.com shared runners, and CircleCI cloud; self-hosted runners are not supported [F-01]. Once linked with direct publishing allowed, the workflow can run `npm publish`, `npm stage publish`, and `npm dist-tag` without any Access Token or Second Factor [F-10], [F-13].

## Before you start

- `your-package` must already exist on npm. If it is brand new, finish [Publishing a brand-new package](./first-release.md) first [F-05].
- `npm trust` needs npm CLI 11.15.0 or later, write access to the package and 2FA enabled on your account [F-06]. You do not need to upgrade npm yourself: the line your Agent gives you runs `npx --yes npm@11`, which fetches a new enough npm [F-69].
- Your GitHub workflow needs Node.js 22.14.0 or later and npm CLI 11.5.1 or later [F-02].

## One-time setup: Agent vs Publisher

### What your Agent does

- Adds the `release.yml` workflow from the skill template, including `permissions: id-token: write` [F-11] and the required Node.js and npm versions [F-02].
- Creates the GitHub `npm` environment limited to `v*` tags. In our runs, creating that rule without `type=tag` stored it as a branch rule, which blocked `v*` tags; adding the rule with `type=tag` and pattern `v*` worked [F-63].
- Checks that `repository.url` in `package.json` matches your GitHub repository exactly [F-11].
- When you release, uses your repository's own release command if it has one (after reading it); otherwise bumps the version with `npm version` and pushes only that version's tag.
- Prepares one line for your Real Terminal.

### What you do in your Real Terminal

When npm needs your Second Factor, your Agent gives you one line to paste into your Real Terminal; you approve in your own browser [F-43], [F-44]. Never type codes into the Agent chat.

1. Paste the one line your Agent hands over into your Real Terminal (you do not type this yourself). It uses `npx --yes npm@11` in case your local npm is too old [F-06], and runs `npm trust github` with `--file`, `--repo`, optional `--env`, and `--allow-publish` [F-07]:

   ```sh
   npx --yes npm@11 trust github your-package --file release.yml --repo <owner>/<repo> --env npm --allow-publish --yes
   ```

2. Approve the Browser Confirmation prompt with your Passkey [F-08], [F-44]. The browser page offers to skip 2FA for the next 5 minutes for follow-up commands [F-08].
3. Lock down package publishing access so Access Tokens cannot publish `your-package`. On npmjs.com, pick "Require two-factor authentication and disallow tokens"; Trusted Publishing keeps working [F-04], [F-26], [F-27]. Your Agent may also put `npx --yes npm@11 access set mfa=publish your-package` in the one line it hands over; this likely matches that setting, though npm does not confirm the exact mapping between CLI values and web labels [F-28], [F-29].

### Important details to watch

- **Direct publishing must be allowed**: links created after Sep 03, 2026 allow only staging by default [F-10]. Always include `--allow-publish` when creating the link, or every release will become a Staged Release instead of going live [F-07], [F-10]. Existing links cannot be edited; to fix a mistake, delete the link with `npm trust revoke` and create a new one [F-08], [F-10].
- **Use the link within 2 days**: a newly created Trusted Publishing link must complete its first successful publish within 2 days, or it expires and must be deleted and recreated [F-03].
- **Case sensitivity**: npm does not check your settings when you save them; every field is case-sensitive, and a wrong workflow file name shows up only at publish time as `ENEEDAUTH` [F-12].
- **How many links per package**: two npm pages conflict on this. One says one link per package, and another says up to 10; which limit applies today is not confirmed [F-09].

## Everyday releases afterwards

Ask your Agent to release a new version (for example, "release a patch"). Your Agent bumps the version and pushes a version tag, and GitHub Actions publishes `your-package` as an Automated Release. If your repository already has its own release command (for example a `release` script in `package.json`), your Agent reads it and uses it when it makes the version you agreed to and does not publish from your computer; it tells you which command it will use before it starts.

## How to check it worked

- Open `your-package` on npmjs.com and confirm the new version is live. In our run the workflow took about half a minute, and npm showed the new version about two and a half minutes later; a short wait is normal [F-72].
- If your GitHub repository and package are both public, npm adds Provenance automatically without `--provenance` [F-14]. Private repositories do not get Provenance even for public packages [F-15].
- Do not use `npm whoami` to test Trusted Publishing; it does not use Trusted Publishing [F-13]. To check existing links, ask your Agent to put `npx --yes npm@11 trust list your-package` in one line for your Real Terminal [F-06], [F-08].

For unfamiliar terms, see [Words you will meet](./concepts.md).

If you're stuck: paste the error into your Agent and say "use npm-publish-guide".

## Sources

- [F-01](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-02](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-03](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-04](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-05](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-06](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-07](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-08](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-09](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-10](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-11](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-12](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-13](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-14](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-15](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-26](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-27](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-28](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-29](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-43](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-44](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-63](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-69](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-72](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)

[F-01]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-02]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-03]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-04]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-05]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-06]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-07]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-08]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-09]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-10]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-11]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-12]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-13]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-14]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-15]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-26]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-27]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-28]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-29]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-43]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-44]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-63]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-69]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-72]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
