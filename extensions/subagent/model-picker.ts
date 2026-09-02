/**
 * Searchable model picker — replaces pi's built-in `ctx.ui.select` for model
 * lists. The built-in selector renders every option with no viewport and no
 * filtering, so once the catalogue outgrows the terminal the off-screen models
 * cannot be seen or picked at all (and finding one means blind arrow-mashing).
 *
 * This picker is a `ctx.ui.custom` overlay (same pattern as the /subagents
 * panel): a filter line that matches partial names against provider/id/name,
 * a windowed list whose viewport follows the cursor, above/below counters,
 * and page/home/end jumps. Non-TUI modes (rpc/json/print) fall back to
 * `ctx.ui.select`, preserving the previous behavior there.
 *
 * Input handling and window math live in pure helpers (pickerInput,
 * windowRange) so they are unit-testable without a terminal.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { availableModelRecords, type AvailableModel, matchHint } from "./models.ts";

export interface PickModelOptions {
	title: string;
	/** Timeout for the non-TUI `ui.select` fallback only; the overlay waits for the user. */
	timeoutMs?: number;
}

/** Filter the catalogue by a partial query (case-insensitive, across provider/id/name). */
export function filterModels(records: AvailableModel[], query: string): AvailableModel[] {
	const q = query.trim();
	return q ? matchHint(q, records) : records;
}

/** One keyboard action for the picker, decoded from raw terminal input. */
export type PickerAction =
	| { type: "move"; delta: number }
	| { type: "page"; delta: number }
	| { type: "home" }
	| { type: "end" }
	| { type: "backspace" }
	| { type: "type"; text: string }
	| { type: "accept" }
	| { type: "cancel" }
	| { type: "none" };

function isPrintableRun(data: string): boolean {
	// Reject control sequences and lone control chars; accept short printable
	// runs (single keystrokes, or a small paste).
	if (data.length === 0 || data.length > 64) return false;
	for (const ch of data) {
		const code = ch.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
}

/** Decode raw terminal input into a picker action. Pure; no state. */
export function pickerInput(data: string): PickerAction {
	if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "\x1b") return { type: "cancel" };
	if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\r" || data === "\n") return { type: "accept" };
	if (matchesKey(data, "up") || data === "\x1b[A" || data === "\x1bOA" || data === "k" || data === "K") return { type: "move", delta: -1 };
	if (matchesKey(data, "down") || data === "\x1b[B" || data === "\x1bOB" || data === "j" || data === "J") return { type: "move", delta: 1 };
	if (matchesKey(data, "pageUp")) return { type: "page", delta: -1 };
	if (matchesKey(data, "pageDown")) return { type: "page", delta: 1 };
	if (matchesKey(data, "home")) return { type: "home" };
	if (matchesKey(data, "end")) return { type: "end" };
	if (matchesKey(data, "backspace") || data === "\x7f" || data === "\x08") return { type: "backspace" };
	if (isPrintableRun(data)) return { type: "type", text: data };
	return { type: "none" };
}

/** Window of visible rows around the cursor, clamped to the list bounds. */
export function windowRange(selected: number, count: number, maxVisible: number): { start: number; end: number } {
	if (count === 0) return { start: 0, end: 0 };
	const cap = Math.max(1, Math.min(maxVisible, count));
	// Center the cursor in the window, but never scroll past either end.
	const start = Math.max(0, Math.min(selected - Math.floor(cap / 2), count - cap));
	return { start, end: start + cap };
}

/**
 * Let the user pick a model from the session catalogue.
 * Returns "provider/modelId", or undefined when cancelled / catalogue empty.
 */
export async function pickModel(ctx: ExtensionContext, opts: PickModelOptions): Promise<string | undefined> {
	const records = availableModelRecords(ctx);
	if (records.length === 0) return undefined;

	// The overlay needs a real TTY; other modes keep the old dialog.
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		return await ctx.ui.select(opts.title, records.map((m) => `${m.provider}/${m.id}`), opts.timeoutMs ? { timeout: opts.timeoutMs } : undefined);
	}

	return await ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
		const fg = theme.fg?.bind(theme);
		let query = "";
		let selected = 0;
		let closed = false;
		const close = (value: string | undefined) => {
			if (closed) return;
			closed = true;
			done(value);
		};
		const termRows = (): number => {
			try {
				return tui.terminal.rows || 24;
			} catch {
				return 24;
			}
		};

		const render = (width: number) => {
			const innerWidth = Math.max(1, width - 2);
			const matches = filterModels(records, query);
			// Leave room for chrome: borders(2) + title(1) + filter(1) + blank(1)
			// + indicators/counter(2) + blank(1) + footer(1).
			const maxVisible = Math.max(3, Math.min(12, termRows() - 10));
			const { start, end } = windowRange(selected, matches.length, maxVisible);

			const body: string[] = [];
			const cursor = fg ? fg("accent", "▏") : "▏";
			const filterLabel = query ? `filter: ${query}` : "filter: (type to search)";
			body.push(trunc(`${filterLabel}${cursor}`, innerWidth));
			body.push("");

			if (matches.length === 0) {
				body.push(fg ? fg("warning", `no models match “${query}”`) : `no models match "${query}"`);
			} else {
				if (start > 0) body.push(fg ? fg("muted", `  … ${start} above`) : `  … ${start} above`);
				for (let i = start; i < end; i++) {
					const m = matches[i];
					if (!m) continue;
					const label = `${m.provider}/${m.id}`;
					if (i === selected) {
						const arrow = fg ? fg("accent", "→ ") : "→ ";
						const text = fg ? fg("accent", label) : label;
						body.push(trunc(`${arrow}${text}`, innerWidth));
					} else {
						const text = fg ? fg("text", label) : label;
						body.push(trunc(`  ${text}`, innerWidth));
					}
				}
				const below = matches.length - end;
				if (below > 0) body.push(fg ? fg("muted", `  … ${below} below`) : `  … ${below} below`);
				const counter = `(${selected + 1}/${matches.length}${query ? ` match${matches.length === 1 ? "" : "es"} of ${records.length}` : ""})`;
				body.push(fg ? fg("dim", `  ${counter}`) : `  ${counter}`);
			}
			body.push("");
			body.push(fg ? fg("muted", "type filter · ↑↓/jk move · pgup/pgdn/home/end jump · enter select · esc cancel") : "type filter · ↑↓/jk move · pgup/pgdn/home/end jump · enter select · esc cancel");

			// Paint every overlay cell so the conversation behind cannot show
			// through. Title rides the top border, as in the /subagents panel.
			const border = (s: string) => fg ? fg("border", s) : s;
			const title = truncateToWidth(` ${opts.title} `, innerWidth, "…");
			const rightRule = "─".repeat(Math.max(0, innerWidth - visibleWidth(title)));
			const lines = [border("╭") + (fg ? fg("accent", title) : title) + border(`${rightRule}╮`)];
			for (const line of body) {
				lines.push(border("│") + truncateToWidth(line, innerWidth, "…", true) + border("│"));
			}
			lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
			return lines;
		};

		const handleInput = (data: string) => {
			const action = pickerInput(data);
			switch (action.type) {
				case "cancel":
					close(undefined);
					return;
				case "accept": {
					const matches = filterModels(records, query);
					const m = matches[selected];
					if (m) close(`${m.provider}/${m.id}`);
					return;
				}
				case "move":
				case "page": {
					const matches = filterModels(records, query);
					if (matches.length === 0) return;
					const step = action.type === "page" ? Math.max(1, Math.min(12, matches.length)) : 1;
					selected = Math.max(0, Math.min(matches.length - 1, selected + action.delta * step));
					tui.requestRender();
					return;
				}
				case "home":
					selected = 0;
					tui.requestRender();
					return;
				case "end": {
					const matches = filterModels(records, query);
					selected = Math.max(0, matches.length - 1);
					tui.requestRender();
					return;
				}
				case "backspace":
					query = query.slice(0, -1);
					selected = 0;
					tui.requestRender();
					return;
				case "type":
					query += action.text;
					selected = 0;
					tui.requestRender();
					return;
				default:
					return;
			}
		};

		return { render, handleInput, invalidate: () => {} };
	}, {
		overlay: true,
		overlayOptions: {
			width: "95%",
			maxHeight: "90%",
			anchor: "center",
			margin: 1,
		},
	});
}

/** truncate a string to a visible cell width, aware of wide chars (CJK) and ANSI codes. */
function trunc(s: string, w: number): string {
	return truncateToWidth(s, w, "…");
}
