# Task Board Plugin for DeepSeek Harness

智能看板插件 — Agent 自主任务驱动开发：看板管理 + 一次性 Worker/Verifier 派发 + 依赖调度 + Team 模式。

## 安装

### 前置条件

- DeepSeek Harness（dsh）已安装并能正常启动：`dsh --profile web`
- Node.js ≥ 22（与 dsh 运行时一致）

### 安装步骤

```sh
# 1. 克隆本仓库
git clone https://github.com/PPawnsir/task-board-plugin.git

# 2. 安装到 dsh web profile（无需构建，包内文件即源码）
dsh plugin --profile web add <本仓库绝对路径>/packages/dsh-agent-board

# 3. 重启 dsh 生效
dsh --profile web
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
git pull
# 重启 dsh（link: 安装指向本仓库，无需重装）
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
- **子任务**：父子层级 + 上下文继承 + 父任务自动流转 + 级联归档

### 一次性派发（v74 去池化）

- 每个任务 spawn 一个**一次性子代理**（Worker/Verifier），上下文全量注入 prompt，做完即销毁——无常驻池、无池化状态残留
- **Worker/Verifier 均可配置异构模型**（⚙️ 弹出层下拉选择，空 = 继承父级），避免同源盲点；模型故障自动熔断回退父级模型
- 孤儿回收：子代理 run 结束/丢失超 2 分钟 → 任务自动回待办重派
- 看门狗：运行超时且事件流停滞 → 标记"疑似卡死"（不自动杀，裁决权交主窗口/用户）
- 歧义上报：Worker 遇到歧义不猜测，上报等主窗口裁决（任何模式下都通知）；裁决后新 Worker 携带裁决答案接手
- 手动派发：详情页「派发 / 派发验收」按钮可随时手动触发单任务派发（auto 模式补派、manual 模式主通道）
- 会话隔离：看板按会话分桶，多会话互不干扰

### 手动 / 自动派发模式

| | 🤖 自动 | 👤 手动 |
|---|---|---|
| Worker 派发 | poolCycle 自动调度（并发上限可配） | 主窗口自行 claim 处理，或详情页手动「派发」 |
| Verifier 派发 | 自动 | **自动**（主窗口手动做完的 full 档任务也会自动验收） |
| 孤儿回收 | 开启 | 开启 |

Team 模式开启时强制自动派发（防止"引导派发 + 手动模式"死锁组合）。

### Team 模式

开启后（Team 开关）：
- 主窗口 system prompt 注入派发引导（提示词层面建议实质性改动走看板，不硬拦截）
- 引导含**上下文书写提示**：子代理是全新会话、无会话记忆，description 写不够会自行调研跑偏
- Worker 歧义自动上报主窗口聊天流，等待裁决
- 任务完成/阻塞时主窗口收到**批量聚合回执**（45s 窗口或满 5 条聚合，等主窗口空闲再发，不打断对话）

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
│   ├── test/core.test.mjs        #   单元测试（node --test，30 例）
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

## License

MIT
