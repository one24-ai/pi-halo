/**
 * A package that does not depend on pi-halo registers a widget and tool rows through the globals
 * alone: Symbol.for("pi-halo/registry") with an apiVersion check, then register(pi, spec, ctx) from
 * its session_start handler. Nothing here imports halo's client; the example in the README is this
 * code. Run with: pnpm test
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.PI_HALO_STATE = join(mkdtempSync(join(tmpdir(), "halo-")), "state.json");

const api = await import("../extensions/halo/api.ts");
const { renderSidebar } = await import("../extensions/halo/sidebar.ts");
const { createState } = await import("../extensions/halo/state.ts");

const strip = (s: string) => s.replace(/\x1b\[[0-9;:]*m/g, "");
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t, getColorMode: () => "truecolor" } as any;

/** A pi stand-in that records handlers so a test can fire session events. */
function fakePi() {
	const handlers = new Map<string, Array<(e: unknown, ctx: unknown) => unknown>>();
	return {
		on: (name: string, fn: (e: unknown, ctx: unknown) => unknown) => {
			(handlers.get(name) ?? handlers.set(name, []).get(name)!).push(fn);
			return () => {};
		},
		fire: async (name: string, ctx: unknown) => {
			for (const fn of [...(handlers.get(name) ?? [])]) await fn({}, ctx);
		},
	} as any;
}

function reset(): void {
	const reg = api.getRegistry();
	for (const e of reg.widgets.values()) if (e.timer) clearInterval(e.timer);
	reg.widgets.clear();
	reg.disabled.clear();
	reg.toolRows.length = 0;
	reg.ctx = undefined;
	reg.apiVersion = undefined;
	reg.register = undefined;
	reg.toolRowsVersion = undefined;
	reg.registerToolRows = undefined;
}

/**
 * The whole integration of a package that does not import pi-halo: nothing but globalThis. This is
 * the code shown in the README, with a recall widget as the example.
 */
function recallPackage(pi: any, saved: string[], clicked: string[]) {
	let recalled = { n: 2, of: 9, chars: 840, budget: 2000 };
	const state: { handle?: { refresh(): void; dispose(): void }; offRows?: () => void } = {};
	pi.on("session_start", async (_e: unknown, ctx: any) => {
		// All extensions have loaded now. Halo absent (or too old): show nothing.
		const host = (globalThis as any)[Symbol.for("pi-halo/registry")];
		if (!host || typeof host.register !== "function" || !(host.apiVersion >= 1)) return;
		state.handle?.dispose();
		state.handle = host.register(
			pi,
			{
				id: "recall",
				title: "Memory",
				sidebar: "section",
				slots: ["sidebar"],
				cacheKey: () => `${recalled.n}/${recalled.of}/${saved.join("|")}`,
				render: () => ({ text: `${recalled.n} of ${recalled.of} recalled, ${recalled.chars}/${recalled.budget} chars` }),
				detail: () => saved.map((s) => `#${s.split(":")[0]} ${s.split(":")[1]}`),
				onDetailClick: (index: number, c: any) => void clicked.push(`${saved[index]} via ${typeof c.ui.notify}`),
			},
			ctx,
		);
		if (typeof host.toolRowsVersion === "number" && host.toolRowsVersion >= 1) {
			state.offRows?.();
			state.offRows = host.registerToolRows({
				memory_search: { icon: "#", title: "Recall", describe: (a: any) => String(a?.query ?? "recent"), summarize: (r: any) => `${r.details?.count ?? 0} found` },
			});
		}
	});
	return { state, set: (r: typeof recalled) => (recalled = r) };
}

test("a package registers a section widget through the raw globals, from session_start, with the handler's ctx", async () => {
	reset();
	api.installHost();
	const saved = ["7:prefers pnpm", "8:no em dashes"];
	const clicked: string[] = [];
	const pi = fakePi();
	const pkg = recallPackage(pi, saved, clicked);
	const ctx: any = { cwd: "/repo", ui: { notify() {} } };
	await pi.fire("session_start", ctx);

	assert.deepEqual(api.widgetsFor("sidebar").map((w: any) => w.id), ["recall"]);
	const state = createState();
	state.ctx = ctx;
	const lines = renderSidebar(state, theme, 60, 30, "test").map(strip).join("\n");
	assert.match(lines, /Memory\s+2 of 9 recalled, 840\/2000 chars/);
	assert.match(lines, /#7 prefers pnpm/);
	assert.match(lines, /#8 no em dashes/);

	// Clicking a saved memory runs onDetailClick with its index and the ctx, which can open ctx.ui.
	assert.equal(await api.runWidgetClick("recall", 1, ctx), undefined);
	assert.deepEqual(clicked, ["8:no em dashes via function"]);

	// Changing what it shows: the cache key changes, and handle.refresh() repaints.
	saved.push("9:use the keyring");
	pkg.set({ n: 3, of: 10, chars: 900, budget: 2000 });
	pkg.state.handle!.refresh();
	const again = renderSidebar(state, theme, 60, 30, "test").map(strip).join("\n");
	assert.match(again, /3 of 10 recalled/);
	assert.match(again, /#9 use the keyring/);

	// A new session registers again under the same id: one widget, not two.
	await pi.fire("session_start", ctx);
	assert.equal(api.widgetsFor("sidebar").length, 1);
	pkg.state.handle!.dispose();
	assert.equal(api.widgetsFor("sidebar").length, 0);
	pkg.state.offRows?.();
});

test("the ctx passed to register starts the widget's first update even before halo has a session", async () => {
	reset();
	api.installHost();
	const host = (globalThis as any)[Symbol.for("pi-halo/registry")];
	let updates = 0;
	const ctx: any = { cwd: "/repo" };
	host.register(fakePi(), { id: "u", update: () => void updates++, render: () => ({ text: "x" }) }, ctx);
	assert.equal(updates, 1, "update ran with the given ctx");
	assert.equal(api.getRegistry().ctx, ctx);
	reset();
});

test("without halo the package registers nothing and does not fail", async () => {
	reset();
	delete (globalThis as any)[Symbol.for("pi-halo/registry")];
	const pi = fakePi();
	recallPackage(pi, [], []);
	await pi.fire("session_start", { cwd: "/repo", ui: {} });
	assert.equal((globalThis as any)[Symbol.for("pi-halo/registry")], undefined, "it did not create halo's registry");
	api.getRegistry(); // later tests expect it to exist
});

test("a halo with an older apiVersion is ignored, not called", async () => {
	reset();
	const reg = api.getRegistry();
	reg.apiVersion = 0;
	reg.register = () => assert.fail("must not be called");
	const pi = fakePi();
	recallPackage(pi, [], []);
	await pi.fire("session_start", { cwd: "/repo", ui: {} });
	reset();
});
