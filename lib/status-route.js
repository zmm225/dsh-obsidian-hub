/**
 * Read-only status endpoint for the plugin's Web panel.
 *
 * The Client half of a harness plugin cannot read Host services or tool state
 * directly, so the panel fetches this one same-origin JSON document instead.
 * It is strictly read-only and never exposes note bodies — only paths, titles,
 * and counts.
 */

const MAX_TITLES = 2000

async function collect(rt) {
  const out = {
    ok: false,
    vaultPath: null,
    vaultName: null,
    notes: { count: 0, titles: [] },
    index: { ready: false },
    rest: { configured: false, reachable: false, url: rt.config.restBaseUrl },
    updatedAt: Date.now(),
  }

  try {
    const vault = await rt.vault()
    out.vaultPath = vault.root
    out.vaultName = vault.root.split(/[\\/]/).filter(Boolean).pop() || vault.root
    out.ok = true
  } catch (error) {
    out.error = String(error && error.message ? error.message : error)
    return out
  }

  try {
    const index = await rt.index()
    const titles = []
    for (const record of index.files.values()) {
      titles.push({ rel: record.rel, title: record.title })
      if (titles.length >= MAX_TITLES) break
    }
    out.index = { ready: true, notes: index.stats.notes, builtAt: index.stats.builtAt }
    out.notes = { count: index.stats.notes, titles }
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
 * Register `GET /obsidian-hub/status` when the Host has a web server.
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
              const body = JSON.stringify(payload)
              response.statusCode = 200
              response.setHeader('content-type', 'application/json; charset=utf-8')
              response.setHeader('cache-control', 'no-store')
              response.setHeader('content-length', Buffer.byteLength(body))
              response.end(body)
            },
          }),
        'obsidian-hub: status route',
      )
    })
  } catch {
    /* No web server in this composition (headless/SDK): the panel degrades. */
  }
}
