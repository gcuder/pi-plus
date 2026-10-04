import { createWriteToolDefinition, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { snapshot, type FileProposal } from "./diff.ts";

export const PREVIEW_EVENT = "pi-plus:hashline-preview-v1";
export const REJECT_EVENT = "pi-plus:hashline-reject-v1";
export interface MutationPreview { ids: string[]; files: FileProposal[] }

export async function previewMutation(pi: ExtensionAPI, event: ToolCallEvent, ctx: ExtensionContext): Promise<MutationPreview> {
  if (event.toolName === "write") {
    // Reuse Pi's actual path normalization and write semantics with inert I/O.
    // Do not execute the registered write tool, emit tool events, or create dirs.
    let proposed: { path: string; content: string } | undefined;
    const input = event.input as { path: string; content: string };
    const definition = createWriteToolDefinition(ctx.cwd, { operations: {
      mkdir: async () => {},
      writeFile: async (path, content) => { proposed = { path, content }; },
    } });
    await definition.execute("preview-only", input, ctx.signal, undefined, ctx as ExtensionToolContext);
    if (!proposed) throw new Error("Write preview produced no proposal");
    return { ids: [event.toolCallId], files: [{ path: proposed.path,
      originalContent: await snapshot(proposed.path), proposedContent: proposed.content }] };
  }
  let response: Promise<MutationPreview & { apiVersion: number; packageVersion: string }> | undefined;
  pi.events.emit(PREVIEW_EVENT, { toolName: event.toolName, toolCallId: event.toolCallId, input: event.input, ctx,
    respond: (promise: typeof response) => { response = promise; },
  });
  if (!response) throw new Error("Hashline preview adapter unavailable. Run scripts/install.sh (or scripts/patch-hashline.mjs), then restart Pi. Review mode does not fall back to unreviewed edits.");
  const preview = await response;
  if (preview.apiVersion !== 1 || preview.packageVersion !== "5.1.0" || !Array.isArray(preview.files) || !preview.files.length ||
      !Array.isArray(preview.ids) || !preview.ids.includes(event.toolCallId) || !preview.ids.every(id => typeof id === "string") ||
      !preview.files.every(f => typeof f?.path === "string" && typeof f.proposedContent === "string" && (f.originalContent === undefined || typeof f.originalContent === "string"))) {
    throw new Error("Unsupported hashline preview adapter response");
  }
  return preview;
}
