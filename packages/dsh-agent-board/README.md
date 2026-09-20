# dsh-agent-board

DeepSeek Harness 智能看板 — 会话级任务管理 + 一次性 Worker/Verifier 派发。

## 功能

- **看板 UI**：会话标题栏「智能看板」按钮（Lucide 线性 SVG 图标，主题色自适应），顶部抽屉面板（看板 / 团队 / 仪表盘三视图），拖拽流转，多选批量操作（带一步撤销），筛选（文本/优先级/标签）
- **任务模型**：draft → pending → in-progress → verifying → resolved → archived，含 blocked/cancelled；优先级、标签、依赖（DFS 环检测）、流水线分档（full 执行+验证 / work 只做不验 / direct 主窗口直办）
- **一次性派发**：每个任务 spawn 一个一次性子代理，上下文全量注入 prompt，做完即销毁——无常驻池、无状态残留；孤儿回收 + 看门狗卡死标记（不自动杀，裁决权在主窗口/用户）
- **Team 模式**：开启后向主窗口注入提示词引导（实质性改动建议走看板派发，不硬拦截），Worker 歧义上报主窗口裁决（任何模式都通知）；任务完成/阻塞时主窗口收到批量聚合回执（等空闲再发，不打断对话）
- **验收**：可选 acceptance 硬性验收脚本，Worker 必须实跑、Verifier 独立复跑
- **异构模型**：⚙️ 弹出层 Worker/Verifier 均可下拉配置不同模型（避免同源盲点）。**默认空 = 继承父级模型**；模型故障自动熔断回退父级
- **手动/自动模式**：自动模式 poolCycle 调度；手动模式主窗口自行 claim（full 档仍自动派 Verifier 验收），详情页可「派发 / 派发验收」手动触发

## 安装

> 宿主要求：Node ≥ 22；DSH ≥ `0.1.5-rc.1`（已通过 `peerDependencies` 声明，含预发布分支的版本范围见 package.json）

```sh
dsh plugin --profile web add dsh-agent-board
```

重启 DSH 后生效。数据存于 `~/.dsh/tasks-<sessionId>.json`，卸载不删数据。

## 升级

```sh
dsh plugin --profile web add dsh-agent-board@latest
# 重启 DSH
```

## 源码与文档

- 仓库：<https://github.com/PPawnsir/task-board-plugin>
- 本包即源码，直接维护（v68 起拆除了动态→静态转换层，v74 起去池化）
- 单元测试：`npm test`（node --test，30+ 例纯逻辑用例，无需重启 dsh）

## 开发热循环（免重启 E2E）

host 代码（`index.mjs` / `lib/*.mjs`）改动必须进程重启才能加载，但不必动你正在用的主实例——
仓库提供一个独立 dev 实例 + 文件监听自动重启方案：

```sh
npm run dev        # = node scripts/dev-watch.cjs
# 浏览器打开 http://127.0.0.1:3081（独立 dev profile，不影响主实例）
```

- 改 host 代码 → 监听器自动重启 dev 实例（约 3-5s）→ 刷新 3081 页面即可验证
- 改 `lib/client.js` → **不用重启**，浏览器刷新即生效（client 包按请求从磁盘读）
- dev profile 在 `~/.dsh/profiles/dev`，只挂 base + web-app + 本插件；会话/看板数据与主实例共享 `~/.dsh`，两边互不干扰
- 官方 `cordis-plugin-hmr` 行在 web 部署里被 `disabled: true`（reload 生命周期未测完），实测对 link: 插件静默无效，故用 watcher 重启替代
