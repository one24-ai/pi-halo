/**
 * Startup header: the brand's art (the pi logo unless a brand supplies its own), centred, with
 * the tagline if the brand has one, the model, cwd and a few OpenCode-style key hints. Shown once
 * at the top of the transcript.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { getBrand } from "./brand.ts";
import { piLogoRows } from "./home.ts";
import { safeGlyph } from "./icons.ts";
import { homeRelative, neutral, primary } from "./palette.ts";

const center = (s: string, w: number) => " ".repeat(Math.max(0, Math.floor((w - visibleWidth(s)) / 2))) + s;

export interface HeaderInfo {
	model: string;
	cwd: string;
	version: string;
}

export function renderHeader(theme: Theme, width: number, info: HeaderInfo): string[] {
	const brand = getBrand();
	if (width < 30) return [primary(theme, safeGlyph(brand.glyph)) + theme.bold(" pi")];
	const lines: string[] = [""];
	if (brand.art) {
		const artW = Math.max(...brand.art.map((r) => visibleWidth(r)));
		for (const row of brand.art) lines.push(center(primary(theme, row + " ".repeat(artW - visibleWidth(row))), width));
	} else {
		for (const row of piLogoRows(theme)) lines.push(center(row, width));
	}
	lines.push("");
	if (brand.tagline) lines.push(center(theme.bold(neutral(theme, brand.tagline)), width));
	lines.push(center(theme.fg("muted", info.model), width));
	lines.push(center(theme.fg("dim", homeRelative(info.cwd)), width));
	lines.push("");
	const key = (k: string, d: string) => `${theme.fg("text", k)} ${theme.fg("dim", d)}`;
	const hints = [key("tab", "build/plan"), key("ctrl+p", "commands"), key("ctrl+x b", "sidebar"), key("ctrl+x ?", "keys")];
	lines.push(center(hints.join(theme.fg("dim", "   ")), width));
	lines.push(center(theme.fg("dim", `pi v${info.version}`), width));
	lines.push("");
	return lines;
}
