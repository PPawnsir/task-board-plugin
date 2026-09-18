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

let snapCount = 0;
let escalations = [];
for (const l of lines) {
  if (l.includes('Current runtime context')) snapCount++;
  if (l.includes('"kind":"escalate"') || l.includes('[ESCALATE')) {
    try {
      const e = JSON.parse(l);
      const s = JSON.stringify(e);
      const i = s.indexOf('question');
      if (i >= 0) escalations.push(s.slice(i, i + 400));
    } catch (_) {}
  }
}
console.log('runtime context 快照消息数:', snapCount);
console.log('escalation 数:', escalations.length);
escalations.slice(0, 2).forEach((t, i) => {
  console.log('--- escalation ' + (i + 1) + ' ---');
  console.log(t.replace(/\\n/g, ' '));
});
