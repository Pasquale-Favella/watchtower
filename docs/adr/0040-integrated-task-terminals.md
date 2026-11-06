# Workspace terminals run as main-owned shells in their checkout

Status: accepted for the workspace terminal drawer; authenticated native turns, packaged-app verification and Linux/macOS evidence remain pending.

Related work: [issue #178](https://github.com/Pasquale-Favella/watchtower/issues/178) and [workspace interaction plan](../plans/workspace-interaction.md). The domain and execution ownership in [ADR 0039](0039-agent-workspace-domain-and-execution.md) continue to apply; a terminal is an operator tool for a Task, not an Agent Session or Agent Run.

The workspace needs a shell that belongs to its selected checkout. A user can inspect or run commands beside a conversation, including before its first message. A terminal must survive navigating to another Task and back, and hiding the drawer must not terminate work the user started. An in-renderer shell cannot provide this, because renderer reloads and view changes would own the process.

## Decision

- **node-pty runs in the main process.** Each session is a pseudo-terminal owned by the application's terminal host, behind a core port (`TerminalHost`) with an infrastructure adapter. The adapter loads the native binding lazily through `createRequire`, so importing the workspace does not load a native module. Windows uses ConPTY through the bundled `conpty.dll`, which avoids node-pty's helper process that would otherwise be forked from an Electron binary.
- **The server resolves the working directory.** The renderer names a Task or an unsent draft with a Project and optional checkout. The platform handler resolves the stored checkout, and the host verifies that it exists before spawning. No RPC accepts a cwd. No project uses the persistent managed checkout without creating a Task.
- **Sessions are keyed by owner and terminal id.** An owner is a Task or an unsent draft. Ids are `term-1` through `term-32`, with at most four panes per split group and at most 32 live sessions application-wide. Drawer and side-panel groups allocate distinct ids. Exceeding a limit fails with a typed error. A session that exits keeps its scrollback until it is restarted or closed.
- **First submission preserves existing shells.** When the draft and Task resolve to the same checkout, adoption transfers their processes, scrollback and layout without restarting. Late draft requests resolve through the same adoption. If submission creates a different worktree, existing shells remain available in explicitly labelled previous-checkout tabs. New Task terminals use the Task's checkout.
- **Scrollback is bounded.** Each session keeps at most 512 KiB, dropping the oldest output first. Output is coalesced for a few milliseconds before it is stored and sent. Attaching sends a snapshot at the current sequence and then live output; the client drops any frame whose sequence is not newer than the last applied one.
- **A slow subscriber fails rather than grows.** Each attachment has a bounded queue and a byte budget. When either overflows, the stream ends with `stream-overflow` and the client attaches again to receive a fresh snapshot.
- **The application owns the lifetime, not the view.** Hiding the drawer, changing tabs or navigating between Tasks keeps the processes running. Explicitly closing a terminal or its side-panel tab ends its sessions, with confirmation for running processes. Close sends a hang-up, waits one second, then kills the process tree. Application shutdown closes all owned sessions through a scoped finalizer.
- **Environment is scrubbed.** Electron launch state (`ELECTRON_RUN_AS_NODE`, renderer port and URL), `VITE_*` and `WATCHTOWER_*` entries are removed. Shells start as `pwsh.exe -NoLogo`, then Windows PowerShell, then `ComSpec` on Windows, and as login shells from `$SHELL`, then `/bin/bash` and `/bin/sh` elsewhere.
- **The renderer uses xterm.js.** Drawer and side-panel groups use `@xterm/xterm` with the fit and web-links addons. Links can open in the integrated browser. Copy, paste, clear, restart and selected-output context use the same session identity. Colours come from the app's theme tokens. Resize is sent only while the session runs.

## Consequences

- node-pty is a native dependency. Version 1.1.0, the newest stable release, ships N-API prebuilds for Windows and macOS but not for Linux, so a Linux install compiles it with node-gyp. The 1.2.0 prereleases include Linux prebuilds. The package is unpacked from asar for packaging, and its macOS spawn helper must remain executable.
- ConPTY behaviour and the bundled `conpty.dll` version are Windows-specific and are verified by the terminal host tests with a fake spawner, plus a probe that loads the module under Electron's Node runtime. Interactive shell behaviour in the packaged app remains a manual gate.
- Output is treated as untrusted terminal data. Error messages returned to the renderer are fixed strings, and raw native failures are not serialized.
- Retention of exited sessions is bounded per Task, not by age; a user who opens many Tasks can keep up to 32 live shells and their scrollback until they close them or the app quits.
