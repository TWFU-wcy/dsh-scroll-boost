# dsh-scroll-boost

一个**纯客户端**的 DeepSeek Harness Web GUI 滚动优化插件。

它不卸载插件、不改 React 组件、不改主题，也不降低画面质量：只在空闲时给「真正可滚动容器里的长列表直接子行」加上
`content-visibility: auto`，让浏览器跳过屏幕外行的布局与绘制，从而减少滚动时的合成和重排压力。

> 当前版本：`0.6.0`（识别 DSH 自身的界面结构：聊天流直接接管，轨迹表用静态规则覆盖，
> PTC 过程按「步」跳过、普通长思考正文按块跳过；**正在流式增长的正文改成只加 `contain: layout`**，
> 不再逐块打跳过标记；行高以真实高度为准；展开/折叠后只重测受影响的那一行）

[![GitHub](https://img.shields.io/badge/GitHub-TWFU--wcy%2Fdsh--scroll--boost-181717?logo=github)](https://github.com/TWFU-wcy/dsh-scroll-boost)
[![Release](https://img.shields.io/github/v/release/TWFU-wcy/dsh-scroll-boost?label=release)](https://github.com/TWFU-wcy/dsh-scroll-boost/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 解决什么问题

安装 `@changfenhuang/dsh-genui` 等会在 DOM 中生成大量围栏内容的插件后，长会话滚动可能出现掉帧。
根因通常是浏览器仍在对整页 DOM 做布局/绘制，而滚动帧预算只有约 16.7ms。

`dsh-scroll-boost` 的做法是：**只让屏幕外的“行”不参与渲染**，屏幕内的画面完全不变。

## 0.3.0 重构：从「猜列表」到「认表面」

0.2.x 的做法是「在页面里找一个看起来可滚动的容器，再把它的直接子节点当成行」。
问题在于 **DSH 把聊天记录渲染进一个 `display: contents` 的槽位**——槽位自己没有盒子，
所以那套「向下走直到找到行列表」的搜索永远看不到它，**长会话聊天页基本没被优化过**。

0.3.0 改为直接认 DSH 自己的稳定 `data-*` 表面，并按表面类型决定策略：

| 表面 | 选择器 | 策略 | 原因 |
| --- | --- | --- | --- |
| `chat-flow` | `[data-slot="conversation.chat.flow"]` | 标记其直接子行 | 聊天记录没有虚拟化，行数随会话增长，是收益最大的地方 |
| `conversation-scroll` | `[data-conversation-scroll]` | 只加 `will-change` 提示 | 这是真正的滚动口 |
| `trajectory` | `[data-trajectory-scroll]` | 静态规则只跳内容单元格 | DSH 每帧重建行，JS 写的属性活不到绘制；见下节 |
| `summary-region` | `[data-summary-scroll-region]` | 只加提示 | 摘要区是短列表，不需要跳行 |

认不出来的界面仍走 0.2.x 的通用回退路径，所以版本升级不会让插件彻底失效。

### 0.4.0：轨迹页为什么需要一条静态规则

0.3.0 把轨迹页整个跳过了，理由是「DSH 自己做虚拟化」。这个判断只对了一半：
虚拟化确实在，但它在**滚动时每帧重建 `<tr>`**（`tbody.replaceChildren`）。
插件原本的打标记方式是「读一次高度 → 写一个 `data-*` 属性」，属性写上去的下一帧就被新节点换掉了，
等于什么都没做——所以 0.3.0 之后轨迹页的手感反而回到没装插件时。

0.4.0 换成一条**静态 CSS 规则**：规则随样式表一次性生效，浏览器在它自己的样式计算里应用，
不需要主线程逐行写 DOM，也就不会被重建冲掉。

```css
[data-trajectory-scroll] tbody tr[data-record-index]:not([data-turn-start]):not([data-terminal-request-boundary]):not([data-request-only]):not([data-collapsed-summary]) > td:last-child {
  content-visibility: auto;
  contain-intrinsic-size: auto 30px;
}
```

三个约束来自对真实轨迹表的像素级验证：

- **只标内容单元格**（`td:last-child`）。事件列里有绝对定位、故意越界的 `turnRail` 与
  `requestBoundaryControl`，`content-visibility` 的 paint containment 会把它们裁掉。
- **排除 `data-turn-start` 行**。这类行用 `td:before` 在自己上边缘画 1px 分隔线，同样会被裁。
- **排除非标准高度行**（9px 边界行、0px 请求行、24px 折叠摘要行）。它们的占位高度和真实高度
  不一致，会让滚动条漂移。

实测（2000 行虚拟化轨迹表，每帧重建 46 行，富文本内容）：每帧脚本+布局耗时中位数 **6.3 → 5.0 ms**
（−21%），p95 **11.6 → 8.3 ms**（−28%）；行高集合与 `scrollHeight` 完全不变；
同位置截图与未安装插件时 **diff = 0 像素**。

### 0.5.0：长思考正文按块跳过

展开一条很长的思考过程（尤其 PTC 模式下多轮 `reasoning` 叠加）后滚动依然会卡，原因和轨迹页完全不同：
整段思考正文是**一个** Markdown 子树，高度远超视口，所以「按行跳过」永远没有可跳的行——
它在视口里，`content-visibility` 就不生效，每帧都要对整棵子树做一次 style + layout。

0.5.0 把跳过粒度从「行」下沉到「块」：只在**思考正文的根**上工作，给它高度超过 1.5 屏的
直接块子元素（段落、代码块、列表、表格）逐个打标记。

> 下面这段是 0.5.0 的写法。0.6.0 已把钉高改为直接写字面量（见下一节），
> `--sb-chunk-h` 这个自定义属性不再存在。

```css
/* 0.5.0 */
[data-scrollboost-chunk] {
  content-visibility: auto;
  contain-intrinsic-size: auto 120px;
  contain-intrinsic-size: auto var(--sb-chunk-h, 120px);
}
```

命中根用的是 `[data-markdown-variant="compact"]`：DSH 只在**思考正文**上输出这个属性
（普通回答的 Markdown 没有），所以不依赖任何哈希类名。

关键约束是**必须先钉真实高度**。块在离屏时读不到布局，`contain-intrinsic-size` 若给一个
估算值，整段正文的 `scrollHeight` 会塌掉（实测 480 块时漂移 −23444px），
页面顶部那个 sticky 的思考头也会被顶出屏幕。所以每个块都是「先量、再钉、后打标」，
并且：

- 流式输出中的正文一律不动（`data-state` 还在 running）——它的文字每个 token 都在变，
  钉住的高度立刻过期；
- 流结束时 `data-state` 翻转、但没有任何节点新增，这条属性变化本身会触发一次分块；
- 块数量变化时（React 重建了正文）整组解钉重来，不会留下过期的占位；
- `disable()` 会把所有钉高与标记清干净，`scrollHeight` 完全还原。

实测（12 个思考块组 × 42 块、真实类名、headless Edge）：每帧脚本+布局耗时中位数
**3.3 → 0.2 ms**，p95 **6.3 → 0.3 ms**；`scrollHeight` 前后一致（48512），
每个正文根的高度不变（4016），sticky 思考头位置不变；离屏块 `checkVisibility` 确认被跳过；
`disable()` 后块标记清零、`scrollHeight` 还原。

> 像素核对：把「插件整体」与「插件但块规则不生效」两组截图对比，**diff = 0**——
> 块级跳过本身不改变任何像素。整体与未安装时仍有少量差异，来自 B 层的
> `will-change: scroll-position`（见「代价」一节），与这一层无关。

### 0.6.0：PTC 过程按「步」跳过

PTC 模式下的「思考过程」不是一个 Markdown 子树，而是一个**过程组**：DSH 把每一轮子调用渲染成
组里的一个 step，展开后整组直接铺在会话滚动流里。

```html
<div data-step-process data-group-expanded-mode>
  <div data-step-process-body>            <!-- 展开时 max-height:none，没有内层滚动口 -->
    <div data-step-process-content data-chat-flow>
      <div data-chat-flow-key>…</div>     <!-- 一个 step，往往就有好几千像素 -->
      …
```

0.5.0 的块级跳过在这里会失效，而且失效得很隐蔽：它要求「正文根」高过 1.5 屏、且至少有 6 个直接块子元素，
可一个 step 的正文常常两条都不满足，于是整组一块都没跳。即使跳上了，**粒度也不对**——
真正该跳的盒子是 step，不是 step 里那几十个段落。

0.6.0 因此改成**步级**：先认 `[data-step-process-content][data-chat-flow]`，给它的每个直接子 step
打标记；组外的长思考正文仍按块跳过作为兜底。

```css
[data-scrollboost-chunk] {
  content-visibility: auto;
  contain-intrinsic-size: auto 120px;   /* 真实高度由脚本逐个写回 */
}
```

两个数字决定了这个设计（40 步 × 70 块，每帧 style recalc + layout）：

| 方案 | 中位数 | p95 |
| --- | --- | --- |
| 不优化 | 9.6 ms | 14.6 ms |
| 块级（每步 70 块） | 3.7 ms | 5.8 ms |
| **步级（每步 1 盒）** | **0.2 ms** | **0.5 ms** |

被跳过的**盒子数量**才是成本主因，节点数不是。另外，钉高方式也换了：

- 旧写法 `contain-intrinsic-size: auto var(--sb-chunk-h)` 每个被跳过的盒子在每次 style recalc
  都要解析一次 `var()`，实测比字面量慢约 **6 倍**（18.1 ms vs 2.8 ms）；
- 0.6.0 直接把 `auto <N>px` 写到元素的 inline style 上，不再经过自定义属性。

流式期间仍然不动：step 里只要还有 `[data-state="running"]`，它就不参与；流结束时
`data-state` 翻转会单独触发一次分块。一轮 PTC 是**一个个 step 陆续结束**的，所以组会边跑边长：
新落定的 step 由一次增量补齐（只测新增的那几个盒子，已钉的盒子不重新测量、不重新布局），
只有 React 重建了整组（已钉的盒子脱离文档）才整组解钉重来。

实测（PTC 40 步 × 70 块，真实类名，headless Edge）：每帧耗时中位数 **9.6 → 0.2 ms**，
p95 **14.6 → 0.5 ms**；`scrollHeight` 前后一致（134759），40 个 step 全部打上标记、
内部的 Markdown 块一个都没碰；`disable()` 后标记清零、`scrollHeight` 还原。
增量补齐也单独验过：往已钉好的组里再追加一个刚结束流式的 step，它会在一秒内被钉上，
`scrollHeight` 变化 **0px**。

### 正在流式增长的正文：只加 `contain: layout`

这是**最新的一次改动，也是收益最大的一次**：用户反馈「所有很长的思考过程滚动都卡，
尤其是正在思考中的时候最卡」。归因是这样一步步定下来的（全部用探针实测，headless Edge）：

**症状**：长思考正文在**流式期间**滚动最卡，流结束后反而不卡了。

**第一直觉（错的）**：既然离屏块跳过有效，那就给流式中的块也打上标记。
实测这个方向**更慢**：

| 每帧 style recalc + layout（单条 3000 块正文，每帧追加 1 个 token） | 中位数 | p95 |
| --- | --- | --- |
| 不加任何东西 | 2.2 ms | 4.8 ms |
| **给每个块打 `content-visibility`（0.6.0 的做法）** | **5.2 ms** | **9.9 ms** |
| 只加 `contain: layout` | **1.6 ms** | **4.5 ms** |
| 两者都加 | 3.7 ms | 8.1 ms |

**为什么**：正在增长的正文每来一个 token，整条正文都要重排一次。
`content-visibility: auto` 在**流式中**会不断判断「这个块离屏了吗」，
这个判断本身就变成每帧的额外开销；而且块的钉高会随流式不断过期、不断重写。
它只在**内容已经落定、块不再变**的时候才是净收益。

`contain: layout` 不做跳过、不钉高度、不改像素，它只告诉浏览器「这个盒子的布局不会影响外面」。
于是正文内部的重排被限制在这个盒子里，不再扩散到整页。实测正好是这个杠杆：

- 流式期间每帧中位数 **2.2 → 1.6 ms**，p95 **4.8 → 4.5 ms**；
- 单 token 追加延迟 **2.1 → 1.1 ms**（约 2×）；
- 帧级探针（3000 块正文 + 每帧 1 token + 每帧滚动跳变）：
  0.6.0 的逐块钉高产生 **133 个长帧（29.6%）**，新策略 **0 个**；
- 截图对比 `plain` vs `contain`：**diffpix = 0，bbox = None**——一个像素都没变；
- `scrollHeight` 前后完全一致，行位置无漂移。

所以现在的分工是：

| 状态 | 策略 |
| --- | --- |
| 正文还在流式增长（`[data-state="running"]` / 有 `[data-streaming]` 祖先） | 只给正文根加 `contain: layout`，**不打跳过标记** |
| 正文已落定 | 走 F / G 层的块级 / 步级跳过（这才是收益区） |
| 整行已离屏 | 走 A 层的行级跳过 |

另外顺手修掉一个反向问题：`topUpStreamingChunks`（流式期间给已钉的块补高）在新策略下不再需要，
已整体移除，省掉每帧一次的测量与写样式。

### 行高必须是真值

DSH 自己的「当前读到第几行」是拿 `getBoundingClientRect()` 做二分的。
一旦占位高度和真实高度对不上，**跳转、跟随尾巴就会落到错误的行**——画面不对，比掉帧更严重。

0.3.0 因此把行高当成一等公民：

- 离屏行不读布局，直接用**按 `data-chat-flow-key` 记住的历史高度**（WeakMap + localStorage）；
- 可见带才实测一次，且减去 padding / border（`contain-intrinsic-size` 描述的是内容盒）；
- 高度以 0.01px 精度写入 `--sb-h`，避免上千行累积出可见的滚动条漂移；
- `ResizeObserver` 盯着近端行，行高变化时立即纠正。

实测（600 行聊天记录，headless Edge）：标记后 `scrollHeight` **完全不变**，
行位置最大偏差 **9px**，DSH 的二分定位依然命中正确的行。

### 护栏：宁可不动，也不能动错

以下行会被主动跳过，并在 `report().skipReasons` 里说明原因：

| 原因 | 场景 |
| --- | --- |
| `motion` | 行正在折叠 / 展开动画中（`data-chat-motion`）——此时行高在变 |
| `virtualized` | 位于 DSH 已经虚拟化的表面内（轨迹页行不逐个打标记，改用静态规则） |
| `hidden` | 行处于 `hidden` 状态 |
| `streaming` | 思考正文还在流式输出——此时改用 `contain: layout`（见下一节） |
`content-visibility` 只在行**离屏**时生效；行在视口内时没有任何 containment，所以行内的 sticky
折叠头、代码块横幅都能正常工作（实测两种模式的截图与几何完全一致）。真正的风险是**占位高度过期**：
行内容变高（展开思考过程、展开工具输出）后，`--sb-h` 必须跟着更新，否则这行滚出视野再滚回来
时，滚动条会跳一下。0.4.1 起，带 `data-expanded` / `data-open` / `data-chat-motion` / `hidden`
的元素发生变化时，只重新测量**它所在的那一行**，而不是扫描整个对话。

另外 `contenteditable`、`aria-live` 区域、`display: table-*` 的行也一律不标记。

## 优化分层（A–H）

| 层 | 做什么 | 关键点 |
| --- | --- | --- |
| A. 离屏跳过（核心） | 给长列表的直接子行加 `content-visibility: auto` + `contain-intrinsic-size` | 先确定真实行高写入 `--sb-h`，再打标记；不改变可见区域 |
| B. 容器提示 | 给面积最大的最多 8 个滚动容器加 `will-change: scroll-position` | 只加属性，不每帧写 DOM |
| C. 空闲调度 | `requestIdleCallback` 分片扫描，每片约 8ms | 滚动期间暂停扫描/测量，滚动结束后继续 |
| D. 增量维护 | `MutationObserver` 监听 `childList` + 少量关键属性，50ms 去抖 | 新消息到达后只补新增行，不重扫全页 |
| E. 首屏快扫（0.2.0） | 视图挂载后下一帧只标记视口上下 1.5 屏内的行 | 上限 120 行 / 300 次 rect 读，剩下的交给空闲分片 |
| F. 块级跳过（0.5.0） | 长思考正文按直接块子元素加 `content-visibility`，高度先实测再钉 | 只碰 `[data-markdown-variant="compact"]`；只在正文落定后打标记 |
| G. 步级跳过（0.6.0） | PTC 过程组按 step 跳过：一组一个盒子，而不是几十个段落 | 认 `[data-step-process-content][data-chat-flow]` 的直接子节点；组外仍走 F 层兜底 |
| H. 流式 containment（0.6.0） | 正文还在流式增长时只加 `contain: layout` | 不打跳过标记、不钉高，等正文落定再交给 F / G |

扫描顺序是：表面发现 → 候选容器 → 行列表 → 逐行测量/标记。每一步都按空闲时间分片，避免启动时产生长任务。
首屏快扫是例外：它只跑一帧、只碰近端行，用来把「第一次可见帧就已经被优化」从几百毫秒提前到十几毫秒。
0.3.0 另加**批量读写**：一个分片里的行先全部读完、再全部写入，把每行一次布局重算压成每批一次。

## 安装

> 安装后必须**完全退出并重启 DSH**（不是只刷新页面）。插件通过 `package.json` 的
> `dsh.bundle.patch` 和 `dsh.client` 自动挂载；host 端入口是空实现，实际逻辑在 `lib/client.js`。

### 方式一：从 GitHub 直接安装

```powershell
dsh plugin --profile desktop add "github:TWFU-wcy/dsh-scroll-boost"
```

### 方式二：本地目录（开发时）

```powershell
git clone https://github.com/TWFU-wcy/dsh-scroll-boost.git
dsh plugin --profile desktop add ".\dsh-scroll-boost"
```

### 方式三：打包后安装

```powershell
npm pack
dsh plugin --profile desktop add ".\dsh-scroll-boost-0.6.0.tgz"
```

### 方式四：从 Releases 下载

每个版本在 [Releases](https://github.com/TWFU-wcy/dsh-scroll-boost/releases) 都有更新说明，
最新版为 [v0.6.0](https://github.com/TWFU-wcy/dsh-scroll-boost/releases/tag/v0.6.0)。

### 安装后确认

重启后打开任意长会话，在开发者工具 Console 执行：

```js
window.__scrollBoost.report()
```

> 如果 `window.__scrollBoost` 是 `undefined`：先确认已**完全退出并重启 DSH**，而不是只刷新页面。
> 如果 `report().rows` 为 `0`：欢迎页、空会话或很短的消息列表没有可标记的行，这是正常的；
> 打开一个有较长消息列表的会话后再看。

正常应看到类似：

```js
{
  version: "0.6.0",
  enabled: true,
  containers: 1,
  hinted: 1,
  rows: 599,
  marked: 599,
  skipped: 2,
  scans: 1,
  lastScanMs: 103,
  scrolling: false,
  fastPasses: 1,
  fastRows: 27,
  chunks: 42,
  chunkRoots: 1,
  surfaces: [
    { id: "chat-flow", kind: "rows", rows: 600, marked: 599 },
    { id: "conversation-scroll", kind: "hint", rows: 0, marked: 0 }
  ],
  skipReasons: { sticky: 2 },
  pending: false
}
```

> `surfaces` 是 0.3.0 新增的：如果 DSH 改了内部结构，这里能直接看出插件认出了哪些界面、
> 认错了多少行（`marked` 小于 `rows` 的部分通常是被护栏跳过的）。
> `chunks` / `chunkRoots` 是 0.5.0 新增的：展开一条长思考过程后它们应当大于 0，
> 说明跳过已经生效（0.6.0 起 PTC 过程的每个 step 也计入 `chunks`）；如果一直是 0，
> 多半是正文还在流式输出。

## 手动控制

```js
window.__scrollBoost.report();   // 查看统计
window.__scrollBoost.disable();  // 立即恢复 DOM（移除所有标记与样式）
window.__scrollBoost.enable();   // 重新启用
window.__scrollBoost.scanNow();  // 手动触发一次空闲扫描
window.__scrollBoost.destroy();  // 彻底卸载当前实例
```

## 插件简介与图标

DSH 的插件列表从 `locale/<语言>.json` 读取显示文案（`meta.title` / `meta.description`），
缺失时回退到 `package.json` 的 `name` / `description`；图标取自 `package.json` 的 `icon` 字段。

本插件提供 `locale/en.json` 与 `locale/zh.json`，中文界面下显示为「滚动加速」及对应说明。
图标取自 `assets/avatar-180.jpg`（作者头像，180×180，8 KB）；`icon.svg` 仍随包发布，供需要矢量图的场合使用。
修改文案后需要**完全重启 DSH** 才会重新读取。

## 验收建议

在同一个会话、同一滚动位置做 A/B（各 3 次取中位数）：

- 滚动 p95 帧耗时 ≤ 16.7ms，或相对基线改善 ≥ 30%
- Long Task 数量为 0
- CLS = 0（标记前后布局不跳动）
- 同位置截图 diff = 0（画面不变）
- 1000 行列表内存增长 < 50MB

## 已知边界

- **只管 CSS 能管的瓶颈**：如果掉帧来自 React 重渲染、genui 的全文档扫描、轨迹面板全量 `map`，
  本插件不会直接消除；它减少的是浏览器布局/绘制压力。
- **PTC 过程按 step 跳过**：一个 step 就是一个几千像素的盒子，滚到它中间时它必须渲染，
  所以「单步内部」的滚动仍会整块布局；这是 0.6.0 有意选择（步内再切块收益为负，实测更慢）。
- **流式正文只加 `contain: layout`**：正在增长的正文不做跳过，所以流式期间的滚动只有 containment
  的收益，没有离屏跳过的收益；正文落定后才会交给块级 / 步级跳过。这是实测后的取舍
  （流式期间逐块打标记反而慢约 2 倍，见上文数据表）。
- **首屏“优化生效”有延迟（0.2.0 已大幅改善）**：不是首屏渲染变慢，而是标记要等分片跑完。
  0.2.0 的首屏快扫会在视图挂载后的下一帧就标记近端行，实测首次可见行标记从约 200ms 降到约 14ms；
  离屏行仍然由空闲分片慢慢补齐，所以“整页都标记完”仍需要一点时间。
  0.3.0 进一步把变更后的去抖从 300ms 降到 50ms，切到轨迹/会话视图后更快跟上。
- **依赖 DSH 的内部结构**：0.4.0 认的是 `[data-slot="conversation.chat.flow"]`、
  `[data-conversation-scroll]`、`[data-trajectory-scroll]` 这些内部属性。DSH 改版后可能失效——
  但插件会保留通用回退路径，且 `report().surfaces` 能直接看出当前认出了什么。
- **不降低内存和加载时间**：DOM 节点仍在，只是离屏行不参与渲染。
- **特殊布局可能误判**：嵌套行列表、绝对定位虚拟列表、`display: table-*`、sticky/fixed 行会被跳过或只标记部分行。
- **Ctrl+F / 无障碍**：`content-visibility: auto` 的离屏内容仍可被浏览器查找；但极端情况下屏幕阅读器
  对“尚未渲染”的内容行为可能不同，遇到问题可 `disable()`。
- **GPU 内存**：`will-change` 只在最多 8 个最大容器上使用；现代 Chromium 对 `scroll-position` 通常
  不直接建整层，实测净增通常 0–50MB，远低于 8GB 显卡压力。

### 代价：`will-change` 会改变文字抗锯齿

B 层给滚动口加 `will-change: scroll-position`，会把该容器提升为独立合成层。层内的文字因此从
LCD 子像素抗锯齿切换到灰度抗锯齿——几何位置、行高、`scrollHeight` 全都不变，但**同一位置的截图
会差几万个像素**（实测 73926 个，幅度集中在 17–64，无任何位移）。

这是 A/B 两层共同的既有行为，从 0.1.0 起就在；块级跳过（F 层）本身经隔离对照验证是 **diff = 0**。
如果更看重"逐像素一致"而不是滚动帧率，可以只用 A+F 两层：删掉 `applyHints()` 里的容器标记即可。

## 开发与测试

```powershell
cd "D:\Project\dsh-scroll-boost"
npm install
npm test
```

`npm test` 会做语法检查、插件元信息检查（`locale` 字典与 `icon` 约束）、
回归测试（表面识别、护栏跳过、行高真值复用、轨迹页静态规则、思考正文分块、PTC 步级分块、
流式 containment 与流式保护）
和 jsdom 冒烟测试（20 行列表、新增行、disable/enable、cleanup）。

浏览器侧的真实回归（需要本机装有 Edge）：

```powershell
npm run test:browser
```

- `harness-chat.html`：复刻 DSH 聊天页 DOM（`display: contents` 槽位 + 600 行），
  检查首屏标记时机、粘性横幅行是否被跳过、滚动口是否被提示；
- `probe-drift.html`：对比标记前后的每行位置与 `scrollHeight`，
  确认占位高度没有让 DSH 的行定位落到错误的行；
- `probe-traj-plugin.html`：复刻 DSH 轨迹表（2000 行、每帧重建 46 行），
  对比安装前后的每帧耗时、行高与 `scrollHeight`，并核对静态规则是否命中
  普通行、是否避开 turn-start / 边界行 / 请求行 / 折叠行；
- `probe-chunk-plugin.html`：复刻 12 组展开的长思考正文（每组 42 个块），
  对比分块前后的每帧耗时、正文根高度、`scrollHeight`、sticky 头位置，
  并用 `checkVisibility` 确认离屏块真的被跳过、`disable()` 后完全还原；
- `probe-ptc.html`：复刻 PTC 展开态的过程组（默认 4 步，可用 `?steps=40&blocks=70` 放大），
  核对 step 是否逐个打标、内部块是否被放过、`scrollHeight` 与各正文根高度是否零漂移；
- `probe-stream-plugin.html`：复刻正在流式增长的长思考正文（3000 块 / 每帧 1 token），
  对比四种策略（不动 / 逐块 `content-visibility` / 只加 `contain: layout` / 两者都加）的
  每帧耗时与长帧数量，并核对最终截图是否逐像素一致。

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-scroll-boost
```

或先执行 `window.__scrollBoost.destroy()`，再移除插件并重启。

## License

MIT
