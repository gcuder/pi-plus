# Pi ↔ official Claude Code JetBrains plugin

A local Pi extension for an **external terminal** and the existing official Claude Code JetBrains plugin. No new IDE plugin, ACP, chat panel, Plan Mode, or general MCP server manager.

## Install / use

Requires Pi **1.0.2** (`@earendil-works/pi-coding-agent`), Node 22.19+, the `patch` utility, **pi-hashline-edit-pro 5.1.0**, and the official Claude Code JetBrains plugin enabled in PyCharm. Tested protocol target: plugin **0.1.14-beta**. No running Claude Code CLI or Claude login is needed for the local handshake.

```sh
# Deploy Pi+ plus the guarded read-only hashline preview adapter:
./scripts/install.sh
./scripts/doctor.sh
pi
```

Restart Pi after installation (or `/reload`); do not load the deployed copy and checkout copy together. The installer installs the isolated `ws` transport dependency and patches only the pinned, SHA-256-verified hashline sources. Unknown versions or altered sources are refused; **never force the patch**. No package patching occurs at runtime.

In Pi, with the same repository open in PyCharm:

```text
/ide                    # connect to best live matching workspace
/ide status
/ide list
/ide 51711              # example only: choose a matching port from /ide list
/edit-mode              # show mode; default is review each session
/edit-mode auto         # ordinary edits, no IDE review or preview work
/edit-mode review       # restore native approval gate
/ide disconnect
```

`/ide` discovers lazily; no startup socket or background reconnect loop. Pending changes are never replayed after reconnect. Disconnect cancels pending reviews; a subsequent Review-mode mutation or explicit IDE command can reconnect. To edit without an IDE, use `/edit-mode auto`.

**Ask Pi to edit normally**, e.g. “Read `example.py` and replace this function.” The model uses its existing tools, not `ide_diff`:

1. Pi's pre-execution `tool_call` hook requests a read-only proposal for `write`, `replace`, `replace_within`, `insert`, `copy`, `move`, or `undo_last_change`.
2. The official plugin opens its native diff. Disk files, anchors and undo are unchanged during preview.
3. **Apply** (the plugin's Accept equivalent) authorizes the **original tool call**, with its original arguments and normal validation/permissions/undo behavior.
4. **Reject**, closing the tab, stale files, missing adapter/IDE, unknown response, or connection loss returns `{ block: true, reason }`; the original tool never runs. There is no mutate-then-undo fallback.

Same-file replace/insert batches review their **combined final proposal once**, before even staging a member. Remaining members share that approval only while their exact proposal/read set stays unchanged. Cross-file moves show both file diffs and require both approvals before either file changes. Copy previews also track the unchanged source as a read dependency. No-op calls need no IDE review.

The native proposed side is editable, but **editing it makes approval fail closed** (except the plugin's LF normalization). Arbitrary UI edits cannot be translated safely into the original anchor arguments. Reject and request a revised edit instead. Original tool execution preserves BOM and newline behavior; the IDE's normalized response is never written directly.

`ide_diff` was removed: review is an internal approval primitive, not a model-facing opt-in editing tool. `/edit-mode` is independent of `pi-code` Plan Mode; existing permissions can still block an accepted tool. Auto exits before proposal generation, disk inspection, adapter requests, or IDE work.

### Explicit editor context

Ask Pi to use `ide_context` with `kind: selection | tabs | diagnostics` and optional diagnostic `uri`. Selection is the latest observed notification with a timestamp, not a guaranteed polling snapshot. Focus/change selection if none arrived. No editor text is injected automatically. Outputs are bounded (24,000 characters; selection 16,000).

## Confirmed protocol (research before implementation)

Verified against local `~/.claude/ide` files, the installed official plugin's bytecode, and a live PyCharm handshake/tool enumeration. No secret or machine-specific lock file is included here.

| Surface | Confirmed wire behavior |
|---|---|
| Discovery | `~/.claude/ide/<port>.lock`: JSON `workspaceFolders: string[]`, `pid: number`, `ideName: string`, `transport: "ws"`, `runningInWindows: boolean`, `authToken: string`. Port comes from filename, not JSON. |
| Transport | `ws://127.0.0.1:<port>/`, **WebSocket subprotocol `mcp`**. `/mcp` returns 404; root without the subprotocol returns 400 in the tested plugin. |
| Authentication | `X-Claude-Code-Ide-Authorization: <authToken>` in the upgrade request; plugin checks it and closes unauthorized sockets. |
| Handshake | JSON-RPC 2.0 `initialize` with `protocolVersion: "2024-11-05"`, empty capabilities and clientInfo. Server responds with `Claude Code JetBrains Plugin`, version `0.1.14-beta`, same protocol version. Then `notifications/initialized`; plugin-specific `ide_connected` with `pid` and `isPluginVersionUnsupported: false`. |
| Tool RPC | `tools/list`; `tools/call` with `{name, arguments}`. Tools return MCP `content` blocks, optional `isError`. |
| Current editor / selection | `selection_changed` notification: `filePath`, `text`, `selection: {start: {line, character}, end: {line, character}}`; zero-based coordinates. No current-editor/selection polling tool advertised. |
| Open tabs | `get_all_opened_file_paths`, no arguments; text containing newline-separated paths. |
| Diagnostics | `getDiagnostics`, optional `uri`; file diagnostic JSON in text. `diagnostics_changed` exists in plugin code. This bridge queries explicitly instead of caching all diagnostics. |
| Native diff | `openDiff` with required `old_file_path`, `new_file_path`, `new_file_contents`, `tab_name`. Uses a native editable JetBrains diff; request remains pending for user decision. |
| Apply | Text blocks `"FILE_SAVED"`, followed by final proposal text, normalized to LF. **The plugin does not save it to the destination. This bridge uses the response only as approval, then lets the original Pi tool write.** |
| Reject / closing | `"DIFF_REJECTED"`. No accepted text. |
| Cleanup | `close_tab` with `tab_name`; bridge uses a unique tab name per review. |
| Keepalive | Server issues MCP `ping` JSON-RPC requests; bridge replies with `{}` even while waiting for diff review. |

Other advertised tools (`openFile`, `open_files`, `reformat_file`) are intentionally not exposed. Diff accept/reject are **UI actions**, not separate approval RPCs. Unknown diff outcomes, missing tools/schemas, protocol mismatches and connection loss fail closed.

Research reference: <https://github.com/ldelossa/pi-ide/blob/main/client.ts> (`@ldelossa/pi-ide` 0.2.6). That implementation currently targets `~/.pi/ide` and `x-pi-ide-authorization`; it cannot simply be pointed at Claude lock files. Its protocol assumptions were not copied into this bridge.

## Discovery / security

- Only recognized JetBrains IDE names with `transport: ws` and absolute workspaces are considered. Windows/remote lock files are excluded on this local implementation.
- PID liveness and a bounded loopback TCP probe filter stale entries; authenticated MCP handshake validates the actual server. A live PID alone is not proof of a usable plugin (PID reuse/port reuse).
- Realpath workspace scoring: exact match, deepest ancestor, then nearest child workspace. Unrelated workspaces are never auto-selected. Multiple candidates are ranked deterministically by score then port; failed handshakes fall back to the next candidate. `/ide list` and `/ide <port>` allow explicit selection among matches.
- Always numeric port + literal IPv4 loopback; no lock-supplied host/URL, redirects, DNS discovery or remote transport. Lock files are read, never modified/deleted.
- Tokens exist only during discovery/upgrade, not in status, model context, transcript entries, configuration or error logs. Transport/RPC errors are sanitized. Local processes running as your user can still access the original Claude lock directory; protect its permissions.
- Diff targets must be regular text files inside Pi's current working directory (or new write targets, including missing parents). Symlink targets and outside paths are rejected. Disk changes during review abort the write. This is optimistic checking, not an atomic cross-process lock: do not concurrently edit the same file during Apply.

## Limitations / compatibility

This is an **unofficial internal Claude IDE protocol**, not a supported Anthropic integration contract. Future plugin versions can change discovery, authentication, MCP version, method schemas, or decision sentinels. Runtime capability checks detect absent methods, but cannot prove new versions retain identical semantics. Re-run manual tests after upgrades.

- Native UI availability and both decision branches are confirmed in installed plugin code and advertised by the live server. Automated tests simulate those branches, and the user has confirmed the live integration works. Use the manual procedure below for detailed acceptance/regression checks. Do not treat a successful handshake as proof of visual/UI operation.
- Save existing PyCharm buffers before review. The IDE's original side can include unsaved edits; there is no advertised dirty-buffer/revision query to reconcile them with disk.
- Native response LF normalization is accounted for; the original tool remains responsible for exact BOM/newline bytes. Proposals over 2 MiB, binary/invalid UTF-8 files, symlinks and targets outside Pi's cwd fail closed in Review mode.
- No filesystem sandbox: shell scripts, formatters, custom tools, deletion/rename through other tools, and other processes are **not intercepted**. A rejected change must not be retried via another tool. Review protects the listed mutation tools, not arbitrary disk access.
- Cross-file approval is all-or-nothing before execution, not a new transactional writer. Original copy/move semantics still govern commit and undo; cross-file move undo continues to require undoing both files.
- Review timeout: 30 minutes; ordinary RPC timeout: 10 seconds; connection timeout: 5 seconds. Close/reject the native tab or use `/ide disconnect` / `/edit-mode auto` to cancel a pending review. Switching mode cancels the pending call; it does **not** retroactively approve it. Pi's `tool_call` context does not guarantee an abort signal, so Escape alone may not close a pending IDE request immediately. Original tools retain their abort checks. Best-effort tab cleanup is not guaranteed if the IDE vanishes.
- No heartbeats initiated by this client; server MCP pings are answered. A half-open connection is detected by request timeout/transport failure, not immediately while idle.
- `pi-code` remains owner of Plan Mode and permissions. The bridge does not change active tools or translate accepted edits into a nested `write`.
- Hashline remains owner of anchors, byte encoding, batch commits, undo and session state. This is a narrow **454-line local patch**, not a second anchor resolver. Its event-bus adapter shares the loaded hashline instance/session registry, reuses real read-only pipelines, captures their bytes/read dependencies, and shares batch planning/composition and byte reconstruction with original execution. `requirePath` is neither enabled nor changed. Re-port and test the adapter before upgrading hashline beyond the pinned version.
- The plugin's `ide_connected`/Reject handling includes Claude-specific terminal focus behavior. With an external Pi terminal, focus may stay in PyCharm or move to an IDE terminal; no iTerm2 focus guarantee. Multiple Claude/Pi clients can coexist at transport level but plugin terminal focus heuristics are Claude-specific.

## Automated tests

```sh
npm ci
node scripts/patch-hashline.mjs
npm ci --prefix extensions/jetbrains-ide --omit=peer --ignore-scripts
npm test --prefix extensions/jetbrains-ide
```

Tests use Node's built-in runner, fake sockets and temporary fixtures; no PyCharm needed. Actual installed hashline tools run in one shared module graph via `jiti`, with isolated session/config state. Coverage includes transport/auth/discovery, registration/modes, every mutation gate, inert built-in write previews, real hashline preview-to-commit parity, BOM/CRLF/mixed endings, combined batches/opposite insert pairs, source dependencies, moves, undo/stale history, rejection/cancellation and fail-closed adapter behavior.

Current automated validation: **34 tests pass**, strict TypeScript checks pass, and a clean disposable `PI_DIR` installation plus doctor and Pi RPC-mode extension-load smoke test pass. The native transport handshake/tabs/diagnostics were previously verified against live plugin 0.1.14-beta; automated approval tests use simulated IDE decisions. The user subsequently confirmed the live integration works.

Strict TypeScript checks cover extension/tests and patched adapter sources. Use the following checklist for per-tool acceptance checks and regression testing after upgrades. A successful handshake alone does not prove native UI behavior.

## Manual integration acceptance test

1. Open a **disposable repository** in PyCharm with the official plugin enabled. Save all buffers. Create/commit `ide-review.txt` containing `before\n`, plus a second file for transfer tests. Keep Claude Code closed initially.
2. Run the installer, restart Pi in an external terminal from that repository, then `/ide`, `/ide status`, `/edit-mode`. Verify the matching workspace and **review** default. Repeat discovery with two projects open.
3. Select text in PyCharm; ask for `ide_context` selection/tabs/diagnostics. Verify no unsolicited editor context per turn.
4. Ask for a normal edit using `read` then `replace` (do **not** request `ide_diff`). The native two-pane diff must appear while disk remains `before`. Click **Reject**; disk must remain unchanged and no undo record should appear. Repeat and close the tab; expect rejection.
5. Repeat and click **Apply** without modifying the proposed side. Verify the original `replace` ran, disk and `git diff` match the proposal, fresh anchors work, and normal undo restores the original. Repeat with `write`, `replace_within`, `insert`, `copy`, `move`, and `undo_last_change`.
6. Request two disjoint same-file replace/insert calls in one assistant message. Verify one combined proposal is shown before any staging/write and Apply yields one normal batch commit/undo. Reject the batch; no member may write.
7. Request a cross-file move. Verify both diffs are reviewed before either file changes. Reject the second diff; neither file may change. Repeat and accept both. Undo both files using normal hashline undo.
8. `/edit-mode auto`: repeat ordinary edits; they must execute without connecting/review. `/edit-mode review`: the next edit must review again. While waiting, `/edit-mode auto` or `/ide disconnect` must cancel/block the pending call, not apply it. Quit PyCharm during review; disk must remain unchanged and old proposals must not replay after reconnect.
9. Edit the file (or a copy source's interior) on disk during review, then Apply: expect a concurrent-change block preserving that external change. Modify the proposed side in the IDE and Apply: expect a block, not an unreviewed replacement tool call. Test a new `write` path whose parents do not yet exist: rejecting must not create directories.
10. Enable `pi-code` Plan Mode and verify its permissions still apply in both edit modes. Optionally run Claude Code alongside Pi and check terminal focus behavior. Disconnect/reload/exit Pi and check cleanup.

Record Pi/plugin versions and actual Apply/Reject results. No credentials should appear in status, tool outputs or logs.
