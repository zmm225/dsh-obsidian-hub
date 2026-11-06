/**
 * Query engine over a VaultIndex.
 *
 * Modes: `text` (BM25 over a mixed Chinese/English tokenizer), `regex`,
 * `phrase`, `tag`, `property`, `link` (backlinks), `files`, `recent`,
 * `headings`, `tasks`.
 *
 * Everything here is synchronous and in-memory: `ensureFresh()` on the index
 * is the only I/O, so a query over a few thousand notes stays in the low
 * milliseconds. Zero external dependencies.
 *
 * @module dsh-obsidian-hub/search
 */
import { parseTasks } from './frontmatter.js'

const K1 = 1.2
const B = 0.75
const TITLE_BOOST = 2.2
const PHRASE_BOOST = 1.25
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 200
const MAX_SNIPPET_LINE = 300
const MAX_CONTEXT_LINES = 5
const MAX_TF = 64
const MAX_REGEX_MATCHES = 200

export const SEARCH_MODES = [
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
]

/** Normalize a vault-relative path for comparisons (forward slashes). */
function normalizeRel(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
}

function clampInt(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function elapsed(started) {
  return Math.round((performance.now() - started) * 100) / 100
}

function roundScore(score) {
  if (!Number.isFinite(score) || score <= 0) return 0
  return Math.round(score * 1000) / 1000
}

// ---------------------------------------------------------------------------
// tokenizer — CJK bigrams + Latin words (no jieba, no dictionary)
// ---------------------------------------------------------------------------

function isCjkCode(code) {
  return (
    (code >= 0x3040 && code <= 0x30ff) || // hiragana / katakana
    (code >= 0x3400 && code <= 0x4dbf) || // CJK ext A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility
    (code >= 0x20000 && code <= 0x2ebef) || // CJK ext B..F (supplementary)
    (code >= 0xac00 && code <= 0xd7af) // hangul
  )
}

function isLatinCode(code) {
  return (
    (code >= 0x61 && code <= 0x7a) || // a-z (input is lowercased)
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x5f || // _
    code === 0x2d || // -
    code === 0x27 // '
  )
}

/**
 * Tokenize a query into all-must-match terms.
 * - CJK runs becomes overlapping character bigrams (a single char stays a unigram).
 * - Latin/digit runs become lowercase words.
 * @param {string} query
 * @returns {string[]} de-duplicated, order preserving
 */
export function tokenize(query) {
  const text = String(query ?? '').toLowerCase()
  const seen = new Set()
  const tokens = []
  const push = (token) => {
    if (!token || seen.has(token)) return
    seen.add(token)
    tokens.push(token)
  }

  let i = 0
  while (i < text.length) {
    const code = text.codePointAt(i)
    const width = code > 0xffff ? 2 : 1
    if (isCjkCode(code)) {
      let j = i + width
      while (j < text.length) {
        const next = text.codePointAt(j)
        if (!isCjkCode(next)) break
        j += next > 0xffff ? 2 : 1
      }
      const run = Array.from(text.slice(i, j))
      if (run.length === 1) push(run[0])
      else for (let k = 0; k + 1 < run.length; k += 1) push(run[k] + run[k + 1])
      i = j
      continue
    }
    if (isLatinCode(code)) {
      let j = i
      while (j < text.length && isLatinCode(text.codePointAt(j))) j += 1
      let word = text.slice(i, j).replace(/^[-']+|[-']+$/g, '')
      if (word) push(word)
      i = j
      continue
    }
    i += 1
  }
  return tokens
}

/** Count non-overlapping occurrences of `needle` in `haystack` (capped). */
function countOccurrences(haystack, needle, cap = MAX_TF) {
  let count = 0
  let from = 0
  while (count < cap) {
    const index = haystack.indexOf(needle, from)
    if (index < 0) break
    count += 1
    from = index + Math.max(1, needle.length)
  }
  return count
}

// ---------------------------------------------------------------------------
// glob / filters
// ---------------------------------------------------------------------------

/**
 * Compile a small glob (`*`, `**`, `?`) to an anchored case-insensitive regex.
 * @param {string} pattern
 */
export function globToRegExp(pattern) {
  const glob = String(pattern ?? '').replace(/\\/g, '/')
  let source = ''
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i += 1
        if (glob[i + 1] === '/') {
          i += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (ch === '?') {
      source += '[^/]'
      continue
    }
    source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`, 'i')
}

function parseTime(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const text = String(value).trim()
  if (/^\d+$/.test(text)) {
    const n = Number(text)
    return n > 0 && n < 1e12 ? n * 1000 : n // seconds → ms when it looks like seconds
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Pre-compile every per-query filter exactly once. */
function prepareParams(params) {
  const glob = params.glob ? globToRegExp(String(params.glob)) : null
  const rawPath = params.path ? normalizeRel(String(params.path)) : ''
  const path = rawPath.replace(/\/+$/, '')
  const isDirPrefix = rawPath === '' || rawPath.endsWith('/')
  const modifiedAfter = parseTime(params.modifiedAfter)
  return {
    mode: params.mode && SEARCH_MODES.includes(params.mode) ? params.mode : 'text',
    limit: clampInt(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
    offset: clampInt(params.offset, 0, 0, 1_000_000),
    contextLines: clampInt(params.contextLines, 1, 0, MAX_CONTEXT_LINES),
    glob,
    path,
    isDirPrefix,
    modifiedAfter,
  }
}

/** Does one note pass the path/glob/modifiedAfter filters? */
function passesFilters(record, filters) {
  if (filters.path) {
    const rel = normalizeRel(record.rel)
    const onPath =
      rel === filters.path || rel.startsWith(`${filters.path}/`) || (filters.isDirPrefix && rel === filters.path)
    if (!onPath) return false
  }
  if (filters.glob && !filters.glob.test(normalizeRel(record.rel))) return false
  if (filters.modifiedAfter !== undefined && record.mtimeMs < filters.modifiedAfter) return false
  return true
}

// ---------------------------------------------------------------------------
// snippets
// ---------------------------------------------------------------------------

function clipLine(line) {
  const text = String(line ?? '')
  return text.length > MAX_SNIPPET_LINE ? `${text.slice(0, MAX_SNIPPET_LINE - 1)}…` : text
}

/** Absolute (file) line number of a body line index (0-based). */
function fileLine(record, bodyLineIndex) {
  return bodyLineIndex + 1 + (Number(record.bodyLineOffset) || 0)
}

function windowSnippet(record, lines, matchIndex, contextLines) {
  const start = Math.max(0, matchIndex - contextLines)
  const end = Math.min(lines.length - 1, matchIndex + contextLines)
  const parts = []
  for (let i = start; i <= end; i += 1) parts.push(clipLine(lines[i]))
  return { snippet: parts.join('\n'), line: fileLine(record, matchIndex) }
}

function splitBody(record) {
  const raw = String(record.body ?? '').split('\n')
  const lower = raw.map((line) => line.toLowerCase())
  return { raw, lower }
}

/** Snippet around the line that contains the most distinct query tokens. */
function snippetForTokens(record, tokens, contextLines) {
  const { raw, lower } = splitBody(record)
  let best = -1
  let bestHits = 0
  for (let i = 0; i < lower.length; i += 1) {
    let hits = 0
    for (const token of tokens) if (lower[i].indexOf(token) >= 0) hits += 1
    if (hits > bestHits) {
      bestHits = hits
      best = i
      if (hits === tokens.length) break
    }
  }
  if (best < 0) return {}
  return windowSnippet(record, raw, best, contextLines)
}

function snippetForPhrase(record, phrase, contextLines) {
  const { raw, lower } = splitBody(record)
  for (let i = 0; i < lower.length; i += 1) {
    if (lower[i].indexOf(phrase) >= 0) return windowSnippet(record, raw, i, contextLines)
  }
  return {}
}

function snippetForLinePredicate(record, predicate, contextLines) {
  const { raw } = splitBody(record)
  for (let i = 0; i < raw.length; i += 1) {
    if (predicate(raw[i], i)) return windowSnippet(record, raw, i, contextLines)
  }
  return {}
}

// ---------------------------------------------------------------------------
// mode implementations
// ---------------------------------------------------------------------------

function emptyResult(mode, started) {
  return { mode, results: [], total: 0, tookMs: elapsed(started), truncated: false }
}

function pageResult(mode, results, filters, started) {
  const start = filters.offset
  const page = results.slice(start, start + filters.limit)
  return {
    mode,
    results: page,
    total: results.length,
    tookMs: elapsed(started),
    truncated: start + page.length < results.length,
  }
}

function makeResult(record, extra = {}) {
  const result = { rel: record.rel, title: record.title }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null) continue
    result[key] = value
  }
  return result
}

function runText(index, params, filters, started) {
  const query = String(params.query ?? '')
  const tokens = tokenize(query)
  if (tokens.length === 0) return emptyResult('text', started)

  const docs = []
  for (const record of index.files.values()) if (passesFilters(record, filters)) docs.push(record)
  const total = docs.length
  if (total === 0) return emptyResult('text', started)

  let totalLength = 0
  for (const record of docs) totalLength += record.lcText.length + String(record.title ?? '').length
  const avgLength = totalLength / total || 1

  const documentFrequency = new Map()
  let candidates = null
  for (const token of tokens) {
    const matched = []
    for (const record of docs) {
      if (record.lcText.indexOf(token) >= 0) {
        matched.push(record)
        continue
      }
      // A note whose title contains the term is still a hit (Obsidian search
      // matches file/title text too); its body may never mention the word.
      if (String(record.title ?? '').toLowerCase().indexOf(token) >= 0) matched.push(record)
    }
    documentFrequency.set(token, matched.length)
    if (matched.length === 0) return emptyResult('text', started)
    if (candidates === null) {
      candidates = matched
    } else {
      const keep = new Set(matched)
      candidates = candidates.filter((record) => keep.has(record))
      if (candidates.length === 0) return emptyResult('text', started)
    }
  }

  const wholeQuery = query.trim().toLowerCase()
  const hits = []
  for (const record of candidates) {
    const lowerTitle = String(record.title ?? '').toLowerCase()
    const documentLength = record.lcText.length + lowerTitle.length || 1
    let score = 0
    let occurrences = 0
    for (const token of tokens) {
      const bodyFrequency = countOccurrences(record.lcText, token, MAX_TF)
      const titleFrequency = countOccurrences(lowerTitle, token, MAX_TF)
      if (bodyFrequency === 0 && titleFrequency === 0) continue
      const termFrequency = bodyFrequency + titleFrequency * 2
      occurrences += bodyFrequency + titleFrequency
      const frequency = documentFrequency.get(token) || 0
      const idf = Math.log(1 + (total - frequency + 0.5) / (frequency + 0.5))
      score +=
        (idf * (termFrequency * (K1 + 1))) /
        (termFrequency + K1 * (1 - B + B * (documentLength / avgLength)))
      if (titleFrequency > 0) score += idf * TITLE_BOOST
    }
    if (occurrences === 0) continue
    if (wholeQuery && (record.lcText.indexOf(wholeQuery) >= 0 || lowerTitle.indexOf(wholeQuery) >= 0)) {
      score *= PHRASE_BOOST
    }
    hits.push({ record, score, occurrences })
  }

  hits.sort(
    (a, b) => b.score - a.score || (a.record.rel < b.record.rel ? -1 : a.record.rel > b.record.rel ? 1 : 0),
  )

  const page = hits.slice(filters.offset, filters.offset + filters.limit)
  const results = page.map((hit) => {
    const extra = { score: roundScore(hit.score), matches: hit.occurrences }
    const snippet = snippetForTokens(hit.record, tokens, filters.contextLines)
    if (snippet.snippet !== undefined) {
      extra.snippet = snippet.snippet
      extra.line = snippet.line
    }
    return makeResult(hit.record, extra)
  })
  return {
    mode: 'text',
    results,
    total: hits.length,
    tookMs: elapsed(started),
    truncated: filters.offset + results.length < hits.length,
  }
}

function runPhrase(index, params, filters, started) {
  const phrase = String(params.query ?? '').trim().toLowerCase()
  if (!phrase) return emptyResult('phrase', started)
  const hits = []
  for (const record of index.files.values()) {
    if (!passesFilters(record, filters)) continue
    const occurrences = countOccurrences(record.lcText, phrase, MAX_TF)
    if (occurrences === 0) continue
    const lowerTitle = String(record.title ?? '').toLowerCase()
    let score = occurrences * 10
    if (lowerTitle.indexOf(phrase) >= 0) score += 25
    if (lowerTitle === phrase) score += 50
    const snippet = snippetForPhrase(record, phrase, filters.contextLines)
    const extra = { score: roundScore(score), matches: occurrences }
    if (snippet.snippet !== undefined) {
      extra.snippet = snippet.snippet
      extra.line = snippet.line
    }
    hits.push(makeResult(record, extra))
  }
  hits.sort((a, b) => b.score - a.score || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return pageResult('phrase', hits, filters, started)
}

function runRegex(index, params, filters, started) {
  const source = String(params.regex ?? params.query ?? '')
  if (!source) return emptyResult('regex', started)
  let matcher
  try {
    // `m` makes ^/$ match line boundaries (what note searches expect); `i`
    // keeps regex search case-insensitive like the other modes.
    matcher = new RegExp(source, 'gim')
  } catch (error) {
    throw new Error(`invalid regex: ${error && error.message ? error.message : String(error)}`)
  }
  const hits = []
  for (const record of index.files.values()) {
    if (!passesFilters(record, filters)) continue
    const body = String(record.body ?? '')
    let count = 0
    matcher.lastIndex = 0
    let match
    while (count < MAX_REGEX_MATCHES && (match = matcher.exec(body)) !== null) {
      count += 1
      if (match[0] === '') matcher.lastIndex += 1
    }
    if (count === 0) continue
    const lineMatcher = new RegExp(source, 'im')
    const snippet = snippetForLinePredicate(record, (line) => lineMatcher.test(line), filters.contextLines)
    const extra = { matches: count }
    if (snippet.snippet !== undefined) {
      extra.snippet = snippet.snippet
      extra.line = snippet.line
    }
    hits.push(makeResult(record, extra))
  }
  hits.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return pageResult('regex', hits, filters, started)
}

function runTag(index, params, filters, started) {
  const raw = String(params.tag ?? params.query ?? '').trim()
  if (!raw) return emptyResult('tag', started)
  const parts = raw
    .split(/[\s,]+/)
    .map((part) => part.replace(/^#+/, '').trim().toLowerCase())
    .filter(Boolean)
  if (parts.length === 0) return emptyResult('tag', started)

  let current = null
  for (const part of parts) {
    const matched = new Set()
    if (part.endsWith('*')) {
      const prefix = part.slice(0, -1)
      for (const [tag, rels] of index.tagIndex) {
        if (!tag.startsWith(prefix)) continue
        for (const rel of rels) matched.add(rel)
      }
    } else {
      const exact = index.tagIndex.get(part)
      if (exact) for (const rel of exact) matched.add(rel)
      const prefix = `${part}/`
      for (const [tag, rels] of index.tagIndex) {
        if (!tag.startsWith(prefix)) continue
        for (const rel of rels) matched.add(rel)
      }
    }
    current = current === null ? matched : new Set([...current].filter((rel) => matched.has(rel)))
    if (current.size === 0) return emptyResult('tag', started)
  }

  const results = []
  for (const rel of current) {
    const record = index.files.get(rel)
    if (!record || !passesFilters(record, filters)) continue
    const extra = {}
    if (record.tags.length > 0) extra.snippet = clipLine(record.tags.map((tag) => `#${tag}`).join(' '))
    results.push(makeResult(record, extra))
  }
  results.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return pageResult('tag', results, filters, started)
}

function propertyText(value) {
  if (value === undefined) return ''
  if (Array.isArray(value)) return value.map((item) => propertyText(item)).filter(Boolean).join(', ')
  if (value !== null && typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

function runProperty(index, params, filters, started) {
  const property = params.property && typeof params.property === 'object' ? params.property : {}
  let key = String(property.key ?? params.propertyKey ?? '').trim()
  let value = property.value !== undefined && property.value !== null ? property.value : params.propertyValue
  if (typeof value === 'string' && value === '') value = undefined
  if (!key) {
    const query = String(params.query ?? '').trim()
    const match = /^([^:=]+)\s*[:=]\s*(.*)$/.exec(query)
    if (match) {
      key = match[1].trim()
      const rest = match[2].trim()
      if (rest) value = rest
    } else {
      key = query
    }
  }
  if (!key) return emptyResult('property', started)

  let actualKey = index.propertyIndex.has(key) ? key : undefined
  if (!actualKey) {
    const lower = key.toLowerCase()
    for (const candidate of index.propertyIndex.keys()) {
      if (candidate.toLowerCase() === lower) {
        actualKey = candidate
        break
      }
    }
  }
  const valueMap = actualKey ? index.propertyIndex.get(actualKey) : undefined
  if (!valueMap) return emptyResult('property', started)

  const rels = new Set()
  if (value === undefined || value === null || String(value).trim() === '') {
    for (const set of valueMap.values()) for (const rel of set) rels.add(rel)
  } else {
    const needle = String(value).trim().toLowerCase()
    const wildcard = needle.includes('*')
    const matcher = wildcard ? globToRegExp(needle) : null
    for (const [canon, set] of valueMap) {
      const haystack = canon.toLowerCase()
      const hit = wildcard ? matcher.test(haystack) : haystack === needle || haystack === needle.replace(/^"|"$/g, '')
      if (hit) for (const rel of set) rels.add(rel)
    }
  }

  const results = []
  for (const rel of rels) {
    const record = index.files.get(rel)
    if (!record || !passesFilters(record, filters)) continue
    const data = record.frontmatter && typeof record.frontmatter === 'object' ? record.frontmatter : {}
    const shown = propertyText(data[actualKey])
    const extra = { matches: 1 }
    if (shown) extra.snippet = clipLine(`${actualKey}: ${shown}`)
    results.push(makeResult(record, extra))
  }
  results.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return pageResult('property', results, filters, started)
}

function linkLine(record, link) {
  const needle = String(link.target ?? '').toLowerCase()
  if (!needle) return undefined
  const { raw } = splitBody(record)
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i].toLowerCase().indexOf(needle) >= 0) return windowSnippet(record, raw, i, 0)
  }
  return undefined
}

function runLink(index, params, filters, started) {
  const target = String(params.note ?? params.query ?? '').trim()
  if (!target) return emptyResult('link', started)
  const resolved = index.resolveNote(target)
  const results = []
  const seen = new Set()

  if (resolved) {
    for (const backlink of index.backlinksOf(resolved)) {
      const record = index.files.get(backlink.from)
      if (!record || !passesFilters(record, filters)) continue
      const extra = { matches: 1 }
      if (backlink.raw) extra.snippet = clipLine(backlink.raw)
      const located = linkLine(record, { target })
      if (located) {
        extra.snippet = located.snippet
        extra.line = located.line
      }
      results.push(makeResult(record, extra))
      seen.add(record.rel)
    }
  }

  // Also surface unresolved links that point at the requested name.
  const needle = target.toLowerCase().replace(/\.md$/i, '')
  for (const record of index.files.values()) {
    if (seen.has(record.rel) || !passesFilters(record, filters)) continue
    for (const link of record.links) {
      const linkTarget = String(link.target ?? '')
        .toLowerCase()
        .replace(/\.md$/i, '')
      if (linkTarget !== needle && !linkTarget.endsWith(`/${needle}`)) continue
      const extra = { matches: 1, snippet: clipLine(link.raw) }
      const located = linkLine(record, link)
      if (located) {
        extra.snippet = located.snippet
        extra.line = located.line
      }
      results.push(makeResult(record, extra))
      seen.add(record.rel)
      break
    }
  }

  results.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return pageResult('link', results, filters, started)
}

function runFiles(index, params, filters, started) {
  const query = String(params.query ?? '').trim().toLowerCase()
  const results = []
  for (const record of index.files.values()) {
    if (!passesFilters(record, filters)) continue
    if (query) {
      const rel = String(record.rel).toLowerCase()
      const title = String(record.title ?? '').toLowerCase()
      if (rel.indexOf(query) < 0 && title.indexOf(query) < 0) continue
    }
    results.push(makeResult(record))
  }
  results.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return pageResult('files', results, filters, started)
}

function runRecent(index, params, filters, started) {
  const ranked = index.recent(Number.MAX_SAFE_INTEGER)
  const results = []
  for (const record of ranked) {
    if (!passesFilters(record, filters)) continue
    results.push(makeResult(record, { matches: 1 }))
  }
  return pageResult('recent', results, filters, started)
}

function runHeadings(index, params, filters, started) {
  const query = String(params.query ?? '').trim().toLowerCase()
  const results = []
  for (const record of index.files.values()) {
    if (!passesFilters(record, filters)) continue
    for (const heading of record.headings) {
      const text = String(heading.text ?? '')
      if (query && text.toLowerCase().indexOf(query) < 0) continue
      const level = Number.isFinite(heading.level) ? heading.level : 1
      results.push(
        makeResult(record, {
          snippet: clipLine(`${'#'.repeat(Math.max(1, Math.min(6, level)))} ${text}`),
          // frontmatter.js reports 0-based body lines; expose 1-based file lines.
          line: (Number(heading.line) || 0) + (Number(record.bodyLineOffset) || 0) + 1,
          level,
          heading: text,
        }),
      )
    }
  }
  results.sort(
    (a, b) =>
      (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0) || (Number(a.line) || 0) - (Number(b.line) || 0),
  )
  return pageResult('headings', results, filters, started)
}

function runTasks(index, params, filters, started) {
  const query = String(params.query ?? '').trim()
  const lower = query.toLowerCase()
  const state = /^(open|todo|unchecked)$/.test(lower)
    ? 'open'
    : /^(done|checked|complete|completed)$/.test(lower)
      ? 'done'
      : /^(all|\*)$/.test(lower)
        ? 'all'
        : null
  const needle = state ? '' : lower

  const results = []
  for (const record of index.files.values()) {
    if (!passesFilters(record, filters)) continue
    let tasks = index.taskItems && typeof index.taskItems.get === 'function' ? index.taskItems.get(record.rel) : undefined
    if (!Array.isArray(tasks)) {
      try {
        tasks = parseTasks(String(record.body ?? ''))
      } catch {
        tasks = []
      }
    }
    for (const task of tasks) {
      if (state === 'open' && task.checked) continue
      if (state === 'done' && !task.checked) continue
      const text = String(task.text ?? '')
      if (needle && text.toLowerCase().indexOf(needle) < 0) continue
      results.push(
        makeResult(record, {
          snippet: clipLine(`${task.checked ? '- [x]' : '- [ ]'} ${text}`),
          // frontmatter.js reports 0-based body lines; expose 1-based file lines.
          line: (Number(task.line) || 0) + (Number(record.bodyLineOffset) || 0) + 1,
          checked: !!task.checked,
        }),
      )
    }
  }
  results.sort(
    (a, b) =>
      (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0) || (Number(a.line) || 0) - (Number(b.line) || 0),
  )
  return pageResult('tasks', results, filters, started)
}

// ---------------------------------------------------------------------------
// public entry point
// ---------------------------------------------------------------------------

/**
 * Run one query against an index.
 *
 * @param {{files: Map<string, object>, tagIndex: Map<string, Set<string>>, propertyIndex: Map<string, Map<string, Set<string>>>, taskItems?: Map<string, object[]>, resolveNote: Function, backlinksOf: Function, recent: Function}} index
 * @param {object} [params]
 * @returns {{mode: string, results: Array<object>, total: number, tookMs: number, truncated: boolean}}
 */
export function search(index, params = {}) {
  const started = performance.now()
  const raw = params && typeof params === 'object' ? params : {}
  const filters = prepareParams(raw)
  if (!index || !(index.files instanceof Map)) {
    return { mode: filters.mode, results: [], total: 0, tookMs: elapsed(started), truncated: false }
  }

  switch (filters.mode) {
    case 'regex':
      return runRegex(index, raw, filters, started)
    case 'phrase':
      return runPhrase(index, raw, filters, started)
    case 'tag':
      return runTag(index, raw, filters, started)
    case 'property':
      return runProperty(index, raw, filters, started)
    case 'link':
      return runLink(index, raw, filters, started)
    case 'files':
      return runFiles(index, raw, filters, started)
    case 'recent':
      return runRecent(index, raw, filters, started)
    case 'headings':
      return runHeadings(index, raw, filters, started)
    case 'tasks':
      return runTasks(index, raw, filters, started)
    case 'text':
    default:
      return runText(index, raw, filters, started)
  }
}
