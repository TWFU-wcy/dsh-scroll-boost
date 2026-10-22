const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "lib", "client.js"), "utf8");

const dom = new JSDOM(
  `<!doctype html><html><head></head><body>
    <main id="main">
      <div class="layout" id="layout-a"></div>
      <div class="layout" id="layout-b"></div>
      <div id="list" style="overflow-y:auto">
        <div id="wrapper">
          ${Array.from({ length: 20 }, (_, i) => `<div class="row" data-test-h="100">row ${i}</div>`).join("")}
        </div>
      </div>
    </main>
  </body></html>`,
  { runScripts: "outside-only", pretendToBeVisual: true, url: "http://localhost/" }
);

const { window } = dom;
const { document } = window;
window.innerHeight = 768;

const heights = new WeakMap();
function setHeight(el, height) {
  heights.set(el, height);
}
setHeight(document.getElementById("main"), 700);
setHeight(document.getElementById("layout-a"), 700);
setHeight(document.getElementById("layout-b"), 700);
setHeight(document.getElementById("list"), 600);
setHeight(document.getElementById("wrapper"), 2000);
for (const row of document.querySelectorAll(".row")) setHeight(row, 100);

window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
  const height = heights.get(this) || 0;
  return {
    width: height > 0 ? 800 : 0,
    height,
    top: 0,
    left: 0,
    right: height > 0 ? 800 : 0,
    bottom: height,
    x: 0,
    y: 0,
    toJSON() {}
  };
};

const list = document.getElementById("list");
Object.defineProperty(list, "clientHeight", { configurable: true, value: 600 });
Object.defineProperty(list, "scrollHeight", { configurable: true, value: 2000 });

window.__ModuleLoader__ = {
  load({ id, factory }) {
    assert.equal(id, "dsh-scroll-boost");
    window.__testExports = factory(() => {
      throw new Error("unexpected require");
    });
  }
};

window.eval(source);
const plugin = window.__testExports;
assert.equal(typeof plugin.apply, "function");
assert.equal(Array.isArray(plugin.inject) && plugin.inject.length, 0);

let cleanup = null;
plugin.apply({
  effect(fn) {
    // Cordis runs the effect body immediately and keeps its return value as
    // the disposer.
    cleanup = fn();
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  // jsdom's getComputedStyle is much slower than a real browser's; the plugin
  // deliberately slices its work, so allow several idle slices to finish.
  await sleep(600);

  let report = window.__scrollBoost.report();
  assert.equal(report.rows, 20, "all 20 rows should be marked");
  assert.equal(document.querySelectorAll("[data-scrollboost-row]").length, 20);
  assert.equal(
    document.querySelectorAll(".layout[data-scrollboost-row]").length,
    0,
    "non-scrolling layout children must not be treated as rows"
  );
  assert.equal(list.hasAttribute("data-scrollboost-container"), true);
  const firstRow = document.querySelector(".row");
  assert.equal(firstRow.style.getPropertyValue("--sb-h"), "100px");

  // A marked row must not be measured again: content-visibility:auto makes an
  // offscreen row report its intrinsic placeholder, not its real height.
  setHeight(firstRow, 500);
  window.__scrollBoost.scanNow();
  await sleep(150);
  assert.equal(firstRow.style.getPropertyValue("--sb-h"), "100px", "marked row must keep its first real height");
  setHeight(firstRow, 100);

  // Mutation maintenance: a new row is discovered after the 300ms debounce.
  const extra = document.createElement("div");
  extra.className = "row";
  extra.textContent = "extra";
  setHeight(extra, 100);
  document.getElementById("wrapper").appendChild(extra);
  await sleep(500);
  report = window.__scrollBoost.report();
  assert.equal(report.rows, 21, "new row should be marked after mutation debounce");

  // Disable must restore the DOM; enable must re-apply it.
  window.__scrollBoost.disable();
  assert.equal(document.querySelectorAll("[data-scrollboost-row]").length, 0);
  assert.equal(list.hasAttribute("data-scrollboost-container"), false);
  assert.equal(document.getElementById("dsh-scroll-boost-style"), null);

  window.__scrollBoost.enable();
  await sleep(600);
  assert.equal(document.querySelectorAll("[data-scrollboost-row]").length, 21);

  // Effect cleanup must remove everything and the global API.
  assert.equal(typeof cleanup, "function");
  cleanup();
  assert.equal(window.__scrollBoost, undefined);
  assert.equal(document.querySelectorAll("[data-scrollboost-row]").length, 0);
  assert.equal(document.getElementById("dsh-scroll-boost-style"), null);

  console.log("smoke test passed");
  dom.window.close();
})().catch((error) => {
  console.error(error);
  dom.window.close();
  process.exitCode = 1;
});
