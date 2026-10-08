/**
 * Cleaning for text that did not come from halo: tool arguments and results, widget values, session
 * names, directory names. A terminal acts on escape sequences in anything it is sent, so text that
 * can be influenced from outside (a file's contents, a branch name, a model's tool call) must not
 * reach it as it is: an OSC 52 sequence writes to the clipboard, OSC 0 and OSC 2 set the window
 * title, OSC 8 draws a link, a cursor-move CSI overdraws other rows, and bidi overrides reorder
 * what the reader sees.
 *
 * No imports, so every module (api.ts included) can use it without an import cycle. palette.ts
 * re-exports it.
 */

/** CSI: ESC [ or the 8-bit introducer, parameter bytes, intermediate bytes, one final byte. */
const CSI = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g;
/** OSC: titles, hyperlinks, clipboard. Ends at BEL, ST or the end of the text. */
const OSC = /(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?/g;
/** DCS, SOS, PM and APC strings, which run to ST. */
const STRING_SEQUENCE = /(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[^\x1b\x9c]*(?:\x1b\\|\x9c)?/g;
/** Any other ESC sequence: ESC, intermediate bytes, one final byte (or a bare ESC). */
const OTHER_ESCAPE = /\x1b[ -/]*[0-~]?/g;
/** Directional marks, embeddings and overrides, and isolates. */
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** C0 and C1 controls, DEL, and the Unicode line and paragraph separators. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
/** C0 and C1 controls except tab and newline. */
const CONTROL_KEEP_BREAKS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Stand-ins for SGR sequences kept while the rest is scrubbed (private-use, never in real text). */
const MARK_OPEN = "\uFDD0";
const MARK_CLOSE = "\uFDD1";

/**
 * `text` without escape sequences (CSI, OSC, DCS, APC and the rest) and without bidi controls.
 * Other characters, newlines and tabs included, stay. A stray ESC left where removing one sequence
 * joined the pieces of another is for the caller's control-character pass to remove.
 */
export function stripEscapes(text: string): string {
	return text.replace(CSI, "").replace(OSC, "").replace(STRING_SEQUENCE, "").replace(OTHER_ESCAPE, "").replace(BIDI, "");
}

const tidy = (s: string) => s.replace(/ {2,}/g, " ").trim();

function scrub(text: unknown, keepColor: boolean, finish: (s: string) => string): string {
	const sgr: string[] = [];
	let s = String(text ?? "");
	if (keepColor) {
		s = s.replace(/[\uFDD0\uFDD1]/g, "").replace(/\x1b\[[0-9;:]*m/g, (m) => `${MARK_OPEN}${sgr.push(m) - 1}${MARK_CLOSE}`);
	}
	s = finish(stripEscapes(s).replace(CONTROL, " "));
	if (sgr.length === 0) return s;
	return `${s.replace(/\uFDD0(\d+)\uFDD1/g, (_m, i: string) => sgr[Number(i)] ?? "")}\x1b[0m`;
}

/**
 * One line of plain text: escape sequences and bidi controls removed, every control character
 * (newline and tab included) turned into a space, runs of spaces collapsed, ends trimmed.
 */
export function sanitize(text: unknown): string {
	return scrub(text, false, tidy);
}

/** Like `sanitize`, but SGR colour and style sequences are kept (and followed by a reset). */
export function sanitizeKeepColor(text: unknown): string {
	return scrub(text, true, tidy);
}

/**
 * One line like `sanitize`, but spacing is left alone: for text where the spaces carry meaning
 * (aligned columns, indentation, a directory name). SGR sequences are kept with `keepColor`.
 */
export function scrubText(text: unknown, keepColor = false): string {
	return scrub(text, keepColor, (s) => s);
}

/**
 * Several lines of plain text: escape sequences, bidi controls and control characters removed,
 * carriage returns and line separators turned into line breaks. Tabs and line breaks stay, so
 * callers split on "\n" and decide what to do with a tab.
 */
export function sanitizeLines(text: unknown): string {
	return stripEscapes(String(text ?? ""))
		.replace(/\r\n?|[\u2028\u2029]/g, "\n")
		.replace(CONTROL_KEEP_BREAKS, "");
}
