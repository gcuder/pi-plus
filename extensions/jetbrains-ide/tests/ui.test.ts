import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import jetbrainsIde from "../index.ts";
import { IdeProtocol, PROTOCOL_VERSION } from "../protocol.ts";

function fixture(cwd = "/not-a-real-directory") {
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const shortcuts = new Map<string, Parameters<ExtensionAPI["registerShortcut"]>[1]>();
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, ((...args: any[]) => any)[]>();
  const statuses = new Map<string, string>(), notices: string[] = [];
  const ctx = { cwd, hasUI: true, mode: "tui", ui: {
    notify: (text: string) => notices.push(text),
    setStatus: (key: string, text: string | undefined) => {
      if (text === undefined) statuses.delete(key); else statuses.set(key, text);
    },
  } } as unknown as ExtensionCommandContext & ExtensionToolContext;
  const pi = {
    registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) => commands.set(name, command),
    registerShortcut: (key: string, shortcut: Parameters<ExtensionAPI["registerShortcut"]>[1]) => shortcuts.set(key, shortcut),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
    getAllTools: () => [...tools.values()],
  } as unknown as ExtensionAPI;
  const emit = async (event: string) => { for (const handler of handlers.get(event) ?? []) await handler({}, ctx); };
  jetbrainsIde(pi);
  return { commands, shortcuts, tools, statuses, notices, ctx, emit,
    command: (args: string) => commands.get("edit-mode")!.handler(args, ctx),
    toggle: () => shortcuts.get("ctrl+q")!.handler(ctx),
  };
}

test("session starts with a persistent REVIEW indicator and no connection", async t => {
  const connect = t.mock.method(IdeProtocol.prototype, "connect", async () => assert.fail("Eager IDE connection"));
  const f = fixture();
  assert.deepEqual([...f.shortcuts.keys()], ["ctrl+q"]);
  assert.match(f.shortcuts.get("ctrl+q")!.description!, /Review\/Auto/);
  await f.emit("session_start");
  assert.equal(f.statuses.get("edit-mode"), "REVIEW");
  assert.equal(f.statuses.get("jetbrains-ide"), "IDE: disconnected");
  assert.deepEqual(f.notices, []);
  await f.toggle(); await f.command("review"); await f.command("");
  await f.commands.get("ide")!.handler("status", f.ctx);
  assert.equal(connect.mock.callCount(), 0);
  await f.emit("session_shutdown");
});

test("shortcut toggles Review to Auto and Auto to Review, updating status immediately", async () => {
  const f = fixture(); await f.emit("session_start");
  await f.toggle();
  assert.equal(f.statuses.get("edit-mode"), "AUTO");
  assert.equal(f.notices.at(-1), "Edit mode: AUTO");
  await f.command(""); assert.match(f.notices.at(-1)!, /Edit mode: auto/);
  await f.toggle();
  assert.equal(f.statuses.get("edit-mode"), "REVIEW");
  assert.equal(f.notices.at(-1), "Edit mode: REVIEW");
  await f.command(""); assert.match(f.notices.at(-1)!, /Edit mode: review/);
});

test("command and shortcut share policy and status without replacing Plan Mode status", async () => {
  const f = fixture(); await f.emit("session_start");
  f.statuses.set("plan-mode", "PLAN");
  await f.command("auto"); assert.equal(f.statuses.get("edit-mode"), "AUTO");
  await f.toggle(); assert.equal(f.statuses.get("edit-mode"), "REVIEW");
  await f.command("auto"); await f.command("review");
  assert.equal(f.statuses.get("edit-mode"), "REVIEW");
  await f.toggle(); assert.equal(f.statuses.get("edit-mode"), "AUTO");
  const before = new Map(f.statuses);
  await f.command("invalid"); assert.deepEqual(f.statuses, before);
  await f.emit("session_start"); assert.equal(f.statuses.get("edit-mode"), "REVIEW");
  assert.equal(f.statuses.get("plan-mode"), "PLAN");
});

test("shortcut switching to Auto cancels active and queued native reviews, never approving them", { timeout: 10_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-edit-ui-"));
  const home = process.env.HOME;
  process.env.HOME = cwd;
  t.after(async () => {
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    await rm(cwd, { recursive: true, force: true });
  });
  const transport = createServer();
  const server = new WebSocketServer({ server: transport });
  let connections = 0; transport.on("connection", () => connections++);
  transport.listen(0, "127.0.0.1"); await once(transport, "listening");
  t.after(() => new Promise<void>(resolve => {
    for (const client of server.clients) client.terminate();
    server.close(() => transport.close(() => resolve()));
  }));
  const port = (transport.address() as { port: number }).port;
  const lockDir = join(cwd, ".claude", "ide"); await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, `${port}.lock`), JSON.stringify({
    pid: process.pid, workspaceFolders: [cwd], ideName: "PyCharm", transport: "ws", authToken: "test-only-token",
  }));
  let opened = 0, cancelled = 0;
  let cancellationReceived!: () => void;
  const cancellation = new Promise<void>(resolve => { cancellationReceived = resolve; });
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  server.on("connection", socket => socket.on("message", raw => {
    const message = JSON.parse(raw.toString());
    const reply = (result: unknown) => socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "initialize") reply({ protocolVersion: PROTOCOL_VERSION,
      serverInfo: { name: "Claude Code JetBrains Plugin", version: "0.1.14-beta" } });
    if (message.method === "tools/list") reply({ tools: [
      { name: "openDiff", inputSchema: { properties: { old_file_path: {}, new_file_path: {}, new_file_contents: {}, tab_name: {} } } },
      { name: "close_tab" },
    ] });
    if (message.method === "tools/call" && message.params.name === "openDiff") { opened++; started(); }
    if (message.method === "tools/call" && message.params.name === "close_tab") reply({ content: [] });
    if (message.method === "notifications/cancelled") { cancelled++; cancellationReceived(); }
  }));
  const f = fixture(cwd); await f.emit("session_start");
  t.after(() => f.emit("session_shutdown"));
  await f.command(""); await f.toggle(); await f.toggle();
  await f.commands.get("ide")!.handler("status", f.ctx);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(connections, 0, "Status and toggles must not even probe a live matching IDE");
  const path = join(cwd, "file.txt"); await writeFile(path, "before\n");
  const edit = f.tools.get("edit")!;
  const first = edit.execute("first", { path, edits: [{ oldText: "before", newText: "after" }] }, undefined, undefined, f.ctx);
  const firstRejected = assert.rejects(first, /cancelled|aborted/i);
  await ready;
  assert.equal(f.statuses.get("jetbrains-ide"), "IDE: PyCharm");
  const second = edit.execute("second", { path, edits: [{ oldText: "before", newText: "queued" }] }, undefined, undefined, f.ctx);
  const secondRejected = assert.rejects(second, /cancelled|aborted/i);
  await f.toggle();
  assert.equal(f.statuses.get("edit-mode"), "AUTO");
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(await readFile(path, "utf8"), "before\n");
  assert.equal(opened, 1);
  await cancellation;
  assert.equal(cancelled, 1);
  await edit.execute("auto", { path, edits: [{ oldText: "before", newText: "auto" }] }, undefined, undefined, f.ctx);
  assert.equal(await readFile(path, "utf8"), "auto\n");
  assert.equal(opened, 1);
  await f.commands.get("ide")!.handler("disconnect", f.ctx);
  assert.equal(f.statuses.get("jetbrains-ide"), "IDE: disconnected");
  assert.equal(f.statuses.get("edit-mode"), "AUTO");
});
