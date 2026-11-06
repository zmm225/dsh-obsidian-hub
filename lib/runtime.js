/**
 * Shared runtime: the lazily created Vault, VaultIndex, and REST client that
 * every `obsidian_*` tool reads. One runtime per plugin activation.
 *
 * Nothing here is registered on the context — the tools own registration.
 */
import fs from 'node:fs/promises'
import { createVault } from './vault.js'
import { VaultIndex } from './indexer.js'
import { ObsidianRest } from './rest.js'
import { detectObsidianApp, detectVaults, readRestApiCredentials, readVaultSettings } from './discover.js'

/**
 * @param {ReturnType<import('./config.js').resolveConfig>} config
 */
export function createRuntime(config) {
  /** @type {Promise<import('./vault.js').Vault> | undefined} */
  let vaultPromise
  /** @type {Promise<import('./indexer.js').VaultIndex> | undefined} */
  let indexPromise
  /** @type {import('./rest.js').ObsidianRest | null | undefined} */
  let restClient
  /** @type {'config' | 'vault-plugin' | null} where the REST credentials came from */
  let restSource = null
  /** @type {{ root: string, source: 'config' | 'auto' } | undefined} */
  let rootInfo
  /** Set by any vault mutation so the next index() call re-stats instead of trusting the TTL. */
  let indexDirty = true

  const MUTATING_METHODS = new Set(['write', 'patch', 'remove', 'move', 'copy', 'mkdir'])

  /**
   * Wrap the Vault so every mutation marks the index stale.
   *
   * Without this, a TTL'd index answers `obsidian_search` with pre-write state
   * for up to `indexTtlMs` after `obsidian_write`, which is exactly the agent
   * loop (write a note, then look for it). `ensureFresh` is stat-based, so the
   * forced refresh costs one directory walk, not a rebuild.
   */
  function wrapVault(base) {
    return new Proxy(base, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (typeof value !== 'function') return value
        if (!MUTATING_METHODS.has(property)) return value.bind(target)
        return async (...args) => {
          const result = await value.apply(target, args)
          indexDirty = true
          return result
        }
      },
    })
  }

  async function resolveRoot() {
    if (rootInfo) return rootInfo
    if (config.vaultPath) {
      rootInfo = { root: config.vaultPath, source: 'config' }
      return rootInfo
    }
    if (!config.autoDetect) {
      throw new Error('vaultPath is not configured and autoDetect is disabled. Set `vaultPath` in cordis.patch.yml.')
    }
    const detected = await detectVaults(config.obsidianConfigPath)
    const chosen = detected.vaults.find((vault) => vault.open && vault.exists) ?? detected.vaults.find((vault) => vault.exists)
    if (!chosen) {
      throw new Error(
        `No Obsidian vault found (looked at ${detected.configPath}). ` +
          'Set `vaultPath` in cordis.patch.yml, or open Obsidian once so its vault registry exists.',
      )
    }
    rootInfo = { root: chosen.path, source: 'auto' }
    return rootInfo
  }

  async function vault() {
    if (!vaultPromise) {
      vaultPromise = (async () => {
        const { root } = await resolveRoot()
        const stat = await fs.stat(root).catch(() => null)
        if (!stat || !stat.isDirectory()) throw new Error(`Vault path does not exist or is not a directory: ${root}`)
        return wrapVault(
          createVault({
            root,
            exclude: config.exclude,
            maxFileBytes: config.maxFileBytes,
            trashMode: config.trashMode,
          }),
        )
      })()
      vaultPromise.catch(() => {
        vaultPromise = undefined
      })
    }
    return vaultPromise
  }

  async function index() {
    const owner = await vault()
    if (!indexPromise) {
      indexPromise = (async () => {
        const built = new VaultIndex(owner, {
          maxFiles: config.indexMaxFiles,
          maxTotalBytes: config.indexMaxTotalBytes,
          ttlMs: config.indexTtlMs,
        })
        await built.ensureFresh({ ttlMs: 0 })
        return built
      })()
      indexPromise.catch(() => {
        indexPromise = undefined
      })
    }
    const existing = await indexPromise
    await existing.ensureFresh({ ttlMs: indexDirty ? 0 : config.indexTtlMs })
    indexDirty = false
    return existing
  }

  /**
   * Resolve the Local REST API endpoint.
   *
   * An explicit `restApiKey` in the plugin config wins. Otherwise the key is
   * read from the vault's own Local REST API plugin settings, so enabling that
   * community plugin is the entire setup — no secret is copied into harness
   * configuration and rotating the key needs no config change.
   */
  async function resolveRest() {
    if (config.restApiKey) {
      return { baseUrl: config.restBaseUrl, apiKey: config.restApiKey, source: 'config' }
    }
    let root
    try {
      root = (await resolveRoot()).root
    } catch {
      return null
    }
    const credentials = await readRestApiCredentials(root)
    if (!credentials) return null
    return { baseUrl: credentials.baseUrl, apiKey: credentials.apiKey, source: 'vault-plugin' }
  }

  async function rest() {
    if (restClient !== undefined) return restClient
    let resolved = null
    try {
      resolved = await resolveRest()
    } catch {
      resolved = null
    }
    if (!resolved) {
      restClient = null
      return null
    }
    restSource = resolved.source
    restClient = new ObsidianRest({
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
      insecure: config.restInsecure,
    })
    return restClient
  }

  function reset() {
    vaultPromise = undefined
    indexPromise = undefined
    restClient = undefined
    restSource = null
    rootInfo = undefined
    indexDirty = true
  }

  /** Aggregated, non-throwing plugin status for `obsidian_status`. */
  async function status() {
    const out = {
      ok: true,
      vault: { path: null, source: null, exists: false, error: null },
      account: null,
      settings: null,
      rest: { configured: false, reachable: false, error: null },
      index: null,
      warnings: [],
    }

    try {
      const info = await resolveRoot()
      out.vault.path = info.root
      out.vault.source = info.source
      const stat = await fs.stat(info.root).catch(() => null)
      out.vault.exists = !!stat && stat.isDirectory()
      if (!out.vault.exists) {
        out.ok = false
        out.vault.error = `Vault path does not exist or is not a directory: ${info.root}`
        out.warnings.push('vault unavailable: ' + out.vault.error)
      }
    } catch (error) {
      out.ok = false
      out.vault.error = String(error && error.message ? error.message : error)
      out.warnings.push('vault unavailable: ' + out.vault.error)
    }

    try {
      const detected = await detectVaults(config.obsidianConfigPath)
      const app = await detectObsidianApp()
      out.account = {
        kind: 'local-installation',
        note: 'Obsidian exposes no public account/cloud API; this reports the local app configuration.',
        configPath: detected.configPath,
        configFound: detected.found,
        vaults: detected.vaults,
        app,
        syncNote:
          'Vault sync is whatever you configured inside Obsidian; it cannot be inspected or driven from outside the app.',
      }
    } catch (error) {
      out.warnings.push('account discovery failed: ' + String(error && error.message ? error.message : error))
    }

    if (out.vault.exists) {
      try {
        out.settings = await readVaultSettings(out.vault.path)
      } catch (error) {
        out.warnings.push('vault settings unreadable: ' + String(error && error.message ? error.message : error))
      }
    }

    const client = await rest()
    out.rest.configured = !!client
    if (client) {
      out.rest.source = restSource
      out.rest.url = client.baseUrl
      try {
        const ping = await client.ping()
        out.rest = { ...out.rest, ...ping, configured: true, source: restSource, url: client.baseUrl }
      } catch (error) {
        out.rest.error = String(error && error.message ? error.message : error)
        out.warnings.push('Local REST API unreachable: ' + out.rest.error)
      }
    } else {
      out.rest.hint =
        'Install and enable the "Local REST API" community plugin in Obsidian (its API key is read automatically), ' +
        'or set `restApiKey` in cordis.patch.yml.'
    }

    if (out.vault.exists) {
      try {
        const idx = await index()
        out.index = idx.stats
      } catch (error) {
        out.warnings.push('index unavailable: ' + String(error && error.message ? error.message : error))
      }
    }

    return out
  }

  return { config, vault, index, rest, reset, status, resolveRoot, restSource: () => restSource }
}
