# DSH 插件正式安装（Bundle 打包）注意事项

> 来源：dsh-agent-board 从动态插件转为静态 Bundle 的实战踩坑记录（2026-09）。
> 每条都是真实报过错换来的，改打包/安装流程前先读一遍。

## 1. 两种插件形态的本质区别

| | 动态插件（cordis_define/cordis_run） | 静态 Bundle（dsh plugin add） |
|---|---|---|
| 生命周期 | 进程级，DSH 重启即消失 | 持久，随 profile 每次启动挂载 |
| 定义方式 | 运行时 define，源码仅存内存 | npm 包装进 profile node_modules |
| 适用 | 开发调试、临时能力、快速试错 | 正式交付、跨会话共享 |
| host API | `harness.defineTool` / `harness.registerTool` / `harness.handle` | `ctx.tools.register` / `ctx.webServer.register` |
| client API | 全局 `React` + `host.call()` | `require('react')` + `fetch()` 走 webServer 路由 |

**关键**：动态转静态不是"保存一下"，两端 API 都要机械转换。本仓库迁移期曾用 `scripts/build-pkg.cjs` 自动完成（带计数断言）；插件稳定后于 v68 拆除转换层，包内文件即唯一源码。本文档的坑仍然有效——它们发生在 API 与装载层，与是否有转换层无关。

## 2. 打包结构（必备四件）

```
my-plugin/
├── package.json        # 必须含 dsh.bundle.patch + dsh.client 元数据
├── cordis.patch.yml    # - insert: 插件行（纯 insert 才能热挂载）
├── index.mjs           # host 端：export const name/inject + export function apply
└── lib/client.js       # client 端：window.__ModuleLoader__.load({id, factory}) 包装
```

package.json 最小模板：

```json
{
  "name": "dsh-agent-board",
  "type": "module",
  "main": "./index.mjs",
  "exports": {
    ".": "./index.mjs",
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "inject": ["@deepseek-ai/dsh-client-runtime"], "platform": "web" }
  }
}
```

## 3. 踩过的坑（按踩坑顺序）

### 坑 1：link: 安装 + 裸 import 外部包 = ERR_MODULE_NOT_FOUND

**现象**：boot 崩溃 `Cannot find package '@deepseek-ai/dsh-tools' imported from D:\...\index.mjs`。

**原因**：`dsh plugin add <本地路径>` 产生的是 `link:` 软链。Node ESM 从包的**真实路径**（源码目录）向上找 node_modules，不会用 profile 的 node_modules。pnpm 复制安装的包（如 dsh-chat-import）靠 `.pnpm` 结构解析 peer 依赖，软链包享受不到。

**修法**：Bundle 包**零外部运行时依赖**。`@deepseek-ai/dsh-tools` 的 `defineTool` 只是"校验+包装出 `{name, description, parameters, output, execute}` 普通对象"，20 行内联等价实现即可（见 index.mjs 头部注释）。真要 import 就用 npm 发布安装，不要 link。

### 坑 2：var 只提升声明不提升赋值

**现象**：`Cannot set properties of undefined (setting 'get-tasks')`，boot 崩溃在 Fiber.execute。

**原因**：转换时把 `var handlers = {}` + `function handle()` 插到了文件尾部，而 `handle('get-tasks', ...)` 调用在文件中段。函数声明提升、对象赋值不提升——第一个 handle() 执行时 handlers 还是 undefined。

**修法**：共享的可变状态容器（注册表、handlers 表）一律在 `apply` **开头**初始化；纯函数声明可以靠提升放任意位置。改完用行号验证顺序：声明行 < 首个调用行 < 使用行。

### 坑 3：bundles 列表与 dependencies 是两笔账

**现象**：市场插件页显示"未声明 dsh.bundle，不会进入 profile bundle 层(纯客户端插件)"，但 package.json 明明声明了 `dsh.bundle`。

**原因**：这句文案有误导性。dshmarket 的真实判定（verify.js:229）是"**声明了 dsh.client 但包名不在 `dsh.profile.bundles` 数组里**"——跟 dsh.bundle 字段无关。boot 失败时手动从 profile package.json 移除依赖，bundles 条目会一起丢；之后即使重装依赖，bundles 行也不会自动回来。

**修法**：检查 `~/.dsh/profiles/<name>/package.json` 的**两处**：
- `dependencies["<pkg>"]` — 装没装
- `dsh.profile.bundles` — 挂没挂（缺了就手动补回数组末尾）

### 坑 4：import 阶段的错误会拖垮整棵树

**现象**：插件一个 import 失败，整个 DSH 起不来（`plugin tree failed to load`）。

**原因**：loader 的隔离只在**插件 apply 之后**生效；import 解析失败发生在更早的阶段，无隔离。

**修法**：host 端 index.mjs 保持极简 import（最好零 import）。起不来时的恢复路径：从 profile package.json 的 dependencies + bundles **两处同时移除**该包，重启，修好后再加回。

### 坑 5：codec 拒绝 undefined（动态插件期遗留）

**现象**：client→host 调用报 `codec rejected "args"`。

**原因**：RPC 序列化层只接受纯 JSON，payload 里任何值为 `undefined` 的字段都会被拒。

**修法**：条件组装 payload——`if (value !== undefined) payload.value = value`，不要图省事固定传全字段。

## 4. client 端转换要点

- 整包进 `window.__ModuleLoader__.load({ id, factory })` 工厂；`React` 用 `require('react')` 取，没有全局 React
- `host.call(method, args)` → `fetch('/<route>', { method: 'POST', body: JSON.stringify({ method, args }) })`，host 侧配一条 `ctx.webServer.register({ kind: 'exact', path: '/<route>', handler })` 做 method 分发
- 动态插件的 `ctx.interval(cb, ms)` 快捷方式不存在，用 `ctx.get('timer')` + `ctx.effect(() => timer.interval(cb, ms))`
- 保守起见 client 不声明 inject，全部用 `ctx.get('xxx')` + 存在性守卫（服务缺失时插件优雅退出而不是永远不启动）

## 5. 安装与验证流程

> v68 起拆除了转换层（build-pkg.cjs），包内文件即源码。以下为当前流程。

```sh
# 1. 改完语法检查
node --check packages/dsh-agent-board/index.mjs
node --check packages/dsh-agent-board/lib/client.js

# 2. 安装（link: 软链，之后改源码只需重启，无需重装）
dsh plugin --profile web add <repo>/packages/dsh-agent-board

# 3. 重启生效
dsh --profile web
```

验证清单：
- [ ] boot 无 `plugin tree failed to load`
- [ ] `dsh.profile.bundles` 含包名（市场页面不再显示"纯客户端"提示）
- [ ] `curl -X POST http://127.0.0.1:3080/<route> -d '{"method":"..."}'` 返回 JSON 而非 405 空 body（405 空 body = 前端静态服务器的默认响应，说明路由没挂上）
- [ ] 页面刷新后 client UI 出现（本插件：会话标题栏 📋 按钮）

## 6. 其他备忘

- **`patchReload: live`** 只对 `cordis.patch.yml` 改动生效；新增/移除 bundle（package.json 变化）必须重启进程
- **动态 vs 静态冲突**：静态包挂载后，同名动态插件必须停掉（工具名重复注册会冲突）；DSH 重启会自然清掉动态插件，通常无需手动处理
- **数据兼容**：动态/静态读写同一份数据文件（本插件 `~/.dsh/tasks-<sessionId>.json`），切换形态不丢数据
- 参考实现：`~/.dsh/profiles/web/node_modules/dsh-chat-import`（完整模板）、`web_backup/node_modules/dsh-task-board`（webServer 路由模式出处）

## 7. 静态化的架构冲击：进程单例 vs 会话隔离（重要）

动态插件**每个会话一个实例**，实例内的状态（如执行池）天然按会话隔离。静态 Bundle 挂 host 层后是**全进程单例**——所有会话共享同一个 `apply` 闭包。

**踩过的坑（真实事故，worker 报"幽灵指派"）**：执行池写成单例 `var pool = {...}`，多会话共存后：
- 会话 B 的 poolCycle spawn worker 时 `parent = getFirstRootAgent()`（取了会话 A 的 root）
- worker 的工具调用经 `resolveRoot` 解析到会话 A 的看板 → 任务在会话 B 的看板里，工具却查 A → `not found`
- poolStatus 快照被写进多个会话的看板文件，互相污染

**修法**：
1. 一切会话级状态按 sessionId 分桶：`var pools = {}; function poolFor(sid) {...}`
2. spawn parent 用 `rootForSession(sid)` 精确匹配（遍历 `agents.roots()` 找 `String(id) === sid`），找不到就不 spawn
3. 通知类（notifyMainWindow / markSuspect 的 followup）同样按 sid 找 root，不能"取第一个"
4. `ctx.effect` 清理函数遍历所有会话桶

**自检清单**：凡是动态转静态的插件，全局搜 `var xxx = {}` / `var xxx = new Map()` 级别的可变单例，逐一问"这个状态是会话级还是进程级"。
