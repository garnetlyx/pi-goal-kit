import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { filePath } from "../extensions/gated-goal/state.ts";
import { TODO_NUDGE_RESET_EVENT, TODO_SETTLED_EVENT, TODO_STATE_ENTRY, type TodoSettledEvent } from "../extensions/todo/snapshot.ts";
import { callTool, flush, makeHarness, type Ctx } from "./harness.ts";

// todo and gated-goal on one event bus, the way pi loads them: the nudge
// boundary between a review verdict and the next ACT round is a contract
// between two extensions and can only be seen end to end. The reviewer is the
// one faked boundary (the real one spawns a child pi process).
const runReview = vi.fn((..._a: unknown[]) => undefined as any);
vi.mock("../extensions/gated-goal/reviewer.ts", () => ({
	runReview: (...a: unknown[]) => runReview(...a),
	cancelActiveReviewer: () => true,
	pingReviewer: async () => {},
}));

const { default: activateGate } = await import("../extensions/gated-goal/index.ts");
const { default: activateTodo } = await import("../extensions/todo/index.ts");

const INCOMPLETE = ["write notes.md", "create out.txt", "verify with grep"];

describe("gated-goal × todo: a new ACT iteration is a new nudge boundary", () => {
	let agentDir: string;
	let ctx: Ctx;

	const statePath = () => filePath("test-session");
	const readState = () => JSON.parse(readFileSync(statePath(), "utf-8"));
	const seedState = (partial: Record<string, unknown> = {}) => {
		mkdirSync(dirname(statePath()), { recursive: true });
		writeFileSync(
			statePath(),
			JSON.stringify({
				phase: "act",
				maxIteration: 3,
				reviewsCompleted: 0,
				reviewerModel: "test/model",
				reviewerPermissions: ["read"],
				frozenPrompt: "## Verification\nrun tests",
				frozenHash: "deadbeef",
				startedAt: 1,
				originalCwd: "/tmp/project",
				...partial,
			}),
		);
	};

	/** Both extensions live, the frozen list installed, every item still open. */
	async function rig(partial: Record<string, unknown> = {}) {
		seedState(partial);
		const todos = INCOMPLETE.map((text, i) => ({ id: i + 1, text, status: "todo" as const }));
		ctx = {
			sessionManager: { getSessionId: () => "test-session", getBranch: () => [{ type: "custom", customType: TODO_STATE_ENTRY, data: { todos, nextId: todos.length + 1 } }] },
			cwd: "/tmp/project",
			hasUI: true,
			ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, confirm: async () => true, select: async () => undefined },
		};
		const h = makeHarness(ctx);
		activateTodo(h.pi as any);
		activateGate(h.pi as any);
		await h.fire("session_start");
		const dispositions: TodoSettledEvent["disposition"][] = [];
		const resets: unknown[] = [];
		h.pi.events.on(TODO_SETTLED_EVENT, (d: unknown) => dispositions.push((d as TodoSettledEvent).disposition));
		h.pi.events.on(TODO_NUDGE_RESET_EVENT, (d: unknown) => resets.push(d));
		const settle = () => h.fire("agent_settled");
		const nudges = () => h.sent.filter((t: string) => t.includes("todo(s) still incomplete"));
		return { h, dispositions, resets, settle, nudges };
	}

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "gated-goal-nudge-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
		delete process.env.PI_CODING_AGENT_DIR;
		vi.clearAllMocks();
	});

	it("a NOT-satisfied verdict re-arms the nudge: the next untouched stop nudges again instead of starting review #2", async () => {
		const { h, dispositions, resets, settle, nudges } = await rig();
		let finish!: (r: unknown) => void;
		runReview.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));

		await settle(); // first stop with an open list → nudge #1
		await settle(); // the agent ignored it and touched nothing → review #1
		expect(dispositions).toEqual(["continue", "review"]);
		expect(runReview).toHaveBeenCalledTimes(1);

		finish({ done: false, output: "Add tests for X.", tampered: false, restored: false, status: "done" });
		await flush();
		await flush();

		// The feedback itself tells the agent to reconcile the list…
		const feedback = h.sent.find((t: string) => t.includes("was NOT satisfied"));
		expect(feedback).toContain("Add tests for X.");
		expect(feedback).toContain("reconcile your todo list with this feedback");
		// …and the nudge is re-armed for the iteration that starts here.
		expect(resets).toEqual([{ source: "gated-goal" }]);
		expect(readState()).toMatchObject({ phase: "act", reviewsCompleted: 1 });

		// The agent applies the change and still never touches the list: this
		// stop is nudged (seen once per iteration), not sent straight to review.
		await settle();
		expect(dispositions.at(-1)).toBe("continue");
		expect(nudges()).toHaveLength(2);
		expect(runReview).toHaveBeenCalledTimes(1);

		// Still bounded: one nudge per iteration, then review.
		await settle();
		expect(dispositions.at(-1)).toBe("review");
		expect(runReview).toHaveBeenCalledTimes(2);
	});

	it("a rejected approval (reject_done) re-arms the nudge the same way", async () => {
		const { dispositions, resets, settle, nudges, h } = await rig({ phase: "verify", reviewsCompleted: 1 });
		await settle(); // the list is still fresh here → nudge #1
		await settle(); // de-duplicated; the gate sits in VERIFY and ignores the review disposition
		expect(dispositions).toEqual(["continue", "review"]);
		expect(nudges()).toHaveLength(1);

		const result = await callTool(h, "reject_done", { reason: "tests fail" }, ctx);
		expect(result.isError).toBeUndefined();
		expect(resets).toEqual([{ source: "gated-goal" }]);
		expect(h.sent.some((t: string) => t.includes("reconcile your todo list with this reason"))).toBe(true);

		await settle();
		expect(dispositions.at(-1)).toBe("continue");
		expect(nudges()).toHaveLength(2);
	});

	it("a verdict that lands during a compaction is delivered after it, with its state already recorded", async () => {
		const { settle, resets, h } = await rig();
		let finish!: (r: unknown) => void;
		runReview.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
		await settle();
		await settle();
		expect(readState().phase).toBe("review");

		await h.fire("session_before_compact", { reason: "manual" });
		finish({ done: false, output: "Add tests for X.", tampered: false, restored: false, status: "done" });
		await flush();
		await flush();

		// State and the nudge boundary are the verdict's; only the words wait.
		expect(readState()).toMatchObject({ phase: "act", reviewsCompleted: 1 });
		expect(resets).toHaveLength(1);
		expect(h.sent.some((t: string) => t.includes("was NOT satisfied"))).toBe(false);

		await h.fire("session_compact", {});
		await flush();
		expect(h.sent.some((t: string) => t.includes("was NOT satisfied"))).toBe(true);
	});

	it("a verdict held through a compaction is never delivered once the gate has exited", async () => {
		const { settle, h } = await rig();
		let finish!: (r: unknown) => void;
		runReview.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
		await settle();
		await settle();

		await h.fire("session_before_compact", { reason: "manual" });
		finish({ done: true, output: "<promise>DONE</promise>", tampered: false, restored: false, status: "done" });
		await flush();
		await flush();
		await h.commands.get("gated-goal-exit")!.handler("", ctx); // user aborts mid-compaction

		await h.fire("session_compact", {});
		await flush();
		expect(h.sent.some((t: string) => t.includes("returned <promise>DONE</promise>"))).toBe(false);
		expect(h.sent.some((t: string) => t.includes("Gated-goal exited"))).toBe(true);
		expect(readState()).toMatchObject({ phase: "idle", exitReason: "aborted by user" });
	});
});
