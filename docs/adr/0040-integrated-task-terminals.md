# Task terminals run as main-owned shells in the Task's checkout

Status: accepted for the workspace terminal drawer; authenticated native turns, packaged-app verification and Linux/macOS evidence remain pending.

Related work: [issue #178](https://github.com/Pasquale-Favella/watchtower/issues/178) and [workspace interaction plan](../plans/workspace-interaction.md). The domain and execution ownership in [ADR 0039](0039-agent-workspace-domain-and-execution.md) continue to apply; a terminal is an operator tool for a Task, not an Agent Session or Agent Run.

The workspace needs a shell that belongs to the Task's checkout: a user can inspect or run commands beside the conversation without sending input to another Task's directory. A terminal must survive navigating to another Task and back, and closing the drawer must not terminate work the user started. An in-renderer shell cannot provide this, because renderer reloads and view changes would own the process.

## Decision

- **node-pty runs in the main process.** Each session is a pseudo-terminal owned by the application's terminal host, behind a core port (`TerminalHost`) with an infrastructure adapter. The adapter loads the native binding lazily through `createRequire`, so importing the workspace does not load a native module. Windows uses ConPTY through the bundled `conpty.dll`, which avoids node-pty's helper process that would otherwise be forked from an Electron binary.
- **The server resolves the working directory.** The renderer names a Task and a tab. The platform handler asks the Task's checkout resolver for the directory, and the host verifies that it exists before spawning. No RPC accepts a cwd.
- **Sessions are keyed by (Task, terminal id).** Ids are `term-1` through `term-4`, at most four per Task and at most 32 live sessions application-wide. Exceeding a limit fails with a typed error. A session that exits keeps its scrollback until it is restarted or closed.
- **Scrollback is bounded.** Each session keeps at most 512 KiB, dropping the oldest output first. Output is coalesced for a few milliseconds before it is stored and sent. Attaching sends a snapshot at the current sequence and then live output; the client drops any frame whose sequence is not newer than the last applied one.
- **A slow subscriber fails rather than grows.** Each attachment has a bounded queue and a byte budget. When either overflows, the stream ends with `stream-overflow` and the client attaches again to receive a fresh snapshot.
- **The application owns the lifetime, not the view.** Sessions are ended by close, by the process ending, or when the app scope closes through a scoped finalizer. Closing a tab or the drawer does not kill its process. Close sends a hang-up, waits one second, then kills the process tree.
- **Environment is scrubbed.** Electron launch state (`ELECTRON_RUN_AS_NODE`, renderer port and URL), `VITE_*` and `WATCHTOWER_*` entries are removed. Shells start as `pwsh.exe -NoLogo`, then Windows PowerShell, then `ComSpec` on Windows, and as login shells from `$SHELL`, then `/bin/bash` and `/bin/sh` elsewhere.
- **The renderer uses xterm.js.** The drawer uses `@xterm/xterm` with the fit and web-links addons. Links open through the existing `shell:open-external` path, and colours come from the app's theme tokens. Resize is sent only while the session runs.

## Consequences

- node-pty is a native dependency. Version 1.1.0, the newest stable release, ships N-API prebuilds for Windows and macOS but not for Linux, so a Linux install compiles it with node-gyp. The 1.2.0 prereleases include Linux prebuilds. The package is unpacked from asar for packaging, and its macOS spawn helper must remain executable.
- ConPTY behaviour and the bundled `conpty.dll` version are Windows-specific and are verified by the terminal host tests with a fake spawner, plus a probe that loads the module under Electron's Node runtime. Interactive shell behaviour in the packaged app remains a manual gate.
- Output is treated as untrusted terminal data. Error messages returned to the renderer are fixed strings, and raw native failures are not serialized.
- Retention of exited sessions is bounded per Task, not by age; a user who opens many Tasks can keep up to 32 live shells and their scrollback until they close them or the app quits.
