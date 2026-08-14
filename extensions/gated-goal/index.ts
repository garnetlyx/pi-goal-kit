/**
 * Gated-goal mode: a five-phase workflow that forces plan → act → review →
 * verify loops until a frozen plan is satisfied or max-iteration is hit.
 *
 *   /gated-goal [maxIteration] [reviewerModel]
 *
 * P1 select-reviewer — pick a reviewer model (arg, or ui.select, or esc = main
 *   model), then ping it with "reply ok". Failure → abort.
 * P2 plan            — discuss with user; agent calls freeze_plan with the four
 *   sections + todos. Frozen prompt + hash persisted; todos created; → P3.
 * P3 act             — main agent works. On agent_settled:
 *     all todos done → P4 ; else todo nudge (handled by todo ext) keeps it in P3.
 * P4 review          — spawn reviewer with the immutable frozen prompt. Parse
 *   <promise>DONE</promise>:
 *     done  → P5 (the promise alone never exits the gate)
 *     edits → feed feedback to main agent, → P3. If reviewsCompleted reaches
 *             maxIteration before a done → exit (reason: max iteration reached).
 * P5 verify          — main agent re-runs the frozen verification itself and
 *   judges the output, because a reviewer can rubber-stamp:
 *     confirm_done → exit (reason: done)
 *     reject_done  → back to P3, costing one iteration like a failed review.
 *
 * Reviewer is a subagent: appears in /subagents, emits wait:active/done, and
 * cannot dispatch (PI_SUBAGENT_CHILD guard inherited from the runner).
 *
 * Hash integrity: the frozen prompt is re-checked against its hash at spawn
 * time; on mismatch it is still used and only flagged — never exit (a mismatch
 * must not become an escape hatch out of the gate).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	buildFrozenPrompt,
	DEFAULT_MAX_ITERATION,
	type GatedGoalState,
	hashPrompt,
	load,
	REVIEWER_PERMISSIONS,
	save,
} from "./state.ts";
import { pingReviewer, runReview } from "./reviewer.ts";
import { availableModels } from "../subagent/models.ts";

/** Extract a `## Section` body from the frozen prompt. Returns "(not specified)" if absent. */
function extractSection(prompt: string, name: string): string {
	const re = new RegExp(`^## ${name}\\s*\\n([\\s\\S]*?)(?=\\n^## |$)`, "m");
	const m = prompt.match(re);
	return m ? m[1].trim() : "(not specified)";
}

interface TodoSnapshot {
	id: number;
	status: "todo" | "pending" | "done";
}

/** Scan session branch for the latest todo tool result (mirrors todo ext). */
function latestTodos(ctx: ExtensionContext): TodoSnapshot[] {
	for (let i = ctx.sessionManager.getBranch().length - 1; i >= 0; i--) {
		const entry: any = ctx.sessionManager.getBranch()[i];
		if (entry?.type !== "message") continue;
		const msg = entry.message;
		if (msg?.role === "toolResult" && msg.toolName === "todo") {
			const todos = msg.details?.todos;
			if (Array.isArray(todos)) return todos.map((t: any) => ({ id: t.id, status: t.status }));
		}
	}
	return [];
}

function allTodosDone(ctx: ExtensionContext, state: GatedGoalState): boolean {
	const todos = latestTodos(ctx);
	if (todos.length === 0) {
		// Recovery case: after a restart the todo list lives in the old session
		// branch and is no longer visible here. If we have a frozen plan AND
		// at least one review has already run, the work was previously judged
		// complete enough to enter review — treat that as "todos done" so the
		// recovery nudge can re-trigger a fresh review instead of deadlocking.
		return !!state.frozenHash && state.reviewsCompleted > 0;
	}
	return todos.every((t) => t.status === "done");
}

function modelIdOf(ctx: ExtensionContext): string {
	const m = ctx.model as any;
	return m && m.provider && m.id ? `${m.provider}/${m.id}` : "";
}


export default function (pi: ExtensionAPI) {
	const baseDir = dirname(fileURLToPath(import.meta.url));

	// Co-locate this extension's skill with its code; register it so pi loads
	// the SKILL.md without a separate skills/ entry.
	pi.on("resources_discover", () => ({
		skillPaths: [join(baseDir, "SKILL.md")],
	}));

	// In-memory mirror of persisted state; reloaded on session_start.
	let state: GatedGoalState = { phase: "idle", maxIteration: DEFAULT_MAX_ITERATION, reviewsCompleted: 0, reviewerModel: "", reviewerPermissions: REVIEWER_PERMISSIONS, frozenPrompt: "", frozenHash: "", startedAt: 0, originalCwd: "" };
	let ready = false;

	const reload = (ctx: ExtensionContext) => {
		state = load(ctx);
		ready = true;
		// Detect project path change since the run was created (project moved /
		// renamed / mounted elsewhere). Warn so the agent does not silently rely
		// on stale-path assumptions.
		if (state.phase !== "idle" && state.originalCwd && state.originalCwd !== ctx.cwd && ctx.hasUI) {
			ctx.ui.notify(`gated-goal: project path changed (${state.originalCwd} -> ${ctx.cwd}). Frozen plan still valid; file paths in it may need reinterpretation.`, "warning");
		}
	};

	pi.on("session_start", async (_e, ctx) => reload(ctx));
	pi.on("session_tree", async (_e, ctx) => reload(ctx));

	// ---- Self-heal: recover from a review interrupted by restart/crash ----
	//
	// If we come back up while phase === "review", the previous reviewer child
	// was killed mid-run (e.g. a pi restart or /reload). The reviewsCompleted
	// counter was already bumped, so we must NOT silently re-enter review
	// (that would double-count). Flip back to act so the next agent_settled
	// with all todos done re-triggers a fresh review. Also nudge the agent so
	// it knows the last review was lost and it should re-present completion.
	pi.on("session_start", async (_e, ctx) => {
		if (state.phase === "review") {
			state.phase = "act";
			save(ctx, state);
			setStatus(ctx, "recovering");
			pi.sendUserMessage(
				`⚠️ The previous review cycle (iteration ${state.reviewsCompleted}/${state.maxIteration}) was interrupted by a restart and its feedback was lost. Flipping back to ACT. If all work is complete, present your completion summary and stop — a fresh review will run automatically.`,
				{ deliverAs: "followUp" },
			);
		}
	});

	function setStatus(ctx: ExtensionContext, extra?: string): void {
		if (!ctx.hasUI) return;
		const phase = state.phase === "idle" ? "" : ` gated-goal[${state.phase}] ${state.reviewsCompleted}/${state.maxIteration}`;
		ctx.ui.setStatus?.("gated-goal", (phase + (extra ? " " + extra : "")).trim());
	}

	function exitGate(ctx: ExtensionContext, reason: string): void {
		state.phase = "idle";
		state.exitReason = reason;
		save(ctx, state);
		setStatus(ctx);
		ctx.ui.notify(`gated-goal exited: ${reason}`, reason === "done" ? "info" : "warning");
		pi.sendUserMessage(
			`🚪 Gated-goal exited — reason: ${reason}.` +
			(reason === "done" ? " Reviewer approved with <promise>DONE</promise>." : ""),
			{ deliverAs: "followUp" },
		);
	}

	// ---- P4 review cycle (fire-and-forget from agent_settled) ----
	function runReviewCycle(ctx: ExtensionContext): void {
		state.phase = "review";
		save(ctx, state);
		setStatus(ctx, "reviewing");

		void (async () => {
			const reviewNumber = state.reviewsCompleted + 1;
			let result;
			try {
				result = await runReview(pi, ctx, state, reviewNumber);
			} catch (err: any) {
				ctx.ui.notify(`reviewer crashed: ${err?.message ?? err}`, "error");
				state.phase = "act";
				save(ctx, state);
				setStatus(ctx);
				return;
			}

			if (result.done) {
				// Do NOT exit yet. Hand control to the main agent for an independent
				// verification pass: reviewer may have rubber-stamped. The main agent
				// runs the frozen verification commands itself and judges the real
				// stdout subjectively, then calls confirm_done or reject_done.
				//
				// Count this review against the budget NOW (a review that ran is a
				// spent iteration regardless of outcome), so reviewer-DONE-then-reject
				// and reviewer-rejects-directly consume budget symmetrically. If this
				// pushes us to max, exit before the agent wastes a turn verifying.
				state.reviewsCompleted = reviewNumber;
				save(ctx, state);
				if (state.reviewsCompleted >= state.maxIteration) {
					exitGate(ctx, "max iteration reached");
					return;
				}
				state.phase = "verify";
				save(ctx, state);
				setStatus(ctx, "verifying");
				const verificationSection = extractSection(state.frozenPrompt, "Verification");
				const tamperNote = result.tampered ? " (note: frozen prompt integrity check flagged — archived version used)" : "";
				pi.sendUserMessage(
					`✅ Reviewer (iteration ${reviewNumber}) returned <promise>DONE</promise>${tamperNote}. ` +
					`Before accepting, INDEPENDENTLY verify — reviewers can rubber-stamp. ` +
					`Run the frozen verification yourself and judge the real output subjectively:\n\n` +
					`--- Verification (from frozen plan) ---\n${verificationSection}\n--- end ---\n\n` +
					`If it genuinely holds: call confirm_done (exits gated-goal, reason: done). ` +
					`If the reviewer approved wrongly: call reject_done with what failed (goes back to ACT for fixes; this counts as a used iteration).`,
					{ deliverAs: "followUp" },
				);
				return;
			}

			state.reviewsCompleted = reviewNumber;
			save(ctx, state);

			if (state.reviewsCompleted >= state.maxIteration) {
				exitGate(ctx, "max iteration reached");
				return;
			}

			// Feedback → back to act. Hand control to main agent.
			state.phase = "act";
			save(ctx, state);
			setStatus(ctx, `iteration ${state.reviewsCompleted}`);
			const tamperNote = result.tampered ? " (note: frozen prompt integrity check flagged — archived version used)" : "";
			pi.sendUserMessage(
				`🔁 Reviewer (iteration ${state.reviewsCompleted}/${state.maxIteration}) was NOT satisfied${tamperNote}. Required changes:\n\n${result.output}\n\nApply these changes, then stop when done. The reviewer will run again automatically.`,
				{ deliverAs: "followUp" },
			);
		})();
	}

	// ---- P3→P4 transition + VERIFY anti-stall on settle ----
	pi.on("agent_settled", async (_e, ctx) => {
		if (!ready) reload(ctx);
		if (state.phase === "act") {
			// Need todos frozen AND all done to enter review.
			if (!state.frozenHash) return;
			if (allTodosDone(ctx, state)) {
				runReviewCycle(ctx);
			}
			// else: todo extension nudges; stay in act.
			return;
		}
		if (state.phase === "verify") {
			// Anti-stall: the agent finished a turn in VERIFY without calling
			// confirm_done / reject_done (those tools flip phase away from verify).
			// Nudge it to pick one explicitly.
			pi.sendUserMessage(
				`You are still in VERIFY phase. You must decide: call confirm_done (if your independent verification passed) or reject_done (with what failed). Do not stop without one of them.`,
				{ deliverAs: "followUp" },
			);
		}
	});

	// ---- /gated-goal command ----
	pi.registerCommand("gated-goal", {
		description: "Start gated-goal mode: /gated-goal [maxIteration] [reviewerModel]. Phases: select reviewer → plan → act → review loop.",
		handler: async (args, ctx) => {
			if (state.phase !== "idle") {
				const stop = await ctx.ui.confirm("Gated-goal already active", `Phase: ${state.phase}. Abort and start over?`);
				if (!stop) return;
			}

			// Parse args: optional numeric maxIteration, optional model string.
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			let maxIteration = 0;
			const rest: string[] = [];
			for (const t of tokens) {
				if (maxIteration === 0 && rest.length === 0 && /^\d+$/.test(t)) {
					maxIteration = Math.max(1, parseInt(t, 10));
				} else {
					rest.push(t);
				}
			}
			if (maxIteration === 0) maxIteration = DEFAULT_MAX_ITERATION;
			let modelArg = rest.join(" ").trim();

			// Resolve reviewer model.
			let reviewerModel = modelArg;
			if (!reviewerModel) {
				const models = availableModels(ctx);
				if (models.length === 0) {
					reviewerModel = modelIdOf(ctx);
					ctx.ui.notify(`No model list available; using main model ${reviewerModel}`, "info");
				} else {
					const choice = await ctx.ui.select("Select reviewer model (esc = main agent model):", models, { timeout: 120000 });
					reviewerModel = choice ?? modelIdOf(ctx);
				}
			}
			if (!reviewerModel) {
				ctx.ui.notify("No reviewer model — aborted", "error");
				return;
			}

			ctx.ui.notify(`Pinging reviewer ${reviewerModel} …`, "info");
			try {
				await pingReviewer(pi, ctx, reviewerModel);
			} catch (err: any) {
				ctx.ui.notify(`Reviewer connectivity failed: ${err?.message ?? err}. Gated-goal aborted.`, "error");
				return;
			}

			// Enter plan phase.
			state = {
				phase: "plan",
				maxIteration,
				reviewsCompleted: 0,
				reviewerModel,
				reviewerPermissions: REVIEWER_PERMISSIONS,
				frozenPrompt: "",
				frozenHash: "",
				startedAt: Date.now(),
			};
			save(ctx, state);
			setStatus(ctx, "planning");
			ctx.ui.notify(`Gated-goal ON — reviewer: ${reviewerModel}, max ${maxIteration} iterations. Discuss the goal, then call freeze_plan.`, "info");
			pi.sendUserMessage(
				`🎯 Gated-goal started (reviewer=${reviewerModel}, maxIterations=${maxIteration}). ` +
				`We are now in PLAN phase. Discuss with the user to align on the goal. When the user confirms, call freeze_plan with: outcome, verification (commands/tools), constraints (what not to do), quality (e.g. tests must pass), and todos (the work items). Only call freeze_plan after explicit user confirmation.`,
				{ deliverAs: "followUp" },
			);
		},
	});

	pi.registerCommand("gated-goal-exit", {
		description: "Abort the current gated-goal workflow.",
		handler: async (_args, ctx) => {
			if (state.phase === "idle") { ctx.ui.notify("No active gated-goal", "info"); return; }
			exitGate(ctx, "aborted by user");
		},
	});

	// ---- freeze_plan tool (P2 → P3) ----
	pi.registerTool({
		name: "freeze_plan",
		label: "Freeze gated-goal plan",
		description: [
			"Gated-goal PLAN phase only. Freezes the agreed plan into an immutable review prompt (hashed) and creates the work todos, then enters ACT phase.",
			"Only call after the user has explicitly confirmed the plan. Provide all four sections and the todo list.",
		].join("\n"),
		parameters: Type.Object({
			outcome: Type.String({ description: "What the task must achieve (1..n concrete outcomes)." }),
			verification: Type.String({ description: "How success is checked: commands to run, tools to call, expected results." }),
			constraints: Type.String({ description: "What must NOT happen (files not to touch, data not to alter, etc.)." }),
			quality: Type.String({ description: "Quality bars (unit tests, CI must pass, etc.)." }),
			todos: Type.Array(Type.Object({
				text: Type.String(),
				status: Type.Optional(Type.Union([Type.Literal("todo"), Type.Literal("pending"), Type.Literal("done")], { description: "Default 'todo'." })),
			}), { description: "Work items; become the todo list for the ACT phase." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (state.phase !== "plan") {
				return { content: [{ type: "text", text: `freeze_plan only valid in PLAN phase (current: ${state.phase}).` }], isError: true };
			}
			const frozenPrompt = buildFrozenPrompt(params);
			state.frozenPrompt = frozenPrompt;
			state.frozenHash = hashPrompt(frozenPrompt);
			state.phase = "act";
			save(ctx, state);
			setStatus(ctx, "acting");

			// Seed the todo list via the todo tool through session context: we
			// can't call another extension's tool directly, so instruct the agent.
			const todoLines = params.todos
				.map((t, i) => `  ${i + 1}. ${t.text}`)
				.join("\n");
			pi.sendUserMessage(
				`📋 Plan frozen (sha256 ${state.frozenHash.slice(0, 12)}…). Now create these todos via the todo tool and start ACTING:\n${todoLines}\n\nWork through them. When all are done and you stop, the reviewer runs automatically.`,
				{ deliverAs: "followUp" },
			);
			return { content: [{ type: "text", text: `Frozen. phase=act, hash=${state.frozenHash.slice(0, 12)}…` }] };
		},
	});

	// ---- confirm_done / reject_done tools (VERIFY phase) ----
	// After the reviewer returns <promise>DONE</promise>, control passes to the
	// main agent for an independent verification pass. These two tools are the
	// only ways out of VERIFY: confirm -> exit done; reject -> count this as a
	// used iteration and return to ACT for fixes.

	pi.registerTool({
		name: "confirm_done",
		label: "Confirm gated-goal done",
		description: [
			"Gated-goal VERIFY phase only. Call after you have independently re-run the frozen verification commands and subjectively judged that the work genuinely satisfies the plan.",
			"This is the final gate: the reviewer may have rubber-stamped, so your own verification is what actually closes the loop. Exits gated-goal with reason: done.",
		].join("\n"),
		parameters: Type.Object({
			note: Type.Optional(Type.String({ description: "Optional one-line summary of what you verified." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (state.phase !== "verify") {
				return { content: [{ type: "text", text: `confirm_done only valid in VERIFY phase (current: ${state.phase}).` }], isError: true };
			}
			const note = params.note?.trim();
			exitGate(ctx, "done" + (note ? ` — ${note}` : ""));
			return { content: [{ type: "text", text: "Confirmed. Exiting gated-goal." }] };
		},
	});

	pi.registerTool({
		name: "reject_done",
		label: "Reject reviewer approval",
		description: [
			"Gated-goal VERIFY phase only. Call when the reviewer returned <promise>DONE</promise> but your own verification shows the work does NOT actually satisfy the frozen plan (reviewer rubber-stamped).",
			"Returns to ACT with your reasons as feedback. The iteration was already charged when the review ran, so this does not consume extra budget; the cap is re-checked after the next review.",
		].join("\n"),
		parameters: Type.Object({
			reason: Type.String({ description: "What failed your independent verification. Becomes the feedback to ACT." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (state.phase !== "verify") {
				return { content: [{ type: "text", text: `reject_done only valid in VERIFY phase (current: ${state.phase}).` }], isError: true };
			}
			// The iteration was already counted when the review ran (entering VERIFY
			// bumped reviewsCompleted). Rejecting does not double-count; it just
			// returns control to ACT. The max-iteration check on re-entry to ACT
			// is handled by the next review cycle.
			state.phase = "act";
			save(ctx, state);
			setStatus(ctx, `iteration ${state.reviewsCompleted}`);
			pi.sendUserMessage(
				`🔁 You rejected the reviewer's <promise>DONE</promise> as a rubber-stamp (iteration ${state.reviewsCompleted}/${state.maxIteration}). Reason: ${params.reason}\n\nApply the fix, then stop. The reviewer will run again automatically.`,
				{ deliverAs: "followUp" },
			);
			return { content: [{ type: "text", text: `Rejected — back to ACT. iteration ${state.reviewsCompleted}/${state.maxIteration}.` }] };
		},
	});

	// surface status on demand
	pi.registerCommand("gated-goal-status", {
		description: "Show current gated-goal state",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				state.phase === "idle" ? "gated-goal idle" : `phase=${state.phase} reviews=${state.reviewsCompleted}/${state.maxIteration} reviewer=${state.reviewerModel}`,
				"info",
			);
		},
	});

	// keep status refreshed on agent activity
	pi.on("agent_settled", async (_e, ctx) => setStatus(ctx));
	pi.on("session_start", async (_e, ctx) => setStatus(ctx));
}
