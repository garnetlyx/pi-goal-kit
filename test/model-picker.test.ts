import { describe, expect, it } from "vitest";
import { filterModels, pickerInput, windowRange } from "../extensions/subagent/model-picker.ts";
import type { AvailableModel } from "../extensions/subagent/models.ts";

const records: AvailableModel[] = [
	{ provider: "local-m4m-proxy", id: "glm-5.3", name: "GLM 5.3" },
	{ provider: "local-m4m-proxy", id: "kimi-k3", name: "Kimi K3" },
	{ provider: "local-m3u-deployed", id: "Qwen3.8-27B-4bit", name: "Qwen 3.8 27B" },
	{ provider: "local-alienware-lms", id: "gemma-4-12b-qat", name: "Gemma 4 12B QAT" },
	{ provider: "anthropic", id: "claude-fable-5", name: "Claude Fable 5" },
];

describe("filterModels", () => {
	it("empty query matches everything", () => {
		expect(filterModels(records, "")).toHaveLength(records.length);
	});

	it("partial id match, case-insensitive", () => {
		expect(filterModels(records, "qwen")).toEqual([records[2]]);
		expect(filterModels(records, "GLM")).toEqual([records[0]]);
	});

	it("matches provider prefix", () => {
		const hits = filterModels(records, "local-m4m");
		expect(hits).toEqual([records[0], records[1]]);
	});

	it("matches full provider/id string", () => {
		expect(filterModels(records, "anthropic/claude")).toEqual([records[4]]);
	});

	it("matches display name", () => {
		expect(filterModels(records, "fable")).toEqual([records[4]]);
	});

	it("no match returns empty", () => {
		expect(filterModels(records, "zzz-nonexistent")).toEqual([]);
	});
});

describe("pickerInput", () => {
	it("arrow keys and vim keys move", () => {
		expect(pickerInput("\x1b[A")).toEqual({ type: "move", delta: -1 });
		expect(pickerInput("\x1b[B")).toEqual({ type: "move", delta: 1 });
		expect(pickerInput("k")).toEqual({ type: "move", delta: -1 });
		expect(pickerInput("j")).toEqual({ type: "move", delta: 1 });
	});

	it("page jumps and home/end", () => {
		expect(pickerInput("\x1b[5~")).toEqual({ type: "page", delta: -1 });
		expect(pickerInput("\x1b[6~")).toEqual({ type: "page", delta: 1 });
		expect(pickerInput("\x1b[H")).toEqual({ type: "home" });
		expect(pickerInput("\x1b[F")).toEqual({ type: "end" });
	});

	it("enter accepts, escape and ctrl+c cancel", () => {
		expect(pickerInput("\r")).toEqual({ type: "accept" });
		expect(pickerInput("\n")).toEqual({ type: "accept" });
		expect(pickerInput("\x1b")).toEqual({ type: "cancel" });
		expect(pickerInput("\x03")).toEqual({ type: "cancel" });
	});

	it("backspace variants", () => {
		expect(pickerInput("\x7f")).toEqual({ type: "backspace" });
		expect(pickerInput("\x08")).toEqual({ type: "backspace" });
	});

	it("printable input types, including short pastes", () => {
		expect(pickerInput("q")).toEqual({ type: "type", text: "q" });
		expect(pickerInput("Qwen3.8")).toEqual({ type: "type", text: "Qwen3.8" });
	});

	it("control sequences and lone controls are ignored", () => {
		expect(pickerInput("\x1b[200~")).toEqual({ type: "none" });
		expect(pickerInput("\x1b]52;c;AAAA\x07")).toEqual({ type: "none" });
		expect(pickerInput("\x00")).toEqual({ type: "none" });
		expect(pickerInput("")).toEqual({ type: "none" });
	});

	it("oversized runs are ignored", () => {
		expect(pickerInput("a".repeat(65))).toEqual({ type: "none" });
	});
});

describe("windowRange", () => {
	it("count fits in window — shows everything", () => {
		expect(windowRange(0, 5, 10)).toEqual({ start: 0, end: 5 });
		expect(windowRange(4, 5, 10)).toEqual({ start: 0, end: 5 });
	});

	it("cursor near top pins to start", () => {
		expect(windowRange(0, 20, 5)).toEqual({ start: 0, end: 5 });
		expect(windowRange(2, 20, 5)).toEqual({ start: 0, end: 5 });
	});

	it("cursor in middle centers the window", () => {
		expect(windowRange(10, 20, 5)).toEqual({ start: 8, end: 13 });
	});

	it("cursor at bottom pins to end", () => {
		expect(windowRange(19, 20, 5)).toEqual({ start: 15, end: 20 });
		expect(windowRange(18, 20, 5)).toEqual({ start: 15, end: 20 });
	});

	it("empty list yields empty window", () => {
		expect(windowRange(0, 0, 5)).toEqual({ start: 0, end: 0 });
	});

	it("maxVisible below 1 is clamped", () => {
		expect(windowRange(0, 10, 0)).toEqual({ start: 0, end: 1 });
	});
});
