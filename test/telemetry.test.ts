/**
 * Turn telemetry: the run summary carries what the run really cost, and the line has icons.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { icon } from "../extensions/halo/icons.ts";
import { fmtCost, formatTelemetry, MIN_TPS_TOKENS, TELEMETRY_ICONS, TelemetryTracker, type Telemetry } from "../extensions/halo/telemetry.ts";

// These tests check the Nerd Font glyphs; the plain set has its own tests in icons.test.ts.
process.env.PI_HALO_ICONS = "nerd";

const strip = (s: string) => s.replace(/\x1b\[[0-9;:]*m/g, "");
const theme = { fg: (_c: string, t: string) => t } as any;

/** Run one agent run of `turns` turns through a tracker with a fake clock; each turn's message has `cost`. */
function run(costs: (number | undefined)[]): Telemetry | undefined {
	let now = 0;
	const tr = new TelemetryTracker(() => now);
	tr.handle({ type: "agent_start" });
	for (const cost of costs) {
		tr.handle({ type: "turn_start" });
		tr.handle({ type: "message_start", message: { role: "assistant" } });
		now += 500;
		tr.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });
		now += 500;
		const usage: any = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100 };
		if (cost !== undefined) usage.cost = { total: cost };
		tr.handle({ type: "message_end", message: { role: "assistant", usage } });
		tr.handle({ type: "turn_end" });
	}
	return tr.handle({ type: "agent_settled" });
}

test("the run's cost is the sum over its turns, not a rate", () => {
	const t = run([0.01, 0.02, 0.005])!;
	assert.ok(Math.abs(t.costUsd! - 0.035) < 1e-9, `summed, got ${t.costUsd}`);
	assert.ok(!("rateUsdPerMTokens" in t), "the per-million rate is gone");
});

test("no cost reported: null, so the line leaves it out", () => {
	assert.equal(run([undefined])!.costUsd, null);
	assert.equal(run([0])!.costUsd, null);
	const line = strip(formatTelemetry(run([undefined])!, theme));
	assert.ok(!line.includes("$"));
});

test("fmtCost: precision follows the size", () => {
	assert.equal(fmtCost(12.4), "$12.40");
	assert.equal(fmtCost(0.29), "$0.29");
	assert.equal(fmtCost(0.031), "$0.031");
	assert.equal(fmtCost(0.0042), "$0.004");
	assert.equal(fmtCost(0.0001), "<$0.001");
});

test("the line: an icon in front of speed, ttft and time, none before the tokens or the cost, the real cost, no /M figure", () => {
	const t: Telemetry = { tps: 42.3, ttftMs: 1100, totalMs: 4800, inputTokens: 2000, outputTokens: 1200, cacheReadTokens: 38000, stallMs: 0, stallCount: 0, costUsd: 0.031 };
	const line = strip(formatTelemetry(t, theme));
	assert.equal(line, `${icon(TELEMETRY_ICONS.speed)} 42.3 tok/s · ${icon(TELEMETRY_ICONS.ttft)} ttft 1.1s · ${icon(TELEMETRY_ICONS.total)} 4.8s · ↑40k (38k cached) ↓1.2k · $0.031`);
	assert.ok(!line.includes("/M"));
	assert.ok(!line.includes(icon(TELEMETRY_ICONS.stall)), "no stall, no stall icon");
});

test("the line: a stall is flagged in warning colour, and icons and separators are dim", () => {
	const seen: [string, string][] = [];
	const spy = { fg: (c: string, t: string) => (seen.push([c, t]), t) } as any;
	const t: Telemetry = { tps: null, ttftMs: 900, totalMs: 65_000, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, stallMs: 2500, stallCount: 2, costUsd: null };
	const line = formatTelemetry(t, spy);
	assert.ok(line.includes("1m 5s") && line.includes("stall 2× 2.5s"));
	assert.ok(!line.includes("tok/s"), "no speed to show");
	assert.ok(seen.some(([c, x]) => c === "warning" && x === icon(TELEMETRY_ICONS.stall)), "the stall icon is warning-coloured");
	assert.ok(seen.some(([c, x]) => c === "dim" && x === icon(TELEMETRY_ICONS.ttft)), "the other icons are dim");
	assert.ok(seen.some(([c, x]) => c === "dim" && x === " · "), "separators are dim");
});

test("the line: speed is shown from MIN_TPS_TOKENS output tokens up, and left out below that", () => {
	const base: Telemetry = { tps: 1.1, ttftMs: 800, totalMs: 1000, inputTokens: 7200, outputTokens: 1, cacheReadTokens: 0, stallMs: 0, stallCount: 0, costUsd: 0.001 };
	const short = strip(formatTelemetry(base, theme));
	assert.ok(!short.includes("tok/s") && !short.includes(icon(TELEMETRY_ICONS.speed)), "one token: no speed");
	assert.ok(short.startsWith(`${icon(TELEMETRY_ICONS.ttft)} ttft 0.8s`), "the line starts at ttft");
	assert.ok(!strip(formatTelemetry({ ...base, outputTokens: MIN_TPS_TOKENS - 1 }, theme)).includes("tok/s"), "just under the limit");
	assert.ok(strip(formatTelemetry({ ...base, tps: 30, outputTokens: MIN_TPS_TOKENS }, theme)).includes("30.0 tok/s"), "at the limit");
	assert.ok(!strip(formatTelemetry({ ...base, tps: null, outputTokens: 500 }, theme)).includes("tok/s"), "no measurable speed");
});
