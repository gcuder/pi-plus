import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import jetbrainsIde from "../index.ts";
import { previewMutation } from "../preview.ts";

test("factory registers automatic lifecycle gate and edit-mode commands, no ide_diff or editing tool overrides", async () => {
  const commands = new Map<string, any>(), handlers = new Map<string, any>(), tools: string[] = [], notices: string[] = [];
  const pi = { registerCommand: (name: string, command: unknown) => commands.set(name, command),
    registerTool: (tool: { name: string }) => tools.push(tool.name), on: (name: string, handler: unknown) => handlers.set(name, handler),
    events: { emit: () => {} } } as unknown as ExtensionAPI;
  jetbrainsIde(pi);
  assert.deepEqual(tools, ["ide_context"]); assert.ok(handlers.has("tool_call"));
  assert.ok(!commands.has("plan")); assert.ok(commands.has("edit-mode"));
  const ctx = { cwd: "/not-a-real-directory", ui: { notify: (text: string) => notices.push(text), setStatus: () => {} } };
  await commands.get("edit-mode").handler("", ctx); assert.match(notices.at(-1)!, /Edit mode: review/);
  await commands.get("edit-mode").handler("auto", ctx); assert.match(notices.at(-1)!, /Edit mode: auto/);
  assert.equal(await handlers.get("tool_call")({ toolName: "replace", toolCallId: "normal", input: {} }, ctx), undefined);
  await commands.get("edit-mode").handler("invalid", ctx); assert.match(notices.at(-1)!, /Usage/);
  await commands.get("edit-mode").handler("", ctx); assert.match(notices.at(-1)!, /Edit mode: auto/);
  await commands.get("edit-mode").handler("review", ctx); assert.match(notices.at(-1)!, /Edit mode: review/);
});

test("write preview uses Pi's actual write definition with inert I/O, including @ normalization and new parents", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-write-preview-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "file.txt"); await writeFile(path, "before");
  const pi = {} as ExtensionAPI, ctx = { cwd } as ExtensionContext;
  const call = (p: string) => ({ type: "tool_call", toolCallId: "write", toolName: "write", input: { path: p, content: "after" } }) as ToolCallEvent;
  const preview = await previewMutation(pi, call("@file.txt"), ctx);
  assert.deepEqual(preview.files, [{ path, originalContent: "before", proposedContent: "after" }]);
  assert.equal(await readFile(path, "utf8"), "before");
  const created = await previewMutation(pi, call("new/sub/file.txt"), ctx);
  assert.equal(created.files[0].originalContent, undefined);
  await assert.rejects(access(join(cwd, "new")), /ENOENT/);
});

test("missing hashline adapter fails closed instead of guessing anchor ownership", async () => {
  const pi = { events: { emit: () => {} } } as unknown as ExtensionAPI;
  const call = { type: "tool_call", toolName: "replace", toolCallId: "normal", input: { remove_from: "Abcd", remove_to: "Abcd", replacement_lines: "new" } } as ToolCallEvent;
  await assert.rejects(previewMutation(pi, call, { cwd: "/unused" } as ExtensionContext), /adapter unavailable/);
});
