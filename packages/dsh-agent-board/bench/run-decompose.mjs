#!/usr/bin/env node
// run-decompose.mjs —— 拆解官行为 bench 执行器（task-mwk0rbam）。
// 三件套之一：decompose-corpus.json（语料）→ 本执行器（语料×模型 → llm.stream 直调 → results 落盘）→ score-decompose.mjs（评分矩阵）。
// 详细用法：node bench/run-decompose.mjs --help（HELP 常量即完整文档）。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildDecomposerPrompt, DECOMPOSE_SCHEMA, DECOMPOSE_MAX_CHILDREN } from '../lib/policy.mjs'
import { parseContextFileEntry, buildContextPackSection } from '../lib/core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BENCH_VERSION = 1
const DEFAULT_MAX_TOKENS = 8192
const DEFAULT_TIMEOUT_MS = 240000
const PROMPT_JSON_SUFFIX =
  '\n\n输出契约（硬约束）：只输出一个符合以下 JSON Schema 的 JSON 对象（UTF-8、无注释、无 BOM），不要任何解释、Markdown 代码块或多余文本：\n' +
  JSON.stringify(DECOMPOSE_SCHEMA)

const HELP = `拆解官行为 bench · 执行器（bench/run-decompose.mjs）

用途：遍历「语料 × 模型」组合，用生产同款拆解契约直调 llm.stream，产出落盘供评分器打矩阵。
  · prompt 契约与 schema 直接 import lib/policy.mjs 的 buildDecomposerPrompt + DECOMPOSE_SCHEMA（零副本，生产改契约 bench 即刻同源跟进）；
  · context 包组装与 dispatch.mjs readContextPack 同款（lib/core.mjs 的 parseContextFileEntry + buildContextPackSection，笔记 8000 字符截断同口径）；
  · llm.stream 调用范式与 lib/model-health.mjs 探测同款：provider/model 拆分、messages 结构、maxTokens、AbortController 超时；文本按 text-delta 增量累积、usage 块计量、finish 块结算。

用法：
  node bench/run-decompose.mjs --help
  node bench/run-decompose.mjs --models=deepseek/chat,cmss/zhanlu/glm-5.2             # 全语料
  node bench/run-decompose.mjs --models=deepseek/chat --corpus=reg-graph,catalog-sim  # 语料过滤
  node bench/run-decompose.mjs --dry-run                                              # 内置 mock 走通管线（不烧额度）
  node bench/run-decompose.mjs --models=a/b --llm-bridge=./my-bridge.mjs             # 桥接宿主 llm

llm 解析链（命中即用，三者皆缺则优雅降级）：
  1. --llm-bridge=<module.mjs>   ESM 模块，导出 default 或命名 llm，形状 { stream(req): AsyncIterable }
  2. 环境变量 DSH_BENCH_LLM_BRIDGE（同上）
  3. globalThis.__DSH_BENCH_LLM__（宿主进程内注入）
  皆缺时：打印「需要宿主环境」提示并以退出码 0 结束（不炸栈、不产生半个结果）。

选项：
  --models=a,b,c   provider/model 复合 id（list-models 同款格式）；--dry-run 未指定时缺省 mock/dry-run
  --corpus=id1,id2 语料 id 过滤（缺省全量，逗号分隔）
  --schema-mode    auto（缺省）：先带 outputSchema 直调；llm.stream 同步抛错则剥参数重试 prompt-JSON 模式
                   native：只带 outputSchema（不支持即失败留痕）
                   prompt：不带 schema，prompt 内补「只输出符合 schema 的 JSON」强箍 + 文本提取解析
  --max-tokens=N   缺省 8192
  --timeout-ms=N   单次调用预算（AbortController 硬超时），缺省 240000
  --temperature=N  缺省 0（可复现基准）
  --out=<dir>      结果根目录（缺省 bench/results）
  --dry-run        不接真模型：内置确定性 mock（按语料 id 生成 DECOMPOSE_SCHEMA 合规提案），验证调用→解析→落盘全链路
  --help           本说明

产出布局：bench/results/<ts>/<model-dir>/<corpusId>.json（model-dir 为模型名去斜杠安全化，如 cmss/zhanlu/glm-5.2 → cmss__zhanlu__glm-5.2）。
结果文件字段：benchVersion/runTs/model/corpusId/schemaMode/prompt/promptSha256/raw/structured/parsed/parseError/usage/elapsedMs/finish/error。
bench/results/ 已被 bench/.gitignore 忽略（本地实证数据不入库）；语料与脚本入库可复现。
上游模型语义差异对照：DECOMPOSE_MAX_CHILDREN=${DECOMPOSE_MAX_CHILDREN}（生产契约上限）。`

// ===== CLI 参数解析（极简手写，不引第三方依赖）=====
function parseArgs(argv) {
  var o = { models: null, corpus: null, schemaMode: 'auto', maxTokens: DEFAULT_MAX_TOKENS, timeoutMs: DEFAULT_TIMEOUT_MS, temperature: 0, out: null, llmBridge: null, dryRun: false, help: false }
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i]
    if (a === '--help' || a === '-h') o.help = true
    else if (a === '--dry-run') o.dryRun = true
    else if (a.indexOf('--models=') === 0) o.models = a.slice('--models='.length).split(',').map(function (s) { return s.trim() }).filter(Boolean)
    else if (a.indexOf('--corpus=') === 0) o.corpus = a.slice('--corpus='.length).split(',').map(function (s) { return s.trim() }).filter(Boolean)
    else if (a.indexOf('--schema-mode=') === 0) o.schemaMode = a.slice('--schema-mode='.length).trim()
    else if (a.indexOf('--max-tokens=') === 0) o.maxTokens = Math.max(1, Number(a.slice('--max-tokens='.length)) || DEFAULT_MAX_TOKENS)
    else if (a.indexOf('--timeout-ms=') === 0) o.timeoutMs = Math.max(1000, Number(a.slice('--timeout-ms='.length)) || DEFAULT_TIMEOUT_MS)
    else if (a.indexOf('--temperature=') === 0) o.temperature = Math.max(0, Math.min(2, Number(a.slice('--temperature='.length)) || 0))
    else if (a.indexOf('--out=') === 0) o.out = a.slice('--out='.length).trim()
    else if (a.indexOf('--llm-bridge=') === 0) o.llmBridge = a.slice('--llm-bridge='.length).trim()
    else return { error: '未知参数：' + a + '（--help 看用法）' }
  }
  if (['auto', 'native', 'prompt'].indexOf(o.schemaMode) < 0) return { error: '--schema-mode 只许 auto|native|prompt，收到：' + o.schemaMode }
  return { opts: o }
}

var _corpusCache = null
async function loadCorpus() {
  if (_corpusCache) return _corpusCache
  var raw = await readFile(path.join(HERE, 'decompose-corpus.json'), 'utf8')
  var c = JSON.parse(raw)
  if (!c || !Array.isArray(c.cards) || !c.cards.length) throw new Error('语料文件无 cards 数组：bench/decompose-corpus.json')
  var seen = {}
  for (var i = 0; i < c.cards.length; i++) {
    var k = c.cards[i]
    if (!k.id || !k.title || !k.description) throw new Error('语料卡缺 id/title/description：#' + i)
    if (seen[k.id]) throw new Error('语料卡 id 重复：' + k.id)
    seen[k.id] = true
  }
  _corpusCache = c
  return c
}
function corpusIds() { return _corpusCache ? _corpusCache.cards.map(function (k) { return k.id }) : [] }

// 语料卡 → 生产任务形状 + 上下文包（与 dispatch.mjs readContextPack 逐行同款：清单形态、8000 字符截断、parseContextFileEntry 归一）
function buildTaskAndPack(card) {
  var t = {
    id: 'bench-' + card.id,
    title: card.title,
    status: 'draft',
    description: card.description,
    acceptance: card.acceptance || '',
    context: { instructions: (card.context && card.context.instructions) || '' },
  }
  var paths = (card.context && Array.isArray(card.context.files)) ? card.context.files : []
  var notes = (card.context && typeof card.context.notes === 'string') ? card.context.notes : ''
  var files = []
  for (var i = 0; i < paths.length; i++) { var e = parseContextFileEntry(paths[i]); if (e.path) files.push(e) }
  var pack = buildContextPackSection(files, notes.slice(0, 8000))
  return { task: t, pack: pack }
}

// 模型名 → 安全目录名（provider/model 复合 id 带斜杠，目录只能拍平）
function sanitizeModelDir(model) {
  return String(model).replace(/[^A-Za-z0-9._-]+/g, '__').replace(/^_+|_+$/g, '') || 'unnamed-model'
}

function runTsName() {
  var d = new Date()
  var pad = function (n) { return String(n).padStart(2, '0') }
  var base = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
  return base + '-' + Math.random().toString(36).slice(2, 6)
}

// ===== llm 解析链：--llm-bridge → DSH_BENCH_LLM_BRIDGE → globalThis 注入 → 缺席优雅降级 =====
async function resolveLlm(opts) {
  var bridgePath = opts.llmBridge || process.env.DSH_BENCH_LLM_BRIDGE || ''
  if (bridgePath) {
    var mod = await import(pathToFileURL(path.resolve(bridgePath)).href)
    var llm = mod.default && typeof mod.default.stream === 'function' ? mod.default : (mod.llm && typeof mod.llm.stream === 'function' ? mod.llm : null)
    if (!llm) throw new Error('llm 桥接模块 ' + bridgePath + ' 须导出 { stream }（default 或命名 llm）')
    return { llm: llm, source: 'bridge:' + bridgePath }
  }
  if (globalThis.__DSH_BENCH_LLM__ && typeof globalThis.__DSH_BENCH_LLM__.stream === 'function') {
    return { llm: globalThis.__DSH_BENCH_LLM__, source: 'globalThis.__DSH_BENCH_LLM__' }
  }
  return null
}

// ===== 单次拆解调用（model-health probeOnce 同款骨架：provider/model 拆分、AbortController 超时、
// text-delta 累积、usage/finish 结算；外加 outputSchema 直参与剥参重试）=====
async function callDecompose(llm, model, prompt, opts) {
  var slash = model.indexOf('/')
  if (slash <= 0 || slash === model.length - 1) return { ok: false, error: '模型 id 须为 provider/model 复合格式，收到：' + model }
  var req0 = {
    provider: model.slice(0, slash),
    model: model.slice(slash + 1),
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
  }
  var wantNative = opts.schemaMode !== 'prompt'

  async function attempt(withSchema, promptText) {
    var req = Object.assign({}, req0, { messages: [{ role: 'user', content: [{ type: 'text', text: promptText }] }] })
    if (withSchema) req.outputSchema = DECOMPOSE_SCHEMA
    var ac = new AbortController(), timedOut = false, timer = null
    var out = { text: '', usage: null, structured: null, finish: null, syncError: null }
    try {
      req.signal = ac.signal
      timer = setTimeout(function () { timedOut = true; ac.abort() }, opts.timeoutMs)
      if (timer && typeof timer.unref === 'function') timer.unref()
      var stream
      try { stream = llm.stream(req) } catch (e) { out.syncError = String((e && e.message) || e); return out } // 参数/模型不支持：同步抛（剥参重试的判定依据）
      try {
        for await (var chunk of stream) {
          if (!chunk) continue
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') out.text += chunk.text
          else if (chunk.type === 'usage') out.usage = chunk.usage || null
          else if (chunk.type === 'structured' && chunk.value != null) out.structured = chunk.value // 宿主原生 outputSchema 结构化面（若有）
          else if (chunk.type === 'finish') { out.finish = chunk.reason || {}; break }
        }
      } catch (e) {
        // 流中断：超时 abort 属预期（外层按 timedOut 判）；其余记流错误
        if (!timedOut) out.streamError = String((e && e.message) || e)
      }
      return out
    } finally {
      if (timer) clearTimeout(timer)
      if (timedOut) out.timedOut = true
    }
  }

  var started = Date.now()
  var promptUsed = wantNative ? prompt : prompt + PROMPT_JSON_SUFFIX // 实际发送给模型的完整 prompt（审计口径：含 JSON 强箍后缀时逐字落盘）
  var res = await attempt(wantNative, promptUsed)
  var schemaMode = wantNative ? 'outputSchema' : 'prompt-json'
  // auto 模式：带 outputSchema 同步抛错（老宿主/provider 不认参数）→ 剥参重试，prompt 内补 JSON 强箍
  if (res.syncError && wantNative && opts.schemaMode === 'auto') {
    promptUsed = prompt + PROMPT_JSON_SUFFIX
    res = await attempt(false, promptUsed)
    schemaMode = 'prompt-json(fallback)'
  }
  var elapsedMs = Date.now() - started
  if (res.timedOut) return { ok: false, schemaMode: schemaMode, elapsedMs: elapsedMs, error: 'timeout：' + opts.timeoutMs + 'ms 预算内未返回 finish', promptUsed: promptUsed }
  if (res.syncError) return { ok: false, schemaMode: schemaMode, elapsedMs: elapsedMs, error: 'llm.stream 调用失败：' + res.syncError, promptUsed: promptUsed }
  if (res.streamError) return { ok: false, schemaMode: schemaMode, elapsedMs: elapsedMs, error: 'llm.stream 流中断：' + res.streamError, usage: res.usage, promptUsed: promptUsed }
  if (res.finish && (res.finish.kind === 'error' || res.finish.kind === 'aborted')) {
    var fmsg = String((res.finish.failure && res.finish.failure.message) || res.finish.kind || '模型流失败')
    return { ok: false, schemaMode: schemaMode, elapsedMs: elapsedMs, error: 'finish:' + res.finish.kind + ' ' + fmsg, finish: res.finish, usage: res.usage, promptUsed: promptUsed }
  }
  if (!res.finish && !res.structured && !res.text) return { ok: false, schemaMode: schemaMode, elapsedMs: elapsedMs, error: '模型流无 finish 且无任何产出', promptUsed: promptUsed }
  return { ok: true, schemaMode: schemaMode, elapsedMs: elapsedMs, raw: res.text, structured: res.structured, usage: res.usage, finish: res.finish, promptUsed: promptUsed }
}

// ===== JSON 提取（prompt 模式/自由文本兜底）：直接解析 → ```json 围栏 → 首花括号配平扫描 =====
function extractJson(text) {
  var s = String(text || '').trim()
  if (!s) return null
  try { return { value: JSON.parse(s), method: 'direct' } } catch (_) {}
  var fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) { try { return { value: JSON.parse(fence[1].trim()), method: 'fence' } } catch (_) {} }
  var start = s.indexOf('{')
  if (start >= 0) {
    var depth = 0, inStr = false, esc = false
    for (var i = start; i < s.length; i++) {
      var ch = s[i]
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue }
      if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') { depth--; if (depth === 0) { try { return { value: JSON.parse(s.slice(start, i + 1)), method: 'brace-scan' } } catch (_) { break } } }
    }
  }
  return null
}

// ===== 结构校验（DECOMPOSE_SCHEMA 的 bench 侧最小实施：verdict 枚举 + children 数组 + 子卡必备字段）=====
function validateProposal(v) {
  var issues = []
  if (!v || typeof v !== 'object') return ['产出不是 JSON 对象']
  if (v.verdict !== 'split' && v.verdict !== 'keep') issues.push('verdict 只许 split|keep，收到：' + JSON.stringify(v.verdict))
  if (v.verdict === 'keep') return issues
  if (!Array.isArray(v.children)) { issues.push('children 不是数组'); return issues }
  if (v.children.length > DECOMPOSE_MAX_CHILDREN) issues.push('children 超生产上限 ' + DECOMPOSE_MAX_CHILDREN + '：' + v.children.length)
  for (var i = 0; i < v.children.length; i++) {
    var c = v.children[i]
    var at = 'children[' + i + ']'
    if (!c || typeof c !== 'object') { issues.push(at + ' 不是对象'); continue }
    ;['title', 'size', 'touches', 'acceptance', 'description'].forEach(function (f) {
      if (c[f] == null) issues.push(at + ' 缺必备字段 ' + f)
    })
    if (c.size && ['light', 'standard', 'heavy'].indexOf(c.size) < 0) issues.push(at + '.size 非法：' + JSON.stringify(c.size))
    if (c.touches != null && !Array.isArray(c.touches)) issues.push(at + '.touches 不是数组')
  }
  return issues
}

// ===== --dry-run 内置 mock llm：确定性提案（按语料 id 派生），走通 调用→解析→落盘 全链路 =====
// 行为模拟「原生支持 outputSchema 的宿主」：带 schema 时额外发 structured 块；文本始终发（证明 text-delta/提取路径）。
function mockProposalFor(corpusId) {
  var h = 0
  for (var i = 0; i < corpusId.length; i++) h = (h * 31 + corpusId.charCodeAt(i)) >>> 0
  var n = 3 + (h % 3) // 3~5 张，健康区间
  var children = []
  for (var c = 0; c < n; c++) {
    children.push({
      title: '【mock】' + corpusId + ' 纵切-' + (c + 1) + '：实现+测试同卡',
      description: 'mock 提案：' + corpusId + ' 第 ' + (c + 1) + ' 张纵切子卡（代码与测试同卡交付）。',
      size: ['light', 'standard', 'heavy'][c % 3],
      touches: ['backend/app/core/mock_' + corpusId + '_' + (c + 1) + '.py', 'backend/tests/test_mock_' + corpusId + '_' + (c + 1) + '.py'],
      acceptance: 'uv run pytest backend/tests/test_mock_' + corpusId + '_' + (c + 1) + '.py',
      dependsOn: c > 0 && (h + c) % 2 === 0 ? [String(c)] : [],
    })
  }
  return { verdict: 'split', children: children, rationale: 'mock：dry-run 确定性提案（' + n + ' 张纵切子卡）' }
}
function mockLlmFactory() {
  return {
    stream: function (req) {
      var prompt = String((req && req.messages && req.messages[0] && req.messages[0].content && req.messages[0].content[0] && req.messages[0].content[0].text) || '')
      var m = prompt.match(/源卡：bench-([A-Za-z0-9-]+)/)
      var proposal = mockProposalFor(m ? m[1] : 'unknown')
      var json = JSON.stringify(proposal, null, 2)
      return (async function* () {
        var half = Math.ceil(json.length / 2)
        yield { type: 'text-delta', text: json.slice(0, half) }
        yield { type: 'text-delta', text: json.slice(half) }
        if (req && req.outputSchema) yield { type: 'structured', value: proposal }
        yield { type: 'usage', usage: { inputTokens: 100 + json.length % 100, outputTokens: 50 + json.length % 50 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

// ===== 主流程 =====
async function main() {
  var parsed = parseArgs(process.argv.slice(2))
  if (parsed.error) { console.error('✗ ' + parsed.error); process.exit(2) }
  var opts = parsed.opts
  if (opts.help) { console.log(HELP); return }

  var corpus = await loadCorpus()
  var cards = corpus.cards
  if (opts.corpus) {
    var valid = cards.map(function (k) { return k.id })
    for (var j = 0; j < opts.corpus.length; j++) {
      if (valid.indexOf(opts.corpus[j]) < 0) { console.error('✗ 未知语料 id：' + opts.corpus[j] + '（可用：' + valid.join(',') + '）'); process.exit(2) }
    }
    cards = cards.filter(function (k) { return opts.corpus.indexOf(k.id) >= 0 })
  }

  var models = opts.models
  var llm = null, llmSource = ''
  if (opts.dryRun) {
    models = models || ['mock/dry-run']
    llm = mockLlmFactory()
    llmSource = 'dry-run 内置 mock'
  } else {
    if (!models || !models.length) { console.error('✗ 真实运行须指定 --models=provider/model,...（或用 --dry-run 验证管线；--help 看用法）'); process.exit(2) }
    var resolved = null
    try { resolved = await resolveLlm(opts) } catch (e) { console.error('✗ llm 桥接加载失败：' + String((e && e.message) || e)); process.exit(2) }
    if (!resolved) {
      // 优雅降级：llm.stream 缺席（独立 CLI 无宿主 llm 服务）——不炸栈、退出码 0、零调用零产出
      console.log('⏭ llm.stream 不可用：真实模型执行需要 DSH 宿主环境（llm 服务由宿主 ctx.get(\'llm\') 提供）。')
      console.log('  独立运行的可选路径：')
      console.log('  ① node bench/run-decompose.mjs --llm-bridge=<模块路径>  模块导出 { stream }（宿主侧桥接）')
      console.log('  ② 设环境变量 DSH_BENCH_LLM_BRIDGE=<模块路径>（同①）')
      console.log('  ③ 宿主进程内注入 globalThis.__DSH_BENCH_LLM__')
      console.log('  ④ node bench/run-decompose.mjs --dry-run  内置 mock 验证管线（不烧额度）')
      console.log('  本次已跳过：0 次调用、0 个结果文件（评分器可继续用 bench/results/ 既有产出）。')
      return
    }
    llm = resolved.llm
    llmSource = resolved.source
  }

  var ts = runTsName()
  var outRoot = opts.out ? path.resolve(opts.out) : path.join(HERE, 'results')
  var runDir = path.join(outRoot, ts)
  console.log('[bench] 拆解官行为 bench：' + cards.length + ' 语料 × ' + models.length + ' 模型｜llm 来源：' + llmSource + '｜schema-mode：' + opts.schemaMode)
  console.log('[bench] 结果目录：' + runDir)

  var okCount = 0, failCount = 0
  for (var mi = 0; mi < models.length; mi++) {
    var model = models[mi]
    var modelDir = path.join(runDir, sanitizeModelDir(model))
    for (var ci = 0; ci < cards.length; ci++) {
      var card = cards[ci]
      var tp = buildTaskAndPack(card)
      var prompt = buildDecomposerPrompt(tp.task, tp.pack)
      var call
      try { call = await callDecompose(llm, model, prompt, opts) } catch (e) { call = { ok: false, error: '调用异常：' + String((e && e.message) || e) } }
      var record = {
        benchVersion: BENCH_VERSION,
        runTs: ts,
        model: model,
        corpusId: card.id,
        schemaMode: call.schemaMode || '',
        prompt: call.promptUsed || prompt, // 实际发送版（prompt 模式含 JSON 强箍后缀，审计可逐字复盘）
        promptSha256: createHash('sha256').update(call.promptUsed || prompt).digest('hex'),
        raw: call.raw != null ? call.raw : '',
        structured: call.structured != null ? call.structured : null,
        parsed: null,
        parseError: null,
        validation: [],
        usage: call.usage || null,
        elapsedMs: call.elapsedMs != null ? call.elapsedMs : null,
        finish: call.finish || null,
        error: call.error || null,
      }
      if (call.ok) {
        var parsedOut = null, parseMethod = ''
        if (record.structured != null) { parsedOut = record.structured; parseMethod = 'structured' }
        else { var ex = extractJson(record.raw); if (ex) { parsedOut = ex.value; parseMethod = 'json:' + ex.method } }
        if (parsedOut == null) record.parseError = '无法从输出提取 JSON（raw ' + record.raw.length + ' 字符）'
        else {
          var issues = validateProposal(parsedOut)
          if (issues.length) { record.parseError = '结构校验失败：' + issues.join('；') } // parse 成功但契约不合：parsed 保留供评分（评分器会暴露行为差异）
          record.parsed = parsedOut
          record.parseMethod = parseMethod
          record.validation = issues
        }
      }
      await mkdir(modelDir, { recursive: true })
      var file = path.join(modelDir, card.id + '.json')
      await writeFile(file, JSON.stringify(record, null, 2), 'utf8')
      if (call.ok && !record.parseError) okCount++
      else failCount++
      var tag = call.ok ? (record.parseError ? '⚠ 解析失败' : '✓') : '✗ ' + String(call.error || '').slice(0, 80)
      console.log('[bench] ' + model + ' × ' + card.id + ' → ' + tag + '（' + (record.elapsedMs != null ? record.elapsedMs + 'ms' : '-') + '）')
    }
  }
  console.log('[bench] 完成：' + okCount + ' 个可解析产出 / ' + (okCount + failCount) + ' 次调用；矩阵评分：node bench/score-decompose.mjs --results=' + JSON.stringify(runDir).slice(1, -1))
}

main().catch(function (e) { console.error('✗ bench 执行器异常：' + String((e && e.stack) || e)); process.exit(2) })
