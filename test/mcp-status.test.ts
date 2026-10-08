/**
 * Run with:
 *   pnpm test
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { connectedServers, enabledServers, formatStatus, parseMcpServers, summarize } from "../extensions/widgets/mcp/status.ts";

const tool = (ns: string, exposure = "codemode") => ({ exposure, namespace: { name: ns } });

test("parseMcpServers tolerates missing, invalid and odd files", () => {
	assert.deepEqual(parseMcpServers(undefined), {});
	assert.deepEqual(parseMcpServers("{not json"), {});
	assert.deepEqual(parseMcpServers('{"mcpServers": []}'), {});
	assert.deepEqual(parseMcpServers('{"mcpServers": {"a": {"url": "x"}, "b": 3}}'), { a: { url: "x" } });
});

test("enabledServers skips disabled, project overrides global, mcp.json beats registered", () => {
	const names = enabledServers(
		{ "aws-knowledge": { url: "g" }, off: { url: "x", enabled: false }, shared: { url: "g" } },
		{ shared: { url: "p", enabled: false } },
		[
			{ name: "aws_knowledge", config: { url: "ext" } }, // same namespace as aws-knowledge
			{ name: "ext-only", config: { url: "e" } },
		],
	);
	assert.deepEqual(names, ["aws-knowledge", "ext-only"]);
});

test("connectedServers ignores hidden tools and matches -/_ namespaces", () => {
	const tools = [
		tool("mcp__aws_knowledge"),
		tool("mcp__gone", "hidden"),
		{ exposure: "direct" }, // built-in tool, no namespace
	];
	assert.deepEqual(connectedServers(["aws-knowledge", "gone", "never"], tools), ["aws-knowledge"]);
});

test("summarize and formatStatus", () => {
	assert.equal(summarize([], []), undefined);
	assert.deepEqual(summarize(["a"], ["a"]), { connected: 1, enabled: 1, level: "ok", pending: [] });
	const partial = summarize(["a", "b"], ["a"]);
	assert.equal(partial?.level, "partial");
	assert.deepEqual(partial?.pending, ["b"]);
	assert.equal(summarize(["a"], [])?.level, "down");
	assert.equal(formatStatus(partial!), "1/2");
});
