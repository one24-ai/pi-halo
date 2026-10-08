/**
 * Turn telemetry (TPS, TTFT, duration, tokens, stalls, cost rate) shown after each agent run.
 *
 * Adapted from pi-open-tui's telemetry.ts (MIT, Copyright (c) 2026 pi-open-tui contributors;
 * see THIRD_PARTY_NOTICES). Formatting changed to match halo.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { icon, type IconName, leadIcon } from "./icons.ts";
import { finite, fmtTokens } from "./palette.ts";

const STALL_THRESHOLD_MS = 1000;
/** Below this many output tokens the speed is mostly start-up time, so the line leaves it out. */
export const MIN_TPS_TOKENS = 20;

interface MessageTiming {
	lastUpdateMs: number;
	firstOutputMs: number | null;
	inStall: boolean;
}

interface TurnTiming {
	startMs: number;
	firstTokenMs: number | null;
	current: MessageTiming | null;
	messages: any[];
	generationMs: number;
	stallMs: number;
	stallCount: number;
}

export interface Telemetry {
	tps: number | null;
	ttftMs: number;
	totalMs: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	stallMs: number;
	stallCount: number;
	/** What the run cost, summed over its turns; null when the provider reports no cost (free or unknown). */
	costUsd: number | null;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

export class TelemetryTracker {
	private turn: TurnTiming | undefined;
	private agentStartMs: number | null = null;
	private turns: (Omit<Telemetry, "costUsd"> & { generationMs: number; costUsd: number })[] = [];

	private readonly now: () => number;

	constructor(now: () => number = () => performance.now()) {
		this.now = now;
	}

	/** Feed every relevant pi event; returns the run summary on agent_settled. */
	handle(event: { type: string; [k: string]: any }): Telemetry | undefined {
		switch (event.type) {
			case "agent_start":
				if (this.agentStartMs === null) {
					this.agentStartMs = this.now();
					this.turns = [];
				}
				return;
			case "turn_start":
				this.turn = { startMs: this.now(), firstTokenMs: null, current: null, messages: [], generationMs: 0, stallMs: 0, stallCount: 0 };
				return;
			case "message_start":
				if (this.turn && event.message?.role === "assistant") {
					this.turn.current = { lastUpdateMs: this.now(), firstOutputMs: null, inStall: false };
				}
				return;
			case "message_update":
				this.update(event);
				return;
			case "message_end":
				this.endMessage(event.message);
				return;
			case "turn_end": {
				const t = this.endTurn();
				if (t && this.agentStartMs !== null) this.turns.push(t);
				return;
			}
			case "agent_settled":
				return this.endAgent();
		}
	}

	private update(event: any): void {
		const turn = this.turn;
		const cur = turn?.current;
		const se = event.assistantMessageEvent;
		if (!turn || !cur || !se) return;
		if (se.type !== "text_delta" && se.type !== "thinking_delta" && se.type !== "toolcall_delta") return;
		if (!se.delta?.length) return;
		const now = this.now();
		if (cur.firstOutputMs === null) {
			cur.firstOutputMs = now;
			turn.firstTokenMs ??= now;
			cur.lastUpdateMs = now;
			return;
		}
		const gap = now - cur.lastUpdateMs;
		if (gap >= STALL_THRESHOLD_MS) {
			if (!cur.inStall) turn.stallCount++;
			cur.inStall = true;
			turn.stallMs += gap;
		} else {
			cur.inStall = false;
		}
		cur.lastUpdateMs = now;
	}

	private endMessage(message: any): void {
		const turn = this.turn;
		if (!turn || message?.role !== "assistant") return;
		if (turn.current) {
			const end = this.now();
			turn.generationMs = end - turn.startMs;
			if (turn.current.firstOutputMs === null && finite(message.usage?.output) > 0) turn.firstTokenMs ??= end;
			turn.current = null;
		}
		turn.messages.push(message);
	}

	private endTurn() {
		const turn = this.turn;
		this.turn = undefined;
		if (!turn || turn.firstTokenMs === null || turn.messages.length === 0) return undefined;
		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cost = 0;
		for (const m of turn.messages) {
			input += finite(m.usage?.input) + finite(m.usage?.cacheWrite);
			output += finite(m.usage?.output);
			cacheRead += finite(m.usage?.cacheRead);
			cost += finite(m.usage?.cost?.total);
		}
		return {
			tps: output > 0 && turn.generationMs > 0 ? round1(output / (turn.generationMs / 1000)) : null,
			ttftMs: turn.firstTokenMs - turn.startMs,
			totalMs: this.now() - turn.startMs,
			inputTokens: input,
			outputTokens: output,
			cacheReadTokens: cacheRead,
			stallMs: turn.stallMs,
			stallCount: turn.stallCount,
			generationMs: turn.generationMs,
			costUsd: cost,
		};
	}

	private endAgent(): Telemetry | undefined {
		const start = this.agentStartMs;
		const turns = this.turns;
		this.agentStartMs = null;
		this.turns = [];
		if (start === null || turns.length === 0) return undefined;
		const sum = (f: (t: (typeof turns)[number]) => number) => turns.reduce((a, t) => a + f(t), 0);
		const output = sum((t) => t.outputTokens);
		const gen = sum((t) => t.generationMs);
		const cost = sum((t) => t.costUsd);
		return {
			tps: output > 0 && gen > 0 ? round1(output / (gen / 1000)) : null,
			ttftMs: turns[0]!.ttftMs,
			totalMs: this.now() - start,
			inputTokens: sum((t) => t.inputTokens),
			outputTokens: output,
			cacheReadTokens: sum((t) => t.cacheReadTokens),
			stallMs: sum((t) => t.stallMs),
			stallCount: sum((t) => t.stallCount),
			costUsd: cost > 0 ? cost : null,
		};
	}
}

const secs = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

/**
 * The telemetry line's icons, by name (icons.ts): a speedometer, a sand timer for the wait for the
 * first token, a clock and an alert. The plain set has none; the words beside them say it.
 */
export const TELEMETRY_ICONS = {
	speed: "telSpeed",
	ttft: "telTtft",
	total: "telTotal",
	stall: "telStall",
} as const satisfies Record<string, IconName>;

/** A dollar amount at the precision it needs: $12.40, $0.29, $0.031, $0.004. */
export function fmtCost(usd: number): string {
	if (usd >= 0.1) return `$${usd.toFixed(2)}`;
	if (usd >= 0.001) return `$${usd.toFixed(3)}`;
	return "<$0.001";
}

/**
 * The line shown after a run:
 *
 *     󰓅 42.3 tok/s · 󰔟 ttft 1.1s · 󰅐 4.8s · ↑40k (38k cached) ↓1.2k · $0.031
 *
 * The speed is left out for a short reply (under MIN_TPS_TOKENS output tokens), where it would only
 * measure start-up. The speed, waits and stalls have a dim icon in front and the separators are dim. The token counts
 * and the cost have none: the arrows and the $ sign speak for themselves. The cost is what the run
 * really cost, left out when the provider reports none.
 */
export function formatTelemetry(t: Telemetry, theme: Theme): string {
	const sep = theme.fg("dim", " · ");
	const mark = (name: keyof typeof TELEMETRY_ICONS, color: "dim" | "warning" = "dim") => leadIcon(icon(TELEMETRY_ICONS[name]), (s) => theme.fg(color, s));
	const parts = [
		...(t.tps !== null && t.outputTokens >= MIN_TPS_TOKENS ? [mark("speed") + theme.fg("text", `${t.tps.toFixed(1)} tok/s`)] : []),
		mark("ttft") + theme.fg("muted", `ttft ${secs(t.ttftMs)}`),
		mark("total") + theme.fg("muted", secs(t.totalMs)),
		theme.fg("muted", `↑${fmtTokens(t.inputTokens + t.cacheReadTokens)}${t.cacheReadTokens > 0 ? ` (${fmtTokens(t.cacheReadTokens)} cached)` : ""} ↓${fmtTokens(t.outputTokens)}`),
	];
	if (t.stallMs > 0) parts.push(mark("stall", "warning") + theme.fg("warning", `stall ${t.stallCount}× ${secs(t.stallMs)}`));
	if (t.costUsd !== null) parts.push(theme.fg("muted", fmtCost(t.costUsd)));
	return parts.join(sep);
}
