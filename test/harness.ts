// Minimal ExtensionAPI doubles shared by the behaviour tests. The reviewer
// boundary is faked separately per file (vi.mock on reviewer.ts): the real one
// spawns a child pi process. Everything else — state machine, epoch latch,
// commands, tools — runs for real.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { vi } from "vitest";
import subagentExtension from "../extensions/subagent/index.ts";

export type Ctx = any;
export type Handler = (e: unknown, ctx: Ctx) => Promise<void> | void;

export function makeHarness(ctx: Ctx) {
	const eventHandlers = new Map<string, (data: unknown) => void>();
	const hooks = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: Ctx) => Promise<unknown> }>();
	const tools = new Map<string, { execute: (id: string, params: any, signal: unknown, onUpdate: unknown, ctx: Ctx) => Promise<any> }>();
	const sent: string[] = [];
	const pi = {
		on: (name: string, h: Handler) => {
			if (!hooks.has(name)) hooks.set(name, []);
			hooks.get(name)!.push(h);
		},
		events: {
			on: (name: string, h: (d: unknown) => void) => eventHandlers.set(name, h),
			emit: (name: string, data: unknown) => eventHandlers.get(name)?.(data),
		},
		registerCommand: (name: string, cmd: { handler: (args: string, ctx: Ctx) => Promise<unknown> }) => commands.set(name, cmd),
		registerTool: (t: { name: string; execute: any }) => tools.set(t.name, t),
		sendUserMessage: (text: string, _opts?: unknown) => {
			sent.push(text);
		},
		appendEntry: (_t: string, _d: unknown) => {},
	};
	const fire = async (name: string, e: unknown = {}) => {
		for (const h of hooks.get(name) ?? []) await h(e, ctx);
	};
	return { pi, eventHandlers, commands, tools, sent, fire };
}

export const flush = () => new Promise((r) => setTimeout(r, 0));

/** Call a registered tool the way pi would. */
export function callTool(h: ReturnType<typeof makeHarness>, name: string, params: any, ctx: Ctx) {
	const tool = h.tools.get(name);
	if (!tool) throw new Error(`tool not registered: ${name}`);
	return tool.execute("call", params, undefined, undefined, ctx) as Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
}

// ---- subagent extension ----------------------------------------------------

export type TestModel = { provider: string; id: string; name: string };

/** The subagent extension registered against a fake pi: tools, commands,
 *  event handlers, and the emitted wait events. */
export function extensionHarness() {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
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
		registerCommand(name: string, command: any) { commands.set(name, command); },
		/** Pi's builtin tools plus whatever the extension under test registered. */
		getAllTools: () => [
			...["read", "grep", "find", "ls", "bash", "write", "edit", "web_search", "web_fetch"].map((name) => ({ name })),
			...[...tools.values()].map((tool) => ({ name: tool.name })),
		],
		sendUserMessage: vi.fn(),
	} as any;
	subagentExtension(pi);
	return { pi, tools, commands, handlers, emitted };
}

/** Execution context with a controlled model catalogue. */
export function executionContext(models: TestModel | TestModel[] = { provider: "test", id: "model", name: "model" }) {
	const list = Array.isArray(models) ? models : [models];
	return {
		cwd: process.cwd(),
		hasUI: false,
		ui: { notify: vi.fn() },
		scopedModels: list.map((model) => ({ model })),
		modelRegistry: {
			getAvailable: () => list,
			getAll: () => list,
		},
	} as any;
}

/** Point PI_CODING_AGENT_DIR at a temp dir with a controlled subagent.json
 *  so loadConfig (read per tool call) sees exactly this policy. */
export function useAgentConfig(cfg: Record<string, unknown>): () => void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
	fs.writeFileSync(path.join(dir, "subagent.json"), JSON.stringify(cfg));
	const saved = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	return () => {
		if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved;
		fs.rmSync(dir, { recursive: true, force: true });
	};
}
