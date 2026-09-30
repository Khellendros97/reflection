/**
 * DemoStudio 技术验证 · 确定性补丁
 *
 * 在目标应用脚本之前注入，把「不确定的源头」固定下来。
 * 目标：同一个页面加载两次，在同一时刻截图，像素完全一致。
 *
 * 刻意没有冻结 performance.now() —— React 调度器依赖它，冻结会导致卡死。
 * 它不影响渲染结果，只影响调度时机。
 */
(() => {
  'use strict';
  const FROZEN_MS = 1767225600000;   // 2026-01-01T00:00:00Z
  const SEED = 0x5eed1234;
  const stats = { dateFrozen: false, randomSeeded: false, cssAnimationsDisabled: 0 };
  window.__DSH_DETERMINISM__ = stats;

  /* ---------- 1. 冻结时间 ---------- */
  try {
    const RealDate = Date;
    class FrozenDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(FROZEN_MS);
        else super(...args);
      }
      static now() { return FROZEN_MS; }
    }
    // 保留原型链上的其余能力
    Object.defineProperty(window, 'Date', { value: FrozenDate, writable: true, configurable: true });
    stats.dateFrozen = true;
  } catch (e) { /* 保持原样 */ }

  /* ---------- 2. 固定随机数 ---------- */
  try {
    let s = SEED >>> 0;
    const rand = () => {
      // xorshift32：确定、够快、分布够用
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;  s >>>= 0;
      return s / 4294967296;
    };
    Math.random = rand;
    if (window.crypto && crypto.getRandomValues) {
      const orig = crypto.getRandomValues.bind(crypto);
      crypto.getRandomValues = (arr) => {
        for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(rand() * 256);
        return arr;
      };
    }
    stats.randomSeeded = true;
  } catch (e) { /* 保持原样 */ }

  /* ---------- 3. 暂停 CSS 动画（动画应交给时间线驱动，而不是 CSS） ---------- */
  const killAnim = () => {
    const style = document.createElement('style');
    style.setAttribute('data-dsh', 'freeze');
    style.textContent =
      '*,*::before,*::after{animation-play-state:paused !important;' +
      'animation-delay:0s !important;animation-duration:0s !important;' +
      'transition:none !important;caret-color:transparent !important}';
    (document.head || document.documentElement).appendChild(style);
    stats.cssAnimationsDisabled = 1;
  };
  if (document.head) killAnim();
  else document.addEventListener('DOMContentLoaded', killAnim, { once: true });

  /* ---------- 4. 把滚动条和字体度量也钉死 ---------- */
  // 滚动条占位会让布局宽度随平台变化
  const onReady = () => {
    const s2 = document.createElement('style');
    s2.textContent = 'html{overflow:hidden !important}';
    (document.head || document.documentElement).appendChild(s2);
  };
  // 注意：init script 在 document 初始化之前执行，此时 documentElement 可能是 null，
  // 必须等 DOM 就绪再操作（第一版没做这个判断，直接抛了 TypeError）。
  if (document.documentElement) onReady();
  else document.addEventListener('DOMContentLoaded', onReady, { once: true });
})();
