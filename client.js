/**
 * dsh-obsidian-hub — Web (browser) half, v1.1.
 *
 * Two registrations, with the SAME id/key so the sidebar button opens this panel:
 * - `sidebar.panellist`, id `obsidian-hub`  -> the icon in the left sidebar
 * - `main`, key `obsidian-hub`              -> the panel body
 *
 * The panel shows the active vault (path, name, source), the candidate vaults
 * from the Host's registry, a runtime vault switcher (POST), the index / REST
 * status, and a quick filter over note titles/paths.
 *
 * Contract notes:
 * - Loaded as a dynamic module through `window.__ModuleLoader__`; React comes
 *   from the browser module table, nothing else is imported.
 * - The Host half owns the vault. This file never touches the filesystem and
 *   never invents data: it reads `GET /obsidian-hub/status`, writes switches
 *   with `POST /obsidian-hub/vault`, and renders an explicit "waiting for data"
 *   state until the GET answers.
 * - Crash-safety matters more than features: a throwing component blanks its
 *   slot, so every render path is defensive, an error boundary sits above the
 *   panel, the icon has its own try/catch, and `apply` swallows every failure.
 */

window.__ModuleLoader__.load({
  id: 'dsh-obsidian-hub',
  factory(require) {
    'use strict'

    /* ------------------------------------------------------------------ react */

    let React = null
    try {
      React = require('react')
    } catch (error) {
      React = null
    }

    const h = React !== null && typeof React.createElement === 'function'
      ? React.createElement
      : null
    const hasHooks = React !== null
      && typeof React.useState === 'function'
      && typeof React.useEffect === 'function'
      && typeof React.useRef === 'function'
    const BaseComponent = React !== null && typeof React.Component === 'function'
      ? React.Component
      : null

    /* ------------------------------------------------------------------ i18n */

    // Inline zh/en dictionary. The client is registered with `inject: ['slots']`
    // only, so the host locale service is not reachable from here; the language
    // is detected from the document/browser instead.
    const DICT = {
      en: {
        'panel.title': 'Obsidian Hub',
        'status.connected': 'Connected',
        'status.waiting': 'Waiting for data',
        'status.error': 'Unavailable',
        'status.loading': 'Loading…',
        'field.notes': 'Notes',
        'field.index': 'Index',
        'field.rest': 'Local REST API',
        'value.noteCount': '{count} notes',
        'value.indexReady': 'Ready · {notes} notes',
        'value.indexMissing': 'Not built',
        'value.restReachable': 'Reachable',
        'value.restUnreachable': 'Unreachable',
        'value.restNotConfigured': 'Not configured',
        'value.restUnknown': 'Unknown',
        'value.unknown': '—',
        'vault.current': 'Current vault',
        'vault.noVault': 'No vault detected yet',
        'vault.source.state': 'Set in panel',
        'vault.source.config': 'From config',
        'vault.source.auto': 'Auto-detected',
        'vault.badge.current': 'Current',
        'vault.badge.open': 'Open in Obsidian',
        'vault.badge.vault': 'Vault folder',
        'vault.badge.missing': 'Missing',
        'vault.listTitle': 'Vaults',
        'vault.listEmpty': 'No registered vaults found. Enter an absolute path below.',
        'vault.pathPlaceholder': 'Absolute path, e.g. D:\\Notes\\MyVault',
        'vault.switch': 'Switch',
        'vault.reset': 'Back to auto/config',
        'vault.switching': 'Switching…',
        'vault.switchedTo': 'Now using {name}',
        'vault.switchError': 'Switch failed: {error}',
        'vault.pathRequired': 'Switch failed: enter an absolute path first',
        'vault.disabledHint': 'Vault switching is disabled in the plugin config (allowVaultSwitch: false).',
        'vault.rowHint': 'Switch to {path}',
        'search.label': 'Quick filter',
        'search.placeholder': 'Filter notes by title or path…',
        'search.count': '{count} of {total}',
        'search.noResults': 'No matching notes.',
        'search.noNotes': 'No note titles available yet.',
        'search.openHint': 'Open “{title}” in Obsidian',
        'waiting.title': 'Waiting for Host data',
        'waiting.body': 'This panel reads vault status from {route}. The Host half does not serve it yet, so nothing is shown here instead of invented numbers.',
        'error.title': 'Could not read status',
        'error.body': 'The request failed ({reason}). The vault itself may still be fine — the panel only failed to read it.',
        'actions.refresh': 'Refresh',
        'actions.refreshing': 'Refreshing…',
        'footer.updatedAt': 'Updated {time}',
        'footer.never': 'never',
      },
      zh: {
        'panel.title': 'Obsidian 知识库中枢',
        'status.connected': '已连接',
        'status.waiting': '等待数据',
        'status.error': '不可用',
        'status.loading': '加载中…',
        'field.notes': '笔记',
        'field.index': '索引',
        'field.rest': '本地 REST API',
        'value.noteCount': '{count} 篇',
        'value.indexReady': '已就绪 · {notes} 篇',
        'value.indexMissing': '尚未建立',
        'value.restReachable': '可访问',
        'value.restUnreachable': '不可访问',
        'value.restNotConfigured': '未配置',
        'value.restUnknown': '未知',
        'value.unknown': '—',
        'vault.current': '当前仓库',
        'vault.noVault': '尚未检测到仓库',
        'vault.source.state': '面板里选过',
        'vault.source.config': '配置指定',
        'vault.source.auto': '自动探测',
        'vault.badge.current': '当前',
        'vault.badge.open': 'Obsidian 已打开',
        'vault.badge.vault': '含 .obsidian',
        'vault.badge.missing': '不存在',
        'vault.listTitle': '仓库列表',
        'vault.listEmpty': '没有已注册的仓库。可在下方输入绝对路径。',
        'vault.pathPlaceholder': '绝对路径，例如 D:\\笔记\\我的仓库',
        'vault.switch': '切换',
        'vault.reset': '回到自动/配置',
        'vault.switching': '切换中…',
        'vault.switchedTo': '已切换到 {name}',
        'vault.switchError': '切换失败：{error}',
        'vault.pathRequired': '切换失败：请先输入绝对路径',
        'vault.disabledHint': '配置里已禁用换仓（allowVaultSwitch: false）。',
        'vault.rowHint': '切换到 {path}',
        'search.label': '快速筛选',
        'search.placeholder': '按标题或路径筛选笔记…',
        'search.count': '{count}/{total}',
        'search.noResults': '没有匹配的笔记。',
        'search.noNotes': '暂无可用的笔记标题。',
        'search.openHint': '在 Obsidian 中打开「{title}」',
        'waiting.title': '等待 Host 数据',
        'waiting.body': '面板通过 {route} 读取知识库状态；Host 端尚未提供该接口，因此这里显示等待状态，而不是编造数据。',
        'error.title': '无法读取状态',
        'error.body': '请求失败（{reason}）。知识库本身可能仍然正常，只是面板没能读到。',
        'actions.refresh': '刷新',
        'actions.refreshing': '刷新中…',
        'footer.updatedAt': '更新于 {time}',
        'footer.never': '从未',
      },
    }

    /** Detect the UI language without depending on any host service. */
    function detectLang() {
      try {
        const nav = typeof navigator === 'object' && navigator !== null ? navigator : null
        let raw = ''
        if (nav !== null) {
          if (typeof nav.language === 'string' && nav.language !== '') raw = nav.language
          else if (Array.isArray(nav.languages) && typeof nav.languages[0] === 'string') raw = nav.languages[0]
        }
        if (raw === '' && typeof document === 'object' && document !== null) {
          const root = document.documentElement
          if (root !== null && typeof root.getAttribute === 'function') {
            const attr = root.getAttribute('lang')
            if (typeof attr === 'string') raw = attr
          }
        }
        return /^zh/i.test(raw) || /-(zh|hans|hant)\b/i.test(raw) ? 'zh' : 'en'
      } catch (error) {
        return 'en'
      }
    }

    /** Look up one dotted key in a flat dictionary. */
    function lookup(dict, key) {
      if (dict === null || dict === undefined) return undefined
      const value = dict[key]
      return typeof value === 'string' ? value : undefined
    }

    /** Build a translator bound to one language; never throws. */
    function makeTranslator(lang) {
      const target = lang === 'zh' ? 'zh' : 'en'
      const dict = DICT[target] || DICT.en
      return function t(key, vars) {
        try {
          let text = lookup(dict, key)
          if (text === undefined) text = lookup(DICT.en, key)
          if (text === undefined) text = String(key)
          if (vars !== null && typeof vars === 'object') {
            text = text.replace(/\{(\w+)\}/g, function (match, name) {
              const value = vars[name]
              return value === undefined || value === null ? '' : String(value)
            })
          }
          return text
        } catch (error) {
          return String(key)
        }
      }
    }

    /* ------------------------------------------------------------------ data */

    const STATUS_PATH = '/obsidian-hub/status'
    const VAULT_PATH = '/obsidian-hub/vault'
    const STATUS_TIMEOUT_MS = 20000
    const SWITCH_TIMEOUT_MS = 45000
    const MAX_TITLES = 2000
    const MAX_RESULTS = 8
    const MAX_VAULTS = 50

    function isRecord(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    function asString(value) {
      if (typeof value === 'string') return value
      if (typeof value === 'number' && isFinite(value)) return String(value)
      return ''
    }

    function asNumber(value) {
      if (typeof value === 'number' && isFinite(value)) return value
      if (typeof value === 'string' && value !== '') {
        const parsed = Number(value)
        if (isFinite(parsed)) return parsed
      }
      return null
    }

    function asBool(value) {
      return value === true || value === false ? value : null
    }

    /** Last path segment, used as a title fallback. */
    function baseName(rel) {
      const text = asString(rel)
      if (text === '') return ''
      const parts = text.split(/[\\/]/)
      return parts.length > 0 ? parts[parts.length - 1] : text
    }

    /** Case-insensitive path comparison (Windows paths differ only by case). */
    function samePath(a, b) {
      const left = asString(a).replace(/[\\/]+$/, '')
      const right = asString(b).replace(/[\\/]+$/, '')
      if (left === '' || right === '') return false
      return left.toLowerCase() === right.toLowerCase()
    }

    /** Optional in-page bridge, for a Host that prefers to publish one. */
    function readBridge() {
      try {
        const scope = typeof globalThis === 'object' && globalThis !== null ? globalThis : null
        const bridge = scope !== null ? scope.__DSH_OBSIDIAN_HUB__ : undefined
        if (isRecord(bridge) && typeof bridge.getStatus === 'function') return bridge
      } catch (error) {
        /* no bridge */
      }
      return null
    }

    /** Collect note entries from any of the shapes the Host may send. */
    function readTitles(raw) {
      const out = []
      try {
        let source = null
        if (isRecord(raw.notes)) {
          if (Array.isArray(raw.notes.titles)) source = raw.notes.titles
          else if (Array.isArray(raw.notes.items)) source = raw.notes.items
        }
        if (source === null && Array.isArray(raw.notes)) source = raw.notes
        if (source === null && Array.isArray(raw.titles)) source = raw.titles
        if (source === null) return out
        for (let i = 0; i < source.length && out.length < MAX_TITLES; i += 1) {
          const entry = source[i]
          if (typeof entry === 'string') {
            out.push({ rel: entry, title: baseName(entry) })
            continue
          }
          if (!isRecord(entry)) continue
          const rel = asString(entry.rel) || asString(entry.path) || asString(entry.file)
          const title = asString(entry.title) || asString(entry.name) || baseName(rel)
          if (rel === '' && title === '') continue
          out.push({ rel: rel === '' ? title : rel, title: title === '' ? baseName(rel) : title })
        }
      } catch (error) {
        return []
      }
      return out
    }

    /**
     * Collect the candidate vaults. The Host marks the active one with
     * `current`; if it does not, the entry matching `vaultPath` is marked here so
     * the list still shows which row is live.
     */
    function readVaults(raw, currentPath) {
      const out = []
      try {
        let source = null
        if (Array.isArray(raw.vaults)) source = raw.vaults
        else if (isRecord(raw.vaultRegistry) && Array.isArray(raw.vaultRegistry.vaults)) source = raw.vaultRegistry.vaults
        if (source === null) return out
        for (let i = 0; i < source.length && out.length < MAX_VAULTS; i += 1) {
          const entry = source[i]
          let path = ''
          let name = ''
          let open = null
          let exists = null
          let isVault = null
          let current = null
          if (typeof entry === 'string') {
            path = entry
          } else if (isRecord(entry)) {
            path = asString(entry.path) || asString(entry.root) || asString(entry.dir)
            name = asString(entry.name)
            open = asBool(entry.open)
            exists = asBool(entry.exists)
            isVault = asBool(entry.isVault)
            current = asBool(entry.current)
          }
          if (path === '') continue
          // The registry can list the same directory twice (e.g. case variants);
          // React keys and the "which row is current" lookup both need it unique.
          let duplicate = false
          for (let j = 0; j < out.length; j += 1) {
            if (samePath(out[j].path, path)) duplicate = true
          }
          if (duplicate) continue
          out.push({
            path: path,
            name: name !== '' ? name : baseName(path),
            open: open,
            exists: exists,
            isVault: isVault,
            current: current === true,
          })
        }
        let marked = false
        for (let i = 0; i < out.length; i += 1) if (out[i].current === true) marked = true
        if (marked !== true && asString(currentPath) !== '') {
          for (let i = 0; i < out.length; i += 1) {
            if (samePath(out[i].path, currentPath)) out[i].current = true
          }
        }
      } catch (error) {
        return []
      }
      return out
    }

    /** Normalize whatever the Host answered into the panel's own shape. */
    function normalizeStatus(raw) {
      const result = {
        source: '',
        vaultPath: '',
        vaultName: '',
        vaultSource: '',
        allowVaultSwitch: null,
        vaults: [],
        noteCount: null,
        titles: [],
        indexReady: null,
        indexNotes: null,
        indexBuiltAt: null,
        restConfigured: null,
        restReachable: null,
        restUrl: '',
        updatedAt: null,
      }
      try {
        const payload = isRecord(raw) ? raw : {}

        if (isRecord(payload.vault)) {
          result.vaultPath = asString(payload.vault.path) || asString(payload.vault.root)
          result.vaultName = asString(payload.vault.name)
        }
        if (result.vaultPath === '') result.vaultPath = asString(payload.vaultPath) || asString(payload.path)
        if (result.vaultName === '') result.vaultName = asString(payload.vaultName) || asString(payload.name)

        result.vaultSource = asString(payload.vaultSource)
        result.allowVaultSwitch = asBool(payload.allowVaultSwitch)
        result.vaults = readVaults(payload, result.vaultPath)

        let count = null
        if (isRecord(payload.notes)) {
          count = asNumber(payload.notes.count)
          if (count === null) count = asNumber(payload.notes.total)
        }
        if (count === null) count = asNumber(payload.noteCount)
        result.noteCount = count

        result.titles = readTitles(payload)

        if (isRecord(payload.index)) {
          result.indexReady = asBool(payload.index.ready)
          result.indexNotes = asNumber(payload.index.notes)
          result.indexBuiltAt = asNumber(payload.index.builtAt)
        }
        if (result.indexReady === null) result.indexReady = asBool(payload.indexReady)
        if (result.indexNotes === null) result.indexNotes = asNumber(payload.indexNotes)

        if (isRecord(payload.rest)) {
          result.restConfigured = asBool(payload.rest.configured)
          result.restReachable = asBool(payload.rest.reachable)
          result.restUrl = asString(payload.rest.url) || asString(payload.rest.baseUrl)
        }
        if (result.restReachable === null) result.restReachable = asBool(payload.restReachable)

        result.updatedAt = asNumber(payload.updatedAt) || asNumber(payload.generatedAt)
        result.source = asString(payload.source)
      } catch (error) {
        return result
      }
      return result
    }

    /** Read a JSON response with a bounded wait; resolves, never rejects. */
    async function requestJson(url, init, timeoutMs) {
      if (typeof fetch !== 'function') return { ok: false, reason: 'no-fetch' }
      let timer = null
      const options = Object.assign({}, init, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: Object.assign({ accept: 'application/json' }, init && init.headers ? init.headers : {}),
      })
      try {
        if (typeof AbortController === 'function') {
          const controller = new AbortController()
          options.signal = controller.signal
          timer = setTimeout(function () {
            try {
              controller.abort()
            } catch (error) {
              /* ignore */
            }
          }, timeoutMs)
        }
        const response = await fetch(url, options)
        if (!response) return { ok: false, reason: 'network' }
        if (response.status === 404) return { ok: false, reason: 'no-route' }
        let payload = null
        try {
          payload = await response.json()
        } catch (error) {
          payload = null
        }
        if (response.ok !== true) {
          const message = isRecord(payload) ? asString(payload.error) : ''
          return { ok: false, reason: message !== '' ? message : 'http-' + String(response.status) }
        }
        if (!isRecord(payload)) return { ok: false, reason: 'bad-payload' }
        if (payload.ok === false) {
          return { ok: false, reason: asString(payload.error) || 'host-error' }
        }
        return { ok: true, payload: payload }
      } catch (error) {
        return { ok: false, reason: 'network' }
      } finally {
        if (timer !== null) {
          try {
            clearTimeout(timer)
          } catch (error) {
            /* ignore */
          }
        }
      }
    }

    /** GET the status: in-page bridge first, then the same-origin route. */
    async function requestStatus() {
      try {
        const bridge = readBridge()
        if (bridge !== null) {
          try {
            const value = await bridge.getStatus()
            if (isRecord(value)) return { ok: true, data: normalizeStatus(value) }
            return { ok: false, reason: 'bad-payload' }
          } catch (error) {
            /* fall through to the route */
          }
        }
      } catch (error) {
        /* fall through to the route */
      }
      const result = await requestJson(STATUS_PATH, { method: 'GET' }, STATUS_TIMEOUT_MS)
      if (result.ok !== true) return { ok: false, reason: result.reason }
      return { ok: true, data: normalizeStatus(result.payload) }
    }

    /**
     * POST a vault switch. `path === null` returns to config/auto. On success the
     * response payload IS the new state (the Host answers with the same shape as
     * GET), so no follow-up GET is needed.
     */
    async function requestSwitch(path) {
      const body = { path: path === null ? null : asString(path) }
      const result = await requestJson(VAULT_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, SWITCH_TIMEOUT_MS)
      if (result.ok !== true) return { ok: false, error: asString(result.reason) || 'unknown' }
      return { ok: true, data: normalizeStatus(result.payload) }
    }

    /** Open a note through the obsidian:// deep link, when the browser allows it. */
    function openNote(vaultName, rel) {
      try {
        const path = asString(rel)
        if (path === '') return
        const file = path.replace(/\.md$/i, '')
        let url = 'obsidian://open?file=' + encodeURIComponent(file)
        if (asString(vaultName) !== '') url += '&vault=' + encodeURIComponent(vaultName)
        const scope = typeof window === 'object' && window !== null ? window : null
        if (scope !== null && typeof scope.open === 'function') {
          scope.open(url, '_blank', 'noopener')
        }
      } catch (error) {
        /* a blocked popup is not an error worth surfacing */
      }
    }

    function formatTime(value, t) {
      const ms = asNumber(value)
      if (ms === null || ms <= 0) return t('footer.never')
      try {
        const date = new Date(ms)
        if (isNaN(date.getTime())) return t('footer.never')
        return date.toLocaleTimeString()
      } catch (error) {
        return t('footer.never')
      }
    }

    /* ----------------------------------------------------------------- style */

    // Chrome colours come only from --dsw-alias-* theme tokens, so light/dark
    // switching and host re-themes apply without any literal colour here.
    // The shell copies the host's main-panel pattern: full-height scroller with
    // the frame's top clearance, then a centred content column.
    const CSS = `
.doh-root{box-sizing:border-box;height:100%;min-height:0;overflow:auto;overscroll-behavior:contain;
  padding:calc(20px + var(--dsw-frame-top-clearance,0px)) 0 28px;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font-size:13px;line-height:1.5;font-family:inherit}
.doh-inner{box-sizing:border-box;width:100%;max-width:960px;margin:0 auto;padding:0 20px;
  display:flex;flex-direction:column;gap:14px}
.doh-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.doh-title{margin:0;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary)}
.doh-pill{display:inline-flex;align-items:center;gap:6px;flex:none;font-size:11.5px;
  color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);
  border-radius:999px;padding:2px 10px;white-space:nowrap}
.doh-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}
.doh-dot.is-ok{background:var(--dsw-alias-state-success-primary)}
.doh-dot.is-warn{background:var(--dsw-alias-state-warn-primary)}
.doh-dot.is-error{background:var(--dsw-alias-state-error-primary)}
.doh-dot.is-busy{background:var(--dsw-alias-brand-primary)}
.doh-card{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-lg,16px);padding:14px 16px;
  display:flex;flex-direction:column;gap:10px;min-width:0}
.doh-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;min-width:0}
.doh-vault-head{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.doh-vault-name{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.doh-vault-path{font-family:var(--ds-font-family-code,ui-monospace,Menlo,Consolas,monospace);
  font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all;line-height:1.45}
.doh-badges{display:flex;flex-wrap:wrap;align-items:center;gap:6px;flex:none}
.doh-badge{display:inline-flex;align-items:center;font-size:11px;line-height:16px;
  padding:1px 7px;border-radius:5px;white-space:nowrap;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.doh-badge.is-brand{color:var(--dsw-alias-brand-primary);background:transparent;
  border:.5px solid var(--dsw-alias-brand-primary)}
.doh-badge.is-ok{color:var(--dsw-alias-state-success-primary);background:transparent;
  border:.5px solid var(--dsw-alias-state-success-primary)}
.doh-badge.is-warn{color:var(--dsw-alias-state-warn-primary);background:transparent;
  border:.5px solid var(--dsw-alias-state-warn-primary)}
.doh-section-label{font-size:11px;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary)}
.doh-vaultlist{display:flex;flex-direction:column;gap:2px;max-height:260px;overflow:auto;
  border-radius:8px;margin:0 -4px;padding:2px 4px}
.doh-vaultrow{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;
  text-align:left;background:transparent;border:0;border-radius:8px;padding:6px 8px;
  font:inherit;color:inherit;cursor:pointer}
.doh-vaultrow:hover:not([disabled]){background:var(--dsw-alias-bg-layer-2)}
.doh-vaultrow.is-current{background:var(--dsw-alias-bg-layer-2)}
.doh-vaultrow[disabled]{cursor:default;opacity:.62}
.doh-vaultrow-main{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.doh-vaultrow-name{font-size:13px;color:var(--dsw-alias-label-primary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.doh-vaultrow-path{font-size:11.5px;color:var(--dsw-alias-label-secondary);
  font-family:var(--ds-font-family-code,ui-monospace,Menlo,Consolas,monospace);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.doh-form{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.doh-input{box-sizing:border-box;flex:1 1 240px;min-width:0;background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;
  color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.doh-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.doh-input:focus{border-color:var(--dsw-alias-brand-primary)}
.doh-btn{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;
  padding:5px 14px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer;
  white-space:nowrap}
.doh-btn:hover:not([disabled]){background:var(--dsw-alias-bg-layer-2)}
.doh-btn[disabled]{opacity:.55;cursor:default}
.doh-btn.is-primary{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);
  font-weight:600}
.doh-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px 16px;margin:0}
.doh-row{min-width:0;display:flex;flex-direction:column;gap:1px}
.doh-label{font-size:11px;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary)}
.doh-value{font-size:13px;color:var(--dsw-alias-label-primary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.doh-mono{font-family:var(--ds-font-family-code,ui-monospace,Menlo,Consolas,monospace);font-size:12px}
.doh-feedback{font-size:12px;line-height:1.45;word-break:break-word}
.doh-feedback.is-ok{color:var(--dsw-alias-state-success-primary)}
.doh-feedback.is-error{color:var(--dsw-alias-state-error-primary)}
.doh-hint{font-size:12px;line-height:1.45;color:var(--dsw-alias-state-warn-primary)}
.doh-search{display:flex;flex-direction:column;gap:6px}
.doh-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;
  gap:1px;max-height:240px;overflow:auto}
.doh-item{display:flex;flex-direction:column;gap:1px;width:100%;box-sizing:border-box;
  text-align:left;background:transparent;border:0;border-radius:7px;padding:5px 8px;
  font:inherit;color:inherit;cursor:pointer}
.doh-item:hover{background:var(--dsw-alias-bg-layer-2)}
.doh-item-title{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.doh-item-path{font-size:11.5px;color:var(--dsw-alias-label-secondary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.doh-empty{font-size:12px;color:var(--dsw-alias-label-secondary);padding:2px 0;line-height:1.45}
.doh-note{display:flex;flex-direction:column;gap:3px;font-size:12px;line-height:1.45;
  color:var(--dsw-alias-label-secondary)}
.doh-note-title{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary)}
.doh-note-body{word-break:break-word}
.doh-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;
  font-size:11.5px;color:var(--dsw-alias-label-secondary);padding-bottom:4px}
`

    /* -------------------------------------------------------------- components */

    /** Language-bound translator that survives re-renders. */
    function useTranslator() {
      const ref = React.useRef(null)
      if (ref.current === null || typeof ref.current !== 'function') ref.current = makeTranslator(detectLang())
      return ref.current
    }

    function statusPill(t, phase, busy) {
      try {
        if (busy === true) return { label: t('vault.switching'), dot: 'is-busy' }
        if (phase === 'ready') return { label: t('status.connected'), dot: 'is-ok' }
        if (phase === 'waiting') return { label: t('status.waiting'), dot: 'is-warn' }
        if (phase === 'error') return { label: t('status.error'), dot: 'is-error' }
        return { label: t('status.loading'), dot: '' }
      } catch (error) {
        return { label: '', dot: '' }
      }
    }

    /** The sidebar icon. Owner props are exactly `{ size, active }`. */
    function ObsidianHubIcon(props) {
      try {
        if (h === null) return null
        const owner = props !== null && typeof props === 'object' ? props : {}
        const rawSize = owner.size
        const size = typeof rawSize === 'number' && isFinite(rawSize) && rawSize > 0
          ? Math.max(10, Math.min(64, rawSize))
          : 16
        const active = owner.active === true
        const children = [
          // Outer gem outline — theme colour via currentColor.
          h('path', {
            key: 'gem',
            d: 'M8 1.7 13.4 5.6 8 14.3 2.6 5.6Z',
            stroke: 'currentColor',
            strokeWidth: 1.25,
            strokeLinejoin: 'round',
          }),
          // Girdle + centre facet.
          h('path', {
            key: 'facet',
            d: 'M2.6 5.6h10.8M8 5.6v8.7',
            stroke: 'currentColor',
            strokeOpacity: 0.55,
            strokeWidth: 1,
            strokeLinecap: 'round',
          }),
        ]
        if (active) {
          // Subtle accent only while the panel is open.
          children.push(h('path', {
            key: 'accent',
            d: 'M8 1.7 13.4 5.6H2.6Z',
            fill: 'var(--dsw-alias-brand-primary)',
            opacity: 0.9,
          }))
        }
        return h('svg', {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block', flex: 'none' },
        }, children)
      } catch (error) {
        return null
      }
    }

    function fieldNode(label, value, extraClass) {
      return h('div', { className: 'doh-row', key: label }, [
        h('div', { className: 'doh-label', key: 'l' }, label),
        h('div', { className: extraClass ? 'doh-value ' + extraClass : 'doh-value', key: 'v', title: value }, value),
      ])
    }

    function statusGrid(t, data) {
      const rows = []
      try {
        const phaseData = data || null

        let notes = t('value.unknown')
        if (phaseData !== null && typeof phaseData.noteCount === 'number' && isFinite(phaseData.noteCount)) {
          notes = t('value.noteCount', { count: phaseData.noteCount.toLocaleString() })
        }
        rows.push(fieldNode(t('field.notes'), notes))

        let index = t('value.unknown')
        if (phaseData !== null) {
          if (phaseData.indexReady === true) {
            const indexed = typeof phaseData.indexNotes === 'number' && isFinite(phaseData.indexNotes)
              ? phaseData.indexNotes.toLocaleString()
              : t('value.unknown')
            index = t('value.indexReady', { notes: indexed })
          } else if (phaseData.indexReady === false) {
            index = t('value.indexMissing')
          }
        }
        rows.push(fieldNode(t('field.index'), index))

        let rest = t('value.restUnknown')
        if (phaseData !== null) {
          if (phaseData.restConfigured === false) rest = t('value.restNotConfigured')
          else if (phaseData.restReachable === true) rest = t('value.restReachable')
          else if (phaseData.restReachable === false) rest = t('value.restUnreachable')
        }
        rows.push(fieldNode(t('field.rest'), rest))
      } catch (error) {
        return h('div', { className: 'doh-grid', key: 'grid' }, [])
      }
      return h('div', { className: 'doh-grid', key: 'grid' }, rows)
    }

    /** Pure-filter helper: never throws, caps the result list. */
    function filterTitles(titles, query) {
      const results = []
      try {
        const list = Array.isArray(titles) ? titles : []
        const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
        if (needle === '') {
          for (let i = 0; i < list.length && results.length < MAX_RESULTS; i += 1) results.push(list[i])
          return results
        }
        for (let i = 0; i < list.length && results.length < MAX_RESULTS; i += 1) {
          const entry = list[i]
          if (!isRecord(entry)) continue
          const title = asString(entry.title)
          const rel = asString(entry.rel)
          if ((title + ' ' + rel).toLowerCase().indexOf(needle) >= 0) results.push(entry)
        }
      } catch (error) {
        return []
      }
      return results
    }

    function searchBlock(t, data, query, setQuery, results) {
      const titles = data !== null && Array.isArray(data.titles) ? data.titles : []
      const trimmed = typeof query === 'string' ? query.trim() : ''
      const total = titles.length

      const children = [
        h('input', {
          key: 'input',
          className: 'doh-input',
          type: 'search',
          value: typeof query === 'string' ? query : '',
          placeholder: t('search.placeholder'),
          'aria-label': t('search.label'),
          spellCheck: false,
          onChange: function (event) {
            try {
              const value = event !== null && event.target !== undefined ? event.target.value : ''
              setQuery(typeof value === 'string' ? value : '')
            } catch (error) {
              /* ignore a malformed event */
            }
          },
        }),
      ]

      const items = []
      for (let i = 0; i < results.length; i += 1) {
        const entry = results[i]
        if (!isRecord(entry)) continue
        const title = asString(entry.title) || asString(entry.rel)
        const rel = asString(entry.rel)
        items.push(h('li', { key: String(i) + ':' + rel }, h('button', {
          type: 'button',
          className: 'doh-item',
          title: t('search.openHint', { title: title }),
          onClick: function () {
            openNote(data !== null ? data.vaultName : '', rel)
          },
        }, [
          h('span', { className: 'doh-item-title', key: 't' }, title),
          rel !== '' && rel !== title
            ? h('span', { className: 'doh-item-path', key: 'p' }, rel)
            : null,
        ])))
      }

      if (total === 0) {
        children.push(h('div', { className: 'doh-empty', key: 'empty' }, t('search.noNotes')))
      } else if (items.length === 0) {
        children.push(h('div', { className: 'doh-empty', key: 'empty' }, t('search.noResults')))
      } else {
        children.push(h('ul', { className: 'doh-list', key: 'list' }, items))
        if (trimmed !== '') {
          children.push(h('div', {
            key: 'count',
            className: 'doh-empty',
          }, t('search.count', { count: results.length, total: total })))
        }
      }

      return h('div', { className: 'doh-search', key: 'search' }, children)
    }

    function noticeBlock(title, body) {
      return h('div', { className: 'doh-note', key: 'notice' }, [
        h('div', { className: 'doh-note-title', key: 't' }, title),
        h('div', { className: 'doh-note-body', key: 'b' }, body),
      ])
    }

    function badge(text, tone, key) {
      const className = tone ? 'doh-badge ' + tone : 'doh-badge'
      return h('span', { className: className, key: key }, text)
    }

    /** Badges for the active vault: where the path came from, and app state. */
    function sourceBadges(t, data) {
      const out = []
      try {
        if (data === null) return out
        const source = asString(data.vaultSource)
        if (source === 'state' || source === 'config' || source === 'auto') {
          out.push(badge(t('vault.source.' + source), source === 'state' ? 'is-brand' : '', 'src'))
        }
        const active = activeVaultEntry(data)
        if (active !== null && active.open === true) out.push(badge(t('vault.badge.open'), 'is-ok', 'open'))
      } catch (error) {
        return []
      }
      return out
    }

    function activeVaultEntry(data) {
      try {
        if (data === null || !Array.isArray(data.vaults)) return null
        for (let i = 0; i < data.vaults.length; i += 1) {
          if (data.vaults[i].current === true) return data.vaults[i]
        }
      } catch (error) {
        return null
      }
      return null
    }

    function vaultRow(t, entry, canSwitch, busy, onPick) {
      const name = asString(entry.name) || baseName(entry.path)
      const isCurrent = entry.current === true
      const missing = entry.exists === false
      const disabled = canSwitch !== true || busy === true || isCurrent || missing
      const badges = []
      if (isCurrent) badges.push(badge(t('vault.badge.current'), 'is-brand', 'cur'))
      if (entry.open === true) badges.push(badge(t('vault.badge.open'), 'is-ok', 'open'))
      if (entry.isVault === true) badges.push(badge(t('vault.badge.vault'), '', 'vault'))
      if (missing) badges.push(badge(t('vault.badge.missing'), 'is-warn', 'missing'))
      return h('button', {
        type: 'button',
        key: 'row:' + entry.path,
        className: isCurrent ? 'doh-vaultrow is-current' : 'doh-vaultrow',
        disabled: disabled,
        title: canSwitch === true && !missing
          ? t('vault.rowHint', { path: entry.path })
          : entry.path,
        onClick: function () {
          if (disabled) return
          try {
            onPick(entry.path)
          } catch (error) {
            /* ignore: the caller reports its own failures */
          }
        },
      }, [
        h('span', { className: 'doh-vaultrow-main', key: 'main' }, [
          h('span', { className: 'doh-vaultrow-name', key: 'n' }, name),
          h('span', { className: 'doh-vaultrow-path', key: 'p' }, entry.path),
        ]),
        badges.length > 0 ? h('span', { className: 'doh-badges', key: 'b' }, badges) : null,
      ])
    }

    /** Vault card: active vault, candidate list, manual path, reset, feedback. */
    function vaultCard(view) {
      const t = view.t
      const data = view.data
      const canSwitch = view.canSwitch
      const children = []

      const name = data !== null
        ? (asString(data.vaultName) || baseName(data.vaultPath) || t('vault.noVault'))
        : t('value.unknown')

      children.push(h('div', { className: 'doh-card-head', key: 'head' }, [
        h('div', { className: 'doh-vault-head', key: 'id' }, [
          h('div', { className: 'doh-section-label', key: 'lbl' }, t('vault.current')),
          h('div', {
            className: 'doh-vault-name',
            key: 'name',
            title: data !== null ? asString(data.vaultPath) : '',
          }, name),
        ]),
        h('span', { className: 'doh-badges', key: 'badges' }, sourceBadges(t, data)),
      ]))

      children.push(h('div', {
        className: 'doh-vault-path',
        key: 'path',
      }, data !== null && asString(data.vaultPath) !== '' ? asString(data.vaultPath) : t('vault.noVault')))

      if (data !== null && data.allowVaultSwitch === false) {
        children.push(h('div', { className: 'doh-hint', key: 'disabled' }, t('vault.disabledHint')))
      }

      children.push(h('div', { className: 'doh-section-label', key: 'list-label' }, t('vault.listTitle')))

      const vaults = data !== null && Array.isArray(data.vaults) ? data.vaults : []
      if (data === null) {
        children.push(h('div', { className: 'doh-empty', key: 'list-empty' }, t('value.unknown')))
      } else if (vaults.length === 0) {
        children.push(h('div', { className: 'doh-empty', key: 'list-empty' }, t('vault.listEmpty')))
      } else {
        const rows = []
        for (let i = 0; i < vaults.length; i += 1) {
          const entry = vaults[i]
          if (!isRecord(entry)) continue
          rows.push(vaultRow(t, entry, canSwitch, view.busy, view.onPick))
        }
        children.push(h('div', {
          className: 'doh-vaultlist',
          key: 'list',
        }, rows))
      }

      children.push(h('div', { className: 'doh-form', key: 'form' }, [
        h('input', {
          key: 'input',
          className: 'doh-input',
          type: 'text',
          value: typeof view.pathInput === 'string' ? view.pathInput : '',
          placeholder: t('vault.pathPlaceholder'),
          'aria-label': t('vault.pathPlaceholder'),
          spellCheck: false,
          disabled: canSwitch !== true || view.busy === true,
          onChange: function (event) {
            try {
              const value = event !== null && event.target !== undefined ? event.target.value : ''
              view.setPathInput(typeof value === 'string' ? value : '')
            } catch (error) {
              /* ignore a malformed event */
            }
          },
          onKeyDown: function (event) {
            try {
              if (event !== null && event.key === 'Enter') {
                event.preventDefault()
                view.onSubmitPath()
              }
            } catch (error) {
              /* ignore */
            }
          },
        }),
        h('button', {
          key: 'switch',
          type: 'button',
          className: 'doh-btn is-primary',
          disabled: canSwitch !== true || view.busy === true || (typeof view.pathInput === 'string' && view.pathInput.trim() === ''),
          onClick: function () {
            try {
              view.onSubmitPath()
            } catch (error) {
              /* ignore */
            }
          },
        }, view.busy === true ? t('vault.switching') : t('vault.switch')),
      ]))

      children.push(h('div', { className: 'doh-form', key: 'reset' }, [
        h('button', {
          key: 'reset-btn',
          type: 'button',
          className: 'doh-btn',
          disabled: canSwitch !== true || view.busy === true,
          onClick: function () {
            try {
              view.onReset()
            } catch (error) {
              /* ignore */
            }
          },
        }, t('vault.reset')),
      ]))

      if (view.feedback !== null && asString(view.feedback.text) !== '') {
        children.push(h('div', {
          className: 'doh-feedback ' + (view.feedback.tone === 'ok' ? 'is-ok' : 'is-error'),
          key: 'feedback',
          role: 'status',
        }, asString(view.feedback.text)))
      }

      return h('div', { className: 'doh-card', key: 'vault' }, children)
    }

    /** Rendered when the panel itself cannot run; keeps the slot non-blank. */
    function FallbackNotice(props) {
      let t
      try {
        t = props !== null && typeof props === 'object' && typeof props.t === 'function'
          ? props.t
          : makeTranslator(detectLang())
      } catch (error) {
        t = makeTranslator('en')
      }
      let text = ''
      try {
        text = t('error.title') + ': ' + t('error.body', { reason: 'render' })
      } catch (error) {
        text = 'Obsidian Hub: panel render failed.'
      }
      try {
        return h('div', { className: 'doh-root' }, [
          h('style', { key: 'style' }, CSS),
          h('div', { className: 'doh-inner', key: 'inner' }, [
            h('div', { className: 'doh-card', key: 'card' }, [
              h('div', { className: 'doh-empty', key: 'msg' }, text),
            ]),
          ]),
        ])
      } catch (error) {
        return null
      }
    }

    /** Pure view assembly: everything above it is data, everything below is DOM. */
    function renderPanel(view) {
      const t = view.t
      const data = view.data
      const pill = statusPill(t, view.phase, view.busy)
      const children = [h('style', { key: 'style' }, CSS)]

      children.push(h('div', { className: 'doh-inner', key: 'inner' }, [
        h('div', { className: 'doh-head', key: 'head' }, [
          h('h2', { className: 'doh-title', key: 'title' }, t('panel.title')),
          h('span', { className: 'doh-pill', key: 'pill' }, [
            h('span', { className: 'doh-dot ' + pill.dot, key: 'dot' }),
            h('span', { key: 'label' }, pill.label),
          ]),
        ]),

        vaultCard(view),

        h('div', { className: 'doh-card', key: 'status' }, [
          statusGrid(t, data),
        ]),

        view.phase === 'waiting'
          ? noticeBlock(t('waiting.title'), t('waiting.body', { route: STATUS_PATH }))
          : null,

        view.phase === 'error'
          ? noticeBlock(t('error.title'), t('error.body', { reason: view.reason || 'unknown' }))
          : null,

        data !== null
          ? h('div', { className: 'doh-card', key: 'search' }, [
            searchBlock(t, data, view.query, view.setQuery, view.results),
          ])
          : null,

        h('div', { className: 'doh-foot', key: 'foot' }, [
          h('span', { key: 'stamp' }, t('footer.updatedAt', {
            time: data !== null ? formatTime(data.updatedAt, t) : t('footer.never'),
          })),
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'doh-btn',
            disabled: view.phase === 'loading' || view.busy === true,
            onClick: function () {
              try {
                view.refresh()
              } catch (error) {
                /* ignore */
              }
            },
          }, view.phase === 'loading' ? t('actions.refreshing') : t('actions.refresh')),
        ]),
      ]))

      return h('div', {
        className: 'doh-root',
        'data-plugin': 'dsh-obsidian-hub',
        role: 'region',
        'aria-label': t('panel.title'),
      }, children)
    }

    function PanelInner(props) {
      const t = useTranslator()
      const stateHook = React.useState({ phase: 'loading', data: null, reason: '' })
      const state = stateHook[0]
      const setState = stateHook[1]
      const queryHook = React.useState('')
      const query = queryHook[0]
      const setQuery = queryHook[1]
      const pathHook = React.useState('')
      const pathInput = pathHook[0]
      const setPathInput = pathHook[1]
      const busyHook = React.useState(false)
      const busy = busyHook[0]
      const setBusy = busyHook[1]
      const feedbackHook = React.useState({ tone: '', text: '' })
      const feedback = feedbackHook[0]
      const setFeedback = feedbackHook[1]
      const tickHook = React.useState(0)
      const tick = tickHook[0]
      const setTick = tickHook[1]
      const runRef = React.useRef(0)
      const busyRef = React.useRef(false)

      React.useEffect(function () {
        let alive = true
        runRef.current += 1
        const mine = runRef.current
        setState(function (previous) {
          const kept = previous !== null && typeof previous === 'object' && isRecord(previous.data)
            ? previous.data
            : null
          return { phase: 'loading', data: kept, reason: '' }
        })
        if (typeof requestStatus !== 'function') {
          setState({ phase: 'waiting', data: null, reason: 'no-route' })
          return function () { alive = false }
        }
        requestStatus().then(function (result) {
          if (!alive || mine !== runRef.current) return
          try {
            if (result && result.ok === true && isRecord(result.data)) {
              setState({ phase: 'ready', data: result.data, reason: '' })
            } else {
              const reason = result && typeof result.reason === 'string' ? result.reason : 'unknown'
              const waiting = reason === 'no-route' || reason === 'network' || reason === 'no-fetch'
              setState({ phase: waiting ? 'waiting' : 'error', data: null, reason: reason })
            }
          } catch (error) {
            setState({ phase: 'error', data: null, reason: 'unknown' })
          }
        }).catch(function () {
          if (!alive || mine !== runRef.current) return
          setState({ phase: 'error', data: null, reason: 'unexpected' })
        })
        return function () { alive = false }
      }, [tick])

      /** Apply a POST/GET payload as the new state (no follow-up GET). */
      function applySwitchResult(target, result) {
        try {
          if (result && result.ok === true && isRecord(result.data)) {
            const next = result.data
            setState({ phase: 'ready', data: next, reason: '' })
            setPathInput('')
            const label = asString(next.vaultName) || baseName(next.vaultPath)
            setFeedback({ tone: 'ok', text: t('vault.switchedTo', { name: label }) })
          } else {
            const message = result && typeof result.error === 'string' && result.error !== ''
              ? result.error
              : 'unknown'
            setFeedback({ tone: 'error', text: t('vault.switchError', { error: message }) })
          }
        } catch (error) {
          setFeedback({ tone: 'error', text: t('vault.switchError', { error: 'render' }) })
        }
      }

      function doSwitch(target) {
        if (busyRef.current === true) return
        if (state.data !== null && state.data.allowVaultSwitch === false) return
        busyRef.current = true
        setBusy(true)
        setFeedback({ tone: '', text: '' })
        let pending = null
        try {
          pending = requestSwitch(target)
        } catch (error) {
          pending = Promise.reject(error)
        }
        Promise.resolve(pending).then(function (result) {
          applySwitchResult(target, result)
        }).catch(function () {
          setFeedback({ tone: 'error', text: t('vault.switchError', { error: 'network' }) })
        }).then(function () {
          busyRef.current = false
          setBusy(false)
        })
      }

      function submitPath() {
        try {
          const value = typeof pathInput === 'string' ? pathInput.trim() : ''
          if (value === '') {
            setFeedback({ tone: 'error', text: t('vault.pathRequired') })
            return
          }
          doSwitch(value)
        } catch (error) {
          setFeedback({ tone: 'error', text: t('vault.switchError', { error: 'input' }) })
        }
      }

      function resetToAuto() {
        doSwitch(null)
      }

      const data = state.data
      const canSwitch = data !== null && data.allowVaultSwitch !== false
      const results = filterTitles(data !== null ? data.titles : [], query)
      const view = {
        t: t,
        phase: state.phase,
        data: data,
        reason: state.reason,
        query: query,
        setQuery: setQuery,
        results: results,
        pathInput: pathInput,
        setPathInput: setPathInput,
        busy: busy,
        feedback: feedback,
        canSwitch: canSwitch,
        onPick: doSwitch,
        onSubmitPath: submitPath,
        onReset: resetToAuto,
        refresh: function () {
          try {
            setTick(function (n) { return (typeof n === 'number' ? n : 0) + 1 })
          } catch (error) {
            /* ignore */
          }
        },
      }

      try {
        return renderPanel(view)
      } catch (error) {
        return h(FallbackNotice, { t: t })
      }
    }

    /** Main-slot entry: an error boundary keeps a crash from blanking the panel. */
    function ObsidianHubPanel(props) {
      try {
        if (h === null) return null
        const safeProps = props !== null && typeof props === 'object' ? props : null
        if (hasHooks !== true) return h(FallbackNotice, {})
        const boundary = makeErrorBoundary()
        if (boundary === null) return h(PanelInner, safeProps)
        return h(boundary, null, h(PanelInner, safeProps))
      } catch (error) {
        return null
      }
    }

    /** Sidebar entry: the icon must never throw either. */
    function ObsidianHubIconEntry(props) {
      try {
        return ObsidianHubIcon(props)
      } catch (error) {
        return null
      }
    }

    /** Build the boundary class once; null when the host React has no Component. */
    let boundaryClass = null
    let boundaryBuilt = false
    function makeErrorBoundary() {
      if (boundaryBuilt) return boundaryClass
      boundaryBuilt = true
      try {
        if (BaseComponent === null || h === null) {
          boundaryClass = null
          return boundaryClass
        }
        // `extends` (not `Component.call`): React.Component is an ES class in
        // the browser module table and cannot be invoked without `new`.
        boundaryClass = class ObsidianHubBoundary extends BaseComponent {
          constructor(props) {
            super(props)
            this.state = { failed: false }
          }

          static getDerivedStateFromError() {
            return { failed: true }
          }

          componentDidCatch() {
            /* swallowed: the slot stays alive */
          }

          render() {
            try {
              if (this.state !== null && this.state !== undefined && this.state.failed === true) {
                return h(FallbackNotice, {})
              }
              const children = this.props !== null && typeof this.props === 'object' ? this.props.children : null
              return children === undefined ? null : children
            } catch (error) {
              return null
            }
          }
        }
      } catch (error) {
        boundaryClass = null
      }
      return boundaryClass
    }

    /* -------------------------------------------------------------- activation */

    // Both registrations must share this id/key, or the sidebar button opens nothing.
    const PANEL_ID = 'obsidian-hub'

    function safeLabel(translator, fallback) {
      try {
        const value = translator('panel.title')
        return typeof value === 'string' && value !== '' ? value : fallback
      } catch (error) {
        return fallback
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          if (ctx === null || typeof ctx !== 'object') return
          const slots = ctx.slots
          if (slots === null || typeof slots !== 'object') return
          if (typeof slots.inject !== 'function' || typeof slots.register !== 'function') return

          const translator = makeTranslator(detectLang())

          try {
            slots.inject('sidebar.panellist', function () {
              try {
                return slots.register({
                  name: 'sidebar.panellist',
                  id: PANEL_ID,
                  order: 35,
                  label: function () { return safeLabel(translator, 'Obsidian Hub') },
                }, ObsidianHubIconEntry)
              } catch (error) {
                return undefined
              }
            })
          } catch (error) {
            /* sidebar missing: the main registration below still works */
          }

          try {
            slots.inject('main', function () {
              try {
                return slots.register({
                  name: 'main',
                  key: PANEL_ID,
                }, ObsidianHubPanel)
              } catch (error) {
                return undefined
              }
            })
          } catch (error) {
            /* main slot missing */
          }
        } catch (error) {
          /* activation must never break the page or the bundle */
        }
      },
    }
  },
})
