# 0030. Portals start AI Tasks through a Task Spec

Date: 2026-10-18 · Status: accepted · Amends ADR-0006 (Panel options) and ADR-0027

## Context

A Portal shows several Local Tools as tabs, sideby among them, and wants to offer AI Tasks on every one of them: a "Let AI do it" button for each page and buttons next to the problems a Tool shows. Starting an AI Task means choosing a signed-in Account, ranking Quota, taking attachments and opening the Preferred Terminal through a fixed command (ADR-0027). sideby already does all of it. A Portal that did it again would keep a second copy of the Account choice and the terminal launchers, and one that imported sideby's modules would break whenever the Portal and the installed sideby are different versions.

The Portal also embeds sideby's Panel in a frame. The Panel has its own "Let AI do it" button and dialog; inside a Portal that has its own, the page would show two buttons and two dialogs that behave differently.

## Decision

- **A Task Spec is how a Portal hands over an AI Task.** `sideby ask --spec -` reads one JSON object on stdin (at most 1 MB), never through a shell. It is either `{ specVersion: 1, prompt, cwd, … }`, a Task Prompt the Portal wrote for another Tool, or `{ specVersion: 1, native: { task, text, context }, … }`, one of sideby's own AI Tasks. Both take `lang`, `account`, `terminal`, `remember` and `files`. sideby picks the Account, copies the files and opens the Preferred Terminal exactly as for its own AI Tasks; the output is `sideby ask --json`'s.
- **sideby writes only its own prompts.** For `native` it writes the Task Prompt itself, word for word as the Panel does (a snapshot test holds every task kind). For `prompt` it only removes key-shaped text again and appends the attachments section, worded as its own (at the prompt's heading level), because the paths exist only once the files are copied. The skill, the folder and the words of another Tool's prompt are the Portal's, from that Tool's declaration.
- **The folder must be the user's.** `cwd` must be an existing directory inside the HOME, judged by its real path; anything else is refused with `bad-cwd` before a file is copied. The task records that real path, and because the folder or one of its parents could be swapped for a link while the Account and terminal are chosen, sideby checks it again right before it writes the task file and once more in `sideby ask --run`, after changing into it and before the Host starts; a folder that moved is refused with `bad-cwd`. Without `cwd` the task starts in sideby's own task folder. Because that folder follows `XDG_STATE_HOME`, a Tool's declaration can name it only as `"cwd": "engine"`: the Portal then sends no `cwd`.
- **Versions are explicit.** A `specVersion` other than 1 exits 2 with `spec-version`, so a Portal can tell the user to update sideby. A refused spec answers `{ schemaVersion, error, code, reason }` under `--json`.
- **`sideby ask --choices`** answers what the Portal's dialog shows before it starts anything: the Account an AI Task would pick (or why none), the Accounts it may use and the installed terminals with the one it would open.
- **The Panel can hand its AI Tasks to the Portal.** `createPanelHandler({ ask: { bridge: 'postMessage' } })` hides the Panel's header button when the page finds itself in a frame at load (a Panel opened on its own keeps it), and every AI Task entry posts `{ type: 'local-tools:ask', version: 1, preset, native: { task, text, context }, text }` to `window.parent` with the Panel's own origin as the target origin, instead of opening the Panel's dialog. The Portal answers with a Task Spec carrying that `native` part. Without the option, or outside a frame, nothing changes. The CSP, Host, Origin and token checks stay as they are.
- **sideby declares its own AI Tasks** in `ai-tasks.json` at the package root: the `sideby` skill and its install command, `"cwd": "engine"`, where to contribute, and one `native: true` preset per AI Task except `free` (the Portal's own button), with the Panel's titles, placeholders and examples in English and Chinese. A test keeps them equal to the Panel's.

Options considered:

- Each Tool launches its own AI Tasks. Rejected: every Tool would need Account choice, Quota ranking and terminal launchers.
- The Portal imports sideby's modules. Rejected: the Portal and the installed sideby update separately; a CLI contract with a version number survives that.
- sideby writes every Tool's prompt. Rejected: sideby would have to know other Tools' skills and wording.

## Consequences

- `PanelHandlerOptions` gains `ask`, a public contract under ADR-0006: adding keeps compatibility; removing or changing it needs a new ADR. The Task Spec, the `--choices` output and `ai-tasks.json` follow the `--json` rule: adding a field keeps `specVersion` and `version`; anything else bumps them.
- The Task Spec carries another Tool's prompt into a Host session. sideby treats it as the user's own text: it reaches the Host only through the private task file, and key-shaped strings are removed again.
