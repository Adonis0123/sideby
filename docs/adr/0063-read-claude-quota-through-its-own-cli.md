# ADR-0063: Read Claude Code quota through its own CLI

Status: accepted
Date: 2026-10-30

## Context

Claude Code passed its Quota only to the status line command. sideby read it through the status line tap (`quota setup claude`), which has two costs. The user must first let sideby wrap `statusLine.command` in `settings.json`. And the cached numbers change only while a session runs in that Account: an Account nobody used for a day still showed yesterday's Quota, and the menu bar's Refresh could not bring new numbers for Claude Code.

Claude Code's `/usage` command prints the same Quota. Tried with Claude Code 2.1.314 on 2026-10-30: `claude -p /usage --no-session-persistence --output-format json` answers in about 4 s with `num_turns: 0`, `total_cost_usd: 0` and `local_command: "usage"`, and writes no session record. Claude Code handles the command itself with its own sign-in. The answer's text has lines such as `Current session: 16% used · resets Oct 30 at 8:30pm (Asia/Singapore)`, `Current week (all models): …` and `Current week (<model>): …`. The rest of the text describes this computer: request counts, sessions, skills, subagents and MCP servers.

## Decision

Add Claude Code to the Host-query exception of ADR-0025, ADR-0038 and ADR-0048 through `fetchQuota` (`families/claude/quota-fetch.ts`):

- Run `claude -p /usage --no-session-persistence --output-format json --settings '{"disableAllHooks":true}' --strict-mcp-config` with the Account's launch environment (`CLAUDE_CONFIG_DIR` for an Account other than the main one). The extra flags keep it from being a session: the user's hooks do not run and no MCP server starts. It runs in a folder of sideby's own, `<state>/quota/claude-run` (a real folder of the user that nobody else can write to), so Claude Code never starts in one of the user's projects.
- Claude Code signs in; sideby reads no credential and makes no request of its own.
- Same rules as the other Hosts: at most every 15 minutes per Account unless the user refreshes, a 20-second timeout, never from `statusline-tap` or `handoff-hook`, never for an API Account or a signed-out one, off under config `quota.check.claude: false` and in CI. On a timeout or a stop, only this query process is ended, never a running session.
- Read only three kinds of line: `Current session:` is the 5-hour window, `Current week (all models):` the weekly one, and `Current week (<model>)` a weekly window named after that model, which never counts toward Quota Pressure. A window at 0% with no reset time is left out.
- Reset times carry no year (`Oct 30 at 8:30pm (Asia/Singapore)`). sideby takes the next such time in the named time zone that falls within the window's length, with a few minutes of slack.
- Keep only the windows, used percents, reset times and the observation time. Nothing else of the text is kept, logged or returned, and error messages never repeat Claude Code's words. stderr is never read. An answer over 512 KB is not read.
- No partial guess: when any `Current …` line does not parse, the result is a fetch error that says to update sideby. An answer that is not the local command (a model turn, or no `local_command`) says to update Claude Code. A signed-out answer says to run `sideby login <ref>`. An API-key answer says the Account has no subscription Quota.
- The newer of the two sources is shown, by `observedAt` (`shownQuota` in `core/quota-fetch.ts`): the tap cache while a session runs, the `/usage` answer otherwise.

## Consequences

- Claude Code Quota shows without `quota setup claude`, and it no longer goes stale while no session runs. The Panel and menu bar Refresh now work for Claude Code.
- `quota setup claude` is still needed for Auto Handoff. `handoff-hook` reads only the tap cache, which a running session updates every turn.
- While the Panel is open, each signed-in Claude subscription Account starts one short Claude Code process about every 15 minutes.
- Revisit if `/usage` ever starts a model turn or costs anything, or if its text changes shape. sideby then shows the fetch error and keeps the last good reading.
