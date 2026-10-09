# Task Board Plugin for DeepSeek Harness

[![npm](https://img.shields.io/npm/v/dsh-agent-board)](https://www.npmjs.com/package/dsh-agent-board)
[![npm downloads](https://img.shields.io/npm/dw/dsh-agent-board.svg)](https://www.npmjs.com/package/dsh-agent-board)
[![node](https://img.shields.io/node/v/dsh-agent-board.svg)](https://www.npmjs.com/package/dsh-agent-board)
[![license](https://img.shields.io/npm/l/dsh-agent-board)](https://github.com/PPawnsir/task-board-plugin/blob/main/LICENSE)
![category](https://img.shields.io/badge/awesome--dsh--plugin-workflow-blue)

智能看板插件 — agent 团队的持久台账与治理层：把「派发 → 执行 → 验收 → 度量 → 复盘」跑成全链路闭环，每一张卡都是可审计、可度量的长期资产。

## 定位

**dsh-agent-board 是 agent 团队的持久台账与治理层——看板只是界面，内核是「派发 → 执行 → 验收 → 度量 → 复盘」的全链路闭环。** 它与「一次性组队、跑完即散」的冲锋型编排器、「人建卡、agent 认领、人逐张验收」的手工看板不是一个代际：

- **持久台账**：任务卡是长期资产。完成 / 驳回 / 歧义裁决 / 验收结论 / Token 消耗 / 自测指南，每一笔都落账留痕，看板文件即审计底稿；卸载不删数据，重启自动继承。
- **池化 Worker + 独立 Verifier**：执行与验收分离——Worker 负责动手（可续跑，续跑只认新增产出），Verifier 独立复跑验收脚本、以实证为准，不听 Worker 的一面之词。
- **独立验收**：`acceptance` 硬性脚本命令由 Worker 实跑、Verifier 独立复跑；结论分通过 / 驳回并逐条给证据。人只看该看的——风险队列「待你过目」把该亲自确认的卡推到眼前，其余交给机器闭环。
- **可运维度量栈**：记分卡（模型表现 / 质量趋势 / 驳回聚类）、运行时健康自检、异常驱动审视（风险队列 / 质量异动告警 / 批次摘要）三层，让成本与质量从「感觉」变成「数字」。

> **流水线归机器，审计台归人。** 我们不造「跑完就散」的冲锋队，也不做「人逐张盯着验收」的手工看板；我们的信念只有三条：**验收独立复跑、人只看该看的、数据沉淀成资产**。别人负责冲锋，agent-board 负责记账与验收——互补，不对抗。

### 适合谁 / 什么时候用

- **长期多任务并行**：一个会话里几十张卡、有依赖有先后、还不断追加新需求——需要一份不随会话结束而消失的台账，而不是每次重开都从零描述。
- **关心成本与质量趋势**：想看清哪个模型在什么场景更省、驳回率在涨还是跌、哪些文件反复成为锁热点——需要记分卡与趋势，而不是拍脑袋。
- **不想逐张审卡**：接受「独立复跑 + 风险队列兜底」的治理方式——机器把「该我亲自看」的卡筛出来，其余信任验收闭环。
- **缺一层治理而非缺一个编排器**：已有冲锋型的团队 / 编排工具，缺的正是「记账、验收、度量、复盘」这一层——agent-board 补上它。

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

## 数据安全

看板数据（`~/.dsh/tasks-<sessionId>.json`）是本插件唯一的持久化状态，按三层防线保证数据不丢、事故可见：

- **原子写盘（防撕裂写）**：落盘一律「写临时文件 → `fsync` → `rename` 覆盖目标」——`rename` 在同分区是原子的，进程在写盘中途被强杀时磁盘上最多残留一个 `.tmp` 残件，看板本体永远不会是截断的半个 JSON。Windows 上 `rename` 覆盖已存在目标原生支持（实测直接覆盖成功），仅当目标被并发读句柄/Defender/索引器瞬时占用（`EPERM`/`EBUSY`/`EACCES`/`ENOTEMPTY`）时做有限退避重试；重试耗尽仍失败则降级「先 `unlink` 目标再 `rename`」并留日志——绝不丢整板。
- **腐坏隔离可见化（不再静默）**：加载时若 JSON 解析失败（撕裂写/重启打断导致文件中部夹杂另一版本残片），坏文件改名 `.corrupt-<时间戳>` 留档隔离（防反复 poison），同时在「架构健康」区亮一条 **err 级红条**（`healthHints`）提示「看板数据文件腐坏已隔离，历史在 `.corrupt-<ts>`，可联系恢复」，并向 owner 会话推送通知——数据不丢，也不再静默从空板重启。
- **自动 salvage（截断抢救）**：隔离前先尝试抢救——从首字节起截到第一个完整 JSON 值（`JSON.parse` 报错 `position` 截断法，与人工恢复同款手法），成功则以抢救出的完整板为底自动写回继续（`healthHints` 红条记「已抢救保留 N 张卡，丢弃撕裂残片」），失败才回退空板。两种情况下原始文件都留档 `.corrupt-<ts>`，可随时人工恢复。

## 功能总览

**核心能力一页速览**（`★` 为 v1.7.5–1.7.7 新栈）：

- **看板**：六列状态流、拖拽 / 多选批量 / 文本·优先级·标签筛选、归档留档、会话隔离
- **派发**：一次性 Worker / 独立 Verifier、依赖调度（DFS 环检测）、touches 文件级排他、可续跑 Worker、Team 托管
- **验收治理** `★`：硬性验收脚本独立复跑、驳回全量带回重派、Verifier 自测指南（userTest）、风险队列「待你过目」、验收时序防护（Verifier 在场时主窗口抢批需显式 `force:true`；有活跃 run 的卡禁止归档；Verifier 迟到结论落 `lateVerdict` 留痕+迟到驳回直投告警，不再静默吞掉）
- **度量** `★`：Token 消耗（总量 / 有效 / 缓存读，按模型·按任务·按日）+ 记分卡（模型表现 / 质量趋势 / 驳回聚类）
- **可运维性** `★`：运行时健康自检（派发冻结 / 结算停滞告警）、异常驱动审视（风险队列 / 质量异动告警 / 批次摘要）、起草 lint、数据安全（原子写盘 / 腐坏隔离 / 自动 salvage）
- **学习反馈**：候选教训信号 → 主窗口沉淀（零耦合，不碰任何笔记 / 记忆工具 API）

以下各节是完整规格。

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

- 仪表盘视图新增「Token 消耗」区：本看板累计**有效 / 缓存读 / 合计**三分量 + 输入 / 输出（缓存写非零时一并展示）拆分、按模型分布条形图、任务消耗 **Top 8**（标题可点击直达该任务详情，title 附「有效 N / 缓存读 M」拆分）；大数字为**今日总量**（含缓存读，本地日口径，无日账则显示 0，旁附「其中有效 X」小字对照，有效消耗详见悬浮 title）、旁附「累计（本看板）」三分量小字，下方「近 7 天」迷你条形按日展示近 7 天**总量**（今天高亮，title 补有效对照，7 天全为 0 时不渲染）；进行中的卡片右上角显示本任务已累计消耗（`⛁ 数字`）；区底固定口径 caption：累计 / Top 8 仅看板派发的 run 消耗，主窗口行并列不混入
- 口径要点：**有效消耗 = 输入 + 输出 + 缓存写（不含缓存读）**；总量 = 有效 + 缓存读。**主显口径翻转（`task-muxnqunk`，用户 2026-10-07 裁决「算总的吧」，推翻 `task-muwq9u04` 的有效主显）**：Token 区**主数字均为总量口径（含缓存读）**——今日大数字 / 近 7 天柱 / 按模型分布 / Top 8 / 主窗口行一律显总量，有效消耗退居悬浮 title 或次要小字；旧口径日（`e=null`）的「今日显 — / 矮灰柱」防护顺势退役（总量恒有值，正常画柱，悬浮注明有效不可知）。**不动的**：「模型表现」「质量趋势」区保持有效口径（效率指标语义），报告导出分列口径不动。实证背景：本板累计 10.3M 里缓存读占 9.7M（94%）——总量与有效的差额一眼可在累计三分量与悬浮里对照
- **主数字口径统一**（`task-muxnqunk` 翻转版，替代 `task-muwq9u04`）：**按模型分布行与任务消耗 Top 8 行的主数字一律为总量**（含缓存读；模型取 host 的 `byModel`，任务取 `topTasks[].total`），有效消耗（`byModelEff` 模型有效分摊 / `topTasks[].effective`）进悬浮 title——与「今日」「近 7 天」同口径；老 host 缺 `byModelEff` 或老卡无五分量留账时 title 标「有效不可知」（口径不伪造）
- **统计范围接通 Token 区**（`task-muwc7hjd`）：仪表盘顶部的「统计范围」（快捷：今天 / 近 7 天 / 近 30 天 / 全部 + 自定义起止）现在同时作用于 Token 区的**按模型分布 / 任务消耗 Top 8 / 累计三分量**——范围变化即用新范围重拉 `get-tasks`，由 host 按每个 run 的本地日落点（`t.runs[i].at` → `YYYY-MM-DD`，两端闭区间）过滤：范围外 run 不计入 total/byModel/top，`byDay` 同步裁到范围内；范围激活时 Token 区标题带「范围内: …」标记。**今日大数字与「近 7 天」柱子是自身固定口径，不随范围变化**（区底第二行 caption 与范围筛选浮层均写明）。无范围（两端皆空）时聚合结果与旧版逐字一致（parity）；无 run 级留账（老卡 / runs 条目未落 usage）退化为按 `updatedAt` 本地日判定，无 `at` 的老 run 只在无范围时计入（宁可漏不错），run 未记模型名时按入选 run 占比摊任务级模型小计（合计与有效同法摊派，ΣbyModel 与入选总量、ΣbyModelEff 与入选有效各自对齐）。**数据源口径修正（`task-muwq9u04`）**：run 记录数组在**任务级 `t.runs[]`**（`t.usage.runs` 只是结算次数计数）——此前误把计数当数组读，范围过滤静默退化成 `updatedAt` 单日近似、Top 8 与无范围逐字相同；现已逐 run 精确裁切，且范围切换后客户端按 `usageSummary` 的 JSON 串比对补一次 notify（选范围即渲染，不等下一次任意刷新）。**Token 口径三连修（`task-muwsnyqv`）**：① 范围内 `byDay` 按入选 run 的本地日落点逐日重建（`to` 端闭区间，`from=to=今天` 时今天不丢——修「范围含今天时 total 含今天、byDay 却吞今天」）；② `usageSummary` 同时返回**未过滤全量 `byDayFull`** 与范围内 `byDay`，「今日」「近 7 天」改读 `byDayFull` 兑现固定口径承诺（老 host 缺字段退化读 `byDay`）；③ ~~旧口径日灰柱防护~~ **已随口径翻转退役**（`task-muxnqunk`）：总量主显后 `e=null` 的旧口径日就是正常柱（`t` 恒有值，柱高按总量归一），不再画矮灰柱 / 今日显「—」，有效不可知只在悬浮 title 注明
- 数据来源：每次 Worker/Verifier run 结算时读该 run 的 v4 会话日志（`~/.dsh/sessions/*/<runId>/session.v4.jsonl.zstd`），把 `assistant/message` 事件的 `usage`（`inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `totalTokens`，字段形状以真实日志为准）按 zstd 帧逐帧累加到任务 `usage`（含按模型小计、`runs` 计数与 `byDay` 日账——本地日 `YYYY-MM-DD`，一次 run 整笔记在结算日；多轮重跑/驳回重做自动累加）；**run 级留账**：本次用量同时原样写回 `t.runs` 对应条目的 `usage`（五分量俱全），因此按天 / 按模型 / 按阶段任何维度都能从 runs 精确重建，口径若要再调整不必回头猜
- `byDay` 为**双指标**形态 `{ t, e }`（`t` = 总量含缓存读，`e` = 有效消耗不含缓存读；一次 run 不跨日拆分）。聚合端兼容老数据：值是裸 number 的历史日账按 `{ t: n, e: null }` 处理——总量照常保留（「近 7 天」不会整段消失），有效值不可知就置 `null`；**口径翻转后（`task-muxnqunk`）旧口径日按总量正常展示**（今日大数字显总量、近 7 天按总量画柱），有效不可知只在悬浮 title 注明——`task-muwsnyqv` 的「显 — / 矮灰柱」防护已随总量主显退役
- `get-tasks` 再现算 board 级 `usageSummary`（总量 / 有效合计 / 按模型（合计 `byModel` + 有效分摊 `byModelEff`，两者同源累加）/ Top8（带有效与缓存读拆分）/ 日账双份（范围内 `byDay` + 未过滤全量 `byDayFull`，后者供「今日」「近 7 天」固定口径读取），不落盘额外表；老任务无 `byDay` 时整笔近似归到 `updatedAt` 的本地日，无 `updatedAt` 则不计入任何日）——**只做展示、不做计费断言**，日志读不到或没有 usage 时一律显示「暂无数据」；第二参 `range`（可选 `{ from, to }` 本地日）给定即只聚合该范围内的 run（口径见上条）
- **主窗口（本会话对话）消耗单列**（`task-muwsol23`）：累计行下方新增一行「**主窗口（本会话）：今日 X · 累计 Y**」（**总量口径含缓存读**——`task-muxnqunk` 翻转后缓存读不再单列、已含在 total 里，有效值见悬浮 title），按模型分布尾部追加一条「**主窗口（对话）**」（琥珀色与 run 模型区分，总量为 0 不渲染，固定尾部不参与排序）；数据源是该看板所属主会话自己的 v4 日志，host 侧**增量尾读**聚合（缓存键=会话 id：文件不变零读、变大只读新增字节段、变小/轮换全量重读一次，尾部半帧不结算下轮补读——3s 轮询稳态零全量重读），五分量与有效口径（e=输入+输出+缓存写）同 Worker 完全一致；**隔离红线：不进 Top 8、不进「本看板累计」、不进架构健康/学习飞轮基数**，只并列展示；随统计范围裁剪（按 `assistant/message` 事件的本地日落点）；日志不存在/读取失败/无 usage 一律**静默降级**（不渲染该行，不炸轮询）
- 统计口径边界：本区累计 / Top 8 / 架构健康与学习飞轮基数只统计**看板派发的 Worker/Verifier run**，**不含主窗口对话**；主窗口对话消耗按上条单列一行 + 模型分布尾部一条并列展示（不越界混入，UI caption 已明示）
- **「模型表现」区**（记分卡卡3，`task-muxhtgi2`）：Token 区下方新增**模型 × 场景七指标对比表**——每行一个 模型 × 角色（worker/verifier）× 规模段（小 <1M / 中 1~10M / 大 >10M，按任务有效 token 分桶）桶；七列口径一句话版：**有效均值** = 桶内 run 有效消耗（输入+输出+缓存写，不含缓存读）的均值、**耗时中位** = run 耗时（endedAt−at）中位数（P90 在行 title）、**驳回率** = 归因到本桶的验收驳回 / 桶内 runs、**一次通过率** = 桶内 resolved 任务中零驳回占比、**超时率** = 超时落定 run / 桶内 runs、**续跑率** = resume 续跑记录 / 桶内 runs、**缓存命中率** = cacheRead/(input+cacheRead)（⚠️ 跨 provider 对比先核 input 是否含缓存读）；表头列名均带 title 口径说明；表头下两个**本地筛选器**（角色 全部/worker/verifier + 规模段 全部/小/中/大）只在已返回的 scoreboard 上过滤、**不重拉**；桶内 runs<5 整行**灰显** + title「样本 <5，仅供参考」（不参与任何「最优」强调）；无数据显「暂无足够 run 数据」；Token 区 caption 新增「**→ 模型表现**」锚链接一键滚动到位。数据源 = `get-tasks` 响应里的 `usageSummary.scoreboard`（卡2 host 聚合底座 `buildScoreboard`，与 Token 区同一统计范围口径裁剪）
- **「质量趋势」区**（记分卡卡4，`task-muxhtgil`）：模型表现区下方新增全局趋势四块（P1 质量 KPI 并入）——**一次通过率**（近 14 天柱形：当日落定 resolved 任务中零驳回占比，今日柱高亮 + 块头标今日值，无落定日画灰基线不假装 0%）、**卡时长分布**（四桶横条 <10m / 10-30m / 30-60m / >60m，创建→落定墙钟含排队/验收全程）、**超时率走势**（近 14 天迷你柱行：当日超时落定 run / 当日 runs）、**续跑成功率**（resume 续跑记录中 completed 占比，范围总量口径、host 出参无逐日故不伪造 byDay）；全部读 `usageSummary.scoreboard.trends`（卡2 已按统计范围裁剪，client 只渲染不重拉），范围激活时区头带「范围内: …」徽章；近 14 天为固定窗口（范围落在窗口外时对应日柱为空，caption 写明）；整区/单块空态均灰显不炸
- **「驳回聚类」区**（记分卡卡5，`task-muxhu1zv`）：质量趋势区下方新增**驳回原因 Top3**——host 对验收驳回文本做规则法关键词聚类（不上 embedding：驳回文本结构模板化；首命中归类，占比分母=驳回总数，未匹配进「其他」兜底桶；按驳回消息自身本地日落点随统计范围裁剪），每行 TopN 类目 + 占比 + 代表原文（行 title 悬浮，各截 80 字）+ **「建议沉淀为约定」结构化文本**（形如「驳回 Top1『验收脚本未实跑』占 42%——建议在派发约定/Worker prompt 补一条：…」，一键复制按钮，沉淀动作人工）；挂 `usageSummary.scoreboard.rejectionClusters`，老 host 缺字段整块不渲染，无驳回显空态。同一通道的**「按表现荐模型」hint**（卡5③）：某模型在中小卡 worker 桶合并后 runs≥10 且一次通过率≥90% 且有效均值较其他每个合格模型严格低 >30% → 「架构健康」区亮黄条「模型 X 在中小卡表现最优（通过率 92% · 有效均值 0.8M，较其他合格模型低 35%），建议设为默认 workerModel」；无足够数据/无对比对象不亮
- 「架构健康」区（架构自省 L1）：`get-tasks` 顺带对**近 50 张卡**现算四信号（纯函数零存储：touches 声明热度 ≥8 次且占比 ≥40% / 带 touches 任务滞留中位数 >2 倍 / 任务**执行**时长 p90 >45min（claimedAt→resolvedAt 纯干活口径，不含排队）/ 同路径驳回 ≥2 次），命中才在仪表盘渲染提示条（⚠️/ℹ️ 两级，最多 3 条）——让运行数据主动提示"该优化架构了"（如某文件反复成为锁热点=该拆），信号只建议不裁判；**运行时健康自检**（`task-muxhrkbg`）复用同一 hint 通道——host 侧在 poolCycle 成功轮 / settle 结算 / 幽灵回收三处记内存心跳（`state.poolHealth`，不落盘）：有可派卡+有空位却 >5min 无成功派发轮 → 亮「🔴 派发循环疑似冻结」，有在跑卡却 >30min 无任何结算 → 黄级「结算通道长时间无活动」，幽灵表项回收 >0 时留一条一次性 info 记录（90s 保鲜、读到即灭）——运行事故不再只靠 e2e 翻车与肉眼发现；**质量异动告警**（异常驱动审视②）：`usageSummary.scoreboard.trends` 环比——近 7 天一次通过率较再前 7 天跌 >10 个百分点（两侧样本各 ≥5 防小样本误报）→ 黄条「质量异动：一次通过率本周 X%（上周 Y%），建议抽查近期验收」，超时率 / 驳回率突变各加一条同构规则（阈值常量置顶，恰好 10pp 不亮、10.1pp 亮）
- 报告导出新增「## 批次摘要（近 24 小时）」段（异常驱动审视③）：`buildReport` 顶部一页纸——完成 N 张 / 驳回 M 次 / Token 总量（约 X，附有效 Y）/ 异常事件计数（超时 + 幽灵回收，读现有字段与 healthHints）/ 一句话质量趋势；纯聚合现有字段、不新建状态，无数据时优雅空态（一句话「近 24 小时无活动记录」）
- **风险队列「待你过目」+ 审视摘要区**（异常驱动审视①，`task-muzikj1y`）：`get-tasks` 对每张卡现算 `reviewHint={score,reasons[]}`（纯函数 `core.computeReviewHints`，现算零落库）——四条硬信号恒计入：**被驳回过**（`rejectCount>0` 或 `verification.verdict=rejected` 或 messages 有 rejection 包）/ **上报过歧义**（messages 有 arbitration 裁决包）/ **touches 碰核心文件**（dispatch.mjs|rpc.mjs|core.mjs）/ **full 无 acceptance**；两条软信号仅质量异动告警激活期间计入（联动加严）：**diff>300 行**（`deliverable.diff` 的 git diff --stat 解析）/ **续跑≥2 次**（`runs` 中 `resume:true` 计数）。已完成/归档的命中卡带「👁 建议过目」徽章（悬浮全部理由行），FilterBar 加 chip「待你过目」一键只看未阅命中卡；打开详情页即幂等落 `reviewedAt`（唯一新落库字段，`mark-reviewed` RPC 只写一次），已阅卡徽章消失、chip 不计；详情顶部新增「审视摘要区」（仅命中时显示）四问动线——①为什么在这（理由行）/ ②改了什么（`deliverable.summary`+diffStat，标「Worker 汇报」来源徽标）/ ③机器怎么验的（`verification` 结论+验收脚本+驳回/仲裁史，标「Verifier 实证」/「系统记录」徽标）/ ④怎么亲自确认（复用 `verification.userTest` 自测指南，缺省显示 tier=internal 提示）；报告「批次摘要」段加一行「未过目 N 张」
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
- **git 纪律红线**：Worker prompt 写死禁止还原命令（`git checkout` / `git restore` / `git reset --hard` / `git clean` 等——会冲掉并行 Worker 与你自己的未提交在途编辑）；只改自己写的文件、别人改了别的文件与你无关，确实需要干净基线时走歧义上报（`board_report` kind=escalate）由主窗口裁决
- **文件级排他**：`touches` 声明本任务要改的文件/glob（如 `["src/**", "README.md"]`）；持有文件锁的任务（`in-progress`/`verifying`）与候选 touches 重叠就跳过本轮（卡片显示 `🔒 等文件释放`，详情页列出在等谁），**锁随工作态**：状态流转到已完成（`resolved`）即放锁，`cancelled`/归档同样不再持锁（归档回归纯收纳动作、不再是释放点）——锁只护「正在写」的阶段，「验收后-提交前」的窗口期由主窗口「回执到即提交」纪律 + 史诗 post-hook 承接，不用长持锁把整批串行化。避免并行 Worker 改同一批文件互踩；手动「派发」遇到冲突会列出冲突任务，确认后才以 `force` 越权派发
- **里程碑进展通道**：Worker 每完成一个可验证的里程碑，可调用 `board_report`（`kind: "progress"`，`question` 写一行进展摘要 ≤200 字符）上报——进行中的卡片显示「📈 最近进展 · 相对时间」（覆盖式只留最新一条），详情页消息流保留全部 progress 条目
- **防表演式汇报**：进展契约只写在 Worker prompt 里、且要求「有实际产物/结论才报」（禁止定时汇报）；progress **静默不通知主窗口**（不进回执聚合），也不写 `history` 流转记录，避免刷屏
- **子任务**：父子层级 + 上下文继承 + 父任务自动流转 + 级联归档（僵尸态出清：`archive-task` 对「无活跃 run 的 in-progress」——典型如被 parentKick 推进后子任务已全部归档的史诗——直接放行，有活跃 run 的仍拒）；**归档子任务仍计入史诗进度并在详情留档可见**——进度分子口径 `settled = resolved | cancelled | archived`、分母也含归档，归档一张子卡不会再让史诗进度从 `0/10` 退化成 `0/9`（进度只增不减），全归档的父卡也照常显示徽章；详情子任务清单不排归档行（灰化 + 行尾「已归档」徽章 + 沉底排序，点击仍可进子卡看留档）
- **死会话零打扰**：15s 派发心跳对无活 root 的会话板直接跳过（不读盘/不写盘/零日志，会话重开后自动恢复派发）；`create-task` 拒绝不完整 sessionId（防裸短 id 建出幻影板）
- **面板轮询渲染短路**：`get-tasks` 响应附 `tasksHash`，任务列表无变化时前端跳过重渲染（usage/池状态等轻量字段照常刷新）
- **看板抽屉稳定性（isRoot 持久语义 + 蝶变防抖）**：`isRoot` 判定改读**持久 parentSession**（根会话=无父）——休眠根会话（有板有卡但无活 agent）也算 root，入口不再分钟级消失；子代理会话（parentSession 指向父）恒不显示入口。客户端防抖仍保留兜底：已确认 root 的会话需**连续 3 次（≈9s）false** 才收起抽屉（会话生命周期内「曾确认 true」粘滞），看板不再在生成状态切换时突然消失；从未确认 root 的子代理会话仍即时隐藏入口，保护语义不变
  - 卡片识别层：父卡显示「📦 史诗 · settled/total」徽章 + 3px 迷你进度条（`settled = resolved | cancelled | archived`，total 同口径含归档；有在跑子任务时附「▸ 在跑：标题」行）；子卡标题下显示「↳ 父任务标题」；依赖未满足的待办卡底部灰字「⛓ 等待「依赖标题」」（childStats 由 host 现算，缺字段一律不渲染）
  - 详情父子区块：父卡详情列子任务清单（状态色点 + 标题，**含已归档留档**——归档行灰化 + 行尾「已归档」徽章并沉底，点击直达子卡详情，标题行汇总 settled/total）；子卡详情顶行「↳ 史诗：父标题」点击回跳父卡
- **可选 hooks（史诗可选点位：前置/后置各是一次真实 agent 运行）**：`epic.hooks = { pre: { enabled, prompt, state, runId }, post: 同构 }`——**前置**让子任务具备开跑条件（串行闸门：未完成前该史诗的子任务一张都不派），**后置**把这批活收口（全部子任务了结后跑一遍，完成后史诗才转验证中）；prompt 只给薄框架契约，具体动作由 hook agent **自行决策**，**吃不准就走歧义上报**（失败即转阻塞等人裁决：重试/跳过/放弃，不自动重跑）。hook run 记在 `epic.runs[]`（role `hook-pre`/`hook-post`），卡片带相位徽章（`⏳ 前置准备中` / `🧪 收尾中` / `⚠️ hook 失败待裁决`，无 hooks 的老卡零渲染），详情页 hooks 区可编辑 enabled+prompt、查看 state/耗时并跳转 run 会话、失败一键跳裁决区；**hooks 仅主窗口可设**（工具与 RPC 双通道门禁），commit/push 不入任何默认形态
- **删除通道（真删，无 undo）**：`delete-task` RPC（卡片 hover 垃圾桶按钮 / 详情页「删除」按钮，均先 `confirm('删除不可恢复，确认删除「标题」？')`）+ `batch-op op='delete'`（多选模式底部「批量删除」，同样 confirm）。状态门禁：**草稿/待办/阻塞可删**；进行中/验证中拒绝并提示先用 `terminate-agent` 终止（避免在跑的 run 变孤儿）；已完成/取消引导改用归档（`archive-task`，留档可检索）；有**未归档子任务**时拒删（防 `parentId` 悬空破坏父任务自动流转）；已归档任务幂等返回 ok。是真删（从 `tasks` 数组移除），因此**不产生 `batch-undo` 撤销快照**（批量条对 delete 不显示「↩️ 撤销」），删除操作在 host 端 `console.error` 留一行日志便于溯源
- **任务粒度建议**：单任务 **10~30 分钟**可独立完成为甜区；预计超过 30 分钟的大任务先建一张 **epic 父卡**（`pipeline: direct`，不进池派发），再挂若干 10~30 分钟的子任务（`task_create` 传 `parentId=父卡 id`，有先后顺序用 `dependsOn` 串联），子任务全部完成后父卡自动流转（`checkParentAuto`）——`task_create` 工具描述与 Team 模式提示词都写了这条契约
- **suggestSplit 软提示**：`task_create` / `create-task` 发现描述超 500 字符、或标题/描述命中「全量 / 整体 / 系统级 / 全面 / 重构 / 所有模块 / 整个」等史诗特征词时，返回体附带一行 `suggestSplit` 建议文案（**只提示，不阻断创建与派发**；未命中则不出现该字段，老调用方无感）
- **开关 `epicSplit`（史诗拆分总开关）**（⚙️ 入池配置弹层「**功能**」小节，默认**开**）：关掉只停**引导**——Team 提示词第 6 条拆分条款整条不注入、`create-task`/`task_create` 响应不再附 `suggestSplit` 软提示；**机制不禁**（显式传 `parentId` 建子卡、史诗自动收口与 hooks 状态机照常工作，明确要拆时不受阻）；老看板文件没有该字段 → 读路径自动补 `true`（与升级前行为一致）。工具描述里的粒度契约是静态工具定义（随 request header 快照），不在开关范围

### 一次性派发（v74 去池化）

- 每个任务 spawn 一个**一次性子代理**（Worker/Verifier），上下文全量注入 prompt，做完即销毁——无常驻池、无池化状态残留（Worker 的可续跑形态见上一节「可续跑 Worker」，Verifier 与 hook run 恒为一次性）
- **预研上下文注入（contextFiles/contextNotes，瘦身分离形态）**：主窗口调研时读过的文件与笔记随子代理的**首条 prompt 一次性注入**——调研笔记全文（notes，≤8000 字符）+ **文件清单**（每行「`路径:L起-L止` — 一句用途」）；**文件内容本体不进 prompt**，由子代理用 `read` 工具按行号范围按需自取（执行时盘面更新鲜；旧形态「host 读盘取正文注入」既受单文件 8KB/总包 40KB 截断，又随 runtime 快照每轮刷新重发——自治 run 实测 6×48.8K 字符≈白烧 75–100K token）；UI 侧调研门禁——full/work 且声明了 touches 却未附调研的卡片亮「⚠️ 无调研」徽章，详情页「调研注入」区列 files 清单 + notes 字数（无则明示）
  - **锚点行段与用途**：`contextFiles` 条目写法「`path:L2350-L2420` / `path:L2350`」+ 可选「` — 一句用途`」（em dash 两侧空格分隔；缺省只给路径行号）——锚点只认尾部 `:L<行号>`（兼容 Windows 盘符），清单里原样带上行号供子代理直接按行段 read；锚点写错（`:L0` / `:L5-L2`）自动剥掉，不误导子代理去读空段
  - **按需自取代替 host 预切段**：派发侧零读盘（不再切行段、不再附结构索引块）——子代理自己 `read(path, offset, limit)` 取需要的那段，清单里给出的行号就是起点；`task_preview_context` / `preview-context` 返回的也是这份瘦身清单（不是文件正文）
- **派发调研门禁（warning 族，软提示不阻断）**：`task_create`/`create-task` 响应附 `warning` 字段——①描述为空「Worker 只能凭标题猜需求」②full/work + touches 非空而未附调研上下文 ③touches 含整树 glob 建议精确到文件级（可多条合并）；GUI 表单内黄色展示不关窗。epic 发布（publish）时自动轻量预检全部子任务注入情况，缺材料则 pushSysNote 汇总提醒主窗口（全有不打扰）；派发时清单组装失败落任务「最近失败」行，不再静默。另存 `lintWarnings[]` 起草 lint（四规则：touches 整树 glob「粒度过粗，几乎锁整仓」/ 相对路径双仓库歧义「建议加仓库前缀」/ full 无验收「建议带验收命令」/ 标题缺动词或描述空），落卡透出、详情页 ⚠️ 行展示，不阻断创建
- **Worker/Verifier 均可配置异构模型**（⚙️ 弹出层下拉选择，空 = 继承父级），避免同源盲点；模型故障自动熔断回退父级模型
- 孤儿回收：子代理 run 结束/丢失超 2 分钟 → 任务自动回待办重派
- 看门狗：运行超时且事件流停滞 → 标记"疑似卡死"（不自动杀，裁决权交主窗口/用户）
- 歧义上报：Worker 遇到歧义不猜测，上报等主窗口裁决（任何模式下都通知）；裁决后新 Worker 携带裁决答案接手
- 驳回详情全量带回：三条驳回路径（`board_verdict` 工具 / Verifier 文本结算 / 手动 `task_verify`·`verify-task`）统一往 `t.messages` 落一条 `kind: "rejection"` 完整驳回包（summary + checks 逐条核对证据；手动路径补写 `t.verification`），经 `buildMessages` 全量注入重派 Worker prompt——新 Worker 据此返工，不再只看到 300 字截断的 history 记录
- **Verifier 自测指南（userTest）**：Verifier prompt 末尾追加「## 自测指南」段契约——四字段 `gist`（一句人话说改了什么）/ `steps[]`（用户操作步骤，每条一步）/ `expect`（预期看到什么）/ `tier`（`ui`=界面可操作 | `metric`=看指标变化 | `internal`=纯内部无用户可感知面；`internal` 时 steps 可空、expect 写「验证靠测试套件」）；**诚实护栏写死在 prompt**：只给亲自验过/从 diff 可推导的步骤，不许编没验过的操作，UI 特性给具体路径（哪个区哪个按钮），host-only 改动如实标 `internal`。双模落账 `t.verification.userTest`（工具通道 `board_verdict` 的 `userTest` 参数 / 文本通道收「## 自测指南」段；tier 非法/缺省一律归 `internal` 保守档，缺段/字段全空不挂字段）；详情页验证记录区渲染「📋 自测指南」块（gist + 编号步骤 + 预期 + tier 徽章：ui 绿 / metric 蓝 / internal 灰），报告导出聚合「## 本版自测清单」段（按验收通过时间倒序近 10 张已验收卡，`internal` 收末尾并标注「无用户可感知面」）
- **开关 `verifyUserGuide`**（⚙️ 设置区「验收」小节——「通知」旁，默认**开**）：关掉后 Verifier prompt 不拼指南段（省 token）、验收落账不挂 `userTest`、详情页自测指南块与报告清单段整块不渲染；老看板文件没有该字段 → 读路径自动补 `true`（与升级前行为一致）
- **Verifier 验收员加餐**（固定人设 + 文件纪律 + 工具收窄）：verifier spawn 挂固定 `persona`（宿主 scoped persona-prefix 影子段）——独立判断不轻信 Worker 汇报、以验收脚本实证为准、诚实分级、结论写给主窗口与用户双读者；prompt 内写死**文件纪律**（可写临时/测试文件，工程代码与文档只读，验收结束清理，事后 touches 审计兜底）；`toolFilter` 保守收窄只砍联网检索（`web_fetch`/`web_search`），spawn 失败自动剥外挂参数裸请求重试（Worker spawn 路径不受影响）
- 手动派发：详情页「派发 / 派发验收」按钮可随时手动触发单任务派发（auto 模式补派、manual 模式主通道）
- 会话隔离：看板按会话分桶，多会话互不干扰

### 可续跑 Worker（continuable，卡1~卡3 已落地，默认开）

**一句话**：Worker 从「一次性 run」变成**持久子会话**——超时不再丢现场，重派时原会话**冷复活**接着干；Verifier 与 hook run 仍是一次性。

- **continuable 化**：Worker 走 `subagents.startContinuable`（rec 持 `childId`），turn 结束改由 host 事件 `agent/status` 的 `running→idle` 观测（一次性路径本就用 `run.result` 结算，未受影响）；`claimedBy` / `t.runs[].id` / 详情页会话跳转的 id 语义不变（仍是子会话 id）
- **硬超时 interrupt 留存（不销毁）**：失败/硬超时结算时只对子会话发取消信号打断当前 turn——Activation、未认领收件箱、已发布后代全部保留，子会话 idle 后仍可被唤醒；`interrupt` 失败（会话已死/无权限）绝不阻断结算：任务照常回待办，只给该 run 落 `noResume` 标记（重派直接起新 Worker，不空唤醒）
- **重派冷复活续跑**：命中「上次 continuable Worker 结局=超时/失败」的待办卡时，不 spawn 新会话，改 `subagents.sendMessage(活父 Agent, childId, 断点续跑指令)`——子会话带着上一轮全部上下文复活，先盘点工作树再从断点继续；`t.runs[]` 追加一条 `resume: true` 记录（详情页历史会话按钮带 **↻** 标记），续跑同样计入三连败计数；续跑不可用（`NOT_RESUMABLE` 等）→ 回落全新 Worker，并把原因写进任务消息随首条 prompt 注入
- **续跑基线（不拿旧文本冒充交付物）**：续跑轮结算只认**基线字节之后**新写的助手文本——一个字没产出就走「空文本按失败」重排，绝不把上一轮（被中断那次）的残留文本当成本轮交付物推进验收
- **重启 reconcile（找回活跃续跑 Worker）**：host 重启会清空内存里的活跃 run 表，但持久子会话还活着。首轮派发周期对「进行中且无活跃 run」的卡查一次 `listChildren(root)`：仍在列 → 重建 rec 观测（监听器本就在）并重挂两级超时臂、基线取当前日志字节数；不在列 → 视为会话已死，走硬超时等价物（回待办重排 + 留一行流转记录），不占 Worker 并发位
- **usage 增量计账（按 seq 水位线）**：注意「一个持久子会话被结算多次」是新形态——整份日志全量累加会把前几轮的 token 反复记账（实测同一 childId 结算两次＝双倍）。现按 v4 日志事件自带的 `seq` 记水位线（落在 `t.runs[].usageSeq`）：每次结算只累加水位线之后的 `assistant/message` 增量，本轮没新增量就一行都不记；one-shot 路径（每 run 独立日志）行为逐字不变
- **开关 `workerContinuable`（默认开）**：关掉即逐字回退旧的一次性路径（零 `startContinuable`/零 `sendMessage`/零 `interrupt`，结算仍走 `run.result`+`dispose`）；Verifier 与 hooks（`hook-pre`/`hook-post`）**保持一次性**，不受该开关影响
- **结算双通道 + 池韧性（2026-10-06 事故修复）**：continuable 结算有事件通道（`agent/status` 的 running→idle，身份取 `agent.session.id`）与上报通道（`board_report` 落定即收尾）两条入口，任一到达即关账（结局/usage/超时臂三件套，幂等）；派发周期自带**幽灵活跃表项 GC**（卡面证据核对回收残留 rec，防残留把派发容量顶到 0 拖死全池）+ 整轮 try/catch 与逐卡隔离（单点异常只作废该卡该轮）+ 去抖 latch 时间戳兜底复位
- **续跑指令优先级**：断点续跑指令会带上卡上 messages 原文（仲裁/干预/驳回理由），并声明**最新裁决/干预优先于历史原始契约**（冲突以最新为准）——冷复活子会话的历史里没有仲裁答案，不带原文它无从知晓
- **高优干预实时送达 continuable Worker**：`task_intervene` 对 continuable rec 走宿主投递通道（保留插件 source，下一个 step 边界消费），会话不可用降级 `sendMessage` 冷复活投递，再不行回退「记录注入随重派送达」并在 history 注明
- **运行区子会话 id 归属标注（防误杀）**：卡详情「运行」区显示当前活跃 run 的子会话 id（childId）并标注「对应子代理列表同名条目」，终止 Worker 前先到子代理列表核对该 id 的同名条目，避免误杀别的合法 Worker

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
- **touches 排他**：`touches` 文件级排他锁在活动任务间生效，冲突任务跳过本轮派发，**锁随工作态**（`in-progress`/`verifying` 持有；状态流转到 `resolved` 即释放，`cancelled`/归档同样释放——归档不再承担解锁职责）；跨档一致
- **起草 lint**：`task_create`/`create-task` 与更新入口现算四规则软警告（touches 整树 glob「粒度过粗，几乎锁整仓」/ 相对路径双仓库歧义「建议加仓库前缀」/ full 无验收「建议带验收命令」/ 标题缺动词或描述空），存 `lintWarnings[]` 落卡透出、详情页 ⚠️ 行展示，不阻断；跨档一致
- 孤儿回收、看门狗、级联归档、会话隔离同样三档一致

Team 托管档独有（调度员体验）：
- 主窗口 system prompt 注入派发引导（提示词层面建议实质性改动走看板，不硬拦截）；引导含**上下文书写提示**——子代理是全新会话、无会话记忆，description 写不够会自行调研跑偏
- **默认草稿护栏**：`task_create` / `create-task` 缺省建为草稿（草稿不派发），先把所有任务的 dependsOn、contextNotes/contextFiles 补齐，再逐个 `task_update publish=true` 统一发布；确实要立即派发的单个任务才显式传 `draft:false`
- **歧义通知 25s 去抖**：通知延迟 25s 投递，投递前重读看板——歧义已被裁决、或任务已 resolved/archived 就静默跳过（消除主窗口 turn 排队导致的过期回声）；同一任务连续多次上报只投最新一条
- 任务完成/阻塞时主窗口收到**批量聚合回执**（45s 窗口或满 5 条聚合，等主窗口空闲再发，不打断对话）；⚙️ 设置区「通知」小节有两个回执开关——`notifyDispatch`（⚡ 派发回执：任务被 Worker/Verifier 领走时播报）与 `notifyDone`（✅ 完成回执：完成/阻塞时聚合播报），缺省均**开**（老看板文件缺字段自动补 `true`）；**歧义裁决通知不受开关影响**（裁决通道不是回执，任务等人裁决必须提醒）

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
│   ├── test/                     #   无头集成套件（node --test；*.test.mjs 为测试本体，
│   │   └── helpers/mock-ctx.mjs  #     helpers/ 是假宿主基建，不被当测试跑）
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
| `usage.mjs` | 统计 | v4 会话日志定位 / zstd 分帧 / token usage 聚合（纯函数；有效消耗 `effectiveTokens` + `byModelEff` 模型有效分摊 + `byDay` 双指标 `{t,e}` 聚合，兼容老 number 日账；统计范围按任务级 `t.runs[].at` 逐 run 裁切；`sinceSeq` 水位线增量结算——同一持久子会话多次结算不重复计账；`readMainWindowUsage` 主窗口会话**增量尾读**聚合——文件偏移水位缓存，追加只读增量、截断全量重读、尾部半帧不结算） |
| `session.mjs` | 会话 | root 解析缓存 / 会话 id 归一 / workMode 派生 / runsFor |
| `store.mjs` | 持久化 | boardPath / rt / wt 原子落盘 / 跨重启继承 / fileLocks 串行化 / mutateLocked |
| `notify.mjs` | 通知 | makeMsg / 歧义 25s 去抖 / 回执聚合 + 空闲门控 / 投递前过滤 |
| `dispatch.mjs` | 派发引擎 | poolCycle / spawnOneShot / settleRun / 两级超时 / 孤儿回收 / 可续跑 Worker（continuable + 重启 reconcile + usage 水位线） |
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
| `dashboard.js` | 仪表盘与设置 | 统计图表、Token 消耗、模型表现（七指标×场景筛选）、质量趋势（通过率/时长分布/超时/续跑）、全局总览、报告生成、团队池视图、池/模型/超时设置与工作模式开关 |

四个模块拼进同一个 `apply(ctx)` 函数作用域（`var`/`function` 声明提升使跨模块引用与拼接顺序无关；
所有同步执行代码——DOM 监听、轮询注册、布局同步、slots.inject——都在 kernel 域内保持原相对顺序）。
改模块源后必须重新组装（`npm run build-client`）产物才更新；直接编辑 `lib/client.js` 会在下次拼装时被覆盖。

> v68 起拆除了"动态源码 → 静态包"的转换层（build-pkg.cjs）：插件已稳定，
> 双形态维护的复杂度大于收益，包内文件即唯一源码，改完重启 dsh 即生效。
>
> v74 起去池化（一次性派发）+ 纯逻辑抽到 `lib/core.mjs`，在包目录跑
> `npm test`（node --test，无头集成全套件）即可验证状态机/依赖/派发决策，
> 不用重启 dsh 人肉回归——跑法与口径详见 [docs/DEVTESTING.md](docs/DEVTESTING.md)。

## 开发与测试

- **一条命令**：`cd packages/dsh-agent-board && npm test`——`pretest` 自动先拼装前端产物
  （`build-client`），再跑 `node --test test/**/*.test.mjs`：纯逻辑单测 + 无头宿主集成全套件
  （当前 355 例，~6s），无需 dsh 环境。
- **helpers 约定**：`test/helpers/mock-ctx.mjs` 是无头基建（假 cordis ctx / 临时 HOME / 虚拟时钟 /
  剧本化 subagents），不是测试；靠 `*.test.mjs` 文件名约定排除，不会被误跑。
- **CI 零改动继承**：`.github/workflows/test.yml` 在 push/PR 时跑语法检查 + `npm test`，
  套件随脚本自动生效；`prepublishOnly` 门禁同款。
- **插件改动生效口径**：host 端代码（`index.mjs` / `lib/*.mjs`）不可热重载（宿主模块表按 URL 缓存），
  改了必须重启 dsh；管理接口 disable→enable 只能重组组合层（路由/工具卸下再挂上），拉不到新代码。
  实测证据与探针脚本（`scripts/reload-probe.cjs`）见 [docs/DEVTESTING.md](docs/DEVTESTING.md)。

## 文档

- [docs/PRD.md](docs/PRD.md) — 完整产品需求文档
- [docs/PACKAGING.md](docs/PACKAGING.md) — 正式安装（Bundle 打包）注意事项
- [docs/icon-style-guide.md](docs/icon-style-guide.md) — 图标规范
- [docs/REGRESSION-v59.md](docs/REGRESSION-v59.md) — 回归测试说明
- [docs/DEVTESTING.md](docs/DEVTESTING.md) — 开发与测试：无头套件跑法 / CI 继承 / 热重载口径

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
- 日常 push / PR 有 `test.yml` 跑语法检查 + 无头集成全套件（`npm test`）
- 本地手动发布仍然可用：`npm publish --registry=https://registry.npmjs.org`（本机默认源是镜像时必须显式指定）

## License

MIT
