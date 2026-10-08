/**
 * Drawing for the diff view: pure functions from parsed diffs to lines of a given width, so they
 * can be tested without a terminal. Colours come from the theme's diff tokens; the tint behind
 * added and removed lines is a mix of that colour into the panel shade.
 *
 * Everything that comes from a diff (file contents, paths, hunk headings) goes through `clean`
 * first: a file can hold escape sequences, and they must never reach the terminal.
 */

import { stripEscapes } from "../halo/sanitize.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, mixColors, parseColor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { surfaceColor } from "../halo/palette.ts";
import type { FileDiff, Hunk } from "./git-diff.ts";

/**
 * Replace control characters (escape sequences, C1 controls, bidi overrides) and expand tabs. A
 * carriage return at the very end is dropped first: it is the second half of a CRLF line ending,
 * not content, and would otherwise show as a dot on every line of a Windows-style file.
 */
export function clean(s: string): string {
	return stripEscapes(s.replace(/\r$/, ""))
		.replace(/\t/g, "    ")
		.replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/g, "·");
}

/** One row of the right pane. */
export interface BodyRow {
	kind: "hunk" | "add" | "del" | "ctx" | "note" | "blank";
	text: string;
	oldNo?: number;
	newNo?: number;
}

/** The rows of a file's diff pane, and where each hunk starts. */
export interface Body {
	rows: BodyRow[];
	hunkStarts: number[];
	/** Widest line number, for the gutter. */
	numWidth: number;
}

export function buildBody(file: FileDiff): Body {
	const rows: BodyRow[] = [];
	const hunkStarts: number[] = [];
	let max = 0;
	const say = (text: string) => rows.push({ kind: "note", text });
	if (file.binary) say("Binary file");
	else if (file.note) say(clean(file.note));
	else if (file.hunks.length === 0) {
		if (file.status === "R" && file.oldPath) say(`Renamed from ${clean(file.oldPath)}`);
		else if (file.status === "D") say("Deleted (no content)");
		else if (file.status === "A") say("Empty file");
		else say("No text changes (mode change or empty)");
	}
	file.hunks.forEach((h: Hunk) => {
		if (rows.length) rows.push({ kind: "blank", text: "" });
		hunkStarts.push(rows.length);
		rows.push({ kind: "hunk", text: clean(h.header) });
		for (const l of h.lines) {
			rows.push({ kind: l.kind, text: clean(l.text), oldNo: l.oldNo, newNo: l.newNo });
			max = Math.max(max, l.oldNo ?? 0, l.newNo ?? 0);
		}
	});
	return { rows, hunkStarts, numWidth: Math.max(3, String(max).length) };
}

/** Index of the hunk whose rows contain `row`, or the first hunk if `row` is above all of them. */
export function hunkAt(body: Body, row: number): number {
	let idx = 0;
	for (let i = 0; i < body.hunkStarts.length; i++) if (body.hunkStarts[i]! <= row) idx = i;
	return idx;
}

// ---- colours -----------------------------------------------------------------------------------

export interface Palette {
	text: string;
	addFg: string;
	delFg: string;
	ctxFg: string;
	dim: string;
	muted: string;
	accent: string;
	warn: string;
	addBg: string;
	delBg: string;
	panel: string;
	element: string;
	selected: string;
	reset: string;
}

/** How much of the diff colour goes into the tint behind a changed line. */
const TINT = 0.16;

/** The theme's diff colours plus a tint of each, mixed into the panel shade for the whole line. */
export function paletteFor(theme: Theme): Palette {
	const mode = theme.getColorMode();
	const fg = (name: Parameters<Theme["getFgAnsi"]>[0]) => theme.getFgAnsi(name);
	const panelColor = surfaceColor(theme, "panel");
	const panel = backgroundAnsi(panelColor, mode);
	const tint = (name: Parameters<Theme["getFgAnsi"]>[0]): string => {
		const m = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(fg(name));
		if (!m) return panel; // a 256-colour theme has no RGB to mix: leave the line untinted
		const hex = [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
		// sRGB, not the default OKLCH: mixing a near-black with red in OKLCH slides the hue through
		// yellow and gives an olive line instead of a dark red one.
		return backgroundAnsi(mixColors(panelColor, parseColor(`#${hex}`), TINT, "srgb"), mode);
	};
	return {
		text: fg("text"),
		addFg: fg("toolDiffAdded"),
		delFg: fg("toolDiffRemoved"),
		ctxFg: fg("toolDiffContext"),
		dim: fg("dim"),
		muted: fg("muted"),
		accent: fg("accent"),
		warn: fg("warning"),
		addBg: tint("toolDiffAdded"),
		delBg: tint("toolDiffRemoved"),
		panel,
		element: backgroundAnsi(surfaceColor(theme, "element"), mode),
		selected: theme.getBgAnsi("selectedBg"),
		reset: "\x1b[0m",
	};
}

// ---- rows --------------------------------------------------------------------------------------

/** Pad or cut plain text to exactly `w` columns. */
export const cell = (text: string, w: number): string => {
	if (w <= 0) return "";
	const t = truncateToWidth(text, w, "…");
	return t + " ".repeat(Math.max(0, w - visibleWidth(t)));
};

/**
 * One row of the diff pane at `width` columns, with a line-number gutter. Added and removed lines
 * are tinted across the full width. `shift` scrolls long lines sideways.
 */
export function renderBodyRow(row: BodyRow, width: number, pal: Palette, numW: number, shift = 0, mark?: "current" | "other"): string {
	const { reset } = pal;
	if (row.kind === "blank") return `${pal.panel}${" ".repeat(width)}${reset}`;
	if (row.kind === "hunk") {
		// In a file with several hunks the current one is marked, so `]` and `[` show where they are.
		if (width < 3) return `${pal.panel}${pal.muted}${cell(row.text, width)}${reset}`;
		if (mark === "current") return `${pal.panel}${pal.accent}▌ ${pal.text}${cell(row.text, Math.max(0, width - 2))}${reset}`;
		if (mark === "other") return `${pal.panel}  ${pal.muted}${cell(row.text, Math.max(0, width - 2))}${reset}`;
		return `${pal.panel}${pal.muted}${cell(row.text, width)}${reset}`;
	}
	if (row.kind === "note") return `${pal.panel}${pal.dim}${cell(` ${row.text}`, width)}${reset}`;
	const sign = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " ";
	const no = row.kind === "del" ? row.oldNo : row.newNo;
	const gutter = `${String(no ?? "").padStart(numW)} `;
	const bg = row.kind === "add" ? pal.addBg : row.kind === "del" ? pal.delBg : pal.panel;
	const signFg = row.kind === "add" ? pal.addFg : row.kind === "del" ? pal.delFg : pal.dim;
	const textFg = row.kind === "ctx" ? pal.ctxFg : pal.text;
	if (width <= gutter.length + 2) return `${bg}${pal.dim}${cell(`${gutter}${sign} `, width)}${reset}`;
	const room = width - gutter.length - 2;
	const shown = shift > 0 ? [...row.text].slice(shift).join("") : row.text;
	return `${bg}${pal.dim}${gutter}${signFg}${sign} ${textFg}${cell(shown, room)}${reset}`;
}

/** Path cut from the left so the file name stays visible. */
export function cutLeft(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	const chars = [...text];
	let out = "";
	for (let i = chars.length - 1; i >= 0; i--) {
		if (visibleWidth(`…${chars[i]}${out}`) > width) break;
		out = chars[i] + out;
	}
	return `…${out}`;
}

/** Colour of the two-letter status code. */
function codeColor(file: FileDiff, pal: Palette): string {
	if (file.code === "??" || file.status === "A") return pal.addFg;
	if (file.status === "D") return pal.delFg;
	if (file.status === "R") return pal.accent;
	return pal.muted;
}

/** "+12 -3", "bin", or "" for a file with nothing to count, plain text for measuring. */
export function statsText(file: FileDiff): string {
	if (file.binary) return "bin";
	return [file.added ? `+${file.added}` : "", file.removed ? `-${file.removed}` : ""].filter(Boolean).join(" ");
}

/**
 * One row of the file list: a marker, git's two-letter code, the path (directory muted, name
 * bright), and +N -M on the right. The selected row is painted on the theme's selection colour.
 */
export function renderFileRow(file: FileDiff, width: number, pal: Palette, selected: boolean, focused = true): string {
	const bg = selected && focused ? pal.selected : pal.panel;
	const stats = statsText(file);
	const room = Math.max(0, width - 5 - (stats ? stats.length + 1 : 0));
	const path = cutLeft(clean(file.path), room);
	const slash = path.lastIndexOf("/") + 1;
	const dir = cell(path.slice(0, slash), slash);
	const name = path.slice(slash);
	const pad = " ".repeat(Math.max(0, room - visibleWidth(path)));
	let statOut = "";
	if (file.binary) statOut = `${pal.dim}bin`;
	else {
		if (file.added) statOut += `${pal.addFg}+${file.added}`;
		if (file.added && file.removed) statOut += " ";
		if (file.removed) statOut += `${pal.delFg}-${file.removed}`;
	}
	const mark = selected ? `${pal.accent}▌` : " ";
	const code = file.code.padEnd(2, " ").slice(0, 2);
	const line = `${bg}${mark}${bg} ${codeColor(file, pal)}${code}${bg} ${pal.muted}${dir}${pal.text}${name}${pad}${bg}${stats ? " " : ""}${statOut}`;
	if (visibleWidth(line) > width) return `${truncateToWidth(line, width, "")}${pal.reset}`;
	return `${line}${bg}${" ".repeat(width - visibleWidth(line))}${pal.reset}`;
}
