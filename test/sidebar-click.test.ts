/**
 * Clicking a detail line in the sidebar runs the widget's onDetailClick with that line's index.
 *
 * The clicks go through pi-tui's real fullscreen TUI (press and release reports), so the test also
 * covers the routing the layout relies on: only the sidebar leaf handles the mouse, so moving the
 * pointer over it must not re-render the transcript (see layout-mouse.test.ts for the root cause).
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Component, ScrollView, type Terminal, TuiAltScreen, VStack } from "@earendil-works/pi-tui";

process.env.PI_HALO_STATE = join(mkdtempSync(join(tmpdir(), "halo-")), "state.json");

const api = await import("../extensions/halo/api.ts");
const { installLayout } = await import("../extensions/halo/layout.ts");
const { renderSidebar } = await import("../extensions/halo/sidebar.ts");
const { createState } = await import("../extensions/halo/state.ts");

const COLS = 160;
const ROWS = 40;
const WIDTH = 42;

class FakeTerminal implements Terminal {
	onInput: (data: string) => void = () => {};
	start(onInput: (data: string) => void) {
		this.onInput = onInput;
	}
	stop() {}
	async drainInput() {}
	write() {}
	get columns() {
		return COLS;
	}
	get rows() {
		return ROWS;
	}
	get kittyProtocolActive() {
		return false;
	}
	moveBy() {}
	hideCursor() {}
	showCursor() {}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle() {}
	setProgramStatus() {}
	setProgress() {}
}

const theme = new Proxy({}, { get: (_t, key) => (key === "getColorMode" ? () => "truecolor" : (...a: unknown[]) => String(a.at(-1) ?? "")) }) as never;

function reset() {
	const reg = api.getRegistry();
	for (const e of reg.widgets.values()) if (e.timer) clearInterval(e.timer);
	reg.widgets.clear();
	reg.disabled.clear();
	return reg;
}

/** A widget with a Files section of `lines`, recording the click indexes. */
function filesWidget(lines: string[], clicks: Array<number>, extra: Partial<Parameters<typeof api.registerWidget>[1]> = {}) {
	const pi = { on: () => () => {}, events: { on: () => () => {} } } as never;
	api.registerWidget(pi, {
		id: "files",
		title: "Files",
		slots: ["sidebar"],
		sidebar: "section",
		render: () => ({}),
		detail: () => lines,
		onDetailClick: (i) => void clicks.push(i),
		...extra,
	});
}

const sgr = (b: number, x: number, y: number, release: boolean) => `\x1b[<${b};${x};${y}${release ? "m" : "M"}`;
/** A left click at 0-based column x and row y. */
const clickAt = (term: FakeTerminal, x: number, y: number) => {
	term.onInput(sgr(0, x + 1, y + 1, false));
	term.onInput(sgr(0, x + 1, y + 1, true));
};

function harness(state = createState()) {
	const terminal = new FakeTerminal();
	const tui = new TuiAltScreen(terminal);
	const counter = { renders: 0 };
	const message: Component = {
		invalidate() {},
		render(width: number) {
			counter.renders++;
			return Array.from({ length: 5 }, (_, i) => `line ${i}`.padEnd(width));
		},
	};
	const transcript = new VStack(Array.from({ length: 200 }, () => message));
	const dock: Component = { invalidate() {}, render: (w) => ["> prompt".padEnd(w)] };
	tui.setLayoutRoot(
		new VStack([
			{ component: new ScrollView(transcript), basis: 0, grow: 1, shrink: 1 },
			{ component: dock, basis: "auto", grow: 0, shrink: 0 },
		]),
	);
	const notes: string[] = [];
	const ctx = {
		cwd: "/repo",
		ui: {
			setWidget: (_id: string, f?: (t: unknown, th: unknown) => Component) => void f?.(tui, theme),
			notify: (m: string) => notes.push(m),
		},
	} as never;
	state.ctx = ctx;
	const handle = installLayout(ctx, state, { width: WIDTH, minTerminalWidth: 110, piVersion: "test", home: () => false, tipIndex: 0 });
	tui.start();
	tui.renderNow();
	return { terminal, tui, state, handle, counter, notes, stop: () => (handle.dispose(), tui.stop()) };
}

/** The screen row and column of the first sidebar line containing `needle`, from a direct render. */
function rowOf(state: ReturnType<typeof createState>, needle: string): { x: number; y: number } {
	const lines = renderSidebar(state, theme, WIDTH, ROWS, "test");
	const y = lines.findIndex((l) => l.includes(needle));
	assert.ok(y >= 0, `no sidebar line with ${needle}`);
	return { x: COLS - WIDTH + 5, y };
}

test("clicking a detail line runs onDetailClick with its index, and only on a left click", () => {
	reset();
	const clicks: number[] = [];
	filesWidget(["alpha.ts", "beta.ts", "gamma.ts"], clicks);
	const h = harness();
	for (const [i, name] of ["alpha.ts", "beta.ts", "gamma.ts"].entries()) {
		const { x, y } = rowOf(h.state, name);
		clickAt(h.terminal, x, y);
		assert.equal(clicks.at(-1), i, name);
	}
	assert.deepEqual(clicks, [0, 1, 2]);

	// A right click, a wheel, and a click on the heading do nothing.
	const { x, y } = rowOf(h.state, "beta.ts");
	h.terminal.onInput(sgr(2, x + 1, y + 1, false));
	h.terminal.onInput(sgr(2, x + 1, y + 1, true));
	h.terminal.onInput(sgr(65, x + 1, y + 1, false));
	const head = rowOf(h.state, "Files");
	clickAt(h.terminal, head.x, head.y);
	assert.deepEqual(clicks, [0, 1, 2]);
	h.stop();
});

test("a press alone does not run the click, and a drag off the row cancels it", () => {
	reset();
	const clicks: number[] = [];
	filesWidget(["alpha.ts", "beta.ts"], clicks);
	const h = harness();
	const { x, y } = rowOf(h.state, "alpha.ts");
	h.terminal.onInput(sgr(0, x + 1, y + 1, false));
	assert.deepEqual(clicks, []);
	h.terminal.onInput(sgr(0, x + 1, y + 3, true)); // released two rows lower
	assert.deepEqual(clicks, []);
	h.stop();
});

test("a widget without onDetailClick, a disabled widget and a failing click are safe", async () => {
	reset();
	const clicks: number[] = [];
	filesWidget(["alpha.ts"], clicks, { onDetailClick: undefined });
	let h = harness();
	let p = rowOf(h.state, "alpha.ts");
	clickAt(h.terminal, p.x, p.y);
	assert.deepEqual(clicks, []);
	h.stop();

	reset();
	filesWidget(["alpha.ts"], clicks, {
		onDetailClick: () => {
			throw new Error("boom");
		},
	});
	h = harness();
	p = rowOf(h.state, "alpha.ts");
	clickAt(h.terminal, p.x, p.y);
	await new Promise((r) => setImmediate(r));
	assert.match(h.notes.join("\n"), /Files: click failed: boom/);
	assert.equal(api.widgetError("files")?.phase, "action");
	h.stop();

	// A widget switched off in /widgets is not drawn, so it has no rows to click.
	reset();
	filesWidget(["alpha.ts"], clicks);
	api.setWidgetDisabled("files", true);
	assert.equal(await api.runWidgetClick("files", 0, {} as never), undefined);
	assert.deepEqual(clicks, []);
});

test("the clickable rows are the detail lines of the widget, also for a row widget, and not cut-off ones", () => {
	reset();
	const pi = { on: () => () => {}, events: { on: () => () => {} } } as never;
	const seen: number[] = [];
	api.registerWidget(pi, { id: "row", title: "Row", slots: ["sidebar"], sidebar: "row", render: () => ({ text: "x" }), detail: () => ["d0", "d1"], onDetailClick: (i) => void seen.push(i) });
	filesWidget(["alpha.ts", "beta.ts"], []);
	const hits: any[] = [];
	const lines = renderSidebar(createState(), theme, WIDTH, ROWS, "test", hits);
	const rows = hits.map((h) => [h.widgetId, h.index, lines[h.y]!.replace(/\x1b\[[0-9;]*m/g, "").trim()]);
	assert.deepEqual(rows, [["row", 0, "d0"], ["row", 1, "d1"], ["files", 0, "alpha.ts"], ["files", 1, "beta.ts"]]);

	// The same array across renders (as the layout keeps it) holds only the latest render's rows.
	const again: any[] = [];
	renderSidebar(createState(), theme, WIDTH, ROWS, "test", again);
	const n = again.length;
	api.getRegistry().widgets.delete("row");
	renderSidebar(createState(), theme, WIDTH, ROWS, "test", again);
	assert.equal(n, 4);
	assert.equal(again.length, 2, "rows of a widget that is gone must not stay clickable");

	// A terminal too short for the whole body drops the hits of the lines it cuts.
	const short: any[] = [];
	renderSidebar(createState(), theme, WIDTH, 14, "test", short);
	assert.ok(short.length < hits.length, "cut-off rows must not stay clickable");
	for (const h of short) assert.ok(h.y < 14);
});

test("pointer moves and clicks over the sidebar do not re-render the transcript", () => {
	reset();
	filesWidget(["alpha.ts", "beta.ts"], []);
	const h = harness();
	const before = h.counter.renders;
	for (let i = 0; i < 60; i++) h.terminal.onInput(sgr(35, COLS - WIDTH + 3 + (i % 30), 2 + (i % 30), false));
	const p = rowOf(h.state, "beta.ts");
	for (let i = 0; i < 10; i++) clickAt(h.terminal, p.x, p.y);
	assert.ok(h.counter.renders - before < 200, `transcript re-rendered ${h.counter.renders - before} times`);
	h.stop();
});
