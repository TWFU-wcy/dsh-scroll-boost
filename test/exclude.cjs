'use strict'
/**
 * Exclusion test (0.8.0).
 *
 * The plugin finds row lists by shape, and shape cannot tell a transcript from
 * a page of cards whose height depends on their content. When such a page
 * scrolls worse with the plugin than without it, the user needs a way to say
 * "not this page" without uninstalling or disabling everything.
 *
 * This test asserts the escape hatch actually is an escape hatch:
 *
 *   1. `scopes()` lists the containers the plugin is working on;
 *   2. `exclude(key)` removes every mark inside that container, restores its
 *      styles, and drops its compositor hint;
 *   3. a second container on the same page keeps working untouched;
 *   4. the choice survives a restart (it is stored, not in-memory only);
 *   5. `include()` adopts the container again.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const root = path.resolve(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')

const HTML = `<!doctype html><html><head></head><body>
  <div data-conversation-scroll id="scroller" style="overflow-y:auto">
    <div data-slot="conversation.chat.flow" id="flow">
      ${Array.from({ length: 12 }, (_, i) => `<div class="turn" data-chat-flow-key="c-${i}">turn ${i}</div>`).join('')}
    </div>
  </div>
  <div class="other-plugin-scroll" id="market" style="overflow-y:auto">
    <div id="marketInner">
      ${Array.from({ length: 16 }, (_, i) => `<div class="mk-card">card ${i}</div>`).join('')}
    </div>
  </div>
</body></html>`

function boot(storage) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' })
  const { window } = dom
  const { document } = window
  window.innerHeight = 768

  // localStorage does not exist in jsdom without `url` + storage; use a plain
  // object so a "restart" can be simulated by handing in the same object.
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; }
    }
  })

  const heights = new WeakMap()
  const setHeight = (el, h) => heights.set(el, h)
  setHeight(document.getElementById('scroller'), 600)
  setHeight(document.getElementById('flow'), 1400)
  for (const t of document.querySelectorAll('.turn')) setHeight(t, 100)
  setHeight(document.getElementById('market'), 600)
  setHeight(document.getElementById('marketInner'), 1600)
  for (const c of document.querySelectorAll('.mk-card')) setHeight(c, 100)

  window.Element.prototype.getBoundingClientRect = function () {
    const h = heights.get(this) || 0
    return { width: h > 0 ? 800 : 0, height: h, top: 0, left: 0, right: h > 0 ? 800 : 0, bottom: h, x: 0, y: 0, toJSON() {} }
  }
  for (const [id, ch, sh] of [['scroller', 600, 1400], ['market', 600, 1600]]) {
    const el = document.getElementById(id)
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: ch })
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: sh })
  }
  window.ResizeObserver = class { constructor() {} observe() {} unobserve() {} disconnect() {} }
  window.__ModuleLoader__ = {
    load({ factory }) {
      // This test is about the engine, not the settings page. A minimal React
      // stand-in keeps the page path quiet so a warning here would mean a real
      // problem instead of the harness being unhelpful.
      window.__x = factory((spec) => {
        if (spec === 'react') {
          return {
            createElement: () => null,
            useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
            useEffect: () => {},
            useRef: (initial) => ({ current: initial })
          }
        }
        throw new Error('no require: ' + spec)
      })
    }
  }
  window.eval(source)
  window.__x.apply({
    slots: { inject(owner, cb) { cb(); return () => {} }, register() { return () => {} } },
    effect(fn) { window.__cleanup = fn() }
  })
  return { dom, window, document }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const storage = {}

  // ---- first run: both pages are optimized -------------------------------
  let { dom, window, document } = boot(storage)
  await sleep(700)

  const chatMarked = () => document.querySelectorAll('[data-chat-flow-key][data-scrollboost-row]').length
  const marketMarked = () => document.querySelectorAll('.mk-card[data-scrollboost-row]').length

  assert.ok(chatMarked() >= 10, `conversation rows must be marked (got ${chatMarked()})`)
  assert.equal(marketMarked(), 16, 'the market-style list is adopted by shape, as in 0.7.x')

  // 1. scopes() lists both containers, biggest first, with an accept-able key.
  const scopes = window.__scrollBoost.scopes()
  assert.ok(Array.isArray(scopes))
  assert.ok(scopes.length >= 2, `both scroll containers must be listed (got ${scopes.length})`)
  const marketScope = scopes.find((s) => s.className.indexOf('other-plugin-scroll') !== -1)
  assert.ok(marketScope, 'the market container must be listed by its class signature')
  assert.equal(marketScope.rows, 16)
  assert.equal(typeof marketScope.key, 'string')
  assert.ok(marketScope.key.length > 0)
  assert.equal(marketScope.excluded, false)

  // 2. exclude() restores that container completely.
  const done = window.__scrollBoost.exclude(marketScope.key)
  assert.equal(done.ok, true, 'exclude must succeed for a listed key')
  assert.equal(marketMarked(), 0, 'an excluded container keeps no row marks')
  assert.equal(
    document.getElementById('market').hasAttribute('data-scrollboost-container'),
    false,
    'an excluded container keeps no compositor hint'
  )
  for (const card of document.querySelectorAll('.mk-card')) {
    assert.equal(card.style.getPropertyValue('contain-intrinsic-size'), '', 'pinned heights are removed')
    assert.equal(card.style.getPropertyValue('--sb-h'), '', 'the height readout is removed')
  }

  // 3. The conversation on the same page is untouched.
  assert.ok(chatMarked() >= 10, 'excluding one page must not stop another')
  assert.equal(
    document.getElementById('scroller').hasAttribute('data-scrollboost-container'),
    true,
    'the conversation port keeps its hint'
  )

  // 4. It survives a restart: the choice is stored, not in-memory.
  assert.ok(storage['dsh-scroll-boost.excluded.v1'], 'the exclusion must be persisted')
  window.__cleanup()
  dom.window.close()

  ;({ dom, window, document } = boot(storage))
  await sleep(700)
  assert.equal(
    document.querySelectorAll('.mk-card[data-scrollboost-row]').length,
    0,
    'a stored exclusion must still be honoured after a restart'
  )
  assert.ok(
    document.querySelectorAll('[data-chat-flow-key][data-scrollboost-row]').length >= 10,
    'the conversation is still optimized after the restart'
  )

  // 5. include() adopts the container again.
  const restored = window.__scrollBoost.include()
  assert.equal(restored.ok, true, 'include must remove stored exclusions')
  window.__scrollBoost.scanNow()
  await sleep(600)
  assert.equal(
    document.querySelectorAll('.mk-card[data-scrollboost-row]').length,
    16,
    'the container is adopted again after include()'
  )

  window.__cleanup()
  dom.window.close()
  console.log('exclusion test passed — scope list, per-page opt-out, persistence, restore')
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
