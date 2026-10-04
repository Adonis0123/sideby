#!/bin/sh
# Scans everything git would publish (tracked + untracked, not ignored) for secrets and private machine layout.
# Exit 0 = clean, 1 = findings (fix: replace the matched value with a placeholder such as <home> or $HOME),
# 2 = a credential-shaped file would be published (fix: delete it or add it to .gitignore).
set -u
root=$(git rev-parse --show-toplevel) || exit 2
cd "$root" || exit 2
home_prefix=$(printf '/%s/' Users)
b='(^|[^A-Za-z0-9_-])'
# Each alternative is a complete credential shape or a private-layout marker, never a bare prefix.
pattern="${home_prefix}[A-Za-z0-9._-]+/|/home/[a-z][a-z0-9_-]+/|[A-Za-z]:\\\\Users\\\\[^\\\\]+|${b}sk-[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,}|npm_[A-Za-z0-9]{36}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[abp]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|hooks\\.slack\\.com/services/[A-Za-z0-9/]+|open\\.feishu\\.cn/open-apis/bot/v2/hook/[a-f0-9-]{20,}"
status=0
# NUL-separated so file names with spaces are scanned too; -I skips binary files such as screenshots.
if git ls-files -z --cached --others --exclude-standard -- ':!scripts/leak-check.sh' ':!pnpm-lock.yaml' \
  | xargs -0 grep -I -n -E "$pattern" --; then
  echo "leak-check: replace the values above with placeholders (<home>, \$HOME, <token>)" >&2
  status=1
fi
stray=$(git ls-files --cached --others --exclude-standard | grep -E '(^|/)(proxy\.env|auth\.json|\.claude\.json|\.npmrc|id_rsa|id_ed25519|.*\.pem|.*\.env(\..*)?)$' | grep -v -E '(^|/)fixtures/')
if [ -n "$stray" ]; then
  printf 'leak-check: credential-shaped file would be published: %s (delete it or move it under a fixtures/ directory with fake values)\n' $stray >&2
  status=2
fi
[ "$status" -eq 0 ] && echo "leak-check: clean"
exit "$status"
