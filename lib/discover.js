/**
 * "Account" discovery for Obsidian.
 *
 * Obsidian has no public account API: an installation is identified by its
 * local app config (`%APPDATA%\obsidian\obsidian.json`), which registers every
 * vault this machine has opened. That registry plus each vault's `.obsidian`
 * directory is what this module reports — never a cloud login.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** @returns {string} candidate `obsidian.json` paths, most specific first. */
export function obsidianConfigCandidates() {
  const out = []
  if (process.env.OBSIDIAN_CONFIG) out.push(process.env.OBSIDIAN_CONFIG)
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  out.push(path.join(appData, 'obsidian', 'obsidian.json'))
  // Non-standard / portable installs keep the config beside the app data dir.
  out.push(path.join(os.homedir(), '.config', 'obsidian', 'obsidian.json'))
  return out
}

async function readJson(file) {
  try {
    const text = await fs.readFile(file, 'utf8')
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Read the machine's vault registry.
 * @param {string} [configPath] explicit `obsidian.json` path
 * @returns {Promise<{configPath: string, found: boolean, vaults: Array<{id: string, path: string, open: boolean, ts: number, exists: boolean}>}>}
 */
export async function detectVaults(configPath) {
  const candidates = configPath ? [configPath] : obsidianConfigCandidates()
  for (const candidate of candidates) {
    const data = await readJson(candidate)
    if (!data || typeof data !== 'object' || !data.vaults || typeof data.vaults !== 'object') continue
    const vaults = []
    for (const [id, entry] of Object.entries(data.vaults)) {
      if (!entry || typeof entry !== 'object') continue
      const vaultPath = typeof entry.path === 'string' ? entry.path : ''
      if (!vaultPath) continue
      let exists = false
      try {
        const stat = await fs.stat(vaultPath)
        exists = stat.isDirectory()
      } catch {
        exists = false
      }
      vaults.push({
        id,
        path: vaultPath,
        open: entry.open === true,
        ts: typeof entry.ts === 'number' ? entry.ts : 0,
        exists,
      })
    }
    vaults.sort((a, b) => Number(b.open) - Number(a.open) || b.ts - a.ts)
    return { configPath: candidate, found: true, vaults }
  }
  return { configPath: candidates[0], found: false, vaults: [] }
}

/** Run a tiny synchronous probe; never throws, never blocks longer than `timeout`. */
function probe(command, args, timeout = 2500) {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout, windowsHide: true })
    return result.stdout || ''
  } catch {
    return ''
  }
}

/** The registered `obsidian://` protocol handler names the real executable. */
function executableFromProtocolHandler() {
  if (process.platform !== 'win32') return undefined
  const out = probe('reg', ['query', 'HKCU\\Software\\Classes\\obsidian\\shell\\open\\command', '/ve'])
  const match = /REG_SZ\s+(.+)/.exec(out)
  if (!match) return undefined
  const exe = /^"([^"]+)"/.exec(match[1].trim())?.[1] ?? match[1].trim().split(/\s+/)[0]
  return exe && exe.toLowerCase().endsWith('.exe') ? exe : undefined
}

/**
 * Read the app log: the last "Loaded main app package <...>/resources/obsidian.asar"
 * line names the install directory, and the trailing "Latest version is X" +
 * "App is up to date." pair names the running version.
 */
async function inspectAppLog() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const logPath = path.join(appData, 'obsidian', 'obsidian.log')
  let text
  try {
    const handle = await fs.open(logPath, 'r')
    try {
      const stat = await handle.stat()
      const size = Math.min(stat.size, 256 * 1024)
      const buffer = Buffer.alloc(size)
      await handle.read(buffer, 0, size, Math.max(0, stat.size - size))
      text = buffer.toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return { logPath, found: false }
  }
  const lines = text.split(/\r?\n/).filter(Boolean)
  let installDir
  let version
  for (const line of lines) {
    const loaded = /Loaded main app package (.+?)[\\/]resources[\\/]obsidian\.asar/.exec(line)
    if (loaded) installDir = loaded[1]
    const latest = /Latest version is ([\d.]+)/.exec(line)
    if (latest) version = latest[1]
  }
  return { logPath, found: true, installDir, version, lastLines: lines.slice(-3) }
}

/** Is an Obsidian.exe process currently running? */
function isRunning() {
  if (process.platform !== 'win32') {
    const out = probe('pgrep', ['-f', 'Obsidian'])
    return out.trim().length > 0
  }
  const out = probe('tasklist', ['/FI', 'IMAGENAME eq Obsidian.exe', '/NH'])
  return /obsidian\.exe/i.test(out)
}

/** Best guess at the Obsidian desktop executable / install directory. */
export async function detectObsidianApp() {
  const executable = executableFromProtocolHandler()
  const log = await inspectAppLog()
  const installDir = log.installDir || (executable ? path.dirname(executable) : undefined)

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const roots = [
    path.join(localAppData, 'Obsidian'),
    path.join(localAppData, 'Programs', 'Obsidian'),
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Obsidian') : '',
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Obsidian') : '',
    installDir || '',
  ].filter(Boolean)
  const installs = []
  for (const root of roots) {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (!/^app-\d/.test(entry.name)) continue
        const exe = path.join(root, entry.name, 'Obsidian.exe')
        try {
          await fs.access(exe)
          installs.push({ version: entry.name.replace(/^app-/, ''), dir: path.join(root, entry.name) })
        } catch {
          /* not an app dir */
        }
      }
    } catch {
      /* root absent */
    }
  }
  installs.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
  return {
    installed: !!(installDir || executable || installs.length),
    running: isRunning(),
    executable: executable || null,
    installDir: installDir || null,
    latest: installs[0]?.version ?? log.version ?? null,
    installs,
    logPath: log.logPath,
  }
}

const REST_PLUGIN_ID = 'obsidian-local-rest-api'

/**
 * Read the Local REST API plugin's own settings out of the vault.
 *
 * The plugin already stores its API key and ports in
 * `<vault>/.obsidian/plugins/obsidian-local-rest-api/data.json`, so the user
 * never has to copy a secret into harness configuration. An explicit
 * `restApiKey` in the plugin config still wins.
 *
 * @param {string} root absolute vault root
 * @returns {Promise<{apiKey: string, port: number, insecurePort: number,
 *   enableSecureServer: boolean, enableInsecureServer: boolean, baseUrl: string} | null>}
 */
export async function readRestApiCredentials(root) {
  const data = await readJson(path.join(root, '.obsidian', 'plugins', REST_PLUGIN_ID, 'data.json'))
  if (!data || typeof data !== 'object') return null
  const apiKey = typeof data.apiKey === 'string' ? data.apiKey.trim() : ''
  if (!apiKey) return null
  const port = Number.isFinite(data.port) ? data.port : 27124
  const insecurePort = Number.isFinite(data.insecurePort) ? data.insecurePort : 27123
  const enableSecureServer = data.enableSecureServer !== false
  const enableInsecureServer = data.enableInsecureServer === true
  const baseUrl = enableSecureServer ? `https://127.0.0.1:${port}` : `http://127.0.0.1:${insecurePort}`
  return { apiKey, port, insecurePort, enableSecureServer, enableInsecureServer, baseUrl }
}

/**
 * Read a vault's own Obsidian settings and plugin state.
 * @param {string} root absolute vault root
 */
export async function readVaultSettings(root) {
  const dir = path.join(root, '.obsidian')
  const [app, appearance, corePlugins, communityPlugins, workspace, data] = await Promise.all([
    readJson(path.join(dir, 'app.json')),
    readJson(path.join(dir, 'appearance.json')),
    readJson(path.join(dir, 'core-plugins.json')),
    readJson(path.join(dir, 'community-plugins.json')),
    readJson(path.join(dir, 'workspace.json')),
    readJson(path.join(dir, 'plugins', REST_PLUGIN_ID, 'data.json')),
  ])
  const enabledCore = Array.isArray(corePlugins)
    ? corePlugins
    : corePlugins && typeof corePlugins === 'object'
      ? Object.entries(corePlugins)
          .filter(([, on]) => on === true)
          .map(([id]) => id)
      : []
  const enabledCommunity = Array.isArray(communityPlugins) ? communityPlugins : []
  return {
    configDir: dir,
    exists: app !== undefined || corePlugins !== undefined || communityPlugins !== undefined,
    app: app ?? null,
    appearance: appearance ?? null,
    enabledCorePlugins: enabledCore,
    enabledCommunityPlugins: enabledCommunity,
    restPlugin: {
      enabled: enabledCommunity.includes(REST_PLUGIN_ID),
      hasConfig: data !== undefined,
      port: data && typeof data.port === 'number' ? data.port : null,
      hasApiKey: !!(data && typeof data.apiKey === 'string' && data.apiKey.length > 0),
    },
    workspaceFile: workspace ? path.join(dir, 'workspace.json') : null,
  }
}
