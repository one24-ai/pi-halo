/**
 * Icons: a Nerd Font set and a plain set that needs no special font, chosen by the environment, the
 * user's setting or the brand. The plain set must lay out exactly like the Nerd one, and the Nerd
 * code points must live in icons.ts only.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

const dir = mkdtempSync(join(tmpdir(), "halo-icons-"));
process.env.PI_HALO_STATE = join(dir, "state.json");
delete process.env.PI_HALO_ICONS;

const api = await import("../extensions/halo/api.ts");
const { resetBrand, setBrand } = await import("../extensions/halo/brand.ts");
const I = await import("../extensions/halo/icons.ts");
const { modePill } = await import("../extensions/halo/prompt-row.ts");
const { renderSidebar } = await import("../extensions/halo/sidebar.ts");
const { renderFooter } = await import("../extensions/halo/footer.ts");
const { formatTelemetry } = await import("../extensions/halo/telemetry.ts");
const { createState } = await import("../extensions/halo/state.ts");
const { TOOL_ICONS, SPECS, makeRenderers } = await import("../extensions/halo/tools.ts");

const strip = (s: string) => s.replace(/\x1b\[[0-9;:]*m/g, "");
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t, getColorMode: () => "truecolor" } as any;
const PUA = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}]/u;

beforeEach(() => {
	delete process.env.PI_HALO_ICONS;
	I.resetIconSetting();
	resetBrand();
	writeFileSync(process.env.PI_HALO_STATE!, "{}");
});
afterEach(() => {
	delete process.env.PI_HALO_ICONS;
	I.resetIconSetting();
	resetBrand();
});

// ---- which set ---------------------------------------------------------------------------------

test("the default is plain, and the environment, the user's setting and the brand each win in order", () => {
	assert.equal(I.iconSet(), "plain");
	assert.equal(I.iconSource(), "default");

	setBrand({ icons: "nerd" });
	assert.equal(I.iconSet(), "nerd", "a brand can ask for nerd");
	assert.equal(I.iconSource(), "brand");

	I.setIconSetting("plain");
	assert.equal(I.iconSet(), "plain", "the user's setting beats the brand");
	assert.equal(I.iconSource(), "setting");

	process.env.PI_HALO_ICONS = "nerd";
	assert.equal(I.iconSet(), "nerd", "the environment beats the setting");
	assert.equal(I.iconSource(), "env");

	process.env.PI_HALO_ICONS = "bogus";
	assert.equal(I.iconSet(), "plain", "an unknown value is ignored");
});

test("the setting is read from and saved to the state file, keeping its other keys", () => {
	const p = process.env.PI_HALO_STATE!;
	writeFileSync(p, JSON.stringify({ disabledWidgets: ["aws"], icons: "nerd" }));
	I.resetIconSetting();
	assert.equal(I.iconSet(), "nerd");

	I.saveIconSetting("plain");
	assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { disabledWidgets: ["aws"], icons: "plain" });
	I.saveIconSetting(undefined);
	assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { disabledWidgets: ["aws"] }, "forgetting removes only the icons key");

	writeFileSync(p, JSON.stringify({ icons: 42 }));
	assert.equal(I.loadIconSetting(p), undefined, "a bad value is ignored");
	writeFileSync(p, "{ not json");
	assert.equal(I.loadIconSetting(p), undefined);
});

// ---- the tables --------------------------------------------------------------------------------

test("every nerd glyph is private-use and every plain one is not", () => {
	for (const [name, pair] of Object.entries(I.ICONS)) {
		const nerd = pair.nerd.replace(/ /g, "");
		assert.ok(nerd && PUA.test(nerd) || nerd.codePointAt(0)! === 0x27f3 || nerd.codePointAt(0)! === 0x27f2, `${name}: nerd glyph ${JSON.stringify(pair.nerd)}`);
		assert.ok(!PUA.test(pair.plain), `${name}: the plain twin ${JSON.stringify(pair.plain)} must not need a Nerd Font`);
	}
});

test("plain glyphs are one cell wide, or empty, or a short word", () => {
	for (const [name, pair] of Object.entries(I.ICONS)) {
		const w = visibleWidth(pair.plain);
		assert.ok(w <= 5, `${name}: ${JSON.stringify(pair.plain)} is ${w} wide`);
	}
	// The single-glyph icons used as markers are exactly one cell in the common monospace fonts.
	const ONE_CELL = /^[\u0021-\u007e\u00d7\u2022\u2190-\u2193\u25a0\u25b2\u25cb\u25cf\u2590\u258c]$/u;
	for (const name of ["provider", "levelOk", "levelWarn", "levelError", "levelOff", "levelInfo", "statusLsp", "statusGraphify", "capLeft", "capRight", "toolRead", "toolWrite", "toolEdit", "toolBash", "toolGrep", "toolFind", "toolLs", "toolOther"] as const) {
		assert.match(I.ICONS[name].plain, ONE_CELL, name);
	}
});

test("the tool icons are distinct in both sets", () => {
	for (const set of ["nerd", "plain"] as const) {
		const glyphs = [...new Set(Object.values(TOOL_ICONS))].map((n) => I.ICONS[n][set]);
		assert.equal(new Set(glyphs).size, glyphs.length, `${set}: no two tools share a glyph`);
	}
});

test("usageIcon: filled in eighths with a Nerd Font, a blank slot without one", () => {
	process.env.PI_HALO_ICONS = "nerd";
	assert.equal(I.usageIcon(0), "\u{F0766}");
	assert.equal(I.usageIcon(50), String.fromCodePoint(0xf0a9d + 4));
	assert.equal(I.usageIcon(100), String.fromCodePoint(0xf0a9d + 8));
	assert.equal(I.usageIcon(undefined), "\u{F0766}");
	process.env.PI_HALO_ICONS = "plain";
	for (const p of [0, 13, 50, 100, undefined]) assert.equal(I.usageIcon(p), I.ICONS.usage.plain);
	assert.equal(visibleWidth(I.usageIcon(50)), 1, "the slot keeps its column");
});

test("resolveIcon: pairs pick their side; a bare string loses private-use characters without a Nerd Font", () => {
	process.env.PI_HALO_ICONS = "nerd";
	assert.equal(I.resolveIcon("\u{F0B58}"), "\u{F0B58}");
	assert.equal(I.resolveIcon({ nerd: "\u{F0B58}", plain: "G" }), "\u{F0B58}");
	process.env.PI_HALO_ICONS = "plain";
	assert.equal(I.resolveIcon("\u{F0B58}"), undefined, "a lone private-use glyph is dropped");
	assert.equal(I.resolveIcon("\u{F0B58} "), undefined, "so is one followed by a blank");
	assert.equal(I.resolveIcon("\u{F0B58}x"), "x", "other characters stay");
	assert.equal(I.resolveIcon("G"), "G");
	assert.equal(I.resolveIcon({ nerd: "\u{F0B58}", plain: "G" }), "G");
	assert.equal(I.resolveIcon({ nerd: "\u{F0B58}" }), undefined, "no plain twin, no icon");
	assert.equal(I.resolveIcon(undefined), undefined);
	assert.equal(I.resolveIcon(""), undefined);
});

test("safeGlyph keeps a brand's own glyph with a Nerd Font and swaps it for a dot without one", () => {
	process.env.PI_HALO_ICONS = "nerd";
	assert.equal(I.safeGlyph("\u{E00B}"), "\u{E00B}");
	process.env.PI_HALO_ICONS = "plain";
	assert.equal(I.safeGlyph("\u{E00B}"), "\u25CF");
	assert.equal(I.safeGlyph("A"), "A", "a plain letter is kept");
	assert.equal(I.safeGlyph("\u{E00B}", "*"), "*");
});

// ---- the UI in the plain set ---------------------------------------------------------------------

/** Every string the UI draws in the plain set must be free of private-use characters. */
function noPrivateUse(label: string, text: string) {
	assert.ok(!PUA.test(text), `${label}: a private-use glyph in ${JSON.stringify(strip(text).slice(0, 120))}`);
}

function stateWith(extra: Record<string, unknown> = {}) {
	const state = createState();
	state.ctx = {
		cwd: "/work/project",
		model: { id: "m", name: "Model X", provider: "acme" },
		modelRegistry: { getProviderDisplayName: () => "Acme" },
		getContextUsage: () => ({ percent: 40, tokens: 40_000, contextWindow: 100_000 }),
		sessionManager: { getSessionName: () => "s", getBranch: () => [] },
		...extra,
	} as any;
	state.git = { branch: "feature-x", dirty: 2, ahead: 1, behind: 0 } as any;
	state.statuses = () => new Map([["lsp", "idle"], ["graphify", "ready"]]);
	return state;
}

test("plain set: the sidebar, footer, pill, tool rows and telemetry contain no private-use glyph", () => {
	process.env.PI_HALO_ICONS = "plain";
	const reg = api.getRegistry();
	for (const e of reg.widgets.values()) if (e.timer) clearInterval(e.timer);
	reg.widgets.clear();
	// Built-in widgets, with their real icons.
	const pi = { on: () => () => {}, events: { on: () => () => {} } } as any;
	return Promise.all([
		import("../extensions/widgets/aws/index.ts"),
		import("../extensions/widgets/container/index.ts"),
		import("../extensions/widgets/mcp/index.ts"),
		import("../extensions/widgets/session-todos/index.ts"),
		import("../extensions/widgets/subagents/index.ts"),
		import("../extensions/widgets/todo/index.ts"),
	]).then((mods) => {
		for (const m of mods) m.default(pi);
		api.registerWidget(pi, { id: "lvl", title: "Lvl", render: () => ({ text: "x", level: "warn", icon: "\u{F0E0F}" }) });
		api.registerWidget(pi, { id: "sec", title: "Section", icon: "\u{F0B58}", sidebar: "section", render: () => ({ text: "2 running" }), detail: () => ["a"] });
		const state = stateWith();
		noPrivateUse("sidebar", renderSidebar(state, theme, 48, 40, "1.0.0").join("\n"));
		state.sidebarShown = () => false;
		noPrivateUse("footer", renderFooter(state, theme, { getGitBranch: () => "main", getExtensionStatuses: () => new Map([["lsp", "idle"]]) } as any, 150).join("\n"));
		noPrivateUse("pill", modePill(theme, "build") + modePill(theme, "plan"));
		noPrivateUse("telemetry", formatTelemetry({ tps: 40, ttftMs: 1000, totalMs: 4000, stallMs: 500, stallCount: 1, inputTokens: 100, outputTokens: 90, cacheReadTokens: 10, costUsd: 0.01 } as any, theme));
		for (const name of Object.keys(SPECS)) {
			const r = makeRenderers(SPECS[name]!, () => "/repo");
			const call = r.renderCall({ path: "a", command: "ls", pattern: "x", kind: "note", text: "t" }, theme, {}).render(80).join("\n");
			noPrivateUse(`tool ${name}`, call);
		}
	});
});

test("the plain set lays out like the nerd one: same row count, label column and width", () => {
	const reg = api.getRegistry();
	for (const e of reg.widgets.values()) if (e.timer) clearInterval(e.timer);
	reg.widgets.clear();
	const pi = { on: () => () => {}, events: { on: () => () => {} } } as any;
	api.registerWidget(pi, { id: "mcp", title: "MCP", render: () => ({ text: "3/3", level: "ok" }) });
	api.registerWidget(pi, { id: "ic", title: "Icon", icon: { nerd: "\u{F0B58}", plain: "G" }, render: () => ({ text: "v" }) });
	const col = (set: string) => {
		process.env.PI_HALO_ICONS = set;
		const lines = renderSidebar(stateWith(), theme, 48, 40, "1.0.0").map(strip);
		const at = (re: RegExp) => lines.find((l) => re.test(l))!;
		// Columns in cells, not string indexes: a Nerd glyph is two UTF-16 units but one cell.
		const cell = (l: string, needle: string) => visibleWidth(l.slice(0, l.indexOf(needle)));
		return { n: lines.length, widths: lines.map((l) => visibleWidth(l)), mcp: cell(at(/MCP/), "MCP"), ic: cell(at(/Icon/), "Icon"), val: cell(at(/ v\b/), "v") };
	};
	const nerd = col("nerd");
	const plain = col("plain");
	assert.equal(plain.n, nerd.n, "same number of rows");
	assert.deepEqual(plain.widths, nerd.widths, "every row the same width");
	assert.equal(plain.mcp, nerd.mcp, "the label column does not move");
	assert.equal(plain.ic, nerd.ic);
	assert.equal(plain.val, nerd.val);
});

test("the mode pill: half-block caps and just the label in the plain set, round caps and an icon in the nerd set", () => {
	process.env.PI_HALO_ICONS = "plain";
	assert.equal(strip(modePill(theme, "build")), "\u2590BUILD \u258C");
	assert.equal(strip(modePill(theme, "plan")), "\u2590PLAN \u258C");
	process.env.PI_HALO_ICONS = "nerd";
	assert.equal(strip(modePill(theme, "build")), "\u{E0B6}\u{F06A9} BUILD \u{E0B4}");
});

test("telemetry in the plain set has no leading icons and no stray spaces", () => {
	process.env.PI_HALO_ICONS = "plain";
	const line = formatTelemetry({ tps: 42.3, ttftMs: 1100, totalMs: 4800, stallMs: 0, stallCount: 0, inputTokens: 100, outputTokens: 90, cacheReadTokens: 0, costUsd: 0.031 } as any, theme);
	assert.equal(line, "42.3 tok/s · ttft 1.1s · 4.8s · ↑100 ↓90 · $0.031");
	assert.ok(!/^ | {2}/.test(line));
});

test("a tool row without an icon has no leading gap", () => {
	process.env.PI_HALO_ICONS = "plain";
	const r = makeRenderers(SPECS.read!, () => "/repo");
	const text = strip(r.renderCall({ path: "src/a.ts" }, theme, {}).render(80).join("\n"));
	assert.match(text, /^ \u2192 Read/, "one space of indent, the arrow, a space, the title");
	process.env.PI_HALO_ICONS = "nerd";
	assert.match(strip(r.renderCall({ path: "src/a.ts" }, theme, {}).render(80).join("\n")), /^ \u{F09EE} Read/u);
});

test("the AWS footer names the service in words when there is no logo", async () => {
	process.env.PI_HALO_ICONS = "plain";
	const reg = api.getRegistry();
	for (const e of reg.widgets.values()) if (e.timer) clearInterval(e.timer);
	reg.widgets.clear();
	process.env.AWS_ACCESS_KEY_ID = "ASIAIOSFODNN7EXAMPLE";
	process.env.AWS_REGION = "us-west-2";
	const { default: installAws } = await import("../extensions/widgets/aws/index.ts");
	installAws({ on: () => () => {}, events: { on: () => () => {} }, getSettings: () => ({}) } as any);
	await reg.widgets.get("aws")!.spec.update!(undefined as any);
	const state = stateWith();
	state.sidebarShown = () => false;
	const data = { getGitBranch: () => undefined, getExtensionStatuses: () => new Map() } as any;
	const foot = strip(renderFooter(state, theme, data, 200).join("\n"));
	assert.match(foot, /AWS \d{12}/, "the word takes the logo's place, one space before the account");
	assert.ok(!/AWS {2}\d{12}/.test(foot), "and there is no extra space for an overhang that is not there");
	// The footer right-aligns with padding, so look at the widget's own view for a stray space.
	const view = reg.widgets.get("aws")!.spec.render({ theme, ctx: undefined, width: 80 })!;
	assert.equal(I.resolveIcon(view.icon), undefined, "no icon in the plain set, not even a blank one");
	assert.equal(view.label, "AWS");
	process.env.PI_HALO_ICONS = "nerd";
	assert.match(strip(renderFooter(state, theme, data, 200).join("\n")), /\u{F0EF} {2}\d{12}/u, "with the logo: two spaces, as before");
	delete process.env.AWS_ACCESS_KEY_ID;
	delete process.env.AWS_REGION;
});

// ---- where the code points live ------------------------------------------------------------------

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((n) => {
		const p = join(dir, n);
		return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") ? [p] : [];
	});
}

test("Nerd Font code points appear in icons.ts and nowhere else in the extension code", () => {
	const root = join(import.meta.dirname, "..", "extensions");
	// Private-use escapes: BMP E000 to F8FF, or F0000 to FFFFF in braces. (\uFDD0 is a noncharacter, not an icon.)
	const escapes = /\\u\{?(?:[Ee][0-9A-Fa-f]{3}|[Ff][0-7][0-9A-Fa-f]{2}|[Ff]8[0-9A-Fa-f]{2})\}?|\\u\{[Ff][0-9A-Fa-f]{4}\}/;
	const offenders: string[] = [];
	for (const f of sources(root)) {
		if (f.endsWith(join("halo", "icons.ts"))) continue;
		readFileSync(f, "utf8").split("\n").forEach((line, i) => {
			if (/^\s*(\*|\/\/|\/\*)/.test(line)) return; // comments and docs may show a glyph
			if (PUA.test(line) || escapes.test(line)) offenders.push(`${f.slice(root.length + 1)}:${i + 1}`);
		});
	}
	assert.deepEqual(offenders, []);
});
