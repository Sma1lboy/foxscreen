/**
 * @foxscreen/cutti-core — the portable cutti editing engine.
 *
 * The ported Swift `AIActionExecutor` (model + actions + persistence), the
 * bring-your-own-key LLM keep/cut, and the framework-agnostic transcript →
 * keep/cut pipeline. No renderer types, no DOM: runs in the Tauri renderer
 * (Web Crypto) and in node (the CLI harness) from this one source of truth.
 */

export * from "./captionSegment";
export * from "./demoProject";
export * from "./engine/actions/aiAction";
export * from "./engine/actions/executor";
export * from "./engine/actions/transcriptLookup";
export * from "./engine/model";
export * from "./engine/persistence/projectFile";
export * from "./llm";
export * from "./pipeline";
export * from "./types";
