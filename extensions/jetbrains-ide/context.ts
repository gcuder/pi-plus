import { IdeProtocol, resultText } from "./protocol.ts";

export class IdeContext {
  private selection?: { filePath: string | null; text: string | null; selection: unknown; observedAt: string };

  notification(method: string, params: unknown): void {
    if (method !== "selection_changed" || !params || typeof params !== "object") return;
    const p = params as Record<string, unknown>;
    this.selection = {
      filePath: typeof p.filePath === "string" ? p.filePath : null,
      text: typeof p.text === "string" ? p.text.slice(0, 16_000) : null,
      selection: p.selection,
      observedAt: new Date().toISOString(),
    };
  }

  clear(): void { this.selection = undefined; }

  async get(ide: IdeProtocol, kind: "selection" | "tabs" | "diagnostics", uri?: string, signal?: AbortSignal): Promise<string> {
    if (kind === "selection") return JSON.stringify(this.selection ?? {
      unavailable: "No selection notification yet. Focus an editor or change the selection in PyCharm. No active-editor polling RPC is advertised.",
    }, null, 2);
    if (kind === "tabs") return resultText(await ide.call("get_all_opened_file_paths", {}, { signal }));
    return resultText(await ide.call("getDiagnostics", uri ? { uri } : {}, { signal }));
  }
}
