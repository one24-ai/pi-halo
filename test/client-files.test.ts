/**
 * The halo client can be loaded from its own files: client.ts needs brand.ts, provider.ts and
 * ../diff/host.ts beside it and nothing else. Its header says so, and this keeps the header true.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..", "extensions");
const FILES = ["halo/client.ts", "halo/brand.ts", "halo/provider.ts", "diff/host.ts"];

/** Value imports of a file: `import x from` and `export ... from`, not `import type` or `export type`. */
function valueImports(rel: string): string[] {
	const text = readFileSync(join(ROOT, rel), "utf8");
	return [...text.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+"(\.[^"]+)"/gm)].map((m) => m[1]!);
}

test("client.ts runs from a folder holding only the four files its header names", () => {
	const dir = mkdtempSync(join(tmpdir(), "halo-client-"));
	try {
		for (const f of FILES) {
			mkdirSync(join(dir, f, ".."), { recursive: true });
			cpSync(join(ROOT, f), join(dir, f));
		}
		const out = execFileSync(
			"node",
			["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", `const c = await import(${JSON.stringify(join(dir, "halo/client.ts"))}); console.log(["registerWidget","registerToolRows","registerBrand","registerProviderStatus","requestRender","addDiffAction","openDiff"].map((n) => typeof c[n]).join(","));`],
			{ encoding: "utf8", cwd: dir },
		);
		assert.equal(out.trim(), "function,function,function,function,function,function,function");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the header's list is the whole list: client.ts value-imports exactly brand, provider and diff/host", () => {
	assert.deepEqual(valueImports("halo/client.ts").sort(), ["../diff/host.ts", "./brand.ts", "./provider.ts"]);
	assert.deepEqual(valueImports("halo/brand.ts"), [], "brand.ts needs no other file");
	assert.deepEqual(valueImports("halo/provider.ts"), [], "provider.ts needs no other file");
	assert.deepEqual(valueImports("diff/host.ts"), [], "host.ts needs no other file");
	const header = readFileSync(join(ROOT, "halo/client.ts"), "utf8").split("*/")[0]!;
	for (const name of ["./brand.ts", "./provider.ts", "../diff/host.ts"]) assert.ok(header.includes(name), `the header names ${name}`);
});
