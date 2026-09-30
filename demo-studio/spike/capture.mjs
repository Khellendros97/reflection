/**
 * DemoStudio 技术验证 · 采集器（静止判定版）
 *
 *   node capture.mjs --url http://localhost:1420/ --out ../spike-out --runs 2
 *
 * 流程：
 *   1. 起独立 headless Chrome
 *   2. 页面脚本之前注入 Tauri mock + 确定性补丁（不改目标项目一行代码）
 *   3. 导航 → 连拍直到画面静止（而不是固定等待）
 *   4. 导出：锚点表 anchors.json / 自包含快照 scene.html / 元数据 meta.json / 截图
 *   5. 重载一遍再采，量化两次的差异
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const URL_ = arg('url', 'http://localhost:1420/');
const OUT = resolve(HERE, arg('out', '../spike-out'));
const RUNS = Number(arg('runs', '2'));
const VIEWPORT = { width: 1440, height: 900 };

const mock = readFileSync(join(HERE, 'inject', 'tauri-mock.js'), 'utf8');
const freeze = readFileSync(join(HERE, 'inject', 'freeze.js'), 'utf8');
const collectSrc = readFileSync(join(HERE, 'inject', 'collect.js'), 'utf8');

const { cdp, openPage, shot, close } = await launch({ port: 9336, viewport: VIEWPORT });
const sessionId = await openPage([mock, freeze]);
console.log('[1/5] Chrome 已启动，Tauri mock + 确定性补丁已注入');

/** 静止判定：连拍到两张字节相同的截图 */
async function quiesce({ minWait = 1000, interval = 300, maxWait = 25000 } = {}) {
  await sleep(minWait);
  let prev = await shot(sessionId);
  const t0 = Date.now();
  let probes = 0;
  while (Date.now() - t0 < maxWait) {
    await sleep(interval);
    probes++;
    const next = await shot(sessionId);
    if (next === prev) return { shot: next, quietMs: Date.now() - t0, probes, stable: true };
    prev = next;
  }
  return { shot: prev, quietMs: Date.now() - t0, probes, stable: false };
}

export function noop() {}

const runs = [];
for (let i = 0; i < RUNS; i++) {
  await cdp.send('Page.navigate', { url: URL_ }, sessionId);
  const q = await quiesce();
  const r = await cdp.send('Runtime.evaluate', {
    expression: collectSrc, returnByValue: true, awaitPromise: false,
  }, sessionId);
  if (r.exceptionDetails) {
    throw new Error('采集脚本异常: ' + (r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)));
  }
  const v = r.result.value;
  runs.push({ shot: q.shot, stable: q.stable, quietMs: q.quietMs, ...v });
  console.log(`[2/5] 第 ${i + 1}/${RUNS} 次：${q.stable ? '已静止' : '未静止(超时)'} ${q.quietMs}ms · 锚点 ${v.stats.anchors} · DOM ${v.stats.domNodes} 节点 · CSS ${v.stats.cssRules} 规则`);

  if (i === 0) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'anchors.json'), JSON.stringify({
      formatVersion: 1,
      source: { kind: 'captured', url: URL_, capturedAt: v.meta.capturedAt, viewport: v.meta.viewport },
      anchors: v.anchors,
    }, null, 2), 'utf8');
    writeFileSync(join(OUT, 'scene.html'), v.snapshot, 'utf8');
    writeFileSync(join(OUT, 'meta.json'), JSON.stringify({
      meta: v.meta, stats: v.stats, samples: v.samples,
    }, null, 2), 'utf8');
    writeFileSync(join(OUT, 'shot-run1.png'), Buffer.from(q.shot, 'base64'));
  } else {
    writeFileSync(join(OUT, `shot-run${i + 1}.png`), Buffer.from(q.shot, 'base64'));
  }
}

const first = runs[0];
const st = first.stats;
const allSame = runs.every((r) => r.shot === first.shot);

const report = {
  url: URL_,
  formatVersion: 1,
  runs: runs.map((r) => ({ stable: r.stable, quietMs: r.quietMs })),
  stats: st,
  determinism: {
    runs: runs.length,
    byteIdentical: allSame,
    note: allSame ? '两次加载静止后截图字节一致' : '字节不同，需用像素阈值判定（见 diff.py）',
  },
  coverage: {
    ipcCalls: first.samples.ipcCalls.length,
    uncoveredIpc: first.samples.i18nWarnings,
  },
  selfContained: {
    unresolvedCssUrls: st.unresolvedCssUrls,
    externalImages: st.images,
    fontFaces: st.fontFaces,
    verdict: (st.unresolvedCssUrls === 0 && st.images === 0)
      ? '自包含（除字体外无需联网）'
      : `还需内联 ${st.unresolvedCssUrls} 个 CSS 资源 + ${st.images} 个 <img>`,
  },
  exceptions: cdp.exceptions(),
  samples: first.samples,
};
writeFileSync(join(OUT, 'capture-report.json'), JSON.stringify(report, null, 2), 'utf8');

console.log(`[3/5] 确定性：${allSame ? '字节一致 ✓' : '字节不同（需阈值判定）'}`);
console.log(`[4/5] IPC 覆盖：${report.coverage.ipcCalls} 次调用，未覆盖 ${report.coverage.uncoveredIpc.length} 个 ${report.coverage.uncoveredIpc.length ? JSON.stringify(report.coverage.uncoveredIpc) : ''}`);
console.log(`[5/5] 自包含：${report.selfContained.verdict}`);

console.log('\n=== 采集报告 ===');
console.log(JSON.stringify({
  anchors: st.anchors,
  selectorNotUnique: st.selectorNotUnique,
  idCollisions: st.idCollisions,
  interactiveVisible: st.interactiveVisible,
  domNodes: st.domNodes,
  cssRules: st.cssRules,
  fontFaces: st.fontFaces,
  quietMs: first.quietMs,
  byteIdenticalAcrossLoads: allSame,
  uncoveredIpc: report.coverage.uncoveredIpc,
  selfContained: report.selfContained.verdict,
  exceptions: report.exceptions.length,
}, null, 2));
console.log(`\n产物: ${OUT}`);

close();
process.exit(0);
