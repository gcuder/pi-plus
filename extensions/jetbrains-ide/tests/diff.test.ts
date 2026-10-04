import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdeProtocol } from "../protocol.ts";
import { reviewEdit, assertPreviewUnchanged } from "../diff.ts";
import { IdeContext } from "../context.ts";

test("openDiff recognizes Apply with final editable content and Reject; unknown outcomes fail closed", async () => {
  const ide = new IdeProtocol();
  ide.tools = [{ name: "openDiff", inputSchema: { properties: { old_file_path: {}, new_file_path: {}, new_file_contents: {}, tab_name: {} } } }];
  let content = [{ type: "text", text: "FILE_SAVED" }, { type: "text", text: "edited in IDE" }];
  ide.call = async (name, args) => {
    assert.equal(name, "openDiff"); assert.deepEqual(args, { old_file_path: "/file", new_file_path: "/file", new_file_contents: "proposal", tab_name: "tab" });
    return { content };
  };
  assert.deepEqual(await ide.openDiff("/file", "proposal", "tab"), { accepted: true, contents: "edited in IDE" });
  content = [{ type: "text", text: "DIFF_REJECTED" }];
  assert.deepEqual(await ide.openDiff("/file", "proposal", "tab"), { accepted: false });
  for (const status of ["unknown", "FILE_SAVED"]) {
    content = [{ type: "text", text: status }];
    await assert.rejects(ide.openDiff("/file", "proposal", "tab"), /Unrecognized/);
  }
  ide.tools = []; await assert.rejects(ide.openDiff("/file", "proposal", "tab"), /Unsupported/);
});

test("internal review is approval-only and never writes; modified UI proposals fail closed", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ide-diff-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "file.txt"); await writeFile(path, "before");
  const ide = new IdeProtocol();
  Object.defineProperty(ide.connection, "connected", { get: () => true });
  let accepted = false, contents = "proposal", closed = 0;
  ide.openDiff = async () => accepted ? { accepted: true, contents } : { accepted: false };
  ide.closeTab = async () => { closed++; };
  const file = { path, originalContent: "before", proposedContent: "proposal" };
  assert.equal(await reviewEdit(ide, file), false);
  accepted = true;
  assert.equal(await reviewEdit(ide, file), true);
  assert.equal(await readFile(path, "utf8"), "before");
  contents = "edited in IDE";
  await assert.rejects(reviewEdit(ide, file), /edited in PyCharm/);
  assert.equal(closed, 3);
  await assertPreviewUnchanged([file], dir);
  await writeFile(path, "external change");
  await assert.rejects(assertPreviewUnchanged([file], dir), /File changed/);
  await symlink(path, join(dir, "link.txt"));
  await assert.rejects(assertPreviewUnchanged([{ ...file, path: join(dir, "link.txt") }], dir), /regular file/);
  await assert.rejects(assertPreviewUnchanged([{ ...file, path: join(dir, "../outside.txt") }], dir), /inside/);
  await assertPreviewUnchanged([{ path: join(dir, "new/sub/file.txt"), originalContent: undefined, proposedContent: "new" }], dir);
  const controller = new AbortController(); controller.abort(); contents = "proposal";
  await assert.rejects(reviewEdit(ide, file, controller.signal), /interrupted/);
  assert.equal(await readFile(path, "utf8"), "external change");
});

test("selection cache is explicit, bounded and cleared on disconnect", async () => {
  const context = new IdeContext(), ide = new IdeProtocol();
  assert.match(await context.get(ide, "selection"), /No selection/);
  context.notification("selection_changed", { filePath: "/file", text: "x".repeat(20000), selection: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } } });
  const selected = JSON.parse(await context.get(ide, "selection"));
  assert.equal(selected.text.length, 16000); assert.equal(selected.filePath, "/file");
  context.clear(); assert.match(await context.get(ide, "selection"), /No selection/);
});
