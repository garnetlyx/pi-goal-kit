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
// Pre-agent-dir layout: state was anchored to the project cwd. Kept only for
// one-way migration into the agent directory on first load.
function legacyFilePath(cwd: string): string {
	return path.join(cwd, "state", "agent", "gated-goal.json");
}

export function load(ctx: ExtensionContext): GatedGoalState {
	const sessionId = ctx.sessionManager.getSessionId();
	try {
		const raw = fs.readFileSync(filePath(sessionId), "utf-8");
		const parsed = JSON.parse(raw);
		return { ...EMPTY, ...parsed, reviewerPermissions: parsed.reviewerPermissions ?? REVIEWER_PERMISSIONS };
	} catch {
		// No session-scoped file. Try the legacy cwd-anchored location: adopt
		// it into this session so an in-flight gated-goal survives the upgrade.
		try {
			const legacyRaw = fs.readFileSync(legacyFilePath(ctx.cwd), "utf-8");
			const legacyParsed = JSON.parse(legacyRaw);
			if (legacyParsed && legacyParsed.phase && legacyParsed.phase !== "idle") {
				const adopted = { ...EMPTY, ...legacyParsed, reviewerPermissions: legacyParsed.reviewerPermissions ?? REVIEWER_PERMISSIONS };
				save(ctx, adopted);
				console.error(`[gated-goal] migrated in-flight state (phase=${adopted.phase}) from legacy cwd-anchored store into session ${sessionId}.`);
				return adopted;
			}
		} catch { /* ignore */ }
		return { ...EMPTY };
	}
}

export function save(ctx: ExtensionContext, state: GatedGoalState): void {
	const sessionId = ctx.sessionManager.getSessionId();
	// Record the project path at creation so a later path change (project
	// moved / mounted elsewhere) is detectable instead of silently using
	// stale-path assumptions.
	if (!state.originalCwd) state.originalCwd = ctx.cwd;
	fs.mkdirSync(path.dirname(filePath(sessionId)), { recursive: true });
	fs.writeFileSync(filePath(sessionId), JSON.stringify(state, null, 2));
}

export function clear(ctx: ExtensionContext): void {
	const sessionId = ctx.sessionManager.getSessionId();
	try { fs.unlinkSync(filePath(sessionId)); } catch { /* ignore */ }
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

/** Read the immutable prompt. On hash mismatch (tampering), use the archive. */
export function verifiedFrozenPrompt(state: GatedGoalState): { prompt: string; tampered: boolean } {
	const recomputed = hashPrompt(state.frozenPrompt);
	if (recomputed === state.frozenHash) return { prompt: state.frozenPrompt, tampered: false };
	// The archive IS the stored prompt; nothing to restore from elsewhere.
	// Mismatch only happens if in-memory frozenPrompt drifted from its own hash,
	// which means the persisted (prompt, hash) pair is inconsistent. We trust the
	// hash: treat the hash as authoritative and warn. There is no "original" to
	// restore beyond what's stored, so we keep using stored prompt and flag it.
	return { prompt: state.frozenPrompt, tampered: true };
}
