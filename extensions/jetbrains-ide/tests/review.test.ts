import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { EditReview, MUTATION_TOOLS } from "../review.ts";
import { IdeProtocol } from "../protocol.ts";

const event = (name: string, id = "call") => ({ type: "tool_call", toolName: name, toolCallId: id, input: { original: "unchanged" } }) as ToolCallEvent;
async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-auto-review-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "file.txt"); await writeFile(path, "before");
  const ctx = { cwd } as ExtensionContext;
  const ide = new IdeProtocol(); Object.defineProperty(ide.connection, "connected", { get: () => true });
  ide.closeTab = async () => {};
  const file = { path, originalContent: "before", proposedContent: "after" };
  return { cwd, path, ctx, ide, file };
}

test("default Review gates EVERY installed mutation tool before original execution", async (t) => {
  const { path, ctx, ide, file } = await fixture(t);
  let executions = 0, previews = 0, reviews = 0;
  ide.openDiff = async (_path, contents) => {
    reviews++; assert.equal(await readFile(path, "utf8"), "before"); assert.equal(executions, 0);
    return { accepted: true, contents };
  };
  const gate = new EditReview({ preview: async e => { previews++; return { ids: [e.toolCallId], files: [file] }; }, connect: async () => ide, reject: () => assert.fail("Unexpected rejection") });
  assert.equal(gate.editMode, "review");
  for (const name of MUTATION_TOOLS) {
    const call = event(name);
    const originalInput = JSON.stringify(call.input);
    const decision = await gate.handle(call, ctx);
    assert.equal(decision, undefined); assert.equal(JSON.stringify(call.input), originalInput);
    // Harness executes the ORIGINAL tool only after the lifecycle decision.
    executions++; await writeFile(path, "after");
    assert.equal(await readFile(path, "utf8"), "after");
    executions = 0; await writeFile(path, "before");
  }
  assert.equal(previews, MUTATION_TOOLS.size); assert.equal(reviews, MUTATION_TOOLS.size);
});

test("Reject blocks original execution with no mutate/undo; no IDE fails closed", async (t) => {
  const { path, ctx, ide, file } = await fixture(t); let rejected = 0, executions = 0;
  ide.openDiff = async () => ({ accepted: false });
  const gate = new EditReview({ preview: async () => ({ ids: ["call"], files: [file] }), connect: async () => ide, reject: () => { rejected++; } });
  const decision = await gate.handle(event("replace"), ctx);
  if (!decision?.block) executions++;
  assert.equal(decision?.block, true); assert.match(decision!.reason, /rejected/);
  assert.equal(executions, 0); assert.equal(rejected, 1); assert.equal(await readFile(path, "utf8"), "before");
  const unavailable = new EditReview({ preview: async () => ({ ids: ["call"], files: [file] }), connect: async () => { throw new Error("No matching IDE"); }, reject: () => {} });
  assert.match((await unavailable.handle(event("write"), ctx))!.reason, /No matching IDE/);
});

test("Auto performs ZERO preview, adapter, disk inspection or IDE work", async () => {
  const gate = new EditReview({ preview: async () => assert.fail("Auto previewed"), connect: async () => assert.fail("Auto connected"), reject: () => assert.fail("Auto changed batch behavior") });
  gate.setMode("auto");
  for (const name of MUTATION_TOOLS) {
    assert.equal(await gate.handle(event(name), { cwd: "/does-not-exist" } as ExtensionContext), undefined);
    gate.finished("call", true);
  }
  assert.equal(await gate.handle(event("read"), {} as ExtensionContext), undefined);
});

test("cross-file move requires BOTH approvals before execution; rejecting second changes neither file", async (t) => {
  const { cwd, path, ctx, ide, file } = await fixture(t);
  const second = join(cwd, "second.txt"); await writeFile(second, "destination");
  let reviews = 0;
  ide.openDiff = async (_path, contents) => ++reviews === 1 ? { accepted: true, contents } : { accepted: false };
  const gate = new EditReview({ preview: async () => ({ ids: ["call"], files: [file, { path: second, originalContent: "destination", proposedContent: "moved" }] }), connect: async () => ide, reject: () => {} });
  assert.equal((await gate.handle(event("move"), ctx))?.block, true);
  assert.equal(reviews, 2); assert.equal(await readFile(path, "utf8"), "before"); assert.equal(await readFile(second, "utf8"), "destination");
});

test("changes to copy read dependencies / edited UI proposals block original execution", async (t) => {
  const { cwd, path, ctx, ide, file } = await fixture(t);
  const source = join(cwd, "source.txt"); await writeFile(source, "source");
  ide.openDiff = async (_path, contents) => { await writeFile(source, "changed interior"); return { accepted: true, contents }; };
  const gate = new EditReview({ preview: async () => ({ ids: ["call"], files: [file, { path: source, originalContent: "source", proposedContent: "source" }] }), connect: async () => ide, reject: () => {} });
  assert.match((await gate.handle(event("copy"), ctx))!.reason, /File changed/);
  assert.equal(await readFile(path, "utf8"), "before");
  ide.openDiff = async () => ({ accepted: true, contents: "different UI proposal" });
  const edited = new EditReview({ preview: async () => ({ ids: ["call"], files: [file] }), connect: async () => ide, reject: () => {} });
  assert.match((await edited.handle(event("insert"), ctx))!.reason, /edited in PyCharm/);
});

test("same-file batch approves combined proposal once, then original queued members proceed", async (t) => {
  const { ctx, ide, file } = await fixture(t); let reviews = 0;
  ide.openDiff = async (_path, contents) => { reviews++; return { accepted: true, contents }; };
  const gate = new EditReview({ preview: async () => ({ ids: ["first", "last"], files: [file] }), connect: async () => ide, reject: () => {} });
  assert.equal(await gate.handle(event("replace", "first"), ctx), undefined);
  gate.finished("first", false);
  assert.equal(await gate.handle(event("insert", "last"), ctx), undefined);
  assert.equal(reviews, 1);
  gate.clearApprovals();
  assert.equal(await gate.handle(event("insert", "last"), ctx), undefined);
  assert.equal(reviews, 2);
});

test("mode switch while awaiting review cancels rather than retroactively approving original call", async (t) => {
  const { path, ctx, ide, file } = await fixture(t);
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  ide.openDiff = async (_path, _contents, _tab, signal) => {
    started(); return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("Review cancelled")), { once: true }));
  };
  const gate = new EditReview({ preview: async () => ({ ids: ["call"], files: [file] }), connect: async () => ide, reject: () => {} });
  const pending = gate.handle(event("replace"), ctx); await ready;
  gate.setMode("auto");
  assert.equal((await pending)?.block, true); assert.equal(await readFile(path, "utf8"), "before");
  assert.equal(await gate.handle(event("replace"), ctx), undefined);
});
