# pi-halo

An OpenCode-style TUI and everyday engineering workflows for [pi](https://pi.dev): a sidebar and home screen, Build and Plan modes, a git diff view, and git commands that draft commit messages and pull requests for you. The brand (name, mark, colours, startup art) is a replaceable layer: see [Branding](#branding).

Requires pi 1.1 and Node.js 22.19 or later.

- **Home screen** like OpenCode's: until the first message, the pi logo, the prompt (75 columns, with an `Ask anything…` placeholder and a blinking cursor), a random tip, and a bottom bar with the brand, the pi and halo versions, the directory and branch, MCP count, and the last session here (`ctrl+x r` resumes it). Fullscreen mode only.
- **Sidebar** on the right with session title, context and cost, status widgets and todos. `ctrl+x b` toggles it.
- **Footer**: one line with cwd, git, widgets, other extensions' statuses, context % and cost.
- **Prompt**: a left rail in the mode colour, with a `BUILD` / `PLAN` badge and the model.
- **Build / Plan modes**: `tab` on an empty prompt (`shift+tab` cycles the thinking level, as in pi). Plan mode turns off edit and write and limits bash to read-only commands (an allow-list that rejects redirects to files, command substitution, unquoted expansion such as `{a,b}`, `*` and `$VAR`, and options that write files or run other programs). It is a guardrail, not a sandbox: tools from other extensions (MCP and custom tools) are not restricted, test and build commands it allows (`pnpm test`, `cargo test`) run project code, and git honours the repository's own config, so do not rely on it in a repository you do not trust.
- **`ctrl+x` leader keys** and a **`ctrl+p` command palette**.
- **Tool rows**: one line per call, with its own icon per tool (`󰧮 Read src/x.ts   120 lines`). `ctrl+o` expands them. For bash, the row shows the line count, the exit code on failure and the run time for commands over a second. Under it, the last 3 lines of output stay visible, with a dim `… N more lines · ctrl+o or click to expand` above them. The command and its output sit in one shaded block with a blank shaded row above, between and below, as in OpenCode. `edit` and `write` are blocks too: the diff of an edit, or the numbered lines of a new file (the first 20, then a note of how many more). Blocks start with a one-column strip of the page background before the shade, as OpenCode's left border does, and an inline row sits tight under another one-line row but keeps a blank row under a block. A call that printed nothing, and every `read`, `grep`, `find` and `ls` call, is a plain unshaded line instead. Every call starts as a plain line and only becomes a block when it has output or fails, so a row changes shape at most once. Click a row or press `ctrl+o` to open it: long output then keeps its first 6 and last 14 lines (errors are usually at the end), with the full-output path when pi truncated it. While a command runs for more than half a second, the last 5 lines of its output show under the row and update as it prints. Colour codes and progress-bar redraws are cleaned up, and a line over 1000 characters is cut.
- **User prompts** get a left bar in the colour of the mode they were sent in (brand colour for Build, plan colour for Plan) and a muted `Build` or `Plan` label in a column on the right, centred vertically; the message wraps before that column. The mode is read from the session, so earlier messages keep their colour and label when you switch modes, and after a resume.
- **Thinking peek**: a spinner and the tail of the reasoning, shown in place of "Thinking...".
- **Turn telemetry**: tok/s, TTFT, duration, tokens and the run's cost after each run.
- **Git diff view**: `/diff` (or `ctrl+x d`) opens a full-size panel: the changed files on the left, the selected file's diff on the right, with line numbers and tinted added and removed lines. The list has staged, unstaged and untracked files together, each with git's two-letter code; `tab` (or a click on the tab) switches to the branch against its base, found the way `/pr` finds it: the remote's default branch (`develop` and `trunk` work too), else `main` or `master`, preferring the remote's copy because a local one can be stale. The tab names the base (`Branch vs origin/main`). Git settings such as `diff.noprefix`, `diff.mnemonicPrefix` and `diff.external` do not affect it, and files with Windows line endings show cleanly. `j`/`k` move, `enter` opens the diff pane, `]`/`[` jump between hunks, `ctrl+d`/`ctrl+u` page, `>`/`<` scroll sideways, `r` reloads, `esc` closes; the mouse clicks files and tabs and scrolls with the wheel. Below 100 columns the list and the diff take turns. Git is read when the panel opens and on `r`, never on a timer. `/widgets disable diff` switches it off.

## Install

```bash
pi install npm:pi-halo@0.1.0                        # from npm, pinned
pi install git:github.com/one24-ai/pi-halo@v0.1.0   # from git, pinned to a tag
pi install /path/to/pi-halo                         # a local checkout
```

Pin a version: pi keeps a pinned npm version or git tag until you change it, so an update never arrives by surprise. See the [changelog](CHANGELOG.md) before moving to a new one.

pi-halo replaces pi's header, footer and editor, so it does not combine with another package that does the same (such as pi-open-tui): keep one of them in `packages`.

**Icons.** pi-halo draws with plain characters by default (`● ○ ▲ × • → ↑ ↓` and half-block pill caps), which every common monospace font has, so it works in any terminal. With a [Nerd Font](https://www.nerdfonts.com) in the terminal it can draw real icons instead (a robot, a branch, a file, a clock, round pill caps). Switch with `/halo icons nerd|plain|auto`; `auto` forgets the choice. The setting is saved in `halo.json`, and the `PI_HALO_ICONS=nerd|plain` environment variable overrides it. A brand can set the default for its users with `icons: "nerd"` (see Branding). The plain set takes the same number of cells as the Nerd one, so nothing moves when you switch. Where a Nerd icon is only decoration (telemetry, the mode pill, the diff header) the plain set shows the words alone.

pi-halo ships no theme. It works with any pi theme; the brand only supplies the mark colour, the plan-mode colour and two surface shades (see Branding).

## Keys

| Key | Action |
|---|---|
| `tab` (empty prompt) | Switch Build / Plan |
| `shift+tab` | Cycle the thinking level (pi's own binding) |
| `ctrl+p` | Command palette (all slash commands, fuzzy search) |
| `ctrl+x` then `n` `l` `r` `m` `t` | New session, sessions, resume the last session here, models, settings/themes |
| `ctrl+x` then `b` `d` `a` `c` `x` | Toggle sidebar, diff view, switch mode, compact, export |
| `ctrl+x` then `g` `y` `s` `h` `q` | Tree, copy last message, session info, hotkeys, quit |
| `ctrl+x` then `?` | Leader help |
| `ctrl+alt+b` | Toggle sidebar |

`ctrl+p` replaces pi's default "cycle model" binding inside the prompt. Pick models with `ctrl+x m` or `ctrl+l`.

`/halo [on|off|sidebar|status|alert|icons]` turns the TUI off for a session, toggles the sidebar, or reports the layout and the registered widgets.

**Finish alert.** When a run that lasted at least 30 seconds ends, fails, or stops to wait for you (a confirmation prompt), halo rings the terminal bell and puts a mark in the window title (`✓`, `✗` or `?` in front of pi's title), so you notice from another window. The mark clears on your next prompt. A run you abort with `esc` never rings. It writes only a BEL character and the standard title escape, with no OS commands, so what you see (a taskbar flash, a tab badge, a sound, or nothing) is your terminal's bell setting. `/halo alert` shows the setting, `/halo alert off|on` switches it, and `/halo alert 90` (or `45s`, `2m`) sets the threshold. It is saved in `halo.json` next to the disabled widgets.

## Git workflows

Slash commands for the git chores you do every day. None of them needs you to explain anything to the model: they read the repository themselves, and where a message helps, the model drafts it from the diff in a one-off request that never enters your conversation. You always see the draft in an editor before anything happens.

| Command | What it does |
|---|---|
| `/commit [message]` | Commits what is staged. With nothing staged it lists the files (the first 15, then "and N more"), asks, then stages everything (`git add -A`); if you then cancel the editor or leave the message empty, the staging area is put back as it was. With no message the model drafts one from the staged diff and your recent commit subjects; you edit or accept it. A message you type is used as is |
| `/push` | Pushes the current branch to the remote branch of the same name and says exactly where ("Push 2 commits on feat to origin/feat?"), publishing it with that upstream the first time. A branch started from `origin/main` is pushed to `origin/feat`, never to `main`. Asks first. Refuses when the branch is behind its remote branch. An upstream deleted on the remote counts as not published |
| `/merge [branch\|abort]` | Merges a branch (picked from a list if you give none) into the current one. Asks first. Refuses with uncommitted changes. On conflicts it lists the files and stops; `/merge abort` restores the tree |
| `/pr [base] [--draft]` | Pushes if needed (asking), drafts the title and description from the commits and the diff against the base, lets you edit them (the first line is the title), then opens the request. The base defaults to the remote's default branch. The push step names the exact target branch |
| `/git [status\|on\|off]` | A menu of the above, the branch, upstream, ahead/behind and change counts, or the off switch |

It is plain git and works with any remote. `/pr` uses the forge's own CLI, so it works with any host that CLI is signed in to: [`gh`](https://cli.github.com) for GitHub and GitHub Enterprise, [`glab`](https://gitlab.com/gitlab-org/cli) for GitLab. Run `gh auth login` (or `glab auth login`) once.

Safe by construction: git runs with argument lists, never through a shell, with no terminal of its own, so a password, ssh passphrase or gpg prompt cannot draw over pi's screen: it fails at once with a hint to sign in first (credential helper, ssh-agent or gpg-agent) and you try again; output from git, hooks and `gh` is stripped of escape sequences before it is shown; nothing force-pushes, skips hooks (`--no-verify`) or resets hard; a failing hook or push shows git's own output and leaves the repository as git left it; and everything that publishes or merges asks first. The model is the one you have selected. If it can't answer, you write the message yourself. `/git off` switches all of these commands off and `/git on` restores them. The choice is saved in `halo.json` and applies to every running session at once. Like any slash command they are listed in the command palette (`ctrl+p`). They need the interactive UI, because they ask before they change anything; in print or JSON mode they say so on stderr and do nothing.

## Adding a widget

A widget is one call. It can show in the footer, the sidebar, or both:

```ts
// my-widget/index.ts, in a pi package that depends on pi-halo (see below)
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWidget } from "pi-halo/client";

export default function (pi: ExtensionAPI) {
	let count = 0;
	registerWidget(pi, {
		id: "builds",
		title: "Builds",              // sidebar heading
		slots: ["footer", "sidebar"], // default: both
		order: 40,                    // container 0, aws 20, mcp 30
		refreshMs: 15_000,            // optional polling
		update: async (ctx) => {      // optional: fetch slow data here
			count = 3;
		},
		render: () => ({ icon: { nerd: "\u{F0AD}", plain: "" }, label: "CI", text: `${count} running`, level: count ? "warn" : "ok" }),
		detail: () => ["main: passing", "feature/x: running"], // extra sidebar lines
	});
}
```

`pi-halo/client` is resolved like any npm import, from the widget's own folder, so the widget lives in a pi package that has pi-halo in its `node_modules`. A single file in `~/.pi/agent/extensions/` can't import it. The exports are compiled JavaScript with type declarations, so the package's own tests can import them with plain `node --test` and type-check with `tsc`. A minimal package:

```json
{
  "name": "my-widget",
  "type": "module",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./index.ts"] },
  "dependencies": { "pi-halo": "^0.2.0" }
}
```

Install its dependencies (`pnpm install`), then `pi install /path/to/my-widget`.

- Widgets in other extensions should import `client.ts`, not `api.ts`. It only looks for halo on `globalThis`, so load order doesn't matter: a widget that registers before halo loads is queued and taken over when it does. Without halo installed, the widget falls back to a plain `ctx.ui.setStatus(id, "<icon> <label or title> <text>")` line, polled on `refreshMs` (no detail lines, colours or caching). It also checks the registry's `apiVersion`, so a halo with an older API is ignored rather than called wrongly. The package exports `./client`, `./api`, `./brand`, `./icons`, `./provider` and `./aws` for use from another package (`./icons` has `iconSet`, `safeGlyph` and the glyph table, for a brand or widget that wants to match the user's icon choice). Built-in widgets in this repo keep importing `api.ts`.
- An `icon` (on the widget or in the view) is either one string, used as given with a Nerd Font and dropped without one, or `{ nerd, plain }` to give one for each set. A string of ordinary characters such as `"CI"` survives in both. With no icon in the current set, a row shows its level marker or the bullet, and a section heading shows no glyph.
- `render` returns `{ icon?, label?, text, color?, level? }`, or `undefined` to hide the widget. In the sidebar's status list a `level` shows as a marker: a check (`ok`), warning triangle (`warn`), cross (`error`), minus (`off`) or information circle (`info`), in that level's colour. `label` is shown only in the footer, because the sidebar uses `title` instead.
- `color` takes theme tokens (`text`, `muted`, `accent`, `success`, `warning`, `error`) the brand colours (`brand`, `brandDark`, `plan`), or any `#RRGGBB` value. If omitted, `level` (`ok`, `warn`, `error`, `off`, `info`) picks the colour.
- An `update` runs one at a time and is abandoned after `updateTimeoutMs` (default 10000). A failing `update`, `render` or `detail` shows its last error under the widget in the sidebar.
- `render` and `detail` run on every repaint, so keep them cheap. A widget that reads session state can pass `cacheKey` (for example the session branch key), and its output is then reused until that key, the width, the theme or any widget update changes. A widget whose render takes over 50 ms three times in a row is suspended (shown as "suspended") until `/widgets enable ID`.
- `actions: [{ id, label, description?, run(ctx) }]` adds entries to the ctrl+p palette, shown as "<title>: <label>". They are hidden while the widget is disabled or suspended. A thrown error is shown as a notification and recorded on the widget.
- `onDetailClick(index, ctx)` makes the lines `detail` returns clickable in the sidebar (left click; the heading, error lines and rows cut off on a short terminal are not). Only the sidebar leaf handles the mouse, so moving the pointer over it costs nothing. A thrown error is shown as a notification and recorded on the widget.
- A `sidebar: "section"` widget with only detail lines can return `{}` from `render`: `text` is optional.
- `/widgets [list|disable ID|enable ID|refresh ID]` shows each widget's state and switches one off. The disabled list is saved in `~/.pi/agent/halo.json`.
- `registerWidget` returns a handle. `refresh()` re-renders on demand, for example from a `pi.events` listener, and `dispose()` removes the widget.
- `sidebar: "section"` gives a widget its own sidebar section (bold title, value beside it, detail lines as the body) instead of a row in the status list. The `todo` widget uses it. Its optional `icon` goes in front of the title; on a row widget it is the row's marker instead of the bullet (the AWS widget shows the AWS logo there).
- Plain `ctx.ui.setStatus(key, text)` from any extension still shows in the footer. A widget whose `id` (or `statusKey`) matches a status key replaces that status, so it doesn't show twice; `statusKeys: [...]` claims several more. The Subagents widget uses it for pi-subagents' slash-command statuses.

`extensions/widgets/` has the built-in widgets, which are also good templates:

| Widget | Shows |
|---|---|
| `container` | The container, devcontainer or pod name when pi runs inside one |
| `aws` | AWS account, role and region from env and `~/.aws/config`. The role is green when its name reads read-only and bold in the warning colour when it reads admin or power-user. An extension that changes the AWS env can emit `aws-status:refresh`. Credential tools can be taught with `registerCredentialProcessResolver` (`pi-halo/aws`) |
| `mcp` | Connected/enabled MCP servers, and which ones are pending |
| `todo` | Open items from the repo's `TODO.md` (or `TODO`, `TODO.txt`), sidebar only, hidden when there's none |
| `session-todos` | The latest todo list a todo-style tool reported in this session, sidebar only, hidden when nothing is open |
| `subagents` | pi-subagents children for this session (see below), hidden until one runs. Running children show their model and token count, and a last line shows spawned-of-cap and the parallel limit |

### Diff view API

Other extensions can show their own diff in the panel and add actions to it (`a` opens the menu). An action runs after the panel has closed, with the file and hunk under the cursor and the file's patch, so halo shows the diff and leaves what to do with it to you:

```ts
import { addDiffAction, openChanges, openDiff } from "pi-halo/client";

addDiffAction({
  id: "review-hunk",
  label: "Send this hunk to the reviewer",
  run: ({ file, hunk, filePatch, source }) => { /* file.path, hunk?.text, ... */ },
});

const shown = await openDiff(ctx, { title: "Proposed change", diff: unifiedDiffText }); // true once it was shown and closed; false when nothing was shown (the diff view is not loaded, switched off or already open, or there is no interactive UI)
const opened = await openChanges(ctx, "src/api.ts"); // the git changes view with that file selected (same result)
```

Both work whichever package loads first, and neither needs halo's registry.

## Branding

The brand is one small object, set by calling `registerBrand` from any extension:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBrand } from "pi-halo/client";

export default function (_pi: ExtensionAPI) {
	registerBrand({
		name: "Acme",                     // "<glyph> Acme pi 1.0.0"; omit for "<glyph> pi 1.0.0"
		glyph: "A",                       // one cell; a private-use glyph (your own icon font) is shown as "●" when the user has plain icons
		icons: "plain",                   // the icon set when the user has not chosen: "nerd" if your users have a Nerd Font
		tagline: "Ship it",               // under the startup art; omit for none
		art: ["▄██▄", "████"],            // startup header rows, painted in `primary`; omit for the pi logo
		colors: { primary: "#E4572E", primaryDark: "#A33B1F", plan: "#F2B134", neutral: "#C9CCC9" },
		surfaces: { panel: "#121212", element: "#1C1C1C" }, // sidebar/messages and the prompt box, dark themes
		lightSurfaces: { panel: "#F0F0F0", element: "#E6E6E6" }, // the same, for light themes
	});
}
```

Every field is optional and merges onto the defaults (a neutral blue, the pi logo, no name or tagline). The brand lives on `globalThis`, so it doesn't matter which package loads first, and `registerBrand` returns a function that puts the previous brand back. Pick `surfaces` (and `lightSurfaces`, if your package has a light theme) to match your theme's `userMessageBg` and `toolSuccessBg`, so pi's own blocks and halo's agree. Under a light theme halo uses `lightSurfaces` and darkens the brand colours it draws as text until they reach 4.5:1 contrast on them; rails, bars and the mode pill keep the brand colour exactly, and a dark theme is untouched. A glyph from a patched font is fine as long as your users have that font; otherwise use a plain character.

A brand package is an ordinary pi package with an extension (the `registerBrand` call), and usually a theme. Install it next to halo; nothing in halo needs to know it exists. The same package can hold widgets that only make sense for its users.

## Provider status

The sidebar's provider section shows the provider's name (as registered with pi), the model, context use, tokens and cost for any provider, with no setup. A provider that publishes its plan usage as a `setStatus("<provider>-usage", "... 71%")` line gets a Plan bar automatically (and the figure in the footer when the sidebar is hidden). Any other provider can add its own bars, such as how much of a plan or quota is used, with `registerProviderStatus`:

```ts
import { registerProviderStatus } from "pi-halo/client";

// The provider already publishes a percentage with ctx.ui.setStatus("acme-usage", "Acme 71%"):
registerProviderStatus({ provider: "acme", name: "Acme", color: "plan", statusKey: "acme-usage", label: "Plan" });

// Or compute bars from anything:
registerProviderStatus({
	provider: ["acme", "acme-eu"],
	meters: (ctx) => [{ label: "Quota", percent: 25, detail: "5 of 20 requests" }],
});
```

Each provider bar has a circle in front of it that fills in eighths with the percentage (`nf-md-circle-slice-*`, U+F0A9E to U+F0AA5; an empty outline at 0). It takes the bar's colour: the status's own colour, the meter's `color`, or accent, then warning from 60% and error from 85%.

- `provider` is the `model.provider` id (or several). `name` overrides the heading (default: the name the provider gave pi), `color` the heading glyph's colour (same tokens as widgets).
- `statusKey` reads a percentage from a `setStatus()` line. The bar takes the status's own colour, and the status is left out of the generic lists. With the sidebar hidden, the footer shows it next to the context.
- `meters` returns `{ label, percent?, detail?, color? }` bars. It runs on every repaint, so keep it cheap. An error in it is ignored.
- A later registration for the same provider replaces the earlier one.

## Subagents

With [pi-subagents](https://github.com/nicobailon/pi-subagents) installed, the sidebar's Subagents section lists this session's children: a status dot, the label or agent, the current tool and elapsed time, with running ones first. Foreground runs show as `fg` rows. To inspect, steer or stop a child, use pi-subagents' own FleetView: press `↓` on an empty prompt, or run `/subagents-fleet`.

The section reads pi-subagents' public `status` RPC only, so it keeps working as pi-subagents changes internally, and hides itself when pi-subagents isn't installed. The one exception is the parallel limit, which comes from `globalConcurrencyLimit` in `~/.pi/agent/extensions/subagent/config.json` (20 when unset).

## How the sidebar works

pi has no extension API for a side panel. In fullscreen mode (`"tuiMode": "fullscreen"`), pi renders one layout root, a vertical stack of transcript plus input. pi-halo wraps that root in a horizontal stack with the sidebar as a fixed 48-column right column, using pi-tui's `setLayoutRoot()`.

This was last checked on pi 1.1.0. A pi update could change these internals. If that happens, or in regular mode, the sidebar falls back to a pop-up overlay (`ctrl+x b`), and everything else keeps working.

Below 116 columns the split sidebar hides itself. Context, cost and provider usage, status widgets and other extensions' statuses (MCP, LSP, ...) live in the sidebar; whenever it is hidden they show in the footer instead.

Other unsupported hooks, all checked on pi 1.1.0:

- Prompt bars: patches `UserMessageComponent.prototype.render`. The original is restored on `/halo off` and on shutdown.
- Tool rows: a renderer resolver (`pi.registerToolRenderer`) draws the built-in tools' calls; pi's own tool definitions, settings and active tool set are not touched.
- Thinking peek: finds the latest assistant message component in the TUI tree, as pi-open-tui does.

## Development

```bash
pnpm install          # typescript + @types/node only
pnpm test             # unit tests (node --test, no pi needed)
pnpm typecheck        # links the installed pi's packages into node_modules, then tsc
pnpm build            # compiles the exports to dist/ (JavaScript and type declarations)
pnpm check            # tests, type check and build, as CI runs them
```

Screenshots (pi in a detached tmux pane, replayed to PNG with pyte + Pillow from public PyPI):

```bash
scripts/screenshot.sh /tmp/shot.png 160 42 "Read button.ts and change red to blue"
# a brand with private-use glyphs: SHOT_FONT=/path/Font-Regular.ttf SHOT_FONT_BOLD=/path/Font-Bold.ttf
```

Try it without touching your settings:

```bash
pi -e /path/to/pi-halo/extensions/halo/index.ts
```

## Versioning

pi-halo follows [Semantic Versioning](https://semver.org). The public API is:

- the exports in `package.json` (`pi-halo/client`, `api`, `brand`, `icons`, `provider`, `aws`) and the types they export,
- the slash commands, their arguments and the `ctrl+x` and `ctrl+p` keys,
- the settings it stores in `~/.pi/agent/halo.json`.

A change that breaks one of those is a major version, a new feature is a minor version, and a fix is a patch. Before 1.0.0, a breaking change bumps the minor version instead (0.1 to 0.2). Each release supports one pi minor version, declared in `peerDependencies`; supporting a new pi minor is a minor release of pi-halo. Every change is listed in [CHANGELOG.md](CHANGELOG.md); how a release is cut is in [RELEASING.md](RELEASING.md).

## Credits

The thinking peek and turn telemetry are adapted from [pi-open-tui](https://github.com/OldSuns/pi-open-tui). The plan-mode bash allowlist started from pi's plan-mode example. See `THIRD_PARTY_NOTICES`.
