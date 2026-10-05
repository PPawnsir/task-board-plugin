// dsh-agent-board — 看板持久化层（lib/store.mjs）
// createStore(ctx, state, deps)：家目录绝对路径直读写 / 原子写盘（tmp+rename+瞬时占用退避）/
// 跨重启继承（唯一孤儿板接管）/ 每会话文件锁串行化读-改-写 / mutateLocked + kickCycle 派发触发。
// deps.poolCycle 为晚绑定（index.mjs 在 dispatch 创建后收口）：kickCycle 经 50ms 去抖才调用，
// 而 kickCycle 只可能被工具/RPC/心跳写盘触发（全部发生在 apply 接线完成之后），晚绑定无窗口风险。
import * as core from './core.mjs'
import path from 'node:path'
import fsNode from 'node:fs'
const { seed, normalizeBoard, vt, boardHome } = core

export function createStore(ctx, state, deps) {
    var sessionCwd = deps.sessionCwd
    // 共享状态别名（本体由 index.mjs apply 统一构建并逐模块注入）
    var teamModeCache = state.teamModeCache
    var feedbackCache = state.feedbackCache
    var epicSplitCache = state.epicSplitCache
    var fileLocks = state.fileLocks
    var cyclePending = state.cyclePending

    // 看板文件用「家目录绝对路径 + node:fs」直读写——不再走 fs 服务的相对路径解析
    // （fs 服务的相对路径解析根 = 进程启动 cwd，cwd 一变所有看板静默读成空板；
    //  曾因此导致整个看板状态异常。绝对路径对此永久免疫）
    function boardPath(sid) { return path.join(boardHome(), 'tasks-' + sid + '.json') }
    function fileFor(sid) { return boardPath(sid) } // 保留旧名兼容调用点，但已是绝对路径

    // ===== 看板跨重启继承（会话根 id 漂移 → 不分裂）=====
    // 背景（看板反馈 n-mur1bmrwvoge）：DSH 重启后同一会话在宿主侧的根 id 可能变
    // （实测 55b0879a → 7b44fb23），看板按 ownerSession 分文件 → 新卡落新板，
    // 旧板（73 张卡历史）从默认视图消失，用户视角就是「看板被清空了」。
    // 归属改为「工作区」：文件里记 ownerCwd；以新 sid 访问且本 sid 无文件时，
    // 若同工作区存在**唯一**「原主已死（不在 agents.roots()）」的看板 → 接管它。
    // 防误继承三闸门：① 只认 ownerCwd 严格相等；② 原主必须不在存活 root 集合里；
    // ③ 候选必须唯一 —— 多候选一律不动（宁可留孤儿板等人工认领，也不合并错板）。
    // 触发点在 rt() 的「文件不存在」分支：工具 / RPC / UI 三通道都走 rt，天然统一受益。
    function activeRootIds() { try { var rs = ctx.agents && ctx.agents.roots(); var s = {}; if (Array.isArray(rs)) for (var i = 0; i < rs.length; i++) s[String(rs[i].id)] = true; return s } catch (_) { return {} } }
    // 找可接管的孤儿看板：返回文件名，或 null（含「多候选」——多候选刻意返回 null）
    function findAdoptableBoardFile(sid, cwd) {
      if (!cwd) return null                                  // 本会话工作区未知 → 绝不猜（猜错就是合并错板）
      var home = boardHome()
      var files
      try { files = fsNode.readdirSync(home) } catch (_) { return null }
      var alive = activeRootIds()
      var hits = []
      for (var i = 0; i < files.length; i++) {
        var f = String(files[i] || '')
        if (f.indexOf('tasks-') !== 0 || f.slice(-5) !== '.json') continue
        var owner = f.slice(6, -5)
        if (!owner || owner === sid) continue                // 本 sid 的文件不该走到这里（本函数只在「本板不存在」时调用）
        if (alive[owner]) continue                           // 原主还活着 → 不是孤儿板，绝不碰
        var d = null
        try { d = JSON.parse(fsNode.readFileSync(path.join(home, f), 'utf8')) } catch (_) { continue }
        if (!vt(d)) continue
        if (d.ownerCwd !== cwd) continue                     // 老文件没 ownerCwd（undefined）→ 天然不匹配，不会被误接管
        hits.push({ file: f, sid: owner })
      }
      if (hits.length > 1) {                                 // 多候选：记录一行但不自动动（多板并存时人工 list-boards 处理）
        console.error('[task-board] 继承跳过：工作区 ' + cwd + ' 有 ' + hits.length + ' 个候选孤儿板（' + hits.map(function (h) { return h.sid }).join(', ') + '），不自动接管')
        return null
      }
      return hits.length === 1 ? hits[0] : null
    }
    // 瞬时占用白名单（与 wt() 同款）：Windows 上 rename/unlink 的目标名被并发读句柄、Defender、
    // 索引器短暂占用时会抛这几个码——退避后重试即可；其它错误（跨设备 EXDEV、只读等）立即放弃。
    var TRANSIENT_FS = { EPERM: 1, EBUSY: 1, ENOTEMPTY: 1, EACCES: 1 }
    function isTransientFs(e) { return !!(e && TRANSIENT_FS[e.code]) }
    // rename 退避重试：成功 true；非瞬时错误或重试耗尽 false（由调用方决定降级/回滚）
    async function renameRetry(from, to, tries) {
      var n = tries || 6
      for (var i = 0; i < n; i++) {
        try { await fsNode.promises.rename(from, to); return true }
        catch (e) {
          if (!isTransientFs(e) || i === n - 1) { console.error('[task-board] rename failed (' + from + ' -> ' + to + '):', String(e)); return false }
          await new Promise(function (r) { setTimeout(r, 60 * (i + 1)) })
        }
      }
      return false
    }
    // unlink 退避重试：ENOENT 视为已达成；重试耗尽返回 false（调用方记一行日志，不再阻断继承）
    async function unlinkRetry(p, tries) {
      var n = tries || 6
      for (var i = 0; i < n; i++) {
        try { await fsNode.promises.unlink(p); return true }
        catch (e) {
          if (e && e.code === 'ENOENT') return true
          if (!isTransientFs(e) || i === n - 1) { console.error('[task-board] unlink failed (' + p + '):', String(e)); return false }
          await new Promise(function (r) { setTimeout(r, 60 * (i + 1)) })
        }
      }
      return false
    }
    // 接管落盘：两条路径，都保证「接管后看板目录里只剩新 sid 那一个文件」（不残留 .adopt-/.tmp 之类残件——
    // 残留一份含全部历史卡的旧板 = 用户磁盘上多一份完整看板，下次继承还会把它算成候选）。
    //   ① 主路径 rename(p → np)：原子、复用 wt() 同款 EPERM/EBUSY 退避重试。注意 rename 只搬内容，
    //      文件里 ownerSession 仍写着旧 sid，所以必须紧接着用 wt() 把改写后的内容原子写回 np；
    //      写回失败则把文件改名退回 p —— 绝不留下「名字是新 sid、内容写着旧主」的半成品（否则 rt()
    //      读到 ownerSession 不匹配会退回空板，用户视角仍是「看板被清空」）。
    //   ② 兜底 rename 走不通（跨设备/顽固占用）→ wt() 写新板 + unlinkRetry 删旧板。先写后删：
    //      任何时刻磁盘上至少有一份完整看板。
    async function adoptBoard(sid, cand, cwd) {
      var p = boardPath(cand.sid), np = boardPath(sid)
      // 目标名已被占用 → 绝不接管（防覆盖：本会话看板若只是「这一刻读不到」，覆盖等于把本板换成孤儿板）
      if (cand.sid === sid || fsNode.existsSync(np)) return false
      var c = null
      try { c = JSON.parse(await fsNode.promises.readFile(p, 'utf8')) } catch (e) { console.error('[task-board] 继承失败（读旧板）:', String(e)); return false }
      if (!vt(c)) return false
      c.ownerSession = sid
      if (typeof cwd === 'string' && cwd) c.ownerCwd = cwd
      if (await renameRetry(p, np)) {                            // ① 主路径：先改名，再把 ownerSession 改写写回
        try {
          await wt(sid, c)
          console.error('[task-board] 继承看板 ' + cand.sid + ' → ' + sid + '（工作区 ' + cwd + '，原主已不在 roots）')
          return true
        } catch (e) {
          console.error('[task-board] 继承失败（改写 ownerSession）:', String(e))
          await renameRetry(np, p)                               // 回滚到旧名：下次 rt 还能再试，且不留半成品
          return false
        }
      }
      try { await wt(sid, c) } catch (e) { console.error('[task-board] 继承失败（写新板）:', String(e)); return false }
      await unlinkRetry(p)
      console.error('[task-board] 继承看板 ' + cand.sid + ' → ' + sid + '（工作区 ' + cwd + '，原主已不在 roots；rename 不通，走写新+删旧）')
      return true
    }
    async function rt(sid) {
      var r = null
      try { r = await fsNode.promises.readFile(boardPath(sid), 'utf8') } catch (e) {
        // 只有「文件确实不存在（ENOENT）」才触发继承：EACCES/EPERM/被占 等说明本会话看板很可能存在、
        // 只是这一刻读不到——此时去接管会把别的板写到本会话文件名上（改前行为只是内存空板，不落盘）。
        if (!e || e.code !== 'ENOENT') { console.error('[task-board] 读看板失败（不触发继承）: ' + boardPath(sid) + ' :: ' + String(e)); return seedNoPersist(sid) }
        // 本 sid 无看板文件：先试「同工作区唯一孤儿板」继承，接不到才种新板（种板即带 ownerCwd，供下次重启继承）
        try {
          var cwd0 = sessionCwd(sid)
          var cand = findAdoptableBoardFile(sid, cwd0)
          if (cand && await adoptBoard(sid, cand, cwd0)) r = await fsNode.promises.readFile(boardPath(sid), 'utf8')
        } catch (e2) { console.error('[task-board] 继承流程异常（降级为空板）:', String(e2)) }
        if (r === null) return seed(sid, sessionCwd(sid))
      }
      try {
        var d = JSON.parse(r)
        if (vt(d) && d.ownerSession === sid) {
          teamModeCache[sid] = !!d.teamMode; var nd = normalizeBoard(d); feedbackCache[sid] = nd.feedbackEnabled !== false; epicSplitCache[sid] = nd.epicSplit !== false
          // ownerCwd 回填（只改内存，随下一次写盘落盘）：老看板文件没有该字段，而继承判定靠它——
          // 不写盘就永远不能匿名继承。这里不额外做 IO，避免把只读路径变成写路径。
          if (!nd.ownerCwd) { var cw = sessionCwd(sid); if (cw) nd.ownerCwd = cw }
          return nd
        }
        return seed(sid, sessionCwd(sid))
      } catch (_) {
        // JSON 截断/损坏（如强杀打断写盘）：隔离留档再种新板——数据不丢，坏文件也不反复 poison
        console.error('[task-board] board file corrupt, quarantining: ' + boardPath(sid))
        fsNode.promises.rename(boardPath(sid), boardPath(sid) + '.corrupt-' + Date.now()).catch(function () {})
        return seedNoPersist(sid)
      }
    }
    // 瞬时读失败/坏文件隔离后的空板必须禁止回写：否则一个「读不到」的瞬间就会把 106 张卡覆成空板。
    // __noPersist 用 non-enumerable 挂载——即使将来有路径漏判把它写出去，JSON.stringify 也会跳过该字段。
    function seedNoPersist(sid) { var d = seed(sid, sessionCwd(sid)); try { Object.defineProperty(d, '__noPersist', { value: true, enumerable: false }) } catch (_) {} return d }
    // 原子写盘：先写临时文件再 rename——强杀若发生在写盘中途，磁盘上最多留个 .tmp 残件，
    // 看板本体永远不会是截断的半个 JSON（此前非原子直写，kill 中写 = 看板被 seed 清空）
    // Windows 特有问题：rename 目标被并发读句柄/Defender/索引器短暂占用时抛 EPERM/EBUSY
    // （E2E 实测：GUI 3s 轮询 + 脚本 10s 轮询下偶发，publish 写入整个丢失）。
    // 对这类瞬时占用做有限退避重试；其他错误（只读/不存在目录等）直接抛。
    async function wt(sid, d) {
      var c = JSON.stringify(d); var p = boardPath(sid); var tmp = p + '.tmp'
      var lastErr = null
      for (var attempt = 0; attempt < 6; attempt++) {
        try { await fsNode.promises.writeFile(tmp, c, 'utf8'); await fsNode.promises.rename(tmp, p); return }
        catch (e) {
          lastErr = e
          var code = e && e.code
          if (code === 'EPERM' || code === 'EBUSY' || code === 'ENOTEMPTY' || code === 'EACCES') {
            await new Promise(function (r) { setTimeout(r, 60 * (attempt + 1)) })
            continue
          }
          console.error('[task-board] write:', String(e)); throw e
        }
      }
      console.error('[task-board] write: retry exhausted (6 次) ->', String(lastErr)); throw lastErr
    }
    // 每会话一条 promise 链，串行化所有 读-改-写，消除并发写竞争
    function withLock(sid, fn) { var prev = fileLocks[sid] || Promise.resolve(); var p = prev.then(function () { return fn() }); fileLocks[sid] = p.catch(function () {}); return p }
    // 便捷：串行的 读→mutate→写。mutate(d) 返回值作为结果；mutate 返回 null/undefined 则不写
    // 写成功后异步触发一次 poolCycle（派发/回收反应快），按会话去抖避免连环触发
    function kickCycle(sid) { if (cyclePending[sid]) return; cyclePending[sid] = true; var tm = ctx.timer; var go = function () { cyclePending[sid] = false; deps.poolCycle(sid).catch(function () {}) }; if (tm) tm.timeout(50).then(go); else Promise.resolve().then(go) }
    function mutateLocked(sid, mutate, skipKick) { return withLock(sid, async function () { var d = await rt(sid); if (d && d.__noPersist) { console.error('[task-board] 看板暂时不可读，拒绝在空板上覆写（防瞬时读失败清板）: ' + sid); return { ok: false, error: '看板暂时不可读，请重试' } } var r = await mutate(d); if (r !== null && r !== undefined) { await wt(sid, d); if (!skipKick) kickCycle(sid); return r } return r }) }

    return { rt: rt, wt: wt, kickCycle: kickCycle, mutateLocked: mutateLocked }
}
