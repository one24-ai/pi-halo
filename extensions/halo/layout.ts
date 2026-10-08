/**
 * Sidebar layout.
 *
 * Fullscreen mode: pi renders one layout root (a VStack of transcript + input dock). We wrap it in
 * an HStack with the sidebar as a fixed-width right column, which is what OpenCode looks like.
 * There is no extension API for this: it relies on the TUI's `layoutRoot` field and
 * `setLayoutRoot()` (pi-tui ViewportTUI), verified on pi 1.1.0. If either is missing, or pi
 * swaps the root back (renderer switch), the guard widget re-wraps it or we fall back.
 *
 * Regular mode has no layout root, so the sidebar is a toggleable overlay instead.
 *
 * Home screen: until the session has a message, the same root swaps to OpenCode's home layout
 * (home.ts): logo, centred prompt, tip and a bottom bar, with no transcript or sidebar. The root
 * picks its layout node each frame, so the switch happens on the first message with no remount.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, HStack, type OverlayHandle, type TUI, VStack } from "@earendil-works/pi-tui";
import { HOME_PROMPT_WIDTH, renderHomeFooter, renderLogo, renderTip } from "./home.ts";
import { runWidgetClick } from "./api.ts";
import { renderSidebar, type SidebarHit } from "./sidebar.ts";
import type { UiState } from "./state.ts";

const ORIGINAL = Symbol.for("pi-halo/original-root");

/**
 * The tree to search for pi's own components. Once halo has wrapped the layout root in its
 * sidebar split, `tui.layoutRoot` is a plain object with no children; pi's real root hangs off it
 * under a symbol. Without it, a search for message and tool components finds nothing.
 */
export function piRootOf(tui: unknown): unknown {
	const root = (tui as any)?.layoutRoot ?? tui;
	return root?.[ORIGINAL] ?? root;
}
/** pi-tui's layout-node hook (layout-node.ts); not exported, but a registered symbol. */
const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const GUARD_WIDGET = "halo-layout";
const GUTTER = 2;
/** Blank column used as horizontal padding around the transcript and prompt. */
const gutter: Component = { invalidate() {}, render: () => [] };
/** Blank rows (or columns); the size comes from the stack entry. */
const blank = (): Component => ({ invalidate() {}, render: () => [] });

type LayoutCapable = Component & { [LAYOUT_NODE]?: () => { entries?: readonly { component: Component }[] } };

/** pi's input dock: the second entry of its root VStack (transcript, dock). */
function findDock(root: Component): Component | undefined {
	try {
		const node = (root as LayoutCapable)[LAYOUT_NODE]?.();
		const entries = node?.entries;
		return entries && entries.length === 2 ? entries[1]!.component : undefined;
	} catch {
		return undefined;
	}
}

interface ViewportLike {
	layoutRoot?: Component & { [ORIGINAL]?: Component };
	setLayoutRoot?: (c: Component | undefined) => void;
	terminal: { rows: number; columns: number };
	requestRender(): void;
}

export interface LayoutOptions {
	width: number;
	/** Hide the split sidebar below this terminal width. */
	minTerminalWidth: number;
	piVersion: string;
	/** True while the home screen should show (no message in the session yet). */
	home: () => boolean;
	/** Tip index for this launch. */
	tipIndex: number;
}

export interface LayoutHandle {
	/** True when the sidebar is currently on screen. */
	isShown(): boolean;
	toggle(): void;
	dispose(): void;
}

export function installLayout(ctx: ExtensionContext, state: UiState, opts: LayoutOptions): LayoutHandle {
	let tui: (TUI & ViewportLike) | undefined;
	let theme: Theme | undefined;
	let ourRoot: (Component & { [ORIGINAL]?: Component }) | undefined;
	let overlay: { handle?: OverlayHandle; close: () => void } | undefined;
	let disposed = false;

	const termWidth = () => tui?.terminal.columns ?? process.stdout.columns ?? 120;
	const splitVisible = () => state.sidebarVisible && termWidth() >= opts.minTerminalWidth;

	// The clickable rows of the last render. Only this leaf handles the mouse: the layout root has no
	// handleMouse on purpose (see below), and a move or a click on any other row is left unhandled.
	const hits: SidebarHit[] = [];
	const hitAt = (y: number) => hits.find((h) => h.y === y);
	const sidebar: Component = {
		invalidate() {},
		render(width: number) {
			if (!theme) return [];
			return renderSidebar(state, theme, width, tui?.terminal.rows ?? 40, opts.piVersion, hits);
		},
		handleMouse(e) {
			if (e.button !== "left" || (e.type !== "press" && e.type !== "click")) return undefined;
			const hit = hitAt(e.y);
			if (!hit) return undefined;
			// A press claims the gesture so the click arrives; only the click acts, and neither repaints.
			if (e.type === "click" && state.ctx) {
				const ctx = state.ctx;
				void runWidgetClick(hit.widgetId, hit.index, ctx).then((msg) => {
					if (msg) ctx.ui.notify(msg, "warning");
				});
			}
			return { handled: true, render: false };
		},
	};

	const wrap = () => {
		if (!tui || disposed || typeof tui.setLayoutRoot !== "function") return false;
		const current = tui.layoutRoot;
		if (!current) return false;
		if (current === ourRoot) return true;
		// A root we built earlier (previous session or /reload): unwrap to pi's own root.
		const original = current[ORIGINAL] ?? current;
		// OpenCode pads the session column 2 columns on each side (routes/session/index.tsx).
		const split = new HStack(
			[
				{ component: gutter, basis: GUTTER, grow: 0, shrink: 0 },
				{ component: original, basis: 0, grow: 1, shrink: 1, minSize: 20 },
				{ component: gutter, basis: GUTTER, grow: 0, shrink: 0 },
				{
					component: sidebar,
					basis: opts.width,
					grow: 0,
					shrink: 0,
					visible: (vp) => state.sidebarVisible && vp.width >= opts.minTerminalWidth,
				},
			],
			{ align: "stretch" },
		);
		const home = buildHome(original);
		const pick = (): Component => (home && opts.home() ? home : split);
		// One root for both layouts: pi-tui asks for the layout node every frame.
		// No handleMouse here on purpose: pi-tui routes mouse events to the leaf components through
		// the cached layout frame. A handleMouse on the root makes it dispatch to the stack's
		// Container.handleMouse, which re-renders the whole transcript on every event (fullscreen
		// reports every pointer move), pinning a CPU core and freezing long sessions.
		const root = {
			invalidate() {
				split.invalidate();
				home?.invalidate();
			},
			render: (w: number) => pick().render(w),
			[LAYOUT_NODE]: () => (pick() as LayoutCapable)[LAYOUT_NODE]!(),
		} as unknown as Component & { [ORIGINAL]?: Component };
		root[ORIGINAL] = original;
		ourRoot = root;
		tui.setLayoutRoot(root);
		return true;
	};

	/**
	 * OpenCode's home route, centred vertically: logo, the prompt (pi's whole input dock) centred at
	 * most 75 columns wide (with the brand line under it), a tip 3 rows below it, flexible space, and the bottom bar.
	 */
	const buildHome = (original: Component): Component | undefined => {
		const dock = findDock(original);
		if (!dock) return undefined;
		const logo: Component = { invalidate() {}, render: (w) => (theme ? renderLogo(theme, w) : []) };
		const tip: Component = { invalidate() {}, render: (w) => (theme ? ["", "", "", ...renderTip(theme, w, opts.tipIndex)] : []) };
		const footer: Component = { invalidate() {}, render: (w) => (theme ? renderHomeFooter(state, theme, w, opts.piVersion) : []) };
		// Left padding is sized each frame: pi-tui hands spare width to grow entries unevenly (the
		// first gets the larger share), so two grow spacers wouldn't centre the prompt.
		const leftPad = { component: blank(), basis: 0, grow: 0, shrink: 1 };
		const promptRow = new HStack(
			[
				{ component: blank(), basis: GUTTER, grow: 0, shrink: 0 },
				leftPad,
				{ component: dock, basis: HOME_PROMPT_WIDTH, grow: 0, shrink: 1, minSize: 20 },
				{ component: blank(), basis: 0, grow: 1, shrink: 1 },
				{ component: blank(), basis: GUTTER, grow: 0, shrink: 0 },
			],
			{ align: "start" },
		);
		const entries = (promptRow as unknown as { entries: { basis?: number }[] }).entries;
		const centre = () => {
			const free = termWidth() - GUTTER * 2 - HOME_PROMPT_WIDTH;
			if (entries[1]) entries[1].basis = Math.max(0, Math.floor(free / 2));
		};
		// The top space is sized each frame from the content height so the logo, prompt and tip sit
		// in the middle of the screen (grow spacers split spare rows unevenly, as above).
		const contentHeight = (w: number) => logo.render(w).length + 1 + promptRow.render(w).length + tip.render(w).length;
		const stack = new VStack([
			{ component: blank(), basis: 0, grow: 0, shrink: 1, minSize: 0 },
			{ component: logo, basis: "auto", grow: 0, shrink: 0 },
			{ component: blank(), basis: 1, grow: 0, shrink: 1, minSize: 0 },
			{ component: promptRow, basis: "auto", grow: 0, shrink: 1, minSize: 3 },
			{ component: tip, basis: "auto", grow: 0, shrink: 1, minSize: 0 },
			{ component: blank(), basis: 0, grow: 1, shrink: 1, minSize: 0 },
			{ component: footer, basis: "auto", grow: 0, shrink: 0 },
		]);
		// VStack keeps its own copy of the entries; update that copy.
		const rows = (stack as unknown as { entries: { basis?: number }[] }).entries;
		const middle = () => {
			const w = termWidth();
			const free = (tui?.terminal.rows ?? 40) - contentHeight(w);
			if (rows[0]) rows[0].basis = Math.max(0, Math.floor(free / 2));
		};
		const node = (stack as unknown as LayoutCapable)[LAYOUT_NODE]!.bind(stack);
		return Object.assign(stack, {
			[LAYOUT_NODE]: () => {
				centre();
				middle();
				return node();
			},
		});
	};

	const unwrap = () => {
		if (!tui || typeof tui.setLayoutRoot !== "function") return;
		const current = tui.layoutRoot;
		if (current && current === ourRoot && current[ORIGINAL]) tui.setLayoutRoot(current[ORIGINAL]);
		ourRoot = undefined;
	};

	// The guard is an empty widget inside pi's own layout. It renders every frame, so it notices
	// when pi has replaced the root (e.g. after a renderer switch) and re-wraps on the next tick.
	ctx.ui.setWidget(
		GUARD_WIDGET,
		(t, th) => {
			tui = t as TUI & ViewportLike;
			theme = th;
			if (wrap()) state.layout = "split";
			else state.layout = "overlay";
			return {
				invalidate() {},
				render() {
					theme = th;
					if (!disposed && state.layout === "split" && tui?.layoutRoot !== ourRoot) {
						queueMicrotask(() => {
							if (!wrap()) state.layout = "overlay";
						});
					}
					return [];
				},
			};
		},
		{ placement: "belowEditor" },
	);

	const openOverlay = () => {
		if (overlay || !theme) return;
		const entry: { handle?: OverlayHandle; close: () => void } = { close: () => {} };
		overlay = entry;
		void ctx.ui
			.custom<void>(
				(t, th, _kb, done) => {
					entry.close = () => done();
					return {
						invalidate() {},
						render: (w: number) => renderSidebar(state, th, w, Math.min(t.terminal.rows - 2, 40), opts.piVersion),
					};
				},
				{
					overlay: true,
					overlayOptions: { anchor: "top-right", width: opts.width, maxHeight: "90%", nonCapturing: true, margin: { top: 1, right: 1 } },
					onHandle: (h) => {
						entry.handle = h;
					},
				},
			)
			.finally(() => {
				if (overlay === entry) overlay = undefined;
			});
	};

	return {
		isShown: () => (state.layout === "split" ? splitVisible() && !opts.home() : overlay !== undefined),
		toggle() {
			if (state.layout === "split") {
				state.sidebarVisible = !state.sidebarVisible;
				tui?.requestRender();
				return;
			}
			if (overlay) overlay.close();
			else openOverlay();
		},
		dispose() {
			disposed = true;
			overlay?.close();
			unwrap();
			try {
				ctx.ui.setWidget(GUARD_WIDGET, undefined);
			} catch {
				// stale ctx
			}
		},
	};
}
