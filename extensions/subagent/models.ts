/**
 * Session model discovery — the single source of truth for "which models can
 * the main agent dispatch to right now".
 *
 * Uses the typed public ExtensionContext fields. Do NOT reach for
 * `(ctx as any).modelRegistry` methods by guessed names — earlier versions did
 * that and called getProviders()/getModels()/.providers, none of which exist
 * on ModelRegistry, so the helpers silently returned [] and the main agent
 * could never see the catalogue. The real API is getAvailable()/getAll()/
 * getRegisteredProviderIds() (see core/model-registry.d.ts).
 *
 * Resolution order (matches DESIGN.md "currently available in the session"):
 *   1. ctx.scopedModels — session-scoped catalogue (--models / enabledModels)
 *   2. ctx.modelRegistry.getAvailable() — models with configured auth
 *   3. ctx.modelRegistry.getAll() — full catalogue; the spawned child remains
 *      the final authority and will surface any auth error explicitly
 *
 * Returning the full catalogue as a last resort (rather than []) keeps the
 * main agent from being blind when auth state is unusual; a child that cannot
 * authenticate reports the real error instead of a generic "no models".
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface AvailableModel {
	provider: string;
	id: string;
	name: string;
}

/** Snapshot of models usable in the current session, as records. */
export function availableModelRecords(ctx: ExtensionContext): AvailableModel[] {
	const scoped = ctx.scopedModels;
	if (scoped && scoped.length > 0) {
		return scoped.map((s) => ({
			provider: s.model.provider,
			id: s.model.id,
			name: s.model.name ?? s.model.id,
		}));
	}

	const reg = ctx.modelRegistry;
	const out: AvailableModel[] = [];
	const seen = new Set<string>();
	const push = (m: AvailableModel) => {
		const key = `${m.provider}/${m.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push(m);
	};

	try {
		for (const m of reg.getAvailable() ?? []) {
			push({ provider: m.provider, id: m.id, name: m.name ?? m.id });
		}
	} catch { /* registry not ready; fall through */ }

	// Auth-ready list is the right answer when non-empty. Otherwise fall back
	// to the full catalogue so the agent can still pick a model.
	if (out.length > 0) return out;

	try {
		for (const m of reg.getAll() ?? []) {
			push({ provider: m.provider, id: m.id, name: m.name ?? m.id });
		}
	} catch { /* ignore */ }

	return out;
}

/** Session catalogue as "provider/modelId" strings. */
export function availableModels(ctx: ExtensionContext): string[] {
	return availableModelRecords(ctx).map((m) => `${m.provider}/${m.id}`);
}

/**
 * Resolve a (possibly fuzzy) role hint against the session catalogue.
 *
 * Role suggestedModels are advisory intent labels — they may be exact
 * ("openai/gpt-5.1"), a bare id ("gpt-5.1"), or a fuzzy label like "GPT" or
 * "claude". We match case-insensitively against provider/id and name so a
 * hint surfaces the concrete models the agent can actually dispatch to.
 */
export function matchHint(hint: string, models: AvailableModel[]): AvailableModel[] {
	const h = hint.trim().toLowerCase();
	if (!h) return [];
	return models.filter((m) => {
		const full = `${m.provider}/${m.id}`.toLowerCase();
		const id = m.id.toLowerCase();
		const name = (m.name ?? "").toLowerCase();
		return full.includes(h) || id.includes(h) || name.includes(h);
	});
}
