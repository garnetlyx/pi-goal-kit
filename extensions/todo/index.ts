/**
 * Todo extension with non-blocking completion nudges.
 *
 * The agent manages a task list via the `todo` tool (add / list / set-status /
 * remove / clear). Statuses: todo | pending | done. The list is stored in tool
 * result details (not external files), so it is automatically correct for the
 * current branch — forking or navigating the session tree restores the state
 * as of that point in history.
 *
 * A persistent widget below the editor shows the list whenever it is non-empty.
 *
 * On `agent_settled`, if any todo is still incomplete (todo or pending) and no
 * other "wait" is active (no running subagent, no pending reminder, etc.), the
 * extension injects a follow-up message nudging the agent to verify which
 * todos are actually done (toggle them) and continue the rest. This catches
 * the common case where a local model stops mid-work or forgets to mark work
 * done.
 *
 * Cross-extension coordination uses the pi.events bus:
 *   wait:active  { source, id }  — something is being waited on
 *   wait:done    { source, id }  — the wait ended
 *   todo:replace { source, items, ctx } — replace the whole list atomically
 * Any extension that represents a wait should emit the first two so the todo
 * nudge stays silent while the agent is legitimately blocked (sources seen so
 * far: "reminder-hook", "subagent"). The third is for an extension that owns a
 * plan and needs the list to match it exactly instead of asking the model to
 * re-type it; see snapshot.ts for the read model both sides share.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	buildTodos,
	readTodoSnapshot,
	type Todo,
	type TodoReplaceEvent,
	type TodoSettledEvent,
	type TodoStatus,
	TODO_REPLACE_EVENT,
	TODO_SETTLED_EVENT,
	TODO_STATE_ENTRY,
} from "./snapshot.ts";
import { openTodosPanel } from "./panel.ts";

interface TodoDetails {
	action: string;
	todos: Todo[];
	nextId: number;
	error?: string;
}

const StatusSchema = StringEnum(["todo", "pending", "done"] as const, {
	description: "New status for the todo item. 'todo' = not started, 'pending' = in progress / blocked, 'done' = complete.",
});

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "set", "remove", "clear"] as const, {
		description: "list: show all. add: create (needs text). set: change status (needs id, status). remove: delete (needs id). clear: empty the list.",
	}),
	text: Type.Optional(Type.String({ description: "Todo text (for add)." })),
	id: Type.Optional(Type.Number({ description: "Todo id (for set / remove)." })),
	status: Type.Optional(StatusSchema),
});

const STATUS_GLYPH: Record<TodoStatus, string> = {
	todo: "○",
	pending: "◐",
	done: "✓",
};

function isIncomplete(t: Todo): boolean {
	return t.status !== "done";
}

// pi's interactive mode renders at most 10 widget lines per widget and, beyond
// that, bluntly cuts the tail ("... (widget truncated)"). Stay under the cap:
// 1 header + up to 9 items, or 1 header + 8 items + 1 summary when folded.
const MAX_WIDGET_LINES = 10;

/** Which items a size-capped widget should show, and what got folded away.
 * Pure — keep exported for tests. */
export function chooseWidgetWindow(
	todos: Todo[],
	maxItems: number,
): { visible: Todo[]; hiddenDone: number; hiddenEarlier: number } {
	// Fold `done` items first (least actionable — the header already counts
	// them), then the earliest items, so the latest incomplete work stays
	// visible. When only done items exist, keep the latest ones so the round's
	// results remain readable.
	const incomplete = todos.filter(isIncomplete);
	const done = todos.filter((t) => t.status === "done");
	const keepIncomplete = Math.min(incomplete.length, maxItems);
	const keepDone = Math.min(done.length, maxItems - keepIncomplete);
	// slice(-0) would copy the whole array — guard both zero cases.
	const keepInc = keepIncomplete > 0 ? incomplete.slice(-keepIncomplete) : [];
	const keepDn = keepDone > 0 ? done.slice(-keepDone) : [];
	const keep = new Set([...keepInc, ...keepDn].map((t) => t.id));
	return {
		visible: todos.filter((t) => keep.has(t.id)), // original order
		hiddenDone: done.length - keepDone,
		hiddenEarlier: incomplete.length - keepIncomplete,
	};
}

const DIM = "\x1b[2m";
const UNDIM = "\x1b[22m";

/** Widget lines for a todo list, budgeted to MAX_WIDGET_LINES. */
export function widgetLines(todos: Todo[]): string[] {
	const done = todos.filter((t) => t.status === "done").length;
	const lines: string[] = [`Todos (${done}/${todos.length})`];
	let visible = todos;
	let folded: ReturnType<typeof chooseWidgetWindow> | undefined;
	if (todos.length > MAX_WIDGET_LINES - 1) {
		folded = chooseWidgetWindow(todos, MAX_WIDGET_LINES - 2); // -2: header + summary
		visible = folded.visible;
	}
	for (const t of visible) {
		const mark = STATUS_GLYPH[t.status];
		const text = t.status === "done" ? `${DIM}${t.text}${UNDIM}` : t.text;
		lines.push(`${mark} #${t.id} ${text}`);
	}
	if (folded) {
		const parts: string[] = [];
		if (folded.hiddenDone > 0) parts.push(`${folded.hiddenDone} done`);
		if (folded.hiddenEarlier > 0) parts.push(`${folded.hiddenEarlier} earlier`);
		lines.push(`${DIM}… ${parts.join(", ")} hidden — /todos for all${UNDIM}`);
	}
	return lines;
}

export default function (pi: ExtensionAPI) {
	const baseDir = dirname(fileURLToPath(import.meta.url));

	// Co-locate this extension's skill with its code; register it so pi loads
	// the SKILL.md without a separate skills/ entry.
	pi.on("resources_discover", () => ({
		skillPaths: [join(baseDir, "SKILL.md")],
	}));

	let todos: Todo[] = [];
	let nextId = 1;
	// Signature of the incomplete set at the last nudge, to de-dup repeated
	// nudges when nothing changed. Empty = nothing nudged yet.
	let lastNudgeSignature = "";

	// Active waits from other extensions (subagent, reminder-hook, ...).
	const activeWaits = new Set<string>(); // `${source}:${id}`

	const reconstructState = (ctx: ExtensionContext) => {
		const snapshot = readTodoSnapshot(ctx);
		todos = snapshot.todos;
		nextId = snapshot.nextId;
		renderWidget(ctx);
	};

	const renderWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (todos.length === 0) {
			ctx.ui.setWidget("todo", undefined, { placement: "belowEditor" });
			return;
		}
		ctx.ui.setWidget("todo", widgetLines(todos), { placement: "belowEditor" });
	};

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	// Cross-extension active-wait protocol.
	pi.events.on("wait:active", (data) => {
		const { source, id } = (data ?? {}) as { source?: string; id?: string };
		if (source && id) activeWaits.add(`${source}:${id}`);
	});
	pi.events.on("wait:done", (data) => {
		const { source, id } = (data ?? {}) as { source?: string; id?: string };
		if (source && id) activeWaits.delete(`${source}:${id}`);
	});

	// Atomic whole-list replacement, for extensions that own a plan (gated-goal
	// freezing one). Asking the model to "now add these todos" instead appends
	// to whatever it already wrote down, producing duplicate work. The new list
	// is persisted as a session entry so it
	// survives restarts and branch navigation like a tool result would.
	pi.events.on(TODO_REPLACE_EVENT, (data) => {
		const { items, ctx } = (data ?? {}) as Partial<TodoReplaceEvent>;
		if (!Array.isArray(items) || !ctx) return;
		const snapshot = buildTodos(items);
		todos = snapshot.todos;
		nextId = snapshot.nextId;
		pi.appendEntry(TODO_STATE_ENTRY, snapshot);
		resetNudgeSig();
		renderWidget(ctx);
	});

	// The nudge: if the agent settles with incomplete todos and nothing is being
	// waited on, push it to verify/continue.
	pi.on("agent_settled", async (_event, ctx) => {
		const settle = (disposition: TodoSettledEvent["disposition"]) => {
			pi.events.emit(TODO_SETTLED_EVENT, { disposition, ctx } satisfies TodoSettledEvent);
		};
		const incomplete = todos.filter(isIncomplete);
		if (incomplete.length === 0) {
			lastNudgeSignature = "";
			settle("review");
			return;
		}
		if (activeWaits.size > 0) {
			settle("wait");
			return; // legitimately waiting — stay silent
		}
		// Avoid nudge loops: if the set of incomplete ids hasn't changed since the
		// last nudge, the agent already saw it and chose to stop. Don't spam.
		const sig = incomplete.map((t) => t.id).sort().join(",");
		const countSig = `${incomplete.length}|${sig}`;
		if (countSig === lastNudgeSignature) {
			settle("review");
			return;
		}
		lastNudgeSignature = countSig;

		const list = incomplete
			.map((t) => `  [${t.status}] #${t.id} ${t.text}`)
			.join("\n");
		const nudge =
			`⏫ ${incomplete.length} todo(s) still incomplete:\n${list}\n\n` +
			`First verify which of these are actually finished (a common mistake is ` +
			`completing work but forgetting to mark it done) — toggle finished ones ` +
			`via todo({action:"set", id:<n>, status:"done"}). Then continue any ` +
			`genuinely unfinished work, or report what is blocking you.`;
		if (ctx.hasUI) {
			ctx.ui.notify(`${incomplete.length} todos incomplete — nudging agent`, "warning");
		}
		pi.sendUserMessage(nudge, { deliverAs: "followUp" });
		settle("continue");
	});

	// Reset the de-dup signature whenever the list changes, so a fresh stop
	// after progress nudges again.
	const resetNudgeSig = () => {
		lastNudgeSignature = "";
	};

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: [
			"Manage a task list. Statuses: todo (not started), pending (in progress / blocked), done.",
			"A widget below the editor shows the list while non-empty.",
			"Actions: list, add (text), set (id, status), remove (id), clear.",
			"Mark items done as soon as their work is finished — a nudge fires if the agent stops with incomplete todos.",
		].join("\n"),
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			let error: string | undefined;
			switch (params.action) {
				case "list":
					break;

				case "add": {
					if (!params.text?.trim()) {
						error = "text required for add";
						break;
					}
					todos.push({ id: nextId++, text: params.text.trim(), status: "todo" });
					resetNudgeSig();
					break;
				}

				case "set": {
					if (params.id === undefined) {
						error = "id required for set";
						break;
					}
					if (!params.status) {
						error = "status required for set";
						break;
					}
					const t = todos.find((x) => x.id === params.id);
					if (!t) {
						error = `#${params.id} not found`;
						break;
					}
					t.status = params.status;
					resetNudgeSig();
					break;
				}

				case "remove": {
					if (params.id === undefined) {
						error = "id required for remove";
						break;
					}
					const before = todos.length;
					todos = todos.filter((x) => x.id !== params.id);
					if (todos.length === before) error = `#${params.id} not found`;
					resetNudgeSig();
					break;
				}

				case "clear": {
					todos = [];
					nextId = 1;
					resetNudgeSig();
					break;
				}

				default:
					error = `unknown action: ${params.action}`;
			}

			renderWidget(ctx);

			const text = error
				? `Error: ${error}`
				: params.action === "list"
					? todos.length
						? todos.map((t) => `[${t.status}] #${t.id}: ${t.text}`).join("\n")
						: "No todos"
					: `ok (${params.action}) — ${todos.length} todo(s), ${todos.filter((t) => t.status === "done").length} done`;

			return {
				content: [{ type: "text", text }],
				details: { action: params.action, todos: todos.map((t) => ({ ...t })), nextId, error } as TodoDetails,
			};
		},
	});

	pi.registerCommand("todos", {
		description: "Show all todos in a scrollable popup",
		handler: async (_args, ctx) => {
			if (todos.length === 0) {
				ctx.ui.notify("No todos", "info");
				return;
			}
			// Older versions rendered this command as a second below-editor widget,
			// which hit the same core 10-line widget cap. Clear any such widget, then
			// open the focused popup (same pattern as /subagents and /reminders).
			ctx.ui.setWidget("todo-cmd", undefined, { placement: "belowEditor" });
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify(widgetLines(todos).join("\n"), "info");
				return;
			}
			await openTodosPanel(ctx, () => todos);
		},
	});
}
