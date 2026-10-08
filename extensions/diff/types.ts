/**
 * Types shared by the diff view and its client API (client.ts). Types only: nothing here runs.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** A changed file, as handed to an action. */
export interface DiffFileInfo {
	path: string;
	/** Where a renamed file came from. */
	oldPath?: string;
	/** A (added), M (modified), D (deleted) or R (renamed). */
	status: string;
	added: number;
	removed: number;
	binary: boolean;
}

/** One hunk of a file's diff. */
export interface DiffHunkInfo {
	/** Position in the file, from 0. */
	index: number;
	/** The `@@ -a,b +c,d @@` line. */
	header: string;
	/** The whole hunk as unified diff text, header line included. */
	text: string;
}

/** What an action is run with: the file and hunk under the cursor, and the patch for the file. */
export interface DiffActionContext {
	ctx: ExtensionContext;
	cwd: string;
	/** "changes", "branch", or "external" for a diff opened with openDiff. */
	source: string;
	file: DiffFileInfo;
	/** The hunk at the top of the diff pane, or undefined for a file with no text hunks. */
	hunk?: DiffHunkInfo;
	/** The file's diff as unified text: header lines and every hunk. */
	filePatch: string;
}

/** An entry in the diff view's action menu (`a`). The panel closes before `run` is called. */
export interface DiffAction {
	/** Unique; adding the same id again replaces the action. */
	id: string;
	label: string;
	run: (c: DiffActionContext) => void | Promise<void>;
}

/** A diff to show that did not come from git in this directory. */
export interface OpenDiffRequest {
	title: string;
	/** Unified diff text (`git diff` or `diff -u` output). */
	diff: string;
	/** Working directory passed on to actions. Default: the session's. */
	cwd?: string;
}

/** The shared store on globalThis, so load order between packages does not matter. */
export interface DiffHost {
	apiVersion: number;
	actions: DiffAction[];
	/** Set by the diff extension while it is loaded. Resolves true if the diff was shown and closed, false if nothing was shown. */
	open?: (ctx: ExtensionContext, req: OpenDiffRequest) => Promise<boolean>;
	/** Set by the diff extension while it is loaded: the git changes view, on a file when given. Same result as `open`. */
	openChanges?: (ctx: ExtensionContext, file?: string) => Promise<boolean>;
}
