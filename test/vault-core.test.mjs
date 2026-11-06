/**
 * vault-core acceptance tests: lib/vault.js, lib/frontmatter.js and
 * lib/tools-vault.js against a throwaway fixture vault under %TEMP%.
 *
 * The user's real vault (D:\obsidian\obsidian) is only ever READ, in the last
 * test, and only when it exists.
 *
 * Run with: node --test test/vault-core.test.mjs
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createVault, compileGlob, VaultError } from '../lib/vault.js'
import {
  extractTitle,
  mergeFrontmatter,
  parseFrontmatter,
  parseHeadings,
  parseLinks,
  parseTags,
  parseTasks,
  stringifyFrontmatter,
  yamlParse,
  yamlStringify,
} from '../lib/frontmatter.js'
import { registerVaultTools } from '../lib/tools-vault.js'
import { resolveConfig } from '../lib/config.js'

// #region fixture

const REAL_VAULT = 'D:\\obsidian\\obsidian'

/** @type {string} */
let root

const A_NOTE = [
  '---',
  'title: Alpha',
  'tags: [project, work]',
  'status: active',
  '---',
  '# Alpha',
  '',
  'Alpha body line one.',
  'Second line with [[Beta]] link and #inline-tag.',
  '',
  '- [ ] open task',
  '- [x] done task',
  '',
].join('\n')

const CRLF_NOTE = '---\r\ntitle: Windows\r\n---\r\n# Windows\r\n\r\nCRLF body.\r\n'

async function readDisk(rel) {
  return fs.readFile(path.join(root, rel), 'utf8')
}

before(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-obsidian-vault-'))
  root = path.join(base, 'vault')
  await fs.mkdir(path.join(root, 'notes', 'sub'), { recursive: true })
  await fs.mkdir(path.join(root, 'attachments'), { recursive: true })
  await fs.mkdir(path.join(root, 'dupes', 'nested'), { recursive: true })
  await fs.mkdir(path.join(root, '.obsidian'), { recursive: true })

  await fs.writeFile(path.join(root, 'notes', 'a.md'), A_NOTE, 'utf8')
  await fs.writeFile(path.join(root, 'notes', 'sub', 'b.md'), '# Beta\n\nBeta links back to [[notes/a|Alpha]].\n', 'utf8')
  await fs.writeFile(path.join(root, 'notes', 'sub', 'deep.md'), '# Deep\n', 'utf8')
  await fs.writeFile(path.join(root, 'dupes', 'x.md'), '# X one\n', 'utf8')
  await fs.writeFile(path.join(root, 'dupes', 'nested', 'x.md'), '# X two\n', 'utf8')
  await fs.writeFile(path.join(root, '.obsidian', 'app.json'), '{}', 'utf8')
  await fs.writeFile(path.join(root, 'attachments', 'image.bin'), Buffer.from([0, 1, 2, 3]))
  await fs.writeFile(path.join(root, 'Welcome.md'), '---\ntags:\n  - welcome\n---\n# Welcome\n\nHello vault.\n', 'utf8')
  await fs.writeFile(path.join(root, 'crlf.md'), CRLF_NOTE, 'utf8')
  await fs.writeFile(path.join(root, 'empty.md'), '', 'utf8')
})

after(async () => {
  if (root) await fs.rm(path.dirname(root), { recursive: true, force: true }).catch(() => {})
})

function makeVault(overrides = {}) {
  const config = resolveConfig({ vaultPath: root, ...overrides })
  return createVault({
    root,
    exclude: config.exclude,
    maxFileBytes: config.maxFileBytes,
    trashMode: config.trashMode,
  })
}

function makeRuntime(overrides = {}) {
  const vault = makeVault(overrides)
  const config = resolveConfig({ vaultPath: root, ...overrides })
  return {
    config,
    vault: async () => vault,
    index: async () => {
      throw new Error('index is not built in this fixture')
    },
    rest: () => null,
    status: async () => ({}),
    reset() {},
  }
}

async function setupTools(overrides = {}) {
  const registered = new Map()
  const ctx = {
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => {
          registered.delete(definition.name)
        }
      },
    },
  }
  const rt = makeRuntime(overrides)
  const dispose = registerVaultTools(ctx, rt)
  const run = async (name, args) => {
    const tool = registered.get(name)
    assert.ok(tool, `tool ${name} is registered`)
    return tool.execute(args, {})
  }
  return { ctx, registered, rt, dispose, run }
}

async function cleanupNote(rel) {
  await fs.rm(path.join(root, rel), { force: true })
}

/**
 * Validate a tool result against its own `output.schema` (the supported JSON
 * Schema subset: type/properties/required/additionalProperties/items/enum).
 * Catches the "execute() returns a different field name than the schema" class
 * of bug, which renders as "undefined" for the user.
 */
function assertMatchesSchema(value, schema, label) {
  if (!schema || typeof schema !== 'object') return
  if (schema.type === 'object') {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label}: expected an object`)
    const properties = schema.properties ?? {}
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `${label}: missing required "${key}"`)
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        assert.ok(Object.hasOwn(properties, key), `${label}: unexpected property "${key}" (schema forbids extra keys)`)
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key) && value[key] !== undefined) assertMatchesSchema(value[key], child, `${label}.${key}`)
    }
    return
  }
  if (schema.type === 'array') {
    assert.ok(Array.isArray(value), `${label}: expected an array`)
    for (let index = 0; index < value.length; index += 1) assertMatchesSchema(value[index], schema.items ?? {}, `${label}[${index}]`)
    return
  }
  if (schema.type === 'string') assert.equal(typeof value, 'string', `${label}: expected a string`)
  else if (schema.type === 'number') assert.equal(typeof value, 'number', `${label}: expected a number`)
  else if (schema.type === 'integer') assert.ok(Number.isInteger(value), `${label}: expected an integer, got ${String(value)}`)
  else if (schema.type === 'boolean') assert.equal(typeof value, 'boolean', `${label}: expected a boolean`)
  if (Array.isArray(schema.enum)) assert.ok(schema.enum.includes(value), `${label}: ${String(value)} not in enum`)
}

// #endregion
// #region frontmatter

const TRICKY_NOTE = [
  '---',
  '# a comment that must survive an untouched round trip',
  'title: "Quoted: title"',
  'created: 2024-01-02',
  'draft: false',
  'count: 3',
  'ratio: 1.5',
  'empty:',
  'tags:',
  '  - alpha',
  '  - beta',
  'meta:',
  '  owner: me',
  '  nested:',
  '    depth: 2',
  'inline: [a, b, "c d"]',
  'long: |',
  '  first line',
  '  second line',
  'folded: >',
  '  folded one',
  '  folded two',
  '---',
  '# Body',
  '',
  'Text.',
  '',
].join('\n')

test('frontmatter round-trips byte-for-byte unchanged (LF)', () => {
  const parsed = parseFrontmatter(TRICKY_NOTE)
  assert.equal(parsed.has, true)
  assert.equal(parsed.error, null)
  assert.equal(parsed.data.title, 'Quoted: title')
  assert.equal(parsed.data.draft, false)
  assert.equal(parsed.data.count, 3)
  assert.equal(parsed.data.ratio, 1.5)
  assert.equal(parsed.data.empty, null)
  assert.deepEqual(parsed.data.tags, ['alpha', 'beta'])
  assert.equal(parsed.data.meta.owner, 'me')
  assert.equal(parsed.data.meta.nested.depth, 2)
  assert.deepEqual(parsed.data.inline, ['a', 'b', 'c d'])
  assert.equal(parsed.data.long, 'first line\nsecond line\n')
  assert.equal(parsed.data.folded, 'folded one folded two\n')
  assert.equal(parsed.body, '# Body\n\nText.\n')
  assert.equal(parsed.data.__raw, undefined)
  assert.equal(stringifyFrontmatter(parsed.data, parsed.body), TRICKY_NOTE)
})

test('frontmatter round-trips byte-for-byte with CRLF', () => {
  const crlf = CRLF_NOTE
  const parsed = parseFrontmatter(crlf)
  assert.equal(parsed.has, true)
  assert.equal(parsed.data.title, 'Windows')
  assert.equal(stringifyFrontmatter(parsed.data, parsed.body), crlf)
})

test('frontmatter absent, unterminated and failed YAML stay lossless', () => {
  const plain = parseFrontmatter('# just a note\n')
  assert.equal(plain.has, false)
  assert.equal(plain.body, '# just a note\n')
  assert.equal(plain.bodyOffset, 0)

  const unterminated = parseFrontmatter('---\ntitle: x\n# body without close\n')
  assert.equal(unterminated.has, false)

  const broken = parseFrontmatter('---\nkey: [unclosed\n---\nbody text\n')
  assert.equal(broken.has, true)
  assert.notEqual(broken.error, null)
  assert.equal(broken.data.__raw, 'key: [unclosed\n')
  assert.equal(broken.body, 'body text\n')
})

test('yaml subset: scalars, lists, nested maps, block scalars', () => {
  const source = [
    'a: 1',
    'b: text value',
    'c: true',
    'd: null',
    'e: [x, 2, false]',
    'f:',
    '  - one',
    '  - two',
    'g:',
    '  h: nested',
    '  i: [1, 2]',
    'j: "quoted \\"value\\""',
    "k: 'single quoted'",
    'l: |',
    '  line one',
    '  line two',
    'm: >',
    '  fold one',
    '  fold two',
  ].join('\n')
  const data = yamlParse(source)
  assert.deepEqual(data, {
    a: 1,
    b: 'text value',
    c: true,
    d: null,
    e: ['x', 2, false],
    f: ['one', 'two'],
    g: { h: 'nested', i: [1, 2] },
    j: 'quoted "value"',
    k: 'single quoted',
    l: 'line one\nline two\n',
    m: 'fold one fold two\n',
  })
  assert.deepEqual(yamlParse(yamlStringify(data)), data)
})

test('yamlStringify writes Obsidian-friendly shapes', () => {
  const yaml = yamlStringify({ title: 'Hello: world', tags: ['a', 'b'], meta: { owner: 'me' }, note: 'line1\nline2' })
  assert.match(yaml, /^title: "Hello: world"$/m)
  assert.match(yaml, /^tags: \[a, b\]$/m)
  assert.match(yaml, /^meta:\n {2}owner: me$/m)
  assert.match(yaml, /^note: \|-$/m)
})

test('mergeFrontmatter deep-merges, replaces arrays and deletes undefined', () => {
  const existing = { a: 1, b: { c: 2, d: 3 }, list: [1, 2], keep: 'x' }
  const patch = { b: { c: 20, e: 4 }, list: [9], keep: undefined, added: true }
  const merged = mergeFrontmatter(existing, patch)
  assert.deepEqual(merged, { a: 1, b: { c: 20, d: 3, e: 4 }, list: [9], added: true })
  assert.deepEqual(existing, { a: 1, b: { c: 2, d: 3 }, list: [1, 2], keep: 'x' }, 'input not mutated')
  assert.deepEqual(mergeFrontmatter({}, { a: 1 }), { a: 1 })
})

test('parseLinks handles wiki, embed, markdown and ignores external/code', () => {
  const body = [
    'See [[Beta]] and [[notes/a|Alpha]] and [[notes/a#Heading|x]].',
    'Embed ![[image.png]] and markdown [label](other.md) plus [deep](notes/sub/b.md#part).',
    'External [site](https://example.com/page) and anchor [top](#intro) are skipped.',
    'Inline code `[[not-a-link]]` is skipped.',
    '',
    '```',
    '[[fenced-code]]',
    '```',
  ].join('\n')
  const links = parseLinks(body)
  const targets = links.map((link) => `${link.type}:${link.target}`)
  assert.deepEqual(targets, ['wiki:Beta', 'wiki:notes/a', 'wiki:notes/a', 'wiki:image.png', 'md:other.md', 'md:notes/sub/b.md'])
  assert.equal(links[2].alias, 'x')
  assert.equal(links[2].heading, 'Heading')
  assert.equal(links[3].embed, true)
  assert.equal(links[5].heading, 'part')
  assert.ok(!links.some((link) => link.target.includes('example.com')))
})

test('parseTags merges frontmatter and body tags without duplicates', () => {
  const body = '# Heading\n\nText #alpha and #Beta and #alpha again. `#code` is skipped.\n\n```\n#fenced\n```\n'
  const tags = parseTags(body, { tags: ['Alpha', '#project', 123, 'nested/tag'] })
  assert.deepEqual(tags, ['Alpha', 'project', 'nested/tag', 'Beta'])
})

test('parseHeadings and parseTasks skip code fences', () => {
  const body = ['# One', '## Two ##', '', '```', '# not a heading', '- [ ] not a task', '```', '', '- [ ] open', '- [x] done', '* [X] also done'].join('\n')
  const headings = parseHeadings(body)
  assert.deepEqual(headings.map((heading) => [heading.level, heading.text]), [[1, 'One'], [2, 'Two']])
  assert.deepEqual(headings.map((heading) => heading.line), [0, 1])
  const tasks = parseTasks(body)
  assert.deepEqual(tasks.map((task) => [task.checked, task.text]), [[false, 'open'], [true, 'done'], [true, 'also done']])
})

test('extractTitle prefers frontmatter, then H1, then file name', () => {
  assert.equal(extractTitle('notes/a.md', { title: 'From FM' }, '# Ignored\n'), 'From FM')
  assert.equal(extractTitle('notes/a.md', {}, '# Heading Title\n'), 'Heading Title')
  assert.equal(extractTitle('notes/a.md', {}, 'no heading\n'), 'a')
  assert.equal(extractTitle('notes/sub/deep.md', undefined, ''), 'deep')
})

// #endregion
// #region vault

test('vault: create, read, append, prepend, patch, move, copy, delete', async () => {
  const vault = makeVault()
  const created = await vault.write('notes/new.md', '# New\n', { mode: 'create' })
  assert.equal(created.action, 'created')
  assert.equal(created.bytes, Buffer.byteLength('# New\n'))
  assert.match(created.version, /^[0-9a-f]{16}$/)

  const read = await vault.read('notes/new.md')
  assert.equal(read.content, '# New\n')
  assert.equal(read.truncated, false)
  assert.equal(read.version, created.version)

  const appended = await vault.write('notes/new.md', 'appended line\n', { mode: 'append' })
  assert.equal(appended.action, 'appended')
  assert.equal(await readDisk('notes/new.md'), '# New\nappended line\n')

  const prepended = await vault.write('notes/new.md', 'first line', { mode: 'prepend' })
  assert.equal(prepended.action, 'prepended')
  assert.equal(await readDisk('notes/new.md'), 'first line\n# New\nappended line\n')

  const patched = await vault.patch('notes/new.md', { find: 'appended', replace: 'patched' })
  assert.deepEqual(patched, { rel: 'notes/new.md', replacements: 1 })
  assert.match(await readDisk('notes/new.md'), /patched line/)

  const moved = await vault.move('notes/new.md', 'notes/moved.md')
  assert.deepEqual(moved, { from: 'notes/new.md', to: 'notes/moved.md' })
  assert.equal(await vault.stat('notes/new.md'), null)
  assert.ok(await vault.stat('notes/moved.md'))

  const copied = await vault.copy('notes/moved.md', 'notes/copied.md')
  assert.deepEqual(copied, { from: 'notes/moved.md', to: 'notes/copied.md' })
  assert.equal(await readDisk('notes/copied.md'), await readDisk('notes/moved.md'))

  const trashed = await vault.remove('notes/copied.md')
  assert.deepEqual(trashed, { rel: 'notes/copied.md', action: 'trashed' })
  assert.equal(await vault.stat('notes/copied.md'), null)
  assert.ok(await fs.stat(path.join(root, '.trash', 'notes', 'copied.md')))
})

test('vault: prepend keeps the frontmatter block on top', async () => {
  const vault = makeVault()
  await vault.write('notes/fm-prepend.md', '---\ntitle: Keep\n---\nbody\n', { mode: 'create' })
  await vault.write('notes/fm-prepend.md', 'inserted', { mode: 'prepend' })
  assert.equal(await readDisk('notes/fm-prepend.md'), '---\ntitle: Keep\n---\ninserted\nbody\n')
})

test('vault: rejects traversal, absolute paths and odd Windows names', async () => {
  const vault = makeVault()
  for (const bad of ['..', '../escape.md', 'notes/../../escape.md', '/etc/passwd', 'C:\\Windows\\x.md', 'notes/..']) {
    assert.throws(() => vault.norm(bad), (error) => error instanceof VaultError && (error.code === 'path_escape' || error.code === 'invalid_path'), `rejects ${bad}`)
  }
  assert.throws(() => vault.norm('CON'), /reserved Windows device/)
  assert.throws(() => vault.norm('notes/bad:name.md'), /invalid character/)
  assert.throws(() => vault.norm('notes/trailing.'), /ends with a dot or space/)
  assert.equal(vault.norm('notes\\sub\\b.md'), 'notes/sub/b.md')
  assert.equal(vault.norm('./notes//sub/./b.md'), 'notes/sub/b.md')
  assert.equal(vault.norm(''), '')
  assert.throws(() => createVault({ root: 'relative/path' }), /absolute path/)
})

test('vault: version mismatch refuses to clobber', async () => {
  const vault = makeVault()
  await vault.write('notes/version.md', 'original\n', { mode: 'create' })
  const before = await vault.read('notes/version.md')
  await fs.writeFile(path.join(root, 'notes', 'version.md'), 'changed externally\n', 'utf8')
  await assert.rejects(
    vault.write('notes/version.md', 'mine\n', { mode: 'overwrite', expectedVersion: before.version }),
    (error) => error instanceof VaultError && error.code === 'version_mismatch' && /Re-read the note/.test(error.message),
  )
  const current = await vault.read('notes/version.md')
  await vault.write('notes/version.md', 'mine\n', { mode: 'overwrite', expectedVersion: current.version })
  assert.equal(await readDisk('notes/version.md'), 'mine\n')
})

test('vault: write modes fail with actionable errors', async () => {
  const vault = makeVault()
  await vault.write('notes/exists.md', 'x', { mode: 'create' })
  await assert.rejects(vault.write('notes/exists.md', 'y', { mode: 'create' }), (error) => error.code === 'exists')
  await assert.rejects(vault.patch('notes/missing.md', { find: 'a' }), (error) => error.code === 'not_found')
  await assert.rejects(vault.patch('notes/exists.md', { find: 'not-there' }), (error) => error.code === 'not_found')
  await assert.rejects(vault.patch('notes/exists.md', { find: '[', regex: true }), (error) => error.code === 'invalid_regex')
  await assert.rejects(vault.write('notes/exists.md', 'y', { mode: 'bogus' }), (error) => error.code === 'invalid_mode')
  await assert.rejects(vault.remove('notes', {}), (error) => error.code === 'is_a_directory')
  await assert.rejects(vault.move('notes/exists.md', 'attachments'), (error) => error.code === 'exists')
})

test('vault: frontmatter merge preserves untouched blocks and adds keys', async () => {
  const vault = makeVault()
  await vault.write('notes/fm.md', TRICKY_NOTE, { mode: 'create' })
  const original = await readDisk('notes/fm.md')
  const blockEnd = original.indexOf('---\n# Body')
  const originalBlock = original.slice(0, blockEnd + 4)

  await vault.write('notes/fm.md', '', { mode: 'append', frontmatter: {} })
  assert.equal(await readDisk('notes/fm.md'), original, 'no-op merge keeps bytes identical')

  const updated = await vault.write('notes/fm.md', '', { mode: 'append', frontmatter: { status: 'draft', tags: ['gamma'] } })
  assert.equal(updated.action, 'appended')
  const text = await readDisk('notes/fm.md')
  assert.match(text, /^status: draft$/m)
  assert.match(text, /^tags: \[gamma\]$/m)
  assert.match(text, /^title: "Quoted: title"$/m, 'other keys survive')
  assert.match(text, /^count: 3$/m, 'numeric values survive')
  assert.match(text, /^  owner: me$/m, 'nested maps survive')
  assert.match(text, /# Body/, 'body survives')
  assert.ok(text.startsWith('---\n'), 'frontmatter stays first')
})

test('vault: BOM stripped, CRLF normalized on read and preserved on write', async () => {
  const vault = makeVault()
  await fs.writeFile(path.join(root, 'bom.md'), '\uFEFF---\ntitle: Bom\n---\nbody\n', 'utf8')
  const bomRead = await vault.read('bom.md')
  assert.ok(!bomRead.content.startsWith('\uFEFF'))
  assert.equal(bomRead.content.split('\n')[0], '---')
  assert.equal(parseFrontmatter(bomRead.content).data.title, 'Bom')

  const crlf = await vault.read('crlf.md')
  assert.ok(!crlf.content.includes('\r'))
  assert.equal(crlf.content.split('\n')[0], '---')
  await vault.write('crlf.md', 'extra\n', { mode: 'append' })
  const raw = await readDisk('crlf.md')
  assert.ok(raw.includes('\r\n'), 'CRLF preserved on append')
  assert.ok(!/[^\r]\n/.test(raw), 'no bare LF introduced')
  assert.ok(raw.includes('CRLF body.\r\n'), 'existing CRLF line untouched')
  assert.ok(raw.includes('extra\r\n'), 'appended text uses CRLF')
})

test('vault: byte truncation honours maxFileBytes, readRaw keeps line endings', async () => {
  const bigFile = path.join(root, 'big.md')
  await fs.writeFile(bigFile, `${'a'.repeat(5000)}\n`, 'utf8')
  const small = createVault({ root, maxFileBytes: 128 })
  const truncated = await small.read('big.md')
  assert.equal(truncated.truncated, true)
  assert.ok(truncated.content.length <= 128)
  assert.equal(truncated.size, 5001)
  assert.ok(truncated.totalLines >= 1)

  const raw = await createVault({ root }).readRaw('crlf.md')
  assert.ok(raw.includes('\r\n'), 'readRaw keeps CRLF')
  await assert.rejects(small.write('notes/too-big.md', 'y'.repeat(500)), /refusing to write/, 'writes above maxFileBytes are refused')
  await cleanupNote('big.md')
})

test('vault: createDirs false and newline policy', async () => {
  const vault = makeVault()
  await assert.rejects(vault.write('missing-dir/deep.md', 'x', { mode: 'create', createDirs: false }), /parent folder does not exist/)
  await vault.write('notes/nl.md', '---\r\ntitle: N\r\n---\r\nbody\r\n', { mode: 'create' })
  await vault.write('notes/nl.md', 'extra\n', { mode: 'append', newline: 'lf' })
  const raw = await readDisk('notes/nl.md')
  assert.ok(!raw.includes('\r'), 'newline lf normalizes the whole note')
  await vault.write('notes/nl2.md', 'one\ntwo\n', { mode: 'create', newline: 'crlf' })
  assert.ok((await readDisk('notes/nl2.md')).includes('\r\n'), 'newline crlf applies to new notes')
})

test('vault: patch supports all and regex replacements', async () => {
  const vault = makeVault()
  await vault.write('notes/patchy.md', 'aa bb aa\ncc aa\n', { mode: 'create' })
  const all = await vault.patch('notes/patchy.md', { find: 'aa', replace: 'XX', all: true })
  assert.equal(all.replacements, 3)
  assert.equal(await readDisk('notes/patchy.md'), 'XX bb XX\ncc XX\n')
  const regex = await vault.patch('notes/patchy.md', { find: 'X+', replace: 'Y', all: true, regex: true })
  assert.equal(regex.replacements, 3)
  assert.equal(await readDisk('notes/patchy.md'), 'Y bb Y\ncc Y\n')
})

test('vault: read refuses binary attachments instead of returning mojibake', async () => {
  const vault = makeVault()
  await assert.rejects(
    vault.read('attachments/image.bin'),
    (error) => error.code === 'binary_file' && /Not a text file/.test(error.message) && /\.bin/.test(error.message),
  )
  await assert.rejects(vault.readRaw('attachments/image.bin'), (error) => error.code === 'binary_file')
  await fs.writeFile(path.join(root, 'blob.dat'), Buffer.from(Array.from({ length: 256 }, (_, index) => 0x80 + (index % 64))))
  await assert.rejects(vault.read('blob.dat'), (error) => error.code === 'binary_file', 'invalid UTF-8 without NUL bytes')
  const { run } = await setupTools()
  await assert.rejects(run('obsidian_read', { path: 'attachments/image.bin' }), /Not a text file/)
  await fs.rm(path.join(root, 'blob.dat'), { force: true })
})

test('vault: concurrent appends serialize and never lose acknowledged bytes', async () => {
  const vault = makeVault()
  await vault.write('notes/concurrent.md', 'start\n', { mode: 'create' })
  const writes = []
  for (let index = 0; index < 10; index += 1) writes.push(vault.write('notes/concurrent.md', `line-${index}\n`, { mode: 'append' }))
  const results = await Promise.allSettled(writes)
  const rejected = results.filter((entry) => entry.status === 'rejected').map((entry) => entry.reason && entry.reason.message)
  assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 10, `rejected: ${rejected.join('; ')}`)
  const lines = (await readDisk('notes/concurrent.md')).split('\n').filter(Boolean)
  assert.equal(lines.length, 11, `expected 11 lines, got: ${lines.join(' | ')}`)
  assert.equal(lines[0], 'start')
  for (let index = 0; index < 10; index += 1) assert.ok(lines.includes(`line-${index}`), `line-${index} landed`)
  const final = await vault.read('notes/concurrent.md')
  assert.equal(final.version, results[results.length - 1].value.version, 'last acknowledged version is the file on disk')
})

test('vault.resolve({note}) resolves title, aliases and first H1', async () => {
  const vault = makeVault()
  await vault.write('notes/titled.md', '---\ntitle: Titled Doc\naliases: [TD, "T Doc"]\n---\n# Body Heading\n\nbody\n', { mode: 'create' })
  assert.equal((await vault.resolve({ note: 'Titled Doc' })).rel, 'notes/titled.md', 'frontmatter title')
  assert.equal((await vault.resolve({ note: 'td' })).rel, 'notes/titled.md', 'alias, case-insensitive')
  assert.equal((await vault.resolve({ note: 'T Doc' })).rel, 'notes/titled.md', 'quoted alias')
  await vault.write('notes/h1only.md', '# H1 Only Title\n\nbody\n', { mode: 'create' })
  assert.equal((await vault.resolve({ note: 'H1 Only Title' })).rel, 'notes/h1only.md', 'first H1 fallback')
  // A mutation must invalidate the cached name map.
  await vault.move('notes/titled.md', 'notes/titled-moved.md')
  assert.equal((await vault.resolve({ note: 'Titled Doc' })).rel, 'notes/titled-moved.md', 'cache invalidated on move')
  await vault.remove('notes/h1only.md')
  await assert.rejects(
    vault.resolve({ note: 'H1 Only Title' }),
    (error) => error.code === 'not_found' && /not found/.test(error.message),
    'cache invalidated on delete',
  )
  await assert.rejects(
    vault.resolve({ note: 'definitely-not-a-note-xyz' }),
    (error) => error instanceof VaultError && error.code === 'not_found' && /not found/.test(error.message),
    'a miss is a not_found error, never a ReferenceError',
  )
})

test('vault: writes are atomic and leave no temp files', async () => {
  const vault = makeVault()
  await vault.write('notes/atomic.md', 'payload\n', { mode: 'create' })
  const entries = await fs.readdir(path.join(root, 'notes'))
  assert.ok(!entries.some((name) => name.endsWith('.tmp')), `no temp files, got ${entries.join(', ')}`)
})

test('vault: list, tree, glob, stat and walkMarkdown exclude hidden folders', async () => {
  const vault = makeVault()
  const top = await vault.list('')
  assert.ok(top.some((entry) => entry.rel === 'notes' && entry.type === 'dir'))
  assert.ok(!top.some((entry) => entry.rel === '.obsidian'), '.obsidian is excluded')
  assert.ok(!top.some((entry) => entry.rel === '.trash'), '.trash is excluded')

  const markdown = await vault.list('', { recursive: true, glob: '**/*.md' })
  assert.ok(markdown.some((entry) => entry.rel === 'notes/sub/deep.md'))
  assert.ok(!markdown.some((entry) => entry.rel.endsWith('.bin')))

  const filtered = await vault.list('notes', { glob: '*.md' })
  assert.ok(filtered.every((entry) => entry.rel.endsWith('.md')))

  const tree = await vault.tree('notes', { depth: 2 })
  assert.equal(tree.rel, 'notes')
  assert.equal(tree.type, 'dir')
  assert.ok(Array.isArray(tree.children))
  assert.ok(tree.children.some((child) => child.rel === 'notes/sub' && child.type === 'dir'))

  const walked = []
  for await (const file of vault.walkMarkdown()) walked.push(file.rel)
  assert.ok(walked.includes('Welcome.md'))
  assert.ok(!walked.some((rel) => rel.startsWith('.obsidian/')))
  assert.ok(walked.every((rel) => rel.endsWith('.md')))

  assert.equal(await vault.stat('nope.md'), null)
  const stat = await vault.stat('notes/a.md')
  assert.equal(stat.type, 'file')
  assert.ok(stat.size > 0)
})

test('vault: glob compiler handles **, * and ?', () => {
  const all = compileGlob('**/*.md')
  assert.ok(all.test('a.md'))
  assert.ok(all.test('x/y/z.md'))
  assert.ok(!all.test('a.txt'))
  const hidden = compileGlob('.obsidian/**')
  assert.ok(hidden.test('.obsidian'))
  assert.ok(hidden.test('.obsidian/app.json'))
  assert.ok(!hidden.test('notes/.obsidianx'))
  const single = compileGlob('notes/?eep.md')
  assert.ok(single.test('notes/deep.md'))
  assert.ok(!single.test('notes/xdeep.md'))
})

test('vault: note resolution by name, path, suffix and ambiguity', async () => {
  const vault = makeVault()
  assert.equal((await vault.resolve({ note: 'Welcome' })).rel, 'Welcome.md')
  assert.equal((await vault.resolve({ note: '[[Welcome]]' })).rel, 'Welcome.md')
  assert.equal((await vault.resolve({ note: 'welcome' })).rel, 'Welcome.md')
  assert.equal((await vault.resolve({ note: 'notes/sub/b.md' })).rel, 'notes/sub/b.md')
  assert.equal((await vault.resolve({ note: 'notes/sub/b' })).rel, 'notes/sub/b.md')
  assert.equal((await vault.resolve({ note: 'deep' })).rel, 'notes/sub/deep.md')
  assert.equal((await vault.resolve({ note: 'sub/deep' })).rel, 'notes/sub/deep.md')
  assert.equal((await vault.resolve({ note: 'Alpha' })).rel, 'notes/a.md', 'frontmatter title resolves')
  await assert.rejects(vault.resolve({ note: 'x' }), (error) => error.code === 'not_found' && /ambiguous/.test(error.message) && /dupes/.test(error.message))
  await assert.rejects(vault.resolve({ note: 'definitely-missing' }), (error) => error.code === 'not_found' && /not found/.test(error.message))
  await assert.rejects(vault.resolve({}), /pass either/)
})

// #endregion
// #region tools

test('tools register exactly five definitions with normalized schemas', async () => {
  const { registered, dispose } = await setupTools()
  assert.deepEqual([...registered.keys()].sort(), ['obsidian_batch_read', 'obsidian_batch_write', 'obsidian_fs', 'obsidian_read', 'obsidian_write'])
  const read = registered.get('obsidian_read')
  const write = registered.get('obsidian_write')
  assert.equal(read.parameters.type, 'object')
  assert.ok(read.parameters.properties.path)
  assert.equal(read.parameters.required, undefined, 'no required params on read (path OR note)')
  assert.ok(Array.isArray(write.parameters.required), 'inline required hoisted to an array')
  assert.deepEqual(write.parameters.required, ['path'])
  assert.equal(write.parameters.properties.path.required, undefined, 'no boolean required marker on parameters')
  assert.ok(Array.isArray(read.output.schema.required))
  assert.ok(read.output.schema.required.includes('path'))
  assert.equal(read.output.schema.properties.path.required, undefined, 'no boolean required markers leftover')
  const rendered = read.output.render({}, {
    path: 'notes/a.md',
    content: 'hello',
    truncated: false,
    totalLines: 1,
    lineStart: 1,
    lineEnd: 1,
    size: 5,
    mtimeMs: 0,
    version: 'abc',
  })
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /notes\/a\.md/)
  dispose()
  assert.equal(registered.size, 0, 'disposer unregisters every tool')
})

test('every tool result satisfies its own output.schema and renders without "undefined"', async () => {
  const { registered, run } = await setupTools()
  const cases = [
    ['obsidian_read', { path: 'notes/a.md', include: ['frontmatter', 'tags', 'headings', 'tasks', 'links'] }],
    ['obsidian_write', { path: 'notes/schema.md', content: '# S\n', mode: 'create', frontmatter: { status: 'draft' } }],
    ['obsidian_batch_read', { paths: ['notes/a.md', 'notes/sub/b.md'], include: ['frontmatter'] }],
    [
      'obsidian_batch_write',
      {
        operations: [
          { type: 'mkdir', path: 'schema-batch' },
          { type: 'write', path: 'schema-batch/x.md', content: 'x' },
        ],
      },
    ],
    ['obsidian_fs', { action: 'list', path: 'notes' }],
    ['obsidian_fs', { action: 'tree', path: 'notes', depth: 2 }],
    ['obsidian_fs', { action: 'stat', path: 'notes/a.md' }],
    ['obsidian_fs', { action: 'mkdir', path: 'schema-fs' }],
    ['obsidian_fs', { action: 'copy', path: 'notes/a.md', dest: 'schema-fs/a.md' }],
    ['obsidian_fs', { action: 'move', path: 'schema-fs/a.md', dest: 'schema-fs/b.md' }],
    ['obsidian_fs', { action: 'delete', path: 'schema-fs/b.md' }],
  ]
  for (const [name, args] of cases) {
    const definition = registered.get(name)
    const value = await run(name, args)
    assertMatchesSchema(value, definition.output.schema, `${name} ${JSON.stringify(args).slice(0, 60)}`)
    const text = definition.output
      .render(args, value)
      .map((block) => block.text)
      .join('\n')
    assert.ok(!/undefined|\[object Object\]/.test(text), `${name} render leaked a missing field:\n${text.slice(0, 300)}`)
  }
})

test('obsidian_read: path and note, include flags, line window, long-note truncation', async () => {
  const { run } = await setupTools()
  const byPath = await run('obsidian_read', { path: 'notes/a.md' })
  assert.equal(byPath.path, 'notes/a.md')
  assert.equal(byPath.totalLines, A_NOTE.split('\n').length)
  assert.match(byPath.content, /Alpha body line one/)
  assert.equal(byPath.truncated, false)

  const byNote = await run('obsidian_read', { note: 'Alpha', include: ['frontmatter', 'tags', 'headings', 'tasks', 'links'] })
  assert.equal(byNote.path, 'notes/a.md')
  assert.equal(byNote.frontmatter.title, 'Alpha')
  assert.deepEqual(byNote.tags, ['project', 'work', 'inline-tag'])
  assert.deepEqual(byNote.headings.map((heading) => heading.text), ['Alpha'])
  assert.deepEqual(byNote.tasks.map((task) => task.checked), [false, true])
  assert.ok(byNote.links.some((link) => link.target === 'Beta'))

  const window = await run('obsidian_read', { path: 'notes/a.md', offset: 6, limit: 2 })
  assert.equal(window.lineStart, 7)
  assert.equal(window.lineEnd, 8)
  assert.match(window.content, /Alpha body line one/)
  assert.equal(window.truncated, true)

  const withBacklinks = await run('obsidian_read', { path: 'notes/a.md', include: ['backlinks'] })
  assert.equal(withBacklinks.backlinks, undefined, 'no index means no backlink claim')
  assert.match(withBacklinks.warnings.join(' '), /backlinks unavailable/)

  await assert.rejects(run('obsidian_read', {}), /pass `path`/)
  await assert.rejects(run('obsidian_read', { path: 'notes/missing.md' }), /not found/)
  await assert.rejects(run('obsidian_read', { path: 'notes' }), /folder/)
  await assert.rejects(run('obsidian_read', { path: 'notes/a.md', include: ['bogus'] }), /unknown include flag/)

  const longText = `${'x'.repeat(7000)}\n`
  await fs.writeFile(path.join(root, 'long.md'), longText, 'utf8')
  const long = await run('obsidian_read', { path: 'long.md' })
  assert.equal(long.truncated, true)
  assert.equal(long.truncatedReason, 'max_chars')
  assert.equal(long.content.length, 6000)
  await cleanupNote('long.md')
})

test('obsidian_write: modes, frontmatter, version guard and validation', async () => {
  const { run } = await setupTools()
  const created = await run('obsidian_write', { path: 'notes/tool.md', content: '# Tool\n', mode: 'create' })
  assert.equal(created.action, 'created')
  assert.match(created.version, /^[0-9a-f]{16}$/)

  const appended = await run('obsidian_write', { path: 'notes/tool.md', content: 'more\n', mode: 'append' })
  assert.equal(appended.action, 'appended')
  assert.equal(await readDisk('notes/tool.md'), '# Tool\nmore\n')

  const patched = await run('obsidian_write', { path: 'notes/tool.md', mode: 'patch', find: 'more', replace: 'less' })
  assert.equal(patched.action, 'patched')
  assert.equal(patched.replacements, 1)
  assert.match(await readDisk('notes/tool.md'), /less/)

  const withFrontmatter = await run('obsidian_write', {
    path: 'notes/tool-fm.md',
    content: 'body\n',
    mode: 'create',
    frontmatter: { tags: ['a'], status: 'draft' },
  })
  assert.equal(withFrontmatter.action, 'created')
  const text = await readDisk('notes/tool-fm.md')
  assert.match(text, /^---$/m)
  assert.match(text, /^tags: \[a\]$/m)
  assert.match(text, /^status: draft$/m)
  assert.match(text, /body/)

  const current = await run('obsidian_read', { path: 'notes/tool.md' })
  await assert.rejects(
    run('obsidian_write', { path: 'notes/tool.md', content: 'x', expectedVersion: 'deadbeefdeadbeef' }),
    /version mismatch/,
  )
  await run('obsidian_write', { path: 'notes/tool.md', content: 'guarded\n', mode: 'overwrite', expectedVersion: current.version })
  assert.equal(await readDisk('notes/tool.md'), 'guarded\n')

  await assert.rejects(run('obsidian_write', { path: 'notes/tool.md' }), /content is required/)
  await assert.rejects(run('obsidian_write', { path: 'notes/tool.md', content: 'x', mode: 'bogus' }), /mode must be one of/)
  await assert.rejects(run('obsidian_write', { path: 'notes/tool.md', mode: 'patch' }), /find/)
  await assert.rejects(run('obsidian_write', { path: 'notes/tool.md', content: 'x', frontmatter: [] }), /frontmatter must be a plain object/)
})

test('obsidian_batch_read: paths, glob, partial failure and truncation flag', async () => {
  const { run } = await setupTools()
  const byPaths = await run('obsidian_batch_read', {
    paths: ['notes/a.md', 'notes/sub/b.md', 'notes/missing.md'],
    include: ['frontmatter', 'tags'],
  })
  assert.equal(byPaths.total, 3)
  assert.equal(byPaths.returned, 3)
  assert.equal(byPaths.notes.filter((note) => note.ok).length, 2)
  const failed = byPaths.notes.find((note) => !note.ok)
  assert.ok(failed && /not found/.test(failed.error))
  assert.equal(byPaths.notes[0].frontmatter.title, 'Alpha')
  assert.deepEqual(byPaths.notes[0].tags, ['project', 'work', 'inline-tag'])

  const byGlob = await run('obsidian_batch_read', { glob: 'notes/sub/**/*.md', limit: 5 })
  assert.ok(byGlob.total >= 2)
  assert.ok(byGlob.notes.every((note) => note.ok))
  assert.equal(byGlob.truncated, false)

  const byQuery = await run('obsidian_batch_read', { query: 'welcome' })
  assert.equal(byQuery.notes[0].path, 'Welcome.md')

  const capped = await run('obsidian_batch_read', { glob: '**/*.md', limit: 2 })
  assert.equal(capped.total > 2, true)
  assert.equal(capped.truncated, true)
  assert.equal(capped.returned, 2)

  await assert.rejects(run('obsidian_batch_read', {}), /pass `paths`/)
  await assert.rejects(run('obsidian_batch_read', { glob: 'no-such-pattern-*.zzz' }), /matched no notes/)
})

test('obsidian_batch_write validates the whole batch before executing', async () => {
  const { run } = await setupTools()
  const result = await run('obsidian_batch_write', {
    operations: [
      { type: 'mkdir', path: 'batch' },
      { type: 'write', path: 'batch/one.md', content: '# One\n', frontmatter: { status: 'ok' } },
      { type: 'bogus', path: 'batch/nope.md' },
      { type: 'write', path: 'batch/two.md', content: '# Two\n' },
      { type: 'move', path: 'batch/one.md', dest: 'batch/one-moved.md' },
      { type: 'copy', path: 'batch/two.md', dest: 'batch/two-copy.md' },
      { type: 'patch', path: 'batch/two.md', find: 'Two', replace: 'Deux' },
      { type: 'delete', path: 'batch/two-copy.md' },
    ],
  })
  assert.equal(result.total, 8)
  assert.equal(result.failed, 1)
  assert.equal(result.succeeded, 7)
  const bogus = result.results.find((entry) => entry.index === 2)
  assert.equal(bogus.ok, false)
  assert.match(bogus.error, /unknown type "bogus"/)
  assert.ok(result.results.every((entry) => typeof entry.index === 'number' && typeof entry.ok === 'boolean'))
  assert.ok(await fs.stat(path.join(root, 'batch', 'one-moved.md')))
  assert.equal(await readDisk('batch/two.md'), '# Deux\n')
  assert.equal(await run('obsidian_fs', { action: 'stat', path: 'batch/two-copy.md' }).then((value) => value.exists), false)

  // Per-item runtime failure: one write targets a folder.
  const partial = await run('obsidian_batch_write', {
    operations: [
      { type: 'write', path: 'notes', content: 'x' },
      { type: 'write', path: 'batch/three.md', content: '# Three\n' },
    ],
  })
  assert.equal(partial.failed, 1)
  assert.equal(partial.succeeded, 1)
  assert.match(partial.results[0].error, /folder|directory|not a note/i)

  // continueOnError: false stops after the first failure and marks the rest skipped.
  const stopped = await run('obsidian_batch_write', {
    continueOnError: false,
    operations: [
      { type: 'write', path: 'batch/four.md', content: '# Four\n' },
      { type: 'delete', path: 'nope-does-not-exist.md' },
      { type: 'write', path: 'batch/five.md', content: '# Five\n' },
    ],
  })
  assert.equal(stopped.succeeded, 1)
  assert.equal(stopped.failed, 1)
  assert.equal(stopped.skipped, 1)
  assert.equal(stopped.results[2].skipped, true)
  assert.equal(await run('obsidian_fs', { action: 'stat', path: 'batch/five.md' }).then((value) => value.exists), false)

  await assert.rejects(run('obsidian_batch_write', { operations: [] }), /at least one operation/)
  await assert.rejects(run('obsidian_batch_write', { operations: {} }), /must be an array/)

  // A malformed operation is reported per item and never executed.
  const malformed = await run('obsidian_batch_write', { operations: [{ type: 'write', path: 'batch/bad.md' }] })
  assert.equal(malformed.failed, 1)
  assert.equal(malformed.succeeded, 0)
  assert.match(malformed.results[0].error, /"content" must be a string/)
  await assert.rejects(fs.stat(path.join(root, 'batch', 'bad.md')))
})

test('obsidian_fs: list, tree, stat, move, copy, delete, mkdir', async () => {
  const { run } = await setupTools()
  const list = await run('obsidian_fs', { action: 'list', path: 'notes', glob: '*.md' })
  assert.equal(list.action, 'list')
  assert.ok(list.entries.length >= 2)
  assert.ok(list.entries.every((entry) => entry.rel.startsWith('notes/')))

  const tree = await run('obsidian_fs', { action: 'tree', path: 'notes', depth: 3 })
  assert.equal(tree.tree.rel, 'notes')
  assert.ok(tree.total >= 2)

  const stat = await run('obsidian_fs', { action: 'stat', path: 'notes/a.md' })
  assert.equal(stat.exists, true)
  assert.equal(stat.entry.type, 'file')
  const missing = await run('obsidian_fs', { action: 'stat', path: 'not-here.md' })
  assert.equal(missing.exists, false)

  const made = await run('obsidian_fs', { action: 'mkdir', path: 'fs/new-folder' })
  assert.equal(made.result, 'created')
  await run('obsidian_fs', { action: 'copy', path: 'notes/a.md', dest: 'fs/new-folder/a-copy.md' })
  assert.ok(await fs.stat(path.join(root, 'fs', 'new-folder', 'a-copy.md')))
  await run('obsidian_fs', { action: 'move', path: 'fs/new-folder/a-copy.md', dest: 'fs/moved.md' })
  assert.ok(await fs.stat(path.join(root, 'fs', 'moved.md')))

  const deleted = await run('obsidian_fs', { action: 'delete', path: 'fs/moved.md' })
  assert.equal(deleted.result, 'trashed')
  assert.ok(await fs.stat(path.join(root, '.trash', 'fs', 'moved.md')))

  await assert.rejects(run('obsidian_fs', { action: 'nope' }), /action must be one of/)
  await assert.rejects(run('obsidian_fs', { action: 'move', path: 'fs/moved.md' }), /dest/)
})

test('trashMode delete removes permanently when configured', async () => {
  const { run } = await setupTools({ trashMode: 'delete' })
  await run('obsidian_write', { path: 'permanent.md', content: 'x', mode: 'create' })
  const deleted = await run('obsidian_fs', { action: 'delete', path: 'permanent.md' })
  assert.equal(deleted.result, 'deleted')
  await assert.rejects(fs.stat(path.join(root, 'permanent.md')))
  await assert.rejects(fs.stat(path.join(root, '.trash', 'permanent.md')))
})

// #endregion
// #region real vault (read-only)

test('real vault: reads 欢迎.md through obsidian_read without touching it', async (t) => {
  const stat = await fs.stat(REAL_VAULT).catch(() => null)
  if (!stat || !stat.isDirectory()) {
    t.skip(`${REAL_VAULT} is not present in this environment`)
    return
  }
  const target = path.join(REAL_VAULT, '欢迎.md')
  const before = await fs.stat(target).catch(() => null)
  if (!before) {
    t.skip('欢迎.md is not present in the real vault')
    return
  }
  const config = resolveConfig({ vaultPath: REAL_VAULT })
  const vault = createVault({ root: REAL_VAULT, exclude: config.exclude, maxFileBytes: config.maxFileBytes, trashMode: config.trashMode })
  const run = async (name, args) => {
    const registered = new Map()
    const dispose = registerVaultTools({ tools: { register: (definition) => (registered.set(definition.name, definition), () => registered.delete(definition.name)) } }, {
      config,
      vault: async () => vault,
      index: async () => {
        throw new Error('no index')
      },
    })
    try {
      return await registered.get(name).execute(args, {})
    } finally {
      dispose()
    }
  }
  const read = await run('obsidian_read', { note: '欢迎' })
  assert.equal(read.path, '欢迎.md')
  assert.ok(read.content.length > 0)
  assert.equal(read.truncated, false)
  const after = await fs.stat(target)
  assert.equal(after.mtimeMs, before.mtimeMs, 'read must not modify the real vault file')
  assert.equal(after.size, before.size)
})

// #endregion
