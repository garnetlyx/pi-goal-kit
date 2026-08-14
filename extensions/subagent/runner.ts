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
import type { Permissions } from "./config.ts";
import { type DispatchEntry, registry } from "./scheduler.ts";

/** Read-only/network extensions whose tools are safe to expose alongside the
 *  builtin readonly/junior sets (they don't mutate the workspace). */
const SAFE_EXTENSION_TOOLS = ["web_search", "web_fetch"];

/** Map a Permissions spec to a pi `--tools` whitelist (undefined = all tools).
 *  readonly/junior intentionally expose read-only builtin tools plus the
 *  safe network extension tools (web_search/web_fetch) so that research-style
 *  subagents can fetch the web without being granted workspace write access. */
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

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "assistant") {
			for (const part of m.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
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
}): Promise<DispatchEntry> {
	const { pi: _pi, ctx, entry, modelArg, permissions, systemPrompt, timeoutSec, signal } = opts;
	const e = entry;

	const args: string[] = ["--mode", "json", "-p", "--no-session", "--model", modelArg];
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
			const proc = spawn(inv.command, inv.args, {
				cwd: ctx.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: childEnv,
			});
			e.kill = () => {
				try { proc.kill("SIGTERM"); } catch { /* ignore */ }
				setTimeout(() => {
					try { if (!proc.killed) proc.kill("SIGKILL"); } catch { /* ignore */ }
				}, 5000);
			};

			let buffer = "";
			const processLine = (line: string) => {
				if (!line.trim()) return;
				let ev: any;
				try { ev = JSON.parse(line); } catch { return; }
				if (ev.type === "message_end" && ev.message) {
					e.messages.push(ev.message as Message);
					if ((ev.message as Message).role === "assistant") {
						const u = (ev.message as any).usage;
						if (u?.cost?.total) (e as any).cost = ((e as any).cost ?? 0) + u.cost.total;
					}
					registry.touch(e.id);
				}
				if (ev.type === "tool_result_end" && ev.message) {
					e.messages.push(ev.message as Message);
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
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (data) => {
				(e as any).stderr = ((e as any).stderr ?? "") + data.toString();
			});
			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});
			proc.on("error", () => resolve(1));

			// hard timeout
			const to = setTimeout(() => {
				timedOut = true;
				try { proc.kill("SIGTERM"); } catch { /* ignore */ }
				setTimeout(() => { try { if (!proc.killed) proc.kill("SIGKILL"); } catch { /* ignore */ } }, 5000);
			}, timeoutSec * 1000);
			proc.on("close", () => clearTimeout(to));

			if (signal) {
				const onAbort = () => {
					aborted = true;
					try { proc.kill("SIGTERM"); } catch { /* ignore */ }
				};
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}
		});

		e.exitCode = exitCode;
		e.finalOutput = getFinalOutput(e.messages);

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
		registry.changed();
		if (tmpFile) try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
		if (tmpDir) try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
	}
	return e;
}
