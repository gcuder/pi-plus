# Pi Plus

A version-controlled, portable setup for reproducing this Pi coding-agent configuration on another machine. The installer configures Pi's user-level agent directory (`~/.pi/agent`) with the tracked settings, models file, extensions, skills, and pinned npm packages.

## Quick install

Requirements: Node.js 22.19+ (with npm), Git, and a supported OS. Then:

```sh
git clone git@github.com:gcuder/pi-plus.git
cd pi-plus
./scripts/install.sh
```

Or, after cloning, run `./scripts/doctor.sh` to check the setup. Authenticate your model providers on the new machine using Pi's normal login flow; credentials are intentionally not included or copied. If Pi is not installed, the installer installs Pi 1.0.2.

## What is included

- `config/settings.json`: Pi packages and Titanium theme selection.
- `config/models.json`: custom model/provider configuration (currently empty).
- `extensions/`: local Orca integration extensions currently used by this setup.
- `skills/`: place any Pi skills here; they are installed into `~/.pi/agent/skills`.
- `package.json` / `package-lock.json`: locked runtime extensions, themes, and package integrations.
- `scripts/install.sh`: installs Pi when absent, backs up managed settings, installs packages, and deploys the repository configuration.
- `scripts/update.sh`: fast-forward pulls this checkout, then reinstalls it.
- `scripts/doctor.sh`: validates the local install.

The settings and model config are managed files and will be replaced by `install.sh` (the existing versions are backed up under `~/.pi/agent/backups/`). Extension files are copied into the Pi agent directory; files not tracked here are left untouched. `PI_DIR` can be set to use a different Pi data root.

## Keep it in sync

Edit the repository files, commit and push the changes, then run `./scripts/install.sh` on each machine. For updates on a cloned machine:

```sh
./scripts/update.sh
```

To add or upgrade a package, edit `package.json` and regenerate the lock file with `npm install --package-lock-only`, then add its `npm:<package-name>` entry to `config/settings.json` when Pi should load it. Commit both manifests. Local extension source should live in `extensions/`; skills should be organized as directories under `skills/`.

## Security and portability

This repository does **not** contain `auth.json`, `mcp-auth.json`, model API keys, device IDs, session transcripts, caches, or machine-specific credentials. Authenticate separately on every machine. Review changes to extensions and npm dependencies before installing; Pi extensions run as code in the agent process.

## GitHub

Repository: <https://github.com/gcuder/pi-plus>
