const fs = require('fs');
const zlib = require('zlib');

const buf = fs.readFileSync(process.argv[2]);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const parts = [];
let off = 0;
while (off < buf.length) {
  try { parts.push(zlib.zstdDecompressSync(buf.subarray(off))) } catch (e) { break }
  const next = buf.indexOf(MAGIC, off + 1);
  if (next < 0) break;
  off = next;
}
const lines = Buffer.concat(parts).toString('utf8').split('\n').filter(Boolean);

let firstAssistantIdx = -1, snapshotIdx = -1, escalateIdx = -1, snapshotText = '';
for (let i = 0; i < lines.length; i++) {
  let e; try { e = JSON.parse(lines[i]) } catch (_) { continue }
  const msg = e.message || (e.data && e.data.message);
  const role = msg && msg.role;
  if (firstAssistantIdx < 0 && (role === 'assistant' || e.type === 'assistant/chunk' || e.type === 'assistant/message')) firstAssistantIdx = i;
  if (escalateIdx < 0 && lines[i].includes('ESCALATE')) escalateIdx = i;
  if (snapshotIdx < 0 && role === 'user' && Array.isArray(msg.content)) {
    const t = msg.content.find(c => c.type === 'text');
    if (t && t.text && t.text.includes('Current runtime context') && t.text.includes('主窗口调研笔记')) {
      snapshotIdx = i; snapshotText = t.text;
    }
  }
}

console.log('总事件数:', lines.length);
console.log('首个 assistant 事件位置:', firstAssistantIdx);
console.log('首个含预研内容的 context 快照位置:', snapshotIdx);
console.log('是否出现 escalate:', escalateIdx >= 0 ? '是（位置 ' + escalateIdx + '）' : '否');
console.log('');
console.log(snapshotIdx >= 0 && (firstAssistantIdx < 0 || snapshotIdx < firstAssistantIdx)
  ? '✅ 首轮注入成功：context 快照先于 assistant 首轮回合出现（竞速修复生效）'
  : snapshotIdx >= 0 ? '⚠️ 快照晚于首轮回合（竞速仍在）' : '❌ 未找到预研快照');
if (snapshotText) {
  console.log('');
  console.log('=== 快照中的预研段（前 500 字符）===');
  const i = snapshotText.indexOf('主窗口调研笔记');
  console.log(snapshotText.slice(i, i + 500));
}
