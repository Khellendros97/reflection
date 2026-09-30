/**
 * 确定性验证（静止判定版）
 *
 * 核心思路：不要用「固定等待 N 秒」，而是「连拍到两张字节相同的截图」才算静止。
 * 固定等待既慢又不可靠 —— 实测 2.5s 时页面还在变（mock 缺口的异步错误横幅），
 * 7.5s 才稳定。
 *
 * 产出：3 次独立加载，各自静止后截图，两两比对。
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'spike-out', 'determinism2');
const URL_ = process.argv[2] || 'http://localhost:1420/';
const RUNS = Number(process.argv[3] || 3);

mkdirSync(OUT, { recursive: true });

const mock = readFileSync(join(HERE, 'inject', 'tauri-mock.js'), 'utf8');
const freeze = readFileSync(join(HERE, 'inject', 'freeze.js'), 'utf8');

const { cdp, openPage, shot, close } = await launch({ port: 9335 });
const sessionId = await openPage([mock, freeze]);

/**
 * 静止判定：连拍到两张完全相同的截图才认为页面稳定。
 * 返回静止耗时 —— 这个数字本身就是采集器的核心指标。
 */
async function quiesce({ minWait = 1200, interval = 350, maxWait = 25000 } = {}) {
  await sleep(minWait);
  let prev = await shot(sessionId);
  const t0 = Date.now();
  let probes = 0;
  while (Date.now() - t0 < maxWait) {
    await sleep(interval);
    probes++;
    const next = await shot(sessionId);
    if (next === prev) {
      return { shot: next, waitedMs: Date.now() - t0, probes, stable: true };
    }
    prev = next;
  }
  return { shot: prev, waitedMs: Date.now() - t0, probes, stable: false };
}

const runs = [];
for (let i = 0; i < RUNS; i++) {
  const t0 = Date.now();
  await cdp.send('Page.navigate', { url: URL_ }, sessionId);
  const q = await quiesce();
  const total = Date.now() - t0;
  writeFileSync(join(OUT, `run${i + 1}.png`), Buffer.from(q.shot, 'base64'));
  runs.push({ i: i + 1, stable: q.stable, quietMs: q.waitedMs, totalMs: total, probes: q.probes, shot: q.shot });
  console.log(`第 ${i + 1} 次：${q.stable ? '已静止' : '未静止(超时)'} · 判定耗时 ${q.waitedMs}ms · 探测 ${q.probes} 次 · 加载到静止共 ${total}ms`);
}

const pairs = [];
for (let i = 1; i < runs.length; i++) {
  pairs.push({ a: `run1.png`, b: `run${i + 1}.png`, byteEqual: runs[0].shot === runs[i].shot });
}

const result = {
  url: URL_,
  runs: runs.map(({ shot, ...rest }) => rest),
  pairs,
  allByteEqual: pairs.every((p) => p.byteEqual),
  exceptions: cdp.exceptions(),
  lastConsole: cdp.consoleMessages().slice(-8),
};
writeFileSync(join(OUT, 'determinism2.json'), JSON.stringify(result, null, 2), 'utf8');

console.log('\n=== 结果 ===');
pairs.forEach((p) => console.log(`${p.a} vs ${p.b}: ${p.byteEqual ? '字节一致 ✓' : '字节不同 ✗'}`));
console.log(`总体：${result.allByteEqual ? '三次加载静止后像素完全一致 ✓' : '存在差异，见 python 量化'}`);
const unknown = await cdp.send('Runtime.evaluate', {
  expression: 'JSON.stringify([...(window.__DSH_UNKNOWN__||[])])', returnByValue: true,
}, sessionId);
console.log('未覆盖的 IPC 命令: ' + unknown.result.value);

close();
process.exit(0);
