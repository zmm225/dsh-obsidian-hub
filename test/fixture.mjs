/**
 * Fixture vault builder for dsh-obsidian-hub verification.
 *
 * Everything is created under `%TEMP%\dsh-obsidian-hub-verify` (never in the
 * user's real vault). All teardown paths are guarded so this module can never
 * delete anything outside that temp base.
 *
 * Only Node built-ins are used (no external dependencies), matching the plugin
 * contract: test code uses node:test / node:assert / node:fs / node:path.
 */
import fs from 'node:fs'
import path from 'node:path'

export const TEMP_BASE_NAME = 'dsh-obsidian-hub-verify'

/**
 * One isolated run directory per PROCESS. A fixed path is unsafe: several
 * `node --test` invocations (e.g. a teammate sweeping `test/` while this suite
 * runs) would otherwise recreate/delete the same temp vault mid-run.
 */
const RUN_ID = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** Temp base directory. Uses TEMP/TMP because node:os is not in the allowed test imports. */
export function tempBase() {
  const t = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp'
  return path.join(t, TEMP_BASE_NAME)
}

/** This process's private run directory under the temp base. */
export function runBase() {
  return path.join(tempBase(), `run-${RUN_ID}`)
}

/** Default deterministic paths (per-process isolated so they can be inspected). */
export function fixturePaths() {
  const base = runBase()
  return {
    base,
    vault: path.join(base, 'vault'),
    perfVault: path.join(base, 'perf-vault-400'),
    registry: path.join(base, 'registry', 'obsidian.json'),
  }
}

/** Refuse to touch anything outside this process's run base. */
function assertSafeTarget(target, { allowBase = false } = {}) {
  const base = path.resolve(runBase())
  const resolved = path.resolve(target)
  const rel = path.relative(base, resolved)
  if ((!rel && !allowBase) || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`fixture: refusing to modify unsafe path: ${resolved}`)
  }
}

function resetDir(target) {
  assertSafeTarget(target)
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  fs.mkdirSync(target, { recursive: true })
}

function write(root, rel, content, { bom = false } = {}) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, (bom ? '\uFEFF' : '') + content, 'utf8')
  return abs
}

function writeBytes(root, rel, bytes) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, bytes)
  return abs
}

/** Small but structurally valid 1x1 transparent PNG. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

const PDF_STUB = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'utf8')

/** Note paths exported so tests never hard-code strings twice. */
export const NOTES = {
  welcome: 'Welcome.md',
  chineseWelcome: '欢迎.md',
  readme: 'README.md',
  empty: 'empty.md',
  crlf: 'crlf.md',
  bom: 'bom.md',
  big: 'big.md',
  noFrontmatter: 'no-frontmatter.md',
  malformed: 'malformed-frontmatter.md',
  english: 'notes/english-note.md',
  chinese: 'notes/chinese-note.md',
  deepDive: 'notes/deep/dive.md',
  level3: 'notes/deep/nested/level3.md',
  tasks: 'notes/tasks.md',
  alpha: 'projects/alpha.md',
  beta: 'projects/beta.md',
  gamma: 'projects/gamma.md',
  daily05: 'daily/2026-11-05.md',
  daily04: 'daily/2026-11-04.md',
  meeting: 'meeting-notes.md',
  ideas: 'ideas.md',
  glossary: 'glossary.md',
  oldPlan: 'archive/old-plan.md',
  review: 'archive/2025-review.md',
  zettel1200: 'zettel/202611051200.md',
  zettel1201: 'zettel/202611051201.md',
  trashed: '.trash/trashed-note.md',
  image: 'image.png',
  pdf: 'doc.pdf',
}

/**
 * Create the main fixture vault (>= 25 notes + .obsidian + attachments).
 *
 * @param {{ root?: string, registryRoot?: string }} [options]
 * @returns {{ root: string, registryPath: string, paths: ReturnType<typeof fixturePaths>, notes: typeof NOTES, cleanup: () => void }}
 */
export function createFixtureVault(options = {}) {
  const defaults = fixturePaths()
  const root = options.root || defaults.vault
  const registryPath = options.registryPath || defaults.registry
  resetDir(root)
  resetDir(path.dirname(registryPath))

  // ------------------------------------------------------------------ notes
  write(
    root,
    NOTES.welcome,
    `---
title: Welcome to the Hub
tags: [welcome, start]
aliases: [Home, 首页]
status: active
priority: high
cssclasses: [hub-home]
---
# Welcome

This vault is a **fixture** for dsh-obsidian-hub verification.

See [[欢迎]] for the Chinese entry point, [[projects/alpha|Alpha project]] for work,
and [[glossary#Terms]].

![[image.png]]

- [ ] read the architecture contract
- [x] create the fixture

> [!note] Callout
> Callouts are plain markdown to this plugin.

\`\`\`js
const hub = 'obsidian'
\`\`\`
`,
  )

  write(
    root,
    NOTES.chineseWelcome,
    `---
title: 欢迎
tags: [入门, 中文]
status: active
priority: high
aliases: [hello-zh]
---
# 欢迎

这里是中文入口。核心概念是量子纠缠与观测者效应。

反向链接：[[Welcome]]

## 要点
- 支持 [[projects/beta]] 的验收
- 任务：写完 VERIFICATION.md
`,
  )

  write(
    root,
    NOTES.readme,
    `# Fixture Vault

No frontmatter here on purpose.

Markdown links: [Alpha](projects/alpha.md) and [Welcome](Welcome.md).

Inline tag: #fixture #readme
`,
  )

  write(root, NOTES.empty, '')

  write(
    root,
    NOTES.crlf,
    '---\r\ntags: [windows]\r\nstatus: active\r\n---\r\n# CRLF Note\r\n\r\nLine one\r\nLine two with crlfonly marker\r\n',
  )

  write(
    root,
    NOTES.bom,
    '---\ntags: [bom]\n---\n# BOM Note\n\nBOM marker note with unique token bomtoken.\n',
    { bom: true },
  )

  write(
    root,
    NOTES.noFrontmatter,
    '# Plain Note\n\nNo frontmatter here at all. Unique token plainzeta.\n\n## Sub Heading\n\n- item one\n- item two\n',
  )

  write(
    root,
    NOTES.malformed,
    '---\ntags: [broken\nstatus: : :\n---\n# Malformed Frontmatter\n\nThe YAML above is invalid on purpose; the body must survive.\n',
  )

  // 2 MiB+ note (config maxFileBytes default is 2 MiB).
  const bigBody =
    '# Big Note\n\nHUGEONLYTOKEN appears only in this oversized note.\n\n' +
    'lorem ipsum dolor sit amet '.repeat(80_000)
  write(root, NOTES.big, `---\ntags: [big]\n---\n${bigBody}`)

  write(
    root,
    NOTES.english,
    `---
tags: [notes, english]
status: active
priority: medium
---
# English Note

The quick brown fox jumps over the lazy dog. zebraquartz is the unique marker for text search.

## Details

More English prose about knowledge bases, note taking, and local filesystem search.
`,
  )

  write(
    root,
    NOTES.chinese,
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
- [[notes/deep/dive|深入阅读]]
`,
  )

  write(
    root,
    NOTES.deepDive,
    `---
tags: [notes/deep]
status: done
---
# Deep Dive

## Deep Dive Details

\`\`\`js
const x = 42
\`\`\`

- [ ] verify --check step
- [x] write fixture

> [!tip] Heading anchor target
> See [[notes/deep/nested/level3]] for the deepest note.
`,
  )

  write(
    root,
    NOTES.level3,
    `---
tags: [nested]
---
# Level Three

Links: [[deep/dive|Dive note]], [[Welcome#Welcome|home]].
`,
  )

  write(
    root,
    NOTES.tasks,
    `---
tags: [tasks]
---
# Task List

- [ ] open task alpha
- [x] done task beta
- [ ] open task gamma
`,
  )

  write(
    root,
    NOTES.alpha,
    `---
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
  )

  write(
    root,
    NOTES.beta,
    `---
tags: [project/beta, project]
status: done
priority: low
---
# Beta Project

Links back to [[projects/alpha]].
`,
  )

  write(
    root,
    NOTES.gamma,
    `---
tags: [project/gamma]
status: paused
---
# Gamma Project

Paused until alpha lands.
`,
  )

  write(
    root,
    NOTES.daily05,
    `---
tags: [daily]
date: 2026-11-05
---
# 2026-11-05

- [ ] standup
- [x] review PR
`,
  )

  write(
    root,
    NOTES.daily04,
    `---
tags: [daily]
date: 2026-11-04
---
# 2026-11-04

- [x] write fixture
`,
  )

  write(
    root,
    NOTES.meeting,
    `---
tags: [meeting]
status: done
---
# Meeting Notes

| Topic | Owner |
|---|---|
| index | verifier |
| search | search-engine |

> [!warning] Deadline
> Verification lands before install sign-off.
`,
  )

  write(root, NOTES.ideas, '# Ideas\n\n- [ ] build obsidian hub\n- [ ] measure latency\n')

  write(
    root,
    NOTES.glossary,
    `# Glossary

## Terms

- [Alpha](projects/alpha.md)
- [Welcome](Welcome.md)
- [[notes/english-note|English]]
`,
  )

  write(root, NOTES.oldPlan, '# Old Plan\n\nArchived plan, superseded by projects/alpha.\n')
  write(root, NOTES.review, '# 2025 Review\n\nRetrospective of the year.\n')

  write(
    root,
    NOTES.zettel1200,
    `---
tags: [zettel]
id: 202611051200
---
# Zettel 1200

A fleeting note before the meeting.
`,
  )
  write(
    root,
    NOTES.zettel1201,
    `---
tags: [zettel]
id: 202611051201
---
# Zettel 1201

Another fleeting note; [[zettel/202611051200]].
`,
  )

  write(root, NOTES.trashed, '# Trashed\n\nThis note lives in .trash and must be excluded.\n')

  // ------------------------------------------------------------- attachments
  writeBytes(root, NOTES.image, PNG_1X1)
  writeBytes(root, NOTES.pdf, PDF_STUB)

  // --------------------------------------------------------------- .obsidian
  write(root, '.obsidian/app.json', JSON.stringify({ newFileLocation: 'folder', alwaysUpdateLinks: true }, null, 2))
  write(
    root,
    '.obsidian/core-plugins.json',
    JSON.stringify(
      { 'file-explorer': true, 'global-search': true, switcher: true, graph: false, backlink: true },
      null,
      2,
    ),
  )
  write(root, '.obsidian/community-plugins.json', JSON.stringify([]))
  write(root, '.obsidian/appearance.json', JSON.stringify({ baseFontSize: 16 }))

  // ----------------------------------------------- fake Obsidian vault registry
  const registry = {
    vaults: {
      'a1b2c3d4e5f6a7b8': { path: root, ts: 1762000000000, open: true },
    },
  }
  fs.mkdirSync(path.dirname(registryPath), { recursive: true })
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf8')

  return {
    root,
    registryPath,
    paths: defaults,
    notes: NOTES,
    cleanup: () => cleanupFixture(root, registryPath),
  }
}

/** Remove the fixture vault (and its registry parent) — temp-base guarded. */
export function cleanupFixture(root, registryPath) {
  assertSafeTarget(root)
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  if (registryPath) {
    assertSafeTarget(registryPath)
    fs.rmSync(path.dirname(registryPath), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

/**
 * Create a deterministic synthetic vault of `count` notes for performance work.
 * @param {{ count?: number, root?: string }} [options]
 */
export function createPerfVault(options = {}) {
  const count = options.count ?? 400
  const root = options.root || fixturePaths().perfVault
  resetDir(root)
  const words = ['lattice', 'garden', 'kernel', 'signal', 'harbor', 'meadow', 'cascade', 'ember']
  for (let i = 0; i < count; i += 1) {
    const id = String(i).padStart(4, '0')
    const group = String(i % 7).padStart(2, '0')
    const w1 = words[i % words.length]
    const w2 = words[(i * 3 + 1) % words.length]
    const marker = i % 10 === 0 ? ' needleword ' : ' '
    const zh = i % 5 === 0 ? '中文内容' : 'english content'
    write(
      root,
      `perf/group-${group}/note-${id}.md`,
      `---
tags: [perf, group/${group}]
status: ${i % 3 === 0 ? 'active' : 'done'}
priority: ${i % 4 === 0 ? 'high' : 'low'}
---
# Perf Note ${id}

${w1} ${w2}${marker}${zh} for note ${id}.

- [ ] task ${id}
- [x] done ${id}

Link: [[perf/group-${group}/note-${String((i + 1) % count).padStart(4, '0')}]]
`,
    )
  }
  return {
    root,
    count,
    cleanup: () => {
      assertSafeTarget(root)
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    },
  }
}

/** Remove this process's entire run directory (fixture + perf vault + registry). */
export function cleanupAll() {
  const base = runBase()
  assertSafeTarget(base, { allowBase: true })
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  // Best effort: drop the parent only when no other run is using it.
  try {
    fs.rmdirSync(tempBase())
  } catch {
    /* another run is still active */
  }
}
