/**
 * DemoStudio 技术验证 · 页面采集器
 *
 * 在页面里执行，返回两部分：
 *   1) anchors —— 自动枚举出的可交互元素 → 锚点候选表（带稳定选择器）
 *   2) snapshot —— 去掉脚本后的自包含 HTML 快照
 *
 * 设计原则：只读页面，不修改目标应用。
 */
(() => {
  const INTERACTIVE = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
    '[role="button"]', '[role="tab"]', '[role="menuitem"]', '[role="option"]',
    '[role="checkbox"]', '[role="switch"]', '[role="combobox"]', '[role="radio"]',
    '[role="link"]', '[role="treeitem"]', '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  const slug = (s) => String(s || '').trim().toLowerCase()
    .replace(/[\s_/\\]+/g, '-')
    .replace(/[^0-9a-z\u4e00-\u9fa5-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);

  function visible(el, r) {
    if (!r || r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    if (parseFloat(cs.opacity || '1') < 0.05) return false;
    if (cs.pointerEvents === 'none') return false;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    return true;
  }

  function labelOf(el) {
    return (el.getAttribute('aria-label') || el.getAttribute('title') ||
            el.getAttribute('placeholder') || el.getAttribute('alt') ||
            (el.innerText || el.textContent || '').trim() ||
            el.value || el.getAttribute('name') || '').replace(/\s+/g, ' ').slice(0, 28);
  }

  /* 状态类名：这些 class 会随界面状态出现/消失。
     实测教训：活动栏「文件资源管理器」生成出
         #activity-bar > div.activity-icon.active:nth-of-type(3)
     当用户点了「仪表盘」后，该元素不再带 .active，选择器直接失效、点击落空。
     —— 这就是架构文档 R-04「锚点漂移」的真实成因。 */
  const STATE_CLASS = /^(active|selected|sel|on|off|open|opened|closed|disabled|current|checked|focus|focused|hover|hovered|expanded|collapsed|show|shown|hidden|visible|loading|error|dragging|dragover|pressed|highlight|enable|enabled)$/i;
  const escAttr = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  function isUnique(sel) {
    try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; }
  }

  function nearestId(el) {
    let p = el.parentElement;
    while (p) { if (p.id) return p.id; p = p.parentElement; }
    return null;
  }

  /** 结构路径：tag + nth-of-type + 稳定类名（状态类一律剔除） */
  function structuralPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 5) {
      let part = cur.tagName.toLowerCase();
      const cls = [...cur.classList]
        .filter((c) => c && c.length < 32 && !STATE_CLASS.test(c) && !/^(ng|css|v|svelte)-/.test(c))
        .slice(0, 2);
      if (cls.length) part += '.' + cls.map((c) => CSS.escape(c)).join('.');
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((s) => s.tagName === cur.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      if (cur.id) { parts[0] = '#' + CSS.escape(cur.id); break; }
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  /**
   * 生成 CSS 选择器。优先级：
   *   1. id
   *   2. 稳定语义属性（title / aria-label / data-* / name / placeholder）—— 跨状态不变
   *   3. 结构路径（剔除状态类）
   * 每个候选都必须「在当前文档中唯一」才采用。
   */
  function cssPath(el) {
    if (el.id) {
      const s = '#' + CSS.escape(el.id);
      if (document.querySelectorAll(s).length === 1) return s;
    }
    const tag = el.tagName.toLowerCase();
    const scope = nearestId(el);
    const cands = [];
    for (const a of ['title', 'aria-label', 'data-testid', 'data-id', 'name', 'placeholder']) {
      const v = el.getAttribute(a);
      if (!v || v.length > 48) continue;
      cands.push(`${tag}[${a}="${escAttr(v)}"]`);
      if (scope) cands.push(`#${CSS.escape(scope)} ${tag}[${a}="${escAttr(v)}"]`);
    }
    const structural = structuralPath(el);
    cands.push(structural);
    for (const c of cands) if (isUnique(c)) return c;
    return structural;
  }

  /* ---------------- 1. 锚点枚举 ---------------- */
  const anchors = [];
  const usedIds = new Set();
  const primary = [...document.querySelectorAll(INTERACTIVE)];

  /* 第二遍：很多应用用 <div onClick> 做按钮，没有 role / tabindex，语义选择器抓不到。
     实测 AIShell 的活动栏图标（文件树/服务器/仪表盘…）全部漏掉，而它们正是演示视频
     最需要的操作入口。用「可见 + cursor:pointer + 尺寸合理 + 内部没有已收录的可交互子元素」
     作为补充判据。 */
  const seenPrimary = new Set(primary);
  const rawSupp = [];
  for (const el of document.querySelectorAll('body *')) {
    if (seenPrimary.has(el)) continue;
    if (el.closest('[data-dsh-ui]')) continue;              // 跳过采集器自己注入的东西
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8 || r.width > 420 || r.height > 420) continue;
    if (!visible(el, r)) continue;
    if (getComputedStyle(el).cursor !== 'pointer') continue;
    // 纯容器：内部已有被收录的可交互元素，跳过，避免把整块面板也当成按钮
    if ([...el.querySelectorAll(INTERACTIVE)].some((c) => seenPrimary.has(c))) continue;
    // 必须有语义标签，否则就是匿名装饰层
    if (!labelOf(el)) continue;
    rawSupp.push(el);
  }
  // 只保留最外层的 pointer 元素：svg / path / rect 这些内部节点会因为继承到
  // cursor:pointer 而被误收，实测把 26 个锚点灌成 82 个、其中一半是噪声。
  const suppSet = new Set(rawSupp);
  const supplementary = rawSupp.filter((el) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (suppSet.has(p)) return false;
    return true;
  });

  const els = [...primary, ...supplementary];
  let scanned = 0, dupeSel = 0, dupeId = 0;

  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    scanned++;

    const label = labelOf(el);
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    const sel = cssPath(el);
    if (!isUnique(sel)) dupeSel++;

    // 锚点 id：语义优先，冲突时加序号
    let base = slug(label) || slug(el.id) || role;
    if (base.length < 2) base = role + '-' + Math.round(r.top) + '-' + Math.round(r.left);
    let id = base, n = 2;
    while (usedIds.has(id)) { id = base + '-' + n++; dupeId++; }
    usedIds.add(id);

    anchors.push({
      id,
      label,
      role,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || undefined,
      selector: sel,
      selectorUnique: isUnique(sel),
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      text: (el.innerText || '').trim().slice(0, 40) || undefined,
    });
  }

  /* ---------------- 2. 自包含快照 ---------------- */
  const clone = document.documentElement.cloneNode(true);
  clone.querySelectorAll('script').forEach((s) => s.remove());
  clone.querySelectorAll('link[rel="modulepreload"]').forEach((s) => s.remove());

  // 外部样式表内联（dev 模式下 Vite 已用 <style> 注入，这里兜底处理 <link>）
  const linked = [...document.querySelectorAll('link[rel="stylesheet"]')];
  let inlinedSheets = 0;
  for (const l of linked) {
    try {
      const sheet = l.sheet;
      if (!sheet) continue;
      let css = '';
      for (const rule of sheet.cssRules) css += rule.cssText + '\n';
      const st = document.createElement('style');
      st.textContent = css;
      clone.querySelector('head').appendChild(st);
      inlinedSheets++;
    } catch (e) { /* 跨域表跳过 */ }
  }
  clone.querySelectorAll('link[rel="stylesheet"]').forEach((l) => l.remove());

  // 记录仍需联网的资产（这是「自包含」还差多少的量化指标）
  const cssText = [...document.styleSheets].flatMap((sh) => {
    try { return [...sh.cssRules].map((r) => r.cssText); } catch (e) { return []; }
  }).join('\n');
  const urlRefs = [...new Set((cssText.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g) || [])
    .map((u) => u.replace(/^url\(\s*['"]?/, '').replace(/['"]?\s*\)$/, ''))
    .filter((u) => !u.startsWith('data:')))];
  const fontFaces = (cssText.match(/@font-face/g) || []).length;
  const imgSrcs = [...new Set([...document.querySelectorAll('img[src]')]
    .map((i) => i.getAttribute('src'))
    .filter((s) => s && !s.startsWith('data:')))];

  // 基础 href，保证快照从 file:// 打开时相对资源仍可解析
  const base = document.createElement('base');
  base.setAttribute('href', location.origin + '/');
  clone.querySelector('head').insertBefore(base, clone.querySelector('head').firstChild);

  /* ---------------- 2.5 表单状态修复 ----------------
     cloneNode / outerHTML 只序列化 HTML 属性，不保留 JS 通过 property 设置的状态：
     input.value、select.value、checkbox.checked、滚动位置、canvas 像素。
     实测：AI 模式下拉框在线显示「工作」，快照里变成「仅建议」（第一个 option）。
     必须在序列化前把这些 property 写回属性。 */
  const liveForm = document.querySelectorAll('input,select,textarea');
  const cloneForm = clone.querySelectorAll('input,select,textarea');
  let formFixed = 0;
  liveForm.forEach((el, i) => {
    const c = cloneForm[i];
    if (!c) return;
    if (el.tagName === 'SELECT') {
      const lo = [...el.options], co = [...c.options];
      lo.forEach((o, j) => {
        if (!co[j]) return;
        if (o.selected) co[j].setAttribute('selected', ''); else co[j].removeAttribute('selected');
      });
      c.setAttribute('data-dsh-selected-index', String(el.selectedIndex));
    } else if (el.type === 'checkbox' || el.type === 'radio') {
      if (el.checked) c.setAttribute('checked', ''); else c.removeAttribute('checked');
    } else if (el.tagName === 'TEXTAREA') {
      c.textContent = el.value;
    } else {
      c.setAttribute('value', el.value);
    }
    formFixed++;
  });

  /* 滚动位置同样不随序列化保留，落到 data-* 上，运行时再恢复 */
  const liveScroll = document.querySelectorAll('*');
  const cloneScroll = clone.querySelectorAll('*');
  let scrollFixed = 0;
  liveScroll.forEach((el, i) => {
    if (el.scrollTop || el.scrollLeft) {
      const c = cloneScroll[i];
      if (c) {
        c.setAttribute('data-dsh-scroll-top', String(el.scrollTop));
        c.setAttribute('data-dsh-scroll-left', String(el.scrollLeft));
        scrollFixed++;
      }
    }
  });

  /* ---------------- 3. 统计 ---------------- */

  /* 「烧进画面」的错误检测。
     组件内部的 try/catch 不会产生未捕获异常，但会在 DOM 里留下错误横幅 ——
     这类错误如果不拦住，会被原样烤进快照和最终视频。
     这是采集器的第三道检测：未捕获异常、未覆盖 IPC、画面内的错误文案。 */
  const ERRORISH = /(失败|错误|异常|出错|无法|\bError\b|\berror\b|Failed|failed|not a function|is undefined|is null)/;
  const suspicious = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.children.length) continue;
    const t = (el.textContent || '').trim();
    if (!t || t.length > 120) continue;
    if (ERRORISH.test(t)) suspicious.push(t);
  }

  return {
    meta: {
      url: location.href,
      title: document.title,
      capturedAt: '2026-01-01T00:00:00.000Z',
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      readyState: document.readyState,
    },
    stats: {
      interactiveTotal: els.length,
      interactiveSemantic: primary.length,
      interactiveSupplementary: supplementary.length,
      interactiveVisible: scanned,
      anchors: anchors.length,
      selectorNotUnique: dupeSel,
      idCollisions: dupeId,
      cssRules: cssText.split('\n').filter(Boolean).length,
      inlinedSheets,
      fontFaces,
      unresolvedCssUrls: urlRefs.length,
      images: imgSrcs.length,
      domNodes: document.querySelectorAll('*').length,
      formStateFixed: formFixed,
      scrollStateFixed: scrollFixed,
    },
    samples: {
      unresolvedCssUrls: urlRefs.slice(0, 12),
      images: imgSrcs.slice(0, 12),
      i18nWarnings: (window.__DSH_UNKNOWN__ ? [...window.__DSH_UNKNOWN__] : []),
      ipcCalls: (window.__DSH_CALLS__ ? window.__DSH_CALLS__.map((c) => c.cmd) : []),
      determinism: window.__DSH_DETERMINISM__ || null,
      suspiciousText: [...new Set(suspicious)].slice(0, 10),
    },
    anchors,
    snapshot: '<!doctype html>\n' + clone.outerHTML,
  };
})();
