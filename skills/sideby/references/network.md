# Network check: stop Claude and Codex on the wrong network

Network Guard (spec §3.35, ADR-0053) checks the country a Host's requests leave from (its Egress): before sideby starts a Claude or Codex account, and before each prompt and tool call in a session sideby started. When the country is not one the user allows, or cannot be told within 3 seconds, it stops and says what to do. It guards against a proxy that stopped or a node in the wrong country. It does not make use from a region the vendor does not support allowed; say so if the user seems to expect that, and never help hide where they are (time zone, fingerprints).

## See where requests leave from

```sh
sideby network --json         # the setting and the newest result per address, from the cache (no request)
sideby network check --json   # ask every address now
```

Each `targets[]` row is one address sideby asks (`api.anthropic.com` for Claude, `chatgpt.com` for Codex subscription accounts, `api.openai.com` for Codex API accounts) with `status` (`ok`, `blocked`, `unknown`, `not-checked`), `loc` (the country) and the `accounts` checked there. `accounts[].skip` says why an account is not checked: `third-party` (an API account on another endpoint) or `at-launch` (an API account, whose address is known only when it starts).

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

## When something was blocked

A blocked Launch exits 1 with `code` `network-blocked` (wrong country) or `network-unknown` (could not tell). Inside a session the prompt or tool call is stopped with the same reason. Help the user check their proxy (is it running, which node), then run `sideby network check --json` to confirm. To go on once anyway, the user runs `sideby run <account> --ignore-network` (or `sideby next <family> --ignore-network`); never add it yourself without their say-so.
