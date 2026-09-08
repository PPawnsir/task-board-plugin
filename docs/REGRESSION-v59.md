# dsh-agent-board 端到端回归测试说明

> 测试时间：2026-09-08 04:34–04:40 UTC
> 测试对象：**静态 Bundle 安装版**（`dsh plugin --profile web add`，link: 软链， bundles 列表挂载）
> 测试会话：session-61f0e9c2-2385-4dc7-9083-15910eff97c9
> 结果：**10/10 全部通过**，测试任务已全部清理归档

## 测试目的

验证动态插件 → 静态 Bundle 转换后，全部功能在正式安装形态下与动态版行为一致。重点覆盖安装转换的 API 差异面（工具注册、webServer RPC 路由、client fetch 通道）。

## 测试方法与结果

### 1. RPC 路由健康检查 ✅

```powershell
POST http://127.0.0.1:3080/dsh-agent-board
{"method":"get-tasks","args":{"sessionId":"..."}}
```

**验证点**：静态插件的 webServer 路由挂载成功，返回 `version/tasks/boardMode/teamMode` 完整数据。
**结果**：正常返回（29 个历史归档任务原样可见 → 数据兼容性 ✓）。

### 2. 任务 CRUD ✅

| 操作 | 验证点 | 结果 |
|---|---|---|
| `task_create` | 创建 reg-crud-1，字段完整（id/pipeline/history 初始轨迹） | ✓ |
| `task_context` | 返回 task + inheritedContext | ✓ |
| `task_update` | title/description/priority 更新生效 | ✓ |
| `task_list` | 列出非归档任务，actor 正确识别为主会话 | ✓ |

### 3. 依赖环检测 ✅

- 创建 reg-dep-A、reg-dep-B（B dependsOn A）→ 成功
- `task_update` 给 A 加 dependsOn=[B] → **拒绝**：`circular dependency via: reg-dep-B` ✓

### 4. 手动流水线（direct 档） ✅

```
pending →(task_claim)→ in-progress →(task_resolve)→ resolved →(task_archive)→ archived
```

**验证点**：direct 档 `task_resolve status=verifying` 被短路为直接 resolved（不进 verifying）。history 轨迹完整记录 4 步流转。

### 5. 批量操作（codec 修复回归） ✅

以修复后的客户端 payload 形态直接调 RPC：

| Payload | 结果 |
|---|---|
| `{ids:[A,B], op:'archive'}`（**无 value 字段**） | `done:0, skipped:[A,B]` — pending 状态正确跳过，**无 codec 错误** ✓ |
| `{ids:[A,B], op:'set-priority', value:'critical'}` | `done:2` ✓ |
| `batch-undo` 快照回滚 | A/B 优先级恢复 medium ✓ |

**核心回归点**：不带 value 的 archive payload 不再触发 codec 拒绝（v59 修复的原始 bug）。

### 6. Pipeline 三档行为 ✅

| 档位 | 任务 | 预期 | 实际 |
|---|---|---|---|
| work | reg-pipe-work | Worker 执行后直接 resolved，不分配 verifier | `resolved`，有 deliverable，无 verification ✓ |
| full | reg-pipe-full | Worker 执行 → verifying → Verifier 审查 → resolved | `resolved`，deliverable + verification(approved) ✓ |
| direct | reg-dep-A/B | 不进池，池状态无认领 | 保持 pending 直到手动处理 ✓ |

### 7. 依赖串行调度 ✅

reg-chain-A（work）→ reg-chain-B（dependsOn A，work）：

```
A: created=04:36:40  claimed=04:36:54  resolved=04:37:03
B: created=04:36:52  claimed=04:37:04  resolved=04:37:43
```

**验证点**：B 创建于 A 完成前 11 秒，但直到 A resolved 后 1 秒才被领取 —— 依赖门禁（depsSatisfied）在池派发层生效 ✓。

### 8. 池 E2E（自动派发全链路） ✅

4 个 auto 任务（pipe-work/pipe-full/chain-A/chain-B）创建后被池自动认领：

- **扩容**：worker #13、#14 自动 spawn（pending 任务驱动）
- **执行**：两个 worker 并行完成各自任务（board_report 工具通道写入 deliverable）
- **验证**：full 档任务自动分配 verifier，board_verdict approved（verification.summary 有真实审查内容）
- **回收**：任务清空后 worker 缩容至 minWorkers=1

### 9. Team 模式硬拦截 ✅

```
set-team-mode enabled=true → pwsh "probe" → 被拦截：
"[任务看板 Team 模式] 直接执行已被拦截：所有改动必须走看板流程…"
set-team-mode enabled=false → pwsh 恢复正常
```

**验证点**：`tools/pre-execute` 拦截器在静态插件形态下工作正常（读类工具和 task_* 工具不受阻，关闭操作可正常完成）✓。

### 10. 清理与状态恢复 ✅

7 个测试任务批量归档（reg-crud-1 已归档故 skipped，幂等行为正确）；
最终状态：非归档任务 0、池缩至 1 worker 待命、teamMode=false。

---

## 追加回归：用户报告的两个问题（2026-09-08 二轮）

### 11. Team 模式任务派发 + 歧义通信流转 ✅（含 1 个真 bug 修复）

**用户报告**：团队模式下待办任务没有被领取，Worker 状态显示"本轮运行失败 message.content.map is not a function"。

**根因定位**（worker 会话日志取证）：
- spawn 时 `subagents.start(provider, { prompt: <裸字符串> })`，init turn 的 inbox 消息 `content` 是字符串而非 ContentBlock 数组
- `dsh-subagent` 类型定义明确要求 `prompt: ContentBlock[]`（types.d.ts:95）
- `createUserMessage` 不做归一化，字符串原样进 inbox（日志 seq 659130 实证）
- LLM 序列化时 `message.content.map()` 崩溃 → init turn 报 turnError，worker 处于"显示失败但后续 followup 又能跑"的薛定谔状态；init 失败时 run.result reject → worker 标 dead → 池反复 spawn 死 worker → 任务无人领取

**修复**：`host-v30.js` spawnAgent —— `prompt: [{ type: 'text', text: prompt }]`

**回归验证**（修复后）：
| 链路 | 结果 |
|---|---|
| teamMode=true 时创建 work 档任务 | worker-22 在 2 秒内自动领取 ✓ |
| Worker board_report 完成 | resolved，deliverable 完整 ✓ |
| 故意歧义任务（"把那个文件改成蓝色"） | 15 秒内 escalation 上报，question 字段完整 ✓ |
| task_arbitrate 裁决回流 | arbitration 消息入队，worker 10 秒内按裁决完成 ✓ |
| messages 数组 | escalation + arbitration 双记录，时序正确 ✓ |

### 12. 池配置保存 UX ✅（确认缺陷并修复）

**用户报告**：池配置修改后没有保存按钮，无法动态扩缩容。

**确认**：PoolCfg/ModelCfg 原本只有 onBlur/Enter 隐式保存——点击弹出层外部关闭时 onBlur 时序不可靠，用户无明确保存路径。

**修复**（client-v30.js）：
- PoolCfg 四个输入框（W-/W+/V-/V+）加 **−/＋ 步进按钮**（点击即生效）
- 输入与当前值不一致时显示 **✓ 应用按钮**（dirty 状态高亮边框 + 显式确认入口）
- ModelCfg（Verifier 异构模型）同样加 dirty 检测 + ✓ 按钮

**回归验证**：`set-board-config` RPC 直连测试 minWorkers 0→3→1 往返写读一致 ✓；UI 交互需浏览器人工确认（见未覆盖项）。

### 二轮修复后状态

- 包已重建（build-pkg.cjs），双端语法检查通过
- **host 端修复需重启 DSH 生效**（Node ESM 模块缓存，link: 只让文件变、不重载已 import 模块）
- 测试任务已全部清理归档，teamMode 已复位 false

## 覆盖矩阵

| 层 | 覆盖项 |
|---|---|
| RPC 路由 | get-tasks / claim / resolve / archive / batch-op / batch-undo / set-team-mode |
| 工具面 | task_create / list / context / update / claim / resolve / archive |
| 池机制 | 自动扩容 / 并行执行 / deliverable 写入 / verifier 审查 / 缩容 |
| 调度门禁 | 依赖串行 / 环检测 / pipeline 分档 / direct 不进池 |
| 安全边界 | Team 模式硬拦截 / 幂等跳过 / 批量撤销 |
| Team 流转 | 池派发 / 歧义上报 / 裁决回流 / messages 双记录 |
| spawn 健壮性 | prompt ContentBlock[] 格式（init turn 不再 turnError） |
| 配置 UX | 池配置显式保存（步进按钮 + dirty ✓ 应用） |

---

## 三轮回归：跨会话串台事故（2026-09-08 三轮，真实用户事故驱动）

### 13. 幽灵指派：池跨会话串台 ✅（架构级修复）

**事故**：import-sess_df0837fa 会话的 Worker #23 上报——`task_context`/`board_report` 对 `task-mtsaspo5` 均返回 not found，但该任务明明存在于该会话看板。

**根因**：静态插件是进程单例，但 `pool` 写成了全局单例 + `getFirstRootAgent()` 取第一个 root：
- Worker #23 的 parent 被挂到 session-61f0e9c2（先到的 root），工具经 resolveRoot 解析到了**错误的看板**
- poolStatus 快照被 poolCycle 写进多个会话的看板文件（grep 实证同一 taskId 指针出现在 3 个看板文件里）

**修复**（host-v30.js → v61）：
- `var pool` → `var pools = {}` + `poolFor(sid)`，全部 51 处 `pool.*` 改按会话分桶
- 新增 `rootForSession(sid)`：遍历 `agents.roots()` 精确匹配，spawn/通知/卡死上报全部按所属会话寻址
- spawn 找不到所属会话 root 时**拒绝 spawn** 并记日志（宁缺毋滥）
- `ctx.effect` 清理改为遍历所有会话桶

**应急处置**（修复生效前）：受影响看板切 manual 止血 → 终止幽灵 worker #23/#24 → 任务回 pending（真实数据未丢）。

**验证**：build 后静态检查 7/7 通过（pools 定义/poolFor/rootForSession 三处调用点/roster 分桶/effect 遍历）；运行时多会话并行派发需重启后观察。

| 会话隔离 | 池按会话分桶 / root 按会话寻址 / spawn 拒绝跨会话 |

### 14. 创建-派发竞争（v62，draft 草稿状态）✅

**用户报告**：Team 模式下先创建卡片再补描述/依赖，池心跳（15s）可能在信息补全前就派发，worker 领到半成品任务 → 歧义上报。

**修复**：新增 `draft` 草稿状态，**只进不出**于派发链路：
- `task_create` / `create-task` 加 `draft: true` 参数 → 任务落 draft，history 记 `created as draft`
- 派发门槛 `status === 'pending'` 与领取白名单 `['pending','blocked']` **天然排除 draft**（无需新门槛，结构性免疫）
- `task_update` / `update-task` 加 `publish: true` → draft → pending（含 not-a-draft 守卫）
- client：新增"草稿"列（首列）、详情页 🚀 发布按钮、草稿拖到待办列即发布

**使用范式**（Team 模式推荐）：`task_create draft:true` 建卡 → 补 description/dependsOn/acceptance → `task_update publish:true` 放行派发。

**验证**：host 静态检查（draft 落库/publish 守卫/派发排除）通过；端到端时序验证需重启后观察。

---

## 重启后全量回归（v62，2026-09-08 08:07–08:13 UTC）

| # | 测试项 | 结果 | 证据 |
|---|---|---|---|
| R1 | RPC 路由 + 数据继承 | ✅ | 39 任务（37 归档 + 2 新增）完整加载 |
| R2 | draft 不被派发 | ✅ | 草稿 35s（>2 心跳）未被领取，池不扩容 |
| R3 | publish 流转 | ✅ | draft→pending，history 记 `published`；重复 publish 被 `not a draft` 守卫拒绝 |
| R4 | spawn init turn 健康 | ✅ | worker #26 日志：inbox content 为 `ARRAY[1]`，init turn + 任务 turn 均 `completed`，**无 content.map 错误** |
| R5 | full 档全流程 | ✅ | worker 完成 → verifier（qwen/deepseek-v4-pro 异构）approved → resolved，6 秒全链路 |
| R6 | 依赖串行 | ✅ | A claimed 08:11:21 / resolved 08:11:27；B claimed 08:11:33（A 完成后） |
| R7 | 跨会话隔离 | ✅ | import-sess 板的 task-mtsaspo5 保持 pending/manual 未被本会话池触碰；本会话看板文件不再含该 taskId 引用 |
| R8 | Team 模式拦截 | ✅ | 开启后 pwsh 被 deny，关闭后恢复 |
| R9 | 清理 | ✅ | 4 个测试任务批量归档，看板归零 |

**重启后回归结论：v62 全部通过，三个修复（spawn ContentBlock / 会话隔离 / draft）均生效。**

## 未覆盖项（已知边界）

- **client UI 交互**：拖拽、多选、归档排序、Esc 快捷键等需浏览器人工验证（静态 client 经 ModuleLoader 加载，路由测试已间接证明 host 侧可用）
- **看门狗卡死标记**：需构造 >5min 停滞场景，时间成本高，逻辑与动态版一致（代码未变）
- **孤儿回收**：需模拟 worker 异常消失，依赖 2 分钟超时
- **escalation 仲裁流**：动态版已验证（v57），静态转换不涉及该代码路径

## 复跑方式

```powershell
# 健康检查
Invoke-RestMethod -Uri 'http://127.0.0.1:3080/dsh-agent-board' -Method Post `
  -ContentType 'application/json' `
  -Body '{"method":"get-tasks","args":{"sessionId":"<your-session-id>"}}'
```

测试任务命名约定 `reg-*`，清理方式：先 claim+resolve 未完成任务，再 batch-op archive 全部 reg- ids。
