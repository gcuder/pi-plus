import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EditReview, type ReviewDecision, type ReviewOptions } from "../review.ts";
import { IdeProtocol } from "../protocol.ts";
import { snapshotFile } from "../diff.ts";
import { commitReviewedFile } from "../commit.ts";
import { withAbort } from "../abort.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cli-review-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "file.txt"); await writeFile(path, "before\n");
  const original = (await snapshotFile(path))!;
  const file = { path, originalContent: original.content, originalIdentity: original.identity, proposedContent: "after\n" };
  const notices: string[] = [];
  const ctx = { cwd, mode: "tui", hasUI: true, ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionContext;
  const ide = new IdeProtocol(); Object.defineProperty(ide.connection, "connected", { get: () => true });
  let closed = 0;
  ide.closeTab = async () => { closed++; };
  const cli = deferred<ReviewDecision>(), native = deferred<{ accepted: false } | { accepted: true; contents: string }>();
  const cliReady = deferred<void>(), ideReady = deferred<void>();
  let cliSignal!: AbortSignal, ideSignal!: AbortSignal;
  const terminal: ReviewOptions["terminal"] = async (_ctx, proposal, signal) => {
    assert.deepEqual(proposal, file); cliSignal = signal; cliReady.resolve();
    return withAbort(cli.promise, signal);
  };
  ide.openDiff = async (_path, _contents, _tab, signal) => {
    ideSignal = signal!; ideReady.resolve(); return withAbort(native.promise, signal);
  };
  const run = (review: EditReview, signal?: AbortSignal) => review.run(ctx, signal, async (approve, reviewSignal) => {
    await approve(file); await commitReviewedFile(file, cwd, reviewSignal);
  });
  return { path, file, ctx, ide, notices, cli, native, cliReady, ideReady, terminal, run,
    cliSignal: () => cliSignal, ideSignal: () => ideSignal, closed: () => closed };
}

test("CLI review approves without an IDE and commits the exact proposal", async t => {
  const f = await fixture(t);
  const review = new EditReview({ terminal: f.terminal });
  const pending = f.run(review); await f.cliReady.promise;
  assert.equal(await readFile(f.path, "utf8"), "before\n");
  f.cli.resolve({ action: "accept" }); await pending;
  assert.equal(await readFile(f.path, "utf8"), "after\n");
  assert.equal(review.editMode, "review"); assert.equal(f.cliSignal().aborted, true);
});

for (const availability of ["missing", "failed", "disconnect"] as const) {
  test(`${availability} IDE leaves CLI review available`, async t => {
    const f = await fixture(t);
    const failed = deferred<void>();
    const review = new EditReview({ terminal: f.terminal, connect: async () => {
      if (availability === "missing") return undefined;
      if (availability === "failed") throw new Error("Unavailable");
      f.ide.openDiff = async () => { failed.resolve(); throw new Error("IDE disconnected"); };
      return f.ide;
    } });
    const pending = f.run(review); await f.cliReady.promise;
    if (availability === "disconnect") await failed.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.cliSignal().aborted, false);
    f.cli.resolve({ action: "accept" }); await pending;
    assert.equal(await readFile(f.path, "utf8"), "after\n");
  });
}

for (const winner of ["cli", "ide"] as const) {
  for (const accept of [true, false]) {
    test(`${winner} ${accept ? "accept" : "decline"} wins and cancels the other surface`, async t => {
      const f = await fixture(t);
      const review = new EditReview({ terminal: f.terminal, connect: async () => f.ide });
      const pending = f.run(review);
      const finished = accept ? pending : assert.rejects(pending, /User rejected/);
      await Promise.all([f.cliReady.promise, f.ideReady.promise]);
      if (winner === "cli") f.cli.resolve({ action: accept ? "accept" : "decline" });
      else f.native.resolve(accept ? { accepted: true, contents: f.file.proposedContent } : { accepted: false });
      await finished;
      assert.equal(f.cliSignal().aborted, true); assert.equal(f.ideSignal().aborted, true);
      if (winner === "cli") f.native.resolve(accept ? { accepted: false } : { accepted: true, contents: f.file.proposedContent });
      else f.cli.resolve({ action: accept ? "decline" : "auto" });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(await readFile(f.path, "utf8"), accept ? "after\n" : "before\n");
      assert.equal(f.closed(), 1); assert.equal(review.editMode, "review");
    });
  }
}

test("IDE decision wins before slow tab cleanup", async t => {
  const f = await fixture(t), cleanup = deferred<void>();
  f.ide.closeTab = async () => cleanup.promise;
  const review = new EditReview({ terminal: f.terminal, connect: async () => f.ide });
  const pending = f.run(review), rejected = assert.rejects(pending, /User rejected/);
  await Promise.all([f.cliReady.promise, f.ideReady.promise]);
  f.native.resolve({ accepted: false });
  await rejected; f.cli.resolve({ action: "accept" });
  assert.equal(await readFile(f.path, "utf8"), "before\n"); cleanup.resolve();
});

test("decline feedback reaches the agent without changing disk", async t => {
  const f = await fixture(t), review = new EditReview({ terminal: f.terminal });
  const pending = f.run(review), rejected = assert.rejects(pending, /User feedback: Keep the old API.*Do not bypass/);
  await f.cliReady.promise; f.cli.resolve({ action: "decline", feedback: "  Keep the old API  " });
  await rejected; assert.equal(await readFile(f.path, "utf8"), "before\n");
});

test("Accept-and-Auto preserves the accepted operation and cancels other pending reviews", async t => {
  const f = await fixture(t), modes: string[] = [];
  const review = new EditReview({ terminal: f.terminal, connect: async () => f.ide,
    onModeChange: mode => modes.push(mode) });
  const pending = f.run(review); await Promise.all([f.cliReady.promise, f.ideReady.promise]);
  const queued = review.run(f.ctx, undefined, approve => approve(f.file));
  const rejected = assert.rejects(queued, /cancelled/);
  f.cli.resolve({ action: "auto" }); await Promise.all([pending, rejected]);
  assert.equal(await readFile(f.path, "utf8"), "after\n");
  assert.equal(review.editMode, "auto"); assert.deepEqual(modes, ["auto"]);
  assert.equal(f.ideSignal().aborted, true);
});

for (const cancellation of ["abort", "toggle", "shutdown"] as const) {
  test(`${cancellation} cancels both review surfaces without approving`, async t => {
    const f = await fixture(t), signal = new AbortController();
    const review = new EditReview({ terminal: f.terminal, connect: async () => f.ide });
    const pending = f.run(review, signal.signal), rejected = assert.rejects(pending, /cancelled/);
    await Promise.all([f.cliReady.promise, f.ideReady.promise]);
    if (cancellation === "abort") signal.abort();
    else if (cancellation === "toggle") review.setMode("auto");
    else review.cancelPending();
    await rejected;
    assert.equal(f.cliSignal().aborted, true); assert.equal(f.ideSignal().aborted, true);
    assert.equal(await readFile(f.path, "utf8"), "before\n");
  });
}

test("CLI approval still rejects stale files", async t => {
  const f = await fixture(t), review = new EditReview({ terminal: f.terminal });
  const pending = f.run(review), rejected = assert.rejects(pending, /File changed/);
  await f.cliReady.promise; await writeFile(f.path, "external change");
  f.cli.resolve({ action: "accept" }); await rejected;
  assert.equal(await readFile(f.path, "utf8"), "external change");
});

test("modified IDE proposals cannot authorize writes; CLI can approve the original proposal", async t => {
  const f = await fixture(t);
  const review = new EditReview({ terminal: f.terminal, connect: async () => f.ide });
  const pending = f.run(review); await Promise.all([f.cliReady.promise, f.ideReady.promise]);
  f.native.resolve({ accepted: true, contents: "changed in IDE" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await readFile(f.path, "utf8"), "before\n");
  assert.equal(f.cliSignal().aborted, false); assert.equal(f.notices.length, 1);
  assert.match(f.notices[0], /IDE proposal was modified.*decline with feedback/);
  f.cli.resolve({ action: "accept" }); await pending;
  assert.equal(await readFile(f.path, "utf8"), "after\n");
});

test("late IDE connections never open a diff after a CLI decision", async t => {
  const f = await fixture(t), connection = deferred<IdeProtocol>();
  f.ide.openDiff = async () => assert.fail("Opened a late IDE diff");
  const review = new EditReview({ terminal: f.terminal, connect: async () => connection.promise });
  const pending = f.run(review); await f.cliReady.promise;
  f.cli.resolve({ action: "accept" }); await pending; connection.resolve(f.ide);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await readFile(f.path, "utf8"), "after\n");
});

test("no-op proposals do not open either review surface", async t => {
  const f = await fixture(t);
  const review = new EditReview({ terminal: async () => assert.fail("No-op CLI review"),
    connect: async () => assert.fail("No-op IDE connection") });
  await review.run(f.ctx, undefined, approve => approve({ ...f.file, proposedContent: f.file.originalContent }));
});

test("headless Review requires an approval surface and never opens terminal UI", async t => {
  const f = await fixture(t);
  f.ctx.mode = "print"; f.ctx.hasUI = false;
  const review = new EditReview({ terminal: async () => assert.fail("Opened terminal UI") });
  await assert.rejects(f.run(review), /interactive CLI or an IDE/);
  assert.equal(await readFile(f.path, "utf8"), "before\n");
});
