#!/usr/bin/env node
// score-decompose.mjs —— 拆解官行为 bench 评分器（task-mwk0rbam）。
// 三件套之三：读 bench/results（run-decompose.mjs 落盘的产出），对每个提案算行为指标，输出「模型 × 指标」
// Markdown 矩阵 + 阈值违规标记；--self-test 用手工构造的 mock 结果文件断言精确期望值（不依赖真模型）。
// 详细用法：node bench/score-decompose.mjs --help。

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RESULTS_ROOT_DEFAULT = path.join(HERE, 'results')

const HELP = `拆解官行为 bench · 评分器（bench/score-decompose.mjs）

用途：对 run-decompose.mjs 落盘的产出（bench/results/<ts>/<model>/<corpus>.json）逐个计算行为指标，
聚合成「模型 × 指标」Markdown 矩阵（含阈值违规标记），实证不同模型在拆解契约下的行为差异。

六项核心指标（口径写在各函数注释，阈值与生产拆解纪律对齐）：
  ① 子卡数     children.length；健康 3~5，>6 记「顶格倾向」（生产上限 8）
  ② 串行深度   dependsOn 最长链（节点数）；>4 为过长（串行链越长交付越慢）
  ③ 纵切率     代码+测试同卡的子卡占比（touches 分桶 + acceptance 测试命令信号）；越高越好，<50% 记低
  ④ 层切信号   纯类型/纯文档/纯组件卡数；应 0（生产纪律：禁止逐技术层机械拆卡）
  ⑤ 非法依赖率 dependsOn 里非「本批前排序号」的条目占比（自引用/越界/非数字都算）；应 0
  ⑥ size 分布  light/standard/heavy/缺档计数；全落 standard 记异常（「全标档引力井」）
  另有辅助列：运行数、解析率（产出可解析为 DECOMPOSE_SCHEMA 形状的比例）、keep 数（verdict=keep 不拆）。

用法：
  node bench/score-decompose.mjs                                  # 评分 bench/results/ 下全部产出
  node bench/score-decompose.mjs --results=<run目录或results根>    # 指定目录（run 目录或 results 根皆可）
  node bench/score-decompose.mjs --self-test                      # 手工 mock 结果 → 精确断言六指标（自测，不依赖真模型）
  node bench/score-decompose.mjs --help                           # 本说明
  （先跑执行器产数据：node bench/run-decompose.mjs --dry-run 或 --models=... --llm-bridge=...）

标记图例：
  ⚠顶格=子卡数>6｜⚠过深=串行深度>4｜⚠纵切低=<50%｜⚠层切=纯文档/类型/组件卡≠0｜⚠非法依赖=非法序号≠0｜⚠全标档=size 全 standard`

// ===== 触点路径分类（纯函数；宁可漏检不可误切——与生产「实现侧拆解」口径对齐）=====
// 测试桶：tests/ 目录、*.test.* / *.spec.*、python test_*.py / *_test.py 风格
function pathBucket(p) {
  var s = String(p || '')
  if (/(^|[\/\\])(tests?|__tests__)([\/\\])/.test(s) || /\.(test|spec)\.[a-z]+$/i.test(s) || /(^|[\/\\])test_[^\/\\]+\.(py|js|mjs|ts|cjs)$/i.test(s) || /_test\.(py|js|mjs|ts|cjs)$/i.test(s)) return 'test'
  if (/\.d\.ts$/i.test(s)) return 'types'
  if (/\.(md|txt|rst|adoc)$/i.test(s) || /(^|[\/\\])docs?([\/\\])/.test(s)) return 'docs'
  if (/\.(tsx|jsx|vue)$/i.test(s)) return 'component'
  return 'code'
}
// acceptance 测试命令信号（生产纪律：acceptance 必须是可执行命令；跑测试的命令即「测试同卡」证据）
var TEST_CMD_RE = /(^|\s)(node --test|npm (test|run test|run -t)|npx (jest|vitest)|py\.?test|uv run pytest|go test|mvn test|gradle test|python -m pytest)(\s|$)/

function childTouches(child) {
  return Array.isArray(child && child.touches) ? child.touches.filter(function (x) { return typeof x === 'string' && x.trim() }) : []
}
function childHasTestSignal(child, buckets) {
  if (buckets.indexOf('test') >= 0) return true
  return TEST_CMD_RE.test(String((child && child.acceptance) || ''))
}
function childIsCodeish(buckets) {
  // 代码信号：生产代码或组件文件任一在卡（测试/文档/纯类型不算——纯类型卡正是层切反模式）
  for (var i = 0; i < buckets.length; i++) if (buckets[i] === 'code' || buckets[i] === 'component') return true
  return false
}

// ===== 单提案评分：parsed（run-decompose 落盘的 parsed/structured 字段）→ 六指标 =====
// 依赖合法性口径与生产 dispatch 物化侧对齐：dependsOn 只许引用本批**前排**子卡序号（'1' 起计，string）——
// 自引用（n==自身位）、后排引用（n>自身位）、越界（n>children.length）、非数字都算非法（生产物化侧是丢弃留痕，bench 记率）。
function classifyDeps(children) {
  var legal = {}, total = 0, illegal = 0
  for (var pos = 1; pos <= children.length; pos++) {
    var deps = children[pos - 1] && children[pos - 1].dependsOn
    if (!Array.isArray(deps)) continue
    legal[pos] = []
    for (var i = 0; i < deps.length; i++) {
      total++
      var d = String(deps[i] == null ? '' : deps[i]).trim()
      if (!/^\d+$/.test(d)) { illegal++; continue }
      var n = Number(d)
      if (n >= 1 && n < pos && n <= children.length) legal[pos].push(n) // 只认前排列
      else illegal++ // 自引用 / 后排（跨批方向）/ 越界
    }
  }
  return { legal: legal, total: total, illegal: illegal }
}
// 串行深度：合法依赖边 DAG 上的最长链（按节点数）；无依赖=1，keep/无子卡=0
function serialDepth(children, legal) {
  var memo = {}
  function depthOf(pos) {
    if (memo[pos] != null) return memo[pos]
    memo[pos] = 1
    var deps = legal[pos] || []
    for (var i = 0; i < deps.length; i++) { var d = depthOf(deps[i]) + 1; if (d > memo[pos]) memo[pos] = d }
    return memo[pos]
  }
  var max = 0
  for (var pos = 1; pos <= children.length; pos++) { var d = depthOf(pos); if (d > max) max = d }
  return max
}
// 层切卡判定：触点全部落在单一非纵切桶（纯文档/纯类型/纯组件）且无测试信号；触点空=不可判定（不算）
function layerCutKind(child, buckets) {
  var uniq = {}
  for (var i = 0; i < buckets.length; i++) uniq[buckets[i]] = true
  var keys = Object.keys(uniq)
  if (!keys.length) return null
  if (keys.length === 1 && keys[0] === 'docs') return 'docs'
  if (keys.length === 1 && keys[0] === 'types') return 'types'
  if (keys.length === 1 && keys[0] === 'component' && !childHasTestSignal(child, buckets)) return 'component'
  return null
}

function scoreProposal(parsed) {
  if (!parsed || typeof parsed !== 'object') return { kind: 'parse-fail' }
  if (parsed.verdict === 'keep') return { kind: 'keep' }
  if (!Array.isArray(parsed.children) || !parsed.children.length) return { kind: 'split-empty' }
  var children = parsed.children
  var dep = classifyDeps(children)
  var vertical = 0, layerCut = { docs: 0, types: 0, component: 0 }
  var sizeDist = { light: 0, standard: 0, heavy: 0, missing: 0 }
  for (var i = 0; i < children.length; i++) {
    var c = children[i]
    var buckets = childTouches(c).map(pathBucket)
    if (childIsCodeish(buckets) && childHasTestSignal(c, buckets)) vertical++
    var cut = layerCutKind(c, buckets)
    if (cut) layerCut[cut]++
    var sz = c && c.size
    if (sz === 'light' || sz === 'standard' || sz === 'heavy') sizeDist[sz]++
    else sizeDist.missing++
  }
  return {
    kind: 'split',
    childrenCount: children.length,
    serialDepth: serialDepth(children, dep.legal),
    verticalChildren: vertical,
    layerCut: layerCut,
    layerCutTotal: layerCut.docs + layerCut.types + layerCut.component,
    depTotal: dep.total,
    depIllegal: dep.illegal,
    illegalRate: dep.total ? dep.illegal / dep.total : 0,
    sizeDist: sizeDist,
  }
}

// ===== 模型聚合：提案列表 → 矩阵行数据 + 违规标记 =====
function aggregateModel(model, proposals) {
  var agg = {
    model: model, runs: proposals.length, parsed: 0, parseFail: 0, keep: 0, splitEmpty: 0, splits: 0,
    childrenAvg: null, childrenMin: null, childrenMax: null,
    depthAvg: null, depthMax: null,
    verticalNum: 0, childrenTotal: 0, verticalRate: null,
    layerCut: { docs: 0, types: 0, component: 0 }, layerCutTotal: 0,
    depTotal: 0, depIllegal: 0, illegalRate: null,
    sizeDist: { light: 0, standard: 0, heavy: 0, missing: 0 },
  }
  var childCounts = [], depths = [], scored = []
  for (var i = 0; i < proposals.length; i++) {
    var r = proposals[i]
    var s = scoreProposal(r && (r.parsed != null ? r.parsed : r.structured))
    if (s.kind === 'parse-fail') { agg.parseFail++; continue }
    agg.parsed++
    if (s.kind === 'keep') { agg.keep++; continue }
    if (s.kind === 'split-empty') { agg.splitEmpty++; continue }
    agg.splits++
    scored.push(s)
    childCounts.push(s.childrenCount)
    depths.push(s.serialDepth)
    agg.verticalNum += s.verticalChildren
    agg.childrenTotal += s.childrenCount
    agg.layerCut.docs += s.layerCut.docs
    agg.layerCut.types += s.layerCut.types
    agg.layerCut.component += s.layerCut.component
    agg.depTotal += s.depTotal
    agg.depIllegal += s.depIllegal
    agg.sizeDist.light += s.sizeDist.light
    agg.sizeDist.standard += s.sizeDist.standard
    agg.sizeDist.heavy += s.sizeDist.heavy
    agg.sizeDist.missing += s.sizeDist.missing
  }
  agg.layerCutTotal = agg.layerCut.docs + agg.layerCut.types + agg.layerCut.component
  if (childCounts.length) {
    agg.childrenAvg = childCounts.reduce(function (a, b) { return a + b }, 0) / childCounts.length
    agg.childrenMin = Math.min.apply(null, childCounts)
    agg.childrenMax = Math.max.apply(null, childCounts)
    agg.depthAvg = depths.reduce(function (a, b) { return a + b }, 0) / depths.length
    agg.depthMax = Math.max.apply(null, depths)
  }
  if (agg.childrenTotal) agg.verticalRate = agg.verticalNum / agg.childrenTotal
  if (agg.depTotal) agg.illegalRate = agg.depIllegal / agg.depTotal
  agg.flags = modelFlags(agg)
  return agg
}
// 阈值口径（与生产拆解纪律对齐）：子卡 3~5 健康、>6 顶格倾向；串行 >4 过长；层切应 0；非法依赖应 0；全标档异常；纵切率 <50% 低
function modelFlags(agg) {
  var f = []
  if (agg.childrenMax != null && agg.childrenMax > 6) f.push('顶格')
  if (agg.depthMax != null && agg.depthMax > 4) f.push('过深')
  if (agg.verticalRate != null && agg.verticalRate < 0.5) f.push('纵切低')
  if (agg.layerCutTotal > 0) f.push('层切')
  if (agg.depIllegal > 0) f.push('非法依赖')
  if (agg.splits > 0 && agg.sizeDist.standard > 0 && agg.sizeDist.light === 0 && agg.sizeDist.heavy === 0 && agg.sizeDist.missing === 0) f.push('全标档')
  return f
}

// ===== 结果发现：递归收集 <root> 下 .json（兼容 results 根 / 单 run 目录两种形态），按 model 字段分组 =====
async function collectResultFiles(root, depth) {
  var out = []
  var ents = await readdir(root, { withFileTypes: true })
  for (var i = 0; i < ents.length; i++) {
    var e = ents[i]
    if (e.name === '.gitignore' || e.name.startsWith('.')) continue
    var p = path.join(root, e.name)
    if (e.isDirectory()) { if (depth < 3) out.push.apply(out, await collectResultFiles(p, depth + 1)) }
    else if (e.isFile() && /\.json$/i.test(e.name)) out.push(p)
  }
  return out
}
async function loadResults(root) {
  var files = await collectResultFiles(root, 0)
  var byModel = {}, order = []
  for (var i = 0; i < files.length; i++) {
    var rec = null
    try { rec = JSON.parse(await readFile(files[i], 'utf8')) } catch (_) { continue } // 半截/损坏文件跳过（bench 本地数据不设防）
    if (!rec || typeof rec !== 'object') continue
    var model = String(rec.model || '(unknown)')
    if (!byModel[model]) { byModel[model] = []; order.push(model) }
    byModel[model].push(rec)
  }
  return { byModel: byModel, order: order, files: files }
}

// ===== 矩阵渲染：模型 × 指标 Markdown =====
function fmtRate(x) { return x == null ? '—' : (Math.round(x * 1000) / 10) + '%' }
function fmtNum(x, digits) { return x == null ? '—' : String(Math.round(x * Math.pow(10, digits || 0)) / Math.pow(10, digits || 0)) }
function renderMatrix(aggs) {
  var lines = []
  lines.push('## 拆解官行为 bench · 模型 × 指标矩阵')
  lines.push('')
  lines.push('| 模型 | 运行 | 解析率 | keep | 子卡数 均(区间) | 串行深度 均/最大 | 纵切率 | 层切 文/型/组 | 非法依赖率 | size L/S/H/缺 | 违规 |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|')
  for (var i = 0; i < aggs.length; i++) {
    var a = aggs[i]
    var parseRate = a.runs ? a.parsed / a.runs : null
    var childCell = a.childrenAvg == null ? '—' : fmtNum(a.childrenAvg, 1) + ' (' + a.childrenMin + '–' + a.childrenMax + ')'
    var depthCell = a.depthMax == null ? '—' : fmtNum(a.depthAvg, 1) + '/' + a.depthMax
    var sd = a.sizeDist
    lines.push('| ' + a.model + ' | ' + a.runs + ' | ' + fmtRate(parseRate) + ' | ' + a.keep + ' | ' + childCell + ' | ' + depthCell + ' | ' + fmtRate(a.verticalRate) + ' | ' + a.layerCut.docs + '/' + a.layerCut.types + '/' + a.layerCut.component + ' | ' + fmtRate(a.illegalRate) + ' | ' + sd.light + '/' + sd.standard + '/' + sd.heavy + '/' + sd.missing + ' | ' + (a.flags.length ? '⚠' + a.flags.join('·⚠') : '✓') + ' |')
  }
  lines.push('')
  lines.push('口径：子卡数/串行深度/纵切率/层切/非法依赖/size 只对 verdict=split 且有子卡的提案聚合（共 ' + aggs.reduce(function (n, a) { return n + a.splits }, 0) + ' 个有效拆分提案）；keep=不拆提案数；解析率=产出可解析为契约形状的比例。')
  lines.push('标记：⚠顶格=子卡>6（健康3~5）｜⚠过深=串行>4｜⚠纵切低=<50%｜⚠层切=纯文档/类型/组件卡≠0｜⚠非法依赖=非前排序号≠0｜⚠全标档=size全standard')
  return lines.join('\n')
}

// ===== 主流程 =====
async function main() {
  var argv = process.argv.slice(2)
  if (argv.indexOf('--help') >= 0 || argv.indexOf('-h') >= 0) { console.log(HELP); return }
  var selfTest = argv.indexOf('--self-test') >= 0
  var root = RESULTS_ROOT_DEFAULT
  for (var i = 0; i < argv.length; i++) {
    if (argv[i].indexOf('--results=') === 0) root = path.resolve(argv[i].slice('--results='.length))
    else if (argv[i] !== '--self-test') { console.error('✗ 未知参数：' + argv[i] + '（--help 看用法）'); process.exit(2) }
  }
  if (selfTest) { await runSelfTest(); return }
  var loaded = await loadResults(root)
  if (!loaded.files.length) {
    console.log('（' + root + ' 下无结果文件。先跑执行器产数据：node bench/run-decompose.mjs --dry-run 或 --models=... --llm-bridge=...；')
    console.log('  评分器自测不依赖真模型：node bench/score-decompose.mjs --self-test）')
    return
  }
  var aggs = loaded.order.map(function (m) { return aggregateModel(m, loaded.byModel[m]) })
  console.log(renderMatrix(aggs))
  console.log('')
  console.log('（' + loaded.files.length + ' 个结果文件，来自 ' + root + '）')
}

// ===== --self-test：手工构造 mock 结果集（与执行器落盘同形状）→ 逐指标精确断言 =====
// 设计意图：三个模型分别代表「健康拆分 / 病态拆分 / 解析失败」，覆盖六指标全部阈值分支；不依赖真模型。
function sanitizeModelDir(model) { return String(model).replace(/[^A-Za-z0-9._-]+/g, '__') || 'unnamed-model' }
function mkRecord(model, corpusId, parsed, extra) {
  return Object.assign({ benchVersion: 1, runTs: 'selftest', model: model, corpusId: corpusId, schemaMode: 'selftest', prompt: '', promptSha256: '', raw: parsed ? JSON.stringify(parsed) : '抱歉，这个需求太大，我建议先不开工。', structured: null, parsed: parsed, parseError: parsed ? null : '无法从输出提取 JSON（raw 13 字符）', validation: [], usage: null, elapsedMs: 1, finish: null, error: null }, extra || {})
}
function buildSelfTestMock() {
  var healthySplit = { verdict: 'split', children: [
    { title: '规则引擎核心改造', description: '实现侧子卡', size: 'heavy', touches: ['backend/app/core/rule_engine.py'], acceptance: 'uv run pytest backend/tests/test_rule_engine.py', dependsOn: [] },
    { title: '相似度回落接入', description: '代码+测试同卡', size: 'light', touches: ['backend/app/core/catalog_similarity.py', 'backend/tests/test_catalog_similarity.py'], acceptance: 'uv run pytest backend/tests/test_catalog_similarity.py', dependsOn: ['1'] },
    { title: '前端编目页接入', description: '组件+接口+测试同卡', size: 'standard', touches: ['frontend/src/pages/CatalogTools.tsx', 'frontend/src/api/client.ts', 'frontend/src/api/client.test.ts'], acceptance: 'npm test', dependsOn: ['2'] },
    { title: '方案文档更新', description: '纯文档卡（层切反例）', size: 'light', touches: ['docs/编目推荐相似度回落方案.md'], acceptance: 'node scripts/check-docs.mjs', dependsOn: [] },
  ], rationale: '4 张纵切子卡' }
  var pathological = { verdict: 'split', children: [
    { title: 'API 类型定义', description: '纯类型卡', size: 'standard', touches: ['src/types/api.d.ts'], acceptance: '', dependsOn: [] },
    { title: '使用文档', description: '纯文档卡', size: 'standard', touches: ['docs/usage.md'], acceptance: '', dependsOn: ['3'] },
    { title: '展示组件', description: '纯组件卡', size: 'standard', touches: ['frontend/src/components/Widget.tsx'], acceptance: 'npm run build', dependsOn: [] },
    { title: '后端逻辑A', description: '代码无测试', size: 'standard', touches: ['backend/app/a.py'], acceptance: 'python -m compileall backend/app/a.py', dependsOn: [] },
    { title: '纵切B', description: '代码+测试同卡', size: 'standard', touches: ['backend/app/b.py', 'backend/tests/test_b.py'], acceptance: 'uv run pytest backend/tests/test_b.py', dependsOn: ['4'] },
    { title: '纵切C', description: '组件+测试同卡', size: 'standard', touches: ['frontend/src/c.tsx', 'frontend/src/c.test.ts'], acceptance: 'npm test', dependsOn: ['5'] },
    { title: '后端逻辑D', description: '代码无测试，带自引用依赖', size: 'standard', touches: ['backend/app/d.py'], acceptance: '', dependsOn: ['6', '7'] },
    { title: '收尾杂项', description: '无触点不可判定', size: 'standard', touches: [], acceptance: '', dependsOn: ['7'] },
  ], rationale: '顶格 8 张病态拆分' }
  return [
    mkRecord('selftest/healthy', 'reg-graph', healthySplit),
    mkRecord('selftest/healthy', 'catalog-sim', { verdict: 'keep', rationale: '单一改动点，不必拆' }),
    mkRecord('selftest/pathological', 'reg-graph', pathological),
    mkRecord('selftest/garbage', 'reg-graph', null),
  ]
}
// 期望值表（手工推导，与上面 mock 一一对应；浮点用 1e-9 容差）
var SELFTEST_EXPECTED = {
  'selftest/healthy': { runs: 2, parsed: 2, parseFail: 0, keep: 1, splitEmpty: 0, splits: 1, childrenAvg: 4, childrenMin: 4, childrenMax: 4, depthAvg: 3, depthMax: 3, verticalRate: 0.75, layerCutDocs: 1, layerCutTypes: 0, layerCutComponent: 0, layerCutTotal: 1, depTotal: 2, depIllegal: 0, illegalRate: 0, light: 2, standard: 1, heavy: 1, missing: 0, flags: ['层切'] },
  'selftest/pathological': { runs: 1, parsed: 1, parseFail: 0, keep: 0, splitEmpty: 0, splits: 1, childrenAvg: 8, childrenMin: 8, childrenMax: 8, depthAvg: 5, depthMax: 5, verticalRate: 0.25, layerCutDocs: 1, layerCutTypes: 1, layerCutComponent: 1, layerCutTotal: 3, depTotal: 6, depIllegal: 2, illegalRate: 1 / 3, light: 0, standard: 8, heavy: 0, missing: 0, flags: ['顶格', '过深', '纵切低', '层切', '非法依赖', '全标档'] },
  'selftest/garbage': { runs: 1, parsed: 0, parseFail: 1, keep: 0, splitEmpty: 0, splits: 0, childrenAvg: null, childrenMin: null, childrenMax: null, depthAvg: null, depthMax: null, verticalRate: null, layerCutTotal: 0, depTotal: 0, depIllegal: 0, illegalRate: null, light: 0, standard: 0, heavy: 0, missing: 0, flags: [] },
}
async function runSelfTest() {
  var records = buildSelfTestMock()
  var tmp = await mkdtemp(path.join(tmpdir(), 'dsh-bench-selftest-'))
  var failures = [], checks = 0
  try {
    // 落成执行器同款布局：<tmp>/<model-dir>/<corpusId>.json，走 loadResults 真实读盘路径
    for (var i = 0; i < records.length; i++) {
      var r = records[i]
      var dir = path.join(tmp, sanitizeModelDir(r.model))
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, r.corpusId + '.json'), JSON.stringify(r, null, 2), 'utf8')
    }
    var loaded = await loadResults(tmp)
    var aggs = {}
    var order = loaded.order
    for (var m = 0; m < order.length; m++) aggs[order[m]] = aggregateModel(order[m], loaded.byModel[order[m]])
    // 逐指标断言
    var models = Object.keys(SELFTEST_EXPECTED)
    for (var mi = 0; mi < models.length; mi++) {
      var model = models[mi]
      var exp = SELFTEST_EXPECTED[model]
      var a = aggs[model]
      if (!a) { failures.push(model + '：mock 结果未被聚合（目录/分组失败）'); continue }
      var fields = { runs: a.runs, parsed: a.parsed, parseFail: a.parseFail, keep: a.keep, splitEmpty: a.splitEmpty, splits: a.splits, childrenAvg: a.childrenAvg, childrenMin: a.childrenMin, childrenMax: a.childrenMax, depthAvg: a.depthAvg, depthMax: a.depthMax, verticalRate: a.verticalRate, layerCutDocs: a.layerCut.docs, layerCutTypes: a.layerCut.types, layerCutComponent: a.layerCut.component, layerCutTotal: a.layerCutTotal, depTotal: a.depTotal, depIllegal: a.depIllegal, illegalRate: a.illegalRate, light: a.sizeDist.light, standard: a.sizeDist.standard, heavy: a.sizeDist.heavy, missing: a.sizeDist.missing, flags: a.flags }
      var keys = Object.keys(exp)
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k], expected = exp[key], actual = fields[key]
        checks++
        var ok = typeof expected === 'number' && typeof actual === 'number' ? Math.abs(actual - expected) < 1e-9 : JSON.stringify(actual) === JSON.stringify(expected)
        if (!ok) failures.push(model + '.' + key + '：期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual))
      }
    }
    // 矩阵照常输出（自测即演示：样例产出 → 矩阵）
    console.log(renderMatrix(order.map(function (m) { return aggs[m] })))
    console.log('')
    if (failures.length) {
      console.log('✗ 自测失败（' + failures.length + '/' + checks + ' 项断言不过）：')
      failures.forEach(function (f) { console.log('  - ' + f) })
      process.exitCode = 1
    } else {
      console.log('✓ 评分器自测通过：' + models.length + ' 个 mock 模型 × ' + checks + ' 项指标断言全对（mock 结果文件写在临时目录，已清理）。')
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

main().catch(function (e) { console.error('✗ 评分器异常：' + String((e && e.stack) || e)); process.exit(2) })
