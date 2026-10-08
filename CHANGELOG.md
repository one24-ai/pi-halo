# Changelog

All notable changes to pi-halo are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html); see [Versioning](README.md#versioning) for what counts as a breaking change here.

## [Unreleased]

### Added

- Tool rows for other extensions' tools: `registerToolRows(specs)` in `pi-halo/client` (and `registerToolRows` plus `toolRowsVersion` on `globalThis[Symbol.for("pi-halo/registry")]` for a package that does not depend on pi-halo) has halo draw a tool's calls as one-line rows with an icon, title, description, outcome and an expanded view. Specs are `ToolRowSpec` (`icon`, `title`, `describe`, `summarize`, `expand`), exported as types from `pi-halo/client`. Everything a spec returns is sanitized, a spec that throws falls back to the tool's own renderer, registration works in any load order and returns a function that removes it, and halo's rows for pi's built-in tools cannot be overridden. This is a new capability, not a change to `apiVersion`: check `toolRowsVersion`.
- `register(pi, spec, ctx?)` on the registry, and `registerWidget(pi, spec, ctx?)` in `pi-halo/client`, take an optional `ctx`. A widget registered from inside a `session_start` handler passes the handler's `ctx` so its first `update` and its timer start at once.
- README: how a package without a dependency on pi-halo registers a widget (including a sidebar section whose detail lines open the full text on click) and tool rows through `globalThis` alone.

### Removed

- **Breaking for the old memory extension's users:** halo no longer draws the `memory_write`, `memory_update`, `memory_forget` and `memory_search` tools with its own rows, and no longer treats the `memory-recall` message type as a plain row. A memory extension now registers its own rows (`registerToolRows`) and its message type (the shared `halo.plainMessageTypes` set); until it does, those tools use pi's default rendering and `memory-recall` notices get halo's panel and bar. The `toolMemory` icon is removed from `pi-halo/icons`.

## [0.2.0] - 2026-10-08

### Changed

- **Breaking:** the package exports (`pi-halo/client`, `api`, `brand`, `icons`, `provider`, `aws`) now resolve to compiled JavaScript in `dist/` with type declarations, instead of the `.ts` sources. A package that depends on pi-halo can now import it from plain `node --test` and type-check it with `tsc`; before, Node refused to strip types from files under `node_modules`. Deep imports of `pi-halo/extensions/...` paths are not part of the API and may stop working. pi still loads pi-halo's own extensions from the `.ts` sources, so nothing changes for users of the TUI.

## [0.1.1] - 2026-10-08

### Security

- Releases are published by CI with npm trusted publishing (OIDC) and carry a provenance attestation. No npm token is stored in the repository.

## [0.1.0] - 2026-10-08

First public release.

### Added

- OpenCode-style TUI for pi: home screen, right sidebar, one-line footer, prompt row with the mode and model, `ctrl+x` leader keys and a `ctrl+p` command palette.
- Build and Plan modes. Plan mode turns off edit and write and limits bash to a read-only allow-list (a guardrail, not a sandbox).
- Tool rows for pi's built-in tools, drawn through `pi.registerToolRenderer`, with live bash output, expandable results, diffs for edit and numbered lines for write.
- Thinking peek, turn telemetry and a finish alert (terminal bell and window title mark).
- Git diff view (`/diff`): changes and branch views, hunks, mouse support, and an API for other extensions (`openDiff`, `openChanges`, `addDiffAction`).
- Git commands: `/commit` (drafts the message from the diff), `/push`, `/merge`, `/pr` (drafts the title and description, opens it with `gh` or `glab`) and `/git`. Each reports its outcome and a fresh repository status to the model on its next turn.
- Widget API (`pi-halo/client`) for status rows and sidebar sections, with built-in widgets for containers, AWS, MCP, TODO.md, session todos and subagents.
- Replaceable brand layer (`pi-halo/brand`): name, mark, colours, startup art and surface shades.
- Plain and Nerd Font icon sets (`/halo icons`).
- Sanitizing of untrusted text (file contents, tool output, git and forge output, session names, widget text) before it reaches the terminal.

[Unreleased]: https://github.com/one24-ai/pi-halo/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/one24-ai/pi-halo/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/one24-ai/pi-halo/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/one24-ai/pi-halo/releases/tag/v0.1.0
