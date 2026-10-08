/**
 * OpenCode-style tool rows: one line per call, details on expand (ctrl+o).
 *
 *   󰧮 Read src/app.ts                       120 lines
 *   󰏫 Edit src/app.ts                       +12 -3
 *   󰆍 pnpm test                             exit 0 · 2.1s
 *   󰍉 Grep "TODO" in src                    14 matches
 *
 * The rows are drawn by a renderer resolver (`pi.registerToolRenderer`), which chooses how calls to
 * a tool are drawn without touching the tool: pi's own definitions for read, bash, edit, write,
 * grep, find and ls, with their settings and the active tool set, stay as they are. Tools that
 * belong to other extensions are drawn the same way when that extension registered a row spec for
 * them (`registerToolRows` in api.ts); halo knows no tool but pi's built-in ones by name.
 *
 * Everything shown comes from tool arguments and results, which a file, a web page or a model can
 * influence, so each piece of text is cleaned of escape sequences and control characters before it
 * is drawn (sanitize.ts).
 */

import { type ExtensionAPI, renderDiff, type Theme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { relative } from "node:path";
import { toolRowFor, type ToolRowSpec } from "./api.ts";
import { icon, type IconLike, type IconName, resolveIcon } from "./icons.ts";
import { primary, sanitize, sanitizeLines, scrubText, shade, stripEscapes } from "./palette.ts";
import { type BashOutput, bashPeek, foldLines, formatWallTime, LIVE_TAIL_LINES, liveTail, liveVisible, liveWaitMs, parseBashOutput } from "./bash-output.ts";
import { diffStats } from "./session-info.ts";

/** The icon name per tool (icons.ts has the glyph for each set, one cell wide). */
export const TOOL_ICONS = {
	read: "toolRead",
	write: "toolWrite",
	edit: "toolEdit",
	bash: "toolBash",
	grep: "toolGrep",
	find: "toolFind",
	ls: "toolLs",
} as const satisfies Record<string, IconName>;

const PREVIEW_LINES = 12;

/**
 * How a tool row is drawn:
 *   plain  one unshaded line, the icon and text with a dim summary
 *   block  a shaded, padded block holding the command and its output
 *   bar    a shaded one-liner with unshaded output beneath it
 */
export type RowShape = "plain" | "block" | "bar";

/**
 * The one rule for a row's shape, used for every stage of a call so it never changes shape without
 * a reason: a call is a plain line until it has output to show or has failed, then a block for the
 * rest of its life. Tools without a block look (no peek and no live view) are plain, or a bar once
 * they have a body or an error, as before.
 */
export function rowShape(opts: { blockTool: boolean; hasBody: boolean; isError: boolean; expanded: boolean; sawBody: boolean }): RowShape {
	const active = opts.hasBody || opts.isError || opts.expanded || opts.sawBody;
	if (!active) return "plain";
	return opts.blockTool ? "block" : "bar";
}

/**
 * A shaded row with OpenCode's left border: a one-column strip in the page background, then the
 * panel shade. OpenCode draws the border in `theme.background`; a terminal has no such token to
 * read, so the strip is left unshaded and shows the terminal's own background.
 */
function edged(theme: Theme, text: string, width: number): string {
	return ` ${shade(theme, text, Math.max(0, width - 1))}`;
}

/**
 * A tool row: the call line on the panel shade (so calls stand apart from assistant text and
 * output), a right-aligned summary, and unshaded expanded output underneath. Width-safe.
 */
class Row implements Component {
	hidden = false;
	private readonly theme: Theme;
	private readonly left: string;
	private readonly right: string;
	private readonly body: string[];
	private readonly shape: RowShape;

	constructor(theme: Theme, left: string, right = "", body: string[] = [], shape: RowShape = "plain") {
		this.theme = theme;
		this.left = left;
		this.right = right;
		this.body = body;
		this.shape = shape;
	}
	invalidate(): void {
		this.cache = undefined;
	}
	/** Last output: the row's text never changes, so only the width (and theme) can. */
	private cache: { width: number; mode: string; lines: string[] } | undefined;
	render(width: number): string[] {
		if (this.hidden) return [];
		const mode = this.theme.getColorMode();
		if (this.cache && this.cache.width === width && this.cache.mode === mode) return this.cache.lines;
		// Blocks and bars lose one more column to the left border strip (see edged).
		const w = Math.max(1, width - (this.shape === "plain" ? 2 : 3));
		const r = this.right;
		const rw = visibleWidth(r);
		let line: string;
		if (rw && rw + 4 < w) {
			const l = truncateToWidth(this.left, w - rw - 2, "…");
			line = `${l}${" ".repeat(Math.max(2, w - visibleWidth(l) - rw))}${r}`;
		} else {
			line = truncateToWidth(this.left, w, "…");
		}
		let lines: string[];
		if (this.shape === "plain") {
			// OpenCode's inline row: no shade, nothing under it.
			lines = [` ${line}`];
		} else if (this.shape === "block") {
			// OpenCode's block: a blank shaded row above and below, and one between the command and
			// its output (paddingTop/paddingBottom 1, gap 1). Every body line is shaded too.
			const pad = edged(this.theme, "", width);
			const bodyLine = (b: string) => edged(this.theme, ` ${truncateToWidth(b, w, "…")} `, width);
			lines = [pad, edged(this.theme, ` ${line} `, width), pad, ...this.body.map(bodyLine), pad];
		} else {
			// "bar": a shaded one-liner with unshaded output under it (tools without a block look).
			const bodyLine = (b: string) => ` ${truncateToWidth(b, w + 1, "…")}`;
			lines = [edged(this.theme, ` ${line} `, width), ...this.body.map(bodyLine)];
		}
		this.cache = { width, mode, lines };
		return lines;
	}
}

function rel(path: unknown, cwd: string): string {
	if (typeof path !== "string" || !path) return "…";
	const r = relative(cwd, path);
	return scrubText(!r || r.startsWith("..") ? path.replace(process.env.HOME ?? "\0", "~") : r);
}

function textOf(result: { content?: { type: string; text?: string }[] }): string {
	return (result.content ?? [])
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

function preview(text: string, theme: Theme, n = PREVIEW_LINES): string[] {
	const lines = sanitizeLines(text).replace(/\s+$/, "").split("\n");
	const shown = lines.slice(0, n).map((l) => `  ${theme.fg("toolOutput", l.replace(/\t/g, "  "))}`);
	if (lines.length > n) shown.push(`  ${theme.fg("dim", `… ${lines.length - n} more lines`)}`);
	return shown;
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;:]*m/g, "");

/** Lines of a diff or a new file shown under a finished edit or write row, and when opened. */
const CODE_PEEK_LINES = 20;
const CODE_OPEN_LINES = 120;

/** The lines of a diff as pi draws them (added, removed and context colours), without the trailing blank. */
function diffLines(diff: string | undefined): string[] {
	if (!diff) return [];
	const lines = renderDiff(sanitizeLines(diff)).split("\n");
	while (lines.length && stripAnsi(lines[lines.length - 1]!).trim() === "") lines.pop();
	return lines;
}

/** Numbered lines of a new file: a dim number in a column as wide as the last one, then the code. */
function numbered(text: string, theme: Theme): string[] {
	const lines = sanitizeLines(text).replace(/\s+$/, "").split("\n");
	const w = String(lines.length).length;
	return lines.map((l, i) => `${theme.fg("dim", String(i + 1).padStart(w))}  ${theme.fg("toolOutput", l.replace(/\t/g, "  "))}`);
}

/** Lines in a file's text: a final newline ends the last line, it does not start another. */
export function countLines(text: unknown): number {
	const t = sanitizeLines(text).replace(/\n$/, "");
	return t === "" ? 0 : t.split("\n").length;
}

/** Indent body lines two columns, under the title text, as bash output is. */
const indented = (lines: string[]) => lines.map((l) => `  ${l}`);

/** The first `n` of `lines`, with a dim note of what is left and how to open it. */
function clipped(lines: string[], n: number, theme: Theme, hint: boolean): string[] {
	if (lines.length <= n) return lines;
	const note = `… ${lines.length - n} more lines${hint ? " · ctrl+o or click to expand" : ""}`;
	return [...lines.slice(0, n), theme.fg("dim", note)];
}

/** The dim glyph and a space, or nothing when the current icon set has none for this tool. */
const callIcon = (theme: Theme, glyph: string) => (glyph ? `${theme.fg("dim", glyph)} ` : "");
const name = (theme: Theme, s: string) => theme.fg("text", s);
const arg = (theme: Theme, s: string) => theme.fg("muted", s);

/** What a renderer knows beyond the result: its shared state and how long the call ran. */
interface RenderExtra {
	isError: boolean;
	/** Seconds from the first partial result to the last, when the renderer saw both. */
	seconds?: number;
}

/** How one tool is drawn. Exported for tests. */
export interface Spec {
	/** An icon name (see TOOL_ICONS); the glyph is looked up when the row is drawn. */
	icon?: IconName;
	/** A glyph supplied by another extension, already cleaned (see `fromRowSpec`). Wins over `icon`. */
	iconLike?: IconLike;
	title: string;
	describe: (args: any, cwd: string, theme: Theme) => string;
	summarize: (result: any, args: any, theme: Theme, isError: boolean, extra?: RenderExtra) => string;
	expand?: (result: any, args: any, theme: Theme, extra?: RenderExtra) => string[];
	/**
	 * Body lines while the call is still running, from the partial result so far. Return undefined
	 * for nothing yet. `expanded` is whether the row was opened with ctrl+o.
	 */
	live?: (partial: any, theme: Theme, expanded: boolean) => string[] | undefined;
	/**
	 * Body lines left under a finished row while it is collapsed (the last lines of output, and a
	 * hint for opening the rest). Return undefined for none. Rows with a peek draw as a shaded block.
	 */
	peek?: (result: any, args: any, theme: Theme, extra?: RenderExtra) => string[] | undefined;
}

/** Lines of bash output shown when a row is expanded, from each end when the output is long. */
const BASH_HEAD_LINES = 6;
const BASH_TAIL_LINES = 14;

/** The parsed output of a bash result, cached on the result object so summary and body share it. */
const parsedBash = new WeakMap<object, BashOutput>();
function bashOutputOf(result: any, isError: boolean): BashOutput {
	const key = result && typeof result === "object" ? result : undefined;
	const hit = key && parsedBash.get(key);
	if (hit) return hit;
	const parsed = parseBashOutput(textOf(result), {
		isError,
		truncation: result?.details?.truncation,
		fullOutputPath: result?.details?.fullOutputPath,
	});
	// cleanLine removes escape sequences and controls; bidi controls are removed here.
	parsed.lines = parsed.lines.map(stripEscapes);
	if (key) parsedBash.set(key, parsed);
	return parsed;
}

/** Output lines for an expanded bash row: the first and last of a long output, with a note between. */
function bashBody(out: BashOutput, theme: Theme): string[] {
	const dim = (s: string) => `  ${theme.fg("dim", s)}`;
	const line = (l: string) => `  ${theme.fg("toolOutput", l)}`;
	if (!out.lines.length) return [dim("(no output)")];
	const limit = BASH_HEAD_LINES + BASH_TAIL_LINES;
	if (out.lines.length <= limit && !out.truncated) return out.lines.map(line);
	const head = foldLines(out.lines, BASH_HEAD_LINES, "head").shown;
	const tail = foldLines(out.lines, BASH_TAIL_LINES, "tail").shown;
	const hidden = out.totalLines - head.length - tail.length;
	const note =
		out.truncated && out.fullOutputPath
			? `… ${hidden} more lines, full output in ${scrubText(out.fullOutputPath.replace(process.env.HOME ?? "\0", "~"))}`
			: `… ${hidden} more lines`;
	return [...head.map(line), dim(note), ...tail.map(line)];
}

function errorLine(result: any, theme: Theme): string {
	const first = sanitize(sanitizeLines(textOf(result)).split("\n").find((l) => sanitize(l)) ?? "") || "error";
	if (/operation was aborted|aborted/i.test(first)) return theme.fg("warning", "cancelled");
	return theme.fg("error", first.length > 60 ? `${first.slice(0, 57)}…` : first);
}

/** Exported for tests. */
export const SPECS: Record<string, Spec> = {
	read: {
		icon: TOOL_ICONS.read,
		title: "Read",
		describe: (a, cwd, t) => {
			const range = a?.offset != null || a?.limit != null ? t.fg("dim", ` :${sanitize(a.offset ?? 1)}${a.limit ? `+${sanitize(a.limit)}` : ""}`) : "";
			return `${arg(t, rel(a?.path, cwd))}${range}`;
		},
		summarize: (r, _a, t, err) => {
			if (err) return errorLine(r, t);
			if (r.content?.some((c: any) => c.type === "image")) return t.fg("dim", "image");
			const n = textOf(r).replace(/\n+$/, "").split("\n").length;
			const trunc = r.details?.truncation?.truncated ? t.fg("warning", " truncated") : "";
			return t.fg("dim", `${n} line${n === 1 ? "" : "s"}`) + trunc;
		},
		expand: (r, _a, t) => preview(textOf(r), t),
	},
	write: {
		icon: TOOL_ICONS.write,
		title: "Write",
		describe: (a, cwd, t) => arg(t, rel(a?.path, cwd)),
		summarize: (r, a, t, err) => (err ? errorLine(r, t) : t.fg("success", `+${countLines(a?.content)}`)),
		peek: (r, a, t, extra) => {
			if (extra?.isError || !a?.content) return undefined;
			return indented(clipped(numbered(String(a.content), t), CODE_PEEK_LINES, t, true));
		},
		expand: (_r, a, t) => indented(clipped(numbered(String(a?.content ?? ""), t), CODE_OPEN_LINES, t, false)),
	},
	edit: {
		icon: TOOL_ICONS.edit,
		title: "Edit",
		describe: (a, cwd, t) => arg(t, rel(a?.path, cwd)),
		summarize: (r, _a, t, err) => {
			if (err) return errorLine(r, t);
			const s = diffStats(r.details?.diff);
			return `${t.fg("success", `+${s.added}`)} ${t.fg("error", `-${s.removed}`)}`;
		},
		peek: (r, _a, t, extra) => {
			if (extra?.isError) return undefined;
			const lines = diffLines(r.details?.diff);
			return lines.length ? indented(clipped(lines, CODE_PEEK_LINES, t, true)) : undefined;
		},
		expand: (r, _a, t) => indented(clipped(diffLines(r.details?.diff), CODE_OPEN_LINES, t, false)),
	},
	bash: {
		icon: TOOL_ICONS.bash,
		title: "",
		describe: (a, _cwd, t) => {
			// A carriage return or line separator counts as a line break here, so a command cannot
			// hide its tail by rewinding the line.
			const command = sanitizeLines(a?.command ?? "…");
			const cmd = scrubText(command.split("\n").find((l) => l.trim()) ?? "");
			const multi = command.includes("\n") ? t.fg("dim", " …") : "";
			return `${t.fg("text", cmd)}${multi}`;
		},
		summarize: (r, _a, t, err, extra) => {
			const out = bashOutputOf(r, err);
			const time = formatWallTime(extra?.seconds);
			const tail = time ? t.fg("dim", ` · ${time}`) : "";
			if (out.status === "aborted") return t.fg("warning", "cancelled");
			if (out.status === "timeout") return t.fg("error", `timed out ${out.timeoutSecs}s`);
			if (out.status === "no-exit") return t.fg("error", "no exit code");
			if (out.status === "failed") return t.fg("error", out.exitCode !== undefined ? `exit ${out.exitCode}` : "failed") + tail;
			const n = out.totalLines;
			return t.fg("dim", n ? `${n} line${n === 1 ? "" : "s"}` : "done") + tail;
		},
		expand: (r, a, t, extra) => {
			const out = bashOutputOf(r, extra?.isError === true);
			const cmd = sanitizeLines(a?.command ?? "");
			return [...(cmd.includes("\n") ? preview(cmd, t, 8) : []), ...bashBody(out, t)];
		},
		peek: (r, _a, t, extra) => {
			const out = bashOutputOf(r, extra?.isError === true);
			if (!out.lines.length) return undefined;
			const { lines, hidden } = bashPeek(out);
			const body = lines.map((l) => `  ${t.fg("toolOutput", l)}`);
			if (hidden > 0) body.unshift(`  ${t.fg("dim", `… ${hidden} more lines · ctrl+o or click to expand`)}`);
			return body;
		},
		live: (partial, t, expanded) => {
			const tail = liveTail(textOf(partial), expanded ? BASH_HEAD_LINES + BASH_TAIL_LINES : LIVE_TAIL_LINES);
			const lines = tail.lines.map(stripEscapes);
			const earlier = tail.earlier;
			if (!lines.length) return undefined;
			const body = lines.map((l) => `  ${t.fg("toolOutput", l)}`);
			return earlier ? [`  ${t.fg("dim", `… ${earlier} earlier`)}`, ...body] : body;
		},
	},
	grep: {
		icon: TOOL_ICONS.grep,
		title: "Grep",
		describe: (a, cwd, t) => `${t.fg("text", JSON.stringify(scrubText(a?.pattern ?? "")))}${a?.path ? arg(t, ` in ${rel(a.path, cwd)}`) : ""}${a?.glob ? t.fg("dim", ` ${scrubText(a.glob)}`) : ""}`,
		summarize: (r, _a, t, err) => {
			if (err) return errorLine(r, t);
			const out = textOf(r).trim();
			const n = !out || /^no matches/i.test(out) ? 0 : out.split("\n").length;
			return t.fg("dim", `${n} match${n === 1 ? "" : "es"}`);
		},
		expand: (r, _a, t) => preview(textOf(r), t),
	},
	find: {
		icon: TOOL_ICONS.find,
		title: "Find",
		describe: (a, cwd, t) => `${t.fg("text", scrubText(a?.pattern ?? ""))}${a?.path ? arg(t, ` in ${rel(a.path, cwd)}`) : ""}`,
		summarize: (r, _a, t, err) => {
			if (err) return errorLine(r, t);
			const out = textOf(r).trim();
			const n = !out || /^no files/i.test(out) ? 0 : out.split("\n").length;
			return t.fg("dim", `${n} file${n === 1 ? "" : "s"}`);
		},
		expand: (r, _a, t) => preview(textOf(r), t),
	},
	ls: {
		icon: TOOL_ICONS.ls,
		title: "List",
		describe: (a, cwd, t) => arg(t, rel(a?.path ?? ".", cwd)),
		summarize: (r, _a, t, err) => (err ? errorLine(r, t) : t.fg("dim", `${textOf(r).trim().split("\n").filter(Boolean).length} entries`)),
		expand: (r, _a, t) => preview(textOf(r), t),
	},
};

/**
 * The live body of a running row, once it has been running long enough to be worth showing. A
 * command that prints a line and then goes quiet gets no further result from pi, so this asks for
 * one more render when the delay is up.
 */
function liveBody(
	spec: Spec,
	partial: any,
	theme: Theme,
	expanded: boolean,
	state: any,
	invalidate: (() => void) | undefined,
): string[] | undefined {
	if (!spec.live || !state) return undefined;
	const text = textOf(partial);
	const now = Date.now();
	if (!liveVisible(state.firstSeenAt, now, text.trim() !== "")) {
		const wait = text.trim() !== "" ? liveWaitMs(state.firstSeenAt, now) : undefined;
		if (wait !== undefined && invalidate && !state.liveTimer) {
			state.liveTimer = setTimeout(() => {
				state.liveTimer = undefined;
				invalidate();
			}, wait);
			state.liveTimer.unref?.();
		}
		return undefined;
	}
	return spec.live(partial, theme, expanded);
}

/** The glyph a spec draws in the current icon set, or "" for none. A supplied glyph is held to two cells. */
function glyphOf(spec: Spec): string {
	if (spec.iconLike !== undefined) return truncateToWidth(resolveIcon(spec.iconLike) ?? "", 2);
	return spec.icon ? icon(spec.icon) : "";
}

/** Exported for tests: the renderers for one tool spec. */
export function makeRenderers(spec: Spec, getCwd: () => string) {
	const describe = (args: any, theme: Theme, cwd: string) =>
		`${spec.title ? `${name(theme, spec.title)} ` : ""}${spec.describe(args, cwd, theme)}`;
	return {
		/**
		 * Call row: shown until the first result arrives. pi renders call then result into the same
		 * shell on every update, so renderResult hides the call row (shared via context.state).
		 */
		renderCall(args: any, theme: Theme, context: any): Component {
			const row = new Row(theme, `${callIcon(theme, glyphOf(spec))}${describe(args, theme, context?.cwd ?? getCwd())}`, theme.fg("dim", "…"), [], "plain");
			if (context?.state) context.state.callRow = row;
			return row;
		},
		renderResult(result: any, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: any): Component {
			const callRow: Row | undefined = context?.state?.callRow;
			if (callRow) callRow.hidden = true;
			const args = context?.args;
			const isError = context?.isError === true;
			// Time the call from the first result this renderer sees: a partial one while it runs.
			const state = context?.state;
			let seconds: number | undefined;
			if (state) {
				state.firstSeenAt ??= Date.now();
				if (!options.isPartial) {
					state.doneAt ??= Date.now();
					if (state.sawPartial) seconds = (state.doneAt - state.firstSeenAt) / 1000;
				} else {
					state.sawPartial = true;
				}
			}
			if (!options.isPartial && state?.liveTimer) {
				clearTimeout(state.liveTimer);
				state.liveTimer = undefined;
			}
			const extra: RenderExtra = { isError, seconds };
			const glyph = glyphOf(spec);
			const mark = !glyph ? "" : isError ? `${theme.fg("error", glyph)} ` : options.isPartial ? `${primary(theme, glyph)} ` : callIcon(theme, glyph);
			const left = `${mark}${describe(args, theme, context?.cwd ?? getCwd())}`;
			const right = options.isPartial ? theme.fg("dim", "running…") : spec.summarize(result, args, theme, isError, extra);
			let body: string[] = [];
			if (options.isPartial) {
				body = liveBody(spec, result, theme, options.expanded, state, context?.invalidate) ?? [];
			} else if (options.expanded && spec.expand) {
				body = spec.expand(result, args, theme, extra);
			} else if (spec.peek) {
				body = spec.peek(result, args, theme, extra) ?? [];
			}
			// Once a call has shown output it stays a block, even if a later frame has less to show
			// (a quiet stretch while it runs), so it never flips back and forth.
			if (state && body.length > 0) state.sawBody = true;
			const shape = rowShape({
				blockTool: Boolean(spec.peek || spec.live),
				hasBody: body.length > 0,
				isError,
				expanded: options.expanded === true && !options.isPartial && body.length > 0,
				sawBody: state?.sawBody === true,
			});
			return new Row(theme, left, right, body, shape);
		},
	};
}

/** The most lines a registered spec's `expand` may show before halo cuts the rest. */
const ROW_EXPAND_LINES = 120;

/** Text from another extension: escape sequences, control characters and bidi controls removed, one line, SGR kept. */
const outside = (value: unknown): string => scrubText(value, true);

function outsideIcon(like: IconLike | undefined): IconLike | undefined {
	if (typeof like === "string") return scrubText(like);
	if (like && typeof like === "object") return like.plain === undefined ? { nerd: scrubText(like.nerd) } : { nerd: scrubText(like.nerd), plain: scrubText(like.plain) };
	return undefined;
}

/**
 * An internal spec for a row spec another extension registered. Everything the spec returns is
 * cleaned here, so the row code below never sees raw text from outside. Exported for tests.
 */
export function fromRowSpec(row: ToolRowSpec): Spec {
	return {
		iconLike: outsideIcon(row.icon),
		title: outside(row.title),
		describe: (a, cwd, t) => outside(row.describe(a, cwd, t)),
		summarize: (r, a, t, err) => outside(row.summarize(r, a, t, err)),
		expand: row.expand
			? (r, a, t) => {
					const lines = row.expand!(r, a, t);
					if (!Array.isArray(lines)) return [];
					return indented(clipped(lines.map(outside), ROW_EXPAND_LINES, t, false));
				}
			: undefined,
	};
}

/** Two components drawn one after the other. */
function stacked(first: Component, second: Component): Component {
	return {
		invalidate() {
			first.invalidate();
			second.invalidate();
		},
		render: (width: number) => [...first.render(width), ...second.render(width)],
	};
}

/**
 * Renderers for a tool that belongs to another extension, drawn from the row spec it registered.
 * If the spec throws (while drawing the call or the result), this call and every later frame of it
 * are drawn by the tool's own renderers (`next()`); when it has none, the error goes to pi, which
 * draws its plain fallback. A broken spec therefore costs the tool its styled row and nothing else.
 */
function rowRenderers(row: ToolRowSpec, next: () => ToolRenderers | undefined): ToolRenderers {
	let inner: ReturnType<typeof makeRenderers> | undefined;
	try {
		inner = makeRenderers(fromRowSpec(row), () => process.cwd());
	} catch {
		inner = undefined;
	}
	const failed = (context: any): boolean => inner === undefined || context?.state?.rowSpecFailed === true;
	/** Remember that the spec failed for this call; the styled call row, if any, is no longer drawn. */
	const fail = (context: any): void => {
		if (!context?.state) return;
		context.state.rowSpecFailed = true;
		context.state.callRow = undefined;
	};
	return {
		renderShell: "self",
		renderCall(args, theme, context) {
			if (!failed(context)) {
				try {
					return inner!.renderCall(args, theme, context);
				} catch {
					fail(context);
				}
			}
			const render = next()?.renderCall;
			if (!render) throw new Error("tool row spec failed and the tool has no renderer of its own");
			return render(args, theme, context);
		},
		renderResult(result, options, theme, context) {
			// Set while the styled call row is on screen (and hidden by a result that began to draw).
			const styledCall = context?.state?.callRow !== undefined;
			if (!failed(context)) {
				try {
					return inner!.renderResult(result, options, theme, context);
				} catch {
					fail(context);
				}
			}
			const own = next();
			if (!own?.renderResult) throw new Error("tool row spec failed and the tool has no renderer of its own");
			const body = own.renderResult(result, options, theme, context);
			// pi drew the styled call row first; it is hidden now, so the tool's own call row takes its place.
			return styledCall && own.renderCall ? stacked(own.renderCall(context?.args, theme, context), body) : body;
		},
	};
}

/**
 * Draw the built-in tools with halo's rows, and any other tool whose extension registered a row
 * spec (`registerToolRows`). A resolver answers for these names and passes every other tool to
 * `next()`, so pi keeps the tool definitions, their settings (shell prefix, shell path, image
 * resizing) and which tools are active; only the drawing changes. The resolver wins over a tool's
 * own renderers. Halo's own specs win over a registered spec of the same name. The registered specs
 * are looked up when a call first appears, so load order does not matter.
 */
export function installToolRenderers(pi: ExtensionAPI): void {
	const drawn = Object.fromEntries(Object.keys(SPECS).map((n) => [n, { ...makeRenderers(SPECS[n]!, () => process.cwd()), renderShell: "self" as const }]));
	pi.registerToolRenderer((toolName, next) => {
		if (Object.hasOwn(drawn, toolName)) return drawn[toolName];
		const row = toolRowFor(toolName);
		return row ? rowRenderers(row, next) : next();
	});
}
