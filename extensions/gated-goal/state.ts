/**
 * Gated-goal state machine: persisted phases + frozen plan.
 *
 * State lives under pi's agent directory (getAgentDir()) so /reload and
 * restarts restore the workflow. The frozen review prompt is the immutable
 * source of truth; the stored hash is recomputed at spawn time and, on
 * mismatch, the copy archived in the session at freeze time is used instead
 * (never exit on mismatch — that would let tampering abort the gate).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Phase = "idle" | "plan" | "act" | "review" | "verify";

export interface GatedGoalState {
	phase: Phase;
	maxIteration: number;
	reviewsCompleted: number;
	reviewerModel: string; // "provider/modelId"
	reviewerPermissions: string[];
	frozenPrompt: string; // outcome + verification + constraints + quality
	frozenHash: string; // sha256 of frozenPrompt
	startedAt: number;
	exitReason?: string;
	/** Project path captured when the run was first saved. Used to detect path changes. */
	originalCwd?: string;
}

export const DEFAULT_MAX_ITERATION = 10;
export const REVIEWER_PERMISSIONS = ["read", "grep", "find", "ls", "bash"];

const EMPTY: GatedGoalState = {
	phase: "idle",
	maxIteration: DEFAULT_MAX_ITERATION,
	reviewsCompleted: 0,
	reviewerModel: "",
	reviewerPermissions: REVIEWER_PERMISSIONS,
	frozenPrompt: "",
	frozenHash: "",
	startedAt: 0,
	originalCwd: "",
};

export function filePath(sessionId: string): string {
	return path.join(getAgentDir(), "gated-goal", "sessions", sessionId, "state.json");
}

export function load(ctx: ExtensionContext): GatedGoalState {
	const sessionId = ctx.sessionManager.getSessionId();
	try {
		const raw = fs.readFileSync(filePath(sessionId), "utf-8");
		const parsed = JSON.parse(raw);
		return { ...EMPTY, ...parsed, reviewerPermissions: parsed.reviewerPermissions ?? REVIEWER_PERMISSIONS };
	} catch {
		return { ...EMPTY };
	}
}

export function save(ctx: ExtensionContext, state: GatedGoalState): void {
	const sessionId = ctx.sessionManager.getSessionId();
	// Record the project path at creation so a later path change (project
	// moved / mounted elsewhere) is detectable instead of silently using
	// stale-path assumptions.
	if (!state.originalCwd) state.originalCwd = ctx.cwd;
	// Frozen plans contain task instructions and may reference private
	// project content. Restrict file + dir to owner only.
	fs.mkdirSync(path.dirname(filePath(sessionId)), { recursive: true, mode: 0o700 });
	fs.writeFileSync(filePath(sessionId), JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function hashPrompt(prompt: string): string {
	return crypto.createHash("sha256").update(prompt, "utf8").digest("hex");
}

/** Build the canonical frozen prompt from the four plan sections. */
export function buildFrozenPrompt(parts: { outcome: string; verification: string; constraints: string; quality: string }): string {
	return [
		"## Outcome",
		parts.outcome.trim(),
		"",
		"## Verification",
		parts.verification.trim(),
		"",
		"## Constraints",
		parts.constraints.trim(),
		"",
		"## Code Quality Requirements",
		parts.quality.trim(),
	].join("\n");
}

/** Custom session entry holding the plan as it was at freeze time. */
export const FROZEN_ENTRY = "gated-goal-frozen";

export interface FrozenArchive {
	prompt: string;
	hash: string;
}

/** Most recent archived copy of the frozen plan in this branch, if any. */
function archivedPrompt(ctx: ExtensionContext): FrozenArchive | undefined {
	let found: FrozenArchive | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		const e = entry as any;
		if (e.type !== "custom" || e.customType !== FROZEN_ENTRY) continue;
		const data = e.data as FrozenArchive | undefined;
		if (data?.prompt && data.hash === hashPrompt(data.prompt)) found = data;
	}
	return found;
}

/**
 * Read the frozen prompt, reporting whether the state file still matches its
 * own hash.
 *
 * A mismatch means the persisted (prompt, hash) pair is inconsistent — the
 * prompt was edited without recomputing the hash. freeze_plan also archives
 * the plan as a session entry, which is a separate store from this state file,
 * so we recover the original from there and keep going. If no intact archive
 * exists, the state file's prompt is used as-is and the caller surfaces the
 * warning.
 *
 * Mismatch deliberately does NOT abort the run: exiting on mismatch would turn
 * editing the plan into an escape hatch out of the gate. Note this catches an
 * inconsistent pair, not a determined edit — anything that can write the state
 * file can rewrite the hash alongside it.
 */
export function verifiedFrozenPrompt(ctx: ExtensionContext, state: GatedGoalState): { prompt: string; tampered: boolean; restored: boolean } {
	if (hashPrompt(state.frozenPrompt) === state.frozenHash) {
		return { prompt: state.frozenPrompt, tampered: false, restored: false };
	}
	const archive = archivedPrompt(ctx);
	if (archive) return { prompt: archive.prompt, tampered: true, restored: true };
	return { prompt: state.frozenPrompt, tampered: true, restored: false };
}
