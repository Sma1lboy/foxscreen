#!/usr/bin/env bash
# UI gallery — screenshot the app's no-video states for visual QA review.
#
# Walks the reachable editor UI (empty state, the editor shell, every inspector
# rail panel, dark + light theme) in a headless browser and saves a PNG per state.
# An agent (or a human) then eyeballs the gallery to catch theme/layout/i18n drift
# without the Tauri shell. Video-preview states are skipped on purpose: <VideoPlayback>
# needs WebGL (Pixi), which headless Chromium lacks, so any project with a source
# crashes — these no-video states are where the visual bugs live anyway.
#
# Usage: bun run dev:web (port 17420) in another shell, then:
#   bash scripts/ui-gallery.sh [base_url] [out_dir]
set -u

URL="${1:-http://localhost:17420}"
OUT="${2:-/tmp/foxscreen-gallery}"
B=~/.claude/skills/gstack/browse/dist/browse
[ -x "$B" ] || { echo "browse binary not found at $B (run the gstack /browse setup once)"; exit 1; }
mkdir -p "$OUT"
rm -f "$OUT"/*.png 2>/dev/null || true

shot()  { "$B" screenshot "$OUT/$1.png" >/dev/null 2>&1 && echo "  saved $1.png"; }
click() { "$B" click "$1" >/dev/null 2>&1; }
theme() { "$B" js "localStorage.setItem('foxscreen.theme','$1')" >/dev/null 2>&1; }

enter_editor() {
  "$B" goto "$URL/?windowType=editor" >/dev/null 2>&1
  "$B" wait --networkidle >/dev/null 2>&1
  click "text=New Empty Project"
  "$B" wait --load >/dev/null 2>&1
  sleep 0.4
}

echo "== dark theme =="
theme dark
"$B" goto "$URL/?windowType=editor" >/dev/null 2>&1
"$B" wait --networkidle >/dev/null 2>&1
shot 01-empty

enter_editor
shot 02-editor-media
for pair in "Background:03-background" "Video Effects:04-effects" "Timeline:05-timeline-panel" "Terminal:06-terminal" "Export Video:07-export" "Crop Video:08-crop"; do
  click "[title=\"${pair%%:*}\"]"; sleep 0.3; shot "${pair##*:}"
  "$B" press Escape >/dev/null 2>&1   # close any modal (Crop) so the next click lands
done

echo "== light theme =="
theme light
enter_editor
shot 09-editor-light
click '[title="Background"]'; sleep 0.3; shot 10-background-light

# Populated project (?seed=demo): media bin + multi-track clip timeline + clip
# inspector all render headless (the video preview itself needs WebGL, so it shows
# the empty "no video" state — the editor chrome around it is the point here).
echo "== populated project (seed=demo) =="
theme dark
"$B" goto "$URL/?windowType=editor&seed=demo" >/dev/null 2>&1
"$B" wait --networkidle >/dev/null 2>&1
sleep 1.2
shot 11-demo-timeline
# select the first V1 clip to open the clip inspector (audio: mute/volume/fades)
"$B" js "(()=>{const els=[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&/sample-10s\.mp4/.test(e.textContent));const c=els.find(e=>e.getBoundingClientRect().top>540);c&&c.click();return 'ok';})()" >/dev/null 2>&1
sleep 0.4
shot 12-demo-clip-inspector

theme dark
echo "gallery: $OUT"
ls -1 "$OUT"
