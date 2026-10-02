# Task Board Plugin for DeepSeek Harness

[![npm](https://img.shields.io/npm/v/dsh-agent-board)](https://www.npmjs.com/package/dsh-agent-board)
[![npm downloads](https://img.shields.io/npm/dw/dsh-agent-board.svg)](https://www.npmjs.com/package/dsh-agent-board)
[![node](https://img.shields.io/node/v/dsh-agent-board.svg)](https://www.npmjs.com/package/dsh-agent-board)
[![license](https://img.shields.io/npm/l/dsh-agent-board)](https://github.com/PPawnsir/task-board-plugin/blob/main/LICENSE)
![category](https://img.shields.io/badge/awesome--dsh--plugin-workflow-blue)

智能看板插件 — Agent 自主任务驱动开发：看板管理 + 一次性 Worker/Verifier 派发 + 依赖调度 + Team 模式。

## 安装

### 前置条件

- DeepSeek Harness（dsh）已安装并能正常启动：`dsh --profile web`
- Node.js ≥ 22（与 dsh 运行时一致）

### 版本兼容性（先按宿主选插件版本）

| 宿主 DSH 版本 | 应装插件版本 | 原因 |
| --- | --- | --- |
| **≥ 0.2.0**（含 rc） | **≥ 1.3.0（必须）** | 0.2.0 起宿主在启动/安装时强制校验 peerDependencies，区间不含 0.2.0 的包**直接拒绝激活**（路由不挂载、面板不出现）。1.3.0 声明 `^0.1.7 \|\| 0.2.0-rc.2 \|\| ^0.2.0`——注意 semver 预发布不命中宽区间，`0.2.0-rc.2` 必须显式枚举。运行时 API（subagents/systemPrompt/agents/uiWorkspace.openSession/sessions/v4 日志格式）在 0.2.0 全部兼容，已过 0.2.0-rc.2 实测（E2E 23+8 断言全绿） |
| **0.1.7 ~ 0.1.7-x**（含 rc） | **≥ 1.2.2（必须）** | 0.1.7 会话日志升级为 format v4：插件消息 `source.kind` 必须是生产者自有 kind。1.2.1 及更早会在**任务完成/阻塞回执**落盘时抛 `SessionFormatError: format v4 message requires a producer-owned source kind`，并连带使主窗口当前轮次失败（表现为「本轮运行失败」）；同时「跳转会话」因宿主移除 `sessions.open` 而失效（控制台 `sessionsSvc.open is not a function`），卡片活动心跳读不到 v4 日志（`session.v4.jsonl.zstd`） |
| 0.1.5-rc.1 ~ 0.1.6 | ≤ 1.2.1 | 1.2.2 起按 0.1.7 协议编写（v4 source kind、`uiWorkspace.openSession` 跳转），旧宿主未做回归验证，建议停留 1.2.1 |

```sh
dsh plugin --profile web add dsh-agent-board@latest   # 0.1.7+/0.2.x 宿主（推荐）
dsh plugin --profile web add dsh-agent-board@1.2.1    # 0.1.5/0.1.6 宿主
```

> 从 ≤1.2.1 升到 ≥1.2.2 必须重启 DSH（host 端代码在启动时加载；1.2.2 之前的老版本还有一个路由残留 bug：禁用/启用热重载会撞 `duplicate exact route`，只能重启恢复，1.2.2 已修复）。

### 从插件市场安装（推荐）

已发布至 npm 官方 registry（[dsh-agent-board](https://www.npmjs.com/package/dsh-agent-board)）：

```sh
dsh plugin --profile web add dsh-agent-board
# 重启 dsh 生效
dsh --profile web
```

### 从源码安装（开发/调试）

```sh
git clone https://github.com/PPawnsir/task-board-plugin.git
dsh plugin --profile web add <本仓库绝对路径>/packages/dsh-agent-board
# 重启 dsh
```

### 验证安装

1. 启动日志无 `plugin tree failed to load`
2. 打开任意会话，标题栏出现 **智能看板** 按钮（Lucide 线性图标）
3. RPC 路由可用：

```sh
curl -X POST http://127.0.0.1:3080/dsh-agent-board \
  -H "Content-Type: application/json" \
  -d '{"method":"get-tasks","args":{"sessionId":"<sessionId>"}}'
```

返回 JSON 即正常；405 空 body 说明路由未挂载。

### 升级

```sh
# 市场版
dsh plugin --profile web add dsh-agent-board@latest
# 源码版
git pull
# 两者都需重启 dsh
```

### 卸载

```sh
dsh plugin --profile web remove dsh-agent-board
# 重启 dsh
```

> 看板数据存在 `~/.dsh/tasks-<sessionId>.json`，卸载不删数据。

## 功能总览

### 看板 UI

- 会话标题栏「智能看板」按钮 → 顶部抽屉面板（看板 / 团队 / 仪表盘三视图）
- 六列状态流：草稿 → 待办 → 进行中 → 验证中 → 已完成 → 阻塞
- 拖拽流转、多选批量操作（带一步撤销）、文本/优先级/标签筛选
- 归档区：时间倒序 + 排序选择器 + 纵向滚动
- Esc 逐级关闭（详情 → 看板 → 面板）
- 全部结构性图标为 Lucide 线性 SVG（`currentColor` 跟随主题，浅深色自适应）

### 任务模型

```
draft → pending → in-progress → verifying → resolved → archived
                     ↓              ↑
                  blocked ←────── reject
```

- **草稿态（draft）**：创建时可先进草稿，补全描述/依赖后再发布，杜绝"半成品被派发"
- **依赖调度**：`dependsOn` 声明依赖（DFS 环检测），依赖全部完成后才会被派发，串行链路自动编排
- **管线分档**：`full`（执行+验证）/ `work`（只做不验）/ `direct`（不进池，主窗口直接处理），创建时按规则自动分类、可手动覆盖
- **硬性验收**：`acceptance` 字段写验收脚本命令，Worker 必须实际运行、Verifier 必须独立复跑
- **文件级排他**：`touches` 声明本任务要改的文件/glob（如 `["src/**", "README.md"]`）；进行中的任务持有文件锁，派发器发现候选与活动任务 touches 重叠就跳过本轮（卡片显示 `🔒 等文件释放`，详情页列出在等谁），锁在提交验收/完成后自动释放——避免并行 Worker 改同一批文件互踩。手动「派发」遇到冲突会列出冲突任务，确认后才以 `force` 越权派发
- **子任务**：父子层级 + 上下文继承 + 父任务自动流转 + 级联归档

### 一次性派发（v74 去池化）

- 每个任务 spawn 一个**一次性子代理**（Worker/Verifier），上下文全量注入 prompt，做完即销毁——无常驻池、无池化状态残留
- **Worker/Verifier 均可配置异构模型**（⚙️ 弹出层下拉选择，空 = 继承父级），避免同源盲点；模型故障自动熔断回退父级模型
- 孤儿回收：子代理 run 结束/丢失超 2 分钟 → 任务自动回待办重派
- 看门狗：运行超时且事件流停滞 → 标记"疑似卡死"（不自动杀，裁决权交主窗口/用户）
- 歧义上报：Worker 遇到歧义不猜测，上报等主窗口裁决（任何模式下都通知）；裁决后新 Worker 携带裁决答案接手
- 手动派发：详情页「派发 / 派发验收」按钮可随时手动触发单任务派发（auto 模式补派、manual 模式主通道）
- 会话隔离：看板按会话分桶，多会话互不干扰

### 工作模式（三档）

看板上一个选择器切换三档工作模式（RPC 单入口 `set-work-mode`，`mode` = `list` / `auto` / `team`）：

| 档位 | 内部映射 | 行为 | 适合场景 |
|---|---|---|---|
| 📋 清单模式 | `boardMode=manual` + `teamMode=false` | 看板当 TODO 列表：任务建了就是 `pending` 躺着，主窗口自己 claim 办理，或逐张在详情页点「派发」才起 Worker | 需求还在拆、想自己盯着逐条推进；或只想借看板记账 |
| ⚡ 自动派发 | `boardMode=auto` + `teamMode=false` | 即建即派：`pending` 任务在心跳周期内自动派给一级 Worker，主窗口也可以自己 claim 干活 | 任务描述已经写清楚、依赖也理顺，交给 Worker 跑 |
| 🤖 Team 托管 | `boardMode=auto` + `teamMode=true` | 主窗口当调度员：`task_create` 缺省建草稿（补完 dependsOn/上下文再 publish 统一发布），Worker 歧义上报主窗口裁决 | 多任务编排、长链路、需要人工把关键决策点 |

三档通用（**不是某一档专属**）：

- **歧义裁决**：Worker 遇歧义不猜测，一律上报；裁决后新 Worker 携带答案接手（Team 托管档附带 system prompt 派发引导 + 默认草稿护栏）
- **Verifier 验收**：`acceptance` 硬性验收脚本命令，Worker 必须实际运行、Verifier 必须独立复跑；跨档一致
- **touches 排他**：`touches` 文件级排他锁在活动任务间生效，冲突任务跳过本轮派发，提交验收/完成后释放；跨档一致
- 孤儿回收、看门狗、级联归档、会话隔离同样三档一致

Team 托管档独有（调度员体验）：
- 主窗口 system prompt 注入派发引导（提示词层面建议实质性改动走看板，不硬拦截）；引导含**上下文书写提示**——子代理是全新会话、无会话记忆，description 写不够会自行调研跑偏
- **默认草稿护栏**：`task_create` / `create-task` 缺省建为草稿（草稿不派发），先把所有任务的 dependsOn、contextNotes/contextFiles 补齐，再逐个 `task_update publish=true` 统一发布；确实要立即派发的单个任务才显式传 `draft:false`
- **歧义通知 25s 去抖**：通知延迟 25s 投递，投递前重读看板——歧义已被裁决、或任务已 resolved/archived 就静默跳过（消除主窗口 turn 排队导致的过期回声）；同一任务连续多次上报只投最新一条
- 任务完成/阻塞时主窗口收到**批量聚合回执**（45s 窗口或满 5 条聚合，等主窗口空闲再发，不打断对话）

> 兼容：旧的 `set-board-mode` / `set-team-mode` 两个 RPC 原样保留（旧客户端与脚本不受影响），
> 内部仍以 `boardMode` + `teamMode` 两个字段落盘，老看板文件无损；`get-tasks` 额外返回派生字段 `workMode` 供 UI 单点读取。

## 13 个 Agent 工具

| 类别 | 工具 |
|---|---|
| 任务管理 | `task_create` / `task_list` / `task_context` / `task_update` / `task_claim` / `task_resolve` / `task_verify` / `task_archive` |
| 池治理 | `task_terminate` / `task_intervene` / `task_arbitrate` |
| 子代理上报 | `board_report` / `board_verdict` |

> 管理工具仅主窗口可用（子代理调用会被拒绝）；`board_report`/`board_verdict` 是子代理的专用上报通道。

## 仓库结构

```
└── packages/dsh-agent-board/     # 插件全部源码（直接维护，无构建步骤）
│   ├── index.mjs                 #   host 端：IO 编排（工具/RPC/一次性派发引擎接线）
│   ├── lib/core.mjs              #   纯逻辑核心：状态机/依赖/分类/prompt/解析（无 IO，可单测）
│   ├── lib/client.js             #   client 端（ModuleLoader 包装，图标统一走 ICONS + ic()）
│   ├── test/core.test.mjs        #   单元测试（node --test，54 例）
│   ├── package.json              #   dsh.bundle.patch + dsh.client 元数据
│   └── cordis.patch.yml          #   bundle 挂载行
└── docs/
    ├── PRD.md                    # 产品需求文档
    ├── PACKAGING.md              # 打包/安装踩坑记录（link 依赖、单例隔离等）
    ├── icon-style-guide.md       # 图标风格指南（Lucide 线性 SVG + emoji 分界）
    └── REGRESSION-v59.md         # 端到端回归测试记录
```

> v68 起拆除了"动态源码 → 静态包"的转换层（build-pkg.cjs）：插件已稳定，
> 双形态维护的复杂度大于收益，包内文件即唯一源码，改完重启 dsh 即生效。
>
> v74 起去池化（一次性派发）+ 纯逻辑抽到 `lib/core.mjs`，跑
> `node --test packages/dsh-agent-board/test/` 即可验证状态机/依赖/派发决策，
> 不用重启 dsh 人肉回归。

## 文档

- [docs/PRD.md](docs/PRD.md) — 完整产品需求文档
- [docs/PACKAGING.md](docs/PACKAGING.md) — 正式安装（Bundle 打包）注意事项
- [docs/icon-style-guide.md](docs/icon-style-guide.md) — 图标规范
- [docs/REGRESSION-v59.md](docs/REGRESSION-v59.md) — 回归测试说明

## 发布新版本（维护者）

tag 驱动，GitHub Actions 自动发布到 npm（`.github/workflows/publish.yml`）。两种打 tag 方式都支持：

**方式 1：命令行**

```sh
cd packages/dsh-agent-board
npm version patch          # 或 minor / major——改 package.json
git add -A && git commit -m 'release: vX.Y.Z' && git tag vX.Y.Z
git push --follow-tags     # tag 推送触发流水线
```

**方式 2：GitHub 网页（Releases 页）**

1. 先把 `packages/dsh-agent-board/package.json` 的 `version` 改成目标版本并合入 main（网页直接编辑即可）
2. 仓库页 → **Releases** → **Draft a new release** → **Choose a tag** → 输入 `vX.Y.Z` 选 **Create new tag**（target 选 main）
3. 点 **Publish release** —— 触发发布流水线

- 流水线会拒绝与 tag 不一致的 `package.json` version（如 tag `v1.0.1` 但包里是 `1.0.0`），防止版本错位
- **README 单一来源**：本文件（根 README）即唯一来源；发版前在 `packages/dsh-agent-board` 跑一次 `npm run sync-readme` 同步进包（npm 页面展示的是包内 README）
- 需在仓库 **Settings → Secrets and variables → Actions** 配置 `NPM_TOKEN`
  （npm granular access token：bypass 2FA + direct publish）
- 日常 push / PR 有 `test.yml` 跑语法检查 + 54 例单测
- 本地手动发布仍然可用：`npm publish --registry=https://registry.npmjs.org`（本机默认源是镜像时必须显式指定）

## License

MIT
