/**
 * Bring-your-own-key LLM keep/cut (step 2 of full cutti).
 *
 * An OpenAI-compatible chat client (configurable base URL + key + model) that
 * reads a transcript and decides which phrases to cut (filler, false starts,
 * dead air, off-topic). Returns the indices to drop; `firstCut` turns those into
 * a real `AIActionBatch`. No subscription / relay — the user's own endpoint.
 *
 * Config lives in localStorage (set via devtools or a future settings panel):
 *   cutti.llm.apiKey, cutti.llm.baseUrl (default OpenAI), cutti.llm.model
 */

import type { CaptionSegment } from "./captionSegment";

export interface CuttiLlmConfig {
	apiKey: string;
	baseUrl: string;
	model: string;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";

/** Read LLM config from localStorage. Returns null if no api key is set. */
export function loadLlmConfig(): CuttiLlmConfig | null {
	if (typeof localStorage === "undefined") return null;
	const apiKey = localStorage.getItem("cutti.llm.apiKey")?.trim();
	if (!apiKey) return null;
	return {
		apiKey,
		baseUrl: localStorage.getItem("cutti.llm.baseUrl")?.trim() || DEFAULT_BASE_URL,
		model: localStorage.getItem("cutti.llm.model")?.trim() || DEFAULT_MODEL,
	};
}

export function buildKeepCutMessages(
	captions: CaptionSegment[],
): Array<{ role: "system" | "user"; content: string }> {
	const numbered = captions.map((c, i) => `${i}: ${c.text}`).join("\n");
	return [
		{
			role: "system",
			content:
				"你是专业的口播视频剪辑助手。下面是一段视频的逐句转写(带序号)。" +
				"判断哪些句子应当剪掉:口头禅(呃/那个/嗯/um/uh)、明显的口误与重启、" +
				"重复啰嗦、长时间停顿或跑题的废话。保留有信息量、连贯的句子。" +
				'只输出 JSON,格式严格为 {"cut": [要删除的序号数组]}。不要解释。',
		},
		{ role: "user", content: numbered },
	];
}

/** Parse the model's reply into a list of cut indices. Tolerant of fences/prose. */
export function parseCutIndices(content: string, phraseCount: number): number[] {
	const match = content.match(/\{[\s\S]*\}/);
	const raw = match ? match[0] : content;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	const cut = (parsed as { cut?: unknown })?.cut;
	if (!Array.isArray(cut)) return [];
	const seen = new Set<number>();
	for (const v of cut) {
		const n = typeof v === "number" ? v : Number(v);
		if (Number.isInteger(n) && n >= 0 && n < phraseCount) seen.add(n);
	}
	return [...seen].sort((a, b) => a - b);
}

/**
 * Ask the LLM which transcript phrases to cut. `fetchImpl` is injectable for
 * tests; defaults to global fetch. Throws on HTTP / network error.
 */
export async function aiKeepCut(
	captions: CaptionSegment[],
	config: CuttiLlmConfig,
	fetchImpl: typeof fetch = globalThis.fetch,
): Promise<number[]> {
	if (captions.length === 0) return [];
	const res = await fetchImpl(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.apiKey}`,
		},
		body: JSON.stringify({
			model: config.model,
			temperature: 0,
			messages: buildKeepCutMessages(captions),
		}),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`LLM ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`);
	}
	const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
	const content = data.choices?.[0]?.message?.content ?? "";
	return parseCutIndices(content, captions.length);
}
