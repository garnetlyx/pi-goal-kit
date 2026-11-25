import { describe, expect, it } from "vitest";
import { TODO_STATE_ENTRY, TODO_SETTLED_EVENT, type TodoSettledEvent } from "../extensions/todo/snapshot.ts";
import { makeHarness, type Ctx } from "./harness.ts";

const { default: activate } = await import("../extensions/todo/index.ts");

/** ctx whose branch contains one stored todo snapshot (that is where todo keeps its list). */
function ctxWith(todos: { id: number; text: string; status: "todo" | "pending" | "done" }[]): Ctx {
	const entry = { type: "custom", customType: TODO_STATE_ENTRY, data: { todos, nextId: todos.length + 1 } };
	return {
		sessionManager: { getSessionId: () => "s", getBranch: () => [entry] },
		cwd: "/tmp/project",
		hasUI: false,
		ui: { notify: () => {}, setWidget: () => {} },
	};
}

async function settleWith(ctx: Ctx, waits: { active: string[]; done?: string[] }) {
	const h = makeHarness(ctx);
	activate(h.pi as any);
	await h.fire("session_start");
	const seen: TodoSettledEvent[] = [];
	h.pi.events.on(TODO_SETTLED_EVENT, (d: unknown) => seen.push(d as TodoSettledEvent));
	for (const id of waits.active) h.pi.events.emit("wait:active", { source: "reminder-hook", id });
	for (const id of waits.done ?? []) h.pi.events.emit("wait:done", { source: "reminder-hook", id });
	await h.fire("agent_settled");
	return { disposition: seen[0]?.disposition, sent: h.sent };
}

describe("settle disposition: an active wait outranks a finished list", () => {
	it("all todos done but a reminder is pending → wait, no review, no message", async () => {
		const r = await settleWith(ctxWith([{ id: 1, text: "a", status: "done" }]), { active: ["r_1"] });
		expect(r.disposition).toBe("wait");
		expect(r.sent).toHaveLength(0);
	});

	it("an empty list with a subagent in flight → wait", async () => {
		const r = await settleWith(ctxWith([]), { active: ["d_1"] });
		expect(r.disposition).toBe("wait");
	});

	it("once the wait ends, the same finished list → review", async () => {
		const r = await settleWith(ctxWith([{ id: 1, text: "a", status: "done" }]), { active: ["r_1"], done: ["r_1"] });
		expect(r.disposition).toBe("review");
	});

	it("incomplete work with a wait still → wait (unchanged)", async () => {
		const r = await settleWith(ctxWith([{ id: 1, text: "a", status: "todo" }]), { active: ["d_9"] });
		expect(r.disposition).toBe("wait");
		expect(r.sent).toHaveLength(0);
	});

	it("without any wait a finished list still → review", async () => {
		const r = await settleWith(ctxWith([{ id: 1, text: "a", status: "done" }]), { active: [] });
		expect(r.disposition).toBe("review");
	});

	it("each wait source counts independently: one ending does not clear another", async () => {
		const r = await settleWith(ctxWith([{ id: 1, text: "a", status: "done" }]), { active: ["r_1", "d_1"], done: ["r_1"] });
		expect(r.disposition).toBe("wait");
	});
});
