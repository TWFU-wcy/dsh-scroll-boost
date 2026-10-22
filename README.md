# dsh-scroll-boost

一个**纯客户端**的 DeepSeek Harness Web GUI 滚动优化插件。

它不卸载插件、不改 React 组件、不改主题，也不降低画面质量：只在空闲时给「真正可滚动容器里的长列表直接子行」加上
`content-visibility: auto`，让浏览器跳过屏幕外行的布局与绘制，从而减少滚动时的合成和重排压力。

> 当前版本：`0.2.0`（新增首屏快扫，Web / Desktop profile 均可用）

[![GitHub](https://img.shields.io/badge/GitHub-TWFU--wcy%2Fdsh--scroll--boost-181717?logo=github)](https://github.com/TWFU-wcy/dsh-scroll-boost)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 解决什么问题

安装 `@changfenhuang/dsh-genui` 等会在 DOM 中生成大量围栏内容的插件后，长会话滚动可能出现掉帧。
根因通常是浏览器仍在对整页 DOM 做布局/绘制，而滚动帧预算只有约 16.7ms。

`dsh-scroll-boost` 的做法是：**只让屏幕外的“行”不参与渲染**，屏幕内的画面完全不变。

## 四层优化

| 层 | 做什么 | 关键点 |
| --- | --- | --- |
| A. 离屏跳过（核心） | 给长列表的直接子行加 `content-visibility: auto` + `contain-intrinsic-size` | 先实测行高写入 `--sb-h`，再打标记；不改变可见区域 |
| B. 容器提示 | 给面积最大的最多 8 个滚动容器加 `will-change: scroll-position` | 只加属性，不每帧写 DOM |
| C. 空闲调度 | `requestIdleCallback` 分片扫描，每片约 8ms | 滚动期间暂停扫描/测量，滚动结束后继续 |
| D. 增量维护 | `MutationObserver` 只监听 `childList`，300ms 去抖 | 新消息到达后只补新增行，不重扫全页 |
| E. 首屏快扫（0.2.0） | 视图挂载后下一帧只标记视口上下 1.5 屏内的行 | 上限 120 行 / 300 次 rect 读，剩下的交给空闲分片 |

扫描顺序是：候选容器 → 行列表 → 逐行测量/标记。每一步都按空闲时间分片，避免启动时产生长任务。
首屏快扫是例外：它只跑一帧、只碰近端行，用来把「第一次可见帧就已经被优化」从几百毫秒提前到十几毫秒。

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
dsh plugin --profile desktop add ".\dsh-scroll-boost-0.2.0.tgz"
```

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
  version: "0.2.0",
  enabled: true,
  containers: 3,
  hinted: 3,
  rows: 120,
  marked: 120,
  skipped: 8,
  scans: 2,
  lastScanMs: 34,
  scrolling: false,
  fastPasses: 1,
  fastRows: 8,
  pending: false
}
```

## 手动控制

```js
window.__scrollBoost.report();   // 查看统计
window.__scrollBoost.disable();  // 立即恢复 DOM（移除所有标记与样式）
window.__scrollBoost.enable();   // 重新启用
window.__scrollBoost.scanNow();  // 手动触发一次空闲扫描
window.__scrollBoost.destroy();  // 彻底卸载当前实例
```

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
- **首屏“优化生效”有延迟（0.2.0 已大幅改善）**：不是首屏渲染变慢，而是标记要等分片跑完。
  0.2.0 的首屏快扫会在视图挂载后的下一帧就标记近端行，实测首次可见行标记从约 200ms 降到约 14ms；
  离屏行仍然由空闲分片慢慢补齐，所以“整页都标记完”仍需要一点时间。
- **不降低内存和加载时间**：DOM 节点仍在，只是离屏行不参与渲染。
- **特殊布局可能误判**：嵌套行列表、绝对定位虚拟列表、`display: table-*`、sticky/fixed 行会被跳过或只标记部分行。
- **Ctrl+F / 无障碍**：`content-visibility: auto` 的离屏内容仍可被浏览器查找；但极端情况下屏幕阅读器
  对“尚未渲染”的内容行为可能不同，遇到问题可 `disable()`。
- **GPU 内存**：`will-change` 只在最多 8 个最大容器上使用；现代 Chromium 对 `scroll-position` 通常
  不直接建整层，实测净增通常 0–50MB，远低于 8GB 显卡压力。

## 开发与测试

```powershell
cd "D:\Project\dsh-scroll-boost"
npm install
npm test
```

`npm test` 会做语法检查并运行 jsdom 冒烟测试（20 行列表、新增行、disable/enable、cleanup）。

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-scroll-boost
```

或先执行 `window.__scrollBoost.destroy()`，再移除插件并重启。

## License

MIT
