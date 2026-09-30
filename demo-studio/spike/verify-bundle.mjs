/**
 * 验证导出的 Scene Bundle 是否真的「自包含」：
 *   1. 从 file:// 打开 scene.html（没有 dev server、没有 mock、没有脚本）
 *   2. 截图，与采集时的截图比对
 *   3. 用 anchors.json 里的选择器逐个回查，确认锚点在离线快照里仍然可解析
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch, sleep } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = resolve(HERE, process.argv[2] || '../spike-out/bundle');
const VIEWPORT = { width: 1440, height: 900 };

const anchors = JSON.parse(readFileSync(join(BUNDLE, 'anchors.json'), 'utf8'));
const fileUrl = pathToFileURL(join(BUNDLE, 'scene.html')).href;

const { cdp, openPage, shot, close } = await launch({ port: 9337, viewport: VIEWPORT });
const sessionId = await openPage([]);   // 刻意不注入任何东西

await cdp.send('Page.navigate', { url: fileUrl }, sessionId);
await sleep(1500);

// 静止判定
let prev = await shot(sessionId);
for (let i = 0; i < 20; i++) {
  await sleep(300);
  const next = await shot(sessionId);
  if (next === prev) break;
  prev = next;
}
const offlineShot = prev;
writeFileSync(join(BUNDLE, 'shot-offline.png'), Buffer.from(offlineShot, 'base64'));

// 锚点回查：选择器在离线快照里还能不能唯一定位
const check = await cdp.send('Runtime.evaluate', {
  expression: `(() => {
    const list = ${JSON.stringify(anchors.anchors.map((a) => ({ id: a.id, selector: a.selector, rect: a.rect })))};
    const out = list.map((a) => {
      let n = -1, r = null;
      try {
        const els = document.querySelectorAll(a.selector);
        n = els.length;
        if (n === 1) { const b = els[0].getBoundingClientRect(); r = [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; }
      } catch (e) { n = -2; }
      return { id: a.id, selector: a.selector, matches: n, rect: r, original: a.rect };
    });
    return {
      total: list.length,
      unique: out.filter((o) => o.matches === 1).length,
      missing: out.filter((o) => o.matches === 0).length,
      ambiguous: out.filter((o) => o.matches > 1).length,
      broken: out.filter((o) => o.matches === -2).length,
      geometryDrift: out.filter((o) => o.rect && (Math.abs(o.rect[0] - o.original.x) > 1 || Math.abs(o.rect[1] - o.original.y) > 1 || Math.abs(o.rect[2] - o.original.w) > 1)).length,
      detail: out,
    };
  })()`,
  returnByValue: true,
}, sessionId);

const r = check.result.value;
console.log('=== 离线快照验证 ===');
console.log(`文件: ${fileUrl}`);
console.log(`锚点回查: 共 ${r.total} · 唯一定位 ${r.unique} · 丢失 ${r.missing} · 歧义 ${r.ambiguous} · 选择器报错 ${r.broken}`);
console.log(`几何漂移(>1px): ${r.geometryDrift}`);
if (r.missing || r.ambiguous || r.broken) {
  console.log('问题锚点:');
  r.detail.filter((d) => d.matches !== 1).forEach((d) => console.log(`  ${d.id}: matches=${d.matches} ${d.selector}`));
}
writeFileSync(join(BUNDLE, 'offline-verify.json'), JSON.stringify(r, null, 2), 'utf8');

close();
process.exit(0);
