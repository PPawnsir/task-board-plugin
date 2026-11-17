// dsh-agent-board — 生命周期状态转移表（lib/lifecycle.mjs，task-mwk47az1）
// 单一事实源：6 状态（draft / pending / in-progress / verifying / resolved / blocked）
// × 全部合法转移逐条显式注册（cancelled / archived 为终态汇，恢复边例外见 B 组）。
// 零依赖纯模块（不 import core/policy，杜绝环）：core.mjs / policy.mjs 反向引用本表。
//
// 用法（表驱动推进点）：推进点改 t.status 前查表断言——
//   import { assertTransition } from './lifecycle.mjs'
//   assertTransition(t.status, 'in-progress', 'claim')  // 表上无此边 → 开发期抛错
// 既有推进点 claimApply / resolveApply / verifyApply / maybeAutoCloseParent /
// parentKickOnDispatch / applyDecomposeProposal 全部接此断言：不合法转移（如 draft→resolved）
// 在开发期就报错，防新增推进点写出死胡同；合法转移零行为变化（本卡纯结构化，不改任何转移行为）。
//
// 边的字段：
//   from  单一状态字符串、状态数组（多 from 同边）、或 '*'（仅限 from===to 的同态审计自环）
//   to    目标状态（'*' 仅配合 from:'*' 表自环）
//   via   事件名数组——语义标签，人读 + 后续检测器分流用；查表配对只看 (from, to)，
//         via 命中时优先返回带该标签的边（via 不匹配不否决，仅失去标签精化）
//   note  一句话出处/触发条件（推进点所在文件 + 语义）

// ===== 状态集 =====
// 全集 8 态：6 状态主体 + cancelled/archived 两个终态汇
export const LIFECYCLE_STATES = ['draft', 'pending', 'in-progress', 'verifying', 'resolved', 'blocked', 'cancelled', 'archived']
// 6 状态（非终态生命周期主体；「6 状态 × 全部合法转移」的口径基准）
export const LIFECYCLE_CORE_STATES = ['draft', 'pending', 'in-progress', 'verifying', 'resolved', 'blocked']

// ===== 转移表：全部合法转移逐条显式注册 =====
export const LIFECYCLE_TRANSITIONS = [
  // ── A. 主推进链（卡面规格表逐条对应）──
  { from: 'draft', to: 'pending', via: ['publish'], note: 'task_update / batch-op publish：草稿确认发布入派发池（门禁 t.status==="draft"，rpc.mjs update-task + batch-op publish）' },
  { from: 'draft', to: 'pending', via: ['decompose'], note: 'applyDecomposeProposal 物化推进：父卡只推一格 draft→pending（policy.mjs；parentKick 与 maybeAutoCloseParent 的门槛由此可达）' },
  { from: 'pending', to: 'in-progress', via: ['claim', 'dispatch'], note: 'claimApply：领取（claim-task RPC）与 poolCycle 派发占位 spawn-pending（dispatch.mjs pickDispatch→claimApply）' },
  { from: 'pending', to: 'in-progress', via: ['parentKick'], note: 'parentKickOnDispatch：首个子任务派发，史诗父卡 pending→in-progress（core.mjs）' },
  { from: 'in-progress', to: 'verifying', via: ['resolve'], note: 'resolveApply：Worker 完成/人工提交验证（full 管线；settle.mjs settleWorker / rpc.mjs board_report+task_resolve+resolve-task）' },
  { from: 'in-progress', to: 'blocked', via: ['blocked'], note: 'worker 失败×3（settle.mjs 两处）/ verifier 驳回×3（settle.mjs + rpc.mjs board_verdict）/ task_resolve 人工提交阻塞 / hook run 失败（core.mjs applyHookSettle）' },
  { from: 'in-progress', to: 'pending', via: ['reclaim', 'retry', 'reject-redispatch', 'terminate', 'arbitrate', 'spawn-fail', 'reconcile'], note: 'run 丢失回收（dispatch.mjs isOrphan）/ 失败重试 / 驳回重派（settle.mjs 两处）/ spawn 失败回退（dispatch.mjs releaseSpawnPlaceholder + revertDepsVeto + rpc.mjs）/ 终止（terminate-task / terminate-agent）/ 裁决回池（doResolveEscalation）/ 重启回收（settle.mjs reconcile）' },
  { from: 'verifying', to: 'resolved', via: ['verify-approved'], note: 'verifyApply approved：验收通过（settle.mjs settleVerifier / rpc.mjs verify-task + task_verify + board_verdict）' },
  { from: 'verifying', to: 'in-progress', via: ['verify-rejected'], note: 'verifyApply rejected：驳回回 in-progress（随后通常立即重派 pending，走上面 reclaim 族 in-progress→pending）' },
  { from: 'in-progress', to: 'verifying', via: ['parentAuto'], note: 'maybeAutoCloseParent：全部子卡落定，full/work 父卡收口 verifying；applyHookSettle post 收口完成同款（core.mjs）' },
  { from: 'in-progress', to: 'resolved', via: ['parentAuto'], note: 'maybeAutoCloseParent：direct 父卡直接收口 resolved（不进派发池，verifier 够不到；core.mjs）' },
  { from: 'verifying', to: 'verifying', via: ['parentAuto'], note: '父卡已 verifying 时 maybeAutoCloseParent 幂等早退（维持、不写账——规格表「verifying + parentAuto(full) → verifying 维持」）' },
  { from: 'resolved', to: 'archived', via: ['archive'], note: 'archiveApply：已验收卡归档（core.mjs archiveApply / rpc.mjs batch-op archive）' },
  { from: ['draft', 'pending', 'blocked'], to: 'cancelled', via: ['cancel'], note: 'cancelApply：cancelGate 放行面（草稿/待办/阻塞可取消；resolved 请用归档、verifying 拒绝）' },
  { from: 'in-progress', to: 'cancelled', via: ['cancel'], note: 'cancelApply：仅 spawn-pending 派发占位态放行（cancelGate；真在跑须先 terminate）——规格「任意 + cancel」按实际门禁收窄' },

  // ── B. 恢复/例外边（代码现实：既有调用面与门禁放行面，保证六推进点断言在合法流上不误炸）──
  { from: 'blocked', to: 'in-progress', via: ['claim'], note: 'claimApply：CLAIMABLE=[pending,blocked]，阻塞卡人工领取复工（core.mjs claimCheck/claimApply）' },
  { from: 'in-progress', to: 'resolved', via: ['resolve'], note: 'resolveApply：work/direct 管线把 status=verifying 强改 resolved（无 Verifier 直落定，core.mjs resolveApply；含 settle/单测直调 status=resolved 的调用面）' },
  { from: 'pending', to: 'verifying', via: ['resolve'], note: 'resolveApply 纯函数调用面：单测直调不带 in-progress 前置（core.test.mjs mkTask 缺省 pending 直调；生产 RPC/结算通道均有 in-progress 门禁，行为不变，函数契约兼容）' },
  { from: 'pending', to: 'resolved', via: ['resolve'], note: '同上：work 管线强改面（core.test.mjs 直调用例锁定）' },
  { from: 'in-progress', to: 'in-progress', via: ['escalate', 'parentAuto'], note: '同态维持：Worker 上报歧义（settle.mjs + board_report，状态不动）/ maybeAutoCloseParent 挂 post 闸门延迟收口（core.mjs：pending 标记 + running，不转 verifying）' },
  { from: 'verifying', to: 'verifying', via: ['verify-retry', 'verify-failed'], note: '同态维持：verifier 未给出有效结论重试 / 故障×3 转人工验收（settle.mjs settleVerifier escalation 挂起）/ Verifier 派发占位超时回收（dispatch.mjs）' },
  { from: 'pending', to: 'blocked', via: ['hook-failed'], note: 'applyHookSettle：hooks.pre run 失败，父卡尚在 pending（未到首个子卡派发）即挂起等人裁决（core.mjs）' },
  { from: 'cancelled', to: 'archived', via: ['archive'], note: 'archiveApply / batch-op archive：归档门禁放行面含 cancelled（archiveErr）' },
  { from: 'in-progress', to: 'archived', via: ['archive'], note: 'archiveApply：无活跃 run 的 in-progress 僵尸卡归档（archiveErr 放行面，v1.7.1 僵尸态出清）' },
  { from: ['draft', 'pending', 'in-progress', 'verifying', 'resolved', 'blocked', 'cancelled'], to: 'archived', via: ['archive-cascade'], note: 'archiveApply 级联子卡：父卡归档时未归档子卡一律 → archived（任意非 archived 态，core.mjs archiveApply）' },
  { from: ['verifying', 'resolved', 'cancelled', 'archived', 'blocked'], to: 'pending', via: ['reset'], note: 'task_update resetToPending：无状态门禁（rpc.mjs update-task）；归档 tab「恢复待办」（client restore）即走此边；draft/pending/in-progress 的 reset 已由 A 组同对边承载（同态走 C 组自环）' },
  { from: 'archived', to: 'resolved', via: ['batch-undo'], note: 'batch-undo 撤销批量归档：恢复归档前状态（rpc.mjs，仅 archived 且快照态 resolved）' },
  { from: 'archived', to: 'cancelled', via: ['batch-undo'], note: 'batch-undo 撤销批量归档（rpc.mjs，仅 archived 且快照态 cancelled）' },

  // ── C. 同态审计自环（from===to：状态不变的留痕行，非状态推进）──
  // 大量调用写 ah(t, s, s, ...) 留痕而不改状态（decompose keep/物化、裁决/扩权、解冻、
  // 等锁复工、batch-undo 优先级、档位自修正……）。from===to 的自环恒合法：它不是转移，
  // 是审计；用通配 from/to:'*' 显式注册这条规则，后续检测器据此放行全部同态审计行。
  { from: '*', to: '*', via: ['audit-self'], note: '同态审计自环：ah(t, s, s, ...) 留痕调用（状态零变化，仅审计记录）——from===to 恒合法' },
]

// ===== 查表 =====
// (from, to) 配对查边；via 可选——给出时优先返回带该事件标签的边（via 只是语义标签，
// 不匹配不否决：先记首个配对边为候选，途中遇到 via 命中的边则提前返回）。
// from/to 支持 '*' 通配（仅同态自环使用：e.to === '*' 时要求 from === to 才算配对）。
export function findTransition(from, to, via) {
  var hit = null
  for (var i = 0; i < LIFECYCLE_TRANSITIONS.length; i++) {
    var e = LIFECYCLE_TRANSITIONS[i]
    var fs = e.from === '*' ? null : (Array.isArray(e.from) ? e.from : [e.from])
    if (fs && fs.indexOf(from) < 0) continue
    if (!(e.to === to || (e.to === '*' && from === to))) continue
    if (!hit) hit = e
    if (via && Array.isArray(e.via) && e.via.indexOf(via) >= 0) return e
  }
  return hit
}

// ===== 开发期断言（表驱动推进点共用）=====
// 推进点改 t.status 前调用：表上无 (from, to) 边 → 立即抛错（开发期报错，防新增推进点
// 写出死胡同）。既有全部合法转移均已注册，合法流上永不触发；测试套件即安全网。
export function assertTransition(from, to, via) {
  var e = findTransition(from, to, via)
  if (!e) throw new Error('[lifecycle] 非法状态转移: ' + from + ' → ' + to + (via ? '（via ' + via + '）' : '') + '——转移表（lib/lifecycle.mjs）未注册该边；若这是新增的合法推进点，请先在 LIFECYCLE_TRANSITIONS 上登记')
  return e
}
