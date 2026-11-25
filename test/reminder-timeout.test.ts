import { describe, expect, it } from "vitest";
import { effectiveTimeoutMs } from "../extensions/reminder-hook/index.ts";

const MIN = 60_000;

describe("reminder hard cap", () => {
	it("defaults a condition reminder to a 120-minute cap instead of waiting forever", () => {
		expect(effectiveTimeoutMs(undefined)).toBe(120 * MIN);
	});

	it("honours an explicit cap", () => {
		expect(effectiveTimeoutMs(5)).toBe(5 * MIN);
		expect(effectiveTimeoutMs(1440)).toBe(1440 * MIN);
	});

	it("falls back to the default for a non-positive or non-finite value rather than leaving no cap", () => {
		expect(effectiveTimeoutMs(0)).toBe(120 * MIN);
		expect(effectiveTimeoutMs(-3)).toBe(120 * MIN);
		expect(effectiveTimeoutMs(Number.NaN)).toBe(120 * MIN);
		expect(effectiveTimeoutMs(Number.POSITIVE_INFINITY)).toBe(120 * MIN);
	});
});
