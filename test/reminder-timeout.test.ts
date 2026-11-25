import { describe, expect, it } from "vitest";
import { normalizeReminderConfig } from "../extensions/reminder-hook/config.ts";
import { effectiveTimeoutMs } from "../extensions/reminder-hook/index.ts";

const MIN = 60_000;

describe("reminder hard cap: configuration", () => {
	it("ships a 120-minute default when reminder-hook.json omits or omits the key", () => {
		expect(normalizeReminderConfig({}).defaultTimeoutMinutes).toBe(120);
		expect(normalizeReminderConfig(undefined).defaultTimeoutMinutes).toBe(120);
		expect(normalizeReminderConfig({ otherSetting: 1 }).defaultTimeoutMinutes).toBe(120);
	});

	it("takes the configured value", () => {
		expect(normalizeReminderConfig({ defaultTimeoutMinutes: 30 }).defaultTimeoutMinutes).toBe(30);
		expect(normalizeReminderConfig({ defaultTimeoutMinutes: 1440 }).defaultTimeoutMinutes).toBe(1440);
	});

	it("ignores a value that would remove the cap", () => {
		for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "60", null, true]) {
			expect(normalizeReminderConfig({ defaultTimeoutMinutes: bad as any }).defaultTimeoutMinutes).toBe(120);
		}
	});
});

describe("reminder hard cap: per-call override", () => {
	it("uses the caller's timeout_minutes when given", () => {
		expect(effectiveTimeoutMs(5, 120)).toBe(5 * MIN);
	});

	it("falls back to the configured default, not a constant", () => {
		expect(effectiveTimeoutMs(undefined, 45)).toBe(45 * MIN);
		expect(effectiveTimeoutMs(undefined, 120)).toBe(120 * MIN);
	});

	it("treats a non-positive or non-finite override as absent", () => {
		for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(effectiveTimeoutMs(bad, 45)).toBe(45 * MIN);
		}
	});
});
