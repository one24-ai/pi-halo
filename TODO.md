# TODO

- [ ] README screenshots: decide which screens to show (home, a chat with tool blocks, the sidebar, the diff view) and whether the PNGs live in the repo; `scripts/screenshot.sh` already makes them.
- [ ] Cost per subagent in the Subagents widget: first check how the widget reads pi-subagents and whether a cost value is available to it.
- [ ] Plan mode as a real sandbox: today it is a guardrail (edit/write off, a bash command filter, a plan-mode prompt). Make it enforceable: run bash read-only (for example a read-only bind mount, bubblewrap/landlock on Linux, sandbox-exec on macOS, or a copy-on-write overlay), gate every write-capable tool including MCP and extension tools (an allow-list of read-only tools rather than blocking edit/write by name), and decide what happens on platforms with no sandbox (fall back to the guardrail and say so).
