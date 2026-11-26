/**
 * Runtime registry + resource-group scheduler for dispatched subagents.
 *
 * The registry holds every live/recent dispatch so the /subagents panel can
 * render status and outputs. The scheduler enforces per-group concurrency with
 * semaphores shared across all dispatch invocations (so two rapid dispatch
 * calls can't bypass a group's limit).
 *
 * The registry state is realm-scoped (Symbol.for), not module-scoped — see
 * the note above `registry` for why a module-level singleton silently splits
 * in two across extension entry points, and why only plain data may live
 * on globalThis.
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

/** Slot state of one resource group. Plain data on purpose: a reloaded module
 *  instance wraps the same slots the torn-down runtime's dispatch closures
 *  still release into (see the note above `registry`). */
export interface SemaphoreState {
	limit: number;
	inUse: number;
	waiters: Array<{ resolve: () => void; reject: (error: Error) => void; signal?: AbortSignal; onAbort?: () => void }>;
}

function freshSemaphoreState(limit: number): SemaphoreState {
	return { limit: normalizedLimit(limit), inUse: 0, waiters: [] };
}

export class Semaphore {
	private readonly state: SemaphoreState;
	/** From a limit: standalone slots. From state: a wrapper over shared slots. */
	constructor(state: SemaphoreState | number) {
		this.state = typeof state === "number" ? freshSemaphoreState(state) : state;
	}
	setLimit(limit: number): void {
		this.state.limit = normalizedLimit(limit);
		this.drain();
	}
	async acquire(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw abortError();
		if (this.state.inUse < this.state.limit) {
			this.state.inUse++;
			return;
		}
		await new Promise<void>((resolve, reject) => {
			const waiter = { resolve, reject, signal, onAbort: undefined as (() => void) | undefined };
			this.state.waiters.push(waiter);
			if (signal) {
				waiter.onAbort = () => {
					const index = this.state.waiters.indexOf(waiter);
					if (index >= 0) this.state.waiters.splice(index, 1);
					reject(abortError());
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
				if (signal.aborted) waiter.onAbort();
			}
		});
	}
	release(): boolean {
		if (this.state.inUse === 0) {
			console.warn("[subagent] ignored semaphore release without an acquired slot");
			return false;
		}
		this.state.inUse--;
		this.drain();
		return true;
	}
	private drain(): void {
		while (this.state.inUse < this.state.limit) {
			const next = this.state.waiters.shift();
			if (!next) return;
			if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
			this.state.inUse++;
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

/** Entries, group slots and panel subscriptions of the process. Plain data so
 *  every module instance can wrap it (see `registry`). */
interface RegistryState {
	entries: Map<string, DispatchEntry>;
	semaphores: Map<string, SemaphoreState>;
	listeners: Set<() => void>;
}

class Registry {
	private readonly state: RegistryState;
	constructor(state: RegistryState) {
		this.state = state;
	}

	private emitChange(): void {
		for (const listener of this.state.listeners) listener();
	}
	/** Subscribe to actual registry mutations (not an idle polling clock). */
	subscribe(listener: () => void): () => void {
		this.state.listeners.add(listener);
		return () => this.state.listeners.delete(listener);
	}
	/** Notify observers after callers mutate a shared entry in place. */
	changed(): void {
		this.emitChange();
	}

	/** A wrapper over the group's shared slots; the limit follows the config. */
	semaphoreFor(cfg: SubagentConfig, group: string): Semaphore {
		const limit = concurrencyForGroup(cfg, group);
		let slots = this.state.semaphores.get(group);
		if (!slots) {
			slots = freshSemaphoreState(limit);
			this.state.semaphores.set(group, slots);
		}
		const semaphore = new Semaphore(slots);
		semaphore.setLimit(limit);
		return semaphore;
	}

	resolveGroup(cfg: SubagentConfig, provider: string, override?: string): string {
		return override ?? groupForProvider(cfg, provider);
	}

	add(entry: DispatchEntry): void {
		this.state.entries.set(entry.id, entry);
		this.emitChange();
	}
	get(id: string): DispatchEntry | undefined {
		return this.state.entries.get(id);
	}
	all(): DispatchEntry[] {
		return [...this.state.entries.values()].sort((a, b) => a.startedAt - b.startedAt);
	}
	live(): DispatchEntry[] {
		return this.all().filter((e) => e.status === "queued" || e.status === "running" || e.status === "hung");
	}
	remove(id: string): void {
		if (this.state.entries.delete(id)) this.emitChange();
	}
	/** Drop every entry: the session runtime that owned them is being torn
	 *  down (new/resume/fork/reload/quit). Group slots are kept on purpose —
	 *  the torn-down runtime's dispatch closures still release into them, so
	 *  the next session's same-group dispatch waits for the killed child to
	 *  exit instead of oversubscribing the group. */
	clear(): void {
		if (this.state.entries.size === 0) return;
		this.state.entries.clear();
		this.emitChange();
	}
	/** GC finished entries older than retainSec. */
	gc(retainSec: number): void {
		const cutoff = Date.now() - retainSec * 1000;
		let changed = false;
		for (const [id, e] of this.state.entries) {
			if (e.endedAt && e.endedAt < cutoff) changed = this.state.entries.delete(id) || changed;
		}
		if (changed) this.emitChange();
	}
	/** Update an entry in place (mutable reference is shared). */
	touch(id: string): void {
		const e = this.state.entries.get(id);
		if (e) {
			e.lastActivityAt = Date.now();
			this.emitChange();
		}
	}
}

// Process-wide shared *state*, not a shared instance, and not module-scoped.
// Pi loads every extension entry point through its own Jiti loader with
// `moduleCache: false`, so a module-level `new Registry()` would give
// gated-goal's reviewer a registry that subagent's panel / dispatch_status /
// watchdog / shutdown never read. But an *instance* stored here would freeze
// the class identity of the process's first load: `/reload` re-reads the
// extension files, and the reloaded module would call its new methods on the
// old prototype ("registry.clear is not a function"). So globalThis holds
// plain data under a Symbol.for key, every module instance wraps it in its own
// Registry, and the torn-down runtime's closures keep mutating the same state
// through theirs.
const REGISTRY_STATE_KEY = Symbol.for("pi-goal-kit.subagent.registry-state.v1");
const globalStore = globalThis as Record<symbol, unknown>;
const registryState = (globalStore[REGISTRY_STATE_KEY] ??= {
	entries: new Map<string, DispatchEntry>(),
	semaphores: new Map<string, SemaphoreState>(),
	listeners: new Set<() => void>(),
}) as RegistryState;
export const registry = new Registry(registryState);

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
