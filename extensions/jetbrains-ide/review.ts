import { createHash } from "node:crypto";
import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { assertPreviewUnchanged, reviewEdit } from "./diff.ts";
import type { IdeProtocol } from "./protocol.ts";
import type { MutationPreview } from "./preview.ts";

export type EditMode = "auto" | "review";
export const MUTATION_TOOLS = new Set(["write", "replace", "replace_within", "insert", "copy", "move", "undo_last_change"]);
interface ReviewDependencies {
  preview: (event: ToolCallEvent, ctx: ExtensionContext) => Promise<MutationPreview>;
  connect: (ctx: ExtensionContext) => Promise<IdeProtocol>;
  reject: (toolCallId: string, reason: string) => void;
}

export class EditReview {
  private mode: EditMode = "review";
  private epoch = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private controllers = new Set<AbortController>();
  private approved = new Map<string, string>();
  private dependencies: ReviewDependencies;
  constructor(dependencies: ReviewDependencies) { this.dependencies = dependencies; }
  get editMode(): EditMode { return this.mode; }
  setMode(mode: EditMode): void { if (mode !== this.mode) { this.cancelPending(); this.mode = mode; } }
  cancelPending(): void {
    this.epoch++;
    for (const controller of this.controllers) controller.abort();
    this.approved.clear();
  }
  clearApprovals(): void { this.approved.clear(); }
  finished(toolCallId: string, isError: boolean): void {
    if (this.mode === "auto") return;
    this.approved.delete(toolCallId);
    if (isError) this.dependencies.reject(toolCallId, "Original tool failed or was blocked; discard any staged hashline batch");
  }

  handle(event: ToolCallEvent, ctx: ExtensionContext): Promise<{ block: true; reason: string } | undefined> {
    // Auto's fast path is deliberately BEFORE preview, filesystem, adapter, or IDE work.
    if (this.mode === "auto" || !MUTATION_TOOLS.has(event.toolName) && event.toolName !== "edit") return Promise.resolve(undefined);
    const epoch = this.epoch;
    const operation = this.queue.then(async () => {
      const controller = new AbortController(); this.controllers.add(controller);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
      const reviewContext = { ...ctx, signal };
      try {
        if (epoch !== this.epoch || signal.aborted) throw new Error("Edit review cancelled by mode change/disconnect");
        if (event.toolName === "edit") throw new Error("Built-in edit is not supported by this hashline installation; original tool blocked");
        const preview = await this.dependencies.preview(event, reviewContext);
        if (signal.aborted || epoch !== this.epoch) throw new Error("Edit review cancelled");
        await assertPreviewUnchanged(preview.files, ctx.cwd);
        const changed = preview.files.filter(f => f.originalContent !== f.proposedContent);
        if (!changed.length) return undefined;
        const fingerprint = createHash("sha256").update(JSON.stringify(preview)).digest("hex");
        // All members of a planned hashline batch approve one combined proposal.
        // Recompute in Review mode to detect changed inputs/files, but don't show
        // the identical approved combined diff once for every queued member.
        if (this.approved.get(event.toolCallId) !== fingerprint) {
          const ide = await this.dependencies.connect(reviewContext);
          if (signal.aborted || epoch !== this.epoch) throw new Error("Edit review cancelled");
          for (const file of changed) {
            if (!await reviewEdit(ide, file, signal)) throw new Error("User rejected native IDE diff; original tool cancelled. Do not bypass this rejection with another editing tool.");
          }
        }
        if (signal.aborted || epoch !== this.epoch) throw new Error("Edit review cancelled");
        // Check the WHOLE read set, including a copy's unchanged source and both
        // move targets. No original tool executes between the two move reviews.
        await assertPreviewUnchanged(preview.files, ctx.cwd);
        if (preview.ids.length > 1) {
          for (const id of preview.ids) this.approved.set(id, fingerprint);
          if (this.approved.size > 256) this.approved.clear();
        }
        return undefined; // Original tool runs with its original input/undo/anchors.
      } catch (e) {
        const reason = e instanceof Error ? e.message : "IDE review failed; original tool blocked";
        this.dependencies.reject(event.toolCallId, reason);
        return { block: true as const, reason };
      } finally { this.controllers.delete(controller); }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
