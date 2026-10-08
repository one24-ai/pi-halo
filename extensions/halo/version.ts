/** This package's own version, read once from its package.json (undefined if it can't be read). */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: { value: string | undefined } | undefined;

export function haloVersion(): string | undefined {
	if (cached) return cached.value;
	let value: string | undefined;
	try {
		const v = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8"))?.version;
		if (typeof v === "string" && v) value = v;
	} catch {
		// vendored without its package.json: show the pi version only
	}
	cached = { value };
	return value;
}
