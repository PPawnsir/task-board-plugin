# 任务看板图标风格指南 (icon-style-guide)

> 版本: v1.0（依据 batch2-1 裁决）
> 裁决结论：**方案 C 混合**——结构性图标用内联 SVG（Lucide 线性风，`currentColor` 跟随主题），表情性点缀保留 emoji。
> 本文件只产出规范与映射表，**不改任何代码**；后续实施以本文件为依据。

---

## 1. 风格总规则

### 1.1 判定框架：什么用 SVG，什么留 emoji

| 类别 | 载体 | 判定 | 例子 |
|---|---|---|---|
| **语义标识**（导航、品牌、Tab） | SVG | 结构性 | 看板 logo、仪表盘 Tab |
| **操作动作**（按钮上的图标） | SVG | 结构性 | 保存、归档、刷新、关闭、通过、驳回、裁决、介入 |
| **状态/告警标识**（badge、卡片标记） | SVG | 结构性 | 待裁决 ⚠、池状态 ⚡✓ |
| **身份角色** | SVG | 结构性 | Team 👥、自动 🤖、手动 👤 |
| **报告区块标题** | SVG | 结构性 | 交付报告 📦、验收报告 🔍 |
| **情绪表达** | emoji | 表情性 | 空状态 🎉 |
| **内容装饰标记** | emoji | 表情性 | 卡片预览摘要前缀 📝 |
| **动态文本内联**（提示消息里的符号） | emoji | 表情性 | actionMsg 里的 ✅/⚠️、驳回提示里的 ❌ |

判定口诀：**"它在传达界面结构，还是在表达情绪？"** 结构用 SVG，情绪用 emoji。拿不准时看：是否需要在主题切换时变色？需要 → SVG。

### 1.2 SVG 技术规范（Lucide 线性风）

```text
viewBox      : 0 0 24 24
fill         : none
stroke       : currentColor        ← 关键：颜色跟随父级文本色，天然适配主题 token
stroke-width : 2（默认）；小尺寸(≤12px)可用 1.5 保持视觉重量
stroke-linecap : round
stroke-linejoin: round
尺寸         : 按钮内 14px，行内 12px，标题/区块头 16px
```

- **不引入任何外部图标库**（客户端沙箱无网络打包能力）；SVG path 手工选自 Lucide（ISC 许可，可自由内联）。
- 统一在客户端代码中实现一个 `ic(name, size)` 帮助函数 + `ICONS` path 字典，所有图标调用收口到一处。
- 命名直接使用 Lucide 官方图标名，便于后续对照 https://lucide.dev 增补。

---

## 2. 替换映射表（全量 25 处盘点）

### 2.1 换为 SVG（结构性，共 20 处）

| 现 emoji | Lucide 图标名 | 含义 | 所在组件 / 位置 | SVG path 来源思路 |
|---|---|---|---|---|
| 📋 ×3 | `clipboard-list` | 看板品牌标识 | `BoardButton` 按钮标签；`TopPanel` 标题；`ViewTab`「看板」Tab | lucide.dev/icons/clipboard-list：圆角夹板外框 + 内部两条横线 |
| 📊 | `bar-chart-3` | 仪表盘 Tab | `ViewTab`「仪表盘」Tab | 三根递增高度竖条 + 底线 |
| ⚠️ (badge) | `alert-triangle` | 待裁决告警 | `BoardButton` ⚠N 脉冲 badge；`Card`「⚠️ 待裁决」标记；`DetailView` 上报横幅标题 | 圆角三角形 + 感叹号（线+点） |
| ⚡ | `zap` | Worker 池 / 高优介入 | `PoolStatus` ⚡w/t；`Card` 领取人前缀；`DetailView` 介入区块标题 | 闪电折线 |
| ✓ | `check` | Verifier 池 | `PoolStatus` ✓v/t | 对勾折线 |
| ✓ (通过) | `check-circle` | 验收通过按钮 | `DetailView`「✓ 通过」 | 圆圈 + 对勾 |
| ✗ | `x-circle` | 驳回按钮 | `DetailView`「✗ 驳回」 | 圆圈 + 交叉 |
| 🔄 | `refresh-cw` | 刷新 | `TopPanel` 刷新按钮 | 顺时针双箭头弧线 |
| ✕ | `x` | 关闭 | `TopPanel` 关闭按钮 | 交叉两线 |
| 💾 | `save` | 保存并重置 | `DetailView` 保存按钮 | 软盘轮廓 + 标签缺口 |
| 📦 (归档) | `archive` | 归档按钮 | `DetailView`「📦 归档」 | 箱体 + 盖子横条 |
| 📦 (交付报告) | `package` | 交付报告区块头 | `DetailView`「📦 交付报告」 | 包裹盒 + 封箱胶带线 |
| 🔍 | `clipboard-check` / `clipboard-x` | 验收报告区块头（随结论变色） | `DetailView`「🔍 验收通过/验收驳回」 | 夹板 + 对勾 / 夹板 + 交叉；与 verdict 联动 |
| ⚖️ | `scale` | 提交裁决 | `DetailView`「⚖️ 提交裁决」按钮 | 天平：立杆 + 横梁 + 双托盘弧 |
| 👥 | `users` | Team 模式开关 | `TeamSwitch` 按钮 | 双人头像轮廓 |
| 🤖 | `bot` | 自动派发 | `ModeSwitch`「🤖 自动」 | 机器人头：方脸 + 天线 + 双眼 |
| 👤 | `user` | 手动派发 / 指派 | `ModeSwitch`「👤 手动」；`Card` 指派前缀；`DetailView`「👤 手动派发」标 | 单人头像 + 肩线 |
| ▼ / ▶ | `chevron-down` / `chevron-right` | 归档区折叠开关 | `TopPanel` 归档折叠行 | 单折线箭头 |

### 2.2 保留 emoji（表情性，共 5 处）

| emoji | 位置 | 保留理由 |
|---|---|---|
| 🎉 | `TopPanel` 空状态「🎉 暂无任务」 | 纯情绪表达，无需主题色 |
| 📝 ×2 | `Card` verifying 预览前缀；`DetailView` resolution 块 | 内容性装饰标记，非界面结构 |
| ✅ / ⚠️ / ❌（动态文本内） | `DetailView` actionMsg 反馈（"✅ 裁决已转达"）、各类错误提示前缀 | 出现在动态消息文本内部，属于行文而非 UI 元素 |

---

## 3. 实施方式（供后续执行参考，本阶段不写代码）

```js
// 拟在 client 中加入的统一收口（示意，非本次交付）
var ICONS = {
  'clipboard-list': '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
  // ... 其余按 §2.1 映射表逐个从 Lucide 抄录 path
}
function ic(name, size) {
  return React.createElement('svg', {
    width: size || 14, height: size || 14, viewBox: '0 0 24 24',
    fill: 'none', stroke: 'currentColor', strokeWidth: 2,
    strokeLinecap: 'round', strokeLinejoin: 'round',
    style: { display: 'inline-block', verticalAlign: '-2px', flexShrink: 0 },
    dangerouslySetInnerHTML: { __html: ICONS[name] } // 或改为逐 path createElement
  }, null)
}
```

**迁移顺序建议**（风险递增）：① `TopPanel` 头部（logo/刷新/关闭）→ ② `ModeSwitch`/`TeamSwitch`/`ViewTab` → ③ `DetailView` 操作按钮与报告区块 → ④ `Card`/`PoolStatus` 状态标记 → ⑤ `BoardButton` badge（⚠️ 脉冲动画已用 CSS keyframes，SVG 同样可挂 `tskb-pulse`）。

**注意**：`dangerouslySetInnerHTML` 在受限环境可能被禁，稳妥做法是 `ICONS[name]` 存 path 数组、用 `React.createElement('path', { d })` 逐个渲染——实施时先试 innerHTML，失败则回退数组方案。

---

## 4. 验收标准（实施完成后核对）

1. §2.1 表中 20 处全部替换为 SVG，渲染无缺失（`ic()` 未知名称不渲染为空白）
2. 所有 SVG 图标在浅色/深色主题下颜色均跟随父级文本（`currentColor` 生效）
3. §2.2 表中 5 处 emoji 保持不变
4. ⚠️ badge 脉冲动画在 SVG 上仍生效
5. 无布局抖动（图标 `flexShrink:0` + 固定尺寸）
