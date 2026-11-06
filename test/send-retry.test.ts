import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	COMPACTION_BUSY_SNIPPET,
	SEND_RETRY_MAX_ATTEMPTS,
	sendFollowUpWithCompactionRetry as retryReminderHook,
} from "../extensions/reminder-hook/index.ts";
import { sendFollowUpWithCompactionRetry as retrySubagent } from "../extensions/subagent/index.ts";

// Both extensions carry an identical copy (they install flat and cannot import
// across dirs), so the same scenarios run against each copy.
describe.each([
	["reminder-hook", retryReminderHook],
	["subagent", retrySubagent],
])("sendFollowUpWithCompactionRetry (%s)", (_name, retry) => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function fakePi(failTimes: number | "always") {
		const calls: string[] = [];
		const sendUserMessage = vi.fn(async (text: string) => {
			calls.push(text);
			if (failTimes === "always" || calls.length <= failTimes) {
				throw new Error(
					`${COMPACTION_BUSY_SNIPPET}. Wait for compaction to finish and retry.`,
				);
			}
		});
		return { pi: { sendUserMessage } as unknown as ExtensionAPI, sendUserMessage, calls };
	}

	it("delivers through transient compaction-busy errors exactly once", async () => {
		vi.useFakeTimers();
		const { pi, sendUserMessage, calls } = fakePi(2);
		const pending = retry(pi, "resume text");
		await vi.advanceTimersByTimeAsync(20_000);
		await vi.advanceTimersByTimeAsync(20_000);
		await pending;
		expect(sendUserMessage).toHaveBeenCalledTimes(3);
		expect(calls.every((text) => text === "resume text")).toBe(true);
	});

	it("rethrows unrelated errors without retrying", async () => {
		const { pi, sendUserMessage } = fakePi(0);
		vi.mocked(pi.sendUserMessage).mockRejectedValueOnce(new Error("boom"));
		await expect(retry(pi, "resume text")).rejects.toThrow("boom");
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
	});

	it("gives up after max attempts when compaction never ends", async () => {
		vi.useFakeTimers();
		const { pi, sendUserMessage } = fakePi("always");
		// Attach the rejection handler before advancing time, otherwise vitest
		// flags the unhandled rejection window as an unhandled error.
		const pending = expect(retry(pi, "resume text")).rejects.toThrow(COMPACTION_BUSY_SNIPPET);
		for (let i = 0; i < SEND_RETRY_MAX_ATTEMPTS - 1; i++) {
			await vi.advanceTimersByTimeAsync(20_000);
		}
		await pending;
		expect(sendUserMessage).toHaveBeenCalledTimes(SEND_RETRY_MAX_ATTEMPTS);
	});
});
