/**
 * 零依赖 CDP 客户端 + headless Chrome 启动器。
 * capture.mjs 与 determinism.mjs 共用。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
];

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.waiters = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else res(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        if (this.waiters.has(msg.method)) {
          const fn = this.waiters.get(msg.method);
          this.waiters.delete(msg.method);
          fn(msg.params);
        }
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    return new Promise((res, reject) => {
      this.pending.set(id, { resolve: res, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  once(method) {
    return new Promise((res) => this.waiters.set(method, res));
  }
  exceptions() {
    return this.events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => e.params?.exceptionDetails?.exception?.description || 'unknown');
  }
  consoleMessages() {
    return this.events
      .filter((e) => e.method === 'Runtime.consoleAPICalled')
      .map((e) => ({
        type: e.params.type,
        text: (e.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300),
      }));
  }
}

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try { readFileSync(p); return p; } catch (e) { /* 下一个 */ }
  }
  throw new Error('找不到 Chrome，请修改 CHROME_CANDIDATES');
}

export async function launch({ port, viewport = { width: 1440, height: 900 } } = {}) {
  // 端口随机化：残留的 Chrome 会占住固定端口，导致新实例静默连到旧浏览器上
  if (!port) port = 9400 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), 'ds-spike-'));
  const proc = spawn(findChrome(), [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    '--disable-lcd-text', '--font-render-hinting=none',
    '--disable-features=PaintHolding,CalculateNativeWinOcclusion',
    '--run-all-compositor-stages-before-draw',
    `--window-size=${viewport.width},${viewport.height}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    await sleep(250);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      wsUrl = (await r.json()).webSocketDebuggerUrl;
    } catch (e) { /* 还没起来 */ }
  }
  if (!wsUrl) { proc.kill(); throw new Error('Chrome 调试端口未就绪'); }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  const cdp = new CDP(ws);

  async function openPage(initScripts = []) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false,
    }, sessionId);
    for (const source of initScripts) {
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId);
    }
    return sessionId;
  }

  async function shot(sessionId) {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
    return r.data;   // base64
  }

  function close() {
    // Chrome 会派生一堆子进程，只 kill 父进程会留下僵尸占住端口
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        proc.kill('SIGKILL');
      }
    } catch (e) { /* ignore */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  return { cdp, proc, profile, openPage, shot, close, viewport };
}

export { sleep };
