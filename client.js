/**
 * dsh-obsidian-hub — Web (browser) half.
 *
 * Registers one small panel in the host's settings page that shows the vault
 * connection status (vault path, note count, index status, Local REST API
 * reachability) and a quick local filter over note titles/paths.
 *
 * Contract notes:
 * - Loaded as a dynamic module through `window.__ModuleLoader__`; React comes
 *   from the browser module table, nothing else is imported.
 * - The Host half owns the vault. This file never touches the filesystem and
 *   never invents data: it reads `GET /obsidian-hub/status` (or an optional
 *   in-page bridge, see `readBridge`) and renders an explicit "waiting for
 *   data" state until that answers.
 * - Crash-safety matters more than features: a throwing component blanks the
 *   slot, so every render path is defensive, an error boundary sits above the
 *   component, and `apply` swallows every failure.
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
        'field.vault': 'Vault',
        'field.notes': 'Notes',
        'field.index': 'Index',
        'field.rest': 'Local REST API',
        'value.vaultUnknown': 'Not detected yet',
        'value.noteCount': '{count} notes',
        'value.indexReady': 'Ready · {notes} notes',
        'value.indexMissing': 'Not built',
        'value.restReachable': 'Reachable',
        'value.restUnreachable': 'Unreachable',
        'value.restNotConfigured': 'Not configured',
        'value.restUnknown': 'Unknown',
        'value.unknown': '—',
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
        'field.vault': '知识库',
        'field.notes': '笔记',
        'field.index': '索引',
        'field.rest': '本地 REST API',
        'value.vaultUnknown': '尚未检测到',
        'value.noteCount': '{count} 篇',
        'value.indexReady': '已就绪 · {notes} 篇',
        'value.indexMissing': '尚未建立',
        'value.restReachable': '可访问',
        'value.restUnreachable': '不可访问',
        'value.restNotConfigured': '未配置',
        'value.restUnknown': '未知',
        'value.unknown': '—',
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
    const FETCH_TIMEOUT_MS = 8000
    const MAX_TITLES = 2000
    const MAX_RESULTS = 8

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

    /** Normalize whatever the Host answered into the panel's own shape. */
    function normalizeStatus(raw) {
      const result = {
        source: '',
        vaultPath: '',
        vaultName: '',
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

    /** GET the status route with a bounded wait; resolves, never rejects. */
    async function requestStatusFromRoute() {
      if (typeof fetch !== 'function') return { ok: false, reason: 'no-fetch' }
      let timer = null
      const init = {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      }
      try {
        if (typeof AbortController === 'function') {
          const controller = new AbortController()
          init.signal = controller.signal
          timer = setTimeout(function () {
            try {
              controller.abort()
            } catch (error) {
              /* ignore */
            }
          }, FETCH_TIMEOUT_MS)
        }
        const response = await fetch(STATUS_PATH, init)
        if (!response) return { ok: false, reason: 'network' }
        if (response.status === 404) return { ok: false, reason: 'no-route' }
        if (response.ok !== true) return { ok: false, reason: 'http-' + String(response.status) }
        let payload = null
        try {
          payload = await response.json()
        } catch (error) {
          return { ok: false, reason: 'bad-json' }
        }
        if (!isRecord(payload)) return { ok: false, reason: 'bad-payload' }
        if (payload.ok === false) {
          return { ok: false, reason: asString(payload.error) || 'host-error' }
        }
        return { ok: true, data: normalizeStatus(payload) }
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

    /** Read the status from the bridge first, then from the HTTP route. */
    async function requestStatus() {
      try {
        const bridge = readBridge()
        if (bridge !== null) {
          try {
            const value = await bridge.getStatus()
            if (isRecord(value)) {
              const data = normalizeStatus(value)
              data.source = 'bridge'
              return { ok: true, data: data }
            }
            return { ok: false, reason: 'bad-payload' }
          } catch (error) {
            /* fall through to the route */
          }
        }
      } catch (error) {
        /* fall through to the route */
      }
      return requestStatusFromRoute()
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
    const CSS = `
.doh-panel{display:flex;flex-direction:column;gap:12px;box-sizing:border-box;
  padding:14px 16px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-text-primary);font-size:13px;line-height:1.5;
  max-width:640px;font-family:inherit}
.doh-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.doh-title{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-text-primary)}
.doh-pill{display:inline-flex;align-items:center;gap:6px;flex:none;
  font-size:11.5px;color:var(--dsw-alias-text-secondary);
  border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:2px 10px;white-space:nowrap}
.doh-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-text-secondary)}
.doh-dot.is-ok{background:var(--dsw-alias-state-success-primary)}
.doh-dot.is-warn{background:var(--dsw-alias-state-warn-primary)}
.doh-dot.is-error{background:var(--dsw-alias-state-error-primary)}
.doh-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));
  gap:8px 16px;margin:0;padding:0}
.doh-row{min-width:0;display:flex;flex-direction:column;gap:1px}
.doh-label{font-size:11px;letter-spacing:.02em;color:var(--dsw-alias-text-secondary)}
.doh-value{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.doh-mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
.doh-search{display:flex;flex-direction:column;gap:6px}
.doh-input{box-sizing:border-box;width:100%;background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;
  color:var(--dsw-alias-text-primary);font:inherit;font-size:13px;outline:none}
.doh-input::placeholder{color:var(--dsw-alias-text-secondary)}
.doh-input:focus{border-color:var(--dsw-alias-brand-primary)}
.doh-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;
  gap:1px;max-height:220px;overflow:auto}
.doh-item{display:flex;flex-direction:column;gap:1px;width:100%;box-sizing:border-box;
  text-align:left;background:transparent;border:0;border-radius:7px;padding:5px 8px;
  font:inherit;color:inherit;cursor:pointer}
.doh-item:hover{background:var(--dsw-alias-bg-layer-2)}
.doh-item-title{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.doh-item-path{font-size:11.5px;color:var(--dsw-alias-text-secondary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.doh-empty{font-size:12px;color:var(--dsw-alias-text-secondary);padding:2px 0}
.doh-note{display:flex;flex-direction:column;gap:3px;font-size:12px;
  color:var(--dsw-alias-text-secondary)}
.doh-note-title{font-size:12.5px;font-weight:600;color:var(--dsw-alias-text-primary)}
.doh-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;
  font-size:11.5px;color:var(--dsw-alias-text-secondary)}
.doh-btn{background:transparent;border:1px solid var(--dsw-alias-border-l1);
  border-radius:8px;padding:4px 12px;font:inherit;font-size:12px;
  color:var(--dsw-alias-text-primary);cursor:pointer}
.doh-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.doh-btn[disabled]{opacity:.55;cursor:default}
`

    /* -------------------------------------------------------------- components */

    /** Language-bound translator that survives re-renders. */
    function useTranslator() {
      const ref = React.useRef(null)
      if (ref.current === null) ref.current = makeTranslator(detectLang())
      return ref.current
    }

    function statusPill(t, phase) {
      try {
        if (phase === 'ready') return { label: t('status.connected'), dot: 'is-ok' }
        if (phase === 'waiting') return { label: t('status.waiting'), dot: 'is-warn' }
        if (phase === 'error') return { label: t('status.error'), dot: 'is-error' }
        return { label: t('status.loading'), dot: '' }
      } catch (error) {
        return { label: '', dot: '' }
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
        const vault = phaseData === null
          ? t('value.unknown')
          : (phaseData.vaultPath || phaseData.vaultName || t('value.vaultUnknown'))
        rows.push(fieldNode(t('field.vault'), vault, 'doh-mono'))

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
        h('div', { key: 'b' }, body),
      ])
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
        return h('div', { className: 'doh-panel' }, [
          h('style', { key: 'style' }, CSS),
          h('div', { className: 'doh-empty', key: 'msg' }, text),
        ])
      } catch (error) {
        return null
      }
    }

    /** Pure view assembly: everything above it is data, everything below is DOM. */
    function renderPanel(view) {
      const t = view.t
      const data = view.data
      const pill = statusPill(t, view.phase)
      const children = [h('style', { key: 'style' }, CSS)]

      children.push(h('div', { className: 'doh-head', key: 'head' }, [
        h('h3', { className: 'doh-title', key: 'title' }, t('panel.title')),
        h('span', { className: 'doh-pill', key: 'pill' }, [
          h('span', { className: 'doh-dot ' + pill.dot, key: 'dot' }),
          h('span', { key: 'label' }, pill.label),
        ]),
      ]))

      children.push(statusGrid(t, data))

      if (view.phase === 'waiting') {
        children.push(noticeBlock(t('waiting.title'), t('waiting.body', { route: STATUS_PATH })))
      } else if (view.phase === 'error') {
        children.push(noticeBlock(t('error.title'), t('error.body', { reason: view.reason || 'unknown' })))
      }

      if (data !== null) {
        children.push(searchBlock(t, data, view.query, view.setQuery, view.results))
      }
      children.push(h('div', { className: 'doh-foot', key: 'foot' }, [
        h('span', { key: 'stamp' }, t('footer.updatedAt', {
          time: data !== null ? formatTime(data.updatedAt, t) : t('footer.never'),
        })),
        h('button', {
          key: 'refresh',
          type: 'button',
          className: 'doh-btn',
          disabled: view.phase === 'loading',
          onClick: view.refresh,
        }, view.phase === 'loading' ? t('actions.refreshing') : t('actions.refresh')),
      ]))

      return h('div', {
        className: 'doh-panel',
        role: 'group',
        'aria-label': t('panel.title'),
        'data-plugin': 'dsh-obsidian-hub',
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
      const tickHook = React.useState(0)
      const tick = tickHook[0]
      const setTick = tickHook[1]
      const runRef = React.useRef(0)

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

      const results = filterTitles(state.data !== null ? state.data.titles : [], query)
      const view = {
        t: t,
        phase: state.phase,
        data: state.data,
        reason: state.reason,
        query: query,
        setQuery: setQuery,
        results: results,
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

    /** Slot entry: an error boundary keeps a crash from blanking the slot. */
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

    const SLOT = 'settings.section'

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          if (ctx === null || typeof ctx !== 'object') return
          const slots = ctx.slots
          if (slots === null || typeof slots !== 'object') return
          if (typeof slots.inject !== 'function' || typeof slots.register !== 'function') return

          slots.inject(SLOT, function () {
            try {
              const translator = makeTranslator(detectLang())
              return slots.register({
                name: SLOT,
                id: 'obsidian-hub',
                order: 40,
                label: function () {
                  try {
                    return translator('panel.title')
                  } catch (error) {
                    return 'Obsidian Hub'
                  }
                },
              }, ObsidianHubPanel)
            } catch (error) {
              return undefined
            }
          })
        } catch (error) {
          /* activation must never break the page or the bundle */
        }
      },
    }
  },
})
