/**
 * The todo list's read model, shared by whoever needs to know the current
 * items (the todo extension itself, and gated-goal's ACT→REVIEW gate).
 *
 * The list is never stored in an external file: it is derived from the session
 * branch, so forking or navigating the session tree yields exactly the list as
 * of that point in history. Two kinds of branch entry carry it:
 *
 *   1. `todo` tool results  — the agent adding / setting / removing items.
 *   2. `todo-state` custom entries — a wholesale replacement pushed by another
 *      extension over the `todo:replace` event (gated-goal freezing a plan).
 *      Custom entries persist in the session but stay out of LLM context.
 *
 * Whichever comes last in the branch wins. This module is intentionally pure:
 * pi gives each extension entry point its own module instance, so shared
 * *state* would silently split in two, but a shared *function* is fine.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type TodoStatus = "todo" | "pending" | "done";

export interface Todo {
	id: number;
	text: string;
	status: TodoStatus;
}

export interface TodoSnapshot {
	todos: Todo[];
	nextId: number;
}

/** Custom-entry type used to persist a replacement list into the session. */
export const TODO_STATE_ENTRY = "todo-state";
/** Event that replaces the whole list atomically. Payload: TodoReplaceEvent. */
export const TODO_REPLACE_EVENT = "todo:replace";

export interface TodoReplaceEvent {
	/** Who asked for the replacement (for logging/debugging). */
	source: string;
	items: { text: string; status?: TodoStatus }[];
	/** Live context of the caller — used to render the widget and persist. */
	ctx: ExtensionContext;
}

function coerce(raw: unknown): TodoSnapshot | undefined {
	const d = raw as { todos?: unknown; nextId?: unknown } | undefined;
	if (!d || !Array.isArray(d.todos)) return undefined;
	const todos = (d.todos as Todo[]).map((t) => ({ id: t.id, text: t.text, status: t.status }));
	const maxId = todos.reduce((m, t) => Math.max(m, t.id), 0);
	return { todos, nextId: typeof d.nextId === "number" ? d.nextId : maxId + 1 };
}

/** Current todo list for this branch. Empty snapshot if the branch has none. */
export function readTodoSnapshot(ctx: ExtensionContext): TodoSnapshot {
	let snapshot: TodoSnapshot = { todos: [], nextId: 1 };
	for (const entry of ctx.sessionManager.getBranch()) {
		const e = entry as any;
		if (e.type === "message") {
			const msg = e.message;
			if (msg?.role !== "toolResult" || msg.toolName !== "todo") continue;
			snapshot = coerce(msg.details) ?? snapshot;
		} else if (e.type === "custom" && e.customType === TODO_STATE_ENTRY) {
			snapshot = coerce(e.data) ?? snapshot;
		}
	}
	return snapshot;
}

/** Renumber a replacement list from 1 so ids stay dense and predictable. */
export function buildTodos(items: { text: string; status?: TodoStatus }[]): TodoSnapshot {
	const todos = items.map((t, i) => ({ id: i + 1, text: t.text.trim(), status: t.status ?? ("todo" as TodoStatus) }));
	return { todos, nextId: todos.length + 1 };
}
