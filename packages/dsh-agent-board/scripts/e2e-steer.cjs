// steer 干预通道 E2E：Worker 干活中途 intervene，断言
//   1) RPC 返回 channel === 'steer'（v1.2.4 新通道；老代码只会 followup）
//   2) 干预消息在 Worker 当前 turn 内被消费（日志出现 user/message kind=plugin:dsh-agent-board），
//      且从发起到消费 < 90s（followup 要等整 turn 结束，会是分钟级）
//   3) Worker 最终上报内容含干预里要求的标记（证明指令真的被执行）
// 用法：node scripts/e2e-steer.cjs --session <id> [--base http://127.0.0.1:3080]
const http = require('http');
const fs = require('fs');
const zlib = require('node:zlib');
const os = require('os');
const path = require('path');

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

// 读 Worker 会话日志（v4 文件名优先），返回 [消费时间ms|null, 当前turn数]
function workerLogState(runId) {
  const root = path.join(os.homedir(), '.dsh', 'sessions');
  const names = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.jsonl.zstd'];
  let file = null;
  for (const bucket of fs.readdirSync(root)) {
    for (const n of names) {
      const cand = path.join(root, bucket, runId, n);
      if (fs.existsSync(cand)) { file = cand; break }
    }
    if (file) break;
  }
  if (!file) return { consumedAt: null, turns: 0, found: false };
  const buf = fs.readFileSync(file);
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  let idx = [], i = -1;
  while ((i = buf.indexOf(MAGIC, i + 1)) >= 0) idx.push(i);
  let consumedAt = null, turns = 0;
  for (const off of idx) {
    let text; try { text = zlib.zstdDecompressSync(buf.subarray(off)).toString('utf8') } catch (_) { continue }
    for (const line of text.split('\n')) {
      if (!line) continue; let e; try { e = JSON.parse(line) } catch (_) { continue }
      if (e.type === 'turn/start') turns++;
      if (e.type === 'user/message') {
        const src = (e.data.source || {}).kind || '';
        const txt = (e.data.content || []).map((b) => b.text || '').join(' ');
        if (src === 'plugin:dsh-agent-board' && txt.includes('STEER-MARKER')) consumedAt = e.time;
      }
    }
  }
  return { consumedAt, turns, found: true };
}

(async () => {
  console.log('[steer] 干预通道 E2E（目标实例 ' + BASE + '）');
  await rpc('set-board-mode', { mode: 'auto' });
  const marker = 'STEER-MARKER-' + Date.now().toString(36);
  // 让 Worker 有几步真实工作（读几个文件），保证干预落在 turn 进行中
  const r = await rpc('create-task', {
    title: 'E2E steer ' + new Date().toISOString().slice(11, 19),
    description: '依次做五件事再上报（每步都必须真实读文件，不许跳步）：①读 packages/dsh-agent-board/README.md 并总结一句话；②读 packages/dsh-agent-board/package.json 并总结一句话；③读 docs/PACKAGING.md 前 50 行并总结一句话；④读 packages/dsh-agent-board/lib/core.mjs 前 60 行并总结一句话；⑤读 packages/dsh-agent-board/index.mjs 前 60 行并总结一句话。全部完成后才允许调用 board_report 上报。',
    pipeline: 'work',
  });
  const id = r.task && r.task.id;
  if (!ok(id, '任务创建成功')) { process.exit(1) }

  // 等派发 + Worker 进入工作中
  let t = null, deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const d = await rpc('get-tasks', {});
    t = (d.tasks || []).find((x) => x.id === id);
    if (t && t.status === 'in-progress' && t.claimedBy && t.claimedBy !== 'spawn-pending') break;
    await sleep(5000);
  }
  if (!ok(t && t.status === 'in-progress', 'Worker 已派发（runId=' + (t && t.claimedBy || '-').slice(0, 8) + '…)')) { process.exit(1) }
  const runId = t.claimedBy;
  await sleep(5000); // flash 模型也可能 17s 内完工——一确认 in-progress 就尽快干预，只留 5s 让 turn 起步

  const t0 = Date.now();
  const iv = await rpc('intervene-agent', { taskId: id, message: '插一条高优指令：在上报时的 selfTest 字段里带上标记 ' + marker + '（原样照抄即可），其余工作不变。' });
  ok(iv.ok === true && iv.delivered === true, '干预已投递（delivered=true）');
  ok(iv.channel === 'steer', '干预走 steer 通道（channel=' + iv.channel + '）');

  // 等任务完成
  deadline = Date.now() + 480000;
  let done = null;
  while (Date.now() < deadline) {
    const d = await rpc('get-tasks', {});
    const cur = (d.tasks || []).find((x) => x.id === id);
    if (cur && cur.status === 'resolved') { done = cur; break }
    await sleep(10000);
  }
  ok(done, '任务最终 resolved');

  // 干预消费时点：turn 进行中（<90s）即证明 steer 生效；followup 要等整 turn
  const st = workerLogState(runId);
  if (ok(st.found, '找到 Worker 会话日志')) {
    if (st.consumedAt) {
      const cost = ((st.consumedAt - t0) / 1000).toFixed(0);
      ok(st.consumedAt - t0 < 90000, '干预在 ' + cost + 's 内被消费（turn 进行中，steer 生效）');
    } else ok(false, '日志中未找到干预消息（plugin:dsh-agent-board / ' + marker + '）');
  }
  if (done) {
    // 只查 deliverable：messages 里本来就有干预原文，含标记是必然，会假阳性
    const all = JSON.stringify(done.deliverable || {});
    ok(all.includes(marker), 'Worker 上报内容含干预标记（指令被真实执行）');
  }
  await rpc('archive-task', { taskId: id });
  const pass = results.filter(Boolean).length;
  console.log('\n===== steer E2E: ' + pass + '/' + results.length + ' 通过 =====');
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1) });
