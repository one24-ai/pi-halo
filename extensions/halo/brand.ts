/**
 * Brand: the few things that make the TUI look like a particular product: the mark shown next to
 * the version, the startup art and tagline, and the accent colours of the chrome.
 *
 * halo ships a neutral default. A separate package layers its own identity on top by calling
 * `registerBrand()` from client.ts:
 *
 *     import { registerBrand } from "pi-halo/client";
 *     export default function () {
 *       registerBrand({ name: "Acme", glyph: "A", colors: { primary: "#E4572E" } });
 *     }
 *
 * The brand is stored on globalThis (the same reason the widget registry is: pi loads every
 * extension in its own module scope) and read while rendering, so load order does not matter and
 * a later registration simply wins. Fields left out keep the defaults.
 *
 * This file has no imports, so client.ts can re-export it without loading anything else.
 */

/** `#RRGGBB` (or any colour string pi-tui's parseColor accepts). */
export type ColorValue = string;

export interface BrandColors {
	/** Build-mode rail and badge, focus marks, the mark next to the version. */
	primary: ColorValue;
	/** Darker companion of `primary`. */
	primaryDark: ColorValue;
	/** Plan-mode rail and badge, and the provider glyph in the sidebar. */
	plan: ColorValue;
	/** Quiet brand neutral used for taglines. */
	neutral: ColorValue;
}

export interface BrandSurfaces {
	/** Sidebar, user messages, tool blocks. Keep in step with the theme's panel colour. */
	panel: ColorValue;
	/** The prompt box. Keep in step with the theme's raised panel colour. */
	element: ColorValue;
}

/**
 * `surfaces` are for dark themes, and `lightSurfaces` for light ones (a theme says which it is with
 * its `appearance`). Text that halo draws in a brand colour is darkened on a light surface until
 * it can be read; rails, bars and the mode pill keep the brand colour exactly.
 */

export interface BrandSpec {
	/** Shown as "<glyph> <name> pi <version>". Leave out for "<glyph> pi <version>". */
	name?: string;
	/** A single-cell mark. Pick one your users' fonts have, or ship a font that does. */
	glyph?: string;
	/** Line under the startup art. */
	tagline?: string;
	/** Startup header art, one string per row, painted in `primary`. Default: the pi logo. */
	art?: string[];
	colors?: Partial<BrandColors>;
	/** For dark themes. */
	surfaces?: Partial<BrandSurfaces>;
	/** For light themes. Default: a light neutral pair. */
	lightSurfaces?: Partial<BrandSurfaces>;
	/**
	 * The icon set to use when the user has not chosen one: "nerd" for a brand whose users have a
	 * Nerd Font (or that ships one), "plain" for icons that need no special font. Default: "plain".
	 */
	icons?: "nerd" | "plain";
}

export const DEFAULT_BRAND = {
	glyph: "●",
	colors: {
		primary: "#4F8EB3",
		primaryDark: "#3B6B87",
		plan: "#EAB65D",
		neutral: "#C9CCC9",
	},
	surfaces: {
		panel: "#121212",
		element: "#1C1C1C",
	},
	lightSurfaces: {
		panel: "#F0F0F0",
		element: "#E6E6E6",
	},
} as const;

export interface ResolvedBrand {
	name?: string;
	glyph: string;
	tagline?: string;
	art?: string[];
	colors: BrandColors;
	surfaces: BrandSurfaces;
	lightSurfaces: BrandSurfaces;
	icons?: "nerd" | "plain";
	/** Changes whenever the brand does; part of render cache keys. */
	version: number;
}

interface Slot {
	spec: BrandSpec;
	version: number;
	resolved?: ResolvedBrand;
}

const KEY = Symbol.for("pi-halo/brand");

function slot(): Slot {
	const g = globalThis as unknown as Record<symbol, Slot | undefined>;
	g[KEY] ??= { spec: {}, version: 0 };
	return g[KEY]!;
}

/** The brand in effect, with defaults filled in. Cheap: cached per change. */
export function getBrand(): ResolvedBrand {
	const s = slot();
	if (s.resolved?.version === s.version) return s.resolved;
	s.resolved = {
		name: s.spec.name,
		glyph: s.spec.glyph || DEFAULT_BRAND.glyph,
		tagline: s.spec.tagline,
		art: s.spec.art?.length ? s.spec.art : undefined,
		colors: { ...DEFAULT_BRAND.colors, ...s.spec.colors },
		surfaces: { ...DEFAULT_BRAND.surfaces, ...s.spec.surfaces },
		lightSurfaces: { ...DEFAULT_BRAND.lightSurfaces, ...s.spec.lightSurfaces },
		icons: s.spec.icons,
		version: s.version,
	};
	return s.resolved;
}

/**
 * Merge a brand onto the current one. Nested `colors`, `surfaces` and `lightSurfaces` merge key by key. Returns a
 * function that restores the previous brand (used by tests and by packages that unload).
 */
export function setBrand(spec: BrandSpec): () => void {
	const s = slot();
	const before = s.spec;
	s.spec = { ...before, ...spec, colors: { ...before.colors, ...spec.colors }, surfaces: { ...before.surfaces, ...spec.surfaces }, lightSurfaces: { ...before.lightSurfaces, ...spec.lightSurfaces } };
	s.version++;
	return () => {
		s.spec = before;
		s.version++;
	};
}

/** Forget any registered brand and go back to the defaults. */
export function resetBrand(): void {
	const s = slot();
	s.spec = {};
	s.version++;
}
