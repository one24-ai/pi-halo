/**
 * The finish alert (BEL and a title mark, no OS commands) and the portable home-directory helpers.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { alert, alertTitle, DEFAULT_ALERT_SECONDS, defaultAlert, describeAlert, loadAlert, parseAlertArg, plainTitle, runOutcome, saveAlert, shouldAlert } from "../extensions/halo/alert.ts";
import { homeRelative, lastSep } from "../extensions/halo/palette.ts";

const dir = mkdtempSync(join(tmpdir(), "halo-alert-"));

test("shouldAlert: only when on and the run lasted the threshold", () => {
	const s = { enabled: true, seconds: 30 };
	assert.equal(shouldAlert(s, 29_999), false);
	assert.equal(shouldAlert(s, 30_000), true);
	assert.equal(shouldAlert(s, 5 * 60_000), true);
	assert.equal(shouldAlert(s, undefined), false, "no duration, no alert");
	assert.equal(shouldAlert({ ...s, enabled: false }, 5 * 60_000), false);
	assert.equal(shouldAlert({ enabled: true, seconds: 0 }, 1), true, "0 seconds alerts on every run");
});

test("alert rings the bell and marks the title, nothing else", () => {
	const wrote: string[] = [];
	const titles: string[] = [];
	alert({ write: (d) => wrote.push(d), setTitle: (t) => titles.push(t) }, "finished", "π - repo");
	assert.deepEqual(wrote, ["\x07"]);
	assert.deepEqual(titles, ["✓ π - repo"]);
	assert.equal(alertTitle("failed", "π - repo"), "✗ π - repo");
	assert.equal(alertTitle("waiting", "π - repo"), "? π - repo");
});

test("plainTitle matches pi's own title and handles either path separator", () => {
	assert.equal(plainTitle("/home/u/git/repo"), "π - repo");
	assert.equal(plainTitle("C:\\Users\\u\\repo"), "π - repo");
	assert.equal(plainTitle("/home/u/git/repo/"), "π - repo");
	assert.equal(plainTitle("/x/repo", "fix bug"), "π - fix bug - repo");
});

test("runOutcome reads the last assistant message: error fails, abort is silent", () => {
	const user = { role: "user" };
	assert.equal(runOutcome([user, { role: "assistant", stopReason: "stop" }]), "finished");
	assert.equal(runOutcome([user, { role: "assistant", stopReason: "toolUse" }, { role: "toolResult" }]), "finished");
	assert.equal(runOutcome([user, { role: "assistant", stopReason: "error" }]), "failed");
	assert.equal(runOutcome([user, { role: "assistant", stopReason: "aborted" }]), "aborted");
	assert.equal(runOutcome([{ role: "assistant", stopReason: "error" }, { role: "assistant", stopReason: "stop" }]), "finished", "the last one counts");
	assert.equal(runOutcome([]), "finished");
	assert.equal(runOutcome(undefined), "finished");
});

test("parseAlertArg: on, off, seconds and minutes; anything else is rejected", () => {
	assert.deepEqual(parseAlertArg("off"), { enabled: false });
	assert.deepEqual(parseAlertArg(" ON "), { enabled: true });
	assert.deepEqual(parseAlertArg("45"), { enabled: true, seconds: 45 });
	assert.deepEqual(parseAlertArg("90s"), { enabled: true, seconds: 90 });
	assert.deepEqual(parseAlertArg("2m"), { enabled: true, seconds: 120 });
	assert.deepEqual(parseAlertArg("0.5m"), { enabled: true, seconds: 30 });
	for (const bad of ["", "soon", "-5", "5h", "1e3", "999999999"]) assert.equal(parseAlertArg(bad), undefined, bad);
});

test("settings: defaults, a round trip that keeps the file's other keys, and bad values fall back", () => {
	assert.deepEqual(loadAlert(join(dir, "missing.json")), defaultAlert());
	assert.equal(defaultAlert().seconds, DEFAULT_ALERT_SECONDS);

	const p = join(dir, "state.json");
	writeFileSync(p, JSON.stringify({ disabledWidgets: ["aws"] }));
	saveAlert({ enabled: false, seconds: 75 }, p);
	assert.deepEqual(loadAlert(p), { enabled: false, seconds: 75 });
	assert.deepEqual(JSON.parse(readFileSync(p, "utf8")).disabledWidgets, ["aws"], "other keys stay");

	writeFileSync(p, JSON.stringify({ alert: { enabled: "yes", seconds: -3 } }));
	assert.deepEqual(loadAlert(p), defaultAlert());
	writeFileSync(p, "{ not json");
	assert.deepEqual(loadAlert(p), defaultAlert());
	saveAlert({ enabled: true, seconds: 10 }, p); // overwrites a broken file instead of throwing
	assert.deepEqual(loadAlert(p), { enabled: true, seconds: 10 });
});

test("describeAlert", () => {
	assert.equal(describeAlert({ enabled: true, seconds: 30 }), "finish alert on (runs over 30s)");
	assert.equal(describeAlert({ enabled: false, seconds: 30 }), "finish alert off");
});

// ---- portable paths ----------------------------------------------------------------------------

function withHome<T>(home: string, f: () => T): T {
	const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	try {
		return f();
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

test("homeRelative: ~ for the home directory and what is under it, on either separator", () => {
	withHome("/home/u", () => {
		assert.equal(homeRelative("/home/u"), "~");
		assert.equal(homeRelative("/home/u/git/repo"), "~/git/repo");
		assert.equal(homeRelative("/home/u2/git"), "/home/u2/git", "a sibling with the same prefix is not under home");
		assert.equal(homeRelative("/etc"), "/etc");
		assert.equal(homeRelative("/home/u\\git"), "~\\git", "a backslash after home counts too");
	});
});

test("homeRelative follows os.homedir() when the other home variable is unset", () => {
	// On Windows homedir() reads USERPROFILE and HOME is often unset; on Unix it reads HOME. On Linux
	// the two are the same lookup, so this cannot catch a regression to reading HOME directly: it
	// only guards that case when the suite runs on Windows.
	withHome("/home/u", () => {
		if (process.platform === "win32") delete process.env.HOME;
		else delete process.env.USERPROFILE;
		assert.equal(homeRelative("/home/u/x"), "~/x");
	});
});

test("lastSep finds the last separator of either kind", () => {
	assert.equal(lastSep("~/git/repo"), 5);
	assert.equal(lastSep("C:\\Users\\u\\repo"), 10);
	assert.equal(lastSep("C:\\a/b\\c"), 6);
	assert.equal(lastSep("repo"), -1);
});
