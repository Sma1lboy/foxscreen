import type { CaptionSegment } from "@foxscreen/cutti-core";
import {
	aiKeepCut,
	buildKeepCutMessages,
	loadLlmConfig,
	parseCutIndices,
} from "@foxscreen/cutti-core";
import { describe, expect, it } from "vitest";
import { transcriptToFirstCutAI } from "../firstCut";

const config = { apiKey: "sk-test", baseUrl: "https://api.example.com/v1", model: "gpt-4o-mini" };

function mockFetch(content: string, status = 200): typeof fetch {
	return (async () => ({
		ok: status >= 200 && status < 300,
		status,
		statusText: status === 200 ? "OK" : "ERR",
		json: async () => ({ choices: [{ message: { content } }] }),
		text: async () => content,
	})) as unknown as typeof fetch;
}

describe("parseCutIndices", () => {
	it("parses a clean JSON object", () => {
		expect(parseCutIndices('{"cut":[1,3]}', 5)).toEqual([1, 3]);
	});
	it("tolerates code fences / surrounding prose", () => {
		expect(parseCutIndices('好的:\n```json\n{"cut": [2, 0]}\n```', 5)).toEqual([0, 2]);
	});
	it("filters out-of-range + dedupes + sorts", () => {
		expect(parseCutIndices('{"cut":[3,3,99,-1,1]}', 5)).toEqual([1, 3]);
	});
	it("returns [] on garbage", () => {
		expect(parseCutIndices("no json here", 5)).toEqual([]);
	});
});

describe("buildKeepCutMessages", () => {
	it("numbers the transcript", () => {
		const caps: CaptionSegment[] = [
			{ startSec: 0, endSec: 1, text: "a" },
			{ startSec: 1, endSec: 2, text: "b" },
		];
		const msgs = buildKeepCutMessages(caps);
		expect(msgs[0]?.role).toBe("system");
		expect(msgs[1]?.content).toBe("0: a\n1: b");
	});
});

describe("aiKeepCut", () => {
	const caps: CaptionSegment[] = [
		{ startSec: 0, endSec: 1, text: "keep" },
		{ startSec: 1, endSec: 2, text: "呃" },
		{ startSec: 2, endSec: 3, text: "keep2" },
	];
	it("returns the model's cut indices", async () => {
		expect(await aiKeepCut(caps, config, mockFetch('{"cut":[1]}'))).toEqual([1]);
	});
	it("throws on HTTP error", async () => {
		await expect(aiKeepCut(caps, config, mockFetch("bad", 500))).rejects.toThrow(/LLM 500/);
	});
	it("short-circuits empty transcript", async () => {
		let called = false;
		const f = (async () => {
			called = true;
			return {} as Response;
		}) as unknown as typeof fetch;
		expect(await aiKeepCut([], config, f)).toEqual([]);
		expect(called).toBe(false);
	});
});

describe("transcriptToFirstCutAI", () => {
	it("cuts exactly the LLM-selected phrases via the real executor", async () => {
		const caps: CaptionSegment[] = [
			{ startSec: 0, endSec: 2, text: "intro" },
			{ startSec: 2, endSec: 2.3, text: "呃" },
			{ startSec: 2.3, endSec: 5, text: "body" },
		];
		const out = await transcriptToFirstCutAI(caps, "S", config, mockFetch('{"cut":[1]}'));
		expect(out.total).toBe(3);
		expect(out.applied).toBe(1);
		expect(out.regions.trimRegions).toHaveLength(2);
		expect(out.regions.annotationRegions.map((a) => a.textContent)).toEqual(["intro", "body"]);
	});
});

describe("loadLlmConfig", () => {
	it("returns null when no api key (no localStorage in node test env)", () => {
		expect(loadLlmConfig()).toBeNull();
	});
});
