'use strict'
/**
 * Regression test: surfaces, guards and height truth.
 *
 * 0.2.x only ever found rows by walking the DOM for a "list that looks
 * scrollable". DSH renders the chat transcript into a slot whose own box is
 * `display: contents`, so that walk never saw the transcript and the chat
 * page stayed unoptimized. 0.3.0 started addressing the DSH surfaces directly:
 *
 *   - `chat-flow`   rows   - `[data-slot="conversation.chat.flow"]` children
 *   - `conversation-scroll` hint - the scroll port
 *   - `trajectory`  static - rows are rebuilt every frame, so the surface is
 *                     covered by a static stylesheet rule instead of an
 *                     attribute the re-render would wipe
 *
 * The test builds that exact DOM shape and asserts the plugin does the right
 * thing with it, including the cases where it must stay out of the way.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const root = path.resolve(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')

const chatRows = Array.from({ length: 12 }, (_, i) => {
  // The inline style stands in for DSH's stylesheet: jsdom resolves inline
  // styles through getComputedStyle, which is what the guard reads.
  const sticky = i === 4
    ? '<div class="banner" data-code-block-banner style="position: sticky; top: 0">sticky banner</div>'
    : ''
  const motion = i === 7 ? ' data-chat-motion="collapse"' : ''
  return `<div class="turn" data-chat-flow-key="node-${i}"${motion}>
    <div class="body">turn ${i}</div>${sticky}
  </div>`
}).join('')

const dom = new JSDOM(
  `<!doctype html><html><head></head><body>
    <div id="column" data-conversation-content data-conversation-region="chat">
      <div data-conversation-scroll id="scroller">
        <div data-slot="conversation.chat.flow" id="flow">${chatRows}</div>
      </div>
    </div>
    <div data-trajectory-scroll id="traj">
      <table><tbody>
        <tr data-trajectory-row-key="r0"><td>trajectory row 0</td></tr>
        <tr data-trajectory-row-key="r1"><td>trajectory row 1</td></tr>
      </tbody></table>
    </div>
  </body></html>`,
  { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' }
)

const { window } = dom
const { document } = window
window.innerHeight = 768

// jsdom has no layout engine, so the plugin's height reads are stubbed here.
const heights = new WeakMap()
const setHeight = (el, height) => heights.set(el, height)

setHeight(document.getElementById('column'), 900)
setHeight(document.getElementById('scroller'), 600)
setHeight(document.getElementById('flow'), 1400)
setHeight(document.getElementById('traj'), 600)
for (const row of document.querySelectorAll('.turn')) setHeight(row, 100)

window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
  const height = heights.get(this) || 0
  const width = height > 0 ? 800 : 0
  return {
    width, height, top: 0, left: 0, right: width, bottom: height,
    x: 0, y: 0, toJSON() {}
  }
}

const scroller = document.getElementById('scroller')
Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 600 })
Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1400 })

window.__ModuleLoader__ = {
  load({ id, factory }) {
    assert.equal(id, 'dsh-scroll-boost')
    window.__testExports = factory(() => { throw new Error('unexpected require') })
  }
}

window.eval(source)
const plugin = window.__testExports
assert.equal(typeof plugin.apply, 'function')

let cleanup = null
plugin.apply({
  effect(fn) { cleanup = fn() }
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

;(async () => {
  await sleep(500)

  const report = window.__scrollBoost.report()
  const surfaces = new Map(report.surfaces.map((s) => [s.id, s]))

  // 1. The chat transcript is recognized as a surface - this is the case that
  //    0.2.x could not see at all.
  assert.ok(surfaces.has('chat-flow'), 'the chat flow surface must be discovered')
  assert.equal(surfaces.get('chat-flow').kind, 'rows')
  assert.equal(surfaces.get('chat-flow').rows, 12, 'every chat row belongs to the surface')

  // 2. Rows are marked, and the scroll port is hinted instead of marked.
  const turns = Array.from(document.querySelectorAll('.turn'))
  const marked = turns.filter((t) => t.hasAttribute('data-scrollboost-row'))
  assert.ok(marked.length >= 10, `chat rows must be marked (got ${marked.length})`)
  assert.equal(scroller.hasAttribute('data-scrollboost-container'), true, 'the scroll port must be hinted')
  assert.equal(document.getElementById('flow').hasAttribute('data-scrollboost-row'), false)

  // 3. A row containing a sticky banner is marked like any other: containment
  //    only applies while the row is skipped, and a skipped row is off screen,
  //    so the banner is never clipped. (Verified against a real browser: the
  //    placeholder height is what matters, not the sticky descendant.)
  const bannerRow = document.querySelector('.turn:has(.banner)')
  assert.ok(bannerRow, 'the fixture must contain a sticky banner row')
  assert.equal(bannerRow.hasAttribute('data-scrollboost-row'), true, 'a row with a sticky descendant is marked')

  // 3b. When a marked row changes height (a reasoning block expands), the
  //     placeholder is refreshed while the row is still on screen.
  const expandedRow = turns[0]
  setHeight(expandedRow, 240)
  expandedRow.querySelector('.body').setAttribute('data-expanded', '')
  await sleep(80)
  assert.equal(expandedRow.style.getPropertyValue('--sb-h'), '240px', 'an expanded row must re-measure its height')

  // 4. A row that is mid-animation is left alone too.
  const motionRow = turns.find((t) => t.getAttribute('data-chat-motion') === 'collapse')
  assert.ok(motionRow)
  assert.equal(motionRow.hasAttribute('data-scrollboost-row'), false, 'a collapsing row must be skipped')

  // 5. The trajectory surface rebuilds its rows every frame, so no row may
  //    carry an attribute - it would be gone before the frame paints. The
  //    optimization ships as a static stylesheet rule instead.
  const trajRows = Array.from(document.querySelectorAll('#traj tr'))
  assert.equal(trajRows.length, 2)
  for (const row of trajRows) {
    assert.equal(row.hasAttribute('data-scrollboost-row'), false, 'trajectory rows must not carry an attribute')
  }
  assert.ok(surfaces.has('trajectory'), 'the trajectory surface must be recognized')
  assert.equal(surfaces.get('trajectory').kind, 'static')

  const style = document.getElementById('dsh-scroll-boost-style')
  assert.ok(style, 'the plugin must inject its stylesheet')
  const css = style.textContent
  assert.ok(
    css.indexOf('[data-trajectory-scroll] tbody tr[data-record-index]') !== -1,
    'the static trajectory rule must be shipped'
  )
  // The content cell is the only safe target: the event cell paints rails and
  // a boundary control that overflow their box, and turn-start rows paint a
  // separator above their own top edge.
  assert.ok(css.indexOf('> td:last-child') !== -1, 'only the content cell may be skipped')
  for (const excluded of ['data-turn-start', 'data-terminal-request-boundary', 'data-request-only', 'data-collapsed-summary']) {
    assert.ok(css.indexOf(':not([' + excluded + '])') !== -1, `${excluded} rows must be excluded`)
  }

  // 6. The height written to --sb-h is the real content box height.
  const first = marked.find((row) => row !== expandedRow)
  assert.equal(first.style.getPropertyValue('--sb-h'), '100px')

  // 7. Heights survive a restart of the plugin: the second pass reuses the
  //    remembered height instead of measuring again.
  window.__scrollBoost.disable()
  const afterDisable = window.__scrollBoost.report()
  assert.equal(afterDisable.marked, 0)
  window.__scrollBoost.enable()
  await sleep(500)
  const second = window.__scrollBoost.report()
  assert.ok(second.cachedRows > 0, 'the second pass must reuse remembered heights')
  assert.equal(
    document.querySelectorAll('[data-scrollboost-row]').length >= 10,
    true
  )

  assert.equal(typeof cleanup, 'function')
  cleanup()
  assert.equal(window.__scrollBoost, undefined)
  assert.equal(document.querySelectorAll('[data-scrollboost-row]').length, 0)

  console.log('regression test passed — surfaces, guards and height truth')
  dom.window.close()
})().catch((error) => {
  console.error(error)
  dom.window.close()
  process.exitCode = 1
})
