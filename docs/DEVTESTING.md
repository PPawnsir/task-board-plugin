# 开发与测试（DEVTESTING）

面向贡献者的本地验证口径：无头集成套件怎么跑、CI 怎么继承、插件改动为什么要重启。
记录时间：2026-10-07（无头基建卡4，task-muxph8r2）。

## 无头集成测试套件

一条命令（在 `packages/dsh-agent-board` 下）：

```sh
npm test
```

- `pretest` 先自动跑 `npm run build-client` 拼装前端产物，再执行 `node --test test/**/*.test.mjs`——
  纯逻辑 + 无头宿主集成全套件一次跑完（当前 355 例，~6s），无需 dsh 环境。
- 套件本体是 `test/*.test.mjs`；`test/helpers/` 是**基建不是测试**（`mock-ctx.mjs` 提供假 cordis
  ctx / 临时 HOME / 虚拟时钟 / 剧本化 subagents），靠「只匹配 `*.test.mjs`」的文件名约定排除，
  不会被当测试跑。新增辅助文件请放 `helpers/` 或避免 `*.test.*` 命名。
- 实测避坑（Node v24.21.0，Windows）：`node --test test/` 目录形态**不可用**——位置参数被当
  入口模块解析，报 `MODULE_NOT_FOUND`；裸 `node --test` 的默认匹配规则含 `test/` 目录全量文件，
  会把 `helpers/mock-ctx.mjs` 也当测试执行（356 例 vs 355 例）。故脚本用递归 glob
  `test/**/*.test.mjs`：新文件自动拾取、helpers 不误跑、Node ≥22 行为一致。

## CI 继承（零改动）

仓库已有 [.github/workflows/test.yml](../.github/workflows/test.yml)：push 到 main 与 PR 触发，
Node 22 上跑三文件语法检查（`index.mjs` / `lib/client.js` / `lib/core.mjs`）+ 在
`packages/dsh-agent-board` 执行 `npm test`。**本次 test 脚本切换后 CI 自动继承全套件，无需改动
工作流**；`prepublishOnly` 门禁同样走 `npm test`，发版即同款验证。

## 插件热重载探针结论（实验支线 L3）

探针脚本：`packages/dsh-agent-board/scripts/reload-probe.cjs`
（`node scripts/reload-probe.cjs` 基线；`--watch N` 观测窗口轮询 RPC 路由）。

**能不能热重载：组合层能，代码层不能。**

1. **组合层（disable→enable）热生效**：本 profile `patchReload: live`（HMR 开）。2026-10-07 实测
   用管理工具 `plugin_manager set_plugin(include:agent-board)` 走一遍 disable→enable：路由
   `POST /dsh-agent-board` 在 +24.2s 消失（HTTP 405 空 body）、+49.5s 恢复（HTTP 200），全程未重启
   宿主；profile `cordis.patch.yml` 的 `agent-board` 行 `disabled` 值随 toggle 翻转并回写 `false`。
2. **代码层不可热重载**：宿主 ESM 模块表按 URL 缓存——重新挂载时 `import` 到的仍是**旧模块对象**，
   改 `index.mjs` / `lib/*.mjs` 后 disable→enable 不会拉到新代码（2026-10-06 Worker 探针实锤，
   本次复核口径一致）。**服务端改动一律重启 dsh 生效。**
3. **卡点记录**：管理接口只有两条通路——agent 工具 `plugin_manager`（需 danger-full-access 或
   审批）与 Web UI「Plugins」页（`pluginManager.setPluginEnabled` cordis 服务）；**无公开 HTTP
   端点**，外部脚本（如本探针）只能观测路由不能触发 toggle。前端产物 `lib/client.js` 属客户端
   模块图，浏览器刷新即拉新，不受此限。
