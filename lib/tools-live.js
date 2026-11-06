/**
 * Live/control tools: `obsidian_status` (account + vault + REST + index
 * diagnostics) and `obsidian_live` (drive the running Obsidian app through the
 * Local REST API plugin, or open notes via the `obsidian://` URI scheme).
 *
 * Honest scope note: Obsidian publishes no account, Sync, or Publish API. The
 * "account" surface here is the machine's local Obsidian installation and its
 * vault registry — never a cloud login.
 */
import { spawn } from 'node:child_process'
import { detectVaults } from './discover.js'
import { defineTool } from './tool-schema.js'

const text = (body) => [{ type: 'text', text: body }]

function line(label, value) {
  if (value === undefined || value === null || value === '') return ''
  return `- ${label}: ${value}\n`
}

/** Launch the Obsidian URI handler on Windows without blocking the Host. */
function openUri(uri) {
  return new Promise((resolve, reject) => {
    if (!/^obsidian:\/\//i.test(uri)) {
      reject(new Error(`Refusing to open a non-obsidian URI: ${uri}`))
      return
    }
    let child
    try {
      if (process.platform === 'win32') {
        child = spawn('cmd.exe', ['/c', 'start', '', uri], { windowsHide: true, detached: true, stdio: 'ignore' })
      } else if (process.platform === 'darwin') {
        child = spawn('open', [uri], { detached: true, stdio: 'ignore' })
      } else {
        child = spawn('xdg-open', [uri], { detached: true, stdio: 'ignore' })
      }
    } catch (error) {
      reject(new Error(`Could not launch the Obsidian URI handler: ${error.message}`))
      return
    }
    child.on('error', (error) => reject(new Error(`Could not launch the Obsidian URI handler: ${error.message}`)))
    child.unref()
    resolve({ ok: true, uri })
  })
}

function buildObsidianUri(vaultName, rel) {
  const params = new URLSearchParams()
  if (vaultName) params.set('vault', vaultName)
  params.set('file', rel)
  return `obsidian://open?${params.toString()}`
}

/**
 * Register `obsidian_status` and `obsidian_live`.
 * @param ctx Cordis context carrying the tool registry.
 * @param rt shared runtime (see lib/runtime.js)
 * @returns {() => void} one disposer for both tools
 */
export function registerLiveTools(ctx, rt) {
  const disposers = []

  disposers.push(
    ctx.tools.register(defineTool({
      name: 'obsidian_status',
      description:
        'Report the Obsidian connection: vault path and note/index statistics, the machine\'s Obsidian installations and vault registry, vault settings, and whether the Local REST API plugin is reachable. Use it first when an obsidian_* call fails, and with action "reindex" to rebuild the search index.',
      parameters: {
        action: {
          type: 'string',
          enum: ['info', 'reindex', 'vaults'],
          description: 'info (default) = full connection report; reindex = force a full index rebuild; vaults = only the vault registry.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', required: true },
            summary: { type: 'string', required: true },
          },
        },
        render: (_args, value) => text(value.summary),
      },
      async execute(args) {
        const action = args && typeof args.action === 'string' ? args.action : 'info'

        if (action === 'reindex') {
          const vault = await rt.vault()
          const index = await rt.index()
          const stats = await index.build({ force: true })
          const summary =
            `Index rebuilt for ${vault.root}\n` +
            line('notes', stats.notes) +
            line('folders', stats.folders) +
            line('links', stats.links) +
            line('tags', stats.tags) +
            line('took', `${stats.tookMs} ms`) +
            line('truncated', stats.truncated ? 'yes (limits reached)' : 'no')
          return { ok: true, action, vault: vault.root, stats, summary }
        }

        if (action === 'vaults') {
          const detected = await detectVaults(rt.config.obsidianConfigPath)
          const rows = detected.vaults
            .map((vault) => `- ${vault.path}${vault.open ? '  (open)' : ''}${vault.exists ? '' : '  [missing]'}`)
            .join('\n')
          const summary =
            `Obsidian vault registry: ${detected.configPath}\n` +
            (rows || '- (no vaults registered)') +
            '\n'
          return { ok: true, action, configPath: detected.configPath, found: detected.found, vaults: detected.vaults, summary }
        }

        const status = await rt.status()
        const restState = status.rest || { configured: false, reachable: false }
        const indexStats = status.index
        const settings = status.settings
        const lines = []
        lines.push(status.ok ? 'Obsidian Hub — connected\n' : 'Obsidian Hub — not connected\n')
        lines.push(line('vault', status.vault.path))
        lines.push(line('vault source', status.vault.source))
        lines.push(line('vault readable', status.vault.exists ? 'yes' : 'no'))
        if (status.vault.error) lines.push(line('vault error', status.vault.error))
        if (indexStats) {
          lines.push(line('notes', indexStats.notes))
          lines.push(line('folders', indexStats.folders))
          lines.push(line('tags', indexStats.tags))
          lines.push(line('links', indexStats.links))
          lines.push(line('index built', `${indexStats.tookMs} ms${indexStats.truncated ? ' (truncated)' : ''}`))
        }
        if (status.account) {
          lines.push(line('obsidian app', status.account.app && status.account.app.installed ? `installed ${status.account.app.latest || ''}` : 'not detected'))
          lines.push(line('vaults registered', status.account.vaults.length))
        }
        if (settings) {
          lines.push(line('core plugins', settings.enabledCorePlugins.length))
          lines.push(line('community plugins', settings.enabledCommunityPlugins.length))
          lines.push(line('Local REST API plugin', settings.restPlugin.enabled ? 'enabled' : 'not enabled'))
        }
        lines.push(line('REST API', restState.configured ? (restState.reachable ? 'reachable' : 'configured but unreachable') : 'not configured'))
        if (restState.error) lines.push(line('REST error', restState.error))
        if (restState.hint) lines.push(line('REST hint', restState.hint))
        for (const warning of status.warnings || []) lines.push(line('warning', warning))
        lines.push(
          '\nNote: Obsidian has no public account or Sync/Publish API. This connection is the local app installation plus the vault directory; changes reach other devices only through whatever sync you configured in Obsidian itself.\n',
        )
        const summary = lines.filter(Boolean).join('')
        return { ok: status.ok, action, summary, status }
      },
    })),
  )

  disposers.push(
    ctx.tools.register(defineTool({
      name: 'obsidian_live',
      description:
        'Control the RUNNING Obsidian app through the Local REST API community plugin: ping it, list or execute Obsidian commands, read the active note, open a note in the UI. Requires restApiKey in the plugin config; without it only action "open-app" (obsidian:// URI) works. For reading/writing vault files always prefer obsidian_read / obsidian_write, which work with Obsidian closed.',
      parameters: {
        action: {
          type: 'string',
          enum: ['ping', 'commands', 'command', 'active', 'open', 'open-app'],
          description: 'ping = reachability check; commands = list command ids; command = run one command id; active = read the active note; open = open a note in the UI via REST; open-app = open a note via the obsidian:// URI handler.',
        },
        command: { type: 'string', description: 'Command id for action=command, e.g. "app:toggle-left-sidebar".' },
        path: { type: 'string', description: 'Vault-relative note path for action=open / open-app.' },
        note: { type: 'string', description: 'Note name or wiki-link to resolve for action=open / open-app (alternative to path).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', required: true },
            action: { type: 'string', required: true },
            summary: { type: 'string', required: true },
          },
        },
        render: (_args, value) => text(value.summary),
      },
      async execute(args) {
        const action = args && typeof args.action === 'string' ? args.action : 'ping'
        const client = await rt.rest()

        const requireRest = () => {
          if (!client) {
            throw new Error(
              'The Local REST API is not configured or not reachable. Install and enable the "Local REST API" ' +
                'community plugin in Obsidian — its API key and port are read from the vault automatically — ' +
                'or set `restApiKey` in cordis.patch.yml.',
            )
          }
          return client
        }

        if (action === 'open-app') {
          const vault = await rt.vault()
          const target = await vault.resolve({ path: args.path, note: args.note })
          const vaultName = vault.root.split(/[\\/]/).filter(Boolean).pop()
          const result = await openUri(buildObsidianUri(vaultName, target.rel))
          return {
            ok: true,
            action,
            vault: vault.root,
            path: target.rel,
            summary: `Opened ${target.rel} through the Obsidian URI handler (vault "${vaultName}").\n${result.uri}`,
          }
        }

        if (action === 'ping') {
          const active = requireRest()
          const ping = await active.ping()
          return {
            ok: true,
            action,
            ping,
            summary: `Local REST API reachable at ${active.baseUrl} in ${ping.tookMs} ms (authenticated: ${ping.authenticated ? 'yes' : 'no'}).`,
          }
        }

        if (action === 'commands') {
          const commands = await requireRest().commands()
          const rows = commands
            .slice(0, 200)
            .map((entry) => `- ${entry.id}${entry.name ? `  — ${entry.name}` : ''}`)
            .join('\n')
          return {
            ok: true,
            action,
            count: commands.length,
            commands,
            summary: `Obsidian commands (${commands.length}${commands.length > 200 ? ', first 200 shown' : ''}):\n${rows || '- (none)'}\n`,
          }
        }

        if (action === 'command') {
          if (!args.command) throw new Error('action=command requires the `command` parameter (a command id from action=commands).')
          const result = await requireRest().runCommand(args.command)
          return { ok: true, action, ...result, summary: `Executed Obsidian command "${args.command}".` }
        }

        if (action === 'active') {
          const content = await requireRest().activeFile()
          return {
            ok: true,
            action,
            content,
            summary: `Active note content (${content.length} chars):\n\n${content.slice(0, 4000)}${content.length > 4000 ? '\n… (truncated)' : ''}`,
          }
        }

        if (action === 'open') {
          const vault = await rt.vault()
          const target = await vault.resolve({ path: args.path, note: args.note })
          await requireRest().openFile(target.rel)
          return { ok: true, action, path: target.rel, summary: `Opened ${target.rel} in the Obsidian UI.` }
        }

        throw new Error(`Unknown action "${action}". Use one of: ping, commands, command, active, open, open-app.`)
      },
    })),
  )

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* already gone */
      }
    }
  }
}
