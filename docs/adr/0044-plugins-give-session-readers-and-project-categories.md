# ADR-0044: Plugins give session readers and Project Categories

Status: accepted
Date: 2026-10-20

## Context

Session History (ADR-0042, spec §3.33) read only the built-in Families, through internal readers in `families/<id>/history.ts`. A user who adds a tool through a plugin Family (Cursor CLI was the sample, cursor-agent 2026.10.19, checked on 2026-10-20) saw that AI in the Panel's filter, picked it, and got "no sessions in this period" with a button to widen the time. The page did not say that sideby had never read anything for that AI, so the user widened the time, saw nothing again, and took it for a bug.

The second gap was the side list. Session History groups by Project only, as a flat list. Users with many repositories keep their own grouping of them (by client, by product, by workspace) in a tool of their own. Orca's workspace view, Linear's and GitHub Projects' "Group by" all agree on the shape: one Display popover, a default grouping, a few alternatives, collapsible group headers with a count. Without a way to bring the user's own grouping in, sideby would either invent a fixed one or ask the user to type it again in sideby's config.

## Decision

- **`FamilyDef.history`** (public, `src/types.ts`): a `FamilyHistory` with `list`, `parse`, `messages`, and optionally `toolText` and `titles`, plus `resumeArgs`. It is the same contract the built-in readers already follow, now exported. `historyReader(family, families)` uses the built-in reader when there is one and the plugin's otherwise; a plugin cannot replace a built-in Family's reader, because it cannot register a built-in Family's id.
- **What sideby checks.** The loader drops a `history` whose members are not functions with a plugin error that names the Family and says it has no Session History until fixed, and keeps the Family, as it does for `logo` and `website` (ADR-0043). A reader that throws for one file adds one problem for that Account; the others go on.
- **No reader.** An Account of a Family without `history` is listed in the sources with reason `unsupported` and a note naming `FamilyDef.history`. When the user filters to such an AI, the Panel says that sideby cannot read that tool's past sessions yet and why, instead of offering to widen the time.
- **`PluginApi.projectCategories({ label?, categoriesOf(projects) })`**: a Plugin sorts Project paths into named categories. sideby asks for all the Projects of a result at once, keeps the answers about a minute, gives up after 3 s, keeps only the paths it asked about with a string name, and cuts names to 80 characters. Only the first Plugin that registers is used; a later one gets a plugin error naming the one in use. A failure adds one problem naming the Plugin and leaves the list ungrouped by category, never empty.
- **Grouping.** `history` takes `group` (`project` default in the Panel, `category`, `day`, `account`, `family`, `none`) and `collapsed` (group keys). Groups are ordered by their best Session, the group without a key last; days keep their own order. A collapsed group is counted but its Sessions are left out of the page, so folding a big group does not cost a page of rows. `--group` and `--tools` do not combine: tool output is searched live and listed as it is found.
- **Panel.** A "Display" popover above the list picks the grouping and says which Plugin the categories come from; the choice and the folded groups are kept per browser. With categories, the side list nests Projects under them. Row actions are visible on the row ("Read", "Continue"), a click on the row opens the viewer, and a right-click or Shift+F10 opens the same menu as "···".
- **Output.** `history --json` gains `groups` and `categories`, each Session `group`; `history projects --json` gains each Project's `category` and `categories`. Adding fields keeps `schemaVersion` 1.

## Consequences

- Any plugin Family can show its Sessions with one field, and a Family without it says so where the user looks.
- A plugin reader decides what reaches the History Index. sideby cannot check that it leaves out tool output or credentials; the docs say which fields to fill and that a reader must never open a login file, and `ParsedSession` has no field for anything else.
- The user's own grouping comes from the tool that already keeps it, through a Plugin of theirs, and never from a file sideby reads on its own. Without such a Plugin, the "Category" choice does not appear.
- Toasts stay in one place, bottom centre. Material, Shopify Polaris and Atlassian put them there; Carbon, Sonner and react-hot-toast differ. At the top they would cover the tab bar and the menus that open downwards, and the actions that can answer in place ("Copied" on the button) do so without a toast.
