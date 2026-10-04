import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { inside } from "./discovery.ts";
import type { IdeProtocol } from "./protocol.ts";

export interface FileProposal {
  path: string;
  originalContent: string | undefined;
  proposedContent: string;
}

export async function snapshot(path: string): Promise<string | undefined> {
  try {
    const bytes = await readFile(path);
    if (bytes.includes(0) || !Buffer.from(bytes.toString("utf8")).equals(bytes)) throw new Error("IDE review requires UTF-8 text files");
    return bytes.toString("utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
}

async function checkedPath(path: string, cwd: string): Promise<void> {
  if (path !== resolve(path)) throw new Error("Preview provider must supply absolute file paths");
  const root = await realpath(cwd);
  // New write targets may have nonexistent parent directories. Check the nearest
  // existing ancestor without creating anything before user approval.
  let parent = dirname(path);
  while (true) {
    try {
      if (!inside(root, await realpath(parent))) throw new Error("Review target must be inside Pi's working directory");
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const entry = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (entry?.isSymbolicLink()) throw new Error("Review parent contains a dangling symlink");
      const next = dirname(parent);
      if (next === parent) throw e;
      parent = next;
    }
  }
  const stat = await lstat(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return undefined;
    throw e;
  });
  if (stat && !stat.isFile()) throw new Error("Review target must be a regular file, not a symlink or directory");
}

export async function assertPreviewUnchanged(files: FileProposal[], cwd: string): Promise<void> {
  for (const file of files) {
    await checkedPath(file.path, cwd);
    if (await snapshot(file.path) !== file.originalContent) {
      throw new Error("File changed before/during IDE review; original tool blocked. Read fresh anchors and retry.");
    }
  }
}

const normalized = (text: string) => text.replace(/\r\n|\r/g, "\n");

// Internal approval primitive only. It NEVER writes, calls another editing tool,
// or rolls back anything. The tool_call handler decides whether execution proceeds.
export async function reviewEdit(ide: IdeProtocol, file: FileProposal, signal?: AbortSignal): Promise<boolean> {
  if (file.proposedContent.includes("\0") || Buffer.from(file.proposedContent).toString("utf8") !== file.proposedContent) throw new Error("IDE review requires a valid UTF-8 text proposal");
  if (Buffer.byteLength(file.proposedContent) > 2 * 1024 * 1024) throw new Error("Review proposal exceeds 2 MiB");
  const tab = `Pi review: ${basename(file.path)} (${randomUUID()})`;
  try {
    const decision = await ide.openDiff(file.path, file.proposedContent, tab, signal);
    if (!decision.accepted) return false;
    if (signal?.aborted || !ide.connection.connected) throw new Error("IDE review interrupted; original tool blocked");
    // The original anchor-based operation must remain the source of truth. The
    // plugin makes the proposed side editable, but translating arbitrary UI edits
    // back to anchors would change semantics/undo. Never silently ignore UI edits.
    if (normalized(decision.contents) !== normalized(file.proposedContent)) {
      throw new Error("Proposal was edited in PyCharm; original tool blocked. Reject and ask Pi to propose that change instead.");
    }
    return true;
  } finally {
    await ide.closeTab(tab).catch(() => {});
  }
}
