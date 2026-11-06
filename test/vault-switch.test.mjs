/**
 * v1.1 verification: runtime vault switching + sidebar panel registration.
 *
 * Contract: ARCHITECTURE.md section「多仓库切换（v1.1，2026-11-06，FROZEN）」.
 *
 * Hermeticity: `lib/state.js` resolves its directory from
 * `DSH_OBSIDIAN_HUB_STATE_DIR` when set, so this file redirects it into the
 * per-process fixture run dir. The user's real
 * `<homedir>/.dsh/obsidian-hub/state.json` is never read or written.
 *
 * Run with:  node --test test/vault-switch.test.mjs
 * Only Node builtins are used (no external dependencies).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createFixtureVault, createPerfVault, fixturePaths, cleanupAll, NOTES } from './fixture.mjs'

const paths = fixturePaths()
const STATE_DIR = path.join(paths.base, 'state')
const ORIGINAL_STATE_DIR = process.env.DSH_OBSIDIAN_HUB_STATE_DIR
process.env.DSH_OBSIDIAN_HUB_STATE_DIR = STATE_DIR

const stateModule = await import('../lib/state.js')
const runtimeModule = await import('../lib/runtime.js')
const configModule = await import('../lib/config.js')
const toolsVaultModule = await import('../lib/tools-vault.js')
const toolsSearchModule = await import('../lib/tools-search.js')
const statusRouteModule = await import('../lib/status-route.js')

const STATE_PATH = () => path.join(STATE_DIR, 'state.json')

for (const kind of ['state', 'runtime', 'config', 'tools-vault', 'tools-search', 'status-route']) {
  test(`module present: ${kind}`, () => {
    const modules = { state: stateModule, runtime: runtimeModule, config: configModule, 'tools-vault': toolsVaultModule, 'tools-search': toolsSearchModule, 'status-route': statusRouteModule }
    assert.ok(modules[kind], `${kind} module must import`)
  })
}

process.on('exit', () => {
  try {
    cleanupAll()
  } catch {
    /* ignore */
  }
  try {
    if (ORIGINAL_STATE_DIR === undefined) delete process.env.DSH_OBSIDIAN_HUB_STATE_DIR
    else process.env.DSH_OBSIDIAN_HUB_STATE_DIR = ORIGINAL_STATE_DIR
  } catch {
    /* ignore */
  }
})

// ---------------------------------------------------------------- fixtures

function makeVault(name) {
  return createFixtureVault({ root: path.join(paths.base, `vault-${name}`), registryPath: path.join(paths.base, `registry-${name}`, 'obsidian.json') })
}

const vaultA = makeVault('a')
const vaultB = makeVault('b')
const vaultC = makeVault('c')

function writeNote(root, rel, content) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')
}

// Distinguishable vaults: A and B get different note counts and unique notes.
writeNote(vaultA.root, 'only-in-a.md', '# Only In A\n\natokenunique lives only in vault A.\n')
writeNote(vaultB.root, 'only-in-b.md', '# Only In B\n\nbtokenunique lives only in vault B.\n')
writeNote(vaultB.root, 'b-extra.md', '# B Extra\n\nbtokenunique also appears here as a second match.\n')

const countNotes = (root) => {
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isDirectory()) return entry.name === '.obsidian' || entry.name === '.trash' ? [] : walk(path.join(dir, entry.name))
      return entry.name.toLowerCase().endsWith('.md') ? [path.join(dir, entry.name)] : []
    })
  return walk(root).length
}
const A_NOTES = countNotes(vaultA.root)
const B_NOTES = countNotes(vaultB.root)
assert.notEqual(A_NOTES, B_NOTES, 'fixture vaults must differ in note count')

async function resetState() {
  fs.rmSync(STATE_DIR, { recursive: true, force: true })
  await stateModule.clearState()
}

function runtimeFor(options = {}) {
  const { vaultPath = '', autoDetect = false, obsidianConfigPath = vaultC.registryPath, ...overrides } = options
  const config = configModule.resolveConfig({
    restApiKey: '',
    vaultPath,
    autoDetect,
    obsidianConfigPath,
    ...overrides,
  })
  return runtimeModule.createRuntime(config)
}

function makeToolHandle(rt) {
  const registered = new Map()
  const disposers = []
  const ctx = {
    tools: {
      register(def) {
        registered.set(def.name, def)
        return () => registered.delete(def.name)
      },
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
  }
  for (const register of [toolsVaultModule.registerVaultTools, toolsSearchModule.registerSearchTools]) {
    disposers.push(register(ctx, rt))
  }
  return {
    registered,
    exec(name, args) {
      const tool = registered.get(name)
      assert.ok(tool, `${name} is not registered`)
      return tool.execute(args || {}, {})
    },
    dispose() {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    },
  }
}

// ---------------------------------------------------------------- A. state file

test('state: missing file reads as null and the path honors DSH_OBSIDIAN_HUB_STATE_DIR', async () => {
  await resetState()
  assert.equal(stateModule.stateDir(), STATE_DIR, 'env override must win')
  assert.equal(stateModule.statePath(), STATE_PATH())
  assert.equal(await stateModule.readState(), null, 'missing state file must be null')

  const saved = process.env.DSH_OBSIDIAN_HUB_STATE_DIR
  delete process.env.DSH_OBSIDIAN_HUB_STATE_DIR
  try {
    const fallback = stateModule.statePath()
    assert.ok(path.isAbsolute(fallback), 'default state path must be absolute')
    assert.match(fallback, /[\\/]\.dsh[\\/]obsidian-hub[\\/]state\.json$/, 'default path must be <homedir>/.dsh/obsidian-hub/state.json')
  } finally {
    process.env.DSH_OBSIDIAN_HUB_STATE_DIR = saved
  }
})

test('state: corrupt JSON / wrong-typed / oversized state → null, never throws', async () => {
  await resetState()
  fs.mkdirSync(STATE_DIR, { recursive: true })

  const cases = [
    ['invalid-json', '{this is not json'],
    ['json-string', '"just-a-string"'],
    ['json-array', '[]'],
    ['json-null', 'null'],
    ['vaultPath-number', JSON.stringify({ version: 1, vaultPath: 42 })],
    ['vaultPath-empty', JSON.stringify({ version: 1, vaultPath: '' })],
    ['vaultPath-blank', JSON.stringify({ version: 1, vaultPath: '   ' })],
    ['vaultPath-object', JSON.stringify({ version: 1, vaultPath: { x: 1 } })],
    ['oversized', JSON.stringify({ version: 1, vaultPath: 'X'.repeat(70 * 1024) })],
  ]
  for (const [name, raw] of cases) {
    fs.writeFileSync(STATE_PATH(), raw, 'utf8')
    const value = await stateModule.readState()
    assert.equal(value, null, `state case ${name} must read as null`)
  }
  fs.rmSync(STATE_PATH(), { force: true })
})

test('state: writeState persists version/vaultPath/updatedAt and leaves no temp file', async () => {
  await resetState()
  const returned = await stateModule.writeState(vaultB.root)
  assert.equal(returned, path.resolve(vaultB.root))

  const raw = fs.readFileSync(STATE_PATH(), 'utf8')
  const parsed = JSON.parse(raw)
  assert.equal(parsed.version, 1)
  assert.equal(parsed.vaultPath, path.resolve(vaultB.root))
  assert.equal(typeof parsed.updatedAt, 'string')
  assert.ok(!Number.isNaN(Date.parse(parsed.updatedAt)), 'updatedAt must be an ISO timestamp')
  assert.equal(fs.existsSync(`${STATE_PATH()}.tmp`), false, 'atomic write must not leave state.json.tmp')

  const read = await stateModule.readState()
  assert.equal(read.vaultPath, path.resolve(vaultB.root))
  assert.equal(read.updatedAt, parsed.updatedAt)

  // Overwriting an existing state file must also work (Windows rename quirk).
  const second = await stateModule.writeState(vaultA.root)
  assert.equal(second, path.resolve(vaultA.root))
  assert.equal((await stateModule.readState()).vaultPath, path.resolve(vaultA.root))
  assert.equal(fs.existsSync(`${STATE_PATH()}.tmp`), false)
})

test('config: allowVaultSwitch defaults to true and parses false/string values', () => {
  assert.equal(configModule.resolveConfig(undefined).allowVaultSwitch, true)
  assert.equal(configModule.resolveConfig({}).allowVaultSwitch, true)
  assert.equal(configModule.resolveConfig({ allowVaultSwitch: false }).allowVaultSwitch, false)
  assert.equal(configModule.resolveConfig({ allowVaultSwitch: 'false' }).allowVaultSwitch, false)
  assert.equal(configModule.resolveConfig({ allowVaultSwitch: 'true' }).allowVaultSwitch, true)
})

test('state: a failed write does not corrupt the existing state (no half file)', async () => {
  await resetState()
  await stateModule.writeState(vaultA.root)
  // Make the temp target a DIRECTORY so fs.writeFile of the temp file fails.
  fs.mkdirSync(`${STATE_PATH()}.tmp`, { recursive: true })
  try {
    await assert.rejects(() => stateModule.writeState(vaultB.root), /EISDIR|EACCES|EPERM|directory/i)
  } finally {
    fs.rmdirSync(`${STATE_PATH()}.tmp`)
  }
  const read = await stateModule.readState()
  assert.ok(read, 'the previous valid state must survive a failed write')
  assert.equal(read.vaultPath, path.resolve(vaultA.root))
  assert.equal(fs.existsSync(`${STATE_PATH()}.tmp`), false)
})

test('state: clearState removes the file and tolerates a missing file', async () => {
  await resetState()
  await stateModule.writeState(vaultA.root)
  assert.ok(fs.existsSync(STATE_PATH()))
  await stateModule.clearState()
  assert.equal(fs.existsSync(STATE_PATH()), false)
  await stateModule.clearState() // must not throw when already gone
  assert.equal(await stateModule.readState(), null)
})

// ---------------------------------------------------------------- B. precedence

test('precedence: state > config.vaultPath > obsidian.json auto-detect', async () => {
  await resetState()

  // 1) persisted state wins over an explicit config vaultPath
  await stateModule.writeState(vaultB.root)
  const byState = runtimeFor({ vaultPath: vaultA.root, obsidianConfigPath: vaultC.registryPath })
  assert.equal((await byState.vault()).root, vaultB.root, 'state must win over config')
  assert.equal(await byState.activeRootSource(), 'state')

  // 2) no state -> config
  await resetState()
  const byConfig = runtimeFor({ vaultPath: vaultA.root, obsidianConfigPath: vaultC.registryPath })
  assert.equal((await byConfig.vault()).root, vaultA.root)
  assert.equal(await byConfig.activeRootSource(), 'config')

  // 3) neither -> obsidian.json auto-detect
  await resetState()
  const byAuto = runtimeFor({ vaultPath: '', autoDetect: true, obsidianConfigPath: vaultC.registryPath })
  assert.equal((await byAuto.vault()).root, vaultC.root)
  assert.equal(await byAuto.activeRootSource(), 'auto')
})

test('precedence: state pointing at a vanished directory falls through instead of trapping the user', async () => {
  await resetState()
  const vanished = path.join(paths.base, 'vanished-vault')
  fs.mkdirSync(vanished, { recursive: true })
  await stateModule.writeState(vanished)
  fs.rmSync(vanished, { recursive: true, force: true })

  const rt = runtimeFor({ vaultPath: vaultA.root })
  assert.equal((await rt.vault()).root, vaultA.root, 'vanished state vault must fall through to config')
  assert.equal(await rt.activeRootSource(), 'config')
})

test('precedence: a new runtime picks up the persisted selection (simulated restart)', async () => {
  await resetState()
  const first = runtimeFor({ vaultPath: vaultA.root })
  await first.setRoot(vaultB.root)
  const second = runtimeFor({ vaultPath: vaultA.root })
  assert.equal((await second.vault()).root, vaultB.root, 'a fresh runtime must read the persisted choice')
  assert.equal(await second.activeRootSource(), 'state')
})

test('activeRootSource: null when no vault can be resolved, and vault() explains why', async () => {
  await resetState()
  const rt = runtimeFor({ vaultPath: '', autoDetect: false, obsidianConfigPath: path.join(paths.base, 'no-registry-at-all', 'obsidian.json') })
  assert.equal(await rt.activeRootSource(), null, 'unresolvable vault must report null, not throw')
  await assert.rejects(() => rt.vault(), /autoDetect is disabled|vaultPath is not configured/i)
})

test('status: vaults[] marks isVault correctly and injects the active vault when it is not registered', async () => {
  await resetState()
  const plainDir = path.join(paths.base, 'plain-folder-not-a-vault')
  fs.mkdirSync(plainDir, { recursive: true })
  const mixedRegistry = path.join(paths.base, 'registry-mixed', 'obsidian.json')
  fs.mkdirSync(path.dirname(mixedRegistry), { recursive: true })
  fs.writeFileSync(
    mixedRegistry,
    JSON.stringify({
      vaults: {
        aaa: { path: vaultA.root, open: true, ts: 1_762_000_000_000 },
        bbb: { path: plainDir, open: false, ts: 1_762_000_000_001 },
      },
    }),
    'utf8',
  )
  const rt = runtimeFor({ vaultPath: vaultC.root, obsidianConfigPath: mixedRegistry })
  const status = await rt.status()
  assert.equal(status.vaultSource, 'config')
  assert.equal(status.allowVaultSwitch, true)
  assert.ok(Array.isArray(status.vaults))
  assert.equal(status.vaults.length, 3, 'registry has 2 entries + the unregistered active vault')
  const entry = (target) => status.vaults.find((item) => path.resolve(item.path).toLowerCase() === path.resolve(target).toLowerCase())
  const current = status.vaults.filter((item) => item.current)
  assert.equal(current.length, 1)
  assert.equal(path.resolve(current[0].path), path.resolve(vaultC.root), 'unregistered active vault must be injected')
  assert.equal(current[0].isVault, true)
  assert.equal(entry(vaultA.root).isVault, true)
  assert.equal(entry(plainDir).isVault, false, 'a folder without .obsidian is not a vault')
  assert.equal(entry(plainDir).exists, true)
  for (const item of status.vaults) {
    for (const key of ['path', 'name', 'open', 'exists', 'isVault', 'current']) assert.ok(key in item, `vaults[] entry must carry ${key}`)
  }
})

// ---------------------------------------------------------------- C. setRoot

test('setRoot: switches to a valid vault, persists it, and clears back to config', async () => {
  await resetState()
  const rt = runtimeFor({ vaultPath: vaultA.root })
  assert.equal((await rt.vault()).root, vaultA.root)

  const switched = await rt.setRoot(vaultB.root)
  assert.deepEqual(switched, { root: vaultB.root, source: 'state' })
  assert.equal((await rt.vault()).root, vaultB.root)
  assert.equal(await rt.activeRootSource(), 'state')
  assert.equal((await stateModule.readState()).vaultPath, path.resolve(vaultB.root))

  await assert.rejects(() => rt.setRoot(path.join(paths.base, 'no-such-vault-xyz')), /does not exist/i)
  assert.equal((await rt.vault()).root, vaultB.root, 'a failed switch must not change the root')
  assert.equal((await stateModule.readState()).vaultPath, path.resolve(vaultB.root), 'a failed switch must not change the state file')

  const filePath = path.join(paths.base, 'not-a-vault.txt')
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, 'file', 'utf8')
  await assert.rejects(() => rt.setRoot(filePath), /not a directory/i)
  assert.equal((await rt.vault()).root, vaultB.root)

  const cleared = await rt.setRoot(null)
  assert.deepEqual(cleared, { root: vaultA.root, source: 'config' })
  assert.equal(await stateModule.readState(), null, 'setRoot(null) must delete the state file')
  assert.equal((await rt.vault()).root, vaultA.root)
  assert.equal(await rt.activeRootSource(), 'config')
})

// ---------------------------------------------------------------- D. the real point

test('switching: after setRoot(B) the TOOLS act on B; switching back to A hides B entirely', async () => {
  await resetState()
  const rt = runtimeFor({ vaultPath: vaultA.root })
  const handle = makeToolHandle(rt)
  try {
    // Baseline in A: write a note through the real tool, find it, count notes.
    const wroteA = await handle.exec('obsidian_write', {
      path: 'switch/a-only.md',
      content: '---\ntags: [switchtest]\n---\n# A Only\n\nawrittentoken lives only in vault A.\n',
    })
    assert.equal(wroteA.action, 'created')
    const searchA = await handle.exec('obsidian_search', { mode: 'text', query: 'awrittentoken' })
    assert.equal(searchA.total, 1)
    assert.equal(searchA.results[0].rel, 'switch/a-only.md')
    const statsA = await handle.exec('obsidian_search', { mode: 'stats' })
    assert.equal(statsA.stats.notes, A_NOTES + 1)
    assert.equal(fs.existsSync(path.join(vaultA.root, 'switch/a-only.md')), true)

    // Switch to B.
    const switched = await rt.setRoot(vaultB.root)
    assert.deepEqual(switched, { root: vaultB.root, source: 'state' })
    assert.equal((await rt.vault()).root, vaultB.root)
    assert.equal(await rt.activeRootSource(), 'state')

    // No leakage: A-only token/content is not visible while B is active.
    const leakedA = await handle.exec('obsidian_search', { mode: 'text', query: 'awrittentoken' })
    assert.equal(leakedA.total, 0, "A's note must not be visible in B")
    assert.equal(fs.existsSync(path.join(vaultB.root, 'switch/a-only.md')), false, "A's note must not exist on B's disk")
    await assert.rejects(() => handle.exec('obsidian_read', { path: 'switch/a-only.md' }), /not found/i)

    // Write through the tool in B; search must find it immediately.
    const wroteB = await handle.exec('obsidian_write', {
      path: 'switch/b-only.md',
      content: '---\ntags: [switchtest]\n---\n# B Only\n\nbwrittentoken lives only in vault B.\n',
    })
    assert.equal(wroteB.action, 'created')
    const searchB = await handle.exec('obsidian_search', { mode: 'text', query: 'bwrittentoken' })
    assert.ok(searchB.total >= 1, 'B note must be searchable right after writing it')
    assert.equal(searchB.results.some((result) => result.rel === 'switch/b-only.md'), true)
    assert.equal(fs.existsSync(path.join(vaultB.root, 'switch/b-only.md')), true)
    assert.equal(fs.existsSync(path.join(vaultA.root, 'switch/b-only.md')), false)

    // The index was rebuilt for B (different note count, B's own base content).
    const statsB = await handle.exec('obsidian_search', { mode: 'stats' })
    assert.equal(statsB.stats.notes, B_NOTES + 1, 'index must be rebuilt for B')
    assert.notEqual(statsB.stats.notes, statsA.stats.notes, 'stale A index must not be reused for B')
    const bOnly = await handle.exec('obsidian_read', { path: 'only-in-b.md' })
    assert.match(bOnly.content, /btokenunique/)

    // Switch back to A: B's note is gone from search and from the active vault.
    const backToA = await rt.setRoot(vaultA.root)
    assert.deepEqual(backToA, { root: vaultA.root, source: 'state' })
    const goneB = await handle.exec('obsidian_search', { mode: 'text', query: 'bwrittentoken' })
    assert.equal(goneB.total, 0, "B's note must be gone after switching back to A")
    const backA = await handle.exec('obsidian_search', { mode: 'text', query: 'atokenunique' })
    assert.equal(backA.total, 1, "A's own note must be visible again")
    assert.equal(backA.results[0].rel, 'only-in-a.md')
    const writtenA = await handle.exec('obsidian_search', { mode: 'text', query: 'awrittentoken' })
    assert.equal(writtenA.total, 1, "A's tool-written note must be visible again")
    assert.equal(writtenA.results[0].rel, 'switch/a-only.md')
    const statsA2 = await handle.exec('obsidian_search', { mode: 'stats' })
    assert.equal(statsA2.stats.notes, A_NOTES + 1)
    await assert.rejects(() => handle.exec('obsidian_read', { path: 'switch/b-only.md' }), /not found/i)

    // The fs tool follows the runtime too.
    const fsList = await handle.exec('obsidian_fs', { action: 'list', path: '' })
    const rels = fsList.entries.map((entry) => entry.rel)
    assert.ok(rels.includes('only-in-a.md'))
    assert.equal(rels.includes('only-in-b.md'), false)
  } finally {
    handle.dispose()
  }
})

test('switching: setRoot(null) makes tools fall back to the config vault', async () => {
  await resetState()
  const rt = runtimeFor({ vaultPath: vaultA.root })
  const handle = makeToolHandle(rt)
  try {
    await rt.setRoot(vaultB.root)
    const inB = await handle.exec('obsidian_fs', { action: 'list', path: '' })
    assert.ok(inB.entries.some((entry) => entry.rel === 'only-in-b.md'))

    const cleared = await rt.setRoot(null)
    assert.equal(cleared.source, 'config')
    const inA = await handle.exec('obsidian_fs', { action: 'list', path: '' })
    assert.ok(inA.entries.some((entry) => entry.rel === 'only-in-a.md'))
    assert.equal(inA.entries.some((entry) => entry.rel === 'only-in-b.md'), false)
  } finally {
    handle.dispose()
  }
})

// ---------------------------------------------------------------- E. HTTP routes

function fakeRequest({ method = 'GET', body } = {}) {
  const listeners = new Map()
  const request = {
    method,
    destroyed: false,
    on(event, handler) {
      const list = listeners.get(event) || []
      list.push(handler)
      listeners.set(event, list)
      return request
    },
    destroy() {
      request.destroyed = true
    },
  }
  queueMicrotask(() => {
    if (body !== undefined) {
      const chunk = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
      for (const handler of listeners.get('data') || []) handler(chunk)
    }
    for (const handler of listeners.get('end') || []) handler()
  })
  return request
}

function fakeResponse() {
  const chunks = []
  return {
    statusCode: 0,
    headers: {},
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value
    },
    end(body) {
      if (body !== undefined) chunks.push(Buffer.isBuffer(body) ? body.toString('utf8') : String(body))
    },
    get body() {
      return chunks.join('')
    },
    json() {
      return JSON.parse(this.body)
    },
  }
}

function captureRoutes(rt) {
  const handlers = new Map()
  const ctx = {
    inject(deps, callback) {
      if (!deps.includes('webServer')) return
      callback({
        webServer: {
          register(spec) {
            handlers.set(spec.path, spec.handler)
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
  statusRouteModule.registerStatusRoute(ctx, rt)
  return handlers
}

async function callRoute(handlers, route, options) {
  const handler = handlers.get(route)
  assert.equal(typeof handler, 'function', `route ${route} must be registered`)
  const response = fakeResponse()
  await handler(fakeRequest(options), response)
  return response
}

test('HTTP GET /obsidian-hub/status exposes vaultSource / allowVaultSwitch / vaults[]', async () => {
  const httpVault = makeVault('http-status')
  await resetState()
  const rt = runtimeFor({ vaultPath: httpVault.root, obsidianConfigPath: httpVault.registryPath })
  const handlers = captureRoutes(rt)
  assert.ok(handlers.has('/obsidian-hub/status'))
  assert.ok(handlers.has('/obsidian-hub/vault'))

  const response = await callRoute(handlers, '/obsidian-hub/status', { method: 'GET' })
  assert.equal(response.statusCode, 200)
  assert.match(String(response.headers['content-type']), /application\/json/)
  const payload = response.json()
  assert.equal(payload.ok, true)
  assert.equal(path.resolve(payload.vaultPath), path.resolve(httpVault.root))
  assert.equal(payload.vaultSource, 'config')
  assert.equal(payload.allowVaultSwitch, true)
  assert.ok(Array.isArray(payload.vaults) && payload.vaults.length >= 1)
  for (const entry of payload.vaults) {
    for (const key of ['path', 'name', 'open', 'exists', 'isVault', 'current']) {
      assert.ok(key in entry, `vaults[] entry must carry ${key}`)
    }
    assert.equal(typeof entry.path, 'string')
    assert.equal(typeof entry.name, 'string')
    assert.equal(typeof entry.open, 'boolean')
    assert.equal(typeof entry.exists, 'boolean')
    assert.equal(typeof entry.isVault, 'boolean')
    assert.equal(typeof entry.current, 'boolean')
  }
  const current = payload.vaults.filter((entry) => entry.current)
  assert.equal(current.length, 1)
  assert.equal(path.resolve(current[0].path), path.resolve(httpVault.root))
  assert.equal(current[0].isVault, true, 'a real Obsidian vault must report isVault:true')
  assert.equal(payload.notes.count, countNotes(httpVault.root))
  assert.equal(payload.index.ready, true)
  assert.equal(payload.rest.configured, false)
})

test('HTTP POST /obsidian-hub/vault switches the active vault and returns the new payload', async () => {
  const httpSource = makeVault('http-source')
  const httpTarget = makeVault('http-target')
  await resetState()
  const rt = runtimeFor({ vaultPath: httpSource.root, obsidianConfigPath: httpSource.registryPath })
  const handlers = captureRoutes(rt)

  const switched = await callRoute(handlers, '/obsidian-hub/vault', { method: 'POST', body: { path: httpTarget.root } })
  assert.equal(switched.statusCode, 200)
  const payload = switched.json()
  assert.equal(payload.ok, true)
  assert.equal(path.resolve(payload.vaultPath), path.resolve(httpTarget.root))
  assert.equal(payload.vaultSource, 'state')
  assert.equal(path.resolve(payload.switchedTo), path.resolve(httpTarget.root))
  assert.equal(payload.notes.count, countNotes(httpTarget.root))
  assert.equal(payload.vaults.some((entry) => entry.current && path.resolve(entry.path) === path.resolve(httpTarget.root)), true)

  // The switch is visible on a following GET (same runtime / panel behaviour).
  const after = (await callRoute(handlers, '/obsidian-hub/status', { method: 'GET' })).json()
  assert.equal(path.resolve(after.vaultPath), path.resolve(httpTarget.root))
  assert.equal(after.vaultSource, 'state')

  // Invalid path -> 400 {ok:false,error}, active vault unchanged.
  const missing = await callRoute(handlers, '/obsidian-hub/vault', { method: 'POST', body: { path: path.join(paths.base, 'no-such-vault-http') } })
  assert.equal(missing.statusCode, 400)
  const missingPayload = missing.json()
  assert.equal(missingPayload.ok, false)
  assert.match(missingPayload.error, /does not exist/i)
  const stillTarget = (await callRoute(handlers, '/obsidian-hub/status', { method: 'GET' })).json()
  assert.equal(path.resolve(stillTarget.vaultPath), path.resolve(httpTarget.root))

  // path:null -> back to config.
  const cleared = await callRoute(handlers, '/obsidian-hub/vault', { method: 'POST', body: { path: null } })
  assert.equal(cleared.statusCode, 200)
  const clearedPayload = cleared.json()
  assert.equal(path.resolve(clearedPayload.vaultPath), path.resolve(httpSource.root))
  assert.equal(clearedPayload.vaultSource, 'config')
})

test('HTTP POST /obsidian-hub/vault: 405 non-POST, 400 malformed JSON, allowVaultSwitch:false', async () => {
  const httpLocked = makeVault('http-locked')
  await resetState()
  const rt = runtimeFor({ vaultPath: httpLocked.root })
  const handlers = captureRoutes(rt)

  for (const method of ['GET', 'PUT', 'DELETE']) {
    const rejected = await callRoute(handlers, '/obsidian-hub/vault', { method })
    assert.equal(rejected.statusCode, 405, `${method} must be 405`)
    assert.equal(rejected.headers.allow, 'POST')
    assert.equal(rejected.json().ok, false)
  }

  const malformed = await callRoute(handlers, '/obsidian-hub/vault', { method: 'POST', body: '{not valid json' })
  assert.equal(malformed.statusCode, 400)
  assert.equal(malformed.json().ok, false)
  assert.match(malformed.json().error, /valid JSON/i)

  const arrayBody = await callRoute(handlers, '/obsidian-hub/vault', { method: 'POST', body: '[]' })
  assert.equal(arrayBody.statusCode, 400)
  assert.equal(arrayBody.json().ok, false)

  const badType = await callRoute(handlers, '/obsidian-hub/vault', { method: 'POST', body: { path: 123 } })
  assert.equal(badType.statusCode, 400)
  assert.match(badType.json().error, /string or null/i)

  // Missing `path` is an explicit 400, not an accidental "clear to config".
  const missingPath = await callRoute(handlers, '/obsidian-hub/vault', { method: 'POST', body: {} })
  assert.equal(missingPath.statusCode, 400)
  assert.equal(missingPath.json().ok, false)
  assert.match(missingPath.json().error, /`path` is required|path.*required/i)

  // After the malformed requests the route still works (no crash / no stuck state).
  const getAgain = await callRoute(handlers, '/obsidian-hub/status', { method: 'GET' })
  assert.equal(getAgain.statusCode, 200)

  // Deployments can disable switching.
  await resetState()
  const lockedRt = runtimeFor({ vaultPath: httpLocked.root, allowVaultSwitch: false })
  const lockedHandlers = captureRoutes(lockedRt)
  const lockedGet = (await callRoute(lockedHandlers, '/obsidian-hub/status', { method: 'GET' })).json()
  assert.equal(lockedGet.allowVaultSwitch, false)
  const lockedPost = await callRoute(lockedHandlers, '/obsidian-hub/vault', { method: 'POST', body: { path: vaultB.root } })
  assert.equal(lockedPost.statusCode, 400)
  assert.equal(lockedPost.json().ok, false)
  assert.match(lockedPost.json().error, /allowVaultSwitch/)
  assert.equal((await lockedRt.vault()).root, httpLocked.root, 'a disabled switch must not change the root')
})

// ---------------------------------------------------------------- F. client (static + executable factory)

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..')

function makeReactStub() {
  const createElement = (type, props, ...children) => ({
    type,
    props: { ...(props || {}), children: children.length <= 1 ? children[0] : children },
  })
  class Component {
    constructor(props) {
      this.props = props || {}
      this.state = {}
    }
    setState(next) {
      this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }
    }
  }
  return {
    createElement,
    Component,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial }),
    Fragment: 'Fragment',
  }
}

/** Compile client.js as a script (no ESM imports) and capture its dynamic module. */
function loadClientModule() {
  const source = fs.readFileSync(path.join(PLUGIN_ROOT, 'client.js'), 'utf8')
  let captured
  const windowStub = {
    __ModuleLoader__: {
      load(definition) {
        captured = definition
      },
    },
  }
  const documentStub = { documentElement: { getAttribute: () => 'en' }, title: 'test' }
  const navigatorStub = { language: 'en', languages: ['en'] }
  const compile = new Function('window', 'document', 'navigator', 'fetch', 'globalThis', source)
  compile(windowStub, documentStub, navigatorStub, async () => {
    throw new Error('static client test must not perform network I/O')
  }, globalThis)
  assert.ok(captured, 'client.js must call window.__ModuleLoader__.load({...})')
  assert.equal(captured.id, 'dsh-obsidian-hub', 'dynamic-module loader id is the bundle id')
  const react = makeReactStub()
  const mod = captured.factory((name) => {
    if (name === 'react') return react
    throw new Error(`client.js must not require anything except react, got: ${name}`)
  })
  return { mod, captured, source }
}

function flattenKeys(value, prefix = '') {
  const keys = []
  for (const [key, child] of Object.entries(value)) {
    const dotted = prefix ? `${prefix}.${key}` : key
    if (child && typeof child === 'object' && !Array.isArray(child)) keys.push(...flattenKeys(child, dotted))
    else keys.push(dotted)
  }
  return keys
}

test('client: registers sidebar.panellist + main with MATCHING id/key and no settings.section', () => {
  const { mod, source } = loadClientModule()

  assert.ok(Array.isArray(mod.inject) && mod.inject.includes('slots'))

  const registrations = []
  const ctx = {
    slots: {
      inject(_slotName, callback) {
        return callback()
      },
      register(spec, component) {
        registrations.push({ spec, component })
        return () => {}
      },
    },
  }
  mod.apply(ctx)
  assert.equal(registrations.length, 2, `expected exactly 2 registrations, got ${registrations.length}`)

  const sidebar = registrations.find((entry) => entry.spec.name === 'sidebar.panellist')
  const main = registrations.find((entry) => entry.spec.name === 'main')
  assert.ok(sidebar, 'sidebar.panellist registration missing')
  assert.ok(main, 'main registration missing')
  assert.equal(sidebar.spec.id, 'obsidian-hub', 'sidebar panel id must be obsidian-hub')
  assert.equal(main.spec.key, 'obsidian-hub', 'main slot key must be obsidian-hub')
  assert.equal(sidebar.spec.id, main.spec.key, 'sidebar id and main key MUST match or the icon opens nothing')
  assert.equal(typeof sidebar.component, 'function', 'sidebar registration needs a component')
  assert.equal(typeof main.component, 'function', 'main registration needs a component')
  assert.equal(typeof sidebar.spec.label, 'function', 'sidebar entry should provide a localized label function')
  assert.equal(typeof sidebar.spec.label(), 'string')

  assert.equal(source.includes('settings.section'), false, 'panel must no longer register into settings.section')
  assert.equal(source.includes('__ModuleLoader__'), true)
  assert.equal(/['"]sidebar\.panellist['"]/.test(source), true)
  assert.equal(/['"]main['"]/.test(source), true)
  assert.equal(source.includes("const PANEL_ID = 'obsidian-hub'"), true, 'PANEL_ID constant must be obsidian-hub')
  assert.equal(/\bid:\s*PANEL_ID/.test(source), true, 'sidebar registration must use PANEL_ID')
  assert.equal(/\bkey:\s*PANEL_ID/.test(source), true, 'main registration must use PANEL_ID')
  assert.match(source, /\/obsidian-hub\/status/, 'client must read the status endpoint')
  assert.match(source, /\/obsidian-hub\/vault/, 'client must post vault switches to the vault endpoint')
  assert.match(source, /method:\s*'POST'/, 'vault switch must be a POST')
})

test('client: locales parse, have meta.title/description + vault-switch strings, and en/zh key parity', () => {
  const en = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'locale', 'en.json'), 'utf8'))
  const zh = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'locale', 'zh.json'), 'utf8'))
  for (const [name, locale] of [['en', en], ['zh', zh]]) {
    assert.equal(typeof locale.meta.title, 'string', `${name} meta.title`)
    assert.ok(locale.meta.title.length > 0)
    assert.equal(typeof locale.meta.description, 'string', `${name} meta.description`)
    assert.ok(locale.meta.description.length > 20)
  }
  assert.equal(en.meta.title, 'Obsidian Hub')
  assert.match(zh.meta.title, /[\u4e00-\u9fff]/)

  const enKeys = flattenKeys(en).sort()
  const zhKeys = flattenKeys(zh).sort()
  assert.deepEqual(enKeys, zhKeys, 'en/zh locale key sets must match')

  for (const key of ['panel.vault.current', 'panel.vault.listTitle', 'panel.vault.switch', 'panel.vault.reset', 'panel.vault.disabledHint', 'panel.vault.switchError']) {
    assert.ok(enKeys.includes(key), `en locale must define ${key} (v1.1 vault switcher)`)
    assert.ok(zhKeys.includes(key), `zh locale must define ${key} (v1.1 vault switcher)`)
  }
  for (const key of ['panel.overview.title', 'panel.overview.dirs', 'panel.overview.recent', 'panel.overview.empty', 'panel.overview.dirNotes']) {
    assert.ok(enKeys.includes(key), `en locale must define ${key} (v1.1.1 overview)`)
    assert.ok(zhKeys.includes(key), `zh locale must define ${key} (v1.1.1 overview)`)
  }
})

test('client: all inline user-visible strings live in the DICT (en/zh parity), no scattered Chinese', () => {
  const { source } = loadClientModule()
  const dictStart = source.indexOf('const DICT')
  const dictEnd = source.indexOf('function detectLang')
  assert.ok(dictStart >= 0 && dictEnd > dictStart, 'inline DICT region must exist')
  const dictRegion = source.slice(dictStart, dictEnd)
  const outside = source.slice(0, dictStart) + source.slice(dictEnd)
  const cjkOutside = outside.match(/[\u4e00-\u9fff]+/g) || []
  assert.deepEqual(cjkOutside, [], 'Chinese user-visible strings must live in the locale DICT, not scattered across JS')

  const counts = new Map()
  for (const match of dictRegion.matchAll(/'([a-z][\w.]*)':/g)) {
    counts.set(match[1], (counts.get(match[1]) || 0) + 1)
  }
  assert.ok(counts.size > 30, `inline DICT should define many strings, got ${counts.size}`)
  for (const [key, count] of counts) {
    assert.equal(count, 2, `inline DICT key ${key} must appear once in en and once in zh`)
  }
})

test('client v1.1.1: overview reads tree/recent from the SAME status payload (no new endpoint) and tolerates missing fields', () => {
  const { source } = loadClientModule()
  const urls = [...new Set([...source.matchAll(/['"](\/obsidian-hub\/[a-z-]+)['"]/g)].map((match) => match[1]))].sort()
  assert.deepEqual(urls, ['/obsidian-hub/status', '/obsidian-hub/vault'], 'the panel must use only the existing two endpoints (no new fetch path)')
  const fetchCalls = source.match(/\bfetch\(/g) || []
  assert.ok(fetchCalls.length <= 1, `overview must reuse the single status fetch helper, found ${fetchCalls.length} fetch( calls`)

  assert.match(source, /Array\.isArray\(payload\.tree\)/, 'tree must be read defensively from the status payload')
  assert.match(source, /Array\.isArray\(payload\.recent\)/, 'recent must be read defensively from the status payload')
  assert.match(source, /const OVERVIEW_TREE_LIMIT = 40/)
  assert.match(source, /const OVERVIEW_RECENT_LIMIT = 8/)
  assert.match(source, /readTree/, 'tree rows must pass through a tolerant reader')
  assert.match(source, /readRecent/, 'recent rows must pass through a tolerant reader')
  assert.match(source, /hasOverview/, 'older Hosts without the fields must be tolerated (card hidden)')

  // All visible overview strings come from the locale DICT keys.
  for (const key of ['overview.title', 'overview.dirs', 'overview.recent', 'overview.empty', 'overview.dirNotes']) {
    assert.ok(source.includes(`'${key}'`), `client inline DICT must define ${key}`)
  }
})

// ---------------------------------------------------------------- v1.1.1 overview payload

function makeBareVault(name, files) {
  const root = path.join(paths.base, `bare-${name}`)
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  for (const [rel, content] of Object.entries(files)) writeNote(root, rel, content)
  return { root }
}

function missingRegistry(name) {
  return path.join(paths.base, `no-registry-${name}`, 'obsidian.json')
}

async function readStatusPayload(rt) {
  const handlers = captureRoutes(rt)
  const response = await callRoute(handlers, '/obsidian-hub/status', { method: 'GET' })
  return { response, payload: response.json() }
}

test('v1.1.1 tree: top-level dirs first (recursive note counts), then top-level files; nested dirs are not rows', async () => {
  await resetState()
  const vault = makeBareVault('overview-tree', {
    'README.md': '# Root\n',
    'fresh.md': '# Fresh\n',
    'notes/a.md': '# A\n',
    'notes/deep/b.md': '# B\n',
    'archive/old.md': '# Old\n',
  })
  const rt = runtimeFor({ vaultPath: vault.root, obsidianConfigPath: missingRegistry('overview-tree') })
  const { response, payload } = await readStatusPayload(rt)
  assert.equal(response.statusCode, 200)
  assert.equal(payload.ok, true)
  assert.ok(Array.isArray(payload.tree), 'tree must be an array')
  assert.deepEqual(
    payload.tree.map((entry) => entry.name),
    ['archive', 'notes', 'fresh.md', 'README.md'],
    'dirs name-sorted first, then top-level files name-sorted',
  )
  const dirs = payload.tree.filter((entry) => entry.type === 'dir')
  const files = payload.tree.filter((entry) => entry.type === 'file')
  assert.deepEqual(dirs.map((entry) => [entry.name, entry.notes]), [
    ['archive', 1],
    ['notes', 2],
  ])
  assert.equal(dirs.some((entry) => entry.name === 'deep'), false, 'nested dirs must not become rows')
  assert.deepEqual(files.map((entry) => entry.name), ['fresh.md', 'README.md'])
  for (const entry of files) {
    assert.equal(typeof entry.rel, 'string')
    assert.equal(entry.rel.includes('\\'), false, 'file rel must use forward slashes')
    assert.equal(entry.rel, entry.name)
    assert.equal(typeof entry.title, 'string')
    assert.ok(entry.title.length > 0)
  }
  assert.equal(files.find((entry) => entry.name === 'fresh.md').title, 'Fresh')
  assert.equal(files.find((entry) => entry.name === 'README.md').title, 'Root')
  assert.ok(payload.tree.length <= 40)
})

test('v1.1.1 tree: total rows capped at 40 (dirs and files share the cap)', async () => {
  await resetState()
  const layout = {}
  for (let i = 0; i < 30; i += 1) layout[`d${String(i).padStart(2, '0')}/note.md`] = `# D${i}\n`
  for (let i = 0; i < 20; i += 1) layout[`f${String(i).padStart(2, '0')}.md`] = `# F${i}\n`
  const vault = makeBareVault('overview-cap', layout)
  const rt = runtimeFor({ vaultPath: vault.root, obsidianConfigPath: missingRegistry('overview-cap') })
  const { payload } = await readStatusPayload(rt)
  assert.equal(payload.tree.length, 40, 'tree must be capped at 40 rows')
  const dirs = payload.tree.filter((entry) => entry.type === 'dir')
  const files = payload.tree.filter((entry) => entry.type === 'file')
  assert.equal(dirs.length, 30)
  assert.equal(files.length, 10, 'files share the remaining cap after dirs')
  assert.deepEqual(dirs.map((entry) => entry.name), Array.from({ length: 30 }, (_, i) => `d${String(i).padStart(2, '0')}`))
  assert.deepEqual(files.map((entry) => entry.name), Array.from({ length: 10 }, (_, i) => `f${String(i).padStart(2, '0')}.md`))
})

test('v1.1.1 recent: newest-first by mtimeMs, max 8, {rel,title,mtimeMs} with forward-slash rel', async () => {
  await resetState()
  const layout = {}
  for (let i = 0; i < 12; i += 1) layout[`recent/r${String(i).padStart(2, '0')}.md`] = `# R${i}\n`
  const vault = makeBareVault('overview-recent', layout)
  const base = 1_762_300_000
  for (let i = 0; i < 12; i += 1) {
    const abs = path.join(vault.root, 'recent', `r${String(i).padStart(2, '0')}.md`)
    fs.utimesSync(abs, base + i, base + i)
  }
  const rt = runtimeFor({ vaultPath: vault.root, obsidianConfigPath: missingRegistry('overview-recent') })
  const { payload } = await readStatusPayload(rt)
  assert.ok(Array.isArray(payload.recent))
  assert.equal(payload.recent.length, 8, 'recent is capped at 8 entries')
  for (const entry of payload.recent) {
    assert.equal(typeof entry.rel, 'string')
    assert.equal(entry.rel.includes('\\'), false, 'recent rel must use forward slashes')
    assert.equal(typeof entry.title, 'string')
    assert.equal(Number.isFinite(entry.mtimeMs), true, 'mtimeMs must be a finite number')
  }
  assert.deepEqual(
    payload.recent.map((entry) => entry.rel),
    Array.from({ length: 8 }, (_, index) => `recent/r${String(11 - index).padStart(2, '0')}.md`),
    'recent must be newest-first',
  )
  for (let i = 1; i < payload.recent.length; i += 1) {
    assert.ok(payload.recent[i - 1].mtimeMs >= payload.recent[i].mtimeMs, 'recent must be sorted by mtimeMs descending')
  }
  assert.equal(payload.recent[0].title, 'R11')
})

test('v1.1.1 overview: empty vault → tree [] / recent [], still 200 and ok:true', async () => {
  await resetState()
  const vault = makeBareVault('overview-empty', {})
  const rt = runtimeFor({ vaultPath: vault.root, obsidianConfigPath: missingRegistry('overview-empty') })
  const { response, payload } = await readStatusPayload(rt)
  assert.equal(response.statusCode, 200)
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.tree, [])
  assert.deepEqual(payload.recent, [])
  assert.equal(payload.notes.count, 0)
  assert.equal(payload.index.ready, true)
})

test('v1.1.1 overview: index unavailable → tree [] / recent [], index.ready:false, 200, no crash', async () => {
  await resetState()
  const vault = makeBareVault('overview-index-broken', { 'x.md': '# X\n', 'dir/y.md': '# Y\n' })
  const baseRt = runtimeFor({ vaultPath: vault.root, obsidianConfigPath: missingRegistry('overview-index-broken') })
  const failingRt = {
    config: baseRt.config,
    vault: () => baseRt.vault(),
    index: async () => {
      throw new Error('index exploded on purpose')
    },
    rest: () => baseRt.rest(),
    status: () => baseRt.status(),
  }
  const handlers = captureRoutes(failingRt)
  const first = await callRoute(handlers, '/obsidian-hub/status', { method: 'GET' })
  assert.equal(first.statusCode, 200, 'index failure must not crash the endpoint')
  const payload = first.json()
  assert.deepEqual(payload.tree, [], 'tree must be the initializer [] when the index throws')
  assert.deepEqual(payload.recent, [], 'recent must be the initializer [] when the index throws')
  assert.equal(payload.index.ready, false)
  assert.match(String(payload.index.error), /index exploded/)
  // A second call must still answer (no stuck state / no unhandled rejection).
  const second = await callRoute(handlers, '/obsidian-hub/status', { method: 'GET' })
  assert.equal(second.statusCode, 200)
})

test('v1.1.1 overview: POST switch payload carries tree/recent for the NEW vault layout', async () => {
  await resetState()
  const vaultOne = makeBareVault('overview-switch-one', { 'alpha/one.md': '# Alpha\n', 'one-root.md': '# One Root\n' })
  const vaultTwo = makeBareVault('overview-switch-two', { 'beta/two.md': '# Beta\n', 'two-root.md': '# Two Root\n' })
  // Make vaultTwo's root note strictly newer so recent ordering is unambiguous.
  fs.utimesSync(path.join(vaultTwo.root, 'two-root.md'), 1_762_400_100, 1_762_400_100)
  fs.utimesSync(path.join(vaultTwo.root, 'beta', 'two.md'), 1_762_400_000, 1_762_400_000)

  const rt = runtimeFor({ vaultPath: vaultOne.root, obsidianConfigPath: missingRegistry('overview-switch') })
  const handlers = captureRoutes(rt)

  const before = (await callRoute(handlers, '/obsidian-hub/status', { method: 'GET' })).json()
  assert.deepEqual(before.tree.map((entry) => entry.name), ['alpha', 'one-root.md'])

  const switched = await callRoute(handlers, '/obsidian-hub/vault', { method: 'POST', body: { path: vaultTwo.root } })
  assert.equal(switched.statusCode, 200)
  const payload = switched.json()
  assert.deepEqual(payload.tree.map((entry) => entry.name), ['beta', 'two-root.md'], 'POST payload must carry the NEW vault overview')
  assert.equal(payload.tree[0].type, 'dir')
  assert.equal(payload.tree[0].notes, 1)
  assert.deepEqual(payload.recent.map((entry) => entry.rel), ['two-root.md', 'beta/two.md'])
  assert.equal(payload.recent[0].title, 'Two Root')
  assert.equal(payload.vaultSource, 'state')

  const after = (await callRoute(handlers, '/obsidian-hub/status', { method: 'GET' })).json()
  assert.deepEqual(after.tree.map((entry) => entry.name), ['beta', 'two-root.md'])
})

test('v1.1.1 overview cost: 200-note vault, single-pass derivation adds no extra disk I/O or rebuild', async () => {
  await resetState()
  const perf = createPerfVault({ count: 200, root: path.join(paths.base, 'perf-overview') })
  try {
    const rt = runtimeFor({
      vaultPath: perf.root,
      obsidianConfigPath: missingRegistry('perf-overview'),
      indexTtlMs: 60_000,
    })
    await rt.index() // build/warm the index once, outside the measured call

    // Stub only rt.status() so the measurement isolates `collect()` (the real
    // rt.status() spawns App discovery probes and would dominate the timing);
    // vault/index/rest below are the REAL runtime members.
    const stubStatus = {
      ok: true,
      vault: { path: perf.root, source: 'config', exists: true, error: null },
      vaultSource: 'config',
      allowVaultSwitch: true,
      vaults: [],
      rest: { configured: false, reachable: false },
      index: null,
      warnings: [],
    }
    const routeRt = {
      config: rt.config,
      vault: () => rt.vault(),
      index: () => rt.index(),
      rest: () => rt.rest(),
      status: async () => stubStatus,
    }
    const handlers = captureRoutes(routeRt)

    // Warm one identical call so module/JIT/serialization cost is not in the sample.
    await callRoute(handlers, '/obsidian-hub/status', { method: 'GET' })
    const before = (await rt.index()).stats

    const samples = []
    for (let i = 0; i < 5; i += 1) {
      const started = performance.now()
      const response = await callRoute(handlers, '/obsidian-hub/status', { method: 'GET' })
      samples.push(performance.now() - started)
      assert.equal(response.statusCode, 200)
    }
    samples.sort((a, b) => a - b)
    const median = samples[Math.floor(samples.length / 2)]
    const min = samples[0]

    const after = (await rt.index()).stats
    assert.equal(after.notes, 200)
    assert.equal(after.reads, before.reads, 'deriving tree/recent must not read files again')
    assert.equal(after.builtAt, before.builtAt, 'deriving tree/recent must not rebuild the index')
    console.log(
      `[perf] overview status (200 notes): min=${min.toFixed(2)}ms median=${median.toFixed(2)}ms; index reads ${before.reads}→${after.reads}; builtAt unchanged=${after.builtAt === before.builtAt}`,
    )
    assert.ok(median < 100, `one status call over 200 notes should stay well under 100ms, got ${median.toFixed(1)}ms`)

    const payload = (await callRoute(handlers, '/obsidian-hub/status', { method: 'GET' })).json()
    assert.deepEqual(payload.tree.map((entry) => [entry.name, entry.type, entry.notes]), [['perf', 'dir', 200]])
    assert.equal(payload.recent.length, 8)
    assert.ok(payload.recent.every((entry) => entry.rel.startsWith('perf/')), 'recent rels come from the index with forward slashes')

    // Full real call (no stub): this also runs rt.status() -> detectObsidianApp()
    // probes, so report both numbers instead of hiding that cost in the isolated one.
    const realHandlers = captureRoutes(rt)
    await callRoute(realHandlers, '/obsidian-hub/status', { method: 'GET' }) // warm
    const readsBeforeReal = (await rt.index()).stats
    const fullStarted = performance.now()
    const fullResponse = await callRoute(realHandlers, '/obsidian-hub/status', { method: 'GET' })
    const fullWall = performance.now() - fullStarted
    const readsAfterReal = (await rt.index()).stats
    assert.equal(fullResponse.statusCode, 200)
    assert.equal(readsAfterReal.reads, readsBeforeReal.reads, 'full status call must not read note files again')
    assert.equal(readsAfterReal.builtAt, readsBeforeReal.builtAt, 'full status call must not rebuild the index')
    console.log(`[perf] full GET /status wall (200 notes, incl. app-discovery probes): ${fullWall.toFixed(1)}ms`)
    assert.ok(fullWall < 3_000)
  } finally {
    perf.cleanup()
  }
})
