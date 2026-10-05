import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("installer refuses unsupported Pi before replacing managed settings; doctor reports the version", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-version-guard-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin"), agent = join(dir, "agent");
  await mkdir(bin); await mkdir(agent);
  await writeFile(join(bin, "pi"), "#!/bin/sh\nprintf '1.0.3\\n'\n", { mode: 0o755 });
  const original = '{"custom":"keep"}\n'; await writeFile(join(agent, "settings.json"), original);
  const env = { ...process.env, PI_DIR: dir, PATH: `${bin}:${process.env.PATH}` };
  const install = spawnSync("bash", [fileURLToPath(new URL("../../../scripts/install.sh", import.meta.url))], { env, encoding: "utf8" });
  assert.notEqual(install.status, 0); assert.match(install.stderr, /requires Pi 1.0.2/);
  assert.equal(await readFile(join(agent, "settings.json"), "utf8"), original);
  const doctor = spawnSync("bash", [fileURLToPath(new URL("../../../scripts/doctor.sh", import.meta.url))], { env, encoding: "utf8" });
  assert.notEqual(doctor.status, 0); assert.match(doctor.stdout, /FAIL Supported Pi version/);
});
