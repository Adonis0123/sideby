#!/bin/sh
# Read-only check of the current package folder before publishing to npm.
# Prints "key: value" lines for the Agent and the Publisher, ending with a "next:" line
# that matches a branch in SKILL.md. Runs nothing that needs a Second Factor and no project scripts.
# Writes no files: npm debug logs go to an impossible path (F-70). npm may still refresh its own
# download cache in the home folder.
#
# Usage: sh diagnose.sh            (run from the package folder)

TRUST_NPM_MIN=11.15.0   # npm trust (F-06)
CI_NPM_MIN=11.5.1       # Trusted Publishing inside the workflow (F-02)
CI_NODE_MIN=22.14.0     # Trusted Publishing inside the workflow (F-02)
NPMJS=https://registry.npmjs.org/

say() { printf '%s: %s\n' "$1" "$2"; }

# Every npm call: no stdin (never waits for a prompt), no update banner, no debug log file
# (--logs-max=0 would delete existing logs, F-70), short network timeout.
npmq() {
  npm --no-update-notifier --logs-dir=/dev/null/npm-publish-guide \
    --fetch-timeout=15000 --fetch-retries=0 "$@" </dev/null
}

# version_ge A B -> exit 0 when A >= B (numeric x.y.z, pre-release tags ignored)
version_ge() {
  node -e '
    const p = (v) => String(v).replace(/^v/, "").split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0)
    const [a, b] = [p(process.argv[1]), p(process.argv[2])]
    for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) process.exit(a[i] > b[i] ? 0 : 1) }
    process.exit(0)
  ' "$1" "$2" 2>/dev/null
}

sep=$(printf '\037')  # unit separator: not whitespace, so empty fields survive read

# This line is printed whatever the TTY checks below say: a pseudo-terminal in the Agent's
# tool is still not the Publisher's Real Terminal.
say handoff_rule "commands that need a Second Factor go to the Publisher through handoff.sh; this shell is never the Publisher's Real Terminal, even if it reports a TTY"

# --- tools ---------------------------------------------------------------
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  say node "$(command -v node >/dev/null 2>&1 && node -v || echo missing)"
  say npm "$(command -v npm >/dev/null 2>&1 && echo present || echo missing)"
  say next "install-node"
  exit 0
fi
say node "$(node -v 2>/dev/null)"

# --- package.json (checked before any npm call) --------------------------
if [ ! -f package.json ]; then
  say package_json "missing in this folder"
  say next "no-package-json"
  exit 0
fi

pkg_fields=$(node -e '
  let p
  try { p = JSON.parse(require("fs").readFileSync("package.json", "utf8")) } catch (e) { console.log("error"); process.exit(0) }
  const r = p.repository
  const url = typeof r === "string" ? r : (r && r.url) || ""
  const pc = p.publishConfig || {}
  console.log([p.name || "", p.version || "", p.private === true ? "yes" : "no", url,
    pc.registry || "", pc.access || ""].join("\x1f"))
' 2>/dev/null)
if [ "$pkg_fields" = error ] || [ -z "$pkg_fields" ]; then
  say package_json "unreadable (not valid JSON)"
  say next "fix-package-json"
  exit 0
fi
IFS="$sep" read -r pkg_name pkg_version pkg_private pkg_repo pc_registry pc_access <<EOF
$pkg_fields
EOF
say package_name "${pkg_name:-missing}"
say package_version "${pkg_version:-missing}"
say package_private "$pkg_private"
say package_repository "${pkg_repo:-missing}"
case "$pkg_name" in
  @*/*) scoped=yes; scope=${pkg_name%%/*} ;;
  *) scoped=no; scope="" ;;
esac
say publish_access "${pc_access:-not set in publishConfig}"

if [ -z "$pkg_name" ] || [ -z "$pkg_version" ]; then
  say next "fix-package-json"
  exit 0
fi

# --- npm ----------------------------------------------------------------
npm_v=$(npmq -v 2>/dev/null)
say npm "$npm_v"
if version_ge "$npm_v" "$TRUST_NPM_MIN"; then
  say npm_ok_for_trust "yes (needs $TRUST_NPM_MIN)"
else
  say npm_ok_for_trust "no (needs $TRUST_NPM_MIN; handoffs use npx --yes npm@11 for npm trust)"
fi
say ci_needs "npm >= $CI_NPM_MIN and node >= $CI_NODE_MIN inside the workflow"

# Where a publish of this package would go: publishConfig.registry, then the scope's registry, then the default.
if [ -n "$pc_registry" ]; then
  registry=$pc_registry; registry_from="package.json publishConfig.registry"
else
  registry=""
  if [ "$scoped" = yes ]; then
    registry=$(npmq config get "$scope:registry" 2>/dev/null)
    case "$registry" in undefined|null) registry="" ;; esac
    [ -n "$registry" ] && registry_from="$scope:registry in npm config"
  fi
  if [ -z "$registry" ]; then
    registry=$(npmq config get registry 2>/dev/null); registry_from="default npm config"
  fi
fi
say publish_registry "$registry ($registry_from)"
case "$registry" in
  "$NPMJS"|"${NPMJS%/}") registry_ok=yes ;;
  *) registry_ok=no ;;
esac
say publish_registry_is_npmjs "$registry_ok"

# --- terminal and login --------------------------------------------------
if [ -t 0 ]; then stdin_tty=yes; else stdin_tty=no; fi
if [ -t 1 ]; then stdout_tty=yes; else stdout_tty=no; fi
say shell_tty "stdin=$stdin_tty stdout=$stdout_tty (informational only)"

auth_type=$(npmq config get auth-type 2>/dev/null)
say auth_type "${auth_type:-unknown}"
otp=$(npmq config get otp 2>/dev/null)
case "$otp" in ''|null|undefined) say otp_config "unset" ;; *) say otp_config "set (forces the old OTP login, F-36)" ;; esac

if who=$(npmq whoami 2>/dev/null) && [ -n "$who" ]; then
  logged_in=yes
  say npm_user "$who"
  tfa=$(npmq profile get tfa 2>/dev/null | tail -n 1)
  say two_factor_mode "${tfa:-unknown}"
else
  logged_in=no
  say npm_user "not logged in (npm whoami failed)"
fi

# --- package manager -----------------------------------------------------
git_root=$(git rev-parse --show-toplevel 2>/dev/null)
lock_dir=.
[ -n "$git_root" ] && lock_dir=$git_root
pm=""
for d in . "$lock_dir"; do
  if [ -f "$d/pnpm-lock.yaml" ]; then pm=pnpm
  elif [ -f "$d/yarn.lock" ]; then pm=yarn
  elif [ -f "$d/bun.lock" ] || [ -f "$d/bun.lockb" ]; then pm=bun
  elif [ -f "$d/package-lock.json" ] || [ -f "$d/npm-shrinkwrap.json" ]; then pm=npm
  fi
  [ -n "$pm" ] && break
done
say package_manager "${pm:-npm (no lockfile)}"

# --- git and GitHub ------------------------------------------------------
# Normalise both sides to https://github.com/<owner>/<repo>; keep case, npm compares exactly (F-11, F-12).
to_github_url() {
  printf '%s\n' "$1" | sed -E \
    -e 's#^git\+##' \
    -e 's#^git@github\.com:#https://github.com/#' \
    -e 's#^ssh://git@github\.com/#https://github.com/#' \
    -e 's#^git://github\.com/#https://github.com/#' \
    -e 's#^github:#https://github.com/#' \
    -e 's#\.git$##' -e 's#/$##'
}
github=no
has_wf=no
if [ -z "$git_root" ]; then
  say git_repo "none"
else
  prefix=$(git rev-parse --show-prefix 2>/dev/null)
  prefix=${prefix%/}
  say package_dir_in_repo "${prefix:-. (repository root)}"
  remote=$(git remote get-url origin 2>/dev/null)
  remote_url=$(to_github_url "$remote")
  case "$remote_url" in
    https://github.com/*/*) github=yes; say github_repo "${remote_url#https://github.com/}" ;;
    *) say git_remote "${remote:-none} (not GitHub)" ;;
  esac
  if [ "$github" = yes ]; then
    if [ -z "$pkg_repo" ]; then
      say repository_matches_remote "no (repository field missing)"
    elif [ "$(to_github_url "$pkg_repo")" = "$remote_url" ]; then
      say repository_matches_remote "yes"
    else
      say repository_matches_remote "no (package.json: $(to_github_url "$pkg_repo"))"
    fi
  fi
  # Any workflow at the repository root that publishes, whatever its file name.
  wfs=""
  for f in "$git_root"/.github/workflows/*.yml "$git_root"/.github/workflows/*.yaml; do
    [ -f "$f" ] || continue
    if grep -qE '(npm|pnpm|bun) publish|yarn npm publish' "$f"; then
      wfs="${wfs:+$wfs }.github/workflows/${f##*/}"
    fi
  done
  if [ -n "$wfs" ]; then has_wf=yes; say publish_workflow "$wfs"; else say publish_workflow "none"; fi
fi

# --- registry ------------------------------------------------------------
on_registry=unknown
if [ "$registry_ok" = no ]; then
  say on_registry "not checked (publish registry is not registry.npmjs.org)"
elif [ "$pkg_private" = yes ]; then
  say on_registry "not checked (package.json has private: true)"
else
  # stdout only: with --json npm prints the document, or {"error":{"code":...}} on failure;
  # notices and warnings go to stderr and would break the JSON.
  view_out=$(npmq view "$pkg_name" --json 2>/dev/null)
  info=$(printf '%s' "$view_out" | node -e '
    const want = process.argv[1]
    let j = null
    try { j = JSON.parse(require("fs").readFileSync(0, "utf8")) } catch (e) {}
    if (Array.isArray(j)) j = j[j.length - 1] || null
    const out = (a) => console.log(a.join("\x1f"))
    if (!j) { out(["error", "no answer from the registry"]); process.exit(0) }
    if (j.error) { out(["error", j.error.code || j.error.summary || "unknown error"]); process.exit(0) }
    const tags = j["dist-tags"] || {}
    const versions = [].concat(j.versions || [])
    const local = versions.includes(want)
      ? "yes" + (Object.keys(tags).filter((t) => tags[t] === want).map((t) => " (dist-tag " + t + ")").join("") || " (no dist-tag)")
      : "no"
    const u = j._npmUser || {}
    const by = u.trustedPublisher ? "trusted-publishing (" + (u.trustedPublisher.id || "?") + ")"
      : (typeof u === "string" && u) || u.name ? "a person" : "unknown"
    const prov = j.dist && j.dist.attestations && j.dist.attestations.provenance ? "yes" : "no"
    out(["ok", j.version || "unknown", by, prov, local,
      Object.keys(tags).map((t) => t + "=" + tags[t]).join(" ")])
  ' "$pkg_version" 2>/dev/null)
  IFS="$sep" read -r view_status latest latest_by latest_prov local_on_npm dist_tags <<EOF
$info
EOF
  if [ "$view_status" = ok ]; then
    on_registry=yes
    say on_registry "yes"
    say dist_tags "$dist_tags"
    say latest_published_by "$latest_by (version $latest, F-68)"
    say latest_has_provenance "$latest_prov"
    say local_version_on_npm "$pkg_version: $local_on_npm"
  elif [ "$latest" = E404 ] && [ "$scoped" = yes ]; then
    on_registry=unconfirmed
    say on_registry "unknown (E404 on a scoped name: free, or private and not visible to this login)"
  elif [ "$latest" = E404 ]; then
    on_registry=no
    say on_registry "no (E404: name not taken yet)"
  else
    say on_registry "unknown (npm view failed: ${latest:-no output})"
  fi
fi

# --- next ----------------------------------------------------------------
needs_login=no
if [ "$registry_ok" = no ]; then
  next=check-registry
elif [ "$pkg_private" = yes ]; then
  next=private-package
elif [ "$on_registry" = unconfirmed ]; then
  next=confirm-visibility
elif [ "$on_registry" = unknown ]; then
  next=troubleshoot
elif [ "$on_registry" = no ]; then
  next=first-release; needs_login=yes
elif [ "$github" = no ]; then
  next=local-release; needs_login=yes
elif [ "$has_wf" = no ]; then
  next=setup-trusted-publishing; needs_login=yes
else
  case "$latest_by" in
    trusted-publishing*) next=release-by-tag ;;
    *) next=finish-trusted-publishing; needs_login=yes ;;
  esac
fi

if [ "$needs_login" = yes ] && [ "$logged_in" = no ]; then
  say next "login"
  say after_login "$next"
else
  say next "$next"
fi
