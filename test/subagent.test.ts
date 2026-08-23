import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Message } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import subagentExtension from "../extensions/subagent/index.ts";
import { createProcessTerminator, runChild } from "../extensions/subagent/runner.ts";
import { captureMessage, genId, getFinalOutput, markWaitDone, registry, Semaphore, type DispatchEntry } from "../extensions/subagent/scheduler.ts";
import { sanitizeNotificationField } from "../extensions/subagent/index.ts";

function entry(status: DispatchEntry["status"]): DispatchEntry {
	return {
		id: genId(),
		name: `test-${status}`,
		model: "test/model",
		provider: "test",
		task: "test task",
		permissionsLabel: "readonly",
		group: "test",
		startedAt: Date.now(),
		lastActivityAt: Date.now(),
		status,
		messages: [],
	};
}

function extensionHarness() {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
	const emitted: Array<{ name: string; data: any }> = [];
	const pi = {
		events: {
			emit(name: string, data: any) { emitted.push({ name, data }); },
		},
		on(name: string, handler: (event: unknown, ctx: any) => unknown) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerTool(definition: any) { tools.set(definition.name, definition); },
		registerCommand() {},
		sendUserMessage: vi.fn(),
	} as any;
	subagentExtension(pi);
	return { pi, tools, handlers, emitted };
}

function executionContext(model = { provider: "test", id: "model", name: "model" }) {
	return {
		cwd: process.cwd(),
		hasUI: false,
		ui: { notify: vi.fn() },
		scopedModels: [{ model }],
		modelRegistry: {
			getAvailable: () => [model],
			getAll: () => [model],
		},
	} as any;
}

afterEach(() => {
	for (const item of registry.all()) {
		if (item.name.startsWith("test-")) registry.remove(item.id);
	}
});

describe("subagent scheduler lifecycle", () => {
	it("cancels a queued semaphore waiter without consuming the next slot", async () => {
		const semaphore = new Semaphore(1);
		await semaphore.acquire();
		const controller = new AbortController();
		const waiting = semaphore.acquire(controller.signal);
		controller.abort();
		await expect(waiting).rejects.toMatchObject({ name: "AbortError" });

		semaphore.release();
		await expect(semaphore.acquire()).resolves.toBeUndefined();
		semaphore.release();
	});

	it("ignores release underflow instead of throwing into the host process", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const semaphore = new Semaphore(1);
		expect(semaphore.release()).toBe(false);
		expect(warn).toHaveBeenCalledOnce();
	});

	it("applies increased and decreased concurrency without restarting", async () => {
		const semaphore = new Semaphore(1);
		await semaphore.acquire();
		let secondAcquired = false;
		const second = semaphore.acquire().then(() => { secondAcquired = true; });
		await Promise.resolve();
		expect(secondAcquired).toBe(false);

		semaphore.setLimit(2);
		await second;
		expect(secondAcquired).toBe(true);

		semaphore.setLimit(1);
		let thirdAcquired = false;
		const third = semaphore.acquire().then(() => { thirdAcquired = true; });
		semaphore.release();
		await Promise.resolve();
		expect(thirdAcquired).toBe(false);
		semaphore.release();
		await third;
		expect(thirdAcquired).toBe(true);
		semaphore.release();
	});

	it("keeps hung children in the live cleanup set", () => {
		const item = entry("hung");
		registry.add(item);
		expect(registry.live()).toContain(item);
	});

	it("marks wait completion exactly once", () => {
		const item = entry("running");
		expect(markWaitDone(item)).toBe(true);
		expect(markWaitDone(item)).toBe(false);
	});
});

describe("subagent extension cancellation", () => {
	it("contains background listener failures and finalizes the dispatch", async () => {
		const { pi, tools, emitted } = extensionHarness();
		const unsubscribe = registry.subscribe(() => {
			const item = registry.all().find((candidate) => candidate.name === "test-iife-catch");
			if (item?.status === "running") throw new Error("panel render failed");
		});
		try {
			await tools.get("dispatch").execute("call", {
				task: "exercise the dispatch background rejection boundary safely",
				timeout: 1,
				permissions: [],
				model: "test/model",
				name: "test-iife-catch",
			}, undefined, undefined, executionContext());

			await vi.waitFor(() => {
				const item = registry.all().find((candidate) => candidate.name === "test-iife-catch");
				expect(item).toMatchObject({ status: "failed", errorMessage: "panel render failed" });
				expect(emitted.filter((event) => event.name === "wait:done" && event.data.id === item?.id)).toHaveLength(1);
				expect(pi.sendUserMessage).toHaveBeenCalledOnce();
			});
		} finally {
			unsubscribe();
		}
	});

	it("does not rewrite an already completed entry as cancelled", async () => {
		const { tools } = extensionHarness();
		const item = entry("done");
		registry.add(item);

		const result = await tools.get("dispatch_cancel").execute("call", { id: item.id });

		expect(item.status).toBe("done");
		expect(result.content[0].text).toContain("already done");
	});

	it("times out a queued dispatch, finishes its wait, and reports the failure", async () => {
		vi.useFakeTimers();
		const { pi, tools, emitted } = extensionHarness();
		const ctx = executionContext();
		const cfg = {
			defaults: { timeoutSec: 600, hungThresholdSec: 120, defaultResourceGroup: "default", retainCompletedSec: 1800, maxCapturedMessages: 1000 },
			resourceGroups: { default: { concurrency: 4 } },
			providerGroups: {},
			roles: {},
		};
		const semaphore = registry.semaphoreFor(cfg, "default");
		await Promise.all([semaphore.acquire(), semaphore.acquire(), semaphore.acquire(), semaphore.acquire()]);
		try {
			await tools.get("dispatch").execute("call", {
				task: "test queued timeout while all resource slots remain occupied",
				timeout: 1,
				permissions: [],
				model: "test/model",
				name: "test-queue-timeout",
			}, undefined, undefined, ctx);
			await vi.advanceTimersByTimeAsync(1000);

			const item = registry.all().find((candidate) => candidate.name === "test-queue-timeout");
			expect(item).toMatchObject({ status: "timeout", stopReason: "queue_timeout" });
			expect(item?.errorMessage).toContain("timed out waiting 1s");
			expect(emitted.filter((event) => event.name === "wait:active" && event.data.id === item?.id)).toHaveLength(1);
			expect(emitted.filter((event) => event.name === "wait:done" && event.data.id === item?.id)).toHaveLength(1);
			expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
			expect(pi.sendUserMessage.mock.calls[0]?.[0]).toContain("timed out waiting 1s");
		} finally {
			semaphore.release();
			semaphore.release();
			semaphore.release();
			semaphore.release();
			vi.useRealTimers();
		}
	});

	it("cancels a hung entry and emits wait:done once", async () => {
		const { tools, emitted } = extensionHarness();
		const item = entry("hung");
		item.abort = vi.fn();
		item.kill = vi.fn();
		registry.add(item);

		await tools.get("dispatch_cancel").execute("call", { id: item.id });
		await tools.get("dispatch_cancel").execute("call", { id: item.id });

		expect(item.status).toBe("cancelled");
		expect(item.abort).toHaveBeenCalledTimes(1);
		expect(item.kill).toHaveBeenCalledTimes(1);
		expect(emitted.filter((event) => event.name === "wait:done" && event.data.id === item.id)).toHaveLength(1);
	});

	it("shutdown cancels hung children instead of orphaning them", async () => {
		const { handlers, emitted } = extensionHarness();
		const item = entry("hung");
		item.abort = vi.fn();
		item.kill = vi.fn();
		registry.add(item);

		for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, {});

		expect(item.status).toBe("cancelled");
		expect(item.abort).toHaveBeenCalledTimes(1);
		expect(item.kill).toHaveBeenCalledTimes(1);
		expect(emitted.filter((event) => event.name === "wait:done" && event.data.id === item.id)).toHaveLength(1);
	});
});

describe("subagent process termination", () => {
	it("preserves the spawn error when the child executable is unavailable", async () => {
		const item = entry("running");
		registry.add(item);
		const previousArgv1 = process.argv[1];
		const previousPath = process.env.PATH;
		process.argv[1] = "/definitely-not-a-pi-script";
		process.env.PATH = "";
		try {
			await runChild({
				pi: {} as any,
				ctx: { cwd: process.cwd() } as any,
				entry: item,
				modelArg: "test/model",
				permissions: [],
				timeoutSec: 1,
			});
		} finally {
			process.argv[1] = previousArgv1;
			process.env.PATH = previousPath;
		}

		expect(item.status).toBe("failed");
		expect(item.errorMessage).toMatch(/failed to spawn subagent:.*ENOENT/i);
	});

	it("settles a spawned child after a signalling error without overwriting an earlier error", async () => {
		const item = entry("running");
		registry.add(item);
		const controller = new AbortController();
		const child = new EventEmitter() as any;
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.kill = vi.fn(() => {
			child.emit("error", Object.assign(new Error("operation not permitted"), { code: "EPERM" }));
			return false;
		});
		const spawnProcess = vi.fn(() => {
			queueMicrotask(() => child.emit("spawn"));
			return child;
		});

		const running = runChild({
			pi: {} as any,
			ctx: { cwd: process.cwd() } as any,
			entry: item,
			modelArg: "test/model",
			permissions: [],
			timeoutSec: 60,
			signal: controller.signal,
			spawnProcess: spawnProcess as any,
		});
		await new Promise<void>((resolve) => child.once("spawn", resolve));
		item.errorMessage = "original provider failure";
		controller.abort();
		await running;

		expect(item.errorMessage).toBe("original provider failure");
		expect(item.status).toBe("cancelled");
		expect(item.kill).toBeUndefined();
		// Promise settlement is idempotent if Node later emits close after error.
		child.emit("close", null, "SIGTERM");
	});

	it("escalates from SIGTERM to SIGKILL when the process remains open", () => {
		vi.useFakeTimers();
		const kill = vi.fn(() => true);
		const terminator = createProcessTerminator({ kill } as any, 50);

		terminator.terminate();
		expect(kill).toHaveBeenCalledWith("SIGTERM");
		vi.advanceTimersByTime(50);
		expect(kill).toHaveBeenCalledWith("SIGKILL");
		vi.useRealTimers();
	});

	it("does not escalate after the process closes", () => {
		vi.useFakeTimers();
		const kill = vi.fn(() => true);
		const terminator = createProcessTerminator({ kill } as any, 50);

		terminator.terminate();
		terminator.markClosed();
		vi.advanceTimersByTime(50);
		expect(kill).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});
});

describe("subagent notifications", () => {
	it("removes OSC delimiters and control bytes without changing ordinary Unicode", () => {
		expect(sanitizeNotificationField("任务;line\u0007next\u001b]777")).toBe("任务,line next ]777");
	});
});

describe("subagent output extraction", () => {
	it("preserves every text block from the final assistant message", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "first" },
					{ type: "thinking", thinking: "hidden" },
					{ type: "text", text: "second" },
				],
			},
		] as unknown as Message[];
		expect(getFinalOutput(messages)).toBe("first\nsecond");
	});

	it("bounds captured records while retaining the latest assistant text separately", () => {
		const item = entry("running");
		captureMessage(item, { role: "assistant", content: [{ type: "text", text: "answer" }] } as Message, 2);
		captureMessage(item, { role: "toolResult", toolCallId: "one", toolName: "read", content: [{ type: "text", text: "one" }] } as Message, 2);
		captureMessage(item, { role: "toolResult", toolCallId: "two", toolName: "read", content: [{ type: "text", text: "two" }] } as Message, 2);

		expect(item.messages).toHaveLength(2);
		expect(item.finalOutput).toBe("answer");
	});

	it("falls back past a final assistant message containing only a tool call", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "the real answer" }] },
			{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "result" }] },
			{ role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "read", arguments: {} }] },
		] as unknown as Message[];
		expect(getFinalOutput(messages)).toBe("the real answer");
	});
});
