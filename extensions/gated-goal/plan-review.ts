/**
 * Plan intent review (P2.5): the reviewer audits the plan the main agent wants
 * to freeze, against the conversation it had with the user, before the plan
 * becomes immutable. This module owns the whole step:
 *
 *   renderTranscript        — the session's current branch as plain text
 *   writeTranscript         — that text as a 0600 file in the OS temp dir
 *   buildIntentReviewPrompt — the reviewer's system prompt: the proposal
 *                             (sections + todos), the transcript path, the
 *                             standalone-tag verdict protocol
 *   runIntentReview         — transcript → reviewer → transcript deleted;
 *                             classifies the outcome, honours the tool's abort
 *                             signal and the gate's staleness, never throws
 *   registerFreezePlanTool  — the `freeze_plan` tool: validation, budget,
 *                             review, and every P2.5 state transition,
 *                             through the small `FreezeGate` interface
 *
 * The session stores extension follow-ups exactly like human input (same
 * role, no marker), so no code can tell them apart; the prompt describes
 * them generically and the transcript renders them as USER lines.
 *
 * Verdict protocol for this step is stricter than P4's: the promise tag must
 * be the whole line, outside code fences (`isStandaloneApproval`).
 */

import { realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join as joinPath } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { writeTempFile } from "../subagent/runner.ts";
import { loadConfig } from "../subagent/config.ts";
import { spawnReviewer, deadlineNotice, isStandaloneApproval } from "./reviewer.ts";
import { buildFrozenPrompt, FROZEN_ENTRY, hashPrompt, type GatedGoalState } from "./state.ts";

/** File name the runner gives the transcript inside its `pi-subagent-*` dir. */
const TRANSCRIPT_FILE = "transcript-gated-goal.md";
const TEMP_DIR_PREFIX = "pi-subagent-";

export type TodoItem = { text: string; status?: "todo" | "pending" | "done" };

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

/** Is `dir` a transcript dir this extension could have created (a runner temp
 *  dir under the OS temp dir)? Anything else in `transcriptDir` — a stale or
 *  hand-edited path — must never be deleted on the gate's authority. */
export function ownsTranscriptDir(dir: string): boolean {
	let resolved: string;
	try {
		resolved = realpathSync(dir);
	} catch {
		return false; // gone already: nothing to own, nothing to delete
	}
	let tmp: string;
	try {
		tmp = realpathSync(tmpdir());
	} catch {
		return false;
	}
	return dirname(resolved) === tmp && basename(resolved).startsWith(TEMP_DIR_PREFIX);
}

/** Remove only the transcript file, then its dir if that is empty now. Never
 *  throws: cleanup must not strand the gate, and a failure here costs a stray
 *  temp file, not a wrong deletion. Returns true when the dir is gone. */
export function removeTranscript(dir: string): boolean {
	try {
		if (!ownsTranscriptDir(dir)) return false;
		unlinkSync(joinPath(dir, TRANSCRIPT_FILE));
	} catch { /* already gone or not ours to touch */ }
	try {
		rmdirSync(dir);
		return true;
	} catch { /* not empty (other files live there) or not ours: leave it */ }
	return false;
}

/** Restart recovery: the previous process died mid-review, so no `finally`
 *  ran. Delete what is ours, keep everything else, and report so the state
 *  can be cleared either way. */
export function removeCrashedTranscript(dir: string): boolean {
	return removeTranscript(dir);
}

export interface PlanProposal {
	/** The four canonical sections (`buildFrozenPrompt`). */
	prompt: string;
	/** The work items that will be installed in ACT. */
	todos: TodoItem[];
}

export function buildIntentReviewPrompt(proposal: PlanProposal, opts: { transcriptPath: string; attempt: number; max: number; deadline: string }): string {
	const todoLines = proposal.todos.map((t, i) => `  ${i + 1}. [${t.status ?? "todo"}] ${t.text}`).join("\n");
	return [
		"You are an intent reviewer operating in an isolated context window: you check a PLAN before it is frozen, against the conversation the main agent had with the user.",
		"You cannot dispatch further subagents. You have no write or edit tools. Your bash access is for reading files only — do not create, modify, or delete anything.",
		"",
		opts.deadline,
		"",
		`This is freeze attempt ${opts.attempt}/${opts.max}.`,
		"",
		"Inputs:",
		"- The PROPOSED PLAN below: four sections plus the work items (todos) that will be installed when it freezes. Judge the whole proposal — a todo counts exactly as much as a sentence in the sections.",
		`- The session transcript, rendered to a file: ${opts.transcriptPath} (read it; page with offset if it is long).`,
		"  Roles: USER lines are what reached the agent as user messages. Most are the human's own words, but the gated-goal extension also injects workflow messages this way — phase announcements, freeze results, review verdicts, instructions to the agent — typically opening with an emoji marker. Those are the gate talking to the agent, not the user: never treat them as the user's intent. ASSISTANT lines are the main agent's replies; tool calls and results are compacted.",
		"",
		"Judge exactly two things:",
		"1. Intent match — does the proposal do what the user asked? Flag anything material it adds that the user did not ask for or agree to, anything material it drops or weakens, and any todo that contradicts the sections. Later user statements override earlier ones.",
		"2. Ambiguity — is there anything the user must clarify before work starts: a choice the proposal silently makes, a term with two plausible readings, conflicting user statements, a confirmation taken before the user had seen what they were confirming? Flag only what would change the work or its verification; do not nitpick wording.",
		"If the transcript shows the agent already tried to freeze this proposal and the user has not addressed the earlier issues since, say so and reject again.",
		"",
		"--- PROPOSED PLAN ---",
		proposal.prompt,
		"",
		"## Proposed todos",
		todoLines,
		"--- END PROPOSED PLAN ---",
		"",
		"Output rules:",
		"- If and only if the proposal matches the user's intent and nothing material needs clarifying: output a line consisting of exactly <promise>DONE</promise> and nothing else on that line. A one-line summary may follow on the next line.",
		"- Otherwise output two lists: \"Intent mismatches:\" (the user's words vs. the proposal) and \"Questions to ask the user:\" (concrete, answerable questions — the agent will relay them to the user). Do not write the tag at all — not to quote it, not to negate it, not inside a code block.",
	].join("\n");
}

async function runPlanReview(pi: ExtensionAPI, ctx: ExtensionContext, state: GatedGoalState, opts: { proposal: PlanProposal; transcriptPath: string; attempt: number; max: number; signal?: AbortSignal }): Promise<{ approved: boolean; status: string; output: string }> {
	const { reviewTimeoutSec } = loadConfig(ctx).gatedGoal;
	const systemPrompt = buildIntentReviewPrompt(opts.proposal, {
		transcriptPath: opts.transcriptPath,
		attempt: opts.attempt,
		max: opts.max,
		deadline: deadlineNotice(reviewTimeoutSec, Date.now()),
	});
	const run = await spawnReviewer(pi, ctx, {
		name: `plan-reviewer-${opts.attempt}`,
		task: `Intent review of freeze attempt ${opts.attempt}/${opts.max}: does the proposed plan match the user's intent? Transcript: ${opts.transcriptPath}`,
		model: state.reviewerModel,
		permissions: state.reviewerPermissions,
		systemPrompt,
		timeoutSec: reviewTimeoutSec,
		signal: opts.signal,
	});
	return { approved: run.status === "done" && isStandaloneApproval(run.output), status: run.status, output: run.output };
}

export type IntentReviewOutcome =
	| { kind: "approved"; output: string }
	| { kind: "rejected"; output: string }
	/** The reviewer child did not finish cleanly (timeout, crash, cancellation): whatever it printed is not a verdict. */
	| { kind: "notVerdict"; status: string; output: string }
	/** The review could not run at all (transcript I/O, spawn, config). */
	| { kind: "failed"; message: string }
	/** The gate changed under the call (exit, restart, session switch): nothing may be written or announced. */
	| { kind: "stale" };

export interface IntentReviewControl {
	/** The tool call's abort signal: cancels the reviewer child and prevents a spawn. */
	signal?: AbortSignal;
	/** True once this call no longer owns the gate. Checked before the transcript is written, before the spawn, and after the review. */
	isStale: () => boolean;
	/** Called with the transcript dir while it exists and with `undefined` once removed, so the gate can persist the path for crash cleanup. Never called after the call went stale. */
	onTranscript?: (dir: string | undefined) => void;
}

/** Run the intent review of `proposal` (freeze attempt `attempt`). The
 *  transcript lives exactly as long as the review. Never throws: every
 *  failure is reported as an outcome so the caller can return to PLAN. */
export async function runIntentReview(pi: ExtensionAPI, ctx: ExtensionContext, state: GatedGoalState, proposal: PlanProposal, attempt: number, control: IntentReviewControl): Promise<IntentReviewOutcome> {
	const gone = () => control.isStale();
	if (gone()) return { kind: "stale" };
	let transcript: { dir: string; file: string };
	try {
		transcript = await writeTranscript(renderTranscript(ctx.sessionManager.getBranch()));
	} catch (err: any) {
		return gone() ? { kind: "stale" } : { kind: "failed", message: String(err?.message ?? err) };
	}
	if (gone()) {
		removeTranscript(transcript.dir);
		return { kind: "stale" };
	}
	control.onTranscript?.(transcript.dir);
	try {
		if (control.signal?.aborted) return { kind: "notVerdict", status: "cancelled", output: "" };
		const result = await runPlanReview(pi, ctx, state, { proposal, transcriptPath: transcript.file, attempt, max: state.maxIteration, signal: control.signal });
		if (gone()) return { kind: "stale" };
		if (result.status !== "done") return { kind: "notVerdict", status: result.status, output: result.output };
		return result.approved ? { kind: "approved", output: result.output } : { kind: "rejected", output: result.output };
	} catch (err: any) {
		return gone() ? { kind: "stale" } : { kind: "failed", message: String(err?.message ?? err) };
	} finally {
		removeTranscript(transcript.dir);
		if (!gone()) control.onTranscript?.(undefined);
	}
}

/** What the freeze tool needs from the gate (index.ts). Everything here is a
 *  closure over the gate's live state; the tool never touches files itself. */
export interface FreezeGate {
	/** The live state object (replaced on session switch). */
	state(): GatedGoalState;
	/** Bumped by every authoritative transition; a captured value that no longer matches means this call lost the gate. */
	epoch(): number;
	save(ctx: ExtensionContext, state: GatedGoalState): void;
	setStatus(ctx: ExtensionContext): void;
	/** Send a follow-up message to the agent. */
	say(ctx: ExtensionContext, text: string): void;
	/** Install the frozen plan and enter ACT: hash, archive, todo:replace, follow-up. */
	enterAct(ctx: ExtensionContext, todos: TodoItem[], frozenPrompt: string): void;
}

/** Footer hint for the freeze phases, derived from persisted state so it
 *  survives the agent_settled refresh (which lands exactly when the user
 *  reads the agent's questions) and a resume. Empty outside P2.5. */
export function freezeStatusHint(state: GatedGoalState): string {
	if (state.phase === "freeze") return `intent review ${state.freezeRejections + 1}/${state.maxIteration}`;
	if (state.phase === "plan" && state.freezeRejections > 0) return `freeze rejected ${state.freezeRejections}/${state.maxIteration}`;
	return "";
}

/** `session_start` found `phase: "freeze"`: the intent review died with the
 *  previous process, so nothing was decided and nothing was charged. Remove
 *  the transcript the crash left behind (only if it is ours), flip to PLAN
 *  with the counter kept, and tell the agent to re-submit. */
export function recoverInterruptedFreeze(pi: ExtensionAPI, ctx: ExtensionContext, state: GatedGoalState, gate: FreezeGate): boolean {
	if (state.phase !== "freeze") return false;
	if (state.transcriptDir) {
		removeCrashedTranscript(state.transcriptDir);
		state.transcriptDir = undefined;
	}
	state.phase = "plan";
	gate.save(ctx, state);
	gate.setStatus(ctx);
	gate.say(ctx, `⚠️ The intent review of your freeze attempt (${state.freezeRejections + 1}/${state.maxIteration}) was interrupted by a restart before it returned a verdict — not charged. Back in PLAN. Call freeze_plan again to re-run the review.`);
	return true;
}

const error = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });
const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

/** The `freeze_plan` tool: P2 → P2.5 → P3. Rejections are counted here (a
 *  finished intent review that did not approve), the cap is enforced here (the
 *  next call after `maxIteration` rejections freezes without a review), and a
 *  timed-out, crashed, cancelled or unrunnable review is never counted. */
export function registerFreezePlanTool(pi: ExtensionAPI, gate: FreezeGate): void {
	pi.registerTool({
		name: "freeze_plan",
		label: "Freeze gated-goal plan",
		description: [
			"Gated-goal PLAN phase only. Submits the agreed plan (four sections + todos) to the intent reviewer, who audits it against the conversation with the user: does it match what the user asked, is anything still ambiguous? Approved: the plan is frozen into an immutable review prompt (hashed), the todo list is REPLACED with the work items given here, and ACT begins. Rejected: the tool returns the reviewer's reasons — discuss them with the user, then call it again.",
			"Only call after the user has explicitly confirmed the plan — and only once they have seen it.",
		].join("\n"),
		parameters: Type.Object({
			outcome: Type.String({ description: "What the task must achieve (1..n concrete outcomes)." }),
			verification: Type.String({ description: "How success is checked: commands to run, tools to call, expected results." }),
			constraints: Type.String({ description: "What must NOT happen (files not to touch, data not to alter, etc.)." }),
			quality: Type.String({ description: "Quality bars (unit tests, CI must pass, etc.)." }),
			todos: Type.Array(Type.Object({
				text: Type.String(),
				status: Type.Optional(Type.Union([Type.Literal("todo"), Type.Literal("pending"), Type.Literal("done")], { description: "Default 'todo'." })),
			}), { minItems: 1, description: "Work items. At least one is required. These REPLACE the current todo list — include everything ACT needs, do not re-add them afterwards, and keep them consistent with the sections: the intent reviewer judges them too." }),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const s = gate.state();
			if (s.phase !== "plan") return error(`freeze_plan only valid in PLAN phase (current: ${s.phase}).`);
			if (params.todos.length === 0 || params.todos.some((todo) => !todo.text.trim())) {
				return error("freeze_plan requires at least one non-blank todo before entering ACT.");
			}
			const myEpoch = gate.epoch();
			const isStale = () => gate.epoch() !== myEpoch;
			const frozenPrompt = buildFrozenPrompt(params);

			// Budget exhausted by consecutive rejections: the review is skipped so
			// the gate moves on. Persist the transition first, then tell the user.
			if (s.freezeRejections >= s.maxIteration) {
				const used = s.freezeRejections;
				s.freezeRejections = 0;
				gate.enterAct(ctx, params.todos, frozenPrompt);
				ctx.ui.notify(`Intent review skipped — ${used}/${s.maxIteration} rejections used. Freezing as proposed.`, "warning");
				return ok(`Frozen (intent review skipped: ${used}/${s.maxIteration} rejections used). phase=act, hash=${s.frozenHash.slice(0, 12)}…`);
			}

			const attempt = s.freezeRejections + 1;
			s.phase = "freeze";
			s.frozenPrompt = frozenPrompt;
			s.frozenHash = hashPrompt(frozenPrompt);
			gate.save(ctx, s);
			gate.setStatus(ctx);

			let outcome: IntentReviewOutcome;
			try {
				outcome = await runIntentReview(pi, ctx, s, { prompt: frozenPrompt, todos: params.todos }, attempt, {
					signal: signal ?? undefined,
					isStale,
					onTranscript: (dir) => {
						s.transcriptDir = dir;
						gate.save(ctx, s);
					},
				});
			} catch (err: any) {
				// Nothing in the review may strand the gate in freeze.
				outcome = isStale() ? { kind: "stale" } : { kind: "failed", message: String(err?.message ?? err) };
			}

			// Exit / restart / session switch while the intent reviewer ran: this
			// call no longer owns the gate. Rechecked here, after the outer await,
			// before any verdict is applied — nothing is frozen, nothing is written.
			if (isStale() || outcome.kind === "stale") return error("freeze_plan aborted: the gate changed during the intent review (exit, restart or session switch). Nothing was frozen.");

			if (outcome.kind === "approved") {
				s.freezeRejections = 0;
				gate.enterAct(ctx, params.todos, frozenPrompt);
				return ok(`Frozen — the intent reviewer approved the plan (attempt ${attempt}). phase=act, hash=${s.frozenHash.slice(0, 12)}…`);
			}

			s.phase = "plan";
			if (outcome.kind === "rejected") s.freezeRejections = attempt;
			gate.save(ctx, s);
			gate.setStatus(ctx);

			if (outcome.kind === "rejected") {
				ctx.ui.notify(`freeze_plan rejected by the intent reviewer (${attempt}/${s.maxIteration})`, "warning");
				return error(
					`NOT frozen — the intent reviewer rejected this plan (rejection ${attempt}/${s.maxIteration}).\n\n${outcome.output}\n\nDiscuss each point with the user, adjust the plan to their answers, then call freeze_plan again.` +
					(attempt >= s.maxIteration ? `\n\nBudget exhausted: this was rejection ${attempt}/${s.maxIteration}. The NEXT freeze_plan call will skip the intent review and go straight to ACT.` : ""),
				);
			}

			// Not a verdict (child timed out, crashed, was cancelled) or the review
			// could not run at all: not counted, and the gate is never left in
			// freeze. The agent must tell the user before retrying.
			const why = outcome.kind === "notVerdict" ? `did not return a verdict (${outcome.status}). ${outcome.output.slice(0, 400)}` : `could not run (${outcome.message})`;
			return error(`NOT frozen — the intent review ${why}; not counted against the freeze budget. Tell the user before calling freeze_plan again.`);
		},
	});
}
