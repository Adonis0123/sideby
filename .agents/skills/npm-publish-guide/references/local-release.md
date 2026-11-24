# Publishing a new version from your computer

Last verified: 2026-11-24

This page explains how a Local Release works when you publish `your-package` from your own computer. It also explains why your Agent cannot run the final publish step in the background.

## When a Local Release is still needed

Use a Local Release when:

- You have not set up Trusted Publishing yet.
- You need an action that Trusted Publishing does not support, such as approving a Staged Release (`npm stage approve`) [F-13], [F-50].
- You need to deprecate, unpublish, or change access on a package while default 2FA ("authorization and writes") is enabled [F-30].

## The one rule

When npm needs your Second Factor, your Agent gives you one line to paste into your Real Terminal; you approve in your own browser [F-43], [F-44]. Never type codes into the Agent chat.

## How it works

1. Tell your Agent to prepare a Local Release with `npm-publish-guide`.
2. Your Agent prepares one line for you.
3. Paste that line into your Real Terminal and press Enter.
4. If your Login Session has expired, `npm login` prints a link to sign in through your browser [F-36], [F-37]. The changelog says a Login Session lasts two hours [F-38]; an npm staff forum comment says it was extended to 12 hours, though no official docs page confirms this [F-39].
5. When `npm publish` asks for your Second Factor, open the printed Browser Confirmation link in your own browser and approve with your Passkey [F-44]. Open it promptly; npm does not publish a timeout, and in one test the link expired after about 95 seconds [F-41], [F-42].

## Why an Agent cannot run `npm publish` in the background

When npm needs a Second Factor, it checks whether both input and output are connected to an interactive terminal (`TTY`) [F-43]. An Agent runs commands without a Real Terminal, so npm does not print a browser link and does not ask for a code [F-43]. Instead, it stops immediately with `EOTP` ("OTP required for authentication") [F-43].

## Why piping output breaks it too

Even in your Real Terminal, sending the output of `npm publish` through a pipe (such as `| tee`) disconnects stdout from the terminal. Because stdout is no longer a terminal (`TTY`), npm hits the same check and fails with `EOTP` instead of showing the Browser Confirmation link [F-43]. In our runs, a handoff script that piped output through `| tee` still failed with `EOTP` in a Real Terminal, and removing the pipe brought back the Browser Confirmation link [F-64]. Run the line your Agent gives you directly, without adding a pipe.

If you want to stop doing Local Releases altogether, set up [Trusted Publishing](./trusted-publishing.md). For unfamiliar terms, see [Words you will meet](./concepts.md).

If you're stuck: paste the error into your Agent and say "use npm-publish-guide".

## Sources

- [F-13](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-30](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-36](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-37](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-38](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-39](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-41](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-42](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-43](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-44](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-50](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-64](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)

[F-13]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-30]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-36]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-37]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-38]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-39]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-41]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-42]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-43]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-44]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-50]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-64]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
