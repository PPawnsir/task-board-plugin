const http = require('http');

let COOKIE = null;

function get(path, redirects = 0) {
  return new Promise((resolve, reject) => {
    const headers = COOKIE ? { Cookie: COOKIE } : {};
    http.get({ host: '127.0.0.1', port: 3082, path, headers }, (r) => {
      if (r.headers['set-cookie']) COOKIE = r.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects < 5) {
        r.resume();
        return resolve(get(r.headers.location, redirects + 1));
      }
      const cs = [];
      r.on('data', (c) => cs.push(c));
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(cs).toString('utf8') }));
    }).on('error', reject);
  });
}

(async () => {
  const r = await get('/?token=L_OPpxfAyoMsVtpQEAlz47tGbnIZIXjaFl0Y1Qop4so');
  console.log('index:', r.status, '含 agent-board:', r.body.includes('dsh-agent-board'));
  // 宽松匹配 agent-board 的记录（json 字段顺序/空白可能不同）
  const m = r.body.match(/"id":\s*"dsh-agent-board"[^}]*"rev":\s*"([^"]+)"/);
  if (!m) { console.log('无 rev 记录'); process.exit(1) }
  console.log('rev:', m[1]);
  // 组合它自己的 bundle URL（从记录里抓 url 字段）
  const um = r.body.match(/"id":\s*"dsh-agent-board"[^}]*"url":\s*"([^"]+)"/);
  let bundleUrl = um ? um[1] : null;
  if (!bundleUrl) {
    // boot 可能用 combo 大 URL——找包含 dsh-agent-board/client.js 的 /plugins URL
    const cm = r.body.match(/"(\/plugins\/\?\?[^"]*dsh-agent-board\/client\.js[^"]*)"/);
    bundleUrl = cm ? cm[1] : null;
  }
  if (!bundleUrl) { console.log('没找到 bundle URL'); process.exit(1) }
  console.log('bundle URL 片段:', bundleUrl.slice(0, 120));
  const b = await get(bundleUrl);
  console.log('bundle:', b.status, 'len', b.body.length);
  console.log('含 inject 声明:', /inject:\s*\[/.test(b.body));
  console.log("含三依赖:", b.body.includes("'slots', 'sessions', 'timer'"));
  console.log('含静默旧版逻辑(不应出现未声明版):', b.body.includes('硬依赖声明'));
})().catch((e) => { console.error('ERR', String(e)); process.exit(1) });
