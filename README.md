# Obsidian Hub — DeepSeek Harness 插件

把 Obsidian 知识库接成 Agent 的一等能力：**读、写、批量读、批量写、快速查询**，以及在 Obsidian 运行中时的**实时操作**（执行命令、打开笔记、读活动笔记）。

- 安装后向 Agent 暴露 8 个 `obsidian_*` 工具
- 主通道是**直接文件系统**：Obsidian 关着也能读写，批量操作快
- 次通道是 **Local REST API** 社区插件：能驱动正在运行的 Obsidian
- 附带一个 Web UI 面板：显示连接状态 + 笔记快速筛选

---

## 1. 关于「账户」和「工作区」——先说实话

Obsidian **没有公开的账户 API、Sync API、Publish API**。任何声称能"登录你的 Obsidian 账户"的第三方插件都做不到官方意义上的登录。

所以本插件的「连接」是这三样东西，`obsidian_status` 会如实报告：

| 维度 | 真实来源 | 能做什么 |
|---|---|---|
| 本机 Obsidian 安装 | `obsidian://` 协议处理程序 + `%APPDATA%\obsidian\obsidian.log` | 报告安装路径、版本、是否运行中 |
| 工作区 / Vault 注册表 | `%APPDATA%\obsidian\obsidian.json` | 列出所有 vault、哪个是当前打开的 |
| Vault 自身 | `<vault>/.obsidian/*.json` | 核心插件、社区插件、主题、工作区布局 |
| 运行中的 App | Local REST API 插件（需你另外安装） | 执行命令、开笔记、读活动笔记 |

`.obsidian` 里 `core-plugins` 含 `sync` 只说明「Sync 这个核心插件被启用」，**不代表**能读到你的账户身份或同步状态——那些在 Obsidian 自己的加密存储里，插件读不到。变化通过文件系统落到磁盘，再由你自己配置的同步方式分发到其他设备。

---

## 2. 8 个工具

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `obsidian_read` | 读单篇笔记 | `path` 或 `note`、`offset`、`limit`、`include`(frontmatter/links/backlinks/tags/headings/tasks) |
| `obsidian_write` | 写单篇笔记 | `path`/`note`、`content`、`mode`(overwrite/append/prepend/create/patch)、`frontmatter`、`expectedVersion` |
| `obsidian_batch_read` | 批量读 | `paths[]` 或 `query`/`glob`、`limit`、`lines` |
| `obsidian_batch_write` | 批量写/搬/删 | `operations[]`、`continueOnError` |
| `obsidian_fs` | 文件系统操作 | `action`(list/tree/stat/move/copy/delete/mkdir)、`path`、`dest` |
| `obsidian_search` | 快速查询 | `mode`(text/regex/phrase/tag/property/link/files/recent/headings/tasks/stats)、`query`、过滤器、`limit`/`offset` |
| `obsidian_status` | 连接诊断 + 重建索引 | `action`(info/reindex/vaults) |
| `obsidian_live` | 驱动运行中的 Obsidian | `action`(ping/commands/command/active/open/open-app) |

设计取向：**少而强**。同类操作合并到 `mode` / `action` 参数里，避免 20 个单薄工具把上下文塞满。

---

## 3. 安装

插件是一个 DSH bundle 包（不是 npm 包），可以从 GitHub 直接装：

```
plugin_manager({ action: "install_bundle", target: "github:zmm225/dsh-obsidian-hub" })
```

或者先 clone / 解压到本地目录，再装本地路径：

```
plugin_manager({ action: "install_bundle", target: "D:\\plugins\\dsh-obsidian-hub" })
```

装完用 `cordis_inspect_query` (host, provider `Tool`, method `listTools`) 确认 `obsidian_*` 出现。

从 GitHub 安装时，pnpm 会 clone 到 profile 的 `node_modules`；**更新插件**就重新跑一次
`install_bundle`，或改 `package.json` 里的 tag/commit 再装。

### 改代码后怎么让它生效（重要）

本地 bundle 是以 **junction/软链**装进 profile 的，文件改动**不会**被运行中的 Host 重新 import——ESM 模块已有缓存。
改完源码后，二选一：

1. **热重载（无需重启）**：`plugin_manager({ action: "set_bundle", target: "dsh-obsidian-hub", enabled: false })`
   然后 `enabled: true`。这会换一代 module generation，已验证有效。
2. 重启 DeepSeek Harness。

只改 `client.js` / `locale/*.json` 这类浏览器侧资源时，刷新页面即可。

### 让 Agent 能驱动正在运行的 Obsidian（零配置）

1. 在 Obsidian 里安装社区插件 **Local REST API**（`obsidian-local-rest-api`，作者 Adam Coddington）
2. 打开它的设置，**启用**（默认就监听 `https://127.0.0.1:27124`）

**不需要复制 Key。** 插件会自己从
`<vault>/.obsidian/plugins/obsidian-local-rest-api/data.json` 读取端口和 API Key；
Key 换了、端口改了都自动跟随，配置文件里什么都不用写。

> 注意：「Local REST API - Periodic Notes」是它的**附加插件**，单独安装不起作用，必须先有主插件。

想手动指定（比如 REST 在另一台机器上）再改配置——那才需要 `restApiKey` / `restBaseUrl`。

没有可用的 REST 时，`obsidian_live` 只有 `open-app`（走 `obsidian://` 协议）可用，其余会给出明确提示；
其余 7 个工具完全不受影响，因为主通道是文件系统。

**改配置要改你自己的 patch 层**，不要改插件目录里的 `cordis.patch.yml`（那是 bundle 默认层，重装会被覆盖）。
在 profile 的 patch 层加一条覆盖即可：

```yaml
# <你的 profile 目录>/cordis.patch.yml
# Windows 默认：C:\Users\<你>\.dsh\profiles\desktop\cordis.patch.yml
- id: obsidian-hub
  name: dsh-obsidian-hub
  config:
    restApiKey: "留空即可：会自动读 Local REST API 插件设置里的 Key"
    vaultPath: "D:\\obsidian\\obsidian"
```

bundle 层的 id 与 name 必须一致（`id: obsidian-hub` / `name: dsh-obsidian-hub`），
这一层在 bundle 之后应用，所以覆盖生效且插件升级不丢配置。

---

## 4. 配置项（`cordis.patch.yml` 里 `id: obsidian-hub` 的 `config`）

| 键 | 默认 | 说明 |
|---|---|---|
| `vaultPath` | `''` | 空 = 自动从 `obsidian.json` 取当前打开的 vault |
| `autoDetect` | `true` | `vaultPath` 为空时是否自动探测 |
| `exclude` | `.obsidian/**`, `.trash/**`, `**/node_modules/**`, `**/.git/**` | 索引与批量遍历的排除规则 |
| `restBaseUrl` | `https://127.0.0.1:27124` | 仅在手动指定时生效；留空/默认时用 vault 插件设置里的端口 |
| `restApiKey` | `''` | 空 = 自动从 vault 的 Local REST API 插件设置读取（推荐）；填了就以此为准 |
| `restInsecure` | `true` | 跳过自签证书校验（本机回环可接受） |
| `indexTtlMs` | `8000` | 索引新鲜度 TTL；TTL 内查询直接命中缓存 |
| `indexMaxFiles` | `20000` | 索引文件数上限 |
| `indexMaxTotalBytes` | `67108864` | 索引正文总字节上限（超出置 `truncated`） |
| `maxFileBytes` | `2097152` | 单文件读取上限 |
| `defaultReadLimit` | `400` | `obsidian_read` 默认返回行数 |
| `trashMode` | `trash` | `trash` = 移到 `<vault>/.trash/`；`delete` = 真删 |

改配置后不需要重装，profile patch 层会重新应用到插件行。

---

## 5. 目录结构

```
obsidian-hub/
├─ index.js               # Host 入口：注册 8 个工具
├─ client.js              # Web UI 面板（动态客户端模块）
├─ cordis.patch.yml       # bundle patch：插入 obsidian-hub 行
├─ lib/
│  ├─ config.js           # 配置解析
│  ├─ runtime.js          # Vault/Index/REST 懒加载与状态聚合
│  ├─ discover.js         # 账户/安装/vault 注册表发现
│  ├─ vault.js            # 文件系统数据面（路径安全、原子写、trash）
│  ├─ frontmatter.js      # 零依赖 YAML frontmatter 与 Markdown 结构解析
│  ├─ indexer.js          # 增量索引（stat 比对，不改不重读）
│  ├─ search.js           # BM25 + CJK bigram 查询引擎
│  ├─ rest.js             # Local REST API 客户端（node:https，自签证书）
│  ├─ tools-vault.js      # read/write/batch/fs 工具
│  ├─ tools-search.js     # search 工具
│  └─ tools-live.js       # status/live 工具
├─ locale/{en,zh}.json    # 插件标题与描述
├─ icon.svg
└─ test/                  # node:test 用例与夹具
```

---

## 6. 设计约束

- **零外部依赖**：只 import 相对文件与 Node 内置模块。本地 bundle 以目录 link 安装，解析不到 harness 自己的 `node_modules`。
- **写入永不越界**：所有路径经 vault 归一化校验，`../` 直接拒绝。
- **原子写**：临时文件 + rename，避免写一半留下坏笔记。
- **乐观并发**：`obsidian_write` 支持 `expectedVersion`，冲突时报错而不是静默覆盖用户手写的内容。
- **索引是派生缓存**：真相永远是磁盘；索引只做 `mtime+size` 增量更新。
- **大输出截断**：任何工具都不会把整库正文倒进上下文。

## 7. 已知边界

- Vault 在 OneDrive/iCloud 等按需下载目录里时，超时文件可能是占位符，读会失败——插件会如实报错。
- Local REST API 走 HTTPS 自签证书，`restInsecure: false` 时需要你自己信任该证书。
- 附件（图片/PDF）只做存在性、大小、链接解析；不做 OCR/嵌入。
- 索引存在进程内存里，Host 重启后首次查询会重建（小库毫秒级，大库数秒）。
