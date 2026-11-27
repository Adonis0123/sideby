# sideby Sessions (Orca Plugin)

An Orca plugin that surfaces your running [sideby](https://github.com/Adonis0123/sideby) Live Sessions inside Orca:

- **Status bar**: displays the Session Label of the focused Chat only when Orca explicitly confirms a single focused agent matching one running session (for example `agy:main · Fix login · 61230c3d`), or a short running count (`sideby · 2 sessions`) when focus cannot be confirmed so it never copies the wrong tab. Clicking it copies the confirmed session's Session Reference for another AI, or opens the `sideby Sessions` right sidebar panel directly.
- **Sidebar panel (`sideby Sessions`)**: lists every running Live Session across accounts with its status, working directory, `Started From` badge, and one-click **Copy for AI** and **Copy session id** actions.

## Requirements

- Orca `>=1.4.248` with Plugins turned on (**Settings -> Plugins**).
- `sideby` installed and available on `PATH`.

## Install and enable

From a global npm install of `sideby`:

```sh
orca plugin install "$(npm root -g)/sideby/mods/orca" --json
```

From a local `sideby` checkout:

```sh
orca plugin install ./mods/orca --json
```

On first install, Orca exits with `approval_required` (exit code `3`) and prints the requested access (`trusted-worker`, `agent:read`, `workspace:read`) together with the exact `--approve <fingerprint>` command. Review the requested access and re-run that command with `--approve <fingerprint>` to enable the plugin.

## Privacy and access

- Runs `sideby sessions --json` locally without a shell and makes no network requests.
- Reads only Orca's focused workspace context and agent status (`workspace:read`, `agent:read`) to match a uniquely active Chat by session id (`sessionId` or `orcaSessionId`).
- Forwards only display and copy fields (`label`, `sessionId`, `reference`, `status`, `cwd`, `startedFrom`, `guessed`, `isCurrent`) to the sidebar panel. Credentials and `orcaSessionId` never leave the worker.

## Validate and test

```sh
orca plugin validate mods/orca --json
orca plugin test mods/orca --json
orca plugin check mods/orca --json
```
