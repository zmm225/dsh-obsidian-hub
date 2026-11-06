/**
 * Client for the Obsidian "Local REST API" community plugin
 * (obsidian-local-rest-api). This is the only way to drive the running
 * Obsidian app: execute commands, open notes, read the active note.
 *
 * The plugin serves HTTPS with a self-signed certificate, so this module uses
 * `node:https` with `rejectUnauthorized: false` (configurable) instead of the
 * global `fetch`, which cannot skip certificate validation.
 */
import http from 'node:http'
import https from 'node:https'

export class RestError extends Error {
  constructor(message, code, status) {
    super(message)
    this.name = 'RestError'
    this.code = code
    this.status = status
  }
}

function encodeVaultPath(rel) {
  return String(rel)
    .split('/')
    .filter((part) => part.length > 0 && part !== '.')
    .map((part) => encodeURIComponent(part))
    .join('/')
}

function decodeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export class ObsidianRest {
  /**
   * @param {{ baseUrl: string, apiKey: string, insecure?: boolean, timeoutMs?: number }} options
   */
  constructor({ baseUrl, apiKey, insecure = true, timeoutMs = 8000 }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '')
    this.apiKey = apiKey || ''
    this.insecure = insecure !== false
    this.timeoutMs = timeoutMs
    if (!this.baseUrl) {
      this.transport = https
      this.hostname = '127.0.0.1'
      this.port = 27124
      this.agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false })
      return
    }
    let url
    try {
      url = new URL(this.baseUrl)
    } catch {
      throw new RestError(`Invalid restBaseUrl: ${JSON.stringify(this.baseUrl)} (expected e.g. https://127.0.0.1:27124)`, 'invalid_url')
    }
    this.transport = url.protocol === 'http:' ? http : https
    this.hostname = url.hostname
    this.port = url.port ? Number(url.port) : url.protocol === 'http:' ? 80 : 443
    this.agent = new this.transport.Agent({
      keepAlive: true,
      rejectUnauthorized: this.transport === https ? !this.insecure : undefined,
    })
  }

  get configured() {
    return this.baseUrl.length > 0 && this.apiKey.length > 0
  }

  /**
   * @param {string} method
   * @param {string} endpoint absolute path beginning with `/`
   * @param {{ body?: unknown, contentType?: string, headers?: Record<string, string>, timeoutMs?: number }} [options]
   */
  request(method, endpoint, options = {}) {
    const body = options.body === undefined ? undefined : Buffer.from(String(options.body), 'utf8')
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: options.contentType || 'application/json',
      ...options.headers,
    }
    if (body) {
      headers['Content-Type'] = options.contentType || 'text/markdown'
      headers['Content-Length'] = String(body.length)
    }
    return new Promise((resolve, reject) => {
      const req = this.transport.request(
        { method, hostname: this.hostname, port: this.port, path: endpoint, headers, agent: this.agent },
        (res) => {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            const status = res.statusCode || 0
            if (status >= 200 && status < 300) {
              resolve({ status, headers: res.headers, text, json: decodeJson(text) })
            } else {
              reject(
                new RestError(
                  `Obsidian REST ${method} ${endpoint} failed: HTTP ${status} ${text.slice(0, 300)}`,
                  status === 401 ? 'unauthorized' : 'http_error',
                  status,
                ),
              )
            }
          })
        },
      )
      req.setTimeout(options.timeoutMs ?? this.timeoutMs, () => {
        req.destroy(new RestError(`Obsidian REST ${method} ${endpoint} timed out`, 'timeout'))
      })
      req.on('error', (error) => {
        reject(
          error instanceof RestError
            ? error
            : new RestError(
                `Obsidian REST unreachable at ${this.baseUrl} (${error.code || error.message}). ` +
                  'Is Obsidian running with the "Local REST API" community plugin enabled?',
                error.code || 'unreachable',
              ),
        )
      })
      if (body) req.write(body)
      req.end()
    })
  }

  async ping() {
    const started = Date.now()
    const res = await this.request('GET', '/')
    return {
      reachable: true,
      tookMs: Date.now() - started,
      authenticated: !!(res.json && res.json.authenticated),
      service: (res.json && res.json.service) || null,
      versions: (res.json && res.json.versions) || null,
    }
  }

  async listDir(rel = '') {
    const res = await this.request('GET', `/vault/${encodeVaultPath(rel)}/`.replace(/\/+$/, '/'))
    return res.json ?? { files: [] }
  }

  async readFile(rel) {
    const res = await this.request('GET', `/vault/${encodeVaultPath(rel)}`)
    return res.text
  }

  async writeFile(rel, content, { overwrite = true } = {}) {
    const headers = overwrite ? {} : { 'Create-Only': 'true' }
    const res = await this.request('PUT', `/vault/${encodeVaultPath(rel)}`, {
      body: content,
      contentType: 'text/markdown',
      headers,
    })
    return res.json ?? { ok: true }
  }

  async appendFile(rel, content) {
    const res = await this.request('PATCH', `/vault/${encodeVaultPath(rel)}`, {
      body: content,
      contentType: 'text/markdown',
      headers: { Operation: 'append', 'Target-Type': 'file' },
    })
    return res.json ?? { ok: true }
  }

  async deleteFile(rel) {
    const res = await this.request('DELETE', `/vault/${encodeVaultPath(rel)}`)
    return res.json ?? { ok: true }
  }

  /** Full-text search over the live metadata cache. */
  async search(query, contextLength = 100) {
    const qs = new URLSearchParams({ query: String(query), contextLength: String(contextLength) })
    const res = await this.request('POST', `/search/simple/?${qs.toString()}`)
    return Array.isArray(res.json) ? res.json : []
  }

  async activeFile() {
    const res = await this.request('GET', '/active/')
    return res.text
  }

  async commands() {
    const res = await this.request('GET', '/commands/')
    return (res.json && res.json.commands) || []
  }

  async runCommand(id) {
    await this.request('POST', `/commands/${encodeURIComponent(id)}/`, { body: '' })
    return { ok: true, command: id }
  }

  async openFile(rel, newLeaf = false) {
    await this.request('POST', `/open/${encodeVaultPath(rel)}`, { body: '' })
    return { ok: true, opened: rel, newLeaf }
  }
}
