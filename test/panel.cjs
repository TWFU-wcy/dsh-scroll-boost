'use strict'
/**
 * Settings panel test (0.8.0).
 *
 * The panel is React inside a slot. This test supplies a minimal React stand-in
 * so the component's *logic* can be exercised without a renderer: what it reads,
 * what it writes, and above all that it never throws when the engine is absent
 * (a throwing component blanks the whole slot entry, which is the one failure
 * mode the host documentation calls out).
 *
 * It asserts:
 *
 *   1. the slot registration shape is what `settings.section` declares;
 *   2. the panel registers under the id "dsh-scroll-boost";
 *   3. a render with no engine does not throw;
 *   4. a render with a live engine lists the scopes, and the button writes
 *      through to exclude()/include();
 *   5. an excluded page is still listed (from report().excluded) so it can be
 *      turned back on - it has no marks left, so scopes() cannot see it.
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
      ${Array.from({ length: 12 }, (_, i) => `<div class="turn" data-chat-flow-key="p-${i}">turn ${i}</div>`).join('')}
    </div>
  </div>
  <!-- A third-party dashboard: a large scroll area full of cards. The idle
       scanner was never pointed at it, but discoverAll() must still list it,
       because the page is supposed to show everything at once. -->
  <div class="lc-root">
    <div class="lc-ov-pagescroll" id="dash" style="overflow-y:auto">
      <div id="dashInner">
        ${Array.from({ length: 20 }, (_, i) => `<div class="lc-ov-session">card ${i}</div>`).join('')}
      </div>
    </div>
  </div>
</body></html>`

// A very small React stand-in: enough for createElement + hooks as the panel
// uses them. `render()` collects the element tree so assertions can inspect it
// without a DOM renderer.
function makeReact() {
  const states = []
  let cursor = 0
  return {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat() }
    },
    Fragment: 'fragment',
    useState(initial) {
      const i = cursor++
      if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        states[i] = typeof next === 'function' ? next(states[i]) : next
        states.__dirty = true
      }
      return [states[i], set]
    },
    useEffect(fn) {
      states.__effects = states.__effects || []
      states.__effects.push(fn)
    },
    useRef(initial) { return { current: initial } },
    useMemo(fn) { return fn() },
    useCallback(fn) { return fn },
    __reset() { cursor = 0; states.length = 0; states.__dirty = false; states.__effects = [] },
    __state: states
  }
}

function boot() {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' })
  const { window } = dom
  const { document } = window
  window.innerHeight = 768

  const heights = new WeakMap()
  const setHeight = (el, h) => heights.set(el, h)
  setHeight(document.getElementById('scroller'), 600)
  setHeight(document.getElementById('flow'), 1400)
  for (const t of document.querySelectorAll('.turn')) setHeight(t, 100)
  setHeight(document.getElementById('dash'), 600)
  setHeight(document.getElementById('dashInner'), 2600)
  for (const c of document.querySelectorAll('.lc-ov-session')) setHeight(c, 130)

  window.Element.prototype.getBoundingClientRect = function () {
    const h = heights.get(this) || 0
    return { width: h > 0 ? 800 : 0, height: h, top: 0, left: 0, right: h > 0 ? 800 : 0, bottom: h, x: 0, y: 0, toJSON() {} }
  }
  const scroller = document.getElementById('scroller')
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 600 })
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1400 })
  const dash = document.getElementById('dash')
  Object.defineProperty(dash, 'clientHeight', { configurable: true, value: 600 })
  Object.defineProperty(dash, 'scrollHeight', { configurable: true, value: 2600 })

  const storage = {}
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v) },
      removeItem: (k) => { delete storage[k] }
    }
  })

  window.ResizeObserver = class { constructor() {} observe() {} unobserve() {} disconnect() {} }

  const registrations = []
  const React = makeReact()
  const slots = {
    inject(owner, cb) { cb(); return () => {} },
    register(options, component) { registrations.push({ options, component }); return () => {} }
  }

  window.__ModuleLoader__ = {
    load({ factory }) {
      // The panel asks for React through the browser module table.
      window.__x = factory((spec) => {
        if (spec === 'react') return React
        throw new Error('unexpected require: ' + spec)
      })
    }
  }
  window.eval(source)

  // Cordis projects a service onto `ctx` only for names listed in the plugin's
  // own `inject`. Model that here instead of handing `ctx.slots` over directly:
  // handing it over is exactly what hid the shipped bug, because a plugin with
  // `inject: []` really does get `ctx.slots === undefined` in the browser.
  const services = { slots }
  const ctx = {
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} }
  }
  for (const name of (window.__x.inject || [])) {
    if (services[name] !== undefined) ctx[name] = services[name]
  }
  ctx.get = (name) => (ctx[name] !== undefined ? ctx[name] : undefined)

  window.__x.apply(ctx)
  return { dom, window, document, registrations, React, storage, ctx }
}

function textOf(node) {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return (node.children || []).map(textOf).join(' ')
}

function findAll(node, predicate, out = []) {
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  for (const child of node.children || []) findAll(child, predicate, out)
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const { dom, window, document, registrations, React, storage: bootStorage } = boot()
  await sleep(700)

  // 0: the declaration that makes the page reachable at all. Cordis only
  //    projects a service onto `ctx` when the plugin lists it in `inject`, so a
  //    plugin with `inject: []` gets `ctx.slots === undefined` and the settings
  //    page is skipped in silence. That was the shipped bug.
  assert.ok(
    Array.isArray(window.__x.inject) && window.__x.inject.includes('slots'),
    "the client export must declare 'slots' in inject, or ctx.slots is undefined"
  )

  // 1 + 2: the registration is the shape settings.section declares.
  assert.equal(registrations.length, 1, 'the plugin must register exactly one settings section')
  const reg = registrations[0]
  assert.equal(reg.options.name, 'settings.section')
  // The id stays the package name (the slot system keys on it), but the visible
  // label must not carry the "dsh-" prefix: it is a product name, not a package
  // specifier. It is fixed English so the entry is findable whichever language
  // the panel itself is set to.
  assert.equal(reg.options.id, 'dsh-scroll-boost', 'the slot id must stay stable')
  assert.equal(typeof reg.component, 'function')
  const labelValue = typeof reg.options.label === 'function' ? reg.options.label() : reg.options.label
  assert.equal(labelValue, 'Scroll Boost', 'the settings entry must read "Scroll Boost"')
  assert.equal(/^dsh-/.test(labelValue), false, 'the settings label must not start with "dsh-"')

  const Panel = reg.component

  // 3: no engine -> no throw, and an explanatory line instead.
  const savedApi = window.__scrollBoost
  delete window.__scrollBoost
  React.__reset()
  let noEngine = null
  assert.doesNotThrow(() => { noEngine = Panel({}) }, 'a panel without the engine must not throw')
  assert.ok(textOf(noEngine).length > 0, 'it must still explain itself')
  window.__scrollBoost = savedApi

  // 4: with the engine, the page renders the catalogue and the live list.
  React.__reset()
  const tree = Panel({})
  const treeText = textOf(tree)

  // 4a-pre: the catalogue is the point of the page. It must name the surfaces
  //   the plugin helps with *without* that surface being mounted here - the
  //   trajectory panel is the canonical example, and the fixture has none.
  const cat = window.__scrollBoost.catalog()
  assert.ok(cat.length >= 6, `the catalogue must list every known surface (got ${cat.length})`)
  const traj = cat.find((c) => c.id === 'trajectory')
  assert.ok(traj, 'the trajectory surface must be catalogued')
  assert.equal(traj.present, false, 'the fixture has no trajectory panel, so it is not present')
  assert.ok(traj.label.zh && traj.label.en, 'every catalogue entry needs both languages')
  assert.ok(traj.note.zh && traj.note.en, 'every catalogue entry needs an explanation in both languages')
  const chatCat = cat.find((c) => c.id === 'chat-flow')
  assert.ok(chatCat && chatCat.present === true, 'the chat surface is on this page')
  assert.equal(cat[0].present, true, 'surfaces present here must sort first')
  assert.ok(/轨迹面板/.test(treeText), 'the trajectory panel must be named on the page even though it is not open')
  assert.ok(/不在此页/.test(treeText), 'a surface that is not here must say so')

  // The default view must be readable: a human name, a count, and a state -
  // never a CSS selector or a raw identifier.
  assert.ok(/聊天记录/.test(treeText), `the scope must be named in plain words (got "${treeText.slice(0, 160)}")`)
  assert.ok(/已折叠 12 条内容/.test(treeText), 'the row must say how much work it is doing')
  assert.ok(/加速中/.test(treeText), 'the row must show its state')
  assert.ok(/语言/.test(treeText) && /中文/.test(treeText) && /English/.test(treeText),
    'a language switch must be present')
  assert.equal(
    /div\.|data-chat-flow-key|lc-ov/.test(treeText),
    false,
    'the default view must not leak CSS selectors or attribute names'
  )

  // 4b: the catalogue switch works on a *kind*, and it works even though the
  //     surface it names is not on this page. This is the whole point of putting
  //     controls in the catalogue: a reader can switch off a page they have not
  //     opened yet.
  const beforeKind = window.__scrollBoost.catalog().find((c) => c.id === 'trajectory')
  assert.equal(beforeKind.excluded, false)
  const kindOff = window.__scrollBoost.excludeKind('trajectory')
  assert.equal(kindOff.ok, true, 'switching a catalogued kind off must succeed')
  const afterKind = window.__scrollBoost.catalog().find((c) => c.id === 'trajectory')
  assert.equal(afterKind.excluded, true)
  assert.equal(afterKind.excludedByKind, true, 'the reason must be recorded as a kind switch')
  // It survives a restart: the preference is stored under its own key.
  assert.ok(bootStorage['dsh-scroll-boost.excludedKinds.v1'], 'the kind switch must be persisted')
  assert.ok(
    bootStorage['dsh-scroll-boost.excludedKinds.v1'].indexOf('trajectory') !== -1,
    'the stored value must name the surface id'
  )
  // An unknown id must be refused rather than stored as a dead switch.
  assert.equal(window.__scrollBoost.excludeKind('not-a-surface').ok, false)
  window.__scrollBoost.includeKind('trajectory')
  assert.equal(window.__scrollBoost.catalog().find((c) => c.id === 'trajectory').excluded, false)

  // 4c: switching off the chat kind must actually remove the marks, and must
  //     keep them off after the scanner runs again.
  const chatMarked = () => document.querySelectorAll('[data-chat-flow-key][data-scrollboost-row]').length
  assert.ok(chatMarked() > 0, 'the chat rows start marked')
  window.__scrollBoost.excludeKind('chat-flow')
  await sleep(400)
  assert.equal(chatMarked(), 0, 'a kind switch must clear the marks, and keep them cleared after a rescan')
  window.__scrollBoost.includeKind('chat-flow')
  await sleep(400)

  // 4a: one pass lists everything, not just what the idle scanner has adopted.
  //     The fixture also holds a large third-party scroll area the scanner never
  //     touched; discoverAll() must still find it.
  const listed = window.__scrollBoost.discoverAll()
  assert.ok(listed.length >= 2, `discoverAll must list every optimizable area (got ${listed.length})`)
  assert.ok(
    listed.some((s) => /market|lc-ov/.test(s.className)),
    'a third-party scroll area must appear even though the scanner ignored it'
  )

  // 4b: enabled entries are pinned above disabled ones.
  const pinTarget = listed[listed.length - 1]
  window.__scrollBoost.exclude(pinTarget.key)
  const afterPin = window.__scrollBoost.discoverAll()
  const firstOff = afterPin.findIndex((s) => s.excluded)
  const lastOn = afterPin.map((s) => s.excluded).lastIndexOf(false)
  assert.ok(firstOff !== -1 && firstOff > lastOn, 'every enabled entry must sort above every disabled one')
  window.__scrollBoost.include(pinTarget.key)

  const buttons = findAll(tree, (n) => n.type === 'button')
  assert.ok(buttons.length >= 2, 'there must be an exclude control and a rescan control')

  const before = window.__scrollBoost.scopes()
  assert.ok(before.length >= 1, 'the conversation must be listed as a scope')

  // Find the action button of the first *live* row - the catalogue rows above
  // carry no controls, so the row is located by its button, not its position.
  const firstListed = window.__scrollBoost.discoverAll()[0]
  const target = { key: firstListed.key }
  const markers = ['关掉加速', '恢复加速', 'Turn off', 'Turn on again']
  // Both sections carry "turn off" buttons now: the catalogue switches a surface
  // *kind* off, the live list switches one *container* off. The rows render in
  // the same order the API reports, so the first live row is the first entry of
  // discoverAll() - its control is the action that follows the catalogue's.
  const allActions = findAll(tree, (n) => n.type === 'button' && markers.indexOf(textOf(n)) !== -1)
  const catalogueCount = window.__scrollBoost.catalog().length
  assert.ok(
    allActions.length >= catalogueCount + 1,
    `the catalogue (${catalogueCount}) and the live list both need controls, got ${allActions.length}`
  )
  const actionButton = allActions[catalogueCount]
  assert.ok(actionButton, 'the live list must carry an action button')

  React.__reset()
  actionButton.props.onClick()
  await sleep(200)

  const afterExclude = window.__scrollBoost.scopes()
  const stillThere = afterExclude.find((s) => s.key === target.key)
  assert.ok(stillThere, 'an excluded scope stays listed, carrying its own way back')
  assert.equal(stillThere.excluded, true, 'it is reported as off')
  assert.equal(stillThere.rows, 0, 'nothing is marked inside it any more')
  assert.equal(stillThere.hinted, false, 'its compositor hint is gone too')
  assert.ok(
    (window.__scrollBoost.report().excluded || []).includes(target.key),
    'the excluded key is also reported in report().excluded'
  )

  // 5: re-render offers the way back, from the same row.
  React.__reset()
  const tree2 = Panel({})
  const restoreButtons = findAll(tree2, (n) => n.type === 'button' && /恢复加速|Turn on again/.test(textOf(n)))
  assert.ok(
    restoreButtons.length >= 1,
    'an excluded page must offer a way to turn it back on'
  )

  React.__reset()
  restoreButtons[0].props.onClick()
  await sleep(400)
  const restored = window.__scrollBoost.scopes().find((s) => s.key === target.key)
  assert.ok(restored, 'restoring keeps the scope listed')
  assert.equal(restored.excluded, false, 'it is no longer off')

  // 6: language. Chinese by default with no host locale, English when the host
  //    says so, and an explicit pick outranks the host and is remembered.
  const storageRef = bootStorage
  delete storageRef['dsh-scroll-boost.panelLang.v1']
  React.__reset()
  const zhDefault = textOf(Panel({}))
  assert.ok(/滚动加速/.test(zhDefault), 'Chinese must be the default when the host gives no locale')
  assert.equal(/Scroll Boost/.test(zhDefault), false)

  React.__reset()
  const enFromHost = textOf(Panel({ locale: 'en' }))
  assert.ok(/Scroll Boost/.test(enFromHost), 'an English host locale must render English')

  React.__reset()
  const zhFromHost = textOf(Panel({ locale: 'zh-CN' }))
  assert.ok(/滚动加速/.test(zhFromHost), 'a Chinese host locale must render Chinese')

  // Switch to English through the control, then confirm it persisted and that a
  // later render ignores the host locale in favour of the saved pick.
  React.__reset()
  const switchTree = Panel({ locale: 'zh-CN' })
  const enBtn = findAll(switchTree, (n) => n.type === 'button' && textOf(n) === 'English')[0]
  assert.ok(enBtn, 'the language switch must offer English')
  React.__reset()
  enBtn.props.onClick()
  assert.equal(
    storageRef['dsh-scroll-boost.panelLang.v1'],
    'en',
    'the pick must be stored so it survives a restart'
  )

  React.__reset()
  const afterPick = textOf(Panel({ locale: 'zh-CN' }))
  assert.ok(
    /Scroll Boost/.test(afterPick),
    'a saved pick must outrank the host locale'
  )
  assert.equal(/滚动加速/.test(afterPick), false)

  window.__cleanup && window.__cleanup()
  dom.window.close()
  console.log('settings panel test passed — registration, plain-language view, language switch, exclude/restore')
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
