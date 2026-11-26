/**
 * sim-core/lib/foam.js — OpenFOAM installations declared by the project profile.
 *
 * The profile may list several installations (`foam.installations`), each with a
 * distribution (`com` = OpenCFD, `org` = Foundation), a version and a bashrc path.
 * A tool call can pick one by id (`openfoam: "org14"`) without restarting DSH;
 * the default comes from `foam.default` (or the first entry).
 * @module sim-core/lib/foam
 */
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/**
 * Normalise `foam.installations` from a profile into a map with absolute bashrc paths.
 * @param {object} foam the `foam` block of `sim-project.json`
 * @param {string} rootDir base for relative bashrc paths (the project root)
 */
export function normalizeInstallations(foam = {}, rootDir = process.cwd()) {
  const out = {}
  const raw = foam?.installations
  if (!raw || typeof raw !== 'object') return out
  for (const [id, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object') continue
    const rawPath = entry.bashrc ? String(entry.bashrc) : ''
    const bashrc = rawPath
      ? (isAbsolute(rawPath) ? rawPath : resolve(rootDir, rawPath))
      : ''
    out[id] = {
      id,
      distribution: String(entry.distribution ?? entry.flavor ?? ''),
      version: String(entry.version ?? ''),
      label: String(entry.label ?? (`${entry.distribution ?? ''}${entry.version ?? ''}`.trim() || id)),
      bashrc,
      exists: Boolean(bashrc && existsSync(bashrc)),
      notes: entry.notes ? String(entry.notes) : '',
    }
  }
  return out
}

/** Human-readable list for error messages and tool payloads. */
export function installationsPayload(config) {
  const installations = Object.values(config.foamInstallations ?? {})
  return {
    default: config.foamDefault || null,
    selected: {
      id: config.foamSelected?.id ?? null,
      distribution: config.foam?.distribution ?? null,
      version: config.foam?.version ?? null,
      bashrc: config.openfoamBashrc || null,
      exists: config.openfoamBashrcExists ?? null,
    },
    installations,
  }
}

/**
 * Resolve a selector (installation id, bashrc path, or nothing = current default).
 * Throws with the available ids when the id is unknown — silence would hide a typo.
 */
export function resolveFoam(config, selector) {
  const installations = config.foamInstallations ?? {}
  const requested = selector === undefined || selector === null ? '' : String(selector).trim()
  if (!requested) {
    const id = config.foamDefault && installations[config.foamDefault] ? config.foamDefault : ''
    if (id) return { ...installations[id], selectedBy: 'profile-default' }
    const bashrc = config.openfoamBashrc ?? ''
    return {
      id: 'default',
      distribution: config.foam?.distribution ?? '',
      version: String(config.foam?.version ?? ''),
      label: 'default',
      bashrc,
      exists: Boolean(bashrc && existsSync(bashrc)),
      selectedBy: 'config',
    }
  }
  if (installations[requested]) {
    return { ...installations[requested], selectedBy: 'installation-id' }
  }
  if (requested.includes('/') || requested.endsWith('bashrc')) {
    const bashrc = isAbsolute(requested) ? requested : resolve(config.cwd || process.cwd(), requested)
    return {
      id: 'custom',
      distribution: '',
      version: '',
      label: requested,
      bashrc,
      exists: existsSync(bashrc),
      selectedBy: 'path',
    }
  }
  const available = Object.keys(installations)
  throw new Error(`unknown OpenFOAM installation "${requested}"; available: ${available.length ? available.join(', ') : '(none declared in sim-project.json)'}`)
}

/** Return a config copy bound to the selected installation (no-op without a selector). */
export function withFoam(config, selector) {
  if (selector === undefined || selector === null || selector === '') return config
  const hit = resolveFoam(config, selector)
  if (!hit.bashrc) throw new Error(`OpenFOAM installation "${hit.id}" has no bashrc`)
  if (!hit.exists) throw new Error(`OpenFOAM bashrc does not exist for "${hit.id}": ${hit.bashrc}`)
  return {
    ...config,
    openfoamBashrc: hit.bashrc,
    openfoamBashrcExists: true,
    foamSelected: hit,
    foam: {
      ...(config.foam ?? {}),
      selected: hit.id,
      distribution: hit.distribution || config.foam?.distribution || '',
      version: hit.version || config.foam?.version || '',
    },
  }
}
