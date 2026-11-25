import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { filePath } from "../extensions/gated-goal/state.ts";
import { TODO_SETTLED_EVENT } from "../extensions/todo/snapshot.ts";
import { flush, makeHarness, type Ctx } from "./harness.ts";

// The reviewer is the boundary we must fake: the real one spawns a child pi
// process. Everything else (state machine, epoch latch, commands) runs for real.
const runReview = vi.fn((..._a: any[]) => undefined as any);
const cancelActiveReviewer = vi.fn((..._a: any[]) => true);
const pingReviewer = vi.fn(async (..._a: any[]) => {});
vi.mock("../extensions/gated-goal/reviewer.ts", () => ({
	runReview: (...a: unknown[]) => runReview(...a),
	cancelActiveReviewer: (...a: unknown[]) => cancelActiveReviewer(...a),
	pingReviewer: (...a: unknown[]) => pingReviewer(...a),
}));

const { default: activate } = await import("../extensions/gated-goal/index.ts");

describe("gated-goal exit vs in-flight review (epoch latch)", () => {
	let agentDir: string;
	let ctx: Ctx;

	const statePath = () => filePath("test-session");
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
	const readState = () => JSON.parse(readFileSync(statePath(), "utf-8"));

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "gated-goal-test-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		ctx = {
			sessionManager: { getSessionId: () => "test-session" },
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

	it("a reviewer crash that lands AFTER exit stays dead: no phase write, no Back to ACT", async () => {
		seedState();
		const h = makeHarness(ctx);
		activate(h.pi as any);
		await h.fire("session_start");

		// Review cycle hangs until the test resolves it.
		let resolveReview!: (r: unknown) => void;
		runReview.mockImplementation(() => new Promise((res) => { resolveReview = res; }));

		h.eventHandlers.get(TODO_SETTLED_EVENT)!({ disposition: "review", ctx });
		await flush();
		expect(readState().phase).toBe("review");

		// User exits while the reviewer is in flight.
		await h.commands.get("gated-goal-exit")!.handler("", ctx);
		expect(readState().phase).toBe("idle");
		expect(readState().exitReason).toBe("aborted by user");
		expect(cancelActiveReviewer).toHaveBeenCalled();

		// The abandoned reviewer finally crashes — the stale continuation must
		// not resurrect the gate (the regression: phase flipped back to act and
		// "Back to ACT" was injected into the exited session).
		const sentAtExit = h.sent.length;
		resolveReview({ done: false, output: "", tampered: false, restored: false, status: "failed" });
		await flush();

		expect(readState().phase).toBe("idle");
		expect(readState().exitReason).toBe("aborted by user");
		expect(h.sent.length).toBe(sentAtExit);
		expect(h.sent.join("\n")).not.toContain("Back to ACT");
	});

	it("without an exit, the same crash still flips back to ACT (guard not over-eager)", async () => {
		seedState();
		const h = makeHarness(ctx);
		activate(h.pi as any);
		await h.fire("session_start");

		let resolveReview!: (r: unknown) => void;
		runReview.mockImplementation(() => new Promise((res) => { resolveReview = res; }));

		h.eventHandlers.get(TODO_SETTLED_EVENT)!({ disposition: "review", ctx });
		await flush();
		expect(readState().phase).toBe("review");

		resolveReview({ done: false, output: "", tampered: false, restored: false, status: "failed" });
		await flush();

		expect(readState().phase).toBe("act");
		expect(h.sent.some((t: string) => t.includes("Back to ACT"))).toBe(true);
	});

	it("a new gate started over an in-flight review severs the old continuation", async () => {
		seedState();
		const h = makeHarness(ctx);
		activate(h.pi as any);
		await h.fire("session_start");

		let resolveReview!: (r: unknown) => void;
		runReview.mockImplementation(() => new Promise((res) => { resolveReview = res; }));

		h.eventHandlers.get(TODO_SETTLED_EVENT)!({ disposition: "review", ctx });
		await flush();
		expect(readState().phase).toBe("review");

		// Start over with an explicit model arg (skips the picker); confirm resolves true.
		await h.commands.get("gated-goal")!.handler("3 test/other", ctx);
		expect(readState().phase).toBe("plan");
		expect(readState().reviewsCompleted).toBe(0);
		expect(cancelActiveReviewer).toHaveBeenCalled();

		const sentAtStart = h.sent.length;
		resolveReview({ done: false, output: "", tampered: false, restored: false, status: "timeout" });
		await flush();

		expect(readState().phase).toBe("plan");
		expect(h.sent.length).toBe(sentAtStart);
		expect(h.sent.join("\n")).not.toContain("Back to ACT");
	});

	it("a restart whose reviewer ping fails leaves the old gate idle, not stuck in review", async () => {
		seedState();
		const h = makeHarness(ctx);
		activate(h.pi as any);
		await h.fire("session_start");

		let resolveReview!: (r: unknown) => void;
		runReview.mockImplementation(() => new Promise((res) => { resolveReview = res; }));

		h.eventHandlers.get(TODO_SETTLED_EVENT)!({ disposition: "review", ctx });
		await flush();
		expect(readState().phase).toBe("review");

		// The user confirmed abort+restart, so the old gate dies at confirm time —
		// not only once the replacement reviewer proves reachable. Otherwise its
		// reviewer is already killed and its continuation discarded, while the
		// phase stays `review` with nothing left that can ever move it.
		pingReviewer.mockRejectedValueOnce(new Error("reviewer probe timeout"));
		const sentBefore = h.sent.length;
		await h.commands.get("gated-goal")!.handler("3 test/other", ctx);

		expect(cancelActiveReviewer).toHaveBeenCalled();
		expect(readState().phase).toBe("idle");
		expect(readState().exitReason).toBe("aborted by user");
		// No exit announcement: on success the restart supersedes it immediately,
		// and the extra follow-up would cost a wasted agent turn.
		expect(h.sent.length).toBe(sentBefore);

		// The killed reviewer's late non-verdict must not resurrect anything.
		resolveReview({ done: false, output: "", tampered: false, restored: false, status: "cancelled" });
		await flush();
		expect(readState().phase).toBe("idle");
	});

	it("preserves a terminal verdict reached while the restart dialog is open", async () => {
		seedState({ maxIteration: 1 });
		const h = makeHarness(ctx);
		activate(h.pi as any);
		await h.fire("session_start");

		let finish!: (result: unknown) => void;
		runReview.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		h.eventHandlers.get(TODO_SETTLED_EVENT)!({ disposition: "review", ctx });
		ctx.ui.confirm = async () => {
			finish({ done: false, output: "Needs edits", status: "done" });
			await flush();
			expect(readState().exitReason).toBe("max iteration reached");
			return true;
		};
		ctx.ui.notify = vi.fn();
		pingReviewer.mockRejectedValueOnce(new Error("offline"));
		await h.commands.get("gated-goal")!.handler("3 test/other", ctx);
		expect(readState().exitReason).toBe("max iteration reached");
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("was aborted as you confirmed"), "error");
	});

	it("heals a pre-epoch corrupt state file (exitReason next to a live phase) to idle", async () => {
		seedState({ phase: "act", exitReason: "aborted by user" });
		const h = makeHarness(ctx);
		activate(h.pi as any);
		await h.fire("session_start");

		const healed = readState();
		expect(healed.phase).toBe("idle");
		expect(healed.exitReason).toBe("aborted by user");
	});
});
