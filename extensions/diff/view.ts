/**
 * The diff panel: a full-size overlay with the changed files on the left and the selected file's
 * diff on the right (one pane at a time below 100 columns). Keyboard first, with the mouse as an
 * extra: click a file or a tab, wheel to scroll.
 *
 *   j k / arrows    files (list) or lines (diff)       ] [     next / previous hunk
 *   enter l         open the diff pane                 h       back to the list
 *   ctrl+d ctrl+u   half a page                        g G     top / bottom
 *   tab             changes <-> branch                 r       reload
 *   a               actions added by other extensions  esc q   close
 *
 * The loader is injected, so the view can be tested with no git and no terminal.
 */

import { relative, resolve } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, type TuiMouseEvent, type TuiMouseEventResult, visibleWidth } from "@earendil-works/pi-tui";
import { icon } from "../halo/icons.ts";
import type { FileDiff, Loaded } from "./git-diff.ts";
import { type Body, buildBody, cell, clean, hunkAt, type Palette, paletteFor, renderBodyRow, renderFileRow } from "./render.ts";
import type { DiffAction, DiffActionContext, DiffFileInfo, DiffHunkInfo } from "./types.ts";

export type Source = "changes" | "branch" | "external";

/** Width below which the two panes become one. */
export const TWO_PANE_MIN = 100;
const WHEEL_LINES = 3;

export interface ViewDeps {
	tui: { terminal: { rows: number; columns: number }; requestRender(): void };
	theme: Theme;
	ctx: ExtensionContext;
	cwd: string;
	/** Actions to offer under `a`, read each time the menu opens. */
	actions: () => DiffAction[];
	/** Close the panel. */
	done: () => void;
	load: (source: "changes" | "branch", cwd: string) => Promise<Loaded>;
	/** A diff that did not come from git here: shown instead of the two git sources. */
	external?: { title: string; files: FileDiff[] };
	initial?: "changes" | "branch";
	/** Select this file (a path, relative to `cwd` or absolute) once the first load finishes. */
	file?: string;
}

interface Layout {
	w: number;
	h: number;
	two: boolean;
	listW: number;
	diffX: number;
	diffW: number;
	contentH: number;
}

const exact = (s: string, w: number): string => {
	const v = visibleWidth(s);
	if (v === w) return s;
	if (v > w) return `${truncateToWidth(s, w, "")}\x1b[0m`;
	return s + " ".repeat(w - v);
};

export function layoutFor(w: number, h: number): Layout {
	const two = w >= TWO_PANE_MIN;
	const listW = two ? Math.min(44, Math.max(28, Math.floor(w * 0.3))) : w;
	const diffX = two ? listW + 1 : 0;
	return { w, h, two, listW, diffX, diffW: two ? w - diffX : w, contentH: Math.max(1, h - 2) };
}

const fileInfo = (f: FileDiff): DiffFileInfo => ({ path: f.path, oldPath: f.oldPath, status: f.status, added: f.added, removed: f.removed, binary: f.binary });

export class DiffView implements Component {
	private readonly d: ViewDeps;
	private source: Source;
	private readonly data: Partial<Record<Source, Loaded>> = {};
	private loading = false;
	private token = 0;
	private closed = false;
	private sel: Record<Source, number> = { changes: 0, branch: 0, external: 0 };
	private listTop = 0;
	private top = 0;
	/** The hunk `]` and `[` moved to, which actions use. It follows the scroll when the view scrolls. */
	private cursor = 0;
	private shift = 0;
	private focus: "list" | "diff" = "list";
	private bodyFor: { file: FileDiff; body: Body } | undefined;
	private menu: { items: DiffAction[]; sel: number; top: number } | undefined;
	/** Where the menu was drawn: its first row, its columns, its row count, and the item shown on the first row after the title. */
	private menuRect: { y: number; x: number; w: number; h: number; top: number } | undefined;
	private tabs: { source: Source; x0: number; x1: number }[] = [];
	private lay: Layout | undefined;
	private flash: string | undefined;
	/** The file to select when the first load finishes; cleared after. */
	private wantFile: string | undefined;

	constructor(deps: ViewDeps) {
		this.d = deps;
		this.source = deps.external ? "external" : (deps.initial ?? "changes");
		this.wantFile = deps.file ? relative(deps.cwd, resolve(deps.cwd, deps.file)) : undefined;
		if (deps.external) this.data.external = { files: deps.external.files };
		else void this.ensure(deps.initial ?? "changes");
	}

	// ---- data ------------------------------------------------------------------------------------

	private async ensure(source: "changes" | "branch", force = false): Promise<void> {
		if (!force && this.data[source]) return;
		const token = ++this.token;
		this.loading = true;
		this.d.tui.requestRender();
		let result: Loaded;
		try {
			result = await this.d.load(source, this.d.cwd);
		} catch (e) {
			result = { files: [], error: e instanceof Error ? e.message.split("\n")[0] : "load failed" };
		}
		if (this.closed || token !== this.token) return;
		const old = this.data[source];
		const keep = old?.files[this.sel[source]]?.path;
		this.data[source] = result;
		const want = this.wantFile;
		this.wantFile = undefined;
		// git lists paths from the repo root, which may be above cwd ("app/b.ts" for "b.ts"): try the
		// exact path first, then a path that ends with it
		const exact = want ? result.files.findIndex((f) => f.path === want) : -1;
		const wanted = exact >= 0 || !want ? exact : result.files.findIndex((f) => f.path.endsWith(`/${want}`));
		const at = wanted >= 0 ? wanted : keep ? result.files.findIndex((f) => f.path === keep) : -1;
		this.sel[source] = at >= 0 ? at : Math.min(this.sel[source], Math.max(0, result.files.length - 1));
		this.loading = false;
		this.bodyFor = undefined;
		if (source === this.source) {
			this.top = 0;
			this.cursor = 0;
		}
		this.d.tui.requestRender();
	}

	private get loaded(): Loaded | undefined {
		return this.data[this.source];
	}

	private get files(): FileDiff[] {
		return this.loaded?.files ?? [];
	}

	private get file(): FileDiff | undefined {
		return this.files[this.sel[this.source]];
	}

	private get body(): Body | undefined {
		const f = this.file;
		if (!f) return undefined;
		if (this.bodyFor?.file !== f) this.bodyFor = { file: f, body: buildBody(f) };
		return this.bodyFor.body;
	}

	dispose(): void {
		this.closed = true;
	}
	invalidate(): void {}

	// ---- state changes ---------------------------------------------------------------------------

	private select(i: number): void {
		const n = this.files.length;
		if (!n) return;
		const next = Math.max(0, Math.min(n - 1, i));
		if (next !== this.sel[this.source]) {
			this.sel[this.source] = next;
			this.top = 0;
			this.cursor = 0;
			this.shift = 0;
		}
		this.keepSelectionVisible();
	}

	private keepSelectionVisible(): void {
		const h = this.lay?.contentH ?? 10;
		const i = this.sel[this.source];
		if (i < this.listTop) this.listTop = i;
		else if (i >= this.listTop + h) this.listTop = i - h + 1;
	}

	private maxTop(): number {
		const body = this.body;
		return Math.max(0, (body?.rows.length ?? 0) - (this.lay?.contentH ?? 10));
	}

	private scroll(by: number): void {
		const before = this.top;
		this.top = Math.max(0, Math.min(this.maxTop(), this.top + by));
		this.followScroll(before);
	}

	/** When the view actually moved, the current hunk is the one at the top. */
	private followScroll(before: number): void {
		const body = this.body;
		if (body && this.top !== before) this.cursor = hunkAt(body, this.top);
	}

	private switchSource(to?: "changes" | "branch"): void {
		if (this.source === "external") return;
		const next = to ?? (this.source === "changes" ? "branch" : "changes");
		if (next === this.source) return;
		this.source = next;
		this.top = 0;
		this.cursor = 0;
		this.shift = 0;
		this.listTop = 0;
		this.focus = "list";
		this.bodyFor = undefined;
		void this.ensure(next);
		this.d.tui.requestRender();
	}

	/** Move to the next or previous hunk, scrolling only as far as needed to bring it into view. */
	private jumpHunk(dir: 1 | -1): void {
		const body = this.body;
		if (!body || body.hunkStarts.length === 0) return;
		this.cursor = Math.max(0, Math.min(body.hunkStarts.length - 1, this.cursor + dir));
		const start = body.hunkStarts[this.cursor]!;
		const h = this.lay?.contentH ?? 10;
		if (start < this.top || start >= this.top + h) this.top = Math.min(start, this.maxTop());
	}

	private openMenu(): void {
		const items = this.d.actions();
		if (!items.length) {
			this.flash = "No actions are registered.";
			return;
		}
		if (!this.file) return;
		this.menu = { items, sel: 0, top: 0 };
	}

	private runAction(a: DiffAction): void {
		const f = this.file;
		const body = this.body;
		if (!f) return;
		const h = body && f.hunks.length ? f.hunks[Math.min(this.cursor, f.hunks.length - 1)] : undefined;
		const hunk: DiffHunkInfo | undefined = h ? { index: f.hunks.indexOf(h), header: h.header, text: `${h.raw.join("\n")}\n` } : undefined;
		const ctx: DiffActionContext = {
			ctx: this.d.ctx,
			cwd: this.d.cwd,
			source: this.source,
			file: fileInfo(f),
			hunk,
			filePatch: `${[...f.header, ...f.hunks.flatMap((x) => x.raw)].join("\n")}\n`,
		};
		this.d.done();
		void Promise.resolve()
			.then(() => a.run(ctx))
			.catch((e: unknown) => {
				try {
					this.d.ctx.ui.notify(`${a.label}: ${e instanceof Error ? e.message.split("\n")[0] : "failed"}`, "warning");
				} catch {
					// the session may be gone
				}
			});
	}

	// ---- keys ------------------------------------------------------------------------------------

	handleInput(data: string): void {
		this.flash = undefined;
		if (this.menu) {
			this.menuInput(data);
			this.d.tui.requestRender();
			return;
		}
		const lay = this.lay ?? layoutFor(this.d.tui.terminal.columns, this.d.tui.terminal.rows);
		if (matchesKey(data, "q") || matchesKey(data, "ctrl+c")) return this.d.done();
		if (matchesKey(data, "escape")) {
			if (!lay.two && this.focus === "diff") this.focus = "list";
			else return this.d.done();
		} else if (matchesKey(data, "tab")) this.switchSource();
		else if (matchesKey(data, "r")) {
			if (this.source !== "external") void this.ensure(this.source, true);
		} else if (matchesKey(data, "a")) this.openMenu();
		else if (matchesKey(data, "]")) this.jumpHunk(1);
		else if (matchesKey(data, "[")) this.jumpHunk(-1);
		else if (matchesKey(data, ">")) this.shift += 8;
		else if (matchesKey(data, "<")) this.shift = Math.max(0, this.shift - 8);
		else if (this.focus === "list") this.listInput(data, lay);
		else this.diffInput(data, lay);
		this.d.tui.requestRender();
	}

	private listInput(data: string, lay: Layout): void {
		const i = this.sel[this.source];
		const page = Math.max(1, lay.contentH - 1);
		if (matchesKey(data, "j") || matchesKey(data, "down")) this.select(i + 1);
		else if (matchesKey(data, "k") || matchesKey(data, "up")) this.select(i - 1);
		else if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) this.select(i + page);
		else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) this.select(i - page);
		else if (matchesKey(data, "g") || matchesKey(data, "home")) this.select(0);
		else if (matchesKey(data, "shift+g") || matchesKey(data, "end")) this.select(this.files.length - 1);
		else if (matchesKey(data, "enter") || matchesKey(data, "l") || matchesKey(data, "right")) {
			if (this.file) this.focus = "diff";
		}
	}

	private diffInput(data: string, lay: Layout): void {
		const half = Math.max(1, Math.floor(lay.contentH / 2));
		if (matchesKey(data, "j") || matchesKey(data, "down")) this.scroll(1);
		else if (matchesKey(data, "k") || matchesKey(data, "up")) this.scroll(-1);
		else if (matchesKey(data, "ctrl+d")) this.scroll(half);
		else if (matchesKey(data, "ctrl+u")) this.scroll(-half);
		else if (matchesKey(data, "pageDown") || matchesKey(data, "space")) this.scroll(lay.contentH - 1);
		else if (matchesKey(data, "pageUp")) this.scroll(-(lay.contentH - 1));
		else if (matchesKey(data, "g") || matchesKey(data, "home")) this.goTo(0);
		else if (matchesKey(data, "shift+g") || matchesKey(data, "end")) this.goTo(this.maxTop());
		else if (matchesKey(data, "h") || matchesKey(data, "left")) this.focus = "list";
	}

	private goTo(top: number): void {
		const before = this.top;
		this.top = top;
		this.followScroll(before);
	}

	private menuInput(data: string): void {
		const m = this.menu!;
		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "a")) this.menu = undefined;
		else if (matchesKey(data, "j") || matchesKey(data, "down")) m.sel = Math.min(m.items.length - 1, m.sel + 1);
		else if (matchesKey(data, "k") || matchesKey(data, "up")) m.sel = Math.max(0, m.sel - 1);
		else if (matchesKey(data, "enter")) {
			this.menu = undefined;
			this.runAction(m.items[m.sel]!);
		}
	}

	// ---- mouse -----------------------------------------------------------------------------------

	handleMouse(e: TuiMouseEvent): TuiMouseEventResult | undefined {
		const lay = this.lay;
		if (!lay) return { handled: true };
		if (this.menu) {
			if (e.type === "click" && e.button === "left") this.menuClick(e);
			return { handled: true };
		}
		const inList = lay.two ? e.x < lay.listW : this.focus === "list";
		if (e.type === "wheel") {
			const dir = Math.sign(e.wheelDelta ?? 0);
			if (inList) this.listTop = Math.max(0, Math.min(Math.max(0, this.files.length - lay.contentH), this.listTop + dir * WHEEL_LINES));
			else this.scroll(dir * WHEEL_LINES);
			return { handled: true };
		}
		if (e.type !== "click" || e.button !== "left") return { handled: true };
		if (e.y === 0) {
			const tab = this.tabs.find((t) => e.x >= t.x0 && e.x < t.x1);
			if (tab && tab.source !== "external") this.switchSource(tab.source);
		} else if (e.y >= 1 && e.y <= lay.contentH) {
			if (inList) {
				const i = this.listTop + (e.y - 1);
				if (i < this.files.length) {
					this.select(i);
					this.focus = lay.two ? "list" : "diff";
				}
			} else if (lay.two ? e.x > lay.listW : true) {
				this.focus = "diff";
			}
		}
		return { handled: true };
	}

	private menuClick(e: TuiMouseEvent): void {
		const r = this.menuRect;
		const m = this.menu;
		if (!r || !m) return;
		if (e.y >= r.y + 1 && e.y < r.y + r.h && e.x >= r.x && e.x < r.x + r.w) {
			const item = m.items[r.top + e.y - r.y - 1];
			if (item) {
				this.menu = undefined;
				this.runAction(item);
			}
		} else this.menu = undefined;
	}

	// ---- drawing ---------------------------------------------------------------------------------

	render(width: number): string[] {
		const h = Math.max(4, this.d.tui.terminal.rows);
		const w = Math.max(1, width);
		const lay = layoutFor(w, h);
		this.lay = lay;
		const pal = paletteFor(this.d.theme);
		this.top = Math.min(this.top, this.maxTop());
		this.keepSelectionVisible();

		const rows: string[] = [this.header(w, pal)];
		const loaded = this.loaded;
		const note = this.stateNote(loaded);
		if (note) {
			for (let i = 0; i < lay.contentH; i++) rows.push(this.noteRow(i, note, w, pal));
		} else {
			for (let i = 0; i < lay.contentH; i++) rows.push(this.contentRow(i, lay, pal));
		}
		rows.push(this.footer(w, pal));
		if (this.menu) this.drawMenu(rows, w, pal);
		return rows.map((r) => exact(r, w));
	}

	private stateNote(l: Loaded | undefined): { text: string; error?: boolean } | undefined {
		if (!l) return { text: this.loading ? "Loading…" : "" };
		if (l.error) return { text: l.error, error: true };
		if (l.files.length === 0) return { text: l.note ?? "No changes." };
		return undefined;
	}

	private noteRow(i: number, note: { text: string; error?: boolean }, w: number, pal: Palette): string {
		if (i !== 1) return `${pal.panel}${" ".repeat(w)}${pal.reset}`;
		return `${pal.panel}${note.error ? pal.delFg : pal.muted}${cell(` ${clean(note.text)}`, w)}${pal.reset}`;
	}

	private header(w: number, pal: Palette): string {
		const files = this.files;
		const added = files.reduce((a, f) => a + f.added, 0);
		const removed = files.reduce((a, f) => a + f.removed, 0);
		this.tabs = [];
		const mark = icon("diff");
		let left = `${pal.panel} ${mark ? `${pal.accent}${mark}${pal.text}  ` : `${pal.text}`}Diff   `;
		let x = visibleWidth(` ${mark ? `${mark}  ` : ""}Diff   `);
		if (this.d.external) {
			left += `${pal.muted}${clean(this.d.external.title)}`;
		} else {
			for (const [source, label] of [["changes", "Changes"], ["branch", "Branch"]] as const) {
				const base = source === "branch" ? this.data.branch?.base : undefined;
				const text = ` ${label}${base ? ` vs ${clean(base)}` : ""} `;
				const active = source === this.source;
				this.tabs.push({ source, x0: x, x1: x + visibleWidth(text) });
				left += active ? `${pal.selected}${pal.text}${text}${pal.reset}${pal.panel}` : `${pal.muted}${text}`;
				x += visibleWidth(text);
				left += " ";
				x += 1;
			}
		}
		const meta = this.loaded?.meta ? `${clean(this.loaded.meta)}   ` : "";
		const count = this.loaded && !this.loaded.error ? `${files.length} file${files.length === 1 ? "" : "s"}` : "";
		const stats = `${added ? `${pal.addFg}+${added}` : ""}${added && removed ? " " : ""}${removed ? `${pal.delFg}-${removed}` : ""}`;
		const right = `${pal.dim}${meta}${count}${stats ? "  " : ""}${stats} ${this.loading ? `${pal.dim}…` : ""}`;
		const gap = Math.max(1, w - visibleWidth(left) - visibleWidth(right));
		return `${left}${pal.panel}${" ".repeat(gap)}${right}${pal.reset}`;
	}

	private contentRow(i: number, lay: Layout, pal: Palette): string {
		const files = this.files;
		const sel = this.sel[this.source];
		const listRow = (): string => {
			const idx = this.listTop + i;
			const f = files[idx];
			if (!f) return `${pal.panel}${" ".repeat(lay.listW)}${pal.reset}`;
			return renderFileRow(f, lay.listW, pal, idx === sel, this.focus === "list");
		};
		const diffRow = (width: number): string => {
			const body = this.body;
			const row = body?.rows[this.top + i];
			if (!body || !row) return `${pal.panel}${" ".repeat(width)}${pal.reset}`;
			const r = this.top + i;
			const mark = row.kind === "hunk" && body.hunkStarts.length > 1 ? (r === body.hunkStarts[this.cursor] ? "current" : "other") : undefined;
			return renderBodyRow(row, width, pal, body.numWidth, this.shift, mark);
		};
		if (lay.two) return `${listRow()}${pal.panel}${pal.dim}│${pal.reset}${diffRow(lay.diffW)}`;
		return this.focus === "list" ? listRow() : diffRow(lay.w);
	}

	private footer(w: number, pal: Palette): string {
		if (this.flash) return `${pal.panel}${pal.warn}${cell(` ${this.flash}`, w)}${pal.reset}`;
		const hints: [string, string][] = [["j/k", "move"], ["]/[", "hunk"], ["tab", "source"], ["a", "actions"], ["r", "reload"], ["esc", "close"]];
		if (this.d.external) hints.splice(2, 1);
		if (!this.d.actions().length) hints.splice(hints.findIndex((x) => x[0] === "a"), 1);
		const body = this.body;
		const f = this.file;
		let pos = "";
		if (f && body) {
			const n = body.hunkStarts.length;
			const at = n ? Math.min(this.cursor, n - 1) + 1 : 0;
			pos = `${n ? `hunk ${at}/${n}  ` : ""}${body.rows.length > 1 ? `${Math.round(((this.top + (this.lay?.contentH ?? 1)) / Math.max(1, body.rows.length)) * 100)}%` : ""}`;
			pos = pos.replace(/(\d+)%/, (_m, p: string) => `${Math.min(100, Number(p))}%`);
		}
		const right = pos ? `${pal.dim}${pos} ` : "";
		const room = w - visibleWidth(right) - 1;
		let left = "";
		for (let k = hints.length; k > 0; k--) {
			const text = hints.slice(0, k).map(([key, label]) => `${pal.muted}${key} ${pal.dim}${label}`).join("  ");
			if (visibleWidth(text) <= room) {
				left = text;
				break;
			}
		}
		const gap = Math.max(1, w - 1 - visibleWidth(left) - visibleWidth(right));
		return `${pal.panel} ${left}${pal.panel}${" ".repeat(gap)}${right}${pal.reset}`;
	}

	/**
	 * The action menu, drawn over the middle rows of the panel. It keeps to the rows between the
	 * header and the footer: on a short screen only as many items as fit are shown, scrolled so the
	 * selected one is always among them.
	 */
	private drawMenu(rows: string[], w: number, pal: Palette): void {
		const m = this.menu!;
		const boxW = w >= 8 ? Math.min(w - 4, 50) : w;
		const x = Math.floor((w - boxW) / 2);
		const room = Math.max(1, rows.length - 2); // rows 1 to length - 2
		const visible = Math.max(0, Math.min(m.items.length, room - 1));
		m.top = Math.max(0, Math.min(m.top, m.sel), m.sel - visible + 1);
		m.top = Math.min(m.top, Math.max(0, m.items.length - visible));
		const h = Math.min(room, visible + 1);
		const y = Math.max(1, Math.floor((rows.length - h) / 2));
		this.menuRect = { y, x, w: boxW, h, top: m.top };
		const inner = Math.max(0, boxW - 2);
		const line = (text: string, on: boolean) => {
			const bg = on ? pal.selected : pal.element;
			const body = inner > 0 ? ` ${on ? pal.text : pal.muted}${cell(text, inner)} ` : cell(text, boxW);
			return `${pal.panel}${" ".repeat(x)}${bg}${inner > 0 ? "" : on ? pal.text : pal.muted}${body}${pal.reset}${pal.panel}${" ".repeat(Math.max(0, w - x - boxW))}${pal.reset}`;
		};
		rows[y] = line("Actions", false).replace(pal.muted, pal.accent);
		for (let i = 0; i < h - 1; i++) {
			const item = m.items[m.top + i]!;
			rows[y + 1 + i] = line(clean(item.label), m.top + i === m.sel);
		}
	}
}
