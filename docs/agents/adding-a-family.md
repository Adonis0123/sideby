# Adding a family

Steps for adding a Host as a new Family. Linked from `AGENTS.md` ("Read when"); the Change process there still applies.

1. Confirm the Host supports an isolated config directory through an environment variable, and record the tested version. A Host without one can still be added as a Main-only Family (`mainOnly: true`, no `selectVar` and no `layout.account`; ADR-0047): sideby then knows only its Main Account and refuses `new` for it. Write the family row in spec §3.4 (Hijack Variables, Shared Items with Share Modes, sign-in command, login-state rule that reads no credential values).
2. Create `src/families/<id>/index.ts` exporting a `Plugin` that calls `api.family(def)` with a `FamilyDef` from `src/types.ts`. Add its mark to `src/families/logos.ts` (one 24x24 SVG path with its source and license) and set it as `logo`.
3. Add it to `BUILTIN_PLUGINS` in `src/families/index.ts`.
4. Add `src/families/<id>/index.test.ts` with a fake HOME and a fake Host binary: discovery, launch env, every Shared Item's check and fix.
5. Quota or usage only from local files or official CLI output (ADR-0003); otherwise leave `readQuota` and `readUsage` out so the panel shows "no public source". sideby reads usage itself; do not add a dependency such as ccusage.
6. Update the supported hosts tables in both READMEs, the Host notes and the "What each account shares" table in `docs/guide/usage*.md` (check it against `sideby families <id>`), the shared-items line in `llms.txt`, and `skills/sideby/SKILL.md`.
