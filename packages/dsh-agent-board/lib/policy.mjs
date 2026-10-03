// dsh-agent-board — 策略层（lib/policy.mjs）
// 纯函数、零状态、零 IO：任务粒度治理（软闸门文案与判定）+ 学习飞轮候选教训生成。
// index.mjs 薄壳 re-export 粒度治理导出（对外契约不变）；dispatch/rpc 模块按需 import。
import * as core from './core.mjs'
const { cfg, lessonText, pushLesson } = core

// ===== 任务粒度治理（全软方案：只引导/提示，绝不阻断创建与派发）=====
// 背景：agent 容易把史诗级大任务整坨塞进看板（长程 + 跑偏风险 + 返工成本高）。
// 落地三件套（都不带硬闸门）：
//   1) task_create 工具描述里的粒度契约 TASK_SIZE_CONTRACT；
//   2) Team 模式系统提示词第 6 条 TEAM_SPLIT_RULE（epic 父卡 + 子任务 + checkParentAuto 收尾）；
//   3) create-task RPC / task_create 工具返回体命中时附加 suggestSplit 一行建议（不落盘、不改状态）。
export var TASK_SIZE_CONTRACT = '建议粒度：单任务 10~30 分钟可独立完成。超出此范围的大任务请先拆分——建一张 epic 卡（parentId 体系）再挂子任务，别整坨塞进来。'
export var SUGGEST_SPLIT_TEXT = '任务看起来偏大（建议单任务 10~30 分钟）：考虑拆分子任务（parentId）或收窄边界'
// Team 模式提示词第 6 条：大任务的 epic 拆分流程（父卡 pipeline=direct 不派发，子任务全 resolved 后父卡由 checkParentAuto 自动转 verifying）
export var TEAM_SPLIT_RULE = '6. 大任务必须拆分：预计超过 30 分钟的任务，先建一张 epic 父卡（pipeline 传 direct，不派发），再拆成若干 10~30 分钟的子任务（task_create 传 parentId=父卡 id，有先后顺序的用 dependsOn 串联）。子任务全部完成后父卡会自动标记完成（checkParentAuto）。'
// 史诗特征词：命中即视为"整坨塞进来"的典型信号（与 TASK_SIZE_CONTRACT 配套；无 /g，可安全复用）
var EPIC_WORDS = /全量|整体|系统级|全面|重构|所有模块|整个/
// description 长度阈值（字符）：超过它说明描述密度远超"10~30 分钟单任务"应有体量
var SPLIT_DESC_LIMIT = 500
// 软闸门判定：description > 500 字符，或 title+description 命中史诗特征词 → 返回建议文案；否则返回 ''
// 纯函数、无 IO、不改任务字段——调用方拿到空串即视为粒度正常（falsy 判断即可）
export function suggestSplitOf(t) {
  var desc = String((t && t.description) || '')
  var text = String((t && t.title) || '') + ' ' + desc
  if (desc.length > SPLIT_DESC_LIMIT || EPIC_WORDS.test(text)) return SUGGEST_SPLIT_TEXT
  return ''
}
// 统一出口：只在命中时附加字段，老调用方拿到的返回体形态完全不变（多一个可选字段而已）
export function withSplitHint(out, t) {
  var hint = suggestSplitOf(t)
  if (hint && out && typeof out === 'object') out.suggestSplit = hint
  return out
}

    // ===== 学习飞轮 v1：候选教训信号（只产信号，不做存储）=====
    // 看板在这里只做一件事：把「Verifier 驳回 / 主窗口仲裁结论」变成一条结构化的候选教训，
    // 落进 t.messages（kind='lesson-candidate'：详情页可见 + 带「沉淀」按钮）。
    // 零耦合红线：不调用任何笔记/记忆工具的 API、不写任何外部文件——教训最终存到哪、要不要存，
    // 全由主窗口 agent 自己用可用工具决定。触发前一律先过 feedbackEnabled 总开关（关掉 = 不生成）。
    function lessonSource(t) { return '任务 ' + t.id + '「' + String(t.title || '').slice(0, 60) + '」 · ' + new Date().toISOString() }
export function pushRejectLesson(d, t, reason, at) {
      if (!cfg(d).feedbackEnabled) return false
      return pushLesson(t, lessonText('任务「' + String(t.title || '') + '」(' + t.id + ') 被 Verifier 驳回', [['错误做法', String(reason || '(Verifier 未给出理由)')]], lessonSource(t)), at, 'system')
    }
export function pushArbitrationLesson(d, t, question, answer, at) {
      if (!cfg(d).feedbackEnabled) return false
      return pushLesson(t, lessonText('任务「' + String(t.title || '') + '」(' + t.id + ') 的歧义裁决', [['疑问', question], ['裁决结论', answer]], lessonSource(t)), at, 'system')
    }
