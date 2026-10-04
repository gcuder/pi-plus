import WebSocket from "ws";

export interface Socket {
  readyState: number;
  on(event: string, handler: (...args: any[]) => void): unknown;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number): void;
  terminate(): void;
}
export type SocketFactory = (url: string, protocol: string, headers: Record<string, string>) => Socket;
export const websocketFactory: SocketFactory = (url, protocol, headers) =>
  new WebSocket(url, protocol, { headers, handshakeTimeout: 5000, followRedirects: false, maxPayload: 8 * 1024 * 1024 });

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; cleanup: () => void }

// Transport only: no Claude methods or credentials are kept here.
export class Connection {
  private socket?: Socket;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private openingReject?: (e: Error) => void;
  onNotification: (method: string, params: unknown) => void = () => {};
  onClose: () => void = () => {};
  get connected(): boolean { return this.socket?.readyState === 1; }

  async open(url: string, protocol: string, headers: Record<string, string>, factory = websocketFactory): Promise<void> {
    if (this.socket) throw new Error("IDE transport already open");
    await new Promise<void>((resolve, reject) => {
      let socket: Socket;
      try { socket = factory(url, protocol, headers); }
      catch { reject(new Error("Cannot create IDE transport")); return; }
      this.socket = socket;
      const timer = setTimeout(() => this.fail("IDE connection timed out"), 5000);
      this.openingReject = (error) => { clearTimeout(timer); reject(error); };
      socket.on("message", (data) => this.receive(String(data)));
      socket.on("open", () => {
        if (this.socket !== socket) return;
        clearTimeout(timer); this.openingReject = undefined; resolve();
      });
      socket.on("error", () => { if (this.socket === socket) this.fail("IDE transport failed (check plugin and authorization)"); });
      socket.on("close", () => { if (this.socket === socket) this.fail("IDE connection closed"); });
    });
  }

  request(method: string, params: unknown = {}, options: { timeout?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    if (!this.connected) return Promise.reject(new Error("IDE not connected; run /ide"));
    if (options.signal?.aborted) return Promise.reject(new Error("IDE request cancelled"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const finishError = (message: string) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id); entry.cleanup(); reject(new Error(message));
        this.notify("notifications/cancelled", { requestId: id, reason: "Client cancelled request" });
      };
      const timer = setTimeout(() => finishError("IDE request timed out"), options.timeout ?? 10_000);
      const abort = () => finishError("IDE request cancelled");
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
      this.pending.set(id, { resolve, reject, cleanup });
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        this.socket!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }), (error) => {
          if (error) finishError("Cannot send IDE request");
        });
      } catch { finishError("Cannot send IDE request"); }
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.connected) return;
    try { this.socket!.send(JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }), () => {}); }
    catch { this.fail("Cannot send IDE notification"); }
  }

  private receive(text: string): void {
    let m: any;
    try { m = JSON.parse(text); } catch { return; }
    if (!m || m.jsonrpc !== "2.0") return;
    if (typeof m.method === "string") {
      if (m.id !== undefined) {
        // The JetBrains server sends MCP ping requests while a user reviews a diff.
        try { this.socket?.send(JSON.stringify(m.method === "ping"
          ? { jsonrpc: "2.0", id: m.id, result: {} }
          : { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not supported" } }), () => {}); }
        catch { this.fail("Cannot reply to IDE request"); }
      } else {
        this.onNotification(m.method, m.params);
      }
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id); p.cleanup();
    // Do not surface arbitrary server error strings: they can contain credentials.
    if (m.error) p.reject(new Error(`IDE RPC failed (code ${Number(m.error.code)})`));
    else if ("result" in m) p.resolve(m.result);
    else p.reject(new Error("Malformed IDE response"));
  }

  close(): void { this.fail("IDE disconnected", true); }

  private fail(message: string, graceful = false): void {
    const socket = this.socket;
    this.socket = undefined;
    this.openingReject?.(new Error(message)); this.openingReject = undefined;
    for (const p of this.pending.values()) { p.cleanup(); p.reject(new Error(message)); }
    this.pending.clear();
    if (socket) {
      if (graceful && socket.readyState === 1) {
        socket.close(1000);
        const timer = setTimeout(() => socket.terminate(), 500);
        timer.unref();
        socket.on("close", () => clearTimeout(timer));
      } else socket.terminate();
      this.onClose();
    }
  }
}
