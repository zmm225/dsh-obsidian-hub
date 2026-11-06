# dsh-obsidian-hub — 独立验证报告 (VERIFICATION)

- 验证者：`verifier`（独立、对抗性验证；不采信队友口头报告，全部自行运行）
- 日期：2026-11-05（Asia/Shanghai）；最终回归 2026-11-05 20:35:07
- 对象：`D:\个人提升\obsidian-hub`（v1.0.0），并验证**已安装**进 `desktop` profile 的同一份文件（linked directory）
- 结论：**PASS** —— 8 个工具全部注册并可执行；**88/88 集成测试**、36/36 vault-core 测试、35/35 search 测试全绿；验证期间共查出 **3 个 HIGH + 4 个 MEDIUM + 5 个 LOW**（另有 1 个 INFO 级验证脚本问题），含 2 个只在真实 Host 调用中出现、本地测试漏掉的 defect class，以及本轮 REST 自动发现的 URL 传播缺陷，全部修复并复测通过。真实 Obsidian Local REST API 成功路径已由 Lead 在用户机器上实测通过（ping/commands/command/open/active），verifier 另用 loopback stub 端到端验证了自动发现链路。剩余未验证项见文末（浏览器**视觉**渲染、其他机器/端口上的 REST 行为）。

---

## 1. 验证环境

| 项 | 值 |
|---|---|
| OS | Windows 11 (AMD64) |
| Node | v24.14.0 |
| 插件目录 | `D:\个人提升\obsidian-hub` |
| 安装方式 | profile `desktop`：`package.json` 依赖 `"dsh-obsidian-hub": "link:D:/个人提升/obsidian-hub"`；`node_modules\dsh-obsidian-hub` = Junction → `D:\个人提升\obsidian-hub` |
| DSH profile | `C:\Users\zmmws\.dsh\profiles\desktop` |
| 真实 vault | `D:\obsidian\obsidian`（**只读**；验证全程未写入/删除） |
| 测试 fixture | `%TEMP%\dsh-obsidian-hub-verify\run-<pid>-<rand>\vault`（每个进程独立、跑完自动清理，绝不触碰真实 vault） |
| 外部依赖 | 0（测试只用 Node 内置：node:test / node:assert / node:fs / node:path，另用 node:http 起 loopback REST stub） |

## 2. 验证方法（五层，互相独立）

1. **源码驱动执行层（主）**：`test/integration.test.mjs` 直接 `import('../index.js')`，用伪 Cordis ctx（`ctx.tools.register` 捕获定义、`ctx.effect` 收集 disposer）执行 `apply(ctx, config)`，然后逐工具调用 `execute()`，并把返回值回灌 `output.render()`，同时按 `output.schema` 递归校验返回值。这等价于真实 Host 的注册 + 调用 + 渲染链路，不依赖 GUI。
2. **真实注册表（已安装副本）**：`cordis_inspect_query`（host / `Tool` / `listTools`）读取**运行中 Host** 的工具表，确认 8 个 `obsidian_*` 工具与归一化后的 JSON Schema；`Config.listConfigs` 确认 `obsidian-hub` 条目存在；HTTP `GET http://127.0.0.1:63261/obsidian-hub/status` 端到端验证 status 路由。
3. **同伴测试独立复跑**：`test/vault-core.test.mjs`、`test/search.test.mjs` 由 verifier 独立执行，不采信队友自报。
4. **真实 Host 工具调用**：安装后由 Lead 在真实 Chat/Host 会话中直接调用 8 个工具（status/read/search/write/batch*/fs/live 路径），由此发现两个**本地 harness 无法暴露**的 defect class（lossless-JSON 严格规则、索引 TTL 失效）。verifier 已把这两类固化成回归测试（见 §7 V-LIVE-1/2），并用同一源码路径复跑通过；verifier 自身没有「调用宿主已注册工具」的接口，因此实时调用证据归属 Lead（见 §8 声明）。
5. **Local REST API 凭据自动发现（本轮新增）**：从 vault 自身的 `.obsidian/plugins/obsidian-local-rest-api/data.json` 读取 key/端口（`readRestApiCredentials`）。verifier 用 **loopback HTTP stub** 端到端验证：`rt.restSource()==='vault-plugin'`、client.baseUrl/API key 正确、真实 `ping` 命中 stub 且带 `Bearer` 头、`obsidian_live ping` 与 `obsidian_status` 均使用该客户端；并用「无 data.json」的 fixture 反证不会伪造客户端；用非默认端口的 stub 反证用户可见 URL 必须等于实际使用的 endpoint。Lead 另在用户真实 Obsidian 上实测了真实 REST 调用（见 §5）。

## 3. 精确命令

```powershell
cd D:\个人提升\obsidian-hub

# 语法检查（15 个文件：index.js、client.js、lib/*.js）
node --check index.js
node --check client.js
Get-ChildItem lib -File | ForEach-Object { node --check ('lib/' + $_.Name) }

# 主验证套件（88 tests）
node --test test/integration.test.mjs

# 同伴套件（独立复跑）
node --test test/vault-core.test.mjs      # 36 tests
node --test test/search.test.mjs          # 35 tests

# 已安装副本 / 实时 Host
Get-Item "C:\Users\zmmws\.dsh\profiles\desktop\node_modules\dsh-obsidian-hub" | Select-Object LinkType,Target
#   cordis_inspect_query { platform:'host', provider:'Tool',   method:'listTools' }
#   cordis_inspect_query { platform:'host', provider:'Config', method:'listConfigs', input:{ name:'dsh-obsidian-hub' } }
Invoke-WebRequest -Uri 'http://127.0.0.1:63261/obsidian-hub/status' -UseBasicParsing
```

## 4. 汇总表

| # | 检查项 | 结果 | 证据 |
|---|---|---|---|
| A1 | fixture vault（27 篇笔记 / 33 文件，含 2.16MB、CRLF、BOM、空笔记、坏 YAML、.trash、附件） | PASS | fixture 自检用例 |
| A2 | 模块可导入，`apply()` 注册 8 个工具 + `ctx.effect` 包裹 | PASS | 注册用例 |
| A3 | 每个工具定义符合归一化 JSON Schema 契约（`parameters.type='object'`、`required` 数组、无内联 `required:true`、无 `default/$ref/pattern/format/minimum/maximum`） | PASS | 定义校验用例 + 实时 Host 工具表 |
| A4 | 第二次 `apply()` 无重复注册错误；dispose 后 8 个工具全部反注册 | PASS | 二次 apply 用例 |
| A5 | `lib/tool-schema.js` 归一化 / 幂等 / 非法定义报错 / registerTools 单 disposer + 中途失败回滚 / `toLosslessJson` / `defineTool` 包装 execute | PASS | 7 个单测 |
| B1 | `obsidian_read`：path/note/标题/别名/wikilink、offset/limit、include 六标志、空/CRLF/BOM/坏 frontmatter、2MB 截断、二进制拒绝、越界拒绝 | PASS | 8 个用例 |
| B2 | `obsidian_write`：overwrite/append/prepend/create/patch(all/regex)、frontmatter 深合并/null 清除、expectedVersion 顺序与并发（恰好一个赢）、CRLF、createDirs、越界拒绝 | PASS | 7 个用例 |
| B3 | `obsidian_batch_read`：paths/glob/query/limit、逐项错误、warnings | PASS | 1 个用例 |
| B4 | `obsidian_batch_write`：9 种操作混合、validation-before-execute、逐项 {index,ok}、continueOnError=false 的 skipped、未知类型、>200 拒绝 | PASS | 3 个用例 |
| B5 | `obsidian_fs`：list/tree/stat/move/copy/delete(trash)/mkdir、.obsidian/.trash 排除、glob/limit/truncated、递归删除保护、越界拒绝 | PASS | 2 个用例 |
| B6 | `obsidian_search`：text（中英/CJK bigram/ALL-term/BM25 排序）、phrase、regex（非法报错）、tag（前缀）、property、link（backlinks）、files、recent、headings、tasks、stats、glob/path/modifiedAfter/分页/截断、渲染 8000 字符上限 | PASS | 11 个用例（真索引 + fake index 双通道） |
| B7 | `obsidian_status`：info/reindex/vaults、真实 vault 统计、REST 未配置如实上报、bogus vault 路径→ok=false | PASS | 状态用例 |
| B8 | `obsidian_live`：无 REST key 时 ping/commands/active/command 快速失败并给出配置指引；open-app 对不存在笔记在 resolve 阶段抛错（未触发 URI handler） | PASS | 隔离 + 集成用例 |
| C1 | 故障注入：不存在 vault、缺失/损坏 obsidian.json、路径穿越（5 种写法）、二进制文件、2MB 大文件、坏 YAML、无 REST key —— 全部快速失败且信息可操作，无挂起、无崩溃 | PASS | 对应用例（含 5s/3s 时限断言） |
| C2 | 并发：10 路并发 append 全部成功且内容零丢失；同 expectedVersion 并发恰好 1 成功 + 1 `version_mismatch` | PASS | 2 个用例 |
| D1 | 性能（fixture 37 篇）：索引 wall 40.3ms / 内部 17.22ms；文本搜索 0.14ms（1 命中） | PASS | 见 §6 |
| D2 | 性能（400 篇合成 vault）：索引 wall 204.8ms / 内部 90ms；文本搜索 0.51ms（40 命中）；tag 搜索 0.17ms（57 命中） | PASS | 见 §6 |
| D3 | `indexMaxFiles:5` 时 `stats.notes=5`、`truncated=true` 并渲染告警 | PASS | 限流用例 |
| E1 | `locale/en.json`、`locale/zh.json` 合法 JSON，`meta.title` 分别 = "Obsidian Hub" / "Obsidian 知识库中枢"，`meta.description` 非空 | PASS | 资源用例 |
| E2 | `icon.svg` 合法 XML、≤256KiB（1,194B） | PASS | 资源用例 |
| E3 | `package.json` exports（`.` / `./client` / `./locale/*.json` / `./icon`）解析到真实文件；`dsh.bundle.patch` 存在 | PASS | 资源用例 |
| E4 | `client.js` 无 top-level ESM import、无 `@deepseek-ai/*`、`node --check` 通过、含 `__ModuleLoader__` 加载格式 | PASS | 资源用例 |
| F1 | 已安装副本：Junction → `D:\个人提升\obsidian-hub`；profile bundles 含 `dsh-obsidian-hub` | PASS | 见 §5 |
| F2 | 实时 Host 工具表：8/8 `obsidian_*` 存在，schema 已归一化（required 数组、无内联 required:true、属性 type 齐全、required 名均存在） | PASS | 见 §5 |
| F3 | `GET /obsidian-hub/status` → HTTP 200，返回真实 vault 路径 / 笔记数 / index ready / REST configured=false | PASS | 见 §5 |
| F4 | **V-LIVE-1 回归**：8 个工具的 `execute()` 返回值全部通过 Host 严格 lossless-JSON 规则（自包含 `visitJsonValue` 等价校验：对象原型/可枚举性/符号键、数组 extra own props、`-0`/非有限数）；覆盖 `obsidian_read` 带 frontmatter、空 frontmatter、`obsidian_live`（fake REST 成功值）；并反证校验器会拒绝历史坏形状 | PASS | DEFECT-LIVE-1 ×2 + toLosslessJson/defineTool 单测，共 4 个用例 |
| F5 | **V-LIVE-2 回归**：先建索引→读笔记不强制 rescan（`stats.reads` 不变）→写新笔记→**立即**搜索到唯一 token（60s TTL 内），索引 notes/reads 增长 | PASS | DEFECT-LIVE-2 用例 |
| H1 | `readRestApiCredentials` 单元：无文件/坏 JSON/空 key/数字 key→null；secure 默认/自定义端口→https；insecure→`http://…:<insecurePort>`；非数字端口回退 27124/27123；双开时 secure 优先 | PASS | 1 个用例（10 组输入） |
| H2 | 自动发现集成：vault 内 `data.json` + `restApiKey:''` → `restSource()==='vault-plugin'`、client.baseUrl/key 正确、真实 `ping` 命中 loopback stub（带 `Bearer` 头）、`obsidian_live ping` 与 `obsidian_status` 使用该客户端 | PASS | REST discovery 用例 |
| H3 | **反证**无 `data.json`：`rt.rest()===null`、`restSource()===null`、`obsidian_live ping` 报 "not configured or not reachable" + `restApiKey` 指引 | PASS | 对照用例（主 fixture 保持无 data.json） |
| H4 | 显式 `restApiKey` 优先：data.json 存在时 `restSource()==='config'`，使用 `config.restBaseUrl`/key 而非插件端口 | PASS | 优先级用例 |
| H5 | 用户可见 URL 传播：非默认端口 stub 下 status-route 的 `rest.url` 与 `obsidian_live ping` 摘要均等于实际 `client.baseUrl`（V-REST-URL 回归） | PASS（修复后） | DEFECT-CHECK 用例 |
| G1 | Client 面板在实时 UI 的**注册**（`settings.section` occupant = obsidian-hub） | **PASS（Lead 实测）** | Lead 通过 client slot occupants 确认 active；verifier 的 client inspect 通道仍超时 |
| G1b | 浏览器中的**视觉渲染**（像素/DOM 层，非注册） | **NOT VERIFIED** | verifier 无截图/DOM 通道，不冒充已看渲染 |
| G2 | 真实 Obsidian Local REST API 成功路径（ping/commands/command/open/active） | **PASS（Lead 在用户运行中的 Obsidian 实测）** + verifier loopback stub 端到端 | 见 §5；用户机器端点 = `https://127.0.0.1:27124` |
| G2b | 其他机器/端口上的 REST 行为 | **NOT VERIFIED** | 仅用户本机（默认端口）实测 |
| G3 | 真实 vault 写入/删除（由 verifier 执行） | **NOT VERIFIED（策略禁止）** | verifier 全程只读；Lead 的实时自检写入已恢复（见 §5/§8） |
| G4 | 真实 Host 工具调用（由 Lead 在安装后执行，非 verifier） | **PASS（Lead 实测）** | status info/vaults/reindex；read path/note/includes；search text/tag/property/stats；write create+frontmatter；batch_write 4/4；batch_read 2/2+tasks；fs tree/delete-to-trash；write→search 即时可见；真实 vault 已恢复为 1 篇 |

## 5. 已安装副本 / 实时 Host 证据

- `C:\Users\zmmws\.dsh\profiles\desktop\package.json`：`"dsh-obsidian-hub": "link:D:/个人提升/obsidian-hub"`，`dsh.profile.bundles` 末尾含 `dsh-obsidian-hub`。
- `node_modules\dsh-obsidian-hub`：`LinkType: Junction`，`Target: D:\个人提升\obsidian-hub`（安装的确实是当前源码目录）。
- `cordis_inspect_query host/Tool/listTools`（共 131 个工具，其中 8 个 obsidian）：
  - `obsidian_read` props=[path,note,offset,limit,include]
  - `obsidian_write` props=[path,content,mode,frontmatter,find,replace,all,regex,expectedVersion,createDirs,newline]，required=[path]
  - `obsidian_batch_read` props=[paths,glob,query,limit,maxChars,include]
  - `obsidian_batch_write` props=[operations,continueOnError]，required=[operations]
  - `obsidian_fs` props=[action,path,dest,recursive,depth,glob,limit,includeFiles,toTrash,overwrite]，required=[action]
  - `obsidian_search` props=[mode,query,regex,tag,propertyKey,propertyValue,note,path,glob,modifiedAfter,limit,offset,contextLines]，required=[mode]
  - `obsidian_status` props=[action]；`obsidian_live` props=[action,command,path,note]
  - 全部：`parameters.type='object'`、无 `required:true` 内联标记、无未声明的 required、描述非空且无重复。
- `cordis_inspect_query host/Config/listConfigs {name:'dsh-obsidian-hub'}`：条目 `include:obsidian-hub`（patchId `obsidian-hub`）存在。
- `GET http://127.0.0.1:63261/obsidian-hub/status` → `HTTP 200`，`{"ok":true,"vaultPath":"D:\\obsidian\\obsidian","notes":{"count":2,...},"index":{"ready":true,...},"rest":{"configured":false,"reachable":false,...}}`。这同时验证了曾被查出「status 路由未接线」的 HIGH 缺陷确已修复。
- **真实 Host 调用（Lead 实测，安装后）**：8/8 工具在真实会话中可调用；实际执行 status info/vaults/reindex、read（path/note/includes）、search（text/tag/property/stats）、write（create+frontmatter）、batch_write（write/append/copy/patch 4/4）、batch_read（2/2 + tasks）、fs（tree/delete-to-trash），以及「写完立即搜索」；由此发现 V-LIVE-1/2。真实 vault 自检产生的 `自检/` 已移入 `.trash`，恢复为 1 篇笔记。
- **真实 Obsidian Local REST API（Lead 实测，用户机器 Obsidian 运行中）**：`readRestApiCredentials` → `https://127.0.0.1:27124`；`ping` → authenticated，service `Obsidian Local REST API 5.5.2` / obsidian 1.15.0；`commands` → 204 条；`obsidian_live command "editor:save-file"` → 执行成功；`open 欢迎.md` → 打开成功；`active` → 返回该笔记 113 字符正文。这些是真实应用级证据（verifier 无宿主工具调用接口，故归因 Lead）。
- **verifier 侧 REST 自动发现端到端（loopback stub，非用户 Obsidian）**：真实 `http` 客户端 + 真实 `rest.js`/`runtime.js`/`tools-live.js`/`status-route.js` 代码路径；断言 `restSource()==='vault-plugin'`、`client.baseUrl='http://127.0.0.1:<stub>'`（**非默认端口**）、请求头 `Authorization: Bearer <data.json apiKey>`、`ping.authenticated=true`、`obsidian_live ping` ok、`obsidian_status` 摘要含 `REST API: reachable` + `Local REST API plugin: enabled`；对照组（无 data.json）→ `rt.rest()===null` 且 ping 报可操作错误；显式 `restApiKey` 存在时 `restSource()==='config'`。
- **插件数据位置与只读性**：REST 凭据来自 `<vault>/.obsidian/plugins/obsidian-local-rest-api/data.json`；本插件**只读取**该文件（verifier 测试均为临时 fixture 写入），从不写回；显式 `restApiKey` 仍然覆盖自动发现（H4）。

### 5b. linked bundle 热重载流程（Lead 实测）

**关键事实：linked 目录安装的 bundle，运行中的 Host 不会重新 import 已修改的 JS 文件**（模块代际已缓存）。要让源码修改在**不重启 App** 的情况下生效，使用：

```text
plugin_manager set_bundle target=dsh-obsidian-hub enabled=false
plugin_manager set_bundle target=dsh-obsidian-hub enabled=true
```

这两步会重建该 bundle 的模块代际并热加载新代码（Lead 用 build-probe sentinel 验证过新模块确实被加载）。本次 V-LIVE-1（`lib/tool-schema.js` 的 `toLosslessJson` 包装）与 V-LIVE-2（`lib/runtime.js` 的 `indexDirty` Proxy）即通过该流程在运行中的 Host 生效，无需重启桌面端。

## 6. 性能测量（最终回归 2026-11-05 20:35:07，实测非估算）

| 场景 | 索引构建（wall / 内部 tookMs） | 查询 |
|---|---|---|
| fixture vault（37 篇，含 2.16MB 笔记） | 48.8ms / 19.98ms | text「zebraquartz」0.16ms，1 命中 |
| 400 篇合成 vault | 213.5ms / 98.22ms，truncated=false | text「needleword」0.40ms，40 命中；tag「group/03」0.19ms，57 命中 |
| detectObsidianApp（同步 spawnSync 探测） | 141–238ms | 无挂起（硬上限 10s 断言通过） |

结论：查询为内存内同步执行，毫秒级；索引构建线性可接受（400 篇 ≈ 0.2s）。索引在 TTL 内不重读未变文件；**写操作会主动置 dirty，下一次 `index()` 强制 stat 刷新**（V-LIVE-2），因此「写完立即搜索」可见且只多一次目录 stat walk。

## 7. 缺陷清单（严重度排序，均已在最终代码中修复并复测）

| ID | 严重度 | 状态 | 文件 | 现象 / 期望 | 复测证据 |
|---|---|---|---|---|---|
| V-01 | **HIGH** | 已修复 | `index.js` | `registerStatusRoute` 被 import 但从未调用 → Web 面板依赖的 `GET /obsidian-hub/status` 404。期望：apply 中注册并随 ctx 释放 | 实测 HTTP 200 + 正常 JSON |
| V-02 | **HIGH** | 已修复 | `lib/tools-vault.js` | `obsidian_write` 返回 vault 的 `{rel,...}`，但 output.schema 要求 `path`、render 打印 `value.path` → 渲染成 "created undefined — 2 bytes"，违反「schema 必须覆盖返回值」 | 现返回 `{path,...}`，render 正确；schema 校验单测通过 |
| V-03 | MEDIUM | 已修复 | `lib/vault.js` | 读取 `image.png` 返回 68 字符乱码（10 个 U+FFFD）、`truncated:false`，无提示。期望：`VaultError('binary_file')` | 现抛 "Not a text file: image.png (70 bytes, looks like .png)…" |
| V-04 | MEDIUM | 已修复 | `lib/vault.js` | 10 路并发 append：多条报成功但最终仅剩最后一条（丢数据），并偶发 permission_denied。期望：写队列串行或明确拒绝 | 现 10/10 成功、line-0…line-9 全部在；同版本并发恰好 1 成功 + 1 version_mismatch |
| V-05 | MEDIUM | 已修复 | `lib/runtime.js` | 配置的 vaultPath 不存在时 `status.ok=true`、摘要 "connected"，仅 "vault readable: no"。期望 ok=false + vault.error / "not connected" | 现 ok=false、摘要 "not connected"、含 vault error |
| V-06 | LOW | 已修复 | `lib/runtime.js` | `account.syncConfigured: … ? undefined : undefined` 恒为 undefined → 状态结果 JSON round-trip 丢键 | 字段已删，JSON 无损断言通过 |
| V-07 | LOW | 已修复 | `lib/vault.js` | `resolve({note})` 不支持 frontmatter 标题/别名（`Home`、`English Note`、`[[Home]]` 均 not_found），与 ARCHITECTURE「按标题/文件名/路径后缀」及 indexer.resolveNote 不一致 | 现三者在集成用例中均解析成功 |
| V-08 | LOW | 已修复 | `lib/config.js` | `bundleDir` 指向 `lib/` 而非 bundle 根（注释与语义不符） | 现为插件根目录（断言通过） |
| V-09 | LOW | 已修复 | `lib/rest.js` | `new ObsidianRest({baseUrl:''})` 抛 TypeError: Invalid URL。期望：可构造且 `configured=false`；非法非空 URL 抛具名 `RestError('invalid_url')` | 两条断言均通过 |
| **V-REST-URL** | LOW | 已修复 | `lib/status-route.js`、`lib/tools-live.js` | 自动发现到的端点**非默认端口**时，`/obsidian-hub/status` 的 `rest.url` 与 `obsidian_live ping` 摘要仍打印 `config.restBaseUrl`（默认 `https://127.0.0.1:27124`），与实际使用的 `client.baseUrl` 不一致 → 面板/模型被告知错误端点。期望：用户可见 URL = 实际 endpoint | 修复为 `client.baseUrl` / `active.baseUrl`；verifier 用非默认端口 loopback stub 回归通过（默认端口下旧代码也能"碰巧正确"，故该用例必须用非默认端口） |
| **V-LIVE-1** | **HIGH** | 已修复 | `lib/tool-schema.js`（修复） | **只在真实 Host 出现**：`obsidian_read` + `include:["frontmatter"]` 报 `returned invalid output: value is not lossless JSON`；本地测试全绿因为旧 harness 只做 JSON/deepStrictEqual。Host 规则（Lead 从 app.asar `snapshotJsonValue→visitJsonValue` 提取）更严格：对象自有键必须全部可枚举、禁止 symbol 键、原型必须是 Object.prototype/null；数组原型必须是 Array.prototype 且 `Reflect.ownKeys(arr).length === arr.length+1`；数字有限且非 `-0`。根因：frontmatter 解析结果携带隐藏 metadata（symbol 键）。期望：注册前的值必须是 lossless JSON | Lead 的热重载实测已通过；verifier 回归：整库所有 execute 值都过严格规则 + 8 工具专项 + 带/空 frontmatter，且反证校验器能拒绝历史坏形状 |
| **V-LIVE-2** | MEDIUM | 已修复 | `lib/runtime.js`（修复） | **只在真实 Host 出现**：`obsidian_write` 后**立即** `obsidian_search` 得不到新笔记（TTL 默认 8000ms 内索引不刷新），破坏「写完就查」的 Agent 循环。期望：写操作使索引 dirty，下一次查询强制 stat 刷新 | verifier 回归：60s TTL 下写→立即搜到唯一 token；只读不触发 rescan（`stats.reads` 不变） |
| V-10 | INFO | 不适用（验证代码） | `test/fixture.mjs`、`test/integration.test.mjs` | 验证器自身两个问题已修正：① 固定 temp 路径在并发 `node --test` 下会被别的进程清掉 → 改为每进程独立 `run-<pid>-<rand>`；② `node:test` 的 `after()` 在 `--test-name-pattern` 过滤时会先于测试体执行 → 清理改挂 `process.on('exit')` | 全套稳定通过 |

修复后最终回归（2026-11-05 20:35:07）：`node --test test/integration.test.mjs` = **88/88 pass, 0 fail, 0 skipped**（本轮新增 REST 自动发现/优先级/反证/URL 传播共 5 个用例，其中含 1 个曾失败、修复后转绿的 DEFECT-CHECK）；`node --test test/vault-core.test.mjs` = **36/36**；`node --test test/search.test.mjs` = **35/35**；`node --check` 15 文件 0 失败。当前源码 mtimes：`lib/discover.js`/`lib/runtime.js` 20:29，`lib/status-route.js`/`lib/tools-live.js` 20:34（REST 修复）。

## 8. 未能验证 / 证据边界（明确声明，不当作通过）

1. **浏览器视觉渲染**：面板在实时 UI 的**注册**已由 Lead 通过 client slot occupants 确认为 active（`settings.section` → `obsidian-hub`）；但 verifier 的 client inspect 通道（`Slots.listSubTree`、`Service.listService`）两次 10s 超时，**没有**像素/DOM 层证据，也没有截图。`client.js` 仅通过静态校验（语法、加载格式、无外部 import）——**BROWSER VISUAL RENDERING: NOT VERIFIED**（注册 ≠ 渲染正确）。
2. **真实 Obsidian Local REST API**：已**不再 BLOCKED**。Lead 在用户运行中的 Obsidian 上实测：`ping`（authenticated，service `Obsidian Local REST API 5.5.2` / obsidian 1.15.0）、`commands`（204 条）、`command "editor:save-file"`（执行成功）、`open 欢迎.md`（打开成功）、`active`（返回 113 字符正文）。verifier 用 loopback stub 独立验证了同一条代码链（自动发现→client→ping→工具/状态输出，含非默认端口与 Bearer 头）。**仍未验证**：其他机器/端口组合上的真实 REST 行为；verifier 本人没有直接调用用户真实 REST API（归因 Lead）。
3. **真实 Host 工具调用的证据归属**：verifier 会话没有「调用宿主已注册工具」的接口，因此不能亲自执行真实 Host 调用。该层由 **Lead 在安装后的真实会话中实测**（8 个工具的实际调用，并由此发现 V-LIVE-1/2）；verifier 已独立把这两类问题固化为回归测试，并在当前源码上复跑通过。因此「宿主级调用」为「已覆盖（Lead 实测 + verifier 回归）」，但 verifier 不冒充亲自执行过 live 调用。
4. **真实 vault 写操作（verifier）**：按任务约束 verifier 全程只读。Lead 的实时自检曾在真实 vault 创建 `自检/`，随后按要求将其移入 `.trash`，现在真实 vault 恢复为 1 篇笔记（status 实测 `notes=1`）。
5. **linked bundle 热重载**：由 Lead 实测（`set_bundle enabled:false→true`，build-probe sentinel 证明新模块代际被加载）；verifier 未重复执行该重载操作。本轮 V-REST-URL 修复（`lib/status-route.js`、`lib/tools-live.js`，mtime 20:34）需在 Lead 的最终 `set_bundle` 热重载后才进入运行中的 Host；verifier 已在**源码路径**复跑通过，重载后的实时 status 路由可再次复检（修复前实测为 HTTP 200，`notes=1`）。
6. **REST 凭据文件的只读性**：插件只读 `<vault>/.obsidian/plugins/obsidian-local-rest-api/data.json`，从不写回；显式 `restApiKey` 覆盖自动发现（H4 已验证）。verifier 的所有写入均发生在临时 fixture vault，真实 vault 不写。

## 9. 复现要点

- 主套件可重复执行：`node --test test/integration.test.mjs`；fixture 每进程唯一（`%TEMP%\dsh-obsidian-hub-verify\run-<pid>-<rand>`），进程退出自动清理；不会触碰真实 vault。
- 新增回归（V-LIVE-1/2）就在主套件内，无需额外命令：`DEFECT-LIVE-1 regression`（严格 lossless 规则覆盖 8 工具 + frontmatter 变体）、`DEFECT-LIVE-1 guard`（反证校验器会拒绝历史坏形状）、`DEFECT-LIVE-2 regression`（60s TTL 下写后立即搜索可见、只读不 rescan）。
- **REST 自动发现回归**也在主套件内：`discover: readRestApiCredentials …`（单元）、`REST auto-discovery: vault plugin data yields a live client…`（临时 vault 内写 `data.json` + loopback `http` stub，真实 HTTP ping）、`… WITHOUT the plugin data keeps the no-REST path`（反证）、`… explicit restApiKey wins`、`DEFECT-CHECK: auto-discovered REST credentials must propagate to user-facing URLs`（非默认端口 stub 下校验 status-route `rest.url` 与 ping 摘要）。这些测试只在 `%TEMP%` fixture 中写 plugin data，主 fixture 永远不写 `data.json`（否则会破坏无 REST 用例）。
- 实时验证步骤见 §3（工具表、配置、HTTP 路由）；若 client inspect 通道恢复，可再执行 `Slots.listSubTree {root:'settings.section'}` 补齐 G1b。
- **热重载**（修改 linked bundle 源码后让运行中的 Host 重新 import）：见 §5b —— `plugin_manager set_bundle enabled:false` → `enabled:true`；仅重启插件 bundle 即可，无需重启 App。
- 测试代码允许的依赖仅 Node 内置（`node:test/node:assert/node:fs/node:path`，另用 `node:http` 起 loopback stub）；插件本身零外部依赖。

---

*本报告只记录 verifier 亲自运行得到的结果；队友的单方面报告未被采信。安装成功不等于行为正确——上述 PASS 均基于实际调用与返回值/schema/render 校验。*
