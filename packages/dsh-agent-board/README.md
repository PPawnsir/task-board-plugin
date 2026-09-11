# dsh-agent-board

Agent 任务看板 — 会话级任务管理 + 常驻 Worker/Verifier 执行池。

## 功能

- **看板 UI**：会话标题栏 📋 按钮，顶部抽屉面板（看板 / 团队 / 仪表盘三视图），拖拽流转，多选批量操作（带一步撤销），筛选（文本/优先级/标签）
- **任务模型**：pending → in-progress → verifying → resolved → archived，含 blocked/cancelled；优先级、标签、依赖（环检测）、流水线分档（full/work/direct）
- **执行池**：自动伸缩的常驻 Worker/Verifier 池，串行队列派发，看门狗卡死标记（不自动杀，裁决权在主窗口/用户）
- **Team 模式**：开启后向主窗口注入提示词引导（实质性改动建议走看板派发），Worker 歧义上报主窗口裁决；池任务完成/阻塞时主窗口收到回执通知
- **验收**：可选 acceptance 硬性验收脚本，Verifier 独立复跑

## 安装

```sh
dsh plugin --profile web add <path-to-this-package>
```

重启 DSH 后生效。

## 源码

本包即源码，直接维护（v68 起拆除了动态→静态转换层）。改完重启 DSH 生效（link: 安装无需重装）。
