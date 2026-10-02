# FEDERATION —— 多 DSH 联邦协同设计（预研）

> 状态：预研设计稿（research/federation 分支）
> 配套骨架：`research/relay/relay.mjs`（零依赖中继）+ `research/relay/smoke.cjs`（回环冒烟）
> 范围：本文档只定设计与协议，不改看板插件本体；实施分层见 §13「兼容性与开关」。

---

## 0. 背景与目标

看板插件当前是**单实例本地任务编排**（Worker/Verifier 派发、依赖、验收、裁决）。联邦协同的目标：让多个 DSH 实例（各自带本地看板）组成一个团队，任务可以从一个「团队看板」分发到各成员实例执行，交付物回收验收。

设计原则：

1. **轻量优先**：不引入消息队列/数据库，一个零依赖 Node 中继进程即可组网。
2. **本地看板仍是执行主体**：成员认领任务后落回自己的本地看板，完全复用现有 Worker/Verifier/progress/escalate 引擎（§10）。
3. **能力默认关闭、纯增量**：未开启联邦的单实例用户零感知（§13）。
4. **v1 只做文本交付物**：调研/评审/方案/文档类任务；代码交付物涉及 git 分支协议，留 v2（§6）。

---

## 1. 拓扑与角色

```
                 ┌─────────────────────┐
                 │   Relay（轻量中继）  │  零依赖单文件进程，内存态
                 │  注册表 + 任务池     │  listen(0) 随机端口或固定端口
                 │  租约回收器          │
                 └──────────┬──────────┘
                            │ HTTP + X-Relay-Token（共享令牌）
        ┌───────────────────┼───────────────────┐
        │                   │                   │
┌───────▼───────┐   ┌───────▼───────┐   ┌───────▼───────┐
│ Master 实例    │   │ Member 实例 A │   │ Member 实例 B │
│ （本地看板晋级）│   │ （本地看板接入）│   │ （本地看板接入）│
│ 发布/验收/仲裁 │   │ 认领/执行/上报 │   │ 认领/执行/上报 │
└───────────────┘   └───────────────┘   └───────────────┘
```

**Hub-and-spoke**：所有实例只与中继通信，实例之间不直连。

| 角色 | 来源 | 职责 |
| --- | --- | --- |
| **Relay（中继/注册中心）** | 独立进程 `relay.mjs` | 成员注册表、联邦任务池（内存态）、排他认领与租约回收、长轮询分发、令牌校验。不做执行、不做验收裁决。 |
| **Master（团队看板）** | 任一本地看板「晋级」而来（§2） | 发布任务入联邦池（镜像本地已 publish 的任务）、拉取交付物、本地走 Verifier 验收、集中仲裁（§8）、取消任务。 |
| **Member（成员看板）** | 本地看板「接入」团队 | 长轮询拉任务、排他认领、落本地看板执行（复用现有引擎）、心跳续租、上报交付物/阻塞。 |

---

## 2. 晋级语义（master promotion）

1. **任一本地看板均可晋级**：持有共享令牌的实例调用 `register(role=master)` 即成为 master。晋级是声明式的，不需要中继持久化任何「master 身份」。
2. **master 宕机可另选**：另一个实例重新 `register(role=master)` 即可接管。中继不存 master 锁，语义上以「当前谁在行使 master 动作（publish/arbitrate/cancel）」为准；v1 假设团队内人为协调同一时刻只有一个活跃 master（局域网小团队场景）。
3. **状态从本地看板文件恢复**：中继是内存态（可丢失），真正的任务事实源在各实例的本地看板文件：
   - master 重启后，从本地看板文件把「已发布到联邦」的任务重新 `publish` 镜像入池（幂等：携带原 taskId，中继按 id upsert）。
   - member 重启后，从本地看板文件找到自己认领中的联邦任务，重新 `heartbeat` 续租或 `release` 回池。
   - 中继重启 = 全员按上两条重建。租约丢失期间的任务由成员重新认领，重复执行风险由 master 验收环节兜底（文本交付物可幂等覆盖）。

---

## 3. 最小协议面：8 动作

全部端点为 `POST /v1/<action>`，JSON 请求体，请求头携带 `X-Relay-Token: <共享令牌>`，令牌错误一律 `401`。

### 3.1 动作总表

| # | 动作 | 调用方 | 语义 | 成功 | 关键失败 |
| --- | --- | --- | --- | --- | --- |
| 1 | `register` | master / member | 注册（幂等 upsert），返回租约参数 | 200 | 400 缺 memberId |
| 2 | `poll` | master / member | 长轮询：成员拉 pending 任务；master 拉 verifying/blocked 任务 | 200 | 404 未注册 |
| 3 | `claim` | member | **排他认领** + 挂租约 | 200 | 409 已被认领 |
| 4 | `heartbeat` | member | 续租 + 刷新成员存活 | 200 | 409 租约不属于你 |
| 5 | `report` | member | 上报交付物（verifying）或阻塞升级（blocked） | 200 | 409 任务不属于你 |
| 6 | `arbitrate` | **master 专用** | 裁决：answer / approve / reject / requeue | 200 | 403 非 master |
| 7 | `cancel` | **master 专用** | 取消任务（终态） | 200 | 403 非 master |
| 8 | `release` | member / master | 主动释放认领，任务回池 | 200 | 403 非认领者 |

**补充端点**（不计入成员协议 8 动作）：

| 端点 | 调用方 | 语义 |
| --- | --- | --- |
| `POST /v1/publish` | **master 专用** | 把本地看板已发布的任务**镜像**进联邦池（v1 由 master 侧增量注入；携带原 taskId 时幂等 upsert） |
| `GET /v1/state` | 调试/POC | 全量内存态观测（成员表 + 任务表 + 租约参数） |

### 3.2 载荷 JSON 草案与字段说明

**register**
```json
// 请求
{ "memberId": "laptop-alice", "role": "member", "boardUrl": "http://192.168.1.10:3080" }
// 响应
{ "ok": true, "memberId": "laptop-alice", "role": "member",
  "heartbeatIntervalMs": 30000, "leaseMs": 90000 }
```
- `memberId`（必填）：实例标识，建议 hostname-用户名。
- `role`：`"master"` 晋级为主控；缺省 `"member"`。
- 响应回带租约参数，成员按此对齐心跳节奏，**不要求各实例本地配置一致**。

**publish**（master 专用）
```json
// 请求
{ "memberId": "master-1",
  "task": { "id": "fed-123", "title": "评审联邦协议草案",
            "description": "输出 Markdown 评审意见",
            "payload": { "kind": "review", "source": "docs/FEDERATION.md" } } }
// 响应 201
{ "ok": true, "task": { "id": "fed-123", "status": "pending", ... } }
```
- `task.id` 可选；携带时为幂等 upsert（用于 master 重启恢复，§2），缺省由中继生成 UUID。
- `payload`：文本交付物任务的输入材料（v1 仅文本/结构化 JSON，不放文件路径——路径跨机无意义）。

**poll**（长轮询）
```json
// 请求
{ "memberId": "laptop-alice", "waitMs": 15000 }
// 响应（成员视角：pending 队列；master 视角：verifying/blocked 队列 + 交付物）
{ "ok": true, "tasks": [ { "id": "fed-123", "title": "...", "status": "pending",
                           "payload": { ... }, "lostContacts": 0 } ] }
```
- 池空时挂起至 `waitMs`（上限 `pollMaxWaitMs`），有任务入池/回池立即唤醒返回；超时返回空数组。
- 角色感知：member 只见 `pending`，master 只见 `verifying`/`blocked`（含 `deliverable`、`reportNote`、`arbitration` 日志）。

**claim**（排他 + 租约）
```json
// 请求
{ "memberId": "laptop-alice", "taskId": "fed-123" }
// 成功 200
{ "ok": true, "taskId": "fed-123",
  "lease": { "expiresAt": 1735689600000, "leaseMs": 90000, "heartbeatIntervalMs": 30000 } }
// 已被认领 409
{ "ok": false, "error": "already-claimed", "claimedBy": "laptop-bob", "status": "claimed" }
```

**heartbeat**
```json
// 请求（带 taskId = 续租；不带 = 纯存活心跳）
{ "memberId": "laptop-alice", "taskId": "fed-123" }
// 响应
{ "ok": true, "lease": { "expiresAt": 1735689690000 } }
```

**report**
```json
// 交付（status 缺省即 verifying）
{ "memberId": "laptop-alice", "taskId": "fed-123", "status": "verifying",
  "deliverable": "# 评审意见\n\n1. ...", "note": "已覆盖 §3 协议表" }
// 阻塞升级
{ "memberId": "laptop-alice", "taskId": "fed-123", "status": "blocked",
  "note": "payload.source 提到的文档在团队仓库里找不到，是指本预研分支吗？" }
```
- `deliverable`：**纯文本（Markdown）**，v1 的交付物唯一形态。
- verifying 后租约结束，验收权移交 master。

**arbitrate**（master 专用）
```json
{ "memberId": "master-1", "taskId": "fed-123",
  "verdict": "answer | approve | reject | requeue", "answer": "…" }
```
| verdict | 适用状态 | 结果 |
| --- | --- | --- |
| `answer` | blocked | 答疑后回到 `claimed`（原认领者、新租约）继续 |
| `approve` | verifying | 验收通过 → `done`（终态） |
| `reject` | verifying | 打回重做 → `claimed`（原认领者、新租约），`answer` 携带修改意见 |
| `requeue` | 任意非终态 | 回池 `pending`，清除认领与租约 |

**cancel**（master 专用）
```json
{ "memberId": "master-1", "taskId": "fed-123" }   // → cancelled（终态）
```

**release**
```json
{ "memberId": "laptop-alice", "taskId": "fed-123" }  // 认领者本人或 master → 回池 pending
```

### 3.3 通用错误码

`401 bad-token` / `400 bad-json | body-too-large | 字段缺失` / `403 master-only | not-your-task` / `404 task-not-found | member-not-registered | unknown-endpoint` / `409 already-claimed | not-your-lease | terminal`。

---

## 4. 任务生命周期

```
publish ──► pending ──claim(排他+租约)──► claimed ──report──► verifying ──approve──► done
              ▲                            │  │                   │
              │                            │  └─report(blocked)─► blocked ──answer──► claimed
              │                            │                        （master 答疑后续作）
              │                   heartbeat 续租（每 30s）
              │                            │
              └──release / 失联回收(90s)────┘        verifying ──reject──► claimed（重做）
     任意非终态 ──cancel──► cancelled                verifying/claimed ──requeue──► pending
```

1. **publish**：master 把本地看板中「已发布且依赖就绪」的文本任务镜像入联邦池。
2. **claim**：排他——同一时刻只有一个成员持有任务；认领即挂租约。
3. **本地执行**：成员把联邦任务落本地看板，走现有 Worker/Verifier 引擎（§10），期间每 30s 心跳续租。
4. **report**：交付物（文本）回传中继，任务转 `verifying`；执行中升级则转 `blocked` 等 master 答疑。
5. **验收回收**：master 长轮询拿到 `verifying` 任务与交付物，本地 Verifier 复核后 `approve`（终态）或 `reject`（打回）。

---

## 5. 租约与失联回收（默认参数）

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| 心跳间隔 `heartbeatIntervalMs` | **30s** | 认领期间成员每 30s `heartbeat` 续租一次 |
| 租约时长 `leaseMs` | **90s（= 3 次心跳）** | **3 次心跳失联**判定实例离线，任务回收重入池 |
| 回收器扫描 `reapIntervalMs` | 1s | 中继侧扫描周期 |
| 长轮询上限 `pollMaxWaitMs` | 15s | `poll` 单次挂起上限，超时返回空数组由客户端重发 |

- 失联回收动作：`claimed`/`blocked` 且租约过期 → 状态回 `pending`、清认领者、`lostContacts + 1`（记入任务历史，master 可见，用于识别「烫手任务」）。
- 为什么 3 次而非 1 次：容忍单次网络抖动/实例 GC 停顿，避免任务在健康实例间反复横跳。
- 租约到期时刻以**中继时钟**为准，不要求实例间时钟同步（成员只用响应里的相对时长 `leaseMs` 安排心跳）。

---

## 6. v1 范围限定：纯文本交付物

- **只做**：调研、评审、方案、文档类任务——交付物是一段 Markdown 文本，随 `report.deliverable` 内联回传（中继请求体上限 1MB，对文本足够）。
- **不做（留 v2）**：代码交付物。其难点在 git 分支协议（分支命名约定如 `federation/<taskId>/<memberId>`、补丁包交换、工作区冲突、touches 文件锁的跨机语义），v2 单独立项。
- v1 的 `payload`/`deliverable` 中**禁止放本机文件路径**（跨机无意义），材料要么内联文本、要么给可访问的 URL。

---

## 7. 跨实例语义：什么同步、什么不同步

| 看板概念 | 跨实例是否有意义 | 处理方式 |
| --- | --- | --- |
| `dependsOn` 依赖 | **有意义，要同步** | v1 简化：master 只在**依赖全部就绪后**才把任务 publish 进联邦池（依赖图留在 master 本地看板计算，不下发到中继）。v2 再考虑跨实例依赖事件传播。 |
| `touches` 文件锁 | **无意义，不同步** | 文件路径只在各实例本机文件系统内有意义；跨机不共享工作区，touches 锁不跨实例传播。代码任务的冲突消解属于 v2 git 分支协议范畴。 |
| 任务标题/描述/交付物 | 有意义 | 全部内联文本，随协议载荷走。 |
| Worker/Verifier 派发、进度、升级 | 纯本地 | 成员认领后完全走本地引擎（§10），中继只见 claim/heartbeat/report 三个粗粒度信号。 |

---

## 8. 仲裁权：集中 master

- 所有升级（成员 `report(blocked)`）的答疑、所有交付物的验收通过/打回、任务取消与强制回池，**只能由 master 发起**（`arbitrate`/`cancel` 端点 403 强制）。
- 理由：单一事实源，避免多实例并发裁决产生分叉；与本地看板「裁决权在主窗口」的语义一致。
- master 宕机期间 blocked 任务原地等待（租约在 blocked 状态同样受心跳约束，成员需持续心跳）；新 master 晋级后即可处理积压。

---

## 9. 信任模型

- **共享令牌**：所有请求携带 `X-Relay-Token`，中继做常数时间比较（`crypto.timingSafeEqual`）。令牌由团队带外分发（口头/IM），v1 无每成员凭证、无注册审批。
- **局域网假设**：中继绑定 `127.0.0.1`（POC）或受信内网网卡；**不暴露公网**。无 TLS——如跨不可信网络，v1 的答案是「不要这么做」，v2 再评估 TLS/双向认证。
- 令牌泄漏的爆炸半径 = 整个团队任务池（可读可投毒），与局域网小团队风险相称。

---

## 10. 与现有看板引擎的复用映射

成员认领联邦任务后，**落本地看板走现有引擎**，联邦层只做薄适配：

| 联邦概念 | 现有看板引擎对应物 | 说明 |
| --- | --- | --- |
| relay `publish` | `task_create(publish=true)` | master 本地发布 → 适配层镜像到中继 |
| relay `poll` 返回的任务 | 成员侧 `task_create`（来源标记 `federation`） | 认领成功后落本地看板，走正常派发 |
| relay `claim` | `task_claim` / 派发器的排他认领 | 联邦层排他由中继租约保证 |
| relay `heartbeat` | Worker 进度心跳（progress） | 本地执行活跃 → 适配层定期向中继续租 |
| relay `report(verifying)` | `board_report(kind=complete)` / `task_resolve(verifying)` | 本地验收通过后把交付物文本回传 |
| relay `report(blocked)` | `board_report(kind=escalate)` / `task_resolve(blocked)` | 本地升级 → 联邦阻塞，等 master 答疑 |
| relay `arbitrate(answer/reject)` | `task_arbitrate` / Verifier 打回 | master 裁决经中继下发，适配层注入本地任务 |
| relay `cancel` / 失联回收 | `task_update(cancelled)` / 卡死 Worker 回收重派 | 本地任务同步取消或重入池 |

关键收益：**成员实例零新引擎**——联邦任务在本地看板看来就是一个普通任务（多一个「来源实例/联邦 taskId」可选字段，§13.4）。

---

## 11. POC 验证路径

1. **协议回环冒烟（不起 DSH）**：`research/relay/smoke.cjs`——同进程启动中继于随机端口，HTTP 模拟 1 个 master + 2 个成员，断言排他认领与失联回收（测试参数：心跳 2s / 租约 6s）。
   ```bash
   cd research/relay && node --check relay.mjs && node smoke.cjs   # 全绿 exit 0
   ```
2. **本机双 profile 组网（真 DSH）**：两个 DSH 实例使用不同 `DSH_HOME`/profile 启动（如 `DSH_HOME=D:\dsh-fed-a`、`D:\dsh-fed-b`），各自装看板插件；一个晋级 master、一个接入为 member；中继独立进程 `node relay.mjs --port=0`。验证：master 发布文本任务 → member 认领落本地看板 → 本地 Worker 执行 → 交付物回收 → master 验收。
3. **宕机演练**：kill master，另一实例晋级接管（§2）；kill member，观察 90s 失联回收重入池。

---

## 12. 待拍板决策点（附推荐默认值）

| # | 决策点 | 选项 | 推荐默认值 | 理由 |
| --- | --- | --- | --- | --- |
| D1 | **中继形态** | A. 独立进程 / B. 嵌进 master 实例内 | **A. 独立进程** | master 可漂移（宕机另选）时中继不随之死；中继本身无状态，独立进程运维成本已极低。合一的唯一收益是少起一个进程。 |
| D2 | **仲裁权** | A. 集中 master / B. 下放给认领者自裁决 | **A. 集中 master** | 单一事实源；与本地看板语义一致；下放只在更大规模（>10 实例）时再评估。 |
| D3 | **租约参数** | 心跳/失联阈值可调 | **心跳 30s、3 次失联（90s）回收** | 30s 心跳对长任务开销可忽略；3 次容忍抖动；90s 的任务空窗期对文本任务可接受。 |

---

## 13. 兼容性与开关（硬约束：默认关闭、纯增量）

联邦能力对现有单实例用户必须**零感知、零开销、零迁移成本**：

### 13.1 单实例用户体验零变化
未开启联邦时，UI **不出现任何联邦入口**：晋级按钮、「接入团队 master」面板、任务上的联邦来源标识一律不渲染。渲染开关由看板数据通道下发——`get-tasks` 响应中携带能力标志（如 `capabilities.federation`），UI 据此条件渲染；不开时前端连相关组件分支都不进入。

### 13.2 配置开关 `federationEnabled`
插件配置新增 `federationEnabled`（**默认 `false`**）。开启后配置面板才出现「晋级为 master / 接入团队 master」入口（含中继地址、共享令牌、实例标识三项输入）。关闭 → 开启无需迁移；开启 → 关闭后本地任务照常（联邦字段被忽略，不删除）。

### 13.3 代码隔离：独立模块按需加载
协议客户端与同步逻辑全部隔离在独立模块（如 `lib/federation.mjs`），`index.mjs` 主路径只在 `federationEnabled === true` 时 `await import()` 动态加载——**主路径零开销**：未开启时没有额外的定时器、网络请求、字段遍历。与中继的所有通信（register/poll/claim/heartbeat/report/arbitrate/cancel/release）只允许出现在该模块内。

### 13.4 数据模型纯增量
任务对象上的联邦字段**全部可选**：`federation?: { originInstance?, remoteTaskId?, leaseExpiresAt?, claimedByInstance? }`。老看板文件无此字段，`normalizeBoard` 规范化后照常工作（字段缺省即本地任务）；新字段不参与既有排序/过滤/统计逻辑。

---

## 附录：预研交付物清单

| 文件 | 说明 |
| --- | --- |
| `docs/FEDERATION.md` | 本文档 |
| `research/relay/relay.mjs` | 零依赖单文件中继骨架：8 动作端点 + publish/state 补充端点 + 内存态（任务表/成员表/内嵌租约）+ 租约回收器 + `X-Relay-Token` 校验；`node relay.mjs --port=0 --token=xxx` 可独立运行 |
| `research/relay/smoke.cjs` | 回环冒烟：排他 claim 断言 + 失联回收断言 + 长轮询唤醒/令牌/越权/验收回路，全绿 exit 0 |
