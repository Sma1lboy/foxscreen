# foxscreen — Tauri/TS AI 视频剪辑器(openscreen fork + cutti 核心)

## 这是什么

foxscreen(codefox 家族,明确继承自 openscreen)是 cutti(原生 Swift 版,小剪)的跨平台 TS 化:
fork 自 **openscreen**(MIT,Screen Studio 替代品,**自带录屏 + 单条视频润色编辑器 + Pixi 预览 +
Whisper 端上字幕 + 导出**),迁到 **Tauri**(Rust 壳 + 系统 WebView),在它之上嫁接 **cutti 的灵魂**
——按转写驱动剪辑(keep/cut)、说话人分离、AI 剪辑方案。

目标:一个**导入任意视频(也能从录制开始)→ 用自带转写 → cutti 大脑出 keep/cut → 在真预览里剪**的视频剪辑软件。

原生 Swift 版完整保留在 **`ref/cutti-swift/`**(已删 .git,纯参考 + 移植真相源 / 测试 oracle)。

## 目录(bun workspaces monorepo)

```
/Users/jacksonc/i/cutti/        ← 仓库根(workspace 编排;依赖 hoist 在根)
├── packages/
│   ├── cutti-core/             @foxscreen/cutti-core —— 可移植引擎(browser+node 都安全)
│   │     src/engine/           model + AIActionExecutor + persistence(纯,Web Crypto)
│   │     src/llm.ts            自带 key 的 OpenAI 兼容 keep/cut
│   │     src/pipeline.ts       转写→keep/cut→编辑后 flat Project(无渲染类型)
│   │     src/captionSegment.ts CaptionSegment 单一真相源
│   ├── cli/                    @foxscreen/cli —— 无 GUI 的 agent 测试入口(见下)
│   │     src/cli.ts            init / inspect / apply / firstcut / ai
│   │     fixtures/             sample-transcript.json
│   └── desktop/                @foxscreen/desktop —— Tauri app(openscreen 真身)
│         src/                  renderer(React/TS)+ src/lib/cutti(desktop 桥,接 core)
│         src-tauri/            Tauri main/lib/conf/capabilities(Rust 壳)
├── examples/                   sample cutti project.json
├── scripts/selftest.mjs        自测 harness(8 步)
├── docs/                       计划 / 决策记录(含 tauri-migration.md)
└── ref/cutti-swift/            原 Swift cutti,移植真相源
```

## 集成状态

cutti 引擎已抽成共享包,"导入视频 → 转写 → 真 keep/cut → 真预览里剪"链路打通。架构接缝:

1. **packages/cutti-core**(`@foxscreen/cutti-core`):纯引擎,**无渲染类型、browser+node 安全**。
   desktop 渲染层(Web Crypto)和 cli(node)从这**一份**源跑同一套逻辑——消灭了原 daemon 的重复副本。
   - `pipeline.ts` = 转写→`runFirstCut`/`runFirstCutAI`→编辑后 flat Project(启发式去口头禅 / LLM 决策器 / 真 `applyActionBatch`)
2. **packages/cli**(`@foxscreen/cli`):headless harness,**让 agent 不开窗口就能测全链路**。
   `firstcut <transcript.json>` = 转写→真 keep/cut→`project.foxscreen` + 剪除摘要;`inspect` 验证产物。
3. **packages/desktop/src/lib/cutti**(desktop 桥,依赖 core):
   - `adapter.ts` flat Project→openscreen region(耦合 `@/components/video-editor/types`、`@/hooks/useEditorHistory`)
   - `firstCut.ts` / `integration.ts` = 调 core 的纯 pipeline,再 `cuttiToRegions` 映射成 region
   - `playback.ts` trim-skip 决策(preview 跳过被剪区间)

**desktop 三步(`VideoEditor` 工具栏 + `VideoPlayback`):**
- **① 转写→真 keep/cut**:`cutti 初剪` = 自带 Whisper → core 引擎删口头禅/过短句
- **② 自带 key LLM**:`cutti AI 剪` = 转写 → LLM(localStorage `cutti.llm.apiKey`/`baseUrl`/`model`)选剪 → 引擎执行
- **③ trim 真剪**:`VideoPlayback` 播放跳过 cut gap(`playback.ts`;无 trim 时 no-op)
- (`cutti 字幕` = demo 按钮,跑引擎 deleteSegment+setSpeed)

**标准 NLE 时间线**(`timeline/`,在转写驱动之上长出的常规剪辑器骨架):
- `clipModel.ts` = `TimelineClip` 模型 + 纯函数(split/duplicate/nudge/offset/paste/rippleDelete/gainAt…,均单测)。
- `trackModel.ts` = `TimelineTrack`(mute/solo/lock/kind)+ 纯函数(`isTrackAudible` solo 优先、`effectiveClipGain`、
  add/removeTrack 重排、lock 查询;均单测)。playback(`timelineRender.planAudioGainAt`)与导出
  (`exporter/sequenceExporter`)都按轨道 mute/solo 计音量。
- `ClipTimeline.tsx` = 多轨道直接操作:拖动移动/跨轨、左右把手 trim、磁吸开关、缩放;每轨左侧 124px **固定 header 槽**
  (mute/solo/lock/删除),所有时间元素右移 `TRACK_HEADER_WIDTH` 避免遮挡(指针↔时间映射要减回去)。
- **键盘**(`VideoEditor` 捕获 keydown):Delete/Shift+Delete(普通/ripple)、S/B split、Cmd+D 复制、Cmd+C/V、
  方向键 nudge(Shift=1s);锁定轨道的 clip 全部跳过;不冲突已有 undo/redo/Space。
- **多选**:`selectedClipIds: string[]`(单选时派生 `selectedClipId` 喂单 clip inspector)。Shift/Cmd-click 切换、
  空白处 marquee 框选(`clipsInMarquee` 纯函数+单测);拖动选中之一 = 整组同移;删/复制/nudge/split 全作用于选区
  (锁定的 clip 跳过),每个 bulk 操作一条 undo;>1 时 inspector 显示「N clips selected」+ Mute all / Delete。
- **叠化转场**(`transitionModel.ts`,MVP = 给两个同轨重叠 clip 的重叠区做 crossfade,不 ripple/不移 clip):
  `Transition{id,fromClipId,toClipId}` 只存 id,窗口由 clip 当前位置实时算(`overlapWindow`/`activeTransitions`,拖开即自动失效);
  `crossfadeAlpha` 线性。时间线在重叠区给 + 加 / 点 hatch 删(各一条 undo,进 `useEditorHistory`+持久化);
  导出 `sequenceExporter` 在窗口内解码两 clip 帧按 alpha 混合。**Pixi 实时预览暂不渲染转场**(headless 验不了)。均单测(29 例)。

**主题**:terracotta 暖橙(取自 kobe Claude 品牌色 + codefox shadcn 变量结构);`ThemeContext` + 工具栏
`ThemeToggle`(light/dark/system,持久化 localStorage `foxscreen.theme`)。light 模式已基本补齐(media/preview/
时间线/面板都走变量);openscreen 个别深色面板仍有零星硬编码,见到即接变量(emerald→`--primary` 已扫多处)。

**自助冒烟(headless QA)**:`bun run dev:web`(:17420)+ `browserDevMock`(非 Tauri+DEV 装惰性 native-bridge mock,
对 cursor 等按真 shape 返回空数据)→ `?seed=demo` 渲染**完整带 clip 的编辑器**(媒体库+多轨时间线+clip inspector)。
`scripts/ui-gallery.sh` 截所有页面(空/各面板/light/dark/populated)供 `/browse` 复核;`main.tsx` DEV 全局 error
logger 把真实抛错打到 console(React 只打组件栈)。预览 `VideoPlayback`(Pixi/WebGL)在 headless 仍崩,故预览本身验不了。

**统一 undo/redo**:`useEditorHistory` 已扩到含 `timelineClips`+`tracks`(单一栈,Cmd+Z/Y 同覆盖 region 与
clip/轨道)。拖动/trim 一次手势 = 一条 undo(手势末提交);split/dup/paste/delete/ripple/nudge、轨道 mute/solo/lock、
加/删轨各一条(删轨 = 轨+其 clip 原子一条)。派生 seed effect 走 `replacePresent`(不进历史)。`applyLoadedProject`
把 clips/tracks 折进同一 `pushState`(载入后不能 Cmd+Z 回上一个项目)。纯 reducer 已导出+单测。

**已验证**:`bun run selftest` **8/8 全绿** —— desktop/core/cli 三处 tsc=0、biome 干净、
vitest 全绿(含 clipModel/trackModel/useEditorHistory 纯函数)、cli firstcut 冒烟、cargo build、tauri-mode vite build。
clip 编辑 / 轨道控制 / 载入经 `?seed=demo` headless 实测无回归(Cmd+D 复制、mute 高亮、+加轨)。

**纯 Tauri(Electron 已移除)**:`packages/desktop/electron/`、`electron-builder.json5`、vite-plugin-electron、
electron 系依赖、openscreen 旧 Electron CI(build.yml/winget/nix/homebrew/discord)全部删除。`window.electronAPI`
类型搬到 `src/native/electron-api.d.ts`(ambient 全局,运行时由 `electronApiShim` 提供)。原 Electron 原生录屏后端
(ScreenCaptureKit Swift / wgc-capture C++)随之删除——录屏在 Tauri 下仍 stubbed(`RECORDING_DEFERRED`),将来 Rust 侧重写。

**发版 / Windows 测试**:`tauri.conf.json` `bundle.active:true` + 全套图标(`icons/icon.ico` 等,`tauri icon` 生成)。
本机 `bun run --cwd packages/desktop tauri:build` 出 mac `.dmg`(已验)。**Windows 不能在 mac 交叉编译** →
`.github/workflows/release.yml`(tauri-action,windows+mac,手动 dispatch 或 `v*` tag)在 CI 出 `.msi`/`.exe` 上传为 artifact;
需先把仓库 push 到 GitHub remote(当前无 remote)。`ci.yml` 改成 bun `selftest` 门禁。

**待打磨(非阻塞)**:`mediaAssets` 仍非 undoable(撤销某 asset 最后一条 clip 会被 seed effect 重新补一条占位 —
沿用既有 seed 语义)。trim-skip 用 timeupdate(~4x/s),进 cut 可能过冲 ~250ms。LLM key 走 localStorage(无设置 UI)。
「cutti *」+ ThemeToggle 文案硬编码(dev,待 i18n)。

## 硬规矩

- **i18n 必须同步**:用户可见文案走 `t("ns.key")`,不硬编码(中文为真相源)。注:openscreen 的 `i18n:check`
  本就有旧债键失败(autoZoom/autoFocus 等),非本项目引入。「cutti *」/ThemeToggle 按钮目前硬编码 dev 触发,productize 时补 i18n。
- **提交信息**:禁止任何 Claude/Anthropic/AI 署名或 "Generated with" footer。
- **删除**:未经明确"删除/remove"指令,不执行 rm 等破坏性操作。
- **MIT 归属**:保留 openscreen 的 `LICENSE` 与版权(见 `ATTRIBUTION.md`)。

## 常用命令

```bash
bun install                      # 装依赖(workspace,bun.lock;依赖 hoist 在根)

# desktop 真身(默认 = Tauri;端口 17420)—— 导入/编辑/预览/导出
bun run dev                      # 根脚本 → cd packages/desktop && tauri dev;见 docs/tauri-migration.md
bun run selftest                 # 8 步自测:desktop/core/cli tsc + biome + vitest + cli 冒烟 + cargo + vite build

# 发版构建(安装包)
bun run --cwd packages/desktop tauri:build   # 本机平台安装包(mac=.dmg);bundle.active 已开
# Windows 安装包:push 到 GitHub 后,Actions → "Release build"(release.yml,tauri-action)手动跑,下 artifact

# cutti 引擎 / agent 无 GUI 测试入口(@foxscreen/cli)
bun run packages/cli/src/cli.ts firstcut packages/cli/fixtures/sample-transcript.json --out /tmp/p.foxscreen
bun run packages/cli/src/cli.ts inspect /tmp/p.foxscreen
# LLM 版:CUTTI_LLM_API_KEY=sk-... bun run packages/cli/src/cli.ts ai <transcript.json> --out p.foxscreen
```

> 环境注:`electron`/`sharp` 二进制从 github 下载会撞企业 TLS 拦截。已在用户授权下用
> `NODE_TLS_REJECT_UNAUTHORIZED=0 npm rebuild sharp` + `node node_modules/electron/install.js` 补齐。
> 重装依赖若再撞证书,同法处理(或配 `NODE_EXTRA_CA_CERTS`)。
