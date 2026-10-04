#!/usr/bin/env node
// Version- and content-guarded local adapter. No patching occurs inside Pi.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(process.argv[2] ?? resolve(repo, "node_modules/pi-hashline-edit-pro"));
const patch = resolve(repo, "extensions/jetbrains-ide/hashline-5.1.0.patch");
const manifest = JSON.parse(await readFile(resolve(repo, "extensions/jetbrains-ide/hashline-patch.json"), "utf8"));
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (pkg.name !== "pi-hashline-edit-pro" || pkg.version !== manifest.version) {
  throw new Error(`Hashline adapter requires pi-hashline-edit-pro ${manifest.version}; found ${pkg.name} ${pkg.version}. No sources changed.`);
}
const digest = async file => {
  try { return createHash("sha256").update(await readFile(resolve(root, file))).digest("hex"); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
};
const actual = Object.fromEntries(await Promise.all(Object.keys(manifest.files).map(async file => [file, await digest(file)])));
const matches = kind => Object.entries(manifest.files).every(([file, expected]) => actual[file] === expected[kind]);
if (matches("after")) {
  console.log("Hashline 5.1.0 read-only preview adapter already installed");
} else {
  if (process.argv[3] === "--check") throw new Error("Hashline preview adapter is missing or altered. Re-run scripts/install.sh before using Review mode.");
  if (!matches("before")) throw new Error("Hashline sources differ from the audited 5.1.0 package. No patch applied. Restore with npm ci or port/review the adapter; do not force this patch.");
  const result = spawnSync("patch", ["-p1", "--batch", "-i", patch], { cwd: root, stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error("Could not install hashline preview adapter. Install the patch utility, restore with npm ci and retry.");
  for (const [file, expected] of Object.entries(manifest.files)) {
    if (await digest(file) !== expected.after) throw new Error("Hashline patch verification failed. Restore with npm ci before loading Pi.");
  }
  console.log("Installed hashline 5.1.0 read-only preview adapter; restart/reload Pi");
}
