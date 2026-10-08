/**
 * Run with:
 *   pnpm test
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.PI_HALO_STATE = join(mkdtempSync(join(tmpdir(), "halo-")), "state.json");

const api = await import("../extensions/halo/api.ts");
const client = await import("../extensions/halo/client.ts");

const REGISTRY = Symbol.for("pi-halo/registry");
const PENDING = Symbol.for("pi-halo/pending");
const g = globalThis as unknown as Record<symbol, any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A pi stand-in that records handlers so tests can fire session events. */
function fakePi() {
	const handlers = new Map<string, Array<(e: unknown, ctx: unknown) => unknown>>();
	return {
		on: (name: string, fn: (e: unknown, ctx: unknown) => unknown) => void (handlers.get(name) ?? handlers.set(name, []).get(name)!).push(fn),
		fire: async (name: string, ctx: unknown = {}) => {
			for (const fn of handlers.get(name) ?? []) await fn({}, ctx);
		},
	} as any;
}

function fakeCtx() {
	const statuses = new Map<string, string | undefined>();
	return { statuses, ui: { theme: {}, setStatus: (k: string, v?: string) => void statuses.set(k, v) } } as any;
}

function reset(): void {
	const reg = api.getRegistry();
	for (const e of reg.widgets.values()) if (e.timer) clearInterval(e.timer);
	reg.widgets.clear();
	reg.disabled.clear();
	reg.apiVersion = undefined;
	reg.register = undefined;
	g[PENDING] = [];
}

test("host loaded first: the client registers straight into the registry", () => {
	reset();
	api.installHost();
	assert.equal(api.getRegistry().apiVersion, api.API_VERSION);
	const h = client.registerWidget(fakePi(), { id: "ext", render: () => ({ text: "x" }) });
	assert.deepEqual(api.widgetsFor("sidebar").map((w: any) => w.id), ["ext"]);
	h.dispose();
	assert.equal(api.widgetsFor("sidebar").length, 0);
});

test("client first: the widget is queued, then taken over when the host loads", () => {
	reset();
	const h = client.registerWidget(fakePi(), { id: "early", render: () => ({ text: "x" }) });
	assert.equal(api.widgetsFor("sidebar").length, 0);
	assert.equal(g[PENDING].length, 1);
	api.installHost();
	assert.equal(g[PENDING].length, 0);
	assert.deepEqual(api.widgetsFor("sidebar").map((w: any) => w.id), ["early"]);
	h.dispose();
	assert.equal(api.widgetsFor("sidebar").length, 0, "the handle controls the real widget");
});

test("disposed before the host loads: it is removed again on takeover", () => {
	reset();
	const h = client.registerWidget(fakePi(), { id: "gone", render: () => ({ text: "x" }) });
	h.dispose();
	api.installHost();
	assert.equal(api.widgetsFor("sidebar").length, 0);
});

test("no host at session_start: falls back to setStatus and stops on shutdown", async () => {
	reset();
	const pi = fakePi();
	const ctx = fakeCtx();
	let n = 0;
	client.registerWidget(pi, {
		id: "plain",
		title: "Plain",
		update: () => void n++,
		render: () => ({ icon: "*", text: `n=${n}` }),
	});
	await pi.fire("session_start", ctx);
	await sleep(5);
	assert.equal(ctx.statuses.get("plain"), "* Plain n=1");
	assert.equal(g[PENDING].length, 0, "no longer waiting for a host");
	await pi.fire("session_shutdown", ctx);
	assert.equal(ctx.statuses.get("plain"), undefined);
});

test("fallback: a hidden view clears the status, a throwing render shows an error, and a hung update times out", async () => {
	reset();
	const pi = fakePi();
	const ctx = fakeCtx();
	client.registerWidget(pi, { id: "hidden", render: () => undefined });
	client.registerWidget(pi, {
		id: "boom",
		title: "Boom",
		render: () => {
			throw new Error("x");
		},
	});
	client.registerWidget(pi, {
		id: "hang",
		title: "Hang",
		updateTimeoutMs: 20,
		update: () => new Promise<void>(() => {}),
		render: () => ({ text: "still here" }),
	});
	await pi.fire("session_start", ctx);
	await sleep(50);
	assert.equal(ctx.statuses.get("hidden"), undefined);
	assert.equal(ctx.statuses.get("boom"), "Boom error");
	assert.equal(ctx.statuses.get("hang"), "Hang still here");
});

test("a host with an older API version is ignored and the fallback applies", async () => {
	reset();
	const reg = api.getRegistry();
	reg.apiVersion = 0;
	reg.register = () => {
		throw new Error("must not be used");
	};
	const pi = fakePi();
	const ctx = fakeCtx();
	client.registerWidget(pi, { id: "old", title: "Old", render: () => ({ text: "ok" }) });
	await pi.fire("session_start", ctx);
	await sleep(5);
	assert.equal(ctx.statuses.get("old"), "Old ok");
});

test("the registry symbol the client reads is the one api.ts writes", () => {
	assert.equal(g[REGISTRY], api.getRegistry());
});
