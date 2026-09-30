# DemoStudio 架构设计（暂定代号）

> **一句话**：把「产品功能演示视频」的制作，从手写代码变成「导入项目 → 还原场景 → 录制/编排 → AI 导演 → 出片」。
>
> **它是**：一个 AI 驱动的演示视频导演台 —— 输入真实前端界面和一段剧本，输出可复现的成片。
> **它不是**：After Effects / Flash 的克隆，不是通用 2D 动画引擎，不是屏幕录制软件。

| 项 | 值 |
|---|---|
| 文档版本 | v1.0 |
| 状态 | 待评审 |
| 日期 | 2026-09-30 |
| 参考实现 | `E:\git_worktree\aishell2-srun-aishell-cloud\video`（Remotion 代码即剪辑工作流，已产出 11 条成片） |
| 首个目标 | AIShell（Tauri 2 + React 18 + Vite 6） |

---

## 目录

1. [背景：现状盘点](#1-背景现状盘点)
2. [目标与非目标](#2-目标与非目标)
3. [核心设计原则](#3-核心设计原则)
4. [总体架构](#4-总体架构)
5. [核心概念模型](#5-核心概念模型)
6. [数据模型规范](#6-数据模型规范)
7. [场景资产格式（Scene Bundle）](#7-场景资产格式scene-bundle)
8. [关键子系统](#8-关键子系统)
   - 8.1 [导入器](#81-导入器-importer)
   - 8.2 [采集器与确定性加固](#82-采集器与确定性加固-capture--determinism)
   - 8.3 [录制器](#83-录制器-recorder)
   - 8.4 [编排器与规则引擎](#84-编排器与规则引擎-director)
   - 8.5 [渲染后端](#85-渲染后端-render-backend)
   - 8.6 [AI 服务层](#86-ai-服务层-ai-layer)
9. [逐帧重放契约](#9-逐帧重放契约最关键的工程约束)
10. [桌面壳技术选型](#10-桌面壳技术选型)
11. [安全与隐私](#11-安全与隐私)
12. [许可与合规](#12-许可与合规)
13. [架构决策记录（ADR）](#13-架构决策记录adr)
14. [V1 范围与验收标准](#14-v1-范围与验收标准)
15. [里程碑](#15-里程碑)
16. [风险登记册](#16-风险登记册)
17. [附录 A：现有资产 → 新架构映射](#附录-a现有资产--新架构映射)

---

## 1. 背景：现状盘点

现有 `video/` 是一套**「代码即剪辑」**的确定性视频生产线：Remotion 4 + React 18，1920×1080@30fps，11 个 Composition，已产出 10 条教学视频 + 1 条宣传片（41s–144s）。

### 1.1 真正的资产（不是代码量，是这几个设计）

| 资产 | 位置 | 本质 | 为什么值钱 |
|---|---|---|---|
| **锚点实测系统** | `src/components/anchors.tsx` | 指针/高亮/涟漪不写死坐标，运行时从真实 DOM `getBoundingClientRect` 反算到画布坐标；元素卸载后保留 last-known；引用不存在的锚点**直接抛错** | 解决"指针落不准"的根本问题。**这是整套方案最值钱的设计** |
| **导演脚本** | `src/*/script.ts`（单文件 19–32KB） | 摄像机轨道 + 指针轨道 + 点击 + 字幕 + 状态推导纯函数 | 它**就是**一份时间线文档，只差 GUI |
| **布局单一真源** | `src/*/layout.ts` | 组件 CSS 与运镜/指针共用同一份几何常量 | 改布局，指针自动跟随 |
| **UI 保真移植** | `src/incentive-promo/real-ui.css`（32KB）+ `mocks.tsx` | 主仓 `.css` 逐条抄来加 `.rui` 前缀，非"凭记忆画的示意图" | 像素级真实度 |
| **返工教训** | `docs/*分镜脚本.md` 的"节奏原则" | 相机 hold 再出指针、涟漪 14 帧、字幕间隔 ≥16 帧…… | 这些是**规则**，可以变成产品默认值 |
| **抽帧审片流程** | `out/verify*/`、`out/review7/`、`out/stills*/` | 手工抽了几百帧做对比 | 最该被产品化的痛点 |

### 1.2 真正的瓶颈

`video/` 下**没有 `scripts/` 目录** —— 所有编排都是手写 `script.ts`。瓶颈不在渲染，在：

- **素材制作**：每做一个新功能演示，都要手工移植一遍真实 UI（`real-ui.css` + `WbN.tsx` 动辄 40–55KB）
- **编排工作量**：帧级手写运镜/指针/字幕
- **评审循环**：改了看、看了改，只能靠手工抽帧
- **知识门槛**：这些活只有会写 Remotion 的人能干

这四件事恰好是 AI 擅长的。**DemoStudio 的存在理由就是把它们自动化。**

### 1.3 从现有实现继承的硬约束（不可违背）

1. 逐帧渲染，**每一帧都可能是新进程的首帧** → 场景必须能从第 0 帧确定性重放（见 §9）
2. 禁止 `Date.now()` / `Math.random()` / 真实网络 / 真实时钟（`incentive-promo` 分镜文档明写"全部硬编码、无 `Date.now()`"）
3. 字体度量是漂移源，必须本地化并加渲染闸（`anchors.tsx` 的 `delayRender` + `document.fonts.ready`）
4. 指针必须绑定锚点，**绝不使用绝对坐标**（现有代码为锚点未挂载的情况显式抛错）

---

## 2. 目标与非目标

### 2.1 目标

| # | 目标 | 说明 |
|---|---|---|
| G1 | **全流程贯通** | 导入项目 → 还原场景 → 动画编排 → 出片，一条竖切跑通 |
| G2 | **零代码制作** | 目标用户不必会写 Remotion / React |
| G3 | **真实界面保真** | 场景来自真实前端代码，非手绘示意 |
| G4 | **确定性可复现** | 同一时间线两次渲染逐帧一致，可校验 hash |
| G5 | **AI 深度参与** | 场景还原、动作编排、字幕运镜、素材生成 |
| G6 | **可产品化对外** | 格式稳定、渲染后端可替换、许可清晰 |

### 2.2 非目标（V1 明确不做）

- ❌ 通用 2D 动画引擎（骨骼 / 粒子 / 形状补间）
- ❌ 双向 round-trip（GUI ↔ 代码互相覆盖）；V1 只做**单向导出**
- ❌ 屏幕录制作为主路径（录屏给不了确定性、可 diff、可只重渲一帧）
- ❌ 原生桌面应用（.exe / .app / 系统弹窗）的自动采集 —— 见 R-07
- ❌ 云端协作 / 多人实时编辑
- ❌ 3D、特效合成、调色

---

## 3. 核心设计原则

| # | 原则 | 落地方式 |
|---|---|---|
| P1 | **锚点绑定优先于绝对坐标** | 所有指针/点击/高亮/运镜目标用 anchor id 表达；坐标只是冷启动兜底 |
| P2 | **状态由操作重放得到，而非外部注入** | 不要求用户应用提供 `setState` API；点击/输入序列重放即得状态。通用 + 确定性 |
| P3 | **时间线 JSON 是单一真源** | GUI 编辑 JSON；TSX 导出是编译产物（调试 + 兼容老流程） |
| P4 | **规则优于自由** | 把节奏教训固化为默认值与 lint，新手缺的是判断力不是控制力 |
| P5 | **失败要响亮** | 锚点失配、网络未命中、非确定性调用 → 报错并指出位置，绝不静默偏位 |
| P6 | **场景框架无关** | iframe 沙箱 + postMessage 协议，不绑定 React/Vue/Svelte |
| P7 | **渲染后端可插拔** | `RenderBackend` 接口；Remotion 是默认实现，不是唯一实现 |
| P8 | **本地优先** | 用户代码默认不出本机 |
| P9 | **自有 UI 类名必须命名空间化** | 一旦加载「用户的真实界面」，自有样式必然与它撞名。类名统一加前缀（见 §8.7） |
| P10 | **AI 的每次改动必须可撤销** | AI 能改时间线，就必须能反悔。每个 AI 动作产出一个可回滚的事务单元（见 §8.6） |
| P11 | **对话优先，参数兜底** | 面向非剪辑用户，主界面是「点元素 → 说话」，属性面板只在高级模式下出现（见 §8.6） |

---

## 4. 总体架构

```
┌──────────────────────────────────────────────────────────────────────┐
│  桌面壳 (Electron)                                                    │
│                                                                      │
│  ┌────────────────────────┐        ┌──────────────────────────────┐  │
│  │  Renderer (Chromium)   │  IPC   │  Main (Node.js)              │  │
│  │                        │◄──────►│                              │  │
│  │  · 舞台 @remotion/player│        │  · 项目/文档读写              │  │
│  │  · 时间线编辑器         │        │  · 采集器 Playwright          │  │
│  │  · 场景检查器(锚点标定) │        │  · 确定性加固内核             │  │
│  │  · 录制器控制条         │        │  · 渲染后端 (Remotion)        │  │
│  │  · 审片模式             │        │  · AI 网关 / 密钥管理         │  │
│  └────────────────────────┘        └──────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
         │                                        │
         │ postMessage (逐帧重放契约 §9)           │ spawn
         ▼                                        ▼
┌──────────────────────┐              ┌──────────────────────────────┐
│ 场景运行时 (iframe)   │              │ Headless Chromium (渲染/采集) │
│  · 用户真实前端 bundle│              │  · Remotion 逐帧截图          │
│  · 注入的确定性补丁   │              │  · FFmpeg 编码               │
│  · mock 网络层        │              └──────────────────────────────┘
│  · data-anchor 注入   │
└──────────────────────┘
```

### 4.1 五个功能模块与全流程

```
 ①导入            ②采集/还原          ③录制            ④编排            ⑤出片
 项目探测    →    Playwright 抓取  →   真实操作一遍  →   语义动作轨道  →   渲染后端
 启动 devserver   确定性加固           自动生成动画      + 规则 lint      + 抽帧审片
 路由枚举         锚点表生成           (零门槛路径)      + AI 字幕运镜     + 批量/多版本
```

### 4.2 分层职责

| 层 | 职责 | 明确不做 |
|---|---|---|
| **编辑器 UI** | 呈现与操作时间线文档；不做渲染计算 | 不含渲染逻辑 |
| **文档模型** | 项目 JSON 的读写、校验、迁移 | 不含业务逻辑 |
| **编排引擎** | 语义动作 → 逐帧状态（纯函数） | 不接触 DOM |
| **场景运行时** | 在 iframe 内重放操作、暴露锚点 | 不感知时间线文档 |
| **渲染后端** | 时间线 → mp4 | 不感知编辑器 UI |
| **AI 层** | 生成/建议，产出必须过 lint | 不直接写文件 |

---

## 5. 核心概念模型

### 5.1 坐标系与画布

沿用现有实现，支持两种模式：

| 模式 | 做法 | 用于 |
|---|---|---|
| **设计空间 + 摄像机** | 场景在自身设计坐标系内绘制（如 `1920×1200`），摄像机是关键帧化的取景框（`scale` + 中心 `x/y`），映射到 `1920×1080` 画布 | 演示真实界面（`ssh2`、`dashboard10`） |
| **原生尺寸 + 等比缩放** | 场景按真实窗口尺寸（如 Tauri 默认 `1440×900`）绘制，整体缩放到 `SCALE`，摄像机只做居中缩放 | 宣传片（`incentive-promo`，`SCALE=0.78`） |

**决策**：V1 统一到"设计空间 + 摄像机"模型，`SCALE` 模式视为 `designSpace` 与 `viewport` 不同的特例。

**摄像机模型**：`transform: translate(cx - X*s, cy - Y*s) scale(s)`，取景框中心 `(X, Y)`、缩放 `s` 均为帧的关键帧函数。沿用教训：**避免为边缘控件大幅平移把窗口推出画面**，优先用缩放。

### 5.2 锚点（Anchor）

锚点是场景运行时暴露的**命名矩形**，是全部空间交互的唯一寻址方式。

- 场景侧：DOM 元素带 `data-anchor="<id>"`
- 运行时每帧实测 `getBoundingClientRect` → 归一化到设计空间 → 上报 host
- 卸载后保留 last-known（跨帧缓存）
- 消费方（指针/涟漪/高亮/运镜）只认 id，坐标是兜底

与现有实现的差异：现有 `anchors.tsx` 是在 Remotion 进程内同步测量；新架构中场景在 iframe 内，测量结果通过 postMessage 上报（见 §9）。

### 5.3 语义动作（Semantic Action）

新手友好的核心抽象。**不暴露关键帧，暴露意图**：

| 动作 | 参数 | 自动生成 |
|---|---|---|
| `click` | anchor, button(左/中/右), modifiers | 指针移动 + 涟漪 + 按下态 + 目标态变化 |
| `type` | anchor, text, cps | 聚焦 + 逐字输入 + 光标闪烁 |
| `hover` | anchor, hold | 指针 + 悬停态 |
| `scroll` | anchor/容器, delta, 时长 | 惯性曲线 |
| `key` | combo, anchor | 键盘浮层 + 按压动效 |
| `drag` | from, to, path | 拖拽轨迹 + 落位 |
| `wait` | frames | — |
| `highlight` | anchor, style, from/to | 高亮环呼吸 |
| `callout` | anchor, text, side | 引导标注 + 连线 |
| `caption` | text, from/to | 字幕（自动避让关键信息区） |
| `camera` | anchor 或定点, scale | 推镜/拉远（自动 hold） |
| `transition` | kind, duration | 转场 |

**每个动作都有"AI 展开"和"手动展开"两条路**：一键让 AI 把 `click` 展开成完整指针轨道 + 涟漪，也可以手动拖。

---

## 6. 数据模型规范

### 6.1 项目文档 `project.json`

```jsonc
{
  "formatVersion": 1,
  "meta": {
    "name": "AIShell 功能演示 01",
    "appVersion": "0.1.0",
    "createdAt": "2026-09-30T00:00:00Z"
  },
  "output": {
    "fps": 30,
    "width": 1920,
    "height": 1080,
    "durationInFrames": 1800,
    "background": "#0a0b0e"
  },
  "scenes": [
    {
      "id": "sc-wb2",
      "bundle": "scenes/wb2",
      "designSpace": { "width": 1920, "height": 1200 },
      "mount": { "from": 0, "to": 1800 },
      "initialState": { "route": "/workbench" }
    }
  ],
  "tracks": [
    {
      "id": "tr-cam",
      "type": "camera",
      "keyframes": [
        { "f": 0,   "s": 0.75, "x": 960,  "y": 600 },
        { "f": 160, "s": 1.20, "x": 960,  "y": 580 },
        { "f": 400, "s": 1.20, "x": 960,  "y": 580 }
      ]
    },
    {
      "id": "tr-cur",
      "type": "cursor",
      "pins": [
        { "f": 60,  "x": 1200, "y": 800 },
        { "f": 118, "anchor": "w2-new-proj" },
        { "f": 132, "anchor": "w2-new-proj" }
      ]
    },
    {
      "id": "tr-act",
      "type": "action",
      "items": [
        { "f": 126, "kind": "click", "anchor": "w2-new-proj" },
        { "f": 140, "kind": "focus", "anchor": "w2-name-input" }
      ]
    },
    {
      "id": "tr-type",
      "type": "typing",
      "items": [
        { "f": 142, "anchor": "w2-name-input", "text": "deephaven-bigdata", "cps": 10 }
      ]
    },
    {
      "id": "tr-cap",
      "type": "caption",
      "items": [
        { "from": 84,  "to": 248, "text": "第一步：选择 Workspace 目录，项目将默认创建在这里" },
        { "from": 266, "to": 334, "text": "路径选择完成，点击「保存」使配置生效" }
      ]
    },
    {
      "id": "tr-audio",
      "type": "audio",
      "items": [
        { "from": 0, "to": 1800, "src": "assets/bgm.mp3", "gain": 0.3, "fadeIn": 30, "fadeOut": 45 }
      ]
    }
  ],
  "lint": {
    "holdBeforePointer": 8,
    "minCaptionGap": 16,
    "forbidNondeterminism": true,
    "warnUnboundAnchor": true
  },
  "render": { "backend": "remotion-local", "concurrency": 4 }
}
```

### 6.2 轨道类型总表

| type | 关键字段 | 说明 |
|---|---|---|
| `camera` | `keyframes[{f, s, x, y}]` | 分段缓动（沿用 `anim.ts` 的 `track1` 语义：段间缓动、端点钳制、帧号严格递增） |
| `cursor` | `pins[{f, anchor?, dx?, dy?, x?, y?}]` | anchor 命中即取其中心；无锚点时必须给 `x/y` 兜底，否则报错 |
| `action` | `items[{f, kind, anchor, ...}]` | 驱动场景状态 |
| `typing` | `items[{f, anchor, text, cps}]` | 逐字输入 |
| `overlay` | `items[{from, to, kind, anchor, style}]` | 高亮 / 标注 / 键盘浮层 / 徽标 |
| `caption` | `items[{from, to, text, style}]` | 字幕 |
| `audio` | `items[{from, to, src, gain, fadeIn, fadeOut}]` | 音轨（BGM / TTS / SFX） |
| `transition` | `items[{f, kind, duration}]` | 转场 |

### 6.3 状态推导必须是纯函数

参照现有 `welcomeAt(f)` / `wbAt(f)` / `Wb10State` 的做法：**给定帧号 → 状态对象**，组件只负责渲染。

```ts
// 契约：纯函数，无副作用，无时间/随机依赖
type SceneStateAt = (frame: number) => SceneState;
```

这条是确定性渲染的地基，必须在文档模型层强制。

---

## 7. 场景资产格式（Scene Bundle）

场景是**自包含、可移植、可版本管理**的目录（或 zip）：

```
scenes/wb2/
  manifest.json      # 元信息 + 来源 + 确定性声明 + 能力契约
  ui/                # 场景运行时（HTML + scoped CSS + JS，或打包后的 bundle）
    index.html
    app.js
    app.css
  anchors.json       # 锚点表（含定位策略与兜底选择器）
  state.json         # 可驱动的状态预置（可选）
  assets/            # 图标 / 图片 / 字体，全部本地化，禁外链
```

### 7.1 `manifest.json`

```jsonc
{
  "formatVersion": 1,
  "id": "wb2",
  "title": "AIShell 工作台",
  "source": {
    "kind": "captured",                  // captured | authored | screenshot | url
    "origin": "http://localhost:5173",
    "commit": "a1b2c3d",
    "capturedAt": "2026-09-30T00:00:00Z",
    "determinism": {
      "frozenTime": "2026-01-01T00:00:00Z",
      "network": "replay",               // replay | blocked | live
      "cssAnimations": "disabled",
      "fonts": "local",
      "seededRandom": 12345
    }
  },
  "viewport": { "width": 1440, "height": 900, "deviceScaleFactor": 1 },
  "designSpace": { "width": 1920, "height": 1200 },
  "entry": "ui/index.html",
  "anchors": "anchors.json",
  "capabilities": {
    "actions": ["click", "type", "scroll", "hover", "key"],
    "state": ["route"]
  },
  "assets": ["assets/logo.svg"],
  "knownIssues": ["Canvas 图表在 seek 时需重绘，已加 rAF 补丁"]
}
```

**`capabilities` 是场景对外的契约**：时间线只认它，不认场景内部实现。AI 换一个界面实现，动画不用改。

### 7.2 `anchors.json`

```jsonc
{
  "formatVersion": 1,
  "anchors": [
    {
      "id": "w2-new-proj",
      "label": "新建项目",
      "locator": { "strategy": "attr", "value": "[data-anchor=\"w2-new-proj\"]" },
      "fallback": [
        { "strategy": "role", "role": "button", "name": "新建项目" },
        { "strategy": "css",  "value": ".welcome-head .btn-brand" }
      ],
      "rect": { "x": 1266, "y": 60, "w": 110, "h": 32 },
      "binding": "confirmed",            // auto | confirmed | manual
      "validInStates": ["explorer"]      // 该锚点在哪些状态下存在（见下）
    }
  ]
}
```

#### 锚点漂移有两种，必须分开处理（技术验证 02 实测结论）

| 类型 | 现象 | 处理 |
|---|---|---|
| **选择器脆弱** | 选择器里混入状态相关的东西导致找错/找不到 | **采集期修复**：语义属性优先（`title`/`aria-label`/`data-*`），**状态类一律剔除**（`active`/`selected`/`open`/`disabled`…），每个候选必须当前唯一 |
| **元素本就不存在** | 状态切换导致组件卸载，锚点自然失效 | **不是错误**，是状态语义 —— 用 `validInStates` 声明 |

> 实测：`#activity-bar > div.activity-icon.active:nth-of-type(3)` 这种选择器在状态一变就失效。
> 而「点击仪表盘后，文件树的『新建文件』锚点失配」是**正常**的 —— 那个面板已经卸载了。

**重绑定策略（产品级必需）**：重新采集时按 `locator → fallback` 顺序解析；
- 全部命中且 `rect` 变化在阈值内 → 静默通过
- 命中但位置大幅变化 → 提示"布局已变，请确认"
- 全部失配 → **阻断出片**，进入可视化重绑定 UI

**漂移探测器（应产品化）**：每执行一个动作后，回查全部锚点选择器是否仍唯一命中，
把失配的锚点标出来并区分「选择器坏了」还是「状态不含它」。

### 7.3 场景来源四档

| 档 | 做法 | 保真 | 可编辑 | 成本 | 适用 |
|---|---|---|---|---|---|
| **L1** 截图/录屏贴图 | 整页截图作背景，锚点由 AI 目测标定 | 高 | 低 | 极低 | 复杂图表、一次性镜头 |
| **L2** 真实 UI 移植 ★ | 在 Chromium 跑真实前端 + mock 网络，抓 DOM/computedStyle → bundle + 锚点表 | 最高 | 中高 | 中 | 有源码的产品 |
| **L3** AI 重写组件 | 从截图/描述生成界面代码 | 中 | 最高 | 高 | 无源码的第三方产品 |
| **L4** AI 原生生成 | 纯图形幕（片头/标语/数据卡） | — | 最高 | 低 | 宣传片动效 |

**V1 主攻 L2**，L1/L4 作为补充。

---

## 8. 关键子系统

### 8.1 导入器 (Importer)

**输入**：本地项目目录 / Git URL / 已部署 URL
**输出**：可运行的 Scene Source 描述

流程：
1. 探测框架（读 `package.json`：vite / next / cra / 静态）
2. 推断启动命令与端口（或让用户指定）
3. 起 dev server，健康检查 + 首屏加载成功
4. 抓路由清单（vite 项目可从 `src/` 扫路由或让用户手填）
5. 产出 `SceneSource` 记录（启动命令、URL、路由、环境变量、mock 策略）

**难点**：环境变量/后端依赖/鉴权。对策：默认走"mock 优先"——能在无后端情况下渲染出目标页面才算导入成功。

### 8.2 采集器与确定性加固 (Capture & Determinism)

> 这是产品的**技术本体**，也是最难的部分。

#### 采集流程

1. Playwright（无头 Chromium）打开目标 URL
2. **注入确定性补丁**（在页面脚本之前，见下）
3. 网络录制 → HAR
4. 遍历可交互元素（`a, button, input, [role], [tabindex], [onclick]` 等）→ 生成锚点候选
5. 抓取 DOM + computedStyle + 资源 → 生成 scoped CSS bundle
6. 截图存档（人工比对 + AI 还原度评分）
7. 打包为 Scene Bundle

#### 确定性加固清单（必须全绿才能出片）

| 维度 | 处理 | 备注 |
|---|---|---|
| `Date` / `Date.now` | 冻结到 `frozenTime` | 页面脚本前注入 |
| `performance.now` | 映射到帧时间基准 | 供 rAF 动画使用 |
| `Math.random` | 固定种子 PRNG | 记录种子便于复现 |
| `crypto.getRandomValues` | 确定性替换 | |
| 网络请求 (fetch/XHR) | HAR 回放；**未命中即报错并列出 URL** | 绝不静默 fallback 到真实网络 |
| WebSocket / SSE | 录制回放或硬阻断 | |
| CSS `animation` / `transition` | 暂停或置零（可白名单） | 关键动效应交给时间线驱动，而非 CSS |
| 字体 | 本地化 + `document.fonts.ready` 渲染闸 | 沿用 `anchors.tsx` 做法 |
| `localStorage` / `sessionStorage` / Cookie | 预置快照 | 保证首屏状态一致 |
| Canvas / WebGL | `preserveDrawingBuffer` + seek 重绘补丁 | 高风险，单列（R-05） |
| 定时器 `setTimeout/setInterval` | 重定向到虚拟时钟 | 否则逐帧渲染会各跑各的 |

**验收**：同一场景从头加载两次、在同一帧截图，像素差为 0。

#### 锚点候选生成

AI 在这里的职责很具体、也很好验收：**提候选，人确认**。

- 输入：可交互元素清单（含 role / 可访问名 / 文本 / 位置 / 选择器路径）
- 输出：`{ id, label, locator, fallback }` 候选表
- 人只做两件事：改 id（变成有语义的名字）、删掉不需要的

### 8.3 录制器 (Recorder)

> **对新手最友好的路径**：你操作一遍，我帮你变成片子。

在采集好的场景里，用户真实操作（点击 / 输入 / 滚动），记录为动作序列：

```ts
interface RecordedEvent {
  t: number;              // 相对起始的毫秒
  kind: 'click' | 'type' | 'scroll' | 'key' | 'hover';
  anchor: string;         // 由命中元素反查锚点 id
  payload?: unknown;
  beforeState?: object;   // 操作前状态快照（用于校验重放一致性）
  afterState?: object;
}
```

后处理管线：

```
原始事件 → 归一化(锚点解析) → 抽稀(轨迹采样) → 压帧(对齐 fps) → 语义动作序列
                                                     ↓
                                    指针轨道 + 点击涟漪 + 逐字输入 + 页面状态变化
```

**它天然满足逐帧重放契约**（顺序重放），这是选它做主路径的关键原因（见 §9）。

**AI 在此处的增值**：录完只得到"平铺直叙"的动作，AI 负责——
- 推断节奏（哪里该停、哪里该快）
- 加运镜（何时推近到锚点）
- 配字幕（结合分镜文字 + 动作语义）
- 插转场、加高亮

### 8.4 编排器与规则引擎 (Director)

**编排器**：语义动作轨道 + 摄像机轨道 + 字幕轨道 + 音频轨道 + 转场轨道的可视化编辑。

**规则引擎（lint）**：这是产品差异化的重要部分，把现有项目的血泪教训固化为自动检查。

| 规则 | 来源 | 级别 |
|---|---|---|
| 相机未停稳就出指针 → 建议 hold ≥8 帧 | 分镜文档"节奏原则" | warn |
| 字幕间隔 < 16 帧 → 报错 | `Video.tsx` 注释"间隔 ≥16 帧避免进出场叠影" | error |
| 锚点引用不存在 → 报错 | `anchors.tsx` 显式抛错哲学 | error |
| 涟漪超出元素生命周期 → 警告 | `Cursor.tsx` `RIPPLE_FRAMES = 14` | warn |
| 场景切换时上一幕未完全淡出 → 报错 | 宣传片文档"章节分隔卡必须等上一幕完全淡出" | error |
| 非确定性调用（`Date.now`/`Math.random`/网络）→ 阻断导出 | §1.3 硬约束 | error |
| 推镜把目标元素推出画框 → 警告 | 宣传片文档"避免把窗口推出画面" | warn |
| 字幕遮挡关键信息区 → 警告 | 宣传片文档"toast 放窗口低位避免被字幕遮挡" | warn |
| 指针落到元素边缘而非中心 → 提示 | 锚点系统设计意图 | info |
| 动作时序冲突（点击未聚焦的输入框）→ 报错 | 录制器一致性校验 | error |

**AI 生成的内容必须过 lint 才能落盘。** 这是 AI 可控性的保障。

### 8.5 渲染后端 (Render Backend)

```ts
interface RenderBackend {
  id: string;
  probe(): Promise<{ available: boolean; reason?: string }>;
  renderStill(doc: ProjectDoc, frame: number, out: string): Promise<void>;
  renderVideo(doc: ProjectDoc, out: string, opts: RenderOpts): Promise<RenderResult>;
}
```

| 实现 | 状态 | 说明 |
|---|---|---|
| `remotion-local` | **默认** | `@remotion/bundler` + `@remotion/renderer`，本机 headless Chromium + FFmpeg |
| `remotion-lambda` | 预留 | 云端并发渲染 |
| `capture-ffmpeg` | 预留 | 自研：CDP 逐帧截图 + FFmpeg 编码（**许可兜底方案**） |

**抽象成本约一天，不抽象的代价是一个月。** 产品核心不能吊死在单一供应商授权上（见 §12）。

预览不走渲染后端：用 `@remotion/player` 实时播放（无需 Node）。

### 8.6 AI 服务层 (AI Layer)

| 能力 | 输入 | 输出 | 校验 |
|---|---|---|---|
| **场景还原** | 截图 / DOM / 源码 / URL | Scene Bundle 或 CSS 修复补丁 | 还原度评分（截图 diff）+ 人工确认 |
| **锚点命名** | 可交互元素清单 | 锚点候选表 | 人工确认 |
| **剧本转动作** | 分镜文字 + 场景锚点词汇表 | 语义动作序列 | lint 全绿 |
| **运镜编排** | 动作序列 + 锚点位置 | 摄像机关键帧 | lint 全绿 |
| **字幕生成** | 动作序列 + 语音 / 文本 | 字幕条目（含时长） | 间隔 ≥16 帧 |
| **素材生成** | 描述 | 图标 / 配图 / BGM / TTS | 资产本地化 |
| **语音对齐** | 音轨 + 文本 | 字幕时间轴 | 对齐误差阈值 |

**统一约束**：AI 的输出永远是**候选**，落盘前过 schema 校验 + lint。

#### 交互形态：对话优先（P11）

面向不懂剪辑的用户，主界面不是参数面板而是**对话**。核心动作只有两步：

```
① 点元素（舞台控件 / 时间线片段）→ 变成 @引用 chip
② 说一句话 → AI 执行 → 回复做了什么
```

- **引用是一等公民**：`{ kind: anchor|action|caption|camera, id }`。引用必须用**稳定 ID**，不能用数组下标（AI 增删片段后下标会漂移）。
- **规则检查进对话流**：lint 结果不作为独立面板，而是一条条 AI 消息，每条带「帮我修」。修好后该条自动从对话中移除。
- **AI 动作必须是事务**（P10）：一次指令 = 一个可回滚单元，支持撤销/重做。**没有撤销的 AI 编辑器不可用**。
- **快捷指令随引用对象变化**，降低"不知道该说什么"的门槛。

#### 与规则引擎的关系

AI 生成的任何时间线改动都必须**过 lint 才能落盘**；反过来，lint 发现的每个问题都必须有对应的**自动修复动作**，否则「帮我修」就是假按钮。

---

### 8.7 样式隔离（踩过的坑，P9）

产品要加载**用户的真实界面**，自有 UI 与用户 UI 的类名必然冲突。这不是概率问题。

真实案例：原型里聊天面板的消息气泡用了 `.bubble`，而舞台上模拟的 AIShell 界面早已有
`.bubble{position:absolute}`（AI 气泡样式）—— 两条规则撞名后，所有聊天消息塌成一行、气泡浮到面板外。

**约束**：

| 项 | 规则 |
|---|---|
| 自有 UI 类名 | 一律带命名空间前缀（如 `.ds-` / `.cbub` / `.rui`），禁止裸用 `.card` `.bubble` `.item` `.msg` 这类通用名 |
| 用户界面 | 运行在 iframe 沙箱内，或用 Shadow DOM / 作用域前缀隔离 |
| 构建期检查 | 加一条 lint：自有样式表里出现「无前缀的单段类名」即报错 |
| 参考先例 | `video/src/incentive-promo/real-ui.css` 用 `.rui` 前缀移植主仓 CSS，就是这个问题的既有解法 |

---

## 9. 逐帧重放契约（最关键的工程约束）

Remotion 逐帧渲染，**每一帧都可能是新进程的首帧**。因此：

> ### 契约 C1
> 场景运行时必须能**从第 0 帧确定性重放到第 t 帧**，且 `seek(t)` 的结果只依赖 `t` 和场景代码，不依赖任何外部可变状态。

> ✅ **实证（技术验证 02）**：对 AIShell 工作台做了 `State(k) ≡ 全新加载 + 重放前 k 个动作` 的验证，k=0..5 全部一致。
> 契约成立，运行时场景**可以**交给 Remotion 逐帧渲染。

> ⚠️ **但契约成立 ≠ 性能可用。** 朴素实现实测 **5–8 秒/关键帧**（含加载与静止判定），
> 1800 帧将耗时 2.5 小时。必须实现 §9.3 的增量推进：
> **进程内帧号单调递增时只补差，仅在进程重启时全量重放** —— 全量重放次数 = chunk 数，而非帧数。
> 这是运行时场景能否落地的**唯一瓶颈**，优先级最高。

### 9.1 postMessage 协议

```
host → scene
  { "t": "init",   "manifest": {...}, "initialState": {...} }
  { "t": "seek",   "frame": 240, "actions": [ ...0..240 的全部动作... ] }
  { "t": "ping" }

scene → host
  { "t": "ready" }                                  // 首帧上屏、字体就绪、锚点测量完成
  { "t": "anchors", "rects": { "w2-new-proj": {...} } }
  { "t": "error",   "frame": 240, "message": "..." }
```

### 9.2 host 侧集成

- 挂载 iframe 后 `delayRender('scene ready')`，收到 `ready` 才 `continueRender`（沿用 `anchors.tsx` 的闸门思想）
- 每帧 `seek(frame, actionsUpTo(frame))`，等待 `anchors` 回执后再渲染覆盖层
- **失败响亮**：`seek` 超时或返回 `error` → 渲染直接失败，不产出偏位帧

### 9.3 性能：契约与优化分离

全量重放 1800 帧的做法在渲染时不可接受。分层策略：

| 场景 | 策略 |
|---|---|
| **契约层** | 要求"可从 0 重放" |
| **优化层** | Remotion 渲染同一 chunk 时帧号单调递增 → 只补差（增量推进） |
| **进程重启** | 检测到帧号回退或首帧 → 全量重放 |
| **审片/预览** | Player 内拖动时间轴 → 允许全量重放（有缓存） |

这样既保证正确性，又不牺牲性能。**这是把 iframe 场景塞进 Remotion 的最大工程点。**

---

## 10. 桌面壳技术选型

| 方案 | 优势 | 劣势 | 结论 |
|---|---|---|---|
| **Electron** ★ | 主进程即 Node，`@remotion/renderer` + Playwright 直接可用；进程模型简单 | 安装包 ~150MB+，内存占用高 | **V1 推荐** |
| Tauri 2 + Node sidecar | 包小（~10MB + sidecar）；团队已有 Tauri 经验（主仓就是） | 需打包 Node sidecar（+~50MB）、跨进程 IPC 复杂、调试链路长 | 备选，M3 后评估 |
| 本地 Web + CLI | 上线最快 | 不满足"桌面应用"要求 | 仅用于 M0 加速验证 |

**Chromium 复用优化**：Electron 已自带 Chromium。采集器可优先尝试 `playwright-core` 通过 CDP 连接 Electron 自身的 Chromium，避免再下载一个（省 ~150MB）。若稳定性不足，再退回 Playwright 自带 Chromium。

---

## 11. 安全与隐私

| 项 | 策略 |
|---|---|
| **执行用户代码** | 导入项目 = 执行任意代码。必须**本地沙箱内运行**，UI 明确告知，首次导入需用户确认 |
| **默认不出本机** | 用户项目代码、截图、HAR 默认不上传 |
| **云端 AI 调用** | 只发送必要的**脱敏片段**（元素清单 / 截图裁剪），需显式授权；提供"纯本地模式"降级 |
| **密钥管理** | 存 OS 凭据库，不落明文配置文件 |
| **采集产物** | HAR 可能含 token / 个人数据 → 导出前扫描并提示脱敏 |
| **许可证合规** | 见 §12 |

---

## 12. 许可与合规

### 12.1 Remotion（关键，需尽早确认）

当前官方条款（文档页标注最后更新 2026-09-29，来源见下）：

| 档位 | 适用对象 | 价格 |
|---|---|---|
| Free License | 个人 / **≤3 人**公司，含商用 | 免费 |
| Company → **Remotion for Automators** | **"video editors, prompt-to-video apps, and embedding the Remotion Player"** | **$0.01/次渲染，$100/月最低** |
| Company → Creators | 手工做片（本地 + Studio + AI agent） | $25/月/席位 |
| Enterprise License | 高级需求 | $500/月起 |

> 来源：[License & Pricing](https://www.remotion.dev/docs/license/pricing)

**结论与行动**：

1. **立即核对**：现有 `video/` 工作流若公司 >3 人，本身已在 Company License 范围内
2. Automators 档位的描述**逐字命中本项目形态**（视频编辑器 + 内嵌 Player），须按此预算
3. **渲染后端必须可插拔**（§8.5），`capture-ffmpeg` 是许可兜底方案
4. 通读 [Telemetry](https://www.remotion.dev/docs/telemetry) 与 [Terms](https://www.remotion.dev/docs/terms)：涉及向客户解释"渲染用量上报"
5. **调研 [Editor Starter](https://www.remotion.dev/docs/editor-starter)**：官方可能已提供时间线编辑器脚手架，避免重复造轮子、避免正面竞争
6. 差异化必须压在官方没有的地方：**场景采集 + 确定性加固 + AI 导演**

### 12.2 其他

| 项 | 风险 | 对策 |
|---|---|---|
| 商用字体（思源 / 苹方 / 微软雅黑） | 嵌入视频需授权 | 只用开源字体或已授权字体，字体清单入项目元数据 |
| BGM | 版权 | 内置可商用曲库 + 用户自备上传 |
| TTS 音色 | 声音权 | 使用合规音色，禁止克隆他人声音 |

---

## 13. 架构决策记录（ADR）

| # | 决策 | 理由 | 代价 |
|---|---|---|---|
| ADR-001 | **复用 Remotion 作为默认渲染内核** | 已解决确定性逐帧、资产闸、字体、headless Chrome + FFmpeg；现有 11 条成片可直接对照验收 | 依赖供应商，商用需授权（§12） |
| ADR-002 | **场景以 iframe + postMessage 接入** | 框架无关、CSS 隔离、崩溃隔离 | 跨进程测量带来同步复杂度 |
| ADR-003 | **状态由操作重放得到，不要求外部 setState** | 通用（适配任意用户应用）+ 天然满足 C1 重放契约 | 到达深层状态需重放较多动作 |
| ADR-004 | **锚点绑定优先于绝对坐标** | 现有 `anchors.tsx` 已验证；坐标漂移是万恶之源 | 需要锚点表维护与重绑定 UI |
| ADR-005 | **时间线 JSON 是单一真源，TSX 导出是产物** | 格式稳定才能产品化；避免 GUI/代码双向同步地狱 | 现有 `script.ts` 需适配层 |
| ADR-006 | **V1 桌面壳选 Electron** | Remotion + Playwright 都是 Node 优先 | 安装包偏大 |
| ADR-007 | **渲染后端可插拔** | 授权风险隔离 + 未来云端渲染 | 一天抽象成本 |
| ADR-008 | **AI 输出永远是候选，落盘前过 schema + lint** | 可控性 | 多一步确认交互 |
| ADR-009 | **V1 主攻 L2（真实 UI 移植）** | 保真最高，且 AIShell 有源码、有 `real-ui.css` 可对照 | 需要确定性加固内核 |

---

## 14. V1 范围与验收标准

### 14.1 唯一主线（一句话）

> **导入一个本地 Vite/React 项目 → 无头采集生成场景 → 在浏览器里真实点 3 次、输 1 行字并自动录成动画 → 加 3 条字幕 → 导出 1080p30 mp4。全程不写一行代码。**

### 14.2 量化指标

| 指标 | 目标 |
|---|---|
| 采集 1 个页面 | < 5 分钟 |
| 录完到出片 | < 3 分钟 |
| **同一时间线渲染两次逐帧一致** | **hash 完全相同**（确定性内核成立的唯一证据） |
| 锚点落点误差 | 0 px（实测，非估算） |
| 场景冷启动到 `ready` | < 3 秒 |

### 14.3 功能清单

- [ ] 项目导入：本地目录探测 + 启动 dev server + 加载成功
- [ ] 采集：Playwright + 确定性加固 + 锚点表 + CSS bundle 导出
- [ ] 舞台：`@remotion/player` 实时预览，可拖时间轴
- [ ] 录制：点击 / 输入 / 滚动 → 语义动作序列
- [ ] 编排：动作 / 摄像机 / 字幕 / 音频四条轨道可视化编辑
- [ ] Lint：§8.4 中标记为 error 的规则全部生效
- [ ] 出片：`RenderBackend` + Remotion 本地渲染 mp4
- [ ] 导出 TSX（调试与兼容老流程）

---

## 15. 里程碑

| 里程碑 | 内容 | 证明什么 | 建议周期 |
|---|---|---|---|
| **M0 骨架** | 文档模型 + Player 舞台 + `RenderBackend` 接口 + 出片闭环（直接拿现有 `ssh2` 场景当素材） | 新应用与老管线**产出同一种东西**，管线零风险 | 1 周 |
| **M1 采集器** | Playwright + 确定性加固 + 自动锚点表 | 能导入 AIShell 并还原出场景 | 2–3 周 |
| **M2 录制器** | 真实操作 → 自动动画 | 零门槛路径成立 | 1–2 周 |
| **M3 编排 + Lint** | 轨道 UI + 规则引擎 + AI 字幕/运镜 | 比手写 `script.ts` 更快 | 2–3 周 |
| **M4 量产** | AI 剧本一键成片 + 抽帧审片 + 批量渲染 + 多版本 diff | 可交付产品 | 3–4 周 |

> **M0 做完，项目就没有技术风险了**，剩余是工程量。

---

## 16. 风险登记册

| # | 风险 | 影响 | 概率 | 对策 |
|---|---|---|---|---|
| R-01 | Remotion 商用授权成本 | 高 | 高 | 提前核对；ADR-007 可插拔后端 |
| R-02 | 确定性加固覆盖不全（第三方库绕过 patch） | 高 | 高 | 补齐"两次渲染 hash 一致"的自动化测试为门禁；未命中的网络请求必须报错 |
| R-03 | 全量重放性能不可接受 | 高 | 中 | §9.3 增量推进 + 契约/优化分离 |
| R-04 | 锚点漂移导致老项目失效 | 中 | 高 | §7.2 重绑定策略 + 失配阻断 |
| R-05 | Canvas / WebGL / 视频元素无法确定性捕获 | 中 | 中 | 单列专项；L1 截图贴图兜底 |
| R-06 | 用户项目环境依赖复杂（后端/鉴权）导致采不到 | 中 | 高 | "mock 优先"策略；导入成功以"无后端可渲染目标页"为准 |
| R-07 | 原生桌面应用（Tauri/Electron 壳外）无法采集 | 中 | 中 | V1 明确不支持；后续用系统级截图 + 手动锚点兜底 |
| R-08 | 安装包过大（Electron + 双 Chromium） | 低 | 中 | 复用 Electron 自带 Chromium 走 CDP |
| R-09 | 与官方 Editor Starter 功能重叠 | 中 | 中 | 先调研；差异化押在采集 + 确定性 + AI 导演 |
| R-10 | 商用字体 / BGM / 音色授权 | 中 | 中 | 内置合规素材库；元数据记录来源 |

---

## 附录 A：现有资产 → 新架构映射

| 现有 `video/` | 新架构对应物 | 迁移方式 |
|---|---|---|
| `src/anim.ts` `track1` 分段关键帧 | 编排引擎的插值原语 | 直接复用（已独立、无依赖） |
| `src/components/anchors.tsx` | 场景运行时的锚点协议 | 概念复用；实现从"同进程同步测量"改为"iframe postMessage"（§9.1） |
| `src/*/layout.ts` 几何常量 | Scene Bundle 的 `anchors.json` | 由采集器自动生成；现有常量转为兜底 `rect` |
| `src/*/script.ts` 导演脚本 | `project.json` 的 `tracks` | 写一次性适配器导入（只读，ADR-005） |
| `src/*/WbN.tsx` 手写界面 | Scene Bundle `ui/` | L2 采集替代；已移植的 `real-ui.css` 可继续作为样式源 |
| `src/components/Cursor.tsx` 涟漪 | overlay 轨道的 `click` 表现 | 参数化（`RIPPLE_FRAMES=14` 进默认配置） |
| `src/components/Caption.tsx` | caption 轨道 | `minCaptionGap=16` 进 lint 默认值 |
| `src/Root.tsx` Composition 注册 | `output` 段 | 每个 `script.ts` 变成一个 project.json |
| `out/verify*/` `out/review7/` 抽帧 | 审片模式 | 产品化为内置功能 |
| `docs/*分镜脚本.md` 节奏原则 | lint 规则集 | 逐条转成规则（§8.4） |
| `incentive-promo/real-ui.css` | 场景样式源 | 继续可用；新场景走自动采集 |

---

## 附录 B：待决问题

| # | 问题 | 影响 | 建议 |
|---|---|---|---|
| Q1 | Remotion license 现状与预算 | 决定 ADR-001/007 的紧迫度 | 本周内确认 |
| Q2 | 首个导入目标 | 决定 M1 范围 | **建议 AIShell**（有源码、有 `real-ui.css` 对照、有 11 条成片当验收基准） |
| Q3 | 桌面壳最终选型 | 决定打包与调试链路 | Electron 起步，M3 后评估 Tauri |
| Q4 | AI 供应商与本地化要求 | 决定 AI 层架构 | 需支持"纯本地模式"降级 |
| Q5 | 是否采购 / 调研 Editor Starter | 可能省数月工作量 | M0 期间并行调研 |
