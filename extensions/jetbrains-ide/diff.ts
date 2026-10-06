import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { inside } from "./discovery.ts";
import type { IdeProtocol } from "./protocol.ts";

export interface FileIdentity { dev: bigint; ino: bigint }
export const sameFile = (a: FileIdentity, b: FileIdentity): boolean => a.dev === b.dev && a.ino === b.ino;
export interface FileProposal {
  path: string;
  originalContent: string | undefined;
  originalIdentity?: FileIdentity;
  proposedContent: string;
}

export async function snapshotFile(path: string): Promise<{ content: string; identity: FileIdentity } | undefined> {
  if (!constants.O_NOFOLLOW) throw new Error("Safe edit review requires filesystem O_NOFOLLOW support");
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const identity = await handle.stat({ bigint: true });
      if (!identity.isFile()) throw new Error("Review target must be a regular file");
      const bytes = await handle.readFile();
      if (bytes.includes(0) || !Buffer.from(bytes.toString("utf8")).equals(bytes)) throw new Error("Edit review requires UTF-8 text files");
      return { content: bytes.toString("utf8"), identity };
    } finally { await handle.close(); }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
}

export async function snapshot(path: string): Promise<string | undefined> {
  return (await snapshotFile(path))?.content;
}

export async function assertReviewTarget(path: string, cwd: string): Promise<void> {
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
    await assertReviewTarget(file.path, cwd);
    const current = await snapshotFile(file.path);
    if (current?.content !== file.originalContent || file.originalIdentity && (!current || !sameFile(current.identity, file.originalIdentity))) {
      throw new Error("File changed before/during edit review; original tool blocked. Read the file again and retry.");
    }
  }
}

const normalized = (text: string) => text.replace(/\r\n|\r/g, "\n");

export function assertReviewProposal(file: FileProposal): void {
  if (file.proposedContent.includes("\0") || Buffer.from(file.proposedContent).toString("utf8") !== file.proposedContent) throw new Error("Edit review requires a valid UTF-8 text proposal");
  if (Buffer.byteLength(file.proposedContent) > 2 * 1024 * 1024) throw new Error("Review proposal exceeds 2 MiB");
}

export class ModifiedIdeProposalError extends Error {}

// Approval only: the native tool remains responsible for committing the proposal.
export async function reviewEdit(ide: IdeProtocol, file: FileProposal, signal?: AbortSignal,
  onDecision?: (accepted: boolean) => void): Promise<boolean> {
  assertReviewProposal(file);
  const tab = `Pi review: ${basename(file.path)} (${randomUUID()})`;
  try {
    const decision = await ide.openDiff(file.path, file.proposedContent, tab, signal);
    if (signal?.aborted || !ide.connection.connected) throw new Error("IDE review interrupted; original tool blocked");
    if (!decision.accepted) { onDecision?.(false); return false; }
    // The native tool's proposal remains the source of truth. Arbitrary edits in
    // the IDE would change the requested operation, so they require a new call.
    if (normalized(decision.contents) !== normalized(file.proposedContent)) {
      throw new ModifiedIdeProposalError("Proposal was edited in PyCharm; original tool blocked. Reject and ask Pi to propose that change instead.");
    }
    onDecision?.(true);
    return true;
  } finally {
    await ide.closeTab(tab).catch(() => {});
  }
}
