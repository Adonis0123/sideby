# ADR-0086: Menu bar rows keep their order while the menu is open

Status: proposed
Date: 2026-11-25

## Context

The Menu Bar Item (spec §3.31, ADR-0034) keeps one `NSMenu` and swaps all of its items whenever a snapshot lands, so an open menu shows new numbers in place. Snapshots land while the menu is open: the automatic one every 2 minutes, a manual Refresh, and the cache-only snapshots that run every 2 seconds during a refresh.

Until now only the recommended row could move between two snapshots. Config `menubar.sort: "room"` (spec §3.31, 2026-11-25) lists the rest of each group by the Family's Handoff ranking, so any refresh can reorder the rows. A row that moves while the pointer or the keyboard selection is on it makes a click start another Account than the one the user aimed at.

AppKit expects a menu's structure to be settled before it opens (`menuNeedsUpdate:`, https://developer.apple.com/documentation/appkit/nsmenudelegate/menuneedsupdate(_:)), so the order is best changed between two openings.

## Decision

- While the menu is open, the script puts each new snapshot on show with the row order and the recommended badge each group had when the menu opened. Numbers, bars, notes and the refresh state still update in place. An Account that was not listed goes at the end of its group; one that is gone drops out.
- The script keeps the newest snapshot as Node ordered it. Once the menu has closed, the next tick (every 5 seconds) puts that one on show, so the next opening has the new order. It does not do this in `menuDidClose:`, which may come before the clicked item's action (not verified), and that action still reads the row list of the menu the user clicked in.
- The title, the card and the submenu of other accounts take each snapshot as before.
- Node still decides every order; the script only keeps an order it was given. `sideby menubar snapshot --json` always prints the new order.

## Considered

- Rebuilding the menu in `menuNeedsUpdate:`: the right AppKit hook, but the script already rebuilds on each snapshot and on appearance changes; keeping the order on show touches only how a snapshot is put on show.
- Freezing the whole snapshot while the menu is open: a refresh started from the menu would then show nothing until it closed.
- Ties within a margin ("within 2 points counts as equal") to make the order calmer: the Handoff ranking already breaks ties, and a margin would make the first row disagree with the recommendation.

## Consequences

- A row never moves under the pointer. The order can be up to one tick old when the menu is opened again within 5 seconds of closing it.
- The native behaviour (keyboard selection kept across a rebuild, no flicker) is not covered by tests; `src/menubar/agent.test.ts` runs the script's `keepOrder` under Node.
