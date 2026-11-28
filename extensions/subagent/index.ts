/**
 * Subagent orchestration extension.
 *
 * dispatch        — non-blocking delegation to a sub-model. Required params:
 *                   task (soft-warned if short), timeout (sec), permissions,
 *                   model ("provider/modelId"). Optional: name, role.
 * dispatch_status — list live/recent dispatches.
 * dispatch_cancel — cancel one by id.
 * /subagents      — open the TUI panel (list + selected output, ↑↓ a esc/q).
 * /subagent       — user-picked model + prompt: the model argument completes
 *                   from the session catalogue, the pick grants a one-time
 *                   blacklist override for exactly that model, and the agent
 *                   dispatches it.
 *
 * Non-blocking: dispatch returns an id immediately. When the child finishes,
 * the resume text is injected into the current session as a follow-up plus a
 * system notification. Delivery goes through the compaction-safe sink in
 * ./follow-up.ts: a completion that lands while the user is mid-/compact is
 * held until compaction ends instead of being rejected.
 *
 * Roles: user suggestions in subagent.json are advisory; the role's
 * models.suggested list is binding - the main agent picks from it when the
 * role has one. A top-level models.blacklist fences the agent's autonomous
 * dispatch: blacklisted models (case-insensitive substring on provider/id or
 * display name) are refused by the dispatch tool and hidden from the
 * subagent_roles catalogue. Human model picks (e.g. the gated-goal reviewer
 * picker) are never filtered; a /subagent pick is exempt for that one
 * dispatch through a one-time override bound to the picked model.
 * The main agent still explicitly chooses permissions/timeout.
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
	blockedBy,
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
import { describePermissions, normalizePermissions, runChild } from "./runner.ts";
import { openSubagentsPanel } from "./panel.ts";
import { registerSubagentCommand, setModelRegistry } from "./command.ts";
import { takeModelOverride } from "./override.ts";
import { createFollowUpSink } from "./follow-up.ts";

import {
	availableModelRecords,
	dispatchableModelRecords,
	matchHint,
	type AvailableModel,
} from "./models.ts";

/** Hints for a dispatch context: the role's models.suggested first, then the
 *  global models.suggested as fallback. Deduped, order preserved. */
function hintsFor(cfg: ReturnType<typeof loadConfig>, role: ReturnType<typeof loadConfig>["roles"][string] | undefined): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const hint of [...(role?.models?.suggested ?? []), ...cfg.models.suggested]) {
		if (seen.has(hint)) continue;
		seen.add(hint);
		out.push(hint);
	}
	return out;
}

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
	// Completions land from the child's exit callback, which cannot know whether
	// the user is mid-/compact; the sink holds what pi would reject until it ends.
	const followUp = createFollowUpSink(pi);

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
		// The /subagent completion runs outside any handler, so it needs the
		// session's model registry.
		setModelRegistry(ctx.modelRegistry);
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
		followUp.say(resume);
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
		// The registry object is process-wide (shared with gated-goal), but its
		// entries belong to the runtime being torn down. Pi fires this for
		// /new, /resume, /fork and /reload, then loads fresh extension
		// instances for the next session; without the clear, that session's
		// /subagents, dispatch_status and dispatch_cancel would keep listing
		// this session's subagents until gc() aged them out.
		registry.clear();
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
				"Capability gate. readonly=read/grep/find/ls/bash; junior=+write/edit; full=all tools; or an explicit tool whitelist array like [\"read\",\"grep\"]. Array elements must be tool names of this session — unknown names are refused with the list of valid names. Pick the minimum the task needs.",
		},
	);

	pi.registerTool({
		name: "subagent_roles",
		label: "Subagent role suggestions",
		description: [
			`List user-configured subagent roles from ${configPath()}, AND list the models currently available in this session (provider/modelId).`,
			"Use this as the discovery tool before dispatch: it returns the session catalogue so you can pick a concrete model instead of guessing.",
			"Models matching models.blacklist in subagent.json are excluded from the catalogue and from suggestion resolution — they cannot be dispatched as subagents.",
			"Model hints are intent labels (may be fuzzy like 'GPT' or 'claude'), not exact IDs — the output shows which hints match a currently available model and names the preferred pick.",
			"When dispatching with a role, default to its 'preferred model now'. Choose a different model only when the user explicitly requested one this turn, no hint matches the session, or the matches lack a capability the task requires.",
		].join("\n"),
		parameters: Type.Object({
			role: Type.Optional(Type.String({ description: "If set, show full details (including the complete system prompt that would be injected) for this single role. Omit to list all roles as a summary." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const cfg = loadConfig(ctx);
			const names = Object.keys(cfg.roles).sort();
			const allRecords = availableModelRecords(ctx);
			const records = dispatchableModelRecords(ctx, cfg);
			const hiddenCount = allRecords.length - records.length;
			const blacklistNote = hiddenCount > 0
				? `\n(${hiddenCount} model${hiddenCount === 1 ? "" : "s"} hidden by models.blacklist in subagent.json — not dispatchable)`
				: "";
			const catalogue = records.map((m) => `${m.provider}/${m.id}`);
			const catalogueBlock = catalogue.length > 0
				? `${catalogue.slice(0, 60).join("\n")}${catalogue.length > 60 ? `\n... (${catalogue.length - 60} more)` : ""}${blacklistNote}`
				: `(none dispatchable${allRecords.length > 0 ? ` — all ${allRecords.length} excluded by models.blacklist` : " — no models discovered; the child Pi will surface any auth error if you dispatch anyway)"}`;
			if (names.length === 0) return { content: [{ type: "text", text: `No roles configured. Choose model, permissions, and timeout directly from the current session requirements${cfg.models.suggested.length > 0 ? `, preferring models.suggested order` : ""}.\n\nCurrently available models in this session:\n${catalogueBlock}` }], details: {} };

			const hintLine = (hints: string[]): string => {
				if (hints.length === 0) return "none";
				return hints.map((h) => {
					const matches = matchHint(h, allRecords);
					const allowed = matches.filter((m) => !blockedBy(cfg, m));
					if (allowed.length > 0) {
						return `${h} → ${allowed.map((m) => `${m.provider}/${m.id}`).slice(0, 5).join(", ")}`;
					}
					if (matches.length > 0) return `${h} (all matches excluded by blacklist)`;
					return `${h} (no match in session)`;
				}).join(", ");
			};

			const preferredModel = (hints: string[]): string | undefined => {
				for (const h of hints) {
					const allowed = matchHint(h, allRecords).filter((m) => !blockedBy(cfg, m));
					if (allowed.length > 0) return `${allowed[0].provider}/${allowed[0].id}`;
				}
				return undefined;
			};

			const summarize = (name: string): string => {
				const role = cfg.roles[name];
				const hints = hintsFor(cfg, role);
				const resolved = resolveSystemPrompt(role);
				const promptLabel = resolved.source === "default"
					? "default generic prompt"
					: `${resolved.source} override, ${resolved.prompt.length} chars (pass role="${name}" to view in full)`;
				return [
					`${name}: ${role?.description ?? ""}`,
					`  model hints (role models.suggested first, global fallback; pick from these when dispatching this role): ${hintLine(hints)}`,
					`  preferred model now: ${preferredModel(hints) ?? "none of the hints match this session"}`,
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
				const hints = hintsFor(cfg, role);
				const detail = [
					`${name}: ${role?.description ?? ""}`,
					`  model hints (role models.suggested first, global fallback; pick from these when dispatching this role): ${hintLine(hints)}`,
					`  preferred model now: ${preferredModel(hints) ?? "none of the hints match this session — pick another suitable model"}`,
					`  preferences: permissions=${Array.isArray(role?.permissions) ? role.permissions.join(",") : role?.permissions ?? "none"}, suggested timeout=${role?.timeoutSec ?? 900}s`,
					`  system prompt source: ${resolved.source}`,
					`  system prompt (full):`,
					resolved.prompt,
				].join("\n");
				return { content: [{ type: "text", text: `${detail}\n\nThis is the system prompt that would be injected by default. To pass it through unchanged, omit the dispatch systemPrompt param. To modify it, pass your version via dispatch systemPrompt.\n\nCurrently available models in this session:\n${catalogueBlock}` }], details: {} };
			}

			return { content: [{ type: "text", text: `${names.map(summarize).join("\n")}\n\nWhen dispatching with a role, pick its model from the hint matches — 'preferred model now' is the default answer, earlier hints preferred. Deviate only when the user explicitly requested a model this turn, no hint matches, or the matches lack a capability the task needs. Permissions and timeout remain your explicit decision.\n\nCurrently available models in this session (use these for dispatch's model param):\n${catalogueBlock}` }], details: {} };
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
			"Role models.suggested are binding preferences (hints may be fuzzy labels - resolve them against the current session catalogue). When a dispatched role has models.suggested, select its model from that list, earlier entries preferred; the global models.suggested is the fallback when the role gives none. Choose outside the list only when the user explicitly requested a model this turn, or every suggestion is unavailable or lacks a required capability. Never invent an unavailable model.",
			"Models matching models.blacklist in subagent.json (case-insensitive substring on provider/id or display name) are refused as subagents — pick from the allowed catalogue and retry.",
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
			role: Type.Optional(Type.String({ description: "Optional work role. Its systemPrompt and permission/timeout preferences are advisory - adapt them as the task and model require (e.g., raise the timeout for slow local models); its models.suggested are binding - pick from them when present." })),
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
			// pi-ai coerces scalars into arrays for union-typed parameters, so the
			// schema alone lets a JSON-encoded whitelist or a bare preset through
			// as a one-element "tool name" list (see normalizePermissions).
			const parsedPermissions = normalizePermissions(params.permissions, pi.getAllTools().map((tool) => tool.name));
			if (!parsedPermissions.ok) {
				return { content: [{ type: "text", text: parsedPermissions.error }], details: {}, isError: true };
			}
			const permissions: Permissions = parsedPermissions.permissions;
			const modelArg = params.model;
			const timeout = params.timeout;
			const { provider, modelId } = splitModel(modelArg);
			if (!modelId) {
				return { content: [{ type: "text", text: `model must be "provider/modelId", got "${modelArg}".` }], details: {}, isError: true };
			}

			const catalogueRecords = availableModelRecords(ctx);
			const catalogue = catalogueRecords.map((m) => `${m.provider}/${m.id}`);
			if (catalogue.length > 0 && !catalogue.includes(modelArg)) {
				return {
					content: [{ type: "text", text: `Model "${modelArg}" is not available in this session. Available models: ${catalogue.slice(0, 30).join(", ") || "(none)"}. Choose explicitly based on the current task/user request and retry.` }],
					details: {},
					isError: true,
				};
			}
			// Blacklist hard gate: fences the agent's autonomous choice only.
			// Human picks (gated-goal reviewer picker, reviewer spawn) never pass
			// through this tool, so they are exempt by construction.
			const matched = catalogueRecords.find((m) => `${m.provider}/${m.id}` === modelArg);
			const blacklistPattern = blockedBy(cfg, matched ?? { provider, id: modelId });
			// A user pick via /subagent grants a one-time override for exactly
			// this model; every other blacklisted model stays refused.
			const userPicked = takeModelOverride(modelArg);
			if (blacklistPattern && !userPicked) {
				const allowed = dispatchableModelRecords(ctx, cfg).map((m) => `${m.provider}/${m.id}`);
				const roleHints = role?.models?.suggested ?? [];
				const roleNote = roleHints.length > 0
					? `\nRole "${roleName}" models.suggested (filtered): ${roleHints.join(", ")}`
					: "";
				return {
					content: [{ type: "text", text: `Model "${modelArg}" is blocked by models.blacklist in subagent.json (matched pattern "${blacklistPattern}") and cannot be dispatched as a subagent. Do not retry this model — re-dispatch with one of the allowed models below, honoring the role's models.suggested where applicable.${roleNote}\nAllowed models: ${allowed.slice(0, 30).join(", ") || "(none)"}${allowed.length > 30 ? ` ... (${allowed.length - 30} more)` : ""}` }],
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
					text: `Dispatched "${name}" (id ${id}) → ${modelArg}${roleName ? ` [role ${roleName}]` : ""} [group ${group}, perms ${entry.permissionsLabel}].${userPicked ? " User-picked model: the models.blacklist fence was overridden once for this dispatch." : " Model chosen by the main agent, from the role's models.suggested where applicable."} Non-blocking — you'll be woken on completion. Status: /subagents.`,
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

	// ---------------- /subagent command ----------------

	registerSubagentCommand(pi);

	// ---------------- /subagents panel ----------------

	pi.registerCommand("subagents", {
		description: "Open the subagents panel: list + live output of the selected entry. Args: [all | <id>]",
		handler: async (args, ctx) => {
			await openSubagentsPanel(pi, ctx, args.trim() || undefined);
		},
	});
}
