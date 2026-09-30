/**
 * 列出某条路由上的锚点候选，用于挑选可驱动的动作。
 * 用法: node dump-anchors.mjs "#/workbench?project=prj-1"
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:1420/';
const HASH = process.argv[2] || '#/workbench?project=prj-1';

const mock = readFileSync(join(HERE, 'inject', 'tauri-mock.js'), 'utf8');
const freeze = readFileSync(join(HERE, 'inject', 'freeze.js'), 'utf8');
const collectSrc = readFileSync(join(HERE, 'inject', 'collect.js'), 'utf8');

const { cdp, openPage, close } = await launch({ viewport: { width: 1440, height: 900 } });
const sessionId = await openPage([mock, freeze]);

await cdp.send('Page.navigate', { url: BASE }, sessionId);
await sleep(1500);
await cdp.send('Runtime.evaluate', { expression: `location.hash = ${JSON.stringify(HASH)}` }, sessionId);
await sleep(1800);

const ev = await cdp.send('Runtime.evaluate', { expression: collectSrc, returnByValue: true }, sessionId);
const v = ev.result.value;
console.log(`路由 ${HASH} — 锚点 ${v.stats.anchors} 个\n`);
v.anchors.forEach((a, i) => {
  console.log(
    `${String(i + 1).padStart(2)}. ${a.id.padEnd(28)} ` +
    `${String(a.role).padEnd(10)} ` +
    `(${String(a.rect.x).padStart(4)},${String(a.rect.y).padStart(3)}) ${String(a.rect.w).padStart(4)}×${String(a.rect.h).padStart(3)} ` +
    `"${(a.label || '').slice(0, 18)}"`
  );
});
close();
process.exit(0);
