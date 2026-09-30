/**
 * DemoStudio 技术验证 · Tauri IPC 接管层
 *
 * 原理：@tauri-apps/api/core 的 invoke 只是
 *     async function invoke(cmd, args, options) {
 *         return window.__TAURI_INTERNALS__.invoke(cmd, args, options);
 *     }
 * 所以只要在页面脚本之前定义 window.__TAURI_INTERNALS__，
 * 就能接管目标应用的全部后端调用 —— 不需要改目标项目一行代码。
 *
 * 本文件用于验证：能不能把「一个真实前端项目」跑成「确定性动画场景」。
 */
(() => {
  'use strict';

  const LOG = [];
  window.__DSH_CALLS__ = LOG;
  window.__DSH_UNKNOWN__ = new Set();

  /* ---------------- 确定性数据表（虚构但是结构完整的演示数据） ---------------- */
  const NOW = '2026-01-01T00:00:00.000Z';

  const SETTINGS = {
    theme: 'dark',
    workspace: 'D:\\AIShell\\workspace',
    autoAiWorkspace: true,
    approvalMode: 'smart',
    autoBackupRemote: false,
    syncTimeline: true,
    openFileMode: 'builtin',
    menuDefaultPage: 'dashboard',
    terminalShell: 'zsh',
    fontSize: 13,
  };

  const SERVERS = [
    { id: 'srv-1', name: 'deephaven-dev-01', host: '10.21.36.8', port: 22, username: 'devops', folder: '', credentialId: null, tags: [], createdAt: NOW, updatedAt: NOW },
    { id: 'srv-2', name: 'order-1', host: '10.21.36.24', port: 22, username: 'deploy', folder: '生产', credentialId: null, tags: [], createdAt: NOW, updatedAt: NOW },
    { id: 'srv-3', name: 'staging-02', host: '10.21.40.7', port: 22, username: 'devops', folder: '测试', credentialId: null, tags: [], createdAt: NOW, updatedAt: NOW },
  ];

  const PROJECTS = [
    { id: 'prj-1', name: 'deephaven-bigdata', serverId: 'srv-1', folder: '', createdAt: NOW, updatedAt: NOW },
    { id: 'prj-2', name: 'order-release', serverId: 'srv-2', folder: '生产', createdAt: NOW, updatedAt: NOW },
  ];

  const STATE = {
    settings: SETTINGS,
    servers: SERVERS,
    credentials: [],
    projects: PROJECTS,
    sessions: {},
    projectFolders: ['生产', '测试'],
    commandFolders: [],
    uiExpanded: {},
    sftpHistory: {},
    sftpFavorites: {},
    dbConnections: {},
    mcp: { enabled: false, port: 8945 },
    mcpDevices: {},
    seededSkillWorkspaces: [],
    traceEnabled: false,
    sshTunnels: [],
    browserProxy: { enabled: false },
    browserFavorites: [],
    aiWindowGeometry: null,
  };

  /* ---------------- 命令分发表 ---------------- */
  const TABLE = {
    /* 启动握手：main.tsx 用它决定进 welcome 还是 settings */
    is_config_complete: () => true,
    get_state: () => STATE,
    get_task_project: () => PROJECTS[0],
    set_theme: () => null,
    save_settings: () => null,
    open_devtools: () => null,
    ai_any_busy: () => false,
    ai_window_close: () => null,
    update_status: () => ({ state: 'idle', currentVersion: '1.3.2', latestVersion: '1.3.2' }),

    /* 文件系统 / 侧栏 */
    list_projects: () => PROJECTS,
    list_servers: () => SERVERS,
    fs_list: () => [],
    fs_stat: () => null,

    /* 时间线 / 仪表盘 / 备忘录（演示视频里最常用的几页） */
    timeline_query: () => ({ entries: [], total: 0 }),
    timeline_cloud_info: () => ({ enabled: true, retentionDays: 90, uploaded: 128 }),
    list_notes: () => [],
    dashboard_render: () => ({ charts: [] }),
    incentive_points: () => ({ total: 386, rank: 2, dimensions: [] }),
    incentive_rules: () => ({ channels: [] }),
    incentive_leaderboard: () => ({ rows: [] }),

    /* AI */
    ai_list_sessions: () => [],
    ai_send: () => ({ sessionId: 'sess-1' }),

    /* 以下四个曾经漏掉，直接导致 AI 面板异步报错、横幅出现又消失：
       同一页面在 2.5s 与 7.5s 两个时刻的画面差了 32942 像素（最大通道差 196）。
       教训：mock 的缺口不是「安静地少显示一点」，而是变成随机的不稳定。 */
    cloud_status: () => ({ mode: 'off', loggedIn: false, serverUrl: '', quota: null }),
    tunnel_list: () => [],
    sessions_get: () => [],            // 期望 ChatSession[]；给 {} 会让调用方 .filter 崩掉
    ai_debug_info: () => ({ runtime: 'pi', ready: true }),

    /* 工作台终端 / 暂存区 */
    staging_list: () => [],
    term_create: () => ({ id: 'term-1' }),
    term_resize: () => null,
  };

  /** Tauri 自身的 plugin: 命令，不是业务调用 */
  let listenerSeq = 1;
  function pluginCall(cmd) {
    if (cmd === 'plugin:event|listen') return listenerSeq++;
    if (cmd === 'plugin:event|unlisten') return null;
    if (cmd === 'plugin:window|is_maximized') return false;
    if (cmd === 'plugin:window|is_fullscreen') return false;
    if (cmd === 'plugin:window|is_minimized') return false;
    if (cmd === 'plugin:app|version') return '1.3.2';
    if (cmd === 'plugin:app|name') return 'AIShell';
    if (cmd === 'plugin:app|tauri_version') return '2.11.1';
    if (cmd.startsWith('plugin:')) return null;
    return undefined;   // 不是 plugin 命令
  }

  /* ---------------- 兜底策略：按命令名猜一个类型正确的空值 ----------------
     实测教训：漏掉 sessions_get 时返回了 null，应用在 AI 面板里
     `.filter()` 崩掉、弹出错误横幅，4 秒后又消失 —— 同一页面在 2.5s 与 7.5s
     两个时刻的画面差了 32942 像素。mock 的缺口不是「少显示一点」，
     而是变成随机的不稳定，直接破坏「同一帧像素一致」这个地基。 */
  function fallback(cmd) {
    window.__DSH_UNKNOWN__.add(cmd);
    if (/^(is_|has_|can_|should_)/.test(cmd)) return false;
    if (/^(list_|query_|search_|read_|get_all_)/.test(cmd)) return [];
    if (/_status$|_info$|_state$/.test(cmd)) return {};
    if (/^get_/.test(cmd)) return {};
    return null;
  }

  /* ---------------- invoke 实现 ---------------- */
  let callbackId = 1;
  const callbacks = new Map();

  function invoke(cmd, args) {
    LOG.push({ i: LOG.length, cmd, args: args === undefined ? null : args });
    try {
      if (Object.prototype.hasOwnProperty.call(TABLE, cmd)) {
        return Promise.resolve(TABLE[cmd](args));
      }
      const p = pluginCall(cmd);
      if (p !== undefined) return Promise.resolve(p);
      return Promise.resolve(fallback(cmd));
    } catch (err) {
      return Promise.reject(String((err && err.message) || err));
    }
  }

  window.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback(cb, once) {
      const id = callbackId++;
      callbacks.set(id, { cb, once });
      return id;
    },
    unregisterCallback(id) { callbacks.delete(id); },
    convertFileSrc(p) { return p; },
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main' },
    },
  };

  // 部分代码走旧版全局
  window.__TAURI__ = window.__TAURI__ || {};
  window.__TAURI__.core = { invoke };
})();
