/**
 * Run with:
 *   pnpm test
 *
 * The bash row while a command runs: nothing for the first half second, then the last lines of its
 * output under the call line, a self-scheduled redraw for a command that goes quiet, and a fold to
 * the usual summary when it finishes.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { LIVE_DELAY_MS } from "../extensions/halo/bash-output.ts";
import { makeRenderers, rowShape, SPECS } from "../extensions/halo/tools.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;:]*m/g, "");
const theme = {
	fg: (_c: string, t: string) => t,
	bold: (t: string) => t,
	bg: (_c: string, t: string) => t,
	getColorMode: () => "truecolor",
} as any;

const partial = (text: string) => ({ content: text ? [{ type: "text", text }] : [] });
const done = (text: string, isError = false) => ({ content: [{ type: "text", text }], isError });

/** One tool call's renderer, with pi's per-call state and an invalidate that counts its calls. */
function call(command = "make build") {
	const r = makeRenderers(SPECS.bash!, () => "/repo");
	const state: Record<string, unknown> = {};
	let invalidations = 0;
	const context = (isError = false) => ({ args: { command }, state, cwd: "/repo", isError, invalidate: () => void invalidations++ });
	return {
		state,
		invalidations: () => invalidations,
		running: (text: string, expanded = false) => r.renderResult(partial(text), { expanded, isPartial: true }, theme, context()),
		finished: (text: string, { isError = false, expanded = false } = {}) =>
			r.renderResult(done(text, isError), { expanded, isPartial: false }, theme, context(isError)),
	};
}

const lines = (c: { render: (w: number) => string[] }, width = 80) => c.render(width).map(strip);
/** The lines with text in them: the padding rows of a block are blank and not what these tests are about. */
const content = (c: { render: (w: number) => string[] }, width = 80) => lines(c, width).filter((l) => l.trim() !== "");

beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 }));
afterEach(() => mock.timers.reset());

test("a quick command never shows live output: the first half second is quiet", () => {
	const c = call();
	const first = lines(c.running("starting\n"));
	assert.equal(first.length, 1, "just the call line");
	assert.match(first[0]!, /running…/);
	mock.timers.tick(LIVE_DELAY_MS - 100);
	assert.equal(lines(c.running("starting\nstep 2\n")).length, 1, "still inside the delay");
});

test("after the delay the last five lines of output appear under the call line", () => {
	const c = call();
	c.running("l1\n");
	mock.timers.tick(LIVE_DELAY_MS);
	const out = content(c.running(Array.from({ length: 8 }, (_, i) => `l${i + 1}`).join("\n")));
	assert.match(out[0]!, /running…/);
	assert.deepEqual(out.slice(1).map((l) => l.trim()), ["… 3 earlier", "l4", "l5", "l6", "l7", "l8"]);
});

test("a progress bar redrawn with carriage returns shows its current state, and colour is cleaned", () => {
	const c = call();
	c.running("x\n");
	mock.timers.tick(LIVE_DELAY_MS);
	const out = content(c.running("\x1b[32mbuilding\x1b[0m\n\r 10%\r 60%\r 99%"));
	assert.deepEqual(out.slice(1).map((l) => l.trim()), ["building", "99%"]);
});

test("a command that prints once and goes quiet still gets its live output, by asking for a redraw", () => {
	const c = call();
	assert.equal(content(c.running("compiling…\n")).length, 1);
	assert.equal(c.invalidations(), 0);
	mock.timers.tick(LIVE_DELAY_MS + 20);
	assert.equal(c.invalidations(), 1, "one redraw was requested when the delay was up");
	assert.deepEqual(content(c.running("compiling…\n")).slice(1).map((l) => l.trim()), ["compiling…"]);
});

test("only one redraw is scheduled no matter how often it is rendered inside the delay", () => {
	const c = call();
	for (let i = 0; i < 20; i++) c.running("a\n");
	mock.timers.tick(LIVE_DELAY_MS + 20);
	assert.equal(c.invalidations(), 1);
});

test("no output yet means no redraw is scheduled and no body", () => {
	const c = call();
	assert.equal(lines(c.running("")).length, 1);
	mock.timers.tick(LIVE_DELAY_MS * 4);
	assert.equal(c.invalidations(), 0);
});

test("a command that finishes inside the delay never redraws late", () => {
	const c = call();
	c.running("fast\n");
	assert.equal(content(c.finished("fast\n")).length, 2, "the summary and its one line of output");
	mock.timers.tick(LIVE_DELAY_MS * 4);
	assert.equal(c.invalidations(), 0, "the pending timer was cancelled on completion");
});

test("when it finishes the live tail becomes the folded peek: summary on top, the last lines under it", () => {
	const c = call();
	c.running("l1\n");
	mock.timers.tick(LIVE_DELAY_MS);
	const live = content(c.running("l1\nl2\nl3\nl4\nl5\nl6\nl7\n"));
	assert.ok(live.length > 4);
	const fin = content(c.finished("l1\nl2\nl3\nl4\nl5\nl6\nl7\n"));
	assert.match(fin[0]!, /7 lines/);
	assert.doesNotMatch(fin[0]!, /running/);
	assert.deepEqual(fin.slice(1).map((l) => l.trim()), ["… 4 more lines · ctrl+o or click to expand", "l5", "l6", "l7"]);
});

test("a failure keeps its exit code on the folded row, and ctrl+o still shows the output", () => {
	const c = call();
	const fin = content(c.finished("ok 1\nFAILED\n\nCommand exited with code 2", { isError: true }));
	assert.match(fin[0]!, /exit 2/);
	const open = content(c.finished("ok 1\nFAILED\n\nCommand exited with code 2", { isError: true, expanded: true }));
	assert.deepEqual(open.slice(1).map((l) => l.trim()), ["ok 1", "FAILED"]);
});

test("expanded while running shows more of the live output, up to the final fold's length", () => {
	const c = call();
	c.running("a\n", true);
	mock.timers.tick(LIVE_DELAY_MS);
	const out = content(c.running(Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join("\n"), true));
	assert.equal(out.length, 1 + 1 + 20, "call line, one 'earlier' note, twenty lines");
	assert.equal(out.at(-1)!.trim(), "l30");
});

test("live rows stay inside the width they are given", () => {
	const c = call("a very long command line ".repeat(8));
	c.running("x\n");
	mock.timers.tick(LIVE_DELAY_MS);
	const row = c.running(`${"wide ".repeat(60)}\nshort`);
	for (const w of [20, 50, 120]) {
		for (const l of row.render(w)) assert.ok(visibleWidth(l) <= w, `${visibleWidth(l)} > ${w}: ${strip(l)}`);
	}
});

test("other tools are unaffected: they have no live body", () => {
	for (const name of ["read", "write", "edit", "grep", "find", "ls"]) assert.equal(SPECS[name]!.live, undefined, name);
});

// ---- OpenCode-style spacing: quiet inline rows and padded blocks ---------------------------------

const BG = "\x1b[48;2;18;18;18m";
/** Whether a rendered line carries the panel shade at its start. */
const shaded = (raw: string) => raw.includes("48;2;");

test("a bash call with nothing to show is a quiet inline row: one line, no shade", () => {
	const c = call("true");
	const out = c.finished("(no output)");
	const raw = out.render(80);
	assert.equal(raw.length, 1);
	assert.ok(!shaded(raw[0]!), "no background on an inline row");
	assert.match(strip(raw[0]!), /true/);
	assert.match(strip(raw[0]!), /done/);
});

test("a bash call with output is a padded block: blank shaded row above, between and below", () => {
	const c = call("echo hi");
	const raw = c.finished("hi\n").render(80);
	const plain = raw.map(strip);
	// pad, command, pad, output, pad
	assert.equal(raw.length, 5);
	assert.deepEqual(plain.map((l) => l.trim() === ""), [true, false, true, false, true]);
	assert.match(plain[1]!, /echo hi/);
	assert.match(plain[3]!, /hi/);
	assert.ok(raw.every(shaded), "every row of the block, including the padding, carries the shade");
});

test("padding rows are exactly the width given, so the shade is a clean rectangle", () => {
	const c = call("echo hi");
	for (const w of [20, 60, 120]) {
		for (const l of c.finished("hi\n").render(w)) assert.equal(visibleWidth(l), w, `${JSON.stringify(strip(l))} at ${w}`);
	}
});

test("a failed call with no output is still a shaded row, so the red exit code is seen", () => {
	const c = call("false");
	const raw = c.finished("\n\nCommand exited with code 1", { isError: true }).render(80);
	assert.ok(raw.some(shaded));
	assert.match(strip(raw.find((l) => /exit 1/.test(strip(l)))!), /exit 1/);
});



test("expanding a call that printed nothing shows that it printed nothing", () => {
	const c = call("true");
	const plain = c.finished("(no output)", { expanded: true }).render(80).map(strip);
	assert.ok(plain.some((l) => /true/.test(l)), "the command is still on its row");
	assert.ok(plain.some((l) => /\(no output\)/.test(l)), "expanded shows the note that there was no output");
});

test("other tools' finished rows are quiet inline rows; only bash makes a block", () => {
	for (const name of ["read", "grep", "find", "ls"]) {
		const r = makeRenderers(SPECS[name]!, () => "/repo");
		const ctx: any = { args: { path: "a.ts", pattern: "x" }, state: {}, cwd: "/repo", isError: false, invalidate() {} };
		const raw = r.renderResult({ content: [{ type: "text", text: "a\nb" }] }, { expanded: false, isPartial: false }, theme, ctx).render(80);
		assert.equal(raw.length, 1, name);
		assert.ok(!shaded(raw[0]!), `${name} is unshaded`);
	}
});

// ---- one shape per call: plain until there is something to show, then a block for good ------------

type Shape = "plain" | "block";
/** Classify what a render looks like, from its rows: any shaded row means a block or a bar. */
const shapeOf = (c: { render: (w: number) => string[] }): Shape => (c.render(80).some(shaded) ? "block" : "plain");

test("rowShape: plain until there is a body, an error or an expansion, then block (or bar)", () => {
	const base = { blockTool: true, hasBody: false, isError: false, expanded: false, sawBody: false };
	assert.equal(rowShape(base), "plain");
	assert.equal(rowShape({ ...base, hasBody: true }), "block");
	assert.equal(rowShape({ ...base, isError: true }), "block");
	assert.equal(rowShape({ ...base, sawBody: true }), "block", "once it showed output it stays a block");
	assert.equal(rowShape({ ...base, blockTool: false }), "plain");
	assert.equal(rowShape({ ...base, blockTool: false, hasBody: true }), "bar");
	assert.equal(rowShape({ ...base, blockTool: false, isError: true }), "bar");
});

test("the first frame of a call, before any result, is already a plain line", () => {
	const r = makeRenderers(SPECS.bash!, () => "/repo");
	const state: Record<string, unknown> = {};
	const row = r.renderCall({ command: "make build" }, theme, { state, cwd: "/repo" });
	const raw = row.render(80);
	assert.equal(raw.length, 1);
	assert.ok(!shaded(raw[0]!), "no shade on the first frame");
});

test("running with no output yet is a plain line: nothing to lose later", () => {
	const c = call();
	assert.equal(shapeOf(c.running("")), "plain");
	assert.equal(c.running("").render(80).length, 1);
	assert.match(strip(c.running("").render(80)[0]!), /running…/);
});

test("a command that finishes with no output never changes shape: plain, plain, plain", () => {
	const c = call("true");
	const shapes = [shapeOf(c.running("")), shapeOf(c.running("")), shapeOf(c.finished("(no output)"))];
	assert.deepEqual(shapes, ["plain", "plain", "plain"]);
});

test("a command with output changes shape once: plain while quiet, block from its first output", () => {
	const c = call();
	const seen: Shape[] = [];
	seen.push(shapeOf(c.running("")));
	seen.push(shapeOf(c.running("a\n"))); // inside the delay: still nothing shown
	mock.timers.tick(LIVE_DELAY_MS);
	seen.push(shapeOf(c.running("a\nb\n")));
	seen.push(shapeOf(c.running("a\nb\nc\n")));
	seen.push(shapeOf(c.finished("a\nb\nc\n")));
	seen.push(shapeOf(c.finished("a\nb\nc\n", { expanded: true })));
	assert.deepEqual(seen, ["plain", "plain", "block", "block", "block", "block"]);
	const changes = seen.filter((s, i) => i > 0 && s !== seen[i - 1]).length;
	assert.equal(changes, 1, "exactly one change of shape in the whole life of the call");
});

test("once a call has shown output it stays a block even if a later frame shows none", () => {
	const c = call();
	c.running("x\n");
	mock.timers.tick(LIVE_DELAY_MS);
	assert.equal(shapeOf(c.running("x\ny\n")), "block");
	// A frame with no visible body (an empty partial) must not drop back to a plain line.
	assert.equal(shapeOf(c.running("")), "block");
});

test("a command that fails with no output goes plain to block, showing its red exit code", () => {
	const c = call("false");
	assert.equal(shapeOf(c.running("")), "plain");
	const fin = c.finished("\n\nCommand exited with code 1", { isError: true });
	assert.equal(shapeOf(fin), "block");
	assert.ok(fin.render(80).map(strip).some((l) => /exit 1/.test(l)));
});

test("a quick command with output goes plain to block once, on the finished frame", () => {
	const c = call("echo hi");
	assert.deepEqual([shapeOf(c.running("")), shapeOf(c.finished("hi\n"))], ["plain", "block"]);
});

test("read, grep, find and ls are plain from the call row to the finished row", () => {
	for (const name of ["read", "grep", "find", "ls"]) {
		const r = makeRenderers(SPECS[name]!, () => "/repo");
		const state: Record<string, unknown> = {};
		const ctx: any = { args: { path: "a.ts", pattern: "x" }, state, cwd: "/repo", isError: false, invalidate() {} };
		const call0 = r.renderCall(ctx.args, theme, ctx).render(80);
		const running = r.renderResult({ content: [] }, { expanded: false, isPartial: true }, theme, ctx).render(80);
		const done = r.renderResult({ content: [{ type: "text", text: "a\nb" }] }, { expanded: false, isPartial: false }, theme, ctx).render(80);
		for (const [label, raw] of [["call", call0], ["running", running], ["done", done]] as const) {
			assert.equal(raw.length, 1, `${name} ${label}`);
			assert.ok(!shaded(raw[0]!), `${name} ${label} is unshaded`);
		}
	}
});

test("expanding a plain call that printed nothing turns it into a block (there is a note to show)", () => {
	const c = call("true");
	assert.equal(shapeOf(c.finished("(no output)")), "plain");
	assert.equal(shapeOf(c.finished("(no output)", { expanded: true })), "block");
});
