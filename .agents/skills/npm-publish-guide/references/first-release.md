# Publishing a brand-new package

Last verified: 2026-11-24

This page walks through publishing the very first version of `your-package` to npm. You only need to do this once per package.

## Why the first version comes from your computer

Trusted Publishing can only be attached to a package that already exists on the npm registry [F-05]. That means your First Release must be a Local Release from your own computer.

## The one rule

When npm needs your Second Factor, your Agent gives you one line to paste into your Real Terminal; you approve in your own browser [F-43], [F-44]. Never type codes into the Agent chat.

## What happens step by step

1. **Tell your Agent**: say "Publish this project to npm using npm-publish-guide."
2. **Your Agent checks the package**: it checks that the package name is available and inspects which files will be included.
3. **Your Agent prepares one line**: it prepares a command for your Real Terminal and copies or prints that one line for you.
4. **Paste the line in your Real Terminal**: open your own terminal window, paste the line, and press Enter.
5. **Log in if asked**: if you have no active Login Session, `npm login` prints "Authenticate your account at:" with a link [F-36], [F-37], [F-38]. Press Enter to open your browser and sign in.
6. **Approve your Second Factor in your browser**: when `npm publish` asks for your Second Factor, it usually prints a Browser Confirmation link [F-44]; sometimes it asks "Enter OTP:" instead [F-45], [F-47] (if you only use a Passkey, see [Troubleshooting](./troubleshooting.md)). Open the link in your own browser right away and approve with your Passkey. npm does not document how long this link lasts; in one test, it expired after about 95 seconds [F-41], [F-42].

If a term here is unfamiliar, see [Words you will meet](./concepts.md).

## What you may see right after

When a brand-new package is staged, npm publishes a public placeholder version `0.0.0-stage` until the staged version is approved [F-51]. npm does not document seeing this during a normal publish, though in one observed First Release of a new package, a `0.0.0-stage` version appeared briefly for about 3 minutes [F-52].

## Next step

Now that `your-package` exists on npm, set up [Trusted Publishing](./trusted-publishing.md) so GitHub publishes future versions for you with no more prompts.

If you're stuck: paste the error into your Agent and say "use npm-publish-guide".

## Sources

- [F-05](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-36](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-37](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-38](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-41](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-42](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-43](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-44](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-45](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-47](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-51](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-52](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)

[F-05]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-36]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-37]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-38]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-41]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-42]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-43]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-44]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-45]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-47]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-51]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-52]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
