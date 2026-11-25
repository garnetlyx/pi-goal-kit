/**
 * Runtime registry + resource-group scheduler for dispatched subagents.
 *
 * The registry holds every live/recent dispatch so the /subagents panel can
 * render status and outputs. The scheduler enforces per-group concurrency with
 * semaphores shared across all dispatch invocations (so two rapid dispatch
 * calls can't bypass a group's limit).
 *
 * The registry instance is realm-scoped (Symbol.for), not module-scoped — see
 * the note above its export for why a plain module singleton silently splits
 * in two across extension entry points.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { SubagentConfig } from "./config.ts";
import { concurrencyForGroup, groupForProvider } from "./config.ts";

export type DispatchStatus = "queued" | "running" | "done" | "failed" | "timeout" | "cancelled" | "hung";

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		if (text.trim()) return text;
	}
	return "";
}

export function captureMessage(entry: DispatchEntry, message: Message, limit: number): void {
	entry.messages.push(message);
	while (entry.messages.length > limit) entry.messages.shift();
	const latestText = getFinalOutput([message]);
	if (latestText.trim()) entry.finalOutput = latestText;
}

export interface DispatchEntry {
	id: string;
	name: string;
	role?: string;
	model: string; // "provider/modelId"
	provider: string;
	task: string;
	permissionsLabel: string;
	group: string;
	startedAt: number;
	endedAt?: number;
	lastActivityAt: number;
	status: DispatchStatus;
	warning?: string; // hung warning text
	messages: Message[]; // captured from child JSON stream
	finalOutput?: string;
	exitCode?: number;
	stopReason?: string;
	errorMessage?: string;
	retryAttempts?: number; // auto_retry attempts observed on the child stream
	lastStopReason?: string; // stopReason of the final assistant message
	// internal lifecycle handles
	kill?: () => void;
	abort?: () => void;
	waitDoneEmitted?: boolean;
	completionDelivered?: boolean;
}

// ---- Semaphore ------------------------------------------------------------

export class Semaphore {
	private limit: number;
	private inUse = 0;
	private waiters: Array<{ resolve: () => void; reject: (error: Error) => void; signal?: AbortSignal; onAbort?: () => void }> = [];
	constructor(limit: number) {
		this.limit = normalizedLimit(limit);
	}
	setLimit(limit: number): void {
		this.limit = normalizedLimit(limit);
		this.drain();
	}
	async acquire(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw abortError();
		if (this.inUse < this.limit) {
			this.inUse++;
			return;
		}
		await new Promise<void>((resolve, reject) => {
			const waiter = { resolve, reject, signal, onAbort: undefined as (() => void) | undefined };
			this.waiters.push(waiter);
			if (signal) {
				waiter.onAbort = () => {
					const index = this.waiters.indexOf(waiter);
					if (index >= 0) this.waiters.splice(index, 1);
					reject(abortError());
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
				if (signal.aborted) waiter.onAbort();
			}
		});
	}
	release(): boolean {
		if (this.inUse === 0) {
			console.warn("[subagent] ignored semaphore release without an acquired slot");
			return false;
		}
		this.inUse--;
		this.drain();
		return true;
	}
	private drain(): void {
		while (this.inUse < this.limit) {
			const next = this.waiters.shift();
			if (!next) return;
			if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
			this.inUse++;
			next.resolve();
		}
	}
}

function normalizedLimit(limit: number): number {
	return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1;
}

function abortError(): Error {
	const error = new Error("Semaphore acquire cancelled");
	error.name = "AbortError";
	return error;
}

// ---- Registry + Scheduler -------------------------------------------------

class Registry {
	private entries = new Map<string, DispatchEntry>();
	private semaphores = new Map<string, Semaphore>();
	private listeners = new Set<() => void>();

	private emitChange(): void {
		for (const listener of this.listeners) listener();
	}
	/** Subscribe to actual registry mutations (not an idle polling clock). */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	/** Notify observers after callers mutate a shared entry in place. */
	changed(): void {
		this.emitChange();
	}

	semaphoreFor(cfg: SubagentConfig, group: string): Semaphore {
		const limit = concurrencyForGroup(cfg, group);
		let s = this.semaphores.get(group);
		if (!s) {
			s = new Semaphore(limit);
			this.semaphores.set(group, s);
		} else {
			s.setLimit(limit);
		}
		return s;
	}

	resolveGroup(cfg: SubagentConfig, provider: string, override?: string): string {
		return override ?? groupForProvider(cfg, provider);
	}

	add(entry: DispatchEntry): void {
		this.entries.set(entry.id, entry);
		this.emitChange();
	}
	get(id: string): DispatchEntry | undefined {
		return this.entries.get(id);
	}
	all(): DispatchEntry[] {
		return [...this.entries.values()].sort((a, b) => a.startedAt - b.startedAt);
	}
	live(): DispatchEntry[] {
		return this.all().filter((e) => e.status === "queued" || e.status === "running" || e.status === "hung");
	}
	remove(id: string): void {
		if (this.entries.delete(id)) this.emitChange();
	}
	/** GC finished entries older than retainSec. */
	gc(retainSec: number): void {
		const cutoff = Date.now() - retainSec * 1000;
		let changed = false;
		for (const [id, e] of this.entries) {
			if (e.endedAt && e.endedAt < cutoff) changed = this.entries.delete(id) || changed;
		}
		if (changed) this.emitChange();
	}
	/** Update an entry in place (mutable reference is shared). */
	touch(id: string): void {
		const e = this.entries.get(id);
		if (e) {
			e.lastActivityAt = Date.now();
			this.emitChange();
		}
	}
}

// Process-wide singleton, NOT a module-level one. Pi loads every extension
// entry point through its own Jiti loader with `moduleCache: false`, so
// `new Registry()` at module scope produces a *different* instance per
// importing extension — gated-goal's reviewer would register into a registry
// that subagent's panel / dispatch_status / watchdog / shutdown never read.
// Symbol.for keys the instance on the shared realm instead.
const REGISTRY_KEY = Symbol.for("pi-goal-kit.subagent.registry.v1");
const globalStore = globalThis as Record<symbol, unknown>;
export const registry: Registry = (globalStore[REGISTRY_KEY] ??= new Registry()) as Registry;

export function markWaitDone(entry: DispatchEntry): boolean {
	if (entry.waitDoneEmitted) return false;
	entry.waitDoneEmitted = true;
	return true;
}

export function genId(): string {
	return `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** Split provider and modelId from "provider/modelId" (modelId may contain slashes). */
export function splitModel(model: string): { provider: string; modelId: string } {
	const idx = model.indexOf("/");
	if (idx < 0) return { provider: model, modelId: "" };
	return { provider: model.slice(0, idx), modelId: model.slice(idx + 1) };
}
