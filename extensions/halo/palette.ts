/**
 * Colours and width-safe text helpers.
 *
 * The chrome follows the active theme. The few colours that come from the brand (see brand.ts)
 * are the primary mark colour, the plan-mode colour, a quiet neutral, and the two surface shades.
 */

import { homedir } from "node:os";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, type Color, colorToHex, colorToOkhsl, colorToRgb, foregroundAnsi, okhslColor, parseColor, rgbColor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WidgetColor, WidgetLevel } from "./api.ts";
import { type BrandColors, type BrandSurfaces, getBrand } from "./brand.ts";
import { safeGlyph } from "./icons.ts";
import { scrubText } from "./sanitize.ts";

const parsed = new Map<string, Color>();

/** Parse a colour string once; an unusable value falls back to `fallback`. */
export function toColor(value: string, fallback = "#808080"): Color {
	let c = parsed.get(value);
	if (!c) {
		try {
			c = parseColor(value);
		} catch {
			c = toColor(fallback, "#808080");
		}
		parsed.set(value, c);
	}
	return c;
}

/** A brand colour, parsed. */
export const brandColor = (name: keyof BrandColors): Color => toColor(getBrand().colors[name]);

/** Paint text with a concrete colour, honouring the theme's colour mode (truecolor/256). */
export function paint(theme: Theme, color: Color, text: string): string {
	return `${foregroundAnsi(color, theme.getColorMode())}${text}\x1b[39m`;
}

/** True under a light theme. A theme without an `appearance` (a test double) counts as dark. */
export const isLight = (theme: Theme): boolean => theme.appearance === "light";

/** Relative luminance of a colour, 0 (black) to 1 (white). */
function luminance(color: Color): number {
	const { r, g, b } = colorToRgb(color);
	const lin = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of two colours, 1 to 21. */
export function contrast(a: Color, b: Color): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
}

const readableCache = new Map<string, Color>();

/**
 * `color` moved along its own lightness (hue and saturation kept) until it has at least `min`
 * contrast against `bg`: darker on a light background, lighter on a dark one. A colour that is
 * readable already comes back as it is. On a background in the middle, where that direction cannot
 * reach `min`, the other direction is tried; failing both, black or white, whichever reads better.
 */
export function readableOn(color: Color, bg: Color, min = 4.5): Color {
	if (contrast(color, bg) >= min) return color;
	const key = `${colorToHex(color)}|${colorToHex(bg)}|${min}`;
	let out = readableCache.get(key);
	if (!out) {
		const { h, s, l } = colorToOkhsl(color);
		const towardsDark = luminance(bg) > 0.5;
		const search = (step: number): Color | undefined => {
			for (let i = 1; i <= 50; i++) {
				const c = okhslColor(h, s, Math.min(1, Math.max(0, l + step * i)));
				if (contrast(c, bg) >= min) return c;
			}
			return undefined;
		};
		const black = rgbColor(0, 0, 0);
		const white = rgbColor(255, 255, 255);
		out = search(towardsDark ? -0.02 : 0.02) ?? search(towardsDark ? 0.02 : -0.02) ?? (contrast(black, bg) >= contrast(white, bg) ? black : white);
		readableCache.set(key, out);
	}
	return out;
}

/**
 * A brand or widget colour used as text. On a light theme it is darkened until it can be read on the
 * surfaces; on a dark theme it is used as given, which is how the brand colours were chosen.
 */
export const textColor = (theme: Theme, color: Color): Color => (isLight(theme) ? readableOn(color, surfaceColor(theme, "element")) : color);

/** Text in the brand's primary colour: the active-mode mark, the brand glyph, the header art. */
export const primary = (theme: Theme, text: string) => paint(theme, textColor(theme, brandColor("primary")), text);

/**
 * One frame of the working spinner: the glyph in the brand's primary colour, so it follows whatever
 * brand is installed. A primary colour that cannot be parsed falls back to the theme's accent.
 */
export function spinnerFrame(theme: Theme, glyph: string): string {
	try {
		parseColor(getBrand().colors.primary);
	} catch {
		return theme.fg("accent", glyph);
	}
	return primary(theme, glyph);
}

/** Text in the brand's neutral colour. */
export const neutral = (theme: Theme, text: string) => paint(theme, textColor(theme, brandColor("neutral")), text);

/** Text in the plan-mode colour. */
export const planColor = (theme: Theme, text: string) => paint(theme, textColor(theme, brandColor("plan")), text);

/** The brand mark and name: "<glyph> <name>", or just the glyph. Painted; no version. */
export function brandMark(theme: Theme): string {
	const b = getBrand();
	const glyph = primary(theme, safeGlyph(b.glyph));
	return b.name ? `${glyph} ${theme.bold(theme.fg("text", b.name))}` : glyph;
}

/** "<mark> pi 1.1.0" (plus " · halo 0.1.0" when given): the brand line on the home screen bottom bar and in the sidebar. */
export function brandLine(theme: Theme, version: string, haloVersion?: string): string {
	const halo = haloVersion ? ` ${theme.fg("dim", "·")} ${theme.fg("muted", `halo ${haloVersion}`)}` : "";
	return `${brandMark(theme)} ${theme.fg("muted", `pi ${version}`)}${halo}`;
}

const LEVEL_COLOR: Record<WidgetLevel, WidgetColor> = {
	ok: "success",
	warn: "warning",
	error: "error",
	off: "dim",
	info: "text",
};

/**
 * Surface shades, OpenCode-style steps above the background (OpenCode: #0a0a0a, panel #141414,
 * element #1e1e1e):
 *   panel    sidebar, user messages, tool blocks
 *   element  the prompt box
 * The brand supplies the values: `surfaces` for a dark theme, `lightSurfaces` for a light one. A theme should use the same ones for userMessageBg,
 * toolSuccessBg and customMessageBg, so pi's own blocks match ours.
 */
export type Surface = keyof BrandSurfaces;

export const surfaceColor = (theme: Theme, surface: Surface): Color => {
	const b = getBrand();
	return toColor((isLight(theme) ? b.lightSurfaces : b.surfaces)[surface]);
};

export const surfaceBg = (theme: Theme, surface: Surface) => backgroundAnsi(surfaceColor(theme, surface), theme.getColorMode());

/**
 * Paint a line on a surface background across exactly `width` columns. Resets inside the line
 * (\x1b[0m, \x1b[49m) would end the shading early, so the background is re-applied after each.
 */
export function shade(theme: Theme, line: string, width: number, surface: Surface = "panel"): string {
	const bg = surfaceBg(theme, surface);
	const body = fit(line, width).replace(/\x1b\[0m/g, `\x1b[0m${bg}`).replace(/\x1b\[49m/g, bg);
	return `${bg}${body}\x1b[49m`;
}

/** Resolve a widget colour (theme token, brand colour or hex) and paint text with it. */
export function widgetPaint(theme: Theme, color: WidgetColor | undefined, level: WidgetLevel | undefined, text: string): string {
	const c = color ?? (level ? LEVEL_COLOR[level] : "text");
	switch (c) {
		case "brand":
			return primary(theme, text);
		case "brandDark":
			return paint(theme, textColor(theme, brandColor("primaryDark")), text);
		case "plan":
			return planColor(theme, text);
		default:
			if (c.startsWith("#")) return paint(theme, textColor(theme, toColor(c)), text);
			return theme.fg(c as Parameters<Theme["fg"]>[0], text);
	}
}

/** Pad or truncate a (possibly styled) line to exactly `width` columns. */
export function fit(line: string, width: number): string {
	if (width <= 0) return "";
	const t = truncateToWidth(line, width, "…");
	return t + " ".repeat(Math.max(0, width - visibleWidth(t)));
}

export { sanitize, sanitizeKeepColor, sanitizeLines, scrubText, stripEscapes } from "./sanitize.ts";

/** True if a string sets its own foreground colour. */
export function hasOwnColor(text: string): boolean {
	for (const m of text.matchAll(/\x1b\[([0-9;:]*)m/g)) {
		const params = m[1]!.split(/[;:]/).map(Number);
		for (let i = 0; i < params.length; i++) {
			const p = params[i]!;
			if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97) || p === 38) return true;
			if (p === 48) i += params[i + 1] === 2 ? 4 : 2;
		}
	}
	return false;
}

export function fmtTokens(n: number): string {
	if (!Number.isFinite(n) || n < 1000) return String(Math.max(0, Math.round(n || 0)));
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

export function fmtDuration(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "just now", "5m ago", "3h ago", "2d ago", "6w ago". */
export function fmtAgo(ms: number): string {
	const m = Math.floor(Math.max(0, ms) / 60_000);
	if (m < 1) return "just now";
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	if (d < 14) return `${d}d ago`;
	return `${Math.floor(d / 7)}w ago`;
}

/**
 * `path` as shown on screen: the home directory written as `~`, and escape sequences and control
 * characters removed, because a directory name is chosen by whoever made the directory. Uses the OS
 * home directory (HOME on Unix, the user profile on Windows) and accepts either path separator
 * after it.
 */
export function homeRelative(path: string): string {
	return scrubText(withTilde(path));
}

function withTilde(path: string): string {
	let home: string;
	try {
		home = homedir();
	} catch {
		return path;
	}
	if (!home) return path;
	const sameCase = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
	if (sameCase(path, home)) return "~";
	const head = path.slice(0, home.length);
	const next = path[home.length];
	return sameCase(head, home) && (next === "/" || next === "\\") ? `~${path.slice(home.length)}` : path;
}

/** Index of the last path separator ("/" or "\\"), or -1. */
export function lastSep(path: string): number {
	return Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
}

export const finite = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
