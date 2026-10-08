/**
 * Mutable UI state shared by the halo pieces (one instance per extension runtime).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GitInfo } from "./session-info.ts";

export type AgentMode = "build" | "plan";

export interface UiState {
	ctx: ExtensionContext | undefined;
	mode: AgentMode;
	sidebarVisible: boolean;
	/** Set while the agent runs. */
	workingSince: number | undefined;
	/**
	 * pi's status indicator (working spinner, retry countdown, compaction) handed to the editor
	 * through setWorkingStatusIndicator; the footer renders it instead of the editor's top row.
	 */
	statusIndicator: { renderInBorder(width: number): string; renderSpinnerInBorder(width: number): string } | undefined;
	lastDurationMs: number | undefined;
	/** Most recent other session in this directory, for the home screen's resume hint. */
	lastSession: { path: string; label: string; modified: Date } | undefined;
	git: GitInfo | undefined;
	/** setStatus() strings from all extensions (set by the footer, read by the sidebar). */
	statuses: () => ReadonlyMap<string, string>;
	/** Whether the sidebar is on screen; when it isn't, statuses fall back to the footer. */
	sidebarShown: () => boolean;
	/** True while the OpenCode-style home screen is shown (fullscreen, no message yet). */
	home: () => boolean;
	/** Whether the sidebar is drawn as a real split (fullscreen) or unavailable. */
	layout: "split" | "overlay" | "none";
}

export function createState(): UiState {
	return {
		ctx: undefined,
		mode: "build",
		sidebarVisible: true,
		workingSince: undefined,
		statusIndicator: undefined,
		lastDurationMs: undefined,
		lastSession: undefined,
		git: undefined,
		statuses: () => new Map(),
		sidebarShown: () => false,
		home: () => false,
		layout: "none",
	};
}
