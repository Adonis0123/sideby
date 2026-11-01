# Panel sort menu (grill decision log, 2026-11-02)

Pairing: Interviewer Claude Code, Proxy Codex (`review-loop consult --raw --web`), no red-team (no hard-to-reverse decision). One round; the Proxy agreed with Q1–Q4 and corrected Q5.

| Q | Decision | Status |
|---|---|---|
| Q1 | "Arrange order and pins…" stays in the sort menu, below a separator, as a plain `menuitem` action with a grip icon; never a radio, never checked. The check stays on "My order". Read-only Panels have no action. | Decided |
| Q2 | The menu gets a "Sort by" heading and items without the "Sort:" prefix (Quota used / Name / Last used / My order); the button keeps "Sort: <choice>". | Decided |
| Q3 | Picking "My order" with no order of one's own still opens the arrange mode; the item says "Not set" in grey meanwhile (`ordered()`, pins alone do not count). | Decided |
| Q4 | Action label "Arrange order and pins…" / 「调整顺序与置顶…」. | Decided |
| Q5 | `selectMenu` gains headings (`optgroup`), separators (`hr`), meta words, button words and actions (`data-action`). A radio click stops at the picker, so the component library's global radio script cannot re-check the clicked item after a `change` handler set another value (re-running `mark()` alone would not help: that script runs later, on `document`). Behaviour change, so tests: the menu model is the pure `sortMenu()` in `page-logic.ts`. | Decided (Proxy correction) |

Found while verifying: the arrange mode threw on open since v0.35.0 (`arrangeRow` called `aliasText(a)` without its list). Fixed, with a static test over every `aliasText` call.
