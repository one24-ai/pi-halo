/**
 * OpenCode-style prompt editor.
 *
 *   ┃ ask anything…
 *   ┃
 *   ┃ 󰚩 BUILD   Opus 5.5  Anthropic  medium
 *                      tab mode · ctrl+p commands · ctrl+x leader
 *
 * A shaded panel with a heavy left rail in the mode colour (the brand primary for build,
 * the brand plan colour for plan) and the mode pill and model inside, like OpenCode's prompt; key hints sit under it.
 * pi's working status (spinner, retry countdown, compaction) is shown in the footer instead.
 *
 * Keys handled here before pi sees them:
 *   - Tab on an empty prompt (and no autocomplete open): switch Build/Plan mode. Shift+Tab is left to
 *     pi, which cycles the thinking level with it.
 *   - Ctrl+X: leader key; the next key runs a leader action (see commands.ts)
 *   - Ctrl+P: command palette. pi binds ctrl+p to model cycling, a reserved action that
 *     registerShortcut() can't take over, so the editor intercepts it (model cycling stays on
 *     ctrl+x m / ctrl+l).
 * Everything else goes to pi's CustomEditor, so app keybindings keep working.
 */

import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, matchesKey, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { paint, shade, surfaceColor } from "./palette.ts";
import { type ModelParts, modeColorValue, promptRow } from "./prompt-row.ts";
import type { UiState } from "./state.ts";

export interface EditorHooks {
	state: UiState;
	theme: () => Theme;
	/** The model, provider and thinking level for the bottom row. */
	modelParts: () => ModelParts;
	/** Muted hint shown after the cursor while the prompt is empty (home screen). */
	placeholder?: () => string | undefined;
	/** Left side of the key-hint row under the box (home screen brand line). */
	hintLeft?: () => string | undefined;
	/** Blink the cursor (home screen only). */
	blink?: () => boolean;
	onModeCycle: () => void;
	/** Called for the key after the leader. Return true if it was a leader action. */
	onLeaderKey: (data: string) => boolean;
	/** Leader key pressed (show a hint) or cleared. */
	onLeaderState: (pending: boolean) => void;
	/** Ctrl+P: open the command palette. */
	onPalette: () => void;
	/** The working/retry indicator changed (footer repaint). */
	onStatusChange?: () => void;
	leaderTimeoutMs: number;
}

const RAIL = "┃";

export class PromptEditor extends CustomEditor {
	private leaderPending = false;
	private leaderTimer: ReturnType<typeof setTimeout> | undefined;

	private readonly hooks: EditorHooks;

	constructor(tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager, hooks: EditorHooks) {
		super(tui, editorTheme, keybindings, { paddingX: 0, embedWorkingStatus: true });
		this.hooks = hooks;
	}

	override setPaddingX(_padding: number): void {
		super.setPaddingX(0);
	}

	/**
	 * pi passes its working/retry/compaction indicator here (embedWorkingStatus). Keep it in shared
	 * state for the footer instead of drawing it in the editor's top border.
	 */
	override setWorkingStatusIndicator(indicator: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]): void {
		super.setWorkingStatusIndicator(undefined);
		this.hooks.state.statusIndicator = indicator as UiState["statusIndicator"];
		this.hooks.onStatusChange?.();
	}

	private clearLeader(): void {
		if (this.leaderTimer) clearTimeout(this.leaderTimer);
		this.leaderTimer = undefined;
		if (this.leaderPending) {
			this.leaderPending = false;
			this.hooks.onLeaderState(false);
		}
	}

	/** Cursor blink: off phase hides the editor's reverse-video cursor; a keypress resets it. */
	private blinkOff = false;
	private blinkTimer: ReturnType<typeof setInterval> | undefined;
	private static readonly BLINK_MS = 530;

	private syncBlink(): void {
		const want = this.hooks.blink?.() ?? false;
		if (want && !this.blinkTimer) {
			this.blinkTimer = setInterval(() => {
				if (!(this.hooks.blink?.() ?? false)) {
					this.stopBlink();
					this.tui.requestRender();
					return;
				}
				this.blinkOff = !this.blinkOff;
				this.tui.requestRender();
			}, PromptEditor.BLINK_MS);
			this.blinkTimer.unref?.();
		} else if (!want && this.blinkTimer) {
			this.stopBlink();
		}
	}

	private stopBlink(): void {
		if (this.blinkTimer) clearInterval(this.blinkTimer);
		this.blinkTimer = undefined;
		this.blinkOff = false;
	}

	dispose(): void {
		this.stopBlink();
	}

	override handleInput(data: string): void {
		// Typing keeps the cursor visible; the blink restarts from "on".
		if (this.blinkTimer) {
			this.stopBlink();
		}
		if (this.leaderPending) {
			this.clearLeader();
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+x")) {
				this.tui.requestRender();
				return;
			}
			if (this.hooks.onLeaderKey(data)) {
				this.tui.requestRender();
				return;
			}
			// Unknown leader key: fall through as a normal key.
		}

		if (matchesKey(data, "ctrl+p")) {
			this.hooks.onPalette();
			return;
		}

		if (matchesKey(data, "ctrl+x")) {
			this.leaderPending = true;
			this.hooks.onLeaderState(true);
			this.leaderTimer = setTimeout(() => {
				this.clearLeader();
				this.tui.requestRender();
			}, this.hooks.leaderTimeoutMs);
			this.leaderTimer.unref?.();
			this.tui.requestRender();
			return;
		}

		const idlePrompt = this.getText().length === 0 && !this.isShowingAutocomplete();
		if (idlePrompt && matchesKey(data, "tab")) {
			this.hooks.onModeCycle();
			this.tui.requestRender();
			return;
		}
		super.handleInput(data);
	}

	private modeColor(s: string): string {
		const theme = this.hooks.theme();
		// The rail is a shape, not text: it keeps the exact brand colour under any theme.
		return paint(theme, modeColorValue(this.hooks.state.mode === "plan" ? "plan" : "build"), s);
	}

	override render(width: number): string[] {
		const theme = this.hooks.theme();
		if (width < 12) return super.render(width);

		// OpenCode prompt (component/prompt/index.tsx): a ┃ rail in the agent colour, then a box on
		// the element background with 1 row of top padding and 2 columns either side, the text, a
		// blank row, the agent + model row, and a half-block bottom edge (╹▀▀▀). Key hints sit
		// below, outside the box.
		//   ┃
		//   ┃  prompt text…
		//   ┃
		//   ┃  󰚩 BUILD   Opus 5.5  Anthropic  medium
		//   ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
		//                            tab agents  ctrl+p commands
		// pi's working spinner goes to the footer (see setWorkingStatusIndicator).
		const PAD = 2;
		const boxW = width - 1; // after the rail
		const inner = boxW - PAD * 2;
		const base = super.render(inner);
		const bottomIdx = bottomBorderIndex(this, base);
		const rail = this.modeColor("┃");
		const row = (content: string) => `${rail}${shade(theme, `${" ".repeat(PAD)}${content}`, boxW, "element")}`;
		const out: string[] = [];

		// Top padding row; a "↑ N more" scroll hint from the base top border goes there.
		out.push(row(stripRule(base[0] ?? "", inner)));
		this.syncBlink();
		const hideCursor = this.blinkOff;
		const placeholder = this.getText().length === 0 ? this.hooks.placeholder?.() : undefined;
		for (let i = 1; i < bottomIdx; i++) {
			let line = base[i] ?? "";
			// The base editor draws its cursor as reverse video; drop that during the off phase.
			if (hideCursor) line = line.replace(/\x1b\[7m/g, "");
			if (placeholder && i === 1) line = `${line.replace(/ +$/, "")}${theme.fg("muted", placeholder)}`;
			out.push(row(truncateToWidth(line, inner, "…")));
		}

		// Blank row, or the "↓ N more" scroll hint from the base bottom border.
		const more = (base[bottomIdx] ?? "").replace(/\x1b\[[0-9;]*m/g, "").match(/[↓]\s+\d+\s+more/);
		out.push(row(more ? theme.fg("dim", more[0]) : ""));

		// Agent + model row: a mode pill, the model, the provider and the thinking level (prompt-row.ts).
		out.push(row(promptRow(theme, this.hooks.state.mode === "plan" ? "plan" : "build", this.hooks.modelParts(), inner)));

		// Bottom edge: ╹ in the rail colour, then upper half blocks in the box colour.
		out.push(`${this.modeColor("╹")}${paint(theme, surfaceColor(theme, "element"), "▀".repeat(boxW))}`);

		// Key hints under the box, right-aligned; an optional brand line on the left.
		const key = (k: string, d: string) => `${theme.fg("text", k)} ${theme.fg("muted", d)}`;
		const hint = this.leaderPending
			? theme.fg("warning", "ctrl+x …  n new · m model · b sidebar · ? help")
			: [key("tab", "agents"), key("ctrl+p", "commands"), key("ctrl+x", "leader")].join("   ");
		const hw = visibleWidth(hint);
		const left = this.hooks.hintLeft?.();
		const lw = left ? visibleWidth(left) + 1 : 0; // 1 column: in line with the rail
		if (left && lw + hw + 4 < width) out.push(` ${left}${" ".repeat(width - lw - hw - 2)}${hint}  `);
		else out.push(hw + 2 < width ? `${" ".repeat(width - hw - 2)}${hint}  ` : truncateToWidth(hint, width, "…"));

		// Autocomplete list below.
		for (let i = bottomIdx + 1; i < base.length; i++) out.push(`  ${base[i]}`);
		return out.map((l) => truncateToWidth(l, width, ""));
	}
}

/**
 * Index of the base editor's bottom border: it renders the top border, then
 * `renderedVisibleLineCount` text lines (a pi-tui Editor field, read at runtime), then the bottom
 * border, then any autocomplete lines.
 */
function bottomBorderIndex(editor: unknown, lines: string[]): number {
	const n = (editor as { renderedVisibleLineCount?: unknown }).renderedVisibleLineCount;
	if (typeof n === "number" && n >= 0 && n + 1 < lines.length) return n + 1;
	return lines.length - 1;
}

/** Replace a plain ─ rule with blank space; keep an embedded status (spinner text) visible. */
function stripRule(line: string, width: number): string {
	const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
	if (/^─*$/.test(plain)) return " ".repeat(width);
	// Working status or scroll hint embedded in the border: drop the dashes around it.
	const text = line.replace(/─/g, " ").replace(/^\s+/, "");
	return truncateToWidth(text, width, "");
}
