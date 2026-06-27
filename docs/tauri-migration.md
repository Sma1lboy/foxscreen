# Electron → Tauri 迁移

cuttio 从 Electron 壳迁到 **Tauri 2**(Rust 后端 + 系统 webview)。cutti 核心(`src/lib/cutti`)平台无关,零改动。

## 怎么跑

```bash
bun install              # 包管理已切 bun(bun.lock;migrated from package-lock)
bun run dev              # ★ 默认:Tauri 开发(= tauri dev;vite 17420 + Tauri 窗口)
bun run dev:electron     # 旧 Electron 路径(迁移期保留)
bun run tauri:build      # 打包(需补图标)
bun run selftest         # 自测 harness:tsc + biome + 单测 + cargo build + tauri-mode vite build
```
> Tauri 脚本里已 `PATH="$HOME/.cargo/bin:$PATH"`(cargo 不在默认 PATH)。
> selftest harness 用 `bun x` 跑工具链(见 `scripts/selftest.mjs`)。

## 架构

```
src-tauri/                Rust 壳(Tauri 2)
├── src/lib.rs            注册插件(fs/dialog/os/shell)+ get_platform / get_asset_base_url 命令
├── tauri.conf.json       frontendDist ../dist, devUrl :17420, beforeDevCommand=dev:web
├── capabilities/default.json  权限(fs 读写 + scope、dialog、os、shell open)
└── icons/icon.png

src/lib/tauri/electronApiShim.ts   ★ 迁移主体
   把整个 renderer 依赖的 window.electronAPI 重建在 Tauri 官方插件之上。
   main.tsx 在 Tauri 下 installElectronApiShim()(Electron 下 no-op)。

vite.config.ts            CUTTIO_SHELL=tauri 时跳过 vite-plugin-electron(不启动 Electron)
```

## 迁移映射(electronAPI ~55 方法)

- **核心 IO(已实现,走 Tauri 插件)**:readBinaryFile / openVideoFilePicker / pickExportSavePath /
  writeExportToPath / saveProjectFile / loadProjectFile(FromPath/Current) / getPlatform /
  setCurrentVideoPath 等 → `plugin-fs` 读写 + `plugin-dialog` 选择 + `invoke('get_platform')`。
- **录屏/HUD/菜单(stub,deferred)**:~28 个 native 录屏方法 + countdown/HUD/菜单回调 → 返回
  `{success:false}` / no-op / 空 unsubscribe。**录屏需把 ScreenCaptureKit/WGC 原生 helper 经 Rust 重桥,是单独大工程。**

## 已验证(self-test harness 全过)

tsc=0、biome 干净、`src/lib` 单测全过(cutti 引擎 + shim)、`cargo build` 编过、`CUTTIO_SHELL=tauri vite build`(3188 模块)打包过。

## 待办 / 风险

- **GUI 实测**:`tauri:dev` 起窗口后,需人工验证:导入视频 / cutti 初剪+AI剪 / 预览 trim-skip /
  **WebCodecs 导出在 WKWebView 能否跑**(这是 Tauri 相对 Electron 的主要风险点)。
- **录屏**:全 stub,要恢复得重桥原生 helper。
- **drag-drop 导入**:`getPathForFile` 在 webview 拿不到路径,返回 ""(改用文件选择器,或接 Tauri drag-drop 事件)。
- **assetBaseUrl**:dev 为空(captioning 走远端 CDN);打包需指向 resource dir。
- **打包图标**:`bundle.active=false`;要 `tauri build` 得用 `tauri icon` 生成完整图标集。
- **Electron 壳**:迁移期保留(`npm run dev`);稳定后可删 `electron/`。
