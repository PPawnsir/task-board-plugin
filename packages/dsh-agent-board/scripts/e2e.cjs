#!/usr/bin/env node
// dsh-agent-board E2E 固化用例——驱动真实 DSH 实例的核心功能验证
//
// 用法：
//   node scripts/e2e.cjs --session <会话id> [--base http://127.0.0.1:3080] [--only 场景1,场景2]
//
// 前置：--session 指定的会话必须在目标实例的 GUI 里处于打开状态（子代理 spawn 需要活的 root agent）。
// 场景（默认跑除 team-flow/work-mode/progress-report 外的全部；这三者需显式 --only 指定）：
//   auto-full      非Team自动模式全流程：创建(full+上下文注入+硬性验收) → 自动派发 → Worker → Verifier → resolved
//   manual-gate    手动模式门禁：manual 下任务不被自动领取；「派发」按钮可流转
//   manual-claim   手动模式领取：主窗口 claim → 办理 → resolve → verify → resolved
//   manual-pickup  切回自动：积压任务在下一心跳周期被自动拾取
//   team-flow      Team模式：草稿→发布→依赖门控→Worker 歧义上报→主窗口裁决→重派完成→依赖任务接续
//   team-draft-default  Team模式默认草稿护栏：不传 draft → 草稿；draft:false → pending；publish → pending；关 Team → pending
//   work-mode      工作模式三档往返（set-work-mode）+ 老 RPC 兼容断言（纯参数往返，无子代理）
//   progress-report 里程碑进展通道：Worker 中途 board_report(kind=progress) → lastProgress + messages 落盘
//
// 默认跑除 team-flow / work-mode / progress-report 外的全部；这三个需显式 --only 指定（progress-report 驱动真实子代理、较慢）。
//
// 全部场景自带清理（任务归档、临时文件删除），退出码 0=全过 / 1=有失败。

const http = require('http');

// ===== 参数 =====
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--session') args.session = process.argv[++i];
  else if (a === '--base') args.base = process.argv[++i];
  else if (a === '--only') args.only = process.argv[++i].split(',');
  else if (a === '--timeout') args.timeout = parseInt(process.argv[++i], 10) * 1000;
}
const BASE = args.base || 'http://127.0.0.1:3080';
const SID = args.session;
const POLL_MS = 10 * 1000;
const TIMEOUT = args.timeout || 300 * 1000;
if (!SID) { console.error('缺少 --session <会话id>（会话需在目标实例 GUI 中打开）'); process.exit(1) }

// ===== RPC（UTF-8 body，中文安全）=====
function rpcRaw(method, rpcArgs) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ method, args: Object.assign({}, rpcArgs, { sessionId: SID }) }), 'utf8');
    const u = new URL(BASE + '/dsh-agent-board');
    const req = http.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length } }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(cs).toString('utf8'))) } catch (e) { reject(new Error('bad json: ' + Buffer.concat(cs).toString('utf8').slice(0, 200))) }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ===== 断言与轮询 =====
const results = [];
function ok(cond, label) {
  results.push({ label, pass: !!cond });
  console.log((cond ? '  ✅ ' : '  ❌ ') + label);
  return !!cond;
}
async function waitTask(taskId, pred, label, timeout = TIMEOUT) {
  const deadline = Date.now() + timeout;
  let t = null;
  while (Date.now() < deadline) {
    const r = await rpcRaw('get-tasks', {});
    t = (r.tasks || []).find((x) => x.id === taskId);
    if (t && pred(t)) return t;
    await sleep(POLL_MS);
  }
  console.log('  ⏳ 轮询超时，最后状态: ' + (t ? t.status + ' claimedBy=' + t.claimedBy : 'task missing'));
  return t && pred(t) ? t : null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== 场景 =====
const scenarios = {};

// S1 非Team自动模式全流程
scenarios['auto-full'] = async () => {
  console.log('\n[auto-full] 非Team自动模式全流程');
  await rpcRaw('set-board-mode', { mode: 'auto' });
  await rpcRaw('set-team-mode', { on: false });
  const marker = 'D:/deepseek-work/.e2e-marker-' + Date.now() + '.txt';
  const fs = require('fs');
  const acc = 'node -e "const fs=require(\'fs\');if(!fs.existsSync(\'' + marker + '\'))process.exit(1);if(!fs.readFileSync(\'' + marker + '\',\'utf8\').includes(\'ok\'))process.exit(2)"';
  const r = await rpcRaw('create-task', {
    title: 'E2E auto-full ' + new Date().toISOString().slice(11, 19),
    description: '只读验证任务：新建文件 ' + marker + '，内容写一行 ok，读取确认。除此之外不要改动任何文件。',
    contextNotes: 'E2E 自动模式验证：本笔记应出现在你的上下文注入区。看到即证明 contextNotes 通道生效。',
    contextFiles: ['packages/dsh-agent-board/lib/core.mjs'],
    acceptance: acc,
    pipeline: 'full',
  });
  const id = r.task && r.task.id;
  if (!ok(id, '任务创建成功（full 管线 + 上下文 + 验收脚本）')) return;
  const t1 = await waitTask(id, (t) => t.status === 'in-progress' && t.claimedBy, '自动派发（Worker 认领）');
  ok(t1, '自动派发生效');
  const t2 = await waitTask(id, (t) => t.status === 'verifying', 'Worker 完成进入验收');
  ok(t2, 'Worker 完成进入 verifying');
  const t3 = await waitTask(id, (t) => t.status === 'resolved', 'Verifier 复核通过');
  ok(t3, 'Verifier approved → resolved');
  if (t3) {
    ok(t3.verification && t3.verification.verdict === 'approved', '验收结论为 approved');
    ok(!!t3.verification && !!t3.verification.by, '验收记录了 Verifier 来源');
  }
  ok(fs.existsSync(marker), '硬性验收产物（标记文件）真实存在');
  fs.existsSync(marker) && fs.unlinkSync(marker);
  await rpcRaw('archive-task', { taskId: id });
};

// S2 手动模式门禁 + 派发按钮流转
scenarios['manual-gate'] = async () => {
  console.log('\n[manual-gate] 手动模式门禁 + 手动派发');
  await rpcRaw('set-board-mode', { mode: 'manual' });
  const r = await rpcRaw('create-task', { title: 'E2E manual-gate', description: '占位验证任务，无需实际工作，直接上报完成。', pipeline: 'work' });
  const id = r.task.id;
  await sleep(35 * 1000); // 覆盖 ≥2 个心跳周期
  const t1 = (await rpcRaw('get-tasks', {})).tasks.find((x) => x.id === id);
  ok(t1.status === 'pending' && !t1.claimedBy, 'manual 模式下 35s 不被自动领取');
  const d = await rpcRaw('dispatch-task', { taskId: id, role: 'worker' });
  ok(d.ok === true, '「派发」按钮（dispatch-task）成功');
  const t2 = await waitTask(id, (t) => t.status === 'resolved', '手动派发后流转完成');
  ok(t2, '手动派发流转到 resolved');
  await rpcRaw('archive-task', { taskId: id });
};

// S3 手动模式领取
scenarios['manual-claim'] = async () => {
  console.log('\n[manual-claim] 手动模式主窗口领取');
  await rpcRaw('set-board-mode', { mode: 'manual' });
  const r = await rpcRaw('create-task', { title: 'E2E manual-claim', description: '占位验证任务：主窗口领取并办理。', pipeline: 'work' });
  const id = r.task.id;
  const c = await rpcRaw('claim-task', { taskId: id });
  ok(c.ok === true, 'claim-task 领取成功');
  const t1 = (await rpcRaw('get-tasks', {})).tasks.find((x) => x.id === id);
  ok(t1.status === 'in-progress' && !!t1.claimedBy, '领取后 in-progress 且记录领取者');
  await rpcRaw('resolve-task', { taskId: id, status: 'verifying', resolution: '主窗口直接办理完成' });
  await rpcRaw('verify-task', { taskId: id, verdict: 'approved' });
  const t2 = (await rpcRaw('get-tasks', {})).tasks.find((x) => x.id === id);
  ok(t2.status === 'resolved', '办理 + 验收后 resolved');
  await rpcRaw('archive-task', { taskId: id });
};

// S4 切回自动拾取积压
scenarios['manual-pickup'] = async () => {
  console.log('\n[manual-pickup] 切回自动后积压任务被拾取');
  await rpcRaw('set-board-mode', { mode: 'manual' });
  const r = await rpcRaw('create-task', { title: 'E2E manual-pickup', description: '占位验证任务，无需实际工作，直接上报完成即可。', pipeline: 'work' });
  const id = r.task.id;
  await rpcRaw('set-board-mode', { mode: 'auto' });
  const t = await waitTask(id, (t) => t.status !== 'pending', '切自动后自动拾取', 60 * 1000);
  ok(t, '积压任务在心跳周期内被自动领取');
  await waitTask(id, (t) => t.status === 'resolved', '拾取后执行完成', TIMEOUT);
  await rpcRaw('archive-task', { taskId: id });
};

// S5 Team模式全流程
scenarios['team-flow'] = async () => {
  console.log('\n[team-flow] Team模式：草稿→依赖门控→歧义上报→裁决→接续');
  const tm = await rpcRaw('set-team-mode', { enabled: true }); // 注意：服务端字段是 enabled（误传 on 会静默关成 false）
  ok(tm.teamMode === true, 'Team 模式开启（enabled 字段）');
  await rpcRaw('set-board-mode', { mode: 'auto' });
  try {
    // 草稿先行（Team 模式规范：先全部草稿、写好依赖、再统一发布）
    const a = await rpcRaw('create-task', {
      title: 'E2E team A（上报歧义）', draft: true, pipeline: 'work',
      description: '占位验证任务。收到本任务后，立即调用 board_report 工具（kind=escalate, taskId=本任务id）上报歧义，question 写「测试歧义上报」。不要做任何其他事。',
    });
    const b = await rpcRaw('create-task', {
      title: 'E2E team B（依赖接续）', draft: true, pipeline: 'work',
      description: '占位验证任务，无需实际工作，直接上报完成即可。',
      dependsOn: [a.task.id],
    });
    const aid = a.task.id, bid = b.task.id;
    ok(aid && bid, '两张草稿卡创建成功');
    const pa = await rpcRaw('update-task', { taskId: aid, publish: true });
    const pb = await rpcRaw('update-task', { taskId: bid, publish: true });
    if (pa.ok !== true || pb.ok !== true) console.log('  [debug] pa=' + JSON.stringify(pa).slice(0, 200) + ' pb=' + JSON.stringify(pb).slice(0, 200));
    ok(pa.ok === true && pb.ok === true, '两张草稿发布成功（publish 返回值受检）');
    // 依赖门控：A 派发，B 因依赖未满足不派发
    const tA1 = await waitTask(aid, (t) => t.status === 'in-progress', 'A 自动派发', 60 * 1000);
    ok(tA1, 'A（无依赖）被派发');
    const bNow = (await rpcRaw('get-tasks', {})).tasks.find((x) => x.id === bid);
    ok(bNow && bNow.status === 'pending', 'B（依赖未满足）保持 pending 不被派发' + (bNow ? '' : '（B 不在看板中！疑似写丢失）'));
    // A 上报歧义 → 主窗口裁决 → 重派完成
    const tEsc = await waitTask(aid, (t) => !!t.escalation, 'A Worker 上报歧义');
    ok(tEsc, '歧义上报到达，任务带 escalation');
    const arb = await rpcRaw('resolve-escalation', { taskId: aid, answer: '裁决：无需额外信息，直接按完成契约上报完成即可。' });
    ok(arb.ok === true, '主窗口裁决（resolve-escalation）成功');
    const tA2 = await waitTask(aid, (t) => t.status === 'resolved', 'A 裁决后重派完成');
    ok(tA2, 'A 重派后 resolved');
    // B 接续
    const tB = await waitTask(bid, (t) => t.status === 'resolved', 'B 依赖满足后接续完成');
    ok(tB, 'B 依赖满足后自动派发并 resolved');
    await rpcRaw('archive-task', { taskId: aid });
    await rpcRaw('archive-task', { taskId: bid });
  } finally {
    await rpcRaw('set-team-mode', { enabled: false });
  }
};

// S6 Team 模式默认草稿护栏（缺省 draft 跟随 teamMode；显式 draft:false 保留逃生门）
scenarios['team-draft-default'] = async () => {
  console.log('\n[team-draft-default] Team 模式默认草稿护栏');
  const cleanup = []; // 收尾统一归档
  const tm = await rpcRaw('set-team-mode', { enabled: true });
  ok(tm.teamMode === true, 'Team 模式开启（enabled 字段）');
  try {
    // ① Team 模式下不传 draft → 缺省建草稿（不被派发，留出补 dependsOn/上下文的时间窗）
    const a = await rpcRaw('create-task', { title: 'E2E team-draft-default A（不传 draft）', description: '占位验证任务，无需实际工作，直接上报完成即可。', pipeline: 'work' });
    const aid = a.task && a.task.id;
    cleanup.push(aid);
    ok(aid && a.task.status === 'draft', 'Team 模式不传 draft → draft');
    // ② 显式 draft:false 是逃生门：仍可直接建 pending（Team 模式下随即入派发池）
    const b = await rpcRaw('create-task', { title: 'E2E team-draft-default B（draft:false）', description: '占位验证任务，无需实际工作，直接上报完成即可。', pipeline: 'work', draft: false });
    const bid = b.task && b.task.id;
    cleanup.push(bid);
    ok(bid && b.task.status === 'pending', 'Team 模式显式 draft:false → pending');
    // ③ 草稿 publish 后回 pending，正常进入派发池
    const pub = await rpcRaw('update-task', { taskId: aid, publish: true });
    ok(pub.ok === true && pub.task.status === 'pending', '草稿 publish → pending');
    // ④ 关 Team（顺带切手动：避免这张 pending 立刻被子代理领走，收尾由主窗口 claim 办理）→ 缺省行为回到 pending
    const off = await rpcRaw('set-board-mode', { mode: 'manual' });
    ok(off.teamMode === false && off.boardMode === 'manual', '关闭 Team 模式（切手动，teamMode 一并关闭）');
    const c = await rpcRaw('create-task', { title: 'E2E team-draft-default C（非 Team 不传 draft）', description: '占位验证任务：主窗口领取并办理。', pipeline: 'work' });
    const cid = c.task && c.task.id;
    cleanup.push(cid);
    ok(cid && c.task.status === 'pending', '非 Team 模式不传 draft → pending（行为不变）');
    // 收尾：C 走 claim→resolve→archive，不起子代理；A/B 已被自动派发，等 resolved 后归档
    const cur = (await rpcRaw('get-tasks', {})).tasks.find((x) => x.id === cid);
    if (cur && cur.status === 'pending') {
      await rpcRaw('claim-task', { taskId: cid });
      await rpcRaw('resolve-task', { taskId: cid, status: 'verifying', resolution: '占位验证任务，主窗口直接办理完成' });
    }
    for (const id of cleanup) {
      if (!id) continue;
      const done = await waitTask(id, (x) => x.status === 'resolved', '收尾等待 ' + id + ' resolved', 180 * 1000);
      const ar = await rpcRaw('archive-task', { taskId: id });
      if (!done || ar.ok !== true) console.log('  ⚠️ ' + id + ' 收尾未归档（最后状态: ' + ((await rpcRaw('get-tasks', {})).tasks.find((x) => x.id === id) || {}).status + '），需人工清理');
    }
  } finally {
    // 恢复自动派发（teamMode 已关），不留测试态
    await rpcRaw('set-board-mode', { mode: 'auto' });
  }
};

// S7 工作模式三档（set-work-mode 单入口）+ 老 RPC 兼容（纯参数往返，不 spawn 子代理，秒级完成）
scenarios['work-mode'] = async () => {
  console.log('\n[work-mode] 工作模式三档往返 + 老 RPC 兼容');
  // ① team 档 → boardMode=auto + teamMode=true，get-tasks 派生 workMode='team'
  const r1 = await rpcRaw('set-work-mode', { mode: 'team' });
  ok(r1.ok === true && r1.boardMode === 'auto' && r1.teamMode === true && r1.workMode === 'team', 'set-work-mode team → auto + teamOn');
  const g1 = await rpcRaw('get-tasks', {});
  ok(g1.workMode === 'team' && g1.boardMode === 'auto' && g1.teamMode === true, 'get-tasks 返回 workMode=team');
  // ② list 档 → manual + teamOff，workMode='list'
  const r2 = await rpcRaw('set-work-mode', { mode: 'list' });
  ok(r2.ok === true && r2.boardMode === 'manual' && r2.teamMode === false && r2.workMode === 'list', 'set-work-mode list → manual + teamOff');
  const g2 = await rpcRaw('get-tasks', {});
  ok(g2.workMode === 'list' && g2.boardMode === 'manual' && g2.teamMode === false, 'get-tasks 返回 workMode=list');
  // ③ auto 档 → auto + teamOff，workMode='auto'
  const r3 = await rpcRaw('set-work-mode', { mode: 'auto' });
  ok(r3.ok === true && r3.boardMode === 'auto' && r3.teamMode === false && r3.workMode === 'auto', 'set-work-mode auto → auto + teamOff');
  const g3 = await rpcRaw('get-tasks', {});
  ok(g3.workMode === 'auto' && g3.boardMode === 'auto' && g3.teamMode === false, 'get-tasks 返回 workMode=auto');
  // ④ 非法/缺省 mode 兜底 auto（不抛错、不留脏状态）
  const r4 = await rpcRaw('set-work-mode', { mode: 'bogus' });
  ok(r4.ok === true && r4.workMode === 'auto' && r4.teamMode === false, '非法 mode 兜底为 auto');
  // ⑤ 老 RPC 兼容：set-team-mode enabled:true 后 workMode 仍派生为 'team'（旧客户端/脚本路径不回归）
  const legacy = await rpcRaw('set-team-mode', { enabled: true });
  const g4 = await rpcRaw('get-tasks', {});
  ok(legacy.teamMode === true && g4.workMode === 'team', '老 RPC set-team-mode(true) 后 get-tasks workMode=team');
  const legacyOff = await rpcRaw('set-board-mode', { mode: 'manual' });
  const g5 = await rpcRaw('get-tasks', {});
  ok(legacyOff.boardMode === 'manual' && legacyOff.teamMode === false && g5.workMode === 'list', '老 RPC set-board-mode(manual) 关 team 后 workMode=list');
  // ⑥ 复原 auto，不留测试态
  const back = await rpcRaw('set-work-mode', { mode: 'auto' });
  ok(back.workMode === 'auto' && back.boardMode === 'auto' && back.teamMode === false, '收尾复原 workMode=auto');
};

// S8 里程碑进展通道（board_report kind=progress → 卡片 lastProgress + 详情页 progress 消息）
// 注意：本场景驱动真实子代理（较慢，约 1~3 分钟），默认不在场景清单里——用 --only progress-report 显式跑。
scenarios['progress-report'] = async () => {
  console.log('\n[progress-report] 里程碑进展通道：中途 progress 上报 → 完成后 lastProgress + messages 落盘');
  await rpcRaw('set-board-mode', { mode: 'auto' });
  await rpcRaw('set-team-mode', { enabled: false });
  const r = await rpcRaw('create-task', {
    title: 'E2E progress-report ' + new Date().toISOString().slice(11, 19),
    pipeline: 'work',
    description: '只读验证任务，不许改动任何文件。依次做三件事：①读 packages/dsh-agent-board/README.md，'
      + '读完立刻调用一次 board_report（kind="progress", taskId=本任务id, question=一行进展摘要，例如「已读完 README」）；'
      + '②读 packages/dsh-agent-board/package.json，读完再调用一次 board_report（kind="progress", taskId=本任务id, question 写第二行进展摘要）；'
      + '③两次进展报完后，才调用 board_report（kind="complete", taskId=本任务id, summary/changes/selfTest 照实填）。'
      + '严禁跳过 progress 直接 complete，也不要定时汇报。',
  });
  const id = r.task && r.task.id;
  if (!ok(id, '进展验证任务创建成功（描述引导中途 progress 上报）')) return;
  const t1 = await waitTask(id, (t) => t.status === 'in-progress' && t.claimedBy, '自动派发（Worker 认领）');
  ok(t1, '自动派发生效');
  // 完成前先抓一次：确认「进行中」阶段卡片展示字段已落地（覆盖式，只留最新一条）
  const tMid = await waitTask(id, (t) => !!t.lastProgress, '中途 lastProgress 落地', TIMEOUT);
  ok(tMid, '进行中阶段 lastProgress 已写入（卡片「最近进展」有内容可显示）');
  if (tMid) {
    ok(typeof tMid.lastProgress.text === 'string' && tMid.lastProgress.text.length > 0, 'lastProgress.text 非空');
    ok(!!tMid.lastProgress.at, 'lastProgress.at 存在（卡片相对时间可渲染）');
    ok(tMid.lastProgress.text.length <= 200, 'lastProgress.text ≤200 字符（截断口径）');
  }
  const t2 = await waitTask(id, (t) => t.status === 'resolved', 'Worker 完成 → resolved');
  ok(t2, 'Worker 完成后任务 resolved');
  if (t2) {
    ok(!!t2.lastProgress && !!t2.lastProgress.text, '完成任务仍保留 lastProgress（覆盖式最新一条）');
    const pm = (t2.messages || []).filter((m) => m.kind === 'progress');
    ok(pm.length >= 1, 'messages 含 kind=progress 条目（详情页可展示，共 ' + pm.length + ' 条）');
    ok(pm.every((m) => !!m.at && m.text && m.text.length <= 200), 'progress 条目含 at/text 且 text ≤200 字符');
  }
  await rpcRaw('archive-task', { taskId: id });
};

// ===== 主流程 =====
(async () => {
  // 健康检查：实例可达 + 会话看板可读
  try {
    const st = await rpcRaw('get-tasks', {});
    console.log('实例 ' + BASE + ' | 会话 ' + SID.slice(0, 20) + '… | boardMode=' + st.boardMode + ' teamMode=' + st.teamMode);
  } catch (e) { console.error('实例不可达: ' + e.message); process.exit(1) }

  const names = args.only || Object.keys(scenarios).filter((n) => n !== 'team-flow' && n !== 'work-mode' && n !== 'progress-report');
  for (const name of names) {
    if (!scenarios[name]) { console.error('未知场景: ' + name + '（可用: ' + Object.keys(scenarios).join(', ') + '）'); process.exit(1) }
    try { await scenarios[name]() } catch (e) { ok(false, '场景异常: ' + String(e).slice(0, 200)) }
  }
  const pass = results.filter((r) => r.pass).length;
  console.log('\n===== E2E 结果: ' + pass + '/' + results.length + ' 通过 =====');
  results.filter((r) => !r.pass).forEach((r) => console.log('  ❌ ' + r.label));
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1) });
