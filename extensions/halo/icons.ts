/**
 * Icons: every glyph halo draws from a Nerd Font lives here, each with a plain twin that needs
 * no special font. The plain twin takes the same number of cells as the Nerd glyph (one, or none
 * where the words beside it already say it), so no layout changes between the two sets.
 *
 * Which set is used, first match wins:
 *   1. the PI_HALO_ICONS environment variable ("nerd" or "plain")
 *   2. the user's setting, `/halo icons nerd|plain`, saved in halo.json
 *   3. the brand's default (`icons` in its spec: a brand that ships a font can ask for "nerd")
 *   4. plain, so a terminal without a Nerd Font never shows empty boxes
 *
 * The plain glyphs are ASCII or characters that exist in the common monospace fonts (DejaVu Sans
 * Mono, Noto Sans Mono, Consolas and Lucida Console were checked): • · ↑ ↓ → ● ○ ▲ × ▐ ▌.
 *
 * This file is the only place with Nerd Font code points. test/icons.test.ts fails on one anywhere else.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getBrand } from "./brand.ts";
import { statePath } from "./api.ts";

export type IconSet = "nerd" | "plain";

/** An icon a widget supplies: one string for both sets, or one per set. */
export type IconLike = string | { nerd: string; plain?: string };

interface Pair {
	nerd: string;
	plain: string;
}

/** nf-md-* unless noted. "" means no icon in that set. */
export const ICONS = {
	// sidebar: provider section
	provider: { nerd: "\u{F06A9}", plain: "\u25A0" }, // robot; a filled square
	usage: { nerd: "\u{F0766}", plain: " " }, // circle-outline; the filled slices are computed from it
	branch: { nerd: "\uF418", plain: "" }, // octicons git-branch
	worktree: { nerd: "\u{F04E0}", plain: "wt" }, // source-fork: a linked git worktree
	cache: { nerd: "\u27F3", plain: "cache" },
	resume: { nerd: "\u27F2", plain: "" },
	// a widget row's level marker
	levelOk: { nerd: "\u{F05E1}", plain: "\u25CF" }, // check-circle-outline
	levelWarn: { nerd: "\u{F002A}", plain: "\u25B2" }, // alert-outline
	levelError: { nerd: "\u{F015A}", plain: "\u00D7" }, // close-circle-outline
	levelOff: { nerd: "\u{F0377}", plain: "\u25CB" }, // minus-circle-outline
	levelInfo: { nerd: "\u{F02FD}", plain: "\u2022" }, // information-outline
	// marks for plain setStatus() lines
	statusLsp: { nerd: "\u{F0169}", plain: "\u2022" }, // code-braces
	statusGraphify: { nerd: "\u{F104A}", plain: "\u2022" }, // graph-outline
	// prompt row
	modeBuild: { nerd: "\u{F06A9}", plain: "" }, // robot
	modePlan: { nerd: "\u{F0208}", plain: "" }, // eye
	capLeft: { nerd: "\uE0B6", plain: "\u2590" }, // powerline round cap; right half block
	capRight: { nerd: "\uE0B4", plain: "\u258C" }, // powerline round cap; left half block
	// tool rows
	toolRead: { nerd: "\u{F09EE}", plain: "\u2192" }, // file-document-outline
	toolWrite: { nerd: "\u{F0EED}", plain: "+" }, // file-plus-outline
	toolEdit: { nerd: "\u{F03EB}", plain: "~" }, // pencil
	toolBash: { nerd: "\u{F018D}", plain: "$" }, // console
	toolGrep: { nerd: "\u{F0349}", plain: "?" }, // magnify
	toolFind: { nerd: "\u{F0C7D}", plain: "*" }, // file-search-outline
	toolLs: { nerd: "\u{F0256}", plain: "/" }, // folder-outline
	toolOther: { nerd: "\uF013", plain: "\u2022" }, // fontawesome cog: a tool with no spec of its own
	// turn telemetry: the words beside them say it
	telSpeed: { nerd: "\u{F04C5}", plain: "" }, // speedometer
	telTtft: { nerd: "\u{F051F}", plain: "" }, // timer-sand
	telTotal: { nerd: "\u{F0150}", plain: "" }, // clock-outline
	telStall: { nerd: "\u{F002A}", plain: "" }, // alert-outline
	// diff view
	diff: { nerd: "\u{F02A2}", plain: "" }, // source-branch
	// widgets. A section heading or a row marker with no plain glyph falls back to the row bullet.
	widgetAws: { nerd: "\u{F0EF}", plain: "" }, // fontawesome aws: the logo, about 1.9 cells of ink
	widgetAwsFooter: { nerd: "\u{F0EF} ", plain: "" }, // the footer copy carries a space for the overhang
	widgetContainer: { nerd: "\u{F0868}", plain: "" }, // docker
	widgetK8s: { nerd: "\u{F10FE}", plain: "" }, // kubernetes
	widgetMcp: { nerd: "\u{F06A5}", plain: "" }, // server-network
	widgetSessionTodos: { nerd: "\u{F08A8}", plain: "" }, // clipboard-check-outline
	widgetSubagents: { nerd: "\u{F0B58}", plain: "" }, // account-group-outline
	widgetTodo: { nerd: "\u{F0756}", plain: "" }, // format-list-checks
} as const satisfies Record<string, Pair>;

export type IconName = keyof typeof ICONS;

/** The slice glyphs of the usage circle come after this one: U+F0A9E is one eighth. */
const USAGE_SLICE_BASE = 0xf0a9d;

// ---- which set --------------------------------------------------------------------------------

interface Slot {
	/** The user's saved setting; `loaded` says whether the state file was read yet. */
	setting?: IconSet;
	loaded: boolean;
}

const KEY = Symbol.for("pi-halo/icons");

function slot(): Slot {
	const g = globalThis as unknown as Record<symbol, Slot | undefined>;
	g[KEY] ??= { loaded: false };
	return g[KEY]!;
}

const asSet = (v: unknown): IconSet | undefined => (v === "nerd" || v === "plain" ? v : undefined);

/** The saved setting from the state file (`icons`), or undefined. */
export function loadIconSetting(path = statePath()): IconSet | undefined {
	try {
		return asSet(JSON.parse(readFileSync(path, "utf8"))?.icons);
	} catch {
		return undefined;
	}
}

/** Set the user's setting for this run (undefined forgets it). Saving to the file is `saveIconSetting`. */
export function setIconSetting(set: IconSet | undefined): void {
	const s = slot();
	s.setting = set;
	s.loaded = true;
}

/** Forget what was read, so the next call reads the state file again (tests, and /reload). */
export function resetIconSetting(): void {
	const s = slot();
	s.setting = undefined;
	s.loaded = false;
}

/** Where the current set comes from, for `/halo icons`. */
export function iconSource(): "env" | "setting" | "brand" | "default" {
	if (asSet(process.env.PI_HALO_ICONS)) return "env";
	const s = slot();
	if (!s.loaded) {
		s.setting = loadIconSetting();
		s.loaded = true;
	}
	if (s.setting) return "setting";
	return asSet(getBrand().icons) ? "brand" : "default";
}

/** The icon set in use. */
export function iconSet(): IconSet {
	const env = asSet(process.env.PI_HALO_ICONS);
	if (env) return env;
	const s = slot();
	if (!s.loaded) {
		s.setting = loadIconSetting();
		s.loaded = true;
	}
	return s.setting ?? asSet(getBrand().icons) ?? "plain";
}

// ---- resolving --------------------------------------------------------------------------------

/** The glyph for `name` in the current set. May be "" (no icon). */
export function icon(name: IconName): string {
	return ICONS[name][iconSet()];
}

/** `glyph`, a space, then `text`; just `text` when there is no glyph. */
export const withIcon = (glyph: string, text: string): string => (glyph ? `${glyph} ${text}` : text);

/** "<glyph> " painted with `paint`, or nothing when the set has no glyph here. */
export const leadIcon = (glyph: string, paint: (s: string) => string): string => (glyph ? `${paint(glyph)} ` : "");

/** Private-use code points: where Nerd Font (and any custom icon font) glyphs live. */
const PRIVATE_USE = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;
export const hasPrivateUse = (s: string): boolean => new RegExp(PRIVATE_USE.source, "u").test(s);

/**
 * A widget's or brand's icon in the current set, or undefined when it has none there. An object
 * gives its `nerd` or `plain` string. A bare string is used as given in the nerd set; in the plain
 * set it loses any private-use characters (a font the terminal may not have), and is undefined if
 * nothing but blanks is left.
 */
export function resolveIcon(like: IconLike | undefined): string | undefined {
	if (like === undefined || like === "") return undefined;
	if (typeof like === "object") {
		const s = iconSet() === "nerd" ? like.nerd : like.plain;
		return s ? s : undefined;
	}
	if (iconSet() === "nerd") return like;
	const kept = like.replace(PRIVATE_USE, "");
	return kept.trim() ? kept : undefined;
}

/**
 * A single-cell mark that is safe to draw: in the plain set a private-use glyph (a brand's own
 * font) is replaced by `fallback`.
 */
export function safeGlyph(glyph: string, fallback = "\u25CF"): string {
	return iconSet() === "plain" && hasPrivateUse(glyph) ? fallback : glyph;
}

/** The usage circle for 0 to 100 percent, filled in eighths; a blank slot in the plain set. */
export function usageIcon(percent: number | undefined): string {
	if (iconSet() === "plain") return ICONS.usage.plain;
	const eighths = percent === undefined || !Number.isFinite(percent) ? 0 : Math.round((Math.max(0, Math.min(100, percent)) / 100) * 8);
	return eighths === 0 ? ICONS.usage.nerd : String.fromCodePoint(USAGE_SLICE_BASE + eighths);
}

// ---- saving -----------------------------------------------------------------------------------

/** Save the user's setting into the state file, keeping its other keys. Best effort. */
export function saveIconSetting(set: IconSet | undefined, path = statePath()): void {
	try {
		let data: Record<string, unknown> = {};
		if (existsSync(path)) {
			try {
				data = JSON.parse(readFileSync(path, "utf8")) ?? {};
			} catch {
				data = {};
			}
		}
		if (set) data.icons = set;
		else delete data.icons;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
	} catch {
		// the in-memory setting still applies for this run
	}
}
