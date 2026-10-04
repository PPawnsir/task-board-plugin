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
>
> - **归属**：看板文件按**会话**分文件，同时在文件里记 `ownerCwd`（创建该看板的会话工作区路径，取不到则省略该字段）——`~/.dsh/tasks-*.json` 每个文件是一块看板，`list-boards` 全局视图可看到本机所有板。
> - **重启继承**：DSH 重启后同一会话的根 id 可能漂移，此时新 id 没有对应文件——若同工作区（`ownerCwd` 严格相等）存在**唯一**「原主已不在 `agents.roots()`」的看板，则自动继承：文件重命名为新 id、文件内 `ownerSession` 改写为新 id、`console.error` 留一行 `[task-board] 继承看板 <旧sid> → <新sid>`；**多个候选一律不自动接管**（记一行日志后按空板处理，防误合并，旧板仍可在 `list-boards` 全局视图里看到）。
> - **写盘保护**：落盘走 临时文件+rename 原子写（EPERM/EBUSY 退避重试）；瞬时读失败/坏文件隔离后返回的空板**禁止回写**（防一个"读不到"的瞬间把看板覆成空板），坏文件隔离为 `.corrupt-<时间戳>` 留档不丢数据。

## 功能总览

### 看板 UI

- 会话标题栏「智能看板」按钮 → 顶部抽屉面板（看板 / 团队 / 仪表盘三视图）
- 面板右上角「＋ 新建任务」：表单弹层填标题/描述/优先级/管线/touches/依赖多选/验收脚本，Team 托管默认存为草稿（提交走 create-task RPC，成功即刷新、失败表单内联报错）
- 新建任务弹层为视口级 overlay（fixed 全屏遮罩 + 限高 80vh + 字段区内部滚动 + 按钮区吸底常驻，不再被看板抽屉裁切）；卡片「当前动作」行摘要化为「工具名 + 关键参数」（40 字符内有意义断点截断，悬停 title 看 host 原文），不再展示裸 JSON
- 六列状态流：草稿 → 待办 → 进行中 → 验证中 → 已完成 → 阻塞（空板也统一渲染六列骨架 + 引导 CTA：右上角「＋ 新建任务」或对话一句 task_create 建第一张卡）
- 读路径 error 防线：get-tasks 返回 {error} 或网络抖动时保留现有卡片与设置（不再静默清空全板），面板头部下方出非阻断红色错误条，下次刷新成功自动消失
- 耗时口径三分离：待办/草稿卡显「⏳ 等待 N」（创建→被领取），执行后显「⏱ 执行 N」（被领取→完成，tooltip 写清口径）——排队时间不再混进"耗时"
- 拖拽流转、多选批量操作（带一步撤销）、文本/优先级/标签筛选；卡片键盘可达（Tab 聚焦 + Enter/Space 开详情），详情页附「流转到」按钮组（状态迁移的键盘替代通道，失败内联回显）
- 归档区：时间倒序 + 排序选择器 + 纵向滚动
- Esc 逐级关闭（详情 → 看板 → 面板）
- 全部结构性图标为 Lucide 线性 SVG（`currentColor` 跟随主题，浅深色自适应）

### 仪表盘（Token 消耗）

- 仪表盘视图新增「Token 消耗」区：本看板累计总量 + 输入 / 输出 / 缓存读（缓存写非零时一并展示）拆分、按模型分布条形图、任务消耗 **Top 8**（标题可点击直达该任务详情）；进行中的卡片右上角显示本任务已累计消耗（`⛁ 数字`）
- 数据来源：每次 Worker/Verifier run 结算时读该 run 的 v4 会话日志（`~/.dsh/sessions/*/<runId>/session.v4.jsonl.zstd`），把 `assistant/message` 事件的 `usage`（`inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `totalTokens`，字段形状以真实日志为准）按 zstd 帧逐帧累加到任务 `usage`（含按模型小计与 `runs` 计数，多轮重跑/驳回重做自动累加），`get-tasks` 再现算 board 级 `usageSummary`（总量 / 按模型 / Top8，不落盘额外表）——**只做展示、不做计费断言**，日志读不到或没有 usage 时一律显示「暂无数据」
- 「架构健康」区（架构自省 L1）：`get-tasks` 顺带对**近 50 张卡**现算四信号（纯函数零存储：touches 声明热度 ≥8 次且占比 ≥40% / 带 touches 任务滞留中位数 >2 倍 / 任务**执行**时长 p90 >45min（claimedAt→resolvedAt 纯干活口径，不含排队）/ 同路径驳回 ≥2 次），命中才在仪表盘渲染提示条（⚠️/ℹ️ 两级，最多 3 条）——让运行数据主动提示"该优化架构了"（如某文件反复成为锁热点=该拆），信号只建议不裁判
- 统计区耗时同口径拆分：「平均排队 / 平均执行」双行展示（平均验收单列不变）
- 统计区新增「调研 ROI」对比行：resolved/archived 卡按有无调研注入分组现算卡数 / 平均执行时长 / 平均 token（双组总样本 ≥4 才渲染，无调研组明显更慢时数字 warn 色提示）

### 学习反馈（候选教训信号 → 主窗口沉淀）

- **信号源架构（零耦合）**：看板只产「候选教训**信号**」，不做**存储**——不调用任何笔记/记忆工具的 API、不写任何外部文件、也不知道教训最终被存到哪；用不用、存进哪个工具（如 `note_search` / `note_manage`）完全由主窗口 agent 自己决定
- **自动生成候选**（两处触发）：① Verifier 驳回 → 一条 `lesson-candidate` 消息（场景 / 错误做法 / 来源）；② 主窗口裁决 Worker 歧义 → 一条 `lesson-candidate` 消息（场景 / 疑问 / 裁决结论）。同一事件按「同时间戳 / 同内容前缀」轻量判重只落一条，且不写 `history` 流转记录（不刷屏）
- **详情页「沉淀」按钮**：把该条候选教训经 `push-lesson` RPC followup 给主窗口 agent（提示语写明「请用你可用的笔记/记忆工具沉淀，或评估后忽略」），推送成功后按钮变「✅ 已推送」置灰
- **软召回引导**：Worker prompt 与 Team 模式提示词都会加一句「开工前如环境装有笔记/记忆类工具（如 note_search），先检索相关历史教训再动手」（Team 档另外提醒把检索到的教训写进任务的 `contextNotes`）
- **开关 `feedbackEnabled`**（⚙️ 设置区「学习反馈」，默认**开**）：关掉后不生成候选、prompt 不提软召回、详情页候选卡片与「沉淀」按钮整个不渲染；老看板文件没有该字段 → 读路径自动补 `true`（与升级前行为一致）
- **两插件完全独立**：`dsh-agent-board` 与笔记类插件（如 `dsh-notes-plugin`）之间没有任何依赖、服务调用或文件直写——看板只发一条 followup 文本，怎么用由主窗口 agent 决定

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
- **里程碑进展通道**：Worker 每完成一个可验证的里程碑，可调用 `board_report`（`kind: "progress"`，`question` 写一行进展摘要 ≤200 字符）上报——进行中的卡片显示「📈 最近进展 · 相对时间」（覆盖式只留最新一条），详情页消息流保留全部 progress 条目
- **防表演式汇报**：进展契约只写在 Worker prompt 里、且要求「有实际产物/结论才报」（禁止定时汇报）；progress **静默不通知主窗口**（不进回执聚合），也不写 `history` 流转记录，避免刷屏
- **子任务**：父子层级 + 上下文继承 + 父任务自动流转 + 级联归档
  - 卡片识别层：父卡显示「📦 史诗 · resolved/total」徽章 + 3px 迷你进度条（有在跑子任务时附「▸ 在跑：标题」行）；子卡标题下显示「↳ 父任务标题」；依赖未满足的待办卡底部灰字「⛓ 等待「依赖标题」」（childStats 由 host 现算，缺字段一律不渲染）
  - 详情父子区块：父卡详情列子任务清单（状态色点 + 标题，点击直达子卡详情，标题行汇总 resolved/total）；子卡详情顶行「↳ 史诗：父标题」点击回跳父卡
- **删除通道（真删，无 undo）**：`delete-task` RPC（卡片 hover 垃圾桶按钮 / 详情页「删除」按钮，均先 `confirm('删除不可恢复，确认删除「标题」？')`）+ `batch-op op='delete'`（多选模式底部「批量删除」，同样 confirm）。状态门禁：**草稿/待办/阻塞可删**；进行中/验证中拒绝并提示先用 `terminate-agent` 终止（避免在跑的 run 变孤儿）；已完成/取消引导改用归档（`archive-task`，留档可检索）；有**未归档子任务**时拒删（防 `parentId` 悬空破坏父任务自动流转）；已归档任务幂等返回 ok。是真删（从 `tasks` 数组移除），因此**不产生 `batch-undo` 撤销快照**（批量条对 delete 不显示「↩️ 撤销」），删除操作在 host 端 `console.error` 留一行日志便于溯源
- **任务粒度建议**：单任务 **10~30 分钟**可独立完成为甜区；预计超过 30 分钟的大任务先建一张 **epic 父卡**（`pipeline: direct`，不进池派发），再挂若干 10~30 分钟的子任务（`task_create` 传 `parentId=父卡 id`，有先后顺序用 `dependsOn` 串联），子任务全部完成后父卡自动流转（`checkParentAuto`）——`task_create` 工具描述与 Team 模式提示词都写了这条契约
- **suggestSplit 软提示**：`task_create` / `create-task` 发现描述超 500 字符、或标题/描述命中「全量 / 整体 / 系统级 / 全面 / 重构 / 所有模块 / 整个」等史诗特征词时，返回体附带一行 `suggestSplit` 建议文案（**只提示，不阻断创建与派发**；未命中则不出现该字段，老调用方无感）

### 一次性派发（v74 去池化）

- 每个任务 spawn 一个**一次性子代理**（Worker/Verifier），上下文全量注入 prompt，做完即销毁——无常驻池、无池化状态残留
- **预研上下文注入（contextFiles/contextNotes）**：主窗口调研时读过的文件与笔记，由 host 在派发时读盘取最新内容，经「上下文注入」区块提供给 Worker/Verifier（不混进 user prompt）；预算口径单文件 8KB、总包 40KB；UI 侧调研门禁——full/work 且声明了 touches 却未附调研的卡片亮「⚠️ 无调研」徽章，详情页「调研注入」区列 files 清单 + notes 字数（无则明示）
  - **锚点行段**：`contextFiles` 支持 `path:L2350-L2420` / `path:L2350` 行段语法（只认尾部 `:L<行号>`，兼容 Windows 盘符），只注入该段（段长上限 400 行，超出截断并标注）；锚点无效（越界/写法错）自动回退头部注入并标注「锚点无效，已回退头部」
  - **截断结构索引**：头部注入被预算截断时，标注升级为「截断：共 N 行，已注入 1–M 行」，并附结构索引块（JS/TS 顶层函数/类/箭头赋值、Markdown 标题及行号，上限 40 条）——Worker 照索引用锚点语法补读目标段即可，不用全文盘点
- **派发调研门禁（warning 族，软提示不阻断）**：`task_create`/`create-task` 响应附 `warning` 字段——①描述为空「Worker 只能凭标题猜需求」②full/work + touches 非空而未附调研上下文 ③touches 含整树 glob 建议精确到文件级（可多条合并）；GUI 表单内黄色展示不关窗。epic 发布（publish）时自动轻量预检全部子任务注入情况，缺材料则 pushSysNote 汇总提醒主窗口（全有不打扰）；派发时读包失败落任务「最近失败」行，不再静默
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
> `board_report` 的 `kind` 三档：`complete`（交付完成）/ `escalate`（歧义上报等裁决）/ `progress`（里程碑进展，静默可见、不通知）。

## 仓库结构

```
└── packages/dsh-agent-board/     # 插件全部源码
│   ├── index.mjs                 #   host 端薄壳（~70 行）：cordis 契约 + 共享 state 构建 + 模块接线
│   ├── lib/core.mjs              #   纯逻辑核心：状态机/依赖/分类/prompt/解析（无 IO，可单测）
│   ├── lib/*.mjs                 #   host 端领域模块（按任务边界拆分，见下节）
│   ├── lib/client/               #   client 端模块源（按用户感知域拆分，见下节）
│   ├── lib/client.js             #   client 端产物（⚠️ GENERATED：scripts/build-client.cjs 拼装，勿直接编辑）
│   ├── scripts/build-client.cjs  #   零依赖组装器（模块源 → 产物；--check 校验产物新鲜度）
│   ├── test/core.test.mjs        #   单元测试（node --test，84 例）
│   ├── package.json              #   dsh.bundle.patch + dsh.client 元数据
│   └── cordis.patch.yml          #   bundle 挂载行
└── docs/
    ├── PRD.md                    # 产品需求文档
    ├── PACKAGING.md              # 打包/安装踩坑记录（link 依赖、单例隔离等）
    ├── icon-style-guide.md       # 图标风格指南（Lucide 线性 SVG + emoji 分界）
    └── REGRESSION-v59.md         # 端到端回归测试记录
```

### host 模块边界（lib/*.mjs）

v1.6.0 起 host 端从单体 index.mjs（1487 行）拆为薄壳 + 7 个领域模块，
共享闭包状态收进显式 `state` 对象逐模块注入——模块边界即任务边界，并行任务不再全员互锁：

| 模块 | 域 | 内容 |
|---|---|---|
| `policy.mjs` | 策略层 | 粒度治理软闸门 + 学习飞轮候选教训（纯函数零状态） |
| `usage.mjs` | 统计 | v4 会话日志定位 / zstd 分帧 / token usage 聚合（纯函数） |
| `session.mjs` | 会话 | root 解析缓存 / 会话 id 归一 / workMode 派生 / runsFor |
| `store.mjs` | 持久化 | boardPath / rt / wt 原子落盘 / 跨重启继承 / fileLocks 串行化 / mutateLocked |
| `notify.mjs` | 通知 | makeMsg / 歧义 25s 去抖 / 回执聚合 + 空闲门控 / 投递前过滤 |
| `dispatch.mjs` | 派发引擎 | poolCycle / spawnOneShot / settleRun / 两级超时 / 孤儿回收 |
| `rpc.mjs` | 接口层 | RPC 路由 + 13 个 Agent 工具注册 |

（store→dispatch 的循环依赖由 `deps.poolCycle` 晚绑定解开；index.mjs 对外 re-export 契约不变。）

### 前端模块边界（lib/client/）

dsh web 的 client 运行时不具备模块解析能力（entry 被整体读成字符串经 `new Function` 求值，
相对 import 是语法错误），所以前端模块化走**构建时拼装**：模块源在 `lib/client/`，
`npm run build-client`（pretest/prepublishOnly 已挂链）拼装成单文件产物 `lib/client.js`。
四个模块按**用户感知域**划分——边界即未来任务边界，新功能先想清楚落在哪个域：

| 模块 | 域 | 内容 |
|---|---|---|
| `kernel.js` | 底座（用户不可感知） | 渲染原语（ic/icText/ActorLink）、RPC 封装与轮询族、共享状态（state/listeners/notify）、图标（ICONS）、共享任务工具，以及面板骨架入口（BoardButton/ViewTab/TopPanel/slots.inject） |
| `board-list.js` | 看板列表 | 看板列与卡片（Card）、筛选条、多选批量操作条、建卡表单、归档列表 |
| `task-detail.js` | 任务详情 | 详情抽屉（编辑/流转/冻结/touches/历史会话/高优介入）、歧义裁决对话与候选教训沉淀、依赖区块 |
| `dashboard.js` | 仪表盘与设置 | 统计图表、Token 消耗、全局总览、报告生成、团队池视图、池/模型/超时设置与工作模式开关 |

四个模块拼进同一个 `apply(ctx)` 函数作用域（`var`/`function` 声明提升使跨模块引用与拼接顺序无关；
所有同步执行代码——DOM 监听、轮询注册、布局同步、slots.inject——都在 kernel 域内保持原相对顺序）。
改模块源后必须重新组装（`npm run build-client`）产物才更新；直接编辑 `lib/client.js` 会在下次拼装时被覆盖。

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
- 日常 push / PR 有 `test.yml` 跑语法检查 + 60 例单测
- 本地手动发布仍然可用：`npm publish --registry=https://registry.npmjs.org`（本机默认源是镜像时必须显式指定）

## License

MIT
