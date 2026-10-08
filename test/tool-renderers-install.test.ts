/**
 * Run with:
 *   pnpm test
 *
 * The built-in tools are restyled with a renderer resolver, not by registering them again, so pi's
 * own definitions, settings and active tool set stay as they are.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { installToolRenderers } from "../extensions/halo/tools.ts";

const BUILT_IN = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** A pi stand-in where registering a tool or reading settings fails, as they must not happen here. */
function strictPi() {
	const resolvers: any[] = [];
	const pi: any = {
		registerToolRenderer: (f: any) => resolvers.push(f),
		registerTool: (t: any) => assert.fail(`registerTool(${t?.name}) must not be called`),
		getSettings: () => assert.fail("getSettings() must not be called while the extension loads"),
	};
	return { pi, resolvers };
}

test("installToolRenderers draws every built-in tool through the resolver and registers no tool", () => {
	const { pi, resolvers } = strictPi();
	installToolRenderers(pi);
	assert.equal(resolvers.length, 1);
	const sentinel = { renderCall() {}, renderResult() {} };
	for (const name of BUILT_IN) {
		const got = resolvers[0](name, () => sentinel);
		assert.ok(got && got !== sentinel, `${name} is drawn by halo`);
		assert.equal(got.renderShell, "self", `${name} draws its own frame`);
		assert.equal(typeof got.renderCall, "function");
		assert.equal(typeof got.renderResult, "function");
		assert.equal(got.execute, undefined, `${name}: nothing but renderers, so pi's own tool runs it`);
		assert.equal(got.parameters, undefined);
	}
	assert.equal(resolvers[0]("powershell", () => sentinel), sentinel, "tools halo has no row for fall through");
});

test("tools.ts no longer re-registers the built-in tools or reads settings at load", () => {
	const src = readFileSync(new URL("../extensions/halo/tools.ts", import.meta.url), "utf8");
	assert.doesNotMatch(src, /\.registerTool\(/);
	assert.doesNotMatch(src, /getSettings/);
	assert.doesNotMatch(src, /create(Read|Bash|Edit|Write|Grep|Find|Ls)ToolDefinition/);
});
