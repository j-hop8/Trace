#!/usr/bin/env bash
# PostToolUse(Edit|Write): format the file that was just touched.
#
# Fail-soft by contract — a missing formatter or a syntax error mid-edit must never block the
# edit itself. Every path exits 0.
set -uo pipefail

payload="$(cat)"
file="$(printf '%s' "$payload" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"

[ -z "$file" ] && exit 0
[ -f "$file" ] || exit 0

root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"

case "$file" in
  *.ts | *.tsx | *.css | *.json)
    if [ -x "$root/web/node_modules/.bin/prettier" ]; then
      "$root/web/node_modules/.bin/prettier" --write "$file" >/dev/null 2>&1 || true
    fi
    ;;
  *.py)
    # Prefer the pipeline venv's ruff so the version matches what CI runs.
    ruff_bin="$root/pipeline/.venv/bin/ruff"
    [ -x "$ruff_bin" ] || ruff_bin="$(command -v ruff || true)"
    if [ -n "$ruff_bin" ] && [ -x "$ruff_bin" ]; then
      "$ruff_bin" format "$file" >/dev/null 2>&1 || true
      "$ruff_bin" check --fix "$file" >/dev/null 2>&1 || true
    fi
    ;;
esac

exit 0
