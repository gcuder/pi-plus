import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { EditReview } from "../review.ts";
import { IdeProtocol } from "../protocol.ts";
import { previewMutation as requestPreview, REJECT_EVENT } from "../preview.ts";

// Test the installed, audited package, not a reimplementation of its algorithms.
const state = await mkdtemp(join(tmpdir(), "pi-hashline-adapter-test-"));
process.env.PI_HASHLINE_DIR = join(state, "config");
after(() => rm(state, { recursive: true, force: true }));
const jiti = createJiti(import.meta.url, { fsCache: false, tryNative: false });
const root = fileURLToPath(new URL("../../../node_modules/pi-hashline-edit-pro/", import.meta.url));
const hashline: any = await jiti.import(join(root, "index.ts"));
const api: any = await jiti.import(join(root, "src/review-preview.ts"));
const undo: any = await jiti.import(join(root, "src/replace-undo.ts"));

async function fixture() {
  const cwd = join(state, randomUUID()); await mkdir(cwd);
  const path = join(cwd, "file.txt"); await writeFile(path, "\ufeffone\r\ntwo\r\nthree\r\n");
  const tools = new Map<string, any>(), handlers = new Map<string, any[]>(), bus = new Map<string, any[]>();
  let active = ["read", "write", "edit", "replace", "replace_within", "insert", "copy", "move", "undo_last_change"];
  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: () => {},
    on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    getActiveTools: () => active, setActiveTools: (next: string[]) => { active = next; },
    events: { on: (name: string, handler: any) => bus.set(name, [...(bus.get(name) ?? []), handler]),
      emit: (name: string, data: unknown) => { for (const handler of bus.get(name) ?? []) handler(data); } },
  };
  const sessionId = randomUUID();
  const ctx: any = { cwd, hasUI: false, signal: undefined, sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
    ui: { notify: () => {}, setStatus: () => {} } };
  hashline.default(pi);
  for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
  assert.equal(active.includes("edit"), false, "Installed package disables built-in edit");
  const execute = async (name: string, args: unknown, id: string = randomUUID()) => tools.get(name).execute(id, args, undefined, undefined, ctx);
  const anchors = async (p = path): Promise<string[]> => {
    const result = await execute("read", { path: p });
    return result.content.flatMap((c: any) => String(c.text ?? "").split("\n").flatMap(line => /^([A-Za-z]{4})│/.exec(line)?.[1] ?? []));
  };
  return { cwd, path, pi, ctx, tools, execute, anchors, handlers };
}

test("real hashline previews match ORIGINAL execution for replace / within / insert / same-file copy and move; preserve BOM/CRLF", async () => {
  for (const name of ["replace", "replace_within", "insert", "copy", "move"]) {
    const f = await fixture(); const anchors = await f.anchors();
    const input = name === "replace" ? { remove_from: anchors[1], remove_to: anchors[1], replacement_lines: "TWO" }
      : name === "replace_within" ? { replace_from: anchors[1], replace_to: anchors[1], replace_old: "wo", replace_new: "WO" }
      : name === "insert" ? { anchor: anchors[0], direction: "after", lines: "inserted\n" }
      : { source_from: anchors[0], source_to: anchors[0], insert_after: anchors[2] };
    const before = await readFile(f.path, "utf8");
    const preview = await api.previewMutation(name, "single", input, f.ctx);
    assert.equal(await readFile(f.path, "utf8"), before, `${name} preview must not mutate`);
    assert.equal(await undo.getUndo(f.path), undefined, `${name} preview must not create undo`);
    assert.deepEqual(await f.anchors(), anchors, `${name} preview must not invalidate anchors`);
    const result = await f.execute(name, input, "single"); assert.equal(result.isError, undefined);
    assert.equal(await readFile(f.path, "utf8"), preview.files[0].proposedContent, `${name} preview must match actual hashline commit exactly`);
    assert.ok(preview.files[0].proposedContent.startsWith("\ufeff"));
    assert.ok(preview.files[0].proposedContent.includes("\r\n"));
  }
});

test("byte-identical and ending-only proposals on mixed-ending files match the original commit", async () => {
  for (const replacement of ["two", "two\r\n"]) {
    const f = await fixture();
    await writeFile(f.path, "\ufeffone\r\ntwo\nthree\r");
    const anchors = await f.anchors();
    const input = { remove_from: anchors[1], remove_to: anchors[1], replacement_lines: replacement };
    const before = await readFile(f.path, "utf8");
    const preview = await api.previewMutation("replace", "mixed", input, f.ctx);
    assert.equal(await readFile(f.path, "utf8"), before);
    await f.execute("replace", input, "mixed");
    assert.equal(await readFile(f.path, "utf8"), preview.files[0].proposedContent);
    if (replacement === "two") assert.equal(preview.files[0].proposedContent, before);
  }
});

test("cross-file copy/move reuse actual transfer preparation, empty destinations, and read dependencies", async () => {
  for (const name of ["copy", "move"]) {
    const f = await fixture(); const source = await f.anchors();
    const destination = join(f.cwd, "destination.txt"); await writeFile(destination, "");
    const dest = await f.anchors(destination);
    const input = { source_from: source[0], source_to: source[1], insert_after: dest[0] };
    const before = await readFile(f.path, "utf8");
    const preview = await api.previewMutation(name, "cross", input, f.ctx);
    assert.equal(preview.files.length, 2, "Includes source even for non-mutating copy dependency");
    assert.equal(await readFile(f.path, "utf8"), before); assert.equal(await readFile(destination, "utf8"), "");
    await f.execute(name, input, "cross");
    for (const file of preview.files) assert.equal(await readFile(file.path, "utf8"), file.proposedContent, `${name}: ${file.path}`);
  }
});

test("automatic tool_call gate uses actual hashline adapter: Reject executes nothing, Accept runs original tool", async () => {
  const f = await fixture(), anchors = await f.anchors();
  const call: any = { type: "tool_call", toolName: "replace_within", toolCallId: "normal-call",
    input: { replace_from: anchors[0], replace_to: anchors[0], replace_old: "one", replace_new: "ONE" } };
  const before = await readFile(f.path, "utf8"); let accepted = false, executions = 0;
  const ide = new IdeProtocol(); Object.defineProperty(ide.connection, "connected", { get: () => true }); ide.closeTab = async () => {};
  ide.openDiff = async (_path, contents) => {
    assert.equal(await readFile(f.path, "utf8"), before); assert.equal(executions, 0);
    return accepted ? { accepted: true, contents } : { accepted: false };
  };
  const gate = new EditReview({ preview: (e, ctx) => requestPreview(f.pi, e, ctx), connect: async () => ide,
    reject: (toolCallId, reason) => f.pi.events.emit(REJECT_EVENT, { toolCallId, reason }) });
  assert.equal((await gate.handle(call, f.ctx))?.block, true);
  assert.equal(await readFile(f.path, "utf8"), before); assert.equal(await undo.getUndo(f.path), undefined);
  accepted = true;
  assert.equal(await gate.handle(call, f.ctx), undefined);
  executions++; await f.execute(call.toolName, call.input, call.toolCallId);
  assert.ok((await readFile(f.path, "utf8")).includes("ONE")); assert.equal(executions, 1);
});

test("combined same-file batch is previewed before ANY mutation and retains one original commit/undo", async () => {
  const f = await fixture(), anchors = await f.anchors();
  const calls = [
    { id: "batch-first", name: "replace", arguments: { remove_from: anchors[0], remove_to: anchors[0], replacement_lines: "ONE" } },
    { id: "batch-last", name: "insert", arguments: { anchor: anchors[2], direction: "before", lines: "inserted\n" } },
  ];
  for (const handler of f.handlers.get("message_end") ?? []) await handler({ message: { role: "assistant", content: calls.map(c => ({ type: "toolCall", ...c })) } }, f.ctx);
  const before = await readFile(f.path, "utf8");
  const preview = await api.previewMutation("replace", calls[0].id, calls[0].arguments, f.ctx);
  assert.deepEqual(preview.ids, calls.map(c => c.id)); assert.equal(await readFile(f.path, "utf8"), before);
  const first = await f.execute("replace", calls[0].arguments, calls[0].id);
  assert.equal(first.details.batch.last, false); assert.equal(await readFile(f.path, "utf8"), before);
  const last = await f.execute("insert", calls[1].arguments, calls[1].id);
  assert.equal(last.details.batch.last, true);
  assert.equal(await readFile(f.path, "utf8"), preview.files[0].proposedContent);
  await f.execute("undo_last_change", { path: f.path });
  assert.equal(await readFile(f.path, "utf8"), before);
});

test("opposite insert pair batch uses upstream merge/composition and matches preview exactly", async () => {
  const f = await fixture(), anchors = await f.anchors();
  const calls = ["before", "after"].map((direction, i) => ({ id: `pair-${i}`, name: "insert", arguments: { anchor: anchors[1], direction, lines: `${direction}\n` } }));
  for (const handler of f.handlers.get("message_end") ?? []) await handler({ message: { role: "assistant", content: calls.map(c => ({ type: "toolCall", ...c })) } }, f.ctx);
  const preview = await api.previewMutation("insert", calls[0].id, calls[0].arguments, f.ctx);
  await f.execute("insert", calls[0].arguments, calls[0].id);
  await f.execute("insert", calls[1].arguments, calls[1].id);
  assert.equal(await readFile(f.path, "utf8"), preview.files[0].proposedContent);
});

test("rejecting an already-staged batch aborts all remaining original members without mutation", async () => {
  const f = await fixture(), anchors = await f.anchors();
  const calls = [0, 2].map((line, i) => ({ id: `reject-batch-${i}`, name: "replace", arguments: { remove_from: anchors[line], remove_to: anchors[line], replacement_lines: `replacement-${i}` } }));
  for (const handler of f.handlers.get("message_end") ?? []) await handler({ message: { role: "assistant", content: calls.map(c => ({ type: "toolCall", ...c })) } }, f.ctx);
  const before = await readFile(f.path, "utf8");
  await f.execute("replace", calls[0].arguments, calls[0].id);
  f.pi.events.emit(REJECT_EVENT, { toolCallId: calls[1].id, reason: "User rejected IDE review" });
  await assert.rejects(f.execute("replace", calls[1].arguments, calls[1].id), /aborted/);
  assert.equal(await readFile(f.path, "utf8"), before); assert.equal(await undo.getUndo(f.path), undefined);
});

test("undo preview reuses recorded exact bytes and refuses stale history without reverting", async () => {
  const f = await fixture(), anchors = await f.anchors(); const before = await readFile(f.path, "utf8");
  await f.execute("replace", { remove_from: anchors[0], remove_to: anchors[0], replacement_lines: "ONE" });
  const current = await readFile(f.path, "utf8");
  const preview = await api.previewMutation("undo_last_change", "undo", { path: f.path }, f.ctx);
  assert.equal(preview.files[0].proposedContent, before); assert.equal(await readFile(f.path, "utf8"), current);
  await writeFile(f.path, "external");
  await assert.rejects(api.previewMutation("undo_last_change", "undo", { path: f.path }, f.ctx), /E_UNDO_STALE/);
  assert.equal(await readFile(f.path, "utf8"), "external");
});
