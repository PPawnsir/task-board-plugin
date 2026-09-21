const fs = require('fs');
const f = 'D:/deepseek-work/task-board-plugin/packages/dsh-agent-board/lib/client.js';
let c = fs.readFileSync(f, 'utf8');
const a = "'前往归档页 →')) : null : null,";
const b = "'前往归档页 →')) : null,";
if (c.includes(a)) { c = c.split(a).join(b); fs.writeFileSync(f, c); console.log('双重 null 已修复') } else { console.log('未找到目标'); process.exit(1) }
// showArchived 残留检查
const lines = c.split('\n');
lines.forEach((l, i) => { if (l.includes('showArchived')) console.log('L' + (i + 1) + ': ' + l.trim().slice(0, 120)) });
