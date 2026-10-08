/**
 * Home screen, OpenCode style (packages/tui/src/routes/home.tsx): before the session has a
 * message, the transcript and sidebar give way to pi's own logo, the prompt (max 75 columns), a
 * tip, and a bottom bar with the directory, MCP count and version. layout.ts composes these with
 * pi's own prompt; this file renders the pieces.
 *
 *                                  (pi logo, coral/blue/yellow)
 *
 *            ┃  Ask anything… "Fix a TODO in the codebase"
 *            ┃  󰚩 BUILD   Opus 5.5  Anthropic  medium
 *            ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
 *                                           tab agents  ctrl+p commands
 *
 *            ● Tip Press tab to cycle between Build and Plan agents
 *
 *   ● Acme pi 1.1.0 · halo 0.1.0  ~/git/pi-halo  main  ● 6 MCP   ⟲ "halo" 2h ago  ctrl+x r
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Color, backgroundAnsi, foregroundAnsi, rgbColor, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { widgetsFor } from "./api.ts";
import { brandLine, fmtAgo, homeRelative, sanitize } from "./palette.ts";
import { icon, leadIcon } from "./icons.ts";
import { branchGlyph, worktreeTag } from "./sidebar.ts";
import type { UiState } from "./state.ts";
import { haloVersion } from "./version.ts";

/** OpenCode's prompt width on the home screen (tui.prompt.max_width default). */
export const HOME_PROMPT_WIDTH = 75;

/** OpenCode's home placeholders, shown as `Ask anything… "<one of these>"`. */
export const PLACEHOLDERS = ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"];

const center = (s: string, w: number) => {
	const pad = Math.max(0, Math.floor((w - visibleWidth(s)) / 2));
	return truncateToWidth(" ".repeat(pad) + s, w, "");
};

/** The pi logo's pixels (pi's own components/pi-logo-animation.js): c coral, b blue, y yellow. */
export const PI_PIXELS = ["ccc.", "b.c.", "bb.y", "b..y"];
const PI_COLORS: Record<string, Color> = {
	c: rgbColor(228, 138, 122),
	b: rgbColor(79, 142, 179),
	y: rgbColor(234, 182, 93),
};

/**
 * The pi logo scaled up: each logo pixel becomes `scale` columns by `scale` half-rows, drawn with
 * half blocks, so scale 3 gives 12 columns by 6 rows (a 12 by 6 cell logo).
 */
export function piLogoRows(theme: Theme, scale = 3): string[] {
	const mode = theme.getColorMode();
	const grid: (string | undefined)[][] = [];
	for (const row of PI_PIXELS) {
		const cells = [...row].flatMap((p) => Array<string | undefined>(scale).fill(PI_COLORS[p] ? p : undefined));
		for (let k = 0; k < scale; k++) grid.push(cells);
	}
	const fg = (p: string) => foregroundAnsi(PI_COLORS[p]!, mode);
	const bg = (p: string) => backgroundAnsi(PI_COLORS[p]!, mode);
	const lines: string[] = [];
	for (let y = 0; y < grid.length; y += 2) {
		const top = grid[y]!;
		const bottom = grid[y + 1] ?? [];
		let line = "";
		for (let x = 0; x < top.length; x++) {
			const t = top[x];
			const b = bottom[x];
			if (!t && !b) line += " ";
			else if (t && b && t === b) line += `${fg(t)}█\x1b[39m`;
			else if (t && b) line += `${fg(t)}${bg(b)}▀\x1b[39;49m`;
			else if (t) line += `${fg(t)}▀\x1b[39m`;
			else line += `${fg(b!)}▄\x1b[39m`;
		}
		lines.push(line);
	}
	return lines;
}

/** The logo, centred: pi's own logo (falls back to a plain "pi" when too narrow). */
export function renderLogo(theme: Theme, width: number): string[] {
	const pi = piLogoRows(theme);
	if (width < 12) return [center(theme.bold(theme.fg("text", "pi")), width)];
	return pi.map((l) => center(l, width));
}

/** Tips, `{x}` marks the highlighted part (OpenCode: {highlight}…{/highlight}). */
export const TIPS = [
	"Press {tab} to cycle between Build and Plan agents",
	"Press {ctrl+p} to see all available actions and commands",
	"The leader key is {ctrl+x}; combine with other keys for quick actions",
	"Press {ctrl+x ?} to list the leader key actions",
	"Press {ctrl+x b} in a session to show or hide the sidebar panel",
	"Use {/new} or {ctrl+x n} to start a fresh conversation session",
	"Use {/resume} or {ctrl+x l} to continue an earlier session",
	"Use {/model} or {ctrl+l} to switch between available AI models",
	"Use {/tree} to jump back to any earlier point in the session",
	"Use {/fork} to branch a new session from an earlier message",
	"Use {/compact} to summarize older history and free up context",
	"Use {/export} to save the session as HTML or JSONL",
	"Use {/copy} or {ctrl+x y} to copy the assistant's last message",
	"Use {/name} to give this session a recognizable name",
	"Press {ctrl+o} to collapse or expand tool output",
	"Press {ctrl+t} to collapse or expand thinking blocks",
	"Press {shift+enter} to add newlines in your prompt",
	"Press {ctrl+g} to compose messages in your external editor",
	"Press {escape} to stop the AI mid-response",
	"Type {@} to search for a file and add it to your prompt",
	"Start your prompt with {!} to run a shell command",
	"Use {/hotkeys} to show all keyboard shortcuts",
	"Use {/reload} to reload extensions, themes and keybindings",
];

/** Splits a tip into plain and highlighted parts. */
export function parseTip(tip: string): { text: string; highlight: boolean }[] {
	const parts: { text: string; highlight: boolean }[] = [];
	const re = /\{([^}]*)\}/g;
	let at = 0;
	for (const m of tip.matchAll(re)) {
		if (m.index > at) parts.push({ text: tip.slice(at, m.index), highlight: false });
		parts.push({ text: m[1]!, highlight: true });
		at = m.index + m[0].length;
	}
	if (at < tip.length) parts.push({ text: tip.slice(at), highlight: false });
	return parts;
}

/** "● Tip …" (OpenCode: warning-coloured label, highlights in text, the rest muted), centred. */
export function renderTip(theme: Theme, width: number, index: number): string[] {
	const tip = TIPS[((index % TIPS.length) + TIPS.length) % TIPS.length]!;
	const body = parseTip(tip)
		.map((p) => theme.fg(p.highlight ? "text" : "muted", p.text))
		.join("");
	const label = theme.fg("warning", "● Tip ");
	const max = Math.min(width, HOME_PROMPT_WIDTH);
	const lines = wrapTextWithAnsi(body, Math.max(10, max - 6));
	const out = lines.map((l, i) => `${i === 0 ? label : "      "}${l}`);
	// One left edge for every line, so wrapped lines stay aligned under the first.
	const w = Math.max(...out.map((l) => visibleWidth(l)));
	const pad = " ".repeat(Math.max(0, Math.floor((width - w) / 2)));
	return out.map((l) => truncateToWidth(pad + l, width, ""));
}

/**
 * Bottom bar (OpenCode home/footer.tsx): 1 row of padding above and below, 2 columns at the sides;
 * the folder and branch (with the branch icon) muted and the MCP count with a coloured dot on the left; on the right, the most
 * recent other session in this directory and the leader key that resumes it. With `piVersion`, the
 * brand with the pi and halo versions comes first on the same line.
 */
export function renderHomeFooter(state: UiState, theme: Theme, width: number, piVersion?: string): string[] {
	const cwd = homeRelative(state.ctx?.cwd ?? process.cwd());
	const branch = state.git?.branch;
	// Same branch icon as the sidebar and footer: the folder, then the icon and the branch name.
	const left: string[] = [theme.fg("muted", cwd) + (branch ? `  ${leadIcon(branchGlyph(), (s) => theme.fg("accent", s))}${theme.fg("muted", branch)}${worktreeTag(theme, state.git)}` : "")];
	const mcp = widgetsFor("sidebar").find((w) => w.id === "mcp");
	if (mcp) {
		try {
			const view = mcp.render({ theme, ctx: state.ctx, width });
			if (view?.text) {
				const connected = view.text.split("/")[0] ?? view.text;
				const dot = view.level === "error" ? "error" : view.level === "warn" ? "warning" : view.level === "ok" ? "success" : "muted";
				left.push(`${theme.fg(dot, "●")} ${theme.fg("text", `${connected} MCP`)}`);
			}
		} catch {
			// widget error: leave it out
		}
	}
	// The brand with the pi and halo versions leads the line.
	if (piVersion) left.unshift(brandLine(theme, piVersion, haloVersion()));
	const leftStr = left.join("  ");
	// Right: the most recent other session here, with the leader key that resumes it.
	const last = state.lastSession;
	const inner = width - 4;
	if (last) {
		const tail = `${theme.fg("dim", fmtAgo(Date.now() - last.modified.getTime()))}  ${theme.fg("text", "ctrl+x r")}`;
		const mark = icon("resume");
		const room = inner - visibleWidth(leftStr) - 4 - visibleWidth(tail) - 4; // gap, "⟲ ", quotes, spaces
		if (room >= 8) {
			// The label comes from a session file, so it is cleaned here whatever put it in the state.
			const label = truncateToWidth(sanitize(last.label) || "untitled", Math.min(40, room), "…");
			const right = `${leadIcon(mark, (s) => theme.fg("muted", s))}${theme.fg("muted", `"${label}"`)} ${tail}`;
			const gap = inner - visibleWidth(leftStr) - visibleWidth(right);
			return ["", `  ${leftStr}${" ".repeat(Math.max(2, gap))}${right}`, ""];
		}
	}
	return ["", `  ${truncateToWidth(leftStr, inner, "…")}`, ""];
}
