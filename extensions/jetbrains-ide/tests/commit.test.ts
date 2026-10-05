import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { constants } from "node:fs";
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerReviewedEditing } from "../editing.ts";
import { EditReview } from "../review.ts";
import { IdeProtocol } from "../protocol.ts";

for (const name of ["edit", "write"]) {
  for (const replacement of ["symlink", "same-content inode"]) {
    test(`${name} blocks a late ${replacement} replacement before commit`, async t => {
      const dir = await mkdtemp(join(tmpdir(), "pi-review-race-"));
      t.after(() => rm(dir, { recursive: true, force: true }));
      const cwd = join(dir, "workspace"); await fs.promises.mkdir(cwd);
      const path = join(cwd, "file.txt"), outside = join(dir, "outside.txt");
      await writeFile(path, "before"); await writeFile(outside, "outside");
      const ide = new IdeProtocol(); Object.defineProperty(ide.connection, "connected", { get: () => true });
      ide.closeTab = async () => {}; ide.openDiff = async (_path, contents) => ({ accepted: true, contents });
      const tools = new Map<string, ToolDefinition>();
      registerReviewedEditing({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), on: () => {} } as unknown as ExtensionAPI,
        new EditReview(async () => ide));
      const originalOpen = fs.promises.open;
      let swapped = false;
      fs.promises.open = (async (target: any, flags: any, mode: any) => {
        if (target === path && typeof flags === "number" && flags & constants.O_RDWR) {
          swapped = true;
          await rename(path, join(cwd, "original.txt"));
          if (replacement === "symlink") await symlink(outside, path);
          else await writeFile(path, "before");
        }
        return originalOpen(target, flags, mode);
      }) as typeof originalOpen;
      syncBuiltinESMExports();
      try {
        const input = name === "edit" ? { path: "file.txt", edits: [{ oldText: "before", newText: "after" }] } : { path: "file.txt", content: "after" };
        await assert.rejects(tools.get(name)!.execute("race", input, undefined, undefined, { cwd } as ExtensionToolContext), /ELOOP|identity changed/);
        assert.equal(swapped, true);
        assert.equal(await readFile(outside, "utf8"), "outside");
        if (replacement !== "symlink") assert.equal(await readFile(path, "utf8"), "before");
      } finally {
        fs.promises.open = originalOpen; syncBuiltinESMExports();
      }
    });
  }
}
