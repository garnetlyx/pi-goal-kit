import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { filePath, FROZEN_ENTRY } from "../extensions/gated-goal/state.ts";
import { TODO_REPLACE_EVENT } from "../extensions/todo/snapshot.ts";
import { callTool, flush, makeHarness, type Ctx } from "./harness.ts";
import { buildIntentReviewPrompt, renderTranscript, type TodoItem } from "../extensions/gated-goal/plan-review.ts";
import { isStandaloneApproval } from "../extensions/gated-goal/reviewer.ts";

// Child-process boundaries faked: the reviewer spawn (reviewer.ts) and the
// temp-file helper (runner.ts). Everything else — verdict parsing, the freeze
// tool, transcript rendering, state machine, epoch latch — runs for real.
const spawnReviewer = vi.fn((..._a: any[]) => undefined as any);
const runReview = vi.fn((..._a: any[]) => undefined as any);
const cancelActiveReviewer = vi.fn((..._a: any[]) => true);
const pingReviewer = vi.fn(async (..._a: any[]) => {});
vi.mock("../extensions/gated-goal/reviewer.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../extensions/gated-goal/reviewer.ts")>()),
	spawnReviewer: (...a: unknown[]) => spawnReviewer(...a),
	runReview: (...a: unknown[]) => runReview(...a),
	cancelActiveReviewer: (...a: unknown[]) => cancelActiveReviewer(...a),
	pingReviewer: (...a: unknown[]) => pingReviewer(...a),
}));
const writeTempFile = vi.fn((..._a: any[]) => undefined as any);
vi.mock("../extensions/subagent/runner.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../extensions/subagent/runner.ts")>()),
	writeTempFile: (...a: unknown[]) => writeTempFile(...a),
}));

const { default: activate } = await import("../extensions/gated-goal/index.ts");

const PLAN: { outcome: string; verification: string; constraints: string; quality: string; todos: TodoItem[] } = {
	outcome: "Ship the feature",
	verification: "run tests",
	constraints: "no deletions",
	quality: "tsc clean",
	todos: [{ text: "do it" }, { text: "then verify", status: "done" }],
};
const DONE = "<promise>DONE</promise>\nplan matches the request";

/** Real temp file, like the production helper, so cleanup paths are exercised. */
function realWriteTempFile(kind: string, name: string, content: string) {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagent-test-"));
	const file = join(dir, `${kind}-${name}.md`);
	writeFileSync(file, content, { mode: 0o600 });
	return Promise.resolve({ dir, file });
}

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
	/** Harness + activated extension; `ctx.ui` calls are spies. */
	const start = async () => {
		const h = makeHarness(ctx);
		activate(h.pi as any);
		await h.fire("session_start");
		return h;
	};

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "gated-goal-freeze-test-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		ctx = {
			sessionManager: { getSessionId: () => "test-session", getBranch: () => [] },
			cwd: "/tmp/project",
			hasUI: true,
			ui: { notify: vi.fn(), setStatus: vi.fn(), confirm: async () => true, select: async () => undefined },
		};
		spawnReviewer.mockResolvedValue({ output: DONE, status: "done" });
		writeTempFile.mockImplementation(realWriteTempFile);
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
		delete process.env.PI_CODING_AGENT_DIR;
		vi.clearAllMocks();
	});

	it("an approved plan freezes: phase act, counter reset, todo replaced, transcript removed", async () => {
		seedState({ freezeRejections: 2 });
		const h = await start();
		let transcriptPath = "";
		spawnReviewer.mockImplementationOnce(async (_pi: any, _ctx: any, opts: any) => {
			expect(opts).toMatchObject({ name: "plan-reviewer-3", model: "test/model", permissions: ["read"] });
			expect(opts.systemPrompt).toContain("freeze attempt 3/3");
			expect(readState().phase).toBe("freeze");
			transcriptPath = opts.systemPrompt.match(/rendered to a file: (\S+)/)![1];
			expect(existsSync(transcriptPath)).toBe(true);
			expect(readState().transcriptDir).toBe(dirname(transcriptPath));
			return { output: DONE, status: "done" };
		});
		let replaced: any;
		h.pi.events.on(TODO_REPLACE_EVENT, (d: unknown) => { replaced = d; });

		const result = await callTool(h, "freeze_plan", PLAN, ctx);

		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain("approved the plan (attempt 3)");
		expect(readState().phase).toBe("act");
		expect(readState().freezeRejections).toBe(0);
		expect(readState().transcriptDir).toBeUndefined();
		expect(replaced.items).toEqual(PLAN.todos);
		expect(existsSync(transcriptPath)).toBe(false);
	});

	it("a rejected plan returns to plan with the reviewer's reasons and counts one rejection", async () => {
		seedState();
		const h = await start();
		const reasons = "Intent mismatches:\n- the user asked for A, the plan delivers B\nQuestions to ask the user:\n1. Which file?";
		spawnReviewer.mockResolvedValueOnce({ output: reasons, status: "done" });

		const result = await callTool(h, "freeze_plan", PLAN, ctx);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain(reasons);
		expect(result.content[0].text).toContain("rejection 1/3");
		expect(result.content[0].text).toContain("Discuss");
		expect(readState().phase).toBe("plan");
		expect(readState().freezeRejections).toBe(1);
		expect(readState().transcriptDir).toBeUndefined();
	});

	it("once the budget is exhausted the next freeze goes straight to ACT without an intent review, persisted before the user is told", async () => {
		seedState({ maxIteration: 2, freezeRejections: 2 });
		const h = await start();
		ctx.ui.notify = vi.fn(() => {
			expect(readState().phase).toBe("act");
			expect(readState().freezeRejections).toBe(0);
		});

		const result = await callTool(h, "freeze_plan", PLAN, ctx);

		expect(spawnReviewer).not.toHaveBeenCalled();
		expect(writeTempFile).not.toHaveBeenCalled();
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain("skipped: 2/2");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Intent review skipped — 2/2"), "warning");
	});

	it("the rejection that exhausts the budget announces the bypass", async () => {
		seedState({ maxIteration: 2, freezeRejections: 1 });
		const h = await start();
		spawnReviewer.mockResolvedValueOnce({ output: "still ambiguous", status: "done" });

		const result = await callTool(h, "freeze_plan", PLAN, ctx);

		expect(result.content[0].text).toContain("rejection 2/2");
		expect(result.content[0].text).toContain("NEXT freeze_plan call will skip the intent review");
		expect(readState().freezeRejections).toBe(2);
	});

	it("a crashed intent review is not a verdict: not counted, back to plan", async () => {
		seedState();
		const h = await start();
		spawnReviewer.mockResolvedValueOnce({ output: "(partial)", status: "timeout" });

		const result = await callTool(h, "freeze_plan", PLAN, ctx);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("did not return a verdict (timeout)");
		expect(result.content[0].text).toContain("not counted");
		expect(readState().phase).toBe("plan");
		expect(readState().freezeRejections).toBe(0);
	});

	it("an intent review that cannot run at all is not a verdict either: not counted, back to plan", async () => {
		seedState();
		const h = await start();
		spawnReviewer.mockRejectedValueOnce(new Error("spawn failed"));

		const result = await callTool(h, "freeze_plan", PLAN, ctx);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("could not run (spawn failed)");
		expect(readState().phase).toBe("plan");
		expect(readState().freezeRejections).toBe(0);
	});

	it("the tool's abort signal reaches the reviewer spawn; an already-aborted call never spawns", async () => {
		seedState();
		const h = await start();
		const controller = new AbortController();
		spawnReviewer.mockImplementationOnce(async (_pi: any, _ctx: any, opts: any) => {
			expect(opts.signal).toBe(controller.signal);
			return { output: DONE, status: "done" };
		});
		const tool = h.tools.get("freeze_plan")!;
		await tool.execute("call", PLAN, controller.signal, undefined, ctx);
		expect(spawnReviewer).toHaveBeenCalledTimes(1);

		seedState();
		const h2 = await start();   // fresh gate: the first one is in ACT now
		const aborted = new AbortController();
		aborted.abort();
		const result = await h2.tools.get("freeze_plan")!.execute("call", PLAN, aborted.signal, undefined, ctx) as any;
		expect(spawnReviewer).toHaveBeenCalledTimes(1);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("did not return a verdict (cancelled)");
		expect(readState().phase).toBe("plan");
	});

	it("a restart during the freeze review returns to PLAN, keeps the counter, tells the agent and removes the crashed transcript", async () => {
		const leftover = mkdtempSync(join(tmpdir(), "pi-subagent-leftover-"));
		writeFileSync(join(leftover, "transcript-gated-goal.md"), "user conversation");
		seedState({ phase: "freeze", freezeRejections: 1, transcriptDir: leftover });
		const h = await start();

		expect(readState().phase).toBe("plan");
		expect(readState().freezeRejections).toBe(1);
		expect(readState().transcriptDir).toBeUndefined();
		expect(existsSync(leftover)).toBe(false);
		expect(h.sent.some((t: string) => t.includes("interrupted by a restart") && t.includes("not charged"))).toBe(true);
	});

	const inFlight = () => {
		let resolve!: (r: unknown) => void;
		let started!: () => void;
		const began = new Promise<void>((r) => { started = r; });
		spawnReviewer.mockImplementationOnce(() => new Promise((res) => { resolve = res; started(); }));
		return { began, resolve: (v: unknown) => resolve(v) };
	};

	it("exiting during a freeze review discards the late verdict, kills the child and leaves the gate idle", async () => {
		seedState();
		const h = await start();
		const review = inFlight();

		const pending = callTool(h, "freeze_plan", PLAN, ctx);
		await review.began;
		expect(readState().phase).toBe("freeze");

		await h.commands.get("gated-goal-exit")!.handler("", ctx);
		const sentAtExit = h.sent.length;
		review.resolve({ output: DONE, status: "done" });
		const result = await pending;

		expect(cancelActiveReviewer).toHaveBeenCalled();
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("aborted");
		expect(readState().phase).toBe("idle");
		expect(readState().exitReason).toBe("aborted by user");
		expect(h.sent.length).toBe(sentAtExit);
		expect(existsSync(readState().transcriptDir ?? "")).toBe(false);
	});

	it("exiting before the reviewer spawns (transcript still being written) spawns nothing", async () => {
		seedState();
		const h = await start();
		const pendingWrite = realWriteTempFile("transcript", "gated-goal", "x");
		let release!: (v: unknown) => void;
		let writing!: () => void;
		const writeBegan = new Promise<void>((r) => { writing = r; });
		writeTempFile.mockImplementationOnce(() => new Promise((res) => { release = res; writing(); }));

		const pending = callTool(h, "freeze_plan", PLAN, ctx);
		await writeBegan;
		await h.commands.get("gated-goal-exit")!.handler("", ctx);
		const written = await pendingWrite;
		release(written);
		const result = await pending;

		expect(spawnReviewer).not.toHaveBeenCalled();
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("aborted");
		expect(readState().phase).toBe("idle");
		expect(readState().exitReason).toBe("aborted by user");
		expect(existsSync(written.dir)).toBe(false);
		expect(h.sent.filter((t: string) => t.includes("Plan frozen"))).toHaveLength(0);
	});

	it("a session switch invalidates the outgoing instance: the in-flight freeze writes nothing and announces nothing", async () => {
		seedState();
		const h = await start();
		const review = inFlight();
		const pending = callTool(h, "freeze_plan", PLAN, ctx);
		await review.began;

		await h.fire("session_shutdown");
		expect(cancelActiveReviewer).toHaveBeenCalled();
		const before = readState();
		review.resolve({ output: DONE, status: "done" });
		const result = await pending;

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("aborted");
		expect(readState()).toEqual(before);
		expect(h.sent).toHaveLength(0);
	});

	it("the footer derives the freeze hints from state, so they survive the settle refresh and a resume", async () => {
		seedState();
		const h = await start();
		spawnReviewer.mockResolvedValueOnce({ output: "needs clarification", status: "done" });
		await callTool(h, "freeze_plan", PLAN, ctx);
		const lastStatus = () => (ctx.ui.setStatus as any).mock.calls.at(-1)[1];
		expect(lastStatus()).toContain("freeze rejected 1/3");

		await h.fire("agent_settled");
		expect(lastStatus()).toContain("freeze rejected 1/3");

		seedState({ phase: "plan", freezeRejections: 2 });
		const h2 = makeHarness(ctx);
		activate(h2.pi as any);
		await h2.fire("session_start");
		expect(lastStatus()).toContain("gated-goal[plan] 0/3 freeze rejected 2/3");

		seedState({ phase: "freeze", freezeRejections: 2 });
		const h3 = makeHarness(ctx);
		activate(h3.pi as any);
		await h3.fire("session_start");
		// session_start heals freeze → plan first; the hint then reads as a rejection count
		expect(lastStatus()).toContain("freeze rejected 2/3");
	});

	it("freeze_plan outside PLAN is refused (including while a freeze review is in flight)", async () => {
		seedState({ phase: "act" });
		const h = await start();

		const result = await callTool(h, "freeze_plan", PLAN, ctx);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("only valid in PLAN phase (current: act)");
	});
});

describe("intent review verdict protocol (standalone tag outside fences)", () => {
	it("approves only a line that is exactly the tag", () => {
		expect(isStandaloneApproval(DONE)).toBe(true);
		expect(isStandaloneApproval("Review complete.\n\n<promise>DONE</promise>\n")).toBe(true);
		expect(isStandaloneApproval("<promise> done </promise>")).toBe(true);
	});

	it("rejects mentions sharing the line with the tag", () => {
		expect(isStandaloneApproval("<promise>DONE</promise> is an example, not my verdict")).toBe(false);
		expect(isStandaloneApproval("<promise>DONE</promise>: the plan looks fine")).toBe(false);
		expect(isStandaloneApproval("do not output <promise>DONE</promise> until the user answers")).toBe(false);
	});

	it("rejects a tag inside a closed or an unclosed code fence", () => {
		expect(isStandaloneApproval("```\n<promise>DONE</promise>\n```")).toBe(false);
		expect(isStandaloneApproval("Example output:\n```\n<promise>DONE</promise>")).toBe(false);
		expect(isStandaloneApproval("~~~\n<promise>DONE</promise>\n~~~\nstill not a verdict")).toBe(false);
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
	it("carries the plan, every proposed todo with its status, the transcript path, the attempt, the standalone verdict protocol and a generic note on workflow messages", () => {
		const prompt = buildIntentReviewPrompt({ prompt: "## Outcome\nShip it", todos: PLAN.todos }, {
			transcriptPath: "/tmp/pi-subagent-abc/transcript-gated-goal.md",
			attempt: 2,
			max: 5,
			deadline: "Time budget: your review window is 30 minutes.",
		});

		expect(prompt).toContain("## Outcome\nShip it");
		expect(prompt).toContain("## Proposed todos\n  1. [todo] do it\n  2. [done] then verify");
		expect(prompt).toContain("/tmp/pi-subagent-abc/transcript-gated-goal.md");
		expect(prompt).toContain("freeze attempt 2/5");
		expect(prompt).toContain("a line consisting of exactly <promise>DONE</promise> and nothing else on that line");
		expect(prompt).toContain("injects workflow messages this way");
		expect(prompt).not.toMatch(/🎯|📋/);
		expect(prompt).toContain("Time budget: your review window is 30 minutes.");
	});
});
