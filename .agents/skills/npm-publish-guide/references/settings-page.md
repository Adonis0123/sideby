# The npm two-factor settings page

Last verified: 2026-11-24

This page walks through the npm two-factor settings page in plain words, item by item. It also covers the package-level setting to turn on after Trusted Publishing.

## Recommended setup

- Account Second Factor: Passkey only [F-32].
- Account mode: keep "authorization and writes" on (the exact label "Require two-factor authentication for write actions" is not confirmed by npm docs) [F-30], [F-31].
- Package publishing access (after Trusted Publishing): "Require two-factor authentication and disallow tokens" [F-04], [F-26].
- Recovery Codes: download them and save them in a password manager [F-34].

## Account-level settings

### Security Keys (your Passkey)

npm's website calls a Passkey a "security key" [F-32]. You can only set it up on the website, and once added it works for both the website and the command line [F-32].

In our observation, the page still shows an "Add Security Key" button when you already have one key, so you can add a second Passkey as a backup [F-67].

If you only use a Passkey, you do not need an OTP authenticator app. Whenever the command line needs your Second Factor, your Agent gives you one line to paste into your Real Terminal, and you approve in your own browser [F-43], [F-44]. Note that npm may still show "Enter OTP:" in some cases [F-47]; if that happens, see [Troubleshooting](./troubleshooting.md). Never type codes into the Agent chat.

### Recovery Codes

npm gives you recovery codes when you turn on 2FA, and you can view or regenerate them later on the 2FA settings page [F-34]. Download them and keep them in a password manager.

Each recovery code works once [F-34]. Keep them for emergencies only: logging in with a recovery code puts a 72-hour security hold on your account [F-34]. During those 72 hours, you cannot publish packages, create Access Tokens, or change settings, and the hold cannot be lifted early [F-34].

### "Require two-factor authentication for write actions" (exact label not confirmed by npm docs [F-31])

Keep this turned on. No checked npm docs page quotes this exact label; matching it to `auth-and-writes` is not confirmed by docs [F-31].

npm's documentation names two account 2FA modes [F-30]:

- **"authorization and writes" (`auth-and-writes`, default)**: requires a Second Factor for login, profile and token changes, and for publishing, unpublishing, deprecating, and changing package access [F-30].
- **"authorization only" (`auth-only`)**: requires a Second Factor only for login, profile, and token changes [F-30].

## Package-level setting: Publishing access

Each package has its own "Publishing access" setting with two choices [F-26]:

- **"Require two-factor authentication or a granular access token with bypass 2fa enabled"**: this is the default for all new packages [F-26].
- **"Require two-factor authentication and disallow tokens"** (recommended): blocks all Access Tokens from publishing `your-package`, even if a token has Bypass 2FA enabled [F-26], [F-27].

Turn on "Require two-factor authentication and disallow tokens" once [Trusted Publishing](./trusted-publishing.md) is set up. It blocks Access Tokens only; Trusted Publishing keeps working normally [F-04].

You do not need to type the CLI command yourself: if your Agent puts `npx --yes npm@11 access set mfa=publish your-package` in the one line it hands over for your Real Terminal (using `npx` in case your local npm is too old [F-06]), note that npm's docs do not confirm the exact mapping between `mfa=publish` and the web label, though the CLI source sets `publish_requires_tfa=true` and `automation_token_overrides_tfa=false` [F-28], [F-29].

If you're stuck: paste the error into your Agent and say "use npm-publish-guide".

## Sources

- [F-04](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-06](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-26](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-27](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-28](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-29](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-30](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-31](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-32](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-34](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-43](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-44](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-47](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-67](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)

[F-04]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-06]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-26]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-27]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-28]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-29]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-30]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-31]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-32]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-34]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-43]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-44]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-47]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-67]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
