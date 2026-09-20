# dsh-agent-board

[![npm version](https://img.shields.io/npm/v/dsh-agent-board.svg)](https://www.npmjs.com/package/dsh-agent-board)
[![npm downloads](https://img.shields.io/npm/dw/dsh-agent-board.svg)](https://www.npmjs.com/package/dsh-agent-board)
[![node](https://img.shields.io/node/v/dsh-agent-board.svg)](https://www.npmjs.com/package/dsh-agent-board)
[![license](https://img.shields.io/npm/l/dsh-agent-board.svg)](https://github.com/PPawnsir/task-board-plugin/blob/main/LICENSE)
![category](https://img.shields.io/badge/awesome--dsh--plugin-workflow-blue)

DeepSeek Harness 智能看板 — 让主窗口把编码工作变成可追踪、可验收、可审计的任务，而不是一段做完就散的对话。

## 背景与动机

直接在会话里让 agent 干活，随着任务变多变复杂，会遇到四个典型问题：

1. **长任务挤占对话** —— 一个改半小时的任务会让主窗口在这期间既不能干别的，也无法并行处理其他请求；多个任务只能排队串行。
2. **干完没有验收** —— agent 说"完成了"就是完成了，改动是否真的可跑、是否满足要求，没有第二双眼睛独立复核过。
3. **上下文反复调研** —— 每个新任务都从零读代码、查约定，主窗口调研过的结论和读过的文件无法带给执行者，时间都花在重复调研上。
4. **过程不可见、结果不可审计** —— 任务散落在对话流里：谁做的、卡在哪、被驳回过几次、为什么这么做，事后无从回溯。

看板针对这四点给出机制化的解法：

| 问题 | 解法 |
| --- | --- |
| 挤占对话 | 每个任务派发给**一次性 Worker 子代理**独立执行，主窗口保持可交互；任务之间依赖调度、可并行 |
| 没有验收 | **独立 Verifier 子代理**复核：Worker 必须实跑自测，Verifier 独立复跑验收脚本后给出结论；驳回自动重派，三次驳回升级人工 |
| 重复调研 | 主窗口调研过的**结论/思路（contextNotes）和读过的文件（contextFiles）**随任务注入子代理的上下文注入区，子代理不必从零开始 |
| 不可见不可审计 | 任务卡全程留痕：状态流转历史、每次验收结论、歧义上报与裁决、干预记录都在任务详情里；Worker/Verifier 会话可从详情页直达回看 |

## 核心机制

- **看板 UI**：会话标题栏「智能看板」按钮打开顶部抽屉（看板 / 团队 / 仪表盘三视图），拖拽流转，多选批量操作（带一步撤销），筛选（文本/优先级/标签）
- **任务模型**：draft → pending → in-progress → verifying → resolved → archived，含 blocked/cancelled；优先级、标签、依赖（DFS 环检测）、流水线分档（full 执行+验证 / work 只做不验 / direct 主窗口直办）
- **一次性派发**：每个任务 spawn 一个一次性子代理，做完即销毁——无常驻池、无状态残留；孤儿回收 + 看门狗卡死标记（不自动杀，裁决权在主窗口/用户）
- **Team 模式**：开启后向主窗口注入提示词引导（实质性改动建议走看板派发，不硬拦截）；Worker 遇到歧义上报主窗口裁决（任何模式都通知）；任务完成/阻塞时主窗口收到批量聚合回执（等空闲再发，不打断对话）
- **异构模型**：Worker/Verifier 均可下拉配置不同模型（避免同源盲点），默认空 = 继承父级模型；模型故障自动熔断回退父级
- **手动/自动模式**：自动模式看板自动调度派发；手动模式主窗口自行 claim，详情页可「派发 / 派发验收」手动触发

## 安装

> 宿主要求：Node ≥ 22；DSH ≥ `0.1.5-rc.1`（已通过 `peerDependencies` 声明，含预发布分支的版本范围见 package.json）

```sh
dsh plugin --profile web add dsh-agent-board
```

重启 DSH 后生效。数据存于 `~/.dsh/tasks-<sessionId>.json`，卸载不删数据。

## 升级

```sh
dsh plugin --profile web add dsh-agent-board@latest
# 重启 DSH
```

## 源码与文档

- 仓库：<https://github.com/PPawnsir/task-board-plugin>
- 本包即源码，直接维护（v68 起拆除了动态→静态转换层，v74 起去池化）
- 单元测试：`npm test`（node --test，38 例纯逻辑用例，无需重启 dsh）
- 开发热循环：`npm run dev`（独立 dev 实例 + 文件监听自动重启，详见 scripts/dev-watch.cjs 头部说明）
