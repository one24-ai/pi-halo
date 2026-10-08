/**
 * Run with:
 *   pnpm test
 *
 * Fixtures are real `status` RPC replies from pi-subagents 0.75.0 (fleet and asyncSnapshot only):
 * a background workflow with four running children, and one foreground child.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { asyncActiveFrom, elapsed, fmtCount, limitsLine, orderRows, parallelFrom, rowsFromStatus, shortModel, spawnedFrom, summary } from "../extensions/widgets/subagents/status.ts";

const fixture = (name: string) => JSON.parse(readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", `subagents-${name}.json`), "utf8"));

test("a background workflow shows its children, not the workflow row", () => {
	const rows = rowsFromStatus(fixture("status-workflow"));
	assert.deepEqual(
		rows.map((r) => [r.label, r.state, r.currentTool ?? null, r.foreground ?? false]),
		[
			["build-api", "running", "bash", false],
			["build-web", "running", "bash", false],
			["lint", "running", "bash", false],
			["test-unit", "running", "bash", false],
		],
	);
	assert.equal(summary(rows).text, "4 running");
});

test("a foreground child comes from the fleet DTO", () => {
	const rows = rowsFromStatus(fixture("status-foreground"));
	assert.equal(rows.length, 1);
	assert.equal(rows[0]!.label, "delegate");
	assert.equal(rows[0]!.foreground, true);
	assert.equal(rows[0]!.state, "running");
});

test("finished children keep their state and sort after running ones", () => {
	const data = {
		asyncSnapshot: {
			kind: "pi-subagents.async-status-snapshot",
			version: 1,
			runs: [
				{ kind: "subagent", label: "reviewer", state: "complete", startedAt: 1000, endedAt: 4000 },
				{ kind: "subagent", label: "scout", state: "failed", startedAt: 2000, endedAt: 5000 },
				{ kind: "subagent", label: "worker", state: "running", startedAt: 3000, activity: { currentTool: "edit" } },
				{ kind: "subagent", label: "next", state: "queued" },
			],
		},
		fleet: { version: 1, entries: [{ key: "fleet-1", agent: "worker", startedAt: 3000, tokens: {} }] },
	};
	const rows = orderRows(rowsFromStatus(data));
	assert.deepEqual(
		rows.map((r) => `${r.label}:${r.state}`),
		["worker:running", "next:queued", "scout:failed", "reviewer:done"],
	);
	assert.equal(rows[0]!.currentTool, "edit");
	assert.equal(summary(rows).text, "1 running · 1 queued · 1 done · 1 failed");
	assert.equal(elapsed(rows[3]!), "3s");
	assert.equal(elapsed(rows[1]!), "");
});

test("unknown or missing shapes give no rows instead of throwing", () => {
	assert.deepEqual(rowsFromStatus(undefined), []);
	assert.deepEqual(rowsFromStatus({ asyncSnapshot: { kind: "other", version: 1, runs: [{ label: "x" }] } }), []);
	assert.deepEqual(rowsFromStatus({ asyncSnapshot: { kind: "pi-subagents.async-status-snapshot", version: 2, runs: [{ label: "x" }] } }), []);
	assert.deepEqual(rowsFromStatus({ fleet: { version: 1, entries: [null, { agent: "workflow", startedAt: 1 }] } }), []);
});

test("background children borrow model and tokens from the matching fleet entry", () => {
	const rows = rowsFromStatus(fixture("status-workflow"));
	assert.deepEqual(
		rows.map((r) => [r.label, r.model, r.tokens]),
		[
			["build-api", "anthropic/claude-opus-5-5", 16147],
			["build-web", "anthropic/claude-opus-5-5", 16186],
			["lint", "anthropic/claude-opus-5-5", 16144],
			["test-unit", "anthropic/claude-opus-5-5", 16191],
		],
	);
});

test("a foreground child carries its model and tokens", () => {
	const rows = rowsFromStatus(fixture("status-foreground"));
	const fg = rows.find((r) => r.foreground);
	assert.equal(fg?.model, "claude-opus-5-5");
	assert.equal(fg?.tokens, 11942);
});

test("a fleet entry further than a second from a row is not paired with it", () => {
	const data = {
		asyncSnapshot: { kind: "pi-subagents.async-status-snapshot", version: 1, runs: [{ kind: "step", label: "a", state: "running", startedAt: 10_000 }] },
		fleet: { version: 1, entries: [{ agent: "x", model: "m/claude-z", startedAt: 20_000, tokens: { total: 5 } }] },
	};
	const [row] = rowsFromStatus(data);
	assert.equal(row?.model, undefined);
	assert.equal(row?.tokens, undefined);
});

test("two rows that started together each get a different entry", () => {
	const data = {
		asyncSnapshot: {
			kind: "pi-subagents.async-status-snapshot",
			version: 1,
			runs: [
				{ kind: "step", label: "a", state: "running", startedAt: 10_000 },
				{ kind: "step", label: "b", state: "running", startedAt: 10_010 },
			],
		},
		fleet: {
			version: 1,
			entries: [
				{ agent: "x", model: "m/one", startedAt: 10_002, tokens: { total: 1 } },
				{ agent: "x", model: "m/two", startedAt: 10_012, tokens: { total: 2 } },
			],
		},
	};
	assert.deepEqual(rowsFromStatus(data).map((r) => [r.label, r.model]), [["a", "m/one"], ["b", "m/two"]]);
});

test("model and token formatting", () => {
	assert.equal(shortModel("anthropic/claude-opus-5-5"), "opus-5-5");
	assert.equal(shortModel("claude-sonnet-5-5"), "sonnet-5-5");
	assert.equal(shortModel("gpt-5"), "gpt-5");
	assert.deepEqual([fmtCount(999), fmtCount(16147), fmtCount(1_200_000), fmtCount(2_000_000)], ["999", "16k", "1.2M", "2M"]);
});

test("limits: spawn budget, async capacity and the parallel cap", () => {
	assert.deepEqual(spawnedFrom({ details: { spawnBudget: { used: 3, limit: 12 } } }), { used: 3, limit: 12 });
	assert.deepEqual(spawnedFrom({ details: { spawnBudget: { used: 3, limit: null } } }), { used: 3, limit: null });
	assert.equal(spawnedFrom({ details: {} }), undefined);
	assert.equal(spawnedFrom(undefined), undefined);
	assert.deepEqual(asyncActiveFrom({ fleet: { topLevelAsyncCapacity: { used: 1, limit: 4 } } }), { used: 1, limit: 4 });
	assert.equal(asyncActiveFrom({ fleet: { topLevelAsyncCapacity: { used: 0, limit: 0 } } }), undefined, "limit 0 means no cap");
	assert.equal(parallelFrom('{"globalConcurrencyLimit": 4}'), 4);
	assert.equal(parallelFrom("{}"), 20);
	assert.equal(parallelFrom("not json"), 20);
	assert.equal(parallelFrom(undefined), 20);
	assert.equal(limitsLine({ spawned: { used: 3, limit: 12 }, parallel: 4 }), "3/12 spawned · max 4 parallel");
	assert.equal(limitsLine({ spawned: { used: 3, limit: null }, parallel: 4 }), "3 spawned · max 4 parallel");
	assert.equal(limitsLine({ spawned: { used: 3, limit: 12 }, asyncActive: { used: 1, limit: 4 }, parallel: 4 }), "3/12 spawned · 1/4 async");
	assert.equal(limitsLine({}), undefined);
});
