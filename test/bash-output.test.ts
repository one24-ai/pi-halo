/**
 * Run with:
 *   pnpm test
 *
 * Bash tool output on the one-line rows: pi's trailing notices are told apart from what the command
 * printed, output is cleaned for the screen, and long output is folded to its two ends.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { cleanLine, foldLines, formatWallTime, parseBashOutput } from "../extensions/halo/bash-output.ts";

const ok = { isError: false };
const failed = { isError: true };

test("a plain successful command: its lines, status ok", () => {
	const r = parseBashOutput("one\ntwo\nthree\n", ok);
	assert.deepEqual([r.lines, r.status, r.truncated, r.totalLines], [["one", "two", "three"], "ok", false, 3]);
});

test("no output: pi's placeholder is not counted as a line", () => {
	const r = parseBashOutput("(no output)", ok);
	assert.deepEqual([r.lines, r.totalLines], [[], 0]);
	assert.deepEqual(parseBashOutput("", ok).lines, []);
});

test("a failing command: the exit code comes off the end and is not an output line", () => {
	const r = parseBashOutput("one\nboom\n\n\nCommand exited with code 3", failed);
	assert.deepEqual([r.lines, r.status, r.exitCode], [["one", "boom"], "failed", 3]);
	assert.equal(parseBashOutput("Command exited with code 127", failed).lines.length, 0);
});

test("only the trailing position is read: output that mentions the words stays output", () => {
	// A successful command that prints pi's own phrases.
	const ok1 = parseBashOutput("Command exited with code 7\nCommand aborted\n", ok);
	assert.deepEqual([ok1.status, ok1.exitCode, ok1.lines], ["ok", undefined, ["Command exited with code 7", "Command aborted"]]);
	// A failing command whose output ends in a line that looks like a notice before the real one.
	const bad = parseBashOutput("Command exited with code 7\n\nCommand exited with code 1", failed);
	assert.deepEqual([bad.exitCode, bad.lines], [1, ["Command exited with code 7"]]);
	// Words in the middle of a line are never a notice.
	assert.equal(parseBashOutput("the worker finished, exit code 5 ignored\n", ok).status, "ok");
});

test("aborted, timed out and no-exit-code results", () => {
	assert.equal(parseBashOutput("partial\n\nCommand aborted", failed).status, "aborted");
	assert.deepEqual(parseBashOutput("partial\n\nCommand aborted", failed).lines, ["partial"]);
	const t = parseBashOutput("Command timed out after 1 seconds", failed);
	assert.deepEqual([t.status, t.timeoutSecs, t.lines], ["timeout", 1, []]);
	assert.equal(parseBashOutput("x\n\nCommand terminated without an exit code", failed).status, "no-exit");
	// An error with no recognised trailer (for example a thrown "aborted" message) still reads as failed.
	assert.equal(parseBashOutput("The operation was aborted", failed).status, "aborted");
	assert.equal(parseBashOutput("something odd", failed).status, "failed");
});

test("truncated output: the notice comes off, the full-output path and the real line count are kept", () => {
	const raw = "1001\n1002\n1003\n\n[Showing lines 1001-3000 of 3000. Full output: /tmp/pi-bash-abc.log]";
	const r = parseBashOutput(raw, { isError: false, truncation: { truncated: true, totalLines: 3000 }, fullOutputPath: "/tmp/pi-bash-abc.log" });
	assert.deepEqual([r.lines, r.truncated, r.totalLines, r.fullOutputPath], [["1001", "1002", "1003"], true, 3000, "/tmp/pi-bash-abc.log"]);
});

test("truncated and failed at once: both trailers are removed, in pi's order", () => {
	const raw = "a\nb\n\n[Showing lines 5-6 of 6. Full output: /tmp/x.log]\n\nCommand exited with code 2";
	const r = parseBashOutput(raw, { isError: true, truncation: { truncated: true, totalLines: 6 }, fullOutputPath: "/tmp/x.log" });
	assert.deepEqual([r.lines, r.exitCode, r.truncated, r.totalLines], [["a", "b"], 2, true, 6]);
});

test("a notice-looking line is only removed when pi says it truncated", () => {
	const line = "[Showing lines 1-2 of 9. Full output: /tmp/fake.log]";
	assert.deepEqual(parseBashOutput(`a\n${line}`, ok).lines, ["a", line]);
});

test("cleanLine: colour, cursor codes, titles and links are removed", () => {
	assert.equal(cleanLine("\x1b[1;32mPASS\x1b[0m src/a.ts"), "PASS src/a.ts");
	assert.equal(cleanLine("\x1b[2K\x1b[1Gready"), "ready");
	assert.equal(cleanLine("\x1b]0;window title\x07done"), "done");
	assert.equal(cleanLine("\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\"), "link");
	assert.equal(cleanLine("tab\there"), "tab  here");
	assert.equal(cleanLine("bell\x07 and nul\x00 gone"), "bell and nul gone");
});

test("cleanLine: a progress bar redrawn with carriage returns shows its last state", () => {
	assert.equal(cleanLine("\r\x1b[32m20%\x1b[0m\r\x1b[32m60%\x1b[0m\r\x1b[32m100%\x1b[0m"), "100%");
	assert.equal(cleanLine("downloading 10%\rdownloading 100%"), "downloading 100%");
	assert.equal(cleanLine("text\r"), "text", "a trailing CR (CRLF output) keeps the text");
	assert.equal(cleanLine(""), "");
});

test("cleaned lines have the width a terminal gives them (no escape codes left to miscount)", () => {
	const l = cleanLine("\x1b[31mred\x1b[0m\r\x1b[32mgreen text\x1b[0m");
	assert.equal(l, "green text");
	assert.equal(visibleWidth(l), 10);
});

test("foldLines keeps the ends and counts what it left out", () => {
	const ten = Array.from({ length: 10 }, (_, i) => `l${i}`);
	assert.deepEqual(foldLines(ten, 3, "head"), { shown: ["l0", "l1", "l2"], hidden: 7 });
	assert.deepEqual(foldLines(ten, 3, "tail"), { shown: ["l7", "l8", "l9"], hidden: 7 });
	assert.deepEqual(foldLines(ten, 10, "head"), { shown: ten, hidden: 0 });
	assert.deepEqual(foldLines([], 3, "tail"), { shown: [], hidden: 0 });
});

test("formatWallTime hides sub-second runs and formats the rest", () => {
	assert.equal(formatWallTime(0.4), undefined);
	assert.equal(formatWallTime(undefined), undefined);
	assert.equal(formatWallTime(Number.NaN), undefined);
	assert.equal(formatWallTime(2.14), "2.1s");
	assert.equal(formatWallTime(59.96), "60.0s");
	assert.equal(formatWallTime(125), "2m05s");
});

// ---- live output while a command runs ------------------------------------------------------------

import { LIVE_DELAY_MS, LIVE_TAIL_LINES, liveTail, liveVisible, liveWaitMs } from "../extensions/halo/bash-output.ts";

test("liveTail: the last lines so far, cleaned, with a count of the earlier ones", () => {
	const raw = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join("\n");
	assert.deepEqual(liveTail(raw), { lines: ["line 5", "line 6", "line 7", "line 8", "line 9"], earlier: 4 });
	assert.deepEqual(liveTail("a\nb\n"), { lines: ["a", "b"], earlier: 0 });
	assert.equal(LIVE_TAIL_LINES, 5);
});

test("liveTail: colour and progress redraws are cleaned, a trailing redraw escape adds no empty row", () => {
	assert.deepEqual(liveTail("\x1b[32mPASS\x1b[0m a\n\r10%\r50%\r90%\n").lines, ["PASS a", "90%"]);
	assert.deepEqual(liveTail("one\n\x1b[2K\x1b[1G").lines, ["one"]);
	assert.deepEqual(liveTail(""), { lines: [], earlier: 0 });
	assert.deepEqual(liveTail("\n\n"), { lines: [], earlier: 0 });
});

test("liveTail: nothing is removed from the end, because there is no status to strip yet", () => {
	assert.deepEqual(liveTail("x\nCommand exited with code 7").lines, ["x", "Command exited with code 7"]);
});

test("liveTail: pi's partial output is already cut to its last lines, and that is fine", () => {
	const raw = Array.from({ length: 2000 }, (_, i) => `bulk ${i + 1001}`).join("\n");
	const r = liveTail(raw);
	assert.deepEqual([r.lines.at(-1), r.earlier], ["bulk 3000", 1995]);
});

test("liveVisible: only after the delay, and only with something to show", () => {
	const t0 = 10_000;
	assert.equal(liveVisible(t0, t0 + LIVE_DELAY_MS - 1, true), false);
	assert.equal(liveVisible(t0, t0 + LIVE_DELAY_MS, true), true);
	assert.equal(liveVisible(t0, t0 + 60_000, false), false, "no output yet");
	assert.equal(liveVisible(undefined, t0, true), false, "never seen");
});

test("liveWaitMs: how long until a quiet row should look again", () => {
	assert.equal(liveWaitMs(1000, 1000), LIVE_DELAY_MS + 10);
	assert.equal(liveWaitMs(1000, 1300), LIVE_DELAY_MS - 300 + 10);
	assert.equal(liveWaitMs(1000, 9000), 10, "already overdue: look again at once");
	assert.equal(liveWaitMs(undefined, 1000), undefined);
});

// ---- the peek left under a finished row ----------------------------------------------------------

import { bashPeek, PEEK_LINES } from "../extensions/halo/bash-output.ts";

test("bashPeek: the last lines of a finished command, and how many are not shown", () => {
	const ten = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n");
	assert.deepEqual(bashPeek(parseBashOutput(ten, ok)), { lines: ["l8", "l9", "l10"], hidden: 7 });
	assert.equal(PEEK_LINES, 3);
	assert.deepEqual(bashPeek(parseBashOutput("a\nb", ok)), { lines: ["a", "b"], hidden: 0 });
	assert.deepEqual(bashPeek(parseBashOutput("", ok)), { lines: [], hidden: 0 });
});

test("bashPeek: an error at the end of a long failing run is what stays visible", () => {
	const raw = `${Array.from({ length: 30 }, (_, i) => `ok ${i + 1}`).join("\n")}\nFAIL: 2 of 31\n\nCommand exited with code 1`;
	const peek = bashPeek(parseBashOutput(raw, failed));
	assert.deepEqual(peek.lines, ["ok 30", "FAIL: 2 of 31"].length === 2 ? ["ok 29", "ok 30", "FAIL: 2 of 31"] : []);
	assert.equal(peek.hidden, 28);
});

test("bashPeek: lines pi cut from a huge output are counted as hidden", () => {
	const raw = `${Array.from({ length: 2000 }, (_, i) => `bulk ${i + 1001}`).join("\n")}\n\n[Showing lines 1001-3000 of 3000. Full output: /tmp/x.log]`;
	const out = parseBashOutput(raw, { isError: false, truncation: { truncated: true, totalLines: 3000 }, fullOutputPath: "/tmp/x.log" });
	const peek = bashPeek(out);
	assert.deepEqual([peek.lines.at(-1), peek.hidden], ["bulk 3000", 2997]);
});

// ---- very long lines ---------------------------------------------------------------------------

import { MAX_LINE_CHARS } from "../extensions/halo/bash-output.ts";

test("a line longer than the cap is cut with an ellipsis, by code points", () => {
	assert.equal(MAX_LINE_CHARS, 1000);
	const long = cleanLine("x".repeat(50_000));
	assert.equal([...long].length, MAX_LINE_CHARS);
	assert.ok(long.endsWith("…"));
	const emoji = cleanLine("😀".repeat(2000));
	assert.equal([...emoji].length, MAX_LINE_CHARS, "counted in code points");
	assert.ok(!emoji.includes("\ufffd"), "no half emoji");
	assert.equal(cleanLine("y".repeat(1000)), "y".repeat(1000), "exactly at the cap is untouched");
});

test("a minified blob among normal lines does not change the lines around it", () => {
	const r = parseBashOutput(`start\n${"z".repeat(50_000)}\nend`, ok);
	assert.deepEqual([r.lines.length, r.lines[0], r.lines[2]], [3, "start", "end"]);
	assert.equal([...r.lines[1]!].length, MAX_LINE_CHARS);
});
