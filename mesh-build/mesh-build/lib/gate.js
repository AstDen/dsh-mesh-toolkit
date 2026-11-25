/**
 * mesh-build/lib/gate.js — compatibility wrapper around the sim-core gate.
 *
 * The gate itself (meshQualityDict, overlay, checkMesh parsing, verdict) lives in
 * `sim-core`; this file only adapts the legacy call shape `gateCase(config, caseDir, opts)`
 * and flattens per-target results for tool output.
 * @module mesh-build/lib/gate
 */
import { detectRegions as coreDetectRegions, gateCase as coreGateCase } from '../../sim-core/lib/gate.js'
import { displayPath } from '../../sim-core/lib/util.js'

export { detectRegions } from '../../sim-core/lib/gate.js'
export { parseCheckMesh, verdictOf } from '../../sim-core/lib/checkmesh.js'

/** Detect regions via the core helper (kept as a named re-export for patches.js). */
export const detectRegionsCompat = coreDetectRegions

/**
 * Gate a case (all regions or the base mesh).
 * @param {object} config resolved plugin config
 * @param {string} caseDir absolute case path
 * @param {{profile?: string, minVol?: number, regions?: string[], engine?: string, script?: string}} options
 */
export function gateCase(config, caseDir, options = {}) {
  const result = coreGateCase({
    config,
    caseDir,
    regions: options.regions,
    profile: options.profile ?? config.gate?.profile,
    minVol: options.minVol ?? null,
    engine: options.engine,
    script: options.script,
    timeoutMs: config.timeoutMs,
    maxOutputChars: config.maxOutputChars,
    openfoamBashrc: config.openfoamBashrc,
  })
  const results = result.targets.map((target) => ({
    region: target.region,
    pass: target.pass,
    verdict: target.verdict,
    profile: target.profile,
    engine: target.engine,
    failKind: target.failKind ?? null,
    minVol: target.minVol ?? null,
    minVolSource: target.minVolSource ?? null,
    minVolSuggestion: target.suggestion?.minVol ?? null,
    thresholds: target.thresholds ?? null,
    metrics: target.metrics ?? null,
    advisory: target.advisory ?? [],
    log: target.log ? displayPath(config, target.log) : null,
    stderrTail: target.stderrTail ?? '',
    error: target.error,
    hint: target.hint,
  }))
  const advisory = [...new Set(results.flatMap((item) => item.advisory))]
  return {
    caseDir,
    verdict: result.verdict,
    pass: result.pass,
    regions: result.regions,
    failingRegions: result.failingRegions,
    results,
    advisory,
    layers: null,
  }
}
