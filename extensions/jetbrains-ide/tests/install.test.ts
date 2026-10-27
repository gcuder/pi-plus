import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("installer and doctor accept any Pi version", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-version-any-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "pi"), "#!/bin/sh\nprintf '9.9.9\\n'\n", { mode: 0o755 });
  const env = { ...process.env, PI_DIR: dir, PATH: `${bin}:${process.env.PATH}` };
  const install = await readFile(fileURLToPath(new URL("../../../scripts/install.sh", import.meta.url)), "utf8");
  assert.doesNotMatch(install, /pi --version|pi-coding-agent@/);
  const doctor = spawnSync("bash", [fileURLToPath(new URL("../../../scripts/doctor.sh", import.meta.url))], { env, encoding: "utf8" });
  assert.match(doctor.stdout, /INFO Pi version: 9\.9\.9/); assert.doesNotMatch(doctor.stdout, /FAIL.*version/i);
});
