import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { filePath, FROZEN_ENTRY } from "../extensions/gated-goal/state.ts";
import { TODO_REPLACE_EVENT } from "../extensions/todo/snapshot.ts";
import { callTool, flush, makeHarness, type Ctx } from "./harness.ts";
import { buildIntentReviewPrompt } from "../extensions/gated-goal/reviewer.ts";
import { renderTranscript } from "../extensions/gated-goal/plan-review.ts";

// Reviewer boundary faked: the real one spawns a child pi process. The plan
// review returns { approved, output, status } like the real runPlanReview.
const runReview = vi.fn((..._a: any[]) => undefined as any);
const cancelActiveReviewer = vi.fn((..._a: any[]) => true);
const pingReviewer = vi.fn(async (..._a: any[]) => {});
const runPlanReview = vi.fn((..._a: any[]) => undefined as any);
vi.mock("../extensions/gated-goal/reviewer.ts", async (importOriginal) => ({
	// Pure exports (prompt builders) stay real; only the child-process boundary is faked.
	...(await importOriginal<typeof import("../extensions/gated-goal/reviewer.ts")>()),
	runReview: (...a: unknown[]) => runReview(...a),
	cancelActiveReviewer: (...a: unknown[]) => cancelActiveReviewer(...a),
	pingReviewer: (...a: unknown[]) => pingReviewer(...a),
	runPlanReview: (...a: unknown[]) => runPlanReview(...a),
}));

const { default: activate } = await import("../extensions/gated-goal/index.ts");

const PLAN = {
	outcome: "Ship the feature",
	verification: "run tests",
	constraints: "no deletions",
	quality: "tsc clean",
	todos: [{ text: "do it" }],
};

describe("gated-goal plan freeze loop (P2.5)", () => {
	let agentDir: string;
	let ctx: Ctx;

	const statePath = () => filePath("test-session");
	const seedState = (partial: Record<string, unknown> = {}) => {
		mkdirSync(dirname(statePath()), { recursive: true });
		writeFileSync(
			statePath(),
			JSON.stringify({
				phase: "plan",
				maxIteration: 3,
				reviewsCompleted: 0,
				freezeRejections: 0,
				reviewerModel: "test/model",
				reviewerPermissions: ["read"],
				frozenPrompt: "",
				frozenHash: "",
				startedAt: 1,
				originalCwd: "/tmp/project",
				...partial,
			}),
		);
	};
	const readState = () => JSON.parse(readFileSync(statePath(), "utf-8"));

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "gated-goal-freeze-test-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		ctx = {
			sessionManager: { getSessionId: () => "test-session", getBranch: () => [] },
			cwd: "/tmp/project",
			hasUI: true,
			ui: { notify: () => {}, setStatus: () => {}, confirm: async () => true, select: async () => undefined },
		};
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
		delete process.env.PI_CODING_AGENT_DIR;
		vi.clearAllMocks();
	});

	it("an approved plan freezes: phase act, counter reset, todo replaced, transcript removed", async () => {
		seedState({ freezeRejections: 2 });
		const h = makeHarness(ctx);
		activate(h.pi as any);
		await h.fire("session_start");

		let transcriptPath = "";
		runPlanReview.mockImplementationOnce(async (_pi: any, _ctx: any, state: any, opts: any) => {
			expect(state.reviewerModel).toBe("test/model");
			expect(opts).toMatchObject({ attempt: 3, max: 3 });
			expect(readState().phase).toBe("freeze");
			expect(existsSync(opts.transcriptPath)).toBe(true);
			transcriptPath = opts.transcriptPath;
			return { approved: true, output: "<promise>DONE</promise> plan matches the request", status: "done" };
		});
		let replaced: any;
		h.pi.events.on(TODO_REPLACE_EVENT, (d: unknown) => { replaced = d; });

		const result = await callTool(h, "freeze_plan", PLAN, ctx);

		expect(result.isError).toBeFalsy();
		expect(readState().phase).toBe("act");
		expect(readState().freezeRejections).toBe(0);
		expect(replaced.items).toEqual(PLAN.todos);
		expect(existsSync(transcriptPath)).toBe(false);
	});

	it("a rejected plan returns to plan with the reviewer's reasons and counts one rejection", async () => {
		seedState();
		const h = makeHarness(ctx);
		activate(h.pi as any);
		await h.fire("session_start");
		const reasons = "Intent mismatches:\n- the user asked for A, the plan delivers B\nQuestions to ask the user:\n1. Which file?";
		runPlanReview.mockResolvedValueOnce({ approved: false, output: reasons, status: "done" });

		const result = await callTool(h, "freeze_plan", PLAN, ctx);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain(reasons);
		expect(result.content[0].text).toContain("rejection 1/3");
		expect(result.content[0].text).toContain("Discuss");
		expect(readState().phase).toBe("plan");
		expect(readState().freezeRejections).toBe(1);
	});

	it("once the budget is exhausted the next freeze goes straight to ACT without an intent review", async () => {
		seedState({ maxIteration: 2, freezeRejections: 2 });
		const h = makeHarness(ctx);
		activate(h.pi as any);
		await h.fire("session_start");

		const result = await callTool(h, "freeze_plan", PLAN, ctx);

		expect(runPlanReview).not.toHaveBeenCalled();
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain("skipped");
		expect(readState().phase).toBe("act");
	});

	it("the rejection that exhausts the budget announces the bypass", async () => {
		seedState({ maxIteration: 2, freezeRejections: 1 });
		const h = makeHarness(ctx);
		activate(h.pi as any);
		await h.fire("session_start");
		runPlanReview.mockResolvedValueOnce({ approved: false, output: "still ambiguous", status: "done" });

		const result = await callTool(h, "freeze_plan", PLAN, ctx);

		expect(result.content[0].text).toContain("rejection 2/2");
		expect(result.content[0].text).toContain("NEXT freeze_plan call will skip the intent review");
		expect(readState().freezeRejections).toBe(2);
	});

	it("a crashed intent review is not a verdict: not counted, back to plan", async () => {
		seedState();
		const h = makeHarness(ctx);
		activate(h.pi as any);
		await h.fire("session_start");
		runPlanReview.mockResolvedValueOnce({ approved: false, output: "(partial)", status: "timeout" });

		const result = await callTool(h, "freeze_plan", PLAN, ctx);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("did not return a verdict");
		expect(result.content[0].text).toContain("not counted");
		expect(readState().phase).toBe("plan");
		expect(readState().freezeRejections).toBe(0);
	});

	it("an intent review that cannot run at all is not a verdict either: not counted, back to plan", async () => {
		seedState();
		const h = makeHarness(ctx);
		activate(h.pi as any);
		await h.fire("session_start");
		runPlanReview.mockRejectedValueOnce(new Error("spawn failed"));

		const result = await callTool(h, "freeze_plan", PLAN, ctx);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("could not run (spawn failed)");
		expect(readState().phase).toBe("plan");
		expect(readState().freezeRejections).toBe(0);
	});

	it("a restart during the freeze review returns to PLAN, keeps the counter and tells the agent", async () => {
		seedState({ phase: "freeze", freezeRejections: 1 });
		const h = makeHarness(ctx);
		activate(h.pi as any);
		await h.fire("session_start");

		expect(readState().phase).toBe("plan");
		expect(readState().freezeRejections).toBe(1);
		expect(h.sent.some((t: string) => t.includes("interrupted by a restart") && t.includes("not charged"))).toBe(true);
	});

	it("exiting during a freeze review discards the late verdict and leaves the gate idle", async () => {
		seedState();
		const h = makeHarness(ctx);
		activate(h.pi as any);
		await h.fire("session_start");
		let verdict!: (v: unknown) => void;
		runPlanReview.mockImplementationOnce(() => new Promise((res) => { verdict = res; }));

		const pending = callTool(h, "freeze_plan", PLAN, ctx);
		await flush();
		expect(readState().phase).toBe("freeze");

		await h.commands.get("gated-goal-exit")!.handler("", ctx);
		const sentAtExit = h.sent.length;
		verdict({ approved: true, output: "<promise>DONE</promise>", status: "done" });
		const result = await pending;

		expect(result.isError).toBe(true);
		expect(readState().phase).toBe("idle");
		expect(readState().exitReason).toBe("aborted by user");
		expect(h.sent.length).toBe(sentAtExit);
	});

	it("freeze_plan outside PLAN is refused (including while a freeze review is in flight)", async () => {
		seedState({ phase: "act" });
		const h = makeHarness(ctx);
		activate(h.pi as any);
		await h.fire("session_start");

		const result = await callTool(h, "freeze_plan", PLAN, ctx);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("only valid in PLAN phase (current: act)");
	});
});

describe("transcript rendering", () => {
	it("renders user/assistant text, compact tool calls, truncated tool results, and gate markers; omits thinking and bookkeeping entries", () => {
		const entries: any[] = [
			{ type: "session", id: "s", cwd: "/tmp" },
			{ type: "message", id: "1", timestamp: "2026-11-24T23:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "make it faster" }] } },
			{ type: "model_change", id: "2", modelId: "m" },
			{ type: "message", id: "3", timestamp: "2026-11-24T23:00:05.000Z", message: { role: "assistant", content: [
				{ type: "thinking", thinking: "secret reasoning" },
				{ type: "text", text: "Which part?" },
				{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls " + "x".repeat(400) } },
			] } },
			{ type: "message", id: "4", timestamp: "2026-11-24T23:00:06.000Z", message: { role: "toolResult", toolName: "bash", toolCallId: "c1", isError: true, content: [{ type: "text", text: "y".repeat(400) }] } },
			{ type: "custom", id: "5", customType: FROZEN_ENTRY, data: { prompt: "## Outcome", hash: "abcdef0123456789" } },
		];

		const text = renderTranscript(entries);

		expect(text).not.toContain("secret reasoning");
		expect(text).not.toContain("model_change");
		expect(text).toContain("## 1. USER — 23:00:00\nmake it faster");
		expect(text).toContain("## 2. ASSISTANT — 23:00:05\nWhich part?");
		expect(text).toMatch(/\[tool call\] bash \{"command":"ls x{0,190}/);
		expect(text).toMatch(/\[tool result · bash · error\] y{300}…$/m);
		expect(text).toContain("[gated-goal] plan frozen (sha256 abcdef012345…)");
	});
});

describe("intent review prompt", () => {
	it("carries the plan, the transcript path, the attempt, the verdict protocol and the workflow-line note", () => {
		const prompt = buildIntentReviewPrompt("## Outcome\nShip it", {
			transcriptPath: "/tmp/pi-subagent-abc/transcript-freeze.md",
			attempt: 2,
			max: 5,
			deadline: "Time budget: your review window is 30 minutes.",
		});

		expect(prompt).toContain("## Outcome\nShip it");
		expect(prompt).toContain("/tmp/pi-subagent-abc/transcript-freeze.md");
		expect(prompt).toContain("freeze attempt 2/5");
		expect(prompt).toContain("<promise>DONE</promise>");
		expect(prompt).toContain("workflow messages injected by the gated-goal extension");
		expect(prompt).toContain("Time budget: your review window is 30 minutes.");
	});
});
