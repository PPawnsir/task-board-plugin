#!/usr/bin/env node
// dsh-agent-board E2E 固化用例——驱动真实 DSH 实例的核心功能验证
//
// 用法：
//   node scripts/e2e.cjs --session <会话id> [--base http://127.0.0.1:3080] [--only 场景1,场景2]
//
// 前置：--session 指定的会话必须在目标实例的 GUI 里处于打开状态（子代理 spawn 需要活的 root agent）。
// 场景（默认跑除 team-flow 外的全部；team-flow 需显式指定）：
//   auto-full      非Team自动模式全流程：创建(full+上下文注入+硬性验收) → 自动派发 → Worker → Verifier → resolved
//   manual-gate    手动模式门禁：manual 下任务不被自动领取；「派发」按钮可流转
//   manual-claim   手动模式领取：主窗口 claim → 办理 → resolve → verify → resolved
//   manual-pickup  切回自动：积压任务在下一心跳周期被自动拾取
//   team-flow      Team模式：草稿→发布→依赖门控→Worker 歧义上报→主窗口裁决→重派完成→依赖任务接续
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
  await rpcRaw('set-team-mode', { on: true });
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
    await rpcRaw('update-task', { taskId: aid, publish: true });
    await rpcRaw('update-task', { taskId: bid, publish: true });
    // 依赖门控：A 派发，B 因依赖未满足不派发
    const tA1 = await waitTask(aid, (t) => t.status === 'in-progress', 'A 自动派发', 60 * 1000);
    ok(tA1, 'A（无依赖）被派发');
    const bNow = (await rpcRaw('get-tasks', {})).tasks.find((x) => x.id === bid);
    ok(bNow.status === 'pending', 'B（依赖未满足）保持 pending 不被派发');
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
    await rpcRaw('set-team-mode', { on: false });
  }
};

// ===== 主流程 =====
(async () => {
  // 健康检查：实例可达 + 会话看板可读
  try {
    const st = await rpcRaw('get-tasks', {});
    console.log('实例 ' + BASE + ' | 会话 ' + SID.slice(0, 20) + '… | boardMode=' + st.boardMode + ' teamMode=' + st.teamMode);
  } catch (e) { console.error('实例不可达: ' + e.message); process.exit(1) }

  const names = args.only || Object.keys(scenarios).filter((n) => n !== 'team-flow');
  for (const name of names) {
    if (!scenarios[name]) { console.error('未知场景: ' + name + '（可用: ' + Object.keys(scenarios).join(', ') + '）'); process.exit(1) }
    try { await scenarios[name]() } catch (e) { ok(false, '场景异常: ' + String(e).slice(0, 200)) }
  }
  const pass = results.filter((r) => r.pass).length;
  console.log('\n===== E2E 结果: ' + pass + '/' + results.length + ' 通过 =====');
  results.filter((r) => !r.pass).forEach((r) => console.log('  ❌ ' + r.label));
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1) });
