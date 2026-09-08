# Task Board Plugin for DeepSeek Harness

任务看板插件 — Agent 自主任务驱动开发，含上下文传递与子任务层级。

## 架构

```
Host (Node.js)                         Client (Browser)
┌────────────────────────┐            ┌──────────────────────────┐
│ 6 个 Tools:             │            │ 组件 A: 侧边栏按钮         │
│  task_list              │  host.call │   sidebar.footer.action   │
│  task_context  ← NEW    │◄──────────►│   - 待办计数徽标           │
│  task_claim             │    RPC     │                          │
│  task_resolve (自动流转) │            │ 组件 B: 浮层看板          │
│  task_verify            │            │   shell.overlay           │
│  task_archive (级联)    │            │   - 平铺/树形视图切换      │
│                         │            │   - 子任务进度条           │
│ Context Resolver        │            │   - 父子层级缩进           │
│  - 文件内容读取          │            │                          │
│  - 父/子上下文继承合并    │            └──────────────────────────┘
│  - 子任务自动流转         │
└──────────┬──────────────┘
           │
     .dsh/tasks.json
```

## 核心特性

### 上下文传递机制

子 Agent 领取任务后自动获取完整上下文，无需反复询问：

```
主 Agent: task_claim(taskId) → 返回 context
主 Agent: task_context(taskId, expandFiles: true) → 文件内容 + 继承上下文
主 Agent: subagent("<任务描述> + <文件内容> + <操作指引>") → 子 Agent 直接工作
```

三层上下文：任务自身字段 → context 对象 → 动态展开（文件内容 + 关联任务状态）

### 子任务模式

```
Epic: 实现用户认证系统  ← 父任务
├── 设计数据库表结构     ← 子任务 (可并行领取)
├── 实现注册 API        ← 子任务
├── 实现登录 API        ← 子任务
└── 编写集成测试         ← 子任务
```

- 执行策略：`sequential`（串行）/ `parallel`（并行）/ `any`（任意）
- 上下文继承：子任务自动合并父任务的文件、文档、指引
- 自动流转：所有子任务 resolved → 父任务自动 verifying
- 级联归档：父任务归档 → 所有子任务自动归档
- **会话隔离**：每个会话独立任务文件 `.dsh/tasks-<sessionId>.json`，子 Agent 自动继承父会话文件

## 任务生命周期

```
pending → in-progress → verifying → resolved → archived
              ↓                        ↑
           blocked ←───────────────── reject
```

## 6 个 Tools

| # | Tool | 功能 |
|---|------|------|
| 1 | `task_list` | 列出任务，支持父子关系筛选 |
| 2 | `task_context` | 获取完整上下文（文件内容 + 继承合并） |
| 3 | `task_claim` | 领取任务，返回完整上下文 |
| 4 | `task_resolve` | 提交验证，触发父任务自动流转 |
| 5 | `task_verify` | 通过/驳回验收 |
| 6 | `task_archive` | 归档（父任务级联归档子任务） |

## 快速开始

1. 创建 `.dsh/tasks-<sessionId>.json`（或通过 Agent 对话自动创建）：

```json
{
  "version": 3,
  "ownerSession": "session-abc123",
  "tasks": [
    {
      "id": "epic-001",
      "title": "实现用户认证系统",
      "status": "pending",
      "priority": "high",
      "parentId": null,
      "subtaskStrategy": "parallel",
      "context": {
        "files": ["docs/auth-spec.md"],
        "instructions": "需支持邮箱+密码和 OAuth 两种方式",
        "prerequisites": "需先了解现有用户模型"
      }
    },
    {
      "id": "sub-001",
      "title": "设计数据库表结构",
      "status": "pending",
      "parentId": "epic-001",
      "context": { "files": ["src/models/user.ts"] }
    }
  ]
}
```

2. 加载插件 → Agent 通过 6 个工具管理完整任务生命周期

## 文件

- `docs/PRD.md` — 完整产品需求文档 (v1.2)
- `src/host.js` — 6 个 Tool + 上下文解析器 + 自动流转
- `src/client.js` — 侧边栏按钮 + 浮层看板 + 树形视图