/**
 * Brand: neutral defaults, layering a brand through client.ts, and that the brand reaches the
 * header, the brand line and the widget colours.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { getBrand, DEFAULT_BRAND, resetBrand } from "../extensions/halo/brand.ts";
import { registerBrand } from "../extensions/halo/client.ts";
import { renderHeader } from "../extensions/halo/header.ts";
import { brandLine, primary, widgetPaint } from "../extensions/halo/palette.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;:]*m/g, "");
const theme = {
	getColorMode: () => "truecolor",
	fg: (_c: string, t: string) => t,
	bold: (t: string) => t,
} as any;

afterEach(() => resetBrand());

test("default brand is neutral: no name, no tagline, only built-in values", () => {
	const b = getBrand();
	assert.equal(b.name, undefined);
	assert.equal(b.tagline, undefined);
	assert.equal(b.glyph, DEFAULT_BRAND.glyph);
	assert.equal(strip(brandLine(theme, "1.0.0")), `${DEFAULT_BRAND.glyph} pi 1.0.0`);
	assert.deepEqual(b.colors, DEFAULT_BRAND.colors);
	assert.deepEqual(b.surfaces, DEFAULT_BRAND.surfaces);
});

test("registerBrand merges onto the defaults and undo restores them", () => {
	const undo = registerBrand({ name: "Acme", glyph: "A", colors: { primary: "#112233" } });
	const b = getBrand();
	assert.equal(b.name, "Acme");
	assert.equal(b.colors.primary, "#112233");
	assert.equal(b.colors.plan, DEFAULT_BRAND.colors.plan, "unset colours keep the default");
	assert.equal(strip(brandLine(theme, "1.0.0")), "A Acme pi 1.0.0");
	undo();
	assert.equal(getBrand().name, undefined);
	assert.equal(getBrand().colors.primary, DEFAULT_BRAND.colors.primary);
});

test("a later registration wins, and the version changes so render caches miss", () => {
	registerBrand({ name: "One" });
	const v1 = getBrand().version;
	registerBrand({ name: "Two" });
	assert.equal(getBrand().name, "Two");
	assert.notEqual(getBrand().version, v1);
	assert.equal(getBrand(), getBrand(), "resolved brand is cached between changes");
});

test("colours use the brand, and a bad colour string does not throw", () => {
	registerBrand({ colors: { primary: "#102030" } });
	assert.ok(primary(theme, "x").includes("38;2;16;32;48"));
	assert.ok(widgetPaint(theme, "brand", undefined, "x").includes("38;2;16;32;48"));
	assert.ok(widgetPaint(theme, "#405060", undefined, "x").includes("38;2;64;80;96"));
	registerBrand({ colors: { primary: "not a colour" } });
	assert.doesNotThrow(() => primary(theme, "x"));
});

test("header uses the pi logo by default and the brand's art and tagline when given", () => {
	const info = { model: "m", cwd: "/x", version: "1.0.0" };
	const plain = renderHeader(theme, 80, info).map(strip);
	assert.ok(!plain.some((l) => l.includes("Let's build")));
	assert.ok(plain.some((l) => l.includes("▀") || l.includes("█")), "pi logo rows");
	registerBrand({ art: ["ab", "cd"], tagline: "Hello there" });
	const branded = renderHeader(theme, 80, info).map(strip);
	assert.ok(branded.some((l) => l.trim() === "ab"));
	assert.ok(branded.some((l) => l.includes("Hello there")));
	assert.deepEqual(renderHeader(theme, 20, info).map(strip), ["A pi".replace("A", getBrand().glyph)]);
});
