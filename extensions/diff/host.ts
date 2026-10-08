/**
 * The diff view's shared store, for other extensions and packages.
 *
 * It lives on globalThis under a registered symbol (pi loads each extension in its own module
 * scope, so a plain module variable would be a separate copy in each). Actions added before the
 * diff view loads are kept and shown once it does; a diff opened while it is not loaded, or is
 * switched off in /widgets, reports that by returning false. So does one that could not be shown:
 * there is no interactive UI, or the view is already open.
 *
 * This file imports only types, so it has no files to bring along; the halo client re-exports it.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DiffAction, DiffHost, OpenDiffRequest } from "./types.ts";

export const DIFF_API_VERSION = 1;
const KEY = Symbol.for("pi-halo/diff");

export function diffHost(): DiffHost {
	const g = globalThis as unknown as Record<symbol, DiffHost | undefined>;
	const host = (g[KEY] ??= { apiVersion: DIFF_API_VERSION, actions: [] });
	host.apiVersion = Math.max(host.apiVersion, DIFF_API_VERSION);
	return host;
}

/**
 * Add an entry to the diff view's action menu (`a`). It is run with the file and hunk under the
 * cursor, after the panel has closed. Adding the same id again replaces it. The returned function
 * removes it.
 */
export function addDiffAction(action: DiffAction): () => void {
	const host = diffHost();
	host.actions = [...host.actions.filter((a) => a.id !== action.id), action];
	return () => {
		host.actions = host.actions.filter((a) => a !== action);
	};
}

/**
 * Open the diff view on the uncommitted git changes (as `/diff` does), with `file` selected when it
 * is among them (a path relative to the session's directory, or absolute). Resolves true once it was
 * shown and closed, and false, without showing anything, when the diff view is not loaded, has been
 * switched off, is already open, or there is no interactive UI.
 */
export async function openChanges(ctx: ExtensionContext, file?: string): Promise<boolean> {
	const open = diffHost().openChanges;
	return open ? open(ctx, file) : false;
}

/**
 * Show a unified diff in the diff view and resolve true when it closes. Resolves false, without
 * showing anything, when the diff view is not loaded, has been switched off, is already open, or
 * there is no interactive UI.
 */
export async function openDiff(ctx: ExtensionContext, req: OpenDiffRequest): Promise<boolean> {
	const open = diffHost().open;
	return open ? open(ctx, req) : false;
}
