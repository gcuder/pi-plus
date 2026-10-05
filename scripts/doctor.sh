#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_DIR="${PI_DIR:-$HOME/.pi}"
PI_AGENT_DIR="$PI_DIR/agent"
errors=0

check() {
  local label="$1"; shift
  if "$@"; then
    printf 'OK   %s\n' "$label"
  else
    printf 'FAIL %s\n' "$label"
    errors=$((errors + 1))
  fi
}

has_command() { command -v "$1" >/dev/null 2>&1; }
valid_json() { node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$1" >/dev/null 2>&1; }
has_extension_packages() { [[ -x "$PI_AGENT_DIR/npm/node_modules/.bin" || -d "$PI_AGENT_DIR/npm/node_modules" ]]; }

check "Node.js installed" has_command node
check "npm installed" has_command npm
check "Pi CLI installed" has_command pi
check "Supported Pi version (1.0.2)" bash -c '[[ "$(pi --version)" == "1.0.2" ]]'
check "Pi settings present and valid JSON" valid_json "$PI_AGENT_DIR/settings.json"
check "Pi models config present and valid JSON" valid_json "$PI_AGENT_DIR/models.json"
check "Pi package dependencies installed" has_extension_packages
check "Orca Pi extensions installed" test -f "$PI_AGENT_DIR/extensions/orca-agent-status.ts" -a -f "$PI_AGENT_DIR/extensions/orca-prefill.ts" -a -f "$PI_AGENT_DIR/extensions/orca-titlebar-spinner.ts"
check "JetBrains IDE extension installed" test -f "$PI_AGENT_DIR/extensions/jetbrains-ide/index.ts"
check "JetBrains IDE transport dependency installed" test -f "$PI_AGENT_DIR/extensions/jetbrains-ide/node_modules/ws/package.json"

if [[ "$errors" -gt 0 ]]; then
  printf '\nDoctor found %s problem(s). Run scripts/install.sh to repair managed files.\n' "$errors" >&2
  exit 1
fi
printf '\nPi Plus looks healthy. Authentication credentials are machine-local and are not checked.\n'
