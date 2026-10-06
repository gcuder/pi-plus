import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createEditToolDefinition, createWriteToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assertPreviewUnchanged, assertReviewTarget, snapshotFile, type FileIdentity } from "./diff.ts";
import { commitReviewedFile } from "./commit.ts";
import type { EditReview } from "./review.ts";

export function registerReviewedEditing(pi: ExtensionAPI, review: EditReview): void {
  const edit = createEditToolDefinition(process.cwd());
  const write = createWriteToolDefinition(process.cwd());
  // Unique schema objects let the public tool inventory identify these wrappers.
  edit.parameters = { ...edit.parameters };
  write.parameters = { ...write.parameters };
  pi.on("tool_call", event => {
    if (review.editMode !== "review" || !["edit", "write"].includes(event.toolName)) return;
    const expected = event.toolName === "edit" ? edit.parameters : write.parameters;
    if (pi.getAllTools().find(tool => tool.name === event.toolName)?.parameters !== expected) {
      return { block: true, reason: "Edit Review does not own this editing tool. Remove conflicting editing extensions and restart Pi." };
    }
  });

  pi.registerTool({ ...edit,
    async execute(id, input, signal, update, ctx) {
      if (review.editMode === "auto") return edit.execute(id, input, signal, update, ctx);
      return review.run(ctx, signal, async (approve, reviewSignal) => {
        let originalContent: string | undefined;
        let originalIdentity: FileIdentity | undefined;
        const tool = createEditToolDefinition(ctx.cwd, { operations: {
          access: async path => {
            await assertReviewTarget(path, ctx.cwd);
            await access(path, constants.R_OK | constants.W_OK);
          },
          readFile: async path => {
            const original = await snapshotFile(path);
            originalContent = original?.content;
            originalIdentity = original?.identity;
            if (originalContent === undefined) throw new Error("Edit target no longer exists");
            return Buffer.from(originalContent, "utf8");
          },
          writeFile: async (path, proposedContent) => {
            const file = { path, originalContent, originalIdentity, proposedContent };
            await approve(file);
            if (reviewSignal.aborted) throw new Error("Edit review cancelled");
            await commitReviewedFile(file, ctx.cwd, reviewSignal);
          },
        } });
        // Pi's native queue surrounds read, review and commit. No nested tool call
        // or second replacement algorithm is involved; native results are retained.
        return tool.execute(id, input, reviewSignal, update, ctx);
      });
    },
  });

  pi.registerTool({ ...write,
    async execute(id, input, signal, update, ctx) {
      if (review.editMode === "auto") return write.execute(id, input, signal, update, ctx);
      return review.run(ctx, signal, async (approve, reviewSignal) => {
        const tool = createWriteToolDefinition(ctx.cwd, { operations: {
          mkdir: async () => {}, // Missing parents must not be created before approval.
          writeFile: async (path, proposedContent) => {
            await assertReviewTarget(path, ctx.cwd);
            const original = await snapshotFile(path);
            const file = { path, originalContent: original?.content, originalIdentity: original?.identity, proposedContent };
            await approve(file);
            if (reviewSignal.aborted) throw new Error("Edit review cancelled");
            await mkdir(dirname(path), { recursive: true });
            // Directory creation yields to other processes. Recheck before writing.
            await assertPreviewUnchanged([file], ctx.cwd);
            if (reviewSignal.aborted) throw new Error("Edit review cancelled");
            await commitReviewedFile(file, ctx.cwd, reviewSignal);
          },
        } });
        return tool.execute(id, input, reviewSignal, update, ctx);
      });
    },
  });
}
