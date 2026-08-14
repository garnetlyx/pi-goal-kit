/**
 * Runtime registry + resource-group scheduler for dispatched subagents.
 *
 * The registry holds every live/recent dispatch so the /subagents panel can
 * render status and outputs. The scheduler enforces per-group concurrency with
 * semaphores shared across all dispatch invocations (so two rapid dispatch
 * calls can't bypass a group's limit).
 */

import type { Message } from "@earendil-works/pi-ai";
import type { SubagentConfig } from "./config.ts";
import { concurrencyForGroup, groupForProvider } from "./config.ts";

export type DispatchStatus = "queued" | "running" | "done" | "failed" | "timeout" | "cancelled" | "hung";

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
	retryAttempts?: number; // auto_retry attempts observed (Bug 1/2 diagnostic)
	lastStopReason?: string; // stopReason of the final assistant message
	// internal handle to kill the child process
	kill?: () => void;
}

// ---- Semaphore ------------------------------------------------------------

class Semaphore {
	private available: number;
	private waiters: (() => void)[] = [];
	constructor(private readonly limit: number) {
		this.available = limit;
	}
	async acquire(): Promise<void> {
		if (this.available > 0) {
			this.available--;
			return;
		}
		await new Promise<void>((resolve) => this.waiters.push(resolve));
	}
	release(): void {
		if (this.waiters.length > 0) {
			const next = this.waiters.shift()!;
			next(); // hand off the slot directly
		} else {
			this.available++;
		}
	}
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
		let s = this.semaphores.get(group);
		if (!s) {
			s = new Semaphore(concurrencyForGroup(cfg, group));
			this.semaphores.set(group, s);
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
		return this.all().filter((e) => e.status === "queued" || e.status === "running");
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

export const registry = new Registry();

export function genId(): string {
	return `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** Split provider and modelId from "provider/modelId" (modelId may contain slashes). */
export function splitModel(model: string): { provider: string; modelId: string } {
	const idx = model.indexOf("/");
	if (idx < 0) return { provider: model, modelId: "" };
	return { provider: model.slice(0, idx), modelId: model.slice(idx + 1) };
}
