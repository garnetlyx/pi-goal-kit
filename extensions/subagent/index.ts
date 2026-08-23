/**
 * Subagent orchestration extension.
 *
 * dispatch        — non-blocking delegation to a sub-model. Required params:
 *                   task (soft-warned if short), timeout (sec), permissions,
 *                   model ("provider/modelId"). Optional: name, role.
 * dispatch_status — list live/recent dispatches.
 * dispatch_cancel — cancel one by id.
 * /subagents      — open the TUI panel (list + selected output, ↑↓ a esc/q).
 *
 * Non-blocking: dispatch returns an id immediately. When the child finishes,
 * the resume text is injected into the current session via
 * pi.sendUserMessage(..., { deliverAs: "followUp" }) plus a system notification.
 *
 * Roles: user suggestions in subagent.json are advisory; the main
 * agent still explicitly chooses the current model/permissions/timeout.
 *
 * Concurrency: resource groups (defined in subagent.json) share
 * semaphores. Same group = serialized, different groups = parallel. Nothing
 * is hardcoded; users define provider→group and group→concurrency.
 *
 * Child guard: the env PI_SUBAGENT_CHILD=1 makes this extension a no-op inside
 * a spawned child, so subagents cannot dispatch sub-subagents.
 *
 * Hung detection: a watchdog scans the registry every 10s. If a running entry
 * hasn't produced output for hungThresholdSec, it flags it (warning only —
 * the main agent decides whether to cancel).
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	configPath,
	ensureConfigTemplate,
	loadConfig,
	resolveSystemPrompt,
	type Permissions,
} from "./config.ts";
import {
	type DispatchEntry,
	genId,
	markWaitDone,
	registry,
	splitModel,
} from "./scheduler.ts";
import { describePermissions, runChild } from "./runner.ts";
import { openSubagentsPanel } from "./panel.ts";
import {
	availableModelRecords,
	availableModels,
	matchHint,
} from "./models.ts";

export function sanitizeNotificationField(value: string, maxLength = 240): string {
	return value
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/;/g, ",")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, maxLength);
}

function notifySystem(title: string, body: string): void {
	const safeTitle = sanitizeNotificationField(title, 80);
	const safeBody = sanitizeNotificationField(body);
	// OSC 777 is a terminal protocol, so write it only to a real TTY and never
	// allow task text to inject delimiters, BEL, ESC, or other control bytes.
	if (process.stdout.isTTY) {
		process.stdout.write(`\x1b]777;notify;${safeTitle};${safeBody}\x07`);
	}

	// Optional native toast. These commands may be absent (e.g. msg.exe on
	// Windows Home, notify-send on a minimal box). spawn() reports "command
	// not found" asynchronously via the child's 'error' event, NOT via a
	// synchronous throw, so a bare try/catch will NOT catch it and the
	// unhandled error would crash the host process. We attach an 'error'
	// listener to swallow that case; notifications are best-effort.
	let cmd: [string, string[]] | null = null;
	try {
		if (process.platform === "darwin") {
			const script = "on run argv\n display notification (item 2 of argv) with title (item 1 of argv)\nend run";
			cmd = ["osascript", ["-e", script, "--", safeTitle, safeBody]];
		} else if (process.platform === "win32") {
			// msg.exe requires a session/user target and is missing on Home
			// editions; skip it and rely on OSC 777 + the shell's own toast.
			cmd = null;
		} else {
			cmd = ["notify-send", [safeTitle, safeBody]];
		}
		if (cmd) {
			const child = spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" });
			child.on?.("error", () => { /* best-effort: command missing etc. */ });
			child.unref();
		}
	} catch { /* ignore */ }
}





export default function (pi: ExtensionAPI) {
	// Child guard: subagents must not spawn sub-subagents.
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	const baseDir = dirname(fileURLToPath(import.meta.url));

	// Contribute this extension's bundled SKILL.md so the main agent sees the
	// subagent skill without a separate entry under skills/. Keeps the skill
	// co-located with the extension code it documents.
	pi.on("resources_discover", () => ({
		skillPaths: [join(baseDir, "SKILL.md")],
	}));

	let watchdogTimer: ReturnType<typeof setInterval> | null = null;

	pi.on("session_start", async (_event, ctx) => {
		ensureConfigTemplate(ctx);
		const cfg = loadConfig(ctx);
		// Start watchdog.
		if (!watchdogTimer) {
			watchdogTimer = setInterval(() => {
				const now = Date.now();
				for (const e of registry.live()) {
					if (e.status !== "running") continue;
					const idle = now - e.lastActivityAt;
					if (idle > cfg.defaults.hungThresholdSec * 1000 && !e.warning) {
						e.warning = `no output for ${Math.floor(idle / 1000)}s (possibly hung)`;
						e.status = "hung";
						registry.changed();
						if (ctx.hasUI) {
							notifySystem("⚠️ Pi subagent hung", e.name);
							ctx.ui.notify(`⚠️ subagent "${e.name}" possibly hung (no output ${Math.floor(idle / 1000)}s)`, "warning");
						}
					}
				}
				registry.gc(cfg.defaults.retainCompletedSec);
			}, 10_000);
		}
	});

	const finishWait = (entry: DispatchEntry) => {
		if (markWaitDone(entry)) pi.events.emit("wait:done", { source: "subagent", id: entry.id });
	};

	const deliverCompletion = (entry: DispatchEntry, ctx: ExtensionContext) => {
		const finalStatus = entry.status;
		if (finalStatus === "cancelled" || entry.completionDelivered) return;
		const retryNote = (entry.retryAttempts ?? 0) > 0 ? ` (auto-retried ${entry.retryAttempts}×)` : "";
		const stderrTail = (entry as any).stderr ? String((entry as any).stderr).slice(-600).trim() : "";
		const out = entry.finalOutput || entry.errorMessage || (stderrTail ? `stderr: ${stderrTail}` : "(no output)");
		const tag = finalStatus === "done" ? "✓" : finalStatus === "timeout" ? "⏱ TIMEOUT" : finalStatus === "hung" ? "⚠ HUNG" : "✗ FAILED";
		const resume =
			`↩️ Subagent "${entry.name}" (${entry.model}) finished [${tag}]${retryNote}.\n` +
			`Task: ${entry.task}\n\n--- output ---\n${out}\n--- end ---\n\n` +
			`⚠️ This is UNVERIFIED output. Re-check any file changes / commands / key facts before relying on them. (id ${entry.id})`;
		if (ctx.hasUI) {
			try { notifySystem(`↩️ Pi subagent ${finalStatus}`, `${entry.name}: ${entry.task.slice(0, 80)}`); } catch { /* best-effort */ }
			try { ctx.ui.notify(`subagent "${entry.name}" ${finalStatus}`, finalStatus === "done" ? "info" : "warning"); } catch { /* best-effort */ }
		}
		pi.sendUserMessage(resume, { deliverAs: "followUp" });
		entry.completionDelivered = true;
	};

	pi.on("session_shutdown", async () => {
		if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
		for (const e of registry.live()) {
			e.status = "cancelled";
			e.endedAt = Date.now();
			try { e.abort?.(); } catch { /* ignore */ }
			try { e.kill?.(); } catch { /* ignore */ }
			finishWait(e);
		}
		registry.changed();
	});

	// ---------------- dispatch tool ----------------

	const PermissionsSchema = Type.Union(
		[
			Type.Literal("readonly"),
			Type.Literal("junior"),
			Type.Literal("full"),
			Type.Array(Type.String()),
		],
		{
			description:
				"Capability gate. readonly=read/grep/find/ls/bash; junior=+write/edit; full=all tools; or an explicit tool whitelist array like [\"read\",\"grep\"]. Pick the minimum the task needs.",
		},
	);

	pi.registerTool({
		name: "subagent_roles",
		label: "Subagent role suggestions",
		description: [
			`List user-configured subagent roles from ${configPath()}, AND list the models currently available in this session (provider/modelId).`,
			"Use this as the discovery tool before dispatch: it returns the session catalogue so you can pick a concrete model instead of guessing.",
			"Model hints are advisory intent labels (may be fuzzy like 'GPT' or 'claude'), not exact IDs — the output shows which hints match a currently available model.",
			"Suggestions are advisory; use current user/session requirements for the explicit dispatch parameters.",
		].join("\n"),
		parameters: Type.Object({
			role: Type.Optional(Type.String({ description: "If set, show full details (including the complete system prompt that would be injected) for this single role. Omit to list all roles as a summary." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const cfg = loadConfig(ctx);
			const names = Object.keys(cfg.roles).sort();
			const records = availableModelRecords(ctx);
			const catalogue = records.map((m) => `${m.provider}/${m.id}`);
			const catalogueBlock = catalogue.length > 0
				? `${catalogue.slice(0, 60).join("\n")}${catalogue.length > 60 ? `\n... (${catalogue.length - 60} more)` : ""}`
				: "(none — no models discovered; the child Pi will surface any auth error if you dispatch anyway)";
			if (names.length === 0) return { content: [{ type: "text", text: `No roles configured. Choose model, permissions, and timeout directly from the current session requirements.\n\nCurrently available models in this session:\n${catalogueBlock}` }], details: {} };

			const hintLine = (hints: string[]): string => {
				if (hints.length === 0) return "none";
				return hints.map((h) => {
					const matches = matchHint(h, records);
					return matches.length > 0
						? `${h} → ${matches.map((m) => `${m.provider}/${m.id}`).slice(0, 5).join(", ")}`
						: `${h} (no match in session)`;
				}).join(", ");
			};

			const summarize = (name: string): string => {
				const role = cfg.roles[name];
				const hints = role?.suggestedModels ?? [];
				const resolved = resolveSystemPrompt(role);
				const promptLabel = resolved.source === "default"
					? "default generic prompt"
					: `${resolved.source} override, ${resolved.prompt.length} chars (pass role="${name}" to view in full)`;
				return [
					`${name}: ${role?.description ?? ""}`,
					`  model hints (advisory, fuzzy ok): ${hintLine(hints)}`,
					`  preferences: permissions=${Array.isArray(role?.permissions) ? role.permissions.join(",") : role?.permissions ?? "none"}, suggested timeout=${role?.timeoutSec ?? 900}s`,
					`  system prompt: ${promptLabel}`,
				].join("\n");
			};

			if (params.role) {
				const name = params.role;
				if (!names.includes(name)) {
					return { content: [{ type: "text", text: `Unknown role "${name}". Available: ${names.join(", ") || "(none)"}` }], details: {}, isError: true };
				}
				const role = cfg.roles[name];
				const resolved = resolveSystemPrompt(role);
				const hints = role?.suggestedModels ?? [];
				const detail = [
					`${name}: ${role?.description ?? ""}`,
					`  model hints (advisory, fuzzy ok): ${hintLine(hints)}`,
					`  preferences: permissions=${Array.isArray(role?.permissions) ? role.permissions.join(",") : role?.permissions ?? "none"}, suggested timeout=${role?.timeoutSec ?? 900}s`,
					`  system prompt source: ${resolved.source}`,
					`  system prompt (full):`,
					resolved.prompt,
				].join("\n");
				return { content: [{ type: "text", text: `${detail}\n\nThis is the system prompt that would be injected by default. To pass it through unchanged, omit the dispatch systemPrompt param. To modify it, pass your version via dispatch systemPrompt.\n\nCurrently available models in this session:\n${catalogueBlock}` }], details: {} };
			}

			return { content: [{ type: "text", text: `${names.map(summarize).join("\n")}\n\nThese are user suggestions, not constraints. The final dispatch model/permissions/timeout must be explicit and may differ for the current task or user request.\n\nCurrently available models in this session (use these for dispatch's model param):\n${catalogueBlock}` }], details: {} };
		},
	});

	pi.registerTool({
		name: "dispatch",
		label: "Dispatch subagent",
		description: [
			"Delegate a task to a sub-model as a non-blocking subagent. Returns immediately with an id; you'll be woken when it finishes.",
			"REQUIRED: detailed task, timeout, minimum permissions, and an explicit model (provider/modelId).",
			`OPTIONAL: role selects a role description plus user suggestions from ${configPath()}; name is a display label.`,
			"The role's default system prompt is injected as-is UNLESS you pass systemPrompt — inspect it first via subagent_roles (role param) and decide whether to pass it through, edit it, or replace it.",
			"Role suggestedModels are advisory intent hints (may be fuzzy labels, not exact IDs), never an allowlist or automatic choice. Resolve hints against the current session catalogue; if none fit, explicitly choose another suitable available model.",
			"Results are UNVERIFIED — independently re-check file changes, commands, and key facts before relying on them. You cannot dispatch from inside a subagent.",
		].join("\n"),
		parameters: Type.Object({
			task: Type.String({
				description: "Detailed task for the subagent. Include goal, context, constraints, and the exact output format you want back. Vague tasks waste a full model round-trip.",
			}),
			timeout: Type.Number({
				exclusiveMinimum: 0,
				description: "Timeout in seconds for each phase: the dispatch may wait up to this long for a resource-group slot, then the started child may run for up to this long. Worst-case wall time is 2× timeout. Local/quantized models often need 600-1800s of execution time; cloud APIs 60-300s for most tasks.",
			}),
			permissions: PermissionsSchema,
			model: Type.String({
				description: 'Model to delegate to, as "provider/modelId". Must be available in the current session catalogue.',
			}),
			name: Type.Optional(Type.String({ description: "Display name for this subagent (shown in /subagents and notifications)." })),
			role: Type.Optional(Type.String({ description: "Optional work role. Its prompt and user preferences are advisory; you still explicitly decide model, permissions, and timeout." })),
			systemPrompt: Type.Optional(Type.String({ description: "Override the role's default system prompt. By default the role's user prompt (if set in subagent.json) or the generic default is injected; pass this to pass through a modified version, replace it, or supply one for an ad-hoc dispatch. Inspect the role's default via subagent_roles (role param) first." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const cfg = loadConfig(ctx);
			const roleName = params.role;
			const role = roleName ? cfg.roles[roleName] : undefined;
			if (roleName && !role) {
				const roles = Object.keys(cfg.roles);
				return { content: [{ type: "text", text: `Unknown role "${roleName}". Available: ${roles.join(", ") || "(none)"}` }], details: {}, isError: true };
			}

			// Explicit main-agent decisions. Role fields remain advice and prompt
			// selection; they never silently choose model/permissions/timeout.
			const permissions: Permissions = params.permissions;
			const modelArg = params.model;
			const timeout = params.timeout;
			const { provider, modelId } = splitModel(modelArg);
			if (!modelId) {
				return { content: [{ type: "text", text: `model must be "provider/modelId", got "${modelArg}".` }], details: {}, isError: true };
			}

			const catalogue = availableModels(ctx);
			if (catalogue.length > 0 && !catalogue.includes(modelArg)) {
				return {
					content: [{ type: "text", text: `Model "${modelArg}" is not available in this session. Available models: ${catalogue.slice(0, 30).join(", ") || "(none)"}. Choose explicitly based on the current task/user request and retry.` }],
					details: {},
					isError: true,
				};
			}
			// Role timeout is advisory; the explicit dispatch timeout always wins.
			// No warning on override — local/quantized models routinely need far
			// longer than a role's suggested value, and nagging misleads the main
			// agent into setting too small a timeout.

			// Resource mapping is operational configuration, not model selection.
			const group = registry.resolveGroup(cfg, provider, role?.resourceGroup);
			const sem = registry.semaphoreFor(cfg, group);

			const id = genId();
			const name = params.name ?? (roleName ? `${roleName}-${id.slice(-4)}` : `${provider}-${id.slice(-4)}`);
			const abortController = new AbortController();
			const entry: DispatchEntry = {
				id, name, role: roleName, model: modelArg, provider, task: params.task,
				permissionsLabel: describePermissions(permissions), group,
				startedAt: Date.now(), lastActivityAt: Date.now(),
				status: "queued", messages: [],
				abort: () => abortController.abort(),
			};
			registry.add(entry);
			pi.events.emit("wait:active", { source: "subagent", id: entry.id });

			// Soft task-length nudge.
			const shortTask = params.task.trim().length < 40;
			if (shortTask) {
				ctx.ui.notify(`dispatch "${name}": task is short — consider adding detail for better results`, "warning");
			}

			// Fire and forget. Queue waiting is bounded by the explicit timeout; once
			// the child starts, runChild applies the same timeout to actual execution.
			let slotHeld = false;
			const releaseSlot = () => {
				if (!slotHeld) return;
				slotHeld = false;
				sem.release();
			};
			void (async () => {
				const queueTimer = setTimeout(() => abortController.abort(), timeout * 1000);
				try {
					await sem.acquire(abortController.signal);
					slotHeld = true;
				} catch (error) {
					if ((error as Error)?.name === "AbortError" && entry.status === "queued") {
						entry.status = "timeout";
						entry.stopReason = "queue_timeout";
						entry.errorMessage = `timed out waiting ${timeout}s for resource group "${group}"`;
						entry.endedAt = Date.now();
						registry.changed();
						finishWait(entry);
						deliverCompletion(entry, ctx);
					} else if ((error as Error)?.name !== "AbortError") {
						entry.status = "failed";
						entry.errorMessage = error instanceof Error ? error.message : String(error);
						entry.endedAt = Date.now();
						registry.changed();
						finishWait(entry);
						deliverCompletion(entry, ctx);
					}
					return;
				} finally {
					clearTimeout(queueTimer);
				}
				if (entry.status === "cancelled") { releaseSlot(); return; }
				entry.status = "running";
				entry.lastActivityAt = Date.now();
				registry.changed();
				try {
					await runChild({
						pi, ctx, entry, modelArg,
						permissions,
						systemPrompt: params.systemPrompt ?? resolveSystemPrompt(role).prompt,
						timeoutSec: timeout,
						signal: abortController.signal,
					});
				} catch (err: any) {
					entry.status = "failed";
					entry.errorMessage = err?.message ?? String(err);
					entry.endedAt = Date.now();
					registry.changed();
				} finally {
					releaseSlot();
				}
				finishWait(entry);
				deliverCompletion(entry, ctx);
			})().catch((error) => {
				releaseSlot();
				if (entry.status !== "cancelled") {
					entry.status = "failed";
					entry.errorMessage ||= error instanceof Error ? error.message : String(error);
					entry.endedAt ||= Date.now();
				}
				try { registry.changed(); } catch { /* a listener caused the rejection */ }
				try { finishWait(entry); } catch { /* event listeners are external */ }
				try { deliverCompletion(entry, ctx); } catch { /* host reports delivery errors separately */ }
			});

			return {
				content: [{
					type: "text",
					text: `Dispatched "${name}" (id ${id}) → ${modelArg}${roleName ? ` [role ${roleName}]` : ""} [group ${group}, perms ${entry.permissionsLabel}]. Model was explicitly selected by the main agent; role suggestions are advisory. Non-blocking — you'll be woken on completion. Status: /subagents.`,
				}],
				details: {},
			};
		},
	});

	// ---------------- status / cancel ----------------

	pi.registerTool({
		name: "dispatch_status",
		label: "Subagent status",
		description: "List live and recently-finished subagents. Use to check progress or get an id for dispatch_cancel.",
		parameters: Type.Object({}),
		async execute() {
			const all = registry.all();
			if (all.length === 0) return { content: [{ type: "text", text: "No subagents yet." }], details: {} };
			const lines = all.map((e) => {
				const dur = e.endedAt ? Math.floor((e.endedAt - e.startedAt) / 1000) : Math.floor((Date.now() - e.startedAt) / 1000);
				return `${e.status.padEnd(8)} ${e.id}  ${e.name}  ${e.model}  ${dur}s${e.warning ? "  " + e.warning : ""}`;
			});
			return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
		},
	});

	pi.registerTool({
		name: "dispatch_cancel",
		label: "Cancel subagent",
		description: "Cancel a running subagent by id (SIGTERM).",
		parameters: Type.Object({ id: Type.String() }),
		async execute(_id, params) {
			const e = registry.get(params.id);
			if (!e) return { content: [{ type: "text", text: `No such id ${params.id}.` }], details: {} };
			if (e.status !== "queued" && e.status !== "running" && e.status !== "hung") {
				return { content: [{ type: "text", text: `${params.id} already ${e.status}.` }], details: {} };
			}
			e.status = "cancelled";
			e.endedAt = Date.now();
			try { e.abort?.(); } catch { /* ignore */ }
			try { e.kill?.(); } catch { /* ignore */ }
			finishWait(e);
			registry.changed();
			return { content: [{ type: "text", text: `Cancelled ${params.id}.` }], details: {} };
		},
	});

	// ---------------- /subagents panel ----------------

	pi.registerCommand("subagents", {
		description: "Open the subagents panel: list + live output of the selected entry. Args: [all | <id>]",
		handler: async (args, ctx) => {
			await openSubagentsPanel(pi, ctx, args.trim() || undefined);
		},
	});
}
