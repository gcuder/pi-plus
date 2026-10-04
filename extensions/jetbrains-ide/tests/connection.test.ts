import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Connection, type Socket } from "../connection.ts";
import { IdeProtocol, AUTH_HEADER, PROTOCOL_VERSION } from "../protocol.ts";

class FakeSocket extends EventEmitter implements Socket {
  readyState = 0;
  sent: any[] = [];
  respond?: (message: any) => void;
  send(text: string, callback?: (error?: Error) => void): void {
    const m = JSON.parse(text); this.sent.push(m); callback?.(); this.respond?.(m);
  }
  close(): void { this.readyState = 3; queueMicrotask(() => this.emit("close")); }
  terminate(): void { this.close(); }
  message(m: unknown): void { this.emit("message", JSON.stringify(m)); }
  open(): void { this.readyState = 1; this.emit("open"); }
}
async function connected() {
  const c = new Connection(); const s = new FakeSocket();
  const open = c.open("ws://127.0.0.1:12345/", "mcp", {}, () => s);
  s.open(); await open;
  return { c, s };
}

test("correlates concurrent out-of-order responses, ignores malformed/unknown IDs, sanitizes errors", async (t) => {
  const { c, s } = await connected(); t.after(() => c.close());
  const a = c.request("a"), b = c.request("b");
  s.emit("message", "bad json");
  s.message({ jsonrpc: "2.0", id: 999, result: "unknown" });
  s.message({ jsonrpc: "2.0", id: s.sent[1].id, result: "second" });
  s.message({ jsonrpc: "2.0", id: s.sent[0].id, result: "first" });
  assert.deepEqual(await Promise.all([a, b]), ["first", "second"]);
  const failed = c.request("fail");
  s.message({ jsonrpc: "2.0", id: s.sent.at(-1).id, error: { code: -32603, message: "secret token" } });
  await assert.rejects(failed, { message: "IDE RPC failed (code -32603)" });
});

test("routes notifications and answers server ping requests without confusing client request IDs", async (t) => {
  const { c, s } = await connected(); t.after(() => c.close());
  const seen: unknown[] = []; c.onNotification = (m, p) => seen.push([m, p]);
  const pending = c.request("awaiting");
  s.message({ jsonrpc: "2.0", method: "selection_changed", params: { text: "selection" } });
  s.message({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.deepEqual(s.sent.at(-1), { jsonrpc: "2.0", id: 1, result: {} });
  s.message({ jsonrpc: "2.0", id: 1, result: "done" });
  assert.equal(await pending, "done");
  assert.deepEqual(seen, [["selection_changed", { text: "selection" }]]);
});

test("disconnect rejects pending work once and allows a fresh transport", async () => {
  const { c } = await connected(); let closes = 0; c.onClose = () => closes++;
  const pending = c.request("wait"); c.close(); c.close();
  await assert.rejects(pending, /disconnected/);
  assert.equal(closes, 1); assert.equal(c.connected, false);
  await assert.rejects(c.request("offline"), /not connected/);
  const s = new FakeSocket(); const reopening = c.open("ws://127.0.0.1:12345/", "mcp", {}, () => s);
  s.open(); await reopening; assert.equal(c.connected, true); c.close();
});

test("close or error during upgrade does not hang and never exposes transport secrets", async () => {
  for (const event of ["close", "error"]) {
    const c = new Connection(); const s = new FakeSocket();
    const opening = c.open("ws://127.0.0.1:12345/", "mcp", {}, () => s);
    s.emit(event, new Error("secret"));
    await assert.rejects(opening, e => e instanceof Error && !e.message.includes("secret"));
    assert.equal(c.connected, false);
  }
});

test("request timeouts and aborts cancel only their own requests", async (t) => {
  const { c, s } = await connected(); t.after(() => c.close());
  await assert.rejects(c.request("timeout", {}, { timeout: 1 }), /timed out/);
  const controller = new AbortController();
  const cancelled = c.request("cancel", {}, { signal: controller.signal });
  controller.abort(); await assert.rejects(cancelled, /cancelled/);
  await assert.rejects(c.request("already cancelled", {}, { signal: controller.signal }), /cancelled/);
  assert.equal(s.sent.filter(m => m.method === "notifications/cancelled").length, 2);
  assert.equal(c.connected, true);
});

test("official handshake uses loopback root, mcp subprotocol, authorization and runtime tool list", async (t) => {
  const ide = new IdeProtocol(); const s = new FakeSocket(); t.after(() => ide.close());
  s.respond = m => {
    if (m.method === "initialize") s.message({ jsonrpc: "2.0", id: m.id, result: {
      protocolVersion: PROTOCOL_VERSION, serverInfo: { name: "Claude Code JetBrains Plugin", version: "0.1.14-beta" },
    } });
    if (m.method === "tools/list") s.message({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "getDiagnostics" }] } });
  };
  const opening = ide.connect({ port: 12345, pid: 1, workspaceFolders: ["/repo"], ideName: "PyCharm", authToken: "test-only-token" }, (url, protocol, headers) => {
    assert.equal(url, "ws://127.0.0.1:12345/"); assert.equal(protocol, "mcp");
    assert.deepEqual(headers, { [AUTH_HEADER]: "test-only-token" }); return s;
  });
  s.open(); await opening;
  assert.deepEqual(s.sent.map(m => m.method), ["initialize", "notifications/initialized", "ide_connected", "tools/list"]);
  assert.equal(ide.supports("getDiagnostics"), true);
  await assert.rejects(ide.call("missing"), /does not advertise/);
});

test("wrong protocol/server handshake fails closed", async () => {
  const ide = new IdeProtocol(); const s = new FakeSocket();
  s.respond = m => s.message({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "unsupported" } });
  const opening = ide.connect({ port: 12345, pid: 1, workspaceFolders: [], ideName: "PyCharm", authToken: "test-only-token" }, () => s);
  s.open(); await assert.rejects(opening, /Unsupported/); assert.equal(ide.connection.connected, false);
});
