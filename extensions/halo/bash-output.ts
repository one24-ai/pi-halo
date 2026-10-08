/**
 * Bash tool output for the one-line tool rows: separate what pi appended to the text (exit status,
 * truncation notice) from what the command printed, clean the printed lines for the screen, and
 * fold them. Pure functions with no pi imports, so tests run standalone.
 *
 * pi adds its notices at the END of the text, after a blank line:
 *
 *     <output>
 *
 *     [Showing lines 1001-3000 of 3000. Full output: /tmp/pi-bash-x.log]      (only when truncated)
 *
 *     Command exited with code 3                                              (only on failure)
 *
 * Only that trailing position is read, so output that merely contains those words is never
 * mistaken for a notice.
 */

export type BashStatus = "ok" | "failed" | "aborted" | "timeout" | "no-exit";

/** How long a command runs before its live output appears under the row. */
export const LIVE_DELAY_MS = 500;
/** Lines of live output shown under a running row. */
export const LIVE_TAIL_LINES = 5;
/** Lines of a finished command's output left under its row until the row is expanded. */
export const PEEK_LINES = 3;

export interface BashOutput {
	/** What the command printed, cleaned for display, without pi's notices. */
	lines: string[];
	status: BashStatus;
	/** The exit code, when pi reported one. */
	exitCode?: number;
	timeoutSecs?: number;
	/** pi cut the output; `lines` holds only the part it kept (the end). */
	truncated: boolean;
	/** Lines the command printed, counting those pi cut. Equals `lines.length` when not truncated. */
	totalLines: number;
	fullOutputPath?: string;
}

export interface BashOutputHints {
	/** Whether pi reports this result as an error. */
	isError: boolean;
	/** `result.details.truncation` */
	truncation?: { truncated?: boolean; totalLines?: number };
	/** `result.details.fullOutputPath` */
	fullOutputPath?: string;
}

const EXIT = /^Command exited with code (-?\d+)$/;
const TIMEOUT = /^Command timed out after (\d+(?:\.\d+)?) seconds?$/;
const SHOWING = /^\[Showing .*Full output: (.+)\]$/;

const CSI = /\x1b\[[0-9;:?<=>]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
const OTHER_ESC = /\x1b[\s\S]?/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/**
 * One output line as plain text: every escape sequence removed (colour, cursor movement, titles,
 * hyperlinks), a progress line that was redrawn with carriage returns reduced to its last state,
 * tabs widened, other control characters dropped.
 */
export function cleanLine(line: string): string {
	const plain = line.replace(CSI, "").replace(OSC, "").replace(OTHER_ESC, "");
	const last = plain.split("\r").reverse().find((p) => p.trim() !== "") ?? "";
	const clean = last.replace(/\t/g, "  ").replace(CONTROL, "").replace(/\s+$/, "");
	return capLine(clean);
}

/** A line longer than this is cut, like OpenCode's character cap: no terminal shows more. */
export const MAX_LINE_CHARS = 1000;

function capLine(line: string): string {
	if (line.length <= MAX_LINE_CHARS) return line;
	// Cut by code points, so an emoji is never split in half.
	return `${[...line].slice(0, MAX_LINE_CHARS - 1).join("")}…`;
}

/** Split pi's bash result text into the command's output and the status pi attached. */
export function parseBashOutput(raw: string, hints: BashOutputHints): BashOutput {
	const all = raw.replace(/\r\n/g, "\n").split("\n");
	const dropBlankTail = () => {
		while (all.length && all[all.length - 1]!.trim() === "") all.pop();
	};
	dropBlankTail();

	let status: BashStatus = "ok";
	let exitCode: number | undefined;
	let timeoutSecs: number | undefined;
	if (hints.isError) {
		status = "failed";
		const last = all[all.length - 1] ?? "";
		let m: RegExpMatchArray | null;
		if ((m = last.match(EXIT))) {
			exitCode = Number(m[1]);
			all.pop();
		} else if (last === "Command aborted") {
			status = "aborted";
			all.pop();
		} else if ((m = last.match(TIMEOUT))) {
			status = "timeout";
			timeoutSecs = Number(m[1]);
			all.pop();
		} else if (last === "Command terminated without an exit code") {
			status = "no-exit";
			all.pop();
		} else if (/operation was aborted/i.test(raw)) {
			status = "aborted";
		}
		dropBlankTail();
	}

	let truncated = false;
	let fullOutputPath = hints.fullOutputPath;
	if (hints.truncation?.truncated) {
		truncated = true;
		const m = (all[all.length - 1] ?? "").match(SHOWING);
		if (m) {
			fullOutputPath = m[1];
			all.pop();
			dropBlankTail();
		}
	}

	// pi's placeholder for a command that printed nothing.
	if (all.length === 1 && all[0] === "(no output)") all.length = 0;

	const lines = all.map(cleanLine);
	const reported = hints.truncation?.totalLines;
	const totalLines = truncated && typeof reported === "number" && reported >= lines.length ? reported : lines.length;
	return { lines, status, exitCode, timeoutSecs, truncated, totalLines, fullOutputPath };
}

/** The first or last `keep` lines, and how many of the given lines were left out. */
export function foldLines(lines: string[], keep: number, from: "head" | "tail"): { shown: string[]; hidden: number } {
	if (lines.length <= keep) return { shown: lines, hidden: 0 };
	return { shown: from === "head" ? lines.slice(0, keep) : lines.slice(lines.length - keep), hidden: lines.length - keep };
}

/** "2.1s" for a run of a second or more, else undefined (a 0.0s tag is noise). */
export function formatWallTime(seconds: unknown): string | undefined {
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 1) return undefined;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const m = Math.floor(seconds / 60);
	return `${m}m${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}

/**
 * The live output of a command that is still running, from the partial result pi sends while it
 * runs (the text so far, cut to its last lines by pi). Returns the last `keep` lines, cleaned for
 * the screen, and how many earlier lines are not shown. There is no status to read yet, so nothing
 * is removed from the end: a line that looks like a notice is just a line.
 */
export function liveTail(raw: string, keep: number = LIVE_TAIL_LINES): { lines: string[]; earlier: number } {
	const all = raw.replace(/\r\n/g, "\n").split("\n");
	while (all.length && all[all.length - 1]!.trim() === "") all.pop();
	const lines = all.map(cleanLine);
	// A last line that cleans to nothing (a bare redraw escape) would show as an empty row.
	while (lines.length && lines[lines.length - 1] === "") lines.pop();
	const { shown, hidden } = foldLines(lines, keep, "tail");
	return { lines: shown, earlier: hidden };
}

/**
 * Whether a running row should show its live output yet: it has waited `LIVE_DELAY_MS` since it
 * first appeared, and there is something to show.
 */
export function liveVisible(firstSeenAt: number | undefined, now: number, hasOutput: boolean): boolean {
	return hasOutput && firstSeenAt !== undefined && now - firstSeenAt >= LIVE_DELAY_MS;
}

/** Milliseconds until a row that is not yet visible should look again, or undefined if it never will. */
export function liveWaitMs(firstSeenAt: number | undefined, now: number): number | undefined {
	if (firstSeenAt === undefined) return undefined;
	return Math.max(0, LIVE_DELAY_MS - (now - firstSeenAt)) + 10;
}

/**
 * What stays visible under a finished row: the last `keep` lines (an error is usually at the end),
 * and how many lines are not shown, counting those pi cut from a very long output.
 */
export function bashPeek(out: BashOutput, keep: number = PEEK_LINES): { lines: string[]; hidden: number } {
	const { shown } = foldLines(out.lines, keep, "tail");
	return { lines: shown, hidden: Math.max(0, out.totalLines - shown.length) };
}
