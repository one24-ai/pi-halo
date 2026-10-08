/**
 * Ctrl+X leader actions and the Ctrl+P command palette (OpenCode keybinds).
 *
 * Leader (ctrl+x, then):
 *   n new session      l sessions (resume)   r resume last    m model
 *   t theme            b toggle sidebar      d diff view      a toggle Build/Plan
 *   c compact          x export              g tree           y copy last msg
 *   s status (/session)  h hotkeys           q quit           ? leader help
 *
 * Built-in pi commands (/new, /model, ...) are only reachable by submitting them through the
 * editor, so leader actions that map to a slash command call the editor's onSubmit, which is
 * pi's own command dispatcher.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	matchesKey,
	type SelectItem,
	SelectList,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { parseWidgetActionValue, runWidgetAction } from "./api.ts";
import { getBrand } from "./brand.ts";
import { safeGlyph } from "./icons.ts";
import { fit, primary } from "./palette.ts";

export interface LeaderAction {
	key: string;
	label: string;
	/** Slash command submitted through pi's dispatcher, or a function. */
	run: string | (() => void);
}

export function leaderActions(hooks: {
	toggleSidebar: () => void;
	cycleMode: () => void;
	showHelp: () => void;
}): LeaderAction[] {
	return [
		{ key: "n", label: "New session", run: "/new" },
		{ key: "l", label: "Sessions", run: "/resume" },
		{ key: "r", label: "Resume last session", run: "/halo-resume-last" },
		{ key: "m", label: "Models", run: "/model" },
		{ key: "t", label: "Themes", run: "/settings" },
		{ key: "b", label: "Toggle sidebar", run: hooks.toggleSidebar },
		{ key: "d", label: "Diff view", run: "/diff" },
		{ key: "a", label: "Switch Build/Plan", run: hooks.cycleMode },
		{ key: "c", label: "Compact session", run: "/compact" },
		{ key: "x", label: "Export session", run: "/export" },
		{ key: "g", label: "Session tree", run: "/tree" },
		{ key: "y", label: "Copy last message", run: "/copy" },
		{ key: "s", label: "Session status", run: "/session" },
		{ key: "h", label: "Hotkeys", run: "/hotkeys" },
		{ key: "q", label: "Quit", run: "/quit" },
		{ key: "?", label: "Leader help", run: hooks.showHelp },
	];
}

export interface PaletteItem {
	value: string;
	label: string;
	description?: string;
	/** Right-aligned hint, e.g. the key binding. */
	hint?: string;
}

/** All slash commands for the palette: built-ins, extension commands, prompts, skills. */
export function paletteItems(
	pi: ExtensionAPI,
	builtins: ReadonlyArray<{ name: string; description?: string }>,
	leader: LeaderAction[],
	widgetItems: PaletteItem[] = [],
): PaletteItem[] {
	const byName = new Map<string, PaletteItem>();
	const leaderHint = new Map<string, string>();
	for (const a of leader) if (typeof a.run === "string") leaderHint.set(a.run.slice(1), `ctrl+x ${a.key}`);
	for (const c of builtins) byName.set(c.name, { value: `/${c.name}`, label: `/${c.name}`, description: c.description, hint: leaderHint.get(c.name) });
	for (const c of pi.getCommands()) {
		if (!c.name || byName.has(c.name)) continue;
		byName.set(c.name, { value: `/${c.name}`, label: `/${c.name}`, description: c.description });
	}
	const items = [...byName.values()];
	// Non-slash actions (sidebar, mode) go first so they're easy to find.
	const actions: PaletteItem[] = leader
		.filter((a) => typeof a.run === "function")
		.map((a) => ({ value: `leader:${a.key}`, label: a.label, hint: `ctrl+x ${a.key}` }));
	return [...actions, ...widgetItems, ...items.sort((a, b) => a.label.localeCompare(b.label))];
}

/** Fuzzy-ish match: every query character in order, scored by compactness and prefix. */
export function fuzzyScore(query: string, text: string): number | undefined {
	const q = query.toLowerCase();
	const t = text.toLowerCase();
	if (!q) return 0;
	const idx = t.indexOf(q);
	if (idx >= 0) return idx === 0 || t[idx - 1] === "/" ? 0 : 1 + idx / 100;
	let ti = 0;
	let first = -1;
	let last = -1;
	for (const ch of q) {
		const found = t.indexOf(ch, ti);
		if (found < 0) return undefined;
		if (first < 0) first = found;
		last = found;
		ti = found + 1;
	}
	return 10 + (last - first) / 10;
}

export function filterPalette(items: PaletteItem[], query: string): PaletteItem[] {
	if (!query.trim()) return items;
	return items
		.map((item) => {
			const s1 = fuzzyScore(query, item.label);
			// Descriptions only match as a contiguous substring; subsequence matches there are noise.
			const s2 = item.description?.toLowerCase().includes(query.toLowerCase()) ? 0 : undefined;
			const score = s1 ?? (s2 !== undefined ? s2 + 20 : undefined);
			return score === undefined ? undefined : { item, score };
		})
		.filter((x): x is { item: PaletteItem; score: number } => x !== undefined)
		.sort((a, b) => a.score - b.score || a.item.label.localeCompare(b.item.label))
		.map((x) => x.item);
}

/** Centered command palette: a search input over a filtered list. */
export class CommandPalette implements Component, Focusable {
	focused = false;
	private readonly input = new Input({ placeholder: "Search commands" });
	private readonly items: PaletteItem[];
	private readonly theme: Theme;
	private readonly done: (value: string | undefined) => void;
	private readonly maxVisible: number;
	private list: SelectList;
	private filtered: PaletteItem[];

	constructor(items: PaletteItem[], theme: Theme, done: (value: string | undefined) => void, maxVisible = 12) {
		this.items = items;
		this.theme = theme;
		this.done = done;
		this.maxVisible = maxVisible;
		this.filtered = items;
		this.list = this.makeList(items);
	}

	private makeList(items: PaletteItem[]): SelectList {
		const t = this.theme;
		const selectItems: SelectItem[] = items.map((i) => ({
			value: i.value,
			label: i.hint ? `${i.label}  ${t.fg("dim", i.hint)}` : i.label,
			description: i.description,
		}));
		const list = new SelectList(selectItems, this.maxVisible, {
			selectedPrefix: (s) => primary(t, s),
			selectedText: (s) => t.bold(t.fg("text", s)),
			description: (s) => t.fg("muted", s),
			scrollInfo: (s) => t.fg("dim", s),
			noMatch: (s) => t.fg("dim", s),
		});
		list.onSelect = (item) => this.done(item.value);
		list.onCancel = () => this.done(undefined);
		return list;
	}

	invalidate(): void {
		this.list.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "pageUp") || matchesKey(data, "pageDown") || matchesKey(data, "enter")) {
			if (matchesKey(data, "enter") && this.filtered.length === 0) return;
			this.list.handleInput(data);
			return;
		}
		const before = this.input.getValue();
		this.input.handleInput(data);
		const after = this.input.getValue();
		if (after !== before) {
			this.filtered = filterPalette(this.items, after);
			this.list = this.makeList(this.filtered);
		}
	}

	render(width: number): string[] {
		const t = this.theme;
		const inner = Math.max(10, width - 4);
		this.input.focused = this.focused;
		const border = (s: string) => t.fg("borderMuted", s);
		const lines: string[] = [];
		const title = `${primary(t, safeGlyph(getBrand().glyph))} ${t.bold("Commands")}`;
		const esc = t.fg("dim", "esc");
		lines.push(border("╭") + border("─".repeat(width - 2)) + border("╮"));
		const head = `${title}${" ".repeat(Math.max(1, inner - visibleWidth(title) - visibleWidth(esc)))}${esc}`;
		lines.push(`${border("│")} ${fit(head, inner)} ${border("│")}`);
		for (const l of this.input.render(inner)) lines.push(`${border("│")} ${fit(l, inner)} ${border("│")}`);
		lines.push(`${border("│")} ${fit("", inner)} ${border("│")}`);
		const body = this.filtered.length ? this.list.render(inner) : [t.fg("dim", "No matching commands")];
		for (const l of body) lines.push(`${border("│")} ${fit(l, inner)} ${border("│")}`);
		lines.push(border("╰") + border("─".repeat(width - 2)) + border("╯"));
		return lines.map((l) => truncateToWidth(l, width, ""));
	}
}

/** Leader help overlay contents. */
export function leaderHelpLines(actions: LeaderAction[], theme: Theme): string[] {
	return [
		theme.bold("ctrl+x then…"),
		"",
		...actions.map((a) => `  ${primary(theme, a.key.padEnd(2))} ${a.label}${typeof a.run === "string" ? theme.fg("dim", `  ${a.run}`) : ""}`),
		"",
		theme.fg("dim", "tab on an empty prompt: switch Build/Plan"),
		theme.fg("dim", "shift+tab: cycle thinking level"),
		theme.fg("dim", "ctrl+p: command palette"),
	];
}

export function runPaletteValue(value: string, ctx: ExtensionContext, actions: LeaderAction[], submit: (text: string) => void): void {
	const widgetAction = parseWidgetActionValue(value);
	if (widgetAction) {
		void runWidgetAction(widgetAction.widgetId, widgetAction.actionId, ctx).then((err) => {
			if (err) ctx.ui.notify(err, "warning");
		});
		return;
	}
	if (value.startsWith("leader:")) {
		const a = actions.find((x) => `leader:${x.key}` === value);
		if (a && typeof a.run === "function") a.run();
		return;
	}
	// Commands that take arguments go to the editor so the user can finish them.
	const needsArgs = /^\/(name|login|thinking|bug|import)$/.test(value);
	if (needsArgs) {
		ctx.ui.setEditorText(`${value} `);
		return;
	}
	submit(value);
}
