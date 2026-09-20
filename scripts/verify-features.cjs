// 最终验证：dev 实例服务的 client bundle 含全部新功能 + 新 RPC 可用
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
function post(method, args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ method, args });
    const req = http.request({ host: '127.0.0.1', port: 3081, path: '/dsh-agent-board', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (r) => {
      const cs = []; r.on('data', (c) => cs.push(c));
      r.on('end', () => resolve(JSON.parse(Buffer.concat(cs).toString('utf8'))));
    });
    req.on('error', reject); req.end(body);
  });
}

(async () => {
  const r = await get('/?token=' + TOKEN);
  const m = r.body.match(/"id":\s*"dsh-agent-board"[^}]*"rev":\s*"([^"]+)"/);
  const cm = r.body.match(/"(\/plugins\/\?\?[^"]*dsh-agent-board\/client\.js[^"]*)"/);
  console.log('boot:', r.status, 'rev:', m ? m[1] : '?');
  const b = await get(cm[1]);
  console.log('bundle:', b.status, 'len', b.body.length);
  console.log('  归档视图:', b.body.includes('ArchiveView'));
  console.log('  全局总览:', b.body.includes('GlobalBoards'));
  console.log('  报告导出:', b.body.includes('buildReport'));
  console.log('  活动心跳:', b.body.includes('fetchActivity'));
  console.log('  attempt 角标:', b.body.includes('retryCount'));
  const lb = await post('list-boards', { sessionId: 'x' });
  console.log('list-boards: ok=' + lb.ok + ' boards=' + (lb.boards || []).length);
  const ac = await post('agent-activity', { sessionId: 'x', taskId: 'nonexistent' });
  console.log('agent-activity: ok=' + ac.ok);
  const pc = await post('preview-context', { sessionId: 'x', contextNotes: 'SMOKE' });
  console.log('preview-context: ok=' + pc.ok + ' packLen=' + (pc.pack || '').length);
})().catch((e) => { console.error('ERR', e); process.exit(1) });
