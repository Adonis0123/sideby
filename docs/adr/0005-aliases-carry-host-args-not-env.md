# ADR 0005: Aliases carry Host arguments, never environment

Date: 2026-10-05 · Status: accepted

## Context

People start one Account several ways: `pi001` for the default model, `pi-kimi` and `pi-glm` for other models. They wrote those as shell functions in their rc file, so sideby could not see them: the Panel showed only `pi001`, and `sideby run pi-kimi` did not exist. The model is a launch choice, not an identity: all three share one login, one Secret File and one session history.

Options considered:

- One Account per model (`pi:kimi`, `pi:glm`). Splits the login and the history, copies the Secret File, and contradicts "the directory is the identity".
- A separate `aliasArgs` map next to `aliases`. Two keys to keep in step for one short command; an agent editing one forgets the other.
- A new Preset concept. It would still be "a name that starts one Account", which is what an Alias is.
- Aliases that also set environment variables. Some entries need them (a Cursor provider for pi unsets and sets `CURSOR_*`), but the config is not a mode 600 file and an `env` field invites keys.

## Decision

- An `aliases` value is either an Account ref (as before) or `{ "account": "<family>:<name>", "args": [...] }`.
- The args apply only to `sideby run <alias>`, after the Account's config `args` and before the user's. Other commands resolve the Alias to its Account and ignore the args.
- `sideby shell-init` makes every Alias function call `sideby run '<alias>'`, so the config stays the one source and an edited Alias needs no new shell.
- Aliases carry no environment. Entries that need it stay in the user's shell or become a `launch.before` plugin.
- `sideby alias add|rm` writes the config, so people and agents do not hand-edit JSON. The config is still written only under `aliases`.

## Consequences

- Readers of the config schema see a union value for `aliases`. Plugin hooks are unaffected: their `ctx.config` holds only their own settings.
- The Panel still shows one row per Account; an Alias with args shows them on hover and matches them in search.
- Existing shell-init files change on the next rewrite (functions call the Alias instead of the ref); behaviour is the same.

## Revisit when

A Host needs per-Alias environment that holds no secret, or people want per-Alias Usage.
