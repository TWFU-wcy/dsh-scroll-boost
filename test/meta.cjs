'use strict'
/**
 * Plugin display metadata check (title / description / icon).
 *
 * DSH reads a plugin's display text from `<specifier>/locale/<lang>.json`
 * (`meta.title`, `meta.description`) and falls back to package.json
 * `name` / `description`; the icon comes from the manifest `icon` field.
 * Those resources must be exported, the locale files must live beside
 * `en.json`, and the icon must be a relative path inside the package and
 * at most 256 KiB.
 *
 * This test mirrors those rules against the real package so a typo in the
 * manifest fails here instead of silently showing the raw package name.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')

const root = path.resolve(__dirname, '..')
const requireFromRoot = createRequire(path.join(root, 'package.json'))
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u
const MAX_ICON_BYTES = 256 * 1024
const ICON_MEDIA_TYPES = new Map([
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
])

/** Resolve an exported package resource the way the host does. */
function resolveResource(specifier) {
  return requireFromRoot.resolve(specifier)
}

// The English locale file anchors the directory: without it no locale is read.
const englishPath = resolveResource(`${manifest.name}/locale/en.json`)
assert.ok(fs.existsSync(englishPath), 'locale/en.json must exist and be exported')

const dictionaries = new Map()
for (const entry of fs.readdirSync(path.dirname(englishPath))) {
  if (!entry.endsWith('.json')) continue
  const language = entry.slice(0, -5)
  assert.match(language, LANGUAGE_ID, `locale/${entry} must be named after a language id`)
  const parsed = JSON.parse(fs.readFileSync(resolveResource(`${manifest.name}/locale/${entry}`), 'utf8'))
  const meta = parsed.meta || {}
  for (const field of ['title', 'description']) {
    if (meta[field] === undefined) continue
    assert.equal(typeof meta[field], 'string', `locale/${entry}: meta.${field} must be a string`)
    assert.ok(meta[field].trim().length > 0, `locale/${entry}: meta.${field} must not be blank`)
  }
  dictionaries.set(language.toLowerCase(), meta)
}

assert.ok(dictionaries.has('en'), 'an English dictionary is required')
assert.ok(dictionaries.has('zh'), 'a Chinese dictionary is required for the zh UI')

// A package-root specifier also reads package.json for fallbacks and the icon.
const manifestPath = resolveResource(`${manifest.name}/package.json`)
assert.equal(fs.realpathSync(manifestPath), fs.realpathSync(path.join(root, 'package.json')))

for (const [language, meta] of dictionaries) {
  assert.ok(meta.title, `locale/${language}.json must set meta.title`)
  assert.ok(meta.description, `locale/${language}.json must set meta.description`)
}

assert.notEqual(
  dictionaries.get('zh').description,
  dictionaries.get('en').description,
  'the Chinese description must not be a copy of the English one',
)

// Icon: relative, inside the package, known media type, within the size cap.
assert.equal(typeof manifest.icon, 'string', 'package.json must declare an icon')
assert.ok(!path.isAbsolute(manifest.icon), 'icon must be a relative path')
const iconPath = path.resolve(root, manifest.icon)
assert.ok(
  !path.relative(root, iconPath).startsWith('..'),
  'icon must stay inside the package directory',
)
const mediaType = ICON_MEDIA_TYPES.get(path.extname(iconPath).toLowerCase())
assert.ok(mediaType, 'icon must be SVG, PNG, JPEG or WebP')
const bytes = fs.statSync(iconPath).size
assert.ok(bytes <= MAX_ICON_BYTES, `icon must be at most 256 KiB (is ${bytes} bytes)`)

// The icon has to ship: `files` must cover it and the locale directory.
const files = manifest.files || []
assert.ok(files.includes('locale'), '"files" must include the locale directory')
assert.ok(files.includes(manifest.icon.replace(/^\.\//, '')), '"files" must include the icon')
assert.ok(
  manifest.exports['./locale/*.json'] === './locale/*.json',
  'exports must expose ./locale/*.json',
)

console.log(
  `meta test passed — ${manifest.name}@${manifest.version}: ` +
    `en="${dictionaries.get('en').title}", zh="${dictionaries.get('zh').title}", icon=${bytes}B`,
)
