import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { assertReviewTarget, sameFile, type FileProposal } from "./diff.ts";

// Open without truncating or following a final-component symlink. Once opened,
// commit to this descriptor, never reopen a checked pathname for the write.
export async function commitReviewedFile(file: FileProposal, cwd: string, signal: AbortSignal): Promise<void> {
  if (!constants.O_NOFOLLOW) throw new Error("Safe edit review requires filesystem O_NOFOLLOW support");
  if (signal.aborted) throw new Error("Edit review cancelled");
  const existing = file.originalContent !== undefined;
  const flags = constants.O_RDWR | constants.O_NOFOLLOW | (existing ? 0 : constants.O_CREAT | constants.O_EXCL);
  const handle = await open(file.path, flags, 0o666);
  try {
    const identity = await handle.stat({ bigint: true });
    if (!identity.isFile() || existing && (!file.originalIdentity || !sameFile(identity, file.originalIdentity))) {
      throw new Error("File identity changed during edit review; edit cancelled");
    }
    await assertReviewTarget(file.path, cwd);
    const current = await lstat(file.path, { bigint: true });
    if (!current.isFile() || !sameFile(current, identity)) throw new Error("File identity changed before commit; edit cancelled");
    if (existing && !Buffer.from(file.originalContent!).equals(await handle.readFile())) {
      throw new Error("File changed before commit; edit cancelled");
    }
    if (signal.aborted) throw new Error("Edit review cancelled");
    const bytes = Buffer.from(file.proposedContent, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (!bytesWritten) throw new Error("Could not write reviewed file");
      offset += bytesWritten;
    }
    await handle.truncate(bytes.length);
  } finally { await handle.close(); }
}
