import { Connection, type SocketFactory } from "./connection.ts";
import type { IdeInstance } from "./discovery.ts";

export const AUTH_HEADER = "X-Claude-Code-Ide-Authorization";
export const PROTOCOL_VERSION = "2024-11-05";
export interface McpResult { content: Array<{ type: string; text?: string }>; isError?: boolean }
export interface IdeTool { name: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] } }

export class IdeProtocol {
  readonly connection = new Connection();
  tools: IdeTool[] = [];
  serverVersion = "unknown";

  async connect(instance: IdeInstance, factory?: SocketFactory, signal?: AbortSignal): Promise<void> {
    if (!Number.isInteger(instance.port) || instance.port < 1 || instance.port > 65535) throw new Error("Invalid local IDE port");
    if (signal?.aborted) throw new Error("IDE connection cancelled");
    const abort = () => this.close();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.connection.open(`ws://127.0.0.1:${instance.port}/`, "mcp", { [AUTH_HEADER]: instance.authToken }, factory);
      const init = await this.connection.request("initialize", {
        protocolVersion: PROTOCOL_VERSION, capabilities: {},
        clientInfo: { name: "pi-plus-jetbrains-ide", version: "0.1.0" },
      }) as { protocolVersion?: string; serverInfo?: { name?: string; version?: string } };
      if (init?.protocolVersion !== PROTOCOL_VERSION || init.serverInfo?.name !== "Claude Code JetBrains Plugin") {
        throw new Error("Unsupported IDE server or MCP protocol version");
      }
      this.serverVersion = String(init.serverInfo.version ?? "unknown");
      this.connection.notify("notifications/initialized");
      // Confirmed plugin-specific notification; associates this external client's PID.
      this.connection.notify("ide_connected", { pid: process.pid, isPluginVersionUnsupported: false });
      await this.refreshTools();
    } catch (error) {
      this.close();
      if (signal?.aborted) throw new Error("IDE connection cancelled");
      throw error;
    }
    finally { signal?.removeEventListener("abort", abort); }
  }

  async refreshTools(): Promise<void> {
    const result = await this.connection.request("tools/list") as { tools?: IdeTool[] };
    if (!Array.isArray(result?.tools) || !result.tools.every(t => typeof t?.name === "string")) {
      throw new Error("Malformed IDE tool list");
    }
    this.tools = result.tools;
  }

  supports(name: string): boolean { return this.tools.some(t => t.name === name); }

  async call(name: string, args: Record<string, unknown> = {}, options: { timeout?: number; signal?: AbortSignal } = {}): Promise<McpResult> {
    if (!this.supports(name)) throw new Error(`IDE does not advertise ${name}`);
    const result = await this.connection.request("tools/call", { name, arguments: args }, options) as McpResult;
    if (!result || !Array.isArray(result.content)) throw new Error("Malformed IDE tool response");
    if (result.isError) throw new Error(`IDE tool ${name} failed`);
    return result;
  }

  async openDiff(path: string, contents: string, tab: string, signal?: AbortSignal): Promise<{ accepted: false } | { accepted: true; contents: string }> {
    const tool = this.tools.find(t => t.name === "openDiff");
    const fields = ["old_file_path", "new_file_path", "new_file_contents", "tab_name"];
    if (!tool || !fields.every(f => f in (tool.inputSchema?.properties ?? {}))) throw new Error("Unsupported IDE openDiff schema");
    const result = await this.call("openDiff", {
      old_file_path: path, new_file_path: path, new_file_contents: contents, tab_name: tab,
    }, { timeout: 30 * 60_000, signal });
    const texts = result.content.filter(c => c.type === "text").map(c => c.text);
    if (texts[0] === "DIFF_REJECTED") return { accepted: false };
    if (texts[0] === "FILE_SAVED" && typeof texts[1] === "string") return { accepted: true, contents: texts[1] };
    // Unknown outcomes must never authorize a write.
    throw new Error("Unrecognized IDE diff decision; no file was written");
  }

  async closeTab(tab: string): Promise<void> {
    if (this.connection.connected && this.supports("close_tab")) await this.call("close_tab", { tab_name: tab });
  }

  close(): void { this.tools = []; this.connection.close(); }
}

export function resultText(result: McpResult): string {
  return result.content.filter(c => c.type === "text").map(c => c.text ?? "").join("\n");
}
