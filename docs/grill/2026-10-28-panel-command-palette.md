# Grill: Panel Command Palette (2026-10-28)

Request: a Panel search that finds anything, settings included, following how others do it.
Pairing: Interviewer claude (this session), Proxy codex, red-team grok. 3 rounds, frontier empty, no Escalations.

| Id | Decision | Status |
|---|---|---|
| Q1 | Search pages, settings and actions; trailing row hands the query to Session History | Decided |
| Q2 | Top-bar Search button plus Cmd/Ctrl+K opens a floating palette | Decided |
| Q3 | Actions only open their existing preview/confirm; disabled with reason in a read-only Panel | Decided |
| Q4 | Index English and Chinese titles plus synonyms; show current language | Decided |
| Q5 | Not exempt from the three-place rule: CLI command and skill row (red-team: hold) | Decided |
| Q6 | Term "Command Palette", UI label Search / 搜索, in CONTEXT.md | Decided |
| Q7 | Reuse existing dialog; self-written exact > prefix > contains ranking; no dependency (CSP is nonce-only) | Decided |
| Q8 | `/` and Cmd/Ctrl+F stay on the account search; palette only Cmd/Ctrl+K | Decided |
| Q9 | Empty query: last 5 used + 4 common entries, ids in localStorage (try/catch) | Decided |
| Q10 | One shared declarative Search Catalog; test every target exists | Decided |
| Q11 | JSON `{schemaVersion:1, results:[{id,kind,title,panel,cliCommand\|null}]}`, exit 0 when empty (red-team: hold) | Decided |
| Q12 | Setting: open its page and popover/dialog, scroll, focus, highlight ~1.2 s (none under reduced motion) | Decided |
| Q13 | One list ranked by match with kind labels, 8 shown then "more"; history row last | Decided |
| Q14 | No match: "No matching feature", history row and "Ask your AI" | Decided |
| Q15 | Account names not in v1 | Decided |
| Q16 | CLI verb `sideby commands <query>`, no `search` alias (medium confidence) | Decided |
| Q17 | No Panel hash in JSON; readable `panel` location instead | Decided |

Records: ADR-0054 (proposed), CONTEXT.md "Command Palette". Next: spec section in docs/specs, then implementation.
