# cuttio 计划与决策记录

> 外部记忆(external memory)。跨会话延续用。记录"为什么这么做",代码里看不出来的部分。

## 动机(用户原话归纳)

1. SwiftUI 改着痛,更熟 Web 栈
2. 想跨平台到 Windows/Linux
3. 觉得原生版架构乱(614KB 上帝 ViewModel + 一次性 AI 流水线),想借机重构
4. 想开源能自托管:用户自带 API key,不锁在云后端 relay

## 已定决策

| 项 | 决策 | 理由 |
|---|---|---|
| 壳 | Electron(fork openscreen) | 自带 Chromium → WebCodecs/Pixi 全特性保证;Tauri 的系统 webview(WKWebView)WebCodecs 残缺不可靠 |
| daemon 语言 | TypeScript/Node | 与前端同语言,一人维护;spawn ffmpeg,直译 AIActionExecutor |
| 基线 | openscreen(MIT,已 archived) | 白捡 Electron 媒体导出 + Pixi 预览 + 时间轴 + Whisper 这几块硬地基 |
| 录屏 | **暂时保留**,不删 | 用户指示;也省得做删除。以后可作为 cutti 的附加能力 |
| ASR | 保留 Python Qwen sidecar,Electron 拉起 | whisper-tiny 对中文是硬降级;Qwen ForcedAligner 给逐字 CJK 时间戳 |
| 分离 | sherpa-onnx-node | 同一套 C 库,Swift wrapper 近 1:1;~250 行后处理纯逻辑机械移植 |
| 媒体 | 先用 openscreen WebCodecs(H.264 MP4);ProRes/HEVC 以后挂 ffmpeg-static | 目标是发 X/YouTube 的成片,H.264 够用 |
| 自托管 | 删 relay,直连 OpenAI 兼容 endpoint + 自带 key | 动机 4 |

## 报告裁决(openscreen→cutti 逐子系统映射,见 workflow 报告)

- **App 壳** → 上 Electron,且 Electron 在这块**确实更好**(消掉 cutti ~250 行 AppKit hack)。fidelity: close。
- **ASR/分离** → 保留 native/Python sidecar;只把编排+分离+glue 移植 TS。fidelity: close。**拒绝 whisper-tiny**。
- **媒体引擎** → 唯一硬回归。openscreen WebCodecs+Pixi 在 ProRes/帧精准 scrub/HDR/双渲染器一致性上**确实比 AVFoundation+Metal 差**。可接受(消费向 H.264 目标),专业路径挂 ffmpeg。
- **CuttiKit 逻辑** → 数据模型 + AIActionExecutor + 几何/规划数学,**近乎 drop-in 直译 TS,以现有单测为 oracle**。这是最干净的复用。

## 路线图(分期,不要 big-bang)

- **M1 — daemon 编辑核心(✅ 完成)**:TS 移植 `Project/Track/TimelineSegment/SubtitleEntry` 数据模型 +
  `AIActionExecutor`(12 个时间轴/字幕文本动作)+ `project.json` 持久化 + CLI(load/apply/save)。以 Swift 单测为 oracle。
  字幕**样式**系统(setSubtitleStyle/setSubtitlesVisible)留到 M2。
  - 产物:`daemon/src/{model,actions,persistence,cli.ts}`,38 个 vitest 全绿,typecheck 干净。
  - 3 个只读对抗 agent 逐边比对 TS↔Swift:**零正确性偏差**;唯一分歧(`makeReplacer` 正则 ICU vs JS)已修复
    (支持前导 `(?i)` 内联 flag + ICU `$0`→JS `$&` 模板翻译),并加了回归测试。
  - CLI 闭环已冒烟验证:`init → inspect → apply(deleteRange+setSpeedRange) → save`,composed-time 数学正确。
- **M2 — 字幕样式 + HTTP/WS**:✅ HTTP 已落地(`daemon/src/server.ts`,`node:http` 零依赖:`GET /api/project`、`POST /api/apply`、CORS;每次 apply 落盘)。`daemon/src/view.ts` 提供 `ProjectView` DTO。字幕样式 patch 仍待做。
- **M3 — 媒体接线**:ffmpeg-static 抽音/导出;接 openscreen 的 WebCodecs 导出到 project.json。
- **M4 — ASR/分离 sidecar**:Electron 拉起 Python Qwen sidecar;sherpa-onnx-node 分离。
- **M5 — LLM 剪辑**:自带 key/OpenAI 兼容;转写驱动 keep/cut 提案。
- **M6 — skills + 侧栏 terminal**:Claude 通过 daemon CLI 编辑 project.json;prompt → skills。
- **M7 — UI**:✅ 已做出**独立可运行的 cutti 编辑器 UI**(`ui/`,Vite+React+TS,复用 openscreen 栈但最小依赖)。
  时间轴按合成时长成比例渲染片段,点选片段 → inspector(中点分割 / 0.5×·1×·2× / 静音 / 删除片段 / 删除区间),
  全部经 daemon HTTP 改 `project.json`。含最小 i18n(中文为源 + EN)。`vite build` 干净、`/browse` 截图确认渲染、无 console 错误。

## 进展快照(M1 + HTTP + UI 已活)

跑起来:
```bash
# 1) 引擎:daemon HTTP(示例项目)
cd daemon && npm run serve -- ../examples/sample-project.json --port 4317
# 2) UI:Vite(代理 /api → 4317)
cd ui && npm install && npm run dev      # http://localhost:5317
```
端到端验证过:`GET /api/project`(4 段/24s)→ `POST /api/apply`(删 filler + seg 提速 2×)→ composed 24→16.5s,UI 实时反映。

**纠偏**:独立 web UI 是走偏了——用户要的是 **openscreen 真正的编辑器 + Pixi 预览**当中间层。已转入 openscreen 真身集成。

## openscreen 真身集成(进行中)

**openscreen 模型实情**(读 `src/components/video-editor/types.ts` + `useEditorHistory.ts` + `VideoPlayback.tsx`):
单条录屏 + 扁平 region 数组(Zoom/Trim/Speed/Annotation,**源时间 ms**),`EditorState` 经 `useEditorHistory` 管理。
关键:**composed-time == source-time,TrimRegion 没在 preview/export 里生效**(stub)。cutti 的"按转写保留子集 + 变速"
恰好能映射成 Trim/Speed/字幕 Annotation,缺的是 **composed→source 时间重映射**让 trim 真正剪。

**已落地(`src/lib/cutti/`,对着 openscreen 真实类型,7/7 vitest 绿、零类型错)**:
- `adapter.ts`:`cuttiToRegions`(段 → TrimRegion+SpeedRegion+caption AnnotationRegion,源 ms)、
  `cuttiProjectToEditorState`(cutti 项目 → 完整 `EditorState`)、`buildComposedTimeline`(composed↔source 映射 +
  `composedToSource`,即 preview 缺的那块时钟,移植自 CuttiKit `sourceTime`)。
- 限制(v0):仅主视频轨、假定源顺序(转写 keep/cut 场景)。reorder / 多源 insert 超出 openscreen 单源扁平模型,未覆盖。

**运行拦路 → 已解决**:`electron`/`sharp` 二进制从 github 下载撞企业 TLS 拦截。用户**授权对这次安装关 TLS**
(`NODE_TLS_REJECT_UNAUTHORIZED=0 npm rebuild sharp` + `node electron/install.js`),两个二进制补齐。
**openscreen 真身现已能跑**:`npm run dev` → vite(5174)+ vite-plugin-electron 构建 main.js/preload + 启动 Electron 窗口;
渲染层加载无 console 错。**全量 `tsc --noEmit` = 0 错误**(含 `src/lib/cutti`),vite build 通过,`src/lib/cutti` 10/10 vitest
绿(含读真实 `examples/sample-project.json` 的端到端转换)。

**下一步(需在运行的 app 里实测)**:把 `composedToSource` 接进 `VideoPlayback`(2167 行)的 ticker/seek/scrub,
让 trim 在 Pixi 预览里真生效(playhead=composed,`video.currentTime=composedToSource(playhead)`,过段边界 seek)。
这是核心播放钟改动 + seek 延迟取舍,须配合运行的 Electron 窗口逐步验,不盲改。还需一个"把 cutti 项目 + 源视频载入编辑器"的入口。

## 真相源 / oracle

原生 Swift 版:`/Users/jacksonc/i/cutti/ref/cutti-swift`
- 移植真相源:`ref/cutti-swift/shared/CuttiKit/Sources/CuttiKit/{Core/AIActionSystem.swift, Project/AICopilotMetadata.swift, Project/Project.swift, Project/EditorRevision.swift}`
- 测试 oracle:`ref/cutti-swift/shared/CuttiKit/Tests/CuttiKitTests/`(InsertSourceClipExecutorTests、SubtitleEntrySplitMerge 等)
