import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../../../node_modules/pi-hashline-edit-pro/", import.meta.url));
const installer = fileURLToPath(new URL("../../../scripts/patch-hashline.mjs", import.meta.url));
const patch = fileURLToPath(new URL("../hashline-5.1.0.patch", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../hashline-patch.json", import.meta.url), "utf8"));
const hash = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
const run = (path: string, check = false) => spawnSync(process.execPath, [installer, path, ...(check ? ["--check"] : [])], { encoding: "utf8" });
async function clone(t: { after: (fn: () => Promise<unknown>) => void }) {
  const path = await mkdtemp(join(tmpdir(), "pi-patch-test-")); t.after(() => rm(path, { recursive: true, force: true }));
  await cp(root, path, { recursive: true }); return path;
}

test("adapter patch applies to pristine audited package, verifies every hash, is idempotent; --check never patches", async (t) => {
  const path = await clone(t);
  const reversed = spawnSync("patch", ["-R", "-p1", "--batch", "-i", patch], { cwd: path, encoding: "utf8" });
  assert.equal(reversed.status, 0, reversed.stderr + reversed.stdout);
  assert.notEqual(run(path, true).status, 0);
  assert.equal(await hash(join(path, "index.ts")), manifest.files["index.ts"].before);
  const installed = run(path); assert.equal(installed.status, 0, installed.stderr + installed.stdout);
  for (const [name, expected] of Object.entries(manifest.files) as [string, { after: string }][]) assert.equal(await hash(join(path, name)), expected.after);
  assert.match(run(path).stdout, /already installed/);
  assert.equal(run(path, true).status, 0);
});

test("adapter installer refuses unknown versions and altered sources without changing other files", async (t) => {
  const path = await clone(t), indexHash = await hash(join(path, "index.ts"));
  const packagePath = join(path, "package.json"), original = await readFile(packagePath, "utf8");
  await writeFile(packagePath, JSON.stringify({ ...JSON.parse(original), version: "5.2.0" }));
  const wrongVersion = run(path); assert.notEqual(wrongVersion.status, 0); assert.match(wrongVersion.stderr, /requires pi-hashline-edit-pro 5.1.0/);
  assert.equal(await hash(join(path, "index.ts")), indexHash);
  await writeFile(packagePath, original);
  const source = join(path, "src/replace.ts"); await writeFile(source, (await readFile(source, "utf8")) + "\n// altered\n");
  const alteredHash = await hash(source), refused = run(path);
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /sources differ/);
  assert.equal(await hash(source), alteredHash); assert.equal(await hash(join(path, "index.ts")), indexHash);
});
