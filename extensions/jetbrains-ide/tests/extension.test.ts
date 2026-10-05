import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import jetbrainsIde from "../index.ts";

test("factory wraps native edit/write and registers context, edit-mode and legacy-tool gate", async () => {
  const commands = new Map<string, any>(), handlers = new Map<string, any>(), tools = new Map<string, any>(), notices: string[] = [];
  const pi = { registerCommand: (name: string, command: unknown) => commands.set(name, command),
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool), on: (name: string, handler: unknown) => handlers.set(name, handler),
  } as unknown as ExtensionAPI;
  jetbrainsIde(pi);
  assert.deepEqual([...tools.keys()], ["edit", "write", "ide_context"]);
  assert.ok(!tools.has("ide_diff")); assert.ok(!commands.has("plan"));
  assert.ok(!handlers.has("tool_result")); assert.ok(!handlers.has("turn_end"));
  const ctx = { cwd: "/not-a-real-directory", ui: { notify: (text: string) => notices.push(text), setStatus: () => {} } };
  await commands.get("edit-mode").handler("", ctx); assert.match(notices.at(-1)!, /Edit mode: review/);
  for (const toolName of ["replace", "replace_within", "insert", "copy", "move", "undo_last_change"]) {
    assert.equal(handlers.get("tool_call")({ toolName }, ctx).block, true);
  }
  for (const toolName of ["edit", "write", "read", "bash"]) assert.equal(handlers.get("tool_call")({ toolName }, ctx), undefined);
  await commands.get("edit-mode").handler("auto", ctx); assert.match(notices.at(-1)!, /Edit mode: auto/);
  assert.equal(handlers.get("tool_call")({ toolName: "replace" }, ctx), undefined);
  await commands.get("edit-mode").handler("invalid", ctx); assert.match(notices.at(-1)!, /Usage/);
  await commands.get("edit-mode").handler("", ctx); assert.match(notices.at(-1)!, /Edit mode: auto/);
  handlers.get("session_start")({}, ctx);
  await commands.get("edit-mode").handler("", ctx); assert.match(notices.at(-1)!, /Edit mode: review/);
});
