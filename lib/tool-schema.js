/**
 * Tool-schema normalizer.
 *
 * `ctx.tools.register()` takes a ToolDefinition VERBATIM: unlike the
 * `defineTool()` helper from `@deepseek-ai/dsh-tools`, it does not normalize a
 * friendly property map into JSON Schema. `register()` also validates
 * `output.schema` with `assertSupportedJsonSchema`, which REJECTS the inline
 * `required: true` marker (`schema.properties.x.required is not supported`).
 *
 * This bundle cannot import `@deepseek-ai/dsh-tools` (linked-directory install
 * resolves only its own files and Node builtins), so every tool module defines
 * tools in the readable property-map form and passes them through `defineTool`
 * below before registering. One implementation, one behavior.
 */

const NON_SCHEMA_KEYS = new Set([
  'required',
  'type',
  'properties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
  'additionalProperties',
  'oneOf',
  'anyOf',
  'allOf',
  'length',
  'minimum',
  'maximum',
])

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Is this a schema node (has a string `type`) rather than a property map? */
function isSchemaNode(node) {
  return isPlainObject(node) && typeof node.type === 'string'
}

/**
 * Does this node look like a bare property map (`{a:{type:'string'}}`)?
 *
 * A tool may legitimately declare parameters named `items`, `properties`, or
 * `enum`, so key names alone cannot decide — only `type` being a string, and
 * every value being an object, can.
 */
function looksLikePropertyMap(node) {
  if (!isPlainObject(node)) return false
  if (isSchemaNode(node)) return false
  const keys = Object.keys(node)
  if (keys.length === 0) return false
  return keys.every((key) => isPlainObject(node[key]))
}

/** Recursively turn a schema node into standard JSON Schema. */
export function normalizeSchema(node) {
  if (Array.isArray(node)) return node.map((item) => normalizeSchema(item))
  if (!isPlainObject(node)) return node

  if (looksLikePropertyMap(node)) {
    return normalizeSchema({ type: 'object', properties: node })
  }

  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'required' || key === 'properties' || key === 'items') continue
    out[key] = value
  }

  if (node.properties && isPlainObject(node.properties)) {
    const properties = {}
    const required = new Set(Array.isArray(node.required) ? node.required : [])
    for (const [name, child] of Object.entries(node.properties)) {
      if (isPlainObject(child) && child.required === true) required.add(name)
      properties[name] = normalizeSchema(child)
    }
    out.type = out.type || 'object'
    out.properties = properties
    if (required.size > 0) out.required = [...required]
  } else if (node.items !== undefined) {
    out.type = out.type || 'array'
    out.items = normalizeSchema(node.items)
  } else if (isPlainObject(node.required)) {
    // Defensive: a nested property map accidentally placed under `required`.
    delete out.required
  }

  // `required: true` on a leaf is meaningless in JSON Schema — never emit it.
  return out
}

/** Normalize the model-facing `parameters` field. */
export function normalizeParameters(parameters) {
  if (parameters === undefined) {
    return { type: 'object', properties: {}, additionalProperties: false }
  }
  // A tool with no parameters is authored as `{}`; it still needs an object schema.
  if (isPlainObject(parameters) && Object.keys(parameters).length === 0) {
    return { type: 'object', properties: {}, additionalProperties: false }
  }
  if (looksLikePropertyMap(parameters)) {
    return normalizeSchema({ type: 'object', properties: parameters })
  }
  return normalizeSchema(parameters)
}

/**
 * Reduce a tool result to values that survive a JSON round-trip unchanged.
 *
 * The Host rejects a tool whose value is "not lossless JSON". That happens for
 * values JSON cannot carry faithfully: `undefined` own properties (dropped by
 * `JSON.stringify`, so the round-trip no longer equals the original), `NaN` /
 * `Infinity` (become `null`), `-0`, BigInt, Date, Map/Set, and non-enumerable
 * helpers attached to parsed objects (e.g. a frontmatter object carrying a
 * non-enumerable `error: undefined`).
 *
 * A JSON round-trip is the exact normal form the Host compares against, so the
 * result is lossless by construction. A manual walk covers values JSON cannot
 * stringify at all (BigInt, cycles).
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function toLosslessJson(value) {
  if (value === undefined) return null
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'symbol' || typeof value === 'function') return null
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    const seen = new WeakSet()
    const walk = (node) => {
      if (node === null) return null
      const kind = typeof node
      if (kind === 'string' || kind === 'boolean') return node
      if (kind === 'number') return Number.isFinite(node) ? (Object.is(node, -0) ? 0 : node) : null
      if (kind === 'bigint') return node.toString()
      if (kind === 'undefined' || kind === 'function' || kind === 'symbol') return null
      if (kind !== 'object') return null
      if (seen.has(node)) return '[circular]'
      seen.add(node)
      if (Array.isArray(node)) return node.map(walk)
      if (node instanceof Date) return Number.isFinite(node.getTime()) ? node.toISOString() : null
      if (node instanceof Map) return Object.fromEntries([...node.entries()].map(([k, v]) => [String(k), walk(v)]))
      if (node instanceof Set) return [...node.values()].map(walk)
      const out = {}
      for (const [key, child] of Object.entries(node)) out[key] = walk(child)
      return out
    }
    return walk(value)
  }
}

/**
 * Build a registrable ToolDefinition from the readable authoring form.
 * @template {object} T
 * @param {T} definition
 */
export function defineTool(definition) {
  if (!definition || typeof definition !== 'object') {
    throw new Error('defineTool: a tool definition object is required')
  }
  if (typeof definition.name !== 'string' || definition.name.length === 0) {
    throw new Error('defineTool: `name` must be a non-empty string')
  }
  if (typeof definition.description !== 'string' || definition.description.length === 0) {
    throw new Error(`defineTool(${definition.name}): a non-empty description is required`)
  }
  if (typeof definition.execute !== 'function') {
    throw new Error(`defineTool(${definition.name}): execute() is required`)
  }
  const output = definition.output
  if (!output || typeof output !== 'object' || typeof output.render !== 'function') {
    throw new Error(`defineTool(${definition.name}): output.render() is required`)
  }
  const execute = definition.execute
  return {
    ...definition,
    parameters: normalizeParameters(definition.parameters),
    output: { ...output, schema: normalizeSchema(output.schema) },
    // The registry compares the value against its JSON round-trip; normalize
    // here so a plugin bug (an undefined field, a Date, a Map) cannot turn a
    // successful call into "invalid output".
    async execute(args, exec) {
      return toLosslessJson(await execute(args, exec))
    },
  }
}

/**
 * Register several tools with one disposer.
 * @param ctx Cordis context carrying `ctx.tools`
 * @param {Array<object>} definitions authoring-form definitions
 * @returns {() => void}
 */
export function registerTools(ctx, definitions) {
  const disposers = []
  try {
    for (const definition of definitions) {
      disposers.push(ctx.tools.register(defineTool(definition)))
    }
  } catch (error) {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* nothing to undo */
      }
    }
    throw error
  }
  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* already unregistered */
      }
    }
  }
}

export { NON_SCHEMA_KEYS }
