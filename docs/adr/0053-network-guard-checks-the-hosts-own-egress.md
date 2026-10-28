# 0053. Network Guard checks the Host's own Egress, and blocks when it cannot tell

Date: 2026-10-27 · Status: accepted

## Context

Users who are in a region Claude Code and Codex support often reach the vendors through a proxy or a company network. When the proxy stops or a node in the wrong country is picked, requests leave from another country, and the vendor may flag the account. Anthropic's rule is about where the person is ("Use by persons while physically located in an unsupported region", https://www.anthropic.com/legal/supported-regions); OpenAI says use from an unsupported country "may result in the account being blocked or suspended". A check on the Egress can only catch an accident for a user who is in a supported region; it cannot make other use compliant, and sideby says so wherever the feature appears.

sideby makes one request of its own, the Update Check (ADR-0021); quota readers make none (ADR-0003). Knowing the Egress needs a request: no local file says which country a proxy leaves from.

What others do (researched 2026-10-27):

- magpie (github.com/yetone/magpie) is a gateway in the request path. It looks at the Egress only when the user presses a proxy Test button (`cloudflare.com/cdn-cgi/trace`, `ip` and `loc`), and reacts to "location not supported" answers after the request was sent, by trying another member. sideby is not in the request path, and an answer after the fact is too late.
- claude-ip-guard (a Claude Code hook plugin) checks at `SessionStart` and lets the session through when the lookup fails. Claude Code's `SessionStart` cannot block ("the session or subagent proceeds"); `UserPromptSubmit` can ("Blocks the prompt, so it never reaches Claude"), and so can `PreToolUse`. Codex has the same events; `UserPromptSubmit` and `PreToolUse` block with exit 2, and non-managed hooks run only after the user trusts them in `/hooks`. Neither Host has a hook before every model request.
- IP services with datacenter or proxy flags (ipinfo, ip-api, ipapi.is) need a key, have low free limits, or have no HTTPS on the free tier.

Options considered:

- A local plugin per user, or a third-party hook per Host. Rejected: two configurations that disagree, and their default lets a session through when the lookup fails.
- Ask `cloudflare.com/cdn-cgi/trace`. Rejected: proxy tools that route by domain (Clash, Surge) can send it another way than the model requests.
- Watch the network and end sessions when it changes. Rejected: sideby never ends a Host (ADR-0010), and a proxy that switches nodes changes nothing on the machine.
- Ask `/cdn-cgi/trace` on the vendor's own API domain, through the Host's own proxy settings, at Launch and before each prompt and tool call, with a short cache. Chosen.

## Decision

- **Network Guard** (`CONTEXT.md`), off by default, config `network.guard` and `network.allow` (ISO country codes; it cannot be turned on with an empty list). Off, and in CI, it makes no request.
- It asks `https://api.anthropic.com/cdn-cgi/trace` for Claude, `https://chatgpt.com/cdn-cgi/trace` for Codex Subscription Accounts and `https://api.openai.com/cdn-cgi/trace` for Codex API Accounts on the official endpoint. API Accounts on a third-party base URL are not checked. The request goes through the Account's launch environment: the proxy variables the Host reads, with sideby opening the `CONNECT` tunnel through an `http://` proxy itself (Node's own `--use-env-proxy` depends on the Node version); a SOCKS or `https://` proxy counts as "cannot tell". It carries no credential, Account, path or identity, and times out after 3 seconds. Only `loc` is kept, and a SHA-256 hash of `ip` to tell that the address changed.
- **Blocks when it cannot tell.** A timeout, an error or a missing `loc` blocks like a country outside the list: a broken proxy is the usual reason, and letting it through is the risk the feature exists for. `--ignore-network` skips it for one Launch.
- **When.** Before every Launch sideby makes (run, next, Alias, Pick Command, Auto Handoff, AI Task, try, login, and `resume` running the Host unchanged, checked as the Main Account), and in sessions sideby starts through a new `network-hook` entry on `UserPromptSubmit` and `PreToolUse`, injected as Auto Handoff injects its hooks (Claude `--settings`, Codex `-c hooks.*`). The hook runs by absolute path (this Node and this sideby), because a missing or older `sideby` on PATH would fail it and a Host lets a failing hook pass. Nothing is written into a Host directory; sessions started without sideby are not covered, and sideby says so.
- **Speed.** Results are cached for 60 seconds per query URL and proxy setting, and dropped when the machine's network interfaces change. A prompt rechecks a result older than that at once (about 0.2 seconds); a tool call lets one action through while a detached process refreshes a result between 60 seconds and 5 minutes old, and rechecks at once beyond that or after a failed check. `network-hook` imports only leaf modules, like `handoff-hook`, but unlike it, it exits 2 to block.
- An address change is a notice (terminal at Launch, `sideby network`, the Panel), never a block.

## Consequences

- sideby makes a second kind of request of its own, only after the user turns the feature on. The vendor sees no more than the Host's own requests already show.
- A node switch inside a proxy tool is caught within about 60 seconds, not at once; one tool call may pass in that window.
- Codex sessions are covered in-session only after the user trusts the hooks once.
- Grok, pi and Desktop Apps are not covered in v1.
