/**
 * HTTP surface for the plugin's Web panel.
 *
 * The Client half of a harness plugin cannot read Host services or tool state
 * directly, so the panel talks to these two same-origin endpoints instead:
 *
 *   GET  /obsidian-hub/status  — connection status, notes, and the vault list
 *   POST /obsidian-hub/vault   — switch the active vault at runtime
 *
 * Only the panel calls these; the payload never carries note bodies, just
 * paths, titles and counts.
 */

const MAX_TITLES = 2000
const MAX_BODY_BYTES = 16 * 1024
/** Top-level directory-tree entries returned to the panel. */
const MAX_TREE_ENTRIES = 40
/** Recently-modified notes returned to the panel. */
const MAX_RECENT = 8

/** Read a small JSON request body. */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        fail(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`))
        request.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    request.on('error', fail)
    request.on('end', () => {
      if (settled) return
      settled = true
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text.length === 0) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('body must be a JSON object'))
          return
        }
        resolve(parsed)
      } catch {
        reject(new Error('body is not valid JSON'))
      }
    })
  })
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload)
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.setHeader('content-length', Buffer.byteLength(body))
  response.end(body)
}

/** Build the panel payload: connection state, current vault, and candidates. */
async function collect(rt) {
  const out = {
    ok: false,
    vaultPath: null,
    vaultName: null,
    vaultSource: null,
    allowVaultSwitch: rt.config.allowVaultSwitch !== false,
    vaults: [],
    notes: { count: 0, titles: [] },
    index: { ready: false },
    tree: [],
    recent: [],
    rest: { configured: false, reachable: false, url: rt.config.restBaseUrl },
    updatedAt: Date.now(),
  }

  // Vault list first: it is useful even when the active vault is unreadable.
  try {
    const status = await rt.status()
    out.vaultSource = status.vaultSource ?? null
    out.vaults = Array.isArray(status.vaults) ? status.vaults : []
    if (status.vault && status.vault.path) {
      out.vaultPath = status.vault.path
      out.vaultName = status.vault.path.split(/[\\/]/).filter(Boolean).pop() || status.vault.path
    }
    if (!status.ok && status.vault && status.vault.error) out.error = status.vault.error
    out.rest = status.rest ? { ...out.rest, ...status.rest } : out.rest
  } catch (error) {
    out.error = String(error && error.message ? error.message : error)
  }

  try {
    const vault = await rt.vault()
    out.vaultPath = vault.root
    out.vaultName = vault.root.split(/[\\/]/).filter(Boolean).pop() || vault.root
    out.ok = true
    delete out.error
  } catch (error) {
    if (!out.error) out.error = String(error && error.message ? error.message : error)
    return out
  }

  try {
    const index = await rt.index()
    const titles = []
    const recent = []
    const directories = new Map()
    const topLevelFiles = []

    // One pass over the index: titles for the filter, plus the two overview
    // blocks. Nothing here stats the disk again.
    for (const record of index.files.values()) {
      if (titles.length < MAX_TITLES) titles.push({ rel: record.rel, title: record.title })
      recent.push({ rel: record.rel, title: record.title, mtimeMs: record.mtimeMs })

      const rel = String(record.rel).replace(/\\/g, '/')
      const segments = rel.split('/')
      if (segments.length > 1) {
        const name = segments[0]
        const entry = directories.get(name) ?? { name, type: 'dir', notes: 0 }
        entry.notes += 1
        directories.set(name, entry)
      } else {
        topLevelFiles.push({ name: segments[0], type: 'file', rel, title: record.title })
      }
    }

    recent.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))
    const dirs = [...directories.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_TREE_ENTRIES)
    const files = topLevelFiles
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, Math.max(0, MAX_TREE_ENTRIES - dirs.length))

    out.index = { ready: true, notes: index.stats.notes, builtAt: index.stats.builtAt }
    out.notes = { count: index.stats.notes, titles }
    out.tree = [...dirs, ...files]
    out.recent = recent.slice(0, MAX_RECENT)
  } catch (error) {
    out.index = { ready: false, error: String(error && error.message ? error.message : error) }
  }

  const client = await rt.rest()
  out.rest.configured = !!client
  if (client) {
    // Report the endpoint actually in use — an auto-discovered port can differ
    // from the configured default, and the panel must not show the wrong one.
    const endpoint = client.baseUrl
    out.rest.url = endpoint
    try {
      const ping = await client.ping()
      out.rest = { configured: true, reachable: true, url: endpoint, authenticated: ping.authenticated }
    } catch {
      out.rest = { configured: true, reachable: false, url: endpoint }
    }
  }

  return out
}

/**
 * Register the status and vault-switch endpoints when the Host has a web server.
 * @param ctx Cordis context
 * @param rt shared runtime
 */
export function registerStatusRoute(ctx, rt) {
  if (typeof ctx.inject !== 'function') return
  try {
    ctx.inject(['webServer'], (webCtx) => {
      const server = webCtx.webServer
      if (!server || typeof server.register !== 'function') return

      webCtx.effect(
        () =>
          server.register({
            kind: 'exact',
            path: '/obsidian-hub/status',
            handler: async (request, response) => {
              let payload
              try {
                payload = await collect(rt)
              } catch (error) {
                payload = {
                  ok: false,
                  error: String(error && error.message ? error.message : error),
                  updatedAt: Date.now(),
                }
              }
              sendJson(response, 200, payload)
            },
          }),
        'obsidian-hub: status route',
      )

      webCtx.effect(
        () =>
          server.register({
            kind: 'exact',
            path: '/obsidian-hub/vault',
            handler: async (request, response) => {
              const method = String(request.method || 'GET').toUpperCase()
              if (method !== 'POST') {
                response.setHeader('allow', 'POST')
                sendJson(response, 405, { ok: false, error: 'This endpoint only accepts POST.' })
                return
              }
              if (rt.config.allowVaultSwitch === false) {
                sendJson(response, 400, {
                  ok: false,
                  error:
                    'Vault switching is disabled in this deployment. Set `allowVaultSwitch: true` on the `obsidian-hub` row in cordis.patch.yml to enable it.',
                })
                return
              }

              let body
              try {
                body = await readJsonBody(request)
              } catch (error) {
                sendJson(response, 400, { ok: false, error: String(error && error.message ? error.message : error) })
                return
              }

              const requested = body.path
              // An empty/malformed body must NOT silently reset the vault to
              // config/auto — clearing is an explicit `{"path": null}`.
              if (!Object.prototype.hasOwnProperty.call(body, 'path')) {
                sendJson(response, 400, {
                  ok: false,
                  error: '`path` is required: send a directory string, or null to fall back to config/auto-detect.',
                })
                return
              }
              if (requested !== null && typeof requested !== 'string') {
                sendJson(response, 400, { ok: false, error: '`path` must be a string or null.' })
                return
              }

              try {
                const switched = await rt.setRoot(requested)
                const payload = await collect(rt)
                payload.switchedTo = switched.root
                payload.vaultSource = switched.source
                sendJson(response, 200, payload)
              } catch (error) {
                sendJson(response, 400, { ok: false, error: String(error && error.message ? error.message : error) })
              }
            },
          }),
        'obsidian-hub: vault switch route',
      )
    })
  } catch {
    /* No web server in this composition (headless/SDK): the panel degrades. */
  }
}
