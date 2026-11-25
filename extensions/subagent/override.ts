/**
 * One-time blacklist override for a human-picked model.
 *
 * `models.blacklist` in `subagent.json` fences the *agent's* autonomous model
 * choice. A human pick is exempt — but only for the exact model the human
 * named, and only for the next dispatch of it. `/subagent <model> <prompt>`
 * grants the override; the `dispatch` tool consumes it.
 *
 * The state lives on globalThis behind a Symbol key, like the dispatch
 * registry: Pi loads every extension entry point through its own Jiti loader
 * with `moduleCache: false`, so a plain module-level variable can end up in
 * two instances and the command and the dispatch tool would then read
 * different overrides.
 */

const OVERRIDE_KEY = Symbol.for("pi-goal-kit.subagent.model-override.v1");
const globalStore = globalThis as Record<symbol, unknown>;

interface OverrideState {
	/** "provider/modelId" the pending override is bound to. */
	model: string | null;
}

function state(): OverrideState {
	return (globalStore[OVERRIDE_KEY] ??= { model: null }) as OverrideState;
}

/** Allow exactly this "provider/modelId" to pass the blacklist gate once. */
export function grantModelOverride(model: string): void {
	state().model = model;
}

/**
 * Consume the pending override when it names this model. Any other model
 * leaves the grant pending — it stays bound to the model the human picked.
 */
export function takeModelOverride(model: string): boolean {
	const current = state();
	if (current.model === null || current.model !== model) return false;
	current.model = null;
	return true;
}

/** The model the pending override is bound to, if any. */
export function pendingModelOverride(): string | null {
	return state().model;
}

/** Drop a pending override. */
export function clearModelOverride(): void {
	state().model = null;
}
