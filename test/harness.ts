// Minimal ExtensionAPI double shared by the gated-goal behaviour tests. The
// reviewer boundary is faked separately per file (vi.mock on reviewer.ts):
// the real one spawns a child pi process. Everything else — state machine,
// epoch latch, commands, tools — runs for real.
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
