/**
 * mesh-stl/lib/qa/verdict.js — the verdict wording of the python QA, unchanged.
 *
 * Reports are consumed by agents and by the benchmark protocol, which quotes
 * these strings; keep them verbatim and in the same order when the engine changes.
 * @module mesh-stl/lib/qa/verdict
 */

const pct = (value, expected) => ((value - expected) / expected) * 100

/** python prints a float tolerance as 2.0, not 2 — keep the message identical. */
const pyFloat = (value) => {
  const number = Number(value)
  return Number.isInteger(number) ? `${number}.0` : String(number)
}

/**
 * Build problems and the PASS/FAIL verdict from a python-shaped report.
 * @param {object} report raw report (see qa/index.js)
 * @param {{expectVolume?: number, expectArea?: number, expectBodies?: number,
 *   maxVolumeErr?: number, maxAreaErr?: number, cleanOut?: string}} options
 */
export function judge(report, options = {}) {
  const problems = []
  const cleaned = report.cleaned ?? {}
  const watertight = cleaned.is_watertight ?? report.is_watertight
  const winding = cleaned.is_winding_consistent ?? report.is_winding_consistent
  const bodies = cleaned.bodies ?? report.bodies
  const volume = cleaned.volume ?? report.volume
  const area = cleaned.area ?? report.area

  if (!watertight) problems.push('STL НЕ watertight (даже после удаления вырожденных граней)')
  if (!winding) problems.push('нормали несогласованы (winding inconsistent)')

  const expectedBodies = options.expectBodies ?? report.expected_bodies ?? null
  if (expectedBodies !== null && expectedBodies !== undefined && bodies !== Number(expectedBodies)) {
    problems.push(`тел: ${bodies} (ожидалось ${expectedBodies})`)
  }
  if (!(volume > 0)) problems.push(`объём <= 0 (${volume.toFixed(4)})`)

  // «как есть»: сырой STL не watertight и чистка не запрошена — в мешер отдавать нельзя
  // (раньше такой файл получал PASS с предупреждением — benchmark DEF-05).
  if (!options.cleanOut && !report.is_watertight) {
    problems.push('сырой STL не watertight (вырожденных граней: '
      + `${report.degenerate_faces}, non-manifold рёбер: ${report.non_manifold_edges}): `
      + 'перед мешированием нужен --clean-out (в stl_check это cleanup: true)')
  }

  const maxVolumeErr = Number(options.maxVolumeErr ?? 2.0)
  const maxAreaErr = Number(options.maxAreaErr ?? 5.0)
  if (options.expectVolume !== undefined && options.expectVolume !== null) {
    const err = pct(volume, Number(options.expectVolume))
    report.expected_volume = Number(options.expectVolume)
    report.volume_err_pct = err
    if (Math.abs(err) > maxVolumeErr) {
      problems.push(`|ΔV| = ${Math.abs(err).toFixed(3)}% > допуска ${pyFloat(maxVolumeErr)}% `
        + `(V=${volume.toFixed(4)}, ожидалось ${Number(options.expectVolume).toFixed(4)})`)
    }
  }
  if (options.expectArea !== undefined && options.expectArea !== null) {
    const err = pct(area, Number(options.expectArea))
    report.expected_area = Number(options.expectArea)
    report.area_err_pct = err
    if (Math.abs(err) > maxAreaErr) {
      problems.push(`|ΔA| = ${Math.abs(err).toFixed(3)}% > допуска ${pyFloat(maxAreaErr)}%`)
    }
  }

  return { problems, verdict: problems.length === 0 ? 'PASS' : 'FAIL', expectedBodies: expectedBodies ?? null }
}
