import { describe, expect, it } from "vitest";
import { normalize as normalizeConfig } from "../extensions/subagent/config.ts";
import { buildReviewerSystemPrompt, WRAP_UP_LEAD_SEC } from "../extensions/gated-goal/reviewer.ts";

describe("subagent config: gatedGoal section", () => {
	it("falls back to defaults when the section is missing", () => {
		expect(normalizeConfig({}).gatedGoal).toEqual({ reviewTimeoutSec: 1800, pingTimeoutSec: 45 });
	});

	it("reads user values", () => {
		const cfg = normalizeConfig({ gatedGoal: { reviewTimeoutSec: 2400, pingTimeoutSec: 120 } });
		expect(cfg.gatedGoal).toEqual({ reviewTimeoutSec: 2400, pingTimeoutSec: 120 });
	});

	it("falls back on invalid values", () => {
		const cfg = normalizeConfig({ gatedGoal: { reviewTimeoutSec: "abc", pingTimeoutSec: 0 } });
		expect(cfg.gatedGoal).toEqual({ reviewTimeoutSec: 1800, pingTimeoutSec: 45 });
	});

	it("falls back when flooring to zero", () => {
		const cfg = normalizeConfig({ gatedGoal: { reviewTimeoutSec: 0.5, pingTimeoutSec: 0.9 } });
		expect(cfg.gatedGoal).toEqual({ reviewTimeoutSec: 1800, pingTimeoutSec: 45 });
	});

	it("rejects booleans (Number(true) === 1)", () => {
		const cfg = normalizeConfig({ gatedGoal: { reviewTimeoutSec: true, pingTimeoutSec: false } });
		expect(cfg.gatedGoal).toEqual({ reviewTimeoutSec: 1800, pingTimeoutSec: 45 });
	});

	it("accepts numeric strings like the defaults section does", () => {
		const cfg = normalizeConfig({ gatedGoal: { reviewTimeoutSec: "2400", pingTimeoutSec: "60" } });
		expect(cfg.gatedGoal).toEqual({ reviewTimeoutSec: 2400, pingTimeoutSec: 60 });
	});

	it("floors fractional values", () => {
		const cfg = normalizeConfig({ gatedGoal: { reviewTimeoutSec: 1800.7, pingTimeoutSec: 45.9 } });
		expect(cfg.gatedGoal).toEqual({ reviewTimeoutSec: 1800, pingTimeoutSec: 45 });
	});
});

describe("reviewer system prompt", () => {
	// Fixed spawn clock so the deadline is deterministic.
	const nowMs = Date.UTC(2026, 0, 15, 10, 0, 0);

	it("embeds the time budget, the hard deadline, and the self-check method", () => {
		const p = buildReviewerSystemPrompt("PLAN", { timeoutSec: 1800, nowMs });
		expect(p).toContain("your review window is 30 minutes");
		expect(p).toContain("hard-killed at 2026-01-15 10:30:00 UTC");
		expect(p).toContain(`unix time ${Math.floor(nowMs / 1000) + 1800}`);
		expect(p).toContain("`date +%s`");
	});

	it("demands a review plan before execution", () => {
		expect(buildReviewerSystemPrompt("PLAN", { timeoutSec: 1800, nowMs })).toContain("begin by outputting a short review plan");
	});

	it("states the wrap-up rule with the clamped threshold", () => {
		const p = buildReviewerSystemPrompt("PLAN", { timeoutSec: 1800, nowMs });
		expect(p).toContain(`fewer than ${WRAP_UP_LEAD_SEC} seconds remain`);
		expect(p).toContain("A killed review is never a verdict");
	});

	it("formats non-whole-minute budgets in seconds", () => {
		expect(buildReviewerSystemPrompt("PLAN", { timeoutSec: 90, nowMs })).toContain("your review window is 90 seconds");
	});

	it("embeds the frozen plan verbatim between the markers", () => {
		const p = buildReviewerSystemPrompt("## Outcome\nDo the thing", { timeoutSec: 1800, nowMs });
		expect(p).toContain("--- FROZEN PLAN (immutable) ---\n## Outcome\nDo the thing\n--- END FROZEN PLAN ---");
	});
});

describe("wrap-up lead", () => {
	it("is the frozen 300-second contract", () => {
		expect(WRAP_UP_LEAD_SEC).toBe(300);
	});
});
