import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { extensionHarness, executionContext, useAgentConfig, type TestModel } from "./harness.ts";
import {
	buildSubagentInstruction,
	catalogueModels,
	modelCompletionItems,
	parseSubagentRequest,
} from "../extensions/subagent/command.ts";
import { clearModelOverride, pendingModelOverride } from "../extensions/subagent/override.ts";
import { registry } from "../extensions/subagent/scheduler.ts";
import { normalize as normalizeConfig } from "../extensions/subagent/config.ts";

// A host pi child process (e.g. the gated-goal reviewer) runs the suite with
// PI_SUBAGENT_CHILD=1, which makes the extension a no-op at registration time.
const savedChildFlag = process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_SUBAGENT_CHILD;
afterAll(() => {
	if (savedChildFlag === undefined) delete process.env.PI_SUBAGENT_CHILD;
	else process.env.PI_SUBAGENT_CHILD = savedChildFlag;
});

const FABLE: TestModel = { provider: "local-m4m-proxy", id: "claude-fable-5.1", name: "Claude Fable 5.1" };
const GLM: TestModel = { provider: "local-m3u-deployed", id: "GLM-5.3-Flash-MLX-Serve-iQ-MLX", name: "GLM-5.3-Flash" };
const GPT: TestModel = { provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" };

/** Registry double: the full catalogue plus a narrower auth-ready subset. */
function registryWith(all: TestModel[], available: TestModel[] = all) {
	return { getAll: () => all, getAvailable: () => available } as any;
}

afterEach(() => {
	clearModelOverride();
	for (const item of registry.all()) {
		if (item.name.startsWith("test-")) registry.remove(item.id);
	}
});

describe("/subagent model completion", () => {
	it("completes connected models only, not the unconfigured preset catalogue", () => {
		const items = modelCompletionItems(registryWith([FABLE, GLM, GPT], [FABLE, GLM]), "");
		expect(items?.map((item) => item.label)).toEqual([FABLE.id, GLM.id]);
	});

	it("fuzzy-matches a partial model id", () => {
		const items = modelCompletionItems(registryWith([FABLE, GLM, GPT]), "fabl");
		expect(items).toHaveLength(1);
		expect(items?.[0].label).toBe(FABLE.id);
		expect(items?.[0].description).toBe(FABLE.provider);
	});

	it("inserts the exact provider/id target followed by a space", () => {
		const items = modelCompletionItems(registryWith([FABLE, GLM]), "fabl");
		expect(items?.[0].value).toBe("local-m4m-proxy/claude-fable-5.1 ");
		expect(items?.[0].value.trim()).toBe("local-m4m-proxy/claude-fable-5.1");
		expect(items?.[0].label).toBe("claude-fable-5.1");
	});

	it("stops completing once the prompt started", () => {
		const registryDouble = registryWith([FABLE, GLM]);
		expect(modelCompletionItems(registryDouble, "local-m4m-proxy/claude-fable-5.1 ")).toBeNull();
		expect(modelCompletionItems(registryDouble, "claude-fable-5.1 review the diff")).toBeNull();
	});

	it("returns nothing without a registry", () => {
		expect(modelCompletionItems(undefined, "fabl")).toBeNull();
	});

	it("reaches the session registry through the registered command", async () => {
		const { commands, handlers } = extensionHarness();
		const ctx = executionContext([FABLE, GLM]);
		for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
		try {
			const items = commands.get("subagent").getArgumentCompletions("fabl") as AutocompleteItem[] | null;
			expect(items?.map((item) => item.label)).toEqual([FABLE.id]);
		} finally {
			for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
		}
	});
});

describe("/subagent argument parsing", () => {
	const models = catalogueModels(registryWith([FABLE, GLM]));

	it("splits the model from the prompt", () => {
		const parsed = parseSubagentRequest("local-m4m-proxy/claude-fable-5.1 review the diff", models);
		expect(parsed).toEqual({ ok: true, request: { model: "local-m4m-proxy/claude-fable-5.1", prompt: "review the diff" } });
	});

	it("resolves a bare model id", () => {
		const parsed = parseSubagentRequest("claude-fable-5.1 review the diff", models);
		expect(parsed).toEqual({ ok: true, request: { model: "local-m4m-proxy/claude-fable-5.1", prompt: "review the diff" } });
	});

	it("reports an ambiguous bare model id with its candidates", () => {
		const ambiguous = catalogueModels(registryWith([FABLE, { ...FABLE, provider: "other" }]));
		const parsed = parseSubagentRequest("claude-fable-5.1 review the diff", ambiguous);
		expect(parsed.ok).toBe(false);
		expect(parsed.ok ? "" : parsed.error).toContain("ambiguous");
		expect(parsed.ok ? "" : parsed.error).toContain("other/claude-fable-5.1");
	});

	it("reports a model that is not in the registry", () => {
		const parsed = parseSubagentRequest("openai/gpt-9 review the diff", models);
		expect(parsed.ok).toBe(false);
		expect(parsed.ok ? "" : parsed.error).toContain("not in the session model registry");
	});

	it("reports a missing model and a missing prompt", () => {
		expect(parseSubagentRequest("", models).ok).toBe(false);
		const missingPrompt = parseSubagentRequest("local-m4m-proxy/claude-fable-5.1", models);
		expect(missingPrompt.ok).toBe(false);
		expect(missingPrompt.ok ? "" : missingPrompt.error).toContain("Missing prompt");
	});
});

describe("/subagent command handler", () => {
	it("reports errors and sends nothing to the agent", async () => {
		const { commands, pi } = extensionHarness();
		const command = commands.get("subagent");
		const ctx = executionContext([FABLE, GLM]);

		await command.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /subagent"), "error");

		await command.handler("openai/gpt-9 do something", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("not in the session model registry"), "error");

		await command.handler("local-m4m-proxy/claude-fable-5.1", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Missing prompt"), "error");

		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		expect(pendingModelOverride()).toBeNull();
	});

	it("hands the request to the agent and grants the one-time override", async () => {
		const { commands, pi } = extensionHarness();
		const ctx = executionContext([FABLE, GLM]);

		await commands.get("subagent").handler("local-m4m-proxy/claude-fable-5.1 review the diff", ctx);

		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		const message = String(pi.sendUserMessage.mock.calls[0][0]);
		expect(message).toContain("local-m4m-proxy/claude-fable-5.1");
		expect(message).toContain("review the diff");
		expect(pendingModelOverride()).toBe("local-m4m-proxy/claude-fable-5.1");
	});

	it("keeps the user's prompt verbatim in the instruction", () => {
		const prompt = "review  the   diff\nand report file:line";
		expect(buildSubagentInstruction("p/m", prompt)).toContain(prompt);
	});
});

describe("/subagent blacklist override", () => {
	/** Occupy every slot of the default resource group so a dispatched child
	 *  never starts — the test only cares about the blacklist gate. */
	async function withBlockedGroup(run: () => Promise<void>): Promise<void> {
		const semaphore = registry.semaphoreFor(normalizeConfig({}), "default");
		await Promise.all([semaphore.acquire(), semaphore.acquire(), semaphore.acquire(), semaphore.acquire()]);
		try {
			await run();
		} finally {
			semaphore.release();
			semaphore.release();
			semaphore.release();
			semaphore.release();
		}
	}

	const KIMI: TestModel = { provider: "test", id: "kimi-k3", name: "Kimi K3" };
	const OTHER: TestModel = { provider: "test", id: "kimi-other", name: "Kimi Other" };

	async function dispatch(tools: Map<string, any>, model: string, name: string) {
		return tools.get("dispatch").execute("call", {
			task: "exercise the blacklist gate with a user-picked model",
			timeout: 60,
			permissions: "readonly",
			model,
			name,
		}, undefined, undefined, executionContext([KIMI, OTHER]));
	}

	it("lets the picked model through exactly once", async () => {
		vi.useFakeTimers();
		const restore = useAgentConfig({ models: { blacklist: ["kimi"] }, roles: {} });
		try {
			const { tools, commands } = extensionHarness();
			const ctx = executionContext([KIMI, OTHER]);
			await commands.get("subagent").handler("test/kimi-k3 review the diff", ctx);

			await withBlockedGroup(async () => {
				const first = await dispatch(tools, "test/kimi-k3", "test-override-first");
				expect(first.isError).toBeUndefined();
				expect(first.content[0].text).toContain("Dispatched");

				const second = await dispatch(tools, "test/kimi-k3", "test-override-second");
				expect(second.isError).toBe(true);
				expect(second.content[0].text).toContain("cannot be dispatched as a subagent");
			});
		} finally {
			restore();
			vi.useRealTimers();
		}
	});

	it("does not leak the override to another model", async () => {
		vi.useFakeTimers();
		const restore = useAgentConfig({ models: { blacklist: ["kimi"] }, roles: {} });
		try {
			const { tools, commands } = extensionHarness();
			const ctx = executionContext([KIMI, OTHER]);
			await commands.get("subagent").handler("test/kimi-k3 review the diff", ctx);

			await withBlockedGroup(async () => {
				const other = await dispatch(tools, "test/kimi-other", "test-override-other");
				expect(other.isError).toBe(true);
				expect(other.content[0].text).toContain("cannot be dispatched as a subagent");
				expect(pendingModelOverride()).toBe("test/kimi-k3");

				const picked = await dispatch(tools, "test/kimi-k3", "test-override-picked");
				expect(picked.isError).toBeUndefined();
			});
		} finally {
			restore();
			vi.useRealTimers();
		}
	});

	it("keeps refusing blacklisted models without a user pick", async () => {
		vi.useFakeTimers();
		const restore = useAgentConfig({ models: { blacklist: ["kimi"] }, roles: {} });
		try {
			const { tools } = extensionHarness();
			await withBlockedGroup(async () => {
				const refused = await dispatch(tools, "test/kimi-k3", "test-no-override");
				expect(refused.isError).toBe(true);
				expect(refused.content[0].text).toContain("cannot be dispatched as a subagent");
			});
		} finally {
			restore();
			vi.useRealTimers();
		}
	});
});
