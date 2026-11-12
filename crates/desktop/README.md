# Native desktop

`cargo run -p hpharness-desktop` starts the native Rust application after `npm run build`. Node.js must be installed. The desktop launches the JSONL client for the persistent Cordis service; closing the GUI does not terminate managed agent jobs. Ordinary interactive terminal sessions close with the GUI.

The renderer and interaction code are Rust (`eframe`/`egui` 0.33.3, OpenGL). No webview or JavaScript UI is used. GPUI was an initial candidate, not a settled requirement; this build uses eframe to deliver a compiled Windows implementation. The public UI-to-service boundary is JSONL and does not depend on the renderer.

## Using the application

1. Register a project with an absolute root directory. For SSH, enter an existing SSH config Host alias and a remote absolute path. Docker container names are optional. New sessions can override their execution target and directory.
2. Open **설정** at the bottom of the sidebar, or click the model name in the composer, to choose Responses, Chat Completions, or Anthropic protocol, endpoint, model, and optional API-key file path. Advanced JSON edits the full backend settings. The default local endpoint is `http://localhost:10100/v1`.
3. Send a task from the centered composer with its send button or Ctrl+Enter. Assistant text renders as Markdown; tool results can be expanded. Review tool approvals through **응답 필요** or the execution panel. Requests submitted while busy queue in the backend. Failed submissions are restored to the composer. The composer **+** opens file navigation; it does not silently attach files to a request.
4. Switch to **편집**, browse files, edit syntax-highlighted native buffers, and save with Ctrl+S. The split view compares the last saved source with the editable buffer. File versions prevent overwriting externally modified files; an outstanding save never marks more recent edits as saved. Buffers and project layout are persisted locally by eframe.
5. In settings, select a language server preset or provide an executable and JSON argument array. It runs in the selected local/SSH/container environment. Language servers are separately installed. Completion, definition, references, and diagnostics use LSP; Ctrl+Space requests completion. Completion ranges account for UTF-16, including Korean and emoji. Click a result to apply or navigate.
6. **터미널** opens a real ConPTY/Unix PTY with a VT100 screen parser, local shell or SSH/Docker shell, input line, interrupt, arrows, Tab and Esc. **명령 실행** is a separate captured-command console. The terminal pane is intentionally a basic terminal, not a full xterm/WezTerm emulator.
7. **Git diff** loads the actual repository patch. Remove unwanted complete hunks from the editable unified patch, then stage the selected patch; Git validates its context before applying. It does not silently reconstruct malformed patches.
8. **도구 연결** is an advanced JSON RPC surface for installed browser, MCP, memory, knowledge, integration and other service methods. These are real calls and may change state. Refer to backend method documentation for parameters.
9. Click PNG/JPEG/GIF/WebP files to open a native image preview. The service enforces the workspace boundary and 10 MB input limit; decoding runs off the UI thread with image dimension/allocation limits. Office/PDF files show an explicit unsupported-preview notice rather than opening binary data as text.

The sidebar groups tasks under their project and can be collapsed. The execution panel starts closed; use the terminal icon in the header to open it. Chat mode keeps the conversation readable at a bounded width, while edit mode gives the code editor more space. At narrow widths, secondary side panes are hidden and the header switches between chat and editing.

Core reload takes an optional candidate JavaScript path and a choice to migrate active runs at a safe boundary. Settings, memory, target identity, approval state and errors are visible in native controls.

## Environment overrides

| Variable | Purpose |
| --- | --- |
| `HPH_ROOT` | Repository/install root containing `packages/harness` |
| `HPH_NODE` | Node executable |
| `HPH_BACKEND` | Compiled JSONL entrypoint |
| `HPH_DATA_DIR` | Backend state directory, inherited by the launched process |
| `HPH_FONT` | Korean-capable font file override |

Windows uses Malgun Gothic when present. Linux checks Noto CJK and Nanum fonts. The default theme is neutral **Light**, with a white conversation area and a soft gray sidebar. Settings also offer **Dark** and **Solarized Light**. Existing dark preferences remain compatible.

## Validation

`cargo test -p hpharness-desktop` checks concurrent-save preservation, reload conflicts, UTF-16 conversion/completion, terminal ANSI handling, and an actual local native-PTY shell round trip. `cargo clippy -p hpharness-desktop -- -D warnings` checks the implementation.

`--smoke-report ABSOLUTE_REPORT_PATH` opens a real native window, captures the application's own rendered frame to the sibling PNG, records backend connection status, and closes. Add `--smoke-scenario ABSOLUTE_TEST_PROJECT` to create a real project/session, open an existing `smoke.py`, append and save a comment through the editor's normal RPC path, send a short request to the configured live model, and wait for an assistant response. Add `--smoke-preview IMAGE_PATH_WITHIN_PROJECT` to load an image through the real service and native decoder. Use a separate `HPH_DATA_DIR` for this test. The scenario never persists test buffers into normal GUI preferences. A successful scenario reports `scenarioPhase: 5`, `assistantMessages: 1` or more, and `savedFiles: 1` or more; image validation additionally reports `imagePreview: true`. It times out after 90 seconds and reports its actual state instead of fabricating success.

For layout checks, add `--smoke-chat`, `--smoke-size 900x650`, `--smoke-panel`, `--smoke-dark`, or `--smoke-solarized`. Smoke runs isolate UI persistence beside the report so saved window dimensions cannot override the requested test size. The desktop tests also cover legacy preferences and active-run selection when later work is queued.

Windows native rendering, Korean text, a live response, a real file save, and the ConPTY round trip were checked in the development environment. Manual IME composition/selection at multiple DPI scales, all requested language-server distributions and representative Android projects, accessibility navigation, and DRM document/image previews still require additional validation and implementation. Generic RPC access is not equivalent to finished dedicated Office/browser/self-improvement interfaces.
