# cuttio — Electron/TS AI 视频剪辑器(openscreen fork + cutti 核心)

## 这是什么

cuttio 是 cutti(原生 Swift 版,小剪)的跨平台 TS 化:fork 自 **openscreen**(MIT,Screen Studio 替代品,
Electron+Vite+React+TS,**自带录屏 + 单条视频润色编辑器 + Pixi 预览 + Whisper 端上字幕 + 导出**),
在它之上嫁接 **cutti 的灵魂**——按转写驱动剪辑(keep/cut)、说话人分离、AI 剪辑方案。

目标:一个**导入任意视频(也能从录制开始)→ 用自带转写 → cutti 大脑出 keep/cut → 在真预览里剪**的视频剪辑软件。

原生 Swift 版完整保留在 **`ref/cutti-swift/`**(已删 .git,纯参考 + 移植真相源 / 测试 oracle)。

## 目录

```
/Users/jacksonc/i/cutti/   ← 本项目 (cuttio)
├── src/                    openscreen renderer (React/TS) + src/lib/cutti(cutti 桥)
├── electron/               Electron main/preload/ipc(录屏原生 helper、IPC)
├── daemon/                 cutti 引擎(AIActionExecutor 移植 + project.json + CLI + HTTP)★见下
├── ui/                     早期独立玩具 UI —— 已废弃,勿用
├── examples/               sample cutti project.json
├── docs/                   计划 / 决策记录
└── ref/cutti-swift/        原 Swift cutti(macos/ shared/CuttiKit/),移植真相源
```

## 集成状态(走向"全 cutti"的三步已接)

cutti 核心引擎已搬进 openscreen 进程内,且"导入视频 → 转写 → 真 keep/cut → 真预览里剪"链路打通。各部分:
1. **daemon/**(14 文件):cutti 引擎的**独立副本**(CLI/HTTP 用);openscreen 用进程内 `src/lib/cutti/engine/`,不直接引用 daemon。
2. **ui/**:废弃玩具,无关。
3. **src/lib/cutti/**(cutti 核心,已进 openscreen):
   - `engine/` = cutti 引擎(model + AIActionExecutor + persistence),**进程内、浏览器安全**(Web Crypto,去 node:fs/crypto)
   - `adapter.ts` 段→openscreen region;`integration.ts` 跑真 `applyActionBatch`
   - `firstCut.ts` 转写→真 keep/cut(去口头禅启发式 / 可换决策器);`llm.ts` 自带 key 的 OpenAI 兼容 keep/cut
   - `playback.ts` trim-skip 决策(preview 跳过被剪区间)

**三步(`VideoEditor` 工具栏按钮 + `VideoPlayback`):**
- **① 转写→真 keep/cut**:`cutti 初剪` = openscreen 自带 Whisper → cutti 引擎删口头禅/过短句
- **② 自带 key LLM**:`cutti AI 剪` = 转写 → LLM(localStorage `cutti.llm.apiKey`/`baseUrl`/`model`)选剪 → 引擎执行
- **③ trim 真剪**:`VideoPlayback` 播放时跳过 cut gap(`playback.ts`;无 trim 时 no-op,不动 openscreen 原行为)
- (`cutti 字幕` = 早期 demo 按钮,跑引擎的 deleteSegment+setSpeed)

**已验证**:全量 tsc=0、biome 干净、`src/lib/cutti` **34/34 vitest**、vite build 全部 bundle 进渲染层无 node 泄漏。

**待打磨(非阻塞)**:trim-skip 用 timeupdate(~4x/s),进 cut 可能过冲 ~250ms;frame-exact 需把 `composedToSource`
(已在 `adapter.ts`)接进播放钟。LLM key 走 localStorage(无设置 UI)。「cutti *」按钮文案硬编码(dev,待 i18n)。

> `daemon/` 仍保留独立引擎副本(CLI/HTTP);openscreen 用 `src/lib/cutti/engine/` 进程内副本。

## 硬规矩

- **i18n 必须同步**:用户可见文案走 `t("ns.key")`,不硬编码(中文为真相源)。注:openscreen 的 `i18n:check`
  本就有旧债键失败(autoZoom/autoFocus 等),非 cuttio 引入。`VideoEditor` 的「cutti 字幕」按钮目前是硬编码 dev 触发,productize 时补 i18n。
- **提交信息**:禁止任何 Claude/Anthropic/AI 署名或 "Generated with" footer。
- **删除**:未经明确"删除/remove"指令,不执行 rm 等破坏性操作。
- **MIT 归属**:保留 openscreen 的 `LICENSE` 与版权(见 `ATTRIBUTION.md`)。

## 常用命令

```bash
# cuttio 真身(默认 = Tauri;包管理已切 bun)—— 导入/编辑/预览/导出;端口 17420
bun install                      # 装依赖(已迁 bun.lock)
bun run dev                      # = tauri dev(默认壳已迁 Tauri);见 docs/tauri-migration.md
bun run dev:electron             # 旧 Electron 路径(迁移期保留)
bun run selftest                 # Tauri 迁移自测:tsc+biome+单测+cargo build+tauri-mode vite build

# cutti 引擎核心(纯逻辑,独立)
cd daemon && npm run test && npm run typecheck

# 桥接测试 / 全量类型检查
npx vitest run src/lib/cutti && npx tsc --noEmit
```

> 环境注:`electron`/`sharp` 二进制从 github 下载会撞企业 TLS 拦截。已在用户授权下用
> `NODE_TLS_REJECT_UNAUTHORIZED=0 npm rebuild sharp` + `node node_modules/electron/install.js` 补齐。
> 重装依赖若再撞证书,同法处理(或配 `NODE_EXTRA_CA_CERTS`)。
