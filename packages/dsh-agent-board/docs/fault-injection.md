# 故障注入 · 路径 B 接口预留：宿主级 mock provider 插件接缝契约

> dsh-agent-board/docs/fault-injection.md — docs/ 目录首文件（task-mvqi3uj4-8）
> 把拆解阶段「A 起步 + B 留接口」的决策落成可追溯文档，供后续宿主级立项直接引用。
> 上游事实源：test/helpers/fault-provider.mjs（A 层五档故障基建）、lib/dispatch.mjs +
> lib/model-health.mjs（消费点；历次拆分后行号持续漂移，本文档一律按「文件 + 函数/符号名」
> 定位，不钉行号——拆分行号锚已全面清扫，见 test/fault-injection-docs.test.mjs 反向锁）、
> test/fault-e2e-hung.test.mjs + test/fault-e2e-circuit.test.mjs（首期场景面）。
> 本文档由 test/fault-injection-docs.test.mjs 读盘断言锁锚点（readme-decompose-docs.test.mjs 的读盘断言范式）。

## 一、A/B 权衡记录（首期取 A，B 留接口）

### A = mock-ctx 故障层（已落地，首期五档×六场景）

- 形态：test/helpers/fault-provider.mjs 的 installFaults(env, {...})——在 createMockCtx 无头宿主上
  opt-in 的故障注入面；installFaults 必须先于 plugin.apply 调用，缺省 createMockCtx() 行为逐字不变
  （尤其缺省 subagents 绝不带 startActivation——hasActivationApi 路径保全，零回归红线）。
- 调度逻辑全真：跑真实 index.mjs apply(mockCtx) 全循环——真 poolCycle 派发循环、真挂死判死双闸
  （hungZeroOutputSweep：**帧活性双层判定**——assistant 帧静默 ≥120s 标「🟡 疑似卡顿」仅标卡不终止
  （HUNG_FRAME_SUSPECT_MS），静默 ≥600s 判死重派并复用熔断链（HUNG_FRAME_KILL_MS）；**日志零增长
  兜底**保留给无事件订阅能力或零帧观测宿主——连续 HUNG_ZERO_GROWTH_ROUNDS 轮零增长 × 距基线
  ≥600s 墙钟地板 HUNG_WALL_FLOOR_MS 常量）、真熔断拉黑（badModels，WORKER_MODEL_CIRCUIT_AFTER=3）、
  真冷却登记（parseModelCooldown 中文带重置形态）、真四级取模链（card → lane → board → parent）。
- 宿主假：假 cordis 服务（ctx.subagents 剧本化包装、ctx.get('llm') 记录器）、虚拟时钟（ctx.timer）、
  真 fs 临时 HOME——宿主本身的行为（事件顺序、持久化时机、日志落盘节奏）是理想化剧本。
- 轻：纯 test-helper，零宿主配合面，零生产代码改动；贴现有测试基建（拆解时点盘点 653 测试，
  node:test + mock-ctx 可进普通单测闸）。
- 已落地为首期五档×六场景：
  - 五档故障模式（fault-provider.mjs FAULT_TYPES）：①instant-kill 秒拆 ②hang 挂死 ③empty 空响应
    ④rate-limit 限流 ⑤slow 慢响应；每档支持 times:N 次数窗口（前 N 次命中后自愈——连败软闸/
    恢复旅程场景依赖此语义）。
  - 六场景：fault-provider.test.mjs 4 用例（缺省①零 installFaults 路径保全 / 缺省②纯观察面 /
    五档③one-shot 全档 / 次数窗口④times:2 自愈）+ fault-e2e-hung.test.mjs 3 场景（挂死①判死关账+
    自动重派冷复活 / 挂死②三连熔断拉黑 / 挂死③活体增长不误伤）+ fault-e2e-circuit.test.mjs 2 场景
    （秒拆三连熔断+取模链跳过 / 目录闸拒写对照）。

### B = 宿主级 mock provider 插件（未立项，接口预留）

- 形态：mock provider 做成宿主级插件装进 DSH profile——全真链路：
  - 真 startActivation：真实宿主 subagents 服务 spawn 出真实子会话（非剧本合成 activation）；
  - 真 v4 日志：宿主真落盘 <home>/.dsh/sessions/<桶>/<childId>/session.v4.jsonl.zstd；
  - 真 agent/status 事件面：真实宿主事件总线的 running→idle 结算语义（非 env.emitStatus 重放）。
- 重：需宿主配合面——插件要进宿主 profile（plugin_manager 权限面 + install 脚本）、插件自身的
  配置 schema 与生命周期管理、故障注入要在真实 LLM 凭据/网关外层拦（不能真烧额度）、真实
  .dsh 数据根的隔离（mock 会话的板文件/日志不得写进真实数据根——「E2E mock 板写进真实 .dsh
  数据根 91 个持续增长」事故先例，撕裂监测信噪比被稀释）。
- 全真的增量价值：A 层无法覆盖的「宿主假面」事故——事件顺序/丢失/重复、持久化时机偏差、
  startActivation 真契约与合成语义的分歧——只有 B 能真证。

### 首期取 A 的理由

1. 事故面集中在调度逻辑：已复盘的事故类（挂死零产出、秒拆喂熔断、限流冷却、目录失效）全部
   落在插件自身的调度逻辑（判死/熔断/冷却/取模链），A 层「调度逻辑全真」已覆盖到位；
2. 轻、贴现有测试基建：node:test + mock-ctx 无头宿主可进普通单测闸，零宿主配合；B 需要装进
   真实 profile（plugin_manager 权限 + 宿主版本门槛），成本高且不能进普通单测闸；
3. B 的增量价值（真事件面/真持久化面）只有当事故漏网发生在宿主假面时才兑现——首期无此类
   漏网事故实证，先上 B 属于为不确定收益预付确定性成本；
4. A 已落地五档×六场景，现有事故类的回归闸已闭合；B 留接口（见第二节）保证后续立项零重研。

### B 的触发条件（何时必须上 B）

插件逻辑 × 宿主事件面/会话持久化面再出漏网事故时。具体三面任一命中即立项：

- (a) agent/status 事件面事故：真实宿主的事件顺序/丢失/重复、running→idle 语义偏差——A 层
  env.emitStatus 重放是理想化剧本（setImmediate 先 running 后 idle），真实事件总线行为更宽；
- (b) 会话持久化面事故：真实宿主的 sessionPersistence stat / 子会话日志落盘时机与 A 层
  「测试写真文件」剧本不一致（findRunLog / logSizeOf 对真实布局的假设失效）；
- (c) startActivation 真契约偏差：真实宿主的 childId/result/delivery 行为与 A 层合成 activation
  （synthActivation）语义出现分歧（如真宿主 delivery='parent' 下 result 的落定时机）。

触发即立项 B（宿主级 mock provider 插件）；A 层保留为回归快门（五档剧本在单测/CI 里继续跑），
B 只补「宿主真面」的端到端场景——两套互不替代、互不合并。

## 二、B 路径接缝契约（宿主侧最小面 + A 层故障映射）

宿主侧需提供的最小面共三项；每项标注 A 层对应故障模式的映射关系（五档故障在 B 层的等价注入点）。
B 立项时按本节契约直接实现插件，不再从零调研。

### 面 1：可编程 subagents provider

- 契约面（lib/dispatch.mjs 的 spawnOneShot activation 消费点；拆分后行号已漂移，按符号定位）：
  - 探测点 hasActivationApi(subagents)：typeof subagents.startActivation === 'function'，同 host
    生命周期一次性缓存——老宿主无此方法走旧路径 subagents.start / startContinuable；
  - continuable 路径（spawnOneShot 的 useContinuable 分支）：startActivation({ provider, label,
    request, signal, delivery: 'parent' }) → { childId, messageId, result,
    dispose }（SubagentActivation 契约形状）；
    childId 缺失即 throw（「startActivation 未返回 childId」——B 层 provider 必须保证返回）；
  - 一次性路径（spawnOneShot 的非 continuable 分支）：同上 delivery='caller'，
    activationAsRun(act) 适配成旧 SubagentRun 形状 { id: act.childId, result, dispose }——
    settleRun / armTimeouts / 资源清理零改动；
  - 外挂参数剥除重试块（spawnOneShot 的 catch 回退臂）：provider 不支持某能力时剥光
    agentOptions/persona/toolFilter/outputSchema 用裸请求重试，continuable 与一次性两条路径同形——
    B 层 provider 必须容忍这两种调用形态（新契约 request 缺 persona/toolFilter 属预期，不得视为错误）；
  - childId 语义（spawnOneShot 尾部的 rec 统一形态）：rec.id = 该次 run 的子会话 id（continuable 是
    childId、一次性是 run.id）——t.runs[].id / claimedBy / verifierRun / poolStatus.runId / 详情页跳转全部照旧；
  - delivery 语义（lib/dispatch.mjs 顶部 startActivation 契约注释段）：'parent' = 子会话结算时向父会话
    投递结果消息（continuable 的「完成留言」旧行为，结算触发 = 宿主 agent/status 事件 running→idle）；
    'caller' = 只回 result promise、不惊动父会话（一次性 run 旧行为，结算走 run.result）；
  - request 组装 activationRequestOf(req)：只带 prompt/parent/agentOptions/cwd +
    outputSchema 透传（task-mvnenrwk 拆解官结构化提案）；persona/toolFilter 不在新契约面
    （v0.2.1 收进 agentPreset 体系）。
- A 层对应故障模式的映射（B 层等价注入点）：
  - A 层注入点：fault-provider.mjs synthActivation()（合成 { childId, messageId, result,
    dispose }）+ wrappedSub.startActivation（spawn 日志 + 剧本表消费）；
  - instant-kill / rate-limit → B 层 = 真宿主拆除子会话 / 真限流响应（activation.result 以
    「子会话被宿主拆除（stopReason: error，…）」拆机原形文本拒绝，或 form:'teardown' 以
    { output: [], stopReason: 'error', diagnostic } 落定）；
  - hang → B 层 = 真子会话 spawn 后永不投递结果消息（result 悬置 + 子会话日志停笔）；
  - empty / slow → B 层 = 真子会话空响应 / 慢响应（result 落定 output text='' / 可编程延时后落定）。

### 面 2：llm provider 枚举面

- 契约面（listProviders / listModels / stream）：
  - 形状：ctx.get('llm') → { listProviders(): [{ id, name }], listModels(pid): [{ id, name }],
    stream(req): async generator }——B 层插件必须按此形状注册 llm 服务面；
  - 目录消费点 modelDirectory()（lib/model-health.mjs 的 createModelHealth 工厂内，头部即口径注释段）：
    每次 spawnOneShot /
    续跑闸现取一次（刻意不缓存——模型从宿主配置删除/改名要当轮生效，缓存会放走已删模型）；
    四路 null = 目录不可得 → 目录闸整体跳过（保守语义，不误伤在册模型）：
    ① llm 服务缺失/缺 listProviders/listModels 方法（老宿主）；② listProviders 未返回数组或抛错；
    ③ 任一 provider 的 listModels 抛错或未返回数组（部分枚举 = 目录不完整）；④ 枚举结果为空；
  - rpc 消费点（lib/rpc.mjs 的 enumModels()）：enum-models / set-board-config 模型校验同源——llm 服务
    缺失（老宿主）返回 null 调用方降级不炸；list-models handler 起 Verifier 模型下拉枚举同面
    （枚举当前网关可用模型供下拉选择）；
  - stream 消费点 probeModel()（lib/model-health.mjs 的 createModelHealth 工厂内）：llm.stream 极短直调（无子代理/系统提示/
    工具，maxTokens=1，15s 硬超时 AbortSignal，同模型全局只在飞一次）；finish=stop/max-tokens
    证明模型链路可用；error/aborted/无 finish 算失败 → failure.message 进冷却登记
    （不改 badModels 熔断判定——冷却与熔断两张表各管各的）。
- A 层对应故障模式的映射（B 层等价注入点）：
  - A 层注入点：fault-provider.mjs faultLlm()——目录可编程且运行中可变
    （listProviders/listModels 每次现取不缓存，handle.directory.add/remove/set 即刻生效）+
    llm.stream 桩（finish/stop 健康、finish/error + failure.message 失败，probeModel 消费口径）；
  - 目录失效 → B 层 = 宿主配置删模型/改名（directory.remove 等价于真实配置面变更，当轮生效）；
  - stream 故障 → B 层 = 真网关故障响应（stream 桩 finish/error 同形注入，不真烧额度）。

### 面 3：会话日志落盘布局

- 契约面：<home>/.dsh/sessions/<桶>/<childId>/session.v4.jsonl.zstd——多帧 zstd 顺序拼接、帧内
  jsonl（lib/usage.mjs readLogFrames 同形）；findRunLog(sessionsRoot) 按桶探测、logSizeOf 量字节
  （挂死零产出检测基线 = 文件存在即有基线、永不增长即零产出）；zstd 不可用（老 Node）退 plain
  utf8 字节（fault-provider.mjs 的 frameOf()）。B 层插件的故障注入必须落在真实宿主的这一
  布局上（桶名/childId 目录层级/zstd 帧格式逐一对齐），不得另起私路径。
- A 层对应故障模式的映射（B 层等价注入点）：
  - A 层注入点：writeFaultLog()（fault-provider.mjs）+ writeChildLog()
    （fault-e2e-hung.test.mjs）——写真日志帧后停笔（「会话在但不干活」的挂死形态）；
  - hang → B 层 = 真宿主 spawn 子会话后测试停笔（日志文件存在但永不增长）；
  - empty → B 层 = 空文本 assistant 帧 + 真宿主 running→idle 事件（settleContinuable 空文本按
    失败结算口径不变）。

## 三、测试分层纪律（事故复盘双落）

### 双落纪律

每类新事故必须双落，缺一不算闭合：

1. 单测断言锁机制——在既有单测/薄桩里锁机制常量与前缀口径（如 isModelKillFailure 拆机前缀、
   WORKER_MODEL_CIRCUIT_AFTER 熔断阈值、HUNG_FRAME_SUSPECT_MS / HUNG_FRAME_KILL_MS 帧活性
   双层判定，以及日志零增长兜底双闸 HUNG_ZERO_GROWTH_ROUNDS / HUNG_WALL_FLOOR_MS、
   parseModelCooldown 限流形态、settle-stop-interrupt.test.mjs 挂死①-⑤薄桩）；
2. fault-e2e-* 场景锁接缝——在真实 index.mjs apply 全循环上锁端到端行为（现有
   fault-e2e-circuit.test.mjs 秒拆熔断面 / fault-e2e-hung.test.mjs 挂死判死面；薄桩直喂 settle
   只锁机制点，真循环锁「机制 × 派发循环」接缝——两套互补，同 mkGateDispatch 与
   fault-e2e-hung 的关系）。

### 新事故类加卡模板（复制进卡片描述）

- 事故类：<名>（原形：<事故记录锚点>）
- 机制锁：单测断言锁 <机制常量/前缀口径>（落 <既有单测文件>）
- 接缝锁：E2E 场景锁 fault-e2e-recovery.test.mjs（恢复旅程类）——新恢复类事故（判死重派/续跑/
  熔断自愈后的恢复路径）统一续写该文件，承接 fault-e2e-hung E2E①「判死后自动重派冷复活原子
  会话」的恢复旅程语义；非恢复类新事故另起 fault-e2e-<incident>.test.mjs

### 分层口径

- A 层（mock-ctx 故障层）跑单测/CI 闸：五档剧本回归（fault-provider.test.mjs +
  fault-e2e-hung.test.mjs + fault-e2e-circuit.test.mjs），每次改动全量跑；
- B 层（宿主级 mock provider 插件，未立项）跑真机场景：只在触发条件命中后立项补场景，
  按第二节接缝契约实现；
- 文档类卡片一律读盘断言（readme-decompose-docs.test.mjs 的读盘断言范式）——本文件由
  test/fault-injection-docs.test.mjs 锁三节锚点标题与关键契约词
  （startActivation / listProviders / session.v4.jsonl.zstd / 五档故障名）。




