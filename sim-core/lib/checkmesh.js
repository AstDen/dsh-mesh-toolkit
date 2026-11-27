/**
 * sim-core/lib/checkmesh.js — parse `checkMesh` output into metrics and a verdict basis.
 *
 * `checkMesh` exits with code 0 even when it prints `Failed N mesh checks`, so the
 * verdict MUST come from the text. This module is the single place that knows how.
 * @module sim-core/lib/checkmesh
 */

const NUMBER = '([-+]?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?)'

function firstNumber(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re)
    if (m) {
      const value = Number(m[1])
      if (Number.isFinite(value)) return value
    }
  }
  return null
}

function firstInt(text, patterns) {
  const value = firstNumber(text, patterns)
  return value === null ? null : Math.round(value)
}

/** Threshold lines that actually violate something, e.g. `faces with ... < 1e-14 : 9`. */
export function thresholdViolations(text) {
  const violations = []
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(/^\s*(.+?)\s*:\s*(\d+)\s*\.?\s*$/)
    if (!m) continue
    const label = m[1].trim()
    const count = Number(m[2])
    if (count > 0 && /[<>]/.test(label)) violations.push(`${label} : ${count}`)
  }
  return violations
}

/** Parse raw checkMesh (or a gate summary) into metrics. */
export function parseCheckMesh(log) {
  const text = String(log ?? '').replace(/\u001b\[[0-9;]*m/g, '')
  const layer = text.match(/Added (\d+) out of (\d+) cells \(([\d.]+)%\)/)
  // snappyHexMesh reports layers twice: cells (final) and faces (per extrusion pass)
  const layerFaces = text.match(/Extruding (\d+) out of (\d+) faces \(([\d.]+)%\)/)
  return {
    cells: firstInt(text, [/^\s*cells:\s*(\d+)/m, /\bcells=(\d+)/]),
    points: firstInt(text, [/^\s*points:\s*(\d+)/m, /\bpoints=(\d+)/]),
    faces: firstInt(text, [/^\s*faces:\s*(\d+)/m, /\bfaces=(\d+)/]),
    maxNonOrtho: firstNumber(text, [
      /Mesh non-orthogonality Max:\s*([\d.]+)/, /maxNonOrtho=\{?([\d.]+)\}?°/,
    ]),
    avgNonOrtho: firstNumber(text, [
      /Mesh non-orthogonality Max:\s*[\d.]+\s*average:\s*([\d.]+)/, /avg=\{?([\d.]+)\}?°/,
    ]),
    severelyNonOrtho: firstInt(text, [
      /Number of severely non-orthogonal \(> \d+ degrees\) faces:\s*(\d+)/, /faces>\d+°=(\d+)/,
    ]),
    maxSkewness: firstNumber(text, [/Max skewness =\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/, /maxSkew=([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/]),
    minVolume: firstNumber(text, [/Min volume =\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/, /minVol=([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/]),
    maxConcavity: firstNumber(text, [/Max concavity =\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/]),
    minFaceWeight: firstNumber(text, [/Min face weight =\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/]),
    minVolRatio: firstNumber(text, [/Min volume ratio =\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/]),
    minDeterminant: firstNumber(text, [/Min determinant =\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/]),
    failedChecks: firstInt(text, [/Failed\s+(\d+)\s+mesh checks?/]),
    meshOk: /\bMesh OK\b/.test(text) || /\bverdict=OK\b/.test(text),
    fatal: /FOAM FATAL (ERROR|IO ERROR)/.test(text),
    violations: thresholdViolations(text),
    layers: layer ? { added: Number(layer[1]), outOf: Number(layer[2]), percent: Number(layer[3]) } : null,
    layersFaces: layerFaces
      ? { extruded: Number(layerFaces[1]), outOf: Number(layerFaces[2]), percent: Number(layerFaces[3]) }
      : null,
  }
}

/** Classify the failure for actionable advice. */
export function failKindOf(metrics, verdict) {
  if (verdict !== 'FAIL') return null
  if (metrics.failedChecks && metrics.failedChecks > 0 && metrics.violations.length === 0) return 'mesh-quality'
  const labels = metrics.violations.join(' ').toLowerCase()
  if (!labels) return 'mesh-quality'
  if (/face pyramid volume|tet quality/.test(labels)) return 'minVol-threshold'
  if (/face twist|triangle twist/.test(labels)) return 'face-twist'
  if (/non-orthogonality/.test(labels)) return 'nonOrtho'
  if (/skewness/.test(labels)) return 'skewness'
  if (/face weight|volume ratio|determinant/.test(labels)) return 'shape-metric'
  return 'mesh-quality'
}

/** Verdict from text only. */
export function verdictOf(metrics) {
  if (metrics.fatal) return 'ERROR'
  if (metrics.failedChecks && metrics.failedChecks > 0) return 'FAIL'
  if (metrics.violations.length > 0) return 'FAIL'
  if (metrics.meshOk) return 'PASS'
  return 'UNKNOWN'
}

/**
 * The layer-extrusion line snappyHexMesh prints — `Extruding N out of M faces (P%)`.
 * checkMesh reports layers as cells (`Added … cells`), so face coverage only exists in the
 * snappy log; both shapes are needed to judge `minLayerCoverage`.
 * @param {string} text snappyHexMesh log
 */
export function parseLayerFaces(text) {
  const m = String(text ?? '').match(/Extruding (\d+) out of (\d+) faces \(([\d.]+)%\)/)
  return m ? { extruded: Number(m[1]), outOf: Number(m[2]), percent: Number(m[3]) } : null
}
