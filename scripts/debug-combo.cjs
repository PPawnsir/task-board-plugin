const http = require('http');
let COOKIE = null;
const TOKEN = 'yZemT1D6E8tTjDTUkYZbvOXAET7_G7wojQfLXDeit44';

function get(path, redirects = 0) {
  return new Promise((resolve, reject) => {
    const headers = COOKIE ? { Cookie: COOKIE } : {};
    http.get({ host: '127.0.0.1', port: 3081, path, headers }, (r) => {
      if (r.headers['set-cookie']) COOKIE = r.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects < 5) {
        r.resume(); return resolve(get(r.headers.location, redirects + 1));
      }
      const cs = [];
      r.on('data', (c) => cs.push(c));
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(cs).toString('utf8') }));
    }).on('error', reject);
  });
}

(async () => {
  const r = await get('/?token=' + TOKEN);
  // 找到 dsh-agent-board 的记录（宽松），打印它周围 600 字符
  const i = r.body.indexOf('dsh-agent-board');
  console.log(r.body.slice(Math.max(0, i - 100), i + 500));
  // 收集所有 /plugins/?? URL 逐个试
  const urls = [...r.body.matchAll(/"(\/plugins\/[^"]+)"/g)].map((m) => m[1]);
  const ours = urls.filter((u) => u.includes('dsh-agent-board'));
  console.log('agent-board URL:', ours);
  for (const u of ours) {
    const b = await get(u);
    console.log(String(b.status) + ' len=' + b.body.length);
    if (b.status === 200) {
      console.log('  归档=' + b.body.includes('ArchiveView') + ' 全局=' + b.body.includes('GlobalBoards') + ' 心跳=' + b.body.includes('fetchActivity') + ' 报告=' + b.body.includes('buildReport') + ' inject声明=' + b.body.includes("'slots', 'sessions', 'timer'"));
    }
  }
})().catch((e) => { console.error('ERR', e); process.exit(1) });
