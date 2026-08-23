/**
 * Child-process runner for a single dispatched subagent.
 *
 * Spawns `pi --mode json -p --no-session` with an isolated system prompt,
 * model, and tool whitelist. Streams JSON events into the registry entry.
 * Honors an overall timeout (SIGTERM -> SIGKILL) and updates lastActivityAt
 * on every event so the watchdog can detect hung children.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type Permissions } from "./config.ts";
import { captureMessage, type DispatchEntry, getFinalOutput, registry } from "./scheduler.ts";

/** Read-only/network extensions whose tools are safe to expose alongside the
 *  builtin readonly/junior sets (they don't mutate the workspace). */
const SAFE_EXTENSION_TOOLS = ["web_search", "web_fetch"];

/** Map a Permissions spec to a pi `--tools` whitelist (undefined = all tools).
 *  readonly/junior intentionally expose read-only builtin tools plus the
 *  safe network extension tools (web_search/web_fetch) so that research-style
 *  subagents can fetch the web without being handed write/edit.
 *
 *  Caveat: `readonly` withholds the write/edit *tools*, but it still includes
 *  `bash`, which is not sandboxed — a child that ignores its instructions can
 *  still modify the workspace through a shell command. Treat `readonly` as
 *  "no editing tools + an instruction not to write", not as an enforced
 *  boundary. Pass an explicit whitelist without `bash` if you need a hard one. */
function permissionsToTools(perm: Permissions): string[] | undefined {
	if (perm === "full") return undefined;
	if (perm === "readonly") return ["read", "grep", "find", "ls", "bash", ...SAFE_EXTENSION_TOOLS];
	if (perm === "junior") return ["read", "grep", "find", "ls", "bash", "write", "edit", ...SAFE_EXTENSION_TOOLS];
	// string[] = explicit whitelist
	return perm;
}

export function describePermissions(perm: Permissions): string {
	if (Array.isArray(perm)) return `tools:${perm.join(",")}`;
	return perm;
}

export function createProcessTerminator(
	proc: Pick<import("node:child_process").ChildProcess, "kill">,
	forceAfterMs = 5000,
): { terminate: () => void; markClosed: () => void } {
	let closed = false;
	let terminating = false;
	let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
	return {
		terminate() {
			if (closed || terminating) return;
			terminating = true;
			try { proc.kill("SIGTERM"); } catch { /* ignore */ }
			forceKillTimer = setTimeout(() => {
				if (closed) return;
				try { proc.kill("SIGKILL"); } catch { /* ignore */ }
			}, forceAfterMs);
		},
		markClosed() {
			closed = true;
			if (forceKillTimer) clearTimeout(forceKillTimer);
		},
	};
}

async function writeTempPrompt(name: string, prompt: string): Promise<{ dir: string; file: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safe = name.replace(/[^\w.-]+/g, "_");
	const file = path.join(dir, `prompt-${safe}.md`);
	await fs.promises.writeFile(file, prompt, { mode: 0o600 });
	return { dir, file };
}

function piInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

/**
 * Run one subagent to completion. Resolves with the updated entry.
 * The caller decides what to do with timeouts/hung (this function only
 * implements the hard timeout kill).
 */
export async function runChild(opts: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	entry: DispatchEntry;
	modelArg: string; // "provider/modelId"
	permissions: Permissions;
	systemPrompt?: string;
	timeoutSec: number;
	signal?: AbortSignal;
	/** Load the project's AGENTS.md / CLAUDE.md in the child (default true).
	 *  Set false for children whose spec must not be rewritable by the project
	 *  they are inspecting — a reviewer, for instance. Note that context files
	 *  load regardless of project trust, so trust settings cannot substitute. */
	contextFiles?: boolean;
	/** Test seam for ChildProcess lifecycle regressions. Production uses node:child_process.spawn. */
	spawnProcess?: typeof spawn;
}): Promise<DispatchEntry> {
	const { pi: _pi, ctx, entry, modelArg, permissions, systemPrompt, timeoutSec, signal, contextFiles, spawnProcess = spawn } = opts;
	const e = entry;
	const maxCapturedMessages = loadConfig(ctx).defaults.maxCapturedMessages;

	const args: string[] = ["--mode", "json", "-p", "--no-session", "--model", modelArg];
	if (contextFiles === false) args.push("--no-context-files");
	const tools = permissionsToTools(permissions);
	if (tools) args.push("--tools", tools.join(","));

	let tmpDir: string | null = null;
	let tmpFile: string | null = null;
	if (systemPrompt && systemPrompt.trim()) {
		const tmp = await writeTempPrompt(e.name, systemPrompt);
		tmpDir = tmp.dir;
		tmpFile = tmp.file;
		args.push("--append-system-prompt", tmpFile);
	}
	args.push(`Task: ${e.task}`);

	// Mark child so the subagent extension doesn't register dispatch inside it.
	const childEnv = { ...process.env, PI_SUBAGENT_CHILD: "1" };

	let timedOut = false;
	let aborted = false;

	try {
		const exitCode = await new Promise<number>((resolve) => {
			const inv = piInvocation(args);
			const proc = spawnProcess(inv.command, inv.args, {
				cwd: ctx.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: childEnv,
			});
			const terminator = createProcessTerminator(proc);
			e.kill = () => {
				aborted = true;
				terminator.terminate();
			};

			let buffer = "";
			let didSpawn = proc.pid !== undefined;
			let preSpawnError: Error | undefined;
			const processLine = (line: string) => {
				if (!line.trim()) return;
				let ev: any;
				try { ev = JSON.parse(line); } catch { return; }
				e.lastActivityAt = Date.now();
				if (ev.type === "message_end" && ev.message) {
					captureMessage(e, ev.message as Message, maxCapturedMessages);
					if ((ev.message as Message).role === "assistant") {
						const u = (ev.message as any).usage;
						if (u?.cost?.total) (e as any).cost = ((e as any).cost ?? 0) + u.cost.total;
					}
					registry.touch(e.id);
				}
				if (ev.type === "tool_result_end" && ev.message) {
					captureMessage(e, ev.message as Message, maxCapturedMessages);
					registry.touch(e.id);
				}
				// Track provider auto-retries (connection errors / empty bodies, etc.).
				// The pi json-mode child still exits 0 even when retries are exhausted,
				// so we must remember this to classify the run correctly below.
				if (ev.type === "auto_retry_start") {
					e.retryAttempts = Math.max(e.retryAttempts ?? 0, ev.attempt ?? 0);
					registry.touch(e.id);
				}
			};

			proc.stdout.on("data", (data) => {
				e.lastActivityAt = Date.now();
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (data) => {
				e.lastActivityAt = Date.now();
				(e as any).stderr = ((e as any).stderr ?? "") + data.toString();
			});

			let onAbort: (() => void) | undefined;
			let settled = false;
			const to = setTimeout(() => {
				timedOut = true;
				terminator.terminate();
			}, timeoutSec * 1000);
			const settle = (code: number) => {
				if (settled) return;
				settled = true;
				clearTimeout(to);
				if (signal && onAbort) signal.removeEventListener("abort", onAbort);
				if (buffer.trim()) processLine(buffer);
				resolve(code);
			};
			proc.once("spawn", () => { didSpawn = true; });
			proc.on("close", (code, closeSignal) => {
				terminator.markClosed();
				settle(preSpawnError ? 1 : code ?? (closeSignal ? 1 : 0));
			});
			proc.on("error", (error) => {
				if (!didSpawn) {
					preSpawnError = error;
					e.errorMessage ||= `failed to spawn subagent: ${error.message}`;
					registry.changed();
					// Spawn failures have no live child to orphan. Settle immediately;
					// a later close event is harmless because settle() is idempotent.
					terminator.markClosed();
					settle(1);
					return;
				}
				// ChildProcess also emits "error" when signalling fails (for example
				// EPERM), and Node may not emit close afterward. Preserve an earlier,
				// more specific error and settle as failure/cancellation so the caller
				// cannot hold its semaphore slot forever. A later close is harmless.
				e.errorMessage ||= `subagent process error: ${error.message}`;
				registry.changed();
				settle(1);
			});

			if (signal) {
				onAbort = () => {
					aborted = true;
					terminator.terminate();
				};
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}
		});

		e.exitCode = exitCode;
		e.finalOutput = getFinalOutput(e.messages) || e.finalOutput || "";

		// Inspect the final assistant message's stopReason. pi's json mode exits 0
		// even when the provider connection failed and auto-retries were
		// exhausted (final assistant stopReason === "error"), so we cannot rely
		// on exitCode alone to decide success.
		let finalAssistantStop: string | undefined;
		for (let i = e.messages.length - 1; i >= 0; i--) {
			const m = e.messages[i];
			if (m.role === "assistant") {
				finalAssistantStop = (m as any).stopReason ?? (m as any).stop_reason;
				break;
			}
		}
		e.lastStopReason = finalAssistantStop;
		const retriedHard = (e.retryAttempts ?? 0) > 0;

		if (aborted) {
			e.status = "cancelled";
			e.stopReason = "aborted";
		} else if (timedOut) {
			e.status = "timeout";
			e.stopReason = "timeout";
		} else if (exitCode !== 0) {
			e.status = "failed";
			e.stopReason = "exit";
		} else if (finalAssistantStop === "error" || finalAssistantStop === "aborted") {
			// Provider/agent layer ended in error (e.g. retries exhausted on
			// connection error) even though the child process exited 0.
			e.status = "failed";
			e.stopReason = finalAssistantStop;
			e.errorMessage = e.errorMessage
				|| `subagent ended with stopReason="${finalAssistantStop}"${retriedHard ? ` after ${e.retryAttempts} auto-retr${(e.retryAttempts ?? 0) > 1 ? "ies" : "y"}` : ""}`;
		} else if (!e.finalOutput.trim() && retriedHard) {
			// No usable text output and retries happened — treat as failure so we
			// don't report a silent "(no output)" success.
			e.status = "failed";
			e.stopReason = "empty_after_retry";
			e.errorMessage = `no output after ${e.retryAttempts} auto-retr${(e.retryAttempts ?? 0) > 1 ? "ies" : "y"}`;
		} else {
			e.status = "done";
		}
	} catch (err: any) {
		e.status = "failed";
		e.errorMessage = err?.message ?? String(err);
	} finally {
		e.endedAt = Date.now();
		// finalOutput/status/endedAt are mutated in place; wake an open panel now
		// rather than waiting for an indirect polling signature to notice.
		e.kill = undefined;
		registry.changed();
		if (tmpFile) try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
		if (tmpDir) try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
	}
	return e;
}
