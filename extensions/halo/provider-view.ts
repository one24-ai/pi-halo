/**
 * Turns a provider status spec (provider.ts) into what the sidebar and footer draw.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WidgetColor } from "./api.ts";
import { sanitizeKeepColor } from "./palette.ts";
import { getProviderStatus, providerStatusKeys, type ProviderStatusSpec } from "./provider.ts";

export interface ResolvedMeter {
	label: string;
	percent?: number;
	detail?: string;
	color?: WidgetColor;
	/** The status's own colour escape, for a `statusKey` meter whose provider colours it. */
	sgr?: string;
}

const stripSgr = (s: string) => s.replace(/\x1b\[[0-9;:]*m/g, "");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Drop a leading glyph and the provider's name or id from a status, leaving "71%" or "71% of plan". */
function withoutLabel(text: string, names: string[]): string {
	let out = text.replace(/^[^\p{L}\p{N}]+/u, "");
	for (const n of names) {
		if (!n) continue;
		const m = out.match(new RegExp(`^${escapeRe(n)}\\b[\\s:·-]*`, "i"));
		if (m) {
			out = out.slice(m[0].length);
			break;
		}
	}
	return out.trim();
}

function namesOf(spec: ProviderStatusSpec): string[] {
	return [spec.name ?? "", ...(Array.isArray(spec.provider) ? spec.provider : [spec.provider])];
}

/** The bars for the provider section: the `statusKey` percentage first, then `meters`. */
export function providerMeters(spec: ProviderStatusSpec, ctx: ExtensionContext, statuses: ReadonlyMap<string, string>): ResolvedMeter[] {
	const out: ResolvedMeter[] = [];
	const raw = spec.statusKey ? statuses.get(spec.statusKey) : undefined;
	if (raw) {
		const clean = sanitizeKeepColor(raw);
		const pct = Number.parseFloat(withoutLabel(stripSgr(clean), namesOf(spec)).match(/\d+(?:\.\d+)?/)?.[0] ?? "");
		if (Number.isFinite(pct)) out.push({ label: spec.label ?? "Plan", percent: pct, sgr: clean.match(/\x1b\[[0-9;:]*m/)?.[0] });
	}
	if (spec.meters) {
		try {
			for (const m of spec.meters(ctx) ?? []) out.push({ ...m, percent: Number.isFinite(m.percent) ? m.percent : undefined });
		} catch {
			// a broken provider hook must not take the sidebar down
		}
	}
	return out;
}

/** Short text for the footer, next to the context: the status without its label (keeping its colour), or the bars as "Plan 71%". */
export function providerFooterText(spec: ProviderStatusSpec, ctx: ExtensionContext, statuses: ReadonlyMap<string, string>): string {
	const raw = spec.statusKey ? statuses.get(spec.statusKey) : undefined;
	if (raw) {
		const clean = sanitizeKeepColor(raw);
		const text = withoutLabel(stripSgr(clean), namesOf(spec));
		const sgr = clean.match(/\x1b\[[0-9;:]*m/)?.[0];
		return sgr && text ? `${sgr}${text}\x1b[39m` : text;
	}
	return providerMeters(spec, ctx, statuses)
		.filter((m) => m.percent !== undefined)
		.map((m) => `${m.label} ${Math.round(m.percent!)}%`)
		.join(" ");
}

/**
 * Heading for the provider: the spec's `name`, else the name the provider registered with pi
 * (`ctx.modelRegistry.getProviderDisplayName`), else the id with a capital letter. A provider's
 * name is often its login dialog title, such as "Acme (Builder ID / Google / GitHub)", so a
 * trailing parenthetical is dropped to leave "Acme".
 */
export function providerDisplayName(ctx: ExtensionContext | undefined, spec?: ProviderStatusSpec): string {
	if (spec?.name) return spec.name;
	const id = ctx?.model?.provider;
	if (!id) return "no provider";
	let name: string | undefined;
	try {
		name = ctx?.modelRegistry?.getProviderDisplayName(id);
	} catch {
		// stale ctx or an older pi
	}
	const short = name?.replace(/\s*\([^)]*\)\s*$/, "").trim();
	return short && short !== id ? short : id.replace(/^./, (x) => x.toUpperCase());
}

/** The implicit spec for a provider that follows the `<provider>-usage` status convention. */
const conventional = (provider: string): ProviderStatusSpec => ({ provider, statusKey: `${provider}-usage` });

/**
 * The spec in effect for the active provider: the registered one, else, when the provider publishes
 * a `<provider>-usage` status that carries a percentage (a convention some provider extensions follow), one built from
 * that convention, so a provider needs no registration just to get its Plan bar. A status without a
 * number is left alone and shows in the generic status list.
 */
export function activeProviderStatus(ctx: ExtensionContext | undefined, statuses: ReadonlyMap<string, string>): ProviderStatusSpec | undefined {
	const id = ctx?.model?.provider;
	if (!id) return undefined;
	const registered = getProviderStatus(id);
	if (registered) return registered;
	const spec = conventional(id);
	return providerMeters(spec, ctx!, statuses).length ? spec : undefined;
}

/** Status keys that belong to the provider section, so the generic status lists skip them. */
export function claimedProviderKeys(ctx: ExtensionContext | undefined, statuses: ReadonlyMap<string, string>): Set<string> {
	const keys = providerStatusKeys();
	const spec = activeProviderStatus(ctx, statuses);
	if (spec?.statusKey) keys.add(spec.statusKey);
	return keys;
}
