/**
 * Resolve the row config (from `cordis.patch.yml`) into a complete, typed
 * config object. Every consumer reads this — never the raw row config.
 *
 * No schemastery dependency: this bundle is installed as a linked directory
 * and cannot resolve the harness' own node_modules.
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_EXCLUDE = ['.obsidian/**', '.trash/**', '**/node_modules/**', '**/.git/**']

function toInt(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function toBool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  return fallback
}

function toStringArray(value) {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean)
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  }
  return []
}

/** Default vault root: the first vault Obsidian itself knows about. */
export function defaultVaultConfigPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appData, 'obsidian', 'obsidian.json')
}

/**
 * @param {Record<string, unknown> | undefined} input raw row config
 * @returns {{
 *   vaultPath: string, autoDetect: boolean, exclude: string[],
 *   restBaseUrl: string, restApiKey: string, restInsecure: boolean,
 *   indexTtlMs: number, indexMaxFiles: number, indexMaxTotalBytes: number,
 *   maxFileBytes: number, defaultReadLimit: number,
 *   trashMode: 'trash' | 'delete', obsidianConfigPath: string,
 * }}
 */
export function resolveConfig(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const vaultPath = typeof raw.vaultPath === 'string' ? raw.vaultPath.trim() : ''
  const exclude = toStringArray(raw.exclude)

  return {
    vaultPath,
    autoDetect: toBool(raw.autoDetect, true),
    exclude: exclude.length ? exclude : DEFAULT_EXCLUDE.slice(),
    restBaseUrl: (typeof raw.restBaseUrl === 'string' && raw.restBaseUrl.trim()) || 'https://127.0.0.1:27124',
    restApiKey: typeof raw.restApiKey === 'string' ? raw.restApiKey.trim() : '',
    restInsecure: toBool(raw.restInsecure, true),
    indexTtlMs: toInt(raw.indexTtlMs, 8000, 0, 600_000),
    indexMaxFiles: toInt(raw.indexMaxFiles, 20_000, 1, 500_000),
    indexMaxTotalBytes: toInt(raw.indexMaxTotalBytes, 64 * 1024 * 1024, 64 * 1024, 2 * 1024 * 1024 * 1024),
    maxFileBytes: toInt(raw.maxFileBytes, 2 * 1024 * 1024, 1024, 64 * 1024 * 1024),
    defaultReadLimit: toInt(raw.defaultReadLimit, 400, 1, 20_000),
    trashMode: raw.trashMode === 'delete' ? 'delete' : 'trash',
    obsidianConfigPath:
      (typeof raw.obsidianConfigPath === 'string' && raw.obsidianConfigPath.trim()) || defaultVaultConfigPath(),
  }
}

/** Absolute path of this bundle's root directory, for diagnostics. */
export const bundleDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
