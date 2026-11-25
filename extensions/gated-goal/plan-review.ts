/**
 * Plan intent review (P2.5): the reviewer audits the plan the main agent wants
 * to freeze, against the conversation it had with the user.
 *
 *   renderTranscript  — the session's current branch as plain text: user and
 *                       assistant prose in full, tool traffic compacted
 *   writeTranscript   — that text as a 0600 file in the OS temp dir, for the
 *                       reviewer child to read
 *   runIntentReview   — transcript → reviewer (`runPlanReview`) → transcript
 *                       deleted; classifies the outcome and never throws
 *
 * The session stores extension follow-ups exactly like human input (same
 * role, no marker), so no code can tell them apart here; the reviewer prompt
 * (reviewer.ts) tells the reviewer which lines are gate workflow messages.
 *
 * The caller owns the freeze-loop accounting: what counts as a rejection, when
 * the budget is exhausted, and every state transition.
 */

import { rmSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { writeTempFile } from "../subagent/runner.ts";
import { runPlanReview } from "./reviewer.ts";
import { FROZEN_ENTRY, type GatedGoalState } from "./state.ts";

const TOOL_CALL_ARG_MAX = 200;
const TOOL_RESULT_MAX = 300;

function trunc(s: string, max: number): string {
	return s.length > max ? s.slice(0, max) + "…" : s;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c: any) => c?.type === "text")
		.map((c: any) => String(c.text ?? ""))
		.join("\n");
}

/** Render a session branch (what `sessionManager.getBranch()` returns): user
 *  and assistant prose in full, one line per tool call, tool results
 *  truncated, gate markers kept; thinking and bookkeeping entries omitted. */
export function renderTranscript(entries: SessionEntry[]): string {
	const out: string[] = [];
	let n = 0;
	for (const e of entries) {
		if (e.type === "custom") {
			if (e.customType === FROZEN_ENTRY) out.push(`[gated-goal] plan frozen (sha256 ${String((e.data as any)?.hash ?? "").slice(0, 12)}…)`);
			continue;
		}
		if (e.type !== "message") continue;
		const m = e.message as any;
		const ts = typeof e.timestamp === "string" ? e.timestamp.slice(11, 19) : "";
		const heading = (who: string) => `\n## ${++n}. ${who} — ${ts}`;
		if (m.role === "user") {
			const t = textOf(m.content);
			if (t.trim()) out.push(heading("USER"), t);
		} else if (m.role === "assistant") {
			const parts: string[] = [];
			for (const c of (Array.isArray(m.content) ? m.content : []) as any[]) {
				if (c?.type === "text" && String(c.text ?? "").trim()) parts.push(String(c.text));
				else if (c?.type === "toolCall") parts.push(`[tool call] ${c.name} ${trunc(JSON.stringify(c.arguments ?? {}), TOOL_CALL_ARG_MAX)}`);
			}
			if (parts.length) out.push(heading("ASSISTANT"), ...parts);
		} else if (m.role === "toolResult") {
			out.push(`[tool result · ${m.toolName}${m.isError ? " · error" : ""}] ${trunc(textOf(m.content), TOOL_RESULT_MAX)}`);
		} else if (m.role === "system") {
			const t = textOf(m.content);
			if (t.trim()) out.push(`[system — ${ts}]`, t);
		}
	}
	return out.join("\n");
}

export async function writeTranscript(text: string): Promise<{ dir: string; file: string }> {
	return writeTempFile("transcript", "gated-goal", text);
}

export type IntentReviewOutcome =
	| { kind: "approved"; output: string }
	| { kind: "rejected"; output: string }
	/** The reviewer child did not finish cleanly (timeout, crash, cancellation): whatever it printed is not a verdict. */
	| { kind: "notVerdict"; status: string; output: string }
	/** The review could not run at all (transcript I/O, spawn, config). */
	| { kind: "failed"; message: string };

/** Run the intent review of `frozenPrompt` (freeze attempt `attempt`). The
 *  transcript lives exactly as long as the review. Never throws: every
 *  failure is reported as an outcome so the caller can return to PLAN. */
export async function runIntentReview(pi: ExtensionAPI, ctx: ExtensionContext, state: GatedGoalState, frozenPrompt: string, attempt: number): Promise<IntentReviewOutcome> {
	try {
		const transcript = await writeTranscript(renderTranscript(ctx.sessionManager.getBranch()));
		try {
			const result = await runPlanReview(pi, ctx, state, { plan: frozenPrompt, transcriptPath: transcript.file, attempt, max: state.maxIteration });
			if (result.status !== "done") return { kind: "notVerdict", status: result.status, output: result.output };
			return result.approved ? { kind: "approved", output: result.output } : { kind: "rejected", output: result.output };
		} finally {
			rmSync(transcript.dir, { recursive: true, force: true });
		}
	} catch (err: any) {
		return { kind: "failed", message: String(err?.message ?? err) };
	}
}
