# cuttio

AI 视频剪辑器:**导入任意视频(也能从录制开始)→ 端上转写 → 按转写驱动剪辑(keep/cut)→ 真预览里剪 → 导出**。

cuttio 是 [cutti](./ref/cutti-swift)(原生 macOS/Swift 版,小剪)的跨平台 TypeScript 化,
fork 自 [OpenScreen](https://github.com/siddharthvaddem/openscreen)(MIT)—— 复用它的
Electron + Vite + React 录屏/编辑/Pixi 预览/Whisper 端上字幕/导出,在其上嫁接 cutti 的转写驱动剪辑大脑。

> 归属:大量 Electron 外壳、renderer、时间轴、WebCodecs 导出、Pixi 合成、端上字幕来自 OpenScreen(MIT)。
> 见 [`ATTRIBUTION.md`](./ATTRIBUTION.md)。原生 Swift cutti 完整保留于 [`ref/cutti-swift/`](./ref/cutti-swift) 作参考。

## 跑起来

```bash
npm install            # 见下方"证书注"
npm run dev            # Electron 窗口:导入视频 → 工具栏「cutti 字幕」试集成
```

- 引擎核心(纯逻辑)测试:`cd daemon && npm run test`
- 桥接 + 全量类型检查:`npx vitest run src/lib/cutti && npx tsc --noEmit`

**证书注**:`electron`/`sharp` 二进制从 github 下载,企业 TLS 拦截环境会失败。可配
`NODE_EXTRA_CA_CERTS=<企业根证书>`,或(本机/已授权)`NODE_TLS_REJECT_UNAUTHORIZED=0 npm rebuild sharp`
+ `node node_modules/electron/install.js`。

## 状态

详见 [`CLAUDE.md`](./CLAUDE.md) 与 [`docs/cuttio-plan.md`](./docs/cuttio-plan.md)。
当前:openscreen 真身可跑;cutti 桥(`src/lib/cutti`)已接入但目前只喂静态 demo;
真正的"自带转写 → LLM keep/cut → trim 真剪"集成仍在进行中。

## License

cuttio 源码遵循 [MIT](./LICENSE)(继承自 OpenScreen)。`ref/cutti-swift` 为原 cutti 项目,见其自带许可。
