import { describe, expect, it } from "vitest";
import { TODO_NUDGE_RESET_EVENT, TODO_SETTLED_EVENT, TODO_STATE_ENTRY, type TodoSettledEvent, type TodoStatus } from "../extensions/todo/snapshot.ts";
import { makeHarness, type Ctx } from "./harness.ts";

const { default: activate } = await import("../extensions/todo/index.ts");

type Item = { id: number; text: string; status: TodoStatus };

/** ctx whose branch contains one stored todo snapshot (that is where todo keeps its list). */
function ctxWith(todos: Item[]): Ctx {
	const entry = { type: "custom", customType: TODO_STATE_ENTRY, data: { todos, nextId: todos.length + 1 } };
	return {
		sessionManager: { getSessionId: () => "s", getBranch: () => [entry] },
		cwd: "/tmp/project",
		hasUI: false,
		ui: { notify: () => {}, setWidget: () => {} },
	};
}

async function rig(todos: Item[]) {
	const h = makeHarness(ctxWith(todos));
	activate(h.pi as any);
	await h.fire("session_start");
	const dispositions: TodoSettledEvent["disposition"][] = [];
	h.pi.events.on(TODO_SETTLED_EVENT, (d: unknown) => dispositions.push((d as TodoSettledEvent).disposition));
	const settle = () => h.fire("agent_settled");
	return { h, dispositions, settle };
}

const open = (n: number): Item[] => Array.from({ length: n }, (_, i) => ({ id: i + 1, text: `task ${i + 1}`, status: "todo" }));

describe("todo:nudge-reset", () => {
	it("an unchanged incomplete list is nudged once, then goes to review — until a workflow re-arms the nudge", async () => {
		const { h, dispositions, settle } = await rig(open(2));

		await settle();
		expect(dispositions).toEqual(["continue"]);
		expect(h.sent).toHaveLength(1);

		// The agent stopped again without touching the list: de-duplicated.
		await settle();
		expect(dispositions).toEqual(["continue", "review"]);
		expect(h.sent).toHaveLength(1);

		h.pi.events.emit(TODO_NUDGE_RESET_EVENT, { source: "gated-goal" });

		// New iteration: the same untouched list is worth one more nudge…
		await settle();
		expect(dispositions).toEqual(["continue", "review", "continue"]);
		expect(h.sent).toHaveLength(2);
		// …and only one: the next unchanged stop goes to review again.
		await settle();
		expect(dispositions.at(-1)).toBe("review");
		expect(h.sent).toHaveLength(2);
	});

	it("the re-armed nudge is the standard one and lists the incomplete items", async () => {
		const { h, settle } = await rig(open(3));
		await settle();
		await settle();
		h.pi.events.emit(TODO_NUDGE_RESET_EVENT, { source: "gated-goal" });
		await settle();
		const again = h.sent[1];
		expect(again).toContain("3 todo(s) still incomplete");
		for (const item of open(3)) expect(again).toContain(`#${item.id} ${item.text}`);
	});

	it("re-arming never nudges a finished list", async () => {
		const { h, dispositions, settle } = await rig([{ id: 1, text: "a", status: "done" }]);
		h.pi.events.emit(TODO_NUDGE_RESET_EVENT, { source: "gated-goal" });
		await settle();
		expect(dispositions).toEqual(["review"]);
		expect(h.sent).toHaveLength(0);
	});

	it("re-arming with an active wait still reports wait, never a nudge", async () => {
		const { h, dispositions, settle } = await rig(open(1));
		h.pi.events.emit("wait:active", { source: "subagent", id: "d_1" });
		h.pi.events.emit(TODO_NUDGE_RESET_EVENT, { source: "gated-goal" });
		await settle();
		expect(dispositions).toEqual(["wait"]);
		expect(h.sent).toHaveLength(0);
	});
});
