/**
 * 确定性诊断：区分三种不一致
 *
 *   A. 同页重复截图    —— 光栅化本身是否稳定（不重载，连拍两次）
 *   B. 跨加载同帧截图  —— 加载时序是否引入差异（重载后同沉降时长再拍）
 *   C. 跨加载稳定窗口  —— 沉降时间加倍后再拍，看差异是否收敛
 *
 * 输出每对的字节相等性与差异像素，供 python 进一步量化。
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'spike-out', 'determinism');
const URL_ = process.argv[2] || 'http://localhost:1420/';
const SETTLE = Number(process.argv[3] || 2500);

mkdirSync(OUT, { recursive: true });

const mock = readFileSync(join(HERE, 'inject', 'tauri-mock.js'), 'utf8');
const freeze = readFileSync(join(HERE, 'inject', 'freeze.js'), 'utf8');

const { cdp, openPage, shot, close } = await launch({ port: 9334 });
const sessionId = await openPage([mock, freeze]);

async function loadAndSettle(ms) {
  await cdp.send('Page.navigate', { url: URL_ }, sessionId);
  await sleep(ms);
}

const results = { url: URL_, settle: SETTLE, pairs: [] };

function save(name, b64) {
  writeFileSync(join(OUT, name), Buffer.from(b64, 'base64'));
}

/* A. 同页连拍 */
await loadAndSettle(SETTLE);
const a1 = await shot(sessionId);
await sleep(600);
const a2 = await shot(sessionId);
save('A1-same-page.png', a1);
save('A2-same-page.png', a2);
results.pairs.push({ name: 'A 同页连拍（间隔 600ms）', byteEqual: a1 === a2, a: 'A1-same-page.png', b: 'A2-same-page.png' });
console.log(`A 同页连拍: ${a1 === a2 ? '字节一致' : '字节不同'}`);

/* B. 重载后同沉降时长 */
await loadAndSettle(SETTLE);
const b1 = await shot(sessionId);
save('B1-reload.png', b1);
results.pairs.push({ name: 'B 跨加载（同沉降 2.5s）', byteEqual: a1 === b1, a: 'A1-same-page.png', b: 'B1-reload.png' });
console.log(`B 跨加载同沉降: ${a1 === b1 ? '字节一致' : '字节不同'}`);

/* C. 沉降加倍 + 字体就绪 + 无网络活动 */
await cdp.send('Page.navigate', { url: URL_ }, sessionId);
await sleep(SETTLE * 3);
await cdp.send('Runtime.evaluate', {
  expression: `(async () => { await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return document.fonts.status; })()`,
  awaitPromise: true, returnByValue: true,
}, sessionId);
const c1 = await shot(sessionId);
save('C1-settled.png', c1);
results.pairs.push({ name: 'C 跨加载（沉降 7.5s + fonts.ready + 双 rAF）', byteEqual: a1 === c1, a: 'A1-same-page.png', b: 'C1-settled.png' });
console.log(`C 充分沉降: ${a1 === c1 ? '字节一致' : '字节不同'}`);

/* 再拍一次 C 的同页对照 */
await sleep(600);
const c2 = await shot(sessionId);
save('C2-settled-repeat.png', c2);
results.pairs.push({ name: 'C2 充分沉降后同页连拍', byteEqual: c1 === c2, a: 'C1-settled.png', b: 'C2-settled-repeat.png' });
console.log(`C2 沉降后连拍: ${c1 === c2 ? '字节一致' : '字节不同'}`);

results.exceptions = cdp.exceptions();
results.console = cdp.consoleMessages().slice(-10);
writeFileSync(join(OUT, 'determinism.json'), JSON.stringify(results, null, 2), 'utf8');

close();
console.log('\n产物: ' + OUT);
process.exit(0);
