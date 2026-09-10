/**
 * Reviewer spawn: a specialized subagent that reviews work against a frozen
 * prompt. Reuses the subagent runner so reviewers appear in the /subagents
 * panel and emit wait:active/wait:done like any other wait.
 *
 * Two entry points:
 *   pingReviewer  — quick connectivity check (P1). Throws on failure/timeout.
 *   runReview     — full review (P4). Returns { done, output, tampered }.
 *
 * Hash integrity: the frozen prompt is re-checked against its hash at spawn
 * time. On mismatch the copy archived in the session at freeze time is used and
 * the caller is told (never exit on mismatch — that would turn editing the plan
 * into an escape hatch out of the gate).
 *
 * Promise parsing: the review passes only when the child finished cleanly AND
 * <promise>DONE</promise> appears as a line of its own outside any code fence.
 * Mentioning the tag inline (quoting or negating it) is not a verdict.
 *
 * Context isolation: reviewer children run with --no-context-files, so the
 * project's own AGENTS.md / CLAUDE.md cannot rewrite the review standard. The
 * frozen plan is the reviewer's whole spec.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../subagent/config.ts";
import { genId, type DispatchEntry, registry, splitModel } from "../subagent/scheduler.ts";
import { runChild } from "../subagent/runner.ts";
import { type GatedGoalState, REVIEWER_PERMISSIONS, verifiedFrozenPrompt } from "./state.ts";

/** The tag counts only where it opens a line — see isApproved(). */
const PROMISE_LINE_RE = /^<promise>\s*DONE\s*<\/promise>/i;
const FENCED_BLOCK_RE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm;

/**
 * Did the reviewer *issue* the promise, as opposed to merely mentioning it?
 *
 * A substring test cannot tell the two apart: a rejection like "do not output
 * <promise>DONE</promise> until the tests pass", or an example inside a code
 * fence, both read as approval and silently discard the reviewer's required
 * changes. So: drop fenced blocks, then require the tag to *start* a line.
 * Approvals open with the verdict (a one-line summary may follow it on the
 * same line); mentions of it are embedded in a sentence.
 */
export function isApproved(output: string): boolean {
	const prose = output.replace(FENCED_BLOCK_RE, "");
	return prose.split(/\r?\n/).some((line) => PROMISE_LINE_RE.test(line.trim()));
}

function buildReviewerEntry(opts: { name: string; model: string; task: string; group: string }): DispatchEntry {
	const { provider } = splitModel(opts.model);
	return {
		id: genId(),
		name: opts.name,
		role: "reviewer",
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

/** Seconds before the hard kill at which the reviewer must stop verifying and
 *  write its verdict. Clamped so it can never exceed half the window — a
 *  60-second ping-style window still gets a sane wrap-up point. */
export function wrapUpThresholdSec(timeoutSec: number): number {
	return Math.min(300, Math.floor(timeoutSec / 2));
}

function formatDuration(sec: number): string {
	if (sec % 60 === 0) return `${sec / 60} minute${sec === 60 ? "" : "s"}`;
	return `${sec} seconds`;
}

/** Build the reviewer system prompt. Exported for tests.
 *  `nowMs` is the spawn-time clock the deadline is computed from. */
export function buildReviewerSystemPrompt(frozenPrompt: string, opts: { timeoutSec: number; nowMs: number }): string {
	const { timeoutSec, nowMs } = opts;
	const deadlineMs = nowMs + timeoutSec * 1000;
	const deadlineSec = Math.floor(deadlineMs / 1000);
	const d = new Date(deadlineMs);
	const pad = (n: number) => String(n).padStart(2, "0");
	const deadlineUtc = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
	const wrapSec = wrapUpThresholdSec(timeoutSec);
	return [
		"You are a strict reviewer subagent operating in an isolated context window.",
		"You cannot dispatch further subagents. You have no write or edit tools: read files, search, and run verification commands (tests, build, git diff).",
		"Your bash access is for inspection only — do not use it to create, modify, or delete anything in the workspace. Report problems; never fix them yourself.",
		"",
		`Time budget: your review window is ${formatDuration(timeoutSec)}. The process running you is hard-killed at ${deadlineUtc} (unix time ${deadlineSec}).`,
		"- You cannot receive messages mid-run. Track time yourself: between steps run `date +%s` and compare with the deadline unix time above.",
		`- Once fewer than ${wrapSec} seconds remain, STOP verifying and write your final verdict immediately. A killed review is never a verdict, so a timely verdict with fewer checks beats a truncated one.`,
		"",
		"Your job: verify the main agent's work against the FROZEN plan below. Run the verification commands it specifies. Check every constraint.",
		"",
		"Method: begin by outputting a short review plan — what you will verify, in what order — then execute it step by step. Check the time budget between steps.",
		"",
		"--- FROZEN PLAN (immutable) ---",
		frozenPrompt,
		"--- END FROZEN PLAN ---",
		"",
		"Output rules:",
		"- If and only if you are fully satisfied that every outcome is met, every verification passes, every constraint honored, and every quality bar cleared: START a line with <promise>DONE</promise>, followed by a one-line summary.",
		"- Otherwise, output a concrete list of changes the main agent must make. Reference specific files/commands/constraints.",
		"- A line beginning with that tag IS the approval verdict. If you are not approving, do not write those characters at all — not to quote them, not to negate them (\"do not output ...\"), not inside a code block.",
	].join("\n");
}
/** Quick connectivity probe. Throws Error on any failure or timeout.
 *  The window comes from user config (`gatedGoal.pingTimeoutSec` in subagent.json),
 *  never from the main agent. */
export async function pingReviewer(pi: ExtensionAPI, ctx: ExtensionContext, model: string): Promise<void> {
	const { pingTimeoutSec } = loadConfig(ctx).gatedGoal;
	const { provider } = splitModel(model);
	const entry: DispatchEntry = {
		id: genId(),
		name: `reviewer-ping-${provider}`,
		role: "reviewer-ping",
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
			permissions: REVIEWER_PERMISSIONS,
			systemPrompt: "You are a connectivity probe. Reply with exactly: ok",
			timeoutSec: pingTimeoutSec,
			contextFiles: false,
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
	/** The state file's prompt no longer matched its hash. */
	tampered: boolean;
	/** …and the archived copy from freeze time was used instead. */
	restored: boolean;
	exitCode?: number;
	status: string;
}

/**
 * Run one full review. Spawns a reviewer subagent with the frozen prompt.
 * Resolves when the child exits. Caller decides transitions based on `done`.
 * The window comes from user config (`gatedGoal.reviewTimeoutSec` in subagent.json),
 * never from the main agent — the main agent is the party under review, and a
 * party that can set the review window can bias or truncate its own verdict. */
export async function runReview(pi: ExtensionAPI, ctx: ExtensionContext, state: GatedGoalState, reviewNumber: number): Promise<ReviewResult> {
	const { reviewTimeoutSec } = loadConfig(ctx).gatedGoal;
	const { prompt, tampered, restored } = verifiedFrozenPrompt(ctx, state);

	const name = `reviewer-${reviewNumber}`;
	const entry = buildReviewerEntry({ name, model: state.reviewerModel, task: `Review #${reviewNumber} against frozen plan`, group: "default" });
	registry.add(entry);
	pi.events.emit("wait:active", { source: "subagent", id: entry.id });

	const systemPrompt = buildReviewerSystemPrompt(prompt, { timeoutSec: reviewTimeoutSec, nowMs: Date.now() });

	try {
		await runChild({
			pi, ctx, entry, modelArg: state.reviewerModel,
			permissions: state.reviewerPermissions,
			systemPrompt,
			timeoutSec: reviewTimeoutSec,
			// The reviewer's standard is the frozen plan, not the reviewed
			// project's own AGENTS.md / CLAUDE.md.
			contextFiles: false,
		});
	} finally {
		pi.events.emit("wait:done", { source: "subagent", id: entry.id });
	}

	const output = entry.finalOutput ?? entry.errorMessage ?? "(no output)";
	// A review that timed out, crashed, or was cancelled has truncated output;
	// whatever it managed to print is not a verdict. Only a cleanly finished
	// child can approve.
	const done = entry.status === "done" && isApproved(output);
	return {
		done,
		output,
		tampered,
		restored,
		exitCode: entry.exitCode,
		status: entry.status,
	};
}
