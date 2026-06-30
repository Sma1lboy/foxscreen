# 编辑器 v2 方向 — 对齐 `editor-v2-mockup.dc.html`

真相源:`docs/design/editor-v2-mockup.dc.html`(用户提供的完整版 mockup)。
配色就是我们现有 terracotta(mockup `#ea7a52` ≈ 我们 dark `--primary: 14 52% 58%`),方向一致。

## 设计系统(对齐 mockup)

- **字体**:UI = `Plus Jakarta Sans`;数字/时间码/元数据 = `IBM Plex Mono`(等宽)。当前用系统字体,需引入这两套(本地打包,不依赖 Google Fonts CDN)。
- **暗色 token**(微调现有 `--*`):chrome bg `#0d0e10`、面板 `#121417`/`#111316`、工具栏 `#0f1113`;边框 `rgba(255,255,255,.06~.09)`;强调 `#ea7a52`。
- **数值即等宽 + 橙色高亮**:时间码、百分比、增益等全部走 mono;激活/可调值用 `--primary` 橙。
- 圆角 8~10px、细边框、柔和阴影;icon-only 按钮配 i18n `title`。

## 与现状的结构性差异(= 要做的)

| mockup 元素 | 现状 | 差距 |
|---|---|---|
| 顶部菜单栏:File/Edit/View/Window/Help + 项目名「· 已自动保存」+ undo/redo 按钮 + **导出**主按钮 | 顶栏较简(语言/主题/Return/Load/Save) | 加菜单导航 + 项目名/自动保存指示 + undo/redo 按钮 + 导出主按钮(接 `handleExport`) |
| 媒体库:搜索框 + 筛选 chips(全部/视频/音频/图片)+ 2 列卡片网格(缩略图+时长+音频波形)+ 底部「共 N 个 · 大小」 | `MediaBin` 简单列表 | 搜索 / 筛选 / 网格卡片 / 波形 / footer 统计 |
| **Inspector 分页**:属性 / 颜色 / 音频 三 tab | 单层 inspector(clip 信息 + AUDIO mute/volume/fade) | 重构为 tab;新增 Transform(位置/缩放/旋转)、Composite(不透明度/混合模式)、Color(曝光/对比度/饱和度/色温 + 直方图) |
| 底部状态栏:就绪 · N 轨道 · N 片段 · 分辨率/fps/codec/时长 | 无 | 新增 28px 状态栏 |
| 时间线:fx 徽标、转场把手、吸附激活态、mono 标尺、缩放 | 大体已有(转场已做) | 视觉精修对齐 |

## 分片(建议顺序)

**S1 — 设计系统 + chrome(纯前端,headless 可验)**:引入双字体 + token 微调;顶部菜单栏(导出主按钮 + undo/redo + 项目名/自动保存);底部状态栏;时间线工具栏/标尺 mono 化与吸附激活态。**最高杠杆、风险低、`?seed=demo` 可截图验。**

**S2 — 媒体库增强(`MediaBin.tsx`)**:搜索 + 筛选 chips + 2 列卡片网格(缩略图/时长/音频波形)+ footer 统计。纯前端可验。

**S3 — Inspector 分页 shell + 音频 tab(`SettingsPanel`/`ClipInspector`)**:重构成 属性/颜色/音频 三 tab;音频 tab 接**现有** gain/mute/fade(clip 模型已有);属性 tab = 现有 clip 信息 + 不透明度;颜色 tab 先放 UI(引擎后置)。结构可验。

**S4 — 引擎能力(重,preview/导出,headless 验不了)**:Transform(位置/缩放/旋转)、Composite(不透明度/混合)、Color grading → clip 模型 + `sequenceExporter` 合成 + Pixi 预览滤镜。需用户跑 Tauri 实测。**最后做。**

S1–S3 让 app **看起来/用起来**像 mockup(可验);S4 才补真能力。每片仍 `selftest` 8/8 + i18n 同步 + 主题变量(不硬编码 hex)。
