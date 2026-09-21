/**
 * /todos popup — single-screen TUI via ctx.ui.custom().
 *
 * The below-editor widget is capped by pi at 10 lines, so long lists are
 * folded there (done items first, then earliest). This panel is the "show me
 * everything" view: a windowed, scrollable list of the full list, same visual
 * pattern as the /subagents panel and /reminders view — bordered overlay with
 * the summary riding the top border, cursor-following viewport, above/below
 * counters, and a key-hint footer.
 *
 * ↑/↓/j/k move (viewport follows), pgup/pgdn/home/end jump, esc/q/enter back.
 * A 1s signature poll re-renders when the underlying list changes, so items
 * the agent completes while the panel is open flip to done live.
 *
 * Display only — mutations go through the `todo` tool so they persist in the
 * session branch like every other change.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Todo } from "./snapshot.ts";

const GLYPH: Record<Todo["status"], string> = {
	todo: "○",
	pending: "◐",
	done: "✓",
};

/** One keyboard action for the panel, decoded from raw terminal input. Pure. */
export type PanelAction =
	| { type: "move"; delta: number }
	| { type: "page"; delta: number }
	| { type: "home" }
	| { type: "end" }
	| { type: "close" }
	| { type: "none" };

export function panelInput(data: string): PanelAction {
	if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "\x1b") return { type: "close" };
	if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\r" || data === "\n") return { type: "close" };
	if (matchesKey(data, "up") || data === "\x1b[A" || data === "\x1bOA" || data === "k" || data === "K") return { type: "move", delta: -1 };
	if (matchesKey(data, "down") || data === "\x1b[B" || data === "\x1bOB" || data === "j" || data === "J") return { type: "move", delta: 1 };
	if (matchesKey(data, "pageUp")) return { type: "page", delta: -1 };
	if (matchesKey(data, "pageDown")) return { type: "page", delta: 1 };
	if (matchesKey(data, "home")) return { type: "home" };
	if (matchesKey(data, "end")) return { type: "end" };
	if (data === "q" || data === "Q") return { type: "close" };
	return { type: "none" };
}

/** Window of visible rows around the cursor, clamped to the list bounds. Pure. */
export function windowRange(selected: number, count: number, maxVisible: number): { start: number; end: number } {
	if (count === 0) return { start: 0, end: 0 };
	const cap = Math.max(1, Math.min(maxVisible, count));
	// Center the cursor in the window, but never scroll past either end.
	const start = Math.max(0, Math.min(selected - Math.floor(cap / 2), count - cap));
	return { start, end: start + cap };
}

/** truncate a string to a visible cell width, aware of wide chars (CJK) and ANSI codes. */
function trunc(s: string, w: number): string {
	return truncateToWidth(s, w, "…");
}

function summaryTitle(todos: Todo[]): string {
	const done = todos.filter((t) => t.status === "done").length;
	return `Todos (${done}/${todos.length})`;
}

export async function openTodosPanel(ctx: ExtensionContext, getTodos: () => Todo[]): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const fg = theme.fg?.bind(theme);
		let selected = 0;
		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			clearInterval(refresh);
			done(undefined);
		};

		// Re-render when the list changes underneath us (agent marking items
		// done while the panel is open). Signature-gated, like /reminders.
		let lastSignature = "";
		const signature = () =>
			getTodos()
				.map((t) => `${t.id}:${t.status}:${t.text}`)
				.join("|");
		const refresh = setInterval(() => {
			const next = signature();
			if (next === lastSignature) return;
			lastSignature = next;
			tui.requestRender();
		}, 1000);
		lastSignature = signature();

		const render = (width: number) => {
			const todos = getTodos();
			const innerWidth = Math.max(1, width - 2);
			// Budget the window so the box never exceeds the overlay's maxHeight
			// (80% of terminal rows minus margins) — the overlay hard-truncates
			// anything taller, which would eat the footer. Chrome: borders(2) +
			// above/below counters(≤2) + footer(1). Windowing is also what makes
			// every row reachable in the first place.
			let rows = 24;
			try {
				rows = tui.terminal.rows || 24;
			} catch {
				/* default */
			}
			const maxBox = Math.min(Math.floor(rows * 0.8), rows - 2);
			const maxVisible = Math.max(3, Math.min(20, maxBox - 5));
			if (todos.length === 0) selected = 0;
			else selected = Math.max(0, Math.min(selected, todos.length - 1));
			const { start, end } = windowRange(selected, todos.length, maxVisible);

			const body: string[] = [];
			if (start > 0) body.push(fg ? fg("muted", `  … ${start} above`) : `  … ${start} above`);
			for (let i = start; i < end; i++) {
				const t = todos[i];
				if (!t) continue;
				const marker = i === selected ? (fg ? fg("accent", "›") : "›") : " ";
				const icon = t.status === "done" && fg ? fg("success", GLYPH[t.status]) : GLYPH[t.status];
				let text: string;
				if (i === selected) {
					text = fg ? fg("accent", `#${t.id} ${t.text}`) : `#${t.id} ${t.text}`;
				} else if (t.status === "done") {
					text = fg ? fg("dim", `#${t.id} ${t.text}`) : `#${t.id} ${t.text}`;
				} else {
					text = fg ? fg("text", `#${t.id} ${t.text}`) : `#${t.id} ${t.text}`;
				}
				body.push(trunc(`${marker} ${icon} ${text}`, innerWidth));
			}
			const below = todos.length - end;
			if (below > 0) body.push(fg ? fg("muted", `  … ${below} below`) : `  … ${below} below`);
			const counter = todos.length > 0 ? ` (${selected + 1}/${todos.length})` : "";
			const footer = `↑↓/j/k move • pgup/pgdn/home/end jump • esc/q back${counter}`;
			body.push(fg ? fg("muted", footer) : footer);

			// Paint every overlay cell so the conversation behind the popup cannot
			// show through. The summary rides the top border, as in /subagents.
			const border = (s: string) => (fg ? fg("border", s) : s);
			const title = truncateToWidth(` ${summaryTitle(todos)} `, innerWidth, "…");
			const rightRule = "─".repeat(Math.max(0, innerWidth - visibleWidth(title)));
			const lines = [border("╭") + (fg ? fg("accent", title) : title) + border(`${rightRule}╮`)];
			for (const line of body) {
				lines.push(border("│") + truncateToWidth(line, innerWidth, "…", true) + border("│"));
			}
			lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
			return lines;
		};

		const handleInput = (data: string) => {
			const action = panelInput(data);
			const todos = getTodos();
			if (action.type === "close") {
				close();
				return;
			}
			if (todos.length === 0) return;
			switch (action.type) {
				case "move":
					selected = Math.max(0, Math.min(todos.length - 1, selected + action.delta));
					break;
				case "page": {
					const step = Math.max(1, Math.min(12, todos.length));
					selected = Math.max(0, Math.min(todos.length - 1, selected + action.delta * step));
					break;
				}
				case "home":
					selected = 0;
					break;
				case "end":
					selected = todos.length - 1;
					break;
				default:
					return;
			}
			tui.requestRender();
		};

		return { render, handleInput, invalidate: () => {} };
	}, {
		overlay: true,
		overlayOptions: {
			width: "95%",
			maxHeight: "80%",
			anchor: "center",
			margin: 1,
		},
	});
}
