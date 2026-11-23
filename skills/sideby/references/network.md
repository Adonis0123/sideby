# Network check: stop Claude and Codex on the wrong network

Network Guard (spec §3.35, ADR-0053) checks the country a Host's requests leave from (its Egress): before sideby starts a Claude or Codex account, and before each prompt and tool call in a session sideby started. When the country is not one the user allows, or cannot be told, it stops and says what to do; inside a session it first asks again for up to about 30 seconds. It guards against a proxy that stopped or a node in the wrong country. It does not make use from a region the vendor does not support allowed; say so if the user seems to expect that, and never help hide where they are (time zone, fingerprints).

The reusable proxy, offline diagnosis, system probes, Network page/controller and fixed diagnostic facts live in https://github.com/Adonis0123/network-portal. sideby supplies Guard targets and cached status, and keeps its account model, Guard cache, fail-closed trace and hooks, Runtime, CLI, JSON schemas and Panel security/theme integration. The package does not read accounts, sideby config or the Guard cache.

## See where requests leave from

```sh
sideby network --json         # the setting and the newest result per address, from the cache (no request)
sideby network check --json   # ask every address now
sideby network diagnose --json # offline system/route/listener/cache diagnosis (no trace)
```

Each `targets[]` row is one address sideby asks (`api.anthropic.com` for Claude, `chatgpt.com` for Codex) with `status` (`ok`, `blocked`, `unknown`, `not-checked`), `loc` (the country) and the `accounts` checked there. `accounts[].skip` says why an account is not checked: `api` (API accounts are never checked) or `third-party` (an endpoint set to a third party).

`network diagnose` is read-only and sends no `/cdn-cgi/trace`. In addition to the selected redacted process proxy, loopback listener and cached Guard state, its `system` facts report WARP state and Network health, macOS HTTP/HTTPS/SOCKS, PAC and automatic proxy discovery (`autoDiscoveryEnabled`) switches, the first default resolver's nameservers, and the default route. WARP Connected does not mean all traffic uses WARP. Non-loopback system proxy hosts are `redacted`; PAC URLs, exception names and DNS search domains are omitted. When a valid proxy dictionary provides no known Enable keys, including an empty `<dict>`/`<dictionary>` or one containing only other configuration keys, every known switch is off; provided switches are reported at their parsed values. Empty stdout or malformed output degrades that item to `invalid-output`, as do empty DNS and route results, instead of claiming everything is off or unconfigured. `localProxyCandidates` probes the common Clash/v2rayN ports 7897, 7890 and 10808: these labels do not identify a process, and TCP reachability does not prove the proxy protocol or upstream connectivity. Commands are fixed, offline, bounded and individually degraded; remote proxies are never resolved or connected, and no port is invented for a non-HTTP proxy that omitted one. Credentials, paths, queries and fragments are never returned or cached; the command also skips generic update and Unattended-ended notification side effects. `guardSupport: "unsupported"` means the current Guard cannot use that scheme: it supports HTTP CONNECT only. Tell the user to configure an HTTP proxy (v2rayN commonly exposes one separately from SOCKS) or direct connection; do not add a proxy protocol stack or switch the exit. Run `network check` only when the user wants a fresh online country result.

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

**Diagnose connection** in the same dialog is manual and offline. **Let AI diagnose** starts the separate fixed `network-diagnose` task with only current errors, safe system facts, local proxy candidates, the redacted route, listener results and Guard check times. On the standalone Network page and its routes, the task accepts only facts returned by this server's `/api/network/diagnose`, rejects client-added or replaced facts, and writes the exact server-generated confirmed prompt without generating it again. The Accounts dialog and `sideby ask --task network-diagnose` keep their original entry behavior: the CLI gathers the same facts itself, and neither uses the standalone page's server-side facts snapshot or `confirmedPrompt` contract. The task excludes generic account, health, quota, version and attachment context, removes URL userinfo before preview or task-file writing, and is read-only: explain the facts and next step, never install a skill, change network settings, configuration, code or files, switch the exit, or automatically run an online check. Do not mix it with the `network` settings task.

## When something was blocked

A blocked Launch exits 1 with `code` `network-blocked` (wrong country) or `network-unknown` (could not tell). The block names the selected redacted proxy or `direct`; connection-refused wording is kept. Inside a session the prompt or tool call is stopped with the same reason, and the message says an older session may need restarting to inherit a changed proxy environment. In a Claude session, a message Claude Code made itself (a background task's result) that was stopped is kept and handed to the session once the network is right again, between `<sideby-held-message>` tags; a typed message is not, the user sends it again. Help the user check their proxy (is it running, which node), then run `sideby network check --json` to confirm. To go on once anyway, the user runs `sideby run <account> --ignore-network` (or `sideby next <family> --ignore-network`); never add it yourself without their say-so. When the user wants the check gone, show `sideby network off --json` (exit 10, a preview), then run it with `--yes` once they agree; sessions already running follow config at once, so no restart is needed.
