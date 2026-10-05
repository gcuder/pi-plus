import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertPreviewUnchanged, reviewEdit, type FileProposal } from "./diff.ts";
import type { IdeProtocol } from "./protocol.ts";
import { withAbort } from "./abort.ts";

export type EditMode = "auto" | "review";
export type ApproveEdit = (file: FileProposal) => Promise<void>;

export class EditReview {
  private mode: EditMode = "review";
  private epoch = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private controllers = new Set<AbortController>();
  private connect: (ctx: ExtensionContext) => Promise<IdeProtocol>;
  constructor(connect: (ctx: ExtensionContext) => Promise<IdeProtocol>) { this.connect = connect; }
  get editMode(): EditMode { return this.mode; }
  setMode(mode: EditMode): void { if (mode !== this.mode) { this.cancelPending(); this.mode = mode; } }
  cancelPending(): void {
    this.epoch++;
    for (const controller of this.controllers) controller.abort();
  }

  // Cancellation stays active through native execution, including time spent
  // waiting in Pi's file mutation queue. Mode changes never approve pending edits.
  async run<T>(ctx: ExtensionContext, signal: AbortSignal | undefined,
    operation: (approve: ApproveEdit, signal: AbortSignal) => Promise<T>): Promise<T> {
    const epoch = this.epoch;
    const controller = new AbortController(); this.controllers.add(controller);
    const signals = [controller.signal, signal, ctx.signal].filter((s): s is AbortSignal => !!s);
    const combined = AbortSignal.any(signals);
    const check = () => {
      if (epoch !== this.epoch || combined.aborted) throw new Error("Edit review cancelled by mode change/disconnect or abort");
    };
    const approve: ApproveEdit = file => {
      const review = this.queue.then(async () => {
        check();
        await assertPreviewUnchanged([file], ctx.cwd);
        if (file.originalContent !== file.proposedContent) {
          const ide = await withAbort(this.connect({ ...ctx, signal: combined }), combined);
          check();
          if (!await reviewEdit(ide, file, combined)) {
            throw new Error("User rejected native IDE diff; edit cancelled. Do not bypass this rejection with another editing tool.");
          }
        }
        check();
        await assertPreviewUnchanged([file], ctx.cwd);
        check();
      });
      this.queue = review.catch(() => {});
      return review;
    };
    try {
      check();
      return await operation(approve, combined);
    } finally { this.controllers.delete(controller); }
  }
}
