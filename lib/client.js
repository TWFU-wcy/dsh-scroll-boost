/**
 * dsh-scroll-boost - browser half.
 *
 * Four layers, all client-side and reversible:
 *   A. Offscreen row skipping with content-visibility + measured intrinsic size.
 *   B. Compositor hints on the largest scroll containers (max 8).
 *   C. Idle, sliced scanning; all scanning pauses while the user is scrolling.
 *   D. Incremental maintenance via a childList-only MutationObserver.
 *
 * The plugin deliberately does not touch React, the DSH host, or any other
 * plugin. It only adds attributes and one scoped style element. Removing the
 * plugin (or calling window.__scrollBoost.disable()) restores the DOM.
 */
window.__ModuleLoader__.load({
	id: "dsh-scroll-boost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		//#region constants
		const VERSION = "0.2.1";
		const STATE_KEY = "__scrollBoost";
		const STYLE_ID = "dsh-scroll-boost-style";
		const ROW_ATTR = "data-scrollboost-row";
		const CONTAINER_ATTR = "data-scrollboost-container";
		const SCROLLING_ATTR = "data-scrollboost-scrolling";
		const ROW_HEIGHT_VAR = "--sb-h";

		const SCROLL_IDLE_MS = 120;
		const MUTATION_DEBOUNCE_MS = 300;
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

		const SKIP_TAGS = new Set([
			"SCRIPT", "STYLE", "LINK", "META", "BR", "HR",
			"TEXTAREA", "INPUT", "SELECT", "OPTION",
			"SVG", "CANVAS", "VIDEO", "AUDIO", "IFRAME",
			"PRE", "CODE", "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TD", "TH"
		]);

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

		const STYLE_TEXT = [
			"[" + ROW_ATTR + "] {",
			"  content-visibility: auto;",
			"  contain-intrinsic-size: auto 200px;",
			"  contain-intrinsic-size: auto var(" + ROW_HEIGHT_VAR + ", 200px);",
			"}",
			"[" + CONTAINER_ATTR + "] {",
			"  will-change: scroll-position;",
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
				rowLists: new Map(),
				fastQueue: new Set(),
				fastHandle: null,
				fastKind: null,
				fastBudgetUntil: 0,
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
					fastPasses: 0,
					fastRows: 0,
					lastScanMs: 0,
					lastScanAt: 0
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
			// (candidate collection, row-list discovery). Marking visible rows
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
			if (state.observer) {
				state.observer.disconnect();
				state.observer = null;
			}

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

		//#region row discovery
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

		function measureAndMark(row, rec) {
			if (!state || !isElement(row) || !isConnected(row)) return false;

			// Never re-measure an already marked row. With content-visibility:auto
			// an offscreen row reports its contain-intrinsic-size, not its real
			// height; measuring it again would shrink the placeholder and make the
			// scrollbar jump. The first measurement is the real one.
			if (row.hasAttribute(ROW_ATTR)) {
				if (rec) rec.rows.add(row);
				return true;
			}

			const cs = getRowStyle(row);
			if (!cs) {
				state.stats.skipped++;
				return false;
			}

			const height = measureRow(row, cs);
			if (!(height > 0)) {
				state.stats.skipped++;
				return false;
			}

			const value = Math.max(1, Math.round(height)) + "px";
			if (row.style.getPropertyValue(ROW_HEIGHT_VAR) !== value) {
				row.style.setProperty(ROW_HEIGHT_VAR, value);
			}
			row.setAttribute(ROW_ATTR, "");
			state.stats.marked++;
			if (rec) rec.rows.add(row);
			return true;
		}

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
				phase: "candidates",
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
				rowIndex: 0,
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
			// cheap selector pass already found a scroll container, skip it — a
			// view that just mounted reaches its rows several slices sooner.
			if (work.candidates.length === 0 && !work.usedOverflow) {
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
					work.rowQueue.push(row);
					work.rowOwner.set(row, record.container);
				}
			}
			work.rowIndex = 0;
			work.phase = "rows";
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

		function runFastPass() {
			if (!state || !state.enabled || state.disposed) return;
			if (isScrolling()) {
				scheduleScan("fast-pass-scroll");
				return;
			}

			const vh = viewportHeight();
			const roots = Array.from(state.fastQueue);
			state.fastQueue.clear();

			let targets;
			if (roots.length > 0) {
				const seen = new Set();
				targets = [];
				for (const root of roots) {
					const target = nearestScrollContainer(root);
					if (target && !seen.has(target)) {
						seen.add(target);
						targets.push(target);
					}
				}
				if (targets.length === 0) targets = collectFastCandidates();
			} else {
				targets = collectFastCandidates();
			}

			let marked = 0;
			let reads = 0;
			const bandTop = vh * FAST_PASS_BAND_RATIO;
			const bandBottom = -vh * 0.5;

			for (const target of targets) {
				const found = findRowList(target);
				if (!found) continue;
				const rec = ensureContainer(target);

				for (const row of found.rows) {
					if (marked >= FAST_PASS_MAX_ROWS || reads >= FAST_PASS_MAX_READS) break;
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
					if (rect.bottom < bandBottom || rect.top > bandTop) continue;
					if (measureAndMark(row, rec)) marked++;
				}

				if (marked >= FAST_PASS_MAX_ROWS || reads >= FAST_PASS_MAX_READS) break;
			}

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
						if (rowsThisSlice >= MAX_ROWS_PER_SLICE) break;
						const row = work.rowQueue[work.rowIndex++];
						const owner = work.rowOwner.get(row);
						const rec = owner ? ensureContainer(owner) : null;
						measureAndMark(row, rec);
						rowsThisSlice++;
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
		function setupObserver() {
			if (!state || state.observer) return;
			if (typeof MutationObserver !== "function") return;
			const root = document.body || document.documentElement;
			if (!root) return;

			state.observer = new MutationObserver((mutations) => {
				let elementAdded = false;
				for (const mutation of mutations) {
					for (const node of mutation.addedNodes) {
						if (isElement(node)) {
							elementAdded = true;
							break;
						}
					}
					if (elementAdded) break;
				}
				if (!elementAdded) return;

				if (state.mutationTimer !== null) clearTimeout(state.mutationTimer);
				state.mutationTimer = setTimeout(() => {
					if (!state) return;
					state.mutationTimer = null;
					if (!state.enabled) return;
					state.scanWork = null;
					// A freshly mounted view (for example the trace panel) should
					// get its visible rows marked on the next frame instead of
					// waiting for the gentle idle scan.
					scheduleFastPass();
					scheduleScan("mutation");
				}, MUTATION_DEBOUNCE_MS);
			});
			state.observer.observe(root, { childList: true, subtree: true });
		}
		//#endregion

		//#region public api
		function report() {
			if (!state) {
				return { version: VERSION, enabled: false, disposed: true };
			}
			let rows = 0;
			try { rows = document.querySelectorAll("[" + ROW_ATTR + "]").length; } catch (_) { /* ignore */ }
			return {
				version: VERSION,
				enabled: state.enabled,
				containers: state.containers.size,
				hinted: state.stats.hinted,
				rows,
				marked: state.stats.marked,
				skipped: state.stats.skipped,
				scans: state.stats.scans,
				lastScanMs: state.stats.lastScanMs,
				lastScanAt: state.stats.lastScanAt,
				scrolling: isScrolling(),
				fastPasses: state.stats.fastPasses,
				fastRows: state.stats.fastRows,
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
