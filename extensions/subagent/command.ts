/**
 * `/subagent <model> <prompt>` — the user names the model, the agent still
 * dispatches.
 *
 * The command completes its first argument against every connected model
 * (`modelRegistry.getAvailable()`, the list `/model` offers), so the user can name a model that
 * `models.blacklist` hides from the agent: the fence binds the agent's
 * autonomous choice, not a human's explicit pick. The pick grants a one-time
 * blacklist override for exactly that model (see `override.ts`); every other
 * blacklisted model stays refused.
 *
 * The dispatch decisions stay with the agent. The command only names the model
 * and hands over the request verbatim; the agent gathers the missing context
 * (the diff under review, the files discussed, ...) and decides task,
 * permissions, timeout, and role.
 */

import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { grantModelOverride } from "./override.ts";

/** A model of the session catalogue, reduced to what the command needs. */
export interface CatalogueModel {
	provider: string;
	id: string;
	name: string;
}

/** Every connected model — providers configured in models.json or with auth
 *  (`modelRegistry.getAvailable()`, the list `/model` offers), including the
 *  ones the blacklist hides from the agent. Pi's unconfigured preset catalogue
 *  (`getAll()`) is not offered. */
export function catalogueModels(registry: ModelRegistry | undefined): CatalogueModel[] {
	if (!registry) return [];
	try {
		return registry.getAvailable().map((model) => ({
			provider: model.provider,
			id: model.id,
			name: model.name ?? model.id,
		}));
	} catch {
		return [];
	}
}

/**
 * Search text for the fuzzy filter. Same composition the built-in `/model`
 * selector uses: model id, provider, "provider/id", and the display name.
 */
function modelSearchText(model: CatalogueModel): string {
	const name = model.name ? ` ${model.name}` : "";
	return `${model.id} ${model.provider} ${model.provider}/${model.id} ${model.provider} ${model.id}${name}`;
}

/**
 * Completion items for the model argument.
 *
 * Only the first argument is completed: once the argument text contains
 * whitespace the prompt has started, and the model token is done. The item
 * label is the model id and the description the provider (like `/model`);
 * the inserted value is the exact "provider/modelId" target, followed by a
 * space so the prompt can be typed right away.
 */
export function modelCompletionItems(
	registry: ModelRegistry | undefined,
	argumentText: string,
): AutocompleteItem[] | null {
	if (/\s/.test(argumentText)) return null;
	const models = catalogueModels(registry);
	if (models.length === 0) return null;
	const matches = fuzzyFilter(models, argumentText, modelSearchText);
	if (matches.length === 0) return null;
	return matches.map((model) => ({
		value: `${model.provider}/${model.id} `,
		label: model.id,
		description: model.provider,
	}));
}

export interface SubagentRequest {
	/** Exact dispatch target, "provider/modelId". */
	model: string;
	/** The user's prompt, verbatim. */
	prompt: string;
}

export type SubagentParse =
	| { ok: true; request: SubagentRequest }
	| { ok: false; error: string };

const USAGE = "Usage: /subagent <provider/modelId> <prompt>";

function catalogueHint(models: CatalogueModel[]): string {
	if (models.length === 0) return "The session model registry is empty.";
	const shown = models.slice(0, 8).map((m) => `${m.provider}/${m.id}`);
	const more = models.length - shown.length;
	return `Available: ${shown.join(", ")}${more > 0 ? ` (and ${more} more)` : ""}.`;
}

/** Resolve a typed model token against the catalogue. */
function resolveModelToken(
	token: string,
	models: CatalogueModel[],
): { ok: true; model: string } | { ok: false; error: string } {
	if (token.includes("/")) {
		const exact = models.find((m) => `${m.provider}/${m.id}` === token);
		if (exact) return { ok: true, model: token };
		return { ok: false, error: `Model "${token}" is not in the session model registry. ${catalogueHint(models)}` };
	}
	const exact = models.filter((m) => m.id === token);
	if (exact.length === 1) return { ok: true, model: `${exact[0].provider}/${exact[0].id}` };
	if (exact.length > 1) {
		return {
			ok: false,
			error: `Model id "${token}" is ambiguous: ${exact.map((m) => `${m.provider}/${m.id}`).join(", ")}. Use provider/modelId.`,
		};
	}
	const insensitive = models.filter((m) => m.id.toLowerCase() === token.toLowerCase());
	if (insensitive.length === 1) return { ok: true, model: `${insensitive[0].provider}/${insensitive[0].id}` };
	if (insensitive.length > 1) {
		return {
			ok: false,
			error: `Model id "${token}" is ambiguous: ${insensitive.map((m) => `${m.provider}/${m.id}`).join(", ")}. Use provider/modelId.`,
		};
	}
	return { ok: false, error: `Model "${token}" is not in the session model registry. ${catalogueHint(models)}` };
}

/**
 * Parse `/subagent` arguments: the first token is the model ("provider/modelId"
 * or a bare model id), the rest is the user's prompt.
 */
export function parseSubagentRequest(args: string, models: CatalogueModel[]): SubagentParse {
	const text = args.trim();
	if (!text) return { ok: false, error: USAGE };
	const separator = text.search(/\s/);
	const token = separator === -1 ? text : text.slice(0, separator);
	const prompt = separator === -1 ? "" : text.slice(separator + 1).trim();
	if (!prompt) {
		return { ok: false, error: `Missing prompt for /subagent ${token}. ${USAGE}` };
	}
	const resolved = resolveModelToken(token, models);
	if (!resolved.ok) return resolved;
	return { ok: true, request: { model: resolved.model, prompt } };
}

/** The message the main agent receives for a `/subagent` request. */
export function buildSubagentInstruction(model: string, prompt: string): string {
	return [
		`The user explicitly requested a subagent on model \`${model}\`.`,
		"",
		"User request:",
		prompt,
		"",
		`Do not ask the user for context you can gather yourself — for a review that means the current diff, the recent changes, and the files discussed in this conversation. Write one self-contained dispatch task that combines that context with the user's request, decide permissions, timeout, and role yourself, and call \`dispatch\` with model \`${model}\` exactly.`,
	].join("\n");
}

/** The registry the completion runs against. Refreshed on session start and on
 *  every command invocation; the registry reads the live model catalogue, so
 *  the completion list stays current. */
let sessionRegistry: ModelRegistry | undefined;

export function setModelRegistry(registry: ModelRegistry | undefined): void {
	sessionRegistry = registry;
}

/** Register the `/subagent` command. */
export function registerSubagentCommand(pi: ExtensionAPI): void {
	pi.registerCommand("subagent", {
		description:
			"Run a task on a model you pick: /subagent <provider/modelId> <prompt>. The model argument completes from the connected models (blacklisted models included — this pick is exempt from models.blacklist once).",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null =>
			modelCompletionItems(sessionRegistry, prefix),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			setModelRegistry(ctx.modelRegistry);
			const parsed = parseSubagentRequest(args ?? "", catalogueModels(ctx.modelRegistry));
			if (!parsed.ok) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}
			// The override must exist before the agent can dispatch, so it is
			// granted before the request is handed over.
			grantModelOverride(parsed.request.model);
			try {
				await pi.sendUserMessage(
					buildSubagentInstruction(parsed.request.model, parsed.request.prompt),
					{ deliverAs: "followUp" },
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not hand the subagent request to the agent: ${message}`, "error");
			}
		},
	});
}
