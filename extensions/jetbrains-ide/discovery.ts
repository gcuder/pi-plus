import { readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { connect } from "node:net";

export interface IdeInstance {
  port: number;
  pid: number;
  ideName: string;
  workspaceFolders: string[];
  authToken: string;
}

// Never accept a URL/host from a lock file. The filename supplies only a port.
export function parseLock(filename: string, text: string): IdeInstance | undefined {
  if (!/^\d+\.lock$/.test(basename(filename))) return;
  const port = Number(basename(filename).slice(0, -5));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  try {
    const d = JSON.parse(text);
    if (!d || d.transport !== "ws" || d.runningInWindows === true ||
        !Number.isSafeInteger(d.pid) || d.pid <= 0 ||
        typeof d.ideName !== "string" || !/^(PyCharm|IntelliJ IDEA|WebStorm|GoLand|CLion|Rider|RubyMine|PhpStorm|RustRover|DataGrip|Android Studio|Aqua)(\b|$)/i.test(d.ideName) ||
        typeof d.authToken !== "string" || !d.authToken || /[\r\n]/.test(d.authToken) ||
        !Array.isArray(d.workspaceFolders) || !d.workspaceFolders.every((p: unknown) => typeof p === "string" && isAbsolute(p))) return;
    return { port, pid: d.pid, ideName: d.ideName, workspaceFolders: d.workspaceFolders, authToken: d.authToken };
  } catch { return; }
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

export function portListening(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (alive: boolean) => { socket.destroy(); done(alive); };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export function inside(parent: string, child: string): boolean {
  const r = relative(parent, child);
  return r === "" || (!isAbsolute(r) && r !== ".." && !r.startsWith(`..${sep}`));
}

// Exact workspace > deepest ancestor > nearest child workspace. Never pick an unrelated IDE.
export function workspaceScore(folders: string[], cwd: string): number {
  const target = resolve(cwd);
  return Math.max(0, ...folders.map((folder) => {
    const root = resolve(folder);
    if (root === target) return 3_000_000;
    if (inside(root, target)) return 2_000_000 + root.length;
    if (inside(target, root)) return 1_000_000 - relative(target, root).length;
    return 0;
  }));
}

export interface DiscoveryOptions {
  dir?: string;
  isAlive?: (pid: number) => boolean;
  isListening?: (port: number) => Promise<boolean>;
}

export async function discover(cwd: string, options: DiscoveryOptions = {}): Promise<IdeInstance[]> {
  const dir = options.dir ?? join(homedir(), ".claude", "ide");
  let names: string[];
  try { names = await readdir(dir); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Cannot read Claude IDE discovery directory. Check its permissions.");
  }
  const canonical = async (p: string) => realpath(p).catch(() => resolve(p));
  const target = await canonical(cwd);
  const found: Array<{ instance: IdeInstance; score: number }> = [];
  for (const name of names.sort()) {
    if (!/^\d+\.lock$/.test(name)) continue;
    let instance: IdeInstance | undefined;
    try { instance = parseLock(name, await readFile(join(dir, name), "utf8")); }
    catch { continue; } // An IDE may remove a lock between listing and reading.
    if (!instance || !(options.isAlive ?? pidAlive)(instance.pid)) continue;
    const folders = await Promise.all(instance.workspaceFolders.map(canonical));
    const score = workspaceScore(folders, target);
    if (score === 0 || !await (options.isListening ?? portListening)(instance.port)) continue;
    found.push({ instance, score });
  }
  return found.sort((a, b) => b.score - a.score || a.instance.port - b.instance.port).map(({ instance }) => instance);
}
