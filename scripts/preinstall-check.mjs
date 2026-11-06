/**
 * Pre-install gate: everything that must be true BEFORE installing the bundle
 * into a profile. Static checks only (no profile or Obsidian state touched).
 *
 * Usage: node scripts/preinstall-check.mjs
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const notes = []

function pass(message) {
  console.log(`PASS  ${message}`)
}
function fail(message) {
  failures.push(message)
  console.log(`FAIL  ${message}`)
}
function note(message) {
  notes.push(message)
  console.log(`NOTE  ${message}`)
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const allFiles = walk(root)
const runtimeJs = allFiles.filter((f) => f.endsWith('.js') && !f.includes(`${path.sep}test${path.sep}`) && !f.includes(`${path.sep}scripts${path.sep}`))
const testJs = allFiles.filter((f) => f.endsWith('.js') && (f.includes(`${path.sep}test${path.sep}`) || f.includes(`${path.sep}scripts${path.sep}`)))

// 1. syntax
for (const file of [...runtimeJs, ...testJs]) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    fail(`syntax: ${path.relative(root, file)} — ${String(error.stderr || error.message).split('\n')[0]}`)
  }
}
if (!failures.length) pass(`syntax: ${runtimeJs.length + testJs.length} JS files parse`)

// 2. runtime imports must be relative or node builtins
const BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'crypto', 'events', 'fs', 'http', 'https', 'net', 'os',
  'path', 'process', 'stream', 'string_decoder', 'timers', 'tty', 'url', 'util', 'zlib',
])
const importRe = /(?:^|\n)\s*(?:import\s[^;]*?from\s*|import\s*|export\s[^;]*?from\s*|await\s+import\s*\(\s*)['"]([^'"]+)['"]/g
for (const file of runtimeJs) {
  const source = fs.readFileSync(file, 'utf8')
  let match
  while ((match = importRe.exec(source)) !== null) {
    const specifier = match[1]
    const ok =
      specifier.startsWith('./') ||
      specifier.startsWith('../') ||
      specifier.startsWith('node:') ||
      BUILTINS.has(specifier.split('/')[0])
    if (!ok) fail(`import: ${path.relative(root, file)} imports "${specifier}" (must be relative or node builtin)`)
  }
}
if (!failures.some((f) => f.startsWith('import:'))) pass('imports: every runtime import is relative or a node builtin')

// 3. no ESM/CJS mixing or browser globals in the Host half (client.js IS the browser half)
const hostJs = runtimeJs.filter((file) => path.basename(file) !== 'client.js')
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
for (const file of hostJs) {
  const source = stripComments(fs.readFileSync(file, 'utf8'))
  if (/\brequire\s*\(/.test(source)) fail(`cjs: ${path.relative(root, file)} calls require()`)
  for (const name of ['window', 'document', 'localStorage', 'sessionStorage']) {
    if (!new RegExp(`(?:^|[^.\\w$])${name}\\s*\\.`, 'm').test(source)) continue
    // A local `const window = …` (e.g. a sliding window in a text chunker) is fine.
    const shadowed =
      new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`).test(source) ||
      new RegExp(`\\(\\s*${name}\\s*[,)]`).test(source)
    if (!shadowed) fail(`browser-global: ${path.relative(root, file)} touches the DOM global "${name}"`)
  }
}
if (!failures.some((f) => f.startsWith('cjs:') || f.startsWith('browser-global:'))) {
  pass(`host half: no require(), no DOM globals (${hostJs.length} files)`)
}

// 4. JSON resources
const readJson = (relative) => {
  const full = path.join(root, relative)
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8'))
  } catch (error) {
    fail(`json: ${relative} — ${error.message}`)
    return undefined
  }
}
const pkg = readJson('package.json')
const localeEn = readJson('locale/en.json')
const localeZh = readJson('locale/zh.json')
if (pkg && localeEn && localeZh) pass('json: package.json + locale/en.json + locale/zh.json parse')

// 5. manifest
if (pkg) {
  if (pkg.name !== 'dsh-obsidian-hub') fail(`manifest: name is ${JSON.stringify(pkg.name)}`)
  if (pkg.type !== 'module') fail('manifest: type must be "module"')
  if (!pkg.dsh || !pkg.dsh.bundle || !pkg.dsh.bundle.patch) fail('manifest: dsh.bundle.patch missing')
  if (!pkg.dsh || !pkg.dsh.client || pkg.dsh.client.platform !== 'web') fail('manifest: dsh.client.platform must be "web"')
  for (const [key, target] of Object.entries(pkg.exports || {})) {
    if (typeof target !== 'string') continue
    if (!key.includes('*') && !fs.existsSync(path.join(root, target))) fail(`manifest: export "${key}" -> ${target} does not exist`)
  }
  const files = pkg.files || []
  for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'lib/*.js', 'locale/*.json']) {
    if (!files.includes(required)) fail(`manifest: files[] omits "${required}"`)
  }
  if (!failures.length) pass('manifest: name/type/patch/client/exports/files consistent')
}

// 6. locale meta
for (const [name, locale] of [['en', localeEn], ['zh', localeZh]]) {
  if (!locale || !locale.meta || typeof locale.meta.title !== 'string' || typeof locale.meta.description !== 'string') {
    fail(`locale: locale/${name}.json lacks meta.title/meta.description`)
  } else if (locale.meta.title.length < 2 || locale.meta.description.length < 10) {
    fail(`locale: locale/${name}.json meta text is placeholder-like`)
  }
}
if (!failures.some((f) => f.startsWith('locale:'))) pass('locale: meta.title + meta.description present in en and zh')

// 7. icon
const iconPath = path.join(root, 'icon.svg')
const icon = fs.readFileSync(iconPath)
if (icon.length > 256 * 1024) fail(`icon: ${icon.length} bytes exceeds 256 KiB`)
if (!/^<svg[\s>]/.test(icon.toString('utf8').trimStart()) || !icon.toString('utf8').trimEnd().endsWith('</svg>')) {
  fail('icon: icon.svg is not a well-formed <svg> document')
}
if (/https?:\/\//.test(icon.toString('utf8').replace(/xmlns="[^"]*"/g, ''))) fail('icon: icon.svg references an external URL')
if (!/viewBox=/.test(icon.toString('utf8'))) fail('icon: icon.svg has no viewBox (will not scale)')
if (!fs.existsSync(path.join(root, 'package.json'))) fail('icon: package.json missing')
if (!failures.some((f) => f.startsWith('icon:'))) pass(`icon: valid svg, ${icon.length} bytes, no external refs`)

// 8. patch
const patchPath = path.join(root, 'cordis.patch.yml')
const patch = fs.readFileSync(patchPath, 'utf8')
if (!/^\s*-\s*insert:/m.test(patch)) fail('patch: no "- insert:" entry')
if (!/id:\s*obsidian-hub/.test(patch)) fail('patch: no row id "obsidian-hub"')
if (!/name:\s*dsh-obsidian-hub/.test(patch)) fail('patch: row name is not the package name')
if (!/^\s{6}config:/m.test(patch)) fail('patch: inserted row has no config block')
if (!failures.some((f) => f.startsWith('patch:'))) pass('patch: inserts row "obsidian-hub" (dsh-obsidian-hub) with a config block')

// 9. disk surface: what the linked install will expose
const shipped = allFiles.filter((f) => {
  const rel = path.relative(root, f).replace(/\\/g, '/')
  return !rel.startsWith('test/') && !rel.startsWith('scripts/') && !rel.endsWith('.md')
})
pass(`linked install surface: ${shipped.length} runtime files`)

// 10. static tool surface
const registered = new Map()
const fakeCtx = {
  tools: {
    register(definition) {
      if (registered.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  },
  effect: (fn) => fn(),
  inject: () => {},
}
const { apply } = await import(pathToFileURL(path.join(root, 'index.js')).href)
apply(fakeCtx, { vaultPath: path.join(root, 'README.md'), autoDetect: false })
const names = [...registered.keys()].sort()
if (names.length !== 8) fail(`tools: expected 8 registered, got ${names.length} (${names.join(', ')})`)
for (const [name, definition] of registered) {
  if (!/^obsidian_/.test(name)) fail(`tools: ${name} does not use the obsidian_ prefix`)
  if (definition.parameters.type !== 'object') fail(`tools: ${name} parameters is not an object schema`)
  if (JSON.stringify(definition).includes('"required":true')) fail(`tools: ${name} still carries inline required:true`)
  if (!definition.output || definition.output.schema.type !== 'object') fail(`tools: ${name} output.schema is not an object schema`)
}
if (!failures.some((f) => f.startsWith('tools:'))) pass(`tools: ${names.join(', ')}`)

// 11. placeholder scan
for (const file of runtimeJs) {
  const source = fs.readFileSync(file, 'utf8')
  for (const pattern of [/\bTODO\b/, /\bFIXME\b/, /\bXXX\b/, /\bnot implemented\b/i, /\bdummy\b/i]) {
    if (pattern.test(source)) note(`placeholder: ${path.relative(root, file)} matches ${pattern}`)
  }
}

console.log(`\n${failures.length === 0 ? 'PRE-INSTALL GATE PASSED' : `PRE-INSTALL GATE FAILED (${failures.length})`}`)
if (failures.length) {
  for (const failure of failures) console.log(` - ${failure}`)
  process.exitCode = 1
}
