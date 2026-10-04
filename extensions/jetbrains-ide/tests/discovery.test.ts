import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover, parseLock, pidAlive, portListening, workspaceScore } from "../discovery.ts";
import { createServer } from "node:net";

const lock = { workspaceFolders: ["/repo"], pid: process.pid, ideName: "PyCharm", transport: "ws", runningInWindows: false, authToken: "test-only-token" };

test("current lock format takes port only from filename and rejects malformed/unsupported locks", () => {
  assert.equal(parseLock("12345.lock", JSON.stringify({ ...lock, port: 9999, url: "wss://remote" }))?.port, 12345);
  for (const name of ["0.lock", "65536.lock", "12junk.lock", "abc.lock"]) assert.equal(parseLock(name, JSON.stringify(lock)), undefined);
  for (const patch of [{ pid: -1 }, { pid: 1.5 }, { authToken: "" }, { authToken: "bad\nheader" }, { transport: "sse" }, { runningInWindows: true }, { ideName: "Visual Studio Code" }, { workspaceFolders: ["relative"] }, { workspaceFolders: [123] }]) {
    assert.equal(parseLock("12345.lock", JSON.stringify({ ...lock, ...patch })), undefined);
  }
  assert.equal(parseLock("12345.lock", "not json"), undefined);
  assert.equal(parseLock("12345.lock", "null"), undefined);
});

test("workspace matching respects boundaries and prefers exact / deepest ancestor / nearest descendant", () => {
  assert.equal(workspaceScore(["/repo"], "/repo-other"), 0);
  assert.equal(workspaceScore(["/else"], "/repo"), 0);
  assert.ok(workspaceScore(["/repo"], "/repo") > workspaceScore(["/"], "/repo"));
  assert.ok(workspaceScore(["/repo"], "/repo/sub") > workspaceScore(["/"], "/repo/sub"));
  assert.ok(workspaceScore(["/repo"], "/repo/sub") > workspaceScore(["/repo/sub/child"], "/repo/sub"));
  assert.ok(workspaceScore(["/repo/a"], "/repo") > workspaceScore(["/repo/a/deep"], "/repo"));
});

test("discovery filters dead PID / closed ports and ranks multiple instances, resolving symlinks", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ide-discovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo"); await mkdir(repo);
  await symlink(repo, join(dir, "alias"));
  const put = (port: number, folders: string[], pid = 1) => writeFile(join(dir, `${port}.lock`), JSON.stringify({ ...lock, pid, workspaceFolders: folders }));
  await put(10001, [dir]); await put(10002, [repo], 2); await put(10003, [repo]);
  await put(10004, [repo], 4); await put(10005, ["/unrelated"]);
  await writeFile(join(dir, "10006.lock"), "broken");
  const matches = await discover(join(dir, "alias"), { dir, isAlive: p => p !== 2, isListening: async p => p !== 10004 });
  assert.deepEqual(matches.map(i => i.port), [10003, 10001]);
  assert.equal((await discover(repo, { dir: join(dir, "missing") })).length, 0);
});

test("actual PID and local port probes detect liveness", async () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(2147483647), false);
  const server = createServer();
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  assert.equal(await portListening(port), true);
  await new Promise<void>(r => server.close(() => r()));
  assert.equal(await portListening(port), false);
});
