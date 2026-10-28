# Themes: the Panel's colors

A Theme is a named set of Panel colors, one version for light and one for dark (spec §3.34, ADR-0050). sideby has five Built-in Themes, one per interface accent on the same cool-gray base: `teal` (default), `leaf` (green), `celeste` (light blue), `claude` (orange) and `codex` (black and white). The old name `sky` still works and means `celeste`. The user can pick one, give their own accent color, or keep a Theme File of their own. Light, dark or system is a separate setting (`panel.theme`).

## See and switch

```sh
sideby theme --json              # every Theme: id, name, source (builtin|file), active, problems
sideby theme use codex --json    # switch; the Panel shows it on its next refresh
sideby theme use --undo --json   # back to the Theme before the last switch
sideby theme use default --json  # no Theme chosen: Teal, or inside a Portal the Portal's colors
```

`use` changes only config `panel.colorTheme`, nothing else; it needs no `--yes`, because undo is one command. Tell the user they can also click **Settings › Theme** in the Panel.

## A Theme File

A Theme File is JSON in `~/.config/sideby/themes/<name>.json` (the folder `sideby theme --json` prints as `folder`). It holds colors only, never code:

```json
{ "schemaVersion": 1, "name": "Calm green", "base": "teal", "accent": "#4f9d69",
  "light": { "bg": "#fafaf7" }, "dark": {} }
```

- `base`: the Built-in Theme to start from (default `teal`).
- `accent`: one `#rrggbb` color; sideby makes the main button, links, selection, focus and the normal quota bar from it. Neutrals and warning colors stay the base's. Usually `base` plus `accent` is enough.
- `light` / `dark`: single tokens to change, by the names `sideby theme export sky` prints. Unknown keys are ignored with a warning.
- The file name is the Theme's name: lowercase letters, digits and hyphens.

## Making one for the user ("Let AI pick my colors")

1. Run `sideby theme --json` to see the Themes and the one in use. Ask what feel they want; a screenshot, a website or a brand color is a good start. Take colors from what they give; do not guess a brand's colors from memory.
2. Write the file in the current folder, not in the themes folder yet. Start from `base` and `accent`; add `light` / `dark` tokens only for what still looks wrong.
3. Run `sideby theme check <file> --json`. Every pair needs `ok: true` (text 4.5:1, the main button and focus outline 3:1). For a failing pair, use its `suggest` value for that token, or pick another; run it again until all pass. The Panel would adjust failing colors by itself, but a Theme should not rely on that.
4. Run `sideby theme preview <file>`: it shows the Theme once in the running Panel without switching. If the Panel is not running, give the user `sideby ui --background` first. Ask what they think; change and preview again as often as needed.
5. Only when they like it: `sideby theme import <file> --json` (exit 10 when that name exists; add `--yes` only after they agree to replace it), then `sideby theme use <name> --json`. Remind them `sideby theme use --undo` goes back.

Keep warnings and errors readable: do not set `warn`, `fail`, `warnBar` or `failBar` to the accent's hue, and do not make the normal quota bar (`okBar`) red or amber.

## Other commands

```sh
sideby theme export teal --out my-theme.json   # a full copy to edit (refuses to overwrite a file)
sideby theme remove <name> --yes --json       # delete a Theme File; the Panel goes back to sky if it was in use
```

A Portal that embeds the Panel can set colors itself (`PanelTheme`). They show until the user picks a Theme; a picked Theme wins over them. When the user wants the Portal's colors back there, run `sideby theme use default`.
