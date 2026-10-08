/**
 * Run with:
 *   pnpm test
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.PI_HALO_STATE = join(mkdtempSync(join(tmpdir(), "halo-")), "state.json");

const api = await import("../extensions/halo/api.ts");

// Minimal ExtensionAPI: registerWidget only needs `on`.
const pi = { on: () => {} } as any;
const ctx = {} as any;
const rc = { theme: {} as any, ctx: undefined, width: 40 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fresh(): void {
	const reg = api.getRegistry();
	for (const e of reg.widgets.values()) if (e.timer) clearInterval(e.timer);
	reg.widgets.clear();
	reg.disabled.clear();
	reg.ctx = ctx;
}

test("a hung update times out, is reported, and does not stack", async () => {
	fresh();
	let calls = 0;
	const h = api.registerWidget(pi, {
		id: "hang",
		updateTimeoutMs: 30,
		update: () => {
			calls++;
			return new Promise<void>(() => {});
		},
		render: () => ({ text: "x" }),
	});
	assert.equal(calls, 1);
	h.refresh();
	h.refresh();
	assert.equal(calls, 1, "ticks are skipped while an update is in flight");
	assert.equal(api.widgetInfo()[0].inflight, true);
	await sleep(60);
	const info = api.widgetInfo()[0];
	assert.equal(info.inflight, false);
	assert.match(info.error?.message ?? "", /timed out/);
	h.refresh();
	assert.equal(calls, 2, "a new update may start after the timeout");
	h.dispose();
});

test("a late result after the timeout does not clear the error", async () => {
	fresh();
	let resolve!: () => void;
	api.registerWidget(pi, {
		id: "late",
		updateTimeoutMs: 20,
		update: () => new Promise<void>((r) => (resolve = r)),
		render: () => ({ text: "x" }),
	});
	await sleep(40);
	resolve();
	await sleep(5);
	assert.match(api.widgetError("late")?.message ?? "", /timed out/);
});

test("update errors are recorded and cleared by the next success", async () => {
	fresh();
	let fail = true;
	const h = api.registerWidget(pi, {
		id: "flaky",
		update: async () => {
			if (fail) throw new Error("boom\nsecond line");
		},
		render: () => ({ text: "x" }),
	});
	await sleep(5);
	assert.deepEqual([api.widgetError("flaky")?.phase, api.widgetError("flaky")?.message], ["update", "boom"]);
	fail = false;
	h.refresh();
	await sleep(5);
	assert.equal(api.widgetError("flaky"), undefined);
});

test("render and detail failures are contained and recorded", () => {
	fresh();
	api.registerWidget(pi, {
		id: "bad",
		render: () => {
			throw new Error("render broke");
		},
		detail: () => {
			throw new Error("detail broke");
		},
	});
	const spec = api.widgetsFor("sidebar")[0];
	assert.deepEqual(api.renderWidget(spec, rc), { text: "error", level: "error" });
	assert.equal(api.widgetError("bad")?.message, "render broke");
	assert.deepEqual(api.detailWidget(spec, rc), []);
	assert.equal(api.widgetError("bad")?.phase, "detail");
});

test("a render that recovers clears its error; hidden widgets stay hidden", () => {
	fresh();
	let broken = true;
	api.registerWidget(pi, {
		id: "r",
		render: () => {
			if (broken) throw new Error("x");
			return undefined;
		},
	});
	const spec = api.widgetsFor("sidebar")[0];
	api.renderWidget(spec, rc);
	assert.ok(api.widgetError("r"));
	broken = false;
	assert.equal(api.renderWidget(spec, rc), undefined);
	assert.equal(api.widgetError("r"), undefined);
});

test("disabling hides the widget, stops updates, and persists", () => {
	fresh();
	let calls = 0;
	const h = api.registerWidget(pi, { id: "d", update: () => void calls++, render: () => ({ text: "x" }) });
	assert.equal(calls, 1);
	assert.equal(api.setWidgetDisabled("d", true), true);
	assert.equal(api.widgetsFor("sidebar").length, 0);
	h.refresh();
	assert.equal(calls, 1, "no update while disabled");
	assert.deepEqual(JSON.parse(readFileSync(api.statePath(), "utf8")).disabledWidgets, ["d"]);
	assert.equal(api.setWidgetDisabled("d", false), true);
	assert.equal(api.widgetsFor("sidebar").length, 1);
	assert.equal(calls, 2, "enabling runs an update");
	assert.deepEqual(JSON.parse(readFileSync(api.statePath(), "utf8")).disabledWidgets, []);
	assert.equal(api.setWidgetDisabled("nope", true), false);
});

test("formatWidgetList summarises state", () => {
	const now = 100_000;
	const out = api.formatWidgetList(
		[
			{ id: "a", title: "A", slots: ["sidebar", "footer"], disabled: false, inflight: false, suspended: false, lastUpdateAt: now - 5000, lastDurationMs: 12 },
			{ id: "b", title: "B", slots: ["sidebar"], disabled: false, inflight: false, suspended: false, error: { phase: "update", message: "boom", at: now } },
			{ id: "c", title: "C", slots: ["footer"], disabled: true, inflight: false, suspended: false },
		],
		now,
	);
	assert.match(out, /a \[ok\] · sidebar\+footer · updated 5s ago · 12ms/);
	assert.match(out, /b \[error\].*update: boom/);
	assert.match(out, /c \[disabled\]/);
});

test("cacheKey: render and detail run once until the key, width, theme, ctx or version changes", () => {
	fresh();
	let renders = 0;
	let details = 0;
	let key = "a";
	api.registerWidget(pi, {
		id: "cached",
		cacheKey: () => key,
		render: () => (renders++, { text: "x" }),
		detail: () => (details++, ["l"]),
	});
	const spec = api.widgetsFor("sidebar")[0];
	const theme = {} as any;
	const c = { theme, ctx: undefined, width: 40 };
	for (let i = 0; i < 5; i++) {
		api.renderWidget(spec, c);
		api.detailWidget(spec, c);
	}
	assert.deepEqual([renders, details], [1, 1]);
	key = "b";
	api.renderWidget(spec, c);
	api.detailWidget(spec, c);
	assert.deepEqual([renders, details], [2, 2], "key change");
	api.renderWidget(spec, { ...c, width: 30 });
	assert.equal(renders, 3, "width change");
	api.renderWidget(spec, { ...c, width: 30, theme: {} as any });
	assert.equal(renders, 4, "theme change");
	api.getRegistry().version++;
	api.renderWidget(spec, { ...c, width: 30, theme: c.theme });
	assert.equal(renders, 5, "registry version change");
});

test("widgets without cacheKey render every time, and a throwing cacheKey only skips the cache", () => {
	fresh();
	let renders = 0;
	api.registerWidget(pi, { id: "plain", render: () => (renders++, { text: "x" }) });
	const spec = api.widgetsFor("sidebar")[0];
	api.renderWidget(spec, rc);
	api.renderWidget(spec, rc);
	assert.equal(renders, 2);
	let n = 0;
	api.registerWidget(pi, {
		id: "badkey",
		cacheKey: () => {
			throw new Error("k");
		},
		render: () => (n++, { text: "x" }),
	});
	const bad = api.widgetsFor("sidebar").find((w) => w.id === "badkey")!;
	api.renderWidget(bad, rc);
	api.renderWidget(bad, rc);
	assert.equal(n, 2);
	assert.equal(api.widgetError("badkey"), undefined);
});

test("a widget that renders slowly three times in a row is suspended until re-enabled", () => {
	fresh();
	const busy = (ms: number) => {
		const t = performance.now();
		while (performance.now() - t < ms);
	};
	let slow = true;
	api.registerWidget(pi, {
		id: "slow",
		render: () => {
			if (slow) busy(api.SLOW_RENDER_MS + 15);
			return { text: "x" };
		},
	});
	const spec = api.widgetsFor("sidebar")[0];
	api.renderWidget(spec, rc);
	api.renderWidget(spec, rc);
	assert.equal(api.widgetInfo()[0].suspended, false);
	api.renderWidget(spec, rc);
	assert.equal(api.widgetInfo()[0].suspended, true);
	assert.match(api.widgetError("slow")?.message ?? "", /suspended/);
	assert.deepEqual(api.renderWidget(spec, rc), { text: "suspended", level: "warn" });
	assert.deepEqual(api.detailWidget(spec, rc), []);
	slow = false;
	api.setWidgetDisabled("slow", false);
	assert.equal(api.widgetInfo()[0].suspended, false);
	assert.deepEqual(api.renderWidget(spec, rc), { text: "x" });
	assert.equal(api.widgetError("slow"), undefined);
});

test("a fast render resets the slow-strike count", () => {
	fresh();
	let ms = api.SLOW_RENDER_MS + 15;
	api.registerWidget(pi, {
		id: "mixed",
		render: () => {
			const t = performance.now();
			while (performance.now() - t < ms);
			return { text: "x" };
		},
	});
	const spec = api.widgetsFor("sidebar")[0];
	api.renderWidget(spec, rc);
	api.renderWidget(spec, rc);
	ms = 0;
	api.renderWidget(spec, rc);
	ms = api.SLOW_RENDER_MS + 15;
	api.renderWidget(spec, rc);
	api.renderWidget(spec, rc);
	assert.equal(api.widgetInfo()[0].suspended, false);
});
