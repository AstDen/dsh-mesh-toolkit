/**
 * `meshToolkit` — the optional Cordis service a solver-side workbench resolves at call time
 * (`ctx.get('meshToolkit')`), so it never has to import this package or chain tools by hand.
 *
 * apiVersion 1 (docs/WORKBENCH-CONTRACT.md §5). Each method is contributed by whichever package is
 * installed — mesh-stl registers `generate`/`qa`, mesh-build registers `mesh`/`gate`/`deliver` — and
 * the service itself is created by the first package that asks for it. Absent methods answer with a
 * structured error instead of throwing, so the consumer can fall back to its own path.
 */

export const TOOLKIT_SERVICE = 'meshToolkit'
export const TOOLKIT_API_VERSION = 1

/** Methods the contract names; registration of anything else is allowed but not advertised. */
export const TOOLKIT_METHODS = ['generate', 'mesh', 'revise', 'patchTypes', 'gate', 'deliver']

const METHOD_HINT = {
  generate: 'install mesh-stl (STL generators) — or call stl_generate directly',
  mesh: 'install mesh-build (snappy/cfMesh/gmsh routes) — or call mesh_build directly',
  revise: 'mesh_revise ships with mesh-build 0.6.x (plan A3); until then re-run mesh_build with new parameters',
  patchTypes: 'mesh_patch_types ships with mesh-build 0.6.x (plan A2); until then retype with foamDictionary -entry boundary.<patch>.type',
  gate: 'install mesh-build — or call mesh_check directly',
  deliver: 'install mesh-build — or call mesh_deliver directly',
}

/**
 * One service per application, even when both bundles are enabled.
 *
 * Both `mesh-stl` and `mesh-build` call `ensureToolkit`, and Cordis throws
 * `service "meshToolkit" has been registered at <mesh-stl>` on the second `provide`. The service is
 * therefore kept on the root context (shared by every plugin of the app) and `provide` is best-effort:
 * whoever arrives second reuses the first object instead of registering a duplicate, and its methods
 * land in the same map, so the service keeps working for whichever package is installed alone.
 */
const SERVICE_SLOT = Symbol.for('dsh.mesh-toolkit/service')
const SERVICE_REGISTRY = new WeakMap()

function serviceHost(ctx) {
  const root = ctx && typeof ctx === 'object' ? ctx.root : null
  if (root && typeof root === 'object') {
    let host = SERVICE_REGISTRY.get(root)
    if (!host) { host = {}; SERVICE_REGISTRY.set(root, host) }
    return host
  }
  const host = globalThis
  if (!host[SERVICE_SLOT]) host[SERVICE_SLOT] = {}
  return host[SERVICE_SLOT]
}

function existingService(ctx) {
  const looked = typeof ctx?.get === 'function' ? ctx.get(TOOLKIT_SERVICE) : null
  if (looked) return looked
  const host = serviceHost(ctx)
  return host.service ?? null
}

/**
 * Get or create the service on a Cordis context.
 * `ctx` may be a real context or a test double exposing `get`/`provide`.
 */
export function ensureToolkit(ctx) {
  const existing = existingService(ctx)
  if (existing) return existing

  /** @type {Map<string, {fn: Function, plugin: string|null, version: string|null, tool: string|null}>} */
  const providers = new Map()

  const describe = () => [...providers.entries()]
    .map(([method, p]) => ({ method, plugin: p.plugin ?? null, version: p.version ?? null, tool: p.tool ?? null }))
    .sort((a, b) => a.method.localeCompare(b.method))

  const notProvided = (method) => ({
    ok: false,
    error: 'not-provided',
    method,
    available: describe().map((d) => d.method),
    message: `meshToolkit.${method} is not provided by any installed package`,
    hint: METHOD_HINT[method] ?? 'install mesh-stl and mesh-build',
  })

  const call = async (method, args = {}, exec) => {
    const provider = providers.get(method)
    if (!provider) return notProvided(method)
    try {
      const value = await provider.fn(args ?? {}, exec)
      if (value && typeof value === 'object' && !Array.isArray(value) && value.error) {
        return { ok: false, error: value.error, method, value }
      }
      return value
    } catch (error) {
      return { ok: false, error: 'exception', method, message: String(error?.message ?? error) }
    }
  }

  const service = {
    apiVersion: TOOLKIT_API_VERSION,
    owner: null,
    /** Contribute one method. Later registrations win (a plugin reload re-registers). */
    register(method, fn, meta = {}) {
      if (typeof fn !== 'function') throw new TypeError(`meshToolkit.register("${method}"): fn must be a function`)
      providers.set(String(method), { fn, plugin: meta.plugin ?? null, version: meta.version ?? null, tool: meta.tool ?? null })
      return service
    },
    /** Drop a method (used by tests and by a plugin that unloads). */
    unregister(method) {
      providers.delete(String(method))
      return service
    },
    providers: describe,
    /** What this toolkit can do right now — the workbench's discovery call. */
    capabilities() {
      return {
        apiVersion: TOOLKIT_API_VERSION,
        methods: describe(),
        missing: TOOLKIT_METHODS.filter((m) => !providers.has(m)),
      }
    },
    has: (method) => providers.has(String(method)),
    call,
    // Typed shims: the consumer reads better than `call('gate', …)`.
    generate: (args, exec) => call('generate', args, exec),
    mesh: (args, exec) => call('mesh', args, exec),
    revise: (args, exec) => call('revise', args, exec),
    patchTypes: (args, exec) => call('patchTypes', args, exec),
    gate: (args, exec) => call('gate', args, exec),
    deliver: (args, exec) => call('deliver', args, exec),
  }

  const host = serviceHost(ctx)
  host.service = service
  if (typeof ctx?.provide === 'function') {
    try {
      ctx.provide(TOOLKIT_SERVICE, service)
    } catch (error) {
      // A second bundle in the same app: reuse the registration that is already there.
      const registered = existingService(ctx)
      if (registered) {
        host.service = registered
        return registered
      }
      throw error
    }
  }
  return service
}

/** A user-facing payload for consumers that cannot resolve the service at all. */
export function missingToolkitPayload(consumer = 'workbench', hint = null) {
  return {
    available: false,
    service: TOOLKIT_SERVICE,
    consumer,
    reason: 'the meshToolkit service is not available: no package providing it is installed',
    hint: hint ?? 'install dsh-mesh-toolkit (mesh-stl + mesh-build) and restart the plugin graph; the file contract (handoff.json) works without the service',
  }
}
