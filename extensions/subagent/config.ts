/**
 * Subagent user configuration loader.
 *
 * `subagent.json` in Pi's agent directory is the single user-owned source for
 * role preferences and scheduling. The session model registry remains the
 * source of truth for actual model availability.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ResourceGroup { concurrency: number }

export interface RolePreference {
	description?: string;
	/** Ordered advice only; provider/modelId or bare modelId. */
	suggestedModels?: string[];
	permissions?: Permissions;
	systemPrompt?: string;
	timeoutSec?: number;
	resourceGroup?: string;
}

export type Permissions = "readonly" | "junior" | "full" | string[];

export interface GatedGoalConfig {
	/** Reviewer review window (P4), seconds. User-owned: the main agent is the
	 *  party under review and deliberately has no knob for this — see the
	 *  gated-goal DESIGN.md "Reviewer" section for the rationale. */
	reviewTimeoutSec: number;
	/** Connectivity ping window (P1), seconds. Cold local models may need more. */
	pingTimeoutSec: number;
}

/** Generic system prompt used when a role sets no `systemPrompt` of its own. */
export const DEFAULT_SYSTEM_PROMPT = [
	"You are a delegated subagent operating in an isolated context window.",
	"Complete the assigned task autonomously with the tools you have.",
	"You cannot dispatch further subagents.",
	"",
	"Working principles:",
	"- Read the role description in your dispatch for your specific focus.",
	"- Respect tool permissions strictly. When restricted to read-only, keep all",
	"  commands (including bash) strictly read-only.",
	"- Use exact references — file paths with line ranges, URLs, IDs — so the",
	"  main agent can verify without re-reading everything.",
	"- Be concise and structured; compress findings rather than dump raw content.",
	"",
	"When finished, output a structured summary:",
	"## Completed",
	"What was done or found.",
	"",
	"## Key results",
	"Specific findings/changes with exact references (path:line, URL, etc.).",
	"",
	"## Notes",
	"Anything the main agent must know — risks, follow-ups, open questions.",
	].join("\n");

/** Resolve the system prompt for a role, with its source. */
export function resolveSystemPrompt(role: RolePreference | undefined): { prompt: string; source: "user" | "default" } {
	if (role?.systemPrompt) return { prompt: role.systemPrompt, source: "user" };
	return { prompt: DEFAULT_SYSTEM_PROMPT, source: "default" };
}

export interface SubagentConfig {
	defaults: {
		timeoutSec: number;
		hungThresholdSec: number;
		defaultResourceGroup: string;
		retainCompletedSec: number;
		maxCapturedMessages: number;
	};
	gatedGoal: GatedGoalConfig;
	resourceGroups: Record<string, ResourceGroup>;
	providerGroups: Record<string, string>;
	roles: Record<string, RolePreference>;
}

const DEFAULT_CONFIG: SubagentConfig = {
	defaults: {
		timeoutSec: 600,
		hungThresholdSec: 120,
		defaultResourceGroup: "default",
		retainCompletedSec: 1800,
		maxCapturedMessages: 1000,
	},
	gatedGoal: {
		reviewTimeoutSec: 1800,
		pingTimeoutSec: 45,
	},
	resourceGroups: { default: { concurrency: 4 } },
	providerGroups: {},
	roles: {},
};

/** Resolved config path for this install — the only place that decides where
 *  the file lives. Never hardcode it; `getAgentDir()` varies by install. */
export function configPath(): string { return path.join(getAgentDir(), "subagent.json"); }

export function normalize(raw: any): SubagentConfig {
	const rawRoles = (raw?.roles ?? {}) as Record<string, any>;
	const roles: Record<string, RolePreference> = {};
	for (const [name, value] of Object.entries(rawRoles)) {
		const suggestions = Array.isArray(value?.suggestedModels)
			? value.suggestedModels.filter((item: unknown) => typeof item === "string" && item.trim()).map((item: string) => item.trim())
			: [];
		roles[name] = { ...value, suggestedModels: suggestions };
	}
	const rawDefaults = { ...DEFAULT_CONFIG.defaults, ...(raw?.defaults ?? {}) };
	const positiveInt = (value: unknown, fallback: number): number => {
		const n = Number(value);
		return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
	};
	const gg = { ...DEFAULT_CONFIG.gatedGoal, ...(raw?.gatedGoal ?? {}) };
	return {
		defaults: {
			...rawDefaults,
			maxCapturedMessages: positiveInt(rawDefaults.maxCapturedMessages, DEFAULT_CONFIG.defaults.maxCapturedMessages),
		},
		gatedGoal: {
			reviewTimeoutSec: positiveInt(gg.reviewTimeoutSec, DEFAULT_CONFIG.gatedGoal.reviewTimeoutSec),
			pingTimeoutSec: positiveInt(gg.pingTimeoutSec, DEFAULT_CONFIG.gatedGoal.pingTimeoutSec),
		},
		resourceGroups: { ...DEFAULT_CONFIG.resourceGroups, ...(raw?.resourceGroups ?? {}) },
		providerGroups: { ...(raw?.providerGroups ?? {}) },
		roles,
	};
}

export function loadConfig(_ctx: ExtensionContext): SubagentConfig {
	try {
		return normalize(JSON.parse(fs.readFileSync(configPath(), "utf-8")));
	} catch {
		return DEFAULT_CONFIG;
	}
}

export function groupForProvider(cfg: SubagentConfig, provider: string): string {
	return cfg.providerGroups[provider] ?? cfg.defaults.defaultResourceGroup;
}

export function concurrencyForGroup(cfg: SubagentConfig, group: string): number {
	return cfg.resourceGroups[group]?.concurrency ?? cfg.resourceGroups[cfg.defaults.defaultResourceGroup]?.concurrency ?? 1;
}

/** Starter file contents: the built-in defaults plus a few example roles. */
function starterConfig(): SubagentConfig {
	return {
		...DEFAULT_CONFIG,
		roles: {
			explorer: { description: "Reconnaissance of a codebase or external information sources (knowledge bases, the web, user-provided context), returning compressed findings for handoff to other agents", suggestedModels: [], permissions: "readonly", timeoutSec: 900 },
			planner: { description: "Implementation planning from supplied context", suggestedModels: [], permissions: "readonly", timeoutSec: 900 },
			advisor: { description: "Technical advisor: architecture design, complex problem-solving, code review, and technical decisions. Provides expert guidance for difficult issues and deep analysis.", suggestedModels: [], permissions: "readonly", timeoutSec: 600 },
			worker: { description: "Small, well-scoped implementation work", suggestedModels: [], permissions: "junior", timeoutSec: 900 },
		},
	};
}

/** Ensure `<agent dir>/subagent.json` exists with starter defaults. */
export function ensureConfigTemplate(_ctx: ExtensionContext): void {
	const target = configPath();
	if (fs.existsSync(target)) return;

	fs.mkdirSync(getAgentDir(), { recursive: true });
	const tmp = `${target}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(starterConfig(), null, 2) + "\n", { mode: 0o600 });
	fs.renameSync(tmp, target);
}
