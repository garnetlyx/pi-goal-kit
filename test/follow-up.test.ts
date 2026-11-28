import { describe, expect, it } from "vitest";
import { createFollowUpSink } from "../extensions/subagent/follow-up.ts";
import { flush, makeHarness } from "./harness.ts";

// The boundary that matters here is pi's own: `pi.sendUserMessage` returns
// void and never reports the compaction rejection to the caller, so nothing
// can be retried after the fact — the sink has to know not to send. The fake
// therefore records sends and nothing else; compaction is driven through the
// extension events pi emits for it.
function rig() {
	const h = makeHarness({});
	const sink = createFollowUpSink(h.pi as any);
	return { h, sink };
}

describe("follow-up sink (compaction-safe delivery)", () => {
	it("delivers at once while no compaction runs", () => {
		const { h, sink } = rig();
		sink.say("verdict");
		expect(h.sent).toEqual(["verdict"]);
	});

	it("holds through a compaction and flushes only after session_compact returns", async () => {
		const { h, sink } = rig();
		await h.fire("session_before_compact", { reason: "manual" });
		sink.say("first");
		sink.say("second");
		expect(h.sent).toEqual([]);

		await h.fire("session_compact", {});
		// pi emits session_compact before clearing its prompt guard
		// (earendil-works/pi#9647): a send inside the handler is rejected again.
		expect(h.sent).toEqual([]);

		await flush();
		expect(h.sent).toEqual(["first", "second"]);

		// Back to immediate delivery.
		sink.say("third");
		expect(h.sent).toEqual(["first", "second", "third"]);
	});

	it("flushes on session_compact_failed as well", async () => {
		const { h, sink } = rig();
		await h.fire("session_before_compact", { reason: "manual" });
		sink.say("wake-up");
		await h.fire("session_compact_failed", { reason: "manual", aborted: true });
		await flush();
		expect(h.sent).toEqual(["wake-up"]);
	});

	it("keeps holding when another compaction starts before the deferred flush runs", async () => {
		const { h, sink } = rig();
		await h.fire("session_before_compact", { reason: "manual" });
		sink.say("a");
		await h.fire("session_compact", {});
		await h.fire("session_before_compact", { reason: "threshold" });
		await flush();
		expect(h.sent).toEqual([]);
		// What is said meanwhile is held too, behind what was already waiting.
		sink.say("b");
		await h.fire("session_compact", {});
		await flush();
		expect(h.sent).toEqual(["a", "b"]);
	});

	it("delivers once a second compaction that started and ended before the first flush also finished", async () => {
		const { h, sink } = rig();
		await h.fire("session_before_compact", { reason: "manual" });
		sink.say("a");
		await h.fire("session_compact", {});
		await h.fire("session_before_compact", { reason: "threshold" });
		await h.fire("session_compact", {});
		await flush();
		expect(h.sent).toEqual(["a"]);
	});

	it("drops a held message whose gate died while it was held, and keeps the rest in order", async () => {
		const { h, sink } = rig();
		let gateAlive = true;
		await h.fire("session_before_compact", { reason: "manual" });
		sink.say("verdict for a dead gate", { isStale: () => !gateAlive });
		sink.say("gate exited");
		gateAlive = false;
		await h.fire("session_compact", {});
		await flush();
		expect(h.sent).toEqual(["gate exited"]);
	});

	it("does not send a message that is already stale", () => {
		const { h, sink } = rig();
		sink.say("stale", { isStale: () => true });
		sink.say("live");
		expect(h.sent).toEqual(["live"]);
	});

	it("drops everything held when the runtime shuts down", async () => {
		const { h, sink } = rig();
		await h.fire("session_before_compact", { reason: "manual" });
		sink.say("held");
		await h.fire("session_shutdown");
		await h.fire("session_compact", {});
		await flush();
		expect(h.sent).toEqual([]);
		sink.say("after shutdown");
		expect(h.sent).toEqual([]);
	});

	it("holds through auto-compaction the same way: its events carry a different reason", async () => {
		const { h, sink } = rig();
		await h.fire("session_before_compact", { reason: "overflow", willRetry: true });
		sink.say("verdict");
		expect(h.sent).toEqual([]);
		await h.fire("session_compact", { reason: "overflow", willRetry: true });
		await flush();
		expect(h.sent).toEqual(["verdict"]);
	});
});
