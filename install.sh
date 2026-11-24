#!/usr/bin/env bash
# Install /team skill using the cross-platform Node installer.
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "✗ 需要 Node.js 18 以上 / Node.js 18+ is required: https://nodejs.org" >&2
  exit 1
fi

exec node "$(dirname "$0")/install.mjs" "$@"
