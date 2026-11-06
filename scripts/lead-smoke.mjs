/**
 * Lead smoke test — exercises the plugin the way the Host does.
 *
 * Drives the real `apply()` with a fake Cordis context (tool registry, effects,
 * webServer injection), then calls every tool's `execute()` + `output.render()`
 * and the HTTP status route.
 *
 * Two contexts are booted: one on the user's real vault (READ-ONLY: read,
 * search, status, route, failure modes) and one on a throwaway temp vault
 * (write, batch, fs operations).
 *
 * Usage: node scripts/lead-smoke.mjs [realVaultPath]
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const bundleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function makeContext() {
  const tools = new Map()
  const routes = []
  const ctx = {
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    effect(fn) {
      return fn()
    },
    inject(_deps, callback) {
      callback({
        webServer: {
          register(route) {
            if (routes.some((r) => r.path === route.path)) throw new Error(`duplicate route: ${route.path}`)
            routes.push(route)
            return () => {
              const index = routes.indexOf(route)
              if (index >= 0) routes.splice(index, 1)
            }
          },
        },
        effect(fn) {
          return fn()
        },
      })
    },
  }
  return { ctx, tools, routes }
}

const results = []
async function check(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, ok: true })
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`)
  } catch (error) {
    const message = String(error && error.message ? error.message : error)
    results.push({ name, ok: false, detail: message })
    console.log(`FAIL  ${name}  — ${message}`)
  }
}

const EXPECTED_TOOLS = [
  'obsidian_read',
  'obsidian_write',
  'obsidian_batch_read',
  'obsidian_batch_write',
  'obsidian_fs',
  'obsidian_search',
  'obsidian_status',
  'obsidian_live',
].sort()

function assertSchemaShape(tools) {
  for (const [name, definition] of tools) {
    if (definition.parameters.type !== 'object') throw new Error(`${name}: parameters.type !== 'object'`)
    if (!definition.parameters.properties || typeof definition.parameters.properties !== 'object') {
      throw new Error(`${name}: parameters.properties missing`)
    }
    if (JSON.stringify(definition.parameters).includes('"required":true')) {
      throw new Error(`${name}: inline required:true leaked into parameters`)
    }
    if (JSON.stringify(definition.output.schema).includes('"required":true')) {
      throw new Error(`${name}: inline required:true leaked into output.schema`)
    }
    if (definition.output.schema.type !== 'object') throw new Error(`${name}: output.schema.type !== 'object'`)
    if (typeof definition.output.render !== 'function') throw new Error(`${name}: render missing`)
    if (typeof definition.execute !== 'function') throw new Error(`${name}: execute missing`)
  }
  return `${tools.size} definitions`
}

function assertRenderMatchesSchema(definition, value) {
  const blocks = definition.output.render({}, value)
  if (!Array.isArray(blocks) || blocks.length === 0) throw new Error('render returned no blocks')
  if (blocks[0].type !== 'text' || typeof blocks[0].text !== 'string') throw new Error('render block is not text')
  if (/\bundefined\b/.test(blocks[0].text)) throw new Error(`render printed "undefined": ${blocks[0].text.slice(0, 120)}`)
  const required = definition.output.schema.required || []
  for (const key of required) {
    if (!(key in value)) throw new Error(`output.schema requires "${key}" but the value lacks it`)
  }
  return blocks
}

async function main() {
  const realVault = process.argv[2] || 'D:/obsidian/obsidian'
  const { apply } = await import(pathToFileURL(path.join(bundleDir, 'index.js')).href)

  // ---------------------------------------------------------------- real vault
  const real = makeContext()
  apply(real.ctx, { vaultPath: realVault, autoDetect: false, indexTtlMs: 0, restApiKey: '' })

  await check('boot on real vault: 8 tools registered', () => {
    const names = [...real.tools.keys()].sort()
    const missing = EXPECTED_TOOLS.filter((n) => !names.includes(n))
    if (missing.length) throw new Error(`missing: ${missing.join(', ')}; got: ${names.join(', ')}`)
    if (names.length !== EXPECTED_TOOLS.length) throw new Error(`unexpected tool count: ${names.join(', ')}`)
    return names.join(', ')
  })

  await check('every definition carries normalized JSON Schema', () => assertSchemaShape(real.tools))

  await check('status route registered at /obsidian-hub/status', () => {
    if (real.routes.length !== 1) throw new Error(`expected 1 route, got ${real.routes.length}`)
    if (real.routes[0].path !== '/obsidian-hub/status') throw new Error(`unexpected path ${real.routes[0].path}`)
    return `${real.routes[0].path} (${real.routes[0].kind})`
  })

  const statusTool = real.tools.get('obsidian_status')
  const statusValue = await statusTool.execute({ action: 'info' }, {})
  await check('obsidian_status info on real vault', () => {
    if (statusValue.ok !== true) throw new Error(`ok=false: ${statusValue.vault && statusValue.vault.error}`)
    if (!String(statusValue.summary).includes('obsidian')) throw new Error('summary does not name the vault')
    const indexStats = statusValue.status && statusValue.status.index
    if (!indexStats) throw new Error('status.index missing')
    if (indexStats.notes < 1) throw new Error('index reports zero notes')
    assertRenderMatchesSchema(statusTool, statusValue)
    if (JSON.stringify(JSON.parse(JSON.stringify(statusValue))) !== JSON.stringify(statusValue)) {
      throw new Error('status value is not JSON-lossless')
    }
    return `${indexStats.notes} notes, ${indexStats.tookMs}ms index`
  })

  const readTool = real.tools.get('obsidian_read')
  await check('obsidian_read resolves a note by wikilink name', async () => {
    const value = await readTool.execute({ note: '欢迎' }, {})
    if (typeof value.content !== 'string' || value.content.length === 0) throw new Error('empty content')
    assertRenderMatchesSchema(readTool, value)
    return `${value.path || value.rel} — ${value.content.split('\n').length} lines`
  })

  const searchTool = real.tools.get('obsidian_search')
  await check('obsidian_search text mode on real vault', async () => {
    const value = await searchTool.execute({ mode: 'text', query: 'Obsidian', limit: 5 }, {})
    if (!Array.isArray(value.results)) throw new Error('results is not an array')
    assertRenderMatchesSchema(searchTool, value)
    return `${value.results.length}/${value.total} hits in ${value.tookMs ?? '?'}ms`
  })

  await check('GET /obsidian-hub/status serves the panel payload', async () => {
    let body = ''
    let statusCode = 0
    const response = {
      set statusCode(value) {
        statusCode = value
      },
      get statusCode() {
        return statusCode
      },
      headers: {},
      setHeader(key, value) {
        this.headers[key] = value
      },
      end(chunk) {
        body = String(chunk)
      },
    }
    await real.routes[0].handler({ method: 'GET' }, response)
    if (statusCode !== 200) throw new Error(`status code ${statusCode}`)
    const payload = JSON.parse(body)
    if (typeof payload.ok !== 'boolean') throw new Error('missing ok')
    if (!Array.isArray(payload.notes.titles)) throw new Error('missing notes.titles')
    if (typeof payload.notes.count !== 'number') throw new Error('missing notes.count')
    if (!payload.rest || typeof payload.rest.reachable !== 'boolean') throw new Error('missing rest.reachable')
    return `ok=${payload.ok} notes=${payload.notes.count} titles=${payload.notes.titles.length} rest=${payload.rest.reachable}`
  })

  await check('path traversal is rejected', async () => {
    try {
      await readTool.execute({ path: '../../../../etc/passwd' }, {})
    } catch (error) {
      return String(error.message).slice(0, 90)
    }
    throw new Error('traversal was NOT rejected')
  })

  await check('missing note fails with a candidate-bearing error', async () => {
    try {
      await readTool.execute({ note: 'definitely-not-a-note-xyz' }, {})
    } catch (error) {
      if (!/not found|not_exists|No note/i.test(String(error.message))) {
        throw new Error('unhelpful message: ' + error.message)
      }
      return String(error.message).slice(0, 100)
    }
    throw new Error('missing note did not throw')
  })

  await check('obsidian_live either reaches the REST API or fails fast with guidance', async () => {
    const started = Date.now()
    try {
      const value = await real.tools.get('obsidian_live').execute({ action: 'ping' }, {})
      if (value.ok !== true) throw new Error('ping returned ok=false')
      assertRenderMatchesSchema(real.tools.get('obsidian_live'), value)
      return `${Date.now() - started}ms — ${String(value.summary).slice(0, 80)}`
    } catch (error) {
      const message = String(error.message)
      if (!/REST|restApiKey/i.test(message)) throw new Error('unhelpful message: ' + message)
      return `refused in ${Date.now() - started}ms — ${message.slice(0, 70)}`
    }
  })

  // --------------------------------------------------------------- temp vault
  const tempVault = await fs.mkdtemp(path.join(os.tmpdir(), 'oh-lead-smoke-'))
  await fs.mkdir(path.join(tempVault, 'notes'), { recursive: true })
  await fs.writeFile(path.join(tempVault, 'notes', 'seed.md'), '---\ntags: [seed]\n---\n# Seed\n\nseed body\n', 'utf8')

  const temp = makeContext()
  apply(temp.ctx, { vaultPath: tempVault, autoDetect: false, indexTtlMs: 0, restApiKey: '' })

  const writeTool = temp.tools.get('obsidian_write')
  await check('obsidian_write on temp vault renders its own value', async () => {
    const value = await writeTool.execute({ path: 'notes/new.md', content: 'hello\n' }, {})
    assertRenderMatchesSchema(writeTool, value)
    const onDisk = await fs.readFile(path.join(tempVault, 'notes', 'new.md'), 'utf8')
    if (!onDisk.includes('hello')) throw new Error('file was not written')
    return `action=${value.action} bytes=${value.bytes}`
  })

  await check('obsidian_write append + frontmatter merge', async () => {
    await writeTool.execute({ path: 'notes/new.md', content: 'tail\n', mode: 'append' }, {})
    const value = await writeTool.execute({ path: 'notes/new.md', content: 'x\n', mode: 'prepend', frontmatter: { status: 'done' } }, {})
    const onDisk = await fs.readFile(path.join(tempVault, 'notes', 'new.md'), 'utf8')
    if (!onDisk.includes('tail')) throw new Error('append lost data')
    if (!/status:\s*done/.test(onDisk)) throw new Error('frontmatter not merged: ' + onDisk.slice(0, 120))
    assertRenderMatchesSchema(writeTool, value)
    return `${onDisk.split('\n').length} lines`
  })

  const batchReadTool = temp.tools.get('obsidian_batch_read')
  await check('obsidian_batch_read reads several notes', async () => {
    const value = await batchReadTool.execute({ paths: ['notes/seed.md', 'notes/new.md'] }, {})
    assertRenderMatchesSchema(batchReadTool, value)
    if (!Array.isArray(value.notes)) throw new Error(`no "notes" array; keys: ${Object.keys(value).join(',')}`)
    if (value.returned !== 2) throw new Error(`expected 2 notes, got ${value.returned}`)
    return `${value.returned}/${value.total} notes`
  })

  const batchWriteTool = temp.tools.get('obsidian_batch_write')
  await check('obsidian_batch_write applies operations', async () => {
    const value = await batchWriteTool.execute(
      {
        operations: [
          { type: 'write', path: 'notes/b1.md', content: 'one\n' },
          { type: 'write', path: 'notes/b2.md', content: 'two\n' },
          { type: 'mkdir', path: 'archive' },
        ],
      },
      {},
    )
    assertRenderMatchesSchema(batchWriteTool, value)
    if (value.failed !== 0) throw new Error(`${value.failed} of ${value.total} failed: ${JSON.stringify(value.results)}`)
    await fs.access(path.join(tempVault, 'notes', 'b2.md'))
    await fs.access(path.join(tempVault, 'archive'))
    return `${value.succeeded}/${value.total} operations`
  })

  const fsTool = temp.tools.get('obsidian_fs')
  await check('obsidian_fs tree/list/stat', async () => {
    const tree = await fsTool.execute({ action: 'tree', path: '' }, {})
    assertRenderMatchesSchema(fsTool, tree)
    const stat = await fsTool.execute({ action: 'stat', path: 'notes/seed.md' }, {})
    assertRenderMatchesSchema(fsTool, stat)
    return `${JSON.stringify(Object.keys(tree)).slice(0, 90)}`
  })

  await check('obsidian_search finds temp content', async () => {
    const value = await temp.tools.get('obsidian_search').execute({ mode: 'text', query: 'seed' }, {})
    if (!Array.isArray(value.results) || value.results.length === 0) throw new Error('no results')
    return `${value.results.length} hits`
  })

  await fs.rm(tempVault, { recursive: true, force: true }).catch(() => {})

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length) {
    console.log('\nFAILURES:')
    for (const failure of failed) console.log(` - ${failure.name}: ${failure.detail}`)
    process.exitCode = 1
  }
}

await main()
