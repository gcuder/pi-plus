import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEditToolDefinition, createWriteToolDefinition, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerReviewedEditing } from "../editing.ts";
import { EditReview } from "../review.ts";
import { IdeProtocol } from "../protocol.ts";

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }, initial = "before\n") {
  const cwd = await mkdtemp(join(tmpdir(), "pi-native-edit-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "file.txt"); await writeFile(path, initial);
  const ctx = { cwd } as ExtensionToolContext;
  const ide = new IdeProtocol(); Object.defineProperty(ide.connection, "connected", { get: () => true });
  ide.closeTab = async () => {};
  ide.openDiff = async (_path, contents) => ({ accepted: true, contents });
  const review = new EditReview(async () => ide), tools = new Map<string, ToolDefinition>();
  registerReviewedEditing({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), on: () => {} } as unknown as ExtensionAPI, review);
  const execute = (name: string, input: unknown, signal?: AbortSignal) => tools.get(name)!.execute("call", input, signal, undefined, ctx);
  return { cwd, path, ctx, ide, review, tools, execute };
}
const edits = (oldText = "before", newText = "after") => ({ path: "@file.txt", edits: [{ oldText, newText }] });

for (const initial of ["before\n", "\uFEFFbefore\r\nsecond\r\n", "before\rsecond\r", "before\r\nsecond\nthird\r\n"]) {
  test(`native edit preview and result match unmodified Pi execution for ${JSON.stringify(initial)}`, async t => {
    const { cwd, path, ctx, ide, execute } = await fixture(t, initial);
    const input = edits(), native = createEditToolDefinition(cwd);
    // Keep the same displayed path so details.patch and result text also match.
    const referenceCtx = { ...ctx, cwd: await mkdtemp(join(cwd, "ref-")) } as ExtensionToolContext;
    await writeFile(join(referenceCtx.cwd, "file.txt"), initial);
    const expected = await native.execute("native", input, undefined, undefined, referenceCtx);
    const bytes = await readFile(join(referenceCtx.cwd, "file.txt"));
    let proposals = 0;
    ide.openDiff = async (_path, contents) => {
      proposals++; assert.equal(await readFile(path, "utf8"), initial);
      assert.deepEqual(Buffer.from(contents), bytes);
      return { accepted: true, contents: contents.replace(/\r\n|\r/g, "\n") };
    };
    assert.deepEqual(await execute("edit", input), expected);
    assert.deepEqual(await readFile(path), bytes); assert.equal(proposals, 1);
    assert.deepEqual(input, edits());
  });
}

test("multiple disjoint edits use one native proposal; invalid edits never open a diff", async t => {
  const { path, ide, execute } = await fixture(t, "one\ntwo\nthree\n");
  let reviews = 0;
  ide.openDiff = async (_path, contents) => { reviews++; assert.equal(contents, "ONE\ntwo\nTHREE\n"); return { accepted: true, contents }; };
  await execute("edit", { path: "file.txt", edits: [{ oldText: "one", newText: "ONE" }, { oldText: "three", newText: "THREE" }] });
  assert.equal(reviews, 1);
  for (const replacements of [[], [{ oldText: "missing", newText: "new" }], [{ oldText: "two", newText: "a" }, { oldText: "two", newText: "b" }]]) {
    await assert.rejects(execute("edit", { path: "file.txt", edits: replacements }));
  }
  await writeFile(path, "same same");
  await assert.rejects(execute("edit", edits("same", "new")));
  assert.equal(reviews, 1); assert.equal(await readFile(path, "utf8"), "same same");
});

test("write preview matches native execution, and rejection creates no parent directories", async t => {
  const { cwd, ctx, ide, execute } = await fixture(t);
  const input = { path: "@new/sub/file.txt", content: "\uFEFFafter\r\n" };
  const native = createWriteToolDefinition(cwd);
  ide.openDiff = async (path, contents) => {
    assert.equal(path, join(cwd, "new/sub/file.txt")); assert.equal(contents, input.content);
    await assert.rejects(access(join(cwd, "new")), /ENOENT/); return { accepted: false };
  };
  await assert.rejects(execute("write", input), /rejected/);
  await assert.rejects(access(join(cwd, "new")), /ENOENT/);
  ide.openDiff = async (_path, contents) => ({ accepted: true, contents });
  const result = await execute("write", input);
  assert.equal(await readFile(join(cwd, "new/sub/file.txt"), "utf8"), input.content);
  assert.deepEqual(result, await native.execute("native", input, undefined, undefined, ctx));
});

for (const name of ["edit", "write"]) {
  test(`${name} rejection, disconnect, stale files and changed UI content never commit`, async t => {
    const { path, ide, review, execute } = await fixture(t);
    const input = name === "edit" ? edits() : { path: "file.txt", content: "after\n" };
    ide.openDiff = async () => ({ accepted: false });
    await assert.rejects(execute(name, input), /rejected/);
    ide.openDiff = async (_path, contents) => { review.cancelPending(); return { accepted: true, contents }; };
    await assert.rejects(execute(name, input), /interrupted|cancelled/);
    ide.openDiff = async () => ({ accepted: true, contents: "UI change" });
    await assert.rejects(execute(name, input), /edited in PyCharm/);
    assert.equal(await readFile(path, "utf8"), "before\n");
    ide.openDiff = async (_path, contents) => { await writeFile(path, "external change"); return { accepted: true, contents }; };
    await assert.rejects(execute(name, input), /File changed/);
    assert.equal(await readFile(path, "utf8"), "external change");
  });
}

test("parallel same-file edit calls review sequential native results, not stale previews", async t => {
  const { path, ide, execute } = await fixture(t, "one two\n");
  const proposals: string[] = [];
  ide.openDiff = async (_path, contents) => {
    proposals.push(contents);
    assert.equal(await readFile(path, "utf8"), proposals.length === 1 ? "one two\n" : "ONE two\n");
    return { accepted: true, contents };
  };
  await Promise.all([execute("edit", edits("one", "ONE")), execute("edit", edits("two", "TWO"))]);
  assert.deepEqual(proposals, ["ONE two\n", "ONE TWO\n"]);
  assert.equal(await readFile(path, "utf8"), "ONE TWO\n");
});

test("mode changes cancel edits waiting in the native file queue and Auto skips IDE review", async t => {
  const { path, ide, review, execute } = await fixture(t);
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  ide.openDiff = async (_path, _contents, _tab, signal) => {
    started(); return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
  };
  const first = execute("edit", edits()), firstRejected = assert.rejects(first, /cancelled/);
  await ready;
  const second = execute("write", { path: "file.txt", content: "queued" }), secondRejected = assert.rejects(second, /cancelled|aborted/);
  review.setMode("auto");
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(await readFile(path, "utf8"), "before\n");
  ide.openDiff = async () => assert.fail("Auto opened IDE");
  await execute("edit", edits());
  await execute("write", { path: "file.txt", content: "auto write" });
  assert.equal(await readFile(path, "utf8"), "auto write");
});

test("Auto delegates directly without proposal validation or IDE work", async t => {
  const { cwd, path, ctx, tools } = await fixture(t);
  const review = new EditReview({
    connect: async () => assert.fail("Auto tried to connect"),
    terminal: async () => assert.fail("Auto opened CLI review"),
  });
  registerReviewedEditing({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), on: () => {} } as unknown as ExtensionAPI, review);
  review.setMode("auto");
  await symlink(path, join(cwd, "link.txt"));
  const input = { path: "link.txt", content: "\0" };
  const native = createWriteToolDefinition(cwd);
  const result = await tools.get("write")!.execute("auto", input, undefined, undefined, ctx);
  assert.equal(await readFile(path, "utf8"), input.content);
  assert.deepEqual(result, await native.execute("native", input, undefined, undefined, ctx));
  await writeFile(path, "before\n");
  const editInput = { ...edits(), path: "link.txt" };
  const edited = await tools.get("edit")!.execute("auto-edit", editInput, undefined, undefined, ctx);
  await writeFile(path, "before\n");
  assert.deepEqual(edited, await createEditToolDefinition(cwd).execute("native", editInput, undefined, undefined, ctx));
});

test("Review rejects symlinks, outside paths, binary and invalid UTF-8 before contacting IDE", async t => {
  const { cwd, path, ide, execute } = await fixture(t);
  ide.openDiff = async () => assert.fail("Unsafe target reached IDE");
  await symlink(path, join(cwd, "link.txt"));
  for (const target of ["link.txt", "../outside.txt", "."]) {
    await assert.rejects(execute("write", { path: target, content: "after" }), /regular file|inside/);
    await assert.rejects(execute("edit", { ...edits(), path: target }), /regular file|inside/);
  }
  for (const bytes of [Buffer.from([0]), Buffer.from([0xff])]) {
    await writeFile(path, bytes);
    await assert.rejects(execute("write", { path: "file.txt", content: "after" }), /UTF-8/);
    await assert.rejects(execute("edit", edits()), /UTF-8/);
    assert.deepEqual(await readFile(path), bytes);
  }
  await writeFile(path, "before\n");
  for (const content of ["\0", "\ud800", "x".repeat(2 * 1024 * 1024 + 1)]) {
    await assert.rejects(execute("write", { path: "file.txt", content }), /UTF-8|2 MiB/);
  }
});
