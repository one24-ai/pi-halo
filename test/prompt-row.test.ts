/**
 * Prompt row: the mode pill, the thinking label and the whole model row.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerBrand } from "../extensions/halo/client.ts";
import { resetBrand } from "../extensions/halo/brand.ts";
import { ICONS } from "../extensions/halo/icons.ts";
import { modePill, promptRow, THINKING_COLORS, thinkingLabel } from "../extensions/halo/prompt-row.ts";

// These tests check the Nerd Font glyphs; the plain set has its own tests in icons.test.ts.
process.env.PI_HALO_ICONS = "nerd";

const strip = (s: string) => s.replace(/\x1b\[[0-9;:]*m/g, "");
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const theme = {
	fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
	bold: (t: string) => t,
	getColorMode: () => "truecolor",
	// No getThinkingBorderColor on purpose: the thinking label must not depend on the theme's tokens.
} as any;
// Tags count as visible width, so rows that are compared as text get a generous width.
const WIDE = 400;

afterEach(() => resetBrand());

/** Hue in degrees of a #RRGGBB colour, and its lightness, to judge a ramp without looking at it. */
function hueOf(hex: string): number {
	const [r, g, b] = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255) as [number, number, number];
	const max = Math.max(r, g, b);
	const d = max - Math.min(r, g, b);
	if (d === 0) return -1; // grey
	const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return (h * 60 + 360) % 360;
}
const isRed = (hex: string) => {
	const h = hueOf(hex);
	return h >= 0 && (h < 20 || h > 340);
};
const luma = (hex: string) => {
	const [r, g, b] = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16)) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

test("thinkingLabel: halo's own colour per level, nothing for a model that does not reason", () => {
	assert.equal(thinkingLabel(theme, undefined), "");
	assert.deepEqual(Object.keys(THINKING_COLORS), LEVELS, "every level has a colour, in order");
	const seen = new Set<string>();
	for (const level of LEVELS) {
		const out = thinkingLabel(theme, level);
		assert.equal(strip(out), level, `${level} prints its name`);
		assert.ok(out.startsWith("\x1b[38;"), `${level} is painted with a foreground colour`);
		seen.add(out);
	}
	assert.equal(seen.size, LEVELS.length, "no two levels share a colour");
	assert.equal(thinkingLabel(theme, "weird"), thinkingLabel(theme, "off").replace("off", "weird"), "an unknown level takes the off colour");
});

test("the ramp: red only at max, nothing dimmer than the panel can show, and no theme token is involved", () => {
	for (const level of LEVELS) assert.equal(isRed(THINKING_COLORS[level]!), level === "max", `${level} ${THINKING_COLORS[level]}`);
	for (const level of LEVELS) assert.ok(luma(THINKING_COLORS[level]!) >= 95, `${level} is readable on the dark panel`);
	// The test theme has no getThinkingBorderColor, so a theme's (possibly red) thinking tokens cannot matter.
	assert.equal(typeof (theme as any).getThinkingBorderColor, "undefined");
	assert.doesNotThrow(() => LEVELS.map((l) => thinkingLabel(theme, l)));
});

test("modePill: round caps, the mode's icon and label, in the mode's colour", () => {
	registerBrand({ colors: { primary: "#112233", plan: "#aabbcc" } });
	const build = modePill(theme, "build");
	const plan = modePill(theme, "plan");
	assert.equal(strip(build), `\u{E0B6}${ICONS.modeBuild.nerd} BUILD \u{E0B4}`, "no space between the left cap and the icon");
	assert.equal(strip(plan), `\u{E0B6}${ICONS.modePlan.nerd} PLAN \u{E0B4}`);
	assert.ok(build.includes("38;2;17;34;51"), "build caps use the brand primary (#112233)");
	assert.ok(build.includes("48;2;17;34;51"), "and the body fills with it");
	assert.ok(plan.includes("38;2;170;187;204") && plan.includes("48;2;170;187;204"), "plan uses the plan colour (#aabbcc)");
	assert.notEqual(ICONS.modeBuild.nerd, ICONS.modePlan.nerd);
	assert.deepEqual([ICONS.modeBuild.nerd, ICONS.modePlan.nerd], ["\u{F06A9}", "\u{F0208}"], "robot for build, eye for plan");
	assert.equal(visibleWidth(build), visibleWidth(plan) + 1, "BUILD is one letter longer than PLAN, nothing else differs");
});

test("the thinking level has its own colour in both modes, and the pill is the only brand colour in the row", () => {
	registerBrand({ colors: { primary: "#112233", plan: "#aabbcc" } });
	const parts = { model: "M", provider: "P", effort: "high" };
	const afterPill = (mode: "build" | "plan") => {
		const row = promptRow(theme, mode, parts, WIDE);
		return row.slice(row.indexOf("<text>M</text>"));
	};
	assert.ok(afterPill("build").startsWith("<text>M</text>"), "found the model after the pill");
	assert.equal(afterPill("build"), afterPill("plan"), "everything after the pill is identical");
	assert.ok(afterPill("build").endsWith(thinkingLabel(theme, "high")), "the level is painted with its colour from the ramp");
	assert.ok(!afterPill("build").includes("38;2;17;34;51") && !afterPill("build").includes("38;2;170;187;204"), "no brand colour after the pill");
});

test("promptRow: pill, model without the Claude prefix, provider, thinking level; cut to the width", () => {
	const row = (w: number, effort?: string) => promptRow(theme, "build", { model: "Claude Sonnet 5.5", provider: "Anthropic", effort }, w);
	const text = strip(row(WIDE, "medium")).replace(/<[^>]+>/g, "");
	assert.match(text, /BUILD .*Sonnet 5\.5 {2}Anthropic {2}medium/, "pill, model, provider, then the thinking level");
	assert.ok(text.includes("Sonnet 5.5") && !text.includes("Claude"));
	assert.ok(text.includes("Anthropic") && text.includes("medium"));
	assert.ok(!strip(row(WIDE)).replace(/<[^>]+>/g, "").includes("medium"), "no thinking level for a model that does not reason");
	// With the real theme's escapes (no tags), the row never exceeds the width it is given.
	const plainTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, getColorMode: () => "truecolor", getThinkingBorderColor: () => (t: string) => t } as any;
	for (const w of [100, 60, 30, 12]) assert.ok(visibleWidth(promptRow(plainTheme, "build", { model: "Claude Sonnet 5.5", provider: "Anthropic", effort: "high" }, w)) <= w, `fits ${w}`);
	const noProvider = strip(promptRow(theme, "plan", { model: "M" }, WIDE)).replace(/<[^>]+>/g, "");
	assert.ok(noProvider.includes("PLAN") && noProvider.includes("M"));
});
