/**
 * dsh-scroll-boost - browser half.
 *
 * 0.5.0 is built on four ideas:
 *
 *   1. Surfaces. DSH renders the chat transcript into a slot whose own box is
 *      `display: contents`, so a generic "find the row list" walk never sees
 *      it and the chat page stays unoptimized. The plugin now knows the stable
 *      `data-*` attributes DSH ships and applies a per-surface strategy
 *      instead of guessing.
 *   2. Height truth. A row is only skipped when its real height is known, so
 *      the placeholder always matches the layout and DSH's own scroll maths
 *      (row binary search, tail follow, spacer arithmetic) keeps working.
 *      Surfaces that rebuild their rows every frame cannot carry an attribute,
 *      so they are covered by a static stylesheet rule instead.
 *   3. Chunking. A single expanded reasoning block is one Markdown subtree
 *      that can be tens of thousands of pixels tall. It is always "relevant
 *      to the user", so row-level content-visibility can never skip it, and
 *      every layout pass pays for the whole subtree. Its direct block
 *      children are independent boxes though, so they are pinned to their
 *      real height and skipped one by one.
 *   4. Reversibility. Everything is attributes plus one style element; the
 *      plugin never touches React, the host, or another plugin.
 */
window.__ModuleLoader__.load({
	id: "dsh-scroll-boost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		//#region constants
		const VERSION = "0.8.0";
		const STATE_KEY = "__scrollBoost";
		const STYLE_ID = "dsh-scroll-boost-style";
		const ROW_ATTR = "data-scrollboost-row";
		const CHUNK_ATTR = "data-scrollboost-chunk";
		const CONTAINER_ATTR = "data-scrollboost-container";
		const SCOPE_ATTR = "data-scrollboost-scope";
		const EXCLUDED_ATTR = "data-scrollboost-excluded";
		const ROW_HEIGHT_VAR = "--sb-h";
		const ROW_HEIGHT_PIN = "contain-intrinsic-size";
		const HEIGHT_CACHE_KEY = "dsh-scroll-boost.heights.v1";
		const HEIGHT_CACHE_LIMIT = 4000;
		const CHUNK_CACHE_KEY = "dsh-scroll-boost.chunks.v1";
		const CHUNK_CACHE_LIMIT = 2000;
		const EXCLUDE_KEY = "dsh-scroll-boost.excluded.v1";
		// Surfaces switched off *by kind*. Separate from the per-container list:
		// a kind has no container to key on, and it has to keep working on a page
		// the user has not opened yet.
		const EXCLUDE_KIND_KEY = "dsh-scroll-boost.excludedKinds.v1";

		const SCROLL_IDLE_MS = 120;
		const MUTATION_DEBOUNCE_MS = 50;
		const IDLE_TIMEOUT_MS = 200;
		const SLICE_BUDGET_MS = 8;
		const MAX_ROWS_PER_SLICE = 60;
		const MAX_CANDIDATES = 16;
		const MAX_ROW_CONTAINERS = 16;
		const MAX_HINT_CONTAINERS = 8;
		const FIND_ROWS_MAX_DEPTH = 5;
		const FIND_ROWS_MAX_VISITS = 600;
		const ROW_LIST_MIN_CHILDREN = 3;
		const ROW_LIST_MIN_HEIGHT_RATIO = 1.5;
		// How far past its own client box a container must overflow before it
		// counts as scrollable. One value for every probe: the fast pass, the
		// overflow sweep and the general walk used to disagree, so a container
		// that overflowed by 5-80px was found by one path and missed by another.
		const SCROLL_OVERFLOW_SLACK = 4;
		const OVERFLOW_SCAN_LIMIT = 1500;
		// How many elements the settings page's on-demand sweep will look at. The
		// page runs it synchronously, so it has to stay bounded.
		const DISCOVERY_SCAN_LIMIT = 4000;
		const FAST_PASS_MAX_CANDIDATES = 12;
		const FAST_PASS_MAX_ROWS = 120;
		const FAST_PASS_MAX_READS = 300;
		const FAST_PASS_BAND_RATIO = 1.5;
		const FAST_PASS_MIN_INTERVAL_MS = 120;
		const PERSIST_DEBOUNCE_MS = 2000;
		const MAX_OBSERVED_ROWS = 200;
		const MAX_CHUNK_ROOTS = 24;
		const MAX_CHUNKS_PER_SLICE = 60;
		const MAX_CHUNK_BATCH = 24;
		const CHUNK_MIN_UNITS = 2;
		const CHUNK_MIN_HEIGHT_RATIO = 1.5;

		const SKIP_TAGS = new Set([
			"SCRIPT", "STYLE", "LINK", "META", "BR", "HR",
			"TEXTAREA", "INPUT", "SELECT", "OPTION",
			"SVG", "CANVAS", "VIDEO", "AUDIO", "IFRAME",
			"PRE", "CODE", "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TD", "TH"
		]);

		// Attributes that identify a stable row across re-renders. The first
		// one that exists is used as the height-cache key.
		const HEIGHT_KEY_ATTRS = [
			"data-chat-flow-key",
			"data-chat-anchor-key",
			"data-chat-node-key",
			"data-chat-group-key"
		];

		// DSH surfaces, ordered by priority.
		//   rows   - direct children of the element are the rows to skip
		//   hint   - only a compositor hint on the scroll port
		//   static - the surface rebuilds its rows on every frame, so a
		//            per-row attribute would be wiped before it is ever
		//            painted. A static stylesheet rule is used instead; the
		//            surface still gets the scroll hint so idle work pauses.
		//
		// `label` and `note` are the settings page's vocabulary for these, in the
		// two shipped languages. They describe what the plugin *can* do on a
		// surface, which is what the catalogue section lists whether or not the
		// page happens to be open right now.
		const SURFACE_DEFS = [
			{
				id: "chat-flow",
				kind: "rows",
				selector: '[data-slot="conversation.chat.flow"]',
				priority: 100,
				label: { zh: "聊天记录", en: "Chat transcript" },
				note: {
					zh: "几百轮之后所有消息仍在页面里。插件让屏幕外的消息不参与布局和绘制，这是收益最大的一处。",
					en: "After hundreds of turns every message is still in the page. Offscreen ones stop being laid out and painted; this is the biggest win."
				}
			},
			{
				id: "conversation-scroll",
				kind: "hint",
				selector: "[data-conversation-scroll]",
				priority: 90,
				label: { zh: "会话滚动区", en: "Conversation scroll port" },
				note: {
					zh: "真正的滚动容器。插件提示浏览器把它单独提升一层，滚动时少做一次合成。",
					en: "The real scroll container. The browser is told to promote it to its own layer, so a scroll costs one compositing pass less."
				}
			},
			{
				id: "trajectory",
				kind: "static",
				selector: "[data-trajectory-scroll]",
				priority: 80,
				label: { zh: "轨迹面板", en: "Trajectory panel" },
				note: {
					zh: "每轮几十条记录、带富文本的长表格。插件跳过屏幕外的内容单元格。",
					en: "A long table with dozens of records per turn and rich text. Offscreen content cells are skipped."
				}
			},
			{
				id: "summary-region",
				kind: "hint",
				selector: "[data-summary-scroll-region]",
				priority: 70,
				label: { zh: "摘要预览", en: "Summary preview" },
				note: {
					zh: "短预览框。不做跳过，只用来在滚动它时让后台工作暂停。",
					en: "A short preview box. Nothing to skip; recognised so background work pauses while it is scrolled."
				}
			},
			// Panel-internal scroll ports. These are not row lists - each one holds
			// a bounded form or preview box (`max-height` + `overflow-y: auto`), so
			// there is nothing to skip row by row. They still benefit from the
			// scroll hint and, more importantly, they are surfaces the idle scanner
			// must pause on: without them a long approval card scrolled inside a
			// message counted as "not scrolling" and kept the scan running.
			//
			// The document zoom viewport is deliberately NOT in this list: it is a
			// zoom transform target, and a compositor hint there changes how the
			// document is rasterized while scaled.
			{
				id: "composer-input",
				kind: "hint",
				selector: "[data-input-scroll]",
				priority: 60,
				label: { zh: "输入框", en: "Composer" },
				note: {
					zh: "输入框内部的滚动口。没有行可跳，认出来是为了滚动它时暂停后台扫描。",
					en: "The composer's inner scroll port. No rows to skip; recognised so a scroll pauses background scanning."
				}
			},
			{
				id: "approval-panel",
				kind: "hint",
				selector: "[data-approval-scroll]",
				priority: 55,
				label: { zh: "审批面板", en: "Approval panel" },
				note: {
					zh: "审批卡片内部滚动口。同上。",
					en: "The approval card's inner scroll port. Same as the composer."
				}
			},
			{
				id: "question-panel",
				kind: "hint",
				selector: "[data-question-scroll]",
				priority: 50,
				label: { zh: "提问面板", en: "Question panel" },
				note: {
					zh: "向用户提问时的内部滚动口。同上。",
					en: "The question panel's inner scroll port. Same again."
				}
			}
		];

		const CANDIDATE_SELECTOR = [
			"main",
			'[role="main"]',
			"aside",
			'[role="complementary"]',
			'[class*="scroll"]',
			'[class*="Scroll"]',
			"[data-scroll]",
			"[data-scrollable]"
		].join(",");

		// Surfaces that rebuild their rows on every frame cannot carry a JS
		// attribute: the node is replaced before the frame is painted. They are
		// optimized by a static stylesheet rule instead, which the browser
		// applies during its own style pass for zero main-thread cost.
		//
		// Only the content cell is targeted:
		//   * the event cell holds absolutely positioned rails and the request
		//     boundary control that overflow their box on purpose - paint
		//     containment would clip them;
		//   * turn-start rows paint a 1px separator above their own top edge,
		//     so they are left fully rendered;
		//   * rows with a non-standard height (9px request boundaries, 0px
		//     request-only rows, 24px collapsed summaries) are left alone as
		//     well: their intrinsic placeholder would be wrong until they have
		//     been rendered once, and the scrollbar would drift.
		const STATIC_ROW_SELECTOR = [
			"[data-trajectory-scroll] tbody tr[data-record-index]" +
			":not([data-turn-start])" +
			":not([data-terminal-request-boundary])" +
			":not([data-request-only])" +
			":not([data-collapsed-summary])" +
			" > td:last-child"
		].join(",");

		// The body of an expanded reasoning block. `data-markdown-variant` is
		// only emitted for the compact variant, and the reasoning body is the
		// only place DSH renders Markdown that way, so this attribute pins the
		// surface without depending on a hashed class name.
		const CHUNK_ROOT_SELECTOR = '[data-markdown-variant="compact"]';
		// An expanded process (PTC) group lays its steps straight into the chat
		// flow, one flow item per step. Those steps are the coarse boxes that
		// are worth skipping; see the note above the chunking region.
		const CHUNK_STEP_CONTAINER = '[data-step-process-content][data-chat-flow]';

		const STYLE_TEXT = [
			"[" + ROW_ATTR + "] {",
			"  content-visibility: auto;",
			"  contain-intrinsic-size: auto 200px;",
			"}",
			"[" + CONTAINER_ATTR + "] {",
			"  will-change: scroll-position;",
			"}",
			// DSH's trajectory table replaces its rows on every scroll frame, so
			// an attribute written by JS is gone before the frame is painted.
			// A static rule is the only technique that survives: it lands with
			// the first style recalculation and costs no main-thread work.
			//
			// Only the content cell is skipped. The event cell carries
			// absolutely positioned rails and the request-boundary control that
			// deliberately overflow their box, and paint containment would clip
			// them. Turn-start rows are excluded for the same reason: they draw
			// a 1px separator above their own top edge.
			STATIC_ROW_SELECTOR + " {",
			"  content-visibility: auto;",
			"  contain-intrinsic-size: auto 30px;",
			"}",
			// A step of a long expanded reasoning process. The placeholder is a
			// literal written straight onto the element: resolving a var() for
			// every skipped box on every style recalculation costs about six
			// times more than reading a literal (measured, see README).
			"[" + CHUNK_ATTR + "] {",
			"  content-visibility: auto;",
			"  contain-intrinsic-size: auto 120px;",
			"}",
			// A reasoning body that is still receiving tokens must NOT be
			// pinned block by block: every token would tear down and rebuild
			// the containment of every skipped box, which measured 2.4x
			// slower than doing nothing (5.2ms vs 2.2ms per token on a 3000
			// block body). What does help is confining the layout of the body
			// to itself, so a token does not invalidate the transcript around
			// it: 1.6ms vs 2.2ms, and no pixels change.
			CHUNK_ROOT_SELECTOR + " {",
			"  contain: layout;",
			"}"
		].join("\n");
		//#endregion

		//#region state
		let state = null;

		function now() {
			return typeof performance !== "undefined" && typeof performance.now === "function"
				? performance.now()
				: Date.now();
		}

		function viewportHeight() {
			return window.innerHeight || document.documentElement.clientHeight || 800;
		}

		function isElement(node) {
			return !!node && node.nodeType === 1;
		}

		function isConnected(el) {
			if (!isElement(el)) return false;
			if (typeof el.isConnected === "boolean") return el.isConnected;
			return document.documentElement.contains(el);
		}

		function rectArea(el) {
			try {
				const rect = el.getBoundingClientRect();
				return Math.max(0, rect.width) * Math.max(0, rect.height);
			} catch (_) {
				return 0;
			}
		}

		function isUsable(el) {
			if (!isElement(el) || !isConnected(el)) return false;
			try {
				const rect = el.getBoundingClientRect();
				return rect.width > 0 && rect.height > 0;
			} catch (_) {
				return false;
			}
		}

		// Only scroll containers should own rows. A non-scrolling <main> or
		// <aside> is usually a layout region; marking its direct children would
		// apply content-visibility to layout boxes, which is not what we want.
		function isScrollContainer(el) {
			if (!isElement(el) || !isConnected(el)) return false;
			try {
				if (!(el.clientHeight > 0) || !(el.scrollHeight > el.clientHeight + SCROLL_OVERFLOW_SLACK)) return false;
			} catch (_) {
				return false;
			}

			if (el.hasAttribute("data-scroll") || el.hasAttribute("data-scrollable")) return true;

			let cs;
			try {
				cs = getComputedStyle(el);
			} catch (_) {
				return false;
			}
			if (!cs) return false;
			const oy = cs.overflowY;
			const ov = cs.overflow;
			return oy === "auto" || oy === "scroll" || oy === "overlay" ||
				ov === "auto" || ov === "scroll" || ov === "overlay";
		}

		// The row counters describe what is in the DOM right now. They are
		// reset whenever the DOM is restored, so report() never claims rows
		// that are no longer marked.
		function resetRowStats() {
			if (!state) return;
			state.stats.rows = 0;
			state.stats.skipped = 0;
			state.stats.cachedRows = 0;
			state.stats.chunks = 0;
			state.stats.chunkRoots = 0;
			state.stats.skipReasons = {};
		}

		function createState() {
			return {
				version: VERSION,
				enabled: true,
				disposed: false,
				styleEl: null,
				observer: null,
				mutationTimer: null,
				idleHandle: null,
				idleKind: null,
				scanScheduled: false,
				scanWork: null,
				containers: new Map(),
				surfaces: new Map(),
				heightCache: new Map(),
				chunkCache: new Map(),
				weakHeights: new WeakMap(),
				chunkRoots: new Map(),
				cacheLoaded: false,
				cacheDirty: false,
				persistTimer: null,
				resizeObserver: null,
				observedRows: new Set(),
				fastQueue: new Set(),
				fastHandle: null,
				fastKind: null,
				lastFastPassAt: 0,
				lastScrollAt: 0,
				pagehideHandler: null,
				pageshowHandler: null,
				pixelSafe: false,
				// Containers the user asked the plugin to leave alone, and the
				// live container -> key map used to resolve them. See the
				// exclusions region.
				excluded: new Set(),
				excludedKinds: new Set(),
				scopeKeys: new Map(),
				scopeListeners: new Set(),
				stats: {
					scans: 0,
					containers: 0,
					hinted: 0,
					rows: 0,
					skipped: 0,
					fastPasses: 0,
					fastRows: 0,
					cachedRows: 0,
					chunks: 0,
					chunkRoots: 0,
					lastScanMs: 0,
					lastScanAt: 0,
					surfaces: 0,
					skipReasons: {}
				}
			};
		}
		//#endregion

		//#region lifecycle
		function injectStyle() {
			if (!state) return;
			if (state.styleEl && state.styleEl.isConnected) return;

			let el = document.getElementById(STYLE_ID);
			if (!el) {
				el = document.createElement("style");
				el.id = STYLE_ID;
				el.dataset.plugin = "dsh-scroll-boost";
				el.textContent = STYLE_TEXT;
				(document.head || document.documentElement).appendChild(el);
			}
			state.styleEl = el;
		}

		function start() {
			if (!state || state.disposed) return;
			state.enabled = true;
			injectStyle();
			// stop() disconnects both observers, and enable() runs start() again.
			// Rebuilding them here is what lets a resumed instance keep correcting
			// pinned heights instead of silently drifting.
			setupResizeObserver();
			setupObserver();
			// First pass: walk the DOM synchronously but only the cheap parts
			// (surface discovery, candidate collection). Marking visible rows
			// immediately is what removes the first-screen delay; heavy overflow
			// detection and offscreen marking stay idle-sliced.
			scheduleScan("start");
			scheduleFastPass();
		}

		// A bfcache hide is not a teardown: the DOM, the marks and the height
		// cache all survive, and the page may be restored exactly as it was. Only
		// the scheduling has to stop, otherwise every idle callback would keep
		// running against a frozen page.
		function pause() {
			if (!state || !state.enabled) return;
			state.enabled = false;
			cancelScheduled();
			cancelFastPass();
		}

		function resume() {
			if (!state || state.disposed || state.enabled) return;
			state.enabled = true;
			state.scanWork = null;
			scheduleScan("resume");
			scheduleFastPass();
		}


		function resetHeightCache() {
			if (!state) return;
			state.heightCache.clear();
			state.chunkCache.clear();
			state.weakHeights = new WeakMap();
			state.cacheDirty = false;
			if (state.persistTimer !== null) {
				clearTimeout(state.persistTimer);
				state.persistTimer = null;
			}
			try { window.localStorage.removeItem(HEIGHT_CACHE_KEY); } catch (_) { /* ignore */ }
			try { window.localStorage.removeItem(CHUNK_CACHE_KEY); } catch (_) { /* ignore */ }
		}

		function stop() {
			if (!state) return;
			state.enabled = false;
			cancelScheduled();
			cancelFastPass();

			if (state.mutationTimer !== null) {
				clearTimeout(state.mutationTimer);
				state.mutationTimer = null;
			}
			if (state.persistTimer !== null) {
				clearTimeout(state.persistTimer);
				state.persistTimer = null;
			}
			flushHeightCache();
			if (state.observer) {
				state.observer.disconnect();
				state.observer = null;
			}
			if (state.resizeObserver) {
				try { state.resizeObserver.disconnect(); } catch (_) { /* ignore */ }
				state.resizeObserver = null;
			}
			state.observedRows.clear();

			for (const [el, rec] of state.containers) {
				try {
					el.removeEventListener("scroll", rec.onScroll, { passive: true });
				} catch (_) { /* ignore */ }
				el.removeAttribute(CONTAINER_ATTR);
			}
			state.containers.clear();
			state.surfaces.clear();

			const marked = document.querySelectorAll("[" + ROW_ATTR + "]");
			for (const row of marked) {
				row.removeAttribute(ROW_ATTR);
				row.style.removeProperty(ROW_HEIGHT_VAR);
				row.style.removeProperty(ROW_HEIGHT_PIN);
			}

			for (const entry of state.chunkRoots.values()) unpinChunks(entry);
			state.chunkRoots.clear();
			// Belt and braces: a chunk whose root entry was dropped (a React
			// rebuild between two scans) would otherwise keep its placeholder.
			const chunked = document.querySelectorAll("[" + CHUNK_ATTR + "]");
			for (const chunk of chunked) {
				chunk.removeAttribute(CHUNK_ATTR);
				chunk.style.removeProperty("contain-intrinsic-size");
			}

			if (state.styleEl) {
				state.styleEl.remove();
				state.styleEl = null;
			}
			state.scanWork = null;
			// The row counters describe the current DOM, so they have to be
			// cleared together with the attributes. Leaving them behind would
			// make report() claim rows are still marked after a disable().
			resetRowStats();
			state.stats.containers = 0;
			state.stats.hinted = 0;
		}

		function destroy() {
			if (!state) return;
			const old = state;
			stop();
			old.disposed = true;
			if (old.pagehideHandler) {
				window.removeEventListener("pagehide", old.pagehideHandler);
			}
			if (old.pageshowHandler) {
				window.removeEventListener("pageshow", old.pageshowHandler);
			}
			if (window[STATE_KEY] === api) {
				try { delete window[STATE_KEY]; } catch (_) { window[STATE_KEY] = undefined; }
			}
			if (state === old) state = null;
		}
		//#endregion

		//#region scroll detection
		function isScrolling() {
			return !!state && state.lastScrollAt > 0 &&
				(now() - state.lastScrollAt) < SCROLL_IDLE_MS;
		}

		function markScrolling() {
			if (!state) return;
			state.lastScrollAt = now();
		}

		function ensureContainer(el) {
			if (!state) return null;
			let rec = state.containers.get(el);
			if (rec) return rec;

			rec = {
				el,
				rows: new Set(),
				area: rectArea(el),
				hinted: false,
				onScroll: null
			};
			rec.onScroll = () => {
				if (!state || !state.enabled) return;
				markScrolling();
			};
			el.addEventListener("scroll", rec.onScroll, { passive: true });
			state.containers.set(el, rec);
			// Remember which exclusion key this live container answers to, so
			// isExcluded() can resolve a stored key back to a node without
			// walking the document on every write.
			const key = scopeKeyOf(el);
			if (key) state.scopeKeys.set(el, key);
			return rec;
		}

		function pruneContainers() {
			if (!state) return;
			for (const [el, rec] of state.containers) {
				if (isConnected(el)) continue;
				try {
					el.removeEventListener("scroll", rec.onScroll, { passive: true });
				} catch (_) { /* ignore */ }
				state.containers.delete(el);
				state.scopeKeys.delete(el);
			}
		}

		// The compositor hint is the one part of the plugin that changes pixels:
		// promoting a scroll port to its own layer switches its text from LCD
		// subpixel antialiasing to grayscale (geometry, line heights and
		// scrollHeight are untouched - the diff is a few tens of thousands of
		// pixels at low amplitude). It is worth roughly a frame budget on a long
		// transcript, but a user who wants a byte-identical screenshot must be
		// able to turn it off, so it is a setting rather than a constant.
		//
		// An excluded container is skipped here too: an exclusion that still left
		// a compositor layer behind would not be "as if the plugin were absent".
		function applyHints() {
			if (!state) return;
			const live = Array.from(state.containers.values()).filter((rec) =>
				isConnected(rec.el) && !isExcluded(rec.el));
			live.sort((a, b) => rectArea(b.el) - rectArea(a.el));
			const top = state.pixelSafe
				? new Set()
				: new Set(live.slice(0, MAX_HINT_CONTAINERS).map((rec) => rec.el));

			for (const [el, rec] of state.containers) {
				if (top.has(el) && isConnected(el)) {
					if (!el.hasAttribute(CONTAINER_ATTR)) {
						el.setAttribute(CONTAINER_ATTR, "");
					}
					rec.hinted = true;
				} else if (el.hasAttribute(CONTAINER_ATTR)) {
					el.removeAttribute(CONTAINER_ATTR);
					rec.hinted = false;
				}
			}
			state.stats.containers = live.length;
			state.stats.hinted = top.size;
		}
		//#endregion

		//#region height cache
		// The height of a skipped row has to be right, otherwise the scrollbar
		// drifts and DSH's own row lookup lands on the wrong line. Real heights
		// are expensive to read for offscreen rows, so they are remembered per
		// stable row key and reused in later passes and later sessions.
		function readStoredMap(key) {
			const out = new Map();
			try {
				const raw = window.localStorage.getItem(key);
				if (!raw) return out;
				const parsed = JSON.parse(raw);
				if (!parsed || typeof parsed !== "object") return out;
				for (const name of Object.keys(parsed)) {
					const value = parsed[name];
					if (typeof value === "number" && value > 0) out.set(name, value);
				}
			} catch (_) { /* ignore */ }
			return out;
		}

		function loadHeightCache() {
			if (!state || state.cacheLoaded) return;
			state.cacheLoaded = true;
			state.heightCache = readStoredMap(HEIGHT_CACHE_KEY);
			state.chunkCache = readStoredMap(CHUNK_CACHE_KEY);
		}

		function heightKeyOf(row) {
			if (!isElement(row)) return null;
			for (const attr of HEIGHT_KEY_ATTRS) {
				const value = row.getAttribute(attr);
				if (value) return attr + ":" + value;
			}
			return null;
		}

		function cachedHeight(row) {
			const key = heightKeyOf(row);
			if (key) {
				const hit = state.heightCache.get(key);
				if (hit > 0) return hit;
			}
			const weak = state.weakHeights.get(row);
			return weak > 0 ? weak : 0;
		}

		function rememberHeight(row, height) {
			if (!(height > 0)) return;
			state.weakHeights.set(row, height);
			const key = heightKeyOf(row);
			if (!key) return;
			if (Math.abs((state.heightCache.get(key) || 0) - height) < 0.5) return;
			state.heightCache.set(key, height);
			state.cacheDirty = true;
			schedulePersist();
		}

		function schedulePersist() {
			if (!state || state.persistTimer !== null) return;
			state.persistTimer = setTimeout(() => {
				state.persistTimer = null;
				flushHeightCache();
			}, PERSIST_DEBOUNCE_MS);
		}

		function trimCache(map, limit) {
			if (map.size <= limit) return;
			// Map preserves insertion order, so the oldest entries go first.
			const stale = Array.from(map.keys()).slice(0, map.size - limit);
			for (const key of stale) map.delete(key);
		}

		function writeStoredMap(key, map, limit) {
			try {
				trimCache(map, limit);
				window.localStorage.setItem(key, JSON.stringify(Object.fromEntries(map)));
			} catch (_) { /* ignore */ }
		}

		function flushHeightCache() {
			if (!state || !state.cacheDirty) return;
			state.cacheDirty = false;
			writeStoredMap(HEIGHT_CACHE_KEY, state.heightCache, HEIGHT_CACHE_LIMIT);
			writeStoredMap(CHUNK_CACHE_KEY, state.chunkCache, CHUNK_CACHE_LIMIT);
		}
		//#endregion

		//#region guards
		// A skipped row becomes a containment context, but only while it is
		// actually skipped: an on-screen row renders normally, so a sticky
		// header inside it still sticks (verified with a pixel-identical
		// screenshot and identical geometry). The real hazard is a *stale*
		// placeholder height, handled by refreshRowHeight below.
		function isInSkippedSurface(el) {
			try {
				return el.closest("[data-trajectory-scroll]") !== null;
			} catch (_) {
				return false;
			}
		}

		//#region exclusions
		// Opt-in escape hatch, added in 0.8.0.
		//
		// The plugin finds row lists by shape, and shape cannot tell a transcript
		// from a page of cards whose height depends on what is inside them. When
		// such a page turns out to scroll worse with the plugin than without it,
		// the user needs a way to say "not this page" without uninstalling.
		//
		// The exclusion is scoped to the scroll container. Inside it the plugin
		// writes nothing at all - no row marks, no pinned heights, no compositor
		// hint, no chunk pins - so a page that is excluded behaves exactly as if
		// the plugin were not installed.
		//
		// A container is identified by a stable path of tag names plus a short
		// class signature, not by a generated id: ids differ between renders and
		// would make the exclusion silently stop working after a reload.
		function classSignature(el) {
			const raw = typeof el.className === "string" ? el.className : "";
			const parts = raw.trim().split(/\s+/).filter(Boolean);
			if (!parts.length) return "";
			// Sorted, so a reordered class attribute still matches.
			parts.sort();
			const text = parts.join(".");
			return text.length > 80 ? text.slice(0, 80) : text;
		}

		function scopeKeyOf(el) {
			if (!isElement(el)) return null;
			const chain = [];
			let node = el;
			let depth = 0;
			while (node && node.nodeType === 1 && depth < 12) {
				let part = node.tagName.toLowerCase();
				const sig = classSignature(node);
				if (sig) part += "." + sig;
				chain.unshift(part);
				if (node === document.body) break;
				node = node.parentElement;
				depth++;
			}
			const key = chain.join(" > ");
			return key.length > 400 ? key.slice(-400) : key;
		}

		function loadExclusions() {
			const out = new Set();
			try {
				const raw = window.localStorage.getItem(EXCLUDE_KEY);
				if (!raw) return out;
				const parsed = JSON.parse(raw);
				if (Array.isArray(parsed)) {
					for (const item of parsed) {
						if (typeof item === "string" && item) out.add(item);
					}
				}
			} catch (_) { /* ignore */ }
			return out;
		}

		function saveExclusions() {
			if (!state) return;
			try {
				window.localStorage.setItem(EXCLUDE_KEY, JSON.stringify(Array.from(state.excluded)));
			} catch (_) { /* ignore */ }
		}

		function loadExcludedKinds() {
			const out = new Set();
			try {
				const raw = window.localStorage.getItem(EXCLUDE_KIND_KEY);
				if (!raw) return out;
				const parsed = JSON.parse(raw);
				if (!Array.isArray(parsed)) return out;
				for (const item of parsed) {
					if (typeof item !== "string" || !item) continue;
					// Only ids this build knows: a surface removed in a later version
					// must not linger as a dead switch.
					if (SURFACE_DEFS.some((def) => def.id === item)) out.add(item);
				}
			} catch (_) { /* ignore */ }
			return out;
		}

		function saveExcludedKinds() {
			if (!state) return;
			try {
				window.localStorage.setItem(EXCLUDE_KIND_KEY, JSON.stringify(Array.from(state.excludedKinds)));
			} catch (_) { /* ignore */ }
		}

		// True when this element lives inside a container the user excluded.
		// Checked on every write path, so an exclusion takes effect on the next
		// pass instead of waiting for a reload.
		function isExcluded(el) {
			if (!state || state.excluded.size === 0) return false;
			if (!isElement(el)) return false;
			for (const [container, key] of state.scopeKeys) {
				if (!state.excluded.has(key)) continue;
				if (container === el) return true;
				try {
					if (container.contains(el)) return true;
				} catch (_) { /* ignore */ }
			}
			return false;
		}

		// The settings panel lives in React, the work lives out here. Rather than
		// have the panel poll, it subscribes: every scope change is pushed to the
		// listeners, which is also what makes two panels agree.
		function notifyScopeChange() {
			if (!state) return;
			for (const listener of Array.from(state.scopeListeners)) {
				try { listener(); } catch (_) { /* a broken panel must not stop the rest */ }
			}
		}

		function subscribeScopes(listener) {
			if (!state || typeof listener !== "function") return () => {};
			state.scopeListeners.add(listener);
			return () => { if (state) state.scopeListeners.delete(listener); };
		}
		//#endregion

		// True when this element sits inside a surface the user switched off by
		// kind. The container-level check below covers a page the user turned off;
		// this one covers a *feature* turned off, which may apply to a surface the
		// generic row path adopted without ever consulting SURFACE_DEFS.
		function insideExcludedKind(el) {
			if (!state || state.excludedKinds.size === 0) return false;
			if (!isElement(el)) return false;
			for (const def of SURFACE_DEFS) {
				if (!state.excludedKinds.has(def.id)) continue;
				try {
					if (el.closest(def.selector) !== null) return true;
				} catch (_) { /* ignore */ }
			}
			return false;
		}

		function guardReason(row) {
			if (!isElement(row)) return "invalid";
			if (row.hasAttribute("hidden")) return "hidden";
			const motion = row.getAttribute("data-chat-motion");
			if (motion === "collapse" || motion === "reveal") return "motion";
			try {
				if (row.querySelector('[data-chat-motion="collapse"],[data-chat-motion="reveal"]')) {
					return "motion";
				}
			} catch (_) { /* ignore */ }
			if (isInSkippedSurface(row)) return "virtualized";
			if (isExcluded(row)) return "excluded";
			if (insideExcludedKind(row)) return "excluded-kind";
			return null;
		}

		function getRowStyle(el) {
			if (!isElement(el)) return null;
			if (SKIP_TAGS.has(el.tagName)) return null;
			if (el.isContentEditable) return null;
			if (el.hasAttribute("aria-live")) return null;

			let cs;
			try {
				cs = getComputedStyle(el);
			} catch (_) {
				return null;
			}
			if (!cs) return null;
			if (cs.display === "none" || cs.visibility === "hidden") return null;
			if (cs.position === "sticky" || cs.position === "fixed") return null;
			if (cs.display === "contents" || cs.display.indexOf("table") === 0) return null;

			// A live region inside a row must stay rendered even while offscreen.
			try {
				if (el.querySelector("[aria-live]")) return null;
			} catch (_) { /* ignore */ }

			return cs;
		}
		//#endregion

		//#region marking
		function contentBoxHeight(height, cs) {
			if (!cs) return height;
			const px = (value) => {
				const n = parseFloat(value);
				return Number.isFinite(n) ? n : 0;
			};
			const inner = height
				- px(cs.paddingTop) - px(cs.paddingBottom)
				- px(cs.borderTopWidth) - px(cs.borderBottomWidth);
			return inner > 0 ? inner : height;
		}

		function measureRow(row, cs) {
			let height = 0;
			try {
				height = row.getBoundingClientRect().height;
			} catch (_) { /* ignore */ }
			if (!(height > 0)) height = row.offsetHeight || 0;
			if (!(height > 0)) return 0;

			// contain-intrinsic-size describes the content box ("inner size").
			// getBoundingClientRect() is the border box, so subtract padding and
			// borders; otherwise every skipped row would be a few pixels too tall
			// and the scrollbar would drift.
			try {
				return contentBoxHeight(height, cs || getComputedStyle(row));
			} catch (_) { /* ignore */ }
			return height;
		}

		function applyRowHeight(row, height) {
			// Keep sub-pixel precision. Rounding every row to whole pixels
			// loses up to 0.5px per row, which over a thousand rows is a visible
			// scrollbar drift and makes DSH's own row lookup land off by a line.
			const rounded = Math.round(height * 100) / 100;
			const value = "auto " + rounded + "px";
			// A literal on the element, not a var(): resolving a custom property
			// for every skipped box on every style recalculation costs about six
			// times more than reading a literal (the same mechanism measured on
			// the chunk path). The variable is still written so report() and a
			// human inspecting a row can read the height back.
			row.style.setProperty(ROW_HEIGHT_VAR, rounded + "px");
			if (row.style.getPropertyValue(ROW_HEIGHT_PIN) !== value) {
				row.style.setProperty(ROW_HEIGHT_PIN, value);
			}
		}

		/**
		 * Mark a batch of rows without interleaving reads and writes.
		 *
		 * Every height read forces a layout, and every attribute write
		 * invalidates it. Doing read/write/read/write per row makes the
		 * browser recompute the whole document for every single row, which is
		 * exactly the long task this plugin is supposed to remove. So the batch
		 * is measured first and written afterwards: one layout pass per batch.
		 */
		function applyBatch(items) {
			if (!state || !items.length) return 0;

			const prepared = [];
			for (const item of items) {
				const row = item.row;
				if (!isElement(row) || !isConnected(row)) continue;
				if (row.hasAttribute(ROW_ATTR)) {
					if (item.rec) item.rec.rows.add(row);
					continue;
				}

				const reason = guardReason(row);
				if (reason) {
					state.stats.skipped++;
					state.stats.skipReasons[reason] = (state.stats.skipReasons[reason] || 0) + 1;
					continue;
				}

				const cs = getRowStyle(row);
				if (!cs) {
					state.stats.skipped++;
					continue;
				}

				let height = 0;
				let fromCache = false;
				if (item.height > 0) {
					height = item.height;
				} else {
					const cached = cachedHeight(row);
					if (cached > 0) {
						height = cached;
						fromCache = true;
					} else {
						height = measureRow(row, cs);
					}
				}
				if (!(height > 0)) {
					state.stats.skipped++;
					continue;
				}
				prepared.push({ row, rec: item.rec, height, fromCache });
			}

			for (const item of prepared) {
				applyRowHeight(item.row, item.height);
				item.row.setAttribute(ROW_ATTR, "");
				if (item.fromCache) state.stats.cachedRows++;
				else rememberHeight(item.row, item.height);
				if (item.rec) item.rec.rows.add(item.row);
				observeRow(item.row);
			}
			return prepared.length;
		}

		function unmarkRow(row) {
			if (!isElement(row)) return;
			row.removeAttribute(ROW_ATTR);
			row.style.removeProperty(ROW_HEIGHT_VAR);
			row.style.removeProperty(ROW_HEIGHT_PIN);
			state.observedRows.delete(row);
		}

		function observeRow(row) {
			if (!state || !state.resizeObserver) return;
			if (state.observedRows.has(row)) return;
			if (state.observedRows.size >= MAX_OBSERVED_ROWS) return;
			try {
				state.resizeObserver.observe(row);
				state.observedRows.add(row);
			} catch (_) { /* ignore */ }
		}

		function setupResizeObserver() {
			if (!state || state.resizeObserver) return;
			if (typeof ResizeObserver !== "function") return;
			state.resizeObserver = new ResizeObserver((entries) => {
				if (!state || !state.enabled) return;
				for (const entry of entries) {
					const target = entry.target;
					if (!isElement(target)) continue;
					// Answer from the entry, never from the element. `contentRect` is
					// already the content box - the same box contain-intrinsic-size
					// describes - so nothing needs measuring. This matters because
					// the callback fires for EVERY observed box on EVERY width
					// change: dragging the conversation width resizes all of them in
					// one frame, and a getBoundingClientRect() in here is a forced
					// synchronous layout each time. Measured on 600 rows with 200
					// observed: 390 rect reads per frame while dragging, 0 without
					// the plugin. The entry needs none of them.
					//
					// This is also the whole answer to "does a width change make the
					// cached heights wrong?". It does, for the rows that reflowed -
					// and they report it here, one entry each. A window-level resize
					// listener is not needed: it would fire once for the whole
					// document and would have to guess which rows moved.
					const inner = entry.contentRect ? entry.contentRect.height : 0;
					if (!(inner > 0)) continue;
					if (target.hasAttribute(CHUNK_ATTR)) {
						// A chunk that is currently rendered reports its real
						// box; keep the placeholder in step with it.
						applyChunkHeight(target, inner);
						continue;
					}
					if (!target.hasAttribute(ROW_ATTR)) continue;
					// A width-only resize still reports, and the height is then
					// unchanged. Writing the same value back would dirty style for
					// nothing, so compare first. Half a pixel is the tolerance:
					// sub-pixel reflow noise must not read as a real change.
					const current = parseFloat(target.style.getPropertyValue(ROW_HEIGHT_VAR));
					if (Number.isFinite(current) && Math.abs(current - inner) < 0.5) continue;
					applyRowHeight(target, inner);
					rememberHeight(target, inner);
				}
			});
		}
		//#endregion

		//#region chunking
		// A long expanded reasoning block is a single Markdown subtree that is
		// taller than the viewport, so it is always "relevant to the user" and
		// row-level content-visibility can never skip it. Every layout pass then
		// pays for thousands of nodes.
		//
		// The coarse boxes worth skipping are the steps of an expanded process
		// (PTC) group: the group lays its steps straight into the chat flow, so
		// every step is a plain box in the scroll container. Marking one box per
		// step is far cheaper than marking the dozens of Markdown blocks inside
		// it, because the browser pays per skipped box, not per skipped node
		// (measured on a 40-step group: 70 blocks per step costs 3.7ms per
		// layout pass, one box per step costs 0.2ms).
		//
		// A long reasoning body that is not part of a process group has no such
		// coarse box, so its Markdown blocks are the fallback.
		//
		// The placeholder is always a real measurement. `contain-intrinsic-size`
		// describes the content box, so padding and borders are subtracted; a
		// placeholder that is off by a few pixels per box would shift the rest
		// of the transcript. The height is written as a literal instead of going
		// through a custom property, because resolving a var() for every skipped
		// box on every style recalculation is about six times more expensive.
		function isChunkable(el) {
			if (!isElement(el) || !isConnected(el)) return false;
			if (SKIP_TAGS.has(el.tagName)) return false;
			if (el.isContentEditable) return false;
			if (el.hasAttribute(CHUNK_ATTR)) return false;
			if (isExcluded(el)) return false;
			if (insideExcludedKind(el)) return false;

			let cs;
			try {
				cs = getComputedStyle(el);
			} catch (_) {
				return false;
			}
			if (!cs) return false;
			if (cs.display === "none" || cs.display === "contents") return false;
			if (cs.display.indexOf("inline") === 0) return false;
			if (cs.display.indexOf("table") === 0) return false;
			if (cs.position === "sticky" || cs.position === "fixed") return false;
			try {
				if (el.querySelector("[aria-live]")) return false;
			} catch (_) { /* ignore */ }
			return cs;
		}

		function applyChunkHeight(chunk, height) {
			const rounded = Math.round(height * 100) / 100;
			const value = "auto " + rounded + "px";
			if (chunk.style.getPropertyValue("contain-intrinsic-size") !== value) {
				chunk.style.setProperty("contain-intrinsic-size", value);
			}
		}

		// A chunk has no stable key of its own - it is a Markdown block whose
		// identity lives in the outline of its root. The key is therefore "root
		// key + index of the child inside that root", which survives a React
		// rebuild of the body as long as the outline is the same. Nothing is
		// cached when the root has no key: an index alone would collide across
		// every reasoning body on the page.
		function childIndexWithin(parent, node) {
			let index = 0;
			for (const sibling of parent.children) {
				if (sibling === node) return index;
				index++;
			}
			return -1;
		}

		function chunkCacheKey(chunk) {
			// The chunk itself often carries the key: a PTC group lays its steps
			// straight into the flow and every step is one.
			const own = heightKeyOf(chunk);
			if (own) return "c:" + own;
			// Otherwise anchor on the nearest ancestor that has a stable key and
			// append the index path down to the block. That survives a rebuild of
			// the body as long as its outline is unchanged, and two reasoning
			// bodies in the same turn cannot collide.
			let anchor = chunk.parentElement;
			let guard = 0;
			while (anchor && guard++ < 6) {
				const anchorKey = heightKeyOf(anchor);
				if (anchorKey) {
					const path = [];
					let node = chunk;
					while (node && node !== anchor && path.length < 6) {
						const index = childIndexWithin(node.parentElement, node);
						if (index < 0) return null;
						path.unshift(String(index));
						node = node.parentElement;
					}
					return "c:" + anchorKey + "/" + path.join(".");
				}
				anchor = anchor.parentElement;
			}
			return null;
		}

		function measureChunk(chunk) {
			const cs = isChunkable(chunk);
			if (!cs) return 0;
			const key = chunkCacheKey(chunk);
			if (key) {
				const hit = state.chunkCache.get(key);
				if (hit > 0) {
					// The body was rendered at this height in an earlier pass or an
					// earlier session. Reuse it: reading layout for a box that is
					// already offscreen only returns its own placeholder anyway.
					return hit;
				}
			}
			let height = 0;
			try {
				height = chunk.getBoundingClientRect().height;
			} catch (_) { /* ignore */ }
			if (!(height > 0)) height = chunk.offsetHeight || 0;
			if (!(height > 0)) return 0;
			const inner = contentBoxHeight(height, cs);
			if (key && inner > 0) {
				state.chunkCache.set(key, inner);
				state.cacheDirty = true;
				schedulePersist();
			}
			return inner;
		}

		// True when the body is still receiving tokens. The running marker sits
		// on the reasoning row, which is an ancestor of the Markdown body, so
		// this is a climb rather than a match on the body itself.
		function isStreamingRoot(el) {
			try {
				return !!el.closest('[data-streaming],[data-state="running"]');
			} catch (_) {
				return false;
			}
		}

		// True when this single box is still growing. Only the box that
		// receives the new tokens is unstable; the blocks above it are final.
		// Testing the box itself - and not its ancestors - is what makes a
		// streaming transcript chunkable at all.
		function isGrowingBox(el) {
			if (!isElement(el)) return true;
			if (el.hasAttribute("data-streaming")) return true;
			if (el.getAttribute("data-state") === "running") return true;
			return false;
		}

		// True when any descendant is still receiving tokens. A process step is
		// such a box while its reasoning row runs: pinning it would freeze a
		// height that changes on the next token.
		function isGrowingSubtree(el) {
			try {
				if (el.matches('[data-streaming],[data-state="running"]')) return true;
				return !!el.querySelector('[data-streaming],[data-state="running"]');
			} catch (_) {
				return true;
			}
		}

		// Every direct child that can carry a placeholder.
		//
		// Only a settled body gets here. A body that is still streaming is
		// never pinned: each token would tear down and rebuild the
		// containment of every skipped box, which measured 2.4x slower than
		// leaving the body alone (5.2ms vs 2.2ms per token on a 3000 block
		// body). Its protection is `contain: layout` from the stylesheet,
		// which costs nothing per token and is applied from the first paint.
		function chunkUnitsOf(root, skipGrowingSubtrees) {
			const units = [];
			let kids;
			try {
				kids = Array.from(root.children);
			} catch (_) {
				return units;
			}
			for (const kid of kids) {
				if (!isChunkable(kid)) continue;
				if (isGrowingBox(kid)) continue;
				if (skipGrowingSubtrees && isGrowingSubtree(kid)) continue;
				units.push(kid);
			}
			return units;
		}

		// A box is worth chunking once it is taller than the viewport: below
		// that the row itself already handles the skipping.
		function isWorthChunking(el) {
			let height = 0;
			try {
				height = el.getBoundingClientRect().height;
			} catch (_) { /* ignore */ }
			return height > viewportHeight() * CHUNK_MIN_HEIGHT_RATIO;
		}

		// Distance from the viewport, so the boxes the user is looking at are
		// pinned first. A long transcript can hold far more reasoning bodies
		// than one slice can handle, and marking the ones at the top of the
		// document first would leave the visible ones unoptimised.
		function viewportDistance(el) {
			let rect;
			try {
				rect = el.getBoundingClientRect();
			} catch (_) {
				return Number.MAX_SAFE_INTEGER;
			}
			const vh = viewportHeight();
			if (rect.bottom < 0) return -rect.bottom;
			if (rect.top > vh) return rect.top - vh;
			return 0;
		}

		// Process groups first: one box per step covers the whole group in a
		// handful of pins. The Markdown bodies inside a group are then left
		// alone - an inner skip is wasted work when the outer box already
		// covers it.
		function collectChunkTargets() {
			const roots = [];
			const seen = new Set();

			const push = (root, skipGrowingSubtrees) => {
				if (seen.has(root)) return;
				seen.add(root);
				if (!isElement(root) || !isConnected(root)) return;
				if (isInSkippedSurface(root)) return;
				// A body that is still receiving tokens is protected by
				// `contain: layout` instead; pinning it is a net loss.
				if (isStreamingRoot(root)) return;
				if (!isWorthChunking(root)) return;
				const units = chunkUnitsOf(root, skipGrowingSubtrees);
				const tracked = state.chunkRoots.get(root);
				if (tracked) {
					const missing = units.filter((unit) => !tracked.chunks.has(unit));
					if (!missing.length) return;
					roots.push({ root, units: missing, existing: tracked, distance: viewportDistance(root) });
					return;
				}
				if (units.length < CHUNK_MIN_UNITS) return;
				roots.push({ root, units, distance: viewportDistance(root) });
			};

			let groups = [];
			try {
				groups = Array.from(document.querySelectorAll(CHUNK_STEP_CONTAINER));
			} catch (_) {
				groups = [];
			}
			for (const group of groups) push(group, true);

			let bodies = [];
			try {
				bodies = Array.from(document.querySelectorAll(CHUNK_ROOT_SELECTOR));
			} catch (_) {
				bodies = [];
			}
			for (const body of bodies) {
				try {
					if (body.closest(CHUNK_STEP_CONTAINER)) continue;
				} catch (_) { /* ignore */ }
				push(body, false);
			}

			roots.sort((a, b) => a.distance - b.distance);
			return roots.slice(0, MAX_CHUNK_ROOTS);
		}

		// A body that is still streaming is never pinned, so there is nothing
		// to top up: its protection is the static `contain: layout` rule. The
		// pass that pins it runs once the turn settles and the body stops
		// growing (see the data-state branch in setupObserver).
		function unpinChunks(entry) {
			if (!entry) return;
			for (const chunk of entry.chunks) {
				try {
					chunk.removeAttribute(CHUNK_ATTR);
					const pinned = chunk.style.getPropertyValue("contain-intrinsic-size");
					if (pinned && pinned.indexOf("auto ") === 0) {
						chunk.style.removeProperty("contain-intrinsic-size");
					}
				} catch (_) { /* ignore */ }
			}
			entry.chunks.clear();
		}

		function releaseChunkRoot(root) {
			const entry = state.chunkRoots.get(root);
			if (!entry) return;
			unpinChunks(entry);
			state.chunkRoots.delete(root);
		}

		// Drop the pins of a root whose children changed under us. Re-pinning
		// from the new layout is the only way to keep the placeholders honest.
		function pruneChunkRoots() {
			for (const [root, entry] of state.chunkRoots) {
				if (!isConnected(root)) {
					unpinChunks(entry);
					state.chunkRoots.delete(root);
					continue;
				}
				if (entry.chunks.size === 0) {
					releaseChunkRoot(root);
					continue;
				}
				if (entry.children > root.children.length) {
					releaseChunkRoot(root);
					continue;
				}
				let lost = false;
				for (const chunk of entry.chunks) {
					if (!isConnected(chunk)) { lost = true; break; }
				}
				if (lost) releaseChunkRoot(root);
			}
		}

		function beginChunks(work) {
			pruneChunkRoots();
			const targets = collectChunkTargets();
			if (!targets.length) return false;
			work.chunkTargets = targets;
			work.chunkRootIndex = 0;
			work.chunkUnits = [];
			work.chunkUnitIndex = 0;
			work.chunkBatch = [];
			work.phase = "chunks";
			return true;
		}

		function flushChunkBatch(work) {
			if (!work.chunkBatch.length) return 0;
			for (const [chunk, height] of work.chunkBatch) {
				applyChunkHeight(chunk, height);
				chunk.setAttribute(CHUNK_ATTR, "");
			}
			const written = work.chunkBatch.length;
			work.chunkBatch = [];
			return written;
		}

		// Returns true when every target has been processed. The work done per
		// call is capped so a very long process group cannot monopolise a slice.
		function chunkSlice(work) {
			let written = 0;
			while (written < MAX_CHUNKS_PER_SLICE) {
				if (work.chunkRootIndex >= work.chunkTargets.length) break;

				const target = work.chunkTargets[work.chunkRootIndex];
				const root = target.root;

				if (!work.chunkUnits.length) {
					// The DOM may have moved on between collection and now. A
					// body that started streaming again must not be pinned.
					if (!isConnected(root) || isStreamingRoot(root) || !isWorthChunking(root)) {
						work.chunkRootIndex++;
						continue;
					}
					work.chunkUnits = target.units;
					work.chunkUnitIndex = 0;
				}

				while (
					work.chunkUnitIndex < work.chunkUnits.length &&
					work.chunkBatch.length < MAX_CHUNK_BATCH
				) {
					const chunk = work.chunkUnits[work.chunkUnitIndex++];
					const height = measureChunk(chunk);
					if (height > 0) work.chunkBatch.push([chunk, height]);
				}

				written += flushChunkBatch(work);

				if (work.chunkUnitIndex < work.chunkUnits.length) continue;

				// All units measured and pinned: remember the root so later
				// scans can tell whether React rebuilt it.
				const entry = target.existing || { children: 0, chunks: new Set() };
				for (const chunk of work.chunkUnits) {
					if (chunk.hasAttribute(CHUNK_ATTR)) entry.chunks.add(chunk);
				}
				entry.children = root.children.length;
				if (entry.chunks.size) {
					state.chunkRoots.set(root, entry);
					state.stats.chunkRoots = state.chunkRoots.size;
				}

				work.chunkUnits = [];
				work.chunkUnitIndex = 0;
				work.chunkRootIndex++;
			}

			state.stats.chunks += written;
			return work.chunkRootIndex >= work.chunkTargets.length;
		}
		//#endregion

		//#region surfaces
		function surfaceContainer(el) {
			// DSH's conversation scroll port is stable across releases.
			try {
				const host = el.closest("[data-conversation-scroll]");
				if (host) return host;
			} catch (_) { /* ignore */ }
			return nearestScrollContainer(el);
		}

		function discoverSurfaces() {
			if (!state) return;
			for (const def of SURFACE_DEFS) {
				let found = [];
				try {
					found = Array.from(document.querySelectorAll(def.selector));
				} catch (_) { found = []; }

				for (const el of found) {
					if (!isConnected(el)) continue;
					// A surface switched off by kind is treated as if it were not
					// there: no record, no container, no mark. The user turned off
					// "the trajectory panel" as a feature, not one instance of it.
					if (state.excludedKinds.has(def.id)) {
						const stale = state.surfaces.get(el);
						if (stale) {
							if (stale.container) clearScope(stale.container);
							state.surfaces.delete(el);
						}
						continue;
					}
					let rec = state.surfaces.get(el);
					if (!rec) {
						rec = { id: def.id, kind: def.kind, el, rows: new Set(), container: null };
						state.surfaces.set(el, rec);
					}
					if (def.kind === "hint") {
						rec.container = el;
						ensureContainer(el);
					} else if (def.kind === "static") {
						// The rows are optimized by the stylesheet, but the port
						// still needs scroll tracking: idle work must pause while
						// the user is scrolling this surface.
						rec.container = el;
						ensureContainer(el);
					} else if (def.kind === "rows") {
						rec.container = surfaceContainer(el);
						if (rec.container) ensureContainer(rec.container);
						for (const child of el.children) {
							if (SKIP_TAGS.has(child.tagName)) continue;
							rec.rows.add(child);
						}
					}
				}
			}
			pruneSurfaces();
			state.stats.surfaces = state.surfaces.size;
		}

		// A surface outlives the view that mounted it: switching conversation,
		// opening the trace panel and coming back leaves the old element in the
		// map, holding its own row set. That pins a detached subtree and makes
		// report() count surfaces that no longer exist.
		function pruneSurfaces() {
			for (const [el, rec] of state.surfaces) {
				if (!isConnected(el)) {
					state.surfaces.delete(el);
					continue;
				}
				// React replaced a row (a turn re-rendered, a node was folded
				// away). Keeping the detached node inflates rows and makes a
				// marked count below rows look like a guard problem.
				if (rec.kind !== "rows" || rec.rows.size === 0) continue;
				for (const row of rec.rows) {
					if (!isConnected(row)) rec.rows.delete(row);
				}
			}
		}

		function surfaceRowLists() {
			const out = [];
			if (!state) return out;
			for (const rec of state.surfaces.values()) {
				if (rec.kind !== "rows" || rec.rows.size === 0) continue;
				out.push(rec);
			}
			out.sort((a, b) => b.rows.size - a.rows.size);
			return out;
		}
		//#endregion

		//#region discovery
		// One synchronous pass over the document that reports every place the
		// plugin could speed up, whether or not it is currently doing so.
		//
		// The idle scanner is incremental on purpose: it is background work and
		// must not block. The settings page needs the opposite - a snapshot of the
		// whole document, taken on demand, so a person can see everything at once.
		// This is that snapshot. It is bounded and it never marks anything.
		//
		// It reports three kinds of entry:
		//   * a known DSH surface (chat flow, a panel port, ...) - always found,
		//     even when it currently has no rows worth skipping;
		//   * a generic row list the plugin adopted by shape;
		//   * an excluded container, so a page that was switched off still shows
		//     up with a way back.
		function discoverAll() {
			const out = [];
			if (!state) return out;
			const seen = new Set();

			const push = (el, source, id) => {
				if (!isElement(el) || !isConnected(el)) return;
				const key = state.scopeKeys.get(el) || scopeKeyOf(el);
				if (!key) return;
				state.scopeKeys.set(el, key);
				const existing = out.find((item) => item.key === key);
				if (existing) {
					if (id && existing.surfaces.indexOf(id) === -1) existing.surfaces.push(id);
					return;
				}
				const excluded = state.excluded.has(key);
				const rec = state.containers.get(el);
				let rows = 0;
				if (rec && !excluded) {
					rows = Array.from(rec.rows).filter((row) => row.hasAttribute(ROW_ATTR)).length;
				}
				out.push({
					key,
					tag: el.tagName.toLowerCase(),
					className: typeof el.className === "string" ? el.className : "",
					rows,
					hinted: el.hasAttribute(CONTAINER_ATTR),
					excluded,
					surfaces: id ? [id] : [],
					source,
					area: Math.round(rectArea(el))
				});
				seen.add(el);
			};

			// 1. Known surfaces first: these have a human name already.
			for (const def of SURFACE_DEFS) {
				let found = [];
				try { found = Array.from(document.querySelectorAll(def.selector)); } catch (_) { found = []; }
				for (const el of found) {
					const container = def.kind === "rows" ? (state.surfaces.get(el)?.container || surfaceContainer(el)) : el;
					if (!container) continue;
					push(container, "surface", def.id);
				}
			}

			// 2. Excluded containers, even if the scanner has since dropped them.
			for (const key of state.excluded) {
				if (out.some((item) => item.key === key)) continue;
				let foundEl = null;
				for (const [el, k] of state.scopeKeys) {
					if (k === key && isConnected(el)) { foundEl = el; break; }
				}
				if (foundEl) push(foundEl, "excluded", null);
				else {
					out.push({
						key, tag: "", className: "", rows: 0, hinted: false,
						excluded: true, surfaces: [], source: "stale", area: 0
					});
				}
			}

			// 3. Generic candidates: a bounded sweep for anything that overflows.
			//    This is what makes "detect everything" mean everything, not just
			//    the pages the user happened to visit.
			let all = [];
			try {
				all = Array.from(document.querySelectorAll("div,section,ul,ol,main,aside"));
			} catch (_) { all = []; }
			const limit = Math.min(all.length, DISCOVERY_SCAN_LIMIT);
			for (let i = 0; i < limit; i++) {
				const el = all[i];
				if (seen.has(el)) continue;
				if (!isConnected(el)) continue;
				if (el.clientHeight <= 0) continue;
				if (el.scrollHeight <= el.clientHeight + SCROLL_OVERFLOW_SLACK) continue;
				if (!isScrollContainer(el)) continue;
				const found = findRowList(el);
				if (!found) {
					// A scroll port with nothing row-shaped inside: still worth
					// listing when it is large, because the user asked to see it.
					if (rectArea(el) < 80000) continue;
					push(el, "generic", null);
					continue;
				}
				push(el, "generic", null);
			}

			// Adopted containers the sweep missed (offscreen, zero size right now)
			// are still real; include whatever the scanner is already working on.
			for (const [el] of state.containers) {
				if (seen.has(el) || !isConnected(el)) continue;
				push(el, "adopted", null);
			}

			// Enabled first, then by how much work there is. A disabled page sinks
			// to the bottom where it belongs, but never disappears.
			out.sort((a, b) => {
				if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
				if (a.rows !== b.rows) return b.rows - a.rows;
				return b.area - a.area;
			});
			return out;
		}

		// The catalogue: every surface this plugin knows how to help, with whether
		// it is on this page right now.
		//
		// This answers "what does this plugin actually do?" without making anyone
		// visit each page first. It costs one `querySelector` per surface - about a
		// dozen selector matches and no layout reads - so it can run on every panel
		// open.
		//
		// `present` separates the two things a reader cares about:
		//   true  - this surface exists here and the plugin is (or can be) on it;
		//   false - not on this page; the entry documents what the plugin would do
		//           if you went there.
		function surfaceCatalog() {
			const out = [];
			const working = state ? Array.from(state.surfaces.values()) : [];
			for (const def of SURFACE_DEFS) {
				let count = 0;
				let present = false;
				let excluded = false;
				try {
					const found = Array.from(document.querySelectorAll(def.selector));
					count = found.length;
					present = count > 0;
					if (present && state) {
						for (const el of found) {
							const container = def.kind === "rows"
								? (state.surfaces.get(el)?.container || surfaceContainer(el))
								: el;
							if (!container) continue;
							const key = state.scopeKeys.get(container) || scopeKeyOf(container);
							if (key && state.excluded.has(key)) { excluded = true; break; }
						}
					}
				} catch (_) { /* keep the defaults */ }
				const rec = def.kind === "rows" ? working.find((s) => s.id === def.id) : null;
				const kindOff = state ? state.excludedKinds.has(def.id) : false;
				out.push({
					id: def.id,
					kind: def.kind,
					label: def.label,
					note: def.note,
					present,
					count,
					excluded: excluded || kindOff,
					excludedByKind: kindOff,
					rows: rec ? Array.from(rec.rows).filter((row) => row.hasAttribute(ROW_ATTR)).length : 0
				});
			}
			// What exists here comes first; the rest keep their priority order, so
			// the reader sees what is live before what is merely possible.
			out.sort((a, b) => (a.present === b.present ? 0 : a.present ? -1 : 1));
			return out;
		}
		//#endregion
		function findRowList(root) {
			let best = null;
			let visits = 0;
			const vh = viewportHeight();

			function consider(el, depth) {
				if (!isElement(el) || !isConnected(el)) return;
				if (++visits > FIND_ROWS_MAX_VISITS) return;

				const children = [];
				for (const child of el.children) {
					if (children.length >= FIND_ROWS_MAX_VISITS) break;
					children.push(child);
				}

				let isRowList = false;
				if (children.length >= ROW_LIST_MIN_CHILDREN) {
					// scrollHeight is one layout read and already reflects the whole
					// content; summing every child rect would make a 1000-row list a
					// long task before the first slice even starts.
					let total = 0;
					try {
						total = Math.max(el.scrollHeight || 0, el.getBoundingClientRect().height || 0);
					} catch (_) { /* ignore */ }
					// A `display: contents` slot has no box of its own, so its own
					// scrollHeight is zero. Measure the parent instead - that is
					// exactly how DSH renders the chat transcript.
					if (!(total > 0) && el.parentElement) {
						try {
							total = Math.max(
								el.parentElement.scrollHeight || 0,
								el.parentElement.getBoundingClientRect().height || 0
							);
						} catch (_) { /* ignore */ }
					}
					if (total > vh * ROW_LIST_MIN_HEIGHT_RATIO) {
						isRowList = true;
						const score = children.length * 1000 + Math.min(total, 100000);
						if (!best || score > best.score) {
							best = { el, rows: children, score };
						}
					}
				}

				if (depth >= FIND_ROWS_MAX_DEPTH) return;
				// A wide, tall child list is almost certainly the row list. Do not
				// descend into its rows: a single tall row (e.g. a code block) could
				// otherwise be mistaken for another row list.
				if (isRowList && children.length >= 8) return;

				// Recurse through wrappers even when they have a single child:
				// virtualized lists commonly look like scroll > wrapper > list > rows.
				for (const child of children) {
					if (child.children.length === 0) continue;
					if (isRowList && child.children.length < ROW_LIST_MIN_CHILDREN) continue;
					consider(child, depth + 1);
				}
			}

			consider(root, 0);
			return best;
		}

		function addCandidate(work, el) {
			if (!isUsable(el)) return;
			work.candidateSet.add(el);
			if (!work.candidateAreas.has(el)) {
				work.candidateAreas.set(el, rectArea(el));
			}
			// Deciding scrollability here keeps the check inside the idle slice
			// loop (one element per iteration) instead of a burst at phase end.
			if (!work.scrollableSet.has(el) && isScrollContainer(el)) {
				work.scrollableSet.add(el);
			}
		}

		function createScanWork() {
			const work = {
				phase: "surfaces",
				candidateSet: new Set(),
				candidateAreas: new Map(),
				scrollableSet: new Set(),
				selectorCandidates: [],
				selectorIndex: 0,
				overflowCandidates: [],
				overflowIndex: 0,
				candidates: [],
				candidateIndex: 0,
				records: [],
				seenRows: new Set(),
				seenContainers: new Set(),
				rowQueue: [],
				rowOwner: new Map(),
				queuedRows: new Set(),
				rowIndex: 0,
				surfaceRows: 0,
				usedOverflow: false,
				chunksStarted: false,
				chunkTargets: [],
				chunkRootIndex: 0,
				chunkUnits: [],
				chunkUnitIndex: 0,
				chunkBatch: [],
				startedAt: now()
			};

			// querySelectorAll itself is cheap; the expensive part (layout reads,
			// getComputedStyle, findRowList) is done one item per idle slice below.
			try {
				work.selectorCandidates = Array.from(document.querySelectorAll(CANDIDATE_SELECTOR));
			} catch (_) { /* ignore */ }
			return work;
		}

		function startOverflowSweep(work) {
			work.usedOverflow = true;
			work.phase = "overflow";
			work.overflowIndex = 0;
			if (!work.overflowCandidates.length) {
				try {
					work.overflowCandidates = Array.from(document.querySelectorAll("div,section,ul,ol"))
						.slice(0, OVERFLOW_SCAN_LIMIT);
				} catch (_) { /* ignore */ }
			}
		}

		function finishCandidates(work) {
			work.candidates = Array.from(work.scrollableSet)
				.sort((a, b) => (work.candidateAreas.get(b) || 0) - (work.candidateAreas.get(a) || 0))
				.slice(0, MAX_CANDIDATES);
			work.candidateIndex = 0;

			// The generic "any overflowing div" sweep is by far the most expensive
			// phase: one layout read plus a getComputedStyle per element. When the
			// cheap selector pass already found a scroll container, skip it - a
			// view that just mounted reaches its rows several slices sooner.
			if (work.candidates.length === 0 && !work.usedOverflow && work.surfaceRows === 0) {
				startOverflowSweep(work);
				return;
			}
			work.phase = "rowlists";
		}

		function addRowList(work, candidate) {
			if (!isScrollContainer(candidate)) return;
			const found = findRowList(candidate);
			if (!found || work.seenContainers.has(found.el)) return;

			const rows = found.rows.filter((row) => !work.seenRows.has(row));
			if (rows.length < ROW_LIST_MIN_CHILDREN) return;
			for (const row of rows) work.seenRows.add(row);
			work.seenContainers.add(found.el);
			// The scroll listener and will-change hint belong to the scrollable
			// candidate, not to the inner row list we found inside it.
			work.records.push({ container: candidate, rowList: found.el, rows, area: rectArea(candidate) });
		}

		function finishRowLists(work) {
			work.records.sort((a, b) => b.area - a.area);
			work.records = work.records.slice(0, MAX_ROW_CONTAINERS);
			for (const record of work.records) {
				for (const row of record.rows) {
					if (work.queuedRows.has(row)) continue;
					work.queuedRows.add(row);
					work.rowQueue.push(row);
					work.rowOwner.set(row, record.container);
				}
			}
			work.rowIndex = 0;
			work.phase = "rows";
		}

		function queueSurfaceRows(work) {
			for (const rec of surfaceRowLists()) {
				const container = rec.container || null;
				if (container) ensureContainer(container);
				for (const row of rec.rows) {
					if (work.seenRows.has(row)) continue;
					work.seenRows.add(row);
					work.rowQueue.push(row);
					work.queuedRows.add(row);
					work.rowOwner.set(row, container);
				}
				work.surfaceRows += rec.rows.size;
			}
		}
		//#endregion

		//#region fast first pass
		// The idle scanner is deliberately gentle, which means the first useful
		// marks can arrive a few hundred milliseconds after a view mounts. This
		// pass runs on the next animation frame and only touches rows that are
		// already near the viewport, so the first painted frame is optimized
		// without doing a full scan on the main thread.
		function nearestScrollContainer(el) {
			let node = isElement(el) ? el : (el && el.parentElement);
			let depth = 0;
			while (node && depth < 8) {
				if (isScrollContainer(node)) return node;
				node = node.parentElement;
				depth++;
			}
			return null;
		}

		function collectFastCandidates() {
			let list = [];
			try {
				list = Array.from(document.querySelectorAll(CANDIDATE_SELECTOR));
			} catch (_) { /* ignore */ }

			const scored = [];
			for (const el of list) {
				if (!isUsable(el) || !isScrollContainer(el)) continue;
				scored.push({ el, area: rectArea(el) });
			}

			// DSH's own scroll regions often carry no recognizable class name, so
			// the selector pass can come back empty. Fall back to a bounded overflow
			// probe: layout reads first (cheap, no style resolution) and
			// getComputedStyle only for the few elements that actually overflow.
			if (scored.length === 0) {
				let all = [];
				try {
					all = Array.from(document.querySelectorAll("div,section,ul,ol"));
				} catch (_) { /* ignore */ }
				const limit = Math.min(all.length, OVERFLOW_SCAN_LIMIT);
				for (let i = 0; i < limit; i++) {
					const el = all[i];
					let overflows = false;
					try {
						overflows = el.clientHeight > 0 && el.scrollHeight > el.clientHeight + SCROLL_OVERFLOW_SLACK;
					} catch (_) { overflows = false; }
					if (!overflows) continue;
					if (!isUsable(el) || !isScrollContainer(el)) continue;
					scored.push({ el, area: rectArea(el) });
					if (scored.length >= FAST_PASS_MAX_CANDIDATES) break;
				}
			}

			scored.sort((a, b) => b.area - a.area);
			return scored.slice(0, FAST_PASS_MAX_CANDIDATES).map((item) => item.el);
		}

		function cancelFastPass() {
			if (!state) return;
			if (state.fastHandle !== null) {
				if (state.fastKind === "raf" && typeof window.cancelAnimationFrame === "function") {
					window.cancelAnimationFrame(state.fastHandle);
				} else {
					clearTimeout(state.fastHandle);
				}
			}
			state.fastHandle = null;
			state.fastKind = null;
		}

		function scheduleFastPass(roots) {
			if (!state || !state.enabled || state.disposed) return;
			if (roots) {
				for (const root of roots) {
					if (isElement(root)) state.fastQueue.add(root);
				}
			}
			if (state.fastHandle !== null) return;

			const run = () => {
				if (!state) return;
				state.fastHandle = null;
				state.fastKind = null;
				runFastPass();
			};
			if (typeof window.requestAnimationFrame === "function") {
				state.fastKind = "raf";
				state.fastHandle = window.requestAnimationFrame(run);
			} else {
				state.fastKind = "timeout";
				state.fastHandle = setTimeout(run, 0);
			}
		}

		function inViewportBand(rect, bandTop, bandBottom) {
			return !(rect.bottom < bandBottom || rect.top > bandTop);
		}

		function runFastPass() {
			if (!state || !state.enabled || state.disposed) return;
			if (isScrolling()) {
				scheduleScan("fast-pass-scroll");
				return;
			}

			const vh = viewportHeight();
			const roots = Array.from(state.fastQueue);
			state.fastQueue.clear();

			const items = [];
			let reads = 0;
			const bandTop = vh * FAST_PASS_BAND_RATIO;
			const bandBottom = -vh * 0.5;

			// Known DSH surfaces first: their rows are known without any search.
			for (const rec of surfaceRowLists()) {
				if (items.length >= FAST_PASS_MAX_ROWS || reads >= FAST_PASS_MAX_READS) break;
				const container = rec.container ? ensureContainer(rec.container) : null;
				for (const row of rec.rows) {
					if (items.length >= FAST_PASS_MAX_ROWS || reads >= FAST_PASS_MAX_READS) break;
					if (row.hasAttribute(ROW_ATTR)) {
						if (container) container.rows.add(row);
						continue;
					}
					let rect;
					try {
						rect = row.getBoundingClientRect();
					} catch (_) {
						continue;
					}
					reads++;
					if (!inViewportBand(rect, bandTop, bandBottom)) continue;
					items.push({ row, rec: container });
				}
			}

			// Generic lists: find them the old way, but only when the surfaces
			// did not already cover the page.
			if (items.length < FAST_PASS_MAX_ROWS && reads < FAST_PASS_MAX_READS && surfaceRowLists().length === 0) {
				const targets = roots.length > 0
					? roots.map((root) => nearestScrollContainer(root)).filter(Boolean)
					: collectFastCandidates();

				const seen = new Set();
				for (const target of targets) {
					if (seen.has(target)) continue;
					seen.add(target);
					const found = findRowList(target);
					if (!found) continue;
					const rec = ensureContainer(target);

					for (const row of found.rows) {
						if (items.length >= FAST_PASS_MAX_ROWS || reads >= FAST_PASS_MAX_READS) break;
						if (row.hasAttribute(ROW_ATTR)) {
							if (rec) rec.rows.add(row);
							continue;
						}
						let rect;
						try {
							rect = row.getBoundingClientRect();
						} catch (_) {
							continue;
						}
						reads++;
						if (!inViewportBand(rect, bandTop, bandBottom)) continue;
						items.push({ row, rec });
					}
					if (items.length >= FAST_PASS_MAX_ROWS || reads >= FAST_PASS_MAX_READS) break;
				}
			}

			// Measure everything first, write afterwards: one layout pass for the
			// whole batch instead of one per row.
			const marked = applyBatch(items);

			state.lastFastPassAt = now();
			if (marked > 0) {
				state.stats.fastPasses++;
				state.stats.fastRows += marked;
				applyHints();
			}
			// The gentle pass still needs to run for offscreen rows, hints and
			// overflow-only containers that the fast pass intentionally skipped.
			scheduleScan("fast-pass");
		}
		//#endregion

		//#region idle scheduling
		function cancelScheduled() {
			if (!state) return;
			if (state.idleHandle !== null) {
				if (state.idleKind === "idle" && typeof window.cancelIdleCallback === "function") {
					window.cancelIdleCallback(state.idleHandle);
				} else {
					clearTimeout(state.idleHandle);
				}
			}
			state.idleHandle = null;
			state.idleKind = null;
			state.scanScheduled = false;
		}

		function scheduleScan(reason) {
			if (!state || !state.enabled || state.disposed || state.scanScheduled) return;
			state.scanScheduled = true;

			if (typeof window.requestIdleCallback === "function") {
				state.idleKind = "idle";
				state.idleHandle = window.requestIdleCallback(onIdle, { timeout: IDLE_TIMEOUT_MS });
			} else {
				state.idleKind = "timeout";
				state.idleHandle = setTimeout(() => onIdle(null), 8);
			}
		}

		function onIdle(deadline) {
			if (!state) return;
			state.idleHandle = null;
			state.idleKind = null;
			state.scanScheduled = false;

			if (!state.enabled || state.disposed) return;
			if (isScrolling()) {
				scheduleScan("scroll-pause");
				return;
			}

			try {
				const done = runSlice(deadline);
				if (!done) scheduleScan("continue");
			} catch (err) {
				state.scanWork = null;
				console.warn("[dsh-scroll-boost] scan failed", err);
			}
		}

		function runSlice(deadline) {
			if (!state) return true;
			if (!state.scanWork) state.scanWork = createScanWork();

			const work = state.scanWork;
			const startedAt = now();
			let budget = SLICE_BUDGET_MS;
			if (deadline && typeof deadline.timeRemaining === "function") {
				try {
					budget = Math.min(SLICE_BUDGET_MS, Math.max(1, deadline.timeRemaining()));
				} catch (_) { /* ignore */ }
			}

			while (now() - startedAt < budget && !isScrolling()) {
				if (work.phase === "surfaces") {
					discoverSurfaces();
					queueSurfaceRows(work);
					work.phase = "candidates";
					continue;
				}

				if (work.phase === "candidates") {
					if (work.selectorIndex < work.selectorCandidates.length) {
						addCandidate(work, work.selectorCandidates[work.selectorIndex++]);
						continue;
					}
					finishCandidates(work);
					continue;
				}

				if (work.phase === "overflow") {
					if (work.overflowIndex < work.overflowCandidates.length) {
						const el = work.overflowCandidates[work.overflowIndex++];
						if (!work.candidateSet.has(el) && isUsable(el)) {
							// Read layout first; getComputedStyle is the expensive part.
							if (el.clientHeight > 0 && el.scrollHeight > el.clientHeight + SCROLL_OVERFLOW_SLACK) {
								let cs;
								try { cs = getComputedStyle(el); } catch (_) { cs = null; }
								if (cs) {
									const oy = cs.overflowY;
									const overflow = cs.overflow;
									if (oy === "auto" || oy === "scroll" || overflow === "auto" || overflow === "scroll") {
										addCandidate(work, el);
									}
								}
							}
						}
						continue;
					}
					finishCandidates(work);
					continue;
				}

				if (work.phase === "rowlists") {
					if (work.candidateIndex < work.candidates.length) {
						addRowList(work, work.candidates[work.candidateIndex++]);
						continue;
					}
					finishRowLists(work);
					continue;
				}

				if (work.phase === "rows") {
					if (work.rowIndex < work.rowQueue.length) {
						// Collect a batch, then measure and write it in one go. Reading
						// and writing per row would recompute the document layout for
						// every single row.
						const batch = [];
						while (work.rowIndex < work.rowQueue.length && batch.length < MAX_ROWS_PER_SLICE) {
							const row = work.rowQueue[work.rowIndex++];
							const owner = work.rowOwner.get(row);
							const rec = owner ? ensureContainer(owner) : null;
							batch.push({ row, rec });
						}
						applyBatch(batch);
						continue;
					}

					for (const record of work.records) {
						const rec = ensureContainer(record.container);
						if (!rec) continue;
						rec.area = record.area;
						for (const row of record.rows) rec.rows.add(row);
					}

					pruneContainers();
					applyHints();

					// Long expanded reasoning bodies are chunked after the rows
					// are marked, so the two passes never fight over the same
					// layout read.
					if (!work.chunksStarted) {
						work.chunksStarted = true;
						if (beginChunks(work)) continue;
					}

					state.scanWork = null;
					state.stats.scans++;
					state.stats.rows = work.rowQueue.length;
					state.stats.lastScanMs = Math.round(now() - work.startedAt);
					state.stats.lastScanAt = Date.now();
					return true;
				}

				if (work.phase === "chunks") {
					if (chunkSlice(work)) {
						state.scanWork = null;
						state.stats.scans++;
						state.stats.rows = work.rowQueue.length;
						state.stats.lastScanMs = Math.round(now() - work.startedAt);
						state.stats.lastScanAt = Date.now();
						return true;
					}
					return false;
				}

				break;
			}

			return false;
		}
		//#endregion

		//#region mutation maintenance
		// A marked row whose height changed (a reasoning block expanded, a tool
		// group collapsed) keeps a stale placeholder. Re-measure it while it is
		// still on screen: once it scrolls away the placeholder is all the
		// browser has, and a wrong value shows up as a jump in the scrollbar.
		function refreshRowHeight(row) {
			if (!isElement(row) || !row.hasAttribute(ROW_ATTR)) return;
			let rect;
			try {
				rect = row.getBoundingClientRect();
			} catch (_) {
				return;
			}
			if (!rect || rect.height <= 0) return;
			// Only an on-screen row reports a real height; a skipped one would
			// report its own placeholder and we would freeze the wrong value.
			if (rect.bottom < 0 || rect.top > viewportHeight()) return;
			const cs = getRowStyle(row);
			if (!cs) return;
			const inner = measureRow(row, cs);
			if (!(inner > 0)) return;
			applyRowHeight(row, inner);
			rememberHeight(row, inner);
		}

		function revalidateRow(row) {
			if (!isElement(row) || !row.hasAttribute(ROW_ATTR)) return;
			const reason = guardReason(row);
			if (reason) {
				// The row became unsafe to skip (motion started, hidden).
				unmarkRow(row);
				return;
			}
			refreshRowHeight(row);
		}

		function setupObserver() {
			if (!state || state.observer) return;
			if (typeof MutationObserver !== "function") return;
			const root = document.body || document.documentElement;
			if (!root) return;

			state.observer = new MutationObserver((mutations) => {
				let elementAdded = false;
				let streamOnly = true;
				let chunkReady = false;
				let surfaceRemoved = false;
				const touchedRows = new Set();
				for (const mutation of mutations) {
					if (mutation.type === "attributes") {
						const target = mutation.target;
						if (!isElement(target)) continue;
						// A reasoning body is left alone while it streams, because
						// its text changes on every token and a pinned placeholder
						// would go stale. The moment the turn settles, its body
						// becomes stable and chunkable for the first time - that
						// transition is the only signal we get, so it has to
						// schedule a pass even though no node was added.
						if (mutation.attributeName === "data-state" || mutation.attributeName === "data-streaming") {
							if (!chunkReady) {
								let settled = null;
								try { settled = !target.closest('[data-streaming],[data-state="running"]'); } catch (_) { /* ignore */ }
								if (settled) {
									try {
										if (target.querySelector(CHUNK_ROOT_SELECTOR)) chunkReady = true;
									} catch (_) { /* ignore */ }
								}
							}
						}
						// O(1): only the row that owns this element needs a look.
						// The old code swept every marked row on the page, which
						// turned one fold/unfold into an O(n) pass over the whole
						// transcript.
						let host = null;
						try { host = target.closest("[" + ROW_ATTR + "]"); } catch (_) { /* ignore */ }
						if (host) touchedRows.add(host);
						continue;
					}
					if (elementAdded && !streamOnly) continue;
					for (const node of mutation.addedNodes) {
						if (!isElement(node)) continue;
						// The trajectory table rebuilds its rows every frame and
						// never keeps our attributes, so its churn must not
						// schedule a document scan.
						if (isInSkippedSurface(node)) continue;
						elementAdded = true;
						// Tokens landing in a reasoning body are the one kind of
						// churn a full scan must not answer: the transcript can
						// grow several times a second while the user scrolls.
						// A tail top-up on the roots we already track is enough.
						let inStream = false;
						try {
							const body = node.closest(CHUNK_ROOT_SELECTOR);
							inStream = !!body && isStreamingRoot(body);
						} catch (_) { /* ignore */ }
						if (!inStream) streamOnly = false;
					}
					// A node leaving the document can be an entire surface (the chat
					// flow, a trajectory table). Nothing is added in that case, so
					// without this the stale entry would sit in the map for the rest
					// of the session.
					if (!surfaceRemoved && mutation.removedNodes.length > 0) {
						for (const node of mutation.removedNodes) {
							if (isElement(node)) { surfaceRemoved = true; break; }
						}
					}
				}

				for (const row of touchedRows) revalidateRow(row);

				if (surfaceRemoved && state.surfaces.size > 0) pruneSurfaces();

				if (!elementAdded && !chunkReady && !surfaceRemoved) return;

				// A body that is still streaming needs no work at all: its
				// protection is the static `contain: layout` rule, and pinning
				// blocks while tokens arrive measured 2.4x slower than doing
				// nothing. Wait for the settle signal instead - it is the only
				// moment a long reasoning body becomes pinnable.
				if (streamOnly && !chunkReady) return;

				// A freshly mounted view (for example the trace panel) should get
				// its visible rows marked on the next frame instead of waiting for
				// the gentle idle scan. The trailing edge keeps streaming updates
				// from re-running the pass on every mutation.
				if (state.mutationTimer !== null) clearTimeout(state.mutationTimer);
				state.mutationTimer = setTimeout(() => {
					state.mutationTimer = null;
					if (!state || !state.enabled) return;
					state.scanWork = null;
					scheduleFastPass();
					scheduleScan("mutation");
				}, MUTATION_DEBOUNCE_MS);
			});
			state.observer.observe(root, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ["data-expanded", "data-open", "data-chat-motion", "hidden", "data-state", "data-streaming"]
			});
		}
		//#endregion

		//#region public api
		function report() {
			if (!state) {
				return { version: VERSION, enabled: false, disposed: true };
			}
			let rows = 0;
			try { rows = document.querySelectorAll("[" + ROW_ATTR + "]").length; } catch (_) { /* ignore */ }
			let chunks = 0;
			try { chunks = document.querySelectorAll("[" + CHUNK_ATTR + "]").length; } catch (_) { /* ignore */ }
			const surfaces = [];
			for (const rec of state.surfaces.values()) {
				surfaces.push({
					id: rec.id,
					kind: rec.kind,
					rows: rec.rows.size,
					marked: Array.from(rec.rows).filter((row) => row.hasAttribute(ROW_ATTR)).length
				});
			}
			return {
				version: VERSION,
				enabled: state.enabled,
				containers: state.containers.size,
				hinted: state.stats.hinted,
				rows,
				marked: rows,
				pixelSafe: state.pixelSafe,
				skipped: state.stats.skipped,
				cachedRows: state.stats.cachedRows,
				scans: state.stats.scans,
				lastScanMs: state.stats.lastScanMs,
				lastScanAt: state.stats.lastScanAt,
				scrolling: isScrolling(),
				fastPasses: state.stats.fastPasses,
				fastRows: state.stats.fastRows,
				chunks,
				chunkRoots: state.chunkRoots.size,
				surfaces,
				cacheSize: state.heightCache.size,
				skipReasons: state.stats.skipReasons,
				excluded: Array.from(state.excluded),
				pending: !!state.scanWork || state.scanScheduled || state.fastHandle !== null
			};
		}

		// Every scroll container the plugin is currently working on, with the
		// key that `exclude()` accepts and how much it is doing there. This is
		// the escape hatch's whole interface: a user who finds a page that
		// scrolls worse with the plugin can read this list, spot the page by
		// area and row count, and switch it off without touching any code.
		//
		// An excluded container stays in this list on purpose, carrying
		// `excluded: true` with zero rows. That is what lets one panel both list
		// it as off and offer the way back, in a single place.
		function scopeList() {
			if (!state) return [];
			const out = [];
			for (const [el, rec] of state.containers) {
				if (!isConnected(el)) continue;
				const key = state.scopeKeys.get(el) || scopeKeyOf(el);
				if (!key) continue;
				state.scopeKeys.set(el, key);
				const isOff = state.excluded.has(key);
				const rows = isOff
					? 0
					: Array.from(rec.rows).filter((row) => row.hasAttribute(ROW_ATTR)).length;
				// Which known surface(s) point at this container. The settings page
				// turns these ids into a human name ("聊天记录") instead of showing
				// a CSS selector, which is the difference between a readable page
				// and a wall of class names.
				const surfaces = [];
				for (const surface of state.surfaces.values()) {
					if (surface.container === el) surfaces.push(surface.id);
				}
				out.push({
					key,
					tag: el.tagName.toLowerCase(),
					className: typeof el.className === "string" ? el.className : "",
					rows,
					hinted: el.hasAttribute(CONTAINER_ATTR),
					excluded: isOff,
					surfaces,
					area: Math.round(rectArea(el))
				});
			}
			out.sort((a, b) => b.area - a.area);
			return out;
		}

		// Turn the plugin off inside one scroll container and remember it across
		// reloads. Everything the plugin wrote there is removed on the spot, so
		// the page returns to how it looks without the plugin installed.
		function exclude(target) {
			if (!state) return { ok: false, reason: "disabled" };
			let el = null;
			if (typeof target === "string") {
				for (const [candidate, key] of state.scopeKeys) {
					if (key === target) { el = candidate; break; }
				}
				if (!el) {
					for (const [candidate] of state.containers) {
						const key = scopeKeyOf(candidate);
						if (key && key === target) { el = candidate; break; }
					}
				}
				if (!el) return { ok: false, reason: "unknown-key", key: target };
			} else if (isElement(target)) {
				el = target;
			} else {
				return { ok: false, reason: "bad-target" };
			}
			const key = state.scopeKeys.get(el) || scopeKeyOf(el);
			if (!key) return { ok: false, reason: "no-key" };
			state.scopeKeys.set(el, key);
			state.excluded.add(key);
			saveExclusions();
			clearScope(el);
			applyHints();
			notifyScopeChange();
			return { ok: true, key, excluded: Array.from(state.excluded) };
		}

		// Undo exclude(). The next scan re-adopts the container.
		function include(target) {
			if (!state) return { ok: false, reason: "disabled" };
			const keys = typeof target === "string" ? [target] : Array.from(state.excluded);
			let removed = 0;
			for (const key of keys) {
				if (state.excluded.delete(key)) removed++;
			}
			if (!removed) return { ok: false, reason: "not-excluded" };
			saveExclusions();
			state.scanWork = null;
			cancelScheduled();
			scheduleFastPass();
			scheduleScan("include");
			notifyScopeChange();
			return { ok: true, removed, excluded: Array.from(state.excluded) };
		}

		// Switch a whole surface kind off, or back on. This is the catalogue's
		// switch: it works for a surface that is not on the current page, because
		// it names the feature rather than a container.
		//
		// It removes what is already applied here (so the change is immediate) and
		// is remembered, so the surface stays off on the next page too.
		function excludeKind(id) {
			if (!state) return { ok: false, reason: "disabled" };
			if (typeof id !== "string" || !SURFACE_DEFS.some((def) => def.id === id)) {
				return { ok: false, reason: "unknown-kind", id };
			}
			if (state.excludedKinds.has(id)) return { ok: true, id, already: true };
			state.excludedKinds.add(id);
			saveExcludedKinds();
			// Undo it here and now, rather than waiting for the next scan.
			for (const [el, rec] of Array.from(state.surfaces)) {
				if (rec.id !== id) continue;
				if (rec.container) clearScope(rec.container);
				state.surfaces.delete(el);
			}
			// A container may still be tracked because a *different* surface also
			// pointed at it. Drop the ones that are now empty and have no surface
			// left, or `discoverAll()` keeps reporting work that is no longer done.
			for (const [container, rec] of Array.from(state.containers)) {
				let owned = false;
				for (const surface of state.surfaces.values()) {
					if (surface.container === container) { owned = true; break; }
				}
				if (owned) continue;
				if (rec.rows.size === 0) {
					try { container.removeEventListener("scroll", rec.onScroll, { passive: true }); } catch (_) { /* ignore */ }
					state.containers.delete(container);
					state.scopeKeys.delete(container);
					if (container.hasAttribute(CONTAINER_ATTR)) container.removeAttribute(CONTAINER_ATTR);
				}
			}
			applyHints();
			state.scanWork = null;
			cancelScheduled();
			scheduleFastPass();
			scheduleScan("exclude-kind");
			notifyScopeChange();
			return { ok: true, id, excludedKinds: Array.from(state.excludedKinds) };
		}

		function includeKind(id) {
			if (!state) return { ok: false, reason: "disabled" };
			const keys = typeof id === "string" ? [id] : Array.from(state.excludedKinds);
			let removed = 0;
			for (const key of keys) {
				if (state.excludedKinds.delete(key)) removed++;
			}
			if (!removed) return { ok: false, reason: "not-excluded" };
			saveExcludedKinds();
			state.scanWork = null;
			cancelScheduled();
			scheduleFastPass();
			scheduleScan("include-kind");
			notifyScopeChange();
			return { ok: true, removed, excludedKinds: Array.from(state.excludedKinds) };
		}

		// Remove every mark the plugin put inside one container, without
		// disturbing any other page it is working on.
		function clearScope(root) {
			if (!state || !isElement(root)) return;
			let rows = [];
			try { rows = Array.from(root.querySelectorAll("[" + ROW_ATTR + "]")); } catch (_) { rows = []; }
			if (root.hasAttribute(ROW_ATTR)) rows.push(root);
			for (const row of rows) unmarkRow(row);
			let chunks = [];
			try { chunks = Array.from(root.querySelectorAll("[" + CHUNK_ATTR + "]")); } catch (_) { chunks = []; }
			if (root.hasAttribute(CHUNK_ATTR)) chunks.push(root);
			for (const chunk of chunks) {
				chunk.removeAttribute(CHUNK_ATTR);
				const pinned = chunk.style.getPropertyValue("contain-intrinsic-size");
				if (pinned && pinned.indexOf("auto ") === 0) chunk.style.removeProperty("contain-intrinsic-size");
			}
			for (const [chunkRoot, entry] of state.chunkRoots) {
				if (root === chunkRoot || root.contains(chunkRoot)) {
					unpinChunks(entry);
					state.chunkRoots.delete(chunkRoot);
				}
			}
			const rec = state.containers.get(root);
			if (rec) rec.rows.clear();
			if (root.hasAttribute(CONTAINER_ATTR)) root.removeAttribute(CONTAINER_ATTR);
		}

		const api = {
			version: VERSION,
			enable() {
				if (state && !state.enabled && !state.disposed) start();
			},
			disable() {
				if (state && state.enabled) stop();
			},
			scanNow() {
				if (!state || !state.enabled) return;
				state.scanWork = null;
				cancelScheduled();
				scheduleFastPass();
				scheduleScan("manual");
			},
			// Trade the compositor hint for byte-identical rendering. The hint is
			// the only part of the plugin that changes pixels (grayscale instead
			// of LCD text), so the two goals cannot both be maximal.
			setPixelSafe(flag) {
				if (!state) return;
				const next = flag === true;
				if (state.pixelSafe === next) return;
				state.pixelSafe = next;
				applyHints();
				return state.pixelSafe;
			},
			// 0.8.0: the escape hatch. `scopes()` lists every scroll container the
			// plugin is working on; `exclude(key)` takes one out for good.
			scopes: scopeList,
			// The settings page's snapshot: everything optimizable on this page,
			// enabled first. `scopes()` stays the narrow, live view.
			discoverAll,
			// The capability list: what the plugin can help with, page or no page.
			catalog: surfaceCatalog,
			// Switch a surface kind on or off. Works whether or not that surface is
			// on the current page.
			excludeKind,
			includeKind,
			exclude,
			include,
			subscribeScopes,
			report,
			destroy() {
				destroy();
			}
		};

		//#region settings panel
		// A settings page under Settings → dsh-scroll-boost.
		//
		// The panel is React inside a slot; the measuring engine is plain DOM code
		// outside it. They meet at exactly three functions: scopes() to read,
		// exclude()/include() to write, and subscribeScopes() to stay in step.
		// Nothing in the panel touches the DOM of the page it is describing.
		//
		// Controls are written here rather than imported from the host's
		// primitives package on purpose: a Client plugin must not require another
		// Harness Client package as a module, and a throwing component blanks the
		// whole slot entry. Only `--dsw-alias-*` tokens are used, so light and
		// dark themes both apply without a single literal colour.
		const PANEL_STYLE_ID = "dsh-scroll-boost-panel-style";

		const PANEL_CSS = [
			// Type scale follows the host's own settings pages: a 15px section
			// title, 13px body, 12px secondary. Everything inherits the family so a
			// theme's font choice applies without this file knowing about it.
			".sbp-root{display:flex;flex-direction:column;gap:16px;font-family:inherit;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary);}",

			// Header: title and one-line explanation on the left, page-wide actions
			// on the right. Wraps instead of squeezing on a narrow panel.
			".sbp-head{display:flex;align-items:flex-start;gap:16px;justify-content:space-between;flex-wrap:wrap;}",
			".sbp-head-text{min-width:0;flex:1;}",
			".sbp-h1{font-size:15px;font-weight:600;line-height:1.4;margin:0 0 4px;letter-spacing:0;}",
			".sbp-sub{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;}",
			".sbp-head-actions{display:flex;gap:8px;flex-wrap:wrap;flex:none;}",
			".sbp-note{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;}",

			".sbp-toolbar{display:flex;align-items:center;gap:8px;justify-content:flex-end;margin-top:-4px;}",
			".sbp-lang-label{font-size:12px;color:var(--dsw-alias-label-secondary);}",
			".sbp-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;overflow:hidden;}",
			".sbp-seg-btn{font:inherit;font-size:12px;line-height:1.4;padding:3px 11px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color .12s,color .12s;}",
			".sbp-seg-btn:hover{color:var(--dsw-alias-label-primary);}",
			".sbp-seg-btn+.sbp-seg-btn{border-left:1px solid var(--dsw-alias-border-l2);}",
			".sbp-seg-btn.on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600;}",

			".sbp-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px;}",
			// The list card has no inner padding: rows supply their own, so the
			// separators reach the card edge and the table reads as one block.
			".sbp-card-flush{padding:0;overflow:hidden;}",
			".sbp-thead{display:flex;align-items:center;gap:12px;justify-content:space-between;padding:9px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);font-size:11px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);}",
			".sbp-th-name{flex:1;min-width:0;}",
			".sbp-th-state{flex:none;padding-right:96px;}",

			".sbp-row{display:flex;align-items:flex-start;gap:16px;justify-content:space-between;padding:12px 16px;}",
			".sbp-row+.sbp-row{border-top:1px solid var(--dsw-alias-border-l2);}",
			".sbp-card-flush .sbp-row+.sbp-row{margin-top:0;}",
			// A disabled row stays legible but visibly secondary: it is reference
			// information, not the thing the reader is working on.
			".sbp-row-off{background:color-mix(in srgb, var(--dsw-alias-bg-layer-2) 55%, transparent);}",
			".sbp-main{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px;}",
			".sbp-name{font-size:13px;font-weight:600;line-height:1.5;margin:0;}",
			".sbp-desc{font-size:12px;line-height:1.55;margin:0;color:var(--dsw-alias-label-secondary);}",
			".sbp-side{display:flex;align-items:center;gap:10px;flex:none;}",
			".sbp-chip{font-size:11px;line-height:1.6;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap;font-weight:500;}",
			".sbp-chip.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}",

			".sbp-btn{font-family:inherit;font-size:12px;line-height:1.5;padding:5px 12px;border-radius:7px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);white-space:nowrap;flex:none;transition:border-color .12s,background-color .12s;}",
			".sbp-btn:hover{border-color:var(--dsw-alias-label-secondary);}",
			".sbp-btn:active{transform:translateY(.5px);}",
			".sbp-btn[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}",
			".sbp-btn:disabled{opacity:.5;cursor:default;}",
			".sbp-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:600;}",
			".sbp-btn-primary:hover{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);}",

			".sbp-link{font-family:inherit;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:none;border:0;padding:3px 0 0;cursor:pointer;text-decoration:underline;text-underline-offset:2px;align-self:flex-start;}",
			".sbp-link:hover{color:var(--dsw-alias-label-primary);}",
			".sbp-detail{margin-top:8px;padding:8px 10px;border-radius:7px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:3px;}",
			".sbp-key-label{font-size:11px;color:var(--dsw-alias-label-secondary);margin:0;font-weight:600;}",
			".sbp-key{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:1.55;color:var(--dsw-alias-label-secondary);word-break:break-all;margin:0;}",

			".sbp-empty{color:var(--dsw-alias-label-secondary);font-size:13px;margin:0 0 4px;padding:0;}",
			".sbp-title{font-weight:600;font-size:13px;line-height:1.5;margin:0 0 10px;}",
			".sbp-hint{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.6;margin:8px 0 0;}",
			".sbp-stat{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);}",

			// Section headings. The catalogue and the live list are two different
			// questions, so they get their own headings rather than one long table.
			".sbp-section-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding:11px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);}",
			".sbp-section-title{font-size:12px;font-weight:600;letter-spacing:.01em;}",
			".sbp-section-sub{font-size:11px;color:var(--dsw-alias-label-secondary);}",
			".sbp-section-head-out{padding:0 0 8px;border-bottom:0;background:none;}",
			// A catalogue entry that is not on this page is reference material:
			// readable, but clearly secondary to what is live.
			".sbp-row-cat{padding:11px 16px;}",
			".sbp-row-muted .sbp-name{color:var(--dsw-alias-label-secondary);}",
			".sbp-row-muted .sbp-desc{color:color-mix(in srgb, var(--dsw-alias-label-secondary) 80%, transparent);}",
			".sbp-desc-quiet{padding-top:2px;}"
		].join("\n");

		function injectPanelStyle() {
			if (typeof document === "undefined") return null;
			let el = document.getElementById(PANEL_STYLE_ID);
			if (!el) {
				el = document.createElement("style");
				el.id = PANEL_STYLE_ID;
				el.dataset.plugin = "dsh-scroll-boost";
				el.textContent = PANEL_CSS;
				(document.head || document.documentElement).appendChild(el);
			}
			return el;
		}

		// Text lives here rather than in locale/<lang>.json because that file is
		// the plugin *catalogue* description; a settings page's copy is UI text
		// and has to follow the locale the page is rendering in.
		//
		// Written for someone who has never opened a browser console. Nothing on
		// the default view names a CSS class, an attribute, or a DOM concept.
		const PANEL_TEXT = {
			zh: {
				heading: "滚动加速",
				intro: "长会话滚起来更顺，是因为这个插件把屏幕外的内容先“折叠”起来，不让浏览器去算它。",
				introMore: "先列出这个插件认得的所有界面——不用真的打开它们。最下面是当前页面检测到的结果，已开启的排在前面。",
				colInterface: "界面",
				colState: "状态",
				catalogTitle: "这个插件会优化哪些界面",
				catalogSub: "不需要打开对应页面也会列在这里",
				pageTitle: "当前页面",
				pageSub: "检测结果，已开启的排在前面",
				here: "本页",
				notHere: "不在此页",
				scopes: "正在加速的界面",
				empty: "这个页面没有需要加速的界面。",
				emptyHint: "只有内容很长的列表才需要加速；短的本来就快。打开一个长会话或长列表再回来看看。",
				on: "加速中",
				off: "已关闭",
				rowsLabel: (n) => "已折叠 " + n + " 条内容",
				noRows: "目前没有可折叠的内容",
				hintChip: "滚动更顺",
				actionTurnOff: "关掉加速",
				actionTurnOn: "恢复加速",
				rescan: "重新检测",
				resetAll: "全部恢复",
				unknownPage: "已离开的界面",
				detailsShow: "技术信息",
				detailsHide: "收起",
				keyLabel: "识别标识",
				keyNote: "用来记住这个界面。页面布局改版后它可能变，届时重新关一次即可。",
				offTitle: "不在当前页面的已关闭记录",
				offNote: "这些界面目前不受插件影响。",
				offEmpty: "没有关闭任何界面。",
				offStale: "此界面已不在当前页面，设置仍会保留。",
				saved: "选择会自动保存，重启后依然有效。",
				lang: "语言",
				stats: (r, scopes) => {
					const on = scopes.filter((s) => !s.excluded).length;
					const off = scopes.length - on;
					return "本页 " + scopes.length + " 个界面 · " + on + " 个加速中" +
						(off > 0 ? " · " + off + " 个已关闭" : "") +
						" · 累计折叠 " + r.rows + " 条";
				},
				statsOff: "插件当前已停用。",
				surfaceChat: "聊天记录",
				surfaceTrajectory: "轨迹面板",
				surfaceSummary: "摘要预览",
				surfaceComposer: "输入框",
				surfaceApproval: "审批面板",
				surfaceQuestion: "提问面板",
				surfaceProcess: "过程组",
				pageKindChat: "聊天记录",
				pageKindSidebar: "侧栏",
				pageKindPanel: "其他插件的面板",
				pageKindOther: "其他界面"
			},
			en: {
				heading: "Scroll Boost",
				intro: "Long conversations scroll more smoothly because this plugin folds away what is off screen, so the browser does not have to work it out.",
				introMore: "First, every interface this plugin recognises — no need to open them. Below that, what was actually detected on this page, enabled ones first.",
				colInterface: "Interface",
				colState: "State",
				catalogTitle: "What this plugin can speed up",
				catalogSub: "Listed whether or not that page is open",
				pageTitle: "This page",
				pageSub: "Detected here, enabled ones first",
				here: "Here",
				notHere: "Not here",
				scopes: "Interfaces being sped up",
				empty: "Nothing on this page needs speeding up.",
				emptyHint: "Only long lists need it; short ones are already fast. Open a long conversation and come back.",
				on: "Speeding up",
				off: "Turned off",
				rowsLabel: (n) => n + " items folded away",
				noRows: "Nothing to fold away right now",
				hintChip: "Smoother scrolling",
				actionTurnOff: "Turn off",
				actionTurnOn: "Turn on again",
				rescan: "Detect again",
				resetAll: "Turn all back on",
				unknownPage: "A page no longer open",
				detailsShow: "Technical details",
				detailsHide: "Hide",
				keyLabel: "Identifier",
				keyNote: "Used to remember this interface. A layout change may alter it; turn it off again if so.",
				offTitle: "Turned off, no longer on this page",
				offNote: "These interfaces are not affected by the plugin.",
				offEmpty: "Nothing is turned off.",
				offStale: "This page is gone; the setting is kept.",
				saved: "Your choice is saved automatically and survives a restart.",
				lang: "Language",
				stats: (r, scopes) => {
					const on = scopes.filter((s) => !s.excluded).length;
					const off = scopes.length - on;
					return scopes.length + " interfaces · " + on + " active" +
						(off > 0 ? " · " + off + " off" : "") +
						" · " + r.rows + " items folded";
				},
				statsOff: "The plugin is currently disabled.",
				surfaceChat: "Chat transcript",
				surfaceTrajectory: "Trajectory panel",
				surfaceSummary: "Summary preview",
				surfaceComposer: "Composer",
				surfaceApproval: "Approval panel",
				surfaceQuestion: "Question panel",
				surfaceProcess: "Process group",
				pageKindChat: "Chat transcript",
				pageKindSidebar: "Sidebar",
				pageKindPanel: "Another plugin's panel",
				pageKindOther: "Another interface"
			}
		};

		// A surface id -> the phrase a person would use for it. Unknown ids fall
		// back to null and the caller picks a generic name, so a future DSH
		// surface shows up as "another interface" instead of breaking the page.
		function surfaceLabel(t, id) {
			switch (id) {
				case "chat-flow": return t.surfaceChat;
				case "trajectory": return t.surfaceTrajectory;
				case "summary-region": return t.surfaceSummary;
				case "composer-input": return t.surfaceComposer;
				case "approval-panel": return t.surfaceApproval;
				case "question-panel": return t.surfaceQuestion;
				case "process-body": return t.surfaceProcess;
				default: return null;
			}
		}

		// The readable name for one scope. Never a CSS selector: a person reads
		// "聊天记录", not "div.chat-scroll > div.column".
		//
		// A page the plugin adopted by shape alone is named by what it visibly is,
		// never by a class name. "未命名" would tell a reader nothing and make the
		// row feel broken; "其他插件的面板" is both true and actionable.
		function scopeTitle(t, scope) {
			if (Array.isArray(scope.surfaces)) {
				for (const id of scope.surfaces) {
					const label = surfaceLabel(t, id);
					if (label) return label;
				}
			}
			const cls = typeof scope.className === "string" ? scope.className : "";
			if (/conv|chat|flow|column|transcript/i.test(cls)) return t.surfaceChat;
			if (/sidebar|aside/i.test(cls)) return t.pageKindSidebar;
			// A large scroll area the plugin adopted by shape, on a page that is
			// not the conversation: most often another plugin's panel.
			if (scope.area >= 120000) return t.pageKindPanel;
			if (scope.rows > 0) return t.pageKindOther;
			return t.pageKindOther;
		}

		// Where the text comes from, in order: an explicit pick saved by the user,
		// then the host locale, then Chinese. The pick is stored so the choice
		// survives a restart, and it is deliberately per-user, not per-page.
		const LANG_KEY = "dsh-scroll-boost.panelLang.v1";

		function readLangPreference() {
			try {
				const raw = window.localStorage.getItem(LANG_KEY);
				if (raw === "zh" || raw === "en") return raw;
			} catch (_) { /* ignore */ }
			return null;
		}

		function writeLangPreference(value) {
			try {
				window.localStorage.setItem(LANG_KEY, value);
			} catch (_) { /* ignore */ }
		}

		function panelText(locale, picked) {
			const chosen = picked === "zh" || picked === "en" ? picked : null;
			if (chosen) return { lang: chosen, t: PANEL_TEXT[chosen] };
			// No explicit pick: follow the host, but default to Chinese when the
			// host gives us nothing usable (DSH ships a Chinese-first UI).
			if (typeof locale === "string" && /^en/i.test(locale)) return { lang: "en", t: PANEL_TEXT.en };
			return { lang: "zh", t: PANEL_TEXT.zh };
		}

		function createSettingsPanel(React) {
			const h = React.createElement;

			return function ScrollBoostSettings(props) {
				// A panel must never blank the slot: if the engine is not up yet
				// (immediately happens before the host mounts), show an explanation
				// instead of throwing.
				const api = typeof window !== "undefined" ? window[STATE_KEY] : undefined;
				const locale = props && props.locale !== undefined ? props.locale : undefined;
				// Language: a saved pick wins, then the host locale, then Chinese.
				const [picked, setPickedState] = React.useState(() => readLangPreference());
				const resolved = panelText(locale, picked);
				const lang = resolved.lang;
				const t = resolved.t;
				// Which rows have their technical block open. Keyed by scope so the
				// state survives a refresh of the list.
				const [detailsOpen, setDetailsOpen] = React.useState({});
				const [version, setVersion] = React.useState(0);
				// The catalogue is what the plugin *can* do; it is cheap (a dozen
				// selector matches) and is always shown, so the page answers "what
				// is this for?" even when nothing here is optimizable.
				const [catalog, setCatalog] = React.useState(() => {
					if (!api) return [];
					try { return api.catalog(); } catch (_) { return []; }
				});
				// The live list is a snapshot, refreshed only when asked, so rows do
				// not move under the pointer while the page is being read.
				const [scopes, setScopes] = React.useState(() => {
					if (!api) return [];
					try { return api.discoverAll(); } catch (_) { return api.scopes(); }
				});
				const [report, setReport] = React.useState(() => (api ? api.report() : null));

				const setPicked = (value) => {
					writeLangPreference(value);
					setPickedState(value);
				};

				// Only re-reads the counters and the cheap catalogue. The expensive
				// document sweep runs when the user asks for it.
				function refresh() {
					if (!api) return;
					setReport(api.report());
					try { setCatalog(api.catalog()); } catch (_) { /* keep the old one */ }
				}

				function rescan() {
					if (!api) return;
					api.scanNow();
					try { setScopes(api.discoverAll()); } catch (_) { setScopes(api.scopes()); }
					refresh();
				}

				React.useEffect(() => {
					if (!api) return undefined;
					refresh();
					const unsubscribe = api.subscribeScopes ? api.subscribeScopes(refresh) : null;
					return () => {
						if (typeof unsubscribe === "function") unsubscribe();
					};
				}, [api, version]);

				if (!api) {
					return h("div", { className: "sbp-root" },
						h("div", { className: "sbp-head" },
							h("div", { className: "sbp-head-text" },
								h("h2", { className: "sbp-h1" }, t.heading),
								h("p", { className: "sbp-sub" }, t.intro))));
				}

				const bump = () => setVersion((n) => n + 1);

				// The row a person reads: what this is, how much it is doing, and
				// one button. The identifier and the raw selector live behind a
				// disclosure, because nobody needs them to make the decision.
				const scopeRow = (scope) => {
					const open = detailsOpen[scope.key] === true;
					const state = scope.excluded ? t.off : t.on;
					// A row with nothing to fold is still listed (the user asked for
					// everything), but it must not claim to be doing work.
					const detail = scope.excluded
						? t.offNote
						: scope.rows > 0 ? t.rowsLabel(scope.rows) : t.noRows;
					return h("div", {
						className: "sbp-row" + (scope.excluded ? " sbp-row-off" : ""),
						key: scope.key
					},
						h("div", { className: "sbp-main" },
							h("p", { className: "sbp-name" }, scopeTitle(t, scope)),
							h("p", { className: "sbp-desc" }, detail),
							h("button", {
								type: "button",
								className: "sbp-link",
								"aria-expanded": open ? "true" : "false",
								onClick: () => setDetailsOpen((prev) => {
									const next = Object.assign({}, prev);
									next[scope.key] = !open;
									return next;
								})
							}, t.detailsShow + (open ? " ▾" : " ▸")),
							open ? h("div", { className: "sbp-detail" },
								h("p", { className: "sbp-key-label" }, t.keyLabel),
								h("p", { className: "sbp-key" }, scope.key),
								h("p", { className: "sbp-hint" }, t.keyNote)) : null),
						h("div", { className: "sbp-side" },
							h("span", { className: "sbp-chip" + (scope.excluded ? "" : " on") }, state),
							h("button", {
								type: "button",
								className: "sbp-btn",
								"aria-pressed": scope.excluded ? "false" : "true",
								onClick: () => {
									if (scope.excluded) api.include(scope.key);
									else api.exclude(scope.key);
									// Re-detect so the row moves to its new group
									// immediately; the list is a snapshot, not a feed.
									rescan();
									bump();
								}
							}, scope.excluded ? t.actionTurnOn : t.actionTurnOff)));
				};

				const excludedList = report && Array.isArray(report.excluded) ? report.excluded : [];
				// A container that is off stays in scopes() with `excluded: true`,
				// so the row itself carries the way back. The only thing scopes()
				// cannot show is a key whose container is gone (the page was closed
				// or the layout changed); those are listed separately so a stale
				// exclusion can still be cleared.
				const activeKeys = new Set(scopes.map((s) => s.key));
				const orphanExcluded = excludedList.filter((key) => !activeKeys.has(key));

				return h("div", { className: "sbp-root" },
					// Header: what this page is for, then the two controls that act on
					// the whole page. The primary action (re-detect) sits here rather
					// than at the bottom so a reader sees it without scrolling.
					h("div", { className: "sbp-head" },
						h("div", { className: "sbp-head-text" },
							h("h2", { className: "sbp-h1" }, t.heading),
							h("p", { className: "sbp-sub" }, t.intro)),
						h("div", { className: "sbp-head-actions" },
							h("button", {
								type: "button",
								className: "sbp-btn sbp-btn-primary",
								onClick: rescan
							}, t.rescan),
							excludedList.length > 0 ? h("button", {
								type: "button", className: "sbp-btn",
								onClick: () => { api.include(); rescan(); bump(); }
							}, t.resetAll) : null)),

					h("p", { className: "sbp-note" }, t.introMore),

					// Language switch. Last in reading order because it is a
					// preference, not part of the task.
					h("div", { className: "sbp-toolbar" },
						h("span", { className: "sbp-lang-label" }, t.lang),
						h("div", { className: "sbp-seg", role: "group", "aria-label": t.lang },
							h("button", {
								type: "button",
								className: "sbp-seg-btn" + (lang === "zh" ? " on" : ""),
								"aria-pressed": lang === "zh" ? "true" : "false",
								onClick: () => setPicked("zh")
							}, "中文"),
							h("button", {
								type: "button",
								className: "sbp-seg-btn" + (lang === "en" ? " on" : ""),
								"aria-pressed": lang === "en" ? "true" : "false",
								onClick: () => setPicked("en")
							}, "English"))),

					// The catalogue. Always shown, page or no page: this is the
					// section that answers "what would this plugin even do?", and it
					// never depends on the user having visited a screen first.
					h("div", { className: "sbp-card sbp-card-flush" },
						h("div", { className: "sbp-section-head" },
							h("span", { className: "sbp-section-title" }, t.catalogTitle),
							h("span", { className: "sbp-section-sub" }, t.catalogSub)),
						catalog.map((item) => {
							const onThisPage = item.present === true;
							const off = item.excluded === true;
							// Switched off reads as muted regardless of presence: the
							// row is describing something the plugin will not touch.
							const muted = off || !onThisPage;
							return h("div", {
								className: "sbp-row sbp-row-cat" + (muted ? " sbp-row-muted" : ""),
								key: item.id
							},
								h("div", { className: "sbp-main" },
									h("p", { className: "sbp-name" },
										item.label[lang] || item.label.zh,
										off
											? h("span", { className: "sbp-chip" }, t.off)
											: onThisPage
												? h("span", { className: "sbp-chip on" }, t.here)
												: h("span", { className: "sbp-chip" }, t.notHere)),
									h("p", { className: "sbp-desc" }, item.note[lang] || item.note.zh),
									onThisPage && !off && item.rows > 0
										? h("p", { className: "sbp-desc sbp-desc-quiet" }, t.rowsLabel(item.rows))
										: null),
								h("div", { className: "sbp-side" },
									h("button", {
										type: "button",
										className: "sbp-btn",
										"aria-pressed": off ? "false" : "true",
										onClick: () => {
											if (off) api.includeKind(item.id);
											else api.excludeKind(item.id);
											rescan();
											bump();
										}
									}, off ? t.actionTurnOn : t.actionTurnOff)));
						})),

					// The live list for this page. Enabled entries are on top
					// because that is what the reader came to change.
					h("div", { className: "sbp-section-head sbp-section-head-out" },
						h("span", { className: "sbp-section-title" }, t.pageTitle),
						h("span", { className: "sbp-section-sub" }, t.pageSub)),

					scopes.length === 0
						? h("div", { className: "sbp-card" },
							h("p", { className: "sbp-empty" }, t.empty),
							h("p", { className: "sbp-hint" }, t.emptyHint))
						: h("div", { className: "sbp-card sbp-card-flush" },
							h("div", { className: "sbp-thead" },
								h("span", { className: "sbp-th-name" }, t.colInterface),
								h("span", { className: "sbp-th-state" }, t.colState)),
							scopes.map(scopeRow)),

					excludedList.length > 0 ? h("div", { className: "sbp-card" },
						h("p", { className: "sbp-title" }, t.offTitle),
						orphanExcluded.length === 0
							? h("p", { className: "sbp-empty" }, t.offEmpty)
							: orphanExcluded.map((key) => h("div", { className: "sbp-row", key },
								h("div", { className: "sbp-main" },
									h("p", { className: "sbp-name" }, t.unknownPage),
									h("p", { className: "sbp-desc" }, t.offStale)),
								h("button", {
									type: "button",
									className: "sbp-btn",
									onClick: () => { api.include(key); rescan(); bump(); }
								}, t.actionTurnOn))),
						h("p", { className: "sbp-hint" }, t.saved)) : null,

					report
						? h("div", { className: "sbp-stat" },
							report.enabled === false ? t.statsOff : t.stats(report, scopes))
						: null);
			};
		}

		// Register the page. `slots` is declared in `exports.inject`, so it is
		// present here by the time apply() runs; the guards below only cover a
		// composition that mounts a partial stand-in.
		function registerSettingsPanel(ctx, React) {
			if (!ctx || !ctx.slots) return false;
			const slots = ctx.slots;
			if (typeof slots.register !== "function" || typeof slots.inject !== "function") return false;

			injectPanelStyle();
			const Panel = createSettingsPanel(React);
			// `label` is what the settings list shows; `id` is the stable key the
			// slot system uses and must not follow the label. The label is the
			// product name without the package prefix - a reader looking for a
			// setting should not have to parse "dsh-".
			//
			// The label is fixed English on purpose: it is the product name, and it
			// has to be found the same way regardless of the panel's language, which
			// the reader may switch at any time. The page's own copy still follows
			// the language switch; only this entry in the settings list does not.
			return slots.inject("settings.section", () => slots.register({
				name: "settings.section",
				id: "dsh-scroll-boost",
				order: 60,
				label: "Scroll Boost"
			}, Panel));
		}
		//#endregion

		function apply(ctx) {
			const existing = window[STATE_KEY];
			if (existing && typeof existing.destroy === "function") {
				try { existing.destroy(); } catch (_) { /* ignore */ }
			}

			state = createState();
			const ownedState = state;
			window[STATE_KEY] = api;
			// `pagehide` used to register `destroy` with `{ once: true }` and nothing
			// else, so leaving the page and coming back through the back/forward
			// cache left the plugin torn down for the rest of the session: no
			// marks, no observer, and `window.__scrollBoost` already deleted. A
			// persisted `pagehide` keeps the document alive, so it only has to
			// pause; a real unload still tears everything down.
			state.pagehideHandler = (event) => {
				// A persisted hide means the document will be restored as-is, so
				// the marks stay and only the scheduling has to stop.
				if (event && event.persisted) {
					pause();
					return;
				}
				destroy();
			};
			window.addEventListener("pagehide", state.pagehideHandler);
			state.pageshowHandler = (event) => {
				if (!event || !event.persisted) return;
				resume();
			};
			window.addEventListener("pageshow", state.pageshowHandler);

			loadHeightCache();
			state.excluded = loadExclusions();
			state.excludedKinds = loadExcludedKinds();
			setupResizeObserver();
			start();

			// The settings page. React comes from the browser module table, which
			// the host always seeds; the only way this is absent is a non-UI
			// composition, and then the page is legitimately not mounted.
			if (ctx !== undefined && ctx !== null) {
				let React = null;
				try {
					React = require("react");
				} catch (err) {
					React = null;
					console.warn("[dsh-scroll-boost] settings page skipped: react unavailable", err);
				}
				if (React !== null && typeof React.createElement === "function") {
					let registered = false;
					try {
						registered = registerSettingsPanel(ctx, React);
					} catch (err) {
						console.warn("[dsh-scroll-boost] settings page failed to register", err);
					}
					if (!registered) {
						console.warn(
							"[dsh-scroll-boost] settings page not registered:",
							ctx.slots === undefined
								? "ctx.slots is missing (is `slots` in inject?)"
								: "slots service lacks register/inject"
						);
					}
				}
			}

			if (ctx !== undefined && typeof ctx.effect === "function") {
				// Only tear down the instance this apply() created. If the plugin
				// is applied twice (HMR, reload), the old cleanup must not destroy
				// the newer instance.
				ctx.effect(() => {
					return () => {
						if (state === ownedState) destroy();
					};
				}, "dsh-scroll-boost: scroll optimization");
			}
		}
		//#endregion

		// `slots` is what the settings page registers into. Declaring it is the
		// whole mechanism: Cordis only projects a service onto `ctx` when the
		// plugin asks for it, so an empty `inject` left `ctx.slots` undefined and
		// the settings page was skipped in silence.
		//
		// The scroll engine itself needs nothing from the client context, so this
		// is the only dependency. A host without the slots service (a headless
		// composition) simply keeps the plugin inactive at the UI layer.
		exports.inject = ["slots"];
		exports.apply = apply;
		return module.exports;
	}
});
