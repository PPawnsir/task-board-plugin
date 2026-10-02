// research/relay/smoke.cjs
//
// 联邦中继回环冒烟（不起真实 DSH，设计见 docs/FEDERATION.md §11）
// ================================================================
// 同进程内启动 relay 于随机端口（listen(0)），用 HTTP 模拟 1 个 master + 2 个成员：
//   令牌校验 → 注册 → 长轮询唤醒 → 排他 claim（A 成 / B 拒）→ 心跳续租 →
//   A 上报交付物 → master 拉取并断言内容 → approve 验收 →
//   失联回收（B 认领后不心跳，测试参数 2s 心跳 / 6s 租约）→ 回收后可再认领 →
//   越权与终态保护。
// 可重复运行（幂等，每次独立中继实例 + 随机端口）。全绿 exit 0，任一断言失败 exit 1。
//
// 运行：node smoke.cjs

'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

let passed = 0;
let failed = 0;

function assert(cond, name, extra = '') {
  if (cond) { passed += 1; console.log(`  ✅ ${name}`); }
  else { failed += 1; console.error(`  ❌ ${name}${extra ? ` | ${extra}` : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // .cjs 内通过 file:// URL 动态引入 ESM 中继骨架
  const { createRelay } = await import(pathToFileURL(path.join(__dirname, 'relay.mjs')).href);

  // 测试参数：心跳 2s / 租约 6s（= 3 次失联，对应生产默认 30s/90s 的等比缩短），回收器 250ms 一扫
  const TOKEN = 'smoke-token';
  const relay = createRelay({
    token: TOKEN,
    heartbeatIntervalMs: 2_000,
    leaseMs: 6_000,
    reapIntervalMs: 250,
    pollMaxWaitMs: 3_000,
  });
  await new Promise((resolve) => relay.server.listen(0, '127.0.0.1', resolve));
  const port = relay.server.address().port;
  console.log(`[smoke] relay 已启动于随机端口 ${port}（测试租约：心跳 2s / 失联 6s 回收）`);

  const call = async (action, body, token = TOKEN) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-relay-token': token },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  const getState = async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/state`, { headers: { 'x-relay-token': TOKEN } });
    return res.json();
  };

  // ── [0] 共享令牌校验 ─────────────────────────────────────────────
  console.log('\n[0] 共享令牌校验（X-Relay-Token）');
  {
    const r = await call('register', { memberId: 'evil' }, 'wrong-token');
    assert(r.status === 401 && r.json.ok === false, '错误令牌被拒绝（401 bad-token）');
  }

  // ── [1] register：1 个 master + 2 个成员 ─────────────────────────
  console.log('\n[1] register：master 晋级 + 成员 A/B 接入');
  {
    const m = await call('register', { memberId: 'master-1', role: 'master' });
    assert(m.status === 200 && m.json.ok && m.json.role === 'master', 'master 晋级注册成功');
    assert(m.json.leaseMs === 6000 && m.json.heartbeatIntervalMs === 2000, '注册响应回带租约参数（供成员对齐心跳）');
    const a = await call('register', { memberId: 'member-A' });
    const b = await call('register', { memberId: 'member-B' });
    assert(a.json.ok && a.json.role === 'member' && b.json.ok, '成员 A/B 注册成功（默认 role=member）');
  }

  // ── [2] poll 长轮询：空池挂起 → publish 唤醒 ─────────────────────
  console.log('\n[2] poll 长轮询：空池挂起，publish 后立即唤醒');
  let taskId;
  {
    const t0 = Date.now();
    const pollPromise = call('poll', { memberId: 'member-A', waitMs: 2500 }); // 空池挂起
    await sleep(300); // 确认挂起后再发布
    const pub = await call('publish', {
      memberId: 'master-1',
      task: {
        title: '调研：联邦协同协议草案评审',
        description: '输出 Markdown 评审意见',
        payload: { kind: 'review', source: 'docs/FEDERATION.md（内联摘要，v1 禁放本机路径）' },
      },
    });
    assert(pub.status === 201 && pub.json.ok && pub.json.task.status === 'pending', 'master publish 文本任务入池（pending）');
    taskId = pub.json.task.id;
    const polled = await pollPromise;
    const elapsed = Date.now() - t0;
    assert(polled.json.ok && polled.json.tasks.some((t) => t.id === taskId), '长轮询被 publish 唤醒并拿到任务');
    assert(elapsed < 2500, `唤醒延迟 ${elapsed}ms < 挂起上限 2500ms（非超时返回）`);
    const denied = await call('publish', { memberId: 'member-A', task: { title: '越权发布' } });
    assert(denied.status === 403, '非 master publish 被拒绝（403 master-only）');
  }

  // ── [3] claim 排他认领（核心断言 1）──────────────────────────────
  console.log('\n[3] claim：排他认领 + 租约');
  let lease1;
  {
    const claimA = await call('claim', { memberId: 'member-A', taskId });
    assert(claimA.status === 200 && claimA.json.ok && claimA.json.lease.expiresAt > Date.now(), '成员 A claim 成功并挂租约');
    lease1 = claimA.json.lease.expiresAt;
    const claimB = await call('claim', { memberId: 'member-B', taskId });
    assert(claimB.status === 409 && claimB.json.error === 'already-claimed' && claimB.json.claimedBy === 'member-A',
      '成员 B claim 同一任务被拒（409 already-claimed）——排他断言');
  }

  // ── [4] heartbeat 续租 ───────────────────────────────────────────
  console.log('\n[4] heartbeat：持有者续租 / 非持有者拒租');
  {
    await sleep(120); // 拉开时钟，保证租约到期时间可比较
    const hb = await call('heartbeat', { memberId: 'member-A', taskId });
    assert(hb.status === 200 && hb.json.lease.expiresAt > lease1, 'A 心跳续租成功，租约到期时间被延长');
    const hbB = await call('heartbeat', { memberId: 'member-B', taskId });
    assert(hbB.status === 409 && hbB.json.error === 'not-your-lease', 'B 对非本人租约心跳被拒（409 not-your-lease）');
  }

  // ── [5] report + master 拉取交付物 + 验收 ────────────────────────
  console.log('\n[5] report → master poll 拉取交付物 → arbitrate 验收');
  const DELIVERABLE = '# 评审意见\n\n1. 8 动作协议面完整，排他 claim 语义清晰；\n2. 租约 3 次失联回收合理。';
  {
    const rep = await call('report', { memberId: 'member-A', taskId, deliverable: DELIVERABLE, note: '已覆盖 §3/§5' });
    assert(rep.status === 200 && rep.json.status === 'verifying', 'A 上报交付物，任务转 verifying');
    const masterPoll = await call('poll', { memberId: 'master-1', waitMs: 500 });
    const got = masterPoll.json.tasks.find((t) => t.id === taskId);
    assert(masterPoll.json.ok && got && got.status === 'verifying', 'master 长轮询拉到待验收任务');
    assert(got && got.deliverable === DELIVERABLE, 'master 拉取交付物断言：内容与 A 上报逐字一致');
    const approve = await call('arbitrate', { memberId: 'master-1', taskId, verdict: 'approve', answer: '验收通过' });
    assert(approve.status === 200 && approve.json.status === 'done', 'master arbitrate(approve) → done 终态');
    const late = await call('release', { memberId: 'member-A', taskId });
    assert(late.status === 409 && late.json.error === 'terminal', '终态任务拒绝 release（409 terminal）');
  }

  // ── [6] 失联回收（核心断言 2）────────────────────────────────────
  console.log('\n[6] 失联回收：B 认领后不心跳（租约 6s），任务回收重入池');
  {
    const pub2 = await call('publish', { memberId: 'master-1', task: { title: '方案：团队看板接入指引' } });
    const task2 = pub2.json.task.id;
    const claimB = await call('claim', { memberId: 'member-B', taskId: task2 });
    assert(claimB.status === 200 && claimB.json.ok, 'B claim 任务 2 成功（随后模拟失联，不发心跳）');

    // 轮询 state 直至回收（租约 6s + 回收器 250ms，给 15s 上限兜底）
    const deadline = Date.now() + 15_000;
    let reaped = null;
    let waitedMs = 0;
    const t0 = Date.now();
    while (Date.now() < deadline) {
      const s = await getState();
      reaped = s.tasks.find((t) => t.id === task2);
      if (reaped && reaped.status === 'pending' && reaped.claimedBy === null) { waitedMs = Date.now() - t0; break; }
      await sleep(300);
    }
    assert(reaped && reaped.status === 'pending' && reaped.claimedBy === null,
      `失联约 ${waitedMs}ms 后任务被回收重入池（pending，无认领者）——失联回收断言`);
    assert(reaped && reaped.lostContacts >= 1, `失联计数已记录（lostContacts=${reaped && reaped.lostContacts}），master 可识别烫手任务`);
    assert(waitedMs >= 6_000, `回收发生在租约到期之后（${waitedMs}ms ≥ 6000ms），未提前误收`);

    const reclaim = await call('claim', { memberId: 'member-A', taskId: task2 });
    assert(reclaim.status === 200 && reclaim.json.ok, '回收后任务可被其他成员重新认领');
    const rel = await call('release', { memberId: 'member-A', taskId: task2 });
    assert(rel.status === 200 && rel.json.status === 'pending', '认领者主动 release，任务回池');
    const cancelDenied = await call('cancel', { memberId: 'member-A', taskId: task2 });
    assert(cancelDenied.status === 403, '非 master cancel 被拒绝（403）');
    const cancel = await call('cancel', { memberId: 'master-1', taskId: task2 });
    assert(cancel.status === 200 && cancel.json.status === 'cancelled', 'master cancel → cancelled 终态');
  }

  // ── 收尾 ─────────────────────────────────────────────────────────
  relay.server.close();
  console.log(`\n[smoke] 断言通过 ${passed} / ${passed + failed}`);
  if (failed === 0) console.log('[smoke] ALL GREEN ✅');
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[smoke] 未捕获异常:', err);
    process.exit(1);
  });
