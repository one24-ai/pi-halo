/**
 * Finish alert: when a long run ends, or a run that has been going for a while stops to ask you
 * something, ring the terminal bell and put a mark in the window title, so you notice from another
 * window or tab.
 *
 * It uses only two terminal standards and no OS commands: BEL (0x07) and the OSC 0 title. What the
 * terminal does with them is its own setting (a taskbar flash, a tab badge, a sound, or nothing).
 * Runs shorter than the threshold stay quiet, and `/halo alert off` switches it off.
 *
 * The setting lives in the same state file as the disabled widgets (`alert`: `{ enabled, seconds }`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { statePath } from "./api.ts";

export const DEFAULT_ALERT_SECONDS = 30;
const MAX_SECONDS = 24 * 60 * 60;

export interface AlertSettings {
	enabled: boolean;
	/** Runs shorter than this stay quiet. */
	seconds: number;
}

const BEL = "\x07";

export function defaultAlert(): AlertSettings {
	return { enabled: true, seconds: DEFAULT_ALERT_SECONDS };
}

/** Settings from the state file; anything missing or malformed falls back to the default. */
export function loadAlert(path = statePath()): AlertSettings {
	const out = defaultAlert();
	try {
		const a = JSON.parse(readFileSync(path, "utf8"))?.alert;
		if (typeof a?.enabled === "boolean") out.enabled = a.enabled;
		if (typeof a?.seconds === "number" && Number.isFinite(a.seconds) && a.seconds >= 0 && a.seconds <= MAX_SECONDS) out.seconds = a.seconds;
	} catch {
		// no file yet, or unreadable: defaults
	}
	return out;
}

/** Save into the state file, keeping its other keys. Best effort, like the widget list. */
export function saveAlert(s: AlertSettings, path = statePath()): void {
	try {
		let data: Record<string, unknown> = {};
		if (existsSync(path)) {
			try {
				data = JSON.parse(readFileSync(path, "utf8")) ?? {};
			} catch {
				data = {};
			}
		}
		data.alert = { enabled: s.enabled, seconds: s.seconds };
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
	} catch {
		// the in-memory setting still applies for this run
	}
}

/** Why the agent stopped. */
export type AlertReason = "finished" | "failed" | "waiting";

/**
 * Whether to alert: on, and the run has lasted the threshold. A shorter run is one you are
 * watching. This holds for a finish, a failure and a stop that waits for you alike.
 */
export function shouldAlert(s: AlertSettings, durationMs: number | undefined): boolean {
	return s.enabled && durationMs !== undefined && durationMs >= s.seconds * 1000;
}

/** The mark put in front of the title. */
export const TITLE_MARK: Record<AlertReason, string> = { finished: "✓", failed: "✗", waiting: "?" };

/** Title while alerting: the mark in front of pi's own title. */
export function alertTitle(reason: AlertReason, title: string): string {
	return `${TITLE_MARK[reason]} ${title}`;
}

export interface AlertOutput {
	/** Raw write to the terminal. */
	write(data: string): void;
	setTitle(title: string): void;
}

/** Ring the bell and mark the title. */
export function alert(out: AlertOutput, reason: AlertReason, title: string): void {
	out.write(BEL);
	out.setTitle(alertTitle(reason, title));
}

/**
 * How a run ended, from the last assistant message's stop reason in an agent_end message list. An
 * abort means you pressed esc, so you are there and nothing should ring.
 */
export function runOutcome(messages: readonly unknown[] | undefined): "finished" | "failed" | "aborted" {
	for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
		const m = messages![i] as { role?: string; stopReason?: string } | undefined;
		if (m?.role !== "assistant") continue;
		return m.stopReason === "error" ? "failed" : m.stopReason === "aborted" ? "aborted" : "finished";
	}
	return "finished";
}

/** The title pi itself sets when there is no session name: "π - <folder>". Used to clear the mark. */
export function plainTitle(cwd: string, sessionName?: string): string {
	const folder = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
	return sessionName ? `π - ${sessionName} - ${folder}` : `π - ${folder}`;
}

/** "off", "on", or a number of seconds ("30", "30s", "2m"); undefined when it is none of these. */
export function parseAlertArg(arg: string): Partial<AlertSettings> | undefined {
	const a = arg.trim().toLowerCase();
	if (a === "on") return { enabled: true };
	if (a === "off") return { enabled: false };
	const m = a.match(/^(\d+(?:\.\d+)?)\s*(s|m)?$/);
	if (!m) return undefined;
	const seconds = Number(m[1]) * (m[2] === "m" ? 60 : 1);
	return seconds <= MAX_SECONDS ? { enabled: true, seconds } : undefined;
}

export function describeAlert(s: AlertSettings): string {
	return s.enabled ? `finish alert on (runs over ${s.seconds}s)` : "finish alert off";
}
