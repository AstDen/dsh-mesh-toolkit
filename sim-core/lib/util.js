/**
 * sim-core/lib/util.js — small helpers shared by every Sim plugin.
 *
 * Nothing here knows about a particular project, tool name or directory layout.
 * @module sim-core/lib/util
 */
import { createHash } from 'node:crypto'
import {
  createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Last N characters of a log tail. */
export function tail(text, max = 6000) {
  const value = String(text ?? '')
  return value.length <= max ? value : `…[${value.length - max} chars trimmed]…\n${value.slice(-max)}`
}

/** Read JSON with a readable error. */
export function readJson(file, what = file) {
  if (!existsSync(file)) throw new Error(`file not found: ${what}`)
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`invalid JSON in ${what}: ${error.message}`)
  }
}

/** Write JSON with a stable 2-space layout; the write is atomic (tmp + rename). */
export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  return file
}

/** Directory-relative path when possible, absolute otherwise. */
export function displayPath(config, path) {
  if (!path) return null
  const abs = resolve(path)
  const root = config?.projectRoot || ''
  if (!root) return abs
  const rel = relative(root, abs)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : abs
}

/** Recursively drop undefined/NaN/Infinity; the tool output schema is lossless JSON. */
export function jsonSafe(value) {
  if (value === undefined) return undefined
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  // -0 is finite but NOT lossless JSON (dsh snapshotJsonValue rejects Object.is(-0)),
  // and trimesh/gmsh metrics legitimately return -0 for bbox minima.
  if (typeof value === 'number') return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null
  if (typeof value === 'bigint') return Number(value)
  if (Array.isArray(value)) return value.map(jsonSafe).filter((v) => v !== undefined)
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    const out = {}
    for (const [key, val] of Object.entries(value)) {
      const safe = jsonSafe(val)
      if (safe !== undefined) out[key] = safe
    }
    return out
  }
  return null
}

/** Normalize a name for file/registry ids. */
export function slugify(value, fallback = 'item') {
  const out = String(value ?? '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return out || fallback
}

/** Base name without extension. */
export function stem(file) {
  return basename(file, extname(file))
}

/** Minimal CSV field quoting. */
export function csvField(value) {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Format a bbox as WxHxD with trailing zeros removed. */
export function formatBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length < 3) return ''
  return bbox.slice(0, 3).map((v) => Number(v).toFixed(4).replace(/\.?0+$/, '')).join('x')
}

/** True when `child` is `root` itself or lives under it. */
export function isInside(root, child) {
  const r = resolve(String(root))
  const c = resolve(String(child))
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep)
}

/** ISO timestamp with the local offset (stable for passports). */
export function nowIso() {
  const d = new Date()
  const pad = (n) => String(Math.abs(n)).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
}

/** sha256 of a file (streaming; large polyMesh files are fine). */
export async function sha256File(file) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

/** sha256 of a file, synchronous (used by passports and freshness checks). */
export function sha256FileSync(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Size and mtime of a file, or null. */
export function fileStat(file) {
  try {
    const st = statSync(file)
    return { size: st.size, mtimeMs: Math.round(st.mtimeMs) }
  } catch {
    return null
  }
}

/** Replace `{placeholder}` slots in a template string. */
export function renderTemplate(template, values = {}) {
  return String(template ?? '').replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => {
    const value = values[key]
    return value === undefined || value === null ? match : String(value)
  })
}

/** Expand a path, a directory, an array or a simple `*` pattern into STL files. */
export function expandStlFiles(inputs, resolvePath) {
  const list = Array.isArray(inputs) ? inputs : [inputs]
  const files = []
  const missing = []
  for (const raw of list) {
    if (!raw) continue
    const path = resolvePath(raw)
    if (!existsSync(path)) { missing.push(path); continue }
    const st = statSync(path)
    if (st.isDirectory()) {
      for (const entry of readdirSync(path).sort()) {
        if (extname(entry).toLowerCase() === '.stl') files.push(join(path, entry))
      }
      continue
    }
    if (st.isFile() && extname(path).toLowerCase() === '.stl') { files.push(path); continue }
    missing.push(path)
  }
  return { files: [...new Set(files)], missing }
}

export { join, resolve, dirname, basename, extname, isAbsolute, relative, sep }
