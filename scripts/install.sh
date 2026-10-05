#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_DIR="${PI_DIR:-$HOME/.pi}"
PI_AGENT_DIR="$PI_DIR/agent"
BACKUP_DIR="$PI_AGENT_DIR/backups/pi-plus-$(date +%Y%m%d-%H%M%S)"

info() { printf '\033[1;34m[pi-plus]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[pi-plus] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js is required. Install Node.js 22.19 or newer, then rerun this script."
command -v npm >/dev/null 2>&1 || fail "npm is required. Install Node.js 22.19 or newer, then rerun this script."
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 19)) process.exit(1)' || fail "Pi Plus requires Node.js 22.19 or newer."

if ! command -v pi >/dev/null 2>&1; then
  info "Installing Pi coding agent..."
  npm install --global @earendil-works/pi-coding-agent@1.0.2
fi
[[ "$(pi --version)" == "1.0.2" ]] || fail "Pi Plus IDE review requires Pi 1.0.2. Install that version before replacing managed files."

mkdir -p "$PI_AGENT_DIR/extensions" "$PI_AGENT_DIR/skills" "$PI_AGENT_DIR/npm"

# Back up files this installer manages. Credentials (auth.json, mcp-auth.json)
# and session history are deliberately not touched or copied into this repo.
for file in settings.json models.json; do
  if [[ -f "$PI_AGENT_DIR/$file" ]]; then
    mkdir -p "$BACKUP_DIR"
    cp "$PI_AGENT_DIR/$file" "$BACKUP_DIR/$file"
  fi
done

cp "$REPO_DIR/config/settings.json" "$PI_AGENT_DIR/settings.json"
cp "$REPO_DIR/config/models.json" "$PI_AGENT_DIR/models.json"
cp "$REPO_DIR"/extensions/*.ts "$PI_AGENT_DIR/extensions/"
IDE_EXTENSION_DIR="$PI_AGENT_DIR/extensions/jetbrains-ide"
mkdir -p "$IDE_EXTENSION_DIR"
# Remove the obsolete preview adapter deployed by earlier Pi+ versions.
rm -f "$IDE_EXTENSION_DIR/preview.ts"
cp "$REPO_DIR"/extensions/jetbrains-ide/*.ts \
  "$REPO_DIR"/extensions/jetbrains-ide/package*.json \
  "$REPO_DIR"/extensions/jetbrains-ide/README.md "$IDE_EXTENSION_DIR/"
(cd "$IDE_EXTENSION_DIR" && npm ci --omit=dev --omit=peer --ignore-scripts)
if [[ -d "$REPO_DIR/skills" ]]; then
  while IFS= read -r -d '' skill; do
    relative="${skill#"$REPO_DIR/skills/"}"
    mkdir -p "$PI_AGENT_DIR/skills/$(dirname "$relative")"
    cp -R "$skill" "$PI_AGENT_DIR/skills/$relative"
  done < <(find "$REPO_DIR/skills" -mindepth 1 -maxdepth 1 -print0)
fi

info "Installing pinned Pi packages..."
cp "$REPO_DIR/package.json" "$REPO_DIR/package-lock.json" "$PI_AGENT_DIR/npm/"
(cd "$PI_AGENT_DIR/npm" && npm ci --omit=dev)

if [[ -n "${BACKUP_DIR:-}" && -d "$BACKUP_DIR" ]]; then
  info "Previous settings backed up to $BACKUP_DIR"
fi
info "Pi Plus is installed. Run 'pi' and authenticate your model providers on this machine."
