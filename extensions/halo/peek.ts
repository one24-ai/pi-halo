/**
 * Thinking peek: while the model reasons with thinking blocks hidden, replace pi's
 * "Thinking..." label with a spinner and the tail of the reasoning.
 *
 * Adapted from pi-open-tui's peek.ts (MIT, Copyright (c) 2026 pi-open-tui contributors;
 * see THIRD_PARTY_NOTICES).
 *
 * pi only offers a global setHiddenThinkingLabel(), which would rewrite every past message's
 * label. To update just the streaming message, this finds the latest AssistantMessageComponent
 * (duck-typed: setHiddenThinkingLabel + updateContent) in the TUI tree, as pi-open-tui does.
 */

import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { piRootOf } from "./layout.ts";
import { sanitize } from "./palette.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export type PeekPhase = "idle" | "thinking" | "done";

export interface PeekState {
	phase: PeekPhase;
	tail: string;
}

export function createPeek(): PeekState {
	return { phase: "idle", tail: "" };
}

/** Cumulative thinking/text of an assistant message's content parts. */
export function collectParts(content: unknown): { thinking: string; text: string } {
	let thinking = "";
	let text = "";
	if (!Array.isArray(content)) return { thinking, text };
	for (const p of content as any[]) {
		if (p?.type === "thinking") thinking += typeof p.thinking === "string" ? p.thinking : (p.text ?? "");
		else if (p?.type === "text") text += p.text ?? "";
	}
	return { thinking, text };
}

/** Last non-empty line of the thinking text, whitespace-collapsed. */
export function lastLine(thinking: string): string {
	const lines = thinking.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const l = lines[i]!.replace(/\s+/g, " ").trim();
		if (l) return l;
	}
	return "";
}

/**
 * Phase machine: idle+thinking -> thinking; thinking+text -> done; done never restarts.
 * Text without thinking leaves idle alone (nothing to peek at).
 */
export function reducePeek(prev: PeekState, parts: { thinking: string; text: string }): PeekState {
	const tail = parts.thinking ? lastLine(parts.thinking) : prev.tail;
	let phase = prev.phase;
	if (parts.thinking && phase === "idle") phase = "thinking";
	if (parts.text && phase === "thinking") phase = "done";
	return { phase, tail };
}

/** Keep the end of `text` within `width` columns, prefixing "…" when clipped. */
export function clipTail(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	const chars = [...text];
	let out = "";
	for (let i = chars.length - 1; i >= 0; i--) {
		if (visibleWidth(`…${chars[i]}${out}`) > width) break;
		out = chars[i] + out;
	}
	return `…${out}`;
}

export function peekLabel(state: PeekState, frame: number, width: number): string {
	const w = Math.max(1, width);
	if (state.phase === "thinking") {
		const marker = `${SPINNER[frame % SPINNER.length]} thinking`;
		const tail = sanitize(state.tail);
		const room = w - visibleWidth(marker) - 1;
		return truncateToWidth(tail && room > 4 ? `${marker} ${clipTail(tail, room)}` : marker, w, "…");
	}
	if (state.phase === "done") return truncateToWidth("✓ thought", w, "…");
	return truncateToWidth("· thinking", w, "…");
}

interface LabelTarget {
	setHiddenThinkingLabel(label: string): void;
	updateContent(message: unknown, streaming?: boolean): void;
	children: unknown[];
}

const isTarget = (v: any): v is LabelTarget =>
	v && Array.isArray(v.children) && typeof v.setHiddenThinkingLabel === "function" && typeof v.updateContent === "function";

/** Latest assistant message component in the TUI tree, or undefined. */
export function findLatestAssistant(root: unknown): LabelTarget | undefined {
	const stack: unknown[] = [root];
	const seen = new Set<object>();
	let latest: LabelTarget | undefined;
	while (stack.length) {
		const v = stack.pop() as any;
		if (!v || typeof v !== "object" || seen.has(v)) continue;
		seen.add(v);
		if (isTarget(v)) latest = v;
		// Layout nodes keep children in `children`; ScrollView keeps its content in `child`.
		if (v.child) stack.push(v.child);
		const kids = v.children;
		if (Array.isArray(kids)) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
	}
	return latest;
}

/** Drives the peek label for the streaming message. */
export class ThinkingPeek {
	private state = createPeek();
	private frame = 0;
	private target: LabelTarget | undefined;
	private active = false;

	private readonly getTui: () => TUI | undefined;
	private readonly width: () => number;

	constructor(getTui: () => TUI | undefined, width: () => number) {
		this.getTui = getTui;
		this.width = width;
	}

	reset(): void {
		this.state = createPeek();
		this.target = undefined;
	}

	/** Feed an assistant message_update. Returns true when the label changed. */
	update(message: any): void {
		if (this.state.phase === "done") return;
		const next = reducePeek(this.state, collectParts(message?.content));
		if (next.phase === this.state.phase && next.tail === this.state.tail) return;
		this.state = next;
		if (next.phase === "thinking") this.frame++;
		if (next.phase !== "idle") this.apply();
	}

	/** Assistant sub-message ended while still thinking: freeze the label. */
	end(): void {
		if (this.state.phase !== "thinking") return;
		this.state = { ...this.state, phase: "done" };
		this.apply();
	}

	private apply(): void {
		const tui = this.getTui();
		if (!tui) return;
		this.target ??= findLatestAssistant(piRootOf(tui));
		if (!this.target) return;
		this.target.setHiddenThinkingLabel(peekLabel(this.state, this.frame, this.width()));
		this.active = true;
		tui.requestRender();
	}

	get isActive(): boolean {
		return this.active;
	}
}
