// research/relay/relay.mjs
//
// 联邦协同中继骨架（预研 POC，设计文档见 docs/FEDERATION.md）
// ============================================================
// 零依赖单文件 Node 中继：仅用 node 内置模块（http / crypto / url）。
// 内存态不落盘，可丢失——任务事实源在各实例本地看板文件（§2 晋级语义）。
//
// 协议面（全部 POST /v1/<action>，请求头 X-Relay-Token 携带共享令牌）：
//   register   成员/主控注册（幂等 upsert），返回租约参数
//   poll       长轮询：成员拉 pending 任务；master 拉 verifying/blocked 任务
//   claim      排他认领：成功挂租约；已被认领返回 409
//   heartbeat  心跳续租（同时刷新成员存活时间）
//   report     成员上报：verifying（交付待验收）/ blocked（阻塞待裁决）
//   arbitrate  【master 专用】裁决：answer / approve / reject / requeue
//   cancel     【master 专用】取消任务（终态）
//   release    释放认领回池（认领者本人或 master）
// 补充端点（不计入成员协议 8 动作）：
//   POST /v1/publish  【master 专用】把本地看板已发布任务镜像进联邦池（幂等 upsert）
//   GET  /v1/state    POC 调试观测端点（需令牌）
//
// CLI：node relay.mjs [--port=0] [--token=xxx] [--lease-ms=90000] [--heartbeat-ms=30000]

import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

// ---------- 默认配置（对应 FEDERATION.md §5 租约参数推荐默认值 / D3 决策点） ----------
const DEFAULT_CONFIG = {
  token: 'dev-federation-token', // 共享令牌：POC 默认值，实际部署必须替换（§9 信任模型）
  heartbeatIntervalMs: 30_000,   // 心跳间隔：认领期间成员每 30s 续租一次
  leaseMs: 90_000,               // 租约时长：3 次心跳失联（90s）即回收任务重入池
  pollMaxWaitMs: 15_000,         // 长轮询单次挂起上限
  reapIntervalMs: 1_000,         // 失联回收器扫描间隔
  maxBodyBytes: 1_048_576,       // 请求体上限 1MB（v1 纯文本交付物足够）
};

const TERMINAL = new Set(['done', 'cancelled']); // 终态：不再参与认领/回收

/**
 * 创建中继实例（不自动 listen，由调用方决定端口；smoke 用 listen(0) 拿随机端口）。
 * @param {Partial<typeof DEFAULT_CONFIG>} userConfig
 * @returns {{ server: http.Server, config: object, tasks: Map, members: Map }}
 */
export function createRelay(userConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...userConfig };

  // ---------- 内存态：任务表 / 成员表（租约字段内嵌在任务上）/ 长轮询挂起者 ----------
  const tasks = new Map();   // taskId → 任务记录（claimedBy / leaseExpiresAt 即租约）
  const members = new Map(); // memberId → { id, role, boardUrl, registeredAt, lastSeenAt }
  const waiters = new Set(); // 长轮询挂起中的 { res, role, timer }

  const now = () => Date.now();

  // ---------- 令牌校验：常数时间比较，防时序侧信道 ----------
  function tokenOk(provided) {
    const a = Buffer.from(String(provided ?? ''), 'utf8');
    const b = Buffer.from(String(config.token), 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function sendJson(res, status, obj) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  }

  // 任务视图：成员视角不含交付物；master 视角含交付物/上报备注/裁决日志
  function taskView(task, forMaster) {
    const view = {
      id: task.id,
      title: task.title,
      description: task.description,
      payload: task.payload,
      status: task.status,
      publishedBy: task.publishedBy,
      publishedAt: task.publishedAt,
      claimedBy: task.claimedBy,
      leaseExpiresAt: task.leaseExpiresAt,
      lostContacts: task.lostContacts,
    };
    if (forMaster) {
      view.deliverable = task.deliverable;
      view.reportNote = task.reportNote;
      view.arbitration = task.arbitration;
    }
    return view;
  }

  // 角色关心的队列：member → 待认领 pending；master → 待验收 verifying / 待裁决 blocked
  function attentionTasks(role) {
    const out = [];
    for (const task of tasks.values()) {
      if (role === 'master') {
        if (task.status === 'verifying' || task.status === 'blocked') out.push(taskView(task, true));
      } else if (task.status === 'pending') {
        out.push(taskView(task, false));
      }
    }
    return out;
  }

  // 有新任务入池/回池/上报时，唤醒符合条件的长轮询挂起者
  function flushWaiters() {
    for (const waiter of [...waiters]) {
      const list = attentionTasks(waiter.role);
      if (list.length > 0) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        sendJson(waiter.res, 200, { ok: true, tasks: list });
      }
    }
  }

  // ---------- 租约回收器：claimed/blocked 且租约过期 → 回池 pending，lostContacts+1 ----------
  const reaper = setInterval(() => {
    const t = now();
    for (const task of tasks.values()) {
      if ((task.status === 'claimed' || task.status === 'blocked')
        && task.leaseExpiresAt !== null && task.leaseExpiresAt <= t) {
        task.history.push({ at: t, event: 'lease-expired', member: task.claimedBy });
        task.status = 'pending';
        task.claimedBy = null;
        task.leaseExpiresAt = null;
        task.lostContacts += 1;
      }
    }
    flushWaiters();
  }, config.reapIntervalMs);
  reaper.unref?.(); // 不阻止进程退出（server 本身会保持存活；smoke 显式 close + exit）

  // 读取 JSON 请求体（限长，防内存放大）
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > config.maxBodyBytes) { reject(new Error('body-too-large')); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
        catch { reject(new Error('bad-json')); }
      });
      req.on('error', reject);
    });
  }

  function getTask(res, id) {
    const task = tasks.get(id);
    if (!task) { sendJson(res, 404, { ok: false, error: 'task-not-found' }); return null; }
    return task;
  }

  const isMaster = (memberId) => members.get(memberId)?.role === 'master';
  const isRegistered = (memberId) => members.has(memberId);

  // ---------- 8 动作 + publish 注入 ----------
  const handlers = {

    // register：成员/主控注册（幂等 upsert），回带租约参数供成员对齐心跳节奏
    register(res, body) {
      if (!body.memberId) return sendJson(res, 400, { ok: false, error: 'memberId-required' });
      const m = members.get(body.memberId) ?? { id: body.memberId, registeredAt: now() };
      m.role = body.role === 'master' ? 'master' : 'member';
      m.boardUrl = body.boardUrl ?? m.boardUrl ?? null;
      m.lastSeenAt = now();
      members.set(m.id, m);
      return sendJson(res, 200, {
        ok: true, memberId: m.id, role: m.role,
        heartbeatIntervalMs: config.heartbeatIntervalMs, leaseMs: config.leaseMs,
      });
    },

    // publish【master 专用，补充端点】：镜像本地已发布任务入联邦池；携带 id 时幂等 upsert（master 重启恢复用）
    publish(res, body) {
      if (!isMaster(body.memberId)) return sendJson(res, 403, { ok: false, error: 'master-only' });
      if (!body.task?.title) return sendJson(res, 400, { ok: false, error: 'task.title-required' });
      const incoming = body.task;
      const existing = incoming.id ? tasks.get(incoming.id) : null;
      if (existing) {
        // 幂等恢复：仅终态/在途任务不覆盖执行现场，只刷新静态字段
        existing.title = incoming.title;
        existing.description = incoming.description ?? existing.description;
        existing.payload = incoming.payload ?? existing.payload;
        existing.history.push({ at: now(), event: 'republished', member: body.memberId });
        return sendJson(res, 200, { ok: true, task: taskView(existing, true) });
      }
      const task = {
        id: incoming.id ?? crypto.randomUUID(),
        title: incoming.title,
        description: incoming.description ?? '',
        payload: incoming.payload ?? null, // 文本任务输入材料（v1 仅内联文本/JSON，禁放本机路径）
        status: 'pending',
        publishedBy: body.memberId,
        publishedAt: now(),
        claimedBy: null,
        leaseExpiresAt: null,
        lostContacts: 0,
        deliverable: null,
        reportNote: null,
        arbitration: [],
        history: [{ at: now(), event: 'published', member: body.memberId }],
      };
      tasks.set(task.id, task);
      flushWaiters();
      return sendJson(res, 201, { ok: true, task: taskView(task, true) });
    },

    // poll：长轮询。成员拉 pending；master 拉 verifying/blocked（含交付物）。池空挂起至有货或超时。
    poll(res, body) {
      const member = members.get(body.memberId);
      if (!member) return sendJson(res, 404, { ok: false, error: 'member-not-registered' });
      member.lastSeenAt = now();
      const role = member.role;
      const list = attentionTasks(role);
      if (list.length > 0) return sendJson(res, 200, { ok: true, tasks: list });
      const waitMs = Math.min(Math.max(Number(body.waitMs) || 0, 0), config.pollMaxWaitMs);
      const waiter = { res, role, timer: null };
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        if (!res.writableEnded) sendJson(res, 200, { ok: true, tasks: attentionTasks(role) });
      }, waitMs);
      waiters.add(waiter);
      // 客户端提前断连时清理挂起者，避免泄漏
      res.on('close', () => {
        if (!res.writableEnded && waiters.has(waiter)) {
          clearTimeout(waiter.timer);
          waiters.delete(waiter);
        }
      });
      return undefined;
    },

    // claim：排他认领 + 挂租约（同一时刻全池只有一个持有者）
    claim(res, body) {
      if (!isRegistered(body.memberId)) return sendJson(res, 404, { ok: false, error: 'member-not-registered' });
      const task = getTask(res, body.taskId); if (!task) return undefined;
      if (task.status !== 'pending') {
        return sendJson(res, 409, {
          ok: false, error: 'already-claimed', claimedBy: task.claimedBy, status: task.status,
        });
      }
      task.status = 'claimed';
      task.claimedBy = body.memberId;
      task.leaseExpiresAt = now() + config.leaseMs;
      task.history.push({ at: now(), event: 'claimed', member: body.memberId });
      return sendJson(res, 200, {
        ok: true, taskId: task.id,
        lease: {
          expiresAt: task.leaseExpiresAt,
          leaseMs: config.leaseMs,
          heartbeatIntervalMs: config.heartbeatIntervalMs,
        },
      });
    },

    // heartbeat：续租（带 taskId，须为持有者）/ 纯存活心跳（不带 taskId）
    heartbeat(res, body) {
      const member = members.get(body.memberId);
      if (member) member.lastSeenAt = now();
      if (!body.taskId) return sendJson(res, 200, { ok: true });
      const task = getTask(res, body.taskId); if (!task) return undefined;
      if (task.claimedBy !== body.memberId || (task.status !== 'claimed' && task.status !== 'blocked')) {
        return sendJson(res, 409, {
          ok: false, error: 'not-your-lease', status: task.status, claimedBy: task.claimedBy,
        });
      }
      task.leaseExpiresAt = now() + config.leaseMs;
      return sendJson(res, 200, { ok: true, lease: { expiresAt: task.leaseExpiresAt } });
    },

    // report：上报交付物（verifying，v1 纯文本）或阻塞升级（blocked，保持租约等 master 答疑）
    report(res, body) {
      const task = getTask(res, body.taskId); if (!task) return undefined;
      if (task.claimedBy !== body.memberId || (task.status !== 'claimed' && task.status !== 'blocked')) {
        return sendJson(res, 409, {
          ok: false, error: 'not-your-task', status: task.status, claimedBy: task.claimedBy,
        });
      }
      if (body.status === 'blocked') {
        task.status = 'blocked';
        task.reportNote = body.note ?? null;
        task.history.push({ at: now(), event: 'blocked', member: body.memberId });
      } else {
        task.status = 'verifying';
        task.deliverable = body.deliverable ?? null; // v1：Markdown 纯文本交付物
        task.reportNote = body.note ?? null;
        task.leaseExpiresAt = null; // 交付后租约结束，验收权移交 master
        task.history.push({ at: now(), event: 'reported', member: body.memberId });
      }
      flushWaiters(); // 唤醒 master 的 poll
      return sendJson(res, 200, { ok: true, taskId: task.id, status: task.status });
    },

    // arbitrate【master 专用】：answer 答疑续作 / approve 验收通过 / reject 打回重做 / requeue 强制回池
    arbitrate(res, body) {
      if (!isMaster(body.memberId)) return sendJson(res, 403, { ok: false, error: 'master-only' });
      const task = getTask(res, body.taskId); if (!task) return undefined;
      if (TERMINAL.has(task.status)) return sendJson(res, 409, { ok: false, error: 'terminal', status: task.status });
      const verdict = body.verdict ?? 'answer';
      task.arbitration.push({ at: now(), verdict, answer: body.answer ?? null, by: body.memberId });
      task.history.push({ at: now(), event: `arbitrate:${verdict}`, member: body.memberId });
      if (verdict === 'approve') {
        task.status = 'done';
        task.leaseExpiresAt = null;
      } else if (verdict === 'reject') {
        // 打回原认领者重做；认领者已失联则直接回池
        if (task.claimedBy) { task.status = 'claimed'; task.leaseExpiresAt = now() + config.leaseMs; }
        else task.status = 'pending';
      } else if (verdict === 'requeue') {
        task.status = 'pending';
        task.claimedBy = null;
        task.leaseExpiresAt = null;
      } else { // answer：阻塞答疑，回到 claimed 由原认领者继续（新租约）
        task.status = 'claimed';
        task.leaseExpiresAt = now() + config.leaseMs;
      }
      flushWaiters();
      return sendJson(res, 200, { ok: true, taskId: task.id, status: task.status });
    },

    // cancel【master 专用】：取消任务（终态）
    cancel(res, body) {
      if (!isMaster(body.memberId)) return sendJson(res, 403, { ok: false, error: 'master-only' });
      const task = getTask(res, body.taskId); if (!task) return undefined;
      task.status = 'cancelled';
      task.claimedBy = null;
      task.leaseExpiresAt = null;
      task.history.push({ at: now(), event: 'cancelled', member: body.memberId });
      return sendJson(res, 200, { ok: true, taskId: task.id, status: task.status });
    },

    // release：认领者本人或 master 主动释放，任务回池 pending
    release(res, body) {
      const task = getTask(res, body.taskId); if (!task) return undefined;
      if (task.claimedBy !== body.memberId && !isMaster(body.memberId)) {
        return sendJson(res, 403, { ok: false, error: 'not-your-task', claimedBy: task.claimedBy });
      }
      if (TERMINAL.has(task.status)) return sendJson(res, 409, { ok: false, error: 'terminal', status: task.status });
      task.status = 'pending';
      task.claimedBy = null;
      task.leaseExpiresAt = null;
      task.history.push({ at: now(), event: 'released', member: body.memberId });
      flushWaiters();
      return sendJson(res, 200, { ok: true, taskId: task.id, status: task.status });
    },
  };

  const server = http.createServer(async (req, res) => {
    try {
      // 全部端点（含 state）都要求共享令牌
      if (!tokenOk(req.headers['x-relay-token'])) {
        return sendJson(res, 401, { ok: false, error: 'bad-token' });
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      // GET /v1/state：POC 调试观测端点
      if (req.method === 'GET' && url.pathname === '/v1/state') {
        return sendJson(res, 200, {
          ok: true,
          config: { heartbeatIntervalMs: config.heartbeatIntervalMs, leaseMs: config.leaseMs },
          members: [...members.values()],
          tasks: [...tasks.values()].map((t) => taskView(t, true)),
        });
      }
      const match = /^\/v1\/([a-z]+)$/.exec(url.pathname);
      const action = match?.[1];
      if (req.method !== 'POST' || !action || !(action in handlers)) {
        return sendJson(res, 404, { ok: false, error: 'unknown-endpoint' });
      }
      const body = await readBody(req);
      return handlers[action](res, body);
    } catch (err) {
      const msg = err?.message === 'body-too-large' ? 'body-too-large'
        : err?.message === 'bad-json' ? 'bad-json' : 'internal-error';
      return sendJson(res, msg === 'internal-error' ? 500 : 400, { ok: false, error: msg });
    }
  });

  return { server, config, tasks, members };
}

// ---------- CLI：node relay.mjs [--port=0] [--token=xxx] [--lease-ms=90000] ----------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = Object.fromEntries(
    process.argv.slice(2)
      .filter((a) => a.startsWith('--'))
      .map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; }),
  );
  const relay = createRelay({
    ...(args.token ? { token: String(args.token) } : {}),
    ...(args['lease-ms'] ? { leaseMs: Number(args['lease-ms']) } : {}),
    ...(args['heartbeat-ms'] ? { heartbeatIntervalMs: Number(args['heartbeat-ms']) } : {}),
  });
  const port = Number(args.port ?? 0); // 默认随机端口
  relay.server.listen(port, '127.0.0.1', () => {
    const actual = relay.server.address().port;
    const tokenHint = relay.config.token === DEFAULT_CONFIG.token ? '默认开发令牌（务必替换）' : '自定义令牌';
    console.log(`[relay] 联邦中继已启动: http://127.0.0.1:${actual}（${tokenHint}）`);
    console.log(`[relay] 租约参数: 心跳 ${relay.config.heartbeatIntervalMs}ms / 租约 ${relay.config.leaseMs}ms（3 次失联回收）`);
  });
}
