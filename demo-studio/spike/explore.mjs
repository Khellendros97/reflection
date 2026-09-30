/**
 * 路由探索：逐条路由采集，看哪个能成为可用的动画场景。
 *
 * 对每条路由输出：能否渲染 / 锚点数 / 静止耗时 / 画面内错误 / 截图
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'spike-out', 'routes');
mkdirSync(OUT, { recursive: true });

const BASE = process.argv[2] || 'http://localhost:1420/';
const ROUTES = [
  { name: 'welcome',   hash: '#/welcome' },
  { name: 'workbench', hash: '#/workbench?project=prj-1' },
  { name: 'settings',  hash: '#/settings' },
  { name: 'account',   hash: '#/account' },
];

const mock = readFileSync(join(HERE, 'inject', 'tauri-mock.js'), 'utf8');
const freeze = readFileSync(join(HERE, 'inject', 'freeze.js'), 'utf8');
const collectSrc = readFileSync(join(HERE, 'inject', 'collect.js'), 'utf8');

const { cdp, openPage, shot, close } = await launch({ viewport: { width: 1440, height: 900 } });
const sessionId = await openPage([mock, freeze]);

async function quiesce({ minWait = 900, interval = 300, maxWait = 20000 } = {}) {
  await sleep(minWait);
  let prev = await shot(sessionId);
  const t0 = Date.now();
  while (Date.now() - t0 < maxWait) {
    await sleep(interval);
    const next = await shot(sessionId);
    if (next === prev) return { shot: next, quietMs: Date.now() - t0, stable: true };
    prev = next;
  }
  return { shot: prev, quietMs: Date.now() - t0, stable: false };
}

const results = [];

for (const r of ROUTES) {
  // 每次从干净加载开始，避免上一条路由的残留状态
  await cdp.send('Page.navigate', { url: BASE }, sessionId);
  await sleep(1500);
  await cdp.send('Runtime.evaluate', { expression: `location.hash = ${JSON.stringify(r.hash)}` }, sessionId);
  const q = await quiesce();

  const ev = await cdp.send('Runtime.evaluate', {
    expression: collectSrc, returnByValue: true,
  }, sessionId);
  const v = ev.result.value;
  const actualHash = (await cdp.send('Runtime.evaluate', {
    expression: 'location.hash', returnByValue: true,
  }, sessionId)).result.value;

  writeFileSync(join(OUT, `${r.name}.png`), Buffer.from(q.shot, 'base64'));
  results.push({
    route: r.name,
    hash: r.hash,
    actualHash,
    stable: q.stable,
    quietMs: q.quietMs,
    anchors: v.stats.anchors,
    domNodes: v.stats.domNodes,
    cssRules: v.stats.cssRules,
    suspiciousText: v.samples.suspiciousText,
    ipcCalls: v.samples.ipcCalls.length,
    uncoveredIpc: v.samples.i18nWarnings,
    topAnchors: v.anchors.slice(0, 6).map((a) => a.id),
  });
  console.log(`[${r.name.padEnd(10)}] hash=${actualHash.padEnd(28)} 锚点 ${String(v.stats.anchors).padStart(2)} · DOM ${String(v.stats.domNodes).padStart(4)} · 静止 ${String(q.quietMs).padStart(4)}ms · 错误文案 ${v.samples.suspiciousText.length} · 未覆盖IPC ${v.samples.i18nWarnings.length}`);
  if (v.samples.suspiciousText.length) {
    v.samples.suspiciousText.slice(0, 3).forEach((t) => console.log(`             ⚠ ${t.slice(0, 80)}`));
  }
}

writeFileSync(join(OUT, 'routes.json'), JSON.stringify(results, null, 2), 'utf8');
console.log('\n产物: ' + OUT);
close();
process.exit(0);
