/**
 * Tool rows for other extensions' tools: registerToolRows (api.ts, client.ts and the raw globalThis
 * protocol) lets an extension have halo draw its tools' rows, with halo knowing no tool by name
 * except pi's built-in ones. Run with: pnpm test
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

process.env.PI_HALO_STATE = join(mkdtempSync(join(tmpdir(), "halo-")), "state.json");
// These tests check the Nerd Font glyphs; the plain set has its own tests in icons.test.ts.
process.env.PI_HALO_ICONS = "nerd";

const { visibleWidth } = await import("@earendil-works/pi-tui");
const api = await import("../extensions/halo/api.ts");
const client = await import("../extensions/halo/client.ts");
const { installToolRenderers, SPECS } = await import("../extensions/halo/tools.ts");

const REGISTRY = Symbol.for("pi-halo/registry");
const PENDING_TOOL_ROWS = Symbol.for("pi-halo/pendingToolRows");
const g = globalThis as unknown as Record<symbol, any>;

const strip = (s: string) => s.replace(/\x1b\[[0-9;:]*m/g, "");
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t, getColorMode: () => "truecolor" } as any;
const NASTY = "\x1b]52;c;ZXZpbA==\x07\x1b]0;pwned\x07\x1b[2J\u202eok\nnext\rline";
const DANGEROUS = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const isClean = (s: string) => !DANGEROUS.test(s.replace(/\x1b\[[0-9;:]*m/g, ""));

const ok = (text: string, details: any = {}) => ({ content: [{ type: "text", text }], details });

/** A spec for a tool no one in halo knows about. */
const deployRow = (extra: Partial<import("../extensions/halo/api.ts").ToolRowSpec> = {}) => ({
	icon: { nerd: "\u{F0AD}", plain: "#" },
	title: "Deploy",
	describe: (a: any, _cwd: string, t: any) => `${t.fg("muted", String(a?.env))} ${t.fg("text", String(a?.version))}`,
	summarize: (r: any, _a: any, t: any, err: boolean) => (err ? t.fg("error", "failed") : t.fg("success", String(r.details?.state ?? "done"))),
	expand: (r: any) => (r.content ?? []).map((c: any) => c.text ?? ""),
	...extra,
});

/** A pi stand-in that collects renderer resolvers, as the extension runner does. */
function fakePi() {
	const resolvers: any[] = [];
	const pi: any = { registerToolRenderer: (f: any) => resolvers.push(f), registerTool: () => assert.fail("no tools are registered") };
	return { pi, resolvers };
}

/** What pi would draw for a tool: the resolver chain with `base` as the tool's own renderers. */
function resolve(resolvers: any[], name: string, base?: any) {
	const next = (i: number): any => (i < resolvers.length ? resolvers[i](name, () => next(i + 1)) : base);
	return next(0);
}

/** The lines a finished call draws: call row first (as pi draws it), then the result. */
function draw(renderers: any, args: any, result: any, { expanded = false, isError = false, width = 100, state = {} as any } = {}) {
	const ctx: any = { args, state, cwd: "/repo", isError, invalidate() {} };
	const call = renderers.renderCall(args, theme, ctx);
	const callLines = call.render(width).map(strip); // drawn before the result arrives; the result then hides it
	const res = renderers.renderResult(result, { expanded, isPartial: false }, theme, ctx);
	return { call: callLines, result: res.render(width).map(strip) };
}

function reset(): void {
	const reg = api.getRegistry();
	reg.toolRows.length = 0;
	reg.apiVersion = undefined;
	reg.register = undefined;
	reg.toolRowsVersion = undefined;
	reg.registerToolRows = undefined;
	g[PENDING_TOOL_ROWS] = [];
}
beforeEach(reset);
afterEach(reset);

test("installHost announces the tool row capability on the registry", () => {
	api.installHost();
	const reg = g[REGISTRY];
	assert.equal(reg.toolRowsVersion, api.TOOL_ROWS_VERSION);
	assert.equal(typeof reg.registerToolRows, "function");
	assert.equal(reg.apiVersion, api.API_VERSION, "the widget contract is unchanged, so its version is too");
});

test("a registered spec draws its tool like a built-in row, and other tools fall through to next()", () => {
	api.installHost();
	const { pi, resolvers } = fakePi();
	installToolRenderers(pi);
	const sentinel = { renderCall() {}, renderResult() {} };
	assert.equal(resolve(resolvers, "deploy_status", sentinel), sentinel, "no spec yet: the tool's own renderers");
	const off = api.registerToolRows({ deploy_status: deployRow() });
	const got = resolve(resolvers, "deploy_status", sentinel);
	assert.ok(got && got !== sentinel);
	assert.equal(got.renderShell, "self");
	const { call, result } = draw(got, { env: "staging", version: "v42" }, ok("rolled out", { state: "live" }));
	assert.equal(call.length, 1);
	assert.ok(call[0]!.includes("\u{F0AD}") && call[0]!.includes("Deploy") && call[0]!.includes("staging") && call[0]!.includes("v42"), call[0]);
	assert.equal(result.length, 1);
	assert.ok(result[0]!.includes("live") && result[0]!.includes("Deploy"), result[0]);
	assert.equal(resolve(resolvers, "other_tool", sentinel), sentinel);
	off();
});

test("a spec is looked up when a call is drawn, so registering after halo installed its resolver works, and unregister takes effect", () => {
	api.installHost();
	const { pi, resolvers } = fakePi();
	installToolRenderers(pi);
	const sentinel = { renderCall() {}, renderResult() {} };
	const off = api.registerToolRows({ late_tool: deployRow() });
	assert.notEqual(resolve(resolvers, "late_tool", sentinel), sentinel);
	off();
	assert.equal(resolve(resolvers, "late_tool", sentinel), sentinel, "removed: back to the tool's own renderers");
	off(); // twice is harmless
	assert.equal(api.getRegistry().toolRows.length, 0);
});

test("the newest registration of a name wins and removing it brings back the one before", () => {
	api.installHost();
	const { pi, resolvers } = fakePi();
	installToolRenderers(pi);
	const first = api.registerToolRows({ t: deployRow({ title: "First" }) });
	const second = api.registerToolRows({ t: deployRow({ title: "Second" }) });
	const titleOf = () => draw(resolve(resolvers, "t"), { env: "e", version: "v" }, ok("x")).call[0]!;
	assert.ok(titleOf().includes("Second"));
	second();
	assert.ok(titleOf().includes("First"));
	first();
});

test("halo's own rows for the built-in tools win over a registered spec of the same name", () => {
	api.installHost();
	const { pi, resolvers } = fakePi();
	installToolRenderers(pi);
	const off = api.registerToolRows(Object.fromEntries(Object.keys(SPECS).map((n) => [n, deployRow({ title: "Hijacked" })])));
	for (const name of Object.keys(SPECS)) {
		const got = resolve(resolvers, name);
		const { call } = draw(got, { path: "a.ts", command: "ls", pattern: "x" }, ok("x"));
		assert.ok(!call.join("").includes("Hijacked"), `${name} keeps halo's row`);
	}
	off();
});

test("load order: rows registered through the client before halo loads are queued and taken over", () => {
	const off = client.registerToolRows({ early_tool: deployRow() });
	assert.equal(api.toolRowFor("early_tool"), undefined, "halo is not here yet");
	assert.equal(g[PENDING_TOOL_ROWS].length, 1);
	api.installHost();
	assert.equal(g[PENDING_TOOL_ROWS].length, 0);
	assert.ok(api.toolRowFor("early_tool"));
	off();
	assert.equal(api.toolRowFor("early_tool"), undefined, "the returned function controls the real registration");
});

test("load order: unregistered while queued, the rows never reach halo", () => {
	const off = client.registerToolRows({ gone_tool: deployRow() });
	off();
	assert.equal(g[PENDING_TOOL_ROWS].length, 0);
	api.installHost();
	assert.equal(api.toolRowFor("gone_tool"), undefined);
});

test("load order: halo first, the client registers straight into the registry", () => {
	api.installHost();
	const off = client.registerToolRows({ direct_tool: deployRow() });
	assert.ok(api.toolRowFor("direct_tool"));
	off();
	assert.equal(api.toolRowFor("direct_tool"), undefined);
});

test("a host that announces no tool row version is not called", () => {
	g[REGISTRY] ??= api.getRegistry();
	api.getRegistry().registerToolRows = () => assert.fail("must not be called without a toolRowsVersion");
	const off = client.registerToolRows({ x: deployRow() });
	assert.equal(g[PENDING_TOOL_ROWS].length, 1, "queued instead");
	off();
});

test("the raw protocol works without importing halo: check toolRowsVersion, call registerToolRows, or queue", () => {
	// What a package that does not depend on pi-halo does.
	const rows = { raw_tool: deployRow() };
	const host = (globalThis as any)[Symbol.for("pi-halo/registry")];
	let off: () => void;
	if (host && typeof host.toolRowsVersion === "number" && host.toolRowsVersion >= 1 && typeof host.registerToolRows === "function") {
		off = host.registerToolRows(rows);
	} else {
		const queue = ((globalThis as any)[Symbol.for("pi-halo/pendingToolRows")] ??= []);
		queue.push({ specs: rows, attach: (undo: () => void) => void (off = undo) });
		off = () => {};
	}
	api.installHost(); // halo loads after it
	assert.ok(api.toolRowFor("raw_tool"), "taken over from the queue");
	off!();
	assert.equal(api.toolRowFor("raw_tool"), undefined);
});

test("everything a spec returns is neutralised: icon, title, description, summary, expanded lines", () => {
	api.installHost();
	const { pi, resolvers } = fakePi();
	installToolRenderers(pi);
	api.registerToolRows({
		nasty_tool: {
			icon: { nerd: NASTY, plain: NASTY },
			title: NASTY,
			describe: () => NASTY,
			summarize: () => NASTY,
			expand: () => [NASTY, NASTY, `${NASTY}\n${NASTY}`],
		},
	});
	for (const isError of [false, true]) {
		for (const expanded of [false, true]) {
			const got = resolve(resolvers, "nasty_tool");
			const state: any = {};
			const ctx: any = { args: {}, state, cwd: "/repo", isError, invalidate() {} };
			const lines = [
				...got.renderCall({}, theme, ctx).render(100),
				...got.renderResult(ok(NASTY), { expanded, isPartial: false }, theme, ctx).render(100),
				...got.renderResult(ok(NASTY), { expanded, isPartial: true }, theme, { ...ctx, state: {} }).render(100),
			];
			for (const line of lines) {
				assert.ok(isClean(strip(line)), `error=${isError} expanded=${expanded}: ${JSON.stringify(strip(line))}`);
				assert.ok(!strip(line).includes("pwned") && !strip(line).includes("ZXZpbA"), "the sequences' payloads are gone");
				assert.ok(visibleWidth(line) <= 100, `width ${visibleWidth(line)}`);
			}
		}
	}
});

test("colour from the theme survives, and a long expanded list is cut", () => {
	api.installHost();
	const { pi, resolvers } = fakePi();
	installToolRenderers(pi);
	api.registerToolRows({ long_tool: deployRow({ expand: () => Array.from({ length: 300 }, (_, i) => `line ${i + 1}`) }) });
	const coloured = { ...theme, fg: (c: string, t: string) => `\x1b[3${c === "error" ? 1 : 2}m${t}\x1b[39m` };
	const got = resolve(resolvers, "long_tool");
	const ctx: any = { args: { env: "e", version: "v" }, state: {}, cwd: "/repo", isError: false, invalidate() {} };
	const row = got.renderResult(ok("x", { state: "live" }), { expanded: false, isPartial: false }, coloured, ctx).render(100);
	assert.ok(row.join("").includes("\x1b[32m"), "SGR colour from the theme is kept");
	const open = got.renderResult(ok("x"), { expanded: true, isPartial: false }, theme, { ...ctx, state: {} }).render(100).map(strip);
	assert.ok(open.some((l: string) => l.includes("line 120")) && !open.some((l: string) => l.includes("line 121")), "cut at 120 lines");
	assert.ok(open.some((l: string) => /… 180 more lines/.test(l)));
});

test("a running call shows the running marker, and rows fit a narrow terminal", () => {
	api.installHost();
	const { pi, resolvers } = fakePi();
	installToolRenderers(pi);
	api.registerToolRows({ w_tool: deployRow() });
	const got = resolve(resolvers, "w_tool");
	const ctx: any = { args: { env: "e".repeat(200), version: "v" }, state: {}, cwd: "/repo", isError: false, invalidate() {} };
	const running = got.renderResult(ok(""), { expanded: false, isPartial: true }, theme, ctx).render(80).map(strip);
	assert.ok(running.join("").includes("running…"));
	for (const w of [40, 60]) {
		for (const line of got.renderResult(ok("x"), { expanded: false, isPartial: false }, theme, { ...ctx, state: {} }).render(w)) {
			assert.ok(visibleWidth(line) <= w, `at ${w}: ${visibleWidth(line)}`);
		}
	}
});

test("a spec with no icon draws no glyph, and the plain icon set uses the plain side", () => {
	api.installHost();
	const { pi, resolvers } = fakePi();
	installToolRenderers(pi);
	api.registerToolRows({ bare_tool: deployRow({ icon: undefined }), pair_tool: deployRow() });
	const args = { env: "e", version: "v" };
	assert.ok(draw(resolve(resolvers, "bare_tool"), args, ok("x")).call[0]!.startsWith(" Deploy"), "starts at the title");
	process.env.PI_HALO_ICONS = "plain";
	try {
		const line = draw(resolve(resolvers, "pair_tool"), args, ok("x")).call[0]!;
		assert.ok(line.includes("# Deploy") && !line.includes("\u{F0AD}"), line);
	} finally {
		process.env.PI_HALO_ICONS = "nerd";
	}
});

test("a spec that throws falls back to the tool's own renderers, for the call and for the result", () => {
	api.installHost();
	const { pi, resolvers } = fakePi();
	installToolRenderers(pi);
	const own = {
		renderCall: () => ({ invalidate() {}, render: () => ["OWN CALL"] }),
		renderResult: () => ({ invalidate() {}, render: () => ["OWN RESULT"] }),
	};
	const boom = () => {
		throw new Error("boom");
	};
	api.registerToolRows({
		bad_call: deployRow({ describe: boom }),
		bad_result: deployRow({ summarize: boom }),
		bad_expand: deployRow({ expand: boom }),
		bad_shape: deployRow({ describe: undefined as any }),
	});

	// describe throws: the call and the result are both the tool's own.
	let got = resolve(resolvers, "bad_call", own);
	let ctx: any = { args: {}, state: {}, cwd: "/repo", isError: false, invalidate() {} };
	assert.deepEqual(got.renderCall({}, theme, ctx).render(80), ["OWN CALL"]);
	assert.deepEqual(got.renderResult(ok("x"), { expanded: false, isPartial: false }, theme, ctx).render(80), ["OWN RESULT"]);

	// summarize throws after the styled call row was drawn: that row is replaced by the tool's own call row.
	got = resolve(resolvers, "bad_result", own);
	ctx = { args: { env: "e", version: "v" }, state: {}, cwd: "/repo", isError: false, invalidate() {} };
	const styledCall = got.renderCall(ctx.args, theme, ctx);
	assert.ok(strip(styledCall.render(80).join("")).includes("Deploy"), "the call row is styled until the result fails");
	const result = got.renderResult(ok("x"), { expanded: false, isPartial: false }, theme, ctx);
	assert.deepEqual(styledCall.render(80), [], "the styled call row is hidden");
	assert.deepEqual(result.render(80), ["OWN CALL", "OWN RESULT"]);
	// The next frame of the same call goes straight to the tool's own renderers.
	assert.deepEqual(got.renderCall(ctx.args, theme, ctx).render(80), ["OWN CALL"]);
	assert.deepEqual(got.renderResult(ok("x"), { expanded: false, isPartial: false }, theme, ctx).render(80), ["OWN RESULT"]);

	// expand throws only when the row is opened.
	got = resolve(resolvers, "bad_expand", own);
	ctx = { args: { env: "e", version: "v" }, state: {}, cwd: "/repo", isError: false, invalidate() {} };
	got.renderCall(ctx.args, theme, ctx);
	assert.ok(got.renderResult(ok("x"), { expanded: false, isPartial: false }, theme, ctx).render(80).length > 0);
	assert.deepEqual(got.renderResult(ok("x"), { expanded: true, isPartial: false }, theme, ctx).render(80), ["OWN CALL", "OWN RESULT"]);

	// A spec that is not shaped like one is handled the same way.
	got = resolve(resolvers, "bad_shape", own);
	ctx = { args: {}, state: {}, cwd: "/repo", isError: false, invalidate() {} };
	assert.deepEqual(got.renderCall({}, theme, ctx).render(80), ["OWN CALL"]);
});

test("a spec that throws for a tool with no renderers of its own raises, so pi draws its plain fallback", () => {
	api.installHost();
	const { pi, resolvers } = fakePi();
	installToolRenderers(pi);
	api.registerToolRows({
		bad_tool: deployRow({
			describe: () => {
				throw new Error("boom");
			},
		}),
	});
	const got = resolve(resolvers, "bad_tool"); // nothing of its own
	const ctx: any = { args: {}, state: {}, cwd: "/repo", isError: false, invalidate() {} };
	assert.throws(() => got.renderCall({}, theme, ctx), /no renderer of its own/);
	assert.throws(() => got.renderResult(ok("x"), { expanded: false, isPartial: false }, theme, ctx), /no renderer of its own/);
});

test("entries that are not specs are ignored", () => {
	api.installHost();
	const off = api.registerToolRows({ ok_tool: deployRow(), nothing: undefined as any, text: "x" as any });
	assert.ok(api.toolRowFor("ok_tool"));
	assert.equal(api.toolRowFor("nothing"), undefined);
	assert.equal(api.toolRowFor("text"), undefined);
	off();
});

test("halo itself knows no extension's tools: SPECS holds only pi's built-in tools", () => {
	assert.deepEqual(Object.keys(SPECS).sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
});
