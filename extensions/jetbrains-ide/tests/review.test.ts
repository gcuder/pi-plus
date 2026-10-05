import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EditReview } from "../review.ts";
import { IdeProtocol } from "../protocol.ts";

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-auto-review-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "file.txt"); await writeFile(path, "before");
  const ctx = { cwd } as ExtensionContext;
  const ide = new IdeProtocol(); Object.defineProperty(ide.connection, "connected", { get: () => true });
  ide.closeTab = async () => {};
  const file = { path, originalContent: "before", proposedContent: "after" };
  return { path, ctx, ide, file };
}

test("Review approves before commit; Reject and missing IDE leave disk unchanged", async t => {
  const { path, ctx, ide, file } = await fixture(t);
  const review = new EditReview(async () => ide);
  assert.equal(review.editMode, "review");
  ide.openDiff = async () => ({ accepted: false });
  const run = () => review.run(ctx, undefined, async approve => {
    await approve(file); await writeFile(path, "after");
  });
  await assert.rejects(run(), /rejected/);
  assert.equal(await readFile(path, "utf8"), "before");
  const unavailable = new EditReview(async () => { throw new Error("No matching IDE"); });
  await assert.rejects(unavailable.run(ctx, undefined, approve => approve(file)), /No matching IDE/);
  ide.openDiff = async (_path, contents) => {
    assert.equal(await readFile(path, "utf8"), "before"); return { accepted: true, contents };
  };
  await run();
  assert.equal(await readFile(path, "utf8"), "after");
});

test("changed disk content and edited UI proposals fail closed", async t => {
  const { path, ctx, ide, file } = await fixture(t);
  const review = new EditReview(async () => ide);
  ide.openDiff = async (_path, contents) => {
    await writeFile(path, "external change"); return { accepted: true, contents };
  };
  await assert.rejects(review.run(ctx, undefined, approve => approve(file)), /File changed/);
  await writeFile(path, "before");
  ide.openDiff = async () => ({ accepted: true, contents: "UI change" });
  await assert.rejects(review.run(ctx, undefined, approve => approve(file)), /edited in PyCharm/);
  assert.equal(await readFile(path, "utf8"), "before");
});

for (const cancel of ["mode", "disconnect", "abort"] as const) {
  test(`${cancel} cancels active and queued reviews without approval`, async t => {
    const { path, ctx, ide, file } = await fixture(t);
    const review = new EditReview(async () => ide), controller = new AbortController();
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    ide.openDiff = async (_path, _contents, _tab, signal) => {
      started(); return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("Review cancelled")), { once: true }));
    };
    const first = review.run(ctx, controller.signal, approve => approve(file));
    const firstRejected = assert.rejects(first, /cancelled/);
    await ready;
    const second = review.run(ctx, controller.signal, approve => approve(file));
    const secondRejected = assert.rejects(second, /cancelled/);
    if (cancel === "mode") review.setMode("auto");
    else if (cancel === "disconnect") review.cancelPending();
    else controller.abort();
    await Promise.all([firstRejected, secondRejected]);
    assert.equal(await readFile(path, "utf8"), "before");
    review.setMode("review");
    ide.openDiff = async (_path, contents) => ({ accepted: true, contents });
    await review.run(ctx, undefined, approve => approve(file));
  });
}

test("no-op proposals need no IDE; already-aborted operations do not run", async t => {
  const { ctx, file } = await fixture(t);
  const review = new EditReview(async () => assert.fail("No-op connected"));
  await review.run(ctx, undefined, approve => approve({ ...file, proposedContent: "before" }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(review.run(ctx, controller.signal, async () => assert.fail("Aborted operation ran")), /cancelled/);
});

test("cancellation stops waiting for connection establishment even if a connector ignores its signal", async t => {
  const { ctx, file } = await fixture(t);
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const review = new EditReview(async () => { started(); return new Promise(() => {}); });
  const pending = review.run(ctx, undefined, approve => approve(file));
  const rejected = assert.rejects(pending, /cancelled/);
  await ready; review.cancelPending(); await rejected;
});
