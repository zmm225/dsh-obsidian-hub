/**
 * Vault data plane: every filesystem access for the plugin goes through here.
 *
 * Guarantees this module owns:
 *  - **Containment.** Every path is normalized by `norm()` and re-checked
 *    against the root in `toAbs()`, so `..`, absolute paths, Windows drive
 *    paths and reserved device names can never escape the vault.
 *  - **Atomicity.** Writes go to a temp file in the destination directory and
 *    are renamed into place; a failed write never leaves a half-written note.
 *  - **Optimistic concurrency.** `version` is the first 16 hex chars of
 *    `sha1(text)`; passing `expectedVersion` refuses to clobber a note that
 *    changed since it was read.
 *  - **Encoding.** UTF-8, BOM stripped on read and never written, CRLF read as
 *    lines while the folder's existing line ending is preserved on write.
 *  - **Trash.** Deletes move to `<root>/.trash/<relative path>` by default
 *    (configurable back to hard deletes through `trashMode`).
 *
 * Only Node builtins are imported; this bundle is installed as a linked
 * directory and cannot resolve the harness' own `node_modules`.
 *
 * @module lib/vault
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { mergeFrontmatter, parseFrontmatter, stringifyFrontmatter } from './frontmatter.js'

/** Error type for every expected vault failure. `code` is machine-readable. */
export class VaultError extends Error {
  /**
   * @param {string} message actionable, model-facing text
   * @param {string} [code] one of: invalid_path, path_escape, not_found,
   *   not_a_file, is_a_directory, exists, version_mismatch, too_large,
   *   invalid_mode, invalid_patch, invalid_regex, permission_denied, no_space,
   *   io_error, invalid_root
   */
  constructor(message, code = 'vault_error') {
    super(message)
    this.name = 'VaultError'
    this.code = code
  }
}

/** Always excluded from folder walks, whatever the configured exclude list. */
const BUILTIN_EXCLUDE = ['.trash/**']
const TRASH_DIR = '.trash'
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_REWRITE_BYTES = 8 * 1024 * 1024
/** How long the note-name/title cache stays warm; mutations invalidate it too. */
const NAME_INDEX_TTL_MS = 10_000
/** Upper bound on notes scanned when building the name/title cache. */
const NAME_INDEX_MAX_FILES = 5000
/** First bytes inspected when deciding whether a file is text or binary. */
const BINARY_SNIFF_BYTES = 4096
/** Replacement-character ratio above which a decoded file is treated as binary. */
const BINARY_REPLACEMENT_RATIO = 0.02
/** Windows transient filesystem errors (AV/indexer holds) worth retrying. */
const TRANSIENT_FS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * One serialized mutation queue per module. Two agent tools writing the same
 * note concurrently must not interleave read-modify-write; Obsidian's own
 * writer is handled separately by retries and the optimistic `version` guard.
 */
let mutationQueue = Promise.resolve()

/**
 * Run a mutation after every previously queued one has settled.
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function enqueueMutation(task) {
  const run = mutationQueue.then(() => task())
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isTransientFsError(error) {
  return !!error && typeof error === 'object' && TRANSIENT_FS_CODES.has(error.code)
}

/**
 * Retry a filesystem operation a few times on Windows transient errors
 * (antivirus scanners, Explorer previews, the Obsidian indexer holding a
 * handle). A real permission problem still surfaces after the attempts.
 * @template T
 * @param {() => Promise<T>} operation
 * @param {number} [attempts]
 * @returns {Promise<T>}
 */
async function withTransientRetry(operation, attempts = 5) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (!isTransientFsError(error) || attempt === attempts - 1) break
      await delay(10 + attempt * 5 + Math.floor(Math.random() * 10))
    }
  }
  throw lastError
}

/**
 * Create a Vault bound to one root directory.
 *
 * @param {{root: string, exclude?: string[], maxFileBytes?: number, trashMode?: 'trash'|'delete'}} options
 * @returns {Vault}
 */
export function createVault(options = {}) {
  return new Vault(options)
}

class Vault {
  constructor(options) {
    const root = options.root
    if (typeof root !== 'string' || root.trim() === '') {
      throw new VaultError('createVault requires the absolute path of the vault root', 'invalid_root')
    }
    if (!path.isAbsolute(root)) {
      throw new VaultError(`vault root must be an absolute path, got "${root}"`, 'invalid_root')
    }
    const absoluteRoot = path.resolve(root)
    const exclude = new Set(BUILTIN_EXCLUDE)
    if (Array.isArray(options.exclude)) for (const pattern of options.exclude) if (typeof pattern === 'string' && pattern.trim() !== '') exclude.add(pattern.trim())

    this.root = absoluteRoot
    this.exclude = [...exclude]
    this.maxFileBytes = toPositiveInt(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES)
    this.trashMode = options.trashMode === 'delete' ? 'delete' : 'trash'
    this._excludeMatchers = this.exclude.map((pattern) => compileGlob(pattern))
    /** @type {{at: number, entries: Array<{rel: string, relLower: string, abs: string, base: string}>} | null} */
    this._namePaths = null
    /** @type {{at: number, entries: Array<{rel: string, title: string, heading: string, aliases: string[]}>} | null} */
    this._titleIndex = null
  }

  // region paths

  /**
   * Normalize a vault-relative path to forward-slash form and reject anything
   * that could escape the root.
   * @param {string} rel
   * @returns {string} normalized empty string for the root
   */
  norm(rel) {
    if (rel === undefined || rel === null) return ''
    if (typeof rel !== 'string') throw new VaultError(`vault path must be a string, received ${typeof rel}`, 'invalid_path')
    let value = rel.trim()
    if (value === '' || value === '.') return ''
    if (value.includes('\u0000')) throw new VaultError('vault path must not contain NUL characters', 'invalid_path')
    value = value.replace(/\\/g, '/')
    if (value.startsWith('//') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
      throw new VaultError(`absolute paths are not allowed inside the vault: ${rel}`, 'path_escape')
    }
    const segments = []
    for (const rawSegment of value.split('/')) {
      const source = rawSegment.trim()
      if (source === '' || source === '.') continue
      if (source === '..') throw new VaultError(`path escapes the vault: ${rel}`, 'path_escape')
      if (source.includes(':') || source.includes('\u0000') || /[\u0000-\u001f]/.test(source)) {
        throw new VaultError(`invalid character in vault path segment "${source}"`, 'invalid_path')
      }
      if (WINDOWS_RESERVED.test(source)) {
        throw new VaultError(`"${source}" is a reserved Windows device name and cannot be used in a vault path`, 'invalid_path')
      }
      if (/[. ]$/.test(source)) {
        throw new VaultError(`path segment "${source}" ends with a dot or space, which Windows cannot store`, 'invalid_path')
      }
      segments.push(source)
    }
    return segments.join('/')
  }

  /**
   * Map a vault-relative path to an absolute path, verifying containment.
   * @param {string} rel
   * @returns {string}
   */
  toAbs(rel) {
    const normalized = this.norm(rel)
    const absolute = normalized === '' ? this.root : path.join(this.root, ...normalized.split('/'))
    const relative = path.relative(this.root, absolute)
    if (relative === '' ) return absolute
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new VaultError(`path escapes the vault: ${rel}`, 'path_escape')
    }
    return absolute
  }

  /**
   * Whether a vault-relative path matches the configured exclude globs.
   * @param {string} rel
   * @returns {boolean}
   */
  isExcluded(rel) {
    let normalized
    try {
      normalized = this.norm(rel)
    } catch {
      return false
    }
    if (normalized === '') return false
    const candidates = [normalized, `${normalized}/`]
    for (const matcher of this._excludeMatchers) {
      for (const candidate of candidates) if (matcher.test(candidate)) return true
    }
    return false
  }

  // endregion
  // region resolution

  /**
   * Resolve a read/write target.
   *
   * `{path}` is a literal vault-relative path (no existence check).
   * `{note}` resolves like Obsidian: exact path → path + `.md` → unique file
   * name (case-insensitive) → unique path suffix. Ambiguity throws with the
   * candidate list instead of guessing.
   *
   * @param {{path?: string, note?: string}} target
   * @returns {Promise<{rel: string, abs: string}>}
   */
  async resolve(target) {
    const spec = target && typeof target === 'object' ? target : {}
    if (typeof spec.path === 'string' && spec.path.trim() !== '') {
      const rel = this.norm(spec.path)
      return { rel, abs: this.toAbs(rel) }
    }
    if (typeof spec.note === 'string' && spec.note.trim() !== '') {
      const rel = await this._resolveNote(spec.note)
      return { rel, abs: this.toAbs(rel) }
    }
    throw new VaultError('pass either { path } or { note } to resolve a vault target', 'invalid_path')
  }

  async _resolveNote(query) {
    const raw = String(query).trim()
    if (raw === '') throw new VaultError('note name must not be empty', 'invalid_path')
    let cleaned = raw
    const wiki = /^!?\[\[([^\]]+)\]\]$/.exec(cleaned)
    if (wiki) cleaned = wiki[1]
    const pipe = cleaned.indexOf('|')
    if (pipe !== -1) cleaned = cleaned.slice(0, pipe)
    const hash = cleaned.indexOf('#')
    if (hash !== -1) cleaned = cleaned.slice(0, hash)
    cleaned = cleaned.replace(/\\/g, '/').replace(/^\.?\//, '').trim()
    if (cleaned === '') throw new VaultError(`cannot resolve a heading-only link "${raw}" to a note`, 'not_found')

    const normalized = (() => {
      try {
        return this.norm(cleaned)
      } catch {
        return ''
      }
    })()

    if (normalized !== '') {
      const exact = await this._fileEntry(normalized)
      if (exact) return exact.rel
      if (!/\.md$/i.test(normalized)) {
        const withExtension = await this._fileEntry(`${normalized}.md`)
        if (withExtension) return withExtension.rel
      } else {
        const withoutExtension = normalized.replace(/\.md$/i, '')
        const alternate = await this._fileEntry(`${withoutExtension}.md`)
        if (alternate) return alternate.rel
      }
    }

    const lowered = cleaned.toLowerCase().replace(/\.md$/, '')
    const paths = await this._namePathsFor()

    // 1. File name, case-insensitive: `[[Meeting]]` -> any Meeting.md.
    //    This tier needs only the directory listing, so the common case stays
    //    one readdir pass and never opens a file.
    const byBase = collectRels(paths.entries, (entry) => entry.base === lowered)
    if (byBase.length > 0) return byBase.length === 1 ? byBase[0] : this._throwAmbiguous(raw, byBase)

    // 2. Frontmatter `title` / first H1 (indexer.resolveNote does the same),
    //    then 3. frontmatter `aliases` / `alias`.
    const titles = await this._titleIndexFor(paths)
    const byTitle = collectRels(titles.entries, (entry) => entry.title === lowered || entry.heading === lowered)
    if (byTitle.length > 0) return byTitle.length === 1 ? byTitle[0] : this._throwAmbiguous(raw, byTitle)
    const byAlias = collectRels(titles.entries, (entry) => entry.aliases.includes(lowered))
    if (byAlias.length > 0) return byAlias.length === 1 ? byAlias[0] : this._throwAmbiguous(raw, byAlias)

    // 4. Path suffix: `sub/deep` -> notes/sub/deep.md.
    const bySuffix = collectRels(paths.entries, (entry) => entry.relLower.endsWith(`/${lowered}.md`))
    if (bySuffix.length > 0) return bySuffix.length === 1 ? bySuffix[0] : this._throwAmbiguous(raw, bySuffix)

    throw new VaultError(
      `note "${raw}" not found. Tried "${cleaned}", "${cleaned}.md", any file named "${cleaned}.md", ` +
        `any note whose frontmatter title or aliases is "${cleaned}", and any path ending with "/${cleaned}.md".`,
      'not_found',
    )
  }

  _throwAmbiguous(raw, candidates) {
    const shown = candidates.slice(0, 8).join(', ')
    const more = candidates.length > 8 ? `, …(${candidates.length - 8} more)` : ''
    throw new VaultError(
      `note "${raw}" is ambiguous: ${shown}${more}. Pass a vault-relative path instead.`,
      'not_found',
    )
  }

  /** Drop the cached note maps; called after every mutation. */
  _invalidateNameIndex() {
    this._namePaths = null
    this._titleIndex = null
  }

  /**
   * Lazily build (and briefly cache) the note path map used by
   * `resolve({note})`: relative path plus lowercased file name.
   *
   * Directory entries only — no file is opened — capped at
   * NAME_INDEX_MAX_FILES notes. Invalidated by every mutation and refreshed
   * after NAME_INDEX_TTL_MS so edits made in Obsidian are picked up.
   * @returns {Promise<{at: number, entries: Array<{rel: string, relLower: string, abs: string, base: string}>}>}
   */
  async _namePathsFor() {
    const now = Date.now()
    if (this._namePaths && now - this._namePaths.at < NAME_INDEX_TTL_MS) return this._namePaths
    const entries = []
    let scanned = 0
    for await (const file of this._walkMarkdownPaths()) {
      if (scanned >= NAME_INDEX_MAX_FILES) break
      scanned += 1
      const relLower = file.rel.toLowerCase()
      entries.push({
        rel: file.rel,
        relLower,
        abs: file.abs,
        base: relLower.slice(relLower.lastIndexOf('/') + 1).replace(/\.md$/, ''),
      })
    }
    this._namePaths = { at: Date.now(), entries }
    return this._namePaths
  }

  /**
   * Lazily collect frontmatter `title`/`aliases` and the first H1 for each note,
   * used only when file-name resolution missed. Reads a capped prefix (8 KB) of
   * at most NAME_INDEX_MAX_FILES notes and caches the map.
   * @param {{entries: Array<{rel: string, abs: string}>}} paths
   * @returns {Promise<{at: number, entries: Array<{rel: string, title: string, heading: string, aliases: string[]}>}>}
   */
  async _titleIndexFor(paths) {
    const now = Date.now()
    if (this._titleIndex && now - this._titleIndex.at < NAME_INDEX_TTL_MS) return this._titleIndex
    /** @type {Array<{rel: string, title: string, heading: string, aliases: string[]}>} */
    const entries = []
    for (const pathEntry of paths.entries) {
      const entry = { rel: pathEntry.rel, title: '', heading: '', aliases: [] }
      entries.push(entry)
      let prefix = ''
      try {
        const handle = await fs.open(pathEntry.abs, 'r')
        try {
          const buffer = Buffer.alloc(8192)
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
          prefix = buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '')
        } finally {
          await handle.close().catch(() => {})
        }
      } catch {
        continue
      }
      if (prefix.includes('\u0000')) continue
      let body = prefix
      try {
        const parsed = parseFrontmatter(prefix)
        if (parsed.has && !parsed.error) {
          body = parsed.body
          const data = parsed.data
          if (typeof data.title === 'string' && data.title.trim() !== '') entry.title = data.title.trim().toLowerCase()
          for (const field of ['aliases', 'alias']) {
            const value = data[field]
            if (Array.isArray(value)) {
              entry.aliases.push(
                ...value
                  .filter((item) => typeof item === 'string')
                  .map((item) => item.trim().toLowerCase())
                  .filter(Boolean),
              )
            } else if (typeof value === 'string' && value.trim() !== '') {
              entry.aliases.push(value.trim().toLowerCase())
            }
          }
        }
      } catch {
        /* unparseable frontmatter: the file name still resolves */
      }
      const heading = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(body)
      if (heading) entry.heading = heading[1].trim().toLowerCase()
    }
    this._titleIndex = { at: Date.now(), entries }
    return this._titleIndex
  }

  /** Canonical (on-disk) casing of a path, so Windows' case-insensitivity does not leak. */
  async _canonicalRel(rel) {
    const parts = rel.split('/')
    let current = ''
    let absolute = this.root
    for (const part of parts) {
      let entries
      try {
        entries = await fs.readdir(absolute)
      } catch {
        return rel
      }
      const found = entries.find((name) => name.toLowerCase() === part.toLowerCase())
      if (found === undefined) return rel
      current = current === '' ? found : `${current}/${found}`
      absolute = path.join(absolute, found)
    }
    return current
  }

  async _fileEntry(rel) {
    const info = await this._statAbs(this.toAbs(rel))
    if (!info || info.type !== 'file') return null
    return { rel: await this._canonicalRel(rel), info }
  }

  // endregion
  // region metadata

  /**
   * @param {string} rel
   * @returns {Promise<{rel: string, type: 'file'|'dir', size: number, mtimeMs: number, ctimeMs: number}|null>}
   */
  async stat(rel) {
    const target = this.norm(rel)
    const info = await this._statAbs(this.toAbs(target))
    if (!info) return null
    return { rel: target, type: info.type, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }
  }

  async _statAbs(absolute) {
    try {
      const info = await fs.stat(absolute)
      if (info.isDirectory()) return { type: 'dir', size: 0, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }
      if (info.isFile()) return { type: 'file', size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }
      return null
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null
      throw toVaultError(error, absolute)
    }
  }

  // endregion
  // region listing

  /**
   * List entries under a folder.
   * @param {string} [rel]
   * @param {{recursive?: boolean, depth?: number, glob?: string, limit?: number}} [options]
   * @returns {Promise<Array<{rel: string, type: 'file'|'dir', size: number, mtimeMs: number}>>}
   */
  async list(rel = '', options = {}) {
    const base = this.norm(rel)
    const absolute = this.toAbs(base)
    const info = await this._statAbs(absolute)
    if (!info) throw new VaultError(`folder not found: ${base === '' ? '(vault root)' : base}`, 'not_found')
    if (info.type !== 'dir') throw new VaultError(`"${base}" is a file, not a folder`, 'is_a_directory')

    const recursive = options.recursive === true
    const maxDepth = toPositiveInt(options.depth, recursive ? 32 : 1)
    const limit = toPositiveInt(options.limit, recursive ? 1000 : 500)
    const matcher = typeof options.glob === 'string' && options.glob.trim() !== '' ? compileGlob(options.glob) : null

    const entries = []
    for await (const entry of this._walkDir(base, maxDepth, recursive)) {
      if (matcher && !matchGlob(matcher, entry.rel, base)) continue
      entries.push({ rel: entry.rel, type: entry.type, size: entry.size, mtimeMs: entry.mtimeMs })
      if (entries.length >= limit) break
    }
    entries.sort((a, b) => a.rel.localeCompare(b.rel))
    return entries
  }

  /**
   * Build a folder tree.
   * @param {string} [rel]
   * @param {{depth?: number, includeFiles?: boolean, limit?: number}} [options]
   */
  async tree(rel = '', options = {}) {
    const base = this.norm(rel)
    const absolute = this.toAbs(base)
    const info = await this._statAbs(absolute)
    if (!info) throw new VaultError(`folder not found: ${base === '' ? '(vault root)' : base}`, 'not_found')
    if (info.type !== 'dir') throw new VaultError(`"${base}" is a file, not a folder`, 'is_a_directory')

    const maxDepth = Math.min(12, Math.max(0, toInt(options.depth, 2)))
    const includeFiles = options.includeFiles !== false
    const limit = Math.min(5000, Math.max(1, toInt(options.limit, 500)))
    const state = { count: 0, truncated: false }

    const build = async (nodeRel, nodeAbs, depth) => {
      const node = { rel: nodeRel, name: nodeRel === '' ? path.basename(this.root) : nodeAbs.slice(nodeAbs.lastIndexOf(path.sep) + 1), type: 'dir' }
      if (depth >= maxDepth) return node
      let dirents
      try {
        dirents = await fs.readdir(nodeAbs, { withFileTypes: true })
      } catch {
        return node
      }
      dirents.sort((a, b) => a.name.localeCompare(b.name))
      const children = []
      for (const dirent of dirents) {
        if (state.count >= limit) {
          state.truncated = true
          break
        }
        const childRel = nodeRel === '' ? dirent.name : `${nodeRel}/${dirent.name}`
        if (this.isExcluded(childRel) || dirent.isSymbolicLink()) continue
        const childAbs = path.join(nodeAbs, dirent.name)
        let childInfo
        try {
          childInfo = await fs.stat(childAbs)
        } catch {
          continue
        }
        state.count += 1
        if (childInfo.isDirectory()) children.push(await build(childRel, childAbs, depth + 1))
        else if (childInfo.isFile() && includeFiles) {
          children.push({ rel: childRel, name: dirent.name, type: 'file', size: childInfo.size })
        }
      }
      if (children.length > 0) node.children = children
      return node
    }

    const root = await build(base, absolute, 0)
    if (state.truncated) {
      Object.defineProperty(root, 'truncated', { value: true, enumerable: false, configurable: true })
    }
    return root
  }

  async *_walkDir(baseRel, maxDepth, recursive) {
    const stack = [{ rel: baseRel, abs: this.toAbs(baseRel), depth: 0 }]
    while (stack.length > 0) {
      const current = stack.pop()
      let dirents
      try {
        dirents = await fs.readdir(current.abs, { withFileTypes: true })
      } catch {
        continue
      }
      dirents.sort((a, b) => a.name.localeCompare(b.name))
      const descend = []
      for (const dirent of dirents) {
        if (dirent.isSymbolicLink()) continue
        const childRel = current.rel === '' ? dirent.name : `${current.rel}/${dirent.name}`
        if (this.isExcluded(childRel)) continue
        const childAbs = path.join(current.abs, dirent.name)
        let info
        try {
          info = await fs.stat(childAbs)
        } catch {
          continue
        }
        if (info.isDirectory()) {
          yield { rel: childRel, type: 'dir', size: 0, mtimeMs: info.mtimeMs }
          if (recursive && current.depth + 1 < maxDepth) descend.push({ rel: childRel, abs: childAbs, depth: current.depth + 1 })
        } else if (info.isFile()) {
          yield { rel: childRel, type: 'file', size: info.size, mtimeMs: info.mtimeMs }
        }
      }
      for (let index = descend.length - 1; index >= 0; index -= 1) stack.push(descend[index])
    }
  }

  /**
   * Yield every Markdown file in the vault, alphabetically, skipping excluded
   * folders and symlinks.
   * @param {{includeExcluded?: boolean}} [options]
   * @returns {AsyncGenerator<{rel: string, abs: string, size: number, mtimeMs: number}>}
   */
  async *walkMarkdown(options = {}) {
    const includeExcluded = options.includeExcluded === true
    const stack = [{ rel: '', abs: this.root }]
    while (stack.length > 0) {
      const current = stack.pop()
      let dirents
      try {
        dirents = await fs.readdir(current.abs, { withFileTypes: true })
      } catch {
        continue
      }
      dirents.sort((a, b) => a.name.localeCompare(b.name))
      const descend = []
      for (const dirent of dirents) {
        if (dirent.isSymbolicLink()) continue
        const childRel = current.rel === '' ? dirent.name : `${current.rel}/${dirent.name}`
        if (!includeExcluded && this.isExcluded(childRel)) continue
        const childAbs = path.join(current.abs, dirent.name)
        if (dirent.isDirectory()) {
          descend.push({ rel: childRel, abs: childAbs })
          continue
        }
        if (!dirent.isFile() || !/\.md$/i.test(dirent.name)) continue
        let info
        try {
          info = await fs.stat(childAbs)
        } catch {
          continue
        }
        yield { rel: childRel, abs: childAbs, size: info.size, mtimeMs: info.mtimeMs }
      }
      for (let index = descend.length - 1; index >= 0; index -= 1) stack.push(descend[index])
    }
  }

  /**
   * Directory-entry-only walk over Markdown files (no `stat` per file), used by
   * note-name resolution where `size`/`mtimeMs` are irrelevant. Keeps resolving
   * `[[Some Note]]` in a large vault to one readdir pass per folder.
   * @returns {AsyncGenerator<{rel: string, abs: string}>}
   */
  async *_walkMarkdownPaths() {
    const stack = [{ rel: '', abs: this.root }]
    while (stack.length > 0) {
      const current = stack.pop()
      let dirents
      try {
        dirents = await fs.readdir(current.abs, { withFileTypes: true })
      } catch {
        continue
      }
      dirents.sort((a, b) => a.name.localeCompare(b.name))
      const descend = []
      for (const dirent of dirents) {
        if (dirent.isSymbolicLink()) continue
        const childRel = current.rel === '' ? dirent.name : `${current.rel}/${dirent.name}`
        if (this.isExcluded(childRel)) continue
        const childAbs = path.join(current.abs, dirent.name)
        if (dirent.isDirectory()) {
          descend.push({ rel: childRel, abs: childAbs })
          continue
        }
        if (dirent.isFile() && /\.md$/i.test(dirent.name)) yield { rel: childRel, abs: childAbs }
      }
      for (let index = descend.length - 1; index >= 0; index -= 1) stack.push(descend[index])
    }
  }

  // endregion
  // region reading

  /**
   * Read a note, optionally sliced by lines.
   *
   * `content` is normalized to `\n` line endings and has a UTF-8 BOM removed.
   * `version` always covers the whole file, not just the returned window, so
   * it can be handed back as `expectedVersion` on write.
   *
   * @param {string} rel
   * @param {{offset?: number, limit?: number}} [options] `offset` is 0-based;
   *   `limit: 0` or omitted means "to the end".
   * @returns {Promise<{rel: string, content: string, totalLines: number, truncated: boolean, size: number, mtimeMs: number, version: string}>}
   */
  async read(rel, options = {}) {
    const target = this.norm(rel)
    if (target === '') throw new VaultError('cannot read the vault root as a note', 'not_a_file')
    const absolute = this.toAbs(target)
    const info = await this._statAbs(absolute)
    if (!info) throw new VaultError(`note not found: ${target}`, 'not_found')
    if (info.type === 'dir') throw new VaultError(`"${target}" is a folder, not a note`, 'not_a_file')

    let byteTruncated = false
    let buffer
    if (info.size > this.maxFileBytes) {
      buffer = await readPrefix(absolute, this.maxFileBytes)
      byteTruncated = true
    } else {
      buffer = await fs.readFile(absolute)
    }
    let text = buffer.toString('utf8')
    if (text.startsWith('\uFEFF')) text = text.slice(1)
    if (byteTruncated) text = text.replace(/\uFFFD+$/, '')
    // A truncated window may legitimately end mid-codepoint, so only the NUL
    // sniff is reliable there; a full read must also pass the decoded ratio.
    if (byteTruncated) {
      if (buffer.subarray(0, Math.min(buffer.length, BINARY_SNIFF_BYTES)).includes(0)) throw binaryFileError(target, info.size)
    } else if (looksBinary(buffer, text)) {
      throw binaryFileError(target, info.size)
    }
    const version = hashText(text)

    const lines = text.split(/\r?\n/)
    const totalLines = text === '' ? 0 : lines.length
    const start = Math.min(Math.max(toInt(options.offset, 0), 0), totalLines)
    const requestedLimit = toInt(options.limit, 0)
    const end = requestedLimit > 0 ? Math.min(totalLines, start + requestedLimit) : totalLines
    const content = lines.slice(start, end).join('\n')
    const truncated = byteTruncated || start > 0 || end < totalLines

    return { rel: target, content, totalLines, truncated, size: info.size, mtimeMs: info.mtimeMs, version }
  }

  /**
   * Read a note's raw text (BOM removed, line endings untouched). Files larger
   * than the rewrite guard are truncated to it rather than loading a huge
   * buffer into memory.
   * @param {string} rel
   * @returns {Promise<string>}
   */
  async readRaw(rel) {
    const target = this.norm(rel)
    if (target === '') throw new VaultError('cannot read the vault root as a note', 'not_a_file')
    const absolute = this.toAbs(target)
    const info = await this._statAbs(absolute)
    if (!info) throw new VaultError(`note not found: ${target}`, 'not_found')
    if (info.type === 'dir') throw new VaultError(`"${target}" is a folder, not a note`, 'not_a_file')
    const guard = Math.max(this.maxFileBytes, MAX_REWRITE_BYTES)
    const buffer = info.size > guard ? await readPrefix(absolute, guard) : await fs.readFile(absolute)
    let text = buffer.toString('utf8')
    if (text.startsWith('\uFEFF')) text = text.slice(1)
    if (info.size > guard) text = text.replace(/\uFFFD+$/, '')
    if (looksBinary(buffer, text)) throw binaryFileError(target, info.size)
    return text
  }

  // endregion
  // region writing

  /**
   * Write a note.
   *
   * @param {string} rel vault-relative path
   * @param {string} content note text (`''` for an empty note)
   * @param {{
   *   mode?: 'overwrite'|'append'|'prepend'|'create'|'patch',
   *   frontmatter?: Record<string, unknown>,
   *   createDirs?: boolean,
   *   expectedVersion?: string,
   *   newline?: 'auto'|'lf'|'crlf',
   *   find?: string, replace?: string, all?: boolean, regex?: boolean,
   * }} [options]
   * @returns {Promise<{rel: string, action: string, bytes: number, mtimeMs: number, version: string, replacements?: number}>}
   */
  async write(rel, content, options = {}) {
    return enqueueMutation(() => this._write(rel, content, options))
  }

  async _write(rel, content, options) {
    const target = this.norm(rel)
    if (target === '') throw new VaultError('cannot write the vault root as a note', 'invalid_path')
    const mode = normalizeMode(options.mode)
    const absolute = this.toAbs(target)
    const existing = await this._readOptional(target)
    const expectedVersion = typeof options.expectedVersion === 'string' && options.expectedVersion !== '' ? options.expectedVersion : undefined

    if (mode === 'create' && existing) {
      throw new VaultError(`note already exists: ${target}. Use mode "overwrite" (or "append"/"prepend") to change it.`, 'exists')
    }
    if (mode === 'patch' && !existing) {
      throw new VaultError(`cannot patch a missing note: ${target}`, 'not_found')
    }
    if (expectedVersion !== undefined) {
      const actual = existing ? hashText(existing.text) : null
      if (actual !== expectedVersion) {
        throw new VaultError(
          `version mismatch for ${target}: expected ${expectedVersion}, actual ${actual === null ? '(note is missing)' : actual}. ` +
            'Re-read the note with obsidian_read and retry with its current version.',
          'version_mismatch',
        )
      }
    }

    const eol = resolveEol(options.newline, existing ? existing.text : '', content)
    const insertion = normalizeInput(String(content === null || content === undefined ? '' : content))
    let text
    let action
    let replacements

    switch (mode) {
      case 'overwrite':
      case 'create': {
        text = insertion
        action = existing ? 'overwritten' : 'created'
        break
      }
      case 'append': {
        const base = existing ? existing.text : ''
        text = appendText(base, insertion, eol)
        action = 'appended'
        break
      }
      case 'prepend': {
        const base = existing ? existing.text : ''
        text = prependText(base, insertion, eol)
        action = 'prepended'
        break
      }
      case 'patch': {
        const result = applyPatch(existing.text, options)
        text = result.text
        replacements = result.replacements
        action = 'patched'
        break
      }
      default:
        throw new VaultError(`unknown write mode "${String(options.mode)}"; use overwrite, append, prepend, create or patch`, 'invalid_mode')
    }

    if (options.frontmatter !== undefined && options.frontmatter !== null) {
      text = applyFrontmatterPatch(text, options.frontmatter)
    }
    text = applyNewlinePolicy(text, options.newline, eol)

    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > this.maxFileBytes) {
      throw new VaultError(
        `refusing to write ${bytes} bytes to ${target}: the vault read limit is ${this.maxFileBytes} bytes. ` +
          'Raise maxFileBytes in cordis.patch.yml for bigger notes.',
        'too_large',
      )
    }

    if (options.createDirs === false) {
      const parent = await this._statAbs(path.dirname(absolute))
      if (!parent || parent.type !== 'dir') throw new VaultError(`parent folder does not exist for ${target}`, 'not_found')
    } else {
      await fs.mkdir(path.dirname(absolute), { recursive: true })
    }

    await atomicWrite(absolute, text)
    this._invalidateNameIndex()
    const stat = await fs.stat(absolute)
    const result = { rel: target, action, bytes, mtimeMs: stat.mtimeMs, version: hashText(text) }
    if (replacements !== undefined) result.replacements = replacements
    return result
  }

  /**
   * Replace text in an existing note.
   *
   * @param {string} rel
   * @param {{find: string, replace?: string, all?: boolean, regex?: boolean}} options
   * @returns {Promise<{rel: string, replacements: number}>}
   */
  async patch(rel, options = {}) {
    return enqueueMutation(async () => {
      const target = this.norm(rel)
      const existing = await this._readOptional(target)
      if (!existing) throw new VaultError(`note not found: ${target}`, 'not_found')
      const result = applyPatch(existing.text, options)
      await atomicWrite(existing.absolute, result.text)
      this._invalidateNameIndex()
      return { rel: target, replacements: result.replacements }
    })
  }

  async _readOptional(target) {
    if (target === '') return null
    const absolute = this.toAbs(target)
    const info = await this._statAbs(absolute)
    if (!info) return null
    if (info.type === 'dir') throw new VaultError(`"${target}" is a folder, not a note`, 'not_a_file')
    if (info.size > MAX_REWRITE_BYTES) {
      throw new VaultError(
        `refusing to rewrite "${target}": ${info.size} bytes exceeds the ${MAX_REWRITE_BYTES}-byte rewrite guard. ` +
          'Patch or append with a smaller edit, or reduce the note size first.',
        'too_large',
      )
    }
    const buffer = await fs.readFile(absolute)
    let text = buffer.toString('utf8')
    if (text.startsWith('\uFEFF')) text = text.slice(1)
    return { text, absolute, stat: info }
  }

  // endregion
  // region file operations

  /**
   * Remove a note or folder, moving it to `<root>/.trash/` unless configured
   * for hard deletes.
   * @param {string} rel
   * @param {{toTrash?: boolean, recursive?: boolean}} [options]
   * @returns {Promise<{rel: string, action: 'trashed'|'deleted'}>}
   */
  async remove(rel, options = {}) {
    return enqueueMutation(async () => {
      const target = this.norm(rel)
      if (target === '') throw new VaultError('refusing to remove the vault root', 'invalid_path')
      const absolute = this.toAbs(target)
      const info = await this._statAbs(absolute)
      if (!info) throw new VaultError(`path not found: ${target}`, 'not_found')
      if (info.type === 'dir' && options.recursive !== true) {
        throw new VaultError(`"${target}" is a folder; pass recursive: true to remove it and its contents`, 'is_a_directory')
      }
      const useTrash = this.trashMode !== 'delete' && options.toTrash !== false
      if (useTrash) {
        const trashRel = await this._uniqueTrashRel(target)
        const trashAbs = this.toAbs(trashRel)
        await fs.mkdir(path.dirname(trashAbs), { recursive: true })
        await moveFile(absolute, trashAbs)
        this._invalidateNameIndex()
        return { rel: target, action: 'trashed' }
      }
      await removeWithRetry(absolute)
      this._invalidateNameIndex()
      return { rel: target, action: 'deleted' }
    })
  }

  /**
   * Move or rename a note/folder inside the vault.
   * @param {string} rel
   * @param {string} destRel
   * @param {{overwrite?: boolean}} [options]
   * @returns {Promise<{from: string, to: string}>}
   */
  async move(rel, destRel, options = {}) {
    return enqueueMutation(async () => {
      const from = this.norm(rel)
      const to = this.norm(destRel)
      if (from === '') throw new VaultError('cannot move the vault root', 'invalid_path')
      if (to === '') throw new VaultError('destination must be a path inside the vault', 'invalid_path')
      if (from === to) return { from, to }
      const fromAbs = this.toAbs(from)
      const toAbs = this.toAbs(to)
      const source = await this._statAbs(fromAbs)
      if (!source) throw new VaultError(`source not found: ${from}`, 'not_found')
      const existing = await this._statAbs(toAbs)
      if (existing) {
        if (options.overwrite !== true) {
          throw new VaultError(`destination already exists: ${to}. Pass overwrite: true to replace it.`, 'exists')
        }
        await removeWithRetry(toAbs)
      }
      await fs.mkdir(path.dirname(toAbs), { recursive: true })
      await moveFile(fromAbs, toAbs)
      this._invalidateNameIndex()
      return { from, to }
    })
  }

  /**
   * Copy a note/folder inside the vault.
   * @param {string} rel
   * @param {string} destRel
   * @param {{overwrite?: boolean}} [options]
   * @returns {Promise<{from: string, to: string}>}
   */
  async copy(rel, destRel, options = {}) {
    return enqueueMutation(async () => {
      const from = this.norm(rel)
      const to = this.norm(destRel)
      if (from === '') throw new VaultError('cannot copy the vault root', 'invalid_path')
      if (to === '') throw new VaultError('destination must be a path inside the vault', 'invalid_path')
      const fromAbs = this.toAbs(from)
      const toAbs = this.toAbs(to)
      const source = await this._statAbs(fromAbs)
      if (!source) throw new VaultError(`source not found: ${from}`, 'not_found')
      if (from === to) return { from, to }
      const existing = await this._statAbs(toAbs)
      if (existing && options.overwrite !== true) {
        throw new VaultError(`destination already exists: ${to}. Pass overwrite: true to replace it.`, 'exists')
      }
      if (existing && options.overwrite === true) await removeWithRetry(toAbs)
      await fs.mkdir(path.dirname(toAbs), { recursive: true })
      if (source.type === 'dir') {
        await copyDirectory(fromAbs, toAbs)
      } else {
        await withTransientRetry(() => fs.copyFile(fromAbs, toAbs))
      }
      this._invalidateNameIndex()
      return { from, to }
    })
  }

  /**
   * Create a folder (and parents).
   * @param {string} rel
   * @returns {Promise<{rel: string, action: 'created'|'exists'}>}
   */
  async mkdir(rel) {
    return enqueueMutation(async () => {
      const target = this.norm(rel)
      if (target === '') return { rel: '', action: 'exists' }
      const absolute = this.toAbs(target)
      const existing = await this._statAbs(absolute)
      if (existing) {
        if (existing.type !== 'dir') throw new VaultError(`a file already exists at ${target}`, 'exists')
        return { rel: target, action: 'exists' }
      }
      await fs.mkdir(absolute, { recursive: true })
      return { rel: target, action: 'created' }
    })
  }

  async _uniqueTrashRel(target) {
    const base = `${TRASH_DIR}/${target}`
    const baseAbs = this.toAbs(base)
    const existing = await this._statAbs(baseAbs)
    if (!existing) return base
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const ext = path.extname(target)
    const withoutExt = ext ? target.slice(0, -ext.length) : target
    const suffixed = `${TRASH_DIR}/${withoutExt}.${stamp}${ext}`
    const suffixedAbs = this.toAbs(suffixed)
    if (!(await this._statAbs(suffixedAbs))) return suffixed
    return `${TRASH_DIR}/${withoutExt}.${stamp}-${Math.random().toString(36).slice(2, 7)}${ext}`
  }

  // endregion
}

// #region text helpers

export { hashText, compileGlob }

/** First 16 hex chars of sha1(text) — the note's `version`. */
function hashText(text) {
  return createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, 16)
}

function normalizeInput(text) {
  let value = String(text).replace(/^\uFEFF/, '')
  return value
}

function normalizeMode(mode) {
  const value = typeof mode === 'string' && mode !== '' ? mode : 'overwrite'
  if (['overwrite', 'append', 'prepend', 'create', 'patch'].includes(value)) return value
  throw new VaultError(`unknown write mode "${value}"; use overwrite, append, prepend, create or patch`, 'invalid_mode')
}

function resolveEol(requested, existingText, incomingText) {
  if (requested === 'lf') return '\n'
  if (requested === 'crlf') return '\r\n'
  if (typeof existingText === 'string' && existingText.includes('\r\n')) return '\r\n'
  if (typeof incomingText === 'string' && incomingText.includes('\r\n')) return '\r\n'
  return '\n'
}

function applyNewlinePolicy(text, requested, eol) {
  if (requested === 'lf') return text.replace(/\r\n?/g, '\n')
  if (requested === 'crlf') return text.replace(/\r\n|\r|\n/g, '\r\n')
  return eol === '\r\n' ? text.replace(/\r\n|\r|\n/g, '\r\n') : text.replace(/\r\n/g, '\n')
}

function appendText(base, addition, eol) {
  if (base === '') return addition
  if (addition === '') return base
  const needsSeparator = !base.endsWith('\n') && !base.endsWith('\r')
  return (needsSeparator ? base + eol : base) + addition
}

function prependText(base, addition, eol) {
  if (addition === '') return base
  const prefix = addition.endsWith('\n') || addition.endsWith('\r') ? addition : addition + eol
  if (base === '') return prefix
  // Insert after an existing frontmatter block so its metadata stays on top.
  const parsed = parseFrontmatter(base)
  if (parsed.has) return base.slice(0, parsed.bodyOffset) + prefix + base.slice(parsed.bodyOffset)
  return prefix + base
}

/**
 * Merge a frontmatter patch into a full note text.
 *
 * Delegates to lib/frontmatter.js so comments, quote style, list style and
 * key order survive an untouched merge, and so a YAML block we cannot parse is
 * reported instead of being silently destroyed.
 */
function applyFrontmatterPatch(text, patch) {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new VaultError('frontmatter must be a plain object of keys to merge', 'invalid_patch')
  }
  const parsed = parseFrontmatter(text)
  if (parsed.has && parsed.error) {
    throw new VaultError(
      `cannot merge frontmatter: the existing block is not valid YAML (${parsed.error}). ` +
        'Fix the frontmatter block first, or write the note with mode "overwrite".',
      'invalid_frontmatter',
    )
  }
  const merged = mergeFrontmatter(parsed.has ? parsed.data : {}, patch)
  return stringifyFrontmatter(merged, parsed.has ? parsed.body : text)
}

function applyPatch(text, options) {
  const find = options.find
  if (typeof find !== 'string' || find === '') {
    throw new VaultError('patch requires a non-empty "find" string (or set regex: true)', 'invalid_patch')
  }
  const replace = typeof options.replace === 'string' ? options.replace : ''
  const all = options.all === true
  if (options.regex === true) {
    let pattern
    try {
      pattern = new RegExp(find, all ? 'g' : '')
    } catch (error) {
      throw new VaultError(`invalid patch regex "${find}": ${error.message}`, 'invalid_regex')
    }
    const matches = text.match(pattern)
    const count = matches ? matches.length : 0
    if (count === 0) throw new VaultError(`patch regex /${find}/ did not match anything`, 'not_found')
    return { text: text.replace(pattern, replace), replacements: count }
  }
  if (all) {
    const parts = text.split(find)
    const count = parts.length - 1
    if (count === 0) throw new VaultError(`patch text "${find}" was not found`, 'not_found')
    return { text: parts.join(replace), replacements: count }
  }
  const index = text.indexOf(find)
  if (index === -1) throw new VaultError(`patch text "${find}" was not found`, 'not_found')
  return { text: text.slice(0, index) + replace + text.slice(index + find.length), replacements: 1 }
}

// #endregion
// #region filesystem helpers

async function readPrefix(absolute, maxBytes) {
  const handle = await fs.open(absolute, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close().catch(() => {})
  }
}

async function atomicWrite(absolute, text) {
  const directory = path.dirname(absolute)
  const tempPath = path.join(
    directory,
    `.${path.basename(absolute)}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`,
  )
  try {
    await withTransientRetry(() => fs.writeFile(tempPath, text, 'utf8'))
    // A rename over an existing file can transiently fail on Windows while an
    // antivirus scanner or the Obsidian indexer holds a handle: retry, never
    // report success for bytes that did not land.
    await withTransientRetry(() => fs.rename(tempPath, absolute))
  } catch (error) {
    await withTransientRetry(() => fs.rm(tempPath, { force: true })).catch(() => {})
    throw toVaultError(error, absolute)
  }
}

/** `fs.rm` with the Windows transient-hold retries. */
async function removeWithRetry(absolute) {
  await withTransientRetry(() => fs.rm(absolute, { recursive: true, force: true }))
}

async function moveFile(sourceAbs, targetAbs) {
  try {
    await withTransientRetry(() => fs.rename(sourceAbs, targetAbs))
    return
  } catch (error) {
    if (error && error.code === 'EXDEV') {
      await copyDirectory(sourceAbs, targetAbs).catch((copyError) => {
        throw toVaultError(copyError, sourceAbs)
      })
      await removeWithRetry(sourceAbs)
      return
    }
    if (error && (error.code === 'EEXIST' || error.code === 'EPERM' || error.code === 'EACCES')) {
      await removeWithRetry(targetAbs).catch(() => {})
      try {
        await withTransientRetry(() => fs.rename(sourceAbs, targetAbs))
        return
      } catch (retryError) {
        throw toVaultError(retryError, targetAbs)
      }
    }
    throw toVaultError(error, targetAbs)
  }
}

async function copyDirectory(sourceAbs, targetAbs) {
  const info = await fs.stat(sourceAbs)
  if (!info.isDirectory()) {
    await fs.mkdir(path.dirname(targetAbs), { recursive: true })
    await withTransientRetry(() => fs.copyFile(sourceAbs, targetAbs))
    return
  }
  await fs.mkdir(targetAbs, { recursive: true })
  const dirents = await fs.readdir(sourceAbs, { withFileTypes: true })
  for (const dirent of dirents) {
    if (dirent.isSymbolicLink()) continue
    await copyDirectory(path.join(sourceAbs, dirent.name), path.join(targetAbs, dirent.name))
  }
}

function toVaultError(error, target) {
  if (error instanceof VaultError) return error
  const code = error && typeof error === 'object' ? error.code : undefined
  const message = error && typeof error.message === 'string' ? error.message : String(error)
  const label = typeof target === 'string' ? target : ''
  switch (code) {
    case 'ENOENT':
      return new VaultError(`path not found: ${label}`, 'not_found')
    case 'EACCES':
    case 'EPERM':
      return new VaultError(`permission denied: ${label}. Close the file in Obsidian or check the folder permissions.`, 'permission_denied')
    case 'EEXIST':
      return new VaultError(`already exists: ${label}`, 'exists')
    case 'ENOSPC':
      return new VaultError(`the disk is full, could not write ${label}`, 'no_space')
    case 'EISDIR':
      return new VaultError(`${label} is a folder`, 'is_a_directory')
    case 'ENOTDIR':
      return new VaultError(`${label} is inside a file, not a folder`, 'not_a_directory')
    case 'ENAMETOOLONG':
      return new VaultError(`the path is too long for this filesystem: ${label}`, 'invalid_path')
    default:
      return new VaultError(`${message}${label ? ` (${label})` : ''}`, 'io_error')
  }
}

// #endregion
// #region small utilities

function toInt(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}

/** Unique note rels whose cache entry matches `predicate`, in walk order. */
function collectRels(entries, predicate) {
  const rels = []
  const seen = new Set()
  for (const entry of entries) {
    if (!predicate(entry)) continue
    if (seen.has(entry.rel)) continue
    seen.add(entry.rel)
    rels.push(entry.rel)
  }
  return rels
}

/** True when a buffer's first bytes or decoded text look like binary data. */
function looksBinary(buffer, text) {
  const sample = buffer.subarray(0, Math.min(buffer.length, BINARY_SNIFF_BYTES))
  if (sample.includes(0)) return true
  if (text.length === 0) return false
  let replacements = 0
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 0xfffd) replacements += 1
  return replacements / text.length > BINARY_REPLACEMENT_RATIO
}

function binaryFileError(rel, size) {
  const extension = path.extname(rel).replace('.', '').toLowerCase()
  const kind = extension === '' ? 'no extension' : `.${extension}`
  return new VaultError(
    `Not a text file: ${rel} (${size} bytes, looks like ${kind}). ` +
      'obsidian_read only reads notes; binary attachments are not readable as text.',
    'binary_file',
  )
}

function toPositiveInt(value, fallback) {
  const parsed = toInt(value, fallback)
  return parsed > 0 ? parsed : fallback
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function translateGlob(pattern) {
  let output = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1
        if (pattern[index + 1] === '/') {
          index += 1
          output += '(?:[^/]+/)*'
        } else output += '.*'
      } else output += '[^/]*'
      continue
    }
    if (char === '?') {
      output += '[^/]'
      continue
    }
    if (char === '[') {
      const end = pattern.indexOf(']', index + 1)
      if (end === -1) {
        output += '\\['
        continue
      }
      let slice = pattern.slice(index + 1, end)
      if (slice.startsWith('!')) slice = `^${slice.slice(1)}`
      output += `[${slice.replace(/\\/g, '\\\\')}]`
      index = end
      continue
    }
    output += escapeRegExp(char)
  }
  return output
}

/**
 * Compile one glob (`**`, `*`, `?`, `[a-z]`) into a RegExp anchored at the
 * vault-relative path. A trailing `/**` also matches its own directory, and
 * every pattern matches a directory prefix (so `a/**` matches `a`).
 * @param {string} pattern
 * @returns {RegExp}
 */
function compileGlob(pattern) {
  const normalized = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/').trim()
  const flags = process.platform === 'win32' ? 'i' : ''
  if (normalized.endsWith('/**')) {
    return new RegExp(`^${translateGlob(normalized.slice(0, -3))}(?:/.*)?$`, flags)
  }
  return new RegExp(`^${translateGlob(normalized)}(?:/.*)?$`, flags)
}

function matchGlob(matcher, rel, base) {
  if (matcher.test(rel)) return true
  if (typeof base === 'string' && base !== '' && rel.startsWith(`${base}/`)) {
    if (matcher.test(rel.slice(base.length + 1))) return true
  }
  const baseName = rel.slice(rel.lastIndexOf('/') + 1)
  return matcher.test(baseName)
}

// #endregion
