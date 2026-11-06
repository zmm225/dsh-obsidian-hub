/**
 * search-engine acceptance tests: VaultIndex + search() + obsidian_search.
 *
 * Everything runs against temp fixture vaults under %TEMP% — never the user's
 * real vault (except the final read-only smoke test). Only Node builtins and
 * sibling plugin modules are imported.
 *
 * Run with:  node --test test/search.test.mjs
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { resolveConfig } from '../lib/config.js'
import { createVault } from '../lib/vault.js'
import { VaultIndex } from '../lib/indexer.js'
import { search, tokenize, globToRegExp } from '../lib/search.js'
import { registerSearchTools } from '../lib/tools-search.js'

const TMP = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp'
const ROOT = path.join(TMP, `dsh-hub-search-${process.pid}`)
const REAL_VAULT = 'D:\\obsidian\\obsidian'

const config = resolveConfig({ vaultPath: ROOT })

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function write(rel, content, options = {}) {
  const abs = path.join(ROOT, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, options.encoding || 'utf8')
  if (options.mtimeMs) fs.utimesSync(abs, options.mtimeMs / 1000, options.mtimeMs / 1000)
  return abs
}

function makeVault(root) {
  return createVault({
    root,
    exclude: config.exclude,
    maxFileBytes: config.maxFileBytes,
    trashMode: config.trashMode,
  })
}

function listMarkdown(root) {
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (/\.md$/i.test(entry.name)) out.push(path.relative(root, abs).split(path.sep).join('/'))
    }
  }
  walk(root)
  return out
}

const BASE_TIME = Date.UTC(2026, 10, 1, 0, 0, 0) // fixed, so "recent" is deterministic
const noteTimes = new Map()

function note(rel, content, mtimeMs) {
  write(rel, content, { mtimeMs: mtimeMs ?? BASE_TIME })
  noteTimes.set(rel, mtimeMs ?? BASE_TIME)
}

const FIXTURE_NOTES = [
  'Welcome.md',
  'notes/english-note.md',
  'notes/chinese-note.md',
  'notes/tasks.md',
  'notes/duplicate-a.md',
  'notes/duplicate-b.md',
  'notes/malformed.md',
  'notes/no-frontmatter.md',
  'notes/huge.md',
  'notes/empty.md',
  'projects/alpha.md',
  'projects/beta.md',
  'projects/gamma.md',
  'daily/2026-11-05.md',
  'daily/2026-11-04.md',
]

function createFixture() {
  fs.mkdirSync(ROOT, { recursive: true })

  note(
    'Welcome.md',
    `---
title: Welcome to the Hub
tags: [welcome, start]
aliases: [Home, 首页]
status: active
priority: high
---
# Welcome

This vault is a fixture for the search engine. See [[欢迎]] for the Chinese
entry point and [[projects/alpha|Alpha project]] for work.

- [ ] read the architecture contract
- [x] create the fixture
`,
    BASE_TIME,
  )

  note(
    'notes/english-note.md',
    `---
tags: [notes, english]
status: active
priority: medium
---
# English Note

The quick brown fox jumps over the lazy dog. zebraquartz is the unique marker
for text search.

## Details

More English prose about knowledge bases, note taking and local filesystem
search.
`,
    BASE_TIME,
  )

  note(
    'notes/chinese-note.md',
    `---
tags: [笔记, 中文/写作]
status: active
priority: medium
---
# 中文笔记

这篇笔记讨论知识管理、双链笔记与本地搜索。

关键词：量子纠缠 出现在欢迎笔记里，这里用「中文检索」作为唯一标记。

## 小节
- [[欢迎]]
`,
    BASE_TIME,
  )

  note(
    'notes/tasks.md',
    `---
tags: [tasks]
---
# Task List

- [ ] open task alpha
- [x] done task beta
- [ ] open task gamma
`,
    BASE_TIME + 2_000,
  )

  note(
    'notes/duplicate-a.md',
    `---
title: Duplicate
tags: [dupe]
---
# Duplicate A

Body A with the marker dupa.
`,
    BASE_TIME,
  )

  note(
    'notes/duplicate-b.md',
    `---
title: Duplicate
tags: [dupe]
---
# Duplicate B

Body B with the marker dupb.
`,
    BASE_TIME,
  )

  note(
    'notes/malformed.md',
    `---
tags: [broken
status: : :
---
# Malformed Frontmatter

The YAML above is invalid on purpose; the body must survive with malformedtoken.
`,
    BASE_TIME,
  )

  note(
    'notes/no-frontmatter.md',
    `# Plain Note

No frontmatter here at all. Unique token plainzeta. Inline tag: #plain
`,
    BASE_TIME,
  )

  note(
    'notes/huge.md',
    `---\ntags: [huge]
---
# Huge Note

HUGEONLYTOKEN appears only in this oversized note.

${'lorem ipsum dolor sit amet '.repeat(400)}
`,
    BASE_TIME,
  )

  note('notes/empty.md', '', BASE_TIME)

  note(
    'projects/alpha.md',
    `---
title: Alpha Project
tags: [project/alpha, project]
status: active
priority: high
aliases: [Alpha]
---
# Alpha Project

Links to [[projects/beta]] and [[Welcome]].

- [ ] ship alpha
- [x] plan alpha
`,
    BASE_TIME + 1_000,
  )

  note(
    'projects/beta.md',
    `---
tags: [project/beta, project]
status: done
priority: low
---
# Beta Project

Links back to [[projects/alpha]].
`,
    BASE_TIME,
  )

  note(
    'projects/gamma.md',
    `---
tags: [project/gamma]
status: paused
---
# Gamma Project

Paused until alpha lands.
`,
    BASE_TIME,
  )

  note(
    'daily/2026-11-05.md',
    `---
tags: [daily]
date: 2026-11-05
---
# 2026-11-05

- [ ] standup
- [x] review PR
`,
    BASE_TIME + 3_000,
  )

  note(
    'daily/2026-11-04.md',
    `---
tags: [daily]
date: 2026-11-04
---
# 2026-11-04

- [x] write fixture
`,
    BASE_TIME,
  )

  // excluded / non-indexable
  write('.trash/trashed.md', '# Trashed\n\nmust be excluded by the vault.\n')
  write('notes/binary.md', Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0x48, 0x69]))
  write('.obsidian/app.json', JSON.stringify({ newFileLocation: 'folder' }))
}

function makeCtx() {
  const registered = new Map()
  const ctx = {
    tools: {
      register(definition) {
        if (registered.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`)
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
  }
  return { ctx, registered }
}

/** Minimal mirror of the harness' supported JSON-Schema subset. */
const SCHEMA_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
])

function assertSupportedSchema(node, at = 'schema') {
  assert.ok(node && typeof node === 'object' && !Array.isArray(node), `${at} must be an object`)
  for (const key of Object.keys(node)) assert.ok(SCHEMA_KEYWORDS.has(key), `${at}.${key} is not a supported keyword`)
  if ('required' in node) {
    assert.ok(Array.isArray(node.required), `${at}.required must be an array`)
    for (const entry of node.required) assert.equal(typeof entry, 'string', `${at}.required entries must be strings`)
    for (const entry of node.required) assert.ok(entry in (node.properties || {}), `${at}.required names ${entry} missing from properties`)
  }
  if (node.properties) {
    for (const [key, child] of Object.entries(node.properties)) assertSupportedSchema(child, `${at}.properties.${key}`)
  }
  if (node.items) assertSupportedSchema(node.items, `${at}.items`)
  assert.equal(JSON.stringify(node).includes('"required":true'), false, `${at} still contains an inline required:true marker`)
}

/** Assert a tool result matches its declared output schema (subset). */
function assertCovers(schema, value, at = 'value') {
  const type = schema.type
  if (type === 'object') {
    assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${at} must be an object`)
    const props = schema.properties || {}
    for (const key of schema.required || []) assert.ok(key in value, `${at}.${key} is required`)
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) assert.ok(key in props, `${at}.${key} is undeclared (additionalProperties:false)`)
    }
    for (const [key, child] of Object.entries(props)) {
      if (key in value && value[key] !== undefined) assertCovers(child, value[key], `${at}.${key}`)
    }
    return
  }
  if (type === 'array') {
    assert.ok(Array.isArray(value), `${at} must be an array`)
    if (schema.items) value.forEach((item, index) => assertCovers(schema.items, item, `${at}[${index}]`))
    return
  }
  const checks = {
    string: (v) => typeof v === 'string',
    integer: Number.isInteger,
    number: (v) => typeof v === 'number' && Number.isFinite(v),
    boolean: (v) => typeof v === 'boolean',
    null: (v) => v === null,
  }
  if (checks[type]) assert.ok(checks[type](value), `${at} must be ${type}, got ${JSON.stringify(value)}`)
}

// ---------------------------------------------------------------------------
// shared fixture index
// ---------------------------------------------------------------------------

let vault
let index

before(async () => {
  createFixture()
  vault = makeVault(ROOT)
  index = new VaultIndex(vault, { maxFiles: 500, maxTotalBytes: 64 * 1024 * 1024, ttlMs: 0 })
  await index.ensureFresh({ ttlMs: 0 })
})

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

// ---------------------------------------------------------------------------
// index
// ---------------------------------------------------------------------------

test('index builds with notes, folders, tags, links and bytes', () => {
  const stats = index.stats
  assert.equal(stats.ready, true)
  assert.equal(stats.notes, FIXTURE_NOTES.length, 'every markdown note except the binary one is indexed')
  assert.ok(stats.folders >= 3, `expected >= 3 folders, got ${stats.folders}`)
  assert.ok(stats.tags >= 10, `expected tags, got ${stats.tags}`)
  assert.ok(stats.links >= 5, `expected links, got ${stats.links}`)
  assert.ok(stats.bytes > 0)
  assert.ok(stats.builtAt > 0)
  assert.equal(typeof stats.tookMs, 'number')
  assert.equal(stats.truncated, false)
})

test('index excludes .trash, skips binary notes and handles empty files', () => {
  assert.equal(index.record('.trash/trashed.md'), undefined)
  assert.equal(index.record('notes/binary.md'), undefined, 'NUL-byte markdown is skipped, not parsed')
  const empty = index.record('notes/empty.md')
  assert.ok(empty, 'empty.md is indexed')
  assert.equal(empty.body, '')
  assert.equal(empty.title, 'empty')
  assert.equal(empty.wordCount, 0)
})

test('record exposes the documented FileRecord shape', () => {
  const record = index.record('Welcome.md')
  assert.ok(record)
  assert.equal(record.rel, 'Welcome.md')
  assert.equal(record.title, 'Welcome to the Hub')
  assert.ok(record.frontmatter && record.frontmatter.status === 'active')
  assert.ok(Array.isArray(record.tags) && record.tags.includes('welcome'))
  assert.ok(Array.isArray(record.links) && record.links.some((link) => link.target === 'projects/alpha' && link.rel === 'projects/alpha.md'))
  assert.ok(Array.isArray(record.headings) && record.headings.some((heading) => heading.text === 'Welcome'))
  assert.deepEqual(record.tasks, { total: 2, open: 1, done: 1 })
  assert.ok(record.wordCount > 0)
  assert.ok(record.lcText.includes('fixture'))
  assert.equal(typeof record.mtimeMs, 'number')
  assert.equal(typeof record.size, 'number')
})

test('malformed frontmatter never breaks indexing', () => {
  const record = index.record('notes/malformed.md')
  assert.ok(record, 'malformed note is still indexed')
  assert.ok(record.body.includes('body must survive'))
  const found = search(index, { mode: 'text', query: 'malformedtoken' })
  assert.equal(found.total, 1)
  assert.equal(found.results[0].rel, 'notes/malformed.md')
})

test('tagIndex / propertyIndex / backlinks / recent helpers behave', () => {
  const projectNotes = [...(index.tagIndex.get('project') ?? [])].sort()
  assert.deepEqual(projectNotes, ['projects/alpha.md', 'projects/beta.md'])
  assert.ok((index.tagIndex.get('中文/写作') ?? new Set()).has('notes/chinese-note.md'))
  assert.ok(index.propertyIndex.get('status').get('active').has('Welcome.md'))
  assert.ok(index.propertyIndex.get('priority').get('high').has('projects/alpha.md'))
  assert.ok(index.backlinksOf('Welcome.md').some((entry) => entry.from === 'projects/alpha.md'))
  assert.ok(index.backlinksOf('projects/alpha.md').some((entry) => entry.from === 'projects/beta.md'))
  assert.equal(index.recent(1)[0].rel, 'daily/2026-11-05.md')
})

test('resolveNote handles path, basename, title, alias and wiki targets', () => {
  assert.equal(index.resolveNote('Welcome.md'), 'Welcome.md')
  assert.equal(index.resolveNote('Welcome'), 'Welcome.md')
  assert.equal(index.resolveNote('projects/alpha.md'), 'projects/alpha.md')
  assert.equal(index.resolveNote('projects/alpha'), 'projects/alpha.md')
  assert.equal(index.resolveNote('alpha'), 'projects/alpha.md')
  assert.equal(index.resolveNote('Alpha'), 'projects/alpha.md', 'frontmatter alias resolves')
  assert.equal(index.resolveNote('中文笔记'), 'notes/chinese-note.md')
  assert.equal(index.resolveNote('does-not-exist'), undefined)
})

test('duplicate titles resolve deterministically', () => {
  const resolved = index.resolveNote('Duplicate')
  assert.equal(resolved, 'notes/duplicate-a.md')
  const found = search(index, { mode: 'text', query: 'duplicate' })
  assert.equal(found.total, 2, 'both duplicate-title notes remain searchable')
})

// ---------------------------------------------------------------------------
// text search
// ---------------------------------------------------------------------------

test('tokenize produces CJK bigrams and lowercase Latin words', () => {
  assert.deepEqual(tokenize('量子纠缠'), ['量子', '子纠', '纠缠'])
  assert.deepEqual(tokenize('中'), ['中'])
  assert.deepEqual(tokenize('Hello World'), ['hello', 'world'])
  assert.deepEqual(tokenize('中文 hello'), ['中文', 'hello'])
  assert.deepEqual(tokenize('   '), [])
  assert.deepEqual(tokenize('\u{20000}\u{20001}'), ['\u{20000}\u{20001}'], 'supplementary CJK keeps surrogate pairs intact')
})

test('text search ranks the obvious title hit first and gives snippets', () => {
  const found = search(index, { mode: 'text', query: 'alpha project' })
  assert.ok(found.total >= 2)
  assert.equal(found.results[0].rel, 'projects/alpha.md')
  assert.equal(typeof found.results[0].score, 'number')
  assert.ok(found.results[0].score > 0)
  assert.ok(found.results[0].snippet.includes('Alpha'), 'snippet contains the matching line')
  assert.ok(Number.isInteger(found.results[0].line))
  assert.equal(found.results[0].line, 8, 'line is the absolute 1-based file line')
})

test('text search works for Chinese with bigrams', () => {
  const found = search(index, { mode: 'text', query: '量子纠缠' })
  assert.equal(found.total, 1)
  assert.equal(found.results[0].rel, 'notes/chinese-note.md')
  assert.ok(found.results[0].snippet.includes('量子纠缠'))

  const knowledge = search(index, { mode: 'text', query: '知识管理' })
  assert.equal(knowledge.total, 1)
  assert.equal(knowledge.results[0].rel, 'notes/chinese-note.md')

  const mixed = search(index, { mode: 'text', query: '中文检索' })
  assert.equal(mixed.total, 1)
})

test('text search requires ALL tokens to match (AND semantics)', () => {
  assert.equal(search(index, { mode: 'text', query: 'zebraquartz standup' }).total, 0)
  assert.equal(search(index, { mode: 'text', query: 'zebraquartz knowledge' }).total, 1, 'both live in one note')
  assert.ok(search(index, { mode: 'text', query: 'zebraquartz search' }).total >= 1)
})

test('text search also matches note titles alone', () => {
  const found = search(index, { mode: 'text', query: 'plain note' })
  assert.ok(found.results.some((result) => result.rel === 'notes/no-frontmatter.md'))
})

test('text search handles empty query and no results', () => {
  const empty = search(index, { mode: 'text', query: '' })
  assert.deepEqual(empty.results, [])
  assert.equal(empty.total, 0)
  assert.equal(empty.truncated, false)
  const none = search(index, { mode: 'text', query: 'this-token-does-not-exist' })
  assert.equal(none.total, 0)
  assert.equal(typeof none.tookMs, 'number')
})

test('text search paging is stable and reports truncated', () => {
  const all = search(index, { mode: 'text', query: 'project', limit: 200 })
  assert.ok(all.total >= 3)
  const page1 = search(index, { mode: 'text', query: 'project', limit: 2, offset: 0 })
  const page2 = search(index, { mode: 'text', query: 'project', limit: 2, offset: 2 })
  assert.equal(page1.total, all.total)
  assert.equal(page1.results.length, Math.min(2, all.total))
  assert.equal(page2.total, all.total)
  assert.notDeepEqual(
    page1.results.map((entry) => entry.rel),
    page2.results.map((entry) => entry.rel),
  )
  assert.equal(page1.truncated, all.total > 2)
})

test('text search honors path, glob and modifiedAfter filters', () => {
  const globbed = search(index, { mode: 'text', query: 'project', glob: 'projects/**' })
  assert.ok(globbed.total > 0)
  for (const result of globbed.results) assert.ok(result.rel.startsWith('projects/'))

  const inNotes = search(index, { mode: 'text', query: 'project', path: 'notes' })
  for (const result of inNotes.results) assert.ok(result.rel.startsWith('notes/'))

  const future = search(index, { mode: 'text', query: 'project', modifiedAfter: '2999-01-01' })
  assert.equal(future.total, 0)

  const since = search(index, {
    mode: 'text',
    query: 'project',
    modifiedAfter: new Date(BASE_TIME + 500).toISOString(),
  })
  assert.deepEqual(since.results.map((result) => result.rel), ['projects/alpha.md'])
})

test('globToRegExp supports *, ** and ?', () => {
  assert.ok(globToRegExp('notes/**').test('notes/a/b.md'))
  assert.ok(globToRegExp('*.md').test('Welcome.md'))
  assert.equal(globToRegExp('*.md').test('notes/a.md'), false)
  assert.ok(globToRegExp('daily/2026-11-0?.md').test('daily/2026-11-05.md'))
})

// ---------------------------------------------------------------------------
// phrase / regex
// ---------------------------------------------------------------------------

test('phrase mode finds an exact phrase and returns its line', () => {
  const found = search(index, { mode: 'phrase', query: 'quick brown fox' })
  assert.equal(found.total, 1)
  assert.equal(found.results[0].rel, 'notes/english-note.md')
  assert.ok(found.results[0].snippet.includes('quick brown fox'))
  assert.equal(found.results[0].line, 8)
  assert.equal(search(index, { mode: 'phrase', query: 'brown quick' }).total, 0)
})

test('regex mode works and invalid regexes fail loudly', () => {
  const found = search(index, { mode: 'regex', regex: 'zebra[a-z]+' })
  assert.equal(found.total, 1)
  assert.equal(found.results[0].rel, 'notes/english-note.md')
  assert.ok(found.results[0].snippet.toLowerCase().includes('zebraquartz'))
  assert.equal(search(index, { mode: 'regex', regex: '^#{1,6} Details$' }).total, 1)
  assert.throws(() => search(index, { mode: 'regex', regex: '([' }), /invalid regex/i)
})

// ---------------------------------------------------------------------------
// tag / property
// ---------------------------------------------------------------------------

test('tag mode matches tags, descendants and wildcards', () => {
  const exact = search(index, { mode: 'tag', tag: 'project/gamma' })
  assert.deepEqual(exact.results.map((result) => result.rel), ['projects/gamma.md'])

  const parent = search(index, { mode: 'tag', tag: '#project' })
  assert.deepEqual(parent.results.map((result) => result.rel).sort(), [
    'projects/alpha.md',
    'projects/beta.md',
    'projects/gamma.md',
  ])

  const wildcard = search(index, { mode: 'tag', tag: 'project/*' })
  assert.equal(wildcard.total, 3)

  const chinese = search(index, { mode: 'tag', tag: '中文/写作' })
  assert.deepEqual(chinese.results.map((result) => result.rel), ['notes/chinese-note.md'])

  assert.equal(search(index, { mode: 'tag', tag: 'nope' }).total, 0)
  assert.equal(search(index, { mode: 'tag', tag: '' }).total, 0)
})

test('property mode matches keys, values and wildcards', () => {
  const active = search(index, { mode: 'property', property: { key: 'status', value: 'active' } })
  assert.deepEqual(active.results.map((result) => result.rel).sort(), [
    'Welcome.md',
    'notes/chinese-note.md',
    'notes/english-note.md',
    'projects/alpha.md',
  ])
  assert.ok(active.results[0].snippet.includes('status: active'))

  const keyOnly = search(index, { mode: 'property', property: { key: 'priority' } })
  assert.equal(keyOnly.total, 5)

  const caseInsensitive = search(index, { mode: 'property', propertyKey: 'STATUS', propertyValue: 'done' })
  assert.deepEqual(caseInsensitive.results.map((result) => result.rel), ['projects/beta.md'])

  const wildcard = search(index, { mode: 'property', propertyKey: 'status', propertyValue: 'act*' })
  assert.equal(wildcard.total, 4)

  assert.equal(search(index, { mode: 'property', property: { key: 'missing' } }).total, 0)
})

// ---------------------------------------------------------------------------
// link / files / recent / headings / tasks
// ---------------------------------------------------------------------------

test('link mode returns backlinks for a resolved note', () => {
  const found = search(index, { mode: 'link', note: 'Welcome' })
  assert.ok(found.results.some((result) => result.rel === 'projects/alpha.md'))
  assert.ok(found.results.every((result) => typeof result.snippet === 'string'))

  const chinese = search(index, { mode: 'link', note: '欢迎' })
  assert.ok(chinese.results.some((result) => result.rel === 'notes/chinese-note.md'))
  assert.equal(search(index, { mode: 'link', note: 'nothing-links-here' }).total, 0)
  assert.equal(search(index, { mode: 'link', note: '' }).total, 0)
})

test('files mode lists notes by path/title with filters', () => {
  const notes = search(index, { mode: 'files', glob: 'notes/**' })
  assert.equal(notes.total, listMarkdown(ROOT).filter((rel) => rel.startsWith('notes/') && rel !== 'notes/binary.md').length)

  const daily = search(index, { mode: 'files', query: 'daily' })
  assert.deepEqual(daily.results.map((result) => result.rel), ['daily/2026-11-04.md', 'daily/2026-11-05.md'])

  const titled = search(index, { mode: 'files', query: 'welcome to the hub' })
  assert.deepEqual(titled.results.map((result) => result.rel), ['Welcome.md'])
})

test('recent mode is newest-first and honors filters', () => {
  const found = search(index, { mode: 'recent', limit: 3 })
  assert.deepEqual(found.results.map((result) => result.rel), [
    'daily/2026-11-05.md',
    'notes/tasks.md',
    'projects/alpha.md',
  ])
  assert.deepEqual(index.recent(3).map((record) => record.rel), found.results.map((result) => result.rel))

  const filtered = search(index, { mode: 'recent', limit: 5, glob: 'daily/**' })
  assert.deepEqual(filtered.results.map((result) => result.rel), ['daily/2026-11-05.md', 'daily/2026-11-04.md'])
})

test('headings mode reports level and absolute line', () => {
  const found = search(index, { mode: 'headings', query: 'Details' })
  assert.equal(found.total, 1)
  const hit = found.results[0]
  assert.equal(hit.rel, 'notes/english-note.md')
  assert.equal(hit.level, 2)
  const lines = fs.readFileSync(path.join(ROOT, hit.rel), 'utf8').split(/\r?\n/)
  assert.equal(lines[hit.line - 1].trim(), '## Details', 'line points at the heading in the real file')
  assert.ok(hit.snippet.startsWith('##'))

  const all = search(index, { mode: 'headings', limit: 200 })
  assert.ok(all.total >= 10)
})

test('tasks mode filters open/done and text', () => {
  const open = search(index, { mode: 'tasks', query: 'open' })
  assert.ok(open.total >= 3)
  for (const result of open.results) assert.equal(result.checked, false)
  assert.ok(open.results.some((result) => result.rel === 'notes/tasks.md'))

  const done = search(index, { mode: 'tasks', query: 'done' })
  assert.ok(done.total >= 2)
  for (const result of done.results) assert.equal(result.checked, true)

  const standup = search(index, { mode: 'tasks', query: 'standup' })
  assert.equal(standup.total, 1)
  const hit = standup.results[0]
  assert.equal(hit.rel, 'daily/2026-11-05.md')
  const lines = fs.readFileSync(path.join(ROOT, hit.rel), 'utf8').split(/\r?\n/)
  assert.ok(lines[hit.line - 1].includes('standup'))

  const all = search(index, { mode: 'tasks', limit: 200 })
  const expected = FIXTURE_NOTES.reduce((sum, rel) => {
    const record = index.record(rel)
    return sum + (record ? record.tasks.total : 0)
  }, 0)
  assert.equal(all.total, expected)
})

// ---------------------------------------------------------------------------
// size limits, incremental freshness
// ---------------------------------------------------------------------------

test('oversized notes are capped and flagged, not dropped', async () => {
  const capped = new VaultIndex(vault, { maxFiles: 500, maxTotalBytes: 64 * 1024 * 1024, maxFileBytes: 1024 })
  await capped.ensureFresh({ ttlMs: 0 })
  const record = capped.record('notes/huge.md')
  assert.ok(record, 'a huge note is indexed with a capped body')
  assert.ok(record.body.length <= 1024, `body capped, got ${record.body.length}`)
  assert.equal(capped.stats.capped >= 1, true, 'body capping is reported as `capped`')
  assert.equal(capped.stats.truncated, false, 'body capping does not hide whole notes from the index')
  const found = search(capped, { mode: 'text', query: 'HUGEONLYTOKEN' })
  assert.equal(found.total, 1)
})

test('maxFiles truncates the index and reports truncated', async () => {
  const limited = new VaultIndex(vault, { maxFiles: 5, maxTotalBytes: 64 * 1024 * 1024 })
  await limited.ensureFresh({ ttlMs: 0 })
  assert.equal(limited.stats.notes, 5)
  assert.equal(limited.stats.truncated, true)
  const again = new VaultIndex(vault, { maxFiles: 500, maxTotalBytes: 64 * 1024 * 1024 })
  await again.ensureFresh({ ttlMs: 0 })
  assert.equal(again.stats.truncated, false)
})

test('an empty vault indexes and answers every mode without errors', async () => {
  const dir = path.join(TMP, `dsh-hub-empty-${process.pid}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  try {
    const emptyIndex = new VaultIndex(makeVault(dir), { maxFiles: 10, maxTotalBytes: 1024 * 1024 })
    await emptyIndex.ensureFresh({ ttlMs: 0 })
    const stats = emptyIndex.stats
    assert.equal(stats.ready, true)
    assert.equal(stats.notes, 0)
    assert.equal(stats.folders, 0)
    assert.equal(stats.tags, 0)
    assert.equal(stats.links, 0)
    assert.equal(stats.bytes, 0)
    assert.equal(stats.truncated, false)
    assert.equal(stats.reads, 0)
    assert.equal(stats.capped, 0)
    assert.equal(typeof stats.tookMs, 'number')
    for (const params of [
      { mode: 'text', query: 'x' },
      { mode: 'phrase', query: 'x' },
      { mode: 'regex', regex: 'x' },
      { mode: 'tag', tag: 'x' },
      { mode: 'property', property: { key: 'k' } },
      { mode: 'link', note: 'n' },
      { mode: 'files' },
      { mode: 'recent' },
      { mode: 'headings', query: 'h' },
      { mode: 'tasks', query: 'open' },
    ]) {
      const result = search(emptyIndex, params)
      assert.equal(result.total, 0, `mode ${params.mode} on an empty vault`)
      assert.deepEqual(result.results, [])
    }
    assert.deepEqual(emptyIndex.recent(5), [])
    assert.deepEqual(emptyIndex.backlinksOf('nope.md'), [])
    assert.equal(emptyIndex.resolveNote('nope'), undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('ensureFresh is stat-only for unchanged notes and re-reads changed ones', async () => {
  const dir = path.join(TMP, `dsh-hub-fresh-${process.pid}`)
  fs.rmSync(dir, { recursive: true, force: true })
  const mk = (rel, content) => {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf8')
    return abs
  }
  mk('a.md', '---\ntags: [alpha]\n---\n# A\n\nfirst note token alpha.\n')
  mk('b.md', '# B\n\nsecond note token beta.\n')
  mk('c.md', '---\nstatus: active\n---\n# C\n\nthird note token gamma.\n')

  try {
    const freshVault = makeVault(dir)
    const fresh = new VaultIndex(freshVault, { maxFiles: 100, maxTotalBytes: 1024 * 1024, ttlMs: 0 })
    await fresh.ensureFresh({ ttlMs: 0 })
    const baseline = fresh.stats.reads
    assert.equal(baseline, 3, 'one content read per note on first build')
    const builtAt = fresh.stats.builtAt
    const recordA = fresh.record('a.md')

    // Same mtime/size → no content re-read, same object identity.
    await fresh.ensureFresh({ ttlMs: 0 })
    assert.equal(fresh.stats.reads, baseline, 'unchanged notes are not re-read')
    assert.equal(fresh.record('a.md'), recordA, 'unchanged records are reused, not reparsed')
    assert.ok(fresh.stats.builtAt >= builtAt)

    // TTL fast path: returns without walking at all.
    await fresh.ensureFresh({ ttlMs: 60_000 })
    assert.equal(fresh.stats.reads, baseline, 'TTL fast path performs no reads')

    // New file → exactly one more read.
    mk('d.md', '# D\n\nbrandnewtoken lives here.\n')
    await fresh.ensureFresh({ ttlMs: 0 })
    assert.equal(fresh.stats.reads, baseline + 1, 'only the new note is read')
    assert.equal(search(fresh, { mode: 'text', query: 'brandnewtoken' }).total, 1)

    // Modified file → exactly one more read (mtime bumped explicitly).
    const aPath = path.join(dir, 'a.md')
    fs.appendFileSync(aPath, '\nappendedmarker after edit.\n', 'utf8')
    const bumped = new Date(Date.now() + 5_000)
    fs.utimesSync(aPath, bumped, bumped)
    await fresh.ensureFresh({ ttlMs: 0 })
    assert.equal(fresh.stats.reads, baseline + 2, 'only the modified note is re-read')
    assert.equal(search(fresh, { mode: 'text', query: 'appendedmarker' }).total, 1)

    // Deleted file disappears from the index.
    fs.rmSync(path.join(dir, 'b.md'))
    await fresh.ensureFresh({ ttlMs: 0 })
    assert.equal(fresh.record('b.md'), undefined)
    assert.equal(search(fresh, { mode: 'text', query: 'second note' }).total, 0)
    assert.equal(fresh.stats.reads, baseline + 2, 'deletions need no content reads')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

// ---------------------------------------------------------------------------
// tool registration / execute / render
// ---------------------------------------------------------------------------

test('registerSearchTools registers exactly one normalized tool', () => {
  const { ctx, registered } = makeCtx()
  const dispose = registerSearchTools(ctx, { index: async () => index })
  assert.equal(typeof dispose, 'function')
  assert.deepEqual([...registered.keys()], ['obsidian_search'])

  const def = registered.get('obsidian_search')
  assert.ok(def.description.length >= 20)
  assert.equal(typeof def.execute, 'function')
  assert.equal(typeof def.output.render, 'function')
  assert.equal(typeof def.presentCall, 'function')

  // parameters were normalized into a JSON-Schema object root.
  assert.equal(def.parameters.type, 'object')
  assert.ok(def.parameters.properties.mode)
  assert.deepEqual(def.parameters.required, ['mode'])
  for (const [key, prop] of Object.entries(def.parameters.properties)) {
    assert.equal(typeof prop.description, 'string', `${key} needs a description`)
    assert.equal('required' in prop, false, `${key} keeps requiredness in the root required[]`)
  }
  assert.deepEqual(def.parameters.properties.mode.enum, [
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
  ])

  assertSupportedSchema(def.output.schema, 'obsidian_search.output.schema')
  assert.ok(def.output.schema.required.includes('results'))

  dispose()
  assert.equal(registered.size, 0, 'disposer unregisters the tool')
})

test('obsidian_search executes every mode and renders text blocks', async () => {
  const { ctx, registered } = makeCtx()
  const dispose = registerSearchTools(ctx, { index: async () => index })
  const def = registered.get('obsidian_search')

  const run = async (args) => {
    const value = await def.execute(args)
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value, 'result must be JSON-serializable')
    assertCovers(def.output.schema, value, 'obsidian_search')
    const blocks = def.output.render(args, value)
    assert.ok(Array.isArray(blocks) && blocks.length > 0)
    assert.equal(blocks[0].type, 'text')
    assert.equal(typeof blocks[0].text, 'string')
    assert.ok(blocks[0].text.length > 0)
    return { value, text: blocks[0].text }
  }

  const stats = await run({ mode: 'stats' })
  assert.equal(stats.value.stats.notes, FIXTURE_NOTES.length)
  assert.ok(stats.text.includes('Obsidian index'))
  assert.ok(stats.text.includes(`${FIXTURE_NOTES.length} notes`))

  const text = await run({ mode: 'text', query: 'zebraquartz' })
  assert.equal(text.value.mode, 'text')
  assert.equal(text.value.results[0].rel, 'notes/english-note.md')
  assert.ok(text.text.includes('obsidian_search(text)'))
  assert.ok(text.text.includes('notes/english-note.md'))

  const defaulted = await run({ query: 'alpha project' })
  assert.equal(defaulted.value.mode, 'text')
  assert.equal(defaulted.value.results[0].rel, 'projects/alpha.md')

  const regex = await run({ mode: 'regex', regex: 'zebra[a-z]+' })
  assert.equal(regex.value.results[0].rel, 'notes/english-note.md')

  const phrase = await run({ mode: 'phrase', query: 'quick brown fox' })
  assert.equal(phrase.value.total, 1)

  const tag = await run({ mode: 'tag', tag: 'project' })
  assert.equal(tag.value.total, 3)

  const property = await run({ mode: 'property', propertyKey: 'status', propertyValue: 'done' })
  assert.deepEqual(property.value.results.map((result) => result.rel), ['projects/beta.md'])

  const link = await run({ mode: 'link', note: 'Welcome' })
  assert.ok(link.value.results.some((result) => result.rel === 'projects/alpha.md'))

  const files = await run({ mode: 'files', glob: 'daily/**' })
  assert.equal(files.value.total, 2)

  const recent = await run({ mode: 'recent', limit: 1 })
  assert.equal(recent.value.results[0].rel, 'daily/2026-11-05.md')

  const headings = await run({ mode: 'headings', query: 'Details' })
  assert.equal(headings.value.total, 1)

  const tasks = await run({ mode: 'tasks', query: 'standup' })
  assert.equal(tasks.value.total, 1)

  const paged = await run({ mode: 'files', glob: 'notes/**', limit: 3, offset: 1, contextLines: 0 })
  assert.equal(paged.value.results.length, 3)
  assert.equal(paged.value.total, search(index, { mode: 'files', glob: 'notes/**' }).total)

  const empty = await run({ mode: 'text', query: '' })
  assert.equal(empty.value.total, 0)
  assert.ok(empty.text.includes('no matches'))

  dispose()
})

test('obsidian_search renders within the 8000 char budget', async () => {
  const { ctx, registered } = makeCtx()
  const dispose = registerSearchTools(ctx, { index: async () => index })
  const def = registered.get('obsidian_search')
  const args = { mode: 'tasks', query: '', limit: 200, contextLines: 2 }
  const value = await def.execute(args)
  const text = def.output.render(args, value)[0].text
  assert.ok(text.length <= 8_300, `render capped, got ${text.length}`)
  dispose()
})

test('obsidian_search surfaces vault failures instead of swallowing them', async () => {
  const { ctx, registered } = makeCtx()
  const dispose = registerSearchTools(ctx, {
    index: async () => {
      throw new Error('vault unavailable')
    },
  })
  const def = registered.get('obsidian_search')
  await assert.rejects(() => def.execute({ mode: 'text', query: 'x' }), /vault unavailable/)
  dispose()
})

// ---------------------------------------------------------------------------
// performance
// ---------------------------------------------------------------------------

test('400-note vault indexes and searches fast', async () => {
  const dir = path.join(TMP, `dsh-hub-perf-${process.pid}`)
  fs.rmSync(dir, { recursive: true, force: true })
  const words = ['lattice', 'garden', 'kernel', 'signal', 'harbor', 'meadow', 'cascade', 'ember']
  try {
    for (let i = 0; i < 400; i += 1) {
      const id = String(i).padStart(4, '0')
      const group = String(i % 7).padStart(2, '0')
      const marker = i % 10 === 0 ? ' needleword ' : ' '
      const zh = i % 5 === 0 ? '中文内容' : 'english content'
      const rel = `perf/group-${group}/note-${id}.md`
      const abs = path.join(dir, rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(
        abs,
        `---
tags: [perf, group/${group}]
status: ${i % 3 === 0 ? 'active' : 'done'}
priority: ${i % 4 === 0 ? 'high' : 'low'}
---
# Perf Note ${id}

${words[i % words.length]} ${words[(i * 3 + 1) % words.length]}${marker}${zh} for note ${id}.

- [ ] task ${id}
- [x] done ${id}

Link: [[perf/group-${group}/note-${String((i + 1) % 400).padStart(4, '0')}]]
`,
        'utf8',
      )
    }

    const perfVault = makeVault(dir)
    const perfIndex = new VaultIndex(perfVault, { maxFiles: 5_000, maxTotalBytes: 64 * 1024 * 1024, ttlMs: 0 })
    const buildStarted = performance.now()
    await perfIndex.ensureFresh({ ttlMs: 0 })
    const buildMs = performance.now() - buildStarted

    const medians = {}
    const measure = (label, params) => {
      for (let i = 0; i < 5; i += 1) search(perfIndex, params) // warm up
      const samples = []
      for (let i = 0; i < 15; i += 1) {
        const started = performance.now()
        const result = search(perfIndex, params)
        samples.push(performance.now() - started)
        assert.ok(result.total > 0, `${label} should match notes`)
      }
      samples.sort((a, b) => a - b)
      medians[label] = samples[Math.floor(samples.length / 2)]
    }
    measure('text-en', { mode: 'text', query: 'needleword' })
    measure('text-zh', { mode: 'text', query: '中文内容' })
    measure('tag', { mode: 'tag', tag: 'group/03' })
    measure('property', { mode: 'property', property: { key: 'status', value: 'active' } })

    const refreshStarted = performance.now()
    await perfIndex.ensureFresh({ ttlMs: 0 })
    const refreshMs = performance.now() - refreshStarted

    console.log(
      `[perf] notes=${perfIndex.stats.notes} build=${buildMs.toFixed(1)}ms ` +
        `refresh(stat-only)=${refreshMs.toFixed(1)}ms ` +
        `text-en=${medians['text-en'].toFixed(2)}ms text-zh=${medians['text-zh'].toFixed(2)}ms ` +
        `tag=${medians.tag.toFixed(2)}ms property=${medians.property.toFixed(2)}ms`,
    )

    assert.equal(perfIndex.stats.notes, 400)
    assert.ok(buildMs < 10_000, `build took ${buildMs.toFixed(1)}ms`)
    assert.ok(refreshMs < 2_000, `stat-only refresh took ${refreshMs.toFixed(1)}ms`)
    assert.ok(medians['text-en'] < 50, `text-en search took ${medians['text-en'].toFixed(2)}ms`)
    assert.ok(medians['text-zh'] < 50, `text-zh search took ${medians['text-zh'].toFixed(2)}ms`)
    assert.ok(medians.tag < 50, `tag search took ${medians.tag.toFixed(2)}ms`)
    assert.ok(medians.property < 50, `property search took ${medians.property.toFixed(2)}ms`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

// ---------------------------------------------------------------------------
// real vault (read-only smoke test)
// ---------------------------------------------------------------------------

test(
  'real vault indexes and searches read-only without errors',
  { skip: fs.existsSync(REAL_VAULT) ? false : `real vault ${REAL_VAULT} not found` },
  async () => {
    const realConfig = resolveConfig({ vaultPath: REAL_VAULT })
    const realVault = createVault({
      root: REAL_VAULT,
      exclude: realConfig.exclude,
      maxFileBytes: realConfig.maxFileBytes,
      trashMode: realConfig.trashMode,
    })
    const realIndex = new VaultIndex(realVault, {
      maxFiles: realConfig.indexMaxFiles,
      maxTotalBytes: realConfig.indexMaxTotalBytes,
      ttlMs: 0,
    })
    const started = performance.now()
    await realIndex.ensureFresh({ ttlMs: 0 })
    const buildMs = performance.now() - started
    console.log(`[real-vault] notes=${realIndex.stats.notes} build=${buildMs.toFixed(1)}ms bytes=${realIndex.stats.bytes}`)
    assert.ok(realIndex.stats.ready)
    assert.ok(realIndex.stats.notes >= 1, 'the real vault has at least one note')

    const chinese = search(realIndex, { mode: 'text', query: '仓库' })
    assert.ok(chinese.total >= 1, 'Chinese text search finds the welcome note body')
    assert.ok(chinese.results.every((result) => result.rel.endsWith('.md')))

    const files = search(realIndex, { mode: 'files', query: '欢迎' })
    assert.ok(files.total >= 1, 'file search finds the Chinese-named note')

    const stats = search(realIndex, { mode: 'recent', limit: 5 })
    assert.ok(stats.total >= 1)
  },
)
