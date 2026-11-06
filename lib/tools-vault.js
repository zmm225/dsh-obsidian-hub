/**
 * Vault tools: `obsidian_read`, `obsidian_write`, `obsidian_batch_read`,
 * `obsidian_batch_write`, `obsidian_fs`.
 *
 * Every tool is authored in the readable property-map form and registered
 * through `lib/tool-schema.js` (see that module for why the normalizer is
 * required: `ctx.tools.register()` never normalizes a bare property map, and
 * its `output.schema` validator rejects the inline `required: true` marker).
 *
 * Rendering rules: text is compact, one note body is capped at 6000 characters
 * per read, batch results are summarized with per-item outcomes, and every
 * truncation is reported through `truncated: true` so the model knows to ask
 * for a line range instead of assuming it saw the whole note.
 *
 * @module lib/tools-vault
 */
import { registerTools } from './tool-schema.js'
import { parseFrontmatter, parseHeadings, parseLinks, parseTags, parseTasks } from './frontmatter.js'

/** Max characters of one note body returned to the model by a single read. */
const MAX_NOTE_CHARS = 6000
/** Max characters of one note body inside a batch read. */
const MAX_BATCH_NOTE_CHARS = 4000
const DEFAULT_BATCH_LIMIT = 10
const MAX_BATCH_LIMIT = 50
const MAX_RENDER_CHARS = 24_000

const INCLUDE_FLAGS = ['frontmatter', 'links', 'backlinks', 'tags', 'headings', 'tasks']
const WRITE_MODES = ['overwrite', 'append', 'prepend', 'create', 'patch']
const NEWLINE_MODES = ['auto', 'lf', 'crlf']
const FS_ACTIONS = ['list', 'tree', 'stat', 'move', 'copy', 'delete', 'mkdir']
const OPERATION_TYPES = ['write', 'append', 'prepend', 'patch', 'move', 'copy', 'delete', 'trash', 'mkdir']

/**
 * Register the five vault tools.
 * @param ctx Cordis context carrying `ctx.tools`
 * @param {object} rt plugin runtime (`rt.vault()`, `rt.index()`, `rt.config`)
 * @returns {() => void} ONE disposer that unregisters all five tools
 */
export function registerVaultTools(ctx, rt) {
  return registerTools(ctx, [readTool(rt), writeTool(rt), batchReadTool(rt), batchWriteTool(rt), fsTool(rt)])
}

// #region obsidian_read

function readTool(rt) {
  return {
    name: 'obsidian_read',
    description:
      'Read one note from the Obsidian vault. Identify it with `path` (vault-relative, e.g. "notes/a.md") or `note` ' +
      '(resolved like Obsidian: "Welcome", "[[Welcome]]", "folder/Welcome.md"). Returns the note text plus ' +
      '`version` for optimistic writes. `offset`/`limit` select a line window (0-based offset; 0 = to the end). ' +
      '`include` adds sections: frontmatter, links, backlinks, tags, headings, tasks. Long notes are truncated and ' +
      'report `truncated: true` — then re-read with offset/limit to see the rest.',
    parameters: {
      path: { type: 'string', description: 'Vault-relative note path, e.g. "notes/a.md" or "欢迎.md".' },
      note: { type: 'string', description: 'Note name or wikilink, e.g. "欢迎", "[[欢迎]]", "notes/欢迎.md".' },
      offset: { type: 'integer', description: '0-based first line to return. Default 0.' },
      limit: { type: 'integer', description: 'Maximum lines to return (0 = all remaining). Defaults to config.defaultReadLimit.' },
      include: {
        type: 'array',
        items: { type: 'string', enum: INCLUDE_FLAGS },
        description: 'Extra sections to add: frontmatter, links, backlinks, tags, headings, tasks.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          content: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          truncatedReason: { type: 'string' },
          totalLines: { type: 'integer', required: true },
          lineStart: { type: 'integer', required: true },
          lineEnd: { type: 'integer', required: true },
          size: { type: 'integer', required: true },
          mtimeMs: { type: 'number', required: true },
          version: { type: 'string', required: true },
          frontmatter: { type: 'object' },
          links: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { type: 'string', required: true },
                target: { type: 'string', required: true },
                alias: { type: 'string' },
                heading: { type: 'string' },
                raw: { type: 'string', required: true },
                embed: { type: 'boolean' },
              },
            },
          },
          backlinks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { from: { type: 'string', required: true }, raw: { type: 'string' } },
            },
          },
          tags: { type: 'array', items: { type: 'string' } },
          headings: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                level: { type: 'integer', required: true },
                text: { type: 'string', required: true },
                line: { type: 'integer', required: true },
              },
            },
          },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                line: { type: 'integer', required: true },
                checked: { type: 'boolean', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_args, value) {
        const parts = [
          `${value.path} — ${formatBytes(value.size)}, lines ${value.lineStart}-${value.lineEnd} of ${value.totalLines}, version ${value.version}`,
        ]
        if (value.truncated) parts.push(`(truncated${value.truncatedReason ? `: ${value.truncatedReason}` : ''})`)
        if (value.frontmatter !== undefined) parts.push(`--- frontmatter ---\n${renderFrontmatter(value.frontmatter)}`)
        parts.push(value.content === '' ? '(empty note)' : value.content)
        if (value.tags && value.tags.length > 0) parts.push(`tags: ${value.tags.join(', ')}`)
        if (value.headings && value.headings.length > 0) {
          parts.push(`headings:\n${value.headings.map((heading) => `  h${heading.level} ${heading.text}`).join('\n')}`)
        }
        if (value.tasks && value.tasks.length > 0) {
          const open = value.tasks.filter((task) => !task.checked).length
          parts.push(
            `tasks (${open} open / ${value.tasks.length - open} done):\n` +
              value.tasks.slice(0, 30).map((task) => `  ${task.checked ? '[x]' : '[ ]'} ${task.text}`).join('\n'),
          )
        }
        if (value.links && value.links.length > 0) {
          parts.push(`links: ${value.links.map((link) => linkLabel(link)).join(', ')}`)
        }
        if (value.backlinks && value.backlinks.length > 0) {
          parts.push(`backlinks: ${value.backlinks.map((entry) => entry.from).join(', ')}`)
        }
        if (value.warnings && value.warnings.length > 0) parts.push(`warnings: ${value.warnings.join('; ')}`)
        return [{ type: 'text', text: clip(parts.join('\n\n')) }]
      },
    },
    presentCall(args) {
      return { card: 'generic', title: args.note || args.path || 'obsidian_read', kind: 'read' }
    },
    async execute(args) {
      const vault = await openVault(rt)
      const rel = await resolveTarget(vault, args)
      const full = await vault.read(rel, {})
      const lines = full.content === '' ? [] : full.content.split('\n')
      const offset = Math.max(0, toInt(args.offset, 0))
      const configuredLimit = toInt(rt.config && rt.config.defaultReadLimit, 400)
      const requestedLimit = args.limit === undefined || args.limit === null ? configuredLimit : toInt(args.limit, 0)
      const start = Math.min(offset, full.totalLines)
      const end = requestedLimit > 0 ? Math.min(full.totalLines, start + requestedLimit) : full.totalLines

      let content = lines.slice(start, end).join('\n')
      let truncated = full.truncated || start > 0 || end < full.totalLines
      let truncatedReason = full.truncated ? 'file_size' : start > 0 || end < full.totalLines ? 'line_window' : undefined
      if (content.length > MAX_NOTE_CHARS) {
        content = content.slice(0, MAX_NOTE_CHARS)
        truncated = true
        truncatedReason = 'max_chars'
      }

      const include = parseInclude(args)
      const value = {
        path: rel,
        content,
        truncated,
        ...(truncatedReason ? { truncatedReason } : {}),
        totalLines: full.totalLines,
        lineStart: start + 1,
        lineEnd: end,
        size: full.size,
        mtimeMs: full.mtimeMs,
        version: full.version,
      }

      if (include.size > 0) {
        const parsed = parseFrontmatter(full.content)
        const body = parsed.has ? parsed.body : full.content
        const warnings = []
        if (include.has('frontmatter')) value.frontmatter = parsed.has ? parsed.data : {}
        if (include.has('links')) value.links = parseLinks(body)
        if (include.has('tags')) value.tags = parseTags(body, parsed.data)
        if (include.has('headings')) value.headings = parseHeadings(body)
        if (include.has('tasks')) value.tasks = parseTasks(body)
        if (include.has('backlinks')) {
          const backlinks = await collectBacklinks(rt, rel, warnings)
          if (backlinks !== null) value.backlinks = backlinks
        }
        if (warnings.length > 0) value.warnings = warnings
      }
      return value
    },
  }
}

// #endregion
// #region obsidian_write

function writeTool(rt) {
  return {
    name: 'obsidian_write',
    description:
      'Write to one note. `mode`: overwrite (default, creates if missing), append, prepend, create (fails if it exists), ' +
      'or patch (replace `find` with `replace`; set `all`/`regex` as needed). `frontmatter` is a key/value patch deep-merged ' +
      'into the existing block — a key set to null clears the value; omit it to leave frontmatter untouched. Pass ' +
      '`expectedVersion` from obsidian_read to refuse writing over a concurrent edit. Writes are atomic and preserve the ' +
      "note's existing line endings.",
    parameters: {
      path: { type: 'string', required: true, description: 'Vault-relative note path, e.g. "notes/a.md". Created if missing (except mode "create").' },
      content: { type: 'string', description: 'Note text for overwrite/append/prepend/create. Use "" for an empty note. Not used with mode "patch".' },
      mode: { type: 'string', enum: WRITE_MODES, description: 'overwrite (default) | append | prepend | create | patch.' },
      frontmatter: { type: 'object', description: 'Frontmatter keys to merge. null clears a key; nested objects merge one level deep.' },
      find: { type: 'string', description: 'Required for mode "patch": literal text to replace (or a regex when regex: true).' },
      replace: { type: 'string', description: 'Text inserted in place of `find`. Default "".' },
      all: { type: 'boolean', description: 'Replace every occurrence (default replaces the first only).' },
      regex: { type: 'boolean', description: 'Treat `find` as a JavaScript regular expression.' },
      expectedVersion: { type: 'string', description: 'Version from a prior read; the write fails with version_mismatch if the note changed.' },
      createDirs: { type: 'boolean', description: 'Create missing parent folders (default true).' },
      newline: { type: 'string', enum: NEWLINE_MODES, description: 'auto (preserve existing, default) | lf | crlf.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          action: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          mtimeMs: { type: 'number', required: true },
          version: { type: 'string', required: true },
          replacements: { type: 'integer' },
        },
      },
      render(_args, value) {
        const detail = value.replacements === undefined ? '' : `, ${value.replacements} replacement${value.replacements === 1 ? '' : 's'}`
        return [{ type: 'text', text: `${value.action} ${value.path} — ${value.bytes} bytes${detail}, version ${value.version}` }]
      },
    },
    presentCall(args) {
      return { card: 'generic', title: args.path || 'obsidian_write', kind: 'edit' }
    },
    async execute(args) {
      const vault = await openVault(rt)
      const path = requireString(args.path, 'path')
      const mode = normalizeEnum(args.mode, WRITE_MODES, 'overwrite', 'mode')
      const options = {
        mode,
        createDirs: args.createDirs !== false,
        newline: normalizeEnum(args.newline, NEWLINE_MODES, 'auto', 'newline'),
      }
      if (args.expectedVersion !== undefined && args.expectedVersion !== null) {
        options.expectedVersion = requireString(args.expectedVersion, 'expectedVersion')
      }
      if (args.frontmatter !== undefined && args.frontmatter !== null) {
        if (typeof args.frontmatter !== 'object' || Array.isArray(args.frontmatter)) {
          throw new Error('frontmatter must be a plain object, e.g. {"tags": ["a"], "status": "draft"}')
        }
        options.frontmatter = args.frontmatter
      }
      if (mode === 'patch') {
        options.find = requireString(args.find, 'find (required for mode "patch")')
        if (args.replace !== undefined && args.replace !== null) options.replace = String(args.replace)
        options.all = args.all === true
        options.regex = args.regex === true
        return publicWriteResult(await vault.write(path, '', options))
      }
      if (args.content === undefined || args.content === null) {
        throw new Error(`content is required for mode "${mode}" (pass "" for an empty note)`)
      }
      if (typeof args.content !== 'string') throw new Error('content must be a string')
      return publicWriteResult(await vault.write(path, args.content, options))
    },
  }
}

/**
 * Map `vault.write()`'s `{rel, ...}` onto the tool's public `{path, ...}` shape.
 *
 * The vault layer speaks `rel` (its contract); the tool schema and render speak
 * `path`. Returning the raw vault result here is what printed
 * "created undefined — 6 bytes" in the host smoke test.
 * @param {{rel: string} & Record<string, unknown>} result
 */
function publicWriteResult(result) {
  const { rel, ...rest } = result
  return { path: rel, ...rest }
}

// #endregion
// #region obsidian_batch_read

function batchReadTool(rt) {
  return {
    name: 'obsidian_batch_read',
    description:
      'Read several notes in one call to save round trips. Select them with `paths` (array of vault-relative paths or note ' +
      'names), or with `glob` (e.g. "notes/**/*.md") or `query` (substring of the path). Every selection is validated ' +
      'before anything is read, then each note is returned or reported as a per-item error. Per-note bodies are capped ' +
      '(`maxChars`, default 6000) and truncation is reported. Use obsidian_search when you need ranked content search ' +
      'instead of an explicit file list.',
    parameters: {
      paths: { type: 'array', items: { type: 'string' }, description: 'Notes to read: vault-relative paths or note names.' },
      glob: { type: 'string', description: 'Vault-relative glob selecting notes, e.g. "notes/**/*.md".' },
      query: { type: 'string', description: 'Case-insensitive substring matched against file paths.' },
      limit: { type: 'integer', description: `Maximum notes to read. Default ${DEFAULT_BATCH_LIMIT}, max ${MAX_BATCH_LIMIT}.` },
      maxChars: { type: 'integer', description: 'Per-note character cap (default 6000).' },
      include: {
        type: 'array',
        items: { type: 'string', enum: INCLUDE_FLAGS },
        description: 'Extra sections to add per note: frontmatter, links, tags, headings, tasks.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          returned: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          selection: { type: 'string', required: true },
          notes: { type: 'array', items: { type: 'object' }, required: true },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_args, value) {
        const lines = [`${value.returned} of ${value.total} note(s) from ${value.selection}${value.truncated ? ' (truncated)' : ''}`]
        for (const note of value.notes) {
          if (!note.ok) {
            lines.push(`✗ ${note.path}: ${note.error}`)
            continue
          }
          const flags = [formatBytes(note.size), `${note.totalLines} lines`]
          if (note.truncated) flags.push('truncated')
          lines.push(`## ${note.path} (${flags.join(', ')}, version ${note.version})`)
          if (note.frontmatter !== undefined) lines.push(`--- frontmatter ---\n${renderFrontmatter(note.frontmatter)}`)
          lines.push(note.content === '' ? '(empty note)' : note.content)
          if (note.tags && note.tags.length > 0) lines.push(`tags: ${note.tags.join(', ')}`)
          if (note.headings && note.headings.length > 0) lines.push(`headings: ${note.headings.map((heading) => heading.text).join(' · ')}`)
          if (note.tasks && note.tasks.length > 0) {
            lines.push(`tasks: ${note.tasks.filter((task) => !task.checked).length} open / ${note.tasks.filter((task) => task.checked).length} done`)
          }
        }
        if (value.warnings && value.warnings.length > 0) lines.push(`warnings: ${value.warnings.join('; ')}`)
        return [{ type: 'text', text: clip(lines.join('\n'), MAX_RENDER_CHARS) }]
      },
    },
    presentCall(args) {
      const label = Array.isArray(args.paths) ? `${args.paths.length} notes` : args.glob || args.query || 'notes'
      return { card: 'generic', title: `Batch read ${label}`, kind: 'read' }
    },
    async execute(args) {
      const vault = await openVault(rt)
      const limit = clamp(toInt(args.limit, DEFAULT_BATCH_LIMIT), 1, MAX_BATCH_LIMIT)
      const maxChars = clamp(toInt(args.maxChars, MAX_NOTE_CHARS), 200, MAX_NOTE_CHARS * 4)
      const selection = await selectNotes(vault, args, limit)
      const include = parseInclude(args)
      const targets = selection.files.slice(0, limit)
      const warnings = []

      // Validate every selected target before reading any of them.
      const prepared = []
      for (let index = 0; index < targets.length; index += 1) {
        const requested = targets[index]
        try {
          const rel = await resolveLoose(vault, requested)
          const stat = await vault.stat(rel)
          if (!stat) throw new Error(`note not found: ${rel}`)
          if (stat.type !== 'file') throw new Error(`"${rel}" is a folder, not a note`)
          prepared.push({ index, requested, path: rel, ok: true })
        } catch (error) {
          prepared.push({ index, requested, path: requested, ok: false, error: messageOf(error) })
        }
      }

      const notes = []
      for (const item of prepared) {
        if (!item.ok) {
          notes.push({ index: item.index, path: item.path, ok: false, error: item.error })
          continue
        }
        try {
          const full = await vault.read(item.path, {})
          let content = full.content
          let truncated = full.truncated
          if (content.length > maxChars) {
            content = content.slice(0, maxChars)
            truncated = true
          }
          const note = {
            index: item.index,
            path: item.path,
            ok: true,
            content,
            truncated,
            totalLines: full.totalLines,
            size: full.size,
            mtimeMs: full.mtimeMs,
            version: full.version,
          }
          if (include.size > 0) {
            const parsed = parseFrontmatter(full.content)
            const body = parsed.has ? parsed.body : full.content
            if (include.has('frontmatter')) note.frontmatter = parsed.has ? parsed.data : {}
            if (include.has('tags')) note.tags = parseTags(body, parsed.data)
            if (include.has('headings')) note.headings = parseHeadings(body)
            if (include.has('tasks')) note.tasks = parseTasks(body)
            if (include.has('links')) note.links = parseLinks(body)
          }
          notes.push(note)
        } catch (error) {
          notes.push({ index: item.index, path: item.path, ok: false, error: messageOf(error) })
        }
      }

      const failed = notes.filter((note) => !note.ok).length
      const truncated = selection.files.length > targets.length || notes.some((note) => note.ok && note.truncated)
      if (failed > 0) warnings.push(`${failed} note(s) could not be read`)
      return {
        total: selection.files.length,
        returned: notes.length,
        truncated,
        selection: selection.label,
        notes,
        ...(warnings.length > 0 ? { warnings } : {}),
      }
    },
  }
}

// #endregion
// #region obsidian_batch_write

function batchWriteTool(rt) {
  return {
    name: 'obsidian_batch_write',
    description:
      'Apply several vault operations in one call: `operations` is an array of objects, each with `type` = write | append | ' +
      'prepend | patch | move | copy | delete | trash | mkdir plus that type\'s fields (path, content, frontmatter, find, ' +
      'replace, all, regex, dest, overwrite, recursive, toTrash, expectedVersion, newline, createDirs). ALL operations are ' +
      'validated before any is executed, and the result reports a per-item {index, ok, ...} outcome. `continueOnError` ' +
      'defaults to true; set it to false to stop at the first failure. Use this instead of many single writes when creating ' +
      'a set of notes or reorganizing a folder.',
    parameters: {
      operations: {
        type: 'array',
        items: { type: 'object' },
        required: true,
        description: 'Operations to run in order. Each: {type, path, content?, frontmatter?, find?, replace?, all?, regex?, dest?, overwrite?, recursive?, toTrash?, expectedVersion?, newline?, createDirs?}.',
      },
      continueOnError: { type: 'boolean', description: 'true (default) keeps going after a failure; false stops at the first failure and marks the rest skipped.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          succeeded: { type: 'integer', required: true },
          failed: { type: 'integer', required: true },
          skipped: { type: 'integer', required: true },
          results: { type: 'array', items: { type: 'object' }, required: true },
        },
      },
      render(_args, value) {
        const lines = [`${value.succeeded} of ${value.total} operation(s) succeeded` + (value.failed > 0 ? `, ${value.failed} failed` : '') + (value.skipped > 0 ? `, ${value.skipped} skipped` : '')]
        for (const result of value.results) {
          const label = `[${result.index}] ${result.type}${result.path ? ` ${result.path}` : ''}`
          if (!result.ok) {
            lines.push(`✗ ${label}: ${result.error || 'failed'}${result.skipped ? ' (skipped)' : ''}`)
            continue
          }
          const detail = []
          if (result.action) detail.push(result.action)
          if (result.bytes !== undefined) detail.push(`${result.bytes} bytes`)
          if (result.version) detail.push(`version ${result.version}`)
          if (result.replacements !== undefined) detail.push(`${result.replacements} replacement(s)`)
          if (result.to) detail.push(`→ ${result.to}`)
          lines.push(`✓ ${label}${detail.length > 0 ? ` — ${detail.join(', ')}` : ''}`)
        }
        return [{ type: 'text', text: clip(lines.join('\n'), MAX_RENDER_CHARS) }]
      },
    },
    presentCall(args) {
      const count = Array.isArray(args.operations) ? args.operations.length : 0
      return { card: 'generic', title: `Batch write (${count} operation${count === 1 ? '' : 's'})`, kind: 'edit' }
    },
    async execute(args) {
      const vault = await openVault(rt)
      if (!Array.isArray(args.operations)) throw new Error('operations must be an array of operation objects')
      if (args.operations.length === 0) throw new Error('operations must contain at least one operation')
      if (args.operations.length > 200) throw new Error('at most 200 operations per call; split the batch')
      const continueOnError = args.continueOnError !== false

      // Phase 1: validate the full batch before touching the filesystem.
      const prepared = args.operations.map((operation, index) => prepareOperation(vault, operation, index))

      // Phase 2: execute in order.
      const results = []
      let stopped = false
      for (const item of prepared) {
        if (item.error !== undefined) {
          results.push({ index: item.index, type: item.type ?? 'unknown', path: item.path, ok: false, error: item.error })
          if (!continueOnError) stopped = true
          continue
        }
        if (stopped) {
          results.push({ index: item.index, type: item.type, path: item.path, ok: false, skipped: true, error: 'skipped: an earlier operation failed' })
          continue
        }
        try {
          results.push(await executeOperation(vault, item))
        } catch (error) {
          results.push({
            index: item.index,
            type: item.type,
            path: item.path,
            ok: false,
            error: messageOf(error),
            ...(error && typeof error === 'object' && typeof error.code === 'string' ? { code: error.code } : {}),
          })
          if (!continueOnError) stopped = true
        }
      }

      const succeeded = results.filter((result) => result.ok).length
      const skipped = results.filter((result) => result.skipped === true).length
      return {
        total: results.length,
        succeeded,
        failed: results.length - succeeded - skipped,
        skipped,
        results,
      }
    },
  }
}

function prepareOperation(vault, operation, index) {
  const base = { index, type: 'unknown', path: '' }
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    return { ...base, error: `operation ${index}: expected an object like {"type": "mkdir", "path": "notes/new"}` }
  }
  const type = typeof operation.type === 'string' ? operation.type.trim().toLowerCase() : ''
  const prepared = { ...base, type, operation }
  if (!OPERATION_TYPES.includes(type)) {
    return { ...prepared, error: `operation ${index}: unknown type "${String(operation.type)}"; use ${OPERATION_TYPES.join(', ')}` }
  }
  if (typeof operation.path !== 'string' || operation.path.trim() === '') {
    return { ...prepared, error: `operation ${index} (${type}): "path" is required` }
  }
  prepared.path = operation.path
  const fail = (error) => ({ ...prepared, error: `operation ${index} (${type}): ${error}` })
  if (type === 'move' || type === 'copy') {
    if (typeof operation.dest !== 'string' || operation.dest.trim() === '') return fail('"dest" is required')
    prepared.dest = operation.dest
  }
  if (type === 'patch') {
    if (typeof operation.find !== 'string' || operation.find === '') return fail('"find" is required for patch')
    if (operation.replace !== undefined && operation.replace !== null && typeof operation.replace !== 'string') return fail('"replace" must be a string')
  }
  if (type === 'write' || type === 'append' || type === 'prepend') {
    if (typeof operation.content !== 'string') return fail('"content" must be a string (use "" for an empty note)')
  }
  if (operation.frontmatter !== undefined && operation.frontmatter !== null) {
    if (typeof operation.frontmatter !== 'object' || Array.isArray(operation.frontmatter)) return fail('"frontmatter" must be a plain object')
  }
  if (operation.mode !== undefined && operation.mode !== null && !WRITE_MODES.includes(operation.mode)) {
    return fail(`unknown mode "${String(operation.mode)}"`)
  }
  if (operation.newline !== undefined && operation.newline !== null && !NEWLINE_MODES.includes(operation.newline)) {
    return fail(`unknown newline "${String(operation.newline)}"`)
  }
  return prepared
}

async function executeOperation(vault, item) {
  const operation = item.operation
  const index = item.index
  const path = item.path
  switch (item.type) {
    case 'write':
    case 'append':
    case 'prepend': {
      const mode = item.type === 'write' ? 'overwrite' : item.type
      const result = await vault.write(path, operation.content, {
        mode,
        frontmatter: operation.frontmatter,
        createDirs: operation.createDirs !== false,
        expectedVersion: typeof operation.expectedVersion === 'string' ? operation.expectedVersion : undefined,
        newline: operation.newline,
      })
      return { index, type: item.type, path: result.rel, ok: true, action: result.action, bytes: result.bytes, version: result.version }
    }
    case 'patch': {
      const result = await vault.write(path, '', {
        mode: 'patch',
        find: operation.find,
        replace: operation.replace,
        all: operation.all === true,
        regex: operation.regex === true,
        frontmatter: operation.frontmatter,
        expectedVersion: typeof operation.expectedVersion === 'string' ? operation.expectedVersion : undefined,
      })
      return {
        index,
        type: 'patch',
        path: result.rel,
        ok: true,
        action: result.action,
        bytes: result.bytes,
        version: result.version,
        ...(result.replacements !== undefined ? { replacements: result.replacements } : {}),
      }
    }
    case 'move': {
      const result = await vault.move(path, item.dest, { overwrite: operation.overwrite === true })
      return { index, type: 'move', path: result.from, to: result.to, ok: true }
    }
    case 'copy': {
      const result = await vault.copy(path, item.dest, { overwrite: operation.overwrite === true })
      return { index, type: 'copy', path: result.from, to: result.to, ok: true }
    }
    case 'delete':
    case 'trash': {
      const result = await vault.remove(path, {
        toTrash: item.type === 'trash' ? true : operation.toTrash !== false,
        recursive: operation.recursive === true,
      })
      return { index, type: item.type, path: result.rel, ok: true, action: result.action }
    }
    case 'mkdir': {
      const result = await vault.mkdir(path)
      return { index, type: 'mkdir', path: result.rel, ok: true, action: result.action }
    }
    default:
      return { index, type: item.type, path, ok: false, error: `unsupported operation type "${item.type}"` }
  }
}

// #endregion
// #region obsidian_fs

function fsTool(rt) {
  return {
    name: 'obsidian_fs',
    description:
      'Vault file-system operations. `action`: list (folder entries, optional recursive/depth/glob), tree (nested outline), ' +
      'stat (does a path exist), move, copy, delete (to .trash by default), mkdir. Paths are always vault-relative and ' +
      'cannot escape the vault. Use obsidian_read for note content and obsidian_search to find notes by content.',
    parameters: {
      action: { type: 'string', enum: FS_ACTIONS, required: true, description: 'list | tree | stat | move | copy | delete | mkdir.' },
      path: { type: 'string', description: 'Target vault-relative path. For list/tree an empty string means the vault root.' },
      dest: { type: 'string', description: 'Destination path for move/copy.' },
      recursive: { type: 'boolean', description: 'list: recurse into subfolders. delete: allow removing a non-empty folder.' },
      depth: { type: 'integer', description: 'list/tree: how many folder levels to walk (default 2 for tree, 1 for list).' },
      glob: { type: 'string', description: 'list only: filter entries with a glob such as "**/*.md".' },
      limit: { type: 'integer', description: 'Maximum entries/nodes returned (default 500, max 5000).' },
      includeFiles: { type: 'boolean', description: 'tree: include files (default true).' },
      toTrash: { type: 'boolean', description: 'delete: move to .trash instead of deleting (default true).' },
      overwrite: { type: 'boolean', description: 'move/copy: replace an existing destination (default false).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          path: { type: 'string', required: true },
          exists: { type: 'boolean' },
          entry: { type: 'object' },
          total: { type: 'integer' },
          truncated: { type: 'boolean' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                rel: { type: 'string', required: true },
                type: { type: 'string', required: true },
                size: { type: 'integer', required: true },
                mtimeMs: { type: 'number', required: true },
              },
            },
          },
          tree: { type: 'object' },
          from: { type: 'string' },
          to: { type: 'string' },
          result: { type: 'string' },
        },
      },
      render(_args, value) {
        switch (value.action) {
          case 'list': {
            const lines = [`${value.path === '' ? '(vault root)' : value.path}: ${value.entries.length} entr${value.entries.length === 1 ? 'y' : 'ies'}${value.truncated ? ' (truncated)' : ''}`]
            for (const entry of value.entries) {
              lines.push(`  ${entry.type === 'dir' ? '📁' : '📄'} ${entry.rel}${entry.type === 'file' ? ` (${formatBytes(entry.size)})` : ''}`)
            }
            return [{ type: 'text', text: clip(lines.join('\n'), MAX_RENDER_CHARS) }]
          }
          case 'tree': {
            const lines = []
            const walk = (node, depth) => {
              if (depth > 0) lines.push(`${'  '.repeat(depth - 1)}${node.type === 'dir' ? '📁' : '📄'} ${node.name}${node.type === 'file' ? ` (${formatBytes(node.size)})` : ''}`)
              for (const child of node.children ?? []) walk(child, depth + 1)
            }
            walk(value.tree, 0)
            return [{ type: 'text', text: clip(lines.join('\n'), MAX_RENDER_CHARS) }]
          }
          case 'stat':
            return [{ type: 'text', text: value.entry ? `${value.entry.rel} — ${value.entry.type}, ${formatBytes(value.entry.size)}` : `${value.path}: not found` }]
          case 'move':
            return [{ type: 'text', text: `moved ${value.from} → ${value.to}` }]
          case 'copy':
            return [{ type: 'text', text: `copied ${value.from} → ${value.to}` }]
          case 'delete':
            return [{ type: 'text', text: `${value.result} ${value.path}` }]
          case 'mkdir':
            return [{ type: 'text', text: `${value.result === 'created' ? 'created' : 'already exists:'} ${value.path === '' ? '(vault root)' : value.path}` }]
          default:
            return [{ type: 'text', text: JSON.stringify(value) }]
        }
      },
    },
    presentCall(args) {
      return { card: 'generic', title: `${args.action} ${args.path ?? ''}`.trim(), kind: 'execute' }
    },
    async execute(args) {
      const vault = await openVault(rt)
      const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : ''
      if (!FS_ACTIONS.includes(action)) {
        throw new Error(`action must be one of ${FS_ACTIONS.join(', ')} (received ${JSON.stringify(args.action)})`)
      }
      const path = typeof args.path === 'string' ? args.path : ''
      switch (action) {
        case 'list': {
          const limit = clamp(toInt(args.limit, 500), 1, 5000)
          const entries = await vault.list(path, {
            recursive: args.recursive === true,
            depth: args.depth,
            glob: args.glob,
            limit,
          })
          return { action, path: vault.norm(path), total: entries.length, entries, truncated: entries.length >= limit }
        }
        case 'tree': {
          const tree = await vault.tree(path, {
            depth: args.depth,
            includeFiles: args.includeFiles !== false,
            limit: clamp(toInt(args.limit, 500), 1, 5000),
          })
          return { action, path: vault.norm(path), tree, total: countTreeNodes(tree), truncated: tree.truncated === true }
        }
        case 'stat': {
          if (path === '') throw new Error('stat requires `path`')
          const entry = await vault.stat(path)
          return { action, path: vault.norm(path), exists: entry !== null, ...(entry ? { entry } : {}) }
        }
        case 'move': {
          const dest = requireString(args.dest, 'dest (required for move)')
          const result = await vault.move(path, dest, { overwrite: args.overwrite === true })
          return { action, path: result.from, from: result.from, to: result.to }
        }
        case 'copy': {
          const dest = requireString(args.dest, 'dest (required for copy)')
          const result = await vault.copy(path, dest, { overwrite: args.overwrite === true })
          return { action, path: result.from, from: result.from, to: result.to }
        }
        case 'delete': {
          if (path === '') throw new Error('delete requires `path`')
          const result = await vault.remove(path, { toTrash: args.toTrash !== false, recursive: args.recursive === true })
          return { action, path: result.rel, result: result.action }
        }
        case 'mkdir': {
          const result = await vault.mkdir(path)
          return { action, path: result.rel, result: result.action }
        }
        default:
          throw new Error(`unsupported action "${action}"`)
      }
    },
  }
}

// #endregion
// #region shared helpers

async function openVault(rt) {
  try {
    return await rt.vault()
  } catch (error) {
    throw new Error(
      `Obsidian vault unavailable: ${messageOf(error)}. ` +
        'Set `vaultPath` in cordis.patch.yml (or leave autoDetect on and open Obsidian once so its vault registry exists).',
    )
  }
}

async function resolveTarget(vault, args) {
  const path = typeof args.path === 'string' && args.path.trim() !== '' ? args.path : undefined
  const note = typeof args.note === 'string' && args.note.trim() !== '' ? args.note : undefined
  if (path === undefined && note === undefined) {
    throw new Error('pass `path` (vault-relative, e.g. "notes/a.md") or `note` (e.g. "Welcome" or "[[Welcome]]")')
  }
  const resolved = path !== undefined ? await vault.resolve({ path }) : await vault.resolve({ note })
  return resolved.rel
}

/** Resolve a batch entry: literal path first, then Obsidian-style note lookup. */
async function resolveLoose(vault, value) {
  const trimmed = String(value).trim()
  if (trimmed === '') throw new Error('empty path')
  let normalized = ''
  try {
    normalized = vault.norm(trimmed)
  } catch {
    normalized = ''
  }
  if (normalized !== '') {
    const stat = await vault.stat(normalized).catch(() => null)
    if (stat && stat.type === 'file') return normalized
    if (!/\.md$/i.test(normalized)) {
      const withExtension = await vault.stat(`${normalized}.md`).catch(() => null)
      if (withExtension && withExtension.type === 'file') return `${normalized}.md`
    }
  }
  const resolved = await vault.resolve({ note: trimmed })
  return resolved.rel
}

async function selectNotes(vault, args, limit) {
  const explicit = Array.isArray(args.paths)
    ? args.paths.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    : []
  if (explicit.length > 0) return { label: `paths[${explicit.length}]`, files: explicit }
  if (typeof args.glob === 'string' && args.glob.trim() !== '') {
    const entries = await vault.list('', { recursive: true, glob: args.glob, limit: Math.max(limit * 10, 200) })
    const files = entries.filter((entry) => entry.type === 'file').map((entry) => entry.rel)
    if (files.length === 0) throw new Error(`glob "${args.glob}" matched no notes`)
    return { label: `glob ${args.glob}`, files }
  }
  if (typeof args.query === 'string' && args.query.trim() !== '') {
    const needle = args.query.trim().toLowerCase()
    const entries = await vault.list('', { recursive: true, limit: 2000 })
    const files = entries.filter((entry) => entry.type === 'file' && entry.rel.toLowerCase().includes(needle)).map((entry) => entry.rel)
    if (files.length === 0) throw new Error(`query "${args.query}" matched no note paths`)
    return { label: `query ${args.query}`, files }
  }
  throw new Error('pass `paths`, or `glob` / `query` to select the notes to read')
}

async function collectBacklinks(rt, rel, warnings) {
  try {
    const index = await rt.index()
    const links = typeof index.backlinksOf === 'function' ? index.backlinksOf(rel) : []
    if (!Array.isArray(links)) return []
    return links
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => ({ from: String(entry.from ?? ''), ...(entry.raw !== undefined ? { raw: String(entry.raw) } : {}) }))
      .filter((entry) => entry.from !== '')
  } catch (error) {
    warnings.push(`backlinks unavailable: ${messageOf(error)}`)
    return null
  }
}

function parseInclude(args) {
  const flags = new Set()
  const raw = args.include
  if (Array.isArray(raw)) {
    for (const entry of raw) if (typeof entry === 'string') flags.add(entry.trim().toLowerCase())
  } else if (typeof raw === 'string') {
    for (const entry of raw.split(',')) flags.add(entry.trim().toLowerCase())
  }
  for (const flag of flags) {
    if (!INCLUDE_FLAGS.includes(flag)) {
      throw new Error(`unknown include flag "${flag}"; use ${INCLUDE_FLAGS.join(', ')}`)
    }
  }
  return flags
}

function countTreeNodes(node) {
  if (!node || typeof node !== 'object') return 0
  let count = 1
  for (const child of node.children ?? []) count += countTreeNodes(child)
  return count
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`)
  return value
}

function normalizeEnum(value, allowed, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback
  const normalized = String(value).trim().toLowerCase()
  if (!allowed.includes(normalized)) throw new Error(`${label} must be one of ${allowed.join(', ')} (received ${JSON.stringify(value)})`)
  return normalized
}

function linkLabel(link) {
  const target = link.heading ? `${link.target}#${link.heading}` : link.target
  return link.embed ? `!${target}` : target
}

function renderFrontmatter(value) {
  if (!value || typeof value !== 'object') return '(none)'
  const entries = Object.entries(value).filter(([key]) => !key.startsWith('__'))
  if (entries.length === 0) return '(none)'
  return entries
    .map(([key, entry]) => `${key}: ${typeof entry === 'string' ? entry : JSON.stringify(entry)}`)
    .join('\n')
}

function formatBytes(bytes) {
  const size = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function clip(text, max = MAX_RENDER_CHARS) {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…(output truncated at ${max} characters)`
}

function messageOf(error) {
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

function toInt(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

// #endregion
