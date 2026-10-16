---
name: readme-assets
description: Check and refresh sideby's README media and copy before a release or after user-visible changes. Covers the Panel screenshots, the demo GIF, the banner, the painted intro video and the README text. Use whenever the maintainer asks to update the README in any words ("更新一下 README", "更新 readme", "update the README", "refresh the README"), or says "README 素材", "重拍截图", "更新 gif", "README 要不要更新", "发版前看看 README", or when `npm version` (preversion) prints a readme-assets warning.
---

# README assets

`docs/assets/manifest.json` lists each README medium, the code it depends on and how to retake it. `node scripts/readme-assets.ts` compares that with git and lists what may be stale. This skill acts on that list. It changes files only; commit when the maintainer asks (AGENTS.md).

## 1. Check

```sh
node scripts/readme-assets.ts
```

For each entry, read the listed commits (`git show --stat <sha>`, and the diff where it matters) and decide whether the medium really shows something that changed. If not, record it and move on:

```sh
node scripts/readme-assets.ts --mark <id>   # or --mark copy
```

## 2. Auto media: retake without asking

These are deterministic and free, so retake them directly, then look at the result before keeping it.

| id | Retake | Look at |
|---|---|---|
| `panel-screenshots` | `node scripts/shoot-panel.ts` (try `--out <dir>` first) | Read all four PNGs: English and Chinese, light and dark, 1280×860, nothing cut off or loading |
| `demo-gif` | `node scripts/record-demo.ts` (needs ffmpeg, gifsicle, Chrome) | `--frames 2,8,14,20` first and Read the PNGs; the full run fails above 4 MB; every pixel that moves costs bytes, so keep borders and backgrounds still |

Retake from a clean working tree, or uncommitted Panel changes end up in the README. If a retake looks wrong, fix the cause (usually `scripts/demo-home.ts` or `docs/assets/demo.html`), not the image.

## 3. Copy: draft, then show

For each `feat` commit the check lists, decide whether a user would notice it on the README's first screen:

- A new command or Panel page the user would look for: one row in the README feature table, with a link to `docs/guide/`.
- A change to the first steps: Quick start.
- Anything else goes only in `docs/guide/<page>.md`, or nowhere.

Keep the README a short landing page. Edit `README.md` and `README.zh-CN.md` together, and each guide page with its `.zh-CN.md`, using the terms in `CONTEXT.md`. Show the maintainer the diff; when nothing needs to change, `--mark copy`.

## 4. Creative media: ask first, every time

These cost money and depend on taste. For each stale one, tell the maintainer which commit makes it stale, what you would change and roughly what it costs, then wait for a yes.

### banner (`docs/assets/banner.jpg`)

A painted scene of the brand characters from `src/core/brand-mark.ts` (crowned main, hard-hat work, beanie personal, headphones API key) under the "sideby" wordmark. Generate with Codex, which has image generation on:

```sh
codex exec -s workspace-write -i docs/assets/banner.jpg \
  "Generate a new README banner for sideby: <what changes>. Keep the attached banner's painted style, palette and characters. 1920×960. Save it as /tmp/sideby-banner.png and print the path."
```

Generate two or three options and let the maintainer pick. Convert the pick to JPEG at 1920×960 (`sips -s format jpeg -s formatOptions 85 <png> --out docs/assets/banner.jpg`), keep it under about 500 KB, and keep any command shown in it valid.

### intro-video (GitHub attachment in both READMEs)

Made with the `painted-animation` skill in the intro film's own project, which lives outside this repository; ask the maintainer where it is. Change the storyboard and scenes there, review with contact sheets as that skill says, then render the MP4. GitHub serves README videos only as attachments, so the maintainer uploads it by dragging the MP4 into a GitHub issue or PR comment box and gives you the `https://github.com/user-attachments/assets/...` link. Then update the link in both READMEs and `url` in the manifest, and run `--mark intro-video`.

## 5. Finish

Run `node scripts/readme-assets.ts` again: it should print nothing stale, or only what the maintainer chose to leave. Report what was retaken, what was marked as unchanged, and what waits for the maintainer.
