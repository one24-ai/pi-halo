/**
 * The agent and model row at the bottom of the prompt box:
 *
 *    󰚩 BUILD   Sonnet 4.5  Anthropic  medium
 *   ^^^^^^^^^^^
 *   a filled pill in the mode colour (brand primary for build, brand plan colour for plan) with the
 *   mode's icon, then the model, the provider, and the thinking level in halo's own colour for it.
 *
 * Pure functions over a theme, so the row can be tested without an editor. With a Nerd Font the pill
 * caps are the Powerline round caps and the mode has an icon; without one the caps are half blocks
 * and the pill is just the label (icons.ts).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, type Color, foregroundAnsi, truncateToWidth } from "@earendil-works/pi-tui";
import { icon, withIcon } from "./icons.ts";
import { brandColor, isLight, paint, readableOn, surfaceColor, toColor } from "./palette.ts";

export type Mode = "build" | "plan";

/** The mode's icon in the current set: a robot for build and an eye for plan, or none. */
export const modeIcon = (mode: Mode): string => icon(mode === "plan" ? "modePlan" : "modeBuild");

/** The mode's colour as a parsed colour: the brand plan colour for plan, the primary for build. */
export const modeColorValue = (mode: Mode) => brandColor(mode === "plan" ? "plan" : "primary");

/** The pill's text: the dark panel shade on a dark theme, near-black on a light one, so it reads on the mode colour either way. */
const pillInk = (theme: Theme): Color => (isLight(theme) ? toColor("#121212") : surfaceColor(theme, "panel"));

/** A filled pill with round caps: "<icon> <LABEL> " in dark text on the mode colour. The left cap is already a curve, so the icon sits right against it. */
export function modePill(theme: Theme, mode: Mode): string {
	const color = modeColorValue(mode);
	const depth = theme.getColorMode();
	const label = withIcon(modeIcon(mode), mode === "plan" ? "PLAN" : "BUILD");
	// The row is shaded on the element surface, so the caps only set a foreground; the body sets
	// both, and ends with \x1b[49m, which shade() turns back into the surface colour.
	const body = `${backgroundAnsi(color, depth)}${foregroundAnsi(pillInk(theme), depth)}\x1b[1m${label} \x1b[22m\x1b[39m\x1b[49m`;
	return `${paint(theme, color, icon("capLeft"))}${body}${paint(theme, color, icon("capRight"))}`;
}

/**
 * One colour per thinking level, halo's own and the same under every theme and brand. It warms
 * up with the effort: grey when off, then blue, violet and amber, and red only at the top, so a red
 * label means the most expensive setting and nothing else. Bright enough for the dark panel shades;
 * under a light theme thinkingLabel darkens the same hues.
 */
export const THINKING_COLORS: Readonly<Record<string, string>> = {
	off: "#6E716E",
	minimal: "#8E9398",
	low: "#7FA6C9",
	medium: "#5F9BE0",
	high: "#A48BE0",
	xhigh: "#E0A94F",
	max: "#F0505F",
};

/**
 * The thinking level's name in its colour from THINKING_COLORS; nothing for a model that does not
 * reason. An unknown level takes the "off" colour.
 */
export function thinkingLabel(theme: Theme, level: string | undefined): string {
	if (!level) return "";
	const color = toColor(THINKING_COLORS[level] ?? THINKING_COLORS.off!);
	// Chosen for the dark panels; on a light theme the same hue is darkened until it can be read.
	return paint(theme, isLight(theme) ? readableOn(color, surfaceColor(theme, "element")) : color, level);
}

export interface ModelParts {
	/** Model name as pi reports it, for example "Claude Sonnet 5.5". */
	model: string;
	provider?: string;
	/** Thinking level, when the model reasons. */
	effort?: string;
}

/** The whole row, cut to `width` columns. */
export function promptRow(theme: Theme, mode: Mode, parts: ModelParts, width: number): string {
	const name = parts.model.replace(/^Claude /, "");
	const segments = [
		modePill(theme, mode),
		theme.fg("text", name),
		...(parts.provider ? [theme.fg("muted", parts.provider)] : []),
		thinkingLabel(theme, parts.effort),
	].filter(Boolean);
	return truncateToWidth(segments.join("  "), width, "…");
}
