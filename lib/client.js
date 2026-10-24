/**
 * dsh-scroll-boost - browser half.
 *
 * 0.4.0 is built on three ideas:
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
 *   3. Reversibility. Everything is attributes plus one style element; the
 *      plugin never touches React, the host, or another plugin.
 */
window.__ModuleLoader__.load({
	id: "dsh-scroll-boost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		//#region constants
		const VERSION = "0.4.0";
		const STATE_KEY = "__scrollBoost";
		const STYLE_ID = "dsh-scroll-boost-style";
		const ROW_ATTR = "data-scrollboost-row";
		const CONTAINER_ATTR = "data-scrollboost-container";
		const SCROLLING_ATTR = "data-scrollboost-scrolling";
		const ROW_HEIGHT_VAR = "--sb-h";
		const HEIGHT_CACHE_KEY = "dsh-scroll-boost.heights.v1";
		const HEIGHT_CACHE_LIMIT = 4000;

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
		const OVERFLOW_SCAN_LIMIT = 1500;
		const FAST_PASS_MAX_CANDIDATES = 12;
		const FAST_PASS_MAX_ROWS = 120;
		const FAST_PASS_MAX_READS = 300;
		const FAST_PASS_BAND_RATIO = 1.5;
		const FAST_PASS_MIN_INTERVAL_MS = 120;
		const PERSIST_DEBOUNCE_MS = 2000;
		const MAX_OBSERVED_ROWS = 200;

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

		// Descendants whose sticky positioning would break when their row
		// becomes a containment context.
		const STICKY_SELECTOR = [
			"[data-disclosure-header]",
			"[data-code-block-banner]",
			"[data-trigger-menu]",
			'[style*="sticky"]'
		].join(",");

		// DSH surfaces, ordered by priority.
		//   rows   - direct children of the element are the rows to skip
		//   hint   - only a compositor hint on the scroll port
		//   static - the surface rebuilds its rows on every frame, so a
		//            per-row attribute would be wiped before it is ever
		//            painted. A static stylesheet rule is used instead; the
		//            surface still gets the scroll hint so idle work pauses.
		const SURFACE_DEFS = [
			{
				id: "chat-flow",
				kind: "rows",
				selector: '[data-slot="conversation.chat.flow"]',
				priority: 100
			},
			{
				id: "conversation-scroll",
				kind: "hint",
				selector: "[data-conversation-scroll]",
				priority: 90
			},
			{
				id: "trajectory",
				kind: "static",
				selector: "[data-trajectory-scroll]",
				priority: 80
			},
			{
				id: "summary-region",
				kind: "hint",
				selector: "[data-summary-scroll-region]",
				priority: 70
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

		const STYLE_TEXT = [
			"[" + ROW_ATTR + "] {",
			"  content-visibility: auto;",
			"  contain-intrinsic-size: auto 200px;",
			"  contain-intrinsic-size: auto var(" + ROW_HEIGHT_VAR + ", 200px);",
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
				if (!(el.clientHeight > 0) || !(el.scrollHeight > el.clientHeight + 4)) return false;
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
			state.stats.marked = 0;
			state.stats.skipped = 0;
			state.stats.deferred = 0;
			state.stats.cachedRows = 0;
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
				weakHeights: new WeakMap(),
				cacheLoaded: false,
				cacheDirty: false,
				persistTimer: null,
				resizeObserver: null,
				observedRows: new Set(),
				markedRows: new WeakSet(),
				guardedRows: new WeakSet(),
				fastQueue: new Set(),
				fastHandle: null,
				fastKind: null,
				fastBudgetUntil: 0,
				lastFastPassAt: 0,
				overflowCandidates: null,
				overflowIndex: 0,
				overflowDone: false,
				overflowHandle: null,
				lastScrollAt: 0,
				pagehideHandler: null,
				stats: {
					scans: 0,
					containers: 0,
					hinted: 0,
					rows: 0,
					marked: 0,
					skipped: 0,
					deferred: 0,
					fastPasses: 0,
					fastRows: 0,
					cachedRows: 0,
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
			setupObserver();
			// First pass: walk the DOM synchronously but only the cheap parts
			// (surface discovery, candidate collection). Marking visible rows
			// immediately is what removes the first-screen delay; heavy overflow
			// detection and offscreen marking stay idle-sliced.
			scheduleScan("start");
			scheduleFastPass();
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
				if (rec.scrollTimer !== null) {
					clearTimeout(rec.scrollTimer);
					rec.scrollTimer = null;
				}
				el.removeAttribute(CONTAINER_ATTR);
				el.removeAttribute(SCROLLING_ATTR);
			}
			state.containers.clear();
			state.surfaces.clear();

			const marked = document.querySelectorAll("[" + ROW_ATTR + "]");
			for (const row of marked) {
				row.removeAttribute(ROW_ATTR);
				row.style.removeProperty(ROW_HEIGHT_VAR);
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

		function markScrolling(el) {
			if (!state) return;
			state.lastScrollAt = now();
			if (!el.hasAttribute(SCROLLING_ATTR)) {
				el.setAttribute(SCROLLING_ATTR, "");
			}
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
				scrollTimer: null,
				onScroll: null
			};
			rec.onScroll = () => {
				if (!state || !state.enabled) return;
				markScrolling(el);
				if (rec.scrollTimer !== null) clearTimeout(rec.scrollTimer);
				rec.scrollTimer = setTimeout(() => {
					rec.scrollTimer = null;
					if (isConnected(el)) el.removeAttribute(SCROLLING_ATTR);
				}, SCROLL_IDLE_MS);
			};
			el.addEventListener("scroll", rec.onScroll, { passive: true });
			state.containers.set(el, rec);
			return rec;
		}

		function pruneContainers() {
			if (!state) return;
			for (const [el, rec] of state.containers) {
				if (isConnected(el)) continue;
				try {
					el.removeEventListener("scroll", rec.onScroll, { passive: true });
				} catch (_) { /* ignore */ }
				if (rec.scrollTimer !== null) clearTimeout(rec.scrollTimer);
				state.containers.delete(el);
			}
		}

		function applyHints() {
			if (!state) return;
			const live = Array.from(state.containers.values()).filter((rec) => isConnected(rec.el));
			live.sort((a, b) => rectArea(b.el) - rectArea(a.el));
			const top = new Set(live.slice(0, MAX_HINT_CONTAINERS).map((rec) => rec.el));

			for (const rec of live) {
				if (top.has(rec.el)) {
					if (!rec.el.hasAttribute(CONTAINER_ATTR)) {
						rec.el.setAttribute(CONTAINER_ATTR, "");
					}
					rec.hinted = true;
				} else if (rec.el.hasAttribute(CONTAINER_ATTR)) {
					rec.el.removeAttribute(CONTAINER_ATTR);
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
		function loadHeightCache() {
			if (!state || state.cacheLoaded) return;
			state.cacheLoaded = true;
			try {
				const raw = window.localStorage.getItem(HEIGHT_CACHE_KEY);
				if (!raw) return;
				const parsed = JSON.parse(raw);
				if (!parsed || typeof parsed !== "object") return;
				for (const key of Object.keys(parsed)) {
					const value = parsed[key];
					if (typeof value === "number" && value > 0) {
						state.heightCache.set(key, value);
					}
				}
			} catch (_) { /* ignore */ }
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

		function flushHeightCache() {
			if (!state || !state.cacheDirty) return;
			state.cacheDirty = false;
			try {
				if (state.heightCache.size > HEIGHT_CACHE_LIMIT) {
					const keys = Array.from(state.heightCache.keys()).slice(0, state.heightCache.size - HEIGHT_CACHE_LIMIT);
					for (const key of keys) state.heightCache.delete(key);
				}
				window.localStorage.setItem(HEIGHT_CACHE_KEY, JSON.stringify(Object.fromEntries(state.heightCache)));
			} catch (_) { /* ignore */ }
		}
		//#endregion

		//#region guards
		// A skipped row becomes a containment context. Anything that relies on
		// escaping that context (sticky headers) or on a stable height (folding
		// rows, live regions) must not be skipped.
		function isInSkippedSurface(el) {
			try {
				return el.closest("[data-trajectory-scroll]") !== null;
			} catch (_) {
				return false;
			}
		}

		function hasStickyDescendant(row) {
			try {
				const found = row.querySelector(STICKY_SELECTOR);
				if (!found) return false;
				const cs = getComputedStyle(found);
				return !!cs && cs.position === "sticky";
			} catch (_) {
				return false;
			}
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
			if (hasStickyDescendant(row)) return "sticky";
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
				const style = cs || getComputedStyle(row);
				const px = (value) => {
					const n = parseFloat(value);
					return Number.isFinite(n) ? n : 0;
				};
				const inner = height
					- px(style.paddingTop) - px(style.paddingBottom)
					- px(style.borderTopWidth) - px(style.borderBottomWidth);
				if (inner > 0) return inner;
			} catch (_) { /* ignore */ }
			return height;
		}

		function applyRowHeight(row, height) {
			// Keep sub-pixel precision. Rounding every row to whole pixels
			// loses up to 0.5px per row, which over a thousand rows is a visible
			// scrollbar drift and makes DSH's own row lookup land off by a line.
			const rounded = Math.round(height * 100) / 100;
			const value = rounded + "px";
			if (row.style.getPropertyValue(ROW_HEIGHT_VAR) !== value) {
				row.style.setProperty(ROW_HEIGHT_VAR, value);
			}
		}

		function markRow(row, rec, options) {
			if (!state || !isElement(row) || !isConnected(row)) return false;

			// Never re-measure an already marked row. With content-visibility:auto
			// an offscreen row reports its contain-intrinsic-size, not its real
			// height; measuring it again would shrink the placeholder and make the
			// scrollbar jump. The first measurement is the real one.
			if (row.hasAttribute(ROW_ATTR)) {
				if (rec) rec.rows.add(row);
				return true;
			}

			const opts = options || {};
			const reason = guardReason(row);
			if (reason) {
				state.stats.skipped++;
				state.stats.skipReasons[reason] = (state.stats.skipReasons[reason] || 0) + 1;
				return false;
			}

			const cs = getRowStyle(row);
			if (!cs) {
				state.stats.skipped++;
				return false;
			}

			let height = 0;
			let fromCache = false;
			if (opts.height > 0) {
				height = opts.height;
			} else {
				const cached = cachedHeight(row);
				if (cached > 0) {
					height = cached;
					fromCache = true;
				} else if (opts.measure === false) {
					// No known height and no budget to read one: leave the row
					// rendered. Correctness first.
					state.stats.deferred++;
					return false;
				} else {
					height = measureRow(row, cs);
				}
			}
			if (!(height > 0)) {
				state.stats.skipped++;
				return false;
			}

			applyRowHeight(row, height);
			row.setAttribute(ROW_ATTR, "");
			state.markedRows.add(row);
			if (fromCache) state.stats.cachedRows++;
			else rememberHeight(row, height);
			state.stats.marked++;
			if (rec) rec.rows.add(row);
			observeRow(row);
			return true;
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
					} else if (item.measure === false) {
						state.stats.deferred++;
						continue;
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
				state.markedRows.add(item.row);
				if (item.fromCache) state.stats.cachedRows++;
				else rememberHeight(item.row, item.height);
				state.stats.marked++;
				if (item.rec) item.rec.rows.add(item.row);
				observeRow(item.row);
			}
			return prepared.length;
		}

		function unmarkRow(row) {
			if (!isElement(row)) return;
			row.removeAttribute(ROW_ATTR);
			row.style.removeProperty(ROW_HEIGHT_VAR);
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
					const row = entry.target;
					if (!isElement(row) || !row.hasAttribute(ROW_ATTR)) continue;
					let height = 0;
					try {
						const rect = row.getBoundingClientRect();
						height = rect.height;
					} catch (_) { height = 0; }
					if (!(height > 0)) continue;
					const cs = getRowStyle(row);
					const inner = cs ? measureRow(row, cs) : height;
					applyRowHeight(row, inner);
					rememberHeight(row, inner);
				}
			});
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
			state.stats.surfaces = state.surfaces.size;
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

		//#region row discovery
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
						overflows = el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 4;
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
					items.push({ row, rec: container, measure: true });
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
						items.push({ row, rec, measure: true });
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

			let rowsThisSlice = 0;

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
							if (el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 80) {
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
							batch.push({ row, rec, measure: true });
						}
						rowsThisSlice += applyBatch(batch);
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

					state.scanWork = null;
					state.stats.scans++;
					state.stats.rows = work.rowQueue.length;
					state.stats.lastScanMs = Math.round(now() - work.startedAt);
					state.stats.lastScanAt = Date.now();
					return true;
				}

				break;
			}

			return false;
		}
		//#endregion

		//#region mutation maintenance
		function revalidateRow(row) {
			if (!isElement(row) || !row.hasAttribute(ROW_ATTR)) return;
			const reason = guardReason(row);
			if (!reason) return;
			// The row became unsafe to skip (folding row opened, sticky header
			// appeared, motion started). Put it back into the layout.
			unmarkRow(row);
		}

		function setupObserver() {
			if (!state || state.observer) return;
			if (typeof MutationObserver !== "function") return;
			const root = document.body || document.documentElement;
			if (!root) return;

			state.observer = new MutationObserver((mutations) => {
				let elementAdded = false;
				let rowChanged = false;
				for (const mutation of mutations) {
					if (mutation.type === "attributes") {
						const target = mutation.target;
						if (isElement(target) && target.hasAttribute(ROW_ATTR)) {
							rowChanged = true;
						}
						continue;
					}
					for (const node of mutation.addedNodes) {
						if (isElement(node)) {
							elementAdded = true;
							break;
						}
					}
					if (elementAdded) break;
				}

				if (rowChanged) {
					for (const marked of document.querySelectorAll("[" + ROW_ATTR + "]")) {
						revalidateRow(marked);
					}
				}

				if (!elementAdded) return;

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
				attributeFilter: ["data-expanded", "data-open", "data-chat-motion", "hidden"]
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
				marked: state.stats.marked,
				skipped: state.stats.skipped,
				deferred: state.stats.deferred,
				cachedRows: state.stats.cachedRows,
				scans: state.stats.scans,
				lastScanMs: state.stats.lastScanMs,
				lastScanAt: state.stats.lastScanAt,
				scrolling: isScrolling(),
				fastPasses: state.stats.fastPasses,
				fastRows: state.stats.fastRows,
				surfaces,
				cacheSize: state.heightCache.size,
				skipReasons: state.stats.skipReasons,
				pending: !!state.scanWork || state.scanScheduled || state.fastHandle !== null
			};
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
			report,
			destroy() {
				destroy();
			}
		};

		function apply(ctx) {
			const existing = window[STATE_KEY];
			if (existing && typeof existing.destroy === "function") {
				try { existing.destroy(); } catch (_) { /* ignore */ }
			}

			state = createState();
			const ownedState = state;
			window[STATE_KEY] = api;
			state.pagehideHandler = () => destroy();
			window.addEventListener("pagehide", state.pagehideHandler, { once: true });

			loadHeightCache();
			setupResizeObserver();
			start();

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

		exports.inject = [];
		exports.apply = apply;
		return module.exports;
	}
});
