/**
 * Reviewer spawn: a specialized subagent that reviews work against a frozen
 * prompt. Reuses the subagent runner so reviewers appear in the /subagents
 * panel and emit wait:active/wait:done like any other wait.
 *
 * Two entry points:
 *   pingReviewer  — quick connectivity check (P1). Throws on failure/timeout.
 *   runReview     — full review (P4). Returns { done, output, tampered }.
 *
 * Hash integrity: the frozen prompt is re-read from state at spawn time. If
 * the recomputed hash mismatches the stored one, the archived prompt is still
 * used (never exit on mismatch — that would let tampering abort the gate).
 *
 * Promise parsing: reviewer output containing <promise>DONE</promise>
 * (whitespace-tolerant) marks the review as passed.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { genId, type DispatchEntry, registry, splitModel } from "../subagent/scheduler.ts";
import { runChild } from "../subagent/runner.ts";
import { type GatedGoalState, hashPrompt, verifiedFrozenPrompt } from "./state.ts";

const PROMISE_RE = /<promise>\s*DONE\s*<\/promise>/i;

function buildReviewerEntry(opts: { name: string; model: string; task: string; group: string }): DispatchEntry {
	const { provider } = splitModel(opts.model);
	return {
		id: genId(),
		name: opts.name,
		preset: "reviewer",
		model: opts.model,
		provider,
		task: opts.task,
		permissionsLabel: "reviewer",
		group: opts.group,
		startedAt: Date.now(),
		lastActivityAt: Date.now(),
		status: "running",
		messages: [],
	};
}

/** Quick connectivity probe. Throws Error on any failure or timeout. */
export async function pingReviewer(pi: ExtensionAPI, ctx: ExtensionContext, model: string, timeoutSec = 45): Promise<void> {
	const { provider } = splitModel(model);
	const entry: DispatchEntry = {
		id: genId(),
		name: `reviewer-ping-${provider}`,
		preset: "reviewer-ping",
		model,
		provider,
		task: "(connectivity probe) reply with exactly: ok",
		permissionsLabel: "reviewer",
		group: "default",
		startedAt: Date.now(),
		lastActivityAt: Date.now(),
		status: "running",
		messages: [],
	};
	registry.add(entry);
	pi.events.emit("wait:active", { source: "subagent", id: entry.id });
	try {
		await runChild({
			pi, ctx, entry, modelArg: model,
			permissions: ["read", "grep", "find", "ls", "bash"],
			systemPrompt: "You are a connectivity probe. Reply with exactly: ok",
			timeoutSec,
		});
		if (entry.status !== "done") {
			throw new Error(`reviewer probe ${entry.status}${entry.errorMessage ? ": " + entry.errorMessage : ""}`);
		}
		const out = (entry.finalOutput ?? "").toLowerCase();
		if (!out.includes("ok")) {
			throw new Error(`reviewer probe returned no 'ok': ${entry.finalOutput?.slice(0, 120) ?? "(empty)"}`);
		}
	} finally {
		pi.events.emit("wait:done", { source: "subagent", id: entry.id });
	}
}

export interface ReviewResult {
	done: boolean;
	output: string;
	tampered: boolean;
	exitCode?: number;
	status: string;
}

/**
 * Run one full review. Spawns a reviewer subagent with the frozen prompt.
 * Resolves when the child exits. Caller decides transitions based on `done`.
 */
export async function runReview(pi: ExtensionAPI, ctx: ExtensionContext, state: GatedGoalState, reviewNumber: number, timeoutSec = 1200): Promise<ReviewResult> {
	const { prompt, tampered } = verifiedFrozenPrompt(state);
	void hashPrompt; // referenced for audit

	const name = `reviewer-${reviewNumber}`;
	const entry = buildReviewerEntry({ name, model: state.reviewerModel, task: `Review #${reviewNumber} against frozen plan`, group: "default" });
	registry.add(entry);
	pi.events.emit("wait:active", { source: "subagent", id: entry.id });

	const systemPrompt = [
		"You are a strict reviewer subagent operating in an isolated context window.",
		"You CANNOT dispatch further subagents. You can read files, search, and run verification commands (tests, build, git diff) — but you cannot edit or write files.",
		"",
		"Your job: verify the main agent's work against the FROZEN plan below. Run the verification commands it specifies. Check every constraint.",
		"",
		"--- FROZEN PLAN (immutable) ---",
		prompt,
		"--- END FROZEN PLAN ---",
		"",
		"Output rules:",
		"- If and only if you are fully satisfied that every outcome is met, every verification passes, every constraint honored, and every quality bar cleared: output exactly `<promise>DONE</promise>` and a one-line summary. Nothing else needs the promise tag.",
		"- Otherwise, output a concrete list of changes the main agent must make. Reference specific files/commands/constraints. Do NOT output the promise tag.",
	].join("\n");

	try {
		await runChild({
			pi, ctx, entry, modelArg: state.reviewerModel,
			permissions: state.reviewerPermissions,
			systemPrompt,
			timeoutSec,
		});
	} finally {
		pi.events.emit("wait:done", { source: "subagent", id: entry.id });
	}

	const output = entry.finalOutput ?? entry.errorMessage ?? "(no output)";
	const done = PROMISE_RE.test(output);
	return {
		done,
		output,
		tampered,
		exitCode: entry.exitCode,
		status: entry.status,
	};
}
