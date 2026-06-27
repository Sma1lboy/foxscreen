import type { CuttiProject } from "./types";

/**
 * A self-contained cutti project used by the "Load cutti captions" editor action
 * to demo cutti's transcript-driven edits riding openscreen's real preview.
 * Mirrors examples/sample-project.json but adds a 2x segment so the demo shows
 * BOTH captions and a speed region. Times are source-video seconds; load it onto
 * any imported clip >= 24s long to see the overlays land.
 */
export const CUTTI_DEMO_PROJECT: CuttiProject = {
	version: 1,
	tracks: [
		{
			kind: "video",
			segments: [
				{
					id: "seg-1",
					sourceVideoID: "src-A",
					startSeconds: 0,
					endSeconds: 6,
					text: "今天聊聊我怎么把视频剪辑做成 agent 驱动的",
					speedRate: 1,
					subtitles: [
						{ relativeStart: 0, relativeDuration: 3, text: "今天聊聊我怎么把视频剪辑" },
						{ relativeStart: 3, relativeDuration: 3, text: "做成 agent 驱动的" },
					],
				},
				{
					id: "seg-2",
					sourceVideoID: "src-A",
					startSeconds: 6,
					endSeconds: 9,
					text: "呃……那个……就是说",
					speedRate: 1,
				},
				{
					id: "seg-3",
					sourceVideoID: "src-A",
					startSeconds: 9,
					endSeconds: 18,
					text: "核心就是把 project.json 当成唯一真相源",
					speedRate: 1,
					subtitles: [{ relativeStart: 0, relativeDuration: 4, text: "project.json 是唯一真相源" }],
				},
				{
					id: "seg-4",
					sourceVideoID: "src-A",
					startSeconds: 18,
					endSeconds: 24,
					text: "UI 和 Claude 都通过 daemon 改它",
					speedRate: 1,
				},
			],
		},
	],
};
