/**
 * 逐帧重放契约验证 —— 决定运行时场景能不能交给 Remotion 渲染
 *
 * Remotion 逐帧渲染时，每一帧都可能是一个新的渲染进程。
 * 所以必须满足：State(k) = 全新加载 + 从零重放前 k 个动作
 *
 * 做法：对每个 k，独立开一次干净页面，重放 k 个动作，取指纹；
 *       再与「顺序执行」得到的第 k 步指纹比对。
 * 全部一致 → 逐帧重放契约成立 → 可以让 Remotion 逐帧渲染。
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'spike-out', 'replay');
mkdirSync(OUT, { recursive: true });

const BASE = 'http://localhost:1420/';
const HASH = process.argv[2] || '#/workbench?project=prj-1';

const ACTIONS = ['仪表盘', '文件资源管理器', '服务器列表', '命令收藏-2', '历史命令'];

const mock = readFileSync(join(HERE, 'inject', 'tauri-mock.js'), 'utf8');
const freeze = readFileSync(join(HERE, 'inject', 'freeze.js'), 'utf8');
const collectSrc = readFileSync(join(HERE, 'inject', 'collect.js'), 'utf8');

const FP_SRC = `(() => {
  const parts = [];
  const walk = (el, d) => {
    if (d > 26) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    parts.push(el.tagName + '.' + [...el.classList].join('.') + '@' +
      Math.round(r.x) + ',' + Math.round(r.y) + ',' + Math.round(r.width) + ',' + Math.round(r.height));
    for (const c of el.children) walk(c, d + 1);
  };
  walk(document.body, 0);
  const s = parts.join('|');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return { hash: h.toString(16), nodes: parts.length, bytes: s.length };
})()`;

const { cdp, openPage, shot, close } = await launch({ viewport: { width: 1440, height: 900 } });
const sessionId = await openPage([mock, freeze]);

async function evaluate(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r.result.value;
}

async function quiesce({ minWait = 600, interval = 250, maxWait = 20000 } = {}) {
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

async function clickBySelector(selector) {
  const box = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (!box) return false;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type, x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
    }, sessionId);
    await sleep(35);
  }
  return true;
}

/** 拿到锚点表（在当前状态下采集一次） */
async function collectAnchors() {
  await cdp.send('Page.navigate', { url: BASE }, sessionId);
  await sleep(1200);
  await evaluate(`location.hash = ${JSON.stringify(HASH)}`);
  await quiesce();
  const c = await evaluate(collectSrc);
  return new Map(c.anchors.map((a) => [a.id, a]));
}

const anchors = await collectAnchors();
console.log(`锚点表就绪：${anchors.size} 个`);

/* ---------- 1. 顺序执行，记录每一步的状态指纹（作为基准） ---------- */
console.log('\n[顺序执行] 作为基准');
await cdp.send('Page.navigate', { url: BASE }, sessionId);
await sleep(1200);
await evaluate(`location.hash = ${JSON.stringify(HASH)}`);
let q = await quiesce();
const sequential = [{ k: 0, fps: await evaluate(FP_SRC), quietMs: q.quietMs }];
console.log(`  k=0 (初始) 指纹 ${sequential[0].fps.hash} 静止 ${q.quietMs}ms`);

for (let i = 0; i < ACTIONS.length; i++) {
  const a = anchors.get(ACTIONS[i]);
  const ok = a ? await clickBySelector(a.selector) : false;
  q = await quiesce();
  const fps = await evaluate(FP_SRC);
  sequential.push({ k: i + 1, action: ACTIONS[i], clickOk: ok, fps, quietMs: q.quietMs });
  console.log(`  k=${i + 1} ${ACTIONS[i].padEnd(16)} 指纹 ${fps.hash} 静止 ${q.quietMs}ms`);
}

/* ---------- 2. 每个 k 都从干净页面重放 k 步 ---------- */
console.log('\n[重放验证] 每个 k 独立开干净页面，从零重放');
const replays = [];
for (let k = 0; k <= ACTIONS.length; k++) {
  const t0 = Date.now();
  await cdp.send('Page.navigate', { url: BASE }, sessionId);
  await sleep(1200);
  await evaluate(`location.hash = ${JSON.stringify(HASH)}`);
  await quiesce();
  for (let i = 0; i < k; i++) {
    const a = anchors.get(ACTIONS[i]);
    if (a) await clickBySelector(a.selector);
    await quiesce();
  }
  const fps = await evaluate(FP_SRC);
  const totalMs = Date.now() - t0;
  const expect = sequential[k].fps.hash;
  const match = fps.hash === expect;
  replays.push({ k, fps, expect, match, totalMs });
  console.log(`  k=${k} 重放指纹 ${fps.hash} vs 顺序 ${expect}  ${match ? '一致 ✓' : '不一致 ✗'}  （加载+重放耗时 ${totalMs}ms）`);
}

const allMatch = replays.every((r) => r.match);
console.log('\n=== 结论 ===');
console.log(`逐帧重放契约 State(k) = replay(前 k 个动作)：${allMatch ? '成立 ✓' : '不成立 ✗'}`);
console.log(`单个关键帧的平均构建成本：${Math.round(replays.reduce((s, r) => s + r.totalMs, 0) / replays.length)}ms`);

writeFileSync(join(OUT, 'replay.json'), JSON.stringify({ hash: HASH, actions: ACTIONS, sequential, replays, verdict: { allMatch } }, null, 2), 'utf8');
console.log('产物: ' + OUT);
close();
process.exit(0);
