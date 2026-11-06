# dsh-obsidian-hub — 架构与接口契约 (FROZEN)

> 本文件是团队协作的唯一契约来源。任何模块接口的改动必须先由 Lead 更新本文件。
> 所有权：Lead 维护本文件；各模块 owner 只写自己 scope 内的文件。

## 目标

一个 DeepSeek Harness 持久化插件，把 Obsidian 知识库（账户/工作区/Vault）接成 Agent 可自主操作的能力：

- 读、写、批量读、批量写
- 快速高效查询（全文 BM25 / 正则 / 标签 / 属性 / 双链 / 文件 / 最近 / 标题 / 任务）
- 文件系统级操作（列表、树、移动、复制、删除、建目录）
- 实时操作 Obsidian 应用（打开笔记、执行命令、读活动笔记）—— 通过 Local REST API 插件；未安装时降级并说明

## 传输层设计（重要）

| 层 | 机制 | 何时可用 | 用途 |
|---|---|---|---|
| 主通道 | 直接文件系统（`node:fs`） | 永远可用 | 读/写/批量/索引/查询。Obsidian 关闭时也可用 |
| 次通道 | Obsidian Local REST API 社区插件 `obsidian-local-rest-api`（https://127.0.0.1:27124, Bearer key） | 用户安装并启用该插件后 | 执行 Obsidian 命令、打开笔记、读活动笔记、metadata cache |
| 深链 | `obsidian://` URI | 安装了 Obsidian 桌面端 | 在应用里打开笔记 |

Obsidian **没有公开的账户/云 API**。因此「账户」在本插件中 = 本机 Obsidian 应用配置（`%APPDATA%\obsidian\obsidian.json` 的 vault 注册表）+ 当前 vault 的 `.obsidian/*` 配置。
Sync / Publish 无法通过官方 API 驱动，只能通过 vault 文件系统间接同步。`obsidian_status` 必须**如实报告**这一点，不得假装连上了云账户。

## 文件所有权（写作用域，互斥）

| 文件 | Owner |
|---|---|
| `ARCHITECTURE.md`, `package.json`, `cordis.patch.yml`, `index.js`, `icon.svg`, `README.md` | Lead |
| `lib/config.js`, `lib/runtime.js`, `lib/discover.js`, `lib/rest.js`, `lib/tools-live.js` | Lead |
| `lib/vault.js`, `lib/frontmatter.js`, `lib/tools-vault.js` | vault-core |
| `lib/indexer.js`, `lib/search.js`, `lib/tools-search.js` | search-engine |
| `client.js`, `locale/*.json`, `icon.svg`（如需替换，先问 Lead） | client-ui |
| `test/**`, `VERIFICATION.md` | verifier |

其他人不得写上述文件。需要跨模块改动 → 发消息给 Lead。

## 硬性技术约束

1. **零外部依赖**。本地 bundle 以目录 link 方式安装，无法解析 dsh 的 `node_modules`。
   只能 `import` 相对路径文件与 Node 内置模块（`node:fs`、`node:path`、`node:os`、`node:crypto`、`node:https`、`node:http`、`node:url`、`node:child_process`）。
   不要 `import '@deepseek-ai/...'`，不要 `defineTool`（用普通对象字面量）。
2. 全部 ES Module（`type: "module"`）。相对 import 必须带 `.js` 扩展名。
3. 不得写入 vault 之外；所有路径经 `vault.norm()` 校验，防目录穿越。
4. 不得在 `apply` 之外注册任何东西；所有注册都要 `ctx.effect(() => disposer)` 包裹。
5. 每个工具必须返回可 JSON 序列化的普通对象（`output.schema` 必须能覆盖它）。
6. 大输出要截断并在返回值里带 `truncated: true`，不得把整个 vault 倒进上下文。

## Tool 注册约定（已修正 2026-11-05）

**重要**：`ctx.tools.register()` 逐字接收 ToolDefinition，**不会**像 `defineTool()` 那样归一化；
且它对 `output.schema` 跑 `assertSupportedJsonSchema()`，会**拒绝**内联的 `required: true`：
`unsupported JSON schema: schema.properties.x.required is not supported on type "string"`。

因此所有工具定义都写在 `lib/tool-schema.js`（Lead 所有）里，用可读的属性表形式，**注册前必须经过归一化**：

```js
import { defineTool, registerTools } from './tool-schema.js'

export function registerVaultTools(ctx, rt) {
  return registerTools(ctx, [
    { name: 'obsidian_read', description: '…', parameters: { path: { type: 'string', description: '…' } }, output: { schema: {…}, render }, async execute(args, exec) {…} },
    …
  ])
}
```

`registerTools(ctx, defs)` 返回**一个** disposer；`defineTool(def)` 归一化单个定义。
归一化规则：内联 `required: true` → 所属对象的 `required: [...]` 数组；裸属性表 → `{ type:'object', properties, required }`。
支持并保留：`type`、`properties`、`required`、`items`、`enum`、`description`、`title`、`additionalProperties`、`oneOf`/`anyOf`。
**禁止**在模型可见 schema 里用 `default`、`$ref`、`pattern`、`format`、`minimum`、`maximum` —— 约束写进 `description`，并在 `execute()` 里校验。
属性名不要叫 `type`（会被判定为 schema 而非属性表）。

```js
// 归一化之后的模型可见形状
parameters: { type: 'object', properties: { path: { type: 'string', description: '…' } }, required: ['path'] }
output.schema: { type: 'object', additionalProperties: false, properties: { … }, required: ['…'] }
```

- `output.render(args, value)` 返回 `ContentBlock[]`，文本块形如 `{ type: 'text', text }`。
- 可选：`presentCall(args)` 返回 `{ card: 'generic', title, kind: 'read'|'edit'|'search'|... }`。
- 工具名唯一，统一 `obsidian_` 前缀。

## 8 个工具与归属

| 工具 | 归属 | 说明 |
|---|---|---|
| `obsidian_read` | vault-core | 单篇读，支持 path 或 note、行区间、附加 frontmatter/links/backlinks/tags/headings/tasks |
| `obsidian_write` | vault-core | 单篇写：overwrite/append/prepend/create/patch + frontmatter 合并 + 乐观并发 version |
| `obsidian_batch_read` | vault-core | 批量读：paths 数组，或 query/glob 选文件 |
| `obsidian_batch_write` | vault-core | 批量写：operations 数组（write/append/prepend/patch/move/copy/delete/mkdir） |
| `obsidian_fs` | vault-core | list/tree/stat/move/copy/delete/mkdir |
| `obsidian_search` | search-engine | 快速查询：text/regex/phrase/tag/property/link/files/recent/headings/tasks |
| `obsidian_status` | Lead | 账户/vault/REST/索引状态聚合；`action:'reindex'` 重建索引 |
| `obsidian_live` | Lead | REST：ping/commands/command/open/active；URI：open-in-app |

## 运行时对象 `rt`（Lead 提供，工具只读它）

```js
rt = {
  config,                                   // ResolvedConfig（见 lib/config.js）
  async vault(),                            // → Vault（懒创建，失败抛清晰错误）
  async index(),                             // → VaultIndex（懒创建 + 按 TTL 增量刷新；写入后强制 stat 刷新）
  async rest(),                             // → ObsidianRest | null（凭据自动发现，见下）
  async status(),                           // → StatusObject
  reset(),                                  // 丢弃缓存的 vault/index/rest
  restSource(),                             // → 'config' | 'vault-plugin' | null
}
```

**REST 凭据发现顺序**（2026-11-05 变更，`rest()` 已改为 async，调用方必须 `await`）：
1. 配置里显式给了 `restApiKey` → 用它（`restSource: 'config'`）
2. 否则读 `<vault>/.obsidian/plugins/obsidian-local-rest-api/data.json` 的 `apiKey` / `port` /
   `insecurePort` / `enableInsecureServer`，拼出 baseUrl（`restSource: 'vault-plugin'`）
3. 都拿不到 → `null`，`obsidian_live` 只保留 `open-app`

这样用户只要启用 Local REST API 社区插件即可，无需把密钥抄进任何 harness 配置。

## 多仓库切换（v1.1，2026-11-06，FROZEN）

面板从「设置」移到**左侧标签栏**，并支持在运行时换仓库 —— 换仓后 8 个工具立刻作用在新仓库上。

### 状态文件

`<homedir>/.dsh/obsidian-hub/state.json`（Windows 形如 `C:\Users\<你>\.dsh\obsidian-hub\state.json`）：

```json
{ "version": 1, "vaultPath": "D:\\obsidian\\obsidian", "updatedAt": "2026-11-06T04:08:00.000Z" }
```

- 读失败 / JSON 损坏 / 字段类型不对 → 当作「没有状态」，**绝不抛**。
- 写：先写 `state.json.tmp` 再 replace 到目标（Windows 上 rename 到已存在文件会失败，需先 unlink 或重试）。

### 活动仓库优先级

1. `state.json` 的 `vaultPath` —— 面板里切换过 → `vault.source: 'state'`
2. 配置 `vaultPath` → `'config'`
3. `obsidian.json` 自动探测当前打开的 vault → `'auto'`

### `rt` 新增成员

```js
rt = {
  ...既有成员,
  async setRoot(rootOrNull),  // 校验目录存在 → 写状态文件（null = 删除状态）→ 清 vault/index/rest 缓存
                              // 返回 { root: string, source: 'state'|'config'|'auto' }
  async activeRootSource(),   // → 'state' | 'config' | 'auto'（会先解析，未解析时调用也可以）
}
```

切换后必须清掉 `vaultPromise` / `indexPromise` / `restClient` / `indexDirty`，否则工具还在读旧仓库。

### HTTP 接口（`lib/status-route.js`）

`GET /obsidian-hub/status` —— 在原 payload 上新增：

| 字段 | 说明 |
|---|---|
| `vaultSource` | `'state' \| 'config' \| 'auto'` |
| `allowVaultSwitch` | 来自配置 `allowVaultSwitch` |
| `vaults` | `[{ path, name, open, exists, isVault, current }]` —— 候选来自 `obsidian.json` 注册表 + 当前仓库；`isVault` = 该目录下有 `.obsidian` |

`POST /obsidian-hub/vault` —— body `{"path":"<绝对路径>"}` 或 `{"path":null}`（= 回到 config/auto）：

| 情况 | 响应 |
|---|---|
| 成功 | 200 + 与 GET 相同的新 payload（切换后的状态） |
| 路径不存在 / 不是目录 / 切换被禁 | 400 + `{"ok":false,"error":"..."}`（禁用时错误信息要点名 `allowVaultSwitch`） |
| 非 POST | 405 |

### 客户端（`client.js`）

两个注册，id 必须一致，否则侧边栏点了打不开面板：

```js
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
  { name: 'sidebar.panellist', id: 'obsidian-hub', order: 35, label: () => t('panel.title') }, PanelIcon))
ctx.slots.inject('main', () => ctx.slots.register(
  { name: 'main', key: 'obsidian-hub' }, PanelView))
```

- `PanelIcon` 只接收 `{ size, active }`（`SidebarPanelIconOwnerProps`），画一个随主题色的图标。
- `PanelView` 负责：当前仓库 + 来源徽标、候选仓库列表（点击切换）、手输路径 + 切换按钮、
  刷新、笔记数 / 索引 / REST 状态、按标题/路径快速筛选。
- 切换走 `POST /obsidian-hub/vault`，成功后用返回的 payload 直接刷新（不额外再 GET）。
- 错误要显示出来（路径不存在等），不能静默。

### 配置新增

| 键 | 默认 | 说明 |
|---|---|---|
| `allowVaultSwitch` | `true` | 面板里是否允许换仓库；`false` 时 POST 返回 400 |

### 面板的仓库概览区块（v1.1.1，2026-11-06，FROZEN）

`GET /obsidian-hub/status` 再新增两个字段，全部由**已有索引**派生（不额外扫盘）：

```js
tree: [                                   // 顶层目录树，目录在前、文件在后，均按名称排序，总上限 40
  { name: 'notes', type: 'dir',  notes: 12 },      // notes = 该顶层目录下 .md 数量
  { name: 'README.md', type: 'file', rel: 'README.md', title: 'README' },
]
recent: [                                 // 最近修改，最多 8 条，按 mtimeMs 倒序
  { rel: 'notes/a.md', title: 'A', mtimeMs: 1762300000000 },
]
```

- 一律使用 **正斜杠** 的相对路径（Windows 后端也统一成 `/`）。
- 索引不可用时两个字段都是 `[]`，不报错。
- 目录项不递归、不暴露除了「顶层名字 + 该目录下笔记数」以外的信息；文件名/标题会出现在 payload 里（本来就有 `notes.titles`）。

客户端行为：新增「仓库概览」卡片，左列顶层目录（点击 = 把筛选框设为该目录前缀），右列最近修改（点击 = `obsidian://open` 打开那篇）。空仓库时显示一句空状态，不编造数据。

## `lib/vault.js` 契约（vault-core 实现）

```js
export class VaultError extends Error { constructor(message, code) }
export function createVault({ root, exclude, maxFileBytes, trashMode }) → Vault

Vault 成员：
  root: string                     // 绝对原生路径
  norm(rel): string                // 规范化相对路径；越界抛 VaultError('path escapes vault')
  toAbs(rel): string
  isExcluded(rel): boolean
  async resolve(target): {rel, abs} // target={path?}|{note?}：note 走「按标题/文件名/路径后缀」解析
  async stat(rel): {rel,type:'file'|'dir',size,mtimeMs,ctimeMs}|null
  async list(rel='', {recursive,depth,glob,limit}): FileEntry[]      // FileEntry={rel,type,size,mtimeMs}
  async tree(rel='', {depth,includeFiles,limit}): TreeNode            // TreeNode={rel,name,type,children?}
  async read(rel, {offset,limit}): {rel,content,totalLines,truncated,size,mtimeMs,version}
  async readRaw(rel): string
  async write(rel, content, {mode='overwrite',frontmatter,createDirs=true,expectedVersion,newline}):
        {rel,action:'created'|'overwritten'|'appended'|'prepended'|'patched',bytes,mtimeMs,version}
        // mode: overwrite|append|prepend|create|patch（patch 用 {find,replace,all,regex}）
  async patch(rel, {find,replace,all,regex}): {rel,replacements}
  async remove(rel, {toTrash=true,recursive=false}): {rel,action:'trashed'|'deleted'}
  async move(rel, destRel, {overwrite=false}): {from,to}
  async copy(rel, destRel, {overwrite=false}): {from,to}
  async mkdir(rel): {rel,action:'created'|'exists'}
  async *walkMarkdown({includeExcluded=false})  // yield {rel,abs,size,mtimeMs}
```

- `version` = `sha1(content)` 前 16 位十六进制（写入时计算，读取时按内容计算）。
- `write` 在 `expectedVersion` 不匹配时抛 `VaultError(..., 'version_mismatch')`。
- `trashMode: 'trash'` → 移到 `<root>/.trash/<相对路径>`；`'delete'` → 真删。

## `lib/frontmatter.js` 契约（vault-core 实现）

```js
export function parseFrontmatter(text) → {has, data, body, bodyOffset}
export function stringifyFrontmatter(data, body) → string
export function mergeFrontmatter(existing, patch) → data      // 深合并，patch 值 undefined 表示删除
export function yamlParse(text) → object
export function yamlStringify(obj) → string                    // 最小 YAML 子集
export function parseLinks(body) → [{type:'wiki'|'md', target, alias?, heading?, raw}]
export function parseTags(body, data) → string[]              // 去重、去掉 '#'、小写 slug 保留原样
export function parseHeadings(body) → [{level, text, line}]
export function parseTasks(body) → [{line, checked, text}]
export function extractTitle(rel, data, body) → string
```
YAML 子集需支持：`key: value`、引号字符串、`true/false/null`、整数/浮点、行内数组 `[a, b]`、块列表 `- a`、一层嵌套 map、`|`/`>` 块字符串。解析失败必须**不丢数据**（原文保留在 `data.__raw` 并抛可捕获的宽容结果，由调用方决定）。

## `lib/indexer.js` 契约（search-engine 实现）

```js
export class VaultIndex {
  constructor(vault, {maxFiles, maxTotalBytes, ttlMs})
  async build({force=false}) → {notes, folders, tags, links, builtAt, tookMs, truncated}
  async ensureFresh({ttlMs}={}) → void        // TTL 内直接返回；否则增量（mtime+size 比对）更新
  get stats()                                 // {ready, notes, folders, tags, links, builtAt, tookMs, bytes, truncated}
  files                                       // Map<rel, FileRecord>
  tagIndex                                    // Map<tag, Set<rel>>
  propertyIndex                               // Map<key, Map<'json值字符串', Set<rel>>>
  record(rel) → FileRecord|undefined
  resolveNote(nameOrPath) → rel|undefined
  backlinksOf(rel) → [{from, raw}]
  recent(n) → FileRecord[]
}
FileRecord = {
  rel, mtimeMs, size, title, frontmatter, body,
  tags: string[], links: [{target, rel?}], headings: [{level,text,line}],
  tasks: {total, open, done}, wordCount, lcText   // lcText 为小写全文（受 maxFileBytes 截断）
}
```

`ensureFresh` 必须便宜：只 stat 目录/文件，不重读未变文件。索引是**派生缓存**，不是真相来源。

## `lib/search.js` 契约（search-engine 实现）

```js
export function search(index, params) → {
  mode, results: [{rel,title,score?,snippet?,line?,matches?}], total, tookMs, truncated
}
params = {
  mode: 'text'|'regex'|'phrase'|'tag'|'property'|'link'|'files'|'recent'|'headings'|'tasks',
  query?, regex?, tag?, property?: {key, value?}, note?, path?, glob?,
  modifiedAfter?, limit=20, offset=0, contextLines=1
}
```
- `text`：分词（中英混合，中文按字符 bigram + 英文按词）AND 命中，BM25 风格打分。
- `snippet`：命中行 ± `contextLines`，单行 ≤ 300 字符。

## 验收（每个模块自测）

每个 owner 在交付前必须：`node --check <file>` 通过；`test/` 下自己的用例可跑（verifier 会独立复测）。
`node` 命令：`node` 在 PATH 上（若无，用 `C:\Program Files\nodejs\node.exe`）。
