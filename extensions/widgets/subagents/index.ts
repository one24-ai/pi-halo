/**
 * Subagents widget: a sidebar section with this session's pi-subagents children.
 *
 *   Subagents  2 running · 1 done
 *   ● build-api           bash  1m02s
 *   ● scout fg                    18s
 *   ✓ reviewer                  2m10s
 *   ↓ on an empty prompt to inspect
 *
 * Data comes from pi-subagents' public in-process RPC (`status`, see its docs/extension-api.md),
 * never from its files on disk, so this keeps working as pi-subagents changes internally.
 * Inspecting, steering and stopping are FleetView's job (pi-subagents' own UI under the
 * editor); the hint line points there. Hidden when pi-subagents isn't installed or nothing ran.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { registerWidget } from "../../halo/api.ts";
import { ICONS } from "../../halo/icons.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { asyncActiveFrom, elapsed, fmtCount, GLYPH, type Limits, limitsLine, orderRows, parallelFrom, type Row, rowsFromStatus, shortModel, spawnedFrom, summary } from "./status.ts";

const REQUEST = "subagents:rpc:v1:request";
const REPLY = "subagents:rpc:v1:reply:";
const READY = "subagents:rpc:v1:ready";
const POLL_MS = 2_000;
const TIMEOUT_MS = 5_000;
const SHOWN = 8;
/** Running children that also get a model and token line, so the section stays short. */
const SHOWN_DETAIL = 5;
/** The spawn budget needs the heavier executor-backed status call: at most this often. */
const BUDGET_MIN_MS = 5_000;
/** Even lifecycle events (which can come in bursts) wait this long between budget calls. */
const BUDGET_FLOOR_MS = 1_000;

function readConfigText(): string | undefined {
	try {
		return readFileSync(join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "extensions", "subagent", "config.json"), "utf8");
	} catch {
		return undefined;
	}
}

/** One `status` request; resolves to the reply's data, or undefined without pi-subagents. */
function requestStatus(pi: ExtensionAPI, params: Record<string, unknown> = {}): Promise<unknown> {
	return new Promise((resolve) => {
		const requestId = randomUUID();
		let off: (() => void) | undefined;
		const timer = setTimeout(() => {
			off?.();
			resolve(undefined);
		}, TIMEOUT_MS);
		timer.unref?.();
		off = pi.events.on(`${REPLY}${requestId}`, (raw) => {
			clearTimeout(timer);
			off?.();
			const r = raw as { success?: boolean; data?: unknown } | undefined;
			resolve(r?.success ? r.data : undefined);
		});
		pi.events.emit(REQUEST, { version: 1, requestId, method: "status", params, source: { extension: "pi-halo" } });
	});
}

export default function (pi: ExtensionAPI) {
	let rows: Row[] = [];
	let inFlight = false;
	let limits: Limits = {};
	let budgetBusy = false;
	let budgetAt = 0;

	/** Spawn count and cap. Rarely needed, and costlier than the poll, so throttled. */
	const refreshBudget = async (force = false): Promise<void> => {
		if (budgetBusy || Date.now() - budgetAt < (force ? BUDGET_FLOOR_MS : BUDGET_MIN_MS)) return;
		budgetBusy = true;
		budgetAt = Date.now();
		try {
			const data = await requestStatus(pi, { view: "fleet" });
			if (data !== undefined) limits = { ...limits, spawned: spawnedFrom(data) ?? limits.spawned };
		} finally {
			budgetBusy = false;
		}
	};

	const update = async (_ctx?: ExtensionContext) => {
		if (inFlight) return;
		inFlight = true;
		try {
			const data = await requestStatus(pi);
			if (data !== undefined) {
				rows = orderRows(rowsFromStatus(data));
				limits = { ...limits, asyncActive: asyncActiveFrom(data), parallel: parallelFrom(readConfigText()) };
				// A new child changes the spawn count, so look again while something is active.
				if (rows.some((r) => r.state === "running" || r.state === "queued")) void refreshBudget();
			}
		} finally {
			inFlight = false;
		}
	};

	const handle = registerWidget(pi, {
		id: "subagents",
		title: "Subagents",
		icon: { nerd: ICONS.widgetSubagents.nerd, plain: ICONS.widgetSubagents.plain },
		// pi-subagents' slash commands publish short-lived statuses ("0 tools | ctrl+o live detail")
		// that this section already covers with per-child rows, so they're not listed a second time.
		statusKeys: ["subagent-slash", "subagent-slash-text"],
		slots: ["sidebar", "footer"],
		sidebar: "section",
		order: 35,
		refreshMs: POLL_MS,
		update,
		render: () => {
			if (!rows.length) return undefined;
			const s = summary(rows);
			return { label: "subagents", text: s.text, level: s.running ? "ok" : s.failed ? "warn" : "off", color: s.running ? "text" : undefined };
		},
		detail: ({ theme, width }) => {
			if (!rows.length) return undefined;
			const tone = (r: Row, x: string) =>
				theme.fg(r.state === "running" ? "accent" : r.state === "done" ? "success" : r.state === "failed" ? "error" : r.state === "paused" ? "warning" : "dim", x);
			const lines = rows.slice(0, SHOWN).map((r) => {
				const active = r.state === "running" || r.state === "queued" || r.state === "paused";
				const left = `${tone(r, GLYPH[r.state])} ${theme.fg(active ? "text" : "muted", r.label)}${r.foreground ? theme.fg("dim", " fg") : ""}`;
				const right = theme.fg("dim", [r.currentTool, elapsed(r)].filter(Boolean).join("  "));
				const gap = width - visibleWidth(left) - visibleWidth(right);
				return gap >= 1 ? `${left}${" ".repeat(gap)}${right}` : truncateToWidth(left, width, "…");
			});
			// Model and tokens under running children: "  opus-5-5 · 16k tokens".
			const withFacts: string[] = [];
			let factRows = 0;
			rows.slice(0, SHOWN).forEach((r, i) => {
				withFacts.push(lines[i]!);
				const facts = [r.model ? shortModel(r.model) : "", r.tokens ? `${fmtCount(r.tokens)} tokens` : ""].filter(Boolean).join(" · ");
				if (facts && r.state === "running" && factRows < SHOWN_DETAIL) {
					factRows++;
					withFacts.push(truncateToWidth(`  ${theme.fg("dim", facts)}`, width, "…"));
				}
			});
			lines.length = 0;
			lines.push(...withFacts);
			if (rows.length > SHOWN) lines.push(theme.fg("dim", `+${rows.length - SHOWN} more`));
			const limit = limitsLine(limits);
			if (limit) lines.push(theme.fg("dim", limit));
			if (summary(rows).running) lines.push(theme.fg("dim", "↓ on an empty prompt to inspect"));
			return lines;
		},
	});

	// Refresh promptly on pi-subagents' lifecycle events, on top of the poll.
	for (const ev of [READY, "subagent:async-started", "subagent:async-complete", "subagent:child-status"]) {
		pi.events.on(ev, () => {
			setTimeout(() => handle.refresh(), 150);
			void refreshBudget(true);
		});
	}
	pi.on("tool_execution_start", async (e) => {
		if (e.toolName === "subagent") setTimeout(() => handle.refresh(), 300);
	});
	pi.on("tool_execution_end", async (e) => {
		if (e.toolName === "subagent") setTimeout(() => handle.refresh(), 300);
	});
	pi.on("session_start", async () => {
		rows = [];
		limits = {};
		budgetAt = 0;
	});
}
