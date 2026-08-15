/**
 * Reminder Hook Extension
 *
 * A generic "park and resume" mechanism. The agent describes an arbitrary
 * completion condition as a shell command (exit 0 = done), optionally gated
 * by an absolute time or a countdown, and leaves a resume prompt for itself.
 * When the condition is met, the extension sends that prompt back to the
 * agent via `pi.sendUserMessage(..., { deliverAs: "followUp" })`, so the
 * agent wakes up and continues without anyone busy-polling by hand.
 *
 * Why one generic tool instead of many:
 *   Every "wait for X" reduces to a predicate. Time, PIDs, files, URLs, logs,
 *   market state, queue depth — all expressible as `bash -c` with exit code.
 *   Letting the agent write the predicate covers any future scenario without
 *   the extension growing new tool types.
 *
 * Persistence:
 *   Reminders live under pi's agent directory (getAgentDir()) so they survive
 *   /reload and pi restarts. They are re-armed on session_start; time-based
 *   reminders already due fire immediately, but conditions are NOT re-evaluated
 *   at that moment — a persisted predicate must not be replayed just because
 *   the session came back up. Their first check is one poll interval later.
 *
 * Tool:
 *   set_reminder  — schedule one reminder
 *   cancel_reminder — cancel by id
 * Commands:
 *   /reminders          — list pending
 *   /cancel-reminder <id>
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

interface Reminder {
	id: string;
	message: string; // resume prompt the agent left for itself
	label?: string;
	createdAt: number;

	// Trigger sources (any combination; all present must be satisfied):
	when?: number; // epoch ms — earliest time to fire / to start checking condition
	condition?: string; // shell command; exit 0 means satisfied

	// Behavior:
	pollSeconds?: number; // polling interval for condition (default 30)
	timeoutMs?: number; // hard cap; fires with timeout flag when elapsed
}

const DEFAULT_POLL_SECONDS = 30;

// State is session-scoped: each session keeps its own reminder list under
// <agent dir>/reminder-hook/sessions/<sessionId>/reminders.json. The wrapper
// records originalCwd so a path change (project moved / mounted elsewhere)
// is detectable instead of silently using stale-path assumptions.
interface ReminderStore {
	originalCwd: string;
	reminders: Reminder[];
}

function stateDir(sessionId: string): string {
	return path.join(getAgentDir(), "reminder-hook", "sessions", sessionId);
}
function stateFile(sessionId: string): string {
	return path.join(stateDir(sessionId), "reminders.json");
}
function loadReminders(sessionId: string): Reminder[] {
	try {
		const parsed = JSON.parse(fs.readFileSync(stateFile(sessionId), "utf-8"));
		return Array.isArray(parsed?.reminders) ? (parsed.reminders as Reminder[]) : [];
	} catch {
		return [];
	}
}
function saveReminders(cwd: string, sessionId: string, reminders: Reminder[]): void {
	// Reminder messages, predicates, and project paths may contain private
	// task content. Restrict file + dir to owner only (mode is masked by
	// umask, so 0o600 yields 0o600 under the default 0o22).
	const dir = stateDir(sessionId);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const store: ReminderStore = { originalCwd: cwd, reminders };
	fs.writeFileSync(stateFile(sessionId), JSON.stringify(store, null, 2), { mode: 0o600 });
}

function notifySystem(title: string, body: string): void {
	// OSC 777 is the primary channel — modern terminals (Windows Terminal,
	// WezTerm, iTerm2, kitty, ...) render it natively with no host binary,
	// so it works on every platform incl. Windows Home (no msg.exe).
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);

	// Optional native toast. These commands may be absent (msg.exe on Windows
	// Home, notify-send on a minimal box). spawn() reports "command not found"
	// asynchronously via the child's 'error' event, NOT via a synchronous
	// throw, so a bare try/catch will NOT catch it and the unhandled error
	// would crash the host process. Attach an 'error' listener to swallow it;
	// notifications are best-effort.
	let cmd: [string, string[]] | null = null;
	try {
		if (process.platform === "darwin") {
			cmd = ["osascript", ["-e", `display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`]];
		} else if (process.platform === "win32") {
			// msg.exe requires a session/user target and is missing on Home
			// editions; skip it and rely on OSC 777 + the shell's own toast.
			cmd = null;
		} else {
			cmd = ["notify-send", [title, body]];
		}
		if (cmd) {
			const child = spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" });
			child.on?.("error", () => { /* best-effort: command missing etc. */ });
			child.unref();
		}
	} catch {
		/* ignore */
	}
}

function parseTime(input: string): number {
	const now = new Date();
	const iso = Date.parse(input);
	if (!Number.isNaN(iso) && /\d{4}-\d{2}-\d{2}/.test(input)) return iso;
	const m = input.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
	if (m) {
		const target = new Date(now);
		target.setHours(+m[1], +m[2], +(m[3] ?? 0), 0);
		if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
		return target.getTime();
	}
	if (!Number.isNaN(iso)) return iso;
	throw new Error(`Cannot parse time: ${input}`);
}

export default function (pi: ExtensionAPI) {
	const baseDir = path.dirname(fileURLToPath(import.meta.url));

	// Co-locate this extension's skill with its code; register it so pi loads
	// the SKILL.md without a separate skills/ entry.
	pi.on("resources_discover", () => ({
		skillPaths: [path.join(baseDir, "SKILL.md")],
	}));

	// Each handle owns its stop() so we never confuse timer types.
	const handles = new Map<string, () => void>();
	function clearHandle(id: string): void {
		const stop = handles.get(id);
		if (stop) {
			try { stop(); } catch { /* ignore */ }
		}
		handles.delete(id);
	}
	function track(id: string, stop: () => void): void {
		handles.set(id, stop);
	}

	function fireReminder(ctx: ExtensionContext, r: Reminder, opts: { timeout?: boolean } = {}): void {
		clearHandle(r.id);
		const remaining = loadReminders(ctx.sessionManager.getSessionId()).filter((x) => x.id !== r.id);
		saveReminders(ctx.cwd, ctx.sessionManager.getSessionId(), remaining);
		pi.events.emit("wait:done", { source: "reminder-hook", id: r.id });

		const label = r.label ?? r.id;
		const tag = opts.timeout ? "⏰ TIMEOUT" : "⏰";
		notifySystem(`${tag} Pi reminder`, label);
		ctx.ui.notify(`${tag} reminder fired: ${label}`, opts.timeout ? "warning" : "info");

		const prefix = opts.timeout
			? `⏰ Reminder "${label}" TIMED OUT after waiting. Give up, change approach, or re-arm.\n\n`
			: `⏰ Reminder "${label}" fired.\n\n`;
		pi.sendUserMessage(prefix + r.message, { deliverAs: "followUp" });
	}

	// The condition executor. Windows has no `bash` by default, so we prefer
	// bash when present (Git Bash / WSL) and fall back to PowerShell. The
	// resolved shell is detected once per process and cached. Write your
	// `condition` predicate in the dialect of whichever shell is active — the
	// tool returns the active shell name so the agent knows what to emit.
	let resolvedShell: { command: string; shell: "bash" | "powershell" } | undefined;
	function resolveShell(): { command: string; shell: "bash" | "powershell" } {
		if (resolvedShell) return resolvedShell;
		if (process.platform !== "win32") {
			resolvedShell = { command: "bash", shell: "bash" };
			return resolvedShell;
		}
		// Windows: probe bash first. Git Bash ships a real `bash`, and WSL does
		// too. A short echo round-trip confirms it actually runs.
		try {
			const probe = spawnSync("bash", ["-c", "echo ok"], { timeout: 3000 });
			if (probe.status === 0 && probe.stdout?.toString().trim() === "ok") {
				resolvedShell = { command: "bash", shell: "bash" };
				return resolvedShell;
			}
		} catch {
			/* ignore — fall through to powershell */
		}
		resolvedShell = { command: "powershell", shell: "powershell" };
		return resolvedShell;
	}

	// Evaluate one reminder's condition. Returns true if satisfied.
	// The spawned child is tracked in `activeChildren` so cancel/shutdown/
	// timeout can kill it — otherwise a slow or hung predicate (curl without
	// --max-time, gh run watch) keeps running after the reminder is gone.
	const activeChildren = new Map<string, import("node:child_process").ChildProcess>();
	function checkCondition(r: Reminder): Promise<boolean> {
		return new Promise((resolve) => {
			if (!r.condition) {
				resolve(true);
				return;
			}
			const { command, shell } = resolveShell();
			const args = shell === "bash" ? ["-c", r.condition] : ["-NoProfile", "-Command", r.condition];
			const child = spawn(command, args, { stdio: "ignore" });
			activeChildren.set(r.id, child);
			const done = (ok: boolean) => { activeChildren.delete(r.id); resolve(ok); };
			child.on("exit", (code) => done(code === 0));
			child.on("error", () => done(false));
		});
	}

	/**
	 * Start polling one reminder.
	 *
	 * `immediate` decides whether the predicate runs right now or only after the
	 * first poll interval. A condition is arbitrary shell, so a freshly armed
	 * reminder checks at once (the agent expects an instant answer if it is
	 * already satisfied), but re-arming an existing one on session_start must
	 * NOT: that would re-run every persisted predicate on every restart /
	 * reload, executing whatever side effects they carry, unprompted.
	 */
	function arm(ctx: ExtensionContext, r: Reminder, { immediate }: { immediate: boolean }): void {
		const startedAt = Date.now();
		const intervalMs = Math.max(1, (r.pollSeconds ?? DEFAULT_POLL_SECONDS)) * 1000;

		// Time gate: earliest moment we may fire / start checking condition.
		const gate = r.when ?? 0;

		// setInterval does not await Promises, so without an in-flight guard a
		// slow condition (e.g. `gh run watch`, `curl` without --max-time) makes
		// overlapping ticks pile up — one per poll interval, unbounded.
		// `inFlight` collapses them to a single in-progress check.
		let inFlight = false;
		// `fired` makes fireReminder idempotent. It must be re-checked AFTER the
		// condition await returns: a timeout can fire while one tick is parked
		// on `await checkCondition`. Without this, the parked tick wakes up,
		// sees the condition true, and fires a second (un-flagged) followUp on
		// top of the TIMED OUT one.
		let fired = false;

		const tick = async () => {
			if (fired) return;
			// Not yet at the time gate? Wait.
			if (gate && Date.now() < gate) return;
			// Hard timeout cap. Must be checked before the inFlight guard:
			// otherwise a condition that never returns pins inFlight true and
			// timeout_minutes never trips.
			if (r.timeoutMs && Date.now() - Math.max(startedAt, gate || startedAt) > r.timeoutMs) {
				fired = true;
				fireReminder(ctx, r, { timeout: true });
				return;
			}
			if (inFlight) return;
			// No condition = pure time trigger: fire once gate is reached.
			if (!r.condition) {
				fired = true;
				fireReminder(ctx, r);
				return;
			}
			// Condition present: poll it. Re-check `fired` after the await — a
			// timeout may have fired while we were waiting.
			inFlight = true;
			try {
				if (await checkCondition(r) && !fired) {
					fired = true;
					fireReminder(ctx, r);
				}
			} finally {
				inFlight = false;
			}
		};

		if (immediate) tick();
		const iv = setInterval(tick, intervalMs);
		track(r.id, () => {
			clearInterval(iv);
			const child = activeChildren.get(r.id);
			if (child) {
				activeChildren.delete(r.id);
				try { child.kill("SIGTERM"); } catch { /* already exited */ }
			}
		});
	}

	function addReminder(ctx: ExtensionContext, r: Reminder): Reminder {
		const all = loadReminders(ctx.sessionManager.getSessionId());
		all.push(r);
		saveReminders(ctx.cwd, ctx.sessionManager.getSessionId(), all);
		arm(ctx, r, { immediate: true });
		pi.events.emit("wait:active", { source: "reminder-hook", id: r.id });
		return r;
	}

	function genId(): string {
		return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
	}

	// --- Lifecycle ---------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		// Remove the persistent widget used by older versions of /reminders.
		ctx.ui.setWidget?.("reminder-hook", undefined);
		const pending = loadReminders(ctx.sessionManager.getSessionId());
		for (const r of pending) {
			// Pure time reminder already due → fire immediately on reload. That is
			// a clock trigger with no side effects of its own, unlike a condition.
			if (!r.condition && r.when && r.when <= Date.now()) {
				fireReminder(ctx, r);
			} else {
				// Do not re-run the predicate here: wait out one poll interval.
				arm(ctx, r, { immediate: false });
				// Re-announce the wait. It is held in memory by whoever listens
				// (the todo nudge), so without this a restored reminder looks like
				// nothing is pending and the agent gets nudged while it is in fact
				// legitimately waiting.
				pi.events.emit("wait:active", { source: "reminder-hook", id: r.id });
			}
		}
		if (pending.length && ctx.hasUI) {
			ctx.ui.notify(`Reminder hook: ${pending.length} pending`, "info");
		}
	});

	pi.on("session_shutdown", async () => {
		for (const id of [...handles.keys()]) clearHandle(id);
	});

	// --- The one generic tool ----------------------------------------------

	pi.registerTool({
		name: "set_reminder",
		label: "Set reminder",
		description: [
			"Schedule a reminder that wakes you up later by sending your `message` back to you as a new user message. Use this whenever you'd otherwise block, sleep, or busy-poll.",
			"",
			"Provide a `condition` (a shell command — exit 0 means done) and/or `at` (absolute time) / `in_minutes`.",
			"`condition` is polled repeatedly until it succeeds, so write a pure test. Anything with side effects (writing files, deploying, posting) will happen once per poll — do that in the work you resume with, not in the predicate.",
			"",
			"Which shell runs `condition`: on macOS/Linux it is `bash`. On Windows the extension prefers bash if",
			"available (Git Bash / WSL) and otherwise falls back to PowerShell. Write the predicate in the dialect",
			"of the active shell — the tool response reports which one was used. Bash examples:",
			"  • process done:        ! pgrep -f 'webpack|cargo|make'",
			"  • file appeared:       [ -f dist/bundle.js ]",
			"  • url healthy:         curl -sf http://localhost:8080/health",
			"PowerShell equivalents (use these when the response says powershell):",
			"  • process done:        -not (Get-Process -Name webpack,cargo,make -ErrorAction SilentlyContinue)",
			"  • file appeared:       Test-Path dist/bundle.js",
			"  • url healthy:         try { (iwr http://localhost:8080/health -UseBasicParsing).StatusCode -eq 200 } catch { $false }",
			"  • any predicate:       anything bash or PowerShell can test",
			"",
			"If only `at`/`in_minutes` is given (no condition), fires once at that time.",
			"If both are given, waits until `at`, THEN starts polling `condition`.",
			"`timeout_minutes` caps the wait; on timeout you get the message flagged as timeout.",
		].join("\n"),
		parameters: Type.Object({
			message: Type.String({
				description:
					"Resume prompt to send back to yourself when the reminder fires. Write it as a self-directed instruction, e.g. 'Build finished — run the test suite and report failures.'",
			}),
			condition: Type.Optional(
				Type.String({
					description:
						"Shell command polled until it exits 0. Use for any completable condition (process exit, file, URL, log, time-of-day, queue, ...). Omit for a pure time trigger. On macOS/Linux it runs under `bash -c`; on Windows it prefers bash (Git Bash/WSL) and falls back to `powershell -NoProfile -Command`. The tool response reports the active shell — write the predicate in that shell's dialect.",
				}),
			),
			at: Type.Optional(
				Type.String({
					description:
						"Absolute time gate. 'HH:mm' (rolls to tomorrow if passed today), 'HH:mm:ss', or ISO datetime. With no condition: fires at this time. With condition: starts polling at this time.",
				}),
			),
			in_minutes: Type.Optional(
				Type.Number({ description: "Countdown gate in minutes from now. Same semantics as `at`." }),
			),
			poll_seconds: Type.Optional(
				Type.Number({ description: `Polling interval for condition. Default ${DEFAULT_POLL_SECONDS}s. Use a larger value for long waits (e.g. 300 for market open).` }),
			),
			timeout_minutes: Type.Optional(
				Type.Number({ description: "Hard cap. If the wait exceeds this, fires with a timeout flag so you can bail or re-arm." }),
			),
			label: Type.Optional(Type.String({ description: "Short human label for display/notification." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!params.condition && !params.at && params.in_minutes == null) {
				return {
					content: [{ type: "text", text: "Provide at least one of: condition, at, in_minutes." }],
					isError: true,
				};
			}
			let when: number | undefined;
			if (params.at) when = parseTime(params.at);
			else if (params.in_minutes != null) when = Date.now() + params.in_minutes * 60_000;

			const r: Reminder = {
				id: genId(),
				message: params.message,
				label: params.label,
				createdAt: Date.now(),
				when,
				condition: params.condition,
				pollSeconds: params.poll_seconds ?? DEFAULT_POLL_SECONDS,
				timeoutMs: params.timeout_minutes != null ? params.timeout_minutes * 60_000 : undefined,
			};
			addReminder(ctx, r);

			const parts: string[] = [`id ${r.id}`];
			if (when) parts.push(`gate ${new Date(when).toLocaleString()}`);
			if (r.condition) parts.push(`shell ${resolveShell().shell}`, `poll every ${r.pollSeconds}s: ${r.condition}`);
			if (r.timeoutMs) parts.push(`timeout ${r.timeoutMs / 60000}min`);
			return { content: [{ type: "text", text: `Reminder armed — ${parts.join(" | ")}. Stop now; you'll be woken automatically.` }] };
		},
	});

	pi.registerTool({
		name: "cancel_reminder",
		label: "Cancel reminder",
		description: "Cancel a pending reminder by id. List ids via /reminders.",
		parameters: Type.Object({ id: Type.String() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			clearHandle(params.id);
			const remaining = loadReminders(ctx.sessionManager.getSessionId()).filter((x) => x.id !== params.id);
			saveReminders(ctx.cwd, ctx.sessionManager.getSessionId(), remaining);
			pi.events.emit("wait:done", { source: "reminder-hook", id: params.id });
			return { content: [{ type: "text", text: `Cancelled ${params.id}.` }] };
		},
	});

	// --- Commands ----------------------------------------------------------

	pi.registerCommand("reminders", {
		description: "List pending reminders",
		handler: async (_args, ctx) => {
			const getAll = () => loadReminders(ctx.sessionManager.getSessionId());
			const initial = getAll();
			if (initial.length === 0) {
				ctx.ui.notify("No pending reminders", "info");
				return;
			}

			// Older versions rendered this command as a persistent widget above the
			// editor. Clear any such widget before opening a focused, closable view.
			ctx.ui.setWidget?.("reminder-hook", undefined);
			if (!ctx.hasUI || ctx.mode !== "tui") {
				const lines = initial.map((r) => {
					const when = r.when ? new Date(r.when).toLocaleString() : "-";
					return `${r.id}  gate=${when}  poll=${r.condition ?? "-"}  — ${r.label ?? ""}`;
				});
				ctx.ui.notify(["Pending reminders:", ...lines].join("\n"), "info");
				return;
			}

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const fg = theme.fg?.bind(theme);
				let lastSignature = "";
				const signature = () => getAll().map((r) => `${r.id}:${r.when ?? 0}:${r.condition ?? ""}:${r.label ?? ""}`).join("|");
				const refresh = setInterval(() => {
					const next = signature();
					if (next === lastSignature) return;
					lastSignature = next;
					tui.requestRender();
				}, 1000);
				const close = () => { clearInterval(refresh); done(undefined); };

				return {
					render(width: number) {
						const all = getAll();
						const innerWidth = Math.max(1, width - 2);
						const body: string[] = [];
						const title = `Pending reminders (${all.length})`;
						body.push(fg ? fg("toolTitle", title) : title);
						body.push("");
						if (all.length === 0) {
							body.push(fg ? fg("muted", "No pending reminders") : "No pending reminders");
						} else {
							for (const r of all) {
								const when = r.when ? new Date(r.when).toLocaleString() : "no time gate";
								body.push(`${r.id}  ${r.label ?? "(unlabelled)"}`);
								body.push(`  gate: ${when}`);
								body.push(`  poll: ${r.condition ?? "none"}`);
							}
						}
						body.push("");
						body.push(fg ? fg("muted", "esc/q/enter back") : "esc/q/enter back");

						// Overlay cells are transparent unless explicitly painted. A full-width
						// bordered box (including padded spaces) prevents conversation text from
						// showing through the reminder panel.
						const border = (s: string) => fg ? fg("border", s) : s;
						const lines = [border(`╭${"─".repeat(innerWidth)}╮`)];
						for (const line of body) {
							lines.push(border("│") + truncateToWidth(line, innerWidth, "…", true) + border("│"));
						}
						lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
						return lines;
					},
					handleInput(data: string) {
						if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "return") || data === "escape" || data === "enter" || data === "return" || data === "\x1b" || data === "\r" || data === "\n" || data === "q" || data === "Q") close();
					},
					invalidate() {},
				};
			}, {
				overlay: true,
				overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center", margin: 1 },
			});
		},
	});

	pi.registerCommand("cancel-reminder", {
		description: "Cancel a reminder by id",
		handler: async (args, ctx) => {
			const id = args.trim();
			if (!id) {
				ctx.ui.notify("Usage: /cancel-reminder <id>", "warning");
				return;
			}
			clearHandle(id);
			const remaining = loadReminders(ctx.sessionManager.getSessionId()).filter((x) => x.id !== id);
			saveReminders(ctx.cwd, ctx.sessionManager.getSessionId(), remaining);
			pi.events.emit("wait:done", { source: "reminder-hook", id });
			ctx.ui.notify(`Cancelled ${id}`, "info");
		},
	});
}
