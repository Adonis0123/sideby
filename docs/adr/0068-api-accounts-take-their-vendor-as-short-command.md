# ADR-0068: An API Account's short command is named after its Vendor

Status: accepted
Date: 2026-11-01

## Context

`sideby new <family> --next` (spec §3.16) picks the next number for the Account and, when the Family's Aliases show a prefix-plus-name pattern, the next numbered Alias (`cc007` → `cc008`). It did the same for API Accounts, so a user with a few of them got `cc009`, `cc010`, `cc011` and had to remember which number calls DeepSeek and which calls Kimi. The Panel showed the Account's number in bold and only one of its Aliases, so the row said even less: an Account with `pi001`, `pi-glm` and `pi-kimi` showed only `pi-glm`.

A Subscription Account's number is fine: every one of them talks to the same vendor, and the number only tells them apart. An API Account differs by what it calls (its Vendor), and that is what the user looks for.

## Decision

- An API Account's suggested Alias is the Family's Alias prefix, a dash and its Vendor Slug (`cc-ds`), never a number. `sideby new … --api --vendor <slug>` gives the slug; the Panel's new-account form asks for the Vendor under "API key". Both use one helper (`vendorAlias` in `page-logic.ts`), with the prefix from the same rule as numbered Aliases (`aliasPrefix`).
- The slug is used as the user gives it and checked by the existing Alias rules (pattern, reserved, taken). A problem is reported and the Account is still created without the Alias, as for a numbered suggestion.
- No prefix can be derived: no Alias, and the result says how to add one. sideby never invents a prefix.
- `--api` without `--vendor`: no Alias, and the result (`suggestion.aliasHint`) says that `--vendor <slug>` or `sideby alias add <prefix>-<slug> <ref>` gives one.
- sideby ships no Vendor-to-slug table. The recommended slugs (`ds`, `glm`, `kimi`, `qwen`, `api` for the Host's own official API, `relay` for a gateway) live only in the skill, which asks the user or reads the Vendor from the docs they gave.
- Account names stay numbered (`claude:011`); only the Alias carries the Vendor. A model variant of one Account is another Alias with Host arguments (`pi-kimi`), not another Account.
- The Panel names an API Account by its Alias that adds no arguments (`cc-kimi`, bold), with its ref in the line under it; Subscription Accounts keep their name. Every Alias of an Account shows after the title, those without arguments first; hovering one shows the arguments it adds.

## Consequences

- A user reads `cc-ds` and `cc-kimi` instead of numbers, and the name stays right when the Account's model changes.
- Existing Aliases are not renamed; a user who wants vendor names adds them with `sideby alias add`.
- `suggestion` in `sideby new --json` gains an optional `aliasHint` and also appears with `--vendor`; nothing is removed, so `schemaVersion` stays 1.
- Two API Accounts of one Vendor collide on `cc-ds`; the second is created without an Alias and the user picks another (`cc-ds2`).
