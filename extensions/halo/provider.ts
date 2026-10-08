/**
 * Provider status: how a model provider adds its own facts to the sidebar's provider section and
 * the footer, such as how much of a plan or quota has been used.
 *
 * Without a registration the section shows the provider's name, the model, context use, tokens and
 * cost, all of which pi reports for every provider. A `<provider>-usage` status that carries a
 * percentage also becomes a Plan bar with no registration (provider-view.ts, activeProviderStatus). A provider extension (or any other package)
 * adds more by registering a spec from client.ts:
 *
 *     import { registerProviderStatus } from "pi-halo/client";
 *
 *     // The provider already publishes a percentage with ctx.ui.setStatus("acme-usage", "Acme 71%"):
 *     registerProviderStatus({ provider: "acme", name: "Acme", color: "plan", statusKey: "acme-usage", label: "Plan" });
 *
 *     // Or compute meters from anything:
 *     registerProviderStatus({
 *       provider: "acme",
 *       meters: (ctx) => [{ label: "Quota", percent: readQuota(ctx), detail: "5 of 20 requests" }],
 *     });
 *
 * The registry lives on globalThis (see brand.ts), so load order doesn't matter and a later
 * registration for the same provider replaces the earlier one.
 *
 * This file has no value imports, so client.ts can re-export it without loading anything else.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WidgetColor } from "./api.ts";

/** One bar in the provider section. */
export interface ProviderMeter {
	/** Up to 9 columns, e.g. "Plan". */
	label: string;
	/** 0 to 100. Undefined shows a dash. */
	percent?: number;
	/** Dim line under the bar, e.g. "5 of 20 requests". */
	detail?: string;
	/** Bar colour. Default: accent, warning from 60%, error from 85%. */
	color?: WidgetColor;
}

export interface ProviderStatusSpec {
	/** The `model.provider` id (or ids) this applies to. */
	provider: string | string[];
	/** Display name for the section heading. Default: the name the provider registered with pi, else the id with a capital letter. */
	name?: string;
	/** Colour of the heading glyph. Default: accent. */
	color?: WidgetColor;
	/**
	 * A `setStatus()` key whose text carries a percentage, for a provider that already publishes
	 * its usage that way. The first number in the text (after any leading glyph and the provider
	 * name) becomes a bar, painted in the status's own colour if it has one. The status is then
	 * left out of the generic status lists, and shown next to the context in the footer when the
	 * sidebar is hidden.
	 */
	statusKey?: string;
	/** Bar label for `statusKey`. Default "Plan". */
	label?: string;
	/** Extra bars computed from the session. Called on every repaint, so keep it cheap. */
	meters?: (ctx: ExtensionContext) => ProviderMeter[] | undefined;
}

const KEY = Symbol.for("pi-halo/providers");

interface Store {
	specs: ProviderStatusSpec[];
	version: number;
}

function store(): Store {
	const g = globalThis as unknown as Record<symbol, Store | undefined>;
	g[KEY] ??= { specs: [], version: 0 };
	return g[KEY]!;
}

const idsOf = (s: ProviderStatusSpec): string[] => (Array.isArray(s.provider) ? s.provider : [s.provider]);

/**
 * Register (or replace) the status spec for one or more providers. Returns a function that removes
 * it. The ids of a new spec replace the same ids in older specs.
 */
export function setProviderStatus(spec: ProviderStatusSpec): () => void {
	const s = store();
	const ids = new Set(idsOf(spec));
	s.specs = s.specs.filter((old) => !idsOf(old).every((id) => ids.has(id)));
	s.specs.push(spec);
	s.version++;
	return () => {
		const i = s.specs.indexOf(spec);
		if (i >= 0) s.specs.splice(i, 1);
		s.version++;
	};
}

/** The spec for a provider id, if one is registered. */
export function getProviderStatus(provider: string | undefined): ProviderStatusSpec | undefined {
	if (!provider) return undefined;
	const specs = store().specs;
	for (let i = specs.length - 1; i >= 0; i--) if (idsOf(specs[i]!).includes(provider)) return specs[i];
	return undefined;
}

/** `setStatus()` keys that registered specs consume, so the generic status lists skip them. */
export function providerStatusKeys(): Set<string> {
	const keys = new Set<string>();
	for (const s of store().specs) if (s.statusKey) keys.add(s.statusKey);
	return keys;
}

/** Forget every registration (tests). */
export function resetProviderStatus(): void {
	const s = store();
	s.specs = [];
	s.version++;
}
