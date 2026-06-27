/**
 * Minimal i18n. Chinese is the source of truth (per workspace convention);
 * every visible string goes through `t(key)`. English mirrors the same keys —
 * the `Strings` type makes a missing/extra key a compile error.
 */

export type Locale = "zh-Hans" | "en";

const zhHans = {
  "app.title": "cutti",
  "app.tagline": "转写驱动的剪辑 · daemon 引擎",
  "header.duration": "合成时长",
  "header.segments": "片段",
  "header.refresh": "刷新",
  "header.disconnected": "未连接 daemon",
  "timeline.empty": "时间轴为空。用一个含片段的 project.json 启动 daemon。",
  "toolbar.hint": "点击时间轴上的片段进行编辑",
  "toolbar.selected": "已选片段",
  "toolbar.source": "源区间",
  "toolbar.split": "中点分割",
  "toolbar.delete": "删除片段",
  "toolbar.speed": "速度",
  "toolbar.mute": "静音",
  "toolbar.unmute": "恢复音量",
  "range.title": "删除合成区间(秒)",
  "range.start": "起",
  "range.end": "止",
  "range.apply": "删除区间",
  "seg.subtitles": "字幕",
  "seg.muted": "静音",
  "status.ready": "就绪",
  "status.applied": "已应用",
  "status.skipped": "跳过",
} as const;

type Strings = Record<keyof typeof zhHans, string>;

const en: Strings = {
  "app.title": "cutti",
  "app.tagline": "transcript-driven editing · daemon engine",
  "header.duration": "composed",
  "header.segments": "segments",
  "header.refresh": "refresh",
  "header.disconnected": "daemon not connected",
  "timeline.empty": "Timeline is empty. Start the daemon with a project.json that has segments.",
  "toolbar.hint": "Click a segment on the timeline to edit it",
  "toolbar.selected": "Selected segment",
  "toolbar.source": "source range",
  "toolbar.split": "Split at midpoint",
  "toolbar.delete": "Delete segment",
  "toolbar.speed": "Speed",
  "toolbar.mute": "Mute",
  "toolbar.unmute": "Unmute",
  "range.title": "Delete composed range (s)",
  "range.start": "from",
  "range.end": "to",
  "range.apply": "Delete range",
  "seg.subtitles": "subs",
  "seg.muted": "muted",
  "status.ready": "ready",
  "status.applied": "applied",
  "status.skipped": "skipped",
};

const tables: Record<Locale, Strings> = { "zh-Hans": zhHans, en };

let current: Locale = "zh-Hans";

export function setLocale(locale: Locale): void {
  current = locale;
}

export function getLocale(): Locale {
  return current;
}

export function t(key: keyof typeof zhHans): string {
  return tables[current][key] ?? zhHans[key];
}
