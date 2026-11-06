/**
 * Independent end-to-end verification for dsh-obsidian-hub.
 *
 * Drives the plugin exactly the way the Host does, but with a fake Cordis ctx:
 * `apply(ctx, config)` registers every tool, then each `execute()` is called
 * directly and its result is fed back through `output.render()` + validated
 * against `output.schema`. This proves registration/shape/execute/render
 * compatibility without the GUI.
 *
 * Run with:  node --test test/integration.test.mjs
 * Allowed imports only: node:test, node:assert, node:fs, node:path
 * (node:http is used solely to run an in-test loopback stub for the REST
 * auto-discovery regression — it is a Node builtin, so still zero external deps).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import {
  createFixtureVault,
  createPerfVault,
  cleanupAll,
  fixturePaths,
  NOTES,
  TEMP_BASE_NAME,
} from './fixture.mjs'

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..')
const EXPECTED_TOOLS = [
  'obsidian_read',
  'obsidian_write',
  'obsidian_batch_read',
  'obsidian_batch_write',
  'obsidian_fs',
  'obsidian_search',
  'obsidian_status',
  'obsidian_live',
]
const TOOL_TIMEOUT = 20_000

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

/** Capture-and-call fake Cordis context. Deliberately throws on duplicate names. */
function makeCtx() {
  const registered = new Map()
  const disposers = []
  const ctx = {
    tools: {
      register(def) {
        if (!def || typeof def !== 'object') throw new TypeError('ctx.tools.register: definition must be an object')
        if (typeof def.name !== 'string' || !def.name) throw new TypeError('ctx.tools.register: name is required')
        if (registered.has(def.name)) throw new Error(`tool already registered: ${def.name}`)
        registered.set(def.name, def)
        return () => registered.delete(def.name)
      },
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose !== 'function') throw new TypeError('ctx.effect: callback must return a disposer function')
      disposers.push(dispose)
      return () => {}
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }
  return {
    ctx,
    registered,
    disposers,
    disposeAll() {
      while (disposers.length) {
        const dispose = disposers.pop()
        try {
          dispose()
        } catch {
          /* tolerate */
        }
      }
    },
  }
}

let pluginModule
let loadError
try {
  pluginModule = await import('../index.js')
} catch (error) {
  loadError = error
}

const fixture = createFixtureVault()
const paths = fixturePaths()

function configFor(vaultPath, overrides = {}) {
  return {
    vaultPath,
    autoDetect: false,
    obsidianConfigPath: fixture.registryPath,
    restBaseUrl: 'https://127.0.0.1:27124',
    restApiKey: '',
    restInsecure: true,
    indexTtlMs: 8_000,
    maxFileBytes: 2 * 1024 * 1024,
    defaultReadLimit: 400,
    trashMode: 'trash',
    ...overrides,
  }
}

/** Boot a fresh plugin instance; returns captured registry handle or boot error. */
function boot({ vaultPath = fixture.root, overrides = {} } = {}) {
  const handle = makeCtx()
  if (!pluginModule || typeof pluginModule.apply !== 'function') {
    return { ...handle, error: new Error('plugin module did not export apply()') }
  }
  try {
    pluginModule.apply(handle.ctx, configFor(vaultPath, overrides))
  } catch (error) {
    return { ...handle, error }
  }
  return { ...handle, error: null }
}

const SKIP = loadError ? `plugin not importable: ${loadError.message}` : false
const booted = loadError ? { registered: new Map(), error: loadError } : boot()

function tool(name) {
  const def = booted.registered.get(name)
  assert.ok(def, `${name} is not registered`)
  return def
}

async function exec(name, args) {
  const def = tool(name)
  return def.execute(args || {}, {})
}

async function render(name, args, value) {
  const def = tool(name)
  assert.equal(typeof def.output.render, 'function', `${name}.output.render must be a function`)
  const blocks = await def.output.render(args || {}, value)
  assert.ok(Array.isArray(blocks), `${name}.output.render must return an array`)
  assert.ok(blocks.length > 0, `${name}.output.render must return at least one block`)
  for (const block of blocks) {
    assert.ok(block && typeof block === 'object', `${name}.output.render block must be an object`)
    assert.equal(typeof block.type, 'string', `${name}.output.render block needs a string type`)
    if (block.type === 'text') assert.equal(typeof block.text, 'string', `${name}.output.render text block needs string text`)
  }
  return blocks
}

const SCALARS = {
  string: (v) => typeof v === 'string',
  integer: Number.isInteger,
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  array: Array.isArray,
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  null: (v) => v === null,
}

/** Check that a declared `output.schema` actually covers an execute() result. */
function assertCovers(schema, value, at = 'value') {
  if (!schema) return
  const type = schema.type
  if (type === undefined) return // loose schema node — nothing to prove
  if (type === 'object') {
    assert.ok(SCALARS.object(value), `${at}: execute() returned ${typeof value}, schema says object`)
    const props = schema.properties || {}
    for (const [key, propSchema] of Object.entries(props)) {
      const required = propSchema.required === true || (Array.isArray(schema.required) && schema.required.includes(key))
      if (required) assert.ok(key in value, `${at}.${key}: required but missing from execute() result`)
      if (key in value && value[key] !== undefined) assertCovers(propSchema, value[key], `${at}.${key}`)
    }
    if (schema.additionalProperties === false) {
      const extras = Object.keys(value).filter((key) => !(key in props))
      assert.deepEqual(extras, [], `${at}: additionalProperties:false but returned undeclared keys`)
    }
    return
  }
  if (type === 'array') {
    assert.ok(SCALARS.array(value), `${at}: schema says array, got ${typeof value}`)
    if (Array.isArray(value) && schema.items) value.forEach((item, i) => assertCovers(schema.items, item, `${at}[${i}]`))
    return
  }
  const check = SCALARS[type]
  if (check) assert.ok(check(value), `${at}: schema says ${type}, got ${JSON.stringify(value)?.slice(0, 120)}`)
}

const JSON_SCHEMA_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'array', 'object', 'null'])

/**
 * Registered definitions must be STANDARD JSON Schema (lib/tool-schema.js
 * normalizes them): no inline `required: true` may survive anywhere, because
 * the real `ctx.tools.register()` validator rejects it.
 */
function assertNoInlineRequired(value, at) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoInlineRequired(item, `${at}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (key === 'required') {
      assert.notEqual(child, true, `${at}.required must not be the inline boolean true (registry rejects it)`)
    }
    assertNoInlineRequired(child, `${at}.${key}`)
  }
}

function assertStandardJsonSchema(node, at) {
  assert.ok(node && typeof node === 'object' && !Array.isArray(node), `${at} must be a schema object`)
  if ('type' in node) {
    assert.ok(JSON_SCHEMA_TYPES.has(node.type), `${at}.type must be a JSON Schema type, got ${JSON.stringify(node.type)}`)
  }
  if ('required' in node) {
    assert.ok(Array.isArray(node.required), `${at}.required must be an array of property names in standard JSON Schema`)
    for (const name of node.required) assert.equal(typeof name, 'string', `${at}.required entries must be strings`)
  }
  if ('properties' in node) {
    assert.ok(node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties), `${at}.properties must be an object`)
    for (const [name, child] of Object.entries(node.properties)) {
      assertStandardJsonSchema(child, `${at}.properties.${name}`)
    }
    if (Array.isArray(node.required)) {
      for (const name of node.required) {
        assert.ok(name in node.properties, `${at}.required names "${name}" but properties has no such key`)
      }
    }
  }
  if ('items' in node) assertStandardJsonSchema(node.items, `${at}.items`)
  if ('enum' in node) assert.ok(Array.isArray(node.enum) && node.enum.length > 0, `${at}.enum must be a non-empty array`)
}

const FORBIDDEN_SCHEMA_KEYS = ['default', '$ref', 'pattern', 'format', 'minimum', 'maximum']

/** ARCHITECTURE.md (rev 2026-11-05): these keys are forbidden in model-visible schemas. */
function assertNoForbiddenSchemaKeys(node, at) {
  assert.ok(node && typeof node === 'object' && !Array.isArray(node), `${at} must be a schema node`)
  for (const key of Object.keys(node)) {
    assert.equal(FORBIDDEN_SCHEMA_KEYS.includes(key), false, `${at}.${key} is forbidden in model-visible JSON Schema (put constraints in description + execute())`)
  }
  if (node.properties && typeof node.properties === 'object') {
    for (const [name, child] of Object.entries(node.properties)) assertNoForbiddenSchemaKeys(child, `${at}.properties.${name}`)
  }
  if (node.items && typeof node.items === 'object') assertNoForbiddenSchemaKeys(node.items, `${at}.items`)
  for (const combiner of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(node[combiner])) node[combiner].forEach((child, i) => assertNoForbiddenSchemaKeys(child, `${at}.${combiner}[${i}]`))
  }
}

/** Structural check of one registered tool definition (post-normalization). */
function assertToolDefinition(def) {
  const name = def.name
  assert.equal(typeof def.description, 'string', `${name}.description must be a string`)
  assert.ok(def.description.length >= 20, `${name}.description is too short to guide a model`)
  assert.equal(typeof def.execute, 'function', `${name}.execute must be a function`)

  const parameters = def.parameters
  assert.ok(parameters && typeof parameters === 'object' && !Array.isArray(parameters), `${name}.parameters must be a schema object`)
  assert.equal(parameters.type, 'object', `${name}.parameters must be standard JSON Schema with type:'object'`)
  assert.ok(parameters.properties && typeof parameters.properties === 'object', `${name}.parameters.properties must be an object`)
  assert.equal('type' in parameters.properties, false, `${name}.parameters must not declare a parameter named "type" (schema/keyword collision)`)
  assertStandardJsonSchema(parameters, `${name}.parameters`)
  assertNoForbiddenSchemaKeys(parameters, `${name}.parameters`)

  const schema = def.output && def.output.schema
  schemaProperties(def, name)
  assertStandardJsonSchema(schema, `${name}.output.schema`)
  assertNoForbiddenSchemaKeys(schema, `${name}.output.schema`)
  assert.equal(typeof def.output.render, 'function', `${name}.output.render must be a function`)

  // The real registry rejects `required: true` anywhere in the definition.
  assertNoInlineRequired(def, name)
  if (def.presentCall !== undefined) assert.equal(typeof def.presentCall, 'function', `${name}.presentCall must be a function`)
}

function schemaProperties(def, at) {
  const schema = def.output && def.output.schema
  assert.ok(schema && typeof schema === 'object', `${at}.output.schema must be an object`)
  assert.equal(schema.type, 'object', `${at}.output.schema must be { type: 'object' }`)
  assert.ok(schema.properties && typeof schema.properties === 'object', `${at}.output.schema.properties must be an object`)
  assert.ok(Object.keys(schema.properties).length > 0, `${at}.output.schema.properties must not be empty`)
  for (const [key, prop] of Object.entries(schema.properties)) {
    assert.ok(prop && typeof prop === 'object', `${at}.output.schema.properties.${key} must be an object`)
  }
  return schema
}

/**
 * Copy of the Host's strict "lossless JSON" rule (Lead extracted it from
 * app.asar: snapshotJsonValue -> visitJsonValue). It is STRICTER than a
 * JSON/deepStrictEqual round-trip:
 *  - objects: every own key enumerable, no symbol keys, prototype must be
 *    Object.prototype or null;
 *  - arrays: prototype must be Array.prototype and
 *    Reflect.ownKeys(arr).length === arr.length + 1 (no extra own props);
 *  - numbers: finite and not -0;
 *  - only null/boolean/string/number/array/object are valid JSON values.
 * A tool that returns anything else makes the real registry fail with
 * "returned invalid output: value is not lossless JSON".
 */
function assertLosslessJson(value, at = 'value') {
  if (value === null) return
  const kind = typeof value
  if (kind === 'string' || kind === 'boolean') return
  if (kind === 'number') {
    assert.ok(Number.isFinite(value), `${at}: ${value} is not a finite JSON number`)
    assert.ok(!Object.is(value, -0), `${at}: -0 is not lossless JSON`)
    return
  }
  assert.equal(kind, 'object', `${at}: ${kind} is not a JSON value`)
  if (Array.isArray(value)) {
    assert.equal(Object.getPrototypeOf(value), Array.prototype, `${at}: array prototype must be Array.prototype`)
    assert.equal(
      Reflect.ownKeys(value).length,
      value.length + 1,
      `${at}: array has extra own properties (ownKeys ${Reflect.ownKeys(value).length}, length ${value.length})`,
    )
    value.forEach((item, index) => assertLosslessJson(item, `${at}[${index}]`))
    return
  }
  const proto = Object.getPrototypeOf(value)
  assert.ok(
    proto === Object.prototype || proto === null,
    `${at}: object prototype must be Object.prototype or null, got ${proto && proto.constructor && proto.constructor.name}`,
  )
  assert.deepEqual(Object.getOwnPropertySymbols(value), [], `${at}: symbol own keys are not lossless JSON`)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    assert.ok(descriptor && descriptor.enumerable === true, `${at}.${String(key)}: own property is not enumerable`)
    assertLosslessJson(value[key], `${at}.${String(key)}`)
  }
}

const invoked = new Set()

/** Execute + render one tool on an arbitrary captured handle, validating coverage. */
async function callAndRenderOn(handle, name, args) {
  const def = handle.registered.get(name)
  assert.ok(def, `${name} is not registered on this handle`)
  const value = await def.execute(args || {}, {})
  assert.ok(value !== null && typeof value === 'object', `${name}.execute() must return a plain object`)
  // must be JSON-serializable (hard constraint #5)
  const roundTripped = JSON.parse(JSON.stringify(value))
  assert.deepEqual(roundTripped, value, `${name}.execute() result must be JSON-serializable without loss`)
  assertLosslessJson(value, `${name}.execute() result (strict host rule)`)
  assertCovers(def.output.schema, value, name)
  const blocks = await renderOn(handle, name, args, value)
  invoked.add(name)
  return { value, blocks, text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n') }
}

async function renderOn(handle, name, args, value) {
  const def = handle.registered.get(name)
  assert.equal(typeof def.output.render, 'function', `${name}.output.render must be a function`)
  const blocks = await def.output.render(args || {}, value)
  assert.ok(Array.isArray(blocks), `${name}.output.render must return an array`)
  assert.ok(blocks.length > 0, `${name}.output.render must return at least one block`)
  for (const block of blocks) {
    assert.ok(block && typeof block === 'object', `${name}.output.render block must be an object`)
    assert.equal(typeof block.type, 'string', `${name}.output.render block needs a string type`)
    if (block.type === 'text') assert.equal(typeof block.text, 'string', `${name}.output.render text block needs string text`)
  }
  return blocks
}

/** Execute + render one tool on the main plugin instance. */
async function callAndRender(name, args) {
  return callAndRenderOn(booted, name, args)
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------
//
// Cleanup must run at PROCESS EXIT, not in a `node:test` after() hook: with
// `--test-name-pattern` the root suite can finish (and run `after`) before the
// filtered test bodies execute, which would delete the vault out from under
// the tests. `process.on('exit')` is ordered after every test path.
process.on('exit', () => {
  try {
    booted?.disposeAll?.()
  } catch {
    /* ignore */
  }
  try {
    fixture.cleanup()
  } catch {
    /* ignore */
  }
  try {
    cleanupAll()
  } catch {
    /* ignore */
  }
})

// ---------------------------------------------------------------------------
// Phase 1 — fixture + registration contract (independent of implementation)
// ---------------------------------------------------------------------------

test('fixture vault exists with >= 25 notes and required edge-case files', () => {
  assert.ok(fs.existsSync(fixture.root), 'fixture vault root missing')
  assert.ok(fs.existsSync(fixture.registryPath), 'fake obsidian.json registry missing')
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
    )
  const files = walk(fixture.root)
  const notes = files.filter((file) => file.endsWith('.md'))
  assert.ok(notes.length >= 25, `expected >= 25 markdown notes, got ${notes.length}`)
  const size = (rel) => fs.statSync(path.join(fixture.root, rel)).size
  assert.equal(size(NOTES.empty), 0, 'empty.md must be empty')
  assert.ok(size(NOTES.big) > 2 * 1024 * 1024, 'big.md must exceed 2 MiB')
  const crlf = fs.readFileSync(path.join(fixture.root, NOTES.crlf))
  assert.ok(crlf.includes('\r\n'), 'crlf.md must contain CRLF')
  const bom = fs.readFileSync(path.join(fixture.root, NOTES.bom))
  assert.ok(bom[0] === 0xef && bom[1] === 0xbb && bom[2] === 0xbf, 'bom.md must start with a UTF-8 BOM')
  assert.ok(fs.existsSync(path.join(fixture.root, '.obsidian', 'app.json')), '.obsidian/app.json missing')
  assert.ok(fs.existsSync(path.join(fixture.root, '.obsidian', 'community-plugins.json')), '.obsidian/community-plugins.json missing')
  assert.ok(fs.existsSync(path.join(fixture.root, '.trash', 'trashed-note.md')), '.trash fixture missing')
  assert.ok(fs.existsSync(path.join(fixture.root, NOTES.image)), 'attachment png missing')
  assert.ok(fs.existsSync(path.join(fixture.root, NOTES.pdf)), 'attachment pdf missing')
})

test('plugin module imports and apply() registers every tool', { skip: SKIP }, () => {
  assert.equal(booted.error, null, `apply() failed: ${booted.error && booted.error.message}`)
  assert.deepEqual([...booted.registered.keys()].sort(), [...EXPECTED_TOOLS].sort())
  assert.ok(booted.disposers.length >= 3, 'expected apply() to wrap registrations in ctx.effect()')
})

test('every registered tool definition is valid standard-JSON-Schema (post-normalization)', { skip: SKIP }, () => {
  for (const name of EXPECTED_TOOLS) {
    const def = tool(name)
    assert.equal(def.name, name)
    assertToolDefinition(def)
  }
})

test('a second apply() on a fresh ctx registers cleanly (no duplicate-registration error)', { skip: SKIP }, () => {
  const second = boot()
  assert.equal(second.error, null, `second apply() failed: ${second.error && second.error.message}`)
  assert.deepEqual([...second.registered.keys()].sort(), [...EXPECTED_TOOLS].sort())
  second.disposeAll()
  for (const name of EXPECTED_TOOLS) {
    assert.equal(second.registered.has(name), false, `${name} was not unregistered by dispose()`)
  }
  assert.equal(second.registered.size, 0, 'all 8 tools must be unregistered after dispose()')
})

// ---------------------------------------------------------------------------
// Phase 1b — lib/tools-live.js in isolation (available before vault/search land)
// ---------------------------------------------------------------------------

let liveModule
let liveImportError
try {
  liveModule = await import('../lib/tools-live.js')
} catch (error) {
  liveImportError = error
}
let discoverModule
try {
  discoverModule = await import('../lib/discover.js')
} catch {
  discoverModule = undefined
}
const SKIP_LIVE = liveImportError ? `tools-live not importable: ${liveImportError.message}` : false

const liveStatusOk = () => ({
  ok: true,
  vault: { path: fixture.root, source: 'config', exists: true, error: null },
  account: {
    kind: 'local-installation',
    configPath: fixture.registryPath,
    configFound: true,
    vaults: [{ path: fixture.root, open: true, exists: true, id: 'a1b2c3d4e5f6a7b8' }],
    app: { installed: true, running: false, latest: '1.15.0' },
  },
  settings: {
    enabledCorePlugins: ['file-explorer'],
    enabledCommunityPlugins: [],
    restPlugin: { enabled: false, hasConfig: false, port: null, hasApiKey: false },
  },
  rest: { configured: false, reachable: false, error: null, hint: 'Set `restApiKey` in cordis.patch.yml' },
  index: { ready: true, notes: 27, folders: 7, tags: 18, links: 20, builtAt: Date.now(), tookMs: 4, truncated: false },
  warnings: [],
})

/** Fake runtime for the two live tools; no filesystem/REST side effects. */
function makeLiveRt(options = {}) {
  const calls = { build: [], resolve: [], status: 0 }
  const status = options.status || liveStatusOk()
  const vaultRoot = options.vaultRoot || fixture.root
  const fakeVault = {
    root: vaultRoot,
    async resolve(target) {
      calls.resolve.push(target)
      throw new Error(
        `Note not found: ${(target && (target.note || target.path)) || '(no target)'} (no vault file matches; this fixture fake never resolves)`,
      )
    },
  }
  const fakeIndex = {
    stats: status.index,
    async build(buildOptions) {
      calls.build.push(buildOptions)
      return { notes: 27, folders: 7, tags: 18, links: 20, builtAt: Date.now(), tookMs: 2, truncated: false }
    },
  }
  const rt = {
    config: configFor(vaultRoot),
    async vault() {
      if (options.vaultError) throw options.vaultError
      return fakeVault
    },
    async index() {
      return fakeIndex
    },
    rest() {
      return options.rest === undefined ? null : options.rest
    },
    async status() {
      calls.status += 1
      if (options.statusError) throw options.statusError
      return status
    },
  }
  return { rt, calls }
}

function bootLiveOnly(options = {}) {
  const handle = makeCtx()
  const { rt, calls } = makeLiveRt(options)
  if (!liveModule || typeof liveModule.registerLiveTools !== 'function') {
    return { ...handle, calls, error: new Error('registerLiveTools not exported') }
  }
  try {
    const dispose = liveModule.registerLiveTools(handle.ctx, rt)
    if (typeof dispose !== 'function') throw new TypeError('registerLiveTools must return a disposer function')
    handle.disposers.push(dispose)
  } catch (error) {
    return { ...handle, calls, error }
  }
  return { ...handle, calls, error: null }
}

const liveBooted = liveImportError ? null : bootLiveOnly()

test('tools-live isolation: registers exactly obsidian_status + obsidian_live with one disposer', { skip: SKIP_LIVE }, () => {
  assert.equal(liveBooted.error, null, `registerLiveTools failed: ${liveBooted.error && liveBooted.error.message}`)
  assert.deepEqual([...liveBooted.registered.keys()].sort(), ['obsidian_live', 'obsidian_status'])
  liveBooted.disposeAll()
  assert.equal(liveBooted.registered.size, 0, 'one disposer must unregister both tools')
})

test('tools-live isolation: status info is a usable, schema-valid report and renders', { skip: SKIP_LIVE }, async () => {
  const handle = bootLiveOnly()
  const { value, blocks, text } = await callAndRenderOn(handle, 'obsidian_status', { action: 'info' })
  assert.equal(value.ok, true)
  assert.equal(typeof value.summary, 'string')
  assert.match(value.summary, /Obsidian Hub — connected/)
  assert.ok(value.summary.includes(fixture.root), 'summary must name the vault path')
  assert.match(value.summary, /notes: 27/)
  assert.match(value.summary, /REST API: not configured/)
  assert.match(value.summary, /no public account or Sync\/Publish API/, 'status must honestly disclaim cloud account APIs')
  assert.equal(blocks[0].text, value.summary, 'render must surface the summary')
  assert.ok(text.length > 100)
  handle.disposeAll()
})

test('tools-live isolation: status vaults reads the machine vault registry', { skip: SKIP_LIVE }, async () => {
  const handle = bootLiveOnly()
  const { value } = await callAndRenderOn(handle, 'obsidian_status', { action: 'vaults' })
  assert.equal(value.ok, true)
  assert.equal(value.found, true)
  assert.equal(value.vaults.length, 1)
  assert.equal(value.vaults[0].path, fixture.root)
  assert.equal(value.vaults[0].open, true)
  handle.disposeAll()
})

test('tools-live isolation: status reindex forces a rebuild', { skip: SKIP_LIVE }, async () => {
  const handle = bootLiveOnly()
  const { value } = await callAndRenderOn(handle, 'obsidian_status', { action: 'reindex' })
  assert.equal(value.ok, true)
  assert.equal(value.stats.notes, 27)
  assert.deepEqual(handle.calls.build, [{ force: true }])
  handle.disposeAll()
})

test('tools-live isolation: info still renders when the vault is unavailable', { skip: SKIP_LIVE }, async () => {
  const broken = liveStatusOk()
  broken.ok = false
  broken.vault = {
    path: 'C:\\does\\not\\exist',
    source: 'config',
    exists: false,
    error: 'Vault path does not exist or is not a directory: C:\\does\\not\\exist',
  }
  broken.settings = null
  broken.index = null
  broken.account = { ...broken.account, configFound: false, vaults: [] }
  broken.warnings = ['vault unavailable: Vault path does not exist or is not a directory: C:\\does\\not\\exist']
  const handle = bootLiveOnly({ status: broken, vaultRoot: 'C:\\does\\not\\exist' })
  const { value, text } = await callAndRenderOn(handle, 'obsidian_status', { action: 'info' })
  assert.equal(value.ok, false)
  assert.match(text, /not connected/)
  assert.match(text, /vault error: Vault path does not exist/)
  assert.match(text, /warning: vault unavailable/)
  handle.disposeAll()
})

test('tools-live isolation: live with no REST key fails fast with actionable guidance', { skip: SKIP_LIVE }, async () => {
  const handle = bootLiveOnly()
  for (const action of ['ping', 'commands', 'active', 'command']) {
    const started = performance.now()
    await assert.rejects(
      async () => handle.registered.get('obsidian_live').execute({ action, command: 'app:toggle-left-sidebar' }, {}),
      (error) => {
        assert.match(error.message, /Local REST API is not configured/)
        assert.match(error.message, /restApiKey/)
        return true
      },
      `action=${action} must reject with REST guidance`,
    )
    assert.ok(performance.now() - started < 3_000, `action=${action} must fail fast, not hang`)
  }
  handle.disposeAll()
})

test('tools-live isolation: live rejects unknown/malformed actions cleanly', { skip: SKIP_LIVE }, async () => {
  const handle = bootLiveOnly()
  const live = handle.registered.get('obsidian_live')
  await assert.rejects(() => live.execute({ action: 'nope' }), /Unknown action "nope"/)
  await assert.rejects(() => live.execute({ action: 'command' }), /requires the `command` parameter/)
  handle.disposeAll()
})

test('tools-live isolation: open-app on a nonexistent note throws and never reaches the URI handler', { skip: SKIP_LIVE }, async () => {
  const handle = bootLiveOnly()
  const started = performance.now()
  await assert.rejects(
    () => handle.registered.get('obsidian_live').execute({ action: 'open-app', note: 'definitely-missing-xyz' }, {}),
    (error) => {
      assert.match(error.message, /Note not found: definitely-missing-xyz/)
      return true
    },
  )
  assert.equal(handle.calls.resolve.length, 1, 'vault.resolve must be consulted before launching a URI')
  assert.deepEqual(handle.calls.resolve[0], { path: undefined, note: 'definitely-missing-xyz' })
  assert.ok(performance.now() - started < 3_000, 'open-app failure must be fast')
  handle.disposeAll()
})

test('discover: detectObsidianApp cannot hang and reports a sane shape', { skip: discoverModule ? false : 'discover.js not importable' }, async () => {
  const started = performance.now()
  const app = await discoverModule.detectObsidianApp()
  const tookMs = performance.now() - started
  console.log(`[perf] detectObsidianApp ${tookMs.toFixed(1)} ms`)
  assert.ok(tookMs < 10_000, `detectObsidianApp took ${tookMs.toFixed(0)} ms — synchronous probes may hang the Host`)
  assert.equal(typeof app.installed, 'boolean')
  assert.equal(typeof app.running, 'boolean')
  assert.ok(Array.isArray(app.installs))
  assert.equal(typeof app.logPath, 'string')
})

test('discover: missing/invalid vault registry and missing vault settings degrade to empty', { skip: discoverModule ? false : 'discover.js not importable' }, async () => {
  const missing = await discoverModule.detectVaults(path.join(paths.base, 'no-such-dir', 'obsidian.json'))
  assert.equal(missing.found, false)
  assert.deepEqual(missing.vaults, [])

  const invalid = path.join(paths.base, 'invalid-registry', 'obsidian.json')
  fs.mkdirSync(path.dirname(invalid), { recursive: true })
  fs.writeFileSync(invalid, '{not json', 'utf8')
  const broken = await discoverModule.detectVaults(invalid)
  assert.equal(broken.found, false)
  assert.deepEqual(broken.vaults, [])
  fs.rmSync(path.dirname(invalid), { recursive: true, force: true })

  const settings = await discoverModule.readVaultSettings(path.join(fixture.root, 'no-such-vault'))
  assert.equal(settings.exists, false)
  assert.deepEqual(settings.enabledCorePlugins, [])
  assert.deepEqual(settings.enabledCommunityPlugins, [])
})

// ---------------------------------------------------------------------------
// Phase 1c — config.js / rest.js / display resources (independent of modules)
// ---------------------------------------------------------------------------

let configModule
try {
  configModule = await import('../lib/config.js')
} catch {
  configModule = undefined
}
let restModule
try {
  restModule = await import('../lib/rest.js')
} catch {
  restModule = undefined
}
const SKIP_CONFIG = configModule ? false : 'lib/config.js not importable'
const SKIP_REST = restModule ? false : 'lib/rest.js not importable'

test('config: resolveConfig returns the documented default set', { skip: SKIP_CONFIG }, () => {
  const config = configModule.resolveConfig(undefined)
  assert.equal(config.vaultPath, '')
  assert.equal(config.autoDetect, true)
  assert.deepEqual(config.exclude, ['.obsidian/**', '.trash/**', '**/node_modules/**', '**/.git/**'])
  assert.equal(config.restBaseUrl, 'https://127.0.0.1:27124')
  assert.equal(config.restApiKey, '')
  assert.equal(config.restInsecure, true)
  assert.equal(config.indexTtlMs, 8_000)
  assert.equal(config.indexMaxFiles, 20_000)
  assert.equal(config.indexMaxTotalBytes, 64 * 1024 * 1024)
  assert.equal(config.maxFileBytes, 2 * 1024 * 1024)
  assert.equal(config.defaultReadLimit, 400)
  assert.equal(config.trashMode, 'trash')
  assert.match(config.obsidianConfigPath, /obsidian[\\/]obsidian\.json$/)
})

test('config: clamps numbers, coerces booleans, splits string arrays', { skip: SKIP_CONFIG }, () => {
  const config = configModule.resolveConfig({
    vaultPath: '  C:\\vault  ',
    autoDetect: 'false',
    exclude: 'a, b',
    restApiKey: '  secret-key  ',
    restInsecure: '0',
    indexTtlMs: -5,
    indexMaxFiles: 0,
    indexMaxTotalBytes: 1,
    maxFileBytes: 999_999_999,
    defaultReadLimit: 999_999,
    trashMode: 'delete',
    obsidianConfigPath: 'C:\\custom\\obsidian.json',
  })
  assert.equal(config.vaultPath, 'C:\\vault')
  assert.equal(config.autoDetect, false)
  assert.deepEqual(config.exclude, ['a', 'b'])
  assert.equal(config.restApiKey, 'secret-key')
  assert.equal(config.restInsecure, false)
  assert.equal(config.indexTtlMs, 0, 'negative TTL must clamp to 0')
  assert.equal(config.indexMaxFiles, 1, 'indexMaxFiles min is 1')
  assert.equal(config.indexMaxTotalBytes, 64 * 1024, 'indexMaxTotalBytes min is 64 KiB')
  assert.equal(config.maxFileBytes, 64 * 1024 * 1024, 'maxFileBytes max is 64 MiB')
  assert.equal(config.defaultReadLimit, 20_000)
  assert.equal(config.trashMode, 'delete')
  assert.equal(config.obsidianConfigPath, 'C:\\custom\\obsidian.json')

  const tolerant = configModule.resolveConfig({ indexTtlMs: '12abc', maxFileBytes: 'not-a-number', exclude: [1, '', 2] })
  assert.equal(tolerant.indexTtlMs, 12)
  assert.equal(tolerant.maxFileBytes, 2 * 1024 * 1024)
  assert.deepEqual(tolerant.exclude, ['1', '2'])
  assert.ok(fs.existsSync(configModule.bundleDir), 'bundleDir must point at a real directory')
  assert.equal(path.resolve(configModule.bundleDir), PLUGIN_ROOT, 'bundleDir must be the bundle ROOT (plugin directory)')
  assert.ok(fs.existsSync(path.join(configModule.bundleDir, 'index.js')), 'bundleDir must contain index.js')
})

test('rest: configured flag, URL normalization and transport selection', { skip: SKIP_REST }, () => {
  const httpsClient = new restModule.ObsidianRest({ baseUrl: 'https://127.0.0.1:27124/', apiKey: 'abc' })
  assert.equal(httpsClient.configured, true)
  assert.equal(httpsClient.baseUrl, 'https://127.0.0.1:27124')
  assert.equal(httpsClient.port, 27_124)
  assert.equal(typeof httpsClient.transport.request, 'function')
  assert.equal(httpsClient.insecure, true)

  const httpClient = new restModule.ObsidianRest({ baseUrl: 'http://localhost', apiKey: 'k' })
  assert.equal(httpClient.port, 80, 'http default port must be 80')

  assert.equal(new restModule.ObsidianRest({ baseUrl: 'https://127.0.0.1:27124', apiKey: '' }).configured, false)
  // Empty baseUrl must degrade to configured:false without throwing (defensive path).
  const emptyClient = new restModule.ObsidianRest({ baseUrl: '', apiKey: 'k' })
  assert.equal(emptyClient.configured, false)
  // An invalid NON-EMPTY baseUrl throws a named RestError instead of a bare TypeError.
  assert.throws(
    () => new restModule.ObsidianRest({ baseUrl: 'not a url', apiKey: 'k' }),
    (error) => {
      assert.equal(error.name, 'RestError')
      assert.equal(error.code, 'invalid_url')
      assert.match(error.message, /Invalid restBaseUrl/)
      return true
    },
    'invalid restBaseUrl must raise RestError(invalid_url)',
  )
})

test('rest: unreachable server rejects with an actionable RestError (no hang)', { skip: SKIP_REST }, async () => {
  const client = new restModule.ObsidianRest({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', timeoutMs: 1_500 })
  const started = performance.now()
  await assert.rejects(
    () => client.ping(),
    (error) => {
      assert.equal(error.name, 'RestError')
      assert.match(error.message, /unreachable|timed out|ECONNREFUSED/i)
      assert.match(error.message, /Local REST API/)
      return true
    },
  )
  assert.ok(performance.now() - started < 5_000, 'REST failure must be bounded by timeoutMs')
})

/** Minimal well-formedness check good enough for the flat icon.svg we ship. */
function assertWellFormedXml(source, label) {
  const stripped = source.replace(/<!--[\s\S]*?-->/g, '')
  const stack = []
  const tag = /<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
  let match
  let count = 0
  while ((match = tag.exec(stripped))) {
    count += 1
    const [, closing, name, , selfClose] = match
    if (selfClose) continue
    if (closing) assert.equal(stack.pop(), name, `${label}: closing </${name}> does not match open tag`)
    else stack.push(name)
  }
  assert.ok(count > 0, `${label}: no XML tags found`)
  assert.deepEqual(stack, [], `${label}: unclosed tags ${stack.join(',')}`)
}

test('resources: package.json manifest core is valid', () => {
  const pkgPath = path.join(PLUGIN_ROOT, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  assert.equal(pkg.name, 'dsh-obsidian-hub')
  assert.equal(pkg.type, 'module')
  assert.ok(pkg.dsh && pkg.dsh.bundle, 'package.json needs dsh.bundle')
  assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, pkg.dsh.bundle.patch)), 'dsh.bundle.patch must resolve to a real file')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately, true)
})

test('resources: package.json exports resolve to real files', { skip: fs.existsSync(path.join(PLUGIN_ROOT, 'client.js')) ? false : 'client.js not written yet' }, () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'))
  const exportsMap = pkg.exports || {}
  assert.ok(Object.keys(exportsMap).length >= 3, 'package.json needs an exports map')
  for (const [key, target] of Object.entries(exportsMap)) {
    assert.equal(typeof target, 'string', `exports["${key}"] must be a string path`)
    if (key.includes('*')) {
      const dir = path.join(PLUGIN_ROOT, path.dirname(target))
      const ext = path.extname(target)
      assert.ok(fs.existsSync(dir), `exports["${key}"] directory does not exist: ${dir}`)
      const candidates = fs.readdirSync(dir).filter((name) => name.endsWith(ext))
      assert.ok(candidates.length > 0, `exports["${key}"] wildcard matches no ${ext} file in ${dir}`)
    } else {
      assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, target)), `exports["${key}"] target missing: ${target}`)
    }
  }
})

test('resources: icon.svg is well-formed and <= 256 KiB', () => {
  const iconPath = path.join(PLUGIN_ROOT, 'icon.svg')
  assert.ok(fs.existsSync(iconPath), 'icon.svg missing')
  const stat = fs.statSync(iconPath)
  assert.ok(stat.size <= 256 * 1024, `icon.svg is ${stat.size} bytes (> 256 KiB)`)
  const source = fs.readFileSync(iconPath, 'utf8')
  assert.match(source.trimStart(), /^<svg[\s>]/, 'icon.svg must start with <svg')
  assert.match(source.trimEnd(), /<\/svg>$/, 'icon.svg must end with </svg>')
  assert.match(source, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assertWellFormedXml(source, 'icon.svg')
})

test('resources: locale JSON files parse with meta.title + meta.description', { skip: fs.existsSync(path.join(PLUGIN_ROOT, 'locale')) ? false : 'locale/ not written yet' }, () => {
  const dir = path.join(PLUGIN_ROOT, 'locale')
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
  assert.ok(files.length >= 2, `expected en/zh locale files, found: ${files.join(',') || '(none)'}`)
  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8')
    let parsed
    assert.doesNotThrow(() => {
      parsed = JSON.parse(raw)
    }, `${file} is not valid JSON`)
    assert.ok(parsed.meta && typeof parsed.meta === 'object', `${file} needs a meta object`)
    assert.equal(typeof parsed.meta.title, 'string', `${file} meta.title must be a string`)
    assert.ok(parsed.meta.title.length > 0, `${file} meta.title must not be empty`)
    assert.equal(typeof parsed.meta.description, 'string', `${file} meta.description must be a string`)
    assert.ok(parsed.meta.description.length > 20, `${file} meta.description is too short`)
  }
  const zh = files.find((name) => name.startsWith('zh'))
  const en = files.find((name) => name.startsWith('en'))
  assert.ok(zh && en, 'expected locale/en.json and locale/zh.json')
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, en), 'utf8')).meta.title, 'Obsidian Hub')
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, zh), 'utf8')).meta.title, 'Obsidian 知识库中枢')
})

test('resources: client.js is a loadable dynamic module (syntax-checkable, no bare imports)', { skip: fs.existsSync(path.join(PLUGIN_ROOT, 'client.js')) ? false : 'client.js not written yet' }, () => {
  const source = fs.readFileSync(path.join(PLUGIN_ROOT, 'client.js'), 'utf8')
  assert.ok(source.length > 200, 'client.js looks empty')
  assert.match(source, /__ModuleLoader__/, 'client.js must use window.__ModuleLoader__.load({...})')
  assert.doesNotMatch(source, /@deepseek-ai\//, 'client.js must not import @deepseek-ai packages')
  assert.doesNotMatch(source, /^\s*import\s+/m, 'client.js must not use top-level ESM imports (dynamic loader format)')
  assert.doesNotThrow(() => new Function(source), 'client.js has a JavaScript syntax error')
})

// ---------------------------------------------------------------------------
// Phase 1d — lib/tool-schema.js normalization + registerTools rollback
// ---------------------------------------------------------------------------

let toolSchemaModule
try {
  toolSchemaModule = await import('../lib/tool-schema.js')
} catch {
  toolSchemaModule = undefined
}
const SKIP_SCHEMA = toolSchemaModule ? false : 'lib/tool-schema.js not importable'

/** Authoring-form tool definition, exactly what tool modules hand to defineTool(). */
function rawTool(name, overrides = {}) {
  return {
    name,
    description: `Demo tool ${name} used by verifier schema-normalization tests.`,
    parameters: {
      path: { type: 'string', description: 'target path', required: true },
      limit: { type: 'integer', description: 'max items' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, path: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: String(value.ok) }],
    },
    async execute() {
      return { ok: true, path: 'x' }
    },
    ...overrides,
  }
}

test('tool-schema: defineTool emits standard JSON Schema with no inline required:true', { skip: SKIP_SCHEMA }, () => {
  const normalized = toolSchemaModule.defineTool(rawTool('demo_tool'))
  assert.deepEqual(normalized.parameters, {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'target path' },
      limit: { type: 'integer', description: 'max items' },
    },
    required: ['path'],
  })
  assert.deepEqual(normalized.output.schema, {
    type: 'object',
    additionalProperties: false,
    properties: { ok: { type: 'boolean' }, path: { type: 'string' } },
    required: ['ok'],
  })
  assertNoInlineRequired(normalized, 'demo_tool')
  assertStandardJsonSchema(normalized.parameters, 'demo_tool.parameters')
  assertStandardJsonSchema(normalized.output.schema, 'demo_tool.output.schema')
  assert.equal(typeof normalized.execute, 'function')
  assert.equal(typeof normalized.output.render, 'function')
  assert.equal(normalized.name, 'demo_tool', 'extra definition fields must survive normalization')
})

test('tool-schema: normalization is idempotent and wraps nested property maps', { skip: SKIP_SCHEMA }, () => {
  const authoring = {
    type: 'object',
    properties: {
      payload: { a: { type: 'string', description: 'a' }, b: { type: 'integer', description: 'b' } },
      list: { type: 'array', items: { type: 'string' }, description: 'list' },
      mode: { type: 'string', enum: ['x', 'y'], required: true, description: 'mode' },
    },
  }
  const once = toolSchemaModule.normalizeSchema(authoring)
  const twice = toolSchemaModule.normalizeSchema(once)
  assert.deepEqual(twice, once, 'normalizeSchema must be idempotent')
  assert.deepEqual(once.properties.payload, {
    type: 'object',
    properties: { a: { type: 'string', description: 'a' }, b: { type: 'integer', description: 'b' } },
  })
  assert.deepEqual(once.properties.list, { type: 'array', items: { type: 'string' }, description: 'list' })
  assert.deepEqual(once.required, ['mode'])
  assertNoInlineRequired(once, 'nested')
})

test('tool-schema: parameter names that collide with schema keywords still work', { skip: SKIP_SCHEMA }, () => {
  const edge = toolSchemaModule.defineTool(
    rawTool('demo_edge', {
      parameters: {
        type: { type: 'string', description: 'kind' },
        required: { type: 'boolean', description: 'flag' },
      },
    }),
  )
  assert.equal(edge.parameters.type, 'object')
  assert.equal(edge.parameters.properties.type.type, 'string')
  assert.equal(edge.parameters.properties.required.type, 'boolean')
  assertNoInlineRequired(edge, 'demo_edge')
})

test('tool-schema: defineTool rejects malformed authoring definitions', { skip: SKIP_SCHEMA }, () => {
  assert.throws(() => toolSchemaModule.defineTool(null), /definition object is required/)
  assert.throws(() => toolSchemaModule.defineTool({}), /name/)
  assert.throws(() => toolSchemaModule.defineTool({ name: 'x' }), /description/)
  assert.throws(() => toolSchemaModule.defineTool({ name: 'x', description: 'a suitable description', output: {} }), /execute/)
  assert.throws(
    () => toolSchemaModule.defineTool({ name: 'x', description: 'a suitable description', execute() {} }),
    /output.render/,
  )
})

test('tool-schema: registerTools returns ONE disposer and rolls back on a mid-array throw', { skip: SKIP_SCHEMA }, () => {
  const registry = new Map()
  const ctx = {
    tools: {
      register(def) {
        if (def.name === 'demo_fail') throw new Error('registry exploded')
        registry.set(def.name, def)
        return () => registry.delete(def.name)
      },
    },
  }
  const dispose = toolSchemaModule.registerTools(ctx, [rawTool('demo_one'), rawTool('demo_two')])
  assert.equal(typeof dispose, 'function')
  assert.deepEqual([...registry.keys()].sort(), ['demo_one', 'demo_two'])
  dispose()
  assert.equal(registry.size, 0, 'one disposer must unregister every tool it registered')

  const rollback = new Map()
  const failingCtx = {
    tools: {
      register(def) {
        if (def.name === 'demo_fail') throw new Error('registry exploded')
        rollback.set(def.name, def)
        return () => rollback.delete(def.name)
      },
    },
  }
  assert.throws(
    () => toolSchemaModule.registerTools(failingCtx, [rawTool('demo_one'), rawTool('demo_fail'), rawTool('demo_three')]),
    /registry exploded/,
  )
  assert.equal(rollback.size, 0, 'registerTools must roll back already-registered tools when a later one throws')
})

test('tool-schema: toLosslessJson normalizes every host-rejected shape', { skip: SKIP_SCHEMA }, () => {
  const weird = {
    undef: undefined,
    negativeZero: -0,
    nan: Number.NaN,
    infinity: Number.POSITIVE_INFINITY,
    when: new Date(0),
    map: new Map([['k', 'v']]),
    set: new Set(['a']),
    big: 10n,
    fn: () => 1,
    nested: { deep: [1, undefined, -0] },
  }
  Object.defineProperty(weird, 'hidden', { value: 'x', enumerable: false })
  weird[Symbol('sym')] = 'y'
  const normalized = toolSchemaModule.toLosslessJson(weird)
  assertLosslessJson(normalized, 'toLosslessJson')
  assert.deepEqual(JSON.parse(JSON.stringify(normalized)), normalized)
  assert.equal(normalized.negativeZero, 0)
  assert.equal(normalized.nan, null)
  assert.equal(normalized.infinity, null)
  assert.equal(normalized.when, '1970-01-01T00:00:00.000Z')
  assert.equal(normalized.big, '10')
  assert.deepEqual(normalized.nested, { deep: [1, null, 0] })
  assert.equal('hidden' in normalized, false, 'non-enumerable own property must be dropped')
  // The BigInt in this object forces the non-JSON walk fallback, which maps
  // undefined/function values to null instead of dropping the key; both forms
  // are lossless JSON, the strict rule above is what the Host enforces.
  assert.ok(normalized.undef === null || !('undef' in normalized), 'undefined own property must not survive as undefined')
  assert.ok(normalized.fn === null || !('fn' in normalized), 'function-valued property must not survive as a function')
  assert.deepEqual(Object.getOwnPropertySymbols(normalized), [])
})

test('tool-schema: defineTool wraps execute so host-rejected values never reach the registry', { skip: SKIP_SCHEMA }, async () => {
  const hostile = {
    ...rawTool('demo_hostile'),
    async execute() {
      const value = { ok: true, text: 'fine', negativeZero: -0, nan: Number.NaN, nested: { missing: undefined, keep: 1 } }
      Object.defineProperty(value, 'hiddenMeta', { value: 'x', enumerable: false })
      value.list = [1, 2]
      value.list.extra = 'own prop'
      return value
    },
  }
  const normalized = toolSchemaModule.defineTool(hostile)
  const value = await normalized.execute({}, {})
  assertLosslessJson(value, 'wrapped execute')
  assert.equal(value.negativeZero, 0)
  assert.equal(value.nan, null)
  assert.equal('hiddenMeta' in value, false)
  assert.deepEqual(value.nested, { keep: 1 })
  assert.deepEqual(value.list, [1, 2])
  assert.equal(Reflect.ownKeys(value.list).length, value.list.length + 1, 'array own props must be stripped')
})

// ---------------------------------------------------------------------------
// Phase 2a — lib/search.js + lib/tools-search.js against an in-memory index
// (runs before vault.js exists; proves the query engine independently)
// ---------------------------------------------------------------------------

let searchModule
let toolsSearchModule
try {
  searchModule = await import('../lib/search.js')
} catch {
  searchModule = undefined
}
try {
  toolsSearchModule = await import('../lib/tools-search.js')
} catch {
  toolsSearchModule = undefined
}
const SKIP_SEARCH = searchModule ? false : 'lib/search.js not importable'

/** Fake FileRecord (shape from ARCHITECTURE.md + indexer.js). */
function fakeRecord({ rel, title, body = '', tags = [], links = [], headings = [], frontmatter = {}, mtimeMs = 0 }) {
  const taskList = []
  body.split('\n').forEach((line, index) => {
    const match = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line)
    if (match) taskList.push({ line: index, checked: match[1].toLowerCase() === 'x', text: match[2] })
  })
  return {
    rel,
    title: title || rel.replace(/\.md$/i, '').split('/').pop(),
    body,
    lcText: body.toLowerCase(),
    tags,
    links: links.map((link) => (typeof link === 'string' ? { target: link, raw: `[[${link}]]` } : link)),
    headings,
    tasks: { total: taskList.length, open: taskList.filter((t) => !t.checked).length, done: taskList.filter((t) => t.checked).length },
    taskList,
    frontmatter,
    mtimeMs,
    bodyLineOffset: 0,
  }
}

/** Minimal index surface exactly as lib/search.js consumes it. */
function makeFakeIndex(records) {
  const files = new Map(records.map((record) => [record.rel, record]))
  const tagIndex = new Map()
  const propertyIndex = new Map()
  const taskItems = new Map()
  const addSet = (map, key, value) => {
    let set = map.get(key)
    if (!set) map.set(key, (set = new Set()))
    set.add(value)
  }
  for (const record of records) {
    for (const tag of record.tags) addSet(tagIndex, String(tag).toLowerCase(), record.rel)
    for (const [key, value] of Object.entries(record.frontmatter || {})) {
      const valueMap = propertyIndex.get(key) || new Map()
      propertyIndex.set(key, valueMap)
      for (const item of Array.isArray(value) ? value : [value]) addSet(valueMap, String(item), record.rel)
    }
    taskItems.set(record.rel, record.taskList)
  }
  const resolveNote = (nameOrPath) => {
    const query = String(nameOrPath ?? '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\|.*$/, '')
      .replace(/#.*$/, '')
      .trim()
    if (!query) return undefined
    if (files.has(query)) return query
    const lower = query.toLowerCase()
    for (const rel of files.keys()) {
      if (rel.toLowerCase() === lower || rel.toLowerCase() === `${lower}.md`) return rel
    }
    const base = lower.replace(/\.md$/i, '').split('/').pop()
    for (const record of files.values()) {
      if (record.rel.toLowerCase().replace(/\.md$/i, '').split('/').pop() === base) return record.rel
    }
    for (const record of files.values()) if (record.title.toLowerCase() === lower) return record.rel
    return undefined
  }
  const backlinks = new Map()
  let linkCount = 0
  for (const record of files.values()) {
    for (const link of record.links) {
      linkCount += 1
      const target = resolveNote(link.target)
      if (!target) continue
      const list = backlinks.get(target) || []
      list.push({ from: record.rel, raw: link.raw })
      backlinks.set(target, list)
    }
  }
  return {
    files,
    tagIndex,
    propertyIndex,
    taskItems,
    stats: {
      ready: true,
      notes: files.size,
      folders: 3,
      tags: tagIndex.size,
      links: linkCount,
      builtAt: Date.now() - 1_000,
      tookMs: 3.5,
      bytes: 2_048,
      truncated: false,
    },
    resolveNote,
    backlinksOf(rel) {
      const key = resolveNote(rel) ?? String(rel)
      return (backlinks.get(key) || []).slice().sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
    },
    recent(n) {
      return [...files.values()].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, Math.max(0, n))
    },
  }
}

const FAKE_RECORDS = [
  fakeRecord({
    rel: 'notes/alpha-note.md',
    title: 'Alpha Note',
    mtimeMs: 5_000,
    body:
      '# Alpha Note\n\nThe quick brown fox jumps over the lazy dog. zebraquartz marker lives here.\n\n- [ ] open task alpha\n- [x] done task beta\n',
    tags: ['project/alpha', 'english'],
    links: [{ target: 'projects/beta', raw: '[[projects/beta]]' }],
    headings: [
      { level: 1, text: 'Alpha Note', line: 0 },
      { level: 2, text: 'Alpha Details', line: 6 },
    ],
    frontmatter: { status: 'active', priority: 'high', aliases: ['Alpha'] },
  }),
  fakeRecord({
    rel: 'projects/beta.md',
    title: 'Beta Project',
    mtimeMs: 1_000,
    body: '# Beta Project\n\nLinks back to [[projects/alpha]].\n',
    tags: ['project/beta'],
    links: [{ target: 'projects/alpha', raw: '[[projects/alpha]]' }],
    headings: [{ level: 1, text: 'Beta Project', line: 0 }],
    frontmatter: { status: 'done', priority: 'low' },
  }),
  fakeRecord({
    rel: '中文/欢迎.md',
    title: '欢迎',
    mtimeMs: 3_000,
    body: '# 欢迎\n\n这里是中文入口。核心概念是量子纠缠与观测者效应。\n',
    tags: ['入门', '中文'],
    links: [{ target: 'notes/alpha-note', raw: '[[Alpha Note]]' }],
    frontmatter: { status: 'active' },
  }),
  fakeRecord({
    rel: 'daily/2026-11-05.md',
    title: '2026-11-05',
    mtimeMs: 4_000,
    body: '# 2026-11-05\n\n- [ ] standup\n- [x] review PR\n',
    tags: ['daily'],
    frontmatter: { status: 'active' },
  }),
  fakeRecord({ rel: 'empty.md', title: 'Empty', mtimeMs: 2_000, body: '' }),
]

let fakeIndex
try {
  fakeIndex = makeFakeIndex(FAKE_RECORDS)
} catch {
  fakeIndex = undefined
}

function fakeIndexSearch(params) {
  return searchModule.search(fakeIndex, params)
}

test('search: tokenizer handles CJK bigrams, Latin words and punctuation', { skip: SKIP_SEARCH }, () => {
  const tokenize = searchModule.tokenize
  assert.deepEqual(tokenize('量子纠缠'), ['量子', '子纠', '纠缠'])
  assert.deepEqual(tokenize('Hello, WORLD! foo_bar baz-qux'), ['hello', 'world', 'foo_bar', 'baz-qux'])
  assert.deepEqual(tokenize('快'), ['快'], 'single CJK char stays a unigram')
  assert.deepEqual(tokenize('  ...  '), [])
})

test('search: glob compiler handles **, * and ?', { skip: SKIP_SEARCH }, () => {
  const globToRegExp = searchModule.globToRegExp
  assert.ok(globToRegExp('**/daily/*.md').test('daily/a.md'))
  assert.ok(globToRegExp('**/daily/*.md').test('x/daily/a.md'))
  assert.ok(!globToRegExp('**/daily/*.md').test('daily/sub/a.md'))
  assert.ok(globToRegExp('notes/*.md').test('notes/a.md'))
  assert.ok(!globToRegExp('notes/*.md').test('notes/sub/a.md'))
  assert.ok(globToRegExp('note-?.md').test('note-a.md'))
  assert.ok(globToRegExp('**/*.md').test('a/b/c.md'))
})

test('search: text mode finds English + Chinese, requires all terms, ranks the obvious hit first', { skip: SKIP_SEARCH }, () => {
  const english = fakeIndexSearch({ mode: 'text', query: 'zebraquartz' })
  assert.equal(english.mode, 'text')
  assert.equal(english.total, 1)
  assert.equal(english.results[0].rel, 'notes/alpha-note.md')
  assert.ok(english.results[0].score > 0, 'text hits carry a BM25-style score')
  assert.equal(typeof english.results[0].snippet, 'string')
  assert.equal(typeof english.results[0].line, 'number')

  const chinese = fakeIndexSearch({ mode: 'text', query: '量子纠缠' })
  assert.equal(chinese.total, 1)
  assert.equal(chinese.results[0].rel, '中文/欢迎.md')

  assert.equal(fakeIndexSearch({ mode: 'text', query: 'zebraquartz missingtoken' }).total, 0, 'all terms must match')
  assert.equal(fakeIndexSearch({ mode: 'text', query: '   ' }).total, 0)
  assert.equal(fakeIndexSearch({ mode: 'text', query: 'marker' }).results[0].rel, 'notes/alpha-note.md')
})

test('search: phrase and regex modes (invalid regex throws a clear error)', { skip: SKIP_SEARCH }, () => {
  const phrase = fakeIndexSearch({ mode: 'phrase', query: 'quick brown fox' })
  assert.equal(phrase.total, 1)
  assert.equal(phrase.results[0].rel, 'notes/alpha-note.md')
  assert.equal(fakeIndexSearch({ mode: 'phrase', query: 'brown quick' }).total, 0)

  const regex = fakeIndexSearch({ mode: 'regex', regex: 'zebra[a-z]+' })
  assert.equal(regex.total, 1)
  assert.equal(regex.results[0].rel, 'notes/alpha-note.md')
  assert.throws(() => fakeIndexSearch({ mode: 'regex', regex: '(' }), /invalid regex/i)
})

test('search: tag mode matches exact tags and parent/* prefixes', { skip: SKIP_SEARCH }, () => {
  const exact = fakeIndexSearch({ mode: 'tag', tag: 'project/alpha' })
  assert.deepEqual(exact.results.map((r) => r.rel), ['notes/alpha-note.md'])
  const prefix = fakeIndexSearch({ mode: 'tag', tag: 'project' })
  assert.deepEqual(prefix.results.map((r) => r.rel).sort(), ['notes/alpha-note.md', 'projects/beta.md'])
  const hashed = fakeIndexSearch({ mode: 'tag', tag: '#daily' })
  assert.deepEqual(hashed.results.map((r) => r.rel), ['daily/2026-11-05.md'])
  assert.equal(fakeIndexSearch({ mode: 'tag', tag: 'nope' }).total, 0)
})

test('search: property mode matches frontmatter key/value', { skip: SKIP_SEARCH }, () => {
  const active = fakeIndexSearch({ mode: 'property', property: { key: 'status', value: 'active' } })
  assert.deepEqual(active.results.map((r) => r.rel).sort(), ['daily/2026-11-05.md', 'notes/alpha-note.md', '中文/欢迎.md'])
  const done = fakeIndexSearch({ mode: 'property', property: { key: 'status', value: 'done' } })
  assert.deepEqual(done.results.map((r) => r.rel), ['projects/beta.md'])
  const anyPriority = fakeIndexSearch({ mode: 'property', property: { key: 'priority' } })
  assert.deepEqual(anyPriority.results.map((r) => r.rel).sort(), ['notes/alpha-note.md', 'projects/beta.md'])
  assert.equal(fakeIndexSearch({ mode: 'property', property: { key: 'status', value: 'missing' } }).total, 0)
})

test('search: link mode returns backlinks and unresolved-link matches', { skip: SKIP_SEARCH }, () => {
  const backlinks = fakeIndexSearch({ mode: 'link', note: 'projects/beta' })
  assert.deepEqual(backlinks.results.map((r) => r.rel), ['notes/alpha-note.md'])
  assert.equal(backlinks.results[0].snippet.includes('projects/beta'), true)
  const unresolved = fakeIndexSearch({ mode: 'link', note: 'does-not-exist' })
  assert.equal(unresolved.total, 0)
})

test('search: files/recent/headings/tasks/filters/paging behave', { skip: SKIP_SEARCH }, () => {
  const files = fakeIndexSearch({ mode: 'files', query: 'daily' })
  assert.deepEqual(files.results.map((r) => r.rel), ['daily/2026-11-05.md'])
  assert.equal(fakeIndexSearch({ mode: 'files', glob: '**/daily/*.md' }).total, 1)
  assert.equal(fakeIndexSearch({ mode: 'files', path: 'notes' }).total, 1)
  assert.equal(fakeIndexSearch({ mode: 'files', path: 'projects' }).results[0].rel, 'projects/beta.md')

  const recent = fakeIndexSearch({ mode: 'recent', limit: 2 })
  assert.deepEqual(recent.results.map((r) => r.rel), ['notes/alpha-note.md', 'daily/2026-11-05.md'])
  assert.equal(recent.total, 5)

  const headings = fakeIndexSearch({ mode: 'headings', query: 'alpha' })
  assert.ok(headings.results.length >= 1)
  assert.ok(headings.results.every((r) => r.rel === 'notes/alpha-note.md'))
  assert.ok(headings.results.some((r) => r.heading === 'Alpha Details' && r.level === 2))

  const open = fakeIndexSearch({ mode: 'tasks', query: 'open' })
  assert.deepEqual(open.results.map((r) => r.rel).sort(), ['daily/2026-11-05.md', 'notes/alpha-note.md'])
  assert.ok(open.results.every((r) => r.checked === false))
  const done = fakeIndexSearch({ mode: 'tasks', query: 'done' })
  assert.ok(done.results.length >= 2)
  assert.ok(done.results.every((r) => r.checked === true))
  assert.deepEqual(fakeIndexSearch({ mode: 'tasks', query: 'standup' }).results.map((r) => r.rel), ['daily/2026-11-05.md'])

  const filtered = fakeIndexSearch({ mode: 'files', modifiedAfter: 3_500 })
  assert.deepEqual(filtered.results.map((r) => r.rel).sort(), ['daily/2026-11-05.md', 'notes/alpha-note.md'])

  const page1 = fakeIndexSearch({ mode: 'files', limit: 2, offset: 0 })
  const page2 = fakeIndexSearch({ mode: 'files', limit: 2, offset: 2 })
  assert.equal(page1.total, 5)
  assert.equal(page1.results.length, 2)
  assert.equal(page1.truncated, true)
  assert.equal(page2.results.length, 2)
  const overlapped = page1.results.filter((a) => page2.results.some((b) => b.rel === a.rel))
  assert.deepEqual(overlapped, [], 'pages must not overlap')
})

const searchBooted = (() => {
  if (!toolsSearchModule) return null
  const handle = makeCtx()
  try {
    const rt = { index: async () => fakeIndex }
    const dispose = toolsSearchModule.registerSearchTools(handle.ctx, rt)
    handle.disposers.push(dispose)
  } catch (error) {
    return { ...handle, error }
  }
  return { ...handle, error: null }
})()

test('tools-search isolation: registers exactly obsidian_search, schema is standard JSON Schema', { skip: toolsSearchModule ? false : 'lib/tools-search.js not importable' }, () => {
  assert.equal(searchBooted.error, null, `registerSearchTools failed: ${searchBooted.error && searchBooted.error.message}`)
  assert.deepEqual([...searchBooted.registered.keys()], ['obsidian_search'])
  assertToolDefinition(searchBooted.registered.get('obsidian_search'))
  const required = searchBooted.registered.get('obsidian_search').parameters.required
  assert.deepEqual(required, ['mode'])
  searchBooted.disposeAll()
  assert.equal(searchBooted.registered.size, 0)
})

test('tools-search isolation: every mode executes, matches schema and renders compactly', { skip: toolsSearchModule ? false : 'lib/tools-search.js not importable' }, async () => {
  const handle = makeCtx()
  toolsSearchModule.registerSearchTools(handle.ctx, { index: async () => fakeIndex })
  const calls = [
    { mode: 'text', query: 'zebraquartz' },
    { mode: 'text', query: '量子纠缠' },
    { mode: 'phrase', query: 'quick brown fox' },
    { mode: 'regex', regex: 'zebra[a-z]+' },
    { mode: 'tag', tag: 'project' },
    { mode: 'property', propertyKey: 'status', propertyValue: 'active' },
    { mode: 'link', note: 'projects/beta' },
    { mode: 'files', query: 'daily' },
    { mode: 'recent', limit: 2 },
    { mode: 'headings', query: 'alpha' },
    { mode: 'tasks', query: 'open' },
    { mode: 'stats' },
  ]
  for (const args of calls) {
    const { value, text } = await callAndRenderOn(handle, 'obsidian_search', args)
    assert.equal(value.mode, args.mode)
    assert.equal(typeof value.total, 'number')
    assert.equal(typeof value.tookMs, 'number')
    assert.equal(typeof value.truncated, 'boolean')
    assert.ok(Array.isArray(value.results))
    assert.ok(text.length > 0, `mode=${args.mode} rendered nothing`)
    if (args.mode === 'stats') {
      assert.ok(value.stats && typeof value.stats === 'object')
      assert.equal(value.stats.ready, true)
    } else if (args.mode === 'text' && args.query === 'zebraquartz') {
      assert.equal(value.results[0].rel, 'notes/alpha-note.md')
      assert.match(text, /obsidian_search\(text\): 1 match/)
    }
  }
  handle.disposeAll()

  // Render cap: 300 synthetic hits must not dump > ~8000 chars into context.
  const many = []
  for (let i = 0; i < 300; i += 1) {
    many.push(fakeRecord({ rel: `bulk/note-${String(i).padStart(3, '0')}.md`, body: 'bulkword content for render cap\n', mtimeMs: i }))
  }
  const bulkIndex = makeFakeIndex(many)
  const bulk = makeCtx()
  toolsSearchModule.registerSearchTools(bulk.ctx, { index: async () => bulkIndex })
  const rendered = await callAndRenderOn(bulk, 'obsidian_search', { mode: 'text', query: 'bulkword', limit: 200 })
  assert.equal(rendered.value.total, 300)
  assert.ok(rendered.text.length <= 8_500, `render must stay near the 8000-char cap, got ${rendered.text.length}`)
  assert.match(rendered.text, /capped at 8000 chars/)
  bulk.disposeAll()
})

// ---------------------------------------------------------------------------
// Phase 1e — lib/frontmatter.js (independent of vault/indexer)
// ---------------------------------------------------------------------------

let frontmatterModule
try {
  frontmatterModule = await import('../lib/frontmatter.js')
} catch {
  frontmatterModule = undefined
}
const SKIP_FM = frontmatterModule ? false : 'lib/frontmatter.js not importable'

const FM_SAMPLE = `---
title: Welcome
tags: [a, b]
status: active
priority: 3
nested:
  key: value
list:
  - one
  - two
block: |
  line1
  line2
quoted: "hello: world"
flag: true
empty: null
---
# Heading

Body text.
`

test('frontmatter: parseFrontmatter exposes has/data/body/bodyOffset invariants', { skip: SKIP_FM }, () => {
  const parsed = frontmatterModule.parseFrontmatter(FM_SAMPLE)
  assert.equal(parsed.has, true)
  assert.equal(parsed.body, FM_SAMPLE.slice(parsed.bodyOffset), 'body must be the original text from bodyOffset on')
  assert.equal(parsed.body.startsWith('# Heading'), true)
  assert.equal(parsed.data.title, 'Welcome')
  assert.deepEqual(parsed.data.tags, ['a', 'b'])
  assert.deepEqual(parsed.data.nested, { key: 'value' })
  assert.deepEqual(parsed.data.list, ['one', 'two'])
  assert.match(parsed.data.block, /line1\nline2/, 'block scalar | keeps newlines')
  assert.equal(parsed.data.quoted, 'hello: world')
  assert.equal(parsed.data.priority, 3)
  assert.equal(parsed.data.flag, true)
  assert.equal(parsed.data.empty, null)
  assert.equal('__raw' in parsed.data, false, 'successful parses must not fall back to __raw')

  const plain = frontmatterModule.parseFrontmatter('# No frontmatter\n')
  assert.deepEqual(plain, { has: false, data: {}, body: '# No frontmatter\n', bodyOffset: 0 })
  const empty = frontmatterModule.parseFrontmatter('---\n---\nbody')
  assert.equal(empty.has, true)
  assert.deepEqual(empty.data, {})
  assert.equal(empty.body, 'body')
  const unterminated = frontmatterModule.parseFrontmatter('---\ntitle: x\nno closing fence')
  assert.equal(unterminated.has, false)
  assert.equal(unterminated.body, '---\ntitle: x\nno closing fence', 'unterminated frontmatter is treated as plain body')
})

test('frontmatter: malformed YAML preserves raw text and body (no data loss)', { skip: SKIP_FM }, () => {
  const malformed = '---\ntags: [broken\nstatus: : :\n---\n# Body survives\n'
  const parsed = frontmatterModule.parseFrontmatter(malformed)
  assert.equal(parsed.has, true)
  assert.equal(typeof parsed.data.__raw, 'string', 'unparseable YAML must be kept in data.__raw')
  assert.equal(parsed.body, '# Body survives\n', 'the body must survive a frontmatter parse failure')
  assert.equal(typeof parsed.error, 'string', 'parseFrontmatter should report the parse error')
  const rebuilt = frontmatterModule.stringifyFrontmatter(parsed.data, parsed.body)
  assert.equal(rebuilt, malformed, 'a failed parse must round-trip byte-for-byte instead of losing data')
})

test('frontmatter: unchanged frontmatter round-trips byte-for-byte; merged writes update values', { skip: SKIP_FM }, () => {
  const parsed = frontmatterModule.parseFrontmatter(FM_SAMPLE)
  assert.equal(frontmatterModule.stringifyFrontmatter(parsed.data, parsed.body), FM_SAMPLE)

  const merged = frontmatterModule.mergeFrontmatter(parsed.data, { status: 'done', extra: 1 })
  assert.equal(merged.status, 'done')
  assert.deepEqual(merged.tags, ['a', 'b'], 'merge must keep untouched keys')
  assert.equal('__raw' in merged, false)
  const written = frontmatterModule.stringifyFrontmatter(merged, parsed.body)
  assert.match(written, /status: done/)
  assert.match(written, /extra: 1/)
  assert.ok(written.endsWith('# Heading\n\nBody text.\n'))

  const dropped = frontmatterModule.mergeFrontmatter(parsed.data, { tags: undefined })
  assert.equal('tags' in dropped, false, 'undefined patch value deletes the key')
  const replaced = frontmatterModule.mergeFrontmatter(parsed.data, { tags: ['x'] })
  assert.deepEqual(replaced.tags, ['x'], 'arrays are replaced, not concatenated')
})

test('frontmatter: YAML subset parser/stringifier round-trip', { skip: SKIP_FM }, () => {
  const yaml = 'a: 1\nb: 2.5\nc: true\nd: null\ne: [x, y, 3]\nf:\n  g: h\ni:\n  - one\n  - two\n'
  const data = frontmatterModule.yamlParse(yaml)
  assert.deepEqual(data, { a: 1, b: 2.5, c: true, d: null, e: ['x', 'y', 3], f: { g: 'h' }, i: ['one', 'two'] })
  const text = frontmatterModule.yamlStringify(data)
  assert.deepEqual(frontmatterModule.yamlParse(text), data, 'yamlStringify output must parse back to the same data')
})

test('frontmatter: parseLinks finds wiki/alias/heading/embed/markdown links and skips code', { skip: SKIP_FM }, () => {
  const body =
    'Text [[Target]] and [[Target|Alias]] and [[Target#Head]] and [[Target#Head|Alias2]] ' +
    'and ![[img.png]] and [md](notes/x.md) and `[[inline-code]]`.\n\n```\n[[fenced]]\n```\n'
  const links = frontmatterModule.parseLinks(body)
  const wiki = links.filter((link) => link.type === 'wiki')
  const md = links.filter((link) => link.type === 'md')
  assert.ok(wiki.some((link) => link.target === 'Target' && link.alias === undefined))
  assert.ok(wiki.some((link) => link.target === 'Target' && link.alias === 'Alias'))
  assert.ok(wiki.some((link) => link.target === 'Target' && link.heading === 'Head'))
  assert.ok(wiki.some((link) => link.target === 'img.png'), 'embeds are reported as links')
  assert.ok(md.some((link) => link.target === 'notes/x.md'))
  assert.equal(links.some((link) => String(link.target).includes('inline-code')), false, 'inline code links are ignored')
  assert.equal(links.some((link) => String(link.target).includes('fenced')), false, 'fenced code links are ignored')
  for (const link of links) assert.equal(typeof link.raw, 'string')
})

test('frontmatter: parseTags dedupes, strips #, merges frontmatter tags, ignores code', { skip: SKIP_FM }, () => {
  const body = 'Body #alpha and #Beta/nested and #dup #dup.\n\n```\n#fenced-tag\n```\n'
  const tags = frontmatterModule.parseTags(body, { tags: ['front', 'alpha'] })
  const lower = tags.map((tag) => tag.toLowerCase())
  assert.ok(lower.includes('alpha'))
  assert.ok(lower.includes('front'))
  assert.ok(lower.includes('beta/nested'))
  assert.ok(lower.includes('dup'))
  assert.equal(lower.filter((tag) => tag === 'dup').length, 1, 'duplicate tags are collapsed')
  assert.equal(tags.some((tag) => tag.startsWith('#')), false, 'leading # is stripped')
  assert.equal(lower.includes('fenced-tag'), false, 'tags in fenced code are ignored')
})

test('frontmatter: parseHeadings / parseTasks report source lines and skip code fences', { skip: SKIP_FM }, () => {
  const body = '# One\n\ntext\n\n## Two ##\n\n```js\n# fenced heading\n- [ ] fenced task\n```\n\n- [ ] open task\n- [x] done task\n'
  const headings = frontmatterModule.parseHeadings(body)
  assert.deepEqual(headings.map((h) => [h.level, h.text, h.line]), [
    [1, 'One', 0],
    [2, 'Two', 4],
  ])
  const tasks = frontmatterModule.parseTasks(body)
  assert.deepEqual(tasks.map((t) => [t.checked, t.text, t.line]), [
    [false, 'open task', 11],
    [true, 'done task', 12],
  ])
})

test('frontmatter: extractTitle prefers frontmatter title, then first H1, then filename', { skip: SKIP_FM }, () => {
  const extract = frontmatterModule.extractTitle
  assert.equal(extract('dir/x.md', { title: 'FM Title' }, '# H1\n'), 'FM Title')
  assert.equal(extract('dir/x.md', {}, '# H1\n'), 'H1')
  assert.equal(extract('dir/x-name.md', {}, 'no heading\n'), 'x-name')
})

test('frontmatter: CRLF and BOM inputs parse without corrupting values or body', { skip: SKIP_FM }, () => {
  const crlf = '---\r\ntags: [windows]\r\nstatus: active\r\n---\r\n# CRLF\r\n\r\nBody\r\n'
  const parsed = frontmatterModule.parseFrontmatter(crlf)
  assert.equal(parsed.has, true)
  assert.deepEqual(parsed.data.tags, ['windows'])
  assert.equal(parsed.data.status, 'active')
  assert.equal(parsed.body, '# CRLF\r\n\r\nBody\r\n')
  const bom = frontmatterModule.parseFrontmatter('\uFEFF---\ntags: [bom]\n---\nbody\n')
  assert.equal(bom.has, true)
  assert.deepEqual(bom.data.tags, ['bom'])
})

// ---------------------------------------------------------------------------
// Phase 2 — full behavior matrix through apply() + all 8 tools
// ---------------------------------------------------------------------------

const HEX16 = /^[0-9a-f]{16}$/

function scratch(name) {
  return `verify-scratch/${name}`
}

async function withTools(fn, options = {}) {
  const handle = boot(options)
  assert.equal(handle.error, null, `apply() failed for ${JSON.stringify(options)}: ${handle.error && handle.error.message}`)
  try {
    return await fn(handle)
  } finally {
    handle.disposeAll()
  }
}

// ---------------------------------------------------------------- read

test('full: obsidian_read by path returns content, metadata and a version', { skip: SKIP }, async () => {
  await withTools(async (handle) => {
    const { value, text, blocks } = await callAndRenderOn(handle, 'obsidian_read', { path: NOTES.english })
    assert.equal(value.path, NOTES.english)
    assert.match(value.content, /zebraquartz/)
    assert.equal(value.truncated, false)
    assert.match(value.version, HEX16)
    assert.ok(value.totalLines > 5)
    assert.equal(value.size, fs.statSync(path.join(fixture.root, NOTES.english)).size)
    assert.equal(blocks[0].type, 'text')
    assert.match(text, /zebraquartz/)
    assert.match(text, /version [0-9a-f]{16}/)
  })
})

test('full: obsidian_read resolves note names and wikilink-style paths', { skip: SKIP }, async () => {
  await withTools(async (handle) => {
    for (const target of [{ note: 'english-note' }, { note: '[[english-note]]' }, { note: 'notes/english-note' }, { note: 'notes/english-note.md' }]) {
      const { value } = await callAndRenderOn(handle, 'obsidian_read', target)
      assert.equal(value.path, NOTES.english, `note target ${JSON.stringify(target)} resolved to ${value.path}`)
    }
    const byPath = await callAndRenderOn(handle, 'obsidian_read', { path: NOTES.welcome })
    assert.equal(byPath.value.path, NOTES.welcome)
  })
})

test('DEFECT-CHECK full: note resolution should honor frontmatter aliases/titles (ARCHITECTURE: 标题/文件名/路径后缀)', { skip: SKIP }, async () => {
  await withTools(async (handle) => {
    // Welcome.md declares aliases: [Home, 首页]; indexer.resolveNote() resolves
    // titles and aliases, but vault.resolve() (used by read/write) does not.
    const alias = await handle.registered.get('obsidian_read').execute({ note: 'Home' }, {}).then(
      (value) => ({ ok: true, path: value.path }),
      (error) => ({ ok: false, message: error.message }),
    )
    assert.equal(alias.ok, true, `alias "Home" should resolve to Welcome.md but failed: ${alias.message}`)
    const title = await handle.registered.get('obsidian_read').execute({ note: 'English Note' }, {}).then(
      (value) => ({ ok: true, path: value.path }),
      (error) => ({ ok: false, message: error.message }),
    )
    assert.equal(title.ok, true, `H1 title "English Note" should resolve to notes/english-note.md but failed: ${title.message}`)
  })
})

test('full: obsidian_read handles empty / CRLF / BOM / malformed-frontmatter notes', { skip: SKIP }, async () => {
  await withTools(async (handle) => {
    const empty = await callAndRenderOn(handle, 'obsidian_read', { path: NOTES.empty })
    assert.equal(empty.value.content, '')
    assert.equal(empty.value.truncated, false)
    assert.equal(empty.value.totalLines, 0)
    assert.match(empty.text, /empty note/)

    const crlf = await callAndRenderOn(handle, 'obsidian_read', { path: NOTES.crlf })
    assert.match(crlf.value.content, /Line one/)
    assert.match(crlf.value.content, /Line two/)

    const bom = await callAndRenderOn(handle, 'obsidian_read', { path: NOTES.bom })
    assert.match(bom.value.content, /BOM marker/)
    assert.equal(bom.value.content.startsWith('\uFEFF'), false, 'BOM must be stripped from content')

    const malformed = await callAndRenderOn(handle, 'obsidian_read', { path: NOTES.malformed, include: ['frontmatter', 'tags'] })
    assert.match(malformed.value.content, /Malformed Frontmatter/)
    assert.equal(typeof malformed.value.frontmatter.__raw, 'string', 'malformed frontmatter must be preserved as __raw')
    assert.ok(Array.isArray(malformed.value.tags))
  })
})

test('full: obsidian_read truncates a 2MB note and never returns the whole file', { skip: SKIP }, async () => {
  await withTools(async (handle) => {
    const { value, text } = await callAndRenderOn(handle, 'obsidian_read', { path: NOTES.big })
    assert.equal(value.truncated, true)
    assert.match(String(value.truncatedReason), /file_size|max_chars/)
    assert.ok(value.content.length <= 6_000, `content must be capped at 6000 chars, got ${value.content.length}`)
    assert.ok(value.size > 2 * 1024 * 1024)
    assert.ok(text.length < 20_000)
  })
})

test('full: obsidian_read offset/limit windows lines and reports line_window truncation', { skip: SKIP }, async () => {
  await withTools(async (handle) => {
    const full = await callAndRenderOn(handle, 'obsidian_read', { path: NOTES.welcome })
    assert.ok(full.value.totalLines > 4)
    const window = await callAndRenderOn(handle, 'obsidian_read', { path: NOTES.welcome, offset: 1, limit: 2 })
    assert.equal(window.value.lineStart, 2)
    assert.equal(window.value.lineEnd, 3)
    assert.equal(window.value.truncated, true)
    assert.equal(window.value.content.split('\n').length <= 2, true)
    const tail = await callAndRenderOn(handle, 'obsidian_read', { path: NOTES.welcome, offset: 0, limit: 0 })
    assert.equal(tail.value.truncated, full.value.totalLines > 0 ? tail.value.truncated : false)
  })
})

test('full: obsidian_read include flags add frontmatter/links/tags/headings/tasks/backlinks', { skip: SKIP }, async () => {
  await withTools(async (handle) => {
    const { value } = await callAndRenderOn(handle, 'obsidian_read', {
      path: NOTES.welcome,
      include: ['frontmatter', 'links', 'backlinks', 'tags', 'headings', 'tasks'],
    })
    assert.equal(value.frontmatter.status, 'active')
    assert.equal(value.frontmatter.priority, 'high')
    assert.ok(value.links.some((link) => link.target === '欢迎'))
    assert.ok(value.links.some((link) => link.target === 'projects/alpha' && link.alias === 'Alpha project'))
    assert.ok(value.links.some((link) => link.target === 'image.png'), 'embeds are reported in links')
    assert.ok(value.tags.includes('welcome'))
    assert.ok(value.headings.some((heading) => heading.text === 'Welcome' && heading.level === 1))
    assert.ok(value.tasks.some((task) => task.checked === false))
    assert.ok(Array.isArray(value.backlinks))
    assert.ok(value.backlinks.some((backlink) => backlink.from === NOTES.chineseWelcome), '欢迎 links back to Welcome')
  })
})

test('full: obsidian_read rejects missing notes and every traversal escape', { skip: SKIP }, async () => {
  await withTools(async (handle) => {
    await assert.rejects(
      () => handle.registered.get('obsidian_read').execute({ path: 'does/not/exist.md' }, {}),
      (error) => {
        assert.match(error.message, /not found/i)
        return true
      },
    )
    // Escapes must never resolve to a readable path. Depending on whether the
    // caller used `path` (goes through note resolution first) or `note`, the
    // failure may be a path_escape error or a not-found error — both are safe,
    // but the message must never contain file content from outside the vault.
    const attacks = ['../../etc/passwd', '..\\..\\windows\\win.ini', 'C:\\Windows\\win.ini', '\\\\server\\share', 'notes/../../escape.md']
    for (const attack of attacks) {
      await assert.rejects(
        () => handle.registered.get('obsidian_read').execute({ path: attack }, {}),
        (error) => {
          assert.match(error.message, /escapes the vault|absolute paths|not allowed|not found/i, `attack ${attack}: ${error.message}`)
          assert.equal(error.message.includes('root:'), false, 'an escape must never leak outside file content')
          return true
        },
        `traversal ${attack} must be rejected`,
      )
    }
    // Direct vault path normalization must reject hard with a path_escape code.
    const fsTool = handle.registered.get('obsidian_fs')
    await assert.rejects(
      () => fsTool.execute({ action: 'list', path: '../../' }, {}),
      (error) => {
        assert.equal(error.code, 'path_escape')
        return true
      },
    )
    await assert.rejects(
      () => fsTool.execute({ action: 'move', path: NOTES.welcome, dest: '../escape.md' }, {}),
      (error) => {
        assert.equal(error.code, 'path_escape')
        return true
      },
    )
  })
})

test('DEFECT-CHECK full: obsidian_read on a binary attachment must fail gracefully, not return mojibake', { skip: SKIP }, async () => {
  await withTools(async (handle) => {
    const outcome = await handle.registered.get('obsidian_read').execute({ path: NOTES.image }, {}).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, message: error.message, code: error.code }),
    )
    if (outcome.ok) {
      const badChars = (outcome.value.content.match(/\uFFFD/g) || []).length
      assert.fail(
        `binary read did not fail cleanly: returned ${outcome.value.content.length} chars (${badChars} replacement chars), truncated=${outcome.value.truncated}`,
      )
    }
    assert.match(outcome.message, /binary|not a text|not text|unsupported/i, `binary read error must be actionable, got: ${outcome.message}`)
  })
})

// ---------------------------------------------------------------- write

test('full: obsidian_write creates, appends, prepends and reads back', { skip: SKIP }, async () => {
  await withTools(async (handle) => {
    const created = await callAndRenderOn(handle, 'obsidian_write', { path: scratch('a.md'), content: '# Scratch A\n\nfirst line\n', mode: 'overwrite' })
    assert.equal(created.value.action, 'created')
    assert.match(created.value.version, HEX16)

    const appended = await callAndRenderOn(handle, 'obsidian_write', { path: scratch('a.md'), content: 'appended line\n', mode: 'append' })
    assert.equal(appended.value.action, 'appended')
    const afterAppend = await callAndRenderOn(handle, 'obsidian_read', { path: scratch('a.md') })
    assert.match(afterAppend.value.content, /first line[\s\S]*appended line/)

    const prepended = await callAndRenderOn(handle, 'obsidian_write', { path: scratch('a.md'), content: 'prepended line\n', mode: 'prepend' })
    assert.equal(prepended.value.action, 'prepended')
    const afterPrepend = await callAndRenderOn(handle, 'obsidian_read', { path: scratch('a.md') })
    assert.match(afterPrepend.value.content, /^prepended line/)
    assert.match(afterPrepend.value.content, /appended line/)
  })
})

test('full: obsidian_write mode=create refuses to overwrite, clear errors for bad input', { skip: SKIP }, async () => {
  await withTools(async (handle) => {
    await handle.registered.get('obsidian_write').execute({ path: scratch('create-me.md'), content: 'x', mode: 'overwrite' }, {})
    await assert.rejects(
      () => handle.registered.get('obsidian_write').execute({ path: scratch('create-me.md'), content: 'y', mode: 'create' }, {}),
      /already exists/i,
    )
    await assert.rejects(() => handle.registered.get('obsidian_write').execute({ path: '', content: 'x' }, {}), /path|invalid/i)
    await assert.rejects(() => handle.registered.get('obsidian_write').execute({ path: scratch('no-content.md') }, {}), /content is required/i)
    await assert.rejects(
      () => handle.registered.get('obsidian_write').execute({ path: scratch('missing/parents/note.md'), content: 'x', createDirs: false }, {}),
      /parent|not found|does not exist/i,
    )
    await assert.rejects(
      () => handle.registered.get('obsidian_write').execute({ path: '../../escape.md', content: 'x' }, {}),
      /escapes the vault|not allowed/i,
    )
  })
})

test('full: obsidian_write patch modes (literal, all, regex, missing text)', { skip: SKIP }, async () => {
  await withTools(async (handle) => {
    await handle.registered.get('obsidian_write').execute({ path: scratch('patch.md'), content: 'alpha beta alpha\n', mode: 'overwrite' }, {})
    const single = await callAndRenderOn(handle, 'obsidian_write', { path: scratch('patch.md'), mode: 'patch', find: 'alpha', replace: 'ALPHA' })
    assert.equal(single.value.action, 'patched')
    assert.equal(single.value.replacements, 1)
    let content = (await callAndRenderOn(handle, 'obsidian_read', { path: scratch('patch.md') })).value.content
    assert.equal(content, 'ALPHA beta alpha\n')

    const all = await callAndRenderOn(handle, 'obsidian_write', { path: scratch('patch.md'), mode: 'patch', find: 'alpha', replace: 'x', all: true })
    assert.equal(all.value.replacements, 1, 'only the remaining lowercase occurrence matches')
    const regex = await callAndRenderOn(handle, 'obsidian_write', { path: scratch('patch.md'), mode: 'patch', find: '[A-Z]+', replace: 'word', regex: true })
    assert.equal(regex.value.replacements, 1)
    content = (await callAndRenderOn(handle, 'obsidian_read', { path: scratch('patch.md') })).value.content
    assert.match(content, /word/)

    await assert.rejects(
      () => handle.registered.get('obsidian_write').execute({ path: scratch('patch.md'), mode: 'patch', find: 'no-such-text', replace: 'x' }, {}),
      /not found|did not match/i,
    )
    await assert.rejects(
      () => handle.registered.get('obsidian_write').execute({ path: scratch('missing-patch.md'), mode: 'patch', find: 'a', replace: 'b' }, {}),
      /missing|not found/i,
    )
  })
})

test('full: obsidian_write frontmatter merge preserves unrelated keys and updates values', { skip: SKIP }, async () => {
  await withTools(async (handle) => {
    const before = await callAndRenderOn(handle, 'obsidian_read', { path: scratch('fm.md') }).catch(() => null)
    assert.equal(before, null, 'scratch/fm.md must not exist yet')
    await handle.registered.get('obsidian_write').execute(
      { path: scratch('fm.md'), content: '---\ntags: [one, two]\nstatus: draft\nkeep: yes\n---\n# FM\n\nbody\n', mode: 'overwrite' },
      {},
    )
    const read1 = await callAndRenderOn(handle, 'obsidian_read', { path: scratch('fm.md') })
    const written = await handle.registered.get('obsidian_write').execute(
      { path: scratch('fm.md'), content: read1.value.content, mode: 'overwrite', frontmatter: { status: 'final', extra: 3 } },
      {},
    )
    assert.equal(written.action, 'overwritten')
    const read2 = await callAndRenderOn(handle, 'obsidian_read', { path: scratch('fm.md'), include: ['frontmatter'] })
    assert.equal(read2.value.frontmatter.status, 'final')
    assert.equal(read2.value.frontmatter.extra, 3)
    assert.deepEqual(read2.value.frontmatter.tags, ['one', 'two'])
    assert.equal(read2.value.frontmatter.keep, 'yes')

    const cleared = await handle.registered.get('obsidian_write').execute(
      { path: scratch('fm.md'), content: read2.value.content, mode: 'overwrite', frontmatter: { extra: null } },
      {},
    )
    assert.equal(cleared.action, 'overwritten')
    const read3 = await callAndRenderOn(handle, 'obsidian_read', { path: scratch('fm.md'), include: ['frontmatter'] })
    assert.ok(read3.value.frontmatter.extra === null || !('extra' in read3.value.frontmatter), 'null must clear the key')
  })
})

test('full: obsidian_write expectedVersion enforces optimistic concurrency', { skip: SKIP }, async () => {
  await withTools(async (handle) => {
    await handle.registered.get('obsidian_write').execute({ path: scratch('ver.md'), content: 'v1\n', mode: 'overwrite' }, {})
    const read = await callAndRenderOn(handle, 'obsidian_read', { path: scratch('ver.md') })
    const version = read.value.version
    const ok = await callAndRenderOn(handle, 'obsidian_write', { path: scratch('ver.md'), content: 'v2\n', mode: 'overwrite', expectedVersion: version })
    assert.equal(ok.value.action, 'overwritten')
    await assert.rejects(
      () => handle.registered.get('obsidian_write').execute({ path: scratch('ver.md'), content: 'v3\n', mode: 'overwrite', expectedVersion: version }, {}),
      (error) => {
        assert.match(error.message, /version mismatch/i)
        assert.equal(error.code, 'version_mismatch')
        return true
      },
    )
    const final = await callAndRenderOn(handle, 'obsidian_read', { path: scratch('ver.md') })
    assert.equal(final.value.content, 'v2\n', 'the stale write must not have changed the note')

    // Concurrent writers holding the SAME expectedVersion: the write queue must
    // let exactly one win and reject the other with version_mismatch.
    const fresh = (await callAndRenderOn(handle, 'obsidian_read', { path: scratch('ver.md') })).value.version
    const race = await Promise.all(
      [0, 1].map((writer) =>
        handle.registered
          .get('obsidian_write')
          .execute({ path: scratch('ver.md'), content: `writer-${writer}\n`, mode: 'overwrite', expectedVersion: fresh }, {})
          .then(() => ({ ok: true }))
          .catch((error) => ({ ok: false, code: error.code })),
      ),
    )
    assert.equal(race.filter((result) => result.ok).length, 1, 'exactly one concurrent writer may win')
    assert.equal(race.find((result) => !result.ok).code, 'version_mismatch')
  })
})

test('full: obsidian_write newline=crlf produces CRLF bytes', { skip: SKIP }, async () => {
  await withTools(async (handle) => {
    await callAndRenderOn(handle, 'obsidian_write', { path: scratch('crlf-out.md'), content: 'one\ntwo\n', mode: 'overwrite', newline: 'crlf' })
    const raw = fs.readFileSync(path.join(fixture.root, scratch('crlf-out.md')), 'utf8')
    assert.ok(raw.includes('\r\n'), 'newline=crlf must write CRLF line endings')
    const read = await callAndRenderOn(handle, 'obsidian_read', { path: scratch('crlf-out.md') })
    assert.match(read.value.content, /one\ntwo/)
  })
})

test('DEFECT-CHECK full: concurrent appends to one note must not silently lose reported-ok writes', { skip: SKIP }, async () => {
  await withTools(async (handle) => {
    const note = scratch('concurrent.md')
    await handle.registered.get('obsidian_write').execute({ path: note, content: 'start\n', mode: 'overwrite' }, {})
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        handle.registered
          .get('obsidian_write')
          .execute({ path: note, content: `line-${i}\n`, mode: 'append' }, {})
          .then(() => ({ i, ok: true }))
          .catch((error) => ({ i, ok: false, code: error.code, message: error.message })),
      ),
    )
    const okLines = results.filter((result) => result.ok).map((result) => `line-${result.i}`)
    const final = (await callAndRenderOn(handle, 'obsidian_read', { path: note })).value.content
    const missing = okLines.filter((line) => !final.includes(line))
    assert.deepEqual(
      missing,
      [],
      `concurrent appends reported ok but their text is missing (lost updates). ok=${okLines.length}, failed=${results.length - okLines.length}, final=${JSON.stringify(final)}`,
    )
  })
})

// ---------------------------------------------------------------- batch read / write

test('full: obsidian_batch_read by paths, glob, query, with per-item errors', { skip: SKIP }, async () => {
  await withTools(async (handle) => {
    const byPaths = await callAndRenderOn(handle, 'obsidian_batch_read', { paths: [NOTES.english, NOTES.welcome] })
    assert.equal(byPaths.value.total, 2)
    assert.equal(byPaths.value.returned, 2)
    assert.equal(byPaths.value.notes.every((note) => note.ok), true)
    assert.equal(byPaths.value.truncated, false)

    const partial = await callAndRenderOn(handle, 'obsidian_batch_read', { paths: [NOTES.english, 'does/not/exist.md'] })
    assert.equal(partial.value.total, 2)
    assert.equal(partial.value.notes.length, 2)
    assert.equal(partial.value.notes[0].ok, true)
    assert.equal(partial.value.notes[1].ok, false)
    assert.match(partial.value.notes[1].error, /not found/i)
    assert.ok(Array.isArray(partial.value.warnings) && partial.value.warnings.length > 0)

    const byGlob = await callAndRenderOn(handle, 'obsidian_batch_read', { glob: 'daily/*.md' })
    assert.equal(byGlob.value.total, 2)
    assert.ok(byGlob.value.notes.every((note) => note.path.startsWith('daily/')))

    const byQuery = await callAndRenderOn(handle, 'obsidian_batch_read', { query: 'projects/' })
    assert.equal(byQuery.value.total, 3)

    const limited = await callAndRenderOn(handle, 'obsidian_batch_read', { query: 'projects/', limit: 1 })
    assert.equal(limited.value.returned, 1)
    assert.equal(limited.value.truncated, true)
    assert.equal(limited.value.total, 3)
  })
})

test('full: obsidian_batch_write runs mixed operations and reports per-item results', { skip: SKIP }, async () => {
  await withTools(async (handle) => {
    const result = await callAndRenderOn(handle, 'obsidian_batch_write', {
      operations: [
        { type: 'mkdir', path: scratch('batch-dir') },
        { type: 'write', path: scratch('batch-dir/one.md'), content: '# One\n\ncontent one\n' },
        { type: 'append', path: scratch('batch-dir/one.md'), content: 'appended\n' },
        { type: 'patch', path: scratch('batch-dir/one.md'), find: 'content one', replace: 'content ONE' },
        { type: 'copy', path: scratch('batch-dir/one.md'), dest: scratch('batch-dir/copy.md') },
        { type: 'move', path: scratch('batch-dir/copy.md'), dest: scratch('batch-dir/moved.md') },
        { type: 'delete', path: scratch('batch-dir/moved.md') },
        { type: 'trash', path: scratch('batch-dir/one.md') },
        { type: 'mkdir', path: scratch('batch-dir') },
      ],
    })
    assert.equal(result.value.total, 9)
    assert.equal(result.value.succeeded, 9, JSON.stringify(result.value.results))
    assert.equal(result.value.failed, 0)
    assert.equal(result.value.skipped, 0)
    assert.deepEqual(
      result.value.results.map((item) => item.index),
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
    )
    assert.equal(result.value.results[8].action, 'exists', 'mkdir on an existing folder reports exists')
    assert.equal(fs.existsSync(path.join(fixture.root, scratch('batch-dir/one.md'))), false, 'trash must remove the note')
    assert.equal(fs.existsSync(path.join(fixture.root, '.trash', scratch('batch-dir/one.md'))), true, 'trash mode moves the note into .trash')
  })
})

test('full: obsidian_batch_write validates the whole batch up front (per-item errors, no partial invalid write)', { skip: SKIP }, async () => {
  await withTools(async (handle) => {
    // Validation is per-item: every operation is shape-checked before execution,
    // invalid ones are reported, valid ones still run, and the invalid one must
    // never touch the filesystem.
    const result = await callAndRenderOn(handle, 'obsidian_batch_write', {
      operations: [
        { type: 'write', path: scratch('valid-op.md'), content: 'written\n' },
        { type: 'write', path: '', content: 'invalid operation' },
      ],
    })
    assert.equal(result.value.total, 2)
    assert.equal(result.value.succeeded, 1)
    assert.equal(result.value.failed, 1)
    assert.match(result.value.results[1].error, /"path" is required/i)
    assert.equal(fs.existsSync(path.join(fixture.root, scratch('valid-op.md'))), true, 'the valid operation must still run')
    assert.equal(fs.existsSync(path.join(fixture.root, 'invalid operation')), false)

    await assert.rejects(() => handle.registered.get('obsidian_batch_write').execute({ operations: [] }, {}), /at least one/i)
    await assert.rejects(() => handle.registered.get('obsidian_batch_write').execute({}, {}), /operations must be an array/i)
    const tooMany = Array.from({ length: 201 }, (_, i) => ({ type: 'mkdir', path: `verify-scratch/many/${i}` }))
    await assert.rejects(() => handle.registered.get('obsidian_batch_write').execute({ operations: tooMany }, {}), /at most 200/i)

    const badType = await callAndRenderOn(handle, 'obsidian_batch_write', {
      operations: [{ type: 'explode', path: scratch('x.md') }, { type: 'write', path: scratch('after-bad.md'), content: 'after\n' }],
    })
    assert.equal(badType.value.failed, 1)
    assert.equal(badType.value.succeeded, 1)
    assert.match(badType.value.results[0].error, /unknown type/i)
  })
})

test('full: obsidian_batch_write continueOnError=false stops and marks the rest skipped', { skip: SKIP }, async () => {
  await withTools(async (handle) => {
    const result = await callAndRenderOn(handle, 'obsidian_batch_write', {
      continueOnError: false,
      operations: [
        { type: 'write', path: scratch('stop-1.md'), content: 'ok\n' },
        { type: 'write', path: '', content: 'invalid' },
        { type: 'write', path: scratch('stop-2.md'), content: 'skipped\n' },
      ],
    })
    assert.equal(result.value.total, 3)
    assert.equal(result.value.succeeded, 1)
    assert.equal(result.value.failed, 1)
    assert.equal(result.value.skipped, 1)
    assert.equal(result.value.results[2].ok, false)
    assert.equal(result.value.results[2].skipped, true)
    assert.equal(fs.existsSync(path.join(fixture.root, scratch('stop-2.md'))), false)
  })
})

// ---------------------------------------------------------------- fs

test('full: obsidian_fs list/tree/stat respect exclusions and limits', { skip: SKIP }, async () => {
  await withTools(async (handle) => {
    const list = await callAndRenderOn(handle, 'obsidian_fs', { action: 'list', path: '' })
    assert.equal(list.value.action, 'list')
    assert.equal(list.value.path, '')
    const rels = list.value.entries.map((entry) => entry.rel)
    assert.ok(rels.includes('notes'))
    assert.ok(rels.includes(NOTES.welcome))
    assert.equal(rels.some((rel) => rel.startsWith('.obsidian')), false, '.obsidian must be excluded from list')
    assert.equal(rels.some((rel) => rel.startsWith('.trash')), false, '.trash must be excluded from list')
    for (const entry of list.value.entries) {
      assert.equal(typeof entry.rel, 'string')
      assert.ok(entry.type === 'file' || entry.type === 'dir')
      assert.equal(typeof entry.size, 'number')
      assert.equal(typeof entry.mtimeMs, 'number')
    }

    const recursive = await callAndRenderOn(handle, 'obsidian_fs', { action: 'list', path: '', recursive: true, glob: '**/*.md', limit: 5000 })
    assert.ok(recursive.value.entries.some((entry) => entry.rel === NOTES.english))
    assert.equal(recursive.value.entries.some((entry) => entry.rel.endsWith('.png')), false, 'glob must filter to notes')

    const limited = await callAndRenderOn(handle, 'obsidian_fs', { action: 'list', path: '', limit: 1 })
    assert.equal(limited.value.entries.length, 1)
    assert.equal(limited.value.truncated, true)

    const tree = await callAndRenderOn(handle, 'obsidian_fs', { action: 'tree', path: '', depth: 1, includeFiles: false })
    assert.equal(tree.value.tree.type, 'dir')
    assert.ok(Array.isArray(tree.value.tree.children))
    assert.ok(tree.value.total > 0)
    assert.ok(tree.value.tree.children.every((child) => child.type === 'dir'), 'includeFiles:false hides files')

    const stat = await callAndRenderOn(handle, 'obsidian_fs', { action: 'stat', path: NOTES.english })
    assert.equal(stat.value.exists, true)
    assert.equal(stat.value.entry.type, 'file')
    const missing = await callAndRenderOn(handle, 'obsidian_fs', { action: 'stat', path: 'nope.md' })
    assert.equal(missing.value.exists, false)
  })
})

test('full: obsidian_fs move/copy/delete/mkdir behave and stay inside the vault', { skip: SKIP }, async () => {
  await withTools(async (handle) => {
    await handle.registered.get('obsidian_write').execute({ path: scratch('fs-a.md'), content: '# A\n', mode: 'overwrite' }, {})
    const mkdir = await callAndRenderOn(handle, 'obsidian_fs', { action: 'mkdir', path: scratch('fs-dir') })
    assert.equal(mkdir.value.result, 'created')
    const again = await callAndRenderOn(handle, 'obsidian_fs', { action: 'mkdir', path: scratch('fs-dir') })
    assert.equal(again.value.result, 'exists')

    const copied = await callAndRenderOn(handle, 'obsidian_fs', { action: 'copy', path: scratch('fs-a.md'), dest: scratch('fs-dir/copy.md') })
    assert.equal(copied.value.from, scratch('fs-a.md'))
    assert.equal(copied.value.to, scratch('fs-dir/copy.md'))
    assert.equal(fs.existsSync(path.join(fixture.root, scratch('fs-dir/copy.md'))), true)

    await assert.rejects(
      () => handle.registered.get('obsidian_fs').execute({ action: 'copy', path: scratch('fs-a.md'), dest: scratch('fs-dir/copy.md') }, {}),
      /exists/i,
      'copy onto an existing destination must fail without overwrite:true',
    )
    const overwritten = await callAndRenderOn(handle, 'obsidian_fs', { action: 'copy', path: scratch('fs-a.md'), dest: scratch('fs-dir/copy.md'), overwrite: true })
    assert.equal(overwritten.value.to, scratch('fs-dir/copy.md'))

    const moved = await callAndRenderOn(handle, 'obsidian_fs', { action: 'move', path: scratch('fs-dir/copy.md'), dest: scratch('fs-dir/moved.md') })
    assert.equal(fs.existsSync(path.join(fixture.root, scratch('fs-dir/copy.md'))), false)
    assert.equal(fs.existsSync(path.join(fixture.root, scratch('fs-dir/moved.md'))), true)
    assert.equal(moved.value.to, scratch('fs-dir/moved.md'))

    const deleted = await callAndRenderOn(handle, 'obsidian_fs', { action: 'delete', path: scratch('fs-dir/moved.md') })
    assert.equal(deleted.value.result, 'trashed')
    assert.equal(fs.existsSync(path.join(fixture.root, '.trash', scratch('fs-dir/moved.md'))), true)

    await assert.rejects(
      () => handle.registered.get('obsidian_fs').execute({ action: 'delete', path: scratch('fs-dir') }, {}),
      /not empty|recursive/i,
      'deleting a non-empty folder requires recursive:true',
    )
    const recursive = await callAndRenderOn(handle, 'obsidian_fs', { action: 'delete', path: scratch('fs-dir'), recursive: true })
    assert.equal(recursive.value.result, 'trashed')

    await assert.rejects(() => handle.registered.get('obsidian_fs').execute({ action: 'move', path: scratch('fs-a.md'), dest: '../escape.md' }, {}), /escapes the vault|not allowed/i)
    await assert.rejects(() => handle.registered.get('obsidian_fs').execute({ action: 'list', path: '../../' }, {}), /escapes the vault|not allowed/i)
    await assert.rejects(() => handle.registered.get('obsidian_fs').execute({ action: 'nope', path: '' }, {}), /action must be one of/i)
  })
})

// ---------------------------------------------------------------- search (real index)

test('full: obsidian_search modes work against the real fixture index', { skip: SKIP }, async () => {
  await withTools(async (handle) => {
    const textZh = await callAndRenderOn(handle, 'obsidian_search', { mode: 'text', query: '量子纠缠' })
    assert.equal(textZh.value.results[0].rel, NOTES.chineseWelcome)
    const textEn = await callAndRenderOn(handle, 'obsidian_search', { mode: 'text', query: 'zebraquartz' })
    assert.equal(textEn.value.results[0].rel, NOTES.english)

    const phrase = await callAndRenderOn(handle, 'obsidian_search', { mode: 'phrase', query: 'quick brown fox' })
    assert.equal(phrase.value.results[0].rel, NOTES.english)

    const regex = await callAndRenderOn(handle, 'obsidian_search', { mode: 'regex', regex: 'zebra[a-z]+' })
    assert.ok(regex.value.results.some((result) => result.rel === NOTES.english))
    await assert.rejects(() => handle.registered.get('obsidian_search').execute({ mode: 'regex', regex: '(' }, {}), /invalid regex/i)

    const tag = await callAndRenderOn(handle, 'obsidian_search', { mode: 'tag', tag: 'project/alpha' })
    assert.deepEqual(tag.value.results.map((result) => result.rel), [NOTES.alpha])
    const tagParent = await callAndRenderOn(handle, 'obsidian_search', { mode: 'tag', tag: 'project' })
    assert.ok(tagParent.value.results.some((result) => result.rel === NOTES.beta))

    const property = await callAndRenderOn(handle, 'obsidian_search', { mode: 'property', propertyKey: 'status', propertyValue: 'active' })
    assert.ok(property.value.results.some((result) => result.rel === NOTES.alpha))

    const link = await callAndRenderOn(handle, 'obsidian_search', { mode: 'link', note: 'projects/alpha' })
    assert.ok(link.value.results.some((result) => result.rel === NOTES.welcome), 'Welcome links to alpha')

    const files = await callAndRenderOn(handle, 'obsidian_search', { mode: 'files', query: 'daily' })
    assert.equal(files.value.total, 2)

    const headings = await callAndRenderOn(handle, 'obsidian_search', { mode: 'headings', query: 'Deep Dive Details' })
    assert.ok(headings.value.results.some((result) => result.rel === NOTES.deepDive))
    assert.ok(headings.value.results.some((result) => result.heading === 'Deep Dive Details' && result.level === 2))

    const tasks = await callAndRenderOn(handle, 'obsidian_search', { mode: 'tasks', query: 'open' })
    assert.ok(tasks.value.results.length > 0)
    assert.ok(tasks.value.results.every((result) => result.checked === false))

    const recent = await callAndRenderOn(handle, 'obsidian_search', { mode: 'recent', limit: 5 })
    assert.equal(recent.value.results.length, 5)
    assert.equal(recent.value.truncated, true)

    const stats = await callAndRenderOn(handle, 'obsidian_search', { mode: 'stats' })
    assert.equal(stats.value.stats.ready, true)
    assert.ok(stats.value.stats.notes >= 25)
    assert.ok(stats.value.stats.tags > 0)
    assert.ok(stats.value.stats.links > 0)

    const none = await callAndRenderOn(handle, 'obsidian_search', { mode: 'text', query: 'no-such-token-xyzzy' })
    assert.equal(none.value.total, 0)
    assert.match(none.text, /no matches/i)
  })
})

test('full: obsidian_search filters, paging and render cap on real data', { skip: SKIP }, async () => {
  await withTools(async (handle) => {
    const globbed = await callAndRenderOn(handle, 'obsidian_search', { mode: 'files', glob: 'daily/*.md' })
    assert.equal(globbed.value.total, 2)
    const pathFiltered = await callAndRenderOn(handle, 'obsidian_search', { mode: 'files', path: 'projects' })
    assert.equal(pathFiltered.value.total, 3)

    const page1 = await callAndRenderOn(handle, 'obsidian_search', { mode: 'files', limit: 5, offset: 0 })
    const page2 = await callAndRenderOn(handle, 'obsidian_search', { mode: 'files', limit: 5, offset: 5 })
    assert.equal(page1.value.truncated, true)
    const overlap = page1.value.results.filter((a) => page2.value.results.some((b) => b.rel === a.rel))
    assert.deepEqual(overlap, [], 'pages must not overlap')

    const big = await callAndRenderOn(handle, 'obsidian_search', { mode: 'text', query: 'lorem', limit: 200 })
    assert.ok(big.value.results.some((result) => result.rel === NOTES.big))
    assert.ok(big.text.length <= 8_500, `search render must stay near 8000 chars, got ${big.text.length}`)
  })
})

// ---------------------------------------------------------------- status / live / faults

test('full: obsidian_status reports the real fixture vault and forces reindex', { skip: SKIP }, async () => {
  await withTools(async (handle) => {
    const info = await callAndRenderOn(handle, 'obsidian_status', { action: 'info' })
    assert.equal(info.value.ok, true)
    assert.match(info.value.summary, /Obsidian Hub — connected/)
    assert.ok(info.value.summary.includes(fixture.root))
    assert.match(info.value.summary, /REST API: not configured/)
    assert.ok(info.value.status.index.notes >= 25)
    assert.equal(info.value.status.rest.configured, false)

    const vaults = await callAndRenderOn(handle, 'obsidian_status', { action: 'vaults' })
    assert.equal(vaults.value.found, true)
    assert.equal(vaults.value.vaults[0].path, fixture.root)

    const reindex = await callAndRenderOn(handle, 'obsidian_status', { action: 'reindex' })
    assert.ok(reindex.value.stats.notes >= 25)
    assert.equal(typeof reindex.value.stats.tookMs, 'number')
  })
})

test('full: obsidian_live without restApiKey fails fast and never launches the URI handler for missing notes', { skip: SKIP }, async () => {
  await withTools(async (handle) => {
    for (const action of ['ping', 'commands', 'active', 'command']) {
      const started = performance.now()
      await assert.rejects(
        () => handle.registered.get('obsidian_live').execute({ action, command: 'app:toggle-left-sidebar' }, {}),
        /Local REST API is not configured/,
      )
      assert.ok(performance.now() - started < 3_000)
    }
    const started = performance.now()
    await assert.rejects(
      () => handle.registered.get('obsidian_live').execute({ action: 'open-app', note: 'definitely-missing-note-xyz' }, {}),
      /not found/i,
    )
    assert.ok(performance.now() - started < 3_000, 'open-app on a missing note must fail fast before the URI handler')
  })
})

test('full: missing vault path produces actionable errors from every tool (no hang, no crash)', { skip: SKIP }, async () => {
  const bogus = path.join(paths.base, 'definitely-missing-vault')
  await withTools(
    async (handle) => {
      assert.equal(handle.registered.size, 8, 'apply() must still register all tools when the vault is missing')
      const read = await handle.registered.get('obsidian_read').execute({ path: NOTES.english }, {}).then(
        () => ({ ok: true }),
        (error) => ({ ok: false, message: error.message }),
      )
      assert.equal(read.ok, false)
      assert.match(read.message, /does not exist|not a directory/i)
      assert.ok(read.message.includes(bogus), 'error must name the configured vault path')

      const { value } = await callAndRenderOn(handle, 'obsidian_status', { action: 'info' })
      assert.equal(value.ok, false)
      assert.match(value.summary, /not connected/)
      assert.match(value.summary, /vault error/i)

      const started = performance.now()
      const search = await handle.registered.get('obsidian_search').execute({ mode: 'text', query: 'x' }, {}).then(
        () => ({ ok: true }),
        (error) => ({ ok: false, message: error.message }),
      )
      assert.equal(search.ok, false)
      assert.match(search.message, /does not exist|not a directory/i)
      assert.ok(performance.now() - started < 5_000, 'missing vault must fail fast')
    },
    { vaultPath: bogus, overrides: { autoDetect: false } },
  )
})

test('full: vaultPath="" with autoDetect and a missing registry gives setup guidance', { skip: SKIP }, async () => {
  await withTools(
    async (handle) => {
      const missingRegistry = path.join(paths.base, 'no-registry', 'obsidian.json')
      const started = performance.now()
      const result = await handle.registered.get('obsidian_read').execute({ path: NOTES.english }, {}).then(
        () => ({ ok: true }),
        (error) => ({ ok: false, message: error.message }),
      )
      assert.equal(result.ok, false)
      assert.match(result.message, /No Obsidian vault found|vaultPath/i)
      assert.ok(performance.now() - started < 5_000, 'auto-detect failure must be fast')

      const status = await callAndRenderOn(handle, 'obsidian_status', { action: 'info' })
      assert.equal(status.value.ok, false)
      assert.ok(Array.isArray(status.value.status.warnings) && status.value.status.warnings.length > 0, 'status.warnings must explain the auto-detect failure')
    },
    { vaultPath: '', overrides: { autoDetect: true, obsidianConfigPath: path.join(paths.base, 'no-registry', 'obsidian.json') } },
  )
})

// ---------------------------------------------------------------- performance

test('perf: index build + search latency on the fixture vault', { skip: SKIP }, async () => {
  await withTools(async (handle) => {
    const started = performance.now()
    const reindex = await handle.registered.get('obsidian_status').execute({ action: 'reindex' }, {})
    const wallMs = performance.now() - started
    console.log(`[perf] fixture index build: wall=${wallMs.toFixed(1)}ms reported=${reindex.stats.tookMs}ms notes=${reindex.stats.notes}`)
    assert.ok(wallMs < 15_000, `fixture index build took ${wallMs.toFixed(0)}ms`)

    const searchStart = performance.now()
    const result = await handle.registered.get('obsidian_search').execute({ mode: 'text', query: 'zebraquartz' }, {})
    const searchWall = performance.now() - searchStart
    console.log(`[perf] fixture text search: wall=${searchWall.toFixed(2)}ms reported=${result.tookMs}ms results=${result.total}`)
    assert.ok(searchWall < 5_000)
  })
})

test('perf: 400-note vault builds an index and searches with bounded latency', { skip: SKIP }, async () => {
  const perf = createPerfVault({ count: 400 })
  try {
    await withTools(
      async (handle) => {
        const buildStart = performance.now()
        const reindex = await handle.registered.get('obsidian_status').execute({ action: 'reindex' }, {})
        const buildWall = performance.now() - buildStart
        console.log(
          `[perf] 400-note index build: wall=${buildWall.toFixed(1)}ms reported=${reindex.stats.tookMs}ms notes=${reindex.stats.notes} bytes=${reindex.stats.bytes} truncated=${reindex.stats.truncated}`,
        )
        assert.equal(reindex.stats.notes, 400)
        assert.equal(reindex.stats.truncated, false)
        assert.ok(buildWall < 60_000, `400-note index build took ${buildWall.toFixed(0)}ms`)

        const searchStart = performance.now()
        const text = await handle.registered.get('obsidian_search').execute({ mode: 'text', query: 'needleword', limit: 200 }, {})
        const searchWall = performance.now() - searchStart
        console.log(`[perf] 400-note text search: wall=${searchWall.toFixed(2)}ms reported=${text.tookMs}ms results=${text.total}`)
        assert.equal(text.total, 40, 'every 10th note contains needleword')
        assert.ok(searchWall < 5_000, `400-note search took ${searchWall.toFixed(0)}ms`)

        const warmStart = performance.now()
        const warm = await handle.registered.get('obsidian_search').execute({ mode: 'tag', tag: 'group/03' }, {})
        const warmWall = performance.now() - warmStart
        console.log(`[perf] 400-note warm tag search: wall=${warmWall.toFixed(2)}ms reported=${warm.tookMs}ms results=${warm.total}`)
        assert.ok(warmWall < 5_000)
        assert.ok(warm.total > 0)
      },
      { vaultPath: perf.root, overrides: { indexTtlMs: 60_000 } },
    )
  } finally {
    perf.cleanup()
  }
})

test('perf: indexMaxFiles limit truncates instead of exploding', { skip: SKIP }, async () => {
  const perf = createPerfVault({ count: 30 })
  try {
    await withTools(
      async (handle) => {
        const stats = await callAndRenderOn(handle, 'obsidian_search', { mode: 'stats' })
        assert.equal(stats.value.stats.notes, 5, 'indexMaxFiles: 5 must cap the index')
        assert.equal(stats.value.stats.truncated, true, 'truncation must be reported')
        assert.match(stats.text, /truncated/i)
      },
      { vaultPath: perf.root, overrides: { indexMaxFiles: 5, indexTtlMs: 60_000 } },
    )
  } finally {
    perf.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Phase 2b — LIVE-host regression classes (found by real Host tool invocation)
// ---------------------------------------------------------------------------

/** Plausible fake REST client so obsidian_live produces a successful value. */
function makeFakeRest() {
  return {
    async ping() {
      return {
        reachable: true,
        tookMs: 1,
        authenticated: true,
        service: 'obsidian-local-rest-api',
        versions: { manifest: 2, api: '1.0.0' },
      }
    },
    async commands() {
      return [{ id: 'app:toggle-left-sidebar', name: 'Toggle left sidebar' }]
    },
    async activeFile() {
      return '# Active note\n'
    },
  }
}

test('DEFECT-LIVE-1 regression: every tool value satisfies the Host strict lossless-JSON rule (incl. frontmatter variants)', { skip: SKIP }, async () => {
  const values = {}
  await withTools(async (handle) => {
    // Empty frontmatter block (has:true, data:{}) is the historical crash shape:
    // parsed objects can carry hidden (non-enumerable) metadata that is not
    // lossless JSON. It must arrive as a plain {} after the tool-schema wrapper.
    const emptyFmRel = scratch('empty-frontmatter.md')
    fs.mkdirSync(path.join(fixture.root, 'verify-scratch'), { recursive: true })
    fs.writeFileSync(path.join(fixture.root, emptyFmRel), '---\n---\n# Empty Frontmatter\n\nbody\n', 'utf8')

    const withFm = await callAndRenderOn(handle, 'obsidian_read', {
      path: NOTES.english,
      include: ['frontmatter', 'links', 'backlinks', 'tags', 'headings', 'tasks'],
    })
    values.obsidian_read = withFm.value
    assert.equal(withFm.value.frontmatter.status, 'active', 'note WITH frontmatter must survive normalization')
    assertLosslessJson(withFm.value, 'obsidian_read (note with frontmatter)')

    const emptyFm = await callAndRenderOn(handle, 'obsidian_read', { path: emptyFmRel, include: ['frontmatter', 'tags'] })
    values['obsidian_read (empty frontmatter)'] = emptyFm.value
    assert.deepEqual(emptyFm.value.frontmatter, {}, 'empty frontmatter block must normalize to a plain {}')
    assertLosslessJson(emptyFm.value, 'obsidian_read (empty frontmatter)')

    values.obsidian_write = (
      await callAndRenderOn(handle, 'obsidian_write', {
        path: scratch('lossless.md'),
        content: '---\ntags: [x]\nstatus: draft\n---\n# Lossless\n',
      })
    ).value

    values.obsidian_batch_read = (
      await callAndRenderOn(handle, 'obsidian_batch_read', { paths: [NOTES.english, emptyFmRel] })
    ).value

    values.obsidian_batch_write = (
      await callAndRenderOn(handle, 'obsidian_batch_write', {
        operations: [{ type: 'write', path: scratch('lossless-b.md'), content: 'batch\n' }],
      })
    ).value

    values.obsidian_fs = (await callAndRenderOn(handle, 'obsidian_fs', { action: 'list', path: '' })).value
    values.obsidian_search = (
      await callAndRenderOn(handle, 'obsidian_search', { mode: 'text', query: 'zebraquartz' })
    ).value
    values.obsidian_status = (await callAndRenderOn(handle, 'obsidian_status', { action: 'info' })).value
  })

  // obsidian_live needs a REST client to reach a success path; use the isolated
  // registration with a fake client (no network, no URI handler).
  const liveHandle = bootLiveOnly({ rest: makeFakeRest() })
  assert.equal(liveHandle.error, null, `live boot failed: ${liveHandle.error && liveHandle.error.message}`)
  try {
    values.obsidian_live = (await callAndRenderOn(liveHandle, 'obsidian_live', { action: 'ping' })).value
    assertLosslessJson(values.obsidian_live, 'obsidian_live')
  } finally {
    liveHandle.disposeAll()
  }

  const covered = Object.keys(values).filter((name) => name.startsWith('obsidian_'))
  const coveredTools = new Set(covered.map((name) => name.split(' ')[0]))
  assert.deepEqual(
    [...coveredTools].sort(),
    [...EXPECTED_TOOLS].sort(),
    `strict lossless rule must be exercised for all 8 tools; got ${[...coveredTools].sort().join(',')}`,
  )
  for (const [label, value] of Object.entries(values)) assertLosslessJson(value, label)
})

test('DEFECT-LIVE-1 guard: the strict validator itself rejects every historical bad shape (so the regression above is meaningful)', { skip: SKIP }, () => {
  assert.throws(() => assertLosslessJson({ a: undefined }), /not a JSON value/, 'undefined own value')
  assert.throws(() => assertLosslessJson({ nan: Number.NaN }), /finite/, 'NaN')
  assert.throws(() => assertLosslessJson({ z: -0 }), /-0/, '-0')
  const hidden = {}
  Object.defineProperty(hidden, 'meta', { value: 1, enumerable: false })
  assert.throws(() => assertLosslessJson(hidden), /not enumerable/, 'non-enumerable own property')
  const extraArray = [1, 2]
  extraArray.extra = 'x'
  assert.throws(() => assertLosslessJson(extraArray), /extra own properties/, 'array with extra own prop')
  assert.throws(() => assertLosslessJson(new Date(0)), /prototype must be/, 'Date')
  assert.throws(() => assertLosslessJson(new Map([['k', 'v']])), /prototype must be/, 'Map')

  // The parser attaches hidden metadata (a symbol key / non-enumerable prop) to
  // parsed frontmatter: that is exactly the historical obsidian_read value the
  // live Host rejected.
  if (frontmatterModule) {
    const parsed = frontmatterModule.parseFrontmatter('---\nstatus: active\n---\nbody\n')
    const hasHidden = Object.getOwnPropertySymbols(parsed.data).length > 0 ||
      Reflect.ownKeys(parsed.data).some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(parsed.data, key)
        return descriptor && descriptor.enumerable === false
      })
    if (hasHidden) {
      assert.throws(() => assertLosslessJson(parsed.data), /not enumerable|symbol own keys/, 'raw parsed frontmatter carries hidden metadata')
    }
    // ...and after the JSON normalization the wrapper applies, it is accepted.
    assertLosslessJson(JSON.parse(JSON.stringify(parsed.data)), 'normalized frontmatter')
  }
})

test('DEFECT-LIVE-2 regression: a write invalidates the TTL index for the next search; a read does not force a rescan', { skip: SKIP }, async () => {
  await withTools(
    async (handle) => {
      // Fresh runtime: first stats call builds the index and clears the dirty flag.
      const stats1 = (await callAndRenderOn(handle, 'obsidian_search', { mode: 'stats' })).value.stats
      assert.equal(stats1.ready, true)
      const readsBefore = stats1.reads

      // Non-mutating read must NOT make the index dirty (TTL index stays warm).
      await callAndRenderOn(handle, 'obsidian_read', { path: NOTES.welcome })
      const stats2 = (await callAndRenderOn(handle, 'obsidian_search', { mode: 'stats' })).value.stats
      assert.equal(stats2.reads, readsBefore, 'a read must not force an index rescan')

      // Write a note with a token that exists nowhere else, then search for it
      // IMMEDIATELY in the same runtime. With a 60s TTL, pre-fix behavior would
      // miss it entirely.
      const rel = scratch('fresh-index.md')
      await callAndRenderOn(handle, 'obsidian_write', {
        path: rel,
        content: '---\ntags: [fresh]\n---\n# Fresh\n\nfreshindexmarkerunique appears only in this note.\n',
      })
      const found = await callAndRenderOn(handle, 'obsidian_search', { mode: 'text', query: 'freshindexmarkerunique' })
      assert.equal(found.value.total, 1, 'the just-written note must be searchable immediately')
      assert.equal(found.value.results[0].rel, rel)

      const stats3 = (await callAndRenderOn(handle, 'obsidian_search', { mode: 'stats' })).value.stats
      assert.ok(stats3.notes > stats2.notes, 'the index must include the new note without waiting for the TTL')
      assert.ok(stats3.reads > stats2.reads, 'a dirty index must re-stat/re-read changed files')
    },
    { overrides: { indexTtlMs: 60_000 } },
  )
})

// ---------------------------------------------------------------------------
// Phase 2d — Local REST API credential auto-discovery (vault plugin data.json)
// ---------------------------------------------------------------------------

let runtimeModule
try {
  runtimeModule = await import('../lib/runtime.js')
} catch {
  runtimeModule = undefined
}
let statusRouteModule
try {
  statusRouteModule = await import('../lib/status-route.js')
} catch {
  statusRouteModule = undefined
}
const SKIP_DISCOVER = discoverModule ? false : 'lib/discover.js not importable'
const SKIP_RUNTIME = runtimeModule && discoverModule && configModule ? false : 'runtime/discover/config not importable'
const REST_PLUGIN_ID = 'obsidian-local-rest-api'

/** Write a vault's Local REST API plugin data.json (and mark it enabled). */
function writeRestPluginData(root, data, { enabled = true } = {}) {
  const dir = path.join(root, '.obsidian', 'plugins', REST_PLUGIN_ID)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'data.json'), typeof data === 'string' ? data : JSON.stringify(data), 'utf8')
  if (enabled) {
    fs.writeFileSync(path.join(root, '.obsidian', 'community-plugins.json'), JSON.stringify([REST_PLUGIN_ID]))
  }
}

function unitVault(name) {
  const root = path.join(paths.base, 'rest-unit', name)
  fs.mkdirSync(root, { recursive: true })
  return root
}

/** A loopback HTTP stub that speaks the two REST responses this plugin uses. */
function startStubRest() {
  const calls = []
  const server = http.createServer((request, response) => {
    calls.push({ method: request.method, url: request.url, authorization: request.headers.authorization })
    response.statusCode = 200
    response.setHeader('content-type', 'application/json')
    if (request.url === '/') {
      response.end(
        JSON.stringify({
          authenticated: true,
          service: 'obsidian-local-rest-api',
          versions: { manifest: 5, api: '1.0.0' },
        }),
      )
      return
    }
    if (request.url.startsWith('/commands/')) {
      response.end(JSON.stringify({ commands: [{ id: 'editor:save-file', name: 'Save current file' }] }))
      return
    }
    response.end('{}')
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        calls,
        port: server.address().port,
        close: () =>
          new Promise((done) => {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
            server.close(() => done())
          }),
      })
    })
  })
}

test('discover: readRestApiCredentials handles secure/insecure/weird/missing data', { skip: SKIP_DISCOVER }, async () => {
  const read = discoverModule.readRestApiCredentials

  assert.equal(await read(path.join(paths.base, 'rest-unit', 'no-vault-at-all')), null, 'missing vault/data must be null')

  const noFile = unitVault('no-file')
  assert.equal(await read(noFile), null, 'vault without plugin data.json must be null')

  const invalid = unitVault('invalid-json')
  writeRestPluginData(invalid, '{not json', { enabled: false })
  assert.equal(await read(invalid), null, 'invalid JSON must degrade to null')

  for (const [name, data] of [
    ['empty-object', {}],
    ['empty-key', { apiKey: '' }],
    ['blank-key', { apiKey: '   ' }],
    ['numeric-key', { apiKey: 123 }],
  ]) {
    const root = unitVault(name)
    writeRestPluginData(root, data)
    assert.equal(await read(root), null, `apiKey case ${name} must be null`)
  }

  const secureDefault = unitVault('secure-default')
  writeRestPluginData(secureDefault, { apiKey: '  vault-key  ' })
  assert.deepEqual(await read(secureDefault), {
    apiKey: 'vault-key',
    port: 27_124,
    insecurePort: 27_123,
    enableSecureServer: true,
    enableInsecureServer: false,
    baseUrl: 'https://127.0.0.1:27124',
  })

  const secureCustom = unitVault('secure-custom')
  writeRestPluginData(secureCustom, { apiKey: 'k', port: 27_125, enableSecureServer: true })
  const secure = await read(secureCustom)
  assert.equal(secure.baseUrl, 'https://127.0.0.1:27125', 'secure server uses `port`')

  const insecure = unitVault('insecure')
  writeRestPluginData(insecure, {
    apiKey: 'k',
    port: 27_124,
    insecurePort: 28_080,
    enableSecureServer: false,
    enableInsecureServer: true,
  })
  const insecureCreds = await read(insecure)
  assert.equal(insecureCreds.baseUrl, 'http://127.0.0.1:28080', 'insecure server uses `insecurePort` over plain http')

  const weirdPorts = unitVault('weird-ports')
  writeRestPluginData(weirdPorts, { apiKey: 'k', port: '27124' })
  const weirdSecure = await read(weirdPorts)
  assert.equal(weirdSecure.port, 27_124, 'non-numeric port falls back to 27124')
  assert.equal(weirdSecure.baseUrl, 'https://127.0.0.1:27124')

  const weirdInsecure = unitVault('weird-insecure-port')
  writeRestPluginData(weirdInsecure, { apiKey: 'k', enableSecureServer: false, insecurePort: 'x' })
  const weirdPlain = await read(weirdInsecure)
  assert.equal(weirdPlain.insecurePort, 27_123, 'non-numeric insecurePort falls back to 27123')
  assert.equal(weirdPlain.baseUrl, 'http://127.0.0.1:27123')

  const both = unitVault('both-servers')
  writeRestPluginData(both, { apiKey: 'k', port: 27_124, insecurePort: 27_123, enableSecureServer: true, enableInsecureServer: true })
  assert.equal((await read(both)).baseUrl, 'https://127.0.0.1:27124', 'secure server wins when both are enabled')
})

test('REST auto-discovery: vault plugin data yields a live client; ping/status work against a loopback stub', { skip: SKIP_RUNTIME }, async () => {
  const restVault = createFixtureVault({
    root: path.join(paths.base, 'vault-rest'),
    registryPath: path.join(paths.base, 'registry-rest', 'obsidian.json'),
  })
  const stub = await startStubRest()
  try {
    writeRestPluginData(restVault.root, {
      apiKey: 'vault-key-auto',
      port: 27_124,
      insecurePort: stub.port,
      enableSecureServer: false,
      enableInsecureServer: true,
    })

    // 1) Runtime level: auto-discovery from the vault's own plugin settings.
    const config = configModule.resolveConfig({
      vaultPath: restVault.root,
      autoDetect: false,
      restApiKey: '',
      obsidianConfigPath: restVault.registryPath,
    })
    const rt = runtimeModule.createRuntime(config)
    assert.equal(rt.restSource(), null, 'restSource is null before the client is resolved')
    const client = await rt.rest()
    assert.ok(client, 'vault plugin data must produce a REST client')
    assert.equal(rt.restSource(), 'vault-plugin')
    assert.equal(client.baseUrl, `http://127.0.0.1:${stub.port}`)
    assert.equal(client.apiKey, 'vault-key-auto')
    assert.equal(client.configured, true)
    const ping = await client.ping()
    assert.equal(ping.reachable, true)
    assert.equal(ping.authenticated, true)
    assert.equal(ping.service, 'obsidian-local-rest-api')
    assert.ok(stub.calls.some((call) => call.url === '/'), 'stub must receive GET /')
    assert.equal(stub.calls[0].authorization, 'Bearer vault-key-auto', 'the discovered key must be sent')

    // 2) Tool level: obsidian_live ping and obsidian_status use the discovered client.
    const handle = boot({
      vaultPath: restVault.root,
      overrides: { restApiKey: '', obsidianConfigPath: restVault.registryPath },
    })
    assert.equal(handle.error, null, `apply() failed: ${handle.error && handle.error.message}`)
    try {
      const live = await callAndRenderOn(handle, 'obsidian_live', { action: 'ping' })
      assert.equal(live.value.ok, true)
      assert.equal(live.value.ping.authenticated, true)

      const info = await callAndRenderOn(handle, 'obsidian_status', { action: 'info' })
      assert.match(info.value.summary, /REST API: reachable/)
      assert.match(info.value.summary, /Local REST API plugin: enabled/)
      assert.equal(info.value.status.rest.source, 'vault-plugin')
      assert.equal(info.value.status.rest.reachable, true)
      assert.equal(info.value.status.rest.url, `http://127.0.0.1:${stub.port}`)
      assert.equal(info.value.status.rest.authenticated, true)
    } finally {
      handle.disposeAll()
    }
  } finally {
    await stub.close()
    restVault.cleanup()
  }
})

test('REST auto-discovery: a vault WITHOUT the plugin data keeps the no-REST path (null + actionable error)', { skip: SKIP_RUNTIME }, async () => {
  // The main fixture deliberately has no REST plugin data.json. Auto-discovery
  // must not silently fabricate a client for it.
  const config = configModule.resolveConfig({
    vaultPath: fixture.root,
    autoDetect: false,
    restApiKey: '',
    obsidianConfigPath: fixture.registryPath,
  })
  const rt = runtimeModule.createRuntime(config)
  assert.equal(await rt.rest(), null, 'no plugin data and no config key must resolve to null')
  assert.equal(rt.restSource(), null)

  await withTools(async (handle) => {
    const outcome = await handle.registered
      .get('obsidian_live')
      .execute({ action: 'ping' }, {})
      .then(() => ({ ok: true }), (error) => ({ ok: false, message: error.message }))
    assert.equal(outcome.ok, false, 'ping must fail when no REST credentials exist')
    assert.match(outcome.message, /Local REST API is not configured or not reachable/)
    assert.match(outcome.message, /restApiKey/, 'the error must still tell the user the explicit override')
  })
})

test('REST auto-discovery: explicit restApiKey wins over vault plugin data', { skip: SKIP_RUNTIME }, async () => {
  const vault = createFixtureVault({
    root: path.join(paths.base, 'vault-rest-config-wins'),
    registryPath: path.join(paths.base, 'registry-rest-config-wins', 'obsidian.json'),
  })
  try {
    writeRestPluginData(vault.root, { apiKey: 'vault-key-should-lose', port: 27_124, enableSecureServer: true })
    const config = configModule.resolveConfig({
      vaultPath: vault.root,
      autoDetect: false,
      restApiKey: 'explicit-key',
      restBaseUrl: 'https://127.0.0.1:29999',
      obsidianConfigPath: vault.registryPath,
    })
    const rt = runtimeModule.createRuntime(config)
    const client = await rt.rest()
    assert.ok(client)
    assert.equal(rt.restSource(), 'config', 'explicit restApiKey must win')
    assert.equal(client.baseUrl, 'https://127.0.0.1:29999', 'config.restBaseUrl must be used, not the plugin port')
    assert.equal(client.apiKey, 'explicit-key')
  } finally {
    vault.cleanup()
  }
})

test('DEFECT-CHECK: auto-discovered REST credentials must propagate to user-facing URLs', { skip: SKIP_RUNTIME || (statusRouteModule ? false : 'status-route not importable') }, async () => {
  // Auto-discovery can pick a NON-DEFAULT port/URL from the vault plugin data.
  // Any user-facing URL must be the client's real baseUrl, not the config default,
  // or the panel/model is told to reach a different endpoint than the one used.
  const restVault = createFixtureVault({
    root: path.join(paths.base, 'vault-rest-url'),
    registryPath: path.join(paths.base, 'registry-rest-url', 'obsidian.json'),
  })
  const stub = await startStubRest()
  try {
    writeRestPluginData(restVault.root, {
      apiKey: 'vault-key-url',
      port: 27_124,
      insecurePort: stub.port,
      enableSecureServer: false,
      enableInsecureServer: true,
    })
    const expectedUrl = `http://127.0.0.1:${stub.port}`
    const config = configModule.resolveConfig({
      vaultPath: restVault.root,
      autoDetect: false,
      restApiKey: '',
      obsidianConfigPath: restVault.registryPath,
    })
    const rt = runtimeModule.createRuntime(config)

    // (a) status route payload
    let handler
    const routeCtx = {
      inject(deps, callback) {
        if (!deps.includes('webServer')) return
        callback({
          webServer: {
            register(spec) {
              handler = spec.handler
              return () => {}
            },
          },
          effect(fn) {
            fn()
            return () => {}
          },
        })
      },
    }
    statusRouteModule.registerStatusRoute(routeCtx, rt)
    assert.equal(typeof handler, 'function', 'status route handler must register')
    const chunks = []
    const response = {
      statusCode: 0,
      headers: {},
      setHeader(key, value) {
        this.headers[key] = value
      },
      end(body) {
        chunks.push(body)
      },
    }
    await handler({}, response)
    const payload = JSON.parse(chunks.join(''))
    assert.equal(payload.rest.configured, true)
    assert.equal(payload.rest.reachable, true)
    assert.equal(payload.rest.url, expectedUrl, `status route reported ${JSON.stringify(payload.rest.url)} instead of the discovered ${expectedUrl}`)

    // (b) obsidian_live ping summary
    const handle = boot({
      vaultPath: restVault.root,
      overrides: { restApiKey: '', obsidianConfigPath: restVault.registryPath },
    })
    try {
      const live = await callAndRenderOn(handle, 'obsidian_live', { action: 'ping' })
      assert.ok(
        live.value.summary.includes(expectedUrl),
        `ping summary must name the endpoint actually used (${expectedUrl}); got: ${live.value.summary}`,
      )
    } finally {
      handle.disposeAll()
    }
  } finally {
    await stub.close()
    restVault.cleanup()
  }
})
