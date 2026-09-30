/**
 * 运行时场景验证 —— 第一条路
 *
 * 要回答三个问题：
 *   Q1 动作能不能驱动状态变化？（点一下，界面真的变了吗）
 *   Q2 变化之后能不能再次静止？（否则无法逐帧渲染）
 *   Q3 同一串动作重复执行，结果一致吗？（ADR-003 操作重放的地基）
 *
 * 做法：加载 → 静止 → 按锚点 id 依次点击 → 每步都静止后记录指纹与截图
 *       整个序列跑两遍（两次独立加载），逐步比对。
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'spike-out', 'runtime');
mkdirSync(OUT, { recursive: true });

const BASE = 'http://localhost:1420/';
const HASH = process.argv[2] || '#/workbench?project=prj-1';
const RUNS = Number(process.argv[3] || 2);

/** 动作序列：全部用锚点 id 寻址，不写坐标 */
const ACTIONS = [
  { id: '仪表盘',        note: '活动栏 → 仪表盘' },
  { id: '文件资源管理器', note: '活动栏 → 文件资源管理器' },
  { id: '服务器列表',    note: '活动栏 → 服务器列表' },
  { id: '命令收藏-2',    note: '活动栏 → 命令收藏' },
  { id: '历史命令',      note: '终端工具条 → 历史命令' },
];

const mock = readFileSync(join(HERE, 'inject', 'tauri-mock.js'), 'utf8');
const freeze = readFileSync(join(HERE, 'inject', 'freeze.js'), 'utf8');
const collectSrc = readFileSync(join(HERE, 'inject', 'collect.js'), 'utf8');

/** 页面内：结构+几何指纹，用来判断「界面真的变了」且「变到了同一个地方」 */
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
  return { hash: h.toString(16), nodes: parts.length };
})()`;

/** 页面内：检查一组选择器是否仍然唯一命中（锚点漂移检测） */
const driftSrc = (pairs) => `(() => {
  const pairs = ${JSON.stringify(pairs)};
  const broken = [], ambiguous = [];
  for (const p of pairs) {
    let n;
    try { n = document.querySelectorAll(p.selector).length; } catch (e) { n = -1; }
    if (n <= 0) broken.push(p.id);
    else if (n > 1) ambiguous.push(p.id);
  }
  return { checked: pairs.length, broken, ambiguous };
})()`;

const { cdp, openPage, shot, close } = await launch({ viewport: { width: 1440, height: 900 } });
const sessionId = await openPage([mock, freeze]);

async function evaluate(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r.result.value;
}

async function quiesce({ minWait = 700, interval = 250, maxWait = 20000 } = {}) {
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

/** 用真实鼠标事件点击锚点元素（比 el.click() 更接近用户操作） */
async function clickAnchor(selector) {
  const box = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (!box) return { ok: false, reason: '锚点未找到' };
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type, x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
    }, sessionId);
    await sleep(40);
  }
  return { ok: true, at: box };
}

const runs = [];

for (let run = 0; run < RUNS; run++) {
  await cdp.send('Page.navigate', { url: BASE }, sessionId);
  await sleep(1200);
  await evaluate(`location.hash = ${JSON.stringify(HASH)}`);
  const base = await quiesce();
  const collected = await evaluate(collectSrc);
  const byId = new Map(collected.anchors.map((a) => [a.id, a]));
  // 锚点漂移检测用：把初始选择器全部记下来，之后每步回查
  const pairs = collected.anchors.map((a) => ({ id: a.id, selector: a.selector }));

  const steps = [];
  steps.push({
    step: 0, action: '(初始)', note: '加载后静止',
    fps: await evaluate(FP_SRC), quietMs: base.quietMs, stable: base.stable, changed: null,
    drift: await evaluate(driftSrc(pairs)),
  });
  writeFileSync(join(OUT, `run${run + 1}-step0.png`), Buffer.from(base.shot, 'base64'));

  let prevFp = steps[0].fps.hash;
  for (let i = 0; i < ACTIONS.length; i++) {
    const act = ACTIONS[i];
    const a = byId.get(act.id);
    if (!a) {
      steps.push({ step: i + 1, action: act.id, note: act.note, error: `锚点表中没有 "${act.id}"` });
      continue;
    }
    const clicked = await clickAnchor(a.selector);
    const q = await quiesce();
    const fps = await evaluate(FP_SRC);
    const drift = await evaluate(driftSrc(pairs));
    steps.push({
      step: i + 1, action: act.id, note: act.note,
      selector: a.selector,
      clickOk: clicked.ok, clickAt: clicked.at,
      quietMs: q.quietMs, stable: q.stable,
      fps, changed: fps.hash !== prevFp, drift,
    });
    writeFileSync(join(OUT, `run${run + 1}-step${i + 1}.png`), Buffer.from(q.shot, 'base64'));
    prevFp = fps.hash;
  }
  runs.push({ run: run + 1, steps });
  console.log(`\n--- 第 ${run + 1} 次执行 ---`);
  for (const s of steps) {
    if (s.error) { console.log(`  ${s.step}. ${s.action}  ✗ ${s.error}`); continue; }
    const d = s.drift || { broken: [], ambiguous: [] };
    const driftTxt = (d.broken.length || d.ambiguous.length)
      ? `  ⚠ 漂移 ${d.broken.length} 失配 / ${d.ambiguous.length} 歧义`
      : '';
    console.log(
      `  ${s.step}. ${String(s.action).padEnd(16)} 静止 ${String(s.quietMs).padStart(4)}ms ` +
      `指纹 ${s.fps.hash.padStart(8)} 节点 ${String(s.fps.nodes).padStart(4)} ` +
      `${s.step === 0 ? '' : s.changed ? '· 画面已变化' : '· 画面未变化 ✗'}${driftTxt}`
    );
    if (d.broken.length) console.log(`       失配锚点: ${d.broken.slice(0, 6).join(', ')}${d.broken.length > 6 ? ' …' : ''}`);
  }
}

/* ---------------- 逐步比对两次执行 ---------------- */
console.log('\n=== 可复现性逐步比对 ===');
const cmp = [];
let allMatch = true;
for (let i = 0; i < ACTIONS.length + 1; i++) {
  const a = runs[0].steps[i], b = runs[1]?.steps[i];
  if (!a || !b || a.error || b.error) { cmp.push({ step: i, match: null }); continue; }
  const match = a.fps.hash === b.fps.hash;
  if (!match) allMatch = false;
  cmp.push({ step: i, action: a.action, hashA: a.fps.hash, hashB: b.fps.hash, match });
  console.log(`  ${i}. ${String(a.action).padEnd(16)} ${a.fps.hash} vs ${b.fps.hash}  ${match ? '一致 ✓' : '不一致 ✗'}`);
}

const anyChange = runs[0].steps.slice(1).some((s) => s.changed === true);
const allQuiet = runs.every((r) => r.steps.every((s) => !s.error && s.stable !== false));

console.log('\n=== 结论 ===');
console.log(`Q1 动作驱动状态变化：${anyChange ? '成立 ✓' : '不成立 ✗'}（${runs[0].steps.slice(1).filter((s) => s.changed).length}/${ACTIONS.length} 个动作改变了画面）`);
console.log(`Q2 变化后能再次静止：${allQuiet ? '成立 ✓' : '不成立 ✗'}`);
console.log(`Q3 序列可复现：      ${allMatch ? '成立 ✓' : '不成立 ✗'}`);

writeFileSync(join(OUT, 'runtime.json'), JSON.stringify({ hash: HASH, actions: ACTIONS, runs, cmp, verdict: { anyChange, allQuiet, allMatch } }, null, 2), 'utf8');
console.log('\n产物: ' + OUT);
close();
process.exit(0);
