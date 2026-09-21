#!/usr/bin/env node
// 每日下载统计：拉取 npm 官方 downloads API，生成 docs/downloads.md
// 由 .github/workflows/download-stats.yml 每日定时调用；本地也可手动运行预览。

const PKG = 'dsh-agent-board';

function fmtDate(d) { return d.toISOString().slice(0, 10) }

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'dsh-agent-board-stats' } });
  if (!res.ok) throw new Error(url + ' -> HTTP ' + res.status);
  return res.json();
}

(async () => {
  const today = new Date();
  const start = new Date(Date.now() - 89 * 86400000); // 近 90 天
  const range = fmtDate(start) + ':' + fmtDate(today);

  const [week, month, all, daily] = await Promise.all([
    getJson(`https://api.npmjs.org/downloads/point/last-week/${PKG}`),
    getJson(`https://api.npmjs.org/downloads/point/last-month/${PKG}`),
    getJson(`https://api.npmjs.org/downloads/point/1900-01-01:9999-12-31/${PKG}`),
    getJson(`https://api.npmjs.org/downloads/range/${range}/${PKG}`),
  ]);

  const days = daily.downloads.filter((d) => d.downloads > 0);
  const yesterday = daily.downloads.length >= 2 ? daily.downloads[daily.downloads.length - 2].downloads : null;
  const todayN = daily.downloads.length >= 1 ? daily.downloads[daily.downloads.length - 1].downloads : 0;

  // 周汇总（按自然周，周一为界）
  const weeks = {};
  for (const d of days) {
    const dt = new Date(d.day + 'T00:00:00Z');
    const day = (dt.getUTCDay() + 6) % 7; // 周一=0
    const monday = fmtDate(new Date(dt.getTime() - day * 86400000));
    weeks[monday] = (weeks[monday] || 0) + d.downloads;
  }
  const weekRows = Object.keys(weeks).sort().reverse().slice(0, 8)
    .map((w) => `| ${w} 起 | ${weeks[w]} |`);

  const lines = [
    '# 下载统计（每日自动更新）',
    '',
    `> 数据源: npm 官方 downloads API · 更新于 ${new Date().toISOString().slice(0, 19)} UTC`,
    '',
    '| 指标 | 数值 |',
    '| --- | --- |',
    `| 累计下载 | ${all.downloads} |`,
    `| 近 30 天 | ${month.downloads} |`,
    `| 近 7 天 | ${week.downloads} |`,
    `| 昨日 | ${yesterday === null ? '（统计中）' : yesterday} |`,
    `| 今日 | ${todayN}（当日数据次日出全） |`,
    '',
    '## 周下载趋势',
    '',
    '| 周 | 下载量 |',
    '| --- | --- |',
    ...weekRows,
    '',
    '## 近 30 天逐日',
    '',
    '| 日期 | 下载量 |',
    '| --- | --- |',
    ...days.slice(-30).map((d) => `| ${d.day} | ${d.downloads} |`),
    '',
  ];

  const fs = await import('node:fs');
  fs.mkdirSync(new URL('../docs/', import.meta.url), { recursive: true });
  fs.writeFileSync(new URL('../docs/downloads.md', import.meta.url), lines.join('\n'));
  console.log(lines.join('\n'));
})().catch((e) => { console.error('FATAL', e.message); process.exit(1) });
