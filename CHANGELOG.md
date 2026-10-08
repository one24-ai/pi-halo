# Changelog

All notable changes to pi-halo are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html); see [Versioning](README.md#versioning) for what counts as a breaking change here.

## [Unreleased]

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

[Unreleased]: https://github.com/one24-ai/pi-halo/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/one24-ai/pi-halo/releases/tag/v0.1.0
