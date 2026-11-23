# Network check: stop Claude and Codex on the wrong network

Network Guard (spec §3.35, ADR-0053) checks the country a Host's requests leave from (its Egress): before sideby starts a Claude or Codex account, and before each prompt and tool call in a session sideby started. When the country is not one the user allows, or cannot be told, it stops and says what to do; inside a session it first asks again for up to about 30 seconds. It guards against a proxy that stopped or a node in the wrong country. It does not make use from a region the vendor does not support allowed; say so if the user seems to expect that, and never help hide where they are (time zone, fingerprints).

## See where requests leave from

```sh
sideby network --json         # the setting and the newest result per address, from the cache (no request)
sideby network check --json   # ask every address now
sideby network diagnose --json # offline route/listener/cache diagnosis (no trace)
```

Each `targets[]` row is one address sideby asks (`api.anthropic.com` for Claude, `chatgpt.com` for Codex) with `status` (`ok`, `blocked`, `unknown`, `not-checked`), `loc` (the country) and the `accounts` checked there. `accounts[].skip` says why an account is not checked: `api` (API accounts are never checked) or `third-party` (an endpoint set to a third party).

`network diagnose` is read-only and sends no `/cdn-cgi/trace`. It reports the current process's selected proxy reduced to scheme, hostname and port (`direct` when none), a loopback TCP listener result, and the cached Guard state with its own `checkedAt`. It never resolves or connects to a remote proxy, and does not invent a port for a non-HTTP proxy that omitted one. Credentials, paths, queries and fragments are never returned or cached; the command also skips generic update and Unattended-ended notification side effects. This covers direct, HTTP and SOCKS settings from Clash, v2rayN or another proxy app without identifying or controlling the app. A reachable TCP listener does not prove HTTP CONNECT, SOCKS or upstream connectivity. `guardSupport: "unsupported"` means the current Guard cannot use that scheme: it supports HTTP CONNECT only. Tell the user to configure an HTTP proxy (v2rayN commonly exposes one separately from SOCKS) or direct connection; do not add a proxy protocol stack or switch the exit. Run `network check` only when the user wants a fresh online country result.

## Turn it on

Ask the user which countries their requests may leave from. Never choose for them, and never add the current country because it is current: on a wrong network that would allow the wrong country. Then:

```sh
sideby network allow US JP --json   # exit 10 with the change; rerun with --yes after they agree
sideby network on --json            # exit 10; rerun with --yes after they agree
```

`on` is refused while no country is allowed (`network-allow-empty`). `sideby network off --yes --json` turns it off. Codes are two letters (ISO 3166-1 alpha-2): US, JP, SG, GB, DE.

Tell the user, once:
- Only sessions sideby starts are checked (`sideby run`, short commands, `sideby next`, Auto Handoff, AI Tasks). Running `claude` or `codex` directly is not.
- Codex runs the hook only after they trust it once: in that account type `/hooks` and trust `network-hook`. Until then Codex is checked only before starting.
- A Claude session started with its own `--settings` is checked only before starting.
- sideby asks the vendor's own `/cdn-cgi/trace` through the account's proxy settings, with no credential, and keeps only the country and a hash of the address. The Panel has the same switch under **Settings › Network check**.

## As an AI Task

The Panel's **Let AI help** (in the Network check dialog and on the wrong-network banner) starts the `network` AI Task (`sideby ask --task network`). Its prompt carries the switch, the allowed countries and the newest result per address (countries only, never an address). Follow it: run `sideby network check --json`, ask which countries, preview, then `--yes` after they agree.

**Diagnose connection** in the same dialog is manual and offline. **Let AI diagnose** starts the separate fixed `network-diagnose` task with only current errors, the redacted route, listener results and Guard check times; `sideby ask --task network-diagnose` gathers the same facts itself. That task excludes generic account, health, quota, version and attachment context, removes URL userinfo before preview or task-file writing, and is read-only: explain the facts and next step, never install a skill, change network settings, configuration, code or files, switch the exit, or automatically run an online check. Do not mix it with the `network` settings task.

## When something was blocked

A blocked Launch exits 1 with `code` `network-blocked` (wrong country) or `network-unknown` (could not tell). The block names the selected redacted proxy or `direct`; connection-refused wording is kept. Inside a session the prompt or tool call is stopped with the same reason, and the message says an older session may need restarting to inherit a changed proxy environment. In a Claude session, a message Claude Code made itself (a background task's result) that was stopped is kept and handed to the session once the network is right again, between `<sideby-held-message>` tags; a typed message is not, the user sends it again. Help the user check their proxy (is it running, which node), then run `sideby network check --json` to confirm. To go on once anyway, the user runs `sideby run <account> --ignore-network` (or `sideby next <family> --ignore-network`); never add it yourself without their say-so. When the user wants the check gone, show `sideby network off --json` (exit 10, a preview), then run it with `--yes` once they agree; sessions already running follow config at once, so no restart is needed.
