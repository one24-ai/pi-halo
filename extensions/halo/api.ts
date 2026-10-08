/**
 * Widget registry: the one place info and status widgets are declared.
 *
 * A widget is a small object with an id and a render function. The TUI decides where it shows up
 * (sidebar section, footer segment, or both) from its `slots`, orders it by `order`, and refreshes
 * it on `refreshMs` or when the widget calls `handle.refresh()`.
 *
 *     import { registerWidget } from "../halo/api.ts";
 *
 *     registerWidget(pi, {
 *       id: "deploy",
 *       title: "Deploy",
 *       slots: ["footer", "sidebar"],
 *       order: 10,
 *       refreshMs: 30_000,
 *       render: () => ({ icon: "\uF0E7", text: "staging·v42", color: "brand" }),
 *       detail: () => ["Last deploy 12m ago"],
 *     });
 *
 * The registry lives on globalThis because pi loads every extension file in its own module scope
 * (jiti, moduleCache off), so a plain module-level Map would give each extension its own copy.
 * Widgets registered before halo loads are kept and shown once it starts.
 *
 * Plain `ctx.ui.setStatus()` from other extensions still works: the TUI shows those statuses as
 * footer segments too, unless a registered widget claims the same key (`statusKey`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { IconLike } from "./icons.ts";
import { scrubText } from "./sanitize.ts";

/** A render or detail call slower than this counts as a strike against the widget. */
export const SLOW_RENDER_MS = 50;
/** This many slow calls in a row suspend the widget until `/widgets enable ID`. */
export const SLOW_RENDER_STRIKES = 3;

/** An `update` that has not settled after this long is abandoned and reported as an error. */
export const DEFAULT_UPDATE_TIMEOUT_MS = 10_000;

/** Where a widget can appear. */
export type WidgetSlot = "sidebar" | "footer";

/**
 * Colours a widget can ask for: theme tokens, the brand colours (`brand`, `brandDark`, `plan`; see
 * brand.ts), or any `#RRGGBB` value.
 */
export type WidgetColor =
	| "text"
	| "muted"
	| "dim"
	| "accent"
	| "success"
	| "warning"
	| "error"
	| "brand"
	| "brandDark"
	| "plan"
	| `#${string}`;

/** Status level: drives the dot colour in the sidebar heading when no colour is given. */
export type WidgetLevel = "ok" | "warn" | "error" | "off" | "info";

/** What a widget renders: one short line for the footer and the sidebar heading row. */
export interface WidgetView {
	/** Optional leading glyph. A string is used as given with a Nerd Font and dropped (private-use characters removed) without one; `{ nerd, plain }` gives one for each set. */
	icon?: IconLike;
	/**
	 * Short status text, e.g. "staging·v42". Plain text: the TUI applies the colour. May be omitted by
	 * a `sidebar: "section"` widget that only has detail lines.
	 */
	text?: string;
	/**
	 * Footer-only label shown between icon and text (e.g. "Deploy" gives "<icon> Deploy staging·v42").
	 * The sidebar shows the widget title in its own column instead.
	 */
	label?: string;
	/**
	 * Sidebar row only: already-styled text drawn after `text`, separated by a space, in its own
	 * colours (e.g. a role name coloured by what it allows). Not shown in the footer.
	 */
	tag?: string;
	/** Colour for icon and text. Defaults from `level`, else "text". */
	color?: WidgetColor;
	/** Status level, used for colour defaults and the sidebar dot. */
	level?: WidgetLevel;
}

/** Something the user can run from the command palette (ctrl+p), shown as "<title>: <label>". */
export interface WidgetAction {
	/** Unique within the widget. */
	id: string;
	label: string;
	description?: string;
	/** A thrown error or rejection is shown as a notification and recorded on the widget. */
	run: (ctx: ExtensionContext) => void | Promise<void>;
}

export interface WidgetRenderContext {
	theme: Theme;
	/** The latest session context, if a session is running. */
	ctx: ExtensionContext | undefined;
	/** Width available to this widget's line(s), in terminal columns. */
	width: number;
}

export interface WidgetSpec {
	/** Unique id; registering the same id again replaces the widget. */
	id: string;
	/** Sidebar section heading. Defaults to the id. */
	title?: string;
	/**
	 * Glyph in front of the widget in the sidebar: before a `sidebar: "section"` heading, or, for a
	 * row, as its marker in place of the bullet (and of the level marker). A row then leaves
	 * `view.icon` out of the value; the footer still draws it. A string is used as given with a Nerd
	 * Font and dropped without one; `{ nerd, plain }` gives one for each icon set. With no icon in
	 * the current set, a row shows its level marker or the bullet and a section shows no glyph.
	 */
	icon?: IconLike;
	/** Where it shows. Default ["footer", "sidebar"]. */
	slots?: WidgetSlot[];
	/** Lower comes first. Default 100. Built-ins: container 0, aws 20, mcp 30, subagents 35, todo 40 and session-todos 50. */
	order?: number;
	/** Re-render interval while a session runs. Omit for event-driven widgets. */
	refreshMs?: number;
	/** Give up on a slow `update` after this many ms (default 10000). The widget shows the error. */
	updateTimeoutMs?: number;
	/**
	 * Called on each refresh tick (and on `handle.refresh()`), before rendering. Use it to poll
	 * slow sources; rendering itself should be cheap and synchronous.
	 */
	update?: (ctx: ExtensionContext) => void | Promise<void>;
	/**
	 * Opt in to caching: `render` and `detail` then run again only when this string, the registry
	 * version (any widget update or refresh), the width, the theme or the context changes. Use it
	 * for widgets that read session state (return something that changes with it) and are costly
	 * to compute. Do not use it when the output depends on the clock.
	 */
	cacheKey?: (rc: WidgetRenderContext) => string;
	/** Return the one-line view, or undefined to hide the widget. */
	render: (rc: WidgetRenderContext) => WidgetView | undefined;
	/** Extra sidebar lines under the heading (plain or themed strings). */
	detail?: (rc: WidgetRenderContext) => string[] | undefined;
	/**
	 * Called when the user clicks a line returned by `detail`, with that line's index. Only the
	 * lines `detail` returned are clickable, not the heading or an error line. A thrown error or
	 * rejection is shown as a notification.
	 */
	onDetailClick?: (index: number, ctx: ExtensionContext) => void | Promise<void>;
	/** Palette actions, listed while the widget is enabled and not suspended. */
	actions?: WidgetAction[];
	/** A setStatus() key this widget replaces, so the raw status isn't shown twice. Default: the id. */
	statusKey?: string;
	/** More setStatus() keys this widget replaces, for a widget that covers several raw statuses. */
	statusKeys?: string[];
	/**
	 * Sidebar layout. "row" (default): one "• Title  value" line in the status list, detail lines
	 * indented under it. "section": its own sidebar section, with a bold title, the value beside
	 * it, and the detail lines as the section body (plain or themed strings, shown as given).
	 */
	sidebar?: "row" | "section";
}

export interface WidgetHandle {
	/** Run `update` (if any) and re-render now. */
	refresh(): void;
	/** Remove the widget. */
	dispose(): void;
}

/** The last failure of a widget, kept for the sidebar and `/widgets`. */
export interface WidgetError {
	phase: "update" | "render" | "detail" | "action";
	message: string;
	at: number;
}

interface RegistryEntry {
	spec: WidgetSpec;
	timer?: ReturnType<typeof setInterval>;
	/** Unsubscribe functions for the pi.on handlers this widget added. */
	offs: Array<() => void>;
	/** An `update` is running; ticks are skipped until it settles or times out. */
	inflight?: boolean;
	lastUpdateAt?: number;
	lastDurationMs?: number;
	error?: WidgetError;
	/** Cached output for widgets with `cacheKey`. */
	cache?: { key: string; theme: unknown; ctx: unknown; width: number; version: number; view?: { value: WidgetView | undefined }; lines?: { value: string[] } };
	/** Consecutive slow render/detail calls. */
	strikes: number;
	/** Set after too many slow calls; cleared by `/widgets enable`. */
	suspended?: boolean;
	lastRenderMs?: number;
}

/** The result of a tool call as a tool row spec sees it. Anything in it can be influenced from outside. */
export interface ToolRowResult {
	content?: Array<{ type: string; text?: string }>;
	details?: any;
}

/**
 * How halo draws the rows of a tool that belongs to another extension: one line per call
 * ("<icon> <title> <describe>" on the left, `summarize` on the right) and, when the row is opened
 * with ctrl+o, the lines `expand` returns.
 *
 * `args` and `result` come from the model and the tool, so treat them as untrusted and possibly
 * partial: a call is drawn while its arguments are still streaming. Every string a spec returns is
 * cleaned before it is drawn (escape sequences, control characters and bidi controls removed, line
 * breaks turned into spaces; SGR colour from `theme` is kept), and a spec that throws makes halo
 * draw that call with the tool's own renderer instead.
 */
export interface ToolRowSpec {
	/** Glyph in front of the row. A string is used as given with a Nerd Font and dropped without one; `{ nerd, plain }` gives one for each icon set. Omit for no glyph. */
	icon?: IconLike;
	/** Short verb or noun before the description, drawn in the text colour. May be empty. */
	title: string;
	/** What the call is about, from its arguments: a path, a query, an id. One line. */
	describe: (args: any, cwd: string, theme: Theme) => string;
	/** The right-aligned outcome of a finished call, for example "3 matches". `isError` is whether the tool reported an error. One line. */
	summarize: (result: ToolRowResult, args: any, theme: Theme, isError: boolean) => string;
	/** Body lines shown when the row is opened (ctrl+o or a click). More than 120 lines are cut. */
	expand?: (result: ToolRowResult, args: any, theme: Theme) => string[];
}

/** Tool row specs by tool name. */
export type ToolRowSpecs = Record<string, ToolRowSpec>;

/** Shared state between halo and widget extensions. */
export interface Registry {
	widgets: Map<string, RegistryEntry>;
	/** Set by halo while a session runs. */
	ctx: ExtensionContext | undefined;
	/** Set by halo: asks the TUI to repaint. */
	requestRender: () => void;
	/** Subscribers to registry changes (halo's renderers). */
	listeners: Set<() => void>;
	/** Bumped on every change, so renderers can cache. */
	version: number;
	/** Widget ids the user switched off (persisted, see `/widgets`). */
	disabled: Set<string>;
	/** Set by halo's `installHost()`: the version of this API. Absent when halo isn't loaded. */
	apiVersion?: number;
	/**
	 * Set by `installHost()`: what client.ts calls to register a widget with the host. `ctx` is
	 * optional: a caller inside a `session_start` handler passes the handler's context, so the
	 * widget's first `update` and its timer start even if halo's own handler has not run yet.
	 */
	register?: (pi: ExtensionAPI, spec: WidgetSpec, ctx?: ExtensionContext) => WidgetHandle;
	/** Set by `installHost()`: the version of the tool row API. Absent when the host predates it, so a client can feature-detect. */
	toolRowsVersion?: number;
	/** Set by `installHost()`: registers tool row specs and returns a function that removes them. */
	registerToolRows?: (specs: ToolRowSpecs) => () => void;
	/** Registered tool row groups, oldest first. Read through `toolRowFor`. */
	toolRows: Array<Map<string, ToolRowSpec>>;
}

/** Bumped on a breaking change to the registry or WidgetSpec; client.ts checks it. */
export const API_VERSION = 1;

/** Version of the tool row API (`registerToolRows`). Bumped on a breaking change to it or to ToolRowSpec. */
export const TOOL_ROWS_VERSION = 1;

/** A registration made (through client.ts) before halo had loaded. */
export interface PendingRegistration {
	pi: ExtensionAPI;
	spec: WidgetSpec;
	/** Hands the real handle back to the client once the host has registered the widget. */
	attach(handle: WidgetHandle): void;
}

/** Tool rows registered (through client.ts or the raw protocol) before halo had loaded. */
export interface PendingToolRows {
	specs: ToolRowSpecs;
	/** Hands the host's unregister function back to the registrant once the host has taken the rows. */
	attach(unregister: () => void): void;
}

const PENDING = Symbol.for("pi-halo/pending");
const PENDING_TOOL_ROWS = Symbol.for("pi-halo/pendingToolRows");

function pendingList(): PendingRegistration[] {
	const g = globalThis as unknown as Record<symbol, PendingRegistration[] | undefined>;
	g[PENDING] ??= [];
	return g[PENDING]!;
}

function pendingToolRowsList(): PendingToolRows[] {
	const g = globalThis as unknown as Record<symbol, PendingToolRows[] | undefined>;
	g[PENDING_TOOL_ROWS] ??= [];
	return g[PENDING_TOOL_ROWS]!;
}

/** Register everything that client.ts queued before the host loaded. */
export function drainPending(): void {
	const list = pendingList().splice(0);
	for (const item of list) {
		try {
			item.attach(registerWidget(item.pi, item.spec));
		} catch {
			// one bad registration must not stop the others
		}
	}
	for (const item of pendingToolRowsList().splice(0)) {
		try {
			item.attach(registerToolRows(item.specs));
		} catch {
			// one bad registration must not stop the others
		}
	}
}

/**
 * Called once by halo when it loads: announces the host (so client.ts registers straight into
 * the registry) and takes over widgets that were queued before it loaded.
 */
export function installHost(): void {
	const reg = getRegistry();
	reg.apiVersion = API_VERSION;
	reg.register = registerWidget;
	reg.toolRowsVersion = TOOL_ROWS_VERSION;
	reg.registerToolRows = registerToolRows;
	drainPending();
}

/** Where the disabled list is stored. PI_HALO_STATE overrides it (used by tests). */
export function statePath(): string {
	return process.env.PI_HALO_STATE ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "halo.json");
}

function loadDisabled(): Set<string> {
	try {
		const data = JSON.parse(readFileSync(statePath(), "utf8"));
		return new Set(Array.isArray(data?.disabledWidgets) ? data.disabledWidgets.filter((x: unknown) => typeof x === "string") : []);
	} catch {
		return new Set();
	}
}

function saveDisabled(ids: Set<string>): void {
	try {
		const path = statePath();
		let data: Record<string, unknown> = {};
		if (existsSync(path)) {
			try {
				data = JSON.parse(readFileSync(path, "utf8")) ?? {};
			} catch {
				data = {};
			}
		}
		data.disabledWidgets = [...ids].sort();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
	} catch {
		// Persistence is best effort; the in-memory list still applies for this run.
	}
}

const KEY = Symbol.for("pi-halo/registry");

export function getRegistry(): Registry {
	const g = globalThis as unknown as Record<symbol, Registry | undefined>;
	g[KEY] ??= {
		widgets: new Map(),
		ctx: undefined,
		requestRender: () => {},
		listeners: new Set(),
		version: 0,
		disabled: loadDisabled(),
		toolRows: [],
	};
	// A registry created by an older halo in the same process lacks newer fields.
	g[KEY]!.disabled ??= loadDisabled();
	g[KEY]!.toolRows ??= [];
	return g[KEY]!;
}

/**
 * Register halo-styled rows for tools that belong to another extension, by tool name. Returns a
 * function that removes them (calling it twice is harmless).
 *
 * The rows are looked up when a call is drawn, so it does not matter whether the extension that
 * owns the tool, the one registering the rows or halo loads first. A call already on screen keeps
 * the renderer it was created with.
 *
 * halo's own rows for pi's built-in tools (read, write, edit, bash, grep, find, ls) always win: a
 * spec registered under one of those names is never used. For any other name the most recently
 * registered spec wins, and removing it brings back the one before it. Entries that are not specs
 * are ignored.
 */
export function registerToolRows(specs: ToolRowSpecs): () => void {
	const reg = getRegistry();
	const group = new Map<string, ToolRowSpec>();
	for (const [name, spec] of Object.entries(specs ?? {})) {
		if (name && spec && typeof spec === "object") group.set(name, spec);
	}
	reg.toolRows.push(group);
	reg.requestRender();
	return () => {
		const i = reg.toolRows.indexOf(group);
		if (i < 0) return;
		reg.toolRows.splice(i, 1);
		reg.requestRender();
	};
}

/** The registered row spec for a tool, newest registration first, or undefined. */
export function toolRowFor(toolName: string): ToolRowSpec | undefined {
	const groups = getRegistry().toolRows;
	for (let i = groups.length - 1; i >= 0; i--) {
		const spec = groups[i]!.get(toolName);
		if (spec) return spec;
	}
	return undefined;
}

/** Make every widget render again (an icon set change, say), dropping cached output. */
export function invalidateWidgets(): void {
	changed(getRegistry());
}

function changed(reg: Registry): void {
	reg.version++;
	for (const l of reg.listeners) l();
	reg.requestRender();
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200) || "unknown error";

function runUpdate(reg: Registry, entry: RegistryEntry): void {
	const { spec } = entry;
	const ctx = reg.ctx;
	if (reg.disabled.has(spec.id)) return;
	if (!spec.update || !ctx) {
		changed(reg);
		return;
	}
	// One update at a time: a slow source must not pile up overlapping runs.
	if (entry.inflight) return;
	entry.inflight = true;
	const started = Date.now();
	const timeoutMs = spec.updateTimeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS;
	let settled = false;
	const finish = (err?: unknown): void => {
		if (settled) return; // a late result after the timeout is ignored
		settled = true;
		clearTimeout(timer);
		entry.inflight = false;
		entry.lastDurationMs = Date.now() - started;
		entry.lastUpdateAt = Date.now();
		if (err !== undefined) entry.error = { phase: "update", message: messageOf(err), at: Date.now() };
		else if (entry.error?.phase === "update") entry.error = undefined;
		changed(reg);
	};
	const timer = setTimeout(() => finish(new Error(`update timed out after ${timeoutMs}ms`)), timeoutMs);
	timer.unref?.();
	try {
		const r = spec.update(ctx);
		if (r && typeof (r as Promise<void>).then === "function") {
			(r as Promise<void>).then(
				() => finish(),
				(e) => finish(e ?? new Error("update rejected")),
			);
		} else {
			finish();
		}
	} catch (e) {
		finish(e ?? new Error("update threw"));
	}
}

function startTimer(reg: Registry, entry: RegistryEntry): void {
	if (entry.timer || !entry.spec.refreshMs || !reg.ctx || reg.disabled.has(entry.spec.id)) return;
	entry.timer = setInterval(() => runUpdate(reg, entry), entry.spec.refreshMs);
	entry.timer.unref?.();
}

/** Remove the pi.on handlers a widget added, so re-registering or disposing doesn't leak them. */
function unlisten(entry: RegistryEntry): void {
	for (const off of entry.offs.splice(0)) {
		try {
			off();
		} catch {
			// the pi instance may already be gone
		}
	}
}

function stopTimer(entry: RegistryEntry): void {
	if (entry.timer) clearInterval(entry.timer);
	entry.timer = undefined;
}

/**
 * Register (or replace) a widget. Returns a handle for on-demand refresh and removal.
 *
 * Pass `pi` so the widget's timers follow the session lifecycle: they start on session_start and
 * stop on session_shutdown. The widget itself stays registered across /reload of halo.
 *
 * Registering from inside a `session_start` handler (as a package that does not import halo does)
 * misses that session's own `session_start` event for the widget, so pass the handler's `ctx`.
 */
export function registerWidget(pi: ExtensionAPI, spec: WidgetSpec, ctx?: ExtensionContext): WidgetHandle {
	const reg = getRegistry();
	if (ctx) reg.ctx ??= ctx;
	const old = reg.widgets.get(spec.id);
	if (old) {
		stopTimer(old);
		unlisten(old);
	}
	const entry: RegistryEntry = { spec, strikes: 0, offs: [] };
	reg.widgets.set(spec.id, entry);

	const listen = (off: unknown): void => {
		if (typeof off === "function") entry.offs.push(off as () => void);
	};
	listen(pi.on("session_start", async (_e, ctx) => {
		if (reg.widgets.get(spec.id) !== entry) return;
		// halo may not have set reg.ctx yet (load order), so use this ctx for the first update.
		reg.ctx ??= ctx;
		startTimer(reg, entry);
		runUpdate(reg, entry);
	}));
	listen(pi.on("session_shutdown", async () => {
		stopTimer(entry);
	}));

	if (reg.ctx) {
		startTimer(reg, entry);
		runUpdate(reg, entry);
	} else {
		changed(reg);
	}

	return {
		refresh: () => {
			if (reg.widgets.get(spec.id) === entry) runUpdate(reg, entry);
		},
		dispose: () => {
			stopTimer(entry);
			unlisten(entry);
			if (reg.widgets.get(spec.id) === entry) reg.widgets.delete(spec.id);
			changed(reg);
		},
	};
}

/** Widgets for a slot, sorted by order then id. */
export function widgetsFor(slot: WidgetSlot): WidgetSpec[] {
	return [...getRegistry().widgets.values()]
		.map((e) => e.spec)
		.filter((s) => !getRegistry().disabled.has(s.id))
		.filter((s) => (s.slots ?? ["footer", "sidebar"]).includes(slot))
		.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id));
}

/** setStatus() keys claimed by registered widgets. */
export function claimedStatusKeys(): Set<string> {
	const keys = new Set<string>();
	for (const { spec } of getRegistry().widgets.values()) {
		keys.add(spec.statusKey ?? spec.id);
		for (const k of spec.statusKeys ?? []) keys.add(k);
	}
	return keys;
}

function record(id: string, phase: WidgetError["phase"], err: unknown): void {
	const entry = getRegistry().widgets.get(id);
	if (entry) entry.error = { phase, message: messageOf(err), at: Date.now() };
}

const nowMs = (): number => performance.now();

/** The cache slot for this call, or undefined when the widget doesn't cache or something changed. */
function cacheFor(entry: RegistryEntry, rc: WidgetRenderContext): NonNullable<RegistryEntry["cache"]> | undefined {
	if (!entry.spec.cacheKey) return undefined;
	let key: string;
	try {
		key = entry.spec.cacheKey(rc);
	} catch {
		return undefined; // a broken key just disables caching for this call
	}
	const version = getRegistry().version;
	const c = entry.cache;
	if (c && c.key === key && c.theme === rc.theme && c.ctx === rc.ctx && c.width === rc.width && c.version === version) return c;
	entry.cache = { key, theme: rc.theme, ctx: rc.ctx, width: rc.width, version };
	return entry.cache;
}

/** Time a real (uncached) call. Too many slow ones in a row suspend the widget. */
function timed<T>(entry: RegistryEntry, fn: () => T): T {
	const t0 = nowMs();
	try {
		return fn();
	} finally {
		const ms = nowMs() - t0;
		entry.lastRenderMs = ms;
		if (ms > SLOW_RENDER_MS) {
			if (++entry.strikes >= SLOW_RENDER_STRIKES && !entry.suspended) {
				entry.suspended = true;
				entry.error = { phase: "render", message: `suspended: ${SLOW_RENDER_STRIKES} slow renders (last ${Math.round(ms)}ms)`, at: Date.now() };
			}
		} else {
			entry.strikes = 0;
		}
	}
}

const SUSPENDED_VIEW: WidgetView = { text: "suspended", level: "warn" };

/**
 * A widget's text is untrusted: it may carry a file name, a branch, a server's reply. Escape
 * sequences (titles, links, clipboard writes, cursor moves), control characters and bidi controls
 * are removed and line breaks become spaces, so one value stays on one line and cannot reach the
 * terminal. SGR colour is kept for widgets that colour their own text; spacing is left as given.
 */
const cleanText = (value: unknown): string | undefined => (value === undefined || value === null ? undefined : scrubText(value, true));

function cleanIcon(icon: IconLike | undefined): IconLike | undefined {
	if (typeof icon === "string") return scrubText(icon);
	if (icon && typeof icon === "object") return icon.plain === undefined ? { nerd: scrubText(icon.nerd) } : { nerd: scrubText(icon.nerd), plain: scrubText(icon.plain) };
	return icon;
}

/** A view with every text field cleaned (see `cleanText`). The colour and level are the widget's own. */
function cleanView(view: WidgetView | undefined): WidgetView | undefined {
	if (!view || typeof view !== "object") return undefined;
	const out: WidgetView = { ...view };
	if (view.icon !== undefined) out.icon = cleanIcon(view.icon);
	for (const key of ["text", "label", "tag"] as const) {
		if (view[key] !== undefined) out[key] = cleanText(view[key]);
	}
	return out;
}

/** Detail lines cleaned the same way; anything that is not an array of lines yields none. */
const cleanLines = (lines: unknown): string[] => (Array.isArray(lines) ? lines.map((l) => cleanText(l) ?? "") : []);

/**
 * Render a widget without letting it throw: a failure is recorded on the widget and returned as
 * an "error" view. Returns undefined when the widget itself returns undefined (hidden).
 * Widgets with `cacheKey` are only re-rendered when the key, width, theme, context or registry
 * version changes; a widget that renders slowly several times in a row is suspended.
 */
export function renderWidget(spec: WidgetSpec, rc: WidgetRenderContext): WidgetView | undefined {
	const entry = getRegistry().widgets.get(spec.id);
	if (entry?.suspended) return SUSPENDED_VIEW;
	const cache = entry ? cacheFor(entry, rc) : undefined;
	if (cache?.view) return cache.view.value;
	try {
		const view = cleanView(entry ? timed(entry, () => spec.render(rc)) : spec.render(rc));
		if (entry?.error?.phase === "render" && !entry.suspended) entry.error = undefined;
		if (cache && !entry?.suspended) cache.view = { value: view };
		return entry?.suspended ? SUSPENDED_VIEW : view;
	} catch (e) {
		record(spec.id, "render", e);
		return { text: "error", level: "error" };
	}
}

/** Detail lines of a widget; a failure is recorded and yields no lines. Cached like `renderWidget`. */
export function detailWidget(spec: WidgetSpec, rc: WidgetRenderContext): string[] {
	const entry = getRegistry().widgets.get(spec.id);
	if (entry?.suspended) return [];
	const cache = entry ? cacheFor(entry, rc) : undefined;
	if (cache?.lines) return cache.lines.value;
	try {
		const lines = cleanLines((entry ? timed(entry, () => spec.detail?.(rc)) : spec.detail?.(rc)) ?? []);
		if (entry?.error?.phase === "detail") entry.error = undefined;
		if (cache && !entry?.suspended) cache.lines = { value: lines };
		return entry?.suspended ? [] : lines;
	} catch (e) {
		record(spec.id, "detail", e);
		return [];
	}
}

/** The last recorded failure of a widget, if any. */
export function widgetError(id: string): WidgetError | undefined {
	return getRegistry().widgets.get(id)?.error;
}

/** Turn a widget off or on. The choice is saved and survives restarts. */
export function setWidgetDisabled(id: string, disabled: boolean): boolean {
	const reg = getRegistry();
	const entry = reg.widgets.get(id);
	if (!entry) return false;
	if (disabled) {
		reg.disabled.add(id);
		stopTimer(entry);
	} else {
		reg.disabled.delete(id);
		if (entry.suspended) entry.error = undefined;
		entry.suspended = false;
		entry.strikes = 0;
		entry.cache = undefined;
		startTimer(reg, entry);
		runUpdate(reg, entry);
	}
	saveDisabled(reg.disabled);
	changed(reg);
	return true;
}

/** Run a widget's update now, even outside its timer. */
export function refreshWidget(id: string): boolean {
	const reg = getRegistry();
	const entry = reg.widgets.get(id);
	if (!entry) return false;
	runUpdate(reg, entry);
	return true;
}

export interface WidgetInfo {
	id: string;
	title: string;
	slots: WidgetSlot[];
	disabled: boolean;
	refreshMs?: number;
	lastUpdateAt?: number;
	lastDurationMs?: number;
	inflight: boolean;
	suspended: boolean;
	lastRenderMs?: number;
	error?: WidgetError;
}

/** Snapshot of every registered widget, for `/widgets`. */
export function widgetInfo(): WidgetInfo[] {
	const reg = getRegistry();
	return [...reg.widgets.values()]
		.map((e) => ({
			id: e.spec.id,
			title: e.spec.title ?? e.spec.id,
			slots: e.spec.slots ?? (["footer", "sidebar"] as WidgetSlot[]),
			disabled: reg.disabled.has(e.spec.id),
			refreshMs: e.spec.refreshMs,
			lastUpdateAt: e.lastUpdateAt,
			lastDurationMs: e.lastDurationMs,
			inflight: !!e.inflight,
			suspended: !!e.suspended,
			lastRenderMs: e.lastRenderMs,
			error: e.error,
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
}

/** Plain-text table for `/widgets list`. */
export function formatWidgetList(list: WidgetInfo[], now = Date.now()): string {
	if (!list.length) return "No widgets registered.";
	const ago = (t?: number): string => (t === undefined ? "never" : `${Math.max(0, Math.round((now - t) / 1000))}s ago`);
	return list
		.map((w) => {
			const state = w.disabled ? "disabled" : w.suspended ? "suspended" : w.error ? "error" : w.inflight ? "updating" : "ok";
			const parts = [`${w.id} [${state}]`, w.slots.join("+") || "command", `updated ${ago(w.lastUpdateAt)}`];
			if (w.lastDurationMs !== undefined) parts.push(`${w.lastDurationMs}ms`);
			if (w.error) parts.push(`${w.error.phase}: ${w.error.message}`);
			return parts.join(" · ");
		})
		.join("\n");
}

export interface WidgetActionInfo {
	widgetId: string;
	widgetTitle: string;
	id: string;
	label: string;
	description?: string;
}

/** Palette actions of every enabled, non-suspended widget, in widget order. */
export function widgetActions(): WidgetActionInfo[] {
	const reg = getRegistry();
	const out: WidgetActionInfo[] = [];
	for (const spec of widgetsForAny()) {
		const entry = reg.widgets.get(spec.id);
		if (!entry || entry.suspended) continue;
		for (const a of spec.actions ?? []) {
			out.push({ widgetId: spec.id, widgetTitle: spec.title ?? spec.id, id: a.id, label: a.label, description: a.description });
		}
	}
	return out;
}

function widgetsForAny(): WidgetSpec[] {
	const reg = getRegistry();
	return [...reg.widgets.values()]
		.map((e) => e.spec)
		.filter((s) => !reg.disabled.has(s.id))
		.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id));
}

/** Palette value for an action: ids are encoded, so they may contain any character. */
export function widgetActionValue(widgetId: string, actionId: string): string {
	return `widget:${encodeURIComponent(widgetId)}:${encodeURIComponent(actionId)}`;
}

export function parseWidgetActionValue(value: string): { widgetId: string; actionId: string } | undefined {
	const m = value.match(/^widget:([^:]*):([^:]*)$/);
	if (!m) return undefined;
	try {
		return { widgetId: decodeURIComponent(m[1]!), actionId: decodeURIComponent(m[2]!) };
	} catch {
		return undefined;
	}
}

/**
 * Run a widget's `onDetailClick` for the clicked detail line. Resolves to undefined on success, or
 * to a short message when it failed (also recorded on the widget as an "action" error).
 */
export async function runWidgetClick(widgetId: string, index: number, ctx: ExtensionContext): Promise<string | undefined> {
	const reg = getRegistry();
	const entry = reg.widgets.get(widgetId);
	const click = entry && !reg.disabled.has(widgetId) && !entry.suspended ? entry.spec.onDetailClick : undefined;
	if (!entry || !click) return undefined;
	try {
		await click(index, ctx);
		if (entry.error?.phase === "action") entry.error = undefined;
		changed(reg);
		return undefined;
	} catch (e) {
		record(widgetId, "action", e);
		changed(reg);
		return `${entry.spec.title ?? widgetId}: click failed: ${messageOf(e)}`;
	}
}

/**
 * Run a widget action. Resolves to undefined on success, or to a short message when the action
 * is unknown or failed (the failure is also recorded on the widget).
 */
export async function runWidgetAction(widgetId: string, actionId: string, ctx: ExtensionContext): Promise<string | undefined> {
	const reg = getRegistry();
	const entry = reg.widgets.get(widgetId);
	const action = entry && !reg.disabled.has(widgetId) ? entry.spec.actions?.find((a) => a.id === actionId) : undefined;
	if (!entry || !action) return `No action "${actionId}" on widget "${widgetId}".`;
	try {
		await action.run(ctx);
		if (entry.error?.phase === "action") entry.error = undefined;
		changed(reg);
		return undefined;
	} catch (e) {
		record(widgetId, "action", e);
		changed(reg);
		return `${entry.spec.title ?? widgetId}: ${action.label} failed: ${messageOf(e)}`;
	}
}
