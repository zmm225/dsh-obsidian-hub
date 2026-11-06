/**
 * dsh-obsidian-hub — Host half.
 *
 * Registers the `obsidian_*` model tools. All vault work goes through the
 * shared runtime, which owns the lazily created Vault, VaultIndex, and
 * Local RPC/REST clients.
 *
 * @module dsh-obsidian-hub
 */
import { resolveConfig } from './lib/config.js'
import { createRuntime } from './lib/runtime.js'
import { registerVaultTools } from './lib/tools-vault.js'
import { registerSearchTools } from './lib/tools-search.js'
import { registerLiveTools } from './lib/tools-live.js'
import { registerStatusRoute } from './lib/status-route.js'

export const name = 'obsidian-hub'
export const inject = ['tools']

/**
 * Register every Obsidian capability on the calling context.
 * @param ctx Cordis context carrying the tool registry.
 * @param config The row's config from `cordis.patch.yml` (may be undefined).
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const rt = createRuntime(resolved)

  ctx.effect(() => registerVaultTools(ctx, rt))
  ctx.effect(() => registerSearchTools(ctx, rt))
  ctx.effect(() => registerLiveTools(ctx, rt))
  // Owns its own effects: waits for `webServer`, then registers the read-only
  // status endpoint the Web panel fetches.
  registerStatusRoute(ctx, rt)
}
