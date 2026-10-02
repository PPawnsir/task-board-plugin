// touches 文件排他 + 裁决 hold/freeze 专项 E2E（v1.4.0 新功能）
// 场景 T：重叠 touches 的任务 B 在 A in-progress 期间被拦截（waitingForTouches 标注），
//         A 进 verifying（停笔不持锁）后 B 自动放行；最终双双 resolved。
// 场景 F：手动派发遇 touches 冲突返回 touches-conflict；force:true 越权强派。
// 场景 H：Worker 上报歧义 → resolve-escalation action=hold 冻结（不自动重派）→
//         观察 ≥40s 不被派发 → unfreeze-task 解冻 → 自动派发至 resolved。
// 用法：node scripts/e2e-touches-freeze.cjs --session <id> [--base http://127.0.0.1:3080]
const http = require('http');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--session') args.session = process.argv[++i];
  else if (process.argv[i] === '--base') args.base = process.argv[++i];
}
const BASE = args.base || 'http://127.0.0.1:3080';
const SID = args.session;
if (!SID) { console.error('缺少 --session'); process.exit(1) }

function rpc(method, rpcArgs) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ method, args: Object.assign({}, rpcArgs, { sessionId: SID }) }), 'utf8');
    const req = http.request(BASE + '/dsh-agent-board', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } }, (res) => {
      const cs = []; res.on('data', (c) => cs.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(cs).toString('utf8'))) } catch (e) { reject(new Error('bad json')) } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function ok(cond, label) { results.push(!!cond); console.log((cond ? '  ✅ ' : '  ❌ ') + label); return !!cond }
async function getTask(id) { const d = await rpc('get-tasks', {}); return (d.tasks || []).find((x) => x.id === id) }
async function waitFor(id, pred, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const t = await getTask(id);
    if (t && pred(t)) return t;
    await sleep(5000);
  }
  return null;
}
const stamp = Date.now().toString(36);

(async () => {
  console.log('[touches+freeze] 专项 E2E（目标实例 ' + BASE + '）');
  await rpc('set-board-mode', { mode: 'auto' });

  // ===== 场景 T：重叠 touches 拦截 + verifying 放行 =====
  console.log('\n[T] 重叠 touches：A 持锁期间 B 被拦，A 停笔后 B 放行');
  const lockDir = 'e2e-lock-' + stamp;
  const ra = await rpc('create-task', {
    title: 'E2E touches A ' + stamp,
    description: '依次真实读 5 个文件并各总结一句话（不许跳步）：①packages/dsh-agent-board/README.md ②packages/dsh-agent-board/package.json ③docs/PACKAGING.md 前 40 行 ④packages/dsh-agent-board/lib/core.mjs 前 60 行 ⑤packages/dsh-agent-board/index.mjs 前 60 行。全部完成后才允许 board_report 上报。不要写任何文件。',
    pipeline: 'work',
    touches: [lockDir + '/a.txt'],
  });
  const rb = await rpc('create-task', {
    title: 'E2E touches B ' + stamp,
    description: '立即调用 board_report 上报完成（什么都不用做）。',
    pipeline: 'work',
    touches: [lockDir + '/**'],
  });
  const A = ra.task && ra.task.id, B = rb.task && rb.task.id;
  if (!ok(A && B, 'A/B 创建成功（touches 已声明）')) process.exit(1);

  // 高频轮询抓瞬时状态：A 持锁期间 B 必须 pending 且 waitingForTouches 含 A
  let aHeld = null, bBlockedSeen = null;
  const tDeadline = Date.now() + 180000;
  while (Date.now() < tDeadline && !(aHeld && bBlockedSeen)) {
    const [ta, tb] = await Promise.all([getTask(A), getTask(B)]);
    if (ta && ta.status === 'in-progress' && ta.claimedBy && ta.claimedBy !== 'spawn-pending') {
      aHeld = ta;
      if (tb && tb.status === 'pending' && Array.isArray(tb.waitingForTouches) && tb.waitingForTouches.includes(A)) bBlockedSeen = tb;
    }
    if (ta && (ta.status === 'verifying' || ta.status === 'resolved')) break;
    await sleep(2000);
  }
  ok(aHeld, 'A 已派发（持锁）');
  ok(bBlockedSeen, 'B 被 touches 拦截（A 持锁期间 waitingForTouches 含 A）');
  ok(aHeld && bBlockedSeen && bBlockedSeen.status === 'pending' && aHeld.status === 'in-progress', '拦截瞬间语义正确（A in-progress / B pending）');
  // A 进 verifying/resolved 后 B 放行
  const bFreed = await waitFor(B, (t) => t.status === 'in-progress' || t.status === 'resolved' || t.status === 'verifying', 300000, 'B 放行');
  const aState = await getTask(A);
  ok(bFreed, 'A 停笔（' + (aState && aState.status) + '）后 B 放行（' + (bFreed && bFreed.status) + '）');
  const aDone = await waitFor(A, (t) => t.status === 'resolved', 300000);
  const bDone = await waitFor(B, (t) => t.status === 'resolved', 300000);
  ok(aDone && bDone, 'A/B 最终双双 resolved');

  // ===== 场景 F：手动派发冲突 + force 越权 =====
  console.log('\n[F] 手动派发冲突返回 touches-conflict，force 越权');
  const flock = 'e2e-force-' + stamp + '/x.txt';
  const rc = await rpc('create-task', {
    title: 'E2E force C ' + stamp,
    description: '依次真实读 3 个文件并各总结一句话（不许跳步）：①packages/dsh-agent-board/README.md ②docs/PACKAGING.md 前 40 行 ③packages/dsh-agent-board/lib/core.mjs 前 60 行。全部完成后才允许 board_report 上报。不要写任何文件。',
    pipeline: 'work',
    touches: [flock],
  });
  const rd = await rpc('create-task', {
    title: 'E2E force D ' + stamp,
    description: '立即调用 board_report 上报完成（什么都不用做）。',
    pipeline: 'work',
    touches: [flock],
  });
  const C = rc.task && rc.task.id, D = rd.task && rd.task.id;
  ok(C && D, 'C/D 创建成功');
  const cRun = await waitFor(C, (t) => t.status === 'in-progress' && t.claimedBy && t.claimedBy !== 'spawn-pending', 90000);
  ok(cRun, 'C 已派发（持锁），D 被自动派发器拦截');
  const disp = await rpc('dispatch-task', { taskId: D });
  ok(disp && disp.ok === false && disp.error === 'touches-conflict' && Array.isArray(disp.conflicts) && disp.conflicts.includes(C), '手动派发 D 被拒（touches-conflict + conflicts 含 C）');
  const forced = await rpc('dispatch-task', { taskId: D, force: true });
  ok(forced && forced.ok === true, 'force:true 越权强派成功');
  const dRun = await waitFor(D, (t) => t.status === 'in-progress' || t.status === 'resolved', 60000);
  ok(dRun, 'D 越权后进入执行（与 C 并行，人工兜底语义）');
  const cDone = await waitFor(C, (t) => t.status === 'resolved', 300000);
  const dDone = await waitFor(D, (t) => t.status === 'resolved', 300000);
  ok(cDone && dDone, 'C/D 最终 resolved');

  // ===== 场景 H：裁决 hold 冻结 + unfreeze 解冻 =====
  console.log('\n[H] 裁决 hold 冻结 → 不自动重派 → unfreeze 解冻续跑');
  const rh = await rpc('create-task', {
    title: 'E2E hold H ' + stamp,
    description: '立即调用 board_report（kind=escalate, taskId=本任务id）上报歧义，question 写「E2E hold 测试」。不要做任何其他事。',
    pipeline: 'work',
  });
  const H = rh.task && rh.task.id;
  ok(H, 'H 创建成功');
  const hEsc = await waitFor(H, (t) => !!t.escalation, 180000, 'H 上报歧义');
  ok(hEsc, 'H 歧义到达（escalation 就位）');
  const arb = await rpc('resolve-escalation', { taskId: H, answer: '无需额外信息，直接按完成契约上报完成即可（这是 E2E 占位任务）。', action: 'hold' });
  ok(arb && arb.ok === true, 'resolve-escalation action=hold 成功');
  const hFrozen = await getTask(H);
  ok(hFrozen && hFrozen.status === 'pending' && hFrozen.frozen === true, 'H 回 pending 且 frozen=true');
  await sleep(40000); // ≥2 次心跳，验证不被自动重派
  const hStill = await getTask(H);
  ok(hStill && hStill.status === 'pending' && hStill.frozen === true, '40s（≥2 心跳）后 H 仍冻结未派发');
  const unf = await rpc('unfreeze-task', { taskId: H });
  ok(unf && unf.ok === true, 'unfreeze-task 解冻成功');
  const hDone = await waitFor(H, (t) => t.status === 'resolved', 300000, 'H 解冻后派发并完成');
  ok(hDone, 'H 解冻后自动派发至 resolved');
  const hFinal = await getTask(H);
  ok(!!(hDone && hFinal && hFinal.status === 'resolved' && !hFinal.frozen), 'resolved 后 frozen 残留已清理');

  // 清理
  for (const id of [A, B, C, D, H]) { try { await rpc('archive-task', { taskId: id }) } catch (_) {} }
  const pass = results.filter(Boolean).length;
  console.log('\n===== touches+freeze E2E: ' + pass + '/' + results.length + ' 通过 =====');
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1) });
