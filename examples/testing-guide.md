# 任务看板插件 — 测试指南

> 适用版本：v4.x（生产者-消费者池架构）
> 测试环境：DSH Web GUI（http://127.0.0.1:3080）+ 动态 Cordis 插件运行时
> 插件 ID：`tskbd-1`（进程内动态注册，重启后需重新定义运行）

本文档覆盖三层测试：**单元测试**（状态机纯函数）、**池 E2E**（常驻 Worker/Verifier 全链路）、**Team 模式测试**（歧义上报/裁决/高优介入/状态一致性）。

---

## 0. 快速开始（3 步最小成本验证插件可用）

只想确认插件活着？按此 3 步，1 分钟内完成冒烟验证，无需读完后文：

```text
第 1 步：task_list
```
→ 返回 JSON 且含 `boardMode` + `poolStatus` 字段，说明 Host 工具已注册、任务文件可读。

```text
第 2 步：task_create { title: "冒烟测试" }
```
→ 返回 `ok:true` 且 task.status=`pending`；同时打开看板（会话头部 📋 按钮）应看到该卡片出现在"待办"列，说明 Client UI 与 RPC 链路正常。

```text
第 3 步：task_update { taskId: <上一步的任务ID>, resetToPending: true } 或直接在 UI 拖拽卡片
```
→ 看板 3 秒内自动刷新反映变化（轮询生效）。

**三步全过 = 插件可用**，可进入正式测试。任一步失败：第 1 步失败查插件是否运行（cordis_inspect_self）；第 2 步失败查 Host 写文件权限；第 3 步失败查 Client 轮询（`ctx.interval`）与 `get-tasks` RPC。

---

## 1. 测试前准备

### 1.1 确认插件运行

```text
对话中输入：task_list
```

期望返回 JSON 包含 `boardMode`、`poolStatus`（workers/verifiers 数组）。若报工具不存在，说明插件未挂载——静态安装后需重启 dsh（源码即 `packages/dsh-agent-board/`）。

### 1.2 打开看板 UI

点击会话头部工具栏的 **📋 看板** 按钮，面板从对话上方展开。确认：
- 头部显示 `W-` `W+` `V-` `V+` 四个池配置输入框
- 池状态徽标 `⚡忙碌/总数`（Worker）与 `✓忙碌/总数`（Verifier）
- 五个看板列：待办 / 进行中 / 验证中 / 已完成 / 阻塞

### 1.3 清理测试残留

每个测试用例结束后，将任务归档，避免污染后续用例：

```text
task_archive → taskId=<已完成任务ID>
```

> 注意：任务文件按会话隔离（`.dsh/tasks-<sessionId>.json`，插件沙箱 fs 内），不同会话互不可见——这本身也是隔离性测试点。

---

## 2. 单元测试（状态机与纯函数）

单元测试针对 Host 侧的纯函数逻辑，通过 **工具调用即单测** 的方式进行（每个 tool 调用就是一次函数执行 + 断言）。

### 2.1 任务创建 — `task_create`

| # | 步骤 | 预期 |
|---|------|------|
| 1 | `task_create { title: "测试任务A", priority: "high" }` | `ok:true`，task.status=`pending`，history 含 `created→pending` |
| 2 | 再次 `task_create { id: "task-a-2", ... }` 后重复同 id | `ok:false`，`error: "duplicate id"` |
| 3 | 缺 `title` 调用 | 参数校验拒绝（required: ['title']） |

### 2.2 领取规则 — `task_claim` / `claimCheck`

| # | 前置 | 步骤 | 预期 |
|---|------|------|------|
| 1 | 任务 pending | `task_claim { taskId }` | → `in-progress`，claimedBy=当前 actor |
| 2 | 任务已 in-progress 且他人持有 | 再次 claim | `error: "claimed by <id>"` |
| 3 | 任务为 manual 指派给他人 | claim | `error: "assigned to <id>"` |
| 4 | 已有 3 个非子任务 active | claim 第 4 个顶级任务 | `error: "max 3 active"`（子任务不占额度） |
| 5 | 子任务的父任务非 in-progress/verifying | claim 子任务 | `error: "parent not in-progress"` |

### 2.3 提交与验收 — `task_resolve` / `task_verify`

| # | 步骤 | 预期 |
|---|------|------|
| 1 | in-progress 任务：`task_resolve { status:"verifying", resolution:"完成说明" }` | → `verifying`，resolution 写入 |
| 2 | 同上但不传 resolution | `error: "resolution required"` |
| 3 | 非领取人调用 resolve | `error: "not claimed by you"` |
| 4 | verifying 任务：`task_verify { verdict:"approved" }` | → `resolved`，verifiedAt/verifiedBy 写入 |
| 5 | verifying 任务：`task_verify { verdict:"rejected", comment:"原因" }` | 回到 `in-progress`，resolution 清空，history 记录驳回原因 |

### 2.4 父子任务联动 — `checkParentAuto`

| # | 前置 | 步骤 | 预期 |
|---|------|------|------|
| 1 | 父任务 in-progress + 2 子任务 | 两子任务依次走完 claim→resolve→verify(approved) | 第 2 个子任务 approved 时，父任务**自动** → `verifying`，history 含 `system / auto: all subtasks resolved` |
| 2 | 仅 1 个子任务 resolved | — | 父任务保持 in-progress 不动 |
| 3 | 父任务归档 | `task_archive { taskId: 父ID }` | 子任务级联归档，返回 `childrenArchived: 2` |

### 2.5 会话隔离 — `resolveRoot` / 双通道 sessionId

| # | 步骤 | 预期 |
|---|------|------|
| 1 | 会话 A 创建任务 X；切到会话 B 打开看板 | B 看不到任务 X（各自读 `tasks-<各自sid>.json`） |
| 2 | 子 Agent 内调用 `task_list` | 返回**根会话**的任务池（沿 ownership 链上溯），而非子 Agent 自己的空池 |

### 2.6 配置钳制 — `set-board-config`

| # | 步骤 | 预期 |
|---|------|------|
| 1 | `set-board-config { key:"maxWorkers", value:99 }` | 实际钳制到 10 |
| 2 | `set-board-config { key:"minVerifiers", value:-1 }` | 实际钳制到 0 |

---

## 3. 池 E2E 测试（生产者-消费者全链路）

> 前置：看板面板设置 `W- = 1`（至少 1 个常驻 Worker）。flatMap 兼容性修复（dsh-tool-cordis 对字符串 content 的防御）需已随 DSH 重启生效，否则子 Agent 首个 turn 即崩，超时保护会把任务标记 blocked、worker 标记 dead。

### 3.1 单任务全链路（冒烟）

```text
1. task_create { id:"e2e-1", title:"写一个 hello world 函数", description:"输出 hello world", priority:"medium" }
2. 等待 ≤3s（客户端轮询触发 poolCycle）
3. task_context { taskId:"e2e-1" }
```

**逐步断言**：
1. 创建后 status=`pending`
2. poolCycle 后：worker 被 spawn（池状态 `⚡1/1`），任务 → `in-progress`，claimedBy=worker 的子会话 id，history 含 `pool-worker-1`
3. worker 完成（≤90s 超时窗内）：任务 → `verifying`，resolution=worker 输出文本
4. 手动 `task_verify { verdict:"approved" }` → `resolved`

### 3.2 自动扩容

```text
设置 W+ = 3，一次性创建 5 个 pending 任务
```

**断言**：poolCycle 每轮按 `ceil(pending/2)` 计算目标并 spawn（上限 3）；池状态 workers 数量从 1 → 2 → 3；前 3 个任务并行被领取，后 2 个排队等 worker 空闲后接续。

### 3.3 自动缩容

```text
全部任务完成后，观察后续 1-2 轮 poolCycle
```

**断言**：pending 清空且存在多余空闲 worker 时，多余者被 dispose（dispatchInfo 含 `dispose worker-N`），池回落到 `W-` 下限。

### 3.4 超时保护

```text
创建一个需要超长处理的任务（或人为让 worker 崩溃）
```

**断言**：90s（worker）后 `withTimeout` 触发，任务 → `blocked`（note 含 `worker-N error`），worker 标记 `dead` 并在下轮 poolCycle 被清理 + 补位新 worker。

### 3.5 Verifier 池联动

```text
设置 V- = 1（常驻 Verifier）
完成 3.1 使任务进入 verifying
```

**断言**：
1. verifier 自动被 spawn（`✓1/1`），领取 verifying 任务
2. verifier 输出含 APPROVED → 任务自动 `resolved`；含 REJECTED → 回到 `in-progress` 并附审核意见
3. 60s 无响应 → 超时按 rejected + `verifier error` 处理

---

## 4. Team 模式测试（歧义上报 / 裁决 / 高优介入）

> Team 模式语义：`teamMode` 开启后，所有任务必须经看板由常驻子 Agent 处理；子 Agent 遇到歧义时上报主窗口裁决；用户可在任意阶段向子 Agent 发送高优先级指令；全程看板状态保持一致。

### 4.1 歧义上报路径（escalation）

```text
1. task_create { id:"team-1", title:"部署到生产服务器（无服务器信息）", description:"把项目部署到生产服务器" }
2. 等待 worker 领取并处理
```

**断言**：
1. worker 识别缺失关键信息，输出 `[ESCALATE]` 标记 + 缺失项清单（主机/凭证/域名/部署对象）
2. 任务进入**待裁决**状态（看板可见标记），而非继续盲做或静默失败
3. 主窗口收到上报内容，可裁决（补充信息/变更方案/取消任务）

### 4.2 裁决后执行

```text
主窗口对 team-1 裁决："不需要真实服务器，改写部署演练文档 deploy-simulation.md"
```

**断言**：
1. 裁决指令作为高优消息注入该 worker（`followup`），worker 按裁决继续
2. worker 产出文档后任务 → `verifying`，resolution 即完成内容
3. history 完整记录：claim → escalate → arbitrate → resolve 全链路，actor 各自可追溯

### 4.3 用户高优介入（中断当前工作）

```text
1. 创建一个耗时任务并被 worker 领取
2. 任务进行中，从详情页向该 worker 发送高优指令："停止当前做法，改用方案 B"
```

**断言**：
1. 指令以高优先级送达（worker 当前 turn 结束后优先处理，或按实现立即抢占）
2. 看板任务状态不因此错乱：仍保持 in-progress（除非指令明确要求变更状态），history 追加介入记录（actor=用户会话）
3. worker 后续输出体现新指令被采纳

### 4.4 状态一致性（关键不变量）

任何测试路径下，以下不变量必须恒成立——违反即为 bug：

| 不变量 | 检查方式 |
|--------|----------|
| in-progress 必有 claimedBy | 遍历任务断言 |
| verifying 必有 resolution | 同上 |
| 已归档任务不再出现在活跃列 | 看板 UI 五列计数 |
| 子任务全 resolved ⇒ 父任务自动 verifying | 2.4 用例 |
| worker 崩溃 ⇒ 任务不悬挂在 in-progress 超过超时窗 | 3.4 用例 |
| 池 worker 数 ∈ [W-, W+]（稳态） | 池状态徽标 |
| 同一任务同一时刻至多一个执行者 | claimedBy 唯一性 |

### 4.5 驳回-返工闭环

```text
任务进入 verifying 后，task_verify { verdict:"rejected", comment:"产出答非所问" }
```

**断言**：任务回 `in-progress`，resolution 清空，原 worker（或池中其他空闲 worker）可再次处理；history 中驳回原因与返工记录完整。

---

## 5. 回归测试速查表（发版前必过）

- [ ] 2.1–2.6 全部单元用例通过
- [ ] 3.1 冒烟链路通过（pending→in-progress→verifying→resolved）
- [ ] 3.2 扩容 / 3.3 缩容各观察一轮
- [ ] 4.1 上报触发 + 4.2 裁决执行 + 4.5 驳回返工
- [ ] 看板 UI：拖拽流转、详情编辑重置、仪表盘 Tab、右侧栏开合后面板不被遮挡（布局自适应）
- [ ] 会话隔离：两个会话各自看板互不可见

---

## 6. 常见问题排查

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| 任务创建后无人领取 | boardMode=manual；或池 W-=0；或 worker 全部 dead | 切回自动模式；调大 W-；查 dispatchInfo 错误 |
| worker 全部 dead | 子 Agent 启动即崩（旧版 flatMap bug） | 确认 DSH 已重启加载 dsh-tool-cordis 修复 |
| 任务卡 in-progress | 超时保护未触发（<90s）或 promise 悬挂 | 等超时窗；超时后自动 blocked |
| 看板空白 | 插件 host/client 只有半边运行 | cordis_inspect_self 检查双半边状态均为 running |
| 跨会话看到别家任务 | sessionId 未从 slot props 传入 | 查客户端 `props.sessionId` 链路 |
