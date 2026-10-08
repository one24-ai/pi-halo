/**
 * The on/off switch for the git commands, saved in halo's state file under `git: { enabled }`
 * next to the other halo settings. It is read on each use, so `/git off` takes effect at once and
 * in every running session. Anything missing or malformed means on.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { statePath } from "../halo/api.ts";

export function loadGitEnabled(path = statePath()): boolean {
	try {
		const enabled = JSON.parse(readFileSync(path, "utf8"))?.git?.enabled;
		return typeof enabled === "boolean" ? enabled : true;
	} catch {
		return true;
	}
}

/** Save into the state file, keeping its other keys. Returns false if it could not be written. */
export function saveGitEnabled(enabled: boolean, path = statePath()): boolean {
	try {
		let data: Record<string, unknown> = {};
		if (existsSync(path)) {
			try {
				data = JSON.parse(readFileSync(path, "utf8")) ?? {};
			} catch {
				data = {};
			}
		}
		data.git = { enabled };
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
		return true;
	} catch {
		return false;
	}
}
