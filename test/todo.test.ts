import { describe, expect, it } from "vitest";
import { chooseWidgetWindow, widgetLines } from "../extensions/todo/index.ts";
import { panelInput, windowRange } from "../extensions/todo/panel.ts";
import type { Todo } from "../extensions/todo/snapshot.ts";

const mk = (n: number, doneIds: number[] = []): Todo[] =>
	Array.from({ length: n }, (_, i) => ({
		id: i + 1,
		text: `task ${i + 1}`,
		status: doneIds.includes(i + 1) ? "done" : "todo",
	}));

const clean = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const idsOf = (lines: string[]): number[] =>
	lines.slice(1, -1).map((l) => parseInt(clean(l).match(/#(\d+)/)![1], 10));

describe("chooseWidgetWindow", () => {
	it("keeps everything when the list fits", () => {
		const w = chooseWidgetWindow(
			[
				{ id: 1, text: "a", status: "todo" },
				{ id: 2, text: "b", status: "done" },
				{ id: 3, text: "c", status: "pending" },
			],
			3,
		);
		expect(w.visible.map((t) => t.id)).toEqual([1, 2, 3]);
		expect(w.hiddenDone).toBe(0);
		expect(w.hiddenEarlier).toBe(0);
	});

	it("folds done items before earliest incomplete ones", () => {
		// 10 items, done = 1,4,7 → incomplete = 2,3,5,6,8,9,10 (7 items).
		// Budget 6: drop all 3 done first, then the earliest incomplete (#2).
		const w = chooseWidgetWindow(mk(10, [1, 4, 7]), 6);
		expect(w.visible.map((t) => t.id)).toEqual([3, 5, 6, 8, 9, 10]);
		expect(w.hiddenDone).toBe(3);
		expect(w.hiddenEarlier).toBe(1);
	});

	it("keeps original order among survivors", () => {
		const w = chooseWidgetWindow(mk(10, [1, 4, 7]), 8);
		const ids = w.visible.map((t) => t.id);
		expect([...ids].sort((a, b) => a - b)).toEqual(ids);
	});

	it("keeps the latest done items when only done remains", () => {
		const w = chooseWidgetWindow(mk(12, Array.from({ length: 12 }, (_, i) => i + 1)), 8);
		expect(w.visible.map((t) => t.id)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
		expect(w.hiddenDone).toBe(4);
		expect(w.hiddenEarlier).toBe(0);
	});

	it("handles a zero keep-done budget without leaking items (slice(-0) trap)", () => {
		// 20 done + 20 incomplete, budget 8 → keepDone must be exactly 0,
		// not the whole done slice.
		const w = chooseWidgetWindow(mk(40, Array.from({ length: 20 }, (_, i) => i + 1)), 8);
		expect(w.visible.map((t) => t.id)).toEqual([33, 34, 35, 36, 37, 38, 39, 40]);
		expect(w.hiddenDone).toBe(20);
		expect(w.hiddenEarlier).toBe(12);
	});
});

describe("widgetLines", () => {
	it("renders short lists whole with no fold summary", () => {
		const lines = widgetLines(mk(5, [2]));
		expect(lines).toHaveLength(6);
		expect(lines[0]).toBe("Todos (1/5)");
		expect(lines.some((l) => clean(l).includes("hidden"))).toBe(false);
	});

	it("fits exactly 9 items at the cap", () => {
		const lines = widgetLines(mk(9));
		expect(lines).toHaveLength(10);
		expect(lines.some((l) => clean(l).includes("hidden"))).toBe(false);
	});

	it("never exceeds pi's 10-line widget cap, whatever the list", () => {
		for (let n = 0; n <= 60; n++) {
			for (let d = 0; d <= n; d++) {
				const lines = widgetLines(mk(n, Array.from({ length: d }, (_, i) => (i % Math.max(1, n)) + 1)));
				expect(lines.length, `n=${n} d=${d}`).toBeLessThanOrEqual(10);
			}
		}
	});

	it("folds done first, then earliest, with a summary pointing at /todos", () => {
		const lines = widgetLines(mk(12, [1, 2, 3]));
		expect(lines).toHaveLength(10);
		// incomplete = 4..12 (9 items) → keep latest 8, drop #4
		expect(idsOf(lines)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
		const summary = clean(lines[lines.length - 1]);
		expect(summary).toContain("3 done");
		expect(summary).toContain("1 earlier");
		expect(summary).toContain("/todos for all");
	});

	it("empty list renders just the header", () => {
		expect(widgetLines([])).toEqual(["Todos (0/0)"]);
	});
});

describe("panelInput", () => {
	it("decodes navigation keys", () => {
		expect(panelInput("\x1b[A")).toEqual({ type: "move", delta: -1 });
		expect(panelInput("\x1b[B")).toEqual({ type: "move", delta: 1 });
		expect(panelInput("k")).toEqual({ type: "move", delta: -1 });
		expect(panelInput("j")).toEqual({ type: "move", delta: 1 });
		expect(panelInput("\x1b[5~")).toEqual({ type: "page", delta: -1 });
		expect(panelInput("\x1b[6~")).toEqual({ type: "page", delta: 1 });
		expect(panelInput("\x1b[H")).toEqual({ type: "home" });
		expect(panelInput("\x1b[F")).toEqual({ type: "end" });
	});

	it("closes on esc, q, ctrl+c, and enter", () => {
		for (const key of ["\x1b", "q", "Q", "\r", "\n"]) {
			expect(panelInput(key)).toEqual({ type: "close" });
		}
	});

	it("ignores unrelated keys", () => {
		expect(panelInput("x")).toEqual({ type: "none" });
	});
});

describe("panel windowRange", () => {
	it("clamps at both ends and centers the cursor", () => {
		expect(windowRange(0, 20, 8)).toEqual({ start: 0, end: 8 });
		expect(windowRange(19, 20, 8)).toEqual({ start: 12, end: 20 });
		expect(windowRange(10, 20, 8)).toEqual({ start: 6, end: 14 });
	});

	it("handles empty and short lists", () => {
		expect(windowRange(0, 0, 8)).toEqual({ start: 0, end: 0 });
		expect(windowRange(3, 5, 8)).toEqual({ start: 0, end: 5 });
	});
});
