/**
 * Under a light theme the panels are light and the brand colours used as text are darkened until
 * they can be read; under a dark theme nothing changes. The theme says which it is with `appearance`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { colorToRgb, parseColor } from "@earendil-works/pi-tui";
import { DEFAULT_BRAND, resetBrand, setBrand } from "../extensions/halo/brand.ts";
import { installMessageStyle, setChatContainer } from "../extensions/halo/messages.ts";
import { contrast, isLight, planColor, primary, readableOn, surfaceColor, toColor, widgetPaint } from "../extensions/halo/palette.ts";
import { modePill, promptRow, THINKING_COLORS, thinkingLabel } from "../extensions/halo/prompt-row.ts";
import { createState } from "../extensions/halo/state.ts";

initTheme("dark", false);

const mk = (appearance: "light" | "dark" | undefined) =>
	({ appearance, name: appearance ?? "none", getColorMode: () => "truecolor", fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t }) as any;
const light = mk("light");
const dark = mk("dark");

/** The colour inside the first truecolor foreground (38;2) or background (48;2) sequence of `s`. */
const rgbOf = (s: string, ground: 38 | 48): [number, number, number] | undefined => {
	const m = new RegExp(`\\x1b\\[${ground};2;(\\d+);(\\d+);(\\d+)m`).exec(s);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
};
const asColor = (c: [number, number, number]) => parseColor(`#${c.map((n) => n.toString(16).padStart(2, "0")).join("")}`);

test("isLight: only a theme that says it is light", () => {
	assert.equal(isLight(light), true);
	assert.equal(isLight(dark), false);
	assert.equal(isLight(mk(undefined)), false, "a theme without an appearance counts as dark");
});

test("surfaces: the dark pair under a dark theme, the light pair under a light one, each overridable", () => {
	resetBrand();
	assert.deepEqual(colorToRgb(surfaceColor(dark, "panel")), colorToRgb(toColor(DEFAULT_BRAND.surfaces.panel)));
	assert.deepEqual(colorToRgb(surfaceColor(light, "panel")), colorToRgb(toColor(DEFAULT_BRAND.lightSurfaces.panel)));
	assert.ok(contrast(surfaceColor(light, "panel"), toColor("#FFFFFF")) < 1.3, "the light panel is a soft step from a white page");
	const undo = setBrand({ lightSurfaces: { panel: "#FAF0E6" }, surfaces: { panel: "#101820" } });
	assert.deepEqual(colorToRgb(surfaceColor(light, "panel")), colorToRgb(toColor("#FAF0E6")));
	assert.deepEqual(colorToRgb(surfaceColor(dark, "panel")), colorToRgb(toColor("#101820")));
	assert.deepEqual(colorToRgb(surfaceColor(light, "element")), colorToRgb(toColor(DEFAULT_BRAND.lightSurfaces.element)), "the other light surface keeps its default");
	undo();
});

test("readableOn: darkens on a light background, lightens on a dark one, leaves a readable colour alone, keeps the hue", () => {
	const white = toColor("#FFFFFF");
	const black = toColor("#000000");
	const gold = toColor("#EAB65D");
	assert.ok(contrast(gold, white) < 2, "the gold is unreadable on white to begin with");
	const dk = readableOn(gold, white);
	assert.ok(contrast(dk, white) >= 4.5, `darkened gold reads on white (${contrast(dk, white).toFixed(1)}:1)`);
	const [r, g, b] = Object.values(colorToRgb(dk)) as number[];
	assert.ok(r! > b! && g! > b!, "still a gold: more red and green than blue");
	assert.ok(contrast(readableOn(toColor("#202020"), black), black) >= 4.5, "lightened on black");
	const fine = toColor("#1F3A5F");
	assert.equal(readableOn(fine, white), fine, "already readable: the same colour comes back");
	assert.ok(contrast(readableOn(toColor("#808080"), toColor("#808080")), toColor("#808080")) >= 4.5, "even when the two were the same colour");
});

test("brand text colours: readable on the light surfaces, exactly the brand colour on the dark ones", () => {
	resetBrand();
	for (const paintFn of [primary, planColor]) {
		const onLight = rgbOf(paintFn(light, "x"), 38)!;
		assert.ok(contrast(asColor(onLight), surfaceColor(light, "element")) >= 4.5, `${paintFn.name} is readable on the light prompt box`);
		assert.ok(contrast(asColor(onLight), surfaceColor(light, "panel")) >= 4.5, `${paintFn.name} is readable on the light panel`);
	}
	assert.deepEqual(rgbOf(primary(dark, "x"), 38), [0x4f, 0x8e, 0xb3], "dark: the brand primary, unchanged");
	assert.deepEqual(rgbOf(planColor(dark, "x"), 38), [0xea, 0xb6, 0x5d], "dark: the brand plan colour, unchanged");
	assert.ok(contrast(asColor(rgbOf(widgetPaint(light, undefined, undefined, "x").length ? widgetPaint(light, "#D4892A" as any, undefined, "x") : "", 38)!), surfaceColor(light, "element")) >= 4.5, "a hex widget colour is darkened too");
});

test("the mode pill keeps the exact mode colour on a light theme and uses dark ink on it", () => {
	resetBrand();
	for (const mode of ["build", "plan"] as const) {
		const pill = modePill(light, mode);
		const bg = rgbOf(pill, 48)!;
		const expected = mode === "plan" ? [0xea, 0xb6, 0x5d] : [0x4f, 0x8e, 0xb3];
		assert.deepEqual(bg, expected, `${mode}: the exact brand colour behind the label`);
		const ink = rgbOf(pill.slice(pill.indexOf("\x1b[48;2")), 38)!;
		assert.ok(contrast(asColor(ink), asColor(bg)) >= 4.5, `${mode}: the label is readable on the pill`);
	}
});

test("the thinking label is readable on a light prompt box at every level, and unchanged on a dark one", () => {
	for (const level of Object.keys(THINKING_COLORS)) {
		const l = rgbOf(thinkingLabel(light, level), 38)!;
		assert.ok(contrast(asColor(l), surfaceColor(light, "element")) >= 4.5, `${level} reads on the light box`);
		assert.deepEqual(rgbOf(thinkingLabel(dark, level), 38), Object.values(colorToRgb(toColor(THINKING_COLORS[level]!))), `${level} is as designed on a dark theme`);
	}
	assert.equal(promptRow(light, "build", { model: "m", provider: "p", effort: "high" }, 60).includes("high"), true);
});

test("a user message box is painted on the light panel under a light theme, and on the dark one under a dark theme", () => {
	resetBrand();
	const text = "a message long enough to be a message";
	const entries = [{ type: "message", id: "u1", message: { role: "user", content: text } }];
	const state = createState();
	state.ctx = { sessionManager: { getLeafId: () => "leaf", getBranch: () => entries, buildContextEntries: () => entries } } as any;
	const bgOfRow = (theme: any) => {
		const box = new UserMessageComponent(text);
		setChatContainer({ children: [box] });
		const undo = installMessageStyle(state, () => theme);
		try {
			const row = box.render(70).find((l) => l.includes("a message"))!;
			return rgbOf(row.slice(row.indexOf("\x1b[48;2")), 48);
		} finally {
			undo();
			setChatContainer(undefined);
		}
	};
	assert.deepEqual(bgOfRow(light), Object.values(colorToRgb(toColor(DEFAULT_BRAND.lightSurfaces.panel))));
	assert.deepEqual(bgOfRow(dark), Object.values(colorToRgb(toColor(DEFAULT_BRAND.surfaces.panel))));
});
