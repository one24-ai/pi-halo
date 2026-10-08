/**
 * The mode each user message was sent in, so the bar beside it keeps its colour when the mode
 * changes later: reading the modes from the session, and drawing the bar of a real pi component.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { drawsUserBox, userMessageModes } from "../extensions/halo/message-modes.ts";
import { installMessageStyle, LABEL_COLUMN, MIN_TEXT_WIDTH, modeOfUserBox, setChatContainer } from "../extensions/halo/messages.ts";
import { resetBrand, setBrand } from "../extensions/halo/brand.ts";
import { createState } from "../extensions/halo/state.ts";

initTheme("dark", false);

const strip = (s: string) => s.replace(/\x1b\[[0-9;:]*m/g, "");
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t, getColorMode: () => "truecolor", name: "t" } as any;

const user = (id: string, text: unknown = "hi") => ({ type: "message", id, message: { role: "user", content: text } });
const asst = (id: string) => ({ type: "message", id, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
const mode = (id: string, m: string) => ({ type: "custom", id, customType: "halo-mode", data: { mode: m } });
const ids = (...e: any[]) => new Set(e.map((x) => x.id));

test("userMessageModes: each user message takes the last mode switch before it, build when there is none", () => {
	const branch = [user("u1"), asst("a1"), mode("m1", "plan"), user("u2"), asst("a2"), mode("m2", "build"), user("u3"), mode("m3", "plan")];
	assert.deepEqual(userMessageModes(branch, ids(...branch)), ["build", "plan", "build"], "a switch after the last message changes nothing");
	assert.deepEqual(userMessageModes([], new Set()), []);
	assert.deepEqual(userMessageModes([mode("m", "plan"), user("u")], ids(user("u"))), ["plan"]);
});

test("userMessageModes: junk mode entries are ignored, and only messages pi draws are counted", () => {
	const branch = [mode("m1", "plan"), mode("m2", "banana"), user("u1"), user("u2", ""), user("u3", [{ type: "image" }]), user("u4", [{ type: "text", text: "a" }, { type: "text", text: "b" }]), asst("a1")];
	assert.deepEqual(userMessageModes(branch, ids(...branch)), ["plan", "plan"], "u1 and u4 have text, u2 and u3 do not");
});

test("userMessageModes: a message cut out by compaction is not counted, but its mode switches still are", () => {
	const old = user("u-old");
	const branch = [old, mode("m1", "plan"), user("u2"), mode("m2", "build"), user("u3")];
	assert.deepEqual(userMessageModes(branch, ids(user("u2"), user("u3"), mode("m1", "plan"))), ["plan", "build"]);
});

test("drawsUserBox: a skill block draws a box only when it carries a message of its own", () => {
	const skill = (extra: string) => `<skill name="x" location="/s">\nbody\n</skill>${extra}`;
	assert.equal(drawsUserBox({ role: "user", content: skill("") }), false);
	assert.equal(drawsUserBox({ role: "user", content: skill("\n\nplease do it") }), true);
	assert.equal(drawsUserBox({ role: "user", content: "plain" }), true);
	assert.equal(drawsUserBox({ role: "assistant", content: "x" }), false);
});

/** A chat with these user messages, a session holding them, and a state whose mode is `current`. */
function chat(entries: any[], current: "build" | "plan", opts: { boxes?: number } = {}) {
	const state = createState();
	state.mode = current;
	let leaf = "leaf-1";
	state.ctx = { sessionManager: { getLeafId: () => leaf, getBranch: () => entries, buildContextEntries: () => entries } } as any;
	const n = opts.boxes ?? entries.filter((e) => e.type === "message" && e.message.role === "user").length;
	const boxes = Array.from({ length: n }, (_, i) => new UserMessageComponent(`message ${i + 1}`));
	setChatContainer({ children: boxes });
	return { state, boxes, newLeaf: () => (leaf = `leaf-${Math.random()}`) };
}

test("a real user box keeps the colour of the mode it was sent in when the mode changes afterwards", () => {
	setBrand({ colors: { primary: "#2E7DDB", plan: "#8E5BD9" } });
	const { state, boxes } = chat([user("u1"), mode("m1", "plan"), user("u2"), mode("m2", "build")], "build");
	const undo = installMessageStyle(state, () => theme);
	try {
		const bar = (b: UserMessageComponent) => /\x1b\[38;2;(\d+;\d+;\d+)m┃/.exec(b.render(80).join("\n"))?.[1];
		assert.deepEqual(boxes.map(bar), ["46;125;219", "142;91;217"], "build is blue, plan is violet");
		state.mode = "plan"; // the user switches mode afterwards
		assert.deepEqual(boxes.map(bar), ["46;125;219", "142;91;217"], "nothing already sent changes colour");
		state.mode = "build";
		assert.deepEqual(boxes.map(bar), ["46;125;219", "142;91;217"]);
	} finally {
		undo();
		setChatContainer(undefined);
		resetBrand();
	}
});

test("modeOfUserBox: the first drawing gives a guess that is not final; a matched box is final and never changes", () => {
	const { state, boxes } = chat([user("u1"), mode("m1", "plan")], "plan", { boxes: 2 }); // the chat has one more box than the session
	const guess = modeOfUserBox(state, boxes[0]!);
	assert.deepEqual(guess, { mode: "plan", final: false }, "counts disagree: the mode it was first drawn in, not final");
	state.mode = "build";
	assert.deepEqual(modeOfUserBox(state, boxes[0]!), { mode: "plan", final: false }, "the guess itself does not drift with the state");
	const ok = chat([user("u1"), mode("m1", "plan"), user("u2")], "plan");
	assert.deepEqual(ok.boxes.map((b) => modeOfUserBox(ok.state, b)), [{ mode: "build", final: true }, { mode: "plan", final: true }]);
	ok.state.mode = "build";
	assert.deepEqual(modeOfUserBox(ok.state, ok.boxes[1]!), { mode: "plan", final: true }, "final answers stay");
	setChatContainer(undefined);
});

test("modeOfUserBox: with no chat found or no session, a box keeps the mode it was first drawn in", () => {
	const state = createState();
	state.mode = "plan";
	const box = new UserMessageComponent("x");
	setChatContainer(undefined);
	assert.deepEqual(modeOfUserBox(state, box), { mode: "plan", final: false });
	state.mode = "build";
	assert.deepEqual(modeOfUserBox(state, box), { mode: "plan", final: false }, "still the first mode");
	state.ctx = { sessionManager: { getLeafId() { throw new Error("stale"); } } } as any;
	assert.doesNotThrow(() => modeOfUserBox(state, box), "a stale session context is survived");
});

test("a new leaf refreshes the modes: a message added later gets its own mode, earlier ones keep theirs", () => {
	const entries: any[] = [user("u1")];
	const state = createState();
	state.mode = "build";
	let leaf = "l1";
	state.ctx = { sessionManager: { getLeafId: () => leaf, getBranch: () => entries, buildContextEntries: () => entries } } as any;
	const b1 = new UserMessageComponent("one");
	setChatContainer({ children: [b1] });
	assert.deepEqual(modeOfUserBox(state, b1), { mode: "build", final: true });
	entries.push(mode("m1", "plan"), user("u2"));
	leaf = "l2";
	const b2 = new UserMessageComponent("two");
	setChatContainer({ children: [b1, b2] });
	assert.deepEqual([modeOfUserBox(state, b1), modeOfUserBox(state, b2)], [{ mode: "build", final: true }, { mode: "plan", final: true }]);
	setChatContainer(undefined);
});

test("the bar is still one column and the text intact after the change", () => {
	const { state, boxes } = chat([user("u1")], "build");
	const undo = installMessageStyle(state, () => theme);
	try {
		// pi puts prompt-navigation markers (OSC 133) before the first and last line; they are not text.
		const lines = boxes[0]!.render(60).map((l) => strip(l).replace(/\x1b\][^\x07]*\x07/g, ""));
		assert.equal(lines.length, 3, "a blank row, the message, a blank row");
		assert.ok(lines.every((l) => l.startsWith("┃")), "every row has the bar in column one");
		assert.ok(lines[1]!.includes("message 1"));
	} finally {
		undo();
		setChatContainer(undefined);
	}
});

/** A box's rows as plain text, without the prompt-navigation markers pi puts on the first and last row. */
const plainRows = (b: UserMessageComponent, w: number) => b.render(w).map((l) => strip(l).replace(/\x1b\][^\x07]*\x07/g, ""));
const LONG = "This is a long message that needs to wrap onto several rows so the label column can be checked against the text that wraps before it.";

/** Two boxes, Build then Plan, with the given texts. */
function pair(texts: [string, string] = ["short", "short"]) {
	const entries = [user("u1"), mode("m1", "plan"), user("u2")];
	const state = createState();
	state.mode = "build";
	state.ctx = { sessionManager: { getLeafId: () => "leaf", getBranch: () => entries, buildContextEntries: () => entries } } as any;
	const boxes = texts.map((t) => new UserMessageComponent(t)) as [UserMessageComponent, UserMessageComponent];
	setChatContainer({ children: boxes });
	return { state, boxes };
}

test("a label column on the right: the word is centred vertically, right-aligned with a margin, and every row keeps the width", () => {
	setBrand({ colors: { primary: "#2E7DDB", plan: "#8E5BD9" } });
	const { state, boxes } = pair(["short", LONG]);
	const undo = installMessageStyle(state, () => theme);
	try {
		for (const w of [100, 70, 60, 50]) {
			for (const [box, word] of [[boxes[0], "Build"], [boxes[1], "Plan"]] as const) {
				const rows = plainRows(box, w);
				const at = rows.map((r, i) => (r.includes(word) ? i : -1)).filter((i) => i >= 0);
				assert.deepEqual(at, [Math.floor((rows.length - 1) / 2)], `${word} is on the middle row of ${rows.length} at ${w}`);
				for (const r of rows) assert.equal(visibleWidth(r), w, `every row is ${w} wide`);
				const r = rows[at[0]!]!;
				assert.ok(r.endsWith(`${word}  `), "two columns from the right edge");
				assert.ok(rows.every((x) => x.startsWith("┃")), "the bar is in column one of every row");
			}
		}
	} finally {
		undo();
		setChatContainer(undefined);
		resetBrand();
	}
});

test("the message wraps before the label column, at the same place in both modes, and never runs into the label", () => {
	const { state, boxes } = pair([LONG, LONG]);
	const undo = installMessageStyle(state, () => theme);
	try {
		for (const w of [100, 70, 60, 50]) {
			const [a, b] = [plainRows(boxes[0], w), plainRows(boxes[1], w)];
			const textOf = (rows: string[], word: string) => rows.map((r) => r.replace(/^┃/, "").replace(word, "").trimEnd());
			assert.deepEqual(textOf(a, "Build"), textOf(b, "Plan"), `the same wrapping in both modes at ${w}`);
			assert.ok(a.length > 3, `the long message wraps at ${w}`);
			assert.ok(![...a, ...b].some((r) => r.includes("…")), `nothing is cut off at ${w}: a row that is too long would end in an ellipsis`);
			const rejoined = (rows: string[], word: string) => rows.map((r) => r.replace(/^┃ {2}/, "").replace(new RegExp(`${word} {2}$`), "").trim()).filter(Boolean).join(" ");
			assert.equal(rejoined(a, "Build"), LONG, `the whole message is there, in order, at ${w}`);
			const textRoom = w - 1 - LABEL_COLUMN - 2; // box, label column, left indent
			// Without the label column pi fits more on a line, so the column is what makes it wrap earlier.
			const widest = (rows: string[]) => Math.max(...rows.map((r) => visibleWidth(r.replace(/^┃ {2}/, "").replace(/(Build|Plan) {2}$/, "").trimEnd())));
			assert.ok(widest(a) <= textRoom, `the widest text row (${widest(a)}) fits in ${textRoom} at ${w}`);
			const unlabelled = new UserMessageComponent(LONG).render(w - 1).map((l) => strip(l).replace(/\x1b\][^\x07]*\x07/g, "").trim());
			assert.ok(Math.max(...unlabelled.map((l) => visibleWidth(l))) > textRoom || w < 70, `without the column the text would run past ${textRoom} at ${w}`);
			for (const r of [...a, ...b]) {
				const body = r.replace(/^┃ {2}/, "").replace(/(Build|Plan) {2}$/, "").trimEnd();
				assert.ok(visibleWidth(body) <= textRoom, `text is at most ${textRoom} wide at ${w}, got ${visibleWidth(body)}: ${JSON.stringify(body)}`);
			}
			// where the label shares a row with text, they are at least two columns apart
			const mid = a[Math.floor((a.length - 1) / 2)]!;
			assert.match(mid, /\S {2,}Build {2}$/, "a gap of two columns or more before the label");
		}
	} finally {
		undo();
		setChatContainer(undefined);
	}
});

test("the label is painted with the tool-output colour, the same for build and plan, and the bar keeps the mode colour", () => {
	setBrand({ colors: { primary: "#2E7DDB", plan: "#8E5BD9" } });
	const { state, boxes } = pair();
	// Each colour token becomes a distinct zero-width 256-colour code, so the layout is unaffected.
	const codes: Record<string, number> = { toolOutput: 201, dim: 202, muted: 203, text: 204 };
	const coded = { ...theme, fg: (c: string, t: string) => `\x1b[38;5;${codes[c] ?? 199}m${t}\x1b[39m` };
	const undo = installMessageStyle(state, () => coded);
	try {
		const raw = (box: UserMessageComponent) => box.render(80).join("\n");
		assert.match(raw(boxes[0]), /\x1b\[38;5;201mBuild\x1b\[39m/, "Build in the tool-output colour");
		assert.match(raw(boxes[1]), /\x1b\[38;5;201mPlan\x1b\[39m/, "Plan in the same colour");
		const bar = (box: UserMessageComponent) => /\x1b\[38;2;(\d+;\d+;\d+)m┃/.exec(raw(box))?.[1];
		assert.deepEqual([bar(boxes[0]), bar(boxes[1])], ["46;125;219", "142;91;217"], "blue bar for build, violet for plan");
		const glyphs = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}]/u;
		assert.ok(!glyphs.test(plainRows(boxes[0], 80).join("") + plainRows(boxes[1], 80).join("")), "no private-use glyphs");
		state.mode = "plan"; // a later switch does not touch either label
		assert.ok(plainRows(boxes[0], 80).join("\n").includes("Build") && plainRows(boxes[1], 80).join("\n").includes("Plan"));
	} finally {
		undo();
		setChatContainer(undefined);
		resetBrand();
	}
});

test("a box too narrow to keep a readable text area has no label column, and all of its width goes to the text", () => {
	const { state, boxes } = pair([LONG, LONG]);
	const undo = installMessageStyle(state, () => theme);
	try {
		const cutoff = MIN_TEXT_WIDTH + 2 + LABEL_COLUMN + 1; // box width where the column still fits
		for (let w = 10; w <= 70; w++) {
			const rows = plainRows(boxes[0], w);
			for (const r of rows) assert.equal(visibleWidth(r), w, `every row is ${w} wide`);
			assert.equal(rows.join("\n").includes("Build"), w >= cutoff, `Build at width ${w} (cutoff ${cutoff})`);
		}
		const narrow = plainRows(boxes[0], cutoff - 1);
		assert.ok(narrow.every((r) => r.startsWith("┃")));
	} finally {
		undo();
		setChatContainer(undefined);
	}
});

test("a message's own height is unchanged apart from wrapping: a short message is still three rows", () => {
	const { state, boxes } = pair(["hi", "hi"]);
	const undo = installMessageStyle(state, () => theme);
	try {
		assert.equal(plainRows(boxes[0], 80).length, 3);
		assert.equal(plainRows(boxes[1], 80).length, 3);
	} finally {
		undo();
		setChatContainer(undefined);
	}
});
