/**
 * `obsidian_search` — the model-facing query tool.
 *
 * Registration goes through `./tool-schema.js` (the shared normalizer), because
 * `ctx.tools.register()` consumes a ToolDefinition verbatim and rejects the
 * inline `required: true` authoring marker in `output.schema`.
 *
 * @module dsh-obsidian-hub/tools-search
 */
import { search } from './search.js'
import { registerTools } from './tool-schema.js'

/** Every mode the tool accepts; `stats` inspects the index instead of searching. */
const MODES = [
  'text',
  'regex',
  'phrase',
  'tag',
  'property',
  'link',
  'files',
  'recent',
  'headings',
  'tasks',
  'stats',
]

const DESCRIPTION =
  'Fast, cheap query over the Obsidian vault index. Prefer it over reading notes one by one when deciding what to open. ' +
  'Modes: text = full-text BM25 (mixed Chinese + English, Chinese bigrams, all query terms must match); ' +
  'regex = JavaScript regex over note bodies; phrase = exact substring; tag = hashtag (supports `parent/*` prefix); ' +
  'property = frontmatter key/value; link = backlinks pointing at a note (or unresolved links to a name); ' +
  'files = match note paths/titles; recent = newest notes first; headings = matching headings with line numbers; ' +
  'tasks = checkbox tasks (query "open" | "done" | "all" or filter task text); stats = index size/freshness only. ' +
  'Returns ranked paths, titles, scores and matching-line snippets.'

const searchToolDefinition = {
  name: 'obsidian_search',
  description: DESCRIPTION,
  parameters: {
    mode: {
      type: 'string',
      required: true,
      enum: MODES,
      description:
        'Query mode. Use "text" for normal searching, "stats" to inspect the index, or one of the specialized modes.',
    },
    query: {
      type: 'string',
      description:
        'Search terms (text/phrase), regex source is allowed via `regex`, tag name, property value, note name, heading or task text, or a path fragment for files.',
    },
    regex: {
      type: 'string',
      description: 'JavaScript regular expression, used when mode="regex". Invalid regexes fail the call with a clear error.',
    },
    tag: {
      type: 'string',
      description: 'Tag for mode="tag", with or without a leading "#"; `project/*` matches descendants. Defaults to `query`.',
    },
    propertyKey: {
      type: 'string',
      description: 'Frontmatter property name for mode="property", e.g. "status". Case-insensitive.',
    },
    propertyValue: {
      type: 'string',
      description: 'Frontmatter value for mode="property" (exact, case-insensitive; `*` wildcards allowed). Omit to list notes that define the key.',
    },
    note: {
      type: 'string',
      description: 'Target note name/path for mode="link" (backlinks); falls back to `query`.',
    },
    path: {
      type: 'string',
      description: 'Restrict to a vault folder, e.g. "notes" or "notes/daily".',
    },
    glob: {
      type: 'string',
      description: 'Restrict to paths matching a glob, e.g. "notes/**/*.md" or "daily/*.md".',
    },
    modifiedAfter: {
      type: 'string',
      description: 'Only notes modified after this ISO date/time (e.g. "2026-01-01") or epoch milliseconds.',
    },
    limit: {
      type: 'integer',
      description: 'Maximum results to return (default 20, max 200).',
    },
    offset: {
      type: 'integer',
      description: 'Result offset for paging (default 0).',
    },
    contextLines: {
      type: 'integer',
      description: 'Snippet context lines around each matching line (default 1, max 5; 0 = matching line only).',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', required: true },
        total: { type: 'integer', required: true },
        tookMs: { type: 'number', required: true },
        truncated: { type: 'boolean', required: true },
        results: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              rel: { type: 'string', required: true },
              title: { type: 'string', required: true },
              score: { type: 'number' },
              snippet: { type: 'string' },
              line: { type: 'integer' },
              matches: { type: 'integer' },
              checked: { type: 'boolean' },
              level: { type: 'integer' },
              heading: { type: 'string' },
            },
          },
        },
        stats: { type: 'object', additionalProperties: true },
      },
    },
    render: renderSearch,
  },
  async execute(args = {}) {
    const requested = typeof args.mode === 'string' ? args.mode : 'text'
    const mode = requested === 'stats' ? 'stats' : MODES.includes(requested) ? requested : 'text'
    const index = await this.rt.index()

    if (mode === 'stats') {
      const stats = index.stats
      return {
        mode: 'stats',
        total: 0,
        tookMs: 0,
        truncated: !!stats.truncated,
        results: [],
        stats,
      }
    }

    const found = search(index, {
      mode,
      query: args.query,
      regex: args.regex,
      tag: args.tag,
      property:
        args.propertyKey !== undefined || args.propertyValue !== undefined
          ? { key: args.propertyKey, value: args.propertyValue }
          : undefined,
      note: args.note,
      path: args.path,
      glob: args.glob,
      modifiedAfter: args.modifiedAfter,
      contextLines: args.contextLines,
      limit: args.limit,
      offset: args.offset,
    })

    return {
      mode: found.mode,
      total: found.total,
      tookMs: found.tookMs,
      truncated: !!found.truncated,
      results: found.results.map(cleanResult),
    }
  },
  presentCall(args) {
    const query = args && typeof args.query === 'string' && args.query.trim() ? args.query.trim() : args && args.mode
    return {
      card: 'generic',
      title: query ? `Search vault: ${query}` : 'Search Obsidian vault',
      kind: 'search',
      rawInput: args,
    }
  },
}

/** `execute` needs the runtime; bind it once instead of storing state per call. */
function withRuntime(definition, rt) {
  return {
    ...definition,
    execute(args) {
      return definition.execute.call({ rt }, args)
    },
  }
}

/** Strip anything the output schema does not declare (and JSON-invalid values). */
function cleanResult(item) {
  const out = {}
  if (typeof item.rel === 'string') out.rel = item.rel
  if (typeof item.title === 'string') out.title = item.title
  if (typeof item.score === 'number' && Number.isFinite(item.score)) {
    const rounded = Math.round(item.score * 100) / 100
    out.score = rounded === 0 ? 0 : rounded
  }
  if (typeof item.snippet === 'string') out.snippet = item.snippet
  if (Number.isInteger(item.line)) out.line = item.line
  if (Number.isInteger(item.matches)) out.matches = item.matches
  if (typeof item.checked === 'boolean') out.checked = item.checked
  if (Number.isInteger(item.level)) out.level = item.level
  if (typeof item.heading === 'string') out.heading = item.heading
  if (typeof out.rel !== 'string') out.rel = ''
  if (typeof out.title !== 'string') out.title = out.rel
  return out
}

/** Keep the rendered block under the documented ~8000 char budget. */
const RENDER_CHAR_CAP = 8_000

function renderSearch(_args, value) {
  if (!value || typeof value !== 'object') return [{ type: 'text', text: 'obsidian_search: no result' }]

  if (value.mode === 'stats') {
    const stats = value.stats || {}
    const lines = [
      `Obsidian index: ${stats.notes ?? 0} notes · ${stats.folders ?? 0} folders · ${stats.tags ?? 0} tags · ${stats.links ?? 0} links`,
      `ready=${stats.ready === true} · built=${formatBuiltAt(stats.builtAt)} · took ${formatMs(stats.tookMs)} · ${formatBytes(stats.bytes)}`,
    ]
    if (stats.truncated) lines.push('⚠ index truncated: maxFiles/maxTotalBytes limit reached, some notes are not searchable')
    if (Number(stats.capped) > 0) {
      lines.push(`⚠ ${stats.capped} oversized note(s) indexed partially (only the first bytes are searchable)`)
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }

  const mode = String(value.mode || 'text')
  const total = Number(value.total) || 0
  const shown = Array.isArray(value.results) ? value.results : []
  if (total === 0 || shown.length === 0) {
    const hint =
      mode === 'regex'
        ? ' (check the regex)'
        : mode === 'tag'
          ? ' (tags are case-insensitive; try mode="text" for full-text)'
          : mode === 'property'
            ? ' (check the property key spelling)'
            : ''
    return [{ type: 'text', text: `obsidian_search(${mode}): no matches${hint}.` }]
  }

  const lines = []
  const headerParts = [`obsidian_search(${mode}): ${total} match${total === 1 ? '' : 'es'}`]
  if (shown.length < total) headerParts.push(`showing ${shown.length}`)
  headerParts.push(`in ${formatMs(value.tookMs)}`)
  lines.push(headerParts.join(' · '))
  if (value.truncated) lines.push('… more results exist; raise `limit` or page with `offset`.')

  let chars = lines.join('\n').length
  let cut = false
  for (let i = 0; i < shown.length; i += 1) {
    const item = shown[i]
    const score = typeof item.score === 'number' ? ` (${item.score.toFixed(2)})` : ''
    const line = Number.isInteger(item.line) ? `:${item.line}` : ''
    const row = `${i + 1}. ${item.rel}${line} — ${item.title}${score}`
    const snippetLines =
      typeof item.snippet === 'string' && item.snippet.length > 0
        ? item.snippet.split('\n').map((part) => `   > ${part}`)
        : []
    const block = [row, ...snippetLines]
    const blockSize = block.join('\n').length + 1
    if (chars + blockSize > RENDER_CHAR_CAP) {
      cut = true
      break
    }
    lines.push(...block)
    chars += blockSize
  }
  if (cut) lines.push(`… rendered output capped at ${RENDER_CHAR_CAP} chars; use a smaller \`limit\`.`)
  return [{ type: 'text', text: lines.join('\n') }]
}

function formatMs(value) {
  const n = Number(value)
  return Number.isFinite(n) ? `${n} ms` : 'n/a'
}

function formatBytes(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 'n/a'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`
}

function formatBuiltAt(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 'never'
  const age = Math.max(0, Date.now() - n)
  if (age < 1000) return 'just now'
  if (age < 60_000) return `${Math.round(age / 1000)}s ago`
  if (age < 3_600_000) return `${Math.round(age / 60_000)}m ago`
  return `${Math.round(age / 3_600_000)}h ago`
}

/**
 * Register the single `obsidian_search` tool.
 * @param ctx Cordis context carrying `ctx.tools`
 * @param {{index: () => Promise<object>}} rt plugin runtime
 * @returns {() => void} disposer
 */
export function registerSearchTools(ctx, rt) {
  return registerTools(ctx, [withRuntime(searchToolDefinition, rt)])
}
