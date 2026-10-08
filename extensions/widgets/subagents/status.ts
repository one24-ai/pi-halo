/**
 * Projection of pi-subagents' public `status` RPC reply into sidebar rows.
 *
 * Reads only the documented, versioned shapes from pi-subagents' docs/extension-api.md:
 * `data.asyncSnapshot` (kind "pi-subagents.async-status-snapshot", version 1) for background
 * runs, and `data.fleet` (version 1) for active foreground children, which the snapshot doesn't
 * cover. Unknown fields are ignored, as that doc asks. No pi imports, so tests stay light.
 */

export type RowState = "running" | "queued" | "done" | "failed" | "paused" | "stopped";

export interface Row {
	label: string;
	state: RowState;
	currentTool?: string;
	startedAt?: number;
	endedAt?: number;
	/** A foreground child (from the fleet DTO). */
	foreground?: boolean;
	/** Model as the fleet DTO reports it, e.g. "anthropic/claude-opus-5-5". Active children only. */
	model?: string;
	/** Tokens so far (input + output). Active children only. */
	tokens?: number;
}

/** What the sidebar shows about the limits, from the status reply and the config file. */
export interface Limits {
	/** Children launched this session, and the cap (null: no cap). */
	spawned?: { used: number; limit: number | null };
	/** Background runs active in this session, and the cap (only when a cap is configured). */
	asyncActive?: { used: number; limit: number };
	/** `globalConcurrencyLimit`: children running at once inside one run. */
	parallel?: number;
}

interface SnapshotNode {
	kind?: string;
	label?: string;
	state?: string;
	startedAt?: number;
	endedAt?: number;
	activity?: { currentTool?: string };
	children?: SnapshotNode[];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

function rowState(s: unknown): RowState {
	switch (s) {
		case "running":
			return "running";
		case "queued":
			return "queued";
		case "complete":
			return "done";
		case "paused":
			return "paused";
		case "stopped":
			return "stopped";
		default:
			return "failed"; // failed, partial, rejected
	}
}

/** A node's leaves: the children you'd open in FleetView. Workflow parents aren't rows. */
function leaves(node: SnapshotNode, out: Row[]): void {
	const kids = Array.isArray(node.children) ? node.children : [];
	if (kids.length) {
		for (const k of kids) if (k && typeof k === "object") leaves(k, out);
		return;
	}
	const state = rowState(node.state);
	out.push({
		label: str(node.label) ?? "subagent",
		state,
		currentTool: state === "running" ? str(node.activity?.currentTool) : undefined,
		startedAt: num(node.startedAt),
		endedAt: state === "running" || state === "queued" ? undefined : num(node.endedAt),
	});
}

/** Rows from a `status` reply's `data`: background leaves, then active foreground children. */
export function rowsFromStatus(data: unknown): Row[] {
	if (!data || typeof data !== "object") return [];
	const d = data as { asyncSnapshot?: { kind?: string; version?: number; runs?: unknown }; fleet?: { version?: number; entries?: unknown } };
	const rows: Row[] = [];
	const snap = d.asyncSnapshot;
	if (snap?.kind === "pi-subagents.async-status-snapshot" && snap.version === 1 && Array.isArray(snap.runs)) {
		for (const run of snap.runs) if (run && typeof run === "object") leaves(run as SnapshotNode, rows);
	}
	// The fleet DTO lists every active child, background and foreground (plus a "workflow" entry
	// per active workflow parent), but exposes no ids. Background children are already rows from
	// the snapshot, so the entries beyond that count are foreground ones: take the newest.
	const fleet = d.fleet;
	if (fleet?.version === 1 && Array.isArray(fleet.entries)) {
		const entries = (fleet.entries as FleetEntry[]).filter(
			(e) => e && typeof e === "object" && e.agent !== "workflow",
		);
		const background = rows.filter((r) => r.state === "running" || r.state === "queued" || r.state === "paused").length;
		const extra = entries.length - background;
		if (extra > 0) {
			const newest = [...entries].sort((a, b) => (num(b.startedAt) ?? 0) - (num(a.startedAt) ?? 0)).slice(0, extra);
			for (const e of newest) {
				rows.push({ label: str(e.role) ?? str(e.agent) ?? "subagent", state: "running", startedAt: num(e.startedAt), foreground: true, ...liveFacts(e) });
			}
		}
		attachLiveFacts(rows, entries);
	}
	return rows;
}

interface FleetEntry {
	agent?: unknown;
	role?: unknown;
	model?: unknown;
	startedAt?: unknown;
	tokens?: { total?: unknown; input?: unknown; output?: unknown };
}

function liveFacts(e: FleetEntry): { model?: string; tokens?: number } {
	const t = e.tokens;
	const total = num(t?.total) ?? (num(t?.input) !== undefined || num(t?.output) !== undefined ? (num(t?.input) ?? 0) + (num(t?.output) ?? 0) : undefined);
	return { ...(str(e.model) ? { model: str(e.model) } : {}), ...(total ? { tokens: total } : {}) };
}

/** Fleet start times differ from the snapshot's by a few milliseconds; this is the match window. */
const MATCH_MS = 1_000;

/**
 * Background rows come from the async snapshot, which has no model or tokens, and the fleet DTO
 * has no ids. Pair each active background row with the fleet entry that started nearest to it
 * (within MATCH_MS, each entry used once) to borrow the model and token count.
 */
function attachLiveFacts(rows: Row[], entries: FleetEntry[]): void {
	const free = entries.filter((e) => num(e.startedAt) !== undefined && (str(e.model) || e.tokens));
	const active = rows.filter((r) => !r.foreground && r.startedAt !== undefined && (r.state === "running" || r.state === "queued" || r.state === "paused"));
	const pairs: Array<{ row: Row; entry: FleetEntry; gap: number }> = [];
	for (const row of active) for (const entry of free) pairs.push({ row, entry, gap: Math.abs(row.startedAt! - num(entry.startedAt)!) });
	pairs.sort((a, b) => a.gap - b.gap);
	const usedRows = new Set<Row>();
	const usedEntries = new Set<FleetEntry>();
	for (const { row, entry, gap } of pairs) {
		if (gap > MATCH_MS) break;
		if (usedRows.has(row) || usedEntries.has(entry)) continue;
		usedRows.add(row);
		usedEntries.add(entry);
		Object.assign(row, liveFacts(entry));
	}
}

/** "anthropic/claude-opus-5-5" becomes "opus-5-5". */
export function shortModel(model: string): string {
	return model.split("/").pop()!.replace(/^claude-/, "");
}

/** 16147 becomes "16k", 1_200_000 becomes "1.2M". */
export function fmtCount(n: number): string {
	if (n < 1_000) return String(n);
	if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
	return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** Spawn budget from a `status` reply made with `view: "fleet"` (`data.details.spawnBudget`). */
export function spawnedFrom(data: unknown): Limits["spawned"] {
	const b = (data as { details?: { spawnBudget?: { used?: unknown; limit?: unknown } } } | undefined)?.details?.spawnBudget;
	const used = num(b?.used);
	if (used === undefined) return undefined;
	return { used, limit: num(b?.limit) ?? null };
}

/** Active async runs and their cap from the fleet DTO; undefined when no cap is configured. */
export function asyncActiveFrom(data: unknown): Limits["asyncActive"] {
	const c = (data as { fleet?: { topLevelAsyncCapacity?: { used?: unknown; limit?: unknown } } } | undefined)?.fleet?.topLevelAsyncCapacity;
	const used = num(c?.used);
	const limit = num(c?.limit);
	return used !== undefined && limit !== undefined && limit > 0 ? { used, limit } : undefined;
}

/** `globalConcurrencyLimit` from pi-subagents' config.json text (default 20 when absent). */
export function parallelFrom(configText: string | undefined): number {
	try {
		const n = num(JSON.parse(configText ?? "{}")?.globalConcurrencyLimit);
		return n !== undefined && n > 0 ? Math.floor(n) : 20;
	} catch {
		return 20;
	}
}

/** The limits line under the rows, or undefined when there is nothing to say. */
export function limitsLine(l: Limits): string | undefined {
	const parts: string[] = [];
	if (l.spawned) parts.push(l.spawned.limit === null ? `${l.spawned.used} spawned` : `${l.spawned.used}/${l.spawned.limit} spawned`);
	if (l.asyncActive) parts.push(`${l.asyncActive.used}/${l.asyncActive.limit} async`);
	else if (l.parallel) parts.push(`max ${l.parallel} parallel`);
	return parts.length ? parts.join(" · ") : undefined;
}

const ORDER: Record<RowState, number> = { running: 0, paused: 1, queued: 2, failed: 3, stopped: 3, done: 3 };

/** Active first (oldest first), then finished (newest first). */
export function orderRows(rows: Row[]): Row[] {
	return [...rows].sort((a, b) => {
		const o = ORDER[a.state] - ORDER[b.state];
		if (o) return o;
		if (ORDER[a.state] < 3) return (a.startedAt ?? 0) - (b.startedAt ?? 0);
		return (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0);
	});
}

export function summary(rows: Row[]): { text: string; running: number; failed: number } {
	let running = 0;
	let queued = 0;
	let done = 0;
	let failed = 0;
	for (const r of rows) {
		if (r.state === "running" || r.state === "paused") running++;
		else if (r.state === "queued") queued++;
		else if (r.state === "done") done++;
		else failed++;
	}
	const text = [running ? `${running} running` : "", queued ? `${queued} queued` : "", done ? `${done} done` : "", failed ? `${failed} failed` : ""].filter(Boolean).join(" · ");
	return { text, running, failed };
}

export function elapsed(r: Row, now = Date.now()): string {
	if (!r.startedAt) return "";
	const end = r.endedAt ?? (r.state === "running" || r.state === "paused" ? now : undefined);
	if (end === undefined) return "";
	const s = Math.max(0, Math.round((end - r.startedAt) / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return m < 60 ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** Plain glyphs that exist in common monospace fonts. */
export const GLYPH: Record<RowState, string> = { running: "●", queued: "○", paused: "‖", done: "✓", failed: "×", stopped: "■" };
