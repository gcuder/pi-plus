import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertPreviewUnchanged, assertReviewProposal, ModifiedIdeProposalError, reviewEdit, type FileProposal } from "./diff.ts";
import type { IdeProtocol } from "./protocol.ts";
import { withAbort } from "./abort.ts";

export type EditMode = "auto" | "review";
export type ApproveEdit = (file: FileProposal) => Promise<void>;
export type ReviewDecision =
  | { action: "accept" }
  | { action: "decline"; feedback?: string }
  | { action: "auto" }
  | { action: "cancel" };

type ConnectIde = (ctx: ExtensionContext) => Promise<IdeProtocol | undefined>;
export interface ReviewOptions {
  connect?: ConnectIde;
  terminal?: (ctx: ExtensionContext, file: FileProposal, signal: AbortSignal, onToggleMode?: () => void) => Promise<ReviewDecision>;
  onModeChange?: (mode: EditMode, ctx: ExtensionContext) => void;
  onToggleMode?: (ctx: ExtensionContext) => void;
}

export class EditReview {
  private mode: EditMode = "review";
  private queue: Promise<unknown> = Promise.resolve();
  private controllers = new Set<AbortController>();
  private options: ReviewOptions;

  constructor(options: ReviewOptions | ConnectIde) {
    this.options = typeof options === "function" ? { connect: options } : options;
  }
  get editMode(): EditMode { return this.mode; }
  setMode(mode: EditMode): void {
    if (mode !== this.mode) { this.cancelPending(); this.mode = mode; }
  }
  cancelPending(except?: AbortController): void {
    for (const controller of this.controllers) if (controller !== except) controller.abort();
  }

  private async decide(ctx: ExtensionContext, file: FileProposal, signal: AbortSignal): Promise<ReviewDecision> {
    const terminal = ctx.mode === "tui" && ctx.hasUI ? this.options.terminal : undefined;
    if (!terminal) {
      if (!this.options.connect) throw new Error("Edit review requires an interactive CLI or an IDE. Use /edit-mode auto for unattended edits.");
      const ide = await withAbort(this.options.connect({ ...ctx, signal }), signal);
      if (!ide) throw new Error("Edit review requires an interactive CLI or an IDE. Use /edit-mode auto for unattended edits.");
      return { action: await reviewEdit(ide, file, signal) ? "accept" : "decline" };
    }

    // Each approval surface has a request lifetime separate from the mutation.
    // Closing a losing diff must not abort a CLI-approved filesystem write.
    const surfaces = new AbortController();
    const surfaceSignal = AbortSignal.any([signal, surfaces.signal]);
    try {
      return await withAbort(new Promise<ReviewDecision>((resolve, reject) => {
        let settled = false;
        const finish = (decision: ReviewDecision) => {
          if (settled || surfaceSignal.aborted) return;
          settled = true;
          resolve(decision);
          surfaces.abort();
        };
        const fail = (error: unknown) => {
          if (settled || surfaceSignal.aborted) return;
          settled = true;
          reject(error);
          surfaces.abort();
        };
        const toggle = this.options.onToggleMode ? () => this.options.onToggleMode!(ctx) : undefined;
        void Promise.resolve().then(() => {
          if (surfaceSignal.aborted) throw new Error("Edit review cancelled");
          return terminal(ctx, file, surfaceSignal, toggle);
        }).then(finish, fail);
        if (this.options.connect) {
          void (async () => {
            if (surfaceSignal.aborted) return;
            const ide = await withAbort(this.options.connect!({ ...ctx, signal: surfaceSignal }), surfaceSignal);
            if (surfaceSignal.aborted || !ide) return;
            // Report the decision before best-effort tab cleanup finishes.
            await reviewEdit(ide, file, surfaceSignal, accepted => finish({ action: accepted ? "accept" : "decline" }));
          })().catch(error => {
            if (!settled && !surfaceSignal.aborted) {
              ctx.ui.notify(error instanceof ModifiedIdeProposalError
                ? "IDE proposal was modified. The CLI shows the original proposal; decline with feedback to request a different change."
                : "IDE review unavailable. Continue reviewing in the CLI.", "warning");
            }
          });
        }
      }), signal);
    } finally { surfaces.abort(); }
  }

  // Cancellation stays active through native execution, including time spent
  // waiting in Pi's file mutation queue. External mode changes never approve edits.
  async run<T>(ctx: ExtensionContext, signal: AbortSignal | undefined,
    operation: (approve: ApproveEdit, signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController(); this.controllers.add(controller);
    const signals = [controller.signal, signal, ctx.signal].filter((s): s is AbortSignal => !!s);
    const combined = AbortSignal.any(signals);
    const check = () => {
      if (combined.aborted) throw new Error("Edit review cancelled by mode change or abort");
    };
    const approve: ApproveEdit = file => {
      const pending = this.queue.then(async () => {
        check();
        await assertPreviewUnchanged([file], ctx.cwd);
        assertReviewProposal(file);
        if (file.originalContent !== file.proposedContent) {
          const decision = await this.decide(ctx, file, combined);
          check();
          if (decision.action === "cancel") throw new Error("Edit review cancelled");
          if (decision.action === "decline") {
            const feedback = decision.feedback?.trim();
            throw new Error(`User rejected the diff; edit cancelled.${feedback ? ` User feedback: ${feedback}` : ""} Do not bypass this rejection with another editing tool.`);
          }
          if (decision.action === "auto") {
            // Unlike an external toggle, this decision approves this operation.
            // Other pending reviews are cancelled, not silently authorized.
            this.mode = "auto";
            this.cancelPending(controller);
            this.options.onModeChange?.("auto", ctx);
          }
        }
        check();
        await assertPreviewUnchanged([file], ctx.cwd);
        check();
      });
      this.queue = pending.catch(() => {});
      return pending;
    };
    try {
      check();
      return await operation(approve, combined);
    } finally { this.controllers.delete(controller); }
  }
}
