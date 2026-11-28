/**
 * Compaction-safe delivery of extension follow-ups.
 *
 * Every extension in this kit has a call site that fires from an async
 * continuation — a reviewer verdict, a subagent completion, a reminder
 * wake-up — and so cannot know whether the user is mid-`/compact`. Pi rejects
 * a prompt submitted while a manual compaction runs ("Cannot submit a prompt
 * while compaction is in progress", `AgentSession.prompt()`), and the
 * extension never learns of it: `pi.sendUserMessage` returns `void` and core
 * reports the rejection itself (`Extension "<runtime>" error`). The message
 * is simply lost. For gated-goal that discarded the reviewer's required
 * changes after the iteration had already been charged.
 *
 * The sink tracks compaction on the extension bus and holds what would be
 * rejected:
 *
 *   session_before_compact           → hold follow-ups
 *   session_compact / _compact_failed → flush, one macrotask later
 *   session_shutdown                 → drop everything held
 *
 * The flush is deferred because pi emits `session_compact` BEFORE it clears
 * the prompt guard (earendil-works/pi#9647): a send inside the handler is
 * rejected again. By the next macrotask `compact()` has returned. The flush
 * delivers only once every compaction that has started has also ended, so one
 * that starts again in the meantime keeps the messages until its own end event.
 *
 * Auto-compaction emits the same events without holding the prompt guard.
 * Holding through it never delays delivery: the agent is mid-run then, so a
 * follow-up queued immediately would be delivered after that run regardless.
 *
 * Each extension creates its own sink: pi gives every extension entry point
 * its own module instance, and the held queue belongs to one runtime.
 *
 * Removal condition: pi queues extension follow-ups during compaction instead
 * of rejecting them (upstream #9647). `say` then collapses to
 * `pi.sendUserMessage(text, { deliverAs: "followUp" })`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface FollowUpOptions {
	/** Checked when said and again when a held message is delivered. True means
	 *  the message belongs to a gate or run that no longer exists (it exited, or
	 *  was replaced, while the message was held): it is dropped without being
	 *  sent. */
	isStale?: () => boolean;
}

export interface FollowUpSink {
	/** Deliver `text` as a follow-up now, or as the first thing after the
	 *  running compaction ends. A runtime that was shut down drops the
	 *  message: it was composed for a session that has been left. */
	say(text: string, opts?: FollowUpOptions): void;
}

interface Held {
	text: string;
	isStale?: () => boolean;
}

export function createFollowUpSink(pi: ExtensionAPI): FollowUpSink {
	let active = true;
	// True from session_before_compact until the flush that follows the end
	// event of every compaction started so far. It is cleared in the flush, not
	// in the end handler: pi's prompt guard is still up while that handler runs.
	let compacting = false;
	let started = 0;
	let ended = 0;
	let held: Held[] = [];
	let flushTimer: ReturnType<typeof setTimeout> | undefined;

	const flush = () => {
		flushTimer = undefined;
		if (!active) return;
		// A compaction that started after the end event that scheduled this flush
		// is still running; its own end event schedules the next one.
		if (ended < started) return;
		compacting = false;
		const due = held;
		held = [];
		for (const m of due) {
			if (m.isStale?.()) continue;
			pi.sendUserMessage(m.text, { deliverAs: "followUp" });
		}
	};
	const scheduleFlush = () => {
		if (flushTimer === undefined) flushTimer = setTimeout(flush, 0);
	};

	pi.on("session_before_compact", async () => {
		started++;
		compacting = true;
	});
	pi.on("session_compact", async () => {
		ended++;
		scheduleFlush();
	});
	pi.on("session_compact_failed", async () => {
		ended++;
		scheduleFlush();
	});
	// The outgoing runtime on a session switch or /reload: nothing it held may
	// land in the session being entered.
	pi.on("session_shutdown", async () => {
		active = false;
		held = [];
		if (flushTimer !== undefined) clearTimeout(flushTimer);
		flushTimer = undefined;
	});

	return {
		say(text, opts) {
			if (!active || opts?.isStale?.()) return;
			if (compacting) {
				held.push({ text, isStale: opts?.isStale });
				return;
			}
			pi.sendUserMessage(text, { deliverAs: "followUp" });
		},
	};
}
