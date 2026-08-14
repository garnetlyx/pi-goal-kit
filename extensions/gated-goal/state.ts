/**
 * Gated-goal state machine: persisted phases + frozen plan.
 *
 * State lives under pi's agent directory (getAgentDir()) so /reload and
 * restarts restore the workflow. The frozen review prompt is the immutable
 * source of truth;
 * the stored hash is recomputed at spawn time and, on mismatch, the archived
 * prompt is used verbatim (never exit on mismatch — that would let tampering
 * abort the gate).
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

/**
 * Read the frozen prompt, reporting whether it still matches its own hash.
 *
 * A mismatch means the persisted (prompt, hash) pair is inconsistent — the
 * prompt was edited without recomputing the hash. The stored prompt is the
 * only copy, so there is nothing to restore from; it is used either way and
 * the caller surfaces `tampered` as a warning. Mismatch deliberately does NOT
 * abort the run: exiting on mismatch would turn tampering into an escape hatch
 * out of the gate.
 */
export function verifiedFrozenPrompt(state: GatedGoalState): { prompt: string; tampered: boolean } {
	const recomputed = hashPrompt(state.frozenPrompt);
	return { prompt: state.frozenPrompt, tampered: recomputed !== state.frozenHash };
}
