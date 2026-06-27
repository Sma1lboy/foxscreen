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
│         electron/             旧 Electron main/preload(迁移期保留)
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

**主题**:terracotta 暖橙(取自 kobe Claude 品牌色 + codefox shadcn 变量结构);`ThemeContext` + 工具栏
`ThemeToggle`(light/dark/system,持久化 localStorage `foxscreen.theme`)。注:openscreen 部分面板硬编码深色,
light 模式尚未完整(待把硬编码色接进主题变量)。

**已验证**:`bun run selftest` **8/8 全绿** —— desktop/core/cli 三处 tsc=0、biome 干净、
193 vitest、cli firstcut 冒烟、cargo build、tauri-mode vite build。

**待打磨(非阻塞)**:trim-skip 用 timeupdate(~4x/s),进 cut 可能过冲 ~250ms。LLM key 走 localStorage(无设置 UI)。
「cutti *」+ ThemeToggle 文案硬编码(dev,待 i18n)。录屏在 Tauri 壳下 stubbed(`RECORDING_DEFERRED`)。

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

# cutti 引擎 / agent 无 GUI 测试入口(@foxscreen/cli)
bun run packages/cli/src/cli.ts firstcut packages/cli/fixtures/sample-transcript.json --out /tmp/p.foxscreen
bun run packages/cli/src/cli.ts inspect /tmp/p.foxscreen
# LLM 版:CUTTI_LLM_API_KEY=sk-... bun run packages/cli/src/cli.ts ai <transcript.json> --out p.foxscreen
```

> 环境注:`electron`/`sharp` 二进制从 github 下载会撞企业 TLS 拦截。已在用户授权下用
> `NODE_TLS_REJECT_UNAUTHORIZED=0 npm rebuild sharp` + `node node_modules/electron/install.js` 补齐。
> 重装依赖若再撞证书,同法处理(或配 `NODE_EXTRA_CA_CERTS`)。
