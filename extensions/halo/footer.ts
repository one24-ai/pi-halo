/**
 * Footer: one line under the prompt, OpenCode style.
 *
 *   ⠋ Working 4s
 *
 * pi's working indicator. The cwd, git branch, context, cost, status widgets and other extensions'
 * setStatus() strings (MCP, LSP, provider usage, ...) live in the sidebar; they only show here
 * while the sidebar is hidden (ctrl+x b, a narrow terminal, or the overlay fallback).
 * Segments drop from the left of the right group when the line is too narrow.
 */

import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { claimedStatusKeys, renderWidget, widgetsFor } from "./api.ts";
import { activeProviderStatus, claimedProviderKeys, providerDisplayName, providerFooterText } from "./provider-view.ts";
import { fmtDuration, fmtTokens, hasOwnColor, homeRelative, sanitizeKeepColor, widgetPaint } from "./palette.ts";
import { usageTotals } from "./session-info.ts";
import { leadIcon, resolveIcon } from "./icons.ts";
import { branchGlyph, worktreeTag } from "./sidebar.ts";
import type { UiState } from "./state.ts";

export function renderFooter(state: UiState, theme: Theme, data: ReadonlyFooterDataProvider, width: number): string[] {
	// The home screen has its own bottom bar (home.ts).
	if (state.home()) return [];
	const ctx = state.ctx;
	const sep = theme.fg("borderMuted", " │ ");

	// Left: cwd and git only while the sidebar (which shows them) is hidden, then the indicator.
	const sidebar = state.sidebarShown();
	const left: string[] = sidebar ? [] : [theme.fg("muted", homeRelative(ctx?.cwd ?? process.cwd()))];
	const branch = sidebar ? undefined : (state.git?.branch ?? data.getGitBranch() ?? undefined);
	if (branch) {
		let g = `${leadIcon(branchGlyph(), (s) => theme.fg("accent", s))}${theme.fg("text", branch)}`;
		if (state.git?.dirty) g += theme.fg("warning", ` ●${state.git.dirty}`);
		if (state.git?.ahead) g += theme.fg("dim", ` ↑${state.git.ahead}`);
		if (state.git?.behind) g += theme.fg("dim", ` ↓${state.git.behind}`);
		g += worktreeTag(theme, state.git);
		left.push(g);
	}
	// pi's status indicator (spinner + "Working…", retry countdown, compaction) with elapsed time.
	const indicator = state.statusIndicator;
	if (indicator) {
		const elapsed = state.workingSince ? theme.fg("dim", ` ${fmtDuration(Date.now() - state.workingSince)}`) : "";
		let status = "";
		try {
			status = indicator.renderInBorder(40);
		} catch {
			status = "";
		}
		left.push(`${status}${elapsed}`);
	} else if (state.workingSince) {
		left.push(theme.fg("dim", `working ${fmtDuration(Date.now() - state.workingSince)}`));
	} else if (state.lastDurationMs !== undefined) {
		left.push(theme.fg("dim", `done ${fmtDuration(state.lastDurationMs)}`));
	}

	// Right (sidebar hidden only): statuses, then context and cost.
	const right: string[] = [];
	const showStatuses = !state.sidebarShown();
	for (const w of showStatuses ? widgetsFor("footer") : []) {
		const view = renderWidget(w, { theme, ctx, width });
		const viewIcon = resolveIcon(view?.icon);
		if (!view?.text && !viewIcon) continue;
		const text = [viewIcon, view!.label, view!.text].filter(Boolean).join(" ");
		right.push(widgetPaint(theme, view!.color, view!.level, text));
	}
	const claimed = new Set([...claimedStatusKeys(), ...claimedProviderKeys(ctx, data.getExtensionStatuses())]);
	const statuses = [...(showStatuses ? data.getExtensionStatuses() : new Map<string, string>())]
		.filter(([k]) => !claimed.has(k))
		.sort(([a], [b]) => a.localeCompare(b));
	for (const [, raw] of statuses) {
		const s = sanitizeKeepColor(raw);
		if (!visibleWidth(s)) continue;
		right.push(hasOwnColor(s) ? s : theme.fg("muted", s));
	}

	// Context, cost and provider usage are in the sidebar's Context section; with the sidebar hidden
	// they come back here.
	if (ctx && showStatuses) {
		try {
			const cu = ctx.getContextUsage();
			const usage = usageTotals(ctx);
			const parts: string[] = [];
			if (cu?.tokens != null) parts.push(fmtTokens(cu.tokens));
			if (cu?.percent != null) {
				const c = cu.percent >= 85 ? "error" : cu.percent >= 60 ? "warning" : "muted";
				parts.push(theme.fg(c, `${cu.percent.toFixed(1)}%`));
			}
			parts.push(`$${usage.cost.toFixed(2)}`);
			const spec = activeProviderStatus(ctx, data.getExtensionStatuses());
			const extra = spec ? providerFooterText(spec, ctx, data.getExtensionStatuses()) : "";
			const tag = spec ? providerDisplayName(ctx, spec).toLowerCase() : "";
			right.push(theme.fg("muted", parts.join(" ")) + (visibleWidth(extra) ? ` ${theme.fg("dim", tag)} ${extra}` : ""));
		} catch {
			// stale ctx
		}
	}

	const leftStr = ` ${left.join("  ")}`;
	// Drop right-hand segments from the front until it fits next to the left part.
	let segs = right;
	const fits = () => visibleWidth(leftStr) + visibleWidth(segs.join(sep)) + 3 <= width;
	while (segs.length > 1 && !fits()) segs = segs.slice(1);
	const rightStr = segs.join(sep);
	const gap = width - visibleWidth(leftStr) - visibleWidth(rightStr) - 1;
	if (gap >= 1) return [`${leftStr}${" ".repeat(gap)}${rightStr} `];
	return [truncateToWidth(leftStr, width, "…"), truncateToWidth(` ${rightStr}`, width, "…")];
}

export function installFooter(ctx: ExtensionContext, state: UiState, onRequestRender: (fn: (() => void) | undefined) => void): () => void {
	ctx.ui.setFooter((tui, theme, data) => {
		onRequestRender(() => tui.requestRender());
		state.statuses = () => data.getExtensionStatuses();
		const unsub = data.onBranchChange(() => tui.requestRender());
		return {
			dispose() {
				unsub();
				onRequestRender(undefined);
			},
			invalidate() {},
			render: (width: number) => renderFooter(state, theme, data, width),
		};
	});
	return () => {
		try {
			ctx.ui.setFooter(undefined);
		} catch {
			// stale ctx
		}
	};
}
