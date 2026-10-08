/**
 * OpenCode-style right sidebar (layout from OpenCode's routes/session/sidebar.tsx):
 * 48 columns, panel background, 1 row / 2 columns of padding, one blank row between sections,
 * bold section titles with muted detail lines, and the directory + version pinned to the bottom.
 *
 *    New session
 *
 *    󰚩 Anthropic                   Opus 5.5
 *      Context  ━━━━━━━━━━━━━━━━━━━   4%
 *               40k of 1M tokens
 *      Plan     ━━━━━━━━━━━━━━━━━━━  71%
 *      ↑ 38k  ↓ 1.2k  ⟳ 26k      $0.04
 *
 *    • AWS   dev us-west-2
 *    • MCP   6/6
 *    • LSP   idle
 *
 *    ~/git/pi-halo
 *    ● pi 1.1.0 · halo 0.1.0  · build
 *
 * In fullscreen it sits in an HStack next to pi's layout root (see layout.ts), so it spans the
 * terminal height; a component only reports its own lines, so the panel is padded to that height.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { haloVersion } from "./version.ts";
import { claimedStatusKeys, detailWidget, renderWidget, widgetError, widgetsFor } from "./api.ts";
import { icon, leadIcon, resolveIcon, usageIcon } from "./icons.ts";
import { activeProviderStatus, claimedProviderKeys, providerDisplayName, providerMeters } from "./provider-view.ts";
import { brandLine, fit, fmtTokens, hasOwnColor, homeRelative, lastSep, planColor, primary, sanitize, sanitizeKeepColor, shade, widgetPaint } from "./palette.ts";
import { usageTotals } from "./session-info.ts";
import type { UiState } from "./state.ts";

export const SIDEBAR_WIDTH = 48;
const PAD_X = 2;
/** The git branch icon in the current icon set (Octicons U+F418 with a Nerd Font; none without one). */
export const branchGlyph = (): string => icon("branch");
/** A worktree icon after the branch when the session runs in a linked git worktree. */
export const worktreeTag = (theme: Theme, git: { worktree?: boolean } | undefined): string => (git?.worktree ? theme.fg("accent", ` ${icon("worktree")}`) : "");

/**
 * Between a status row's marker and its label: two spaces, so a wide marker such as the AWS logo
 * (ink about 1.9 cells wide) still has a gap before the label. Every row in the list uses it, so
 * the label and value columns stay lined up. The footer already has the same gap.
 */
const MARK_GAP = "  ";
const PAD_Y = 1;

/**
 * Marker for a plain setStatus() line from an extension that isn't a widget, by status key
 * (one cell wide). Keys not listed here get the bullet.
 */
export const statusMark = (key: string): string => (key === "lsp" ? icon("statusLsp") : key === "graphify" ? icon("statusGraphify") : "\u2022");

/** Status level to the colour and glyph of a widget row's marker (one cell wide). */
const LEVEL_MARK: Record<string, { color: "success" | "warning" | "error" | "dim" | "muted"; glyph: () => string }> = {
	ok: { color: "success", glyph: () => icon("levelOk") },
	warn: { color: "warning", glyph: () => icon("levelWarn") },
	error: { color: "error", glyph: () => icon("levelError") },
	off: { color: "dim", glyph: () => icon("levelOff") },
	info: { color: "muted", glyph: () => icon("levelInfo") },
};

const safe = <T,>(f: () => T, fallback: T): T => {
	try {
		return f();
	} catch {
		return fallback; // stale ctx after a session switch
	}
};

/** One line naming the last failure of a widget, cut to `max` columns (empty when healthy). */
function errorLines(id: string, max: number): string[] {
	const e = widgetError(id);
	return e ? [truncateToWidth(`${e.phase}: ${e.message}`, Math.max(1, max), "…")] : [];
}

/** A clickable sidebar row: its line in the rendered panel (0 is the top padding row). */
export interface SidebarHit {
	y: number;
	widgetId: string;
	/** Index into the widget's `detail` lines. */
	index: number;
}

/** `hits`, when given, is filled with the clickable rows of this render (cleared first). */
export function renderSidebar(state: UiState, theme: Theme, width: number, height: number, piVersion: string, hits?: SidebarHit[]): string[] {
	if (hits) hits.length = 0;
	/** Clickable detail lines by section: a section's lines and where its detail lines start. */
	const clicks = new Map<string[], { widgetId: string; first: number; count: number }>();
	const ctx = state.ctx;
	const inner = Math.max(1, width - PAD_X * 2);
	/**
	 * Provider section: who is answering, how full the context window is, any extra bars the
	 * provider registered (provider.ts, for example how much of a plan is used), and this
	 * session's tokens and cost.
	 *
	 *   󰚩 Acme                      Opus 5.5
	 *   󰪞 Context  ━━━━━━━━━━━━━━━━━━━   4%
	 *              40k of 1M tokens
	 *   󰪡 Plan     ━━━━━━━━━━━━━━━━━━━  71%
	 *     ↑ 38k  ↓ 1.2k  ⟳ 26k      $0.04
	 */
	const providerSection = (): string[] => {
		const c = ctx!;
		const model = c.model;
		const statuses = safe(() => state.statuses(), new Map<string, string>());
		const spec = activeProviderStatus(c, statuses);
		const providerName = providerDisplayName(c, spec);
		const modelName = (model?.name ?? model?.id ?? "").replace(/^Claude /, "");
		const glyph = spec?.color ? widgetPaint(theme, spec.color, undefined, icon("provider")) : theme.fg("accent", icon("provider"));
		const head = `${glyph} ${theme.bold(text(providerName))}`;
		const lines = [spread(head, muted(modelName), inner)];

		const cu = safe(() => c.getContextUsage(), undefined);
		const usage = safe(() => usageTotals(c), undefined);
		const LABEL = 9; // "Context  "
		const pctW = 5; // " 100%"
		const barW = Math.max(6, inner - 2 - LABEL - pctW);
		// `gauge` puts a fill-level circle in the indent column, in the bar's colour.
		const meter = (label: string, pct: number | undefined, color?: (s: string) => string, gauge = false) => {
			const p = Math.max(0, Math.min(100, pct ?? 0));
			const filled = Math.round((p / 100) * barW);
			const tone = color ?? ((x: string) => theme.fg(p >= 85 ? "error" : p >= 60 ? "warning" : "accent", x));
			const bar = tone("━".repeat(filled)) + theme.fg("borderMuted", "━".repeat(barW - filled));
			const num = pct === undefined ? "  –" : `${Math.round(p)}%`;
			const lead = gauge ? `${tone(usageIcon(pct))} ` : "  ";
			return `${lead}${muted(label.padEnd(LABEL))}${bar}${tone(num.padStart(pctW))}`;
		};

		lines.push(meter("Context", cu?.percent ?? undefined, undefined, true));
		if (cu?.contextWindow) {
			lines.push(`  ${" ".repeat(LABEL)}${theme.fg("dim", `${fmtTokens(cu.tokens ?? 0)} of ${fmtTokens(cu.contextWindow).replace(/\.0(?=[kM]$)/, "")} tokens`)}`);
		}

		// Provider bars: a plan or quota the provider reports, in its own colour when it has one.
		if (spec) {
			for (const m of providerMeters(spec, c, statuses)) {
				const paint = m.sgr ? (x: string) => `${m.sgr}${x}\x1b[39m` : m.color ? (x: string) => widgetPaint(theme, m.color, undefined, x) : undefined;
				lines.push(meter(m.label, m.percent, paint, true));
				if (m.detail) lines.push(`  ${" ".repeat(LABEL)}${theme.fg("dim", m.detail)}`);
			}
		}

		if (usage) {
			const io = [
				`↑ ${fmtTokens(usage.input + usage.cacheWrite)}`,
				`↓ ${fmtTokens(usage.output)}`,
				...(usage.cacheRead ? [`${icon("cache")} ${fmtTokens(usage.cacheRead)}`] : []),
			].join("  ");
			lines.push(`  ${spread(theme.fg("dim", io), text(`$${usage.cost.toFixed(2)}`), inner - 2)}`);
		}
		return lines;
	};
	const text = (s: string) => theme.fg("text", s);
	const muted = (s: string) => theme.fg("muted", s);
	const title = (s: string) => theme.bold(text(s));

	// Sections, each a list of lines; joined with one blank row between them.
	const sections: string[][] = [];

	const sessionName = safe(() => ctx?.sessionManager.getSessionName(), undefined);
	// The name is chosen by the user or a model, so it is cleaned and kept to one line.
	sections.push([title(sanitize(sessionName) || "New session")]);

	if (ctx) sections.push(providerSection());

	// Registered widgets: "• Title  value", detail lines indented under it.
	const widgetLines: string[] = [];
	const rowClicks: Array<{ widgetId: string; first: number; count: number }> = [];
	const widgets = widgetsFor("sidebar");
	// Label column fits the longest widget title or status name (up to 9 columns).
	const allStatuses = safe(() => state.statuses(), new Map<string, string>());
	const statusNames = [...allStatuses.keys()].filter((k) => !claimedProviderKeys(ctx, allStatuses).has(k));
	const labelW = Math.min(9, Math.max(3, ...widgets.filter((w) => w.sidebar !== "section").map((w) => visibleWidth(w.title ?? w.id)), ...statusNames.map((n) => n.length))) + 2;
	const sectionWidgets: string[][] = [];
	for (const w of widgets) {
		const rc = { theme, ctx, width: inner };
		if (w.sidebar === "section") {
			const view = renderWidget(w, rc);
			if (!view) continue;
			const value = view.text ? `  ${muted(view.text)}` : "";
			const wIcon = resolveIcon(w.icon);
			const detail = detailWidget(w, rc);
			const section = [`${leadIcon(wIcon ?? "", (s) => theme.fg("muted", s))}${title(w.title ?? w.id)}${value}`, ...detail, ...errorLines(w.id, inner)];
			if (w.onDetailClick && detail.length) clicks.set(section, { widgetId: w.id, first: 1, count: detail.length });
			sectionWidgets.push(section);
			continue;
		}
		const view = renderWidget(w, rc);
		if (!view) continue;
		const mark = view.level ? LEVEL_MARK[view.level] : undefined;
		// A widget icon is the row's marker, in the view's colour (or its level's); it is then not
		// repeated beside the value.
		const rowIcon = resolveIcon(w.icon);
		const viewIcon = resolveIcon(view.icon);
		const dot = rowIcon ? widgetPaint(theme, view.color, view.level, rowIcon) : mark ? theme.fg(mark.color, mark.glyph()) : widgetPaint(theme, view.color, undefined, "•");
		const label = text((w.title ?? w.id).padEnd(labelW));
		const value = widgetPaint(theme, view.color, view.level, `${viewIcon && !rowIcon ? `${viewIcon} ` : ""}${view.text ?? ""}`);
		widgetLines.push(`${dot}${MARK_GAP}${label}${value}${view.tag ? ` ${view.tag}` : ""}`);
		const indent = " ".repeat(1 + MARK_GAP.length + labelW);
		const detail = detailWidget(w, rc);
		if (w.onDetailClick && detail.length) rowClicks.push({ widgetId: w.id, first: widgetLines.length, count: detail.length });
		for (const d of detail) widgetLines.push(`${indent}${muted(d)}`);
		for (const d of errorLines(w.id, inner - indent.length)) widgetLines.push(`${indent}${theme.fg("error", d)}`);
	}
	// Other extensions' setStatus() strings (LSP, subagents, ...), unless a widget
	// claims the key. "Label: value" splits into the label column; otherwise the key is the label.
	const claimed = claimedStatusKeys();
	const providerKeys = claimedProviderKeys(ctx, allStatuses);
	for (const [key, raw] of [...allStatuses].sort(([a], [b]) => a.localeCompare(b))) {
		if (claimed.has(key) || providerKeys.has(key)) continue; // provider usage is in the provider section
		const clean = sanitizeKeepColor(raw);
		const plain = stripSgr(clean);
		if (!plain.trim()) continue;
		const m = plain.match(/^([A-Za-z][\w .-]{0,10}):\s*(.+)$/);
		// A name wider than the label column is cut with an ellipsis so it never runs into the value.
		const name = truncateToWidth(m ? m[1]! : key.replace(/^./, (c) => c.toUpperCase()), labelW - 1, "…");
		const value = m ? muted(m[2]!) : hasOwnColor(clean) ? clean : muted(clean);
		widgetLines.push(`${theme.fg("muted", statusMark(key))}${MARK_GAP}${text(name.padEnd(labelW))}${value}`);
	}
	if (widgetLines.length) {
		sections.push(widgetLines);
		if (rowClicks.length) clicks.set(widgetLines, rowClicks[0]!);
	}
	sections.push(...sectionWidgets);

	const body: string[] = [];
	sections.forEach((s, i) => {
		if (i > 0) body.push("");
		const c = clicks.get(s);
		if (c && hits) {
			const groups = s === widgetLines ? rowClicks : [c];
			for (const g of groups) for (let k = 0; k < g.count; k++) hits.push({ y: PAD_Y + body.length + g.first + k, widgetId: g.widgetId, index: k });
		}
		body.push(...s);
	});

	// Bottom block: directory (parent muted, leaf bright), git, and the brand/version line.
	const dir = homeRelative(ctx?.cwd ?? process.cwd());
	const cut = lastSep(dir);
	const dirLine = cut >= 0 ? `${muted(dir.slice(0, cut + 1))}${text(dir.slice(cut + 1))}` : text(dir);
	// Git branch and status (dirty files, ahead/behind) beside the directory, or on the next line
	// when both don't fit.
	const git = state.git;
	let gitPart = "";
	if (git?.branch) {
		gitPart = `${leadIcon(branchGlyph(), (s) => theme.fg("accent", s))}${text(git.branch)}`;
		if (git.dirty) gitPart += theme.fg("warning", ` ●${git.dirty}`);
		if (git.ahead) gitPart += theme.fg("dim", ` ↑${git.ahead}`);
		if (git.behind) gitPart += theme.fg("dim", ` ↓${git.behind}`);
		gitPart += worktreeTag(theme, git);
	}
	const sameLine = gitPart && visibleWidth(dirLine) + 2 + visibleWidth(gitPart) <= inner;
	const locLines = !gitPart ? [dirLine] : sameLine ? [`${dirLine}  ${gitPart}`] : [dirLine, gitPart];
	const mode = state.mode === "plan" ? planColor(theme, "plan") : primary(theme, "build");
	const footer = [...locLines, "", `${brandLine(theme, piVersion, haloVersion())}  ${muted("·")} ${mode}`];

	const rows = Math.max(height, 1);
	const usable = rows - PAD_Y * 2;
	const lines = body.slice(0, Math.max(0, usable - footer.length - 1));
	if (hits) hits.splice(0, hits.length, ...hits.filter((h) => h.y - PAD_Y < lines.length)); // rows cut off by a short terminal
	while (lines.length < usable - footer.length) lines.push("");
	lines.push(...footer);

	const pad = " ".repeat(PAD_X);
	const blank = shade(theme, "", width);
	const out = [
		...Array(PAD_Y).fill(blank),
		...lines.map((l) => shade(theme, `${pad}${fit(l, inner)}${pad}`, width)),
		...Array(PAD_Y).fill(blank),
	];
	return out.slice(0, rows);
}

const stripSgr = (s: string) => s.replace(/\x1b\[[0-9;:]*m/g, "");

/** Left text, right text pushed to the far edge of `width` columns. */
function spread(left: string, right: string, width: number): string {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	return gap >= 1 ? `${left}${" ".repeat(gap)}${right}` : truncateToWidth(`${left} ${right}`, width, "…");
}

export { truncateToWidth };
