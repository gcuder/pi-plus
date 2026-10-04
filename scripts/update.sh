#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ ! -d "$REPO_DIR/.git" ]]; then
  printf 'This checkout is not a git repository: %s\n' "$REPO_DIR" >&2
  exit 1
fi

git -C "$REPO_DIR" pull --ff-only
exec "$REPO_DIR/scripts/install.sh"
