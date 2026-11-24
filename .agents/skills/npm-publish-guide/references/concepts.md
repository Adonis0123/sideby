# Words you will meet

Last verified: 2026-11-24

This page explains the terms you will see when publishing to npm. You do not need to memorize them; come back here when a word looks unfamiliar.

## Second Factor

A Second Factor is the extra proof npm asks for on top of being logged in. On npm, it is either a Passkey or an OTP.

- **Passkey**: Confirmed with Touch ID, a phone, or a hardware key in your browser. npm calls it a "security key" on its website, and you can only set it up on the website [F-32].
- **OTP**: A one-time code from an authenticator app [F-33]. If you only set up a Passkey, you have no OTP to type.

You will see this when logging in, changing account settings, or running a Local Release [F-30].

## Browser Confirmation

Browser Confirmation is the flow where npm prints a link in your terminal [F-37], [F-44]. You open that link in your own logged-in browser and approve with your Passkey.

`npm login` uses Browser Confirmation by default [F-36]. npm does not document how long the link stays valid [F-41]. In one test, it stopped working after about 95 seconds and returned `E404` [F-42].

You will see this when logging in or approving a Local Release in your Real Terminal.

## Login Session

A Login Session is the short-lived credential that `npm login` saves on your computer [F-38]. Later npm commands use it so the registry knows who you are.

The npm changelog says a Login Session lasts two hours [F-38]. An npm staff member wrote on a forum that it was extended to 12 hours, but no official docs page or changelog confirms this [F-39]. (One npm CLI docs page still says `npm login` creates a legacy token, which conflicts with the changelog and looks outdated [F-40].)

You will see this when your computer asks you to log in again after a break.

## Access Token

An Access Token is a long-lived secret that lets a machine act as you. This guide treats it as a last resort.

Only granular Access Tokens exist today; all classic tokens were permanently revoked on 2025-12-09 [F-16], [F-17]. Write Access Tokens are capped at 90 days [F-18]. A 7-day default lifetime was announced in 2025, though no current docs page confirms whether that default still applies [F-19].

A write Access Token can have "Bypass two-factor authentication" turned on, which is off by default [F-20]. Since August 2026, Bypass-2FA tokens can no longer change 2FA, manage tokens, change maintainers, manage orgs or teams, or change Trusted Publishing settings [F-21], [F-22]. npm states that direct publishing with granular Access Tokens will be removed in January 2027 [F-22], [F-23]. Since 2026-09-18, an Access Token can also be "Read and write (stage only)", which allows `npm stage publish` but fails `npm publish` with `E_STAGE_REQUIRED` [F-24].

You will see this when an older setup asks you to paste a secret into CI.

## Trusted Publishing

Trusted Publishing is a link between your package and a CI workflow. It supports GitHub Actions (GitHub-hosted runners), GitLab CI/CD (GitLab.com shared runners), and CircleCI (CircleCI cloud); self-hosted runners are not supported [F-01].

The workflow needs Node.js 22.14.0 or later and npm CLI 11.5.1 or later [F-02]. The package must already exist on npm before you create the link [F-05]. Once linked with direct publishing allowed, the workflow can run `npm publish`, `npm stage publish`, and `npm dist-tag` with no Access Token and no Second Factor [F-10], [F-13].

You will see this when you want GitHub to publish new versions for you.

## Automated Release

An Automated Release is a version published by a CI workflow through Trusted Publishing. You usually trigger it by pushing a version tag.

You will see this on every normal release after Trusted Publishing is set up.

## Staged Release

A Staged Release is a version uploaded with `npm stage publish` that does not go live until you approve it with a Second Factor [F-50]. It became generally available on 2026-05-22 [F-48] and needs npm CLI 11.15.0 or later, Node.js 22.14.0 or later, publish access, and 2FA on your account [F-49].

You can inspect a Staged Release with `npm stage list`, `view`, or `download`, then approve it with `npm stage approve <stage-id>` or on npmjs.com [F-50]. Its dist-tag is fixed when it is staged [F-53]. Staging a brand-new package name publishes a public placeholder version `0.0.0-stage` until you approve it [F-51].

You will see this if a Trusted Publishing link was created without direct publishing allowed [F-10], or if you choose to review releases before they go live.

## Provenance

Provenance is a public record on a package version saying which repository and workflow built it.

npm adds Provenance automatically, with no need to pass `--provenance`, when you publish through Trusted Publishing from a public repository for a public package [F-14]. Private repositories and CircleCI do not get Provenance, even when the package is public [F-14], [F-15].

You will see this recorded on a package version after an Automated Release from a public GitHub repository (in our observation, `npm view` showed `dist.attestations.provenance` [F-68]).

## Real Terminal vs Agent

A **Real Terminal** is a terminal window you type into yourself. An **Agent** is the AI coding tool running commands on your behalf.

When npm needs a Second Factor, it checks whether input and output are connected to a Real Terminal [F-43]. Inside an Agent's command runner, they are not, so npm refuses to prompt and fails with `EOTP` [F-43]. In your Real Terminal, npm usually prints the Browser Confirmation link so you can approve with your Passkey [F-44]; sometimes it asks "Enter OTP:" instead [F-45], [F-47].

The one rule: when npm needs your Second Factor, your Agent gives you one line to paste into your Real Terminal; you approve in your own browser. Never type codes into the Agent chat.

## Other package managers: pnpm, yarn, bun

All three can publish to the npm registry, with differences in how they handle login, Second Factor prompts, and Provenance [F-54], [F-55], [F-56], [F-58], [F-59].

| Tool | Login and credentials | Second Factor on publish | Provenance |
| --- | --- | --- | --- |
| pnpm | Reads npm's `~/.npmrc`, so an npm Login Session works [F-54] | Supports `--otp` (or `PNPM_CONFIG_OTP`) and prints a link with a QR code for Browser Confirmation [F-55] | Added automatically under Trusted Publishing [F-55] |
| yarn (Berry) | `yarn npm login` asks for username, password, and OTP and saves to Yarn's own config; `--web-login` is for login only [F-56]. Yarn v1/v2 used a legacy login endpoint planned for removal [F-57] | `yarn npm publish` documents `--otp`, `--provenance`, and `--staged`; whether it supports Browser Confirmation is not confirmed in Yarn's docs [F-56] | Supports `--provenance` [F-56] |
| bun | Reads `.npmrc` and `bunfig.toml`; respects `NPM_CONFIG_TOKEN` [F-58] | Uses Browser Confirmation by default (`--auth-type web`); also supports `--auth-type legacy` and `--otp` [F-58] | Cannot create Provenance; requesting it causes an error [F-59] |

If you're stuck: paste the error into your Agent and say "use npm-publish-guide".

## Sources

- [F-01](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-02](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-05](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-10](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-13](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-14](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-15](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-16](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-17](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-18](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-19](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-20](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-21](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-22](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-23](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-24](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-30](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-32](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-33](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-36](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-37](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-38](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-39](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-40](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-41](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-42](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-43](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-44](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-45](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-47](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-48](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-49](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-50](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-51](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-53](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-54](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-55](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-56](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-57](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-58](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-59](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-68](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)

[F-01]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-02]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-05]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-10]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-13]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-14]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-15]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-16]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-17]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-18]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-19]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-20]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-21]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-22]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-23]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-24]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-30]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-32]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-33]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-36]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-37]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-38]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-39]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-40]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-41]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-42]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-43]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-44]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-45]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-47]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-48]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-49]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-50]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-51]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-53]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-54]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-55]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-56]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-57]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-58]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-59]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-68]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
