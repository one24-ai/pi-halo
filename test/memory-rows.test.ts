/**
 * Memory tool rows: the memory extension's four tools are drawn like the built-in tools, through
 * pi.registerToolRenderer, with the memory extension left as it is.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { icon } from "../extensions/halo/icons.ts";
import { installToolRenderers, makeRenderers, SPECS, TOOL_ICONS } from "../extensions/halo/tools.ts";

// These tests check the Nerd Font glyphs; the plain set has its own tests in icons.test.ts.
process.env.PI_HALO_ICONS = "nerd";

const strip = (s: string) => s.replace(/\x1b\[[0-9;:]*m/g, "");
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t, getColorMode: () => "truecolor" } as any;
const MEMORY = ["memory_write", "memory_update", "memory_forget", "memory_search"];

/** The one row a finished memory call draws at this width. */
function row(name: string, args: any, result: any, { expanded = false, isError = false, width = 100 } = {}) {
	const r = makeRenderers(SPECS[name]!, () => "/repo");
	const ctx: any = { args, state: {}, cwd: "/repo", isError, invalidate() {} };
	return r.renderResult(result, { expanded, isPartial: false }, theme, ctx).render(width).map(strip);
}
const ok = (text: string, details: any = {}) => ({ content: [{ type: "text", text }], details });

test("all four memory tools have a spec with the brain icon", () => {
	for (const n of MEMORY) assert.equal(SPECS[n]!.icon, TOOL_ICONS.memory, n);
	assert.equal(icon(TOOL_ICONS.memory), "\u{F09D1}");
});

test("installToolRenderers registers one resolver that takes the memory tools and leaves the rest to next()", () => {
	const resolvers: any[] = [];
	const registered: any[] = [];
	const pi: any = { registerToolRenderer: (f: any) => resolvers.push(f), registerTool: (t: any) => registered.push(t) };
	installToolRenderers(pi);
	assert.equal(resolvers.length, 1);
	const sentinel = { renderCall() {}, renderResult() {} };
	for (const n of MEMORY) {
		const got = resolvers[0](n, () => sentinel);
		assert.ok(got && got !== sentinel, `${n} is drawn by halo`);
		assert.equal(got.renderShell, "self");
		assert.equal(typeof got.renderCall, "function");
		assert.equal(typeof got.renderResult, "function");
	}
	assert.equal(resolvers[0]("some_mcp_tool", () => sentinel), sentinel, "other tools fall through to next()");
	assert.equal(resolvers[0]("custom", () => undefined), undefined);
	assert.equal(registered.length, 0, "halo registers no tools at all");
});

test("memory_write: the kind and the start of the text, then the id", () => {
	const l = row("memory_write", { kind: "gotcha", text: "A project-level .pi/APPEND_SYSTEM.md fully replaces the global one" }, ok("Saved memory #7 [gotcha] ...", { id: 7 }));
	assert.equal(l.length, 1, "one quiet line");
	assert.ok(l[0]!.includes(icon(TOOL_ICONS.memory)) && l[0]!.includes("Remember") && l[0]!.includes("gotcha") && l[0]!.includes("A project-level"), l[0]);
	assert.ok(l[0]!.includes("#7 saved"), l[0]);
	const again = row("memory_write", { kind: "fact", text: "x" }, ok("Refreshed", { id: 7, deduplicated: true }));
	assert.ok(again[0]!.includes("#7 refreshed"));
});

test("memory_write: a long text is cut to one line and global is shown", () => {
	const l = row("memory_write", { kind: "fact", global: true, text: "word ".repeat(80) }, ok("Saved", { id: 1 }), { width: 160 });
	assert.equal(l.length, 1);
	assert.ok(l[0]!.includes("global") && l[0]!.includes("…"));
	assert.ok(!l[0]!.includes("word ".repeat(30)), "the text is clipped");
});

test("memory_update, memory_forget, memory_search: call and result", () => {
	const u = row("memory_update", { id: 12, text: "revised wording" }, ok("Updated memory #12", { id: 12 }));
	assert.ok(u[0]!.includes("Revise") && u[0]!.includes("#12") && u[0]!.includes("revised wording") && u[0]!.includes("updated") && (u[0]!.match(/#12/g) ?? []).length === 1, u[0]);
	const d = row("memory_forget", { id: 12, reason: "merged into #9" }, ok("Deleted memory #12.", { id: 12, deleted: true }));
	assert.ok(d[0]!.includes("Forget") && d[0]!.includes("merged into #9") && d[0]!.includes("deleted"), d[0]);
	const kept = row("memory_forget", { id: 12, reason: "x" }, ok("Kept memory #12: the user declined", { id: 12, deleted: false }));
	assert.ok(kept[0]!.includes("kept") && !kept[0]!.includes("deleted"));
	const s = row("memory_search", { query: "registry token", kinds: ["gotcha", "fact"] }, ok("#1 [fact] a\n#2 [fact] b", { count: 2, ids: [1, 2] }));
	assert.ok(s[0]!.includes("Recall") && s[0]!.includes('"registry token"') && s[0]!.includes("gotcha, fact") && s[0]!.includes("2 memories"), s[0]);
	assert.ok(row("memory_search", { query: "q" }, ok("x", { count: 1 }))[0]!.includes("1 memory"));
	assert.ok(row("memory_search", {}, ok("No matching memories.", { count: 0 }))[0]!.includes("recent"));
	assert.ok(row("memory_search", { query: "q" }, ok("No matching memories.", { count: 0 }))[0]!.includes("0 memories"));
});

test("expanded (ctrl+o): the saved memories as a preview, like other tools' output", () => {
	const text = Array.from({ length: 20 }, (_, i) => `#${i + 1} [fact] memory ${i + 1}`).join("\n");
	const l = row("memory_search", { query: "q" }, ok(text, { count: 20 }), { expanded: true });
	assert.ok(l.some((x) => x.includes("#1 [fact] memory 1")), "the list is there");
	assert.ok(l.some((x) => /… 8 more lines/.test(x)), "long lists fold like other previews");
});

test("an error shows its first line on the row", () => {
	const l = row("memory_update", { id: 99, text: "x" }, { content: [{ type: "text", text: "No memory #99 in project or global" }] }, { isError: true });
	assert.ok(l.join("\n").includes("No memory #99"), l.join("\n"));
});

test("rows fit a narrow terminal", () => {
	for (const n of MEMORY) {
		for (const w of [40, 60]) {
			const r = makeRenderers(SPECS[n]!, () => "/repo");
			const ctx: any = { args: { id: 1, kind: "fact", text: "t".repeat(200), query: "q".repeat(100), reason: "r".repeat(100) }, state: {}, cwd: "/repo", isError: false, invalidate() {} };
			for (const line of r.renderResult(ok("done", { id: 1, count: 1, deleted: true }), { expanded: false, isPartial: false }, theme, ctx).render(w)) {
				assert.ok(strip(line).length <= w + 4, `${n} at ${w}: ${strip(line).length}`);
			}
		}
	}
});
