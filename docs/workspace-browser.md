# Workspace browser

The Browser tab opens HTTP(S) pages, including local development servers. Tabs
retain their pages while hidden or while another Task is selected. Screenshots
and picked elements can be annotated and added to the Conversation.

Picking an element collects its selector, accessible name, computed styles,
HTML preview and React component/source metadata when the page exposes it.
The screenshot crops around the selected element and outlines it. Pick another
element to collect up to eight targets with comments in one chat attachment.
Page annotations and picked elements appear as inline context chips in the
prompt. The chip uses the comment as its label and opens a screenshot preview
with the page title and target counts. Detailed element context travels with the
attachment when the message is sent. Draft restore and copy/paste retain this
context; removing the chip removes its attachment.
Sent messages keep the inline chip and its screenshot popover. The screenshot
opens at full size from the popover, and remains available after reloading the
Conversation.

The browser menu provides viewport presets, custom dimensions, color scheme,
zoom, audio, developer tools and external opening. Picking an element temporarily
pauses agent interaction and restores the previous state when it finishes or is
cancelled. The browser menu also provides explicit Pause agent and Resume agent
controls.

## Agent tools

Workspace Harnesses receive the `watchtower-browser` MCP server for each Agent
Run. Its tools operate only on the current Task's tabs.

| Tool                                                | Behavior                                                                                                                                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preview_status`                                    | Lists Task tabs, URLs, titles, loading and paused state.                                                                                                                                            |
| `preview_open`                                      | Opens a page or reuses the caller's available tab.                                                                                                                                                  |
| `preview_navigate`, `preview_close`                 | Navigates or closes a tab.                                                                                                                                                                          |
| `preview_snapshot`                                  | Returns compact text, usable element refs and pending dialogs. `includeImage=true` attaches a PNG, `save=true` saves one, and `includeDiagnostics=true` adds accessibility/console/network details. |
| `preview_act`                                       | Clicks, types, presses keys, scrolls, hovers, selects options, drags or uploads checkout files.                                                                                                     |
| `preview_evaluate`                                  | Evaluates page JavaScript and returns a bounded result.                                                                                                                                             |
| `preview_wait_for`                                  | Waits for an element, text, URL or JavaScript condition.                                                                                                                                            |
| `preview_resize`, `preview_set_appearance`          | Emulates viewport dimensions and color scheme.                                                                                                                                                      |
| `preview_dialog`                                    | Accepts or dismisses a page dialog.                                                                                                                                                                 |
| `preview_recording_start`, `preview_recording_stop` | Captures timestamped screenshots and saves a standalone HTML playback file.                                                                                                                         |

Use a `tabId` returned by open or status when multiple tabs exist. Use a fresh
snapshot after navigation, another snapshot, or interrupted control. Page text,
scripts and diagnostics are untrusted page content.

Snapshot text is capped at 20,000 UTF-8 bytes including metadata. Images and
diagnostics default to off. Each tool advertises only its relevant arguments.

## Limits

Separate browser profiles, importing other browsers' credentials, native
passkeys, picture-in-picture and encoded video export remain outside this
implementation. Recordings are screenshot playback files, not video files.
