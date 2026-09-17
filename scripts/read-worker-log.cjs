const fs = require('fs');
const zlib = require('zlib');

const buf = fs.readFileSync(process.argv[2]);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
// 逐帧解压拼接（DSH 的 session.jsonl.zstd 是多帧追加格式）
const parts = [];
let off = 0;
while (off < buf.length) {
  try {
    parts.push(zlib.zstdDecompressSync(buf.subarray(off)));
  } catch (e) { break }
  const next = buf.indexOf(MAGIC, off + 1);
  if (next < 0) break;
  off = next;
}
const text = Buffer.concat(parts).toString('utf8');
const lines = text.split('\n').filter(Boolean);
console.log('total events:', lines.length);

for (const line of lines) {
  try {
    const e = JSON.parse(line);
    const msg = e.message || (e.data && e.data.message) || (e.data && e.data);
    if (msg && msg.role === 'user' && Array.isArray(msg.content)) {
      const t = msg.content.find(c => c.type === 'text');
      if (t && t.text && t.text.includes('一次性任务执行 Worker')) {
        console.log('=== Worker prompt 开头 800 字符 ===');
        console.log(t.text.slice(0, 800));
        console.log('=== 预研文件段验证 ===');
        const i = t.text.indexOf('主窗口预研文件');
        if (i >= 0) {
          console.log('✅ 找到「主窗口预研文件」段（位置 ' + i + '），内容预览：');
          console.log(t.text.slice(i, i + 800));
        } else {
          console.log('❌ 未找到预研文件段；prompt 末尾 500 字符：');
          console.log(t.text.slice(-500));
        }
        process.exit(0);
      }
    }
  } catch (_) {}
}
console.log('未找到 worker prompt。事件类型分布:');
const types = {};
for (const line of lines) { try { const e = JSON.parse(line); types[e.type] = (types[e.type] || 0) + 1 } catch (_) {} }
console.log(JSON.stringify(types));
