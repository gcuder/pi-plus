# Pi ↔ official Claude Code JetBrains plugin

A local Pi extension for an **external terminal** and the existing official Claude Code JetBrains plugin. No new IDE plugin, ACP, chat panel, Plan Mode, or general MCP server manager.

## Install / use

Requires Pi **1.0.2** (`@earendil-works/pi-coding-agent`), Node 22.19+, and the official Claude Code JetBrains plugin enabled in PyCharm. Tested protocol target: plugin **0.1.14-beta**. No running Claude Code CLI or Claude login is needed for the local handshake.

```sh
# Deploy Pi+ and the reviewed built-in editing tools:
./scripts/install.sh
./scripts/doctor.sh
pi
```

Restart Pi after installation; do not load the deployed copy and checkout copy together. The installer installs the isolated `ws` transport dependency and uses Pi's public tool factories. It does not patch dependency sources.

Existing installs: running the installer replaces the managed settings and npm dependency tree, removing `pi-hashline-edit-pro`. Remove any additional user/project declarations or manually installed copies of that extension before restarting. Review mode checks that the bridge owns `edit` and `write` on every call and blocks conflicting registrations. Remove conflicting editing extensions before restarting.

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

**Alt+R** toggles Review/Auto using the same mode switch as `/edit-mode`. Ctrl+R remains Pi's session-rename shortcut; Shift+Tab remains thinking-level cycling; pi-code's Ctrl+Alt+P still controls Plan Mode.

Pi's persistent extension status row shows **REVIEW** (the session default) or **AUTO**, followed by `IDE: PyCharm` when connected or `IDE: disconnected` when there is no active connection. Both the command and shortcut update it immediately. The items coexist with Plan Mode and other extension statuses, including in status-aware custom footers. Displaying status never discovers or connects to an IDE. Switching to Auto cancels pending reviews without approving them.

Pi+'s `config/settings.json` enables OMP's supported `extension_statuses` secondary row. OMP's default Claude preset hides that row; other custom footers must also opt into showing extension statuses. On macOS, configure your terminal's Option key to send Alt for Alt+R.

`/ide` discovers lazily; no startup socket or background reconnect loop. Pending changes are never replayed after reconnect. Disconnect cancels pending reviews; a subsequent Review-mode mutation or explicit IDE command can reconnect. To edit without an IDE, use `/edit-mode auto`.

**Ask Pi to edit normally**, e.g. “Read `example.py` and replace this function.” The model uses its existing tools, not `ide_diff`:

1. The bridge registers Pi's built-in `edit` and `write` definitions with supported filesystem hooks. Schemas, argument preparation, matching, newline handling, rendering and result details come from Pi.
2. The native tool computes its proposal inside Pi's per-file mutation queue. The official plugin opens its native diff before any write or parent directory creation.
3. **Apply** authorizes the exact computed proposal. The same native execution continues and writes it after checking that disk content is unchanged.
4. **Reject**, closing the tab, stale files, missing IDE, unknown response, cancellation or connection loss fails the tool without writing. There is no mutate-then-undo fallback.

Use one `edit` call with multiple disjoint `edits[]` entries to review a combined change to one file. Separate calls each get their own review; calls targeting the same file are serialized through review and commit. Changes to different files are not an all-or-nothing transaction. No-op calls need no IDE review.

The native proposed side is editable, but **editing it makes approval fail closed** (except the plugin's LF normalization). Reject and request a revised edit instead. Pi's native tool remains responsible for BOM and newline behavior; the IDE response is never written directly.

`ide_diff` was removed: review is internal to normal editing, not a model-facing opt-in tool. `/edit-mode` is independent of `pi-code` Plan Mode. Calls still pass through Pi's tool validation and permission hooks before execution. Auto delegates directly to unmodified native tools without review-specific proposals, disk checks or IDE work.

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
- Diff targets must be regular text files inside Pi's current working directory (or new write targets, including missing parents). Symlink targets and outside paths are rejected. Snapshots and commits use `O_NOFOLLOW`; existing targets must retain their reviewed file identity and bytes. Commits write through the verified file descriptor, and new files use exclusive creation. Filesystems without `O_NOFOLLOW` support fail closed. Disk changes during review abort the write. This is optimistic checking, not an atomic cross-process lock: do not concurrently edit the same file or rename its parent directories during Apply.

## Limitations / compatibility

This is an **unofficial internal Claude IDE protocol**, not a supported Anthropic integration contract. Future plugin versions can change discovery, authentication, MCP version, method schemas, or decision sentinels. Runtime capability checks detect absent methods, but cannot prove new versions retain identical semantics. Re-run manual tests after upgrades.

- Native UI availability and both decision branches are confirmed in installed plugin code and advertised by the live server. Automated tests simulate those branches, and the user has confirmed the live integration works. Use the manual procedure below for detailed acceptance/regression checks. Do not treat a successful handshake as proof of visual/UI operation.
- Save existing PyCharm buffers before review. The IDE's original side can include unsaved edits; there is no advertised dirty-buffer/revision query to reconcile them with disk.
- Native response LF normalization is accounted for; the original tool remains responsible for exact BOM/newline bytes. Proposals over 2 MiB, binary/invalid UTF-8 files, symlinks and targets outside Pi's cwd fail closed in Review mode.
- No filesystem sandbox: shell scripts, formatters, custom tools, deletion/rename through other tools, and other processes are **not intercepted**. A rejected change must not be retried via another tool. Review protects the listed mutation tools, not arbitrary disk access.
- Review covers only `edit` and `write`. There is no built-in anchor editing, cross-file move/copy, batch undo or rollback. Legacy `replace`, `replace_within`, `insert`, `copy`, `move` and `undo_last_change` calls are blocked in Review mode if another extension still registers them.
- Review timeout: 30 minutes; ordinary RPC timeout: 10 seconds; connection timeout: 5 seconds. Close/reject the native tab or use `/ide disconnect` / `/edit-mode auto` to cancel a pending review. Switching mode cancels the pending call; it does **not** retroactively approve it. Native tool abort signals cancel pending reviews and queued edits. Cancellation cannot reverse a filesystem write already in progress. Best-effort tab cleanup is not guaranteed if the IDE vanishes.
- No heartbeats initiated by this client; server MCP pings are answered. A half-open connection is detected by request timeout/transport failure, not immediately while idle.
- `pi-code` remains owner of Plan Mode and permissions. The bridge wraps native `edit` and `write` through supported tool registration and never invokes nested editing tools.
- The bridge uses the public `createEditToolDefinition` and `createWriteToolDefinition` APIs. Pi owns path normalization, replacement matching and per-file serialization. The bridge delays filesystem writes for approval; it does not patch npm packages or maintain a second editing algorithm. Re-run parity and manual approval tests before upgrading Pi.
- The plugin's `ide_connected`/Reject handling includes Claude-specific terminal focus behavior. With an external Pi terminal, focus may stay in PyCharm or move to an IDE terminal; no iTerm2 focus guarantee. Multiple Claude/Pi clients can coexist at transport level but plugin terminal focus heuristics are Claude-specific.

## Automated tests

```sh
npm ci
npm ci --prefix extensions/jetbrains-ide --omit=peer --ignore-scripts
npm test --prefix extensions/jetbrains-ide
npm run typecheck --prefix extensions/jetbrains-ide
```

Tests use Node's built-in runner, fake sockets and temporary fixtures; no PyCharm is required. Native tool tests compare reviewed execution against unmodified Pi definitions, including results and BOM/CRLF/mixed-ending bytes. Coverage includes transport/auth/discovery, registration/modes, multi-replacement edits, parallel same-file calls, rejection without creating directories, stale files, edited proposals, invalid inputs, unsafe paths, late symlink/inode replacement, tool ownership conflicts, unsupported Pi versions and cancellation. A real SDK session verifies argument preparation, validation and permission hooks. A real Pi TUI with a test terminal verifies shortcut registration, terminal key dispatch, persistent footer rendering and coexistence with pi-code Plan Mode. A fake JetBrains server verifies that toggling to Auto cancels active and queued reviews without writing. Strict TypeScript checks cover the extension and tests.

Automated approval tests simulate IDE decisions. The previous bridge's handshake/tabs/diagnostics and live UI were verified against plugin 0.1.14-beta; the migrated native editing flow still needs the manual Apply/Reject checks below.

## Manual integration acceptance test

1. Open a **disposable repository** in PyCharm with the official plugin enabled. Save all buffers. Create/commit `ide-review.txt` containing `before\n`, plus a second file for transfer tests. Keep Claude Code closed initially.
2. Run the installer, restart Pi in an external terminal from that repository, then `/ide`, `/ide status`, `/edit-mode`. Verify the matching workspace and **review** default. Repeat discovery with two projects open.
3. Select text in PyCharm; ask for `ide_context` selection/tabs/diagnostics. Verify no unsolicited editor context per turn.
4. Ask for a normal edit using `read` then `edit` (do **not** request `ide_diff`). Verify the native two-pane diff appears while disk remains unchanged. Click **Reject**; disk must remain unchanged. Repeat and close the tab; expect rejection.
5. Repeat and click **Apply** without modifying the proposed side. Verify disk and `git diff` match the proposal. Repeat with `write`, including a new nested path: rejecting must not create parent directories. Restore fixtures through Git when needed; there is no hashline undo tool.
6. Request one `edit` call containing two disjoint entries in `edits[]`. Verify one combined proposal and no partial writes on rejection. Request two separate same-file calls and verify each reviews the file state produced by the preceding accepted call.
7. `/edit-mode auto`: repeat ordinary edits; they must execute without IDE review. `/edit-mode review`: the next edit must review again. While waiting, `/edit-mode auto`, `/ide disconnect` or Escape must cancel the pending review, not approve it. Quit PyCharm during review; disk must remain unchanged and old proposals must not replay after reconnect.
8. Edit the target on disk during review, then Apply: expect a concurrent-change failure preserving that external change. Modify the proposed side in the IDE and Apply: expect failure rather than silently writing different content.
9. Enable `pi-code` Plan Mode and verify its permissions still apply in both edit modes. Optionally run Claude Code alongside Pi and check terminal focus behavior. Disconnect/reload/exit Pi and check cleanup.

Record Pi/plugin versions and actual Apply/Reject results. No credentials should appear in status, tool outputs or logs.
