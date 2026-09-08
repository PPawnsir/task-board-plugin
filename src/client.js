// task-board-plugin Client — 非侵入式任务看板 + 树形视图
// 组件 A: sidebar.footer.action  — 侧边栏入口按钮
// 组件 B: shell.overlay            — 浮层看板（平铺/树形视图切换）

return {
  inject: ['timer'],
  apply(ctx) {
    var slots = ctx.get('slots')
    if (slots === undefined) return

    var POLL_INTERVAL_MS = 3000

    var priorityColors = {
      critical: 'var(--ds-color-red-500, #ef4444)',
      high: 'var(--ds-color-orange-500, #f97316)',
      medium: 'var(--ds-color-yellow-500, #eab308)',
      low: 'var(--ds-color-gray-400, #9ca3af)',
    }

    var statusLabels = {
      pending: '待办', 'in-progress': '进行中', verifying: '验证中',
      resolved: '已完成', blocked: '阻塞', cancelled: '已取消', archived: '已归档',
    }

    var statusColumns = ['pending', 'in-progress', 'verifying', 'resolved', 'blocked']

    // --- 共享状态 ---
    var sharedTasks = []
    var panelVisible = false
    var listeners = []

    function notifyListeners() {
      listeners.forEach(function (fn) { try { fn(sharedTasks) } catch (_e) {} })
    }

    function fetchTasks() {
      host.call('get-tasks').then(function (data) {
        sharedTasks = (data && data.tasks) || []
        notifyListeners()
      }).catch(function () {})
    }

    ctx.interval(fetchTasks, POLL_INTERVAL_MS)
    fetchTasks()

    // --- 辅助函数 ---
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

    // ============================================================
    // 组件 A：侧边栏入口按钮
    // ============================================================
    slots.inject('sidebar.footer.action', function () {
      return slots.register(
        { name: 'sidebar.footer.action', id: 'task-board-toggle', label: '任务看板' },
        function () {
          var _R = React
          var useState = _R.useState, useEffect = _R.useEffect
          var _a = useState(0), pendingCount = _a[0], setPendingCount = _a[1]

          useEffect(function () {
            function update() {
              var n = 0
              for (var i = 0; i < sharedTasks.length; i++) {
                if (sharedTasks[i].status === 'pending') n++
              }
              setPendingCount(n)
            }
            listeners.push(update)
            update()
            return function () {
              var idx = listeners.indexOf(update)
              if (idx >= 0) listeners.splice(idx, 1)
            }
          }, [])

          return React.createElement('button', {
            onClick: function () { panelVisible = !panelVisible; notifyListeners() },
            title: '任务看板' + (pendingCount > 0 ? ' (' + pendingCount + ' 待办)' : ''),
            style: {
              display: 'inline-flex', alignItems: 'center', gap: '4px',
              padding: '4px 8px', border: 'none', borderRadius: '4px',
              background: panelVisible ? 'var(--ds-color-bg-active, #e5e7eb)' : 'transparent',
              color: 'var(--ds-color-text-primary, #1f2937)',
              cursor: 'pointer', fontSize: '12px', position: 'relative',
            },
          },
            React.createElement('span', null, '\uD83D\uDCCB'),
            React.createElement('span', null, '任务看板'),
            pendingCount > 0 ? React.createElement('span', {
              style: {
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                minWidth: '16px', height: '16px', padding: '0 4px', borderRadius: '8px',
                background: 'var(--ds-color-red-500, #ef4444)', color: '#fff',
                fontSize: '10px', fontWeight: 600, lineHeight: '16px',
              },
            }, String(pendingCount)) : null,
          )
        },
      )
    })

    // ============================================================
    // 任务卡片（含子任务进度条）
    // ============================================================
    function TaskCard(props) {
      var task = props.task, onAction = props.onAction, allTasks = props.allTasks
      var priorityColor = priorityColors[task.priority] || priorityColors.low
      var isVerifying = task.status === 'verifying'
      var hasChildren = isParentTask(task, allTasks)
      var children = hasChildren ? getSubtasks(task.id, allTasks) : []
      var childResolved = hasChildren ? children.filter(function (c) { return c.status === 'resolved' }).length : 0
      var isSub = isSubtask(task)
      var parent = isSub ? getParentTask(task, allTasks) : undefined

      return React.createElement('div', {
        style: {
          border: '1px solid var(--ds-color-border, #e5e7eb)',
          borderRadius: '6px', padding: '8px 10px', marginBottom: '6px',
          fontSize: '12px', lineHeight: '1.4',
          background: 'var(--ds-color-surface, #fff)',
          borderLeft: '3px solid ' + priorityColor,
          cursor: 'default',
          animation: isVerifying ? 'taskBoardPulse 1.5s ease-in-out infinite' : 'none',
          marginLeft: isSub ? '16px' : '0',
        },
      },
        // 子任务标记：父任务摘要
        isSub && parent ? React.createElement('div', {
          style: { fontSize: '10px', color: 'var(--ds-color-text-tertiary, #9ca3af)', marginBottom: '2px' },
        }, '\u2514\u2500 父任务: ' + parent.title + ' [' + statusLabels[parent.status] + ']') : null,

        // 标题行
        React.createElement('div', {
          style: { fontWeight: 600, marginBottom: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '4px' },
        },
          React.createElement('span', { style: { flex: 1, wordBreak: 'break-word' } },
            (isSub ? '\u2514 ' : '') + task.title,
          ),
          React.createElement('span', {
            style: { fontSize: '10px', padding: '1px 5px', borderRadius: '3px', background: priorityColor, color: '#fff', whiteSpace: 'nowrap', flexShrink: 0 },
          }, task.priority || 'medium'),
        ),

        // 子任务进度条
        hasChildren && children.length > 0 ? React.createElement('div', { style: { marginBottom: '4px' } },
          React.createElement('div', {
            style: { fontSize: '10px', color: 'var(--ds-color-text-secondary, #6b7280)', marginBottom: '2px' },
          }, '\uD83D\uDCCB 子任务 ' + childResolved + '/' + children.length + ' 已完成'),
          React.createElement('div', {
            style: { height: '4px', borderRadius: '2px', background: 'var(--ds-color-surface-secondary, #e5e7eb)', overflow: 'hidden' },
          },
            React.createElement('div', {
              style: { height: '100%', width: (childResolved / children.length * 100) + '%', borderRadius: '2px', background: 'var(--ds-color-green-500, #22c55e)', transition: 'width 0.3s' },
            }),
          ),
        ) : null,

        // 描述
        task.description ? React.createElement('div', {
          style: { color: 'var(--ds-color-text-secondary, #6b7280)', marginBottom: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, task.description) : null,

        // 领取者
        task.claimedBy ? React.createElement('div', {
          style: { fontSize: '10px', color: 'var(--ds-color-text-tertiary, #9ca3af)', marginBottom: '4px' },
        }, '领取: ' + task.claimedBy.slice(0, 10) + '...') : null,

        // 解决说明
        task.resolution && (task.status === 'verifying' || task.status === 'resolved') ? React.createElement('div', {
          style: { fontSize: '10px', color: 'var(--ds-color-text-secondary, #6b7280)', marginBottom: '4px', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, '\uD83D\uDCDD ' + task.resolution) : null,

        // 操作按钮
        React.createElement('div', { style: { display: 'flex', gap: '4px', marginTop: '4px', flexWrap: 'wrap' } },
          (task.status === 'pending' || task.status === 'blocked') ? React.createElement('button', {
            onClick: function (e) { e.stopPropagation(); onAction('claim', task.id) },
            style: { fontSize: '10px', padding: '2px 6px', border: 'none', borderRadius: '3px', background: 'var(--ds-color-blue-500, #3b82f6)', color: '#fff', cursor: 'pointer' },
          }, '领取') : null,
          task.status === 'verifying' ? React.createElement(React.Fragment, null,
            React.createElement('button', {
              onClick: function (e) { e.stopPropagation(); onAction('verify', task.id, 'approved') },
              style: { fontSize: '10px', padding: '2px 6px', border: 'none', borderRadius: '3px', background: 'var(--ds-color-green-500, #22c55e)', color: '#fff', cursor: 'pointer' },
            }, '\u2705 通过'),
            React.createElement('button', {
              onClick: function (e) { e.stopPropagation(); var reason = window.prompt('驳回原因（可选）：'); onAction('verify', task.id, 'rejected', reason || '') },
              style: { fontSize: '10px', padding: '2px 6px', border: 'none', borderRadius: '3px', background: 'var(--ds-color-red-500, #ef4444)', color: '#fff', cursor: 'pointer' },
            }, '\u274C 驳回'),
          ) : null,
          task.status === 'resolved' ? React.createElement('button', {
            onClick: function (e) { e.stopPropagation(); onAction('archive', task.id) },
            style: { fontSize: '10px', padding: '2px 6px', border: 'none', borderRadius: '3px', background: 'var(--ds-color-gray-400, #9ca3af)', color: '#fff', cursor: 'pointer' },
          }, '\uD83D\uDCE6 归档') : null,
        ),
      )
    }

    // ============================================================
    // 看板面板主体
    // ============================================================
    function TaskBoardPanel() {
      var _R = React
      var useState = _R.useState, useEffect = _R.useEffect, useCallback = _R.useCallback

      var _a = useState(sharedTasks), tasks = _a[0], setTasks = _a[1]
      var _b = useState(false), visible = _b[0], setVisible = _b[1]
      var _c = useState('all'), filterStatus = _c[0], setFilterStatus = _c[1]
      var _d = useState('flat'), viewMode = _d[0], setViewMode = _d[1] // 'flat' | 'tree'

      useEffect(function () {
        function update() { setTasks(sharedTasks); setVisible(panelVisible) }
        listeners.push(update)
        update()
        return function () {
          var idx = listeners.indexOf(update)
          if (idx >= 0) listeners.splice(idx, 1)
        }
      }, [])

      var handleAction = useCallback(function (action, taskId, extra, comment) {
        if (action === 'claim') {
          host.call('claim-task', { taskId: taskId }).then(fetchTasks).catch(function () {})
        } else if (action === 'verify') {
          host.call('verify-task', { taskId: taskId, verdict: extra, comment: comment || '' }).then(fetchTasks).catch(function () {})
        } else if (action === 'archive') {
          host.call('archive-task', { taskId: taskId }).then(fetchTasks).catch(function () {})
        }
      }, [])

      if (!visible) return null

      // 过滤
      var filteredTasks = tasks
      if (filterStatus !== 'all') {
        filteredTasks = tasks.filter(function (t) { return t.status === filterStatus })
      }

      // 统计
      var counts = {}
      statusColumns.forEach(function (s) {
        counts[s] = tasks.filter(function (t) { return t.status === s }).length
      })

      // 树形视图：构建渲染列表
      function buildTreeList(taskList) {
        var result = []
        // 先找顶级任务
        var topLevel = taskList.filter(function (t) { return !isSubtask(t) })
        topLevel.forEach(function (parent) {
          result.push({ type: 'task', task: parent, depth: 0 })
          if (viewMode === 'tree') {
            var children = getSubtasks(parent.id, taskList)
            children.forEach(function (child) {
              result.push({ type: 'task', task: child, depth: 1 })
            })
          }
        })
        return result
      }

      var treeList = buildTreeList(filteredTasks)

      return React.createElement('div', {
        style: {
          position: 'fixed', top: 0, right: 0, width: '380px', height: '100vh',
          zIndex: 1000, background: 'var(--ds-color-surface, #fff)',
          borderLeft: '1px solid var(--ds-color-border, #e5e7eb)',
          boxShadow: '-4px 0 16px rgba(0,0,0,0.08)',
          display: 'flex', flexDirection: 'column',
          animation: 'taskBoardSlideIn 0.2s ease-out',
        },
      },
        // 标题栏
        React.createElement('div', {
          style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', borderBottom: '1px solid var(--ds-color-border, #e5e7eb)', flexShrink: 0 },
        },
          React.createElement('span', { style: { fontWeight: 600, fontSize: '14px' } }, '\uD83D\uDCCB 任务看板'),
          React.createElement('div', { style: { display: 'flex', gap: '4px' } },
            // 视图切换
            React.createElement('button', {
              onClick: function () { setViewMode(viewMode === 'tree' ? 'flat' : 'tree') },
              title: viewMode === 'tree' ? '切换平铺视图' : '切换树形视图',
              style: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '13px', padding: '2px 6px', borderRadius: '4px', color: viewMode === 'tree' ? 'var(--ds-color-blue-500, #3b82f6)' : 'var(--ds-color-text-secondary, #6b7280)' },
            }, viewMode === 'tree' ? '\uD83D\uDCD1' : '\uD83D\uDCC4'),
            React.createElement('button', {
              onClick: function () { fetchTasks() }, title: '刷新',
              style: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '14px', padding: '2px 6px', borderRadius: '4px' },
            }, '\uD83D\uDD04'),
            React.createElement('button', {
              onClick: function () { panelVisible = false; notifyListeners() }, title: '关闭 (ESC)',
              style: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '16px', padding: '2px 6px', borderRadius: '4px', color: 'var(--ds-color-text-secondary, #6b7280)' },
            }, '\u2715'),
          ),
        ),

        // 统计栏
        React.createElement('div', {
          style: { padding: '6px 12px', fontSize: '11px', color: 'var(--ds-color-text-secondary, #6b7280)', borderBottom: '1px solid var(--ds-color-border, #e5e7eb)', flexShrink: 0 },
        }, statusColumns.map(function (s) { return counts[s] + ' ' + statusLabels[s] }).join(' \u00B7 ')),

        // 筛选 Tab
        React.createElement('div', {
          style: { display: 'flex', gap: '2px', padding: '6px 12px', borderBottom: '1px solid var(--ds-color-border, #e5e7eb)', flexShrink: 0, overflowX: 'auto' },
        },
          [{ key: 'all', label: '全部' }].concat(statusColumns.map(function (s) { return { key: s, label: statusLabels[s] } })).map(function (tab) {
            var active = filterStatus === tab.key
            return React.createElement('button', {
              key: tab.key, onClick: function () { setFilterStatus(tab.key) },
              style: {
                fontSize: '10px', padding: '3px 8px', border: 'none', borderRadius: '4px',
                background: active ? 'var(--ds-color-blue-500, #3b82f6)' : 'var(--ds-color-surface-secondary, #f3f4f6)',
                color: active ? '#fff' : 'var(--ds-color-text-secondary, #6b7280)',
                cursor: 'pointer', whiteSpace: 'nowrap',
              },
            }, tab.label)
          }),
        ),

        // 任务列表
        React.createElement('div', { style: { flex: 1, overflowY: 'auto', padding: '8px 12px' } },
          treeList.length === 0 ? React.createElement('div', {
            style: { textAlign: 'center', padding: '40px 0', color: 'var(--ds-color-text-tertiary, #9ca3af)', fontSize: '13px' },
          }, tasks.length === 0 ? '\uD83C\uDF89 暂无任务\n在 .dsh/tasks.json 中创建任务' : '当前筛选条件下无任务') : null,

          viewMode === 'tree' ? treeList.map(function (item) {
            return React.createElement(TaskCard, {
              key: item.task.id, task: item.task, onAction: handleAction, allTasks: tasks,
            })
          }) : (
            // 平铺视图：按状态分组
            statusColumns.map(function (status) {
              var columnTasks = filteredTasks.filter(function (t) { return t.status === status })
              if (columnTasks.length === 0) return null
              return React.createElement('div', { key: status },
                React.createElement('div', {
                  style: { fontWeight: 600, fontSize: '11px', marginBottom: '6px', color: 'var(--ds-color-text-secondary, #6b7280)', textTransform: 'uppercase' },
                }, statusLabels[status] + ' (' + columnTasks.length + ')'),
                columnTasks.map(function (task) {
                  return React.createElement(TaskCard, {
                    key: task.id, task: task, onAction: handleAction, allTasks: tasks,
                  })
                }),
              )
            })
          ),
        ),
      )
    }

    // 遮罩层
    function OverlayBackdrop() {
      var _R = React
      var useState = _R.useState, useEffect = _R.useEffect
      var _a = useState(false), visible = _a[0], setVisible = _a[1]

      useEffect(function () {
        function update() { setVisible(panelVisible) }
        listeners.push(update)
        update()
        return function () { var idx = listeners.indexOf(update); if (idx >= 0) listeners.splice(idx, 1) }
      }, [])

      useEffect(function () {
        function onKeyDown(e) {
          if (e.key === 'Escape' && panelVisible) { panelVisible = false; notifyListeners() }
        }
        window.addEventListener('keydown', onKeyDown)
        return function () { window.removeEventListener('keydown', onKeyDown) }
      }, [])

      if (!visible) return null
      return React.createElement('div', {
        onClick: function () { panelVisible = false; notifyListeners() },
        style: { position: 'fixed', inset: 0, zIndex: 999, background: 'rgba(0,0,0,0.15)' },
      })
    }

    // ============================================================
    // 注册到 shell.overlay
    // ============================================================
    slots.inject('shell.overlay', function () {
      return slots.register(
        { name: 'shell.overlay', id: 'task-board-panel' },
        function () {
          return React.createElement('div', null,
            React.createElement(OverlayBackdrop),
            React.createElement(TaskBoardPanel),
          )
        },
      )
    })

    // CSS 动画
    var styles = ctx.get('styles')
    if (styles !== undefined) {
      styles.insert(
        '@keyframes taskBoardSlideIn {' +
        '  from { transform: translateX(100%); }' +
        '  to { transform: translateX(0); }' +
        '}' +
        '@keyframes taskBoardPulse {' +
        '  0%, 100% { border-color: var(--ds-color-orange-400, #fb923c); }' +
        '  50% { border-color: var(--ds-color-orange-600, #ea580c); }' +
        '}',
      )
    }
  },
}