/**
 * Widget client: the entry point for widgets that live in other extensions or packages.
 *
 *     import { registerWidget } from "pi-halo/client";
 *
 *     registerWidget(pi, { id: "git", render: () => ({ text: "main ●2" }) });
 *
 * Same spec and handle as api.ts, but it never loads the registry code: it only looks for the
 * host on globalThis (the Symbol.for keys below), so it works whichever extension loads first
 * and it works without halo installed:
 *
 * - halo already loaded: the widget is registered with it straight away.
 * - halo loads later: the widget is queued and halo registers it when it loads.
 * - halo is not installed (checked at session_start, when every extension has loaded): the
 *   widget falls back to ctx.ui.setStatus(id, "<label> <text>"), updated on `refreshMs`. Only
 *   the one-line view is shown there: no detail lines, colours or caching.
 *
 * Import it as "pi-halo/client" (the package's `exports` map), which resolves to compiled
 * JavaScript with type declarations (dist/), so a consumer's plain Node tests and tsc need no
 * TypeScript loader. pi itself loads this package's extensions from the .ts sources. It loads
 * two value modules, `./brand.ts` and `./provider.ts`, and `../diff/host.ts` for the diff view API,
 * and the rest of what it imports is types. To vendor it, copy those four files and keep the
 * `halo/` and `diff/` folder layout, or import it from the package instead. Any one of the
 * three missing fails the load. Those modules import only types themselves, so they add no
 * further files.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PendingRegistration, Registry, WidgetHandle, WidgetSpec } from "./api.ts";
import { type BrandSpec, setBrand } from "./brand.ts";
import { type ProviderStatusSpec, setProviderStatus } from "./provider.ts";

/** The registry API version this client was written for. */
export const CLIENT_API_VERSION = 1;
const REGISTRY = Symbol.for("pi-halo/registry");
const PENDING = Symbol.for("pi-halo/pending");
const DEFAULT_UPDATE_TIMEOUT_MS = 10_000;

type Host = Required<Pick<Registry, "register">>;

/** The host registry, if halo has loaded and speaks an API version this client understands. */
function findHost(): Host | undefined {
	const reg = (globalThis as unknown as Record<symbol, Registry | undefined>)[REGISTRY];
	if (!reg?.register || typeof reg.apiVersion !== "number" || reg.apiVersion < CLIENT_API_VERSION) return undefined;
	return { register: reg.register };
}

function pending(): PendingRegistration[] {
	const g = globalThis as unknown as Record<symbol, PendingRegistration[] | undefined>;
	g[PENDING] ??= [];
	return g[PENDING]!;
}

interface Fallback {
	stop(): void;
	refresh(): void;
}

/** Plain-pi mode: show the widget as a setStatus() line. */
function startFallback(spec: WidgetSpec, ctx: ExtensionContext): Fallback {
	const timeoutMs = spec.updateTimeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS;
	let stopped = false;
	let inflight = false;

	const setStatus = (text: string | undefined): void => {
		try {
			ctx.ui.setStatus(spec.id, text);
		} catch {
			// stale ctx after a session switch
		}
	};
	const paint = (): void => {
		if (stopped) return;
		try {
			const view = spec.render({ theme: ctx.ui.theme, ctx, width: 80 });
			// Without halo there is no icon set to ask, so an icon pair gives its plain side.
			const glyph = typeof view?.icon === "object" ? view.icon.plain : view?.icon;
			if (!view || (!view.text && !glyph)) return setStatus(undefined);
			setStatus([glyph, view.label ?? spec.title ?? spec.id, view.text].filter(Boolean).join(" "));
		} catch {
			setStatus(`${spec.title ?? spec.id} error`);
		}
	};
	const refresh = async (): Promise<void> => {
		if (stopped || inflight) return;
		inflight = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			if (spec.update) {
				const timeout = new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("update timed out")), timeoutMs);
					timer.unref?.();
				});
				await Promise.race([Promise.resolve(spec.update(ctx)), timeout]);
			}
		} catch {
			// keep showing the last state
		} finally {
			if (timer) clearTimeout(timer);
			inflight = false;
			paint();
		}
	};

	void refresh();
	const interval = spec.refreshMs ? setInterval(() => void refresh(), spec.refreshMs) : undefined;
	interval?.unref?.();
	return {
		refresh: () => void refresh(),
		stop: () => {
			stopped = true;
			if (interval) clearInterval(interval);
			setStatus(undefined);
		},
	};
}

/** Register (or replace) a widget with halo if present, else show it as a plain status. */
export function registerWidget(pi: ExtensionAPI, spec: WidgetSpec): WidgetHandle {
	let real: WidgetHandle | undefined;
	let fallback: Fallback | undefined;
	let disposed = false;
	const offs: Array<() => void> = [];
	const unlisten = (): void => {
		for (const off of offs.splice(0)) {
			try {
				off();
			} catch {
				// the pi instance may already be gone
			}
		}
	};
	const listen = (off: unknown): void => {
		if (typeof off === "function") offs.push(off as () => void);
	};

	const handle: WidgetHandle = {
		refresh: () => (real ? real.refresh() : fallback?.refresh()),
		dispose: () => {
			disposed = true;
			real?.dispose();
			fallback?.stop();
			fallback = undefined;
			unlisten();
		},
	};

	const host = findHost();
	if (host) {
		real = host.register(pi, spec);
		return handle;
	}

	// Host not loaded yet (or absent). Queue for it; if it never shows up, fall back at session_start.
	const entry: PendingRegistration = {
		pi,
		spec,
		attach: (h) => {
			real = h;
			fallback?.stop();
			fallback = undefined;
			unlisten(); // the host owns the lifecycle now
			if (disposed) h.dispose();
		},
	};
	pending().push(entry);

	listen(pi.on("session_start", async (_e, ctx) => {
		if (real || disposed) return; // halo took it
		const list = pending();
		const i = list.indexOf(entry);
		if (i >= 0) list.splice(i, 1);
		fallback?.stop();
		fallback = startFallback(spec, ctx);
	}));
	listen(pi.on("session_shutdown", async () => {
		fallback?.stop();
		fallback = undefined;
	}));
	return handle;
}

/**
 * Layer a brand (name, glyph, tagline, startup art, colours) on top of halo. Call it from an
 * extension's default export; it works whichever package loads first, and halo repaints. The
 * returned function restores the previous brand. See brand.ts for the fields.
 */
export function registerBrand(spec: BrandSpec): () => void {
	const undo = setBrand(spec);
	requestRender();
	return () => {
		undo();
		requestRender();
	};
}

/**
 * Add a provider's own facts (a plan or quota bar, a display name, a glyph colour) to the sidebar's
 * provider section and the footer. See provider.ts. The returned function removes it.
 */
export function registerProviderStatus(spec: ProviderStatusSpec): () => void {
	const undo = setProviderStatus(spec);
	requestRender();
	return () => {
		undo();
		requestRender();
	};
}

/** Ask halo to repaint now (no-op when it isn't loaded). For state a widget changes outside `update`. */
export function requestRender(): void {
	(globalThis as unknown as Record<symbol, Registry | undefined>)[REGISTRY]?.requestRender?.();
}

export { addDiffAction, openChanges, openDiff } from "../diff/host.ts";
export type { DiffAction, DiffActionContext, DiffFileInfo, DiffHunkInfo, OpenDiffRequest } from "../diff/types.ts";
export type { ProviderMeter, ProviderStatusSpec } from "./provider.ts";
export type { BrandColors, BrandSpec, BrandSurfaces } from "./brand.ts";
export type { IconLike } from "./icons.ts";
export type { WidgetAction, WidgetHandle, WidgetSpec, WidgetView, WidgetRenderContext, WidgetSlot, WidgetColor, WidgetLevel } from "./api.ts";
