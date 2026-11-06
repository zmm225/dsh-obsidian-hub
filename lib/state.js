/**
 * Plugin-owned runtime state: which vault the user picked in the panel.
 *
 * Deliberately a separate little file rather than profile configuration:
 * the harness owns `cordis.patch.yml`, and a user switching vault from the UI
 * should not require editing (or racing) it.
 *
 * Nothing here throws at the caller: a missing, unreadable, or corrupt state
 * file simply means "no state", and the runtime falls back to config/auto.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const STATE_VERSION = 1
const MAX_STATE_BYTES = 64 * 1024

/** Directory that holds plugin-owned state. Overridable for tests. */
export function stateDir() {
  const override = process.env.DSH_OBSIDIAN_HUB_STATE_DIR
  if (typeof override === 'string' && override.trim().length > 0) return override.trim()
  return path.join(os.homedir(), '.dsh', 'obsidian-hub')
}

export function statePath() {
  return path.join(stateDir(), 'state.json')
}

/**
 * Read the persisted selection.
 * @returns {Promise<{vaultPath: string, updatedAt: string|undefined} | null>}
 */
export async function readState() {
  let raw
  try {
    const stat = await fs.stat(statePath())
    if (!stat.isFile()) return null
    if (stat.size > MAX_STATE_BYTES) return null
    raw = await fs.readFile(statePath(), 'utf8')
  } catch {
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const vaultPath = typeof parsed.vaultPath === 'string' ? parsed.vaultPath.trim() : ''
  if (vaultPath.length === 0) return null
  return {
    vaultPath,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
  }
}

/**
 * Persist the selection. Writes a temp file next to the target and renames it,
 * so a crash mid-write cannot leave a half-written state file.
 * @param {string} vaultPath absolute path
 */
export async function writeState(vaultPath) {
  const resolved = path.resolve(String(vaultPath))
  const target = statePath()
  const temporary = `${target}.tmp`
  const payload = `${JSON.stringify({ version: STATE_VERSION, vaultPath: resolved, updatedAt: new Date().toISOString() }, null, 2)}\n`
  await fs.mkdir(stateDir(), { recursive: true })
  await fs.writeFile(temporary, payload, 'utf8')
  try {
    await fs.rename(temporary, target)
  } catch (error) {
    // Windows can refuse to replace an existing file; remove then retry once.
    if (error && (error.code === 'EEXIST' || error.code === 'EPERM' || error.code === 'EACCES')) {
      await fs.rm(target, { force: true })
      await fs.rename(temporary, target)
      return resolved
    }
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  return resolved
}

/** Drop the persisted selection (back to config / auto-detect). */
export async function clearState() {
  try {
    await fs.rm(statePath(), { force: true })
  } catch {
    /* nothing persisted */
  }
}
