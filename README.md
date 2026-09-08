# Task Board Plugin for DeepSeek Harness

任务看板插件 — Agent 自主任务驱动开发：看板管理 + 常驻 Worker/Verifier 执行池 + 依赖调度 + Team 模式。

## 安装

### 前置条件

- DeepSeek Harness（dsh）已安装并能正常启动：`dsh --profile web`
- Node.js ≥ 22（与 dsh 运行时一致）

### 安装步骤

```sh
# 1. 克隆本仓库
git clone https://github.com/PPawnsir/task-board-plugin.git
cd task-board-plugin

# 2. 构建静态包（从双端源码生成 packages/dsh-agent-board）
node scripts/build-pkg.cjs

# 3. 安装到 dsh web profile
dsh plugin --profile web add <本仓库绝对路径>/packages/dsh-agent-board

# 4. 重启 dsh 生效
dsh --profile web
```

### 验证安装

1. 启动日志无 `plugin tree failed to load`
2. 打开任意会话，标题栏出现 **📋 看板** 按钮
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
node scripts/build-pkg.cjs   # 重新生成包（link: 安装即时生效）
# 重启 dsh
```

### 卸载

```sh
dsh plugin --profile web remove dsh-agent-board
# 重启 dsh
```

> 看板数据存在 `~/.dsh/tasks-<sessionId>.json`，卸载不删数据。

## 功能总览

### 看板 UI

- 会话标题栏 📋 按钮 → 顶部抽屉面板（看板 / 团队 / 仪表盘三视图）
- 六列状态流：草稿 → 待办 → 进行中 → 验证中 → 已完成 → 阻塞
- 拖拽流转、多选批量操作（带一步撤销）、文本/优先级/标签筛选
- 归档区：时间倒序 + 排序选择器 + 纵向滚动
- Esc 逐级关闭（详情 → 看板 → 面板）

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

### 执行池

- 自动伸缩的常驻 Worker/Verifier 池（最小/最大并发可配，⚙️ 弹出层）
- Verifier 异构审查：可用不同模型（默认 `qwen/deepseek-v4-pro`）避免同源盲点
- 看门狗：运行超 5 分钟且事件流停滞超 1 分钟 → 标记"疑似卡死"（不自动杀，裁决权交主窗口/用户）
- 歧义上报：Worker 遇到歧义不猜测，上报等主窗口裁决；裁决直接回流原 Worker（保有上下文）
- 会话隔离：池按会话分桶，多会话互不干扰

### Team 模式

开启后（👥 Team 开关）：
- 主窗口的直接执行工具（write/edit/pwsh）被硬拦截，所有改动必须走看板
- 池中子 Agent 不受影响，读类和 task_* 工具不受阻
- Worker 歧义自动上报主窗口聊天流

## 13 个 Agent 工具

| 类别 | 工具 |
|---|---|
| 任务管理 | `task_create` / `task_list` / `task_context` / `task_update` / `task_claim` / `task_resolve` / `task_verify` / `task_archive` |
| 池治理 | `task_terminate` / `task_intervene` / `task_arbitrate` |
| 池中 Agent 上报 | `board_report` / `board_verdict` |

## 仓库结构

```
├── host-v30.js / client-v30.js   # 双端源码（单一事实来源）
├── scripts/build-pkg.cjs         # 构建脚本：源码 → 静态 Bundle（带计数断言）
├── packages/dsh-agent-board/     # 生成的可安装包（勿手改，由构建脚本生成）
│   ├── index.mjs                 #   host 端（13 工具 + RPC 路由）
│   └── lib/client.js             #   client 端（ModuleLoader 包装）
└── docs/
    ├── PRD.md                    # 产品需求文档
    ├── PACKAGING.md              # 打包/安装踩坑记录（link 依赖、单例隔离等）
    └── REGRESSION-v59.md         # 端到端回归测试记录
```

## 文档

- [docs/PRD.md](docs/PRD.md) — 完整产品需求文档
- [docs/PACKAGING.md](docs/PACKAGING.md) — 正式安装（Bundle 打包）注意事项
- [docs/REGRESSION-v59.md](docs/REGRESSION-v59.md) — 回归测试说明

## License

MIT
