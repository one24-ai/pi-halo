/**
 * The package's exports resolve to compiled JavaScript with type declarations, so a consumer can
 * import pi-halo from plain Node (no TypeScript loader) and type-check against it. Builds into a
 * temporary directory, then imports every export from there. Run with: pnpm test
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("every export points at dist JavaScript with a declaration file next to it", () => {
	for (const [name, target] of Object.entries<any>(pkg.exports)) {
		if (name === "./package.json") continue;
		assert.match(target.default, /^\.\/dist\/.+\.js$/, name);
		assert.equal(target.types, target.default.replace(/\.js$/, ".d.ts"), name);
		assert.ok(existsSync(join(root, target.default.replace("./dist/", "extensions/").replace(/\.js$/, ".ts"))), `${name} has a source file`);
	}
});

test("the build compiles, rewrites .ts imports, and every export loads in plain Node", async () => {
	const out = mkdtempSync(join(tmpdir(), "halo-build-"));
	const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
	execFileSync(process.execPath, [tsc, "-p", join(root, "tsconfig.build.json"), "--outDir", out], { cwd: root, stdio: "pipe" });
	for (const [name, target] of Object.entries<any>(pkg.exports)) {
		if (name === "./package.json") continue;
		const file = join(out, target.default.replace("./dist/", ""));
		const js = readFileSync(file, "utf8");
		assert.doesNotMatch(js, /^\s*(?:import|export)[^\n]*from\s+"\.[^"]*\.ts"/m, `${name}: relative imports are rewritten to .js`);
		assert.ok(existsSync(file.replace(/\.js$/, ".d.ts")), `${name}: declarations emitted`);
		const mod = await import(pathToFileURL(file).href);
		assert.ok(Object.keys(mod).length > 0, `${name} exports something`);
	}
});
