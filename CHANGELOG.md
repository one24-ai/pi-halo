# Changelog

All notable changes to pi-halo are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html); see [Versioning](README.md#versioning) for what counts as a breaking change here.

## [Unreleased]

## [0.2.1] - 2026-10-08

### Changed

- pi-halo describes itself as a workbench for pi (an interface, git workflows and a widget platform) instead of an OpenCode-style TUI, in the README and the npm description. OpenCode is credited as the inspiration for the interface.

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

[Unreleased]: https://github.com/one24-ai/pi-halo/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/one24-ai/pi-halo/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/one24-ai/pi-halo/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/one24-ai/pi-halo/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/one24-ai/pi-halo/releases/tag/v0.1.0
