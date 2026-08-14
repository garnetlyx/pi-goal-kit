/**
 * /subagents panel — single-screen TUI via ctx.ui.custom().
 *
 * One view, two regions:
 *   - Top: status summary + list (running/hung/failed shown by default;
 *     done folded, press 'a' to show all).
 *   - Bottom: live output of the currently selected entry.
 * ↑/↓ select (bottom region follows). a = toggle show-all. enter = toggle
 * expanded output. esc/q/ctrl+c = back to editor.
 *
 * Subscribes to registry changes, so running output and completion update live
 * without an idle redraw loop.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { DispatchEntry, DispatchStatus } from "./scheduler.ts";
import { registry } from "./scheduler.ts";

function statusIcon(s: DispatchStatus): string {
	switch (s) {
		case "queued": return "·";
		case "running": return "▶";
		case "done": return "✓";
		case "failed": return "✗";
		case "timeout": return "⏱";
		case "cancelled": return "⊘";
		case "hung": return "⚠";
		default: return "?";
	}
}

function statusGlyph(s: DispatchStatus, fg: any): string {
	const icon = statusIcon(s);
	if (!fg) return icon;
	switch (s) {
		case "running": return fg("accent", icon);
		case "done": return fg("success", icon);
		case "failed":
		case "timeout":
		case "hung": return fg("error", icon);
		case "cancelled": return fg("muted", icon);
		default: return fg("muted", icon);
	}
}

function fmtDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60}s`;
	const h = Math.floor(m / 60);
	return `${h}h${m % 60}m`;
}

function fmtAgo(ts: number): string {
	const s = Math.floor((Date.now() - ts) / 1000);
	if (s < 5) return "now";
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	return `${Math.floor(m / 60)}h ago`;
}

/** truncate a string to a visible cell width, aware of wide chars (CJK) and ANSI codes. */
function trunc(s: string, w: number): string {
	return truncateToWidth(s, w, "…");
}

const INTERESTING = new Set<DispatchStatus>(["running", "hung", "failed", "timeout", "queued"]);

interface State {
	selected: number; // index into `visible` list
	showAll: boolean;
	expanded: boolean;
	visible: DispatchEntry[]; // recomputed each render
}

function computeVisible(showAll: boolean): DispatchEntry[] {
	const all = registry.all();
	// newest first
	const sorted = [...all].sort((a, b) => b.startedAt - a.startedAt);
	if (showAll) return sorted;
	// default: interesting first, then a few recent done
	const interesting = sorted.filter((e) => INTERESTING.has(e.status));
	const done = sorted.filter((e) => !INTERESTING.has(e.status));
	return [...interesting, ...done.slice(0, 5)];
}

function summaryLine(all: DispatchEntry[], fg: any, showAll: boolean, expanded: boolean): string {
	const counts: Record<string, number> = {};
	for (const e of all) counts[e.status] = (counts[e.status] ?? 0) + 1;
	const parts = Object.entries(counts).map(([k, v]) => `${k} ${v}`);
	const mode = `view ${showAll ? "all" : "active+recent"} · output ${expanded ? "expanded" : "compact"}`;
	const status = parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
	const text = `Subagents (${all.length})${status} · ${mode}`;
	return fg ? fg("toolTitle", text) : text;
}

function listItem(e: DispatchEntry, selected: boolean, fg: any, width: number): string {
	const marker = selected ? (fg ? fg("accent", "›") : "›") : " ";
	const icon = statusGlyph(e.status, fg);
	const name = fg ? fg("accent", e.name) : e.name;
	const model = fg ? fg("dim", e.model) : e.model;
	const elapsed = e.endedAt ? fmtDuration(e.endedAt - e.startedAt) : fmtDuration(Date.now() - e.startedAt);
	const ago = e.endedAt ? fmtAgo(e.endedAt) : `${fmtAgo(e.lastActivityAt)}`;
	const warn = e.warning ? " " + (fg ? fg("warning", e.warning) : e.warning) : "";
	return trunc(`${marker} ${icon} ${name} ${model} ${elapsed} ${ago}${warn}`, width);
}

function outputRegion(e: DispatchEntry | undefined, fg: any, width: number, height: number, expanded: boolean): string[] {
	if (!e) return [fg ? fg("muted", "(no subagents)") : "(no subagents)"];
	const lines: string[] = [];
	const header = `${expanded ? "▼" : "▶"} ${e.name} — ${e.model}`;
	lines.push(trunc(fg ? fg("muted", header) : header, width));

	// task
	lines.push(trunc(fg ? fg("dim", `task: ${e.task}`) : `task: ${e.task}`, width));
	lines.push("");

	// tool calls (last several)
	const calls = e.messages
		.filter((m) => m.role === "assistant")
		.flatMap((m) => m.content)
		.filter((p: any) => p.type === "toolCall");
	if (calls.length > 0) {
		lines.push(trunc(fg ? fg("muted", `tool calls (${calls.length}):`) : `tool calls (${calls.length}):`, width));
		const budget = Math.max(0, height - lines.length - 6);
		for (const c of calls.slice(-budget)) {
			const args = JSON.stringify((c as any).arguments ?? {});
			const preview = args.length > 50 ? args.slice(0, 50) + "…" : args;
			lines.push(trunc(`  → ${(c as any).name} ${preview}`, width));
		}
		lines.push("");
	}

	// Final/live assistant output (tail to fit). Prefer finalOutput, but also
	// derive text from captured messages so a just-finished run can never stay
	// stuck on the placeholder while its final assignment is propagating.
	let capturedText: string | undefined;
	for (let i = e.messages.length - 1; i >= 0 && !capturedText; i--) {
		const message = e.messages[i];
		if (message.role !== "assistant") continue;
		for (let j = message.content.length - 1; j >= 0; j--) {
			const part = message.content[j];
			if (part.type === "text" && part.text.trim()) { capturedText = part.text; break; }
		}
	}
	const out = e.finalOutput || capturedText || e.errorMessage || (e.status === "running" ? "(running…)" : "(no output yet)");
	const outLines = out.split("\n");
	const remaining = Math.max(0, height - lines.length - 1);
	if (outLines.length > remaining) {
		lines.push(fg ? fg("muted", `output (last ${remaining} lines):`) : `output (last ${remaining} lines):`);
		for (const ln of outLines.slice(-remaining)) lines.push(trunc(ln, width));
	} else {
		lines.push(fg ? fg("muted", "output:") : "output:");
		for (const ln of outLines) lines.push(trunc(ln, width));
	}
	return lines;
}

export async function openSubagentsPanel(_pi: ExtensionAPI, ctx: ExtensionContext, arg?: string): Promise<void> {
	if (!ctx.hasUI || ctx.mode !== "tui") {
		// Non-TUI fallback: print text.
		ctx.ui.notify(summaryText(), "info");
		return;
	}

	// If an id arg was given, we still open the panel but jump-select to it.
	const startId = arg && arg !== "all" ? arg : undefined;
	const startShowAll = arg === "all";

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const fg = theme.fg?.bind(theme);
		const state: State = { selected: 0, showAll: startShowAll, expanded: false, visible: [] };

		const render = (width: number) => {
			state.visible = computeVisible(state.showAll);
			// clamp selection
			if (state.visible.length === 0) state.selected = 0;
			else if (state.selected >= state.visible.length) state.selected = state.visible.length - 1;
			else if (state.selected < 0) state.selected = 0;

			const all = registry.all();
			const innerWidth = Math.max(1, width - 2);
			const body: string[] = [];

			// List region: fixed budget (render() gives width only, no height).
			const listBudget = Math.min(state.visible.length, 10);
			const start = Math.max(0, Math.min(state.selected - listBudget + 1, state.visible.length - listBudget));
			const listItems = state.visible.slice(start, start + listBudget);
			if (start > 0) body.push(fg ? fg("muted", `  … ${start} newer above`) : `  … ${start} newer above`);
			for (let i = 0; i < listItems.length; i++) {
				const visibleIdx = start + i;
				body.push(listItem(listItems[i], visibleIdx === state.selected, fg, innerWidth));
			}
			const below = state.visible.length - (start + listItems.length);
			if (below > 0) body.push(fg ? fg("muted", `  … ${below} older below`) : `  … ${below} older below`);
			body.push("");

			// Output region: fixed line budget.
			const outHeight = state.expanded ? 24 : 12;
			const sel = state.visible[state.selected];
			body.push(...outputRegion(sel, fg, innerWidth, outHeight, state.expanded));
			body.push("");
			body.push(fg ? fg("muted", "↑↓/j/k select • enter expand/collapse • a all/recent • esc/q back") : "↑↓/j/k select • enter expand/collapse • a all/recent • esc/q back");

			// Paint every overlay cell so the conversation behind the popup cannot
			// show through. The current status/mode doubles as the border title.
			const border = (s: string) => fg ? fg("border", s) : s;
			const rawTitle = summaryLine(all, fg, state.showAll, state.expanded);
			const title = truncateToWidth(` ${rawTitle} `, innerWidth, "…");
			const titleWidth = visibleWidth(title);
			const rightRule = "─".repeat(Math.max(0, innerWidth - titleWidth));
			const lines = [border("╭") + title + border(`${rightRule}╮`)];
			for (const line of body) {
				lines.push(border("│") + truncateToWidth(line, innerWidth, "…", true) + border("│"));
			}
			lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
			return lines;
		};

		// Registry mutations directly wake this overlay. This guarantees the
		// running→done transition and finalOutput appear immediately, without an
		// idle interval that can snap scrollback or leave a cached stale frame.
		const unsubscribe = registry.subscribe(() => tui.requestRender());
		let closed = false;
		const cleanup = () => {
			if (closed) return;
			closed = true;
			unsubscribe();
		};
		const close = () => { cleanup(); done(undefined); };
		const isUp = (data: string) => matchesKey(data, "up") || data === "up" || data === "\x1b[A" || data === "\x1bOA" || data === "k" || data === "K";
		const isDown = (data: string) => matchesKey(data, "down") || data === "down" || data === "\x1b[B" || data === "\x1bOB" || data === "j" || data === "J";
		const isEnter = (data: string) => matchesKey(data, "enter") || matchesKey(data, "return") || data === "enter" || data === "return" || data === "\r" || data === "\n";

		const handleInput = (data: string) => {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "escape" || data === "\x1b" || data === "q" || data === "Q") { close(); return; }
			if (isUp(data)) {
				state.selected = Math.max(0, state.selected - 1);
				tui.requestRender();
				return;
			}
			if (isDown(data)) {
				state.selected = Math.min(state.visible.length - 1, state.selected + 1);
				tui.requestRender();
				return;
			}
			if (data === "a" || data === "A") {
				state.showAll = !state.showAll;
				state.selected = 0;
				tui.requestRender();
				return;
			}
			if (isEnter(data)) {
				state.expanded = !state.expanded;
				tui.requestRender();
				return;
			}
		};

		// jump to startId if given
		if (startId) {
			const v = computeVisible(true);
			const idx = v.findIndex((e) => e.id === startId);
			if (idx >= 0) { state.showAll = true; state.visible = v; state.selected = idx; }
		}

		return { render, handleInput, invalidate: () => {}, dispose: cleanup };
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

function summaryText(): string {
	const all = registry.all();
	if (all.length === 0) return "No subagents.";
	const counts: Record<string, number> = {};
	for (const e of all) counts[e.status] = (counts[e.status] ?? 0) + 1;
	return `Subagents (${all.length}): ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}`;
}
