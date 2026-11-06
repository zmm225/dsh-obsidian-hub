/**
 * VaultIndex — the derived, incrementally refreshed search index over the
 * markdown notes of an Obsidian vault.
 *
 * The index is a *cache*, never a source of truth: every refresh re-stats the
 * vault and only re-reads files whose `(mtimeMs, size)` changed. Unchanged
 * notes keep their parsed record (body, frontmatter, tags, links, headings,
 * tasks), so `ensureFresh()` after a TTL costs one directory walk of `stat`s.
 *
 * Zero external dependencies: only `node:` builtins plus the sibling
 * `./frontmatter.js` parser contract.
 *
 * @module dsh-obsidian-hub/indexer
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  parseFrontmatter,
  parseLinks,
  parseTags,
  parseHeadings,
  parseTasks,
  extractTitle,
} from './frontmatter.js'

const DEFAULT_MAX_FILES = 20_000
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024
const DEFAULT_TTL_MS = 8_000

/** Per-note cap for the lowercased scoring copy (`lcText`), in characters. */
const SCORING_CHARS_CAP = 512 * 1024
/** Bytes sniffed for a NUL byte (binary file that happens to be named `.md`). */
const BINARY_SNIFF_BYTES = 8_192
/** Directories never descended into by the built-in fallback walk. */
const FALLBACK_SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules', '.sync'])

const EMPTY_TASKS = Object.freeze({ total: 0, open: 0, done: 0 })

/** Normalize a vault-relative path to forward slashes (no leading slash). */
export function normalizeRel(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
}

/** Run a parser defensively: malformed notes must never break indexing. */
function safe(parse, fallback) {
  try {
    const value = parse()
    return value === undefined || value === null ? fallback : value
  } catch {
    return fallback
  }
}

function basenameNoExt(rel) {
  const base = String(rel).split('/').pop() || ''
  return base.replace(/\.md$/i, '')
}

function addToSetMap(map, key, value) {
  let set = map.get(key)
  if (!set) {
    set = new Set()
    map.set(key, set)
  }
  set.add(value)
}

function addToMultiMap(map, key, value) {
  let list = map.get(key)
  if (!list) {
    list = []
    map.set(key, list)
  }
  list.push(value)
}

/** Stable text form of a frontmatter value, used as the property-index key. */
export function canonPropertyValue(value) {
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Flatten one frontmatter value to its searchable text forms. */
function propertyValues(value) {
  if (value === undefined) return []
  if (Array.isArray(value)) return value.flatMap((item) => propertyValues(item))
  if (value === null) return ['null']
  if (typeof value === 'object') return [canonPropertyValue(value)]
  const text = canonPropertyValue(value)
  return text === '' ? [] : [text]
}

/** Number of directories that contain at least one indexed note. */
function foldersOf(files) {
  const folders = new Set()
  for (const rel of files.keys()) {
    const index = rel.lastIndexOf('/')
    if (index > 0) folders.add(rel.slice(0, index))
  }
  return folders
}

/**
 * Read at most `maxBytes` from a file without pulling the whole thing into
 * memory when the note is oversized.
 * @returns {Promise<Buffer>}
 */
async function readCapped(abs, maxBytes) {
  const handle = await fs.open(abs, 'r')
  try {
    const stat = await handle.stat()
    const want = Math.max(0, Math.min(stat.size, maxBytes))
    const buffer = Buffer.allocUnsafe(want)
    let offset = 0
    while (offset < want) {
      const { bytesRead } = await handle.read(buffer, offset, want - offset, offset)
      if (bytesRead <= 0) break
      offset += bytesRead
    }
    return buffer.subarray(0, offset)
  } finally {
    await handle.close()
  }
}

function countNewlines(text) {
  let count = 0
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) count += 1
  return count
}

/**
 * A lazily built, incrementally refreshed index of one Obsidian vault.
 *
 * FileRecord (per indexed note):
 * `{ rel, mtimeMs, size, title, frontmatter, body, tags, links, headings,
 *    tasks: {total, open, done}, wordCount, lcText, bodyLineOffset, bytes }`
 * — `line` numbers reported by search are absolute file lines, so
 * `bodyLineOffset` (number of frontmatter lines) is stored alongside.
 */
export class VaultIndex {
  #vault
  #options
  #builtAt = 0
  #tookMs = 0
  #truncated = false
  #bytes = 0
  #reads = 0
  #capped = 0
  #linkCount = 0
  #folders = new Set()
  #tail = Promise.resolve()
  /** Lowercased rel → canonical rel. */
  #byRelLower = new Map()
  /** Lowercased basename (no .md) → [rel]. */
  #byName = new Map()
  /** Lowercased title → [rel]. */
  #byTitle = new Map()
  /** Lowercased frontmatter alias → [rel]. */
  #byAlias = new Map()
  /** Target rel → [{from, raw}]. */
  #backlinks = new Map()

  /**
   * @param {object} vault Vault from `./vault.js` (read-only use: walk, stat, paths).
   * @param {{maxFiles?: number, maxTotalBytes?: number, maxFileBytes?: number, ttlMs?: number, reader?: Function}} [options]
   */
  constructor(vault, options = {}) {
    this.#vault = vault
    const vaultMaxFileBytes = vault && Number.isFinite(vault.maxFileBytes) && vault.maxFileBytes > 0 ? vault.maxFileBytes : 0
    this.#options = {
      maxFiles: Number.isFinite(options.maxFiles) && options.maxFiles > 0 ? options.maxFiles : DEFAULT_MAX_FILES,
      maxTotalBytes:
        Number.isFinite(options.maxTotalBytes) && options.maxTotalBytes > 0
          ? options.maxTotalBytes
          : DEFAULT_MAX_TOTAL_BYTES,
      maxFileBytes:
        Number.isFinite(options.maxFileBytes) && options.maxFileBytes > 0
          ? options.maxFileBytes
          : vaultMaxFileBytes || DEFAULT_MAX_FILE_BYTES,
      ttlMs: Number.isFinite(options.ttlMs) && options.ttlMs >= 0 ? options.ttlMs : DEFAULT_TTL_MS,
      // Injectable reader for tests/diagnostics: async (abs, maxBytes) => Buffer.
      reader: typeof options.reader === 'function' ? options.reader : null,
      /** Bounded concurrency for content reads during a rebuild. */
      readConcurrency:
        Number.isFinite(options.readConcurrency) && options.readConcurrency > 0
          ? Math.min(64, Math.trunc(options.readConcurrency))
          : 16,
    }

    /** @type {Map<string, object>} rel → FileRecord */
    this.files = new Map()
    /** @type {Map<string, Set<string>>} lowercased tag → rels */
    this.tagIndex = new Map()
    /** @type {Map<string, Map<string, Set<string>>>} key → canon value → rels */
    this.propertyIndex = new Map()
    /** @type {Map<string, Array<{line:number,checked:boolean,text:string}>>} rel → task items */
    this.taskItems = new Map()
  }

  /** Public index statistics (see ARCHITECTURE.md). `reads` is additive diagnostics. */
  get stats() {
    return {
      ready: this.#builtAt > 0,
      notes: this.files.size,
      folders: this.#folders.size,
      tags: this.tagIndex.size,
      links: this.#linkCount,
      builtAt: this.#builtAt > 0 ? this.#builtAt : null,
      tookMs: this.#tookMs,
      bytes: this.#bytes,
      truncated: this.#truncated,
      // Additive diagnostics (not part of the ARCHITECTURE.md shape):
      // `reads` proves stat-only refreshes; `capped` counts oversized notes
      // whose body was indexed partially instead of being dropped.
      reads: this.#reads,
      capped: this.#capped,
    }
  }

  /** One indexed note, or undefined. */
  record(rel) {
    return this.files.get(normalizeRel(rel))
  }

  /**
   * Full rebuild from disk. `force` is accepted for API symmetry; a build is
   * always full.
   * @param {{force?: boolean}} [options]
   */
  async build(options = {}) {
    void options
    return this.#enqueue(async () => {
      this.#resetCaches()
      await this.#refresh()
      return {
        notes: this.files.size,
        folders: this.#folders.size,
        tags: this.tagIndex.size,
        links: this.#linkCount,
        builtAt: this.#builtAt,
        tookMs: this.#tookMs,
        truncated: this.#truncated,
      }
    })
  }

  /**
   * Cheap freshness check. Within `ttlMs` this returns immediately; otherwise
   * it re-walks the vault (stat only) and re-reads just the changed notes.
   * @param {{ttlMs?: number}} [options]
   */
  async ensureFresh(options = {}) {
    const ttlMs = options.ttlMs === undefined ? this.#options.ttlMs : options.ttlMs
    if (this.#builtAt > 0 && ttlMs > 0 && Date.now() - this.#builtAt < ttlMs) return
    return this.#enqueue(async () => {
      // A refresh may have completed while this call waited in the queue.
      if (this.#builtAt > 0 && ttlMs > 0 && Date.now() - this.#builtAt < ttlMs) return
      await this.#refresh()
    })
  }

  /**
   * Resolve a note name / path / wikilink target to a vault-relative path.
   * Resolution order: exact path, title, alias, basename, path suffix.
   * @returns {string | undefined}
   */
  resolveNote(nameOrPath) {
    const query = normalizeRel(String(nameOrPath ?? '').trim())
    if (!query) return undefined
    return this.#resolveNormalized(query)
  }

  /** Notes that link to `rel`, as `[{from, raw}]` sorted by source path. */
  backlinksOf(rel) {
    const key = this.resolveNote(rel) ?? normalizeRel(String(rel ?? ''))
    const list = this.#backlinks.get(key)
    if (!list) return []
    return list
      .map((entry) => ({ from: entry.from, raw: entry.raw }))
      .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
  }

  /** Most recently modified indexed notes, newest first. */
  recent(n = 10) {
    const limit = Math.max(0, Number.isFinite(Number(n)) ? Math.trunc(Number(n)) : 10)
    return Array.from(this.files.values())
      .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
      .slice(0, limit)
  }

  // ------------------------------------------------------------------ internals

  /** Serialize refreshes so concurrent tool calls never walk twice at once. */
  #enqueue(task) {
    const run = this.#tail.then(task)
    this.#tail = run.then(
      () => {},
      () => {},
    )
    return run
  }

  #resetCaches() {
    this.files.clear()
    this.taskItems.clear()
    this.tagIndex.clear()
    this.propertyIndex.clear()
    this.#byRelLower.clear()
    this.#byName.clear()
    this.#byTitle.clear()
    this.#byAlias.clear()
    this.#backlinks.clear()
    this.#linkCount = 0
    this.#bytes = 0
    this.#reads = 0
    this.#capped = 0
    this.#truncated = false
    this.#builtAt = 0
    this.#tookMs = 0
    this.#folders = new Set()
  }

  /** Walk markdown entries (`{rel, abs, size, mtimeMs}`), preferring the Vault's walker. */
  async *#entries() {
    const vault = this.#vault
    if (vault && typeof vault.walkMarkdown === 'function') {
      let yielded = false
      try {
        for await (const entry of vault.walkMarkdown({ includeExcluded: false })) {
          yielded = true
          const rel = normalizeRel(entry && entry.rel)
          if (!rel || !/\.md$/i.test(rel)) continue
          yield this.#entry(entry, rel)
        }
        return
      } catch (error) {
        // A walker that dies mid-way must surface; one that never worked falls
        // back to the built-in walk so search stays available.
        if (yielded) throw error
      }
    }
    yield* this.#entriesFallback()
  }

  #entry(entry, rel) {
    const size = Number(entry && entry.size)
    const mtimeMs = Number(entry && entry.mtimeMs)
    return {
      rel,
      abs:
        (entry && entry.abs) ||
        (this.#vault && typeof this.#vault.toAbs === 'function' ? this.#vault.toAbs(rel) : path.join(this.#vault.root, rel)),
      size: Number.isFinite(size) && size >= 0 ? size : 0,
      mtimeMs: Number.isFinite(mtimeMs) && mtimeMs >= 0 ? mtimeMs : 0,
    }
  }

  /** Built-in `readdir`+`stat` walk, used when the Vault does not provide one. */
  async *#entriesFallback() {
    const root = this.#vault && this.#vault.root
    if (!root) return
    const excluded = (rel) => {
      try {
        return this.#vault && typeof this.#vault.isExcluded === 'function' ? this.#vault.isExcluded(rel) : false
      } catch {
        return false
      }
    }
    const stack = ['']
    while (stack.length > 0) {
      const relDir = stack.pop()
      let entries
      try {
        entries = await fs.readdir(relDir ? path.join(root, relDir) : root, { withFileTypes: true })
      } catch {
        continue
      }
      for (const dirent of entries) {
        if (FALLBACK_SKIP_DIRS.has(dirent.name)) continue
        const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name
        if (excluded(rel)) continue
        if (dirent.isDirectory()) {
          stack.push(rel)
          continue
        }
        if (!dirent.isFile() || !/\.md$/i.test(dirent.name)) continue
        const abs = path.join(root, rel)
        const stat = await fs.stat(abs).catch(() => null)
        if (!stat) continue
        yield { rel, abs, size: stat.size, mtimeMs: stat.mtimeMs }
      }
    }
  }

  async #refresh() {
    const started = performance.now()
    const options = this.#options
    const files = this.files
    const seen = new Set()

    // Phase 1 — enumerate (stat only) and classify WITHOUT reading content.
    // Unchanged notes keep their parsed record; changed ones are re-read; new
    // ones are only read while the maxFiles budget allows.
    const toRefresh = []
    const toAdd = []
    let bytes = 0
    let projectedBytes = 0
    let truncated = false
    let capped = 0
    let changed = this.#builtAt === 0

    for await (const entry of this.#entries()) {
      if (seen.has(entry.rel)) continue
      seen.add(entry.rel)
      const existing = files.get(entry.rel)
      if (existing && existing.mtimeMs === entry.mtimeMs && existing.size === entry.size) {
        bytes += existing.bytes
        projectedBytes += entry.size
        if (existing.capped) capped += 1
        continue
      }
      if (projectedBytes + entry.size > options.maxTotalBytes) {
        truncated = true
        if (!existing) continue
      }
      projectedBytes += entry.size
      if (existing) toRefresh.push(entry)
      else toAdd.push(entry)
    }

    // Phase 2 — re-read notes that already have a slot (never capped by count).
    let parsedByRel = await this.#readMany(toRefresh)
    for (const entry of toRefresh) {
      const parsed = parsedByRel.get(entry.rel)
      if (!parsed) {
        files.delete(entry.rel)
        this.taskItems.delete(entry.rel)
        changed = true
        continue
      }
      parsed.record.capped = parsed.truncated
      if (parsed.truncated) capped += 1
      files.set(entry.rel, parsed.record)
      this.taskItems.set(entry.rel, parsed.tasks)
      bytes += parsed.record.bytes
      changed = true
    }

    // Phase 3 — add new notes up to maxFiles, reading a bounded window at a
    // time so a huge vault never floods the process with reads (and a binary
    // file that fails to parse does not silently consume a slot).
    const slack = Math.max(1, options.readConcurrency * 2)
    let capacity = Math.max(0, options.maxFiles - files.size)
    let cursor = 0
    while (cursor < toAdd.length && capacity > 0) {
      const window = toAdd.slice(cursor, cursor + capacity + slack)
      cursor += window.length
      parsedByRel = await this.#readMany(window)
      for (const entry of window) {
        if (files.size >= options.maxFiles) {
          truncated = true
          continue
        }
        const parsed = parsedByRel.get(entry.rel)
        if (!parsed) continue
        parsed.record.capped = parsed.truncated
        if (parsed.truncated) capped += 1
        files.set(entry.rel, parsed.record)
        this.taskItems.set(entry.rel, parsed.tasks)
        bytes += parsed.record.bytes
        changed = true
      }
      capacity = Math.max(0, options.maxFiles - files.size)
    }
    if (cursor < toAdd.length) truncated = true

    // Deleted notes disappear from the index on the next stat pass.
    for (const rel of files.keys()) {
      if (!seen.has(rel)) {
        files.delete(rel)
        this.taskItems.delete(rel)
        changed = true
      }
    }

    this.#folders = foldersOf(files)
    this.#bytes = bytes
    this.#truncated = truncated
    this.#capped = capped
    if (changed) this.#rebuildDerived()
    this.#tookMs = Math.round((performance.now() - started) * 100) / 100
    this.#builtAt = Date.now()
  }

  /** Read entries with bounded concurrency; parsing itself stays synchronous. */
  async #readMany(entries) {
    const parsed = new Map()
    const batchSize = Math.max(1, this.#options.readConcurrency)
    for (let index = 0; index < entries.length; index += batchSize) {
      const batch = entries.slice(index, index + batchSize)
      await Promise.all(
        batch.map(async (entry) => {
          parsed.set(entry.rel, await this.#readRecord(entry))
        }),
      )
    }
    return parsed
  }

  /**
   * Parse one file into a FileRecord.
   * @returns {Promise<{record: object, tasks: Array, truncated: boolean} | null>}
   *   `null` for an unreadable/binary file (skipped silently).
   */
  async #readRecord(entry) {
    const maxBytes = this.#options.maxFileBytes
    let buffer
    try {
      this.#reads += 1
      if (this.#options.reader) {
        buffer = await this.#options.reader(entry.abs, maxBytes)
      } else if (entry.size <= maxBytes) {
        // The walk already gave us the size: one read syscall, no extra stat.
        buffer = await fs.readFile(entry.abs)
      } else {
        buffer = await readCapped(entry.abs, maxBytes)
      }
      if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(String(buffer ?? ''))
    } catch {
      return null
    }
    if (buffer.length === 0 && entry.size > 0) return null

    const sniff = buffer.subarray(0, Math.min(buffer.length, BINARY_SNIFF_BYTES))
    if (sniff.includes(0)) return null // binary masquerading as markdown

    const truncated = entry.size > buffer.length
    let text = buffer.toString('utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    // Normalize line endings once so line numbers, snippets and parsers agree.
    text = text.replace(/\r\n?/g, '\n')

    const frontmatter = safe(
      () => {
        const parsed = parseFrontmatter(text)
        if (!parsed || typeof parsed !== 'object') return null
        return {
          data: parsed.data && typeof parsed.data === 'object' ? parsed.data : {},
          body: typeof parsed.body === 'string' ? parsed.body : text,
          bodyOffset: Number.isFinite(parsed.bodyOffset) ? parsed.bodyOffset : 0,
        }
      },
      null,
    )
    const data = frontmatter ? frontmatter.data : {}
    const body = frontmatter ? frontmatter.body : text
    const bodyOffset = frontmatter ? frontmatter.bodyOffset : 0
    const bodyLineOffset = bodyOffset > 0 ? countNewlines(text.slice(0, bodyOffset)) : 0

    const tags = safe(() => {
      const parsed = parseTags(body, data)
      if (!Array.isArray(parsed)) return []
      const unique = new Set()
      const out = []
      for (const tag of parsed) {
        const value = String(tag ?? '').trim()
        if (!value) continue
        const key = value.toLowerCase()
        if (unique.has(key)) continue
        unique.add(key)
        out.push(value)
      }
      return out
    }, [])

    const links = safe(() => {
      const parsed = parseLinks(body)
      if (!Array.isArray(parsed)) return []
      return parsed
        .filter((link) => link && link.target !== undefined && link.target !== null)
        .map((link) => ({
          type: link.type === 'md' ? 'md' : 'wiki',
          target: String(link.target),
          raw: typeof link.raw === 'string' ? link.raw : String(link.target),
          heading: typeof link.heading === 'string' ? link.heading : undefined,
        }))
    }, [])

    const headings = safe(() => {
      const parsed = parseHeadings(body)
      if (!Array.isArray(parsed)) return []
      return parsed
        .filter((heading) => heading && Number.isFinite(heading.line) && Number.isFinite(heading.level))
        .map((heading) => ({ level: heading.level, text: String(heading.text ?? ''), line: heading.line }))
    }, [])

    const taskList = safe(() => {
      const parsed = parseTasks(body)
      if (!Array.isArray(parsed)) return []
      return parsed
        .filter((task) => task && Number.isFinite(task.line))
        .map((task) => ({ line: task.line, checked: !!task.checked, text: String(task.text ?? '') }))
    }, [])

    let title = safe(() => extractTitle(entry.rel, data, body), '')
    if (typeof title !== 'string' || !title.trim()) title = basenameNoExt(entry.rel)
    title = title.replace(/\s+/g, ' ').trim()

    const scoringText = body.length > SCORING_CHARS_CAP ? body.slice(0, SCORING_CHARS_CAP) : body
    const lcText = scoringText.toLowerCase()
    const wordCount =
      (scoringText.match(/[A-Za-z0-9_'-]+/g) || []).length +
      (scoringText.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length

    let open = 0
    for (const task of taskList) if (!task.checked) open += 1

    const record = {
      rel: entry.rel,
      mtimeMs: entry.mtimeMs,
      size: entry.size,
      title,
      frontmatter: data,
      body,
      tags,
      links,
      headings,
      tasks: taskList.length ? { total: taskList.length, open, done: taskList.length - open } : { ...EMPTY_TASKS },
      wordCount,
      lcText,
      bodyLineOffset,
      bytes: buffer.length,
    }
    return { record, tasks: taskList, truncated }
  }

  /** Rebuild tag/property/name/alias/link-backlink indexes from `files`. */
  #rebuildDerived() {
    const tagIndex = new Map()
    const propertyIndex = new Map()
    const byRelLower = new Map()
    const byName = new Map()
    const byTitle = new Map()
    const byAlias = new Map()

    for (const record of this.files.values()) {
      const rel = record.rel
      byRelLower.set(rel.toLowerCase(), rel)
      addToMultiMap(byName, basenameNoExt(rel).toLowerCase(), rel)
      if (record.title) addToMultiMap(byTitle, record.title.toLowerCase(), rel)

      const aliases = record.frontmatter ? record.frontmatter.aliases : undefined
      if (Array.isArray(aliases)) {
        for (const alias of aliases) {
          const value = String(alias ?? '').trim()
          if (value) addToMultiMap(byAlias, value.toLowerCase(), rel)
        }
      } else if (typeof aliases === 'string' && aliases.trim()) {
        addToMultiMap(byAlias, aliases.trim().toLowerCase(), rel)
      }

      for (const tag of record.tags) addToSetMap(tagIndex, String(tag).toLowerCase(), rel)

      const data = record.frontmatter
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const [key, value] of Object.entries(data)) {
          if (!key || key === '__raw' || value === undefined) continue
          let valueMap = propertyIndex.get(key)
          if (!valueMap) {
            valueMap = new Map()
            propertyIndex.set(key, valueMap)
          }
          for (const text of propertyValues(value)) addToSetMap(valueMap, text, rel)
        }
      }
    }

    // Publish name maps before resolving links: resolveNote() reads them.
    this.#byRelLower = byRelLower
    this.#byName = byName
    this.#byTitle = byTitle
    this.#byAlias = byAlias

    let linkCount = 0
    const backlinks = new Map()
    for (const record of this.files.values()) {
      const resolved = []
      for (const link of record.links) {
        linkCount += 1
        const targetRel = this.#resolveNormalized(link.target)
        const entry = { ...link, rel: targetRel }
        if (entry.rel === undefined) delete entry.rel
        resolved.push(entry)
        if (targetRel) {
          let list = backlinks.get(targetRel)
          if (!list) {
            list = []
            backlinks.set(targetRel, list)
          }
          list.push({ from: record.rel, raw: link.raw })
        }
      }
      record.links = resolved
    }

    this.tagIndex = tagIndex
    this.propertyIndex = propertyIndex
    this.#backlinks = backlinks
    this.#linkCount = linkCount
  }

  #resolveNormalized(query) {
    let value = normalizeRel(String(query ?? '').trim())
    if (!value) return undefined
    // Strip a wikilink alias/heading tail that reached us raw.
    const pipe = value.indexOf('|')
    if (pipe >= 0) value = value.slice(0, pipe)
    const hash = value.indexOf('#')
    if (hash >= 0) value = value.slice(0, hash)
    value = value.trim()
    if (!value) return undefined

    if (this.files.has(value)) return value
    const lower = value.toLowerCase()
    const exact = this.#byRelLower.get(lower)
    if (exact) return exact

    if (!lower.endsWith('.md')) {
      const withExt = this.#byRelLower.get(`${lower}.md`)
      if (withExt) return withExt
    }

    const baseName = (lower.endsWith('.md') ? lower.slice(0, -3) : lower).split('/').pop() || ''
    const byName = baseName ? this.#byName.get(baseName) : undefined
    if (byName && byName.length > 0) return this.#pickBest(byName)

    const byTitle = this.#byTitle.get(lower)
    if (byTitle && byTitle.length > 0) return this.#pickBest(byTitle)

    const byAlias = this.#byAlias.get(lower)
    if (byAlias && byAlias.length > 0) return this.#pickBest(byAlias)

    // Path suffix without extension, e.g. "deep/dive" → notes/deep/dive.md.
    if (!lower.includes('/')) return undefined
    for (const [relLower, rel] of this.#byRelLower) {
      if (relLower === `${lower}.md` || relLower.endsWith(`/${lower}.md`)) return rel
    }
    return undefined
  }

  /** Prefer the shortest path (Obsidian's "closest to root wins"), then lexical order. */
  #pickBest(rels) {
    let best = rels[0]
    for (const rel of rels) {
      if (rel.length < best.length || (rel.length === best.length && rel < best)) best = rel
    }
    return best
  }
}
