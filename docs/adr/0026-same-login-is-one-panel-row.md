# 0026. A Same Login is one row in the Panel

Date: 2026-10-17 · Status: accepted · Replaces the Panel bullet of ADR-0016

## Context

ADR-0016 kept one Panel row per Account of a Same Login: the first row showed the Quota, every other row said "shares quota with main", and a rail on the left tied the rows together. A user with two directories signed in to one login reported that this reads as two accounts. Three independent design reviews (Codex, Grok Build and Claude Code, each given the same brief without the others' answers, 2026-10-17) all recommended one row, with the same reasons:

- One Quota drawn on two rows suggests two Quotas.
- "Shares quota with main" points up by position, so it breaks when the sort changes, and a beginner has to read and decode it.
- Products that link several records of one identity show one entry and list the sources inside it (Apple Contacts linked cards, Gmail "Send mail as", Google account devices).

Options:

- Keep one row per directory (ADR-0016). Rejected for the reasons above.
- A parent row with indented child rows, always visible. Rejected: still two rows in the collapsed list.
- A badge with a popover listing the directories. Rejected: the second directory and its short command are hidden behind a hover, which a beginner does not find and touch screens do not have.
- One row, the directories inside its expanded view. Chosen.

## Decision

- In the list view, the members of a Same Login that are shown together become one row: the name and short commands of the first member, a "2 directories · shared quota" label, the email, browser sign-in and Quota once, and the newest "last used".
- Expanding the row lists each directory with its own short command, last use, a "Copy start command" button and its own menu.
- The row's menu has Pin first, then one section per directory, then the actions the login shares. (Revised 2026-10-20: the menu is the single-account menu of the directory the row is named after, so each action appears once; a last group lists every other directory as one item that opens its own actions in the same menu, with Back.)
- The "Next" tag, Quota warnings and the attention count appear once, on the row.
- Card view and a filter that leaves one member keep one entry per directory, as before.

Nothing else of ADR-0016 changes: how a Same Login is recognized, the shared Quota reading and the Handoff rules stay.

## Consequences

- The list is shorter and the Quota appears once per login.
- Opening one directory takes one click more (expand, then copy its command). The row's menu reaches each directory's actions without expanding.
- Panel only: `sideby list` keeps one line per Account, and every `--json` output is unchanged.

## Revisit when

Users need to compare two directories of one login side by side often, for example when Usage per directory matters more than the shared Quota.
