import { useCallback, useEffect, useMemo, useState } from "react";

import {
  applyBatch,
  getProject,
  type ProjectView,
  type SegmentView,
  type UIAction,
} from "./api";
import { getLocale, setLocale, t, type Locale } from "./i18n";

function fmt(seconds: number): string {
  return `${seconds.toFixed(2)}s`;
}

const SPEEDS = [0.5, 1, 2] as const;

export function App() {
  const [project, setProject] = useState<ProjectView | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>(t("status.ready"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, forceRepaint] = useState(0);
  const [rangeStart, setRangeStart] = useState("0");
  const [rangeEnd, setRangeEnd] = useState("0");

  const refresh = useCallback(async () => {
    try {
      const r = await getProject();
      setProject(r.project);
      setPath(r.path);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = useMemo<SegmentView | null>(() => {
    if (!project || !selectedId) return null;
    return project.segments.find((s) => s.id === selectedId) ?? null;
  }, [project, selectedId]);

  const run = useCallback(
    async (label: string, action: UIAction) => {
      setBusy(true);
      try {
        const r = await applyBatch(label, [action]);
        setProject(r.project);
        setError(null);
        setStatus(
          `${label} · ${t("status.applied")} ${r.applied} · ${t("status.skipped")} ${r.skipped}`,
        );
        if (selectedId && !r.project.segments.some((s) => s.id === selectedId)) {
          setSelectedId(null);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [selectedId],
  );

  const toggleLocale = () => {
    const next: Locale = getLocale() === "zh-Hans" ? "en" : "zh-Hans";
    setLocale(next);
    setStatus(t("status.ready"));
    forceRepaint((n) => n + 1);
  };

  const total = project?.composedDurationSeconds ?? 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">✂</span>
          <div>
            <div className="title">{t("app.title")}</div>
            <div className="tagline">{t("app.tagline")}</div>
          </div>
        </div>
        <div className="meta">
          {project ? (
            <>
              <span>
                {t("header.duration")}: <b>{fmt(total)}</b>
              </span>
              <span>
                {t("header.segments")}: <b>{project.segments.length}</b>
              </span>
              {path && (
                <span className="path" title={path}>
                  {path.split("/").slice(-1)[0]}
                </span>
              )}
            </>
          ) : (
            <span className="warn">{t("header.disconnected")}</span>
          )}
          <button onClick={() => void refresh()} disabled={busy}>
            {t("header.refresh")}
          </button>
          <button onClick={toggleLocale}>{getLocale() === "zh-Hans" ? "EN" : "中"}</button>
        </div>
      </header>

      {error && <div className="error">⚠ {error}</div>}

      <main className="stage">
        {!project || project.segments.length === 0 ? (
          <div className="empty">{t("timeline.empty")}</div>
        ) : (
          <div className="track">
            {project.segments.map((s, i) => {
              const widthPct = total > 0 ? (s.composedDurationSeconds / total) * 100 : 0;
              const cls = [
                "clip",
                s.id === selectedId ? "sel" : "",
                s.speedRate !== 1 ? "speed" : "",
                s.volumeLevel === 0 ? "muted" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <button
                  key={s.id}
                  className={cls}
                  style={{ width: `${widthPct}%` }}
                  onClick={() => setSelectedId(s.id)}
                  title={s.text}
                >
                  <span className="clip-idx">#{i}</span>
                  <span className="clip-text">{s.text || s.id.slice(0, 6)}</span>
                  <span className="clip-foot">
                    {fmt(s.composedDurationSeconds)}
                    {s.speedRate !== 1 && <em> · {s.speedRate}×</em>}
                    {s.volumeLevel === 0 && <em> · {t("seg.muted")}</em>}
                    {s.subtitleCount > 0 && (
                      <em>
                        {" "}
                        · {s.subtitleCount} {t("seg.subtitles")}
                      </em>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </main>

      <section className="inspector">
        {selected ? (
          <>
            <div className="ins-head">
              <span className="ins-title">
                {t("toolbar.selected")} #{project!.segments.findIndex((s) => s.id === selected.id)}
              </span>
              <span className="ins-sub">
                {t("toolbar.source")} [{selected.startSeconds.toFixed(2)} →{" "}
                {selected.endSeconds.toFixed(2)}]s
              </span>
            </div>
            <div className="actions">
              <button
                disabled={busy}
                onClick={() =>
                  void run(t("toolbar.split"), {
                    type: "splitSegment",
                    id: selected.id,
                    atSourceTime: (selected.startSeconds + selected.endSeconds) / 2,
                  })
                }
              >
                {t("toolbar.split")}
              </button>
              <div className="group">
                <span className="group-label">{t("toolbar.speed")}</span>
                {SPEEDS.map((r) => (
                  <button
                    key={r}
                    className={selected.speedRate === r ? "on" : ""}
                    disabled={busy}
                    onClick={() =>
                      void run(`${t("toolbar.speed")} ${r}×`, {
                        type: "setSpeed",
                        id: selected.id,
                        rate: r,
                      })
                    }
                  >
                    {r}×
                  </button>
                ))}
              </div>
              {selected.volumeLevel === 0 ? (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(t("toolbar.unmute"), { type: "setVolume", id: selected.id, level: 1 })
                  }
                >
                  {t("toolbar.unmute")}
                </button>
              ) : (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(t("toolbar.mute"), { type: "setVolume", id: selected.id, level: 0 })
                  }
                >
                  {t("toolbar.mute")}
                </button>
              )}
              <button
                className="danger"
                disabled={busy}
                onClick={() => void run(t("toolbar.delete"), { type: "deleteSegment", id: selected.id })}
              >
                {t("toolbar.delete")}
              </button>
            </div>
          </>
        ) : (
          <div className="ins-hint">{t("toolbar.hint")}</div>
        )}

        <div className="range">
          <span className="group-label">{t("range.title")}</span>
          <label>
            {t("range.start")}
            <input
              type="number"
              step="0.5"
              value={rangeStart}
              onChange={(e) => setRangeStart(e.target.value)}
            />
          </label>
          <label>
            {t("range.end")}
            <input
              type="number"
              step="0.5"
              value={rangeEnd}
              onChange={(e) => setRangeEnd(e.target.value)}
            />
          </label>
          <button
            disabled={busy}
            onClick={() =>
              void run(t("range.apply"), {
                type: "deleteRange",
                start: Number(rangeStart),
                end: Number(rangeEnd),
              })
            }
          >
            {t("range.apply")}
          </button>
        </div>
      </section>

      <footer className="statusbar">{busy ? "…" : status}</footer>
    </div>
  );
}
