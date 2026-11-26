/**
 * mesh-stl/lib/registry.js — append a row to the project STL passport table.
 * @module mesh-stl/lib/registry
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

/** Canonical column order of stl/registry.csv (see project AGENTS.md / geometry/AGENTS.md). */
export const REGISTRY_COLUMNS = [
  'geom_id', 'name', 'family', 'generator', 'params_file', 'seed', 'units', 'domain_mm', 'periodic',
  'fluid_or_solid', 'triangles', 'area_mm2', 'volume_mm3', 'bbox_mm', 'watertight', 'date', 'path', 'notes',
]

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n;]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** Format bbox [x,y,z] in mm as WxHxD with 4 significant decimals. */
export function formatBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length < 3) return ''
  return bbox.slice(0, 3).map((v) => Number(v).toFixed(4).replace(/\.?0+$/, '')).join('x')
}

/**
 * Absolute path of the passport table. `registry` may be absolute; a relative value is
 * resolved against the project root, or against the cwd when there is no profile — so the
 * default `./stl/registry.csv` works in a bare directory (plan 1.3).
 */
export function registryFilePath(config) {
  const entry = String(config.registry || 'stl/registry.csv')
  const base = config.projectRoot || config.rootDir || process.cwd()
  return isAbsolute(entry) ? entry : join(base, entry)
}

/** Append one passport row; creates the file with a header when missing. */
export function appendRegistryRow(config, values) {
  const file = registryFilePath(config)
  mkdirSync(dirname(file), { recursive: true })
  let existed = existsSync(file)
  if (!existed) {
    appendFileSync(file, `${REGISTRY_COLUMNS.join(',')}\n`, 'utf8')
    existed = true
  } else {
    const header = readFileSync(file, 'utf8').split('\n')[0]
    if (!header.includes('geom_id')) {
      throw new Error(`registry file has no expected header (geom_id,...): ${file}`)
    }
  }
  const row = REGISTRY_COLUMNS.map((column) => csvCell(values[column]))
  appendFileSync(file, `${row.join(',')}\n`, 'utf8')
  return { file, columns: REGISTRY_COLUMNS, rowCount: 1 }
}
