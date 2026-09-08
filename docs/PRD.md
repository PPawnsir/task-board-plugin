# 任务看板插件 (Task Board Plugin) — 产品需求文档

> 版本: v5.16  
> 状态: ✅ 归档区体验优化上线（pkg-5/v58 运行中）  
> 作者: DSH Agent
>
> **v5.16 修订**（pkg-5/v58 归档区体验）：
> - 归档任务默认按**归档时间降序**（最新在前），「已归档」展开行右侧新增排序选择器（最新在前/最早在前/按标题）
> - 归档卡片从横向滚动条（200px 定宽 flex）改为**纵向滚动列表**（maxHeight 32vh，向下滚动浏览）
>
> **v5.15 修订**（pkg-4/v57 热修：歧义通知降噪）：
> - 歧义上报的聊天通知（`root.followup`）仅在 **Team 模式**推送；自动模式靠看板面板 3s 轮询自动弹开直达详情页
> - 原因：followup 是排队语义（主窗口空闲才处理），自动模式下该消息必然延迟到达成为事后噪音；面板自动弹开才是真正的实时通道（≤3s）
> - 实现：新增 `maybeNotify(sid, task)` 包装（读 teamMode 再决定），替换 `onWorkerDone` 和 `board_report` 两处直调
>
> **v5.14 修订**（批 8 E2E 结果）：
> - **环检测**：`task_update(b8-x, dependsOn=[b8-y])` 被拒 `circular dependency via: b8-y` ✅
> - **依赖串行**：b8-a（full）10:09:19 验收通过 → b8-b（work）10:09:20 同秒被派发 ✅（A 验证通过前 B 未占 worker 名额）
> - **work 档免验证**：b8-b 从 in-progress 直接 resolved，未进 verifying、未分配 verifier ✅
> - **direct 档不进池**：b8-c/b8-y 依赖满足后仍 pending，由主窗口 task_claim + task_resolve 直接完成 ✅
> - **意外收获**：worker-7 对无描述空任务主动 board_report(kind=escalate) 上报歧义，主窗口裁决后闭环——#8 escalation 链路在真实场景再验一次
>
> **v5.12 修订**（批 7：verifier 异构化，pkg-2，E2E 通过）：
> 1. **#17 verifier 异构化**：`spawnAgent` 支持 `agentOptions.model` 覆盖（`SubagentStartRequest.agentOptions` 在 `resolveChildAgentOptions` 中展开于父级 provider/model 之后，确认可行）；spawn 失败回退父级模型。默认 `qwen/deepseek-v4-pro`（**注意**：`zhipu/glm-5.2` 在 gsmoma 网关返回 402 subscription_required，勿用；旧值自动迁移），⚙️ 弹层可改（空=同父级），Team 视图卡片显示 🧬 模型徽章。**E2E（b7-hetero）**：verifier 会话日志确认 `"model":"qwen/deepseek-v4-pro"`，独立复跑通过并 approve
> 2. **坑**：DSH 进程重启会清空动态插件定义（本次重建为 tskbd-1/pkg-1）；会话 zstd 日志为多帧拼接（Node `zlib.zstdDecompressSync` 需按 magic `28 B5 2F FD` 分帧）
>
> **v5.11 修订**（批 6：体验层，pkg-23，随重建版上线）：
> 1. **#11 头部减负**：4 个池配置输入收进 ⚙️ 弹出层（点击外部自动收起），头部只留 视图切换/池状态/多选/Team/模式/刷新/关闭
> 2. **#15 仪表盘趋势**：近 7 天每日完成量迷你柱状图（纯 div，悬停显示数量）
> 3. **#16 快捷键/撤销**：Esc 逐级关闭（详情→多选→面板，输入框聚焦不劫持）；批量操作条带一步撤销（快照 priority/status，`batch-undo` RPC 回滚）
>
> **v5.10 修订**（批 5：持久化与批量，pkg-22，E2E 通过）：
> 1. **#7 池状态持久化**：`poolRoster`（nextW/nextV 编号计数 + 成员统计 done 数）随 poolCycle 落盘；插件更新/重启后编号与统计连续（E2E：重建后 worker 编号从 2 续起）。已知边界：活 Agent 句柄不可跨重启复活，靠孤儿回收重派，重连冷会话为后续方向
> 2. **#14 批量操作**：看板头部「☑ 多选」开关 → 卡片复选框 → 底部操作条支持批量归档 / 批量设优先级 / 清除选择；Host 新增 `batch-op` RPC（archive + set-priority，逐任务 mutateLocked 串行）
>
> **v5.9 修订**（批 4：调度与验收，pkg-21，E2E 通过）：
> 1. **#5 优先级调度**：poolCycle 分配 pending 任务时按优先级排序（critical→low，同级按创建时间），不再纯 FIFO
> 2. **#3 硬性验收脚本**：`task_create` 新增 `acceptance` 参数（shell 命令）；worker 契约要求完成后实际运行并贴真实输出；verifier 契约要求独立复跑、失败必须 REJECTED；详情页展示验收命令。**E2E（b4-crit）**：worker 贴真实 TAP 输出（540ms），verifier 独立复跑贴自己的输出（715ms）互证；**注意**：验收命令应写内核命令（如 `node --test ...`），不要套 `pwsh -Command` 外壳（worker 沙箱 PATH 无 pwsh）
> 3. **#6 teamMode 硬拦截**：基于 `tools/pre-execute` waterfall（`ctx.on` + `{kind:'deny'}` 决策，dsh-tool-jobs 同款模式）。teamMode 开启时，**root agent**（主窗口）的 write/edit/pwsh 直接执行被 deny 并指引 task_create；池中子 Agent 不受影响（非 root 直接放行）；teamMode 状态由 rt() 缓存同步。**E2E（b4-teamoff）**：root 的 pwsh 被 deny（原文验证），worker 的 pwsh 畅通并完成自解锁。已知限制：插件重启后缓存冷启动期（≤15s 心跳预热）不拦截
>
> **v5.8 修订**（超时哲学重构：计时器从刽子手变为报警器）：
> 1. **不再自动杀 Agent**：pump 移除 300s 死刑，改为看门狗（30s 间隔检查 `session.events.length` 增量）；运行 >300s 且事件流停滞 >60s → 标记 `suspect` + `task.stuckSince`，**不 dispose、不重排队**
> 2. **Team 模式 → 主窗口裁决**：suspect 时通知主窗口（附运行时长/停滞时长证据），主 Agent 可查看子会话后用 `task_terminate` 终止或 `task_intervene` 指导
> 3. **自动模式 → 看板终止钮**：卡片亮 ⏱「疑似卡死」标记并列内置顶；详情页提供 [⏹ 终止任务]（dispose Agent，in-progress 回 pending / verifying 保持待审）与 [继续等待]（清除标记并重置计时）按钮
> 4. suspect Agent 不占扩缩容名额（池自动补位）；Agent 若最终正常完成则自动清除卡死标记
>
> **v5.7 修订**（改进清单第三批，纯客户端，pkg-19）：
> 1. **#12 优先级视觉**：卡片右上角彩色优先级 badge；critical 任务卡片红色呼吸辉光（tskb-crit keyframes）；列内排序升级（待裁决 > 优先级 critical→low > 创建时间）
> 2. **#13 筛选搜索**：看板视图顶部筛选条——文本搜索（标题/描述/ID 模糊匹配）+ 优先级多选 chips + 标签下拉 + 一键清除；作用于活跃列与归档区
>
> **v5.6 修订**（改进清单第二批，pkg-18 运行中，E2E 通过）：
> 1. **#9 裁决对话线程**：`task.messages[]` 持久化完整问答流（escalation 疑问全文 / arbitration 裁决全文 / intervention 介入全文，带时间与身份），不再"裁决后即删疑问"。详情页呈现为对话线程（Worker 红泡 / 主窗口品牌泡 / 介入黄泡）。**E2E（batch2-1）**：escalation + arbitration 两条全文落库，线程完整
> 2. **#10 团队视图**：新增「👥 团队」Tab——Worker/Verifier 成员卡片墙（编号、忙闲、当前任务可点击、已完成数、队列深度），`poolStatus` 增加 queueLen
> 3. **#2 结构化回报工具**（双模渐进）：新增 `board_report`（worker：kind=complete 带 summary/changes/selfTest，kind=escalate 带 question）与 `board_verdict`（verifier：verdict/summary/checks）工具，直接结构化写库；文本分段契约保留为降级路径。**E2E 实证**：spawn 的子 Agent 可调用动态注册工具——worker 上报走"工具通道"（escalate + complete 均命中），verifier 结论走 board_verdict（by 字段为原始 agent id 而非 verifier-N 文本签名）
> 4. **热修**：verifier 120s 超时预算不足以审查长文档（读文件+复跑测试+写结论），v47 E2E 中 #9→#11 连续超时被杀；对齐 worker 300s 预算后 v48 一次通过
>
> **v5.5 修订**（改进清单第一批，pkg-16 运行中，E2E 通过）：
> 1. **#1 阶段产出结构化**：worker 按 `## 开发描述 / ## 改动清单 / ## 自测情况` 分段输出，Host 容错解析存入 `task.deliverable`；verifier 按 `首行 APPROVED:/REJECTED: + ## 测试概要 / ## 核对项` 输出，存入 `task.verification`。详情页新增「📦 交付报告」「🔍 验收报告」区块；verifying 卡片预览改用 deliverable.summary。**E2E（struct-1）**：worker 产出含真实 TAP 输出的自测报告；verifier 独立复跑 + 边界探测（Infinity/相等区间/字符串输入），核对项 6 条带行号引证，还抓出声明行数与实际的小偏差
> 2. **#8 Escalation 一等公民**：看板按钮新增「⚠️N」脉冲 badge（注入 tskb-pulse keyframes，与待办数 badge 独立）；新 escalation 到达时面板自动弹开直达该任务详情；待裁决卡片列内置顶
> 3. **#4 Host 侧调度心跳**（从第三批提前，E2E 中被实证阻塞）：`timer.interval` 15s 对所有已知会话跑 poolCycle，面板关闭/后台节流时池照常运转；空闲快进路径（无活跃任务且池为空则不写盘）。另修复：数据文件 boardMode 残留 manual 导致池静默不派发
>
> **v5.4 修订**（Team 模式 E2E 中发现的 3 个真实缺陷，全部修复并复验通过）：
> 1. **init 竞态 → seed 误判**（严重）：spawn 后 init turn 未完成时 pump 就派发任务，`whenIdle()` 提前 resolve 在 init turn 上，无边界 readOutput 回扫到 **主会话 seed 的旧消息**，导致 verifier 凭陈旧内容误判驳回（曾连续 3 次）。修复：spawn 时 `running={init:true}` 哨兵阻塞 pump，init 完成后才放行
> 2. **readOutput 缺 turn 守卫**：子 Agent 会话携带 248KB 主会话 seed，扫描需 `turn >= minTurn`（pump 在 followup 前捕获 maxTurn+1），杜绝 seed/旧 turn 泄漏
> 3. **verdict 误判**：`/approved/ && !/rejected/` 全文匹配把"提及历史 REJECTED 的正面审查"误判为驳回。修复：行首锚定 `^[>#\-\s]*(APPROVED|REJECTED)` 解析；无法判定走 verifyRetries 重试而非驳回
> 4. **verifier 历史感知**（Worker 在 E2E 中主动上报指出）：verify prompt 携带 上报/裁决/驳回/干预 过程记录，verifier 以"裁决后方向"为验收标准——否则会把"按裁决产出"误判为"绕过任务"
>
> **v5.0 修订**：新增 **Team 模式**（团队协作工作模式）。
> 1. **teamMode 开关**：面板头部 👥 Team 切换。开启后主 Agent 不直接执行任务（task_list 返回 teamHint 引导），所有工作通过 `task_create` 提交看板，由常驻 Worker/Verifier 池自动派发处理
> 2. **歧义上报（Escalation）**：Worker 提示词加入 `[ESCALATE]` 契约——遇到需求歧义/信息不足/需用户决策时，输出 `[ESCALATE] 疑问描述` 而非猜测。Host 检测到后：任务保持 in-progress 并标记 `escalation`（卡片红框 ⚠️ 待裁决），同时 **followup 主会话根 Agent**（用户主窗口出现上报消息）
> 3. **裁决回流**：用户/主 Agent 裁决后（`task_arbitrate` 工具、`resolve-escalation` RPC、看板详情页输入框三通道），答案入队原 Worker（保有上下文）；原 Worker 已死则任务回 pending 带裁决重派
> 4. **高优介入**：`task_intervene` 工具 / `intervene-agent` RPC / 详情页输入框——消息 **unshift 到目标 Agent 队首**，当前 turn 结束后优先处理
> 5. **状态一致性**：上报/裁决/介入全部经 `mutateLocked` 串行写并记录 history，看板轮询实时反映
>
> **v5.0 E2E 验证记录**（3 个测试任务，全部 resolved 并归档）：
> - team-esc-1（含糊需求）：worker 完成登录页（附假设声明）→ verifier 带行号引证通过（L144-145 `EMAIL_RE.test`）
> - team-esc-2（无服务器部署）：worker 31s 触发 [ESCALATE]（5 项缺失信息+3 方案）→ 主窗口裁决（方案A变体：写演练文档）→ worker 产出 267 行 deploy-simulation.md → 期间插件更新触发孤儿恢复自动重派 → verifier 引用裁决记录通过
> - team-esc-3（文档+高优介入）：介入指令插入 worker 队首 → 最终产物含介入要求的 §0 快速开始章节（verifier 核实第 11-30 行）
>
> **v4.5 修订**（池可靠性加固，全部经 E2E 实测验证）：
> 1. **每会话文件锁**：`withLock(sid)` promise 链串行化所有 读-改-写（poolCycle 分配、worker/verifier 回调、tool/RPC 处理器共 19 处），根治并发写覆盖导致的 claim 丢失
> 2. **Agent 串行任务队列**：每个 worker/verifier 持有 `queue[]` + `pump()` 驱动，驳回重试入队而非直接 followup，消除 taskId 覆盖竞争
> 3. **超时预算**：worker 300s / verifier 120s（实测编码任务 29s-12min）；超时不清除而是回 pending 重试，`retryCount>=3` 才转 blocked 待人工
> 4. **孤儿回收**：in-progress 任务 claimedBy 不在当前池中且超 2 分钟 → 自动回 pending（覆盖插件更新/崩溃场景）
> 5. **空输出守卫**：verifier 输出读取失败（空）不再误判为驳回，任务保持 verifying 重审，`verifyRetries>=3` 转 blocked 待人工
> 6. **驳回预算**：真实驳回 `rejectCount>=3` → blocked 待人工裁决（不再无限重试）
>
> **v4.0 修订**：任务看板改为**生产者-消费者模式**。
> - 启动指定数量的**常驻 Worker Agent**（持久子 Agent 会话），自动从 pending 队列领取任务、执行、提交验证，完成后立即领取下一个，无任务时空转等待
> - 启动指定数量的**常驻 Verifier Agent**，自动从 verifying 队列审查任务，全员通过→resolved，任一驳回→in-progress
> - **自动伸缩**（auto-scaling）：监控 pending/verifying 队列深度，动态增减 worker/verifier 数量（min/max 可配置）
> - 看板面板显示 worker/verifier 池状态（各 agent 的当前任务、空闲/忙碌）
>
> **v3.2 修订**：
> 1. 看板面板动态适配布局——从 DOM 读取 AppFrame `gridTemplateColumns`，面板 `left`/`right` 精确对齐对话列，ResizeObserver + MutationObserver 实时跟随侧边栏开合/拖宽
> 2. seed 不再预置任务，看板默认空白
> 3. **DSH 框架 bug 修复**：`dsh-tool-cordis` 的 `referencedPluginIds` 在 `agent/pre-step` 中对 `message.content` 调用 `.flatMap()`，但 spawn 子 Agent 的 `createUserMessage({ content: string })` 传入的是字符串而非数组，导致 `flatMap is not a function`。修复：添加 `typeof === "string"` 防御分支。**需重启 DSH 生效**  
> 日期: 2026-09-06
>
> **v3.1 修订**：新增**仪表盘视图**（Jira 风格统计面板）。看板顶部增加「看板 | 仪表盘」Tab 切换。仪表盘包含：任务统计卡片（各状态计数）、按优先级分布、按状态分布、流转效率（平均完成时间）、进行中任务 agent 负载、最近活跃记录。
>
> **v3.0 修订**：
> 1. 流转轨迹中的 actor ID 可点击，点击跳转对应 Agent 会话（`sessions.open`）
> 2. 自动派发支持配置 `maxWorkers`（并发处理 agent 数 1-10）和 `maxVerifiers`（验证 agent 数 0-5）；verifier > 0 时任务进 verifying 自动 spawn N 个验证 Agent 审查，全员 APPROVED 才 resolved
>
> **v2.1 修订**：看板改为**拖拽式卡片流转**——每个状态一个列，卡片可直接拖拽到目标列完成状态流转（待办→进行中=领取，进行中→验证中=提交验证，验证中→已完成=通过，验证中→进行中=驳回，已完成→归档）。非法流转静默拒绝。
>
> **v2.0 修订**（基于 v1.x 实测反馈）：
> 1. 看板位置从 composer 上方移至**对话上方**（header 按钮 + 顶部下拉面板）
> 2. 看板改为 **Kanban 列式布局**，点击卡片打开详情视图（描述/创建时间/状态/历史）
> 3. 新增**双派发模式**：自动领取（Agent 自由领取）/ 手动派发（用户指派给指定 Agent）
> 4. 领取中的任务可**跳转至执行子 Agent 的对话**并继续交互
> 5. 会话隔离修复：客户端从 slot props 获取 `sessionId` 直传 Host RPC（原方案 `currentInitiator()` 在 RPC 链路中拿不到正确会话，导致全局看板）

---

## 1. 概述

### 1.1 产品愿景

在 DeepSeek Harness 中构建一个**任务看板 (Task Board)** 插件，使 Agent 能够：

- **观察**当前工作区下的任务列表及其状态
- **自动领取**待办任务，**获取充足上下文**后交由子 Agent 独立解决
- **更新**任务状态，覆盖完整的生命周期：待办 → 进行中 → 验证中 → 已完成 → 已归档
- **分解复杂任务**：支持父子任务层级，父任务可拆分为多个子任务并行/串行执行
- **非侵入式展示**：看板以浮层形式展示，主对话窗口始终保持可用
- **会话级隔离**：每个会话拥有独立的任务文件，不同会话间的任务完全隔离，互不干扰。子 Agent 自动继承父会话的任务文件，同一会话链内的任务共享

### 1.2 核心价值

| 角色 | 价值 |
|------|------|
| **人类用户** | 一次性下发多个任务（含父子层级），Agent 自动领取并派生子 Agent 执行。通过上下文传递机制，子 Agent 无需重复询问即可获得足够信息。主窗口始终可用，浮层看板实时监控。每个会话独立管理任务，互不干扰 |
| **Agent** | 通过标准化的 Tool 接口读取任务、获取上下文、领取执行。子任务自动继承父任务上下文，子 Agent 启动即就绪 |
| **子 Agent** | 通过 `task_context` 工具获取任务关联的文件列表、文档引用、前提说明，确保有足够信息完成任务。子 Agent 自动使用父会话的任务文件，无缝衔接 |
| **会话隔离** | 不同对话会话拥有独立的任务空间，会话 A 的任务不会出现在会话 B 的看板中，避免任务混淆 |

### 1.3 使用场景

1. **批量任务下发**：用户创建 `tasks.json`，列出 5 个 bug，Agent 逐个领取并派生子 Agent 修复
2. **复杂需求拆分**：一个 Epic 需求拆分为 3 个子任务（前端/后端/测试），分别由不同 Agent 并行处理
3. **多 Agent 协作**：多个 Agent 从共享任务池中领取，子任务分发到不同执行者
4. **上下文传递**：子 Agent 领取任务时自动获取关联文件路径、文档引用、前提条件，无需人工交代
5. **人工验收**：Agent 完成后进入验证中，用户通过浮层看板确认或驳回

---

## 2. 功能需求

### 2.1 任务数据模型

任务以 JSON 文件形式存储在**工作区根目录**下的 `.dsh/` 目录中，**按会话隔离**：

- 文件命名：`.dsh/tasks-<sessionId>.json`
- 每个会话（及其子 Agent 链）拥有独立的任务文件
- 子 Agent 自动继承父会话的任务文件，确保同一会话链内的任务共享

```json
{
  "version": 3,
  "ownerSession": "session-abc123",
  "tasks": [
    {
      "id": "task-001",
      "title": "修复登录页面样式错乱",
      "description": "登录按钮在移动端溢出容器，需要调整 CSS flex 布局",
      "status": "pending",
      "priority": "high",
      "tags": ["bug", "frontend", "css"],
      "parentId": null,
      "subtaskStrategy": null,
      "context": {
        "files": ["src/pages/Login.tsx", "src/styles/login.css"],
        "docs": ["docs/login-spec.md"],
        "instructions": "确保移动端 (<768px) 和桌面端都正常。参考 PRD 第 3.2 节。",
        "relatedTasks": [],
        "prerequisites": "需要先了解项目的 CSS 变量命名规范"
      },
      "claimedBy": null,
      "claimedAt": null,
      "createdAt": "2026-09-05T10:00:00Z",
      "resolvedAt": null,
      "verifiedAt": null,
      "verifiedBy": null,
      "archivedAt": null,
      "resolution": null,
      "history": []
    }
  ]
}
```

**字段说明**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 唯一任务标识符，由创建者分配 |
| `title` | string | 任务标题（必填） |
| `description` | string | 任务详细描述 |
| `status` | enum | `pending` / `in-progress` / `verifying` / `resolved` / `blocked` / `cancelled` / `archived` |
| `priority` | enum | `low` / `medium` / `high` / `critical` |
| `tags` | string[] | 自由标签，用于分类和筛选 |
| `parentId` | string \| null | **父任务 ID**，`null` 表示顶级任务 |
| `subtaskStrategy` | enum \| null | **子任务执行策略**：`sequential`（串行）/ `parallel`（并行）/ `any`（任意顺序），仅父任务有效 |
| `assignMode` | enum | **派发模式**：`auto`（Agent 自动领取，默认）/ `manual`（手动派发，仅 assignee 可领取） |
| `assignee` | string \| null | **手动派发目标**：被指派的 Agent Session ID；`null` 表示未指派 |
| `context` | Context \| null | **任务上下文**，子 Agent 领取时获取 |
| `claimedBy` | string \| null | 领取该任务的 Agent Session ID |
| `claimedAt` | ISO8601 \| null | 领取时间 |
| `createdAt` | ISO8601 | 创建时间 |
| `resolvedAt` | ISO8601 \| null | Agent 提交解决的时间 |
| `verifiedAt` | ISO8601 \| null | 用户验证通过的时间 |
| `verifiedBy` | string \| null | 验证者标识 |
| `archivedAt` | ISO8601 \| null | 归档时间 |
| `resolution` | string \| null | 解决说明 |
| `ownerSession` | string | 任务所属会话 ID（自动设置为创建时的根会话） |
| `history` | HistoryEntry[] | 状态变更历史记录 |

> **会话隔离**：`ownerSession` 字段由系统自动设置，等于创建任务时的根会话 ID。子 Agent 的 `currentInitiator()` 返回根会话，因此子 Agent 操作的任务文件与父 Agent 相同。不同根会话之间的任务完全隔离。

**Context 结构**：

```json
{
  "files": ["src/pages/Login.tsx"],
  "docs": ["docs/login-spec.md"],
  "instructions": "具体操作指引",
  "relatedTasks": ["task-002"],
  "prerequisites": "前置条件说明"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `files` | string[] | 关联文件路径（相对于工作区） |
| `docs` | string[] | 关联文档引用（路径或 URL） |
| `instructions` | string | 操作指引，子 Agent 执行前必读 |
| `relatedTasks` | string[] | 关联任务 ID 列表 |
| `prerequisites` | string | 前置条件说明 |

**HistoryEntry 结构**：

```json
{
  "from": "pending",
  "to": "in-progress",
  "timestamp": "2026-09-05T10:30:00Z",
  "actor": "session-abc123",
  "note": "Agent 领取任务"
}
```

### 2.2 上下文传递机制

#### 2.2.1 设计目标

确保子 Agent 在认领任务后能够**获取到足够的上下文**来独立完成任务，无需反复向用户询问基本信息。

#### 2.2.2 三层上下文体系

```
Layer 1: 任务自身字段
  ├── title          — 任务标题
  ├── description    — 任务描述
  ├── tags           — 分类标签
  └── priority       — 优先级

Layer 2: context 对象（任务创建时填写）
  ├── files[]        — 关联文件路径
  ├── docs[]         — 关联文档引用
  ├── instructions   — 操作指引
  ├── relatedTasks[] — 关联任务
  └── prerequisites  — 前置条件

Layer 3: 动态上下文（通过 task_context 工具获取）
  ├── 父任务信息     — 若当前任务是子任务，返回父任务的完整上下文
  ├── 文件内容       — 读取 context.files 中指定文件的实际内容
  ├── 关联任务状态   — context.relatedTasks 的当前状态
  └── 子任务列表     — 若当前任务是父任务，列出所有子任务及其状态
```

#### 2.2.3 上下文传递流程

```
1. 用户创建任务，填写 context 字段
         │
         ▼
2. 主 Agent 调用 task_list → 看到任务及摘要上下文
         │
         ▼
3. 主 Agent 调用 task_claim(taskId) → 返回任务（含完整 context 对象）
         │
         ▼
4. 主 Agent 调用 task_context(taskId, expandFiles: true)
   → 返回完整上下文，包括关联文件的实际内容
         │
         ▼
5. 主 Agent 根据上下文构造子 Agent 的 prompt：
   "请修复 task-001: 修复登录页面样式错乱。
    关联文件: src/pages/Login.tsx (内容: ...), src/styles/login.css (内容: ...)
    操作指引: 确保移动端和桌面端都正常..."
         │
         ▼
6. 子 Agent 收到 prompt 后直接开始工作，无需额外询问
         │
         ▼
7. 子 Agent 完成后，主 Agent 调用 task_resolve 提交验证
```

#### 2.2.4 上下文继承规则

当任务有父子关系时，子任务**自动继承**父任务的上下文：

| 父任务字段 | 子任务继承规则 |
|-----------|---------------|
| `context.files` | 合并（父 + 子），子任务可追加自己的文件 |
| `context.docs` | 合并（父 + 子） |
| `context.instructions` | 子任务有则用自己的，否则用父的 |
| `context.prerequisites` | 合并（父 + 子） |
| `context.relatedTasks` | 合并（父 + 子） |
| `tags` | 合并（父 + 子） |
| `priority` | 子任务有则用自己的，否则继承父的 |

### 2.3 会话隔离机制

#### 2.3.1 设计目标

每个 DSH 会话拥有独立的任务空间，不同会话间的任务**完全隔离**，互不干扰。同时，同一会话链内的 Agent（父 Agent 及其派生的子 Agent）**共享**同一个任务文件。

#### 2.3.2 隔离模型

```
会话 A (session-aaa)                 会话 B (session-bbb)
┌──────────────────────┐            ┌──────────────────────┐
│ .dsh/tasks-aaa.json  │            │ .dsh/tasks-bbb.json  │
│                      │            │                      │
│ task-001: pending    │            │ task-101: pending    │
│ task-002: in-progress│            │ task-102: resolved   │
│                      │            │                      │
│ 子 Agent A1 ─────────┤            │ 子 Agent B1 ─────────┤
│ (继承 tasks-aaa.json)│            │ (继承 tasks-bbb.json)│
└──────────────────────┘            └──────────────────────┘
     ↑ 完全隔离，互不可见 ↑
```

#### 2.3.3 文件命名规则

| 场景 | 任务文件路径 |
|------|-------------|
| 根 Agent（用户直接对话） | `.dsh/tasks-<rootSessionId>.json` |
| 子 Agent（由根 Agent 派生） | 与根 Agent 相同（通过 `currentInitiator()` 获取） |
| 更深层子 Agent | 同上，始终追溯到根 Agent |

#### 2.3.4 会话 ID 解析逻辑（v2.0 修订）

**v1.x 的问题**：`currentInitiator()` 只在 Agent 驱动链（Tool execute）内有效；客户端 UI 的 RPC 调用（`host.call`）不在任何 Agent 链上，导致看板始终解析到错误/全局会话——所有会话看到同一个看板。

**v2.0 方案：双通道解析**

```
通道 1 — Agent Tool 调用（task_claim / task_resolve / ...）：
  Host 用 agents.currentInitiator() 获取执行者，
  再用 agents.list() + isOwnedBy() 沿所有权链向上解析根会话
  → 子 Agent 与父会话共享任务文件，claimedBy 记录真实执行者

通道 2 — 客户端 UI RPC（get-tasks / verify-task / ...）：
  看板组件从 slot 标准 props 获取当前 sessionId（conversation.* 槽位均提供），
  每次 host.call(method, { sessionId, ... }) 直传
  → Host 按该 sessionId 直接解析任务文件，不再猜
```

文件命名：`.dsh/tasks-<sessionId>.json`

这使得：
- 主 Agent 和其所有子 Agent 使用同一个任务文件（通道 1 根解析）
- 看板永远显示**当前正在查看的会话**的任务（通道 2 直传）
- 不同用户对话的任务文件完全独立

#### 2.3.5 看板 UI 的会话隔离

- 看板按钮和面板的 RPC 全部携带当前 `sessionId`
- 切换到另一个会话时，组件随 slot 重挂载，sessionId 变化 → 看板显示该会话的任务
- 会话 A 的 `pending` 计数不会与会话 B 的混合

### 2.4 子任务模式

#### 2.4.1 设计目标

支持将复杂任务拆分为多个子任务，通过父子层级关系管理任务依赖和完成条件。

#### 2.3.2 父子关系模型

```
Epic: 实现用户认证系统 (task-001)           ← 父任务
├── 子任务: 设计数据库表结构 (task-001-1)     ← 子任务
├── 子任务: 实现注册 API (task-001-2)        ← 子任务
├── 子任务: 实现登录 API (task-001-3)        ← 子任务
└── 子任务: 编写集成测试 (task-001-4)        ← 子任务
```

- 父任务通过 `parentId: null` 标识
- 子任务通过 `parentId: "task-001"` 指向父任务
- 子任务**不能有子任务**（只支持两层：父 → 子）
- 子任务也是独立任务，有自己独立的状态生命周期

#### 2.3.3 子任务执行策略

父任务通过 `subtaskStrategy` 字段控制子任务的执行方式：

| 策略 | 含义 | 子任务状态约束 |
|------|------|---------------|
| `sequential` | **串行**：子任务必须按顺序执行 | 只有前一个子任务 `resolved` 后，下一个子任务才能被领取 |
| `parallel` | **并行**：所有子任务可同时执行 | 所有子任务可同时被不同 Agent 领取 |
| `any` | **任意顺序**：无顺序约束 | 子任务可被任意领取，不要求顺序 |

#### 2.3.4 父任务自动流转规则

父任务的状态受子任务状态影响：

| 条件 | 父任务行为 |
|------|-----------|
| 父任务被领取 (`in-progress`) | 子任务可以被领取 |
| 所有子任务 `resolved` | 父任务**自动**变为 `verifying` |
| 任一子任务 `blocked` | 父任务保持 `in-progress`，不阻塞其他子任务 |
| 父任务 `verifying` 被驳回 | 父任务退回 `in-progress`，子任务状态不变 |

#### 2.3.5 子任务领取约束

| 规则 | 说明 |
|------|------|
| 父任务必须先被领取 | 子任务只有在父任务进入 `in-progress` 后才可被领取 |
| 串行策略的顺序检查 | `sequential` 模式下，子任务必须按创建顺序逐个领取 |
| 子任务独立领取 | 子任务可由不同 Agent 领取（并行模式下） |
| 子任务计数独立 | 子任务不计入父 Agent 的 3 个任务上限（因为子任务由子 Agent 执行） |

### 2.5 任务状态完整生命周期

```
                         ┌──────────┐
                         │  pending  │  ← 初始状态
                         └─────┬─────┘
                               │ task_claim()
                               ▼
                         ┌───────────┐
                   ┌─────│in-progress│─────┐
                   │     └───────────┘     │
                   │ task_resolve(         │ task_resolve(
                   │   "blocked")          │   "verifying")
                   ▼                       ▼
             ┌──────────┐           ┌───────────┐
             │  blocked  │           │ verifying  │  ← Agent 提交完成
             └────┬─────┘           └─────┬─────┘
                  │ task_claim()          │ task_verify("approved")
                  ▼                       ▼
             ┌───────────┐          ┌──────────┐
             │in-progress │          │ resolved  │  ← 验证通过
             └───────────┘          └────┬─────┘
                    ↑                    │ task_archive()
                    │                    ▼
                    │               ┌──────────┐
                    │               │ archived  │  ← 终态
                    │               └──────────┘
                    │
                    └── task_verify("rejected") ──┘

父任务特殊规则：
  - 领取父任务后，子任务才可被领取
  - 所有子任务 resolved → 父任务自动变为 verifying
  - 父任务 verifying 驳回 → 退回 in-progress，子任务不变

子任务特殊规则：
  - 子任务继承父任务上下文
  - sequential 模式下需按顺序领取
  - 子任务可独立进入 verifying / resolved / archived
```

**各状态含义**：

| 状态 | 含义 | 谁操作 | 下一步 |
|------|------|--------|--------|
| `pending` | 待办，等待领取 | — | Agent 领取 → `in-progress` |
| `in-progress` | Agent 正在处理 | Agent | 提交 → `verifying`；阻塞 → `blocked` |
| `verifying` | **验证中**，等待人工验收 | 用户 | 通过 → `resolved`；驳回 → `in-progress` |
| `resolved` | **已完成**，验证通过 | — | 归档 → `archived` |
| `archived` | **已归档**，历史记录保留 | 用户 | 终态 |
| `blocked` | 阻塞，无法继续 | Agent | 重新领取 → `in-progress` |
| `cancelled` | 已取消 | 用户 | 终态 |

### 2.6 Host 端 — 模型 Tools（核心）

插件向模型注册以下 6 个 Tool：

#### 2.5.1 `task_list` — 列出任务

**描述**：列出当前工作区的所有任务，支持按状态、优先级、标签、父子关系筛选。默认不返回已归档任务。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `status` | string | 否 | 按状态筛选 |
| `priority` | string | 否 | 按优先级筛选 |
| `tag` | string | 否 | 按标签筛选 |
| `parentId` | string | 否 | 筛选指定父任务的所有子任务。`"null"` 表示只返回顶级任务 |
| `includeArchived` | boolean | 否 | 是否包含已归档任务，默认 `false` |
| `limit` | number | 否 | 返回数量上限，默认 20 |

**返回**：匹配的任务数组，按优先级降序 + 创建时间升序排列。每个子任务附带其父任务的 `title` 和 `status` 摘要。

#### 2.5.2 `task_context` — 获取任务上下文（新增）

**描述**：获取一个任务的完整上下文，包括关联文件内容、父/子任务信息。子 Agent 在领取任务后**必须调用此工具**获取足够信息。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `taskId` | string | 是 | 要获取上下文的任务 ID |
| `expandFiles` | boolean | 否 | 是否读取关联文件的实际内容，默认 `false` |
| `includeParent` | boolean | 否 | 是否包含父任务信息，默认 `true` |
| `includeSubtasks` | boolean | 否 | 是否包含子任务列表，默认 `true` |

**返回**：

```json
{
  "task": { /* 任务完整信息 */ },
  "parent": { /* 父任务信息（若存在） */ },
  "subtasks": [ /* 子任务列表（若存在） */ ],
  "expandedFiles": {
    "src/pages/Login.tsx": "// 文件内容...",
    "src/styles/login.css": "/* 文件内容... */"
  },
  "relatedTaskStatuses": {
    "task-002": { "status": "resolved", "title": "..." }
  },
  "inheritedContext": {
    "files": ["..."],
    "docs": ["..."],
    "instructions": "...",
    "prerequisites": "..."
  }
}
```

#### 2.5.3 `task_claim` — 领取任务

**描述**：Agent 领取一个待办任务，将其状态改为 `in-progress`。领取时自动返回任务的完整上下文。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `taskId` | string | 是 | 要领取的任务 ID |
| `reason` | string | 否 | 领取理由 |

**返回**：领取成功后的任务对象（含完整 context + 继承的父任务上下文）。

**约束**：
- 只能领取 `pending` 或 `blocked` 的任务
- 一个 Agent 同时最多持有 3 个 `in-progress` 或 `verifying` 任务
- 子任务：父任务必须已进入 `in-progress`
- `sequential` 模式：必须按顺序领取
- 子任务不计入父 Agent 的 3 个上限（子任务由子 Agent 执行）

#### 2.5.4 `task_resolve` — 提交任务

**描述**：Agent 完成任务后提交验证（`verifying`）或标记阻塞（`blocked`）。若提交的是父任务且其所有子任务均已 `resolved`，则自动转为 `verifying`。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `taskId` | string | 是 | 要提交的任务 ID |
| `status` | string | 是 | 目标状态：`verifying` / `blocked` |
| `resolution` | string | 条件必填 | 当 `status === "verifying"` 时必填 |

**返回**：更新后的任务对象。若触发了父任务自动流转，附带 `parentUpdated: true`。

**自动流转**：子任务提交 `verifying` 后，系统检查父任务的所有子任务状态——若全部 `resolved`，自动将父任务设为 `verifying`。

#### 2.5.5 `task_verify` — 验证任务

**描述**：用户对 Agent 提交的任务进行验收。通过则进入 `resolved`，驳回则退回 `in-progress`。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `taskId` | string | 是 | 要验证的任务 ID |
| `verdict` | string | 是 | `approved` 或 `rejected` |
| `comment` | string | 否 | 验证意见 |

**返回**：更新后的任务对象。

#### 2.5.6 `task_archive` — 归档任务

**描述**：将已解决的任务归档。归档后不再出现在默认列表中。父任务归档时，其所有子任务自动归档。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `taskId` | string | 是 | 要归档的任务 ID |

**返回**：更新后的任务对象。若有关联子任务，附带 `childrenArchived: N`。

**约束**：
- 只能归档 `resolved` 或 `cancelled` 的任务
- 归档父任务时，所有子任务（无论状态）自动归档
- 归档不可逆

### 2.7 Client 端 — 可视化看板（对话上方 + Kanban 列 + 详情视图）

#### 2.7.1 交互设计原则

**看板位于对话内容区域上方**，通过会话头部按钮唤起，面板从对话顶部向下铺开（Kanban 列式布局），不遮挡侧边栏，主对话内容自然下移、保持可见。

**会话隔离**：客户端组件通过 slot 标准 props 拿到当前会话 `sessionId`，所有 RPC 调用携带该 ID；Host 端按该 ID 解析任务文件，实现真正的会话级隔离。

#### 2.7.2 组件分解

**组件 A：会话头部按钮**（`conversation.session.header.actions`）

- 位置：会话标题栏操作行（与 agent-preset、job-list 并列）
- 内容："📋 看板" + 待办计数徽标
- 点击：切换顶部看板面板显示/隐藏
- standardProps 提供 `sessionId`，作为本会话身份

**组件 B：Kanban 看板面板**（`shell.overlay`，定位为对话列顶部下拉）

- 位置：对话内容区域顶部向下铺开（非右侧浮层）
- 布局：横向 Kanban 列——`待办` / `进行中` / `验证中` / `已完成` / `阻塞`
- 顶栏：标题 + **派发模式切换**（🤖 自动领取 / 👤 手动派发）+ 刷新 + 关闭
- 主题：全部使用 `--dsw-alias-*` 主题 token，自动跟随浅色/深色

```
┌─ 对话头部 ────────────────────────── [📋 看板 3] ─┐
│                                                    │
│  ┌─ 任务看板 ──── [🤖自动|👤手动] ──── [🔄] [✕] ─┐ │
│  │ 待办(2)  │ 进行中(1) │ 验证中(1) │ 已完成 │ 阻塞│ │
│  │ ┌──────┐ │ ┌──────┐ │ ┌──────┐ │       │     │ │
│  │ │任务A │ │ │任务B │ │ │任务C │ │       │     │ │
│  │ │high  │ │ │⚡2min │ │ │📝... │ │       │     │ │
│  │ └──────┘ │ └──────┘ │ └──────┘ │       │     │ │
│  └────────────────────────────────────────────┘ │
│                                                    │
│  [对话消息流...]                                    │
└────────────────────────────────────────────────────┘
```

#### 2.7.3 任务详情视图

点击任意任务卡片 → 面板内切换为详情视图（面包屑可返回列表）：

| 区域 | 内容 |
|------|------|
| 标题 | 任务标题 + 优先级标签 + 当前状态徽章 |
| 信息 | 任务 ID、创建时间、领取人、领取时间、解决时间、验证时间 |
| 描述 | 完整描述（**可编辑**，保存后重置为 `pending` 待领取状态） |
| 操作指引 | context.instructions / prerequisites |
| 历史时间线 | history 数组逐条展示（状态 + 时间 + 操作者 + 备注） |
| 操作区 | 按当前状态显示：领取 / 通过 / 驳回 / 归档 / **手动派发** / **跳转执行会话** |

#### 2.7.4 双派发模式

**派发模式为看板级开关**（顶栏切换），影响 Agent 的领取行为：

| 模式 | 行为 |
|------|------|
| 🤖 **自动领取**（默认） | `pending` 任务可被任何 Agent 通过 `task_claim` 自由领取（先到先得）。用户可在详情中编辑任务描述，保存后任务重置为 `pending` 等待自动领取 |
| 👤 **手动派发** | 任务详情中用户选择目标 Agent（下拉列出当前会话的子 Agent 会话），任务写入 `assignee`。`task_claim` 校验：仅 `assignee` 匹配的 Agent 可领取；其他 Agent 领取被拒绝 |

任务字段：`assignMode: 'auto' | 'manual'`（默认 `auto`），`assignee: string | null`。

**约束**：
- 手动派发任务的 `assignee` 不匹配时，`task_claim` 返回 `{ ok: false, error: 'task assigned to <assignee>' }`
- 用户可在详情中随时改回自动模式（`assignee = null`）

#### 2.7.5 跳转执行会话

任务处于 `in-progress` / `verifying` 且 `claimedBy` 非当前会话时：

- 详情视图显示按钮：**"→ 跳转执行会话"**
- 点击调用客户端 `sessions.open(claimedBy)` 切换到执行该任务的子 Agent 对话
- 用户可在子 Agent 对话中直接查看/继续交互（追问、驳回指示等）

#### 2.7.6 状态变化的视觉反馈

| 事件 | 视觉反馈 |
|------|----------|
| Agent 领取任务 | 卡片进入"进行中"列，显示 `⚡ <actor> 正在处理 · N分钟前` |
| Agent 提交验证 | 卡片进入"验证中"列，边框警示色高亮，resolution 醒目展示 |
| 用户验证通过 | 卡片进入"已完成"列 |
| 用户驳回 | 卡片退回"进行中"列 |
| 用户归档 | 卡片从列中淡出，移入"已归档"折叠区（含完整时间线） |
| 子任务全部完成 | 父任务自动进入"验证中"列 |
| 手动派发成功 | 卡片上显示 `👤 → <assignee>` 标记 |

#### 2.7.7 仪表盘视图（Jira 风格）

看板顶部增加「📋 看板 | 📊 仪表盘」Tab 切换。仪表盘为只读统计视图，帮助用户快速了解任务全局状态。

**统计卡片行**（横向排列）：

| 卡片 | 内容 |
|------|------|
| 总任务数 | 当前会话全部任务（含已归档） |
| 待办 | pending 数量 |
| 进行中 | in-progress 数量 + 各任务领取人 |
| 验证中 | verifying 数量 |
| 已完成 | resolved 数量 |
| 已归档 | archived 数量 |

**分布面板**：
- 按优先级分布（horizontal bar chart：紧急/高/中/低）
- 按状态分布（horizontal bar chart）

**效率指标**：
- 平均完成时间（pending→resolved 的平均耗时）
- 平均验证时间（verifying→resolved 的平均耗时）
- 今日完成数

**Agent 负载**：
- 各 agent 当前持有的进行中/验证中任务数

**最近活跃**：最近 10 条流转记录（时间 + 任务 + 状态变更 + actor，actor 可点击跳转）

---

## 3. 技术架构

### 3.1 整体架构

```
┌──────────────────────────────────────────────────────────────────┐
│                          DSH Runtime                              │
│                                                                  │
│  ┌──────────────────────────┐  ┌───────────────────────────────┐ │
│  │   Host (Node.js)          │  │  Client (Browser)             │ │
│  │                          │  │                               │ │
│  │  ┌────────────────────┐  │  │  ┌─────────────────────────┐  │ │
│  │  │ 6 个 Tools:         │  │  │  │ 组件 A: 侧边栏按钮       │  │ │
│  │  │  task_list          │  │  │  │ sidebar.footer.action   │  │ │
│  │  │  task_context  ←NEW │  │  │  │                         │  │ │
│  │  │  task_claim         │──┼──┼──│ 组件 B: 浮层看板         │  │ │
│  │  │  task_resolve       │  │  │  │ shell.overlay           │  │ │
│  │  │  task_verify        │  │  │  │ - 平铺/树形视图切换      │  │ │
│  │  │  task_archive       │  │  │  │ - 父子层级展示           │  │ │
│  │  └─────────┬───────────┘  │  │  │ - 子任务进度条            │  │ │
│  │            │              │  │  └──────────┬──────────────┘  │ │
│  │  ┌─────────▼───────────┐  │  │             │                 │ │
│  │  │ Context Resolver    │  │  │  host.call() RPC             │ │
│  │  │ - 文件内容读取       │  │  │             │                 │ │
│  │  │ - 父/子任务聚合      │  │  │  ┌──────────▼──────────────┐  │ │
│  │  │ - 上下文继承合并     │  │  │  │ 6 个 RPC Handlers       │  │ │
│  │  └─────────┬───────────┘  │  │  │ + get-context            │  │ │
│  │            │              │  │  └─────────────────────────┘  │ │
│  │  ┌─────────▼───────────┐  │  │                               │ │
│  │  │ Task Store          │  │  │                               │ │
│  │  │ .dsh/tasks-<sid>.json│  │  │                               │ │
│  │  │ (按会话隔离)          │  │  │                               │ │
│  │  └─────────────────────┘  │  │                               │ │
│  └──────────────────────────┘  └───────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### 3.2 上下文传递数据流

```
用户创建任务（含 context）
        │
        ▼
主 Agent: task_list → 看到任务摘要
        │
        ▼
主 Agent: task_claim(taskId) → 返回任务 + context
        │
        ▼
主 Agent: task_context(taskId, expandFiles: true)
        │ → 返回文件内容 + 父任务上下文 + 子任务列表
        ▼
主 Agent: 构造子 Agent prompt =
    "任务: {title}\n描述: {description}\n"
  + "文件: {files + contents}\n"
  + "指引: {instructions}\n"
  + "前提: {prerequisites}"
        │
        ▼
主 Agent: subagent(prompt) → 子 Agent 开始工作
        │
        ▼
子 Agent: 直接开始解决，无需额外询问
        │
        ▼
子 Agent 完成 → 主 Agent: task_resolve(taskId, "verifying")
```

### 3.3 子任务自动流转数据流

```
父任务 in-progress
  ├── 子任务 1: resolved ✅
  ├── 子任务 2: resolved ✅
  ├── 子任务 3: verifying → task_verify("approved") → resolved ✅
  └── 子任务 4: in-progress

子任务 3 变为 resolved 时：
  → task_resolve 内部检查父任务的所有子任务
  → 发现子任务 1,2,3 = resolved，子任务 4 = in-progress
  → 不满足"全部 resolved"条件，不触发自动流转

子任务 4 变为 resolved 时：
  → task_resolve 内部检查：全部 4 个子任务 = resolved
  → 满足条件 → 自动将父任务设为 verifying
  → 返回 { ok: true, parentUpdated: true }
```

### 3.4 上下文继承合并算法

```
function mergeContext(parent, child) {
  return {
    files:       [...new Set([...(parent.files||[]), ...(child.files||[])])],
    docs:        [...new Set([...(parent.docs||[]), ...(child.docs||[])])],
    instructions: child.instructions || parent.instructions || '',
    prerequisites: [parent.prerequisites, child.prerequisites]
                    .filter(Boolean).join('; '),
    relatedTasks: [...new Set([...(parent.relatedTasks||[]), ...(child.relatedTasks||[])])],
  }
}
```

### 3.5 客户端通信 RPC

| 方法 | 方向 | 参数 | 返回 |
|------|------|------|------|
| `get-tasks` | Client→Host | — | 完整任务列表 |
| `get-context` | Client→Host | `{ taskId, expandFiles }` | 任务上下文 |
| `claim-task` | Client→Host | `{ taskId }` | 任务对象 |
| `resolve-task` | Client→Host | `{ taskId, status, resolution }` | 任务对象 |
| `verify-task` | Client→Host | `{ taskId, verdict, comment }` | 任务对象 |
| `archive-task` | Client→Host | `{ taskId }` | 任务对象 |

---

## 4. 用户故事

### US-1: 作为用户，我希望能一次性创建多个任务

**场景**：我在项目根目录创建 `.dsh/tasks.json`，列出 5 个待修复的 bug。Agent 启动后自动扫描并列出所有待办任务。

**验收标准**：
- Agent 调用 `task_list` 可看到全部 5 个任务
- 任务按优先级排序
- 已归档任务不出现在默认列表中

### US-2: 作为 Agent，我希望能领取任务并获取完整上下文

**场景**：Agent 扫描任务列表后，调用 `task_claim` 领取一个任务，同时获取任务的完整上下文（关联文件、操作指引、前置条件）。

**验收标准**：
- `task_claim` 返回的任务对象包含完整 `context` 字段
- 可调用 `task_context(taskId, expandFiles: true)` 获取关联文件的实际内容
- 子任务自动继承父任务上下文

### US-3: 作为子 Agent，我希望能直接获取足够信息开始工作

**场景**：主 Agent 派生子 Agent 处理任务。子 Agent 通过 `task_context` 获取关联文件内容、操作指引后，无需额外询问即可开始工作。

**验收标准**：
- 子 Agent 收到 prompt 后无需向用户提问"这个文件在哪里？"
- `task_context` 返回的文件内容可直接用于代码修改
- 上下文包含足够的前提条件说明

### US-4: 作为用户，我希望能将复杂需求拆分为子任务

**场景**：我创建一个父任务"实现用户认证系统"，并拆分为 4 个子任务。子任务可被不同 Agent 并行领取执行。

**验收标准**：
- 父任务通过 `parentId` 关联子任务
- 子任务在父任务被领取后才可以被领取
- 并行模式下，不同 Agent 可同时领取不同子任务
- 所有子任务完成后，父任务自动变为 `verifying`

### US-5: 作为用户，我希望能看到任务的父子层级

**场景**：在看板中切换到树形视图，直观看到父子任务关系及子任务进度。

**验收标准**：
- 树形视图下，子任务缩进显示在父任务下方
- 父任务卡片显示子任务完成进度（如 "2/4 已完成"）
- 子任务全部完成后，父任务自动移到"验证中"列

### US-6: 作为 Agent，我希望能提交任务等待验收

**场景**：Agent 完成修复后，调用 `task_resolve(taskId, "verifying")` 提交任务。

**验收标准**：
- 任务状态变为 `verifying`
- 只能提交自己领取的任务
- 看板中该任务卡片显示橙色闪烁边框

### US-7: 作为用户，我希望看板不占用主对话窗口

**场景**：点击侧边栏按钮，右侧浮出看板，主对话窗口完全不受影响。

**验收标准**：
- 看板默认关闭，侧边栏有入口按钮 + 待办计数徽标
- 点击按钮后看板从右侧滑入
- 主对话窗口不被遮挡或挤压
- ESC / 点击遮罩关闭看板

---

## 5. 非功能需求

### 5.1 性能

- 任务列表读取：< 50ms
- `task_context` 含文件读取：< 200ms（最多 5 个文件）
- UI 渲染：≤ 100 任务时流畅
- 浮层面板动画：60fps

### 5.2 可靠性

- 并发写入安全：原子文件写入
- 文件损坏恢复：自动备份
- 上下文继承：合并算法保证幂等
- 父子状态一致性：每次子任务状态变更时检查父任务

### 5.3 安全性

- 任务文件只在工作区范围内
- `task_context` 文件读取仅限 `context.files` 中声明的路径
- 文件路径校验：拒绝 `../` 等越权路径

### 5.4 兼容性

- 纯 JavaScript，无 TypeScript/JSX 编译
- 不依赖外部 NPM 包

---

## 6. 实现计划

### Phase 1: 核心功能（MVP）

| 任务 | 说明 | 状态 |
|------|------|------|
| 1.1 | 创建项目结构，编写 PRD | ✅ 完成 |
| 1.2 | 实现 Host 端：Task Store（fs 读写 + 备份） | 待开始 |
| 1.3 | 实现 Host 端：注册 6 个 Tool（含 task_context） | 待开始 |
| 1.4 | 实现 Host 端：上下文解析器（文件读取 + 继承合并） | 待开始 |
| 1.5 | 实现 Host 端：子任务自动流转逻辑 | 待开始 |
| 1.6 | 实现 Host 端：6 个 RPC handler | 待开始 |
| 1.7 | 实现 Client 端：侧边栏入口按钮 | 待开始 |
| 1.8 | 实现 Client 端：浮层看板（平铺 + 树形视图） | 待开始 |
| 1.9 | 集成测试：端到端流程验证 | 待开始 |

### Phase 2: 增强功能

| 任务 | 说明 |
|------|------|
| 2.1 | 看板面板宽度拖拽调整 |
| 2.2 | 任务卡片拖拽 |
| 2.3 | 任务筛选/搜索 |
| 2.4 | 任务统计面板 |
| 2.5 | 任务模板 |
| 2.6 | 任务变更通知 |

---

## 7. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 多 Agent 并发写入冲突 | 任务状态不一致 | 原子文件写入 + 乐观锁 |
| 上下文文件读取越权 | 安全风险 | 仅限 `context.files` 声明的路径，拒绝 `../` |
| 子任务自动流转未触发 | 父任务卡住 | 每次子任务状态变更时检查，同时提供手动触发 |
| 大文件上下文溢出 | 超出 Token 限制 | 单文件截断至 5000 字符，总上下文截断至 20000 字符 |
| 树形视图性能 | 任务多时卡顿 | 虚拟滚动 + 默认折叠子任务 |

---

## 8. 附录

### A. 任务状态流转图（完整）

```
                         ┌──────────┐
                         │  pending  │
                         └─────┬─────┘
                               │ task_claim()
                               ▼
                         ┌───────────┐
                   ┌─────│in-progress│─────┐
                   │     └───────────┘     │
                   │ task_resolve(         │ task_resolve(
                   │   "blocked")          │   "verifying")
                   ▼                       ▼
             ┌──────────┐           ┌───────────┐
             │  blocked  │           │ verifying  │
             └────┬─────┘           └─────┬─────┘
                  │ task_claim()          │ task_verify("approved")
                  ▼                       ▼
             ┌───────────┐          ┌──────────┐
             │in-progress │          │ resolved  │
             └───────────┘          └────┬─────┘
                    ↑                    │ task_archive()
                    │                    ▼
                    │               ┌──────────┐
                    │               │ archived  │
                    │               └──────────┘
                    │
                    └── task_verify("rejected") ──┘

父任务自动流转：
  所有子任务 resolved → 父任务自动 in-progress → verifying
```

### B. 文件结构

```
task-board-plugin/
├── docs/
│   └── PRD.md              # 本文档
├── src/
│   ├── host.js             # 6 个 Tool + 上下文解析器 + 自动流转 + 会话隔离
│   └── client.js           # 侧边栏按钮 + 浮层看板 + 树形视图
└── README.md

运行时文件（自动生成）：
  .dsh/
  ├── tasks-<sessionA>.json  # 会话 A 的任务文件
  ├── tasks-<sessionB>.json  # 会话 B 的任务文件
  └── tasks.backup.json      # 备份文件
```

### C. Slot 注册方案

| 组件 | Slot | 注册方式 | 说明 |
|------|------|----------|------|
| 侧边栏按钮 | `sidebar.footer.action` | `list`，id=`task-board-toggle` | 带待办计数徽标 |
| 浮层看板 | `shell.overlay` | `list`，id=`task-board-panel` | 右侧滑入面板 |

### D. Tool 汇总

| # | Tool | 功能 | 新增于 |
|---|------|------|--------|
| 1 | `task_list` | 列出任务，支持父子关系筛选 | v1.0 |
| 2 | `task_context` | **获取完整上下文（文件内容+继承合并）** | v1.2 |
| 3 | `task_claim` | 领取任务，返回完整上下文 | v1.0 |
| 4 | `task_resolve` | 提交验证/标记阻塞，触发父任务自动流转 | v1.0 |
| 5 | `task_verify` | 通过/驳回验收 | v1.1 |
| 6 | `task_archive` | 归档任务（父任务归档级联子任务） | v1.1 |

### E. 参考

- DSH Cordis Plugin 开发文档
- `fs` Service API（原子文件读写）
- `harness` Builtin（Tool 注册 + RPC）
- `sidebar.footer.action` / `shell.overlay` Slot