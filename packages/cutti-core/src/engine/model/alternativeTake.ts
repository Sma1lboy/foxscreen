/**
 * One alternate recording of the same sentence / same meaning.
 *
 * Ported (minimally) from `CuttiKit.AlternativeTake` (AICopilotMetadata.swift).
 * Carried on a `TimelineSegment` and preserved verbatim by `makeDerivedSegment`
 * when a segment is split / trimmed / range-deleted, so the executor must round
 * it through unchanged.
 */
export interface AlternativeTake {
	id: string;
	sourceVideoID: string;
	startSeconds: number;
	endSeconds: number;
	text: string;
	/** Short label describing why the LLM grouped this as equivalent. */
	reason?: string;
}

export function alternativeTakeDuration(t: AlternativeTake): number {
	return t.endSeconds - t.startSeconds;
}

export function cloneAlternativeTake(t: AlternativeTake): AlternativeTake {
	return { ...t };
}
