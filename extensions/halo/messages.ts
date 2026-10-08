/**
 * OpenCode-style transcript styling. pi has no renderer hooks for these, so two prototype patches
 * (pi and extensions share one module instance; verified on pi 1.1.0), both undone on uninstall:
 *
 * 1. User messages (UserMessageComponent.render): a ┃ bar in the agent colour, then the message
 *    on the panel background with 1 row of padding above and below and 2 columns on the left,
 *    like OpenCode's UserMessage box.
 *
 *      ┃
 *      ┃  fix the failing test in src/app.ts
 *      ┃
 *
 * 2. Tool rows (ToolExecutionComponent.render): pi puts a blank line above every tool. OpenCode
 *    stacks consecutive one-line tools with no gap, so for our one-line rows ("self" shell, a
 *    single content line) the blank line is dropped when the item above is also a tool or a
 *    hidden thinking-only message.
 *
 *    Other extensions' tools (default shell: a padded, shaded box) are compacted the same way
 *    when collapsed and their box holds at most 2 short lines: one row with "⚙", the call line,
 *    and the result line right-aligned and dim, e.g.
 *       lsp_diagnostics button.ts                         ✓ No diagnostics
 *    Errors, partial results, multi-line output and the expanded view (ctrl+o) keep pi's box.
 *
 * 3. Finished thinking (AssistantMessageComponent.render): with thinking blocks hidden, pi leaves a
 *    "Thinking..." label plus a blank line for every thinking block, i.e. between most tool calls
 *    and above every answer. OpenCode shows nothing once thinking is done, so in a finished message
 *    the hidden-thinking labels (and the spacer after each) are left out, and a message left with
 *    nothing visible renders no lines. While streaming the label stays (the thinking peek lives
 *    there). ctrl+t (pi's app.thinking.toggle) still shows full thinking.
 *
 * 4. Extension messages (CustomMessageComponent.render, e.g. [memory-recall], search results): pi
 *    draws them in a full-width shaded box. OpenCode draws notices as a ┃ bar in a muted colour
 *    beside a panel-shaded block, like its revert/error notices, so the box's own background is
 *    replaced with the panel shade and a dim bar is added. Messages whose renderer draws a plain
 *    row of its own (PLAIN_MESSAGE_TYPES) are left as that renderer draws them: no panel, no bar.
 *
 * Lines keep their OSC 133 prompt markers, which pi uses for prompt-to-prompt navigation.
 */

import {
	AssistantMessageComponent,
	CustomMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { MouseRegion, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getBrand } from "./brand.ts";
import { icon, leadIcon } from "./icons.ts";
import { userMessageModes } from "./message-modes.ts";
import { brandColor, fit, paint, shade } from "./palette.ts";
import type { AgentMode, UiState } from "./state.ts";

const ORIGINAL = Symbol.for("pi-halo/original-render");
const OSC133 = /\x1b\]133;[ABC]\x07/g;

type RenderFn = (this: any, width: number) => string[];
type Proto = { render: RenderFn; [ORIGINAL]?: RenderFn };

function patch(proto: Proto, make: (original: RenderFn) => RenderFn): () => void {
	const original = proto[ORIGINAL] ?? proto.render;
	proto[ORIGINAL] = original;
	proto.render = make(original);
	return () => {
		if (proto[ORIGINAL]) {
			proto.render = proto[ORIGINAL]!;
			delete proto[ORIGINAL];
		}
	};
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;:]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b_[^\x07]*\x07/g, "");

/**
 * Per-component memo for the restyling patches. pi-tui re-renders the whole transcript every
 * frame and relies on components returning the same line strings when nothing changed (its
 * caches compare by identity). Restyling builds new strings, so without this every message is
 * re-padded and re-shaded on every keystroke, which made long sessions lag (about 100 ms a frame
 * on a 1,261-message session, against 2 ms without the patches). The memo reuses the previous
 * output while pi's own lines are the same strings and the width and style key are unchanged.
 */
const memo = new WeakMap<object, Map<string, { width: number; key: string; src: string[]; out: string[] }>>();

export function memoLines(owner: object, slot: string, width: number, key: string, src: string[], build: () => string[]): string[] {
	let slots = memo.get(owner);
	if (!slots) {
		slots = new Map();
		memo.set(owner, slots);
	}
	const hit = slots.get(slot);
	if (hit && hit.width === width && hit.key === key && sameLines(hit.src, src)) return hit.out;
	const out = build();
	slots.set(slot, { width, key, src: src.slice(), out });
	return out;
}

function sameLines(a: string[], b: string[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** Style key: anything besides pi's lines that changes the output (theme, mode). */
const styleKey = (theme: Theme, extra = "") => `${theme.name ?? ""}|${theme.getColorMode()}|${getBrand().version}|${extra}`;

/** A stable per-object id, so a sibling can be part of a cache key. */
const ids = new WeakMap<object, number>();
let nextId = 0;
const identity = (o: unknown) => {
	if (!o || typeof o !== "object") return "-";
	let id = ids.get(o);
	if (id === undefined) ids.set(o, (id = ++nextId));
	return String(id);
};

/**
 * Custom message types that draw themselves as a plain row, like a tool row, and so get no panel
 * or bar from halo. Extensions in other module scopes add theirs through the shared set, with
 * `globalThis[Symbol.for("halo.plainMessageTypes")]`, so no import of halo is needed.
 */
export const PLAIN_MESSAGE_TYPES: Set<string> = (() => {
	const g = globalThis as Record<symbol, unknown>;
	const key = Symbol.for("halo.plainMessageTypes");
	if (!(g[key] instanceof Set)) g[key] = new Set<string>();
	const set = g[key] as Set<string>;
	set.add("memory-recall");
	return set;
})();

/**
 * Mode of each user box on the current branch, kept until the branch changes (a new entry changes
 * the leaf) or the session does (a different session manager).
 */
let branchModes: { sm: object; leaf: string | null; modes: AgentMode[] } | undefined;

function modesOfBranch(state: UiState): AgentMode[] | undefined {
	try {
		const sm = state.ctx?.sessionManager;
		if (!sm) return undefined;
		const leaf = sm.getLeafId();
		if (branchModes && branchModes.sm === sm && branchModes.leaf === leaf) return branchModes.modes;
		const contextIds = new Set(sm.buildContextEntries().map((e: any) => e.id as string));
		const modes = userMessageModes(sm.getBranch(), contextIds);
		branchModes = { sm, leaf, modes };
		return modes;
	} catch {
		return undefined; // a stale context after a session switch
	}
}

const sentIn = new WeakMap<object, AgentMode>();
const firstSeen = new WeakMap<object, AgentMode>();

/**
 * The mode a user box was sent in, so its bar keeps that colour when the mode changes later. It is
 * read from the session once the box can be matched to its message: the Nth box is the Nth user
 * message, trusted only when the two counts agree. Until then (a message not saved yet, or the chat
 * not found yet) it is the mode the box was first drawn in, and `final` is false so the caller does
 * not cache that guess.
 */
export function modeOfUserBox(state: UiState, box: object): { mode: AgentMode; final: boolean } {
	const known = sentIn.get(box);
	if (known) return { mode: known, final: true };
	if (!firstSeen.has(box)) firstSeen.set(box, state.mode);
	const modes = modesOfBranch(state);
	const boxes = chatContainer?.children.filter((c) => c instanceof UserMessageComponent);
	if (modes && boxes && boxes.length === modes.length) {
		const i = boxes.indexOf(box as UserMessageComponent);
		if (i >= 0) {
			sentIn.set(box, modes[i]!);
			return { mode: modes[i]!, final: true };
		}
	}
	return { mode: firstSeen.get(box)!, final: false };
}

/** The word in a user box's label column: plain text in the muted colour of tool output, no icon. The bar carries the mode colour. */
const MODE_LABELS: Record<AgentMode, string> = { build: "Build", plan: "Plan" };
const LABEL_WORD_WIDTH = Math.max(...Object.values(MODE_LABELS).map((w) => w.length));
/** Columns between the text area and the longest label, and between the label and the right edge (as wide as the indent on the left). */
const LABEL_GAP = 2;
const LABEL_MARGIN = 2;
/**
 * Width of the label column on the right of a user box. It is the same for every mode, so a message
 * wraps at the same place whichever mode it was sent in.
 */
export const LABEL_COLUMN = LABEL_GAP + LABEL_WORD_WIDTH + LABEL_MARGIN;
/** The text area is never narrower than this: a box too narrow to keep it has no label column at all. */
export const MIN_TEXT_WIDTH = 24;

export function installMessageStyle(state: UiState, getTheme: () => Theme | undefined): () => void {
	themeRef.get = getTheme;
	const undoUser = patch(UserMessageComponent.prototype as unknown as Proto, (original) =>
		function (this: object, width: number): string[] {
			const theme = getTheme();
			if (!theme || width < 8) return original.call(this, width);
			const boxW = width - 1;
			// The label column on the right takes LABEL_COLUMN columns from the text, which is rendered
			// narrower so it wraps before it reaches the column. A box too narrow for that has none.
			const labelled = boxW - 2 - LABEL_COLUMN >= MIN_TEXT_WIDTH;
			const textBoxW = labelled ? boxW - LABEL_COLUMN : boxW;
			// pi's message already has 1 row of vertical padding and outputPad columns on the sides;
			// re-pad it to OpenCode's 2 columns and paint the panel background over its own fill.
			const lines = original.call(this, textBoxW - 2);
			const { mode, final } = modeOfUserBox(state, this);
			// Until the answer is final the key changes on every call, so the lines are not reused.
			return memoLines(this, "user", width, styleKey(theme, `${mode}${final ? "" : `~${Date.now()}`}`), lines, () => {
				const color = brandColor(mode === "plan" ? "plan" : "primary");
				const bar = paint(theme, color, "┃");
				// The mode the message was sent in, in a column of its own on the right, on the middle row
				// of the box (the upper one of two when the box has an even number of rows).
				const word = MODE_LABELS[mode];
				const middle = Math.floor((lines.length - 1) / 2);
				const labelCell = (row: number): string =>
					row === middle ? `${" ".repeat(LABEL_COLUMN - LABEL_MARGIN - word.length)}${theme.fg("toolOutput", word)}${" ".repeat(LABEL_MARGIN)}` : " ".repeat(LABEL_COLUMN);
				return lines.map((line, i) => {
					const markers = line.match(OSC133)?.join("") ?? "";
					const body = line
						.replace(OSC133, "")
						.replace(/\x1b\[48;[0-9;]*m/g, "")
						.replace(/^ /, "");
					const text = labelled ? `${fit(`  ${body}`, boxW - LABEL_COLUMN)}${labelCell(i)}` : `  ${body}`;
					return `${markers}${bar}${shade(theme, text, boxW, "panel")}`;
				});
			});
		},
	);

	const undoTool = patch(ToolExecutionComponent.prototype as unknown as Proto, (original) =>
		function (this: any, width: number): string[] {
			let lines = original.call(this, width);
			const theme = currentThemeOf();
			// pi's own lines are the cache key: same strings, same width and theme, same row. The
			// previous sibling decides the leading blank line, so its identity, message and
			// streaming flag (hidden thinking only collapses once it settles) are in the key too.
			const parent = this.parent ?? findParent(this);
			const siblings: unknown[] | undefined = parent?.children;
			const i = siblings ? siblings.indexOf(this) : -1;
			const prevSibling = i > 0 ? siblings![i - 1] : undefined;
			const key = `${theme ? styleKey(theme) : ""}|${this.expanded ? 1 : 0}|${this.isPartial ? 1 : 0}|${prevSibling instanceof ToolExecutionComponent && isTall(prevSibling, width) ? "T" : "-"}|${prevSibling ? `${identity(prevSibling)}:${identity((prevSibling as any).lastMessage)}:${(prevSibling as any).isStreaming ? 1 : 0}` : "-"}`;
			return memoLines(this, "tool", width, key, lines, () => {
				let compact = lines;
				if (this.toolDefinition?.renderShell !== "self") {
					const row = compactDefaultShell(this, width);
					if (!row) return lines;
					compact = ["", row];
				}
				// Our compact rows: a leading blank line, then exactly one content line.
				if (compact.length !== 2 || stripAnsi(compact[0] ?? "").trim() !== "") return lines;
				lines = compact;
				let j = i - 1;
				// Skip assistant messages that render nothing (hidden thinking, or only tool calls).
				while (j >= 0 && siblings![j] instanceof AssistantMessageComponent && rendersNothing(siblings![j], width)) j--;
				const prev = j >= 0 ? siblings![j] : undefined;
				// OpenCode: an inline row sits tight under another one-line row, but a block above it
				// (or any taller row) gets a blank row between.
				return prev instanceof ToolExecutionComponent && !isTall(prev, width) ? lines.slice(1) : lines;
			});
		},
	);

	const undoAssistant = patch(AssistantMessageComponent.prototype as unknown as Proto, (original) =>
		function (this: any, width: number): string[] {
			const box = this.contentContainer;
			if (!thinkingSettled(this) || !Array.isArray(box?.children)) return original.call(this, width);
			const all: unknown[] = box.children;
			const kept: unknown[] = [];
			for (let i = 0; i < all.length; i++) {
				if (isHiddenThinkingLabel(all[i])) {
					if (all[i + 1] instanceof Spacer) i++; // the gap pi adds after the label
					continue;
				}
				kept.push(all[i]);
			}
			// Only the leading spacer left: nothing to show.
			if (kept.every((k) => k instanceof Spacer)) return [];
			if (kept.length === all.length) return original.call(this, width);
			box.children = kept;
			try {
				return original.call(this, width);
			} finally {
				box.children = all;
			}
		},
	);

	const undoCustom = patch(CustomMessageComponent.prototype as unknown as Proto, (original) =>
		function (this: object, width: number): string[] {
			const theme = getTheme();
			if (!theme || width < 8) return original.call(this, width);
			if (PLAIN_MESSAGE_TYPES.has((this as any).message?.customType)) return original.call(this, width);
			// Bar (1) + space (1) are added in front, so render pi's box 2 columns narrower.
			const lines = original.call(this, width - 2);
			return memoLines(this, "custom", width, styleKey(theme), lines, () => {
				// pi adds a blank spacer row above; keep it unshaded, bar the rest.
				const lead = lines.length && stripAnsi(lines[0] ?? "").trim() === "" && !/\x1b\[48;/.test(lines[0] ?? "") ? 1 : 0;
				// Same colour as the [label], so notices read as one unit (theme: customMessageLabel).
				const bar = theme.fg("customMessageLabel", "┃");
				return lines.map((line, i) => {
					if (i < lead) return line;
					const markers = line.match(OSC133)?.join("") ?? "";
					const body = line.replace(OSC133, "").replace(/\x1b\[48;[0-9;]*m/g, "");
					return `${markers}${bar}${shade(theme, ` ${body.replace(/^ /, "")} `, width - 1, "panel")}`;
				});
			});
		},
	);

	return () => {
		undoUser();
		undoTool();
		undoAssistant();
		undoCustom();
	};
}

/**
 * One-line row for a default-shell tool (pi's padded box) when it is small and settled, or
 * undefined to keep pi's rendering. Reads pi fields at runtime: contentBox, expanded, isPartial,
 * result, imageComponents.
 */
function compactDefaultShell(c: any, width: number): string | undefined {
	const theme = currentThemeOf();
	if (!theme || c.expanded || c.isPartial || !c.result || c.result.isError || c.imageComponents?.length) return undefined;
	const box = c.contentBox;
	if (!box || typeof box.render !== "function") return undefined;
	const inner = (box.render(Math.max(10, width - 4)) as string[])
		.map((l) => stripAnsi(l).trim())
		.filter(Boolean);
	if (inner.length === 0 || inner.length > 2) return undefined;
	const [call, result = ""] = inner;
	if ((call?.length ?? 0) > width - 6 || result.length > 60) return undefined;
	const left = `${leadIcon(icon("toolOther"), (s) => theme.fg("dim", s))}${theme.fg("text", call ?? "")}`;
	const right = theme.fg("dim", result);
	const w = width - 2;
	const lw = visibleWidth(left);
	const rw = visibleWidth(right);
	const line = rw && lw + rw + 2 <= w ? `${left}${" ".repeat(w - lw - rw)}${right}` : truncateToWidth(`${left}  ${right}`, w, "…");
	return shade(theme, ` ${line} `, width);
}

const themeRef: { get?: () => Theme | undefined } = {};

/** True when a tool row draws more than one content line (a block, or an expanded row). */
export function isTall(c: any, width: number): boolean {
	try {
		const lines = c.render(width) as string[];
		const blank = lines.length && stripAnsi(lines[0] ?? "").trim() === "" && !/\x1b\[48;/.test(lines[0] ?? "") ? 1 : 0;
		return lines.length - blank > 1;
	} catch {
		return false;
	}
}

function rendersNothing(c: any, width: number): boolean {
	if (isHiddenThoughtOnly(c)) return true;
	try {
		return (c.render(width) as string[]).every((l) => stripAnsi(l).trim() === "");
	} catch {
		return false;
	}
}
const currentThemeOf = () => themeRef.get?.();

/**
 * True for a finished assistant message whose thinking is hidden and not clicked open (pi fields
 * read at runtime: lastMessage, isStreaming, hideThinkingBlock, thinkingVisibilityOverrides).
 */
function thinkingSettled(c: any): boolean {
	const m = c?.lastMessage;
	if (!m || c.isStreaming || c.hideThinkingBlock !== true) return false;
	if (c.thinkingVisibilityOverrides instanceof Map && [...c.thinkingVisibilityOverrides.values()].some((v) => v === false)) return false;
	return true;
}

/** pi's hidden-thinking label: a MouseRegion wrapping a plain Text (shown thinking is Markdown). */
function isHiddenThinkingLabel(v: any): boolean {
	return v instanceof MouseRegion && (v as any).child instanceof Text;
}

/**
 * A finished assistant message whose only visible content is hidden thinking (it renders nothing).
 */
export function isHiddenThoughtOnly(c: any): boolean {
	const m = c?.lastMessage;
	if (!thinkingSettled(c)) return false;
	if (m.stopReason === "error" || m.stopReason === "aborted" || m.stopReason === "length") return false;
	const parts: any[] = Array.isArray(m.content) ? m.content : [];
	const hasThinking = parts.some((p) => p?.type === "thinking" && String(p.thinking ?? "").trim());
	const hasText = parts.some((p) => p?.type === "text" && String(p.text ?? "").trim());
	return hasThinking && !hasText;
}

/**
 * pi-tui components don't keep a parent pointer, so the chat container is found once from the
 * TUI tree by halo (see setChatContainer) and used for sibling lookups.
 */
let chatContainer: { children: unknown[] } | undefined;
export function setChatContainer(c: { children: unknown[] } | undefined): void {
	chatContainer = c;
}
function findParent(child: unknown): { children: unknown[] } | undefined {
	return chatContainer && chatContainer.children.includes(child) ? chatContainer : undefined;
}
