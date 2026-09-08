// task-board-plugin Host — 6 个 Tool + 上下文解析器 + 子任务自动流转 + 6 个 RPC Handler
// 此文件为 Cordis Plugin 的 code.host 函数体

return {
  apply(ctx) {
    // --- 依赖检查 ---
    const fs = ctx.get('fs')
    if (fs === undefined) {
      console.error('[task-board] fs service unavailable')
      return
    }

    // --- 常量 ---
    const TASK_FILE_PREFIX = '.dsh/tasks-'
    const TASK_FILE_SUFFIX = '.json'
    const BACKUP_FILE = '.dsh/tasks.backup.json'
    const MAX_CLAIMED = 3
    const MAX_FILE_CONTENT_CHARS = 5000   // 单文件内容截断上限
    const MAX_TOTAL_CONTEXT_CHARS = 20000  // 总上下文截断上限
    const CLAIMABLE_STATUSES = ['pending', 'blocked']

    // --- 辅助函数 ---
    function getSessionId() {
      const agents = ctx.get('agents')
      if (agents === undefined) return 'unknown'
      const initiator = agents.currentInitiator()
      // 返回根会话 ID：子 Agent 始终回到发起链的根 Agent
      return initiator ? String(initiator.id) : 'unknown'
    }

    function getTaskFilePath() {
      return TASK_FILE_PREFIX + getSessionId() + TASK_FILE_SUFFIX
    }

    function validateTasks(data) {
      if (data === null || typeof data !== 'object') return false
      if (!Array.isArray(data.tasks)) return false
      return true
    }

    function addHistory(task, from, to, actor, note) {
      if (!Array.isArray(task.history)) task.history = []
      task.history.push({
        from: from, to: to,
        timestamp: new Date().toISOString(),
        actor: actor, note: note || '',
      })
    }

    function isSubtask(task) {
      return task.parentId !== null && task.parentId !== undefined
    }

    function isParentTask(task, allTasks) {
      return allTasks.some(function (t) { return t.parentId === task.id })
    }

    function getSubtasks(parentId, allTasks) {
      return allTasks.filter(function (t) { return t.parentId === parentId })
    }

    function getParentTask(task, allTasks) {
      if (!isSubtask(task)) return undefined
      return allTasks.find(function (t) { return t.id === task.parentId })
    }

    // --- 上下文继承合并 ---
    function mergeContext(parent, child) {
      var pCtx = (parent && parent.context) || {}
      var cCtx = (child && child.context) || {}
      return {
        files: Array.from(new Set(
          (pCtx.files || []).concat(cCtx.files || [])
        )),
        docs: Array.from(new Set(
          (pCtx.docs || []).concat(cCtx.docs || [])
        )),
        instructions: cCtx.instructions || pCtx.instructions || '',
        prerequisites: [pCtx.prerequisites, cCtx.prerequisites]
          .filter(Boolean).join('; '),
        relatedTasks: Array.from(new Set(
          (pCtx.relatedTasks || []).concat(cCtx.relatedTasks || [])
        )),
      }
    }

    function getEffectiveContext(task, allTasks) {
      if (isSubtask(task)) {
        var parent = getParentTask(task, allTasks)
        return mergeContext(parent, task)
      }
      return task.context || {}
    }

    // --- 任务存储 ---
    async function readTasks(target) {
      try {
        var raw = await fs.readText(target)
        var data = JSON.parse(raw)
        if (!validateTasks(data)) {
          console.error('[task-board] Invalid tasks.json format')
          return { version: 3, ownerSession: getSessionId(), tasks: [] }
        }
        return data
      } catch (_err) {
        return { version: 3, ownerSession: getSessionId(), tasks: [] }
      }
    }

    async function writeTasks(target, data) {
      var content = JSON.stringify(data, null, 2)
      try {
        try {
          var backupTarget = await fs.resolve(BACKUP_FILE, { cwd: process.cwd() })
          var existing = await readTasks(target)
          await fs.writeText(backupTarget, JSON.stringify(existing, null, 2))
        } catch (_backupErr) { /* 备份失败不阻塞 */ }
        await fs.writeText(target, content)
      } catch (err) {
        console.error('[task-board] Write failed:', String(err))
        throw err
      }
    }

    async function getTaskFile() {
      return fs.resolve(getTaskFilePath(), { cwd: process.cwd() })
    }

    // --- 上下文解析器 ---
    async function resolveContext(task, allTasks, expandFiles, includeParent, includeSubtasks) {
      var result = { task: task }

      // 继承上下文
      result.inheritedContext = getEffectiveContext(task, allTasks)

      // 父任务信息
      if (includeParent !== false && isSubtask(task)) {
        var parent = getParentTask(task, allTasks)
        if (parent) {
          result.parent = {
            id: parent.id, title: parent.title,
            status: parent.status, priority: parent.priority,
            description: parent.description,
          }
        }
      }

      // 子任务列表
      if (includeSubtasks !== false) {
        var children = getSubtasks(task.id, allTasks)
        if (children.length > 0) {
          result.subtasks = children.map(function (c) {
            return {
              id: c.id, title: c.title, status: c.status,
              priority: c.priority, claimedBy: c.claimedBy,
            }
          })
          result.subtaskProgress = {
            total: children.length,
            resolved: children.filter(function (c) { return c.status === 'resolved' }).length,
            inProgress: children.filter(function (c) { return c.status === 'in-progress' }).length,
            pending: children.filter(function (c) { return c.status === 'pending' }).length,
          }
        }
      }

      // 展开文件内容
      if (expandFiles) {
        result.expandedFiles = {}
        var files = result.inheritedContext.files || []
        var totalChars = 0
        for (var i = 0; i < files.length && totalChars < MAX_TOTAL_CONTEXT_CHARS; i++) {
          var filePath = files[i]
          // 安全检查：拒绝路径穿越
          if (filePath.indexOf('..') >= 0) {
            result.expandedFiles[filePath] = '[SKIPPED: path traversal rejected]'
            continue
          }
          try {
            var fileTarget = await fs.resolve(filePath, { cwd: process.cwd() })
            var content = await fs.readText(fileTarget)
            if (content.length > MAX_FILE_CONTENT_CHARS) {
              content = content.slice(0, MAX_FILE_CONTENT_CHARS) +
                '\n... [truncated, ' + (content.length - MAX_FILE_CONTENT_CHARS) + ' more chars]'
            }
            result.expandedFiles[filePath] = content
            totalChars += content.length
          } catch (_err) {
            result.expandedFiles[filePath] = '[ERROR: unable to read file]'
          }
        }
      }

      // 关联任务状态
      var relatedIds = result.inheritedContext.relatedTasks || []
      if (relatedIds.length > 0) {
        result.relatedTaskStatuses = {}
        relatedIds.forEach(function (rid) {
          var rt = allTasks.find(function (t) { return t.id === rid })
          result.relatedTaskStatuses[rid] = rt
            ? { status: rt.status, title: rt.title }
            : { status: 'not-found', title: 'unknown' }
        })
      }

      return result
    }

    // --- 子任务自动流转检查 ---
    async function checkParentAutoTransition(childTask, allTasks, target, sessionId) {
      if (!isSubtask(childTask)) return null
      var parent = getParentTask(childTask, allTasks)
      if (!parent) return null
      if (parent.status !== 'in-progress') return null

      var siblings = getSubtasks(parent.id, allTasks)
      var allResolved = siblings.every(function (s) {
        return s.id === childTask.id ? true : s.status === 'resolved'
      })
      // 当前子任务也变为 resolved 才算
      allResolved = allResolved && true

      if (allResolved) {
        var prevStatus = parent.status
        parent.status = 'verifying'
        parent.resolvedAt = new Date().toISOString()
        parent.resolution = '所有子任务已完成 [' +
          siblings.map(function (s) { return s.id }).join(', ') + ']'
        addHistory(parent, prevStatus, 'verifying', 'system',
          '所有子任务已完成，自动进入验证')
        await writeTasks(target, { version: 3, ownerSession: getSessionId(), tasks: allTasks })
        return { parentUpdated: true, parentId: parent.id }
      }
      return null
    }

    // ============================================================
    // Tool 注册
    // ============================================================

    // Tool 1: task_list
    harness.registerTool(ctx, harness.defineTool({
      name: 'task_list',
      description: '列出当前工作区的所有任务，支持按状态、优先级、标签、父子关系筛选。默认不返回已归档任务。每个子任务附带父任务摘要。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending','in-progress','verifying','resolved','blocked','cancelled'], description: '按状态筛选' },
          priority: { type: 'string', enum: ['low','medium','high','critical'], description: '按优先级筛选' },
          tag: { type: 'string', description: '按标签筛选' },
          parentId: { type: 'string', description: '筛选指定父任务的所有子任务；传 "null" 只返回顶级任务' },
          includeArchived: { type: 'boolean', description: '是否包含已归档任务，默认 false' },
          limit: { type: 'number', description: '返回数量上限，默认 20' },
        },
      },
      execute: async function (args) {
        var target = await getTaskFile()
        var data = await readTasks(target)
        var allTasks = data.tasks
        var tasks = allTasks

        if (!args.includeArchived) {
          tasks = tasks.filter(function (t) { return t.status !== 'archived' })
        }
        if (args.status) {
          tasks = tasks.filter(function (t) { return t.status === args.status })
        }
        if (args.priority) {
          tasks = tasks.filter(function (t) { return t.priority === args.priority })
        }
        if (args.tag) {
          tasks = tasks.filter(function (t) {
            return Array.isArray(t.tags) && t.tags.indexOf(args.tag) >= 0
          })
        }
        if (args.parentId === 'null') {
          tasks = tasks.filter(function (t) { return !isSubtask(t) })
        } else if (args.parentId) {
          tasks = tasks.filter(function (t) { return t.parentId === args.parentId })
        }

        var priorityOrder = { critical: 4, high: 3, medium: 2, low: 1 }
        tasks.sort(function (a, b) {
          var pDiff = (priorityOrder[b.priority] || 0) - (priorityOrder[a.priority] || 0)
          if (pDiff !== 0) return pDiff
          return (a.createdAt || '').localeCompare(b.createdAt || '')
        })

        var limit = Math.min(args.limit || 20, 100)
        var result = tasks.slice(0, limit).map(function (t) {
          var enriched = Object.assign({}, t)
          if (isSubtask(t)) {
            var parent = getParentTask(t, allTasks)
            if (parent) {
              enriched.parentSummary = { id: parent.id, title: parent.title, status: parent.status }
            }
          }
          if (isParentTask(t, allTasks)) {
            var children = getSubtasks(t.id, allTasks)
            enriched.subtaskCount = children.length
            enriched.subtaskResolved = children.filter(function (c) { return c.status === 'resolved' }).length
          }
          return enriched
        })

        return { tasks: result, total: tasks.length }
      },
    }))

    // Tool 2: task_context — 获取完整上下文（新增）
    harness.registerTool(ctx, harness.defineTool({
      name: 'task_context',
      description: '获取一个任务的完整上下文，包括关联文件内容、父任务信息、子任务列表、继承合并后的上下文。子 Agent 在领取任务后应调用此工具获取足够信息。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '要获取上下文的任务 ID' },
          expandFiles: { type: 'boolean', description: '是否读取关联文件的实际内容，默认 false' },
          includeParent: { type: 'boolean', description: '是否包含父任务信息，默认 true' },
          includeSubtasks: { type: 'boolean', description: '是否包含子任务列表，默认 true' },
        },
        required: ['taskId'],
      },
      execute: async function (args) {
        var target = await getTaskFile()
        var data = await readTasks(target)
        var task = data.tasks.find(function (t) { return t.id === args.taskId })
        if (task === undefined) {
          return { ok: false, error: '任务 ' + args.taskId + ' 不存在' }
        }
        var context = await resolveContext(
          task, data.tasks,
          args.expandFiles || false,
          args.includeParent !== false,
          args.includeSubtasks !== false,
        )
        return { ok: true, context: context }
      },
    }))

    // Tool 3: task_claim
    harness.registerTool(ctx, harness.defineTool({
      name: 'task_claim',
      description: 'Agent 领取一个待办任务，将其状态改为 in-progress。领取时返回任务的完整上下文（含继承的父任务上下文）。子任务需父任务已进入 in-progress 才可领取。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '要领取的任务 ID' },
          reason: { type: 'string', description: '领取理由（可选）' },
        },
        required: ['taskId'],
      },
      execute: async function (args) {
        var target = await getTaskFile()
        var data = await readTasks(target)
        var allTasks = data.tasks
        var sessionId = getSessionId()

        var task = allTasks.find(function (t) { return t.id === args.taskId })
        if (task === undefined) {
          return { ok: false, error: '任务 ' + args.taskId + ' 不存在' }
        }
        if (CLAIMABLE_STATUSES.indexOf(task.status) < 0) {
          return { ok: false, error: '任务 ' + args.taskId + ' 当前状态为 ' + task.status + '，无法领取' }
        }
        if (task.claimedBy !== null && task.claimedBy !== sessionId && task.status === 'in-progress') {
          return { ok: false, error: '任务 ' + args.taskId + ' 已被 ' + task.claimedBy + ' 领取' }
        }

        // 子任务：检查父任务状态
        if (isSubtask(task)) {
          var parent = getParentTask(task, allTasks)
          if (!parent) {
            return { ok: false, error: '父任务不存在' }
          }
          if (parent.status !== 'in-progress' && parent.status !== 'verifying') {
            return { ok: false, error: '父任务 ' + parent.id + ' 当前状态为 ' + parent.status + '，子任务暂不可领取（需父任务进入 in-progress）' }
          }
          // sequential 模式：检查顺序
          if (parent.subtaskStrategy === 'sequential') {
            var siblings = getSubtasks(parent.id, allTasks)
            // 按创建时间排序
            siblings.sort(function (a, b) {
              return (a.createdAt || '').localeCompare(b.createdAt || '')
            })
            var taskIdx = siblings.findIndex(function (s) { return s.id === task.id })
            for (var i = 0; i < taskIdx; i++) {
              if (siblings[i].status !== 'resolved') {
                return { ok: false, error: '串行模式：前序子任务 ' + siblings[i].id + ' (' + siblings[i].title + ') 尚未完成，当前任务不可领取' }
              }
            }
          }
        }

        // 检查领取上限（排除子任务）
        var myClaims = allTasks.filter(function (t) {
          return t.claimedBy === sessionId &&
            (t.status === 'in-progress' || t.status === 'verifying') &&
            !isSubtask(t)
        })
        if (!isSubtask(task) && myClaims.length >= MAX_CLAIMED) {
          return { ok: false, error: '当前 Agent 已持有 ' + myClaims.length + ' 个活跃任务（上限 ' + MAX_CLAIMED + '），请先完成或释放部分任务' }
        }

        var prevStatus = task.status
        task.status = 'in-progress'
        task.claimedBy = sessionId
        task.claimedAt = new Date().toISOString()
        addHistory(task, prevStatus, 'in-progress', sessionId, args.reason || 'Agent 领取任务')

        await writeTasks(target, data)

        // 返回完整上下文
        var context = await resolveContext(task, data.tasks, false, true, true)
        return { ok: true, task: task, context: context }
      },
    }))

    // Tool 4: task_resolve — 提交任务（含自动流转）
    harness.registerTool(ctx, harness.defineTool({
      name: 'task_resolve',
      description: 'Agent 完成任务后提交验证（verifying）或标记阻塞（blocked）。若子任务全部 resolved，父任务自动进入 verifying。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '要提交的任务 ID' },
          status: { type: 'string', enum: ['verifying', 'blocked'], description: '目标状态' },
          resolution: { type: 'string', description: '解决说明（status=verifying 时必填）' },
        },
        required: ['taskId', 'status'],
      },
      execute: async function (args) {
        var target = await getTaskFile()
        var data = await readTasks(target)
        var allTasks = data.tasks
        var sessionId = getSessionId()

        var task = allTasks.find(function (t) { return t.id === args.taskId })
        if (task === undefined) {
          return { ok: false, error: '任务 ' + args.taskId + ' 不存在' }
        }
        if (task.status !== 'in-progress') {
          return { ok: false, error: '任务 ' + args.taskId + ' 当前状态为 ' + task.status + '，只有进行中的任务才能提交' }
        }
        if (task.claimedBy !== sessionId) {
          return { ok: false, error: '任务由 ' + task.claimedBy + ' 领取，当前 Agent 无权提交' }
        }
        if (args.status === 'verifying' && !args.resolution) {
          return { ok: false, error: '提交验证时必须提供 resolution（解决说明）' }
        }

        var prevStatus = task.status
        task.status = args.status
        task.resolution = args.resolution || null
        task.resolvedAt = new Date().toISOString()
        addHistory(task, prevStatus, args.status, sessionId,
          args.status === 'verifying'
            ? 'Agent 提交验证: ' + (args.resolution || '')
            : 'Agent 标记阻塞: ' + (args.resolution || ''))

        await writeTasks(target, data)

        var result = { ok: true, task: task }

        // 检查父任务自动流转
        if (args.status === 'verifying' && isSubtask(task)) {
          // 重新读取确保数据一致
          var freshData = await readTasks(target)
          var freshTasks = freshData.tasks
          var freshTask = freshTasks.find(function (t) { return t.id === task.id })
          if (freshTask) freshTask.status = 'verifying' // 确保内存状态一致
          var autoTransition = await checkParentAutoTransition(
            freshTask || task, freshTasks, target, sessionId,
          )
          if (autoTransition) {
            result.parentUpdated = true
            result.parentId = autoTransition.parentId
          }
        }

        return result
      },
    }))

    // Tool 5: task_verify
    harness.registerTool(ctx, harness.defineTool({
      name: 'task_verify',
      description: '对 Agent 提交的任务进行验收。approved 通过进入 resolved；rejected 驳回退回 in-progress。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '要验证的任务 ID' },
          verdict: { type: 'string', enum: ['approved', 'rejected'], description: 'approved 或 rejected' },
          comment: { type: 'string', description: '验证意见' },
        },
        required: ['taskId', 'verdict'],
      },
      execute: async function (args) {
        var target = await getTaskFile()
        var data = await readTasks(target)
        var allTasks = data.tasks
        var sessionId = getSessionId()

        var task = allTasks.find(function (t) { return t.id === args.taskId })
        if (task === undefined) {
          return { ok: false, error: '任务 ' + args.taskId + ' 不存在' }
        }
        if (task.status !== 'verifying') {
          return { ok: false, error: '任务 ' + args.taskId + ' 当前状态为 ' + task.status + '，只有验证中的任务才能验收' }
        }

        var prevStatus = task.status
        if (args.verdict === 'approved') {
          task.status = 'resolved'
          task.verifiedAt = new Date().toISOString()
          task.verifiedBy = sessionId
          addHistory(task, prevStatus, 'resolved', sessionId, '验证通过' + (args.comment ? ': ' + args.comment : ''))
        } else {
          task.status = 'in-progress'
          task.resolvedAt = null
          task.resolution = null
          addHistory(task, prevStatus, 'in-progress', sessionId, '驳回' + (args.comment ? ': ' + args.comment : ''))
        }

        await writeTasks(target, data)
        return { ok: true, task: task }
      },
    }))

    // Tool 6: task_archive — 归档（含级联）
    harness.registerTool(ctx, harness.defineTool({
      name: 'task_archive',
      description: '将已解决或已取消的任务归档。归档父任务时，所有子任务自动级联归档。归档不可逆。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '要归档的任务 ID' },
        },
        required: ['taskId'],
      },
      execute: async function (args) {
        var target = await getTaskFile()
        var data = await readTasks(target)
        var allTasks = data.tasks
        var sessionId = getSessionId()

        var task = allTasks.find(function (t) { return t.id === args.taskId })
        if (task === undefined) {
          return { ok: false, error: '任务 ' + args.taskId + ' 不存在' }
        }
        if (task.status !== 'resolved' && task.status !== 'cancelled') {
          return { ok: false, error: '任务 ' + args.taskId + ' 当前状态为 ' + task.status + '，只有已完成或已取消的任务才能归档' }
        }

        var prevStatus = task.status
        task.status = 'archived'
        task.archivedAt = new Date().toISOString()
        addHistory(task, prevStatus, 'archived', sessionId, '归档')

        // 级联归档子任务
        var childrenArchived = 0
        var children = getSubtasks(task.id, allTasks)
        children.forEach(function (child) {
          if (child.status !== 'archived') {
            addHistory(child, child.status, 'archived', sessionId, '父任务归档，级联归档')
            child.status = 'archived'
            child.archivedAt = new Date().toISOString()
            childrenArchived++
          }
        })

        await writeTasks(target, data)

        var result = { ok: true, task: task }
        if (childrenArchived > 0) {
          result.childrenArchived = childrenArchived
        }
        return result
      },
    }))

    // ============================================================
    // RPC Handlers
    // ============================================================

    harness.handle('get-tasks', async function () {
      var target = await getTaskFile()
      return await readTasks(target)
    })

    harness.handle('get-context', async function (args) {
      var target = await getTaskFile()
      var data = await readTasks(target)
      var task = data.tasks.find(function (t) { return t.id === args.taskId })
      if (task === undefined) return { ok: false, error: '任务不存在' }
      return {
        ok: true,
        context: await resolveContext(
          task, data.tasks,
          args.expandFiles || false,
          args.includeParent !== false,
          args.includeSubtasks !== false,
        ),
      }
    })

    harness.handle('claim-task', async function (args) {
      var target = await getTaskFile()
      var data = await readTasks(target)
      var allTasks = data.tasks
      var sessionId = getSessionId()
      var task = allTasks.find(function (t) { return t.id === args.taskId })
      if (task === undefined) return { ok: false, error: '任务不存在' }
      if (CLAIMABLE_STATUSES.indexOf(task.status) < 0) {
        return { ok: false, error: '任务状态不允许领取' }
      }
      var prevStatus = task.status
      task.status = 'in-progress'
      task.claimedBy = sessionId
      task.claimedAt = new Date().toISOString()
      addHistory(task, prevStatus, 'in-progress', sessionId, '手动领取')
      await writeTasks(target, data)
      return { ok: true, task: task }
    })

    harness.handle('resolve-task', async function (args) {
      var target = await getTaskFile()
      var data = await readTasks(target)
      var sessionId = getSessionId()
      var task = data.tasks.find(function (t) { return t.id === args.taskId })
      if (task === undefined) return { ok: false, error: '任务不存在' }
      if (task.status !== 'in-progress') return { ok: false, error: '只有进行中的任务才能提交' }
      var prevStatus = task.status
      task.status = args.status
      task.resolution = args.resolution || null
      task.resolvedAt = new Date().toISOString()
      addHistory(task, prevStatus, args.status, sessionId, '手动提交')
      await writeTasks(target, data)
      return { ok: true, task: task }
    })

    harness.handle('verify-task', async function (args) {
      var target = await getTaskFile()
      var data = await readTasks(target)
      var sessionId = getSessionId()
      var task = data.tasks.find(function (t) { return t.id === args.taskId })
      if (task === undefined) return { ok: false, error: '任务不存在' }
      if (task.status !== 'verifying') return { ok: false, error: '只有验证中的任务才能验收' }
      var prevStatus = task.status
      if (args.verdict === 'approved') {
        task.status = 'resolved'
        task.verifiedAt = new Date().toISOString()
        task.verifiedBy = sessionId
        addHistory(task, prevStatus, 'resolved', sessionId, '验证通过')
      } else {
        task.status = 'in-progress'
        task.resolvedAt = null
        task.resolution = null
        addHistory(task, prevStatus, 'in-progress', sessionId, '驳回: ' + (args.comment || ''))
      }
      await writeTasks(target, data)
      return { ok: true, task: task }
    })

    harness.handle('archive-task', async function (args) {
      var target = await getTaskFile()
      var data = await readTasks(target)
      var allTasks = data.tasks
      var sessionId = getSessionId()
      var task = allTasks.find(function (t) { return t.id === args.taskId })
      if (task === undefined) return { ok: false, error: '任务不存在' }
      if (task.status !== 'resolved' && task.status !== 'cancelled') {
        return { ok: false, error: '只有已完成或已取消的任务才能归档' }
      }
      var prevStatus = task.status
      task.status = 'archived'
      task.archivedAt = new Date().toISOString()
      addHistory(task, prevStatus, 'archived', sessionId, '手动归档')
      var childrenArchived = 0
      var children = getSubtasks(task.id, allTasks)
      children.forEach(function (child) {
        if (child.status !== 'archived') {
          addHistory(child, child.status, 'archived', sessionId, '父任务归档，级联归档')
          child.status = 'archived'
          child.archivedAt = new Date().toISOString()
          childrenArchived++
        }
      })
      await writeTasks(target, data)
      var result = { ok: true, task: task }
      if (childrenArchived > 0) result.childrenArchived = childrenArchived
      return result
    })

    console.log('[task-board] Host plugin loaded — 6 tools + 6 RPC handlers')
  },
}