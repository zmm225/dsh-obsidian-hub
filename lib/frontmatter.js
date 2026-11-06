/**
 * Obsidian note parsing: a small dependency-free YAML subset plus Markdown
 * extractors (links, tags, headings, tasks) and the frontmatter round-trip
 * helpers.
 *
 * Design goals, in order:
 *  1. Never lose data. If the frontmatter is not valid YAML we keep the raw
 *     text in `data.__raw` and expose `parseFrontmatter(...).error` instead of
 *     throwing, so a note always stays readable and writable.
 *  2. Byte-for-byte round-trip. An untouched frontmatter block is reproduced
 *     exactly as it was parsed, including its original quoting style, list
 *     style, key order and line endings. Only changed data is re-serialized.
 *  3. Predictable serialization. When something does change we emit a
 *     canonical, Obsidian-friendly block: `key: value`, inline arrays for
 *     short scalar lists, block lists for objects, `|` blocks for multiline
 *     strings.
 *
 * Supported YAML subset: `key: value`, plain/quoted scalars, booleans,
 * null/~, integers and floats, inline arrays `[a, b]`, inline maps `{a: b}`,
 * block sequences `- item` (including `- key: value` maps), arbitrarily deep
 * nested mappings, and literal/folded block scalars (`|`, `>`, `|-`, `>-`).
 * Anchors, tags, multi-document streams and complex keys are not supported.
 *
 * This module has no imports on purpose: it is a leaf used by both the vault
 * layer and the search indexer.
 *
 * @module lib/frontmatter
 */

/** Non-enumerable metadata slot attached to parsed frontmatter objects. */
const META = Symbol('dsh-obsidian-hub/frontmatter')

const RESERVED_SCALARS = new Set(['true', 'false', 'null', '~'])

// #region public API

/**
 * Split a note into its YAML frontmatter and body.
 *
 * The frontmatter block is only recognized when the note starts with a `---`
 * line (an optional UTF-8 BOM and a leading blank line are tolerated) and a
 * closing `---` (or `...`) line exists.
 *
 * `data` is an object (or an array for a malformed top-level sequence). When
 * the YAML cannot be parsed, `data` is `{ __raw: '<yaml text>' }` and the
 * non-enumerable `error` property describes the problem; `body` still points
 * at the untouched note body so callers can salvage the note.
 *
 * @param {string} text note content
 * @returns {{has: boolean, data: Record<string, unknown>, body: string, bodyOffset: number}}
 *   `bodyOffset` is the index in the ORIGINAL string where the body starts.
 *   Non-enumerable extras: `raw` (the exact frontmatter block, delimiters
 *   included, `null` when absent) and `error` (`null` unless YAML failed).
 */
export function parseFrontmatter(text) {
  const source = typeof text === 'string' ? text : text === null || text === undefined ? '' : String(text)
  const result = { has: false, data: {}, body: source, bodyOffset: 0 }
  defineHidden(result, 'raw', null)
  defineHidden(result, 'error', null)

  const bomLength = source.startsWith('\uFEFF') ? 1 : 0
  const work = bomLength ? source.slice(1) : source

  // Skip leading blank lines before `---`, mirroring how Obsidian tolerates
  // a stray blank line at the top of a note.
  let cursor = 0
  while (cursor < work.length) {
    const nextLineEnd = work.indexOf('\n', cursor)
    const lineEnd = nextLineEnd === -1 ? work.length : nextLineEnd
    const line = work.slice(cursor, lineEnd).replace(/\r$/, '')
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      if (nextLineEnd === -1) return result
      cursor = nextLineEnd + 1
      continue
    }
    if (line.trim() !== '---') return result
    if (nextLineEnd === -1) return result
    break
  }
  if (cursor >= work.length) return result

  const openEnd = work.indexOf('\n', cursor)
  if (openEnd === -1) return result

  // Locate the closing delimiter line.
  let index = openEnd + 1
  let yamlEnd = -1
  let afterClose = -1
  while (index <= work.length) {
    const newline = work.indexOf('\n', index)
    const lineEnd = newline === -1 ? work.length : newline
    const line = work.slice(index, lineEnd).replace(/\r$/, '')
    const marker = line.trim()
    if (marker === '---' || marker === '...') {
      yamlEnd = index
      afterClose = newline === -1 ? work.length : newline + 1
      break
    }
    if (newline === -1) break
    index = newline + 1
  }
  if (yamlEnd === -1) return result

  const rawYaml = work.slice(openEnd + 1, yamlEnd)
  const bodyStart = afterClose + bomLength
  const rawBlock = source.slice(0, bodyStart)

  let data
  let error = null
  try {
    data = yamlParse(rawYaml)
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
    data = { __raw: rawYaml }
  }
  if (!isPlainObject(data) && !Array.isArray(data)) {
    error = error ?? 'frontmatter must be a mapping'
    data = { __raw: rawYaml }
  }

  attachMeta(data, { raw: rawBlock, snapshot: snapshot(cleanData(data)), eol: detectEol(rawBlock) })

  result.has = true
  result.data = data
  result.body = source.slice(bodyStart)
  result.bodyOffset = bodyStart
  defineHidden(result, 'raw', rawBlock)
  defineHidden(result, 'error', error)
  return result
}

/**
 * Serialize a frontmatter object back into a note.
 *
 * When `data` came from {@link parseFrontmatter} and its values have not
 * changed, the original block is emitted byte-for-byte. Otherwise a canonical
 * block is generated from `data`. An empty object (or an object whose only
 * keys are internal `__`-prefixed ones) drops the block entirely.
 *
 * @param {Record<string, unknown> | unknown[] | null | undefined} data
 * @param {string} [body] note body (already without frontmatter)
 * @returns {string}
 */
export function stringifyFrontmatter(data, body = '') {
  const text = body === null || body === undefined ? '' : String(body)
  const source = data === null || data === undefined ? {} : data
  const meta = typeof source === 'object' && source !== null ? source[META] : undefined
  const clean = cleanData(source)
  const eol = text.includes('\r\n') ? '\r\n' : detectEol(text)
  const keys = Object.keys(clean)

  // Untouched block: reproduce the original bytes (delimiters included).
  if (meta && typeof meta.raw === 'string' && sameJson(clean, meta.snapshot)) return meta.raw + text

  if (keys.length === 0) {
    // Nothing left to write. Preserve an unparseable block verbatim if possible.
    const rawYaml = isPlainObject(source) ? source.__raw : undefined
    if (typeof rawYaml === 'string' && rawYaml.trim() !== '') {
      const normalized = rawYaml.replace(/\r?\n$/, '')
      return `---${eol}${normalized.replace(/\r?\n/g, eol)}${eol}---${eol}${text}`
    }
    return text
  }

  const yaml = yamlStringify(clean)
  if (yaml.trim() === '') return text
  const normalized = yaml.replace(/\r?\n/g, eol)
  return `---${eol}${normalized.endsWith(eol) ? normalized : normalized + eol}---${eol}${text}`
}

/**
 * Deep-merge a frontmatter patch into existing frontmatter data.
 *
 * - plain objects merge recursively; arrays and scalars replace wholesale
 * - a patch value of `undefined` deletes that key
 * - a patch value of `null` sets the key to null
 * - internal `__`-prefixed keys are never merged
 *
 * Neither input is mutated. When the merge changes nothing the result keeps
 * the original block's round-trip metadata, so a no-op merge still writes the
 * byte-identical block.
 *
 * @param {Record<string, unknown> | null | undefined} existing
 * @param {Record<string, unknown> | null | undefined} patch
 * @returns {Record<string, unknown>}
 */
export function mergeFrontmatter(existing, patch) {
  const base = isPlainObject(existing) ? cleanData(existing) : {}
  if (!isPlainObject(patch)) return base
  const merged = mergeInto(base, patch)
  const meta = isPlainObject(existing) ? existing[META] : undefined
  if (meta) attachMeta(merged, meta)
  return merged
}

/**
 * Parse the supported YAML subset into a plain object.
 *
 * @param {string} text YAML source (frontmatter content without delimiters)
 * @returns {Record<string, unknown> | unknown[]}
 * @throws {Error} on structural errors (bad indentation, missing key/value
 *   separator, unterminated quote). Callers that must not fail should use
 *   {@link parseFrontmatter} instead.
 */
export function yamlParse(text) {
  const source = typeof text === 'string' ? text : text === null || text === undefined ? '' : String(text)
  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  const state = { lines, index: 0 }
  skipTrivia(state)
  if (state.index >= lines.length) return {}
  const indent = indentOf(lines[state.index])
  const value = parseBlock(state, indent)
  skipTrivia(state)
  if (state.index < lines.length) {
    throw new Error(`yaml: unexpected content at line ${state.index + 1}: ${String(lines[state.index]).trim()}`)
  }
  return value
}

/**
 * Serialize a plain object into the supported YAML subset.
 *
 * Keys are written in insertion order, `__`-prefixed keys are skipped, and
 * `undefined` values are omitted. Always ends with a newline (or is empty).
 *
 * @param {unknown} object
 * @returns {string}
 */
export function yamlStringify(object) {
  if (object === null || object === undefined) return ''
  if (Array.isArray(object)) {
    const lines = stringifySequenceBlock(object, 0)
    return lines.length ? `${lines.join('\n')}\n` : ''
  }
  if (typeof object !== 'object') return `${formatScalar(object)}\n`
  const lines = []
  for (const [key, value] of Object.entries(object)) {
    if (key.startsWith('__')) continue
    lines.push(...stringifyPair(key, value, 0))
  }
  return lines.length ? `${lines.join('\n')}\n` : ''
}

/**
 * Extract wiki links (`[[note]]`, `[[note|alias]]`, `[[note#heading]]`,
 * `![[embed]]`) and internal Markdown links from a note body.
 *
 * External URLs (`http:`, `https:`, `mailto:`, …), pure anchors and links
 * inside fenced code blocks or inline code are ignored.
 *
 * @param {string} body
 * @returns {Array<{type: 'wiki'|'md', target: string, alias?: string, heading?: string, raw: string, embed?: boolean}>}
 */
export function parseLinks(body) {
  const source = typeof body === 'string' ? body : ''
  const links = []
  const lines = codeMaskedLines(source)
  for (const line of lines) {
    if (line === '') continue
    const scrubbed = stripInlineCode(line)
    const found = []
    const wikiPattern = /(!?)\[\[([^\]\n]+)\]\]/g
    let match
    while ((match = wikiPattern.exec(scrubbed)) !== null) {
      const inner = match[2]
      const pipe = inner.indexOf('|')
      const left = pipe === -1 ? inner : inner.slice(0, pipe)
      const alias = pipe === -1 ? '' : inner.slice(pipe + 1).trim()
      const hash = left.indexOf('#')
      const target = (hash === -1 ? left : left.slice(0, hash)).trim()
      const heading = hash === -1 ? '' : left.slice(hash + 1).trim()
      const link = { type: 'wiki', target }
      if (alias) link.alias = alias
      if (heading) link.heading = heading
      if (match[1] === '!') link.embed = true
      link.raw = match[0]
      found.push({ index: match.index, link })
    }
    const mdPattern = /\[([^\]\n]*)\]\(([^()\n]*)\)/g
    while ((match = mdPattern.exec(scrubbed)) !== null) {
      const label = match[1].trim()
      let targetPart = match[2].trim()
      if (targetPart === '') continue
      const whitespace = targetPart.search(/\s/)
      if (whitespace !== -1) targetPart = targetPart.slice(0, whitespace)
      if (targetPart.startsWith('<') && targetPart.endsWith('>')) targetPart = targetPart.slice(1, -1)
      if (targetPart === '' || /^[a-z][a-z0-9+.-]*:/i.test(targetPart) || targetPart.startsWith('#')) continue
      const hash = targetPart.indexOf('#')
      const target = (hash === -1 ? targetPart : targetPart.slice(0, hash)).trim()
      if (target === '') continue
      const link = { type: 'md', target }
      if (label) link.alias = label
      if (hash !== -1) {
        const heading = targetPart.slice(hash + 1).trim()
        if (heading) link.heading = heading
      }
      link.raw = match[0]
      found.push({ index: match.index, link })
    }
    found.sort((a, b) => a.index - b.index)
    for (const entry of found) links.push(entry.link)
  }
  return links
}

/**
 * Collect tags from frontmatter (`tags` / `tag`) and from `#tag` references in
 * the body. Code blocks and inline code are ignored. Tags are de-duplicated
 * case-insensitively, returned without the leading `#`, keeping the spelling
 * of their first occurrence.
 *
 * @param {string} body
 * @param {Record<string, unknown>} [data] parsed frontmatter
 * @returns {string[]}
 */
export function parseTags(body, data) {
  const tags = []
  const seen = new Set()
  const push = (candidate) => {
    const tag = normalizeTag(candidate)
    if (tag === '') return
    const key = tag.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    tags.push(tag)
  }

  if (isPlainObject(data)) {
    for (const field of ['tags', 'tag', 'keywords']) {
      const value = data[field]
      if (Array.isArray(value)) for (const item of value) push(item)
      else if (typeof value === 'string') for (const item of value.split(/[,;]+/)) push(item)
    }
  }

  const source = typeof body === 'string' ? body : ''
  for (const line of codeMaskedLines(source)) {
    if (line === '') continue
    const scrubbed = stripInlineCode(line)
    const pattern = /(^|[\s(])#([\p{L}\p{N}_/-]+)/gu
    let match
    while ((match = pattern.exec(scrubbed)) !== null) push(match[2])
  }
  return tags
}

/**
 * Extract ATX headings outside fenced code blocks.
 *
 * @param {string} body
 * @returns {Array<{level: number, text: string, line: number}>} `line` is the
 *   0-based index of the heading within `body`.
 */
export function parseHeadings(body) {
  const source = typeof body === 'string' ? body : ''
  const headings = []
  const lines = codeMaskedLines(source)
  const pattern = /^(#{1,6})[ \t]+(.*)$/
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line === '') continue
    const match = pattern.exec(line)
    if (!match) continue
    let text = match[2].trim()
    text = text.replace(/[ \t]+#+[ \t]*$/, '').trim()
    if (text === '') continue
    headings.push({ level: match[1].length, text, line: index })
  }
  return headings
}

/**
 * Extract Markdown task-list items outside fenced code blocks.
 *
 * @param {string} body
 * @returns {Array<{line: number, checked: boolean, text: string}>} `line` is
 *   the 0-based index within `body`; `checked` is true for `[x]` / `[X]`.
 */
export function parseTasks(body) {
  const source = typeof body === 'string' ? body : ''
  const tasks = []
  const lines = codeMaskedLines(source)
  const pattern = /^[ \t]*[-*+][ \t]+\[([ xX/<>-])\][ \t]+(.*)$/
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line === '') continue
    const match = pattern.exec(line)
    if (!match) continue
    const marker = match[1]
    const text = match[2].trim()
    tasks.push({ line: index, checked: marker === 'x' || marker === 'X', text })
  }
  return tasks
}

/**
 * Best available title for a note.
 *
 * Order: frontmatter `title` → first level-1 heading in the body → file name
 * without `.md` → full relative path.
 *
 * @param {string} rel vault-relative path
 * @param {Record<string, unknown>} [data] parsed frontmatter
 * @param {string} [body] note body
 * @returns {string}
 */
export function extractTitle(rel, data, body) {
  if (isPlainObject(data)) {
    const value = data.title
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  const heading = parseHeadings(typeof body === 'string' ? body : '').find((entry) => entry.level === 1)
  if (heading) return heading.text
  const segments = String(rel ?? '').split(/[\\/]/)
  const base = segments[segments.length - 1] ?? ''
  const stripped = base.replace(/\.md$/i, '').trim()
  return stripped !== '' ? stripped : base !== '' ? base : 'Untitled'
}

// #endregion
// #region YAML parser

function indentOf(line) {
  const match = /^[ \t]*/.exec(line)
  return match ? match[0].length : 0
}

/** A sequence entry line: `-`, `- x`, `-key: value` is NOT an entry. */
function isSeqEntry(line) {
  return /^[ \t]*-(\s|$)/.test(line)
}

function isBlankLine(line) {
  return line === undefined || line.trim() === ''
}

function isCommentLine(line) {
  return /^[ \t]*#/.test(line)
}

function skipTrivia(state) {
  while (state.index < state.lines.length) {
    const line = state.lines[state.index]
    if (isBlankLine(line) || isCommentLine(line)) {
      state.index += 1
      continue
    }
    return
  }
}

function parseBlock(state, indent) {
  const line = state.lines[state.index]
  return isSeqEntry(line) ? parseSequence(state, indent) : parseMapping(state, indent)
}

function parseMapping(state, indent) {
  const map = {}
  while (state.index < state.lines.length) {
    const raw = state.lines[state.index]
    if (isBlankLine(raw) || isCommentLine(raw)) {
      state.index += 1
      continue
    }
    const lineIndent = indentOf(raw)
    if (lineIndent < indent) break
    if (lineIndent > indent) throw new Error(`yaml: unexpected indentation at line ${state.index + 1}`)
    if (isSeqEntry(raw)) throw new Error(`yaml: unexpected sequence entry at line ${state.index + 1}`)
    const line = raw.slice(lineIndent)
    const colon = findKeyColon(line)
    if (colon < 0) throw new Error(`yaml: expected "key: value" at line ${state.index + 1}`)
    const key = normalizeKey(line.slice(0, colon))
    const rest = line.slice(colon + 1)
    state.index += 1
    map[key] = parseValueAfterKey(state, indent, rest, state.index)
  }
  return map
}

function parseSequence(state, indent) {
  const list = []
  while (state.index < state.lines.length) {
    const raw = state.lines[state.index]
    if (isBlankLine(raw) || isCommentLine(raw)) {
      state.index += 1
      continue
    }
    const lineIndent = indentOf(raw)
    if (lineIndent < indent) break
    if (lineIndent > indent) throw new Error(`yaml: unexpected indentation at line ${state.index + 1}`)
    if (!isSeqEntry(raw)) break
    const itemText = raw.slice(lineIndent + 1).trim()
    state.index += 1
    if (itemText === '') {
      // A bare dash: the value is a nested block, or null.
      const saved = state.index
      skipTrivia(state)
      if (state.index < state.lines.length && indentOf(state.lines[state.index]) > indent) {
        list.push(parseBlock(state, indentOf(state.lines[state.index])))
      } else {
        state.index = saved
        list.push(null)
      }
      continue
    }
    const blockHeader = /^([|>])([+-]?)(\d*)$/.exec(itemText)
    if (blockHeader) {
      list.push(readBlockScalar(state, indent, blockHeader[1], blockHeader[2]))
      continue
    }
    const colon = findKeyColon(itemText)
    if (colon > 0) {
      // A mapping item: `- key: value`, possibly with continuation lines.
      const key = normalizeKey(itemText.slice(0, colon))
      const rest = itemText.slice(colon + 1)
      const item = {}
      item[key] = parseValueAfterKey(state, indent + 2, rest, state.index)
      const saved = state.index
      skipTrivia(state)
      if (state.index < state.lines.length) {
        const continuationIndent = indentOf(state.lines[state.index])
        const continuationLine = state.lines[state.index]
        if (continuationIndent > indent && !isSeqEntry(continuationLine)) {
          const extra = parseMapping(state, continuationIndent)
          Object.assign(item, extra)
        } else {
          state.index = saved
        }
      } else {
        state.index = saved
      }
      list.push(item)
      continue
    }
    list.push(parseInlineValue(itemText, state.index))
  }
  return list
}

function parseValueAfterKey(state, parentIndent, restRaw, lineNumber) {
  const rest = restRaw.trim()
  if (rest === '') {
    const saved = state.index
    skipTrivia(state)
    if (state.index >= state.lines.length) {
      state.index = saved
      return null
    }
    const nextLine = state.lines[state.index]
    const nextIndent = indentOf(nextLine)
    if (nextIndent > parentIndent) return parseBlock(state, nextIndent)
    if (nextIndent === parentIndent && isSeqEntry(nextLine)) return parseSequence(state, parentIndent)
    state.index = saved
    return null
  }
  const blockHeader = /^([|>])([+-]?)(\d*)\s*(?:#.*)?$/.exec(rest)
  if (blockHeader) return readBlockScalar(state, parentIndent, blockHeader[1], blockHeader[2])
  return parseInlineValue(rest, lineNumber)
}

/** Index of the `:` separating a key from its value, or -1. */
function findKeyColon(text) {
  let quote = ''
  let depth = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote) {
      if (char === '\\' && quote === '"') {
        index += 1
        continue
      }
      if (char === quote) {
        if (quote === "'" && text[index + 1] === "'") {
          index += 1
          continue
        }
        quote = ''
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '[' || char === '{') {
      depth += 1
      continue
    }
    if (char === ']' || char === '}') {
      depth -= 1
      continue
    }
    if (char === '#' && (index === 0 || /\s/.test(text[index - 1]))) return -1
    if (char === ':' && depth === 0) {
      const next = text[index + 1]
      if (next === undefined || /\s/.test(next)) return index
    }
  }
  return -1
}

function normalizeKey(raw) {
  let key = raw.trim()
  if (key.length >= 2 && key.startsWith('"') && key.endsWith('"')) {
    key = unquoteDouble(key).value
  } else if (key.length >= 2 && key.startsWith("'") && key.endsWith("'")) {
    key = key.slice(1, -1).replace(/''/g, "'")
  }
  return key
}

function parseInlineValue(raw, lineNumber) {
  const text = stripTrailingComment(raw).trim()
  if (text === '') return null
  if (text.startsWith('[')) return parseInlineArray(text, lineNumber)
  if (text.startsWith('{')) return parseInlineMap(text, lineNumber)
  if (text.startsWith('"')) {
    const parsed = unquoteDouble(text)
    if (parsed.rest.trim() !== '') throw new Error(`yaml: unexpected trailing content at line ${lineNumber}`)
    return parsed.value
  }
  if (text.startsWith("'")) {
    const parsed = unquoteSingle(text)
    if (parsed.rest.trim() !== '') throw new Error(`yaml: unexpected trailing content at line ${lineNumber}`)
    return parsed.value
  }
  return parseScalar(text)
}

function parseInlineArray(text, lineNumber) {
  const end = matchingBracket(text, '[', ']')
  if (end === -1) throw new Error(`yaml: unterminated inline array at line ${lineNumber}`)
  const inner = text.slice(1, end).trim()
  const trailing = text.slice(end + 1).trim()
  if (trailing !== '') throw new Error(`yaml: unexpected content after inline array at line ${lineNumber}`)
  if (inner === '') return []
  return splitTopLevel(inner, ',').map((part) => parseInlineValue(part, lineNumber))
}

function parseInlineMap(text, lineNumber) {
  const end = matchingBracket(text, '{', '}')
  if (end === -1) throw new Error(`yaml: unterminated inline map at line ${lineNumber}`)
  const inner = text.slice(1, end).trim()
  const trailing = text.slice(end + 1).trim()
  if (trailing !== '') throw new Error(`yaml: unexpected content after inline map at line ${lineNumber}`)
  const map = {}
  if (inner === '') return map
  for (const part of splitTopLevel(inner, ',')) {
    const colon = findKeyColon(part)
    if (colon < 0) throw new Error(`yaml: expected "key: value" in inline map at line ${lineNumber}`)
    map[normalizeKey(part.slice(0, colon))] = parseInlineValue(part.slice(colon + 1), lineNumber)
  }
  return map
}

function matchingBracket(text, open, close) {
  let depth = 0
  let quote = ''
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote) {
      if (char === '\\' && quote === '"') {
        index += 1
        continue
      }
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function splitTopLevel(text, separator) {
  const parts = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote) {
      if (char === '\\' && quote === '"') {
        index += 1
        continue
      }
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '[' || char === '{') depth += 1
    else if (char === ']' || char === '}') depth -= 1
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

function stripTrailingComment(text) {
  let quote = ''
  let depth = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote) {
      if (char === '\\' && quote === '"') {
        index += 1
        continue
      }
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '[' || char === '{') depth += 1
    else if (char === ']' || char === '}') depth -= 1
    else if (char === '#' && depth === 0 && (index === 0 || /[ \t]/.test(text[index - 1]))) {
      return text.slice(0, index).replace(/[ \t]+$/, '')
    }
  }
  return text
}

function unquoteDouble(text) {
  // text starts with '"'; find the closing unescaped quote.
  let value = ''
  let index = 1
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') {
      const next = text[index + 1]
      if (next === undefined) break
      switch (next) {
        case 'n': value += '\n'; break
        case 'r': value += '\r'; break
        case 't': value += '\t'; break
        case '0': value += '\0'; break
        case '"': value += '"'; break
        case '\\': value += '\\'; break
        case '/': value += '/'; break
        case 'u': {
          const hex = text.slice(index + 2, index + 6)
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            value += String.fromCharCode(Number.parseInt(hex, 16))
            index += 4
          } else {
            value += 'u'
          }
          break
        }
        default: value += next
      }
      index += 2
      continue
    }
    if (char === '"') return { value, rest: text.slice(index + 1) }
    value += char
    index += 1
  }
  return { value, rest: '' }
}

function unquoteSingle(text) {
  let value = ''
  let index = 1
  while (index < text.length) {
    const char = text[index]
    if (char === "'") {
      if (text[index + 1] === "'") {
        value += "'"
        index += 2
        continue
      }
      return { value, rest: text.slice(index + 1) }
    }
    value += char
    index += 1
  }
  return { value, rest: '' }
}

function parseScalar(text) {
  const value = text.trim()
  if (value === '') return null
  if (value === '~' || /^(?:null|Null|NULL)$/.test(value)) return null
  if (/^(?:true|True|TRUE)$/.test(value)) return true
  if (/^(?:false|False|FALSE)$/.test(value)) return false
  if (/^0x[0-9a-fA-F]+$/.test(value)) return Number.parseInt(value, 16)
  if (/^[-+]?(?:0|[1-9]\d*)$/.test(value)) {
    const number = Number(value)
    if (Number.isSafeInteger(number)) return number
    return value
  }
  if (/^[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(value)) {
    const number = Number(value)
    if (Number.isFinite(number)) return number
  }
  return value
}

function readBlockScalar(state, parentIndent, style, chomp) {
  const collected = []
  let blockIndent = -1
  while (state.index < state.lines.length) {
    const raw = state.lines[state.index]
    if (isBlankLine(raw)) {
      collected.push('')
      state.index += 1
      continue
    }
    const lineIndent = indentOf(raw)
    if (lineIndent <= parentIndent) break
    if (blockIndent === -1) blockIndent = lineIndent
    if (lineIndent < blockIndent) break
    collected.push(raw.slice(blockIndent))
    state.index += 1
  }
  // Trailing blank lines belong to the chomping decision, not the content.
  let trailing = 0
  while (collected.length > 0 && collected[collected.length - 1] === '') {
    collected.pop()
    trailing += 1
  }
  const core = style === '|' ? collected.join('\n') : foldLines(collected)
  if (chomp === '-') return core
  if (chomp === '+') return core + '\n'.repeat(trailing + (core === '' ? 0 : 1))
  return core === '' ? '' : core + '\n'
}

function foldLines(lines) {
  let output = ''
  for (const line of lines) {
    if (line === '') {
      output += '\n'
      continue
    }
    if (output === '' || output.endsWith('\n')) output += line
    else output += ` ${line}`
  }
  return output
}

// #endregion
// #region YAML serializer

function stringifyPair(key, value, indent) {
  const pad = ' '.repeat(indent)
  const keyText = formatKey(key)
  if (value === undefined) return []
  if (value === null) return [`${pad}${keyText}: null`]
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}${keyText}: []`]
    if (value.every(isScalar) && value.every(isInlineSafeScalar)) {
      return [`${pad}${keyText}: [${value.map(formatScalar).join(', ')}]`]
    }
    const lines = [`${pad}${keyText}:`]
    for (const item of value) {
      if (isPlainObject(item)) {
        const entries = Object.entries(item).filter(([itemKey, itemValue]) => itemValue !== undefined && !itemKey.startsWith('__'))
        if (entries.length === 0) {
          lines.push(`${pad}  - {}`)
          continue
        }
        const first = entries[0]
        const firstLines = stringifyPair(first[0], first[1], indent + 4)
        lines.push(`${pad}  - ${firstLines[0].slice(indent + 4)}`)
        for (const extraLine of firstLines.slice(1)) lines.push(extraLine)
        for (const [itemKey, itemValue] of entries.slice(1)) lines.push(...stringifyPair(itemKey, itemValue, indent + 4))
      } else if (Array.isArray(item)) {
        lines.push(`${pad}  - [${item.map((entry) => formatScalar(entry)).join(', ')}]`)
      } else {
        lines.push(`${pad}  - ${formatScalar(item)}`)
      }
    }
    return lines
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([itemKey, itemValue]) => itemValue !== undefined && !itemKey.startsWith('__'))
    if (entries.length === 0) return [`${pad}${keyText}: {}`]
    const lines = [`${pad}${keyText}:`]
    for (const [itemKey, itemValue] of entries) lines.push(...stringifyPair(itemKey, itemValue, indent + 2))
    return lines
  }
  if (typeof value === 'string' && /[\r\n]/.test(value)) {
    return [`${pad}${keyText}: ${value.endsWith('\n') ? '|' : '|-'}`, ...stringifyBlockBody(value, indent + 2)]
  }
  return [`${pad}${keyText}: ${formatScalar(value)}`]
}

function stringifySequenceBlock(list, indent) {
  const lines = []
  const pad = ' '.repeat(indent)
  for (const item of list) {
    if (item === undefined) continue
    if (isPlainObject(item)) {
      const entries = Object.entries(item).filter(([key, value]) => value !== undefined && !key.startsWith('__'))
      if (entries.length === 0) {
        lines.push(`${pad}- {}`)
        continue
      }
      const first = entries[0]
      const firstLines = stringifyPair(first[0], first[1], indent + 2)
      lines.push(`${pad}- ${firstLines[0].slice(indent + 2)}`)
      for (const extraLine of firstLines.slice(1)) lines.push(extraLine)
      for (const [key, value] of entries.slice(1)) lines.push(...stringifyPair(key, value, indent + 2))
    } else {
      lines.push(`${pad}- ${formatScalar(item)}`)
    }
  }
  return lines
}

function stringifyBlockBody(text, indent) {
  const pad = ' '.repeat(indent)
  const core = text.endsWith('\n') ? text.slice(0, -1) : text
  return core.split('\n').map((line) => (line === '' ? '' : `${pad}${line}`))
}

function formatKey(key) {
  const text = String(key)
  if (/^[A-Za-z0-9_\u00a0-\uffff][A-Za-z0-9_ .\u00a0-\uffff-]*$/.test(text) && !text.endsWith(' ')) return text
  return JSON.stringify(text)
}

function formatScalar(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  const text = String(value)
  if (text === '') return '""'
  if (needsQuotes(text)) return JSON.stringify(text)
  return text
}

function needsQuotes(text) {
  if (/^[ \t]|[ \t]$/.test(text)) return true
  if (/[\r\n\t]/.test(text)) return true
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(text)) return true
  if (RESERVED_SCALARS.has(text)) return true
  if (/^(?:true|false|null|~)$/i.test(text)) return true
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(text)) return true
  if (text.includes(': ') || text.endsWith(':') || text.includes(' #')) return true
  return false
}

function isScalar(value) {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function isInlineSafeScalar(value) {
  if (value === null) return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'boolean') return true
  const text = String(value)
  if (text.length > 60) return false
  if (/[\r\n]/.test(text)) return false
  if (text.includes(',') || text.includes('[') || text.includes(']')) return true // quoted by formatScalar below
  return !/[{}]/.test(text)
}

// #endregion
// #region Markdown helpers

/** Replace fenced code block lines with empty strings (line count preserved). */
function codeMaskedLines(body) {
  const lines = String(body).split(/\r?\n/)
  let fence = ''
  return lines.map((line) => {
    const opening = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (opening && opening[1][0] === fence[0] && opening[1].length >= fence.length) fence = ''
      return ''
    }
    if (opening) {
      fence = opening[1]
      return ''
    }
    return line
  })
}

function stripInlineCode(line) {
  return line.replace(/`[^`\n]*`/g, ' ')
}

function normalizeTag(candidate) {
  let tag = String(candidate === null || candidate === undefined ? '' : candidate).trim()
  tag = tag.replace(/^#+/, '').replace(/^\/+/, '').replace(/\/+$/, '')
  if (tag === '') return ''
  if (!/^[\p{L}\p{N}_/-]+$/u.test(tag)) return ''
  if (/^\d+$/.test(tag)) return '' // Obsidian rejects purely numeric tags
  return tag
}

// #endregion
// #region shared utilities

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function defineHidden(target, key, value) {
  try {
    Object.defineProperty(target, key, { value, enumerable: false, configurable: true, writable: true })
  } catch {
    /* frozen input — nothing to attach */
  }
}

function attachMeta(data, meta) {
  if (!isPlainObject(data)) return
  defineHidden(data, META, meta)
}

function detectEol(text) {
  return typeof text === 'string' && text.includes('\r\n') ? '\r\n' : '\n'
}

/** Deep JSON-safe copy that drops `__`-prefixed keys and undefined values. */
function cleanData(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (entry === undefined ? null : cleanData(entry)))
      .filter((entry) => entry !== undefined)
  }
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      if (key.startsWith('__')) continue
      if (entry === undefined) continue
      out[key] = cleanData(entry)
    }
    return out
  }
  if (typeof value === 'function' || typeof value === 'symbol') return undefined
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  if (value instanceof Date) return value.toISOString()
  return value === undefined ? null : value
}

function snapshot(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return null
  }
}

function sameJson(a, b) {
  if (b === null || b === undefined) return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

function mergeInto(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (key.startsWith('__')) continue
    if (value === undefined) {
      delete out[key]
      continue
    }
    const current = out[key]
    if (isPlainObject(value) && isPlainObject(current)) out[key] = mergeInto(current, value)
    else if (Array.isArray(value)) out[key] = cleanData(value)
    else out[key] = cleanData(value)
  }
  return out
}

// #endregion
