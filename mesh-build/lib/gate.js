/**
 * mesh-build/lib/gate.js — compatibility wrapper around the sim-core gate.
 *
 * The gate itself (meshQualityDict, overlay, checkMesh parsing, verdict) lives in
 * `sim-core`; this file only adapts the legacy call shape `gateCase(config, caseDir, opts)`
 * and flattens per-target results for tool output.
 * @module mesh-build/lib/gate
 */
import { detectRegions as coreDetectRegions, gateCase as coreGateCase } from '../../sim-core/lib/gate.js'
import { deriveMinVol } from './minvol.js'
import { layerCoverageCheck } from '../../sim-core/lib/gate.js'
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
  // D-6: an absolute profile-wide minVol cannot be right for every mesh. When neither the call
  // nor the project supplies one, derive h_min³/6 from the case instead of writing -1.
  const configured = options.minVol ?? config.gate?.minVol ?? null
  const derived = configured === null || configured === undefined || configured === ''
    ? (options.derivedMinVol ?? deriveMinVol(caseDir))
    : null
  const result = coreGateCase({
    config,
    caseDir,
    regions: options.regions,
    profile: options.profile ?? config.gate?.profile,
    minVol: options.minVol ?? (derived ? derived.minVol : null),
    engine: options.engine,
    script: options.script,
    writeFields: options.writeFields ?? null,
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
    layers: target.layers ?? null,
    advisory: target.advisory ?? [],
    log: target.log ? displayPath(config, target.log) : null,
    writeFields: target.writeFields ?? null,
    writtenFields: target.writtenFields ?? [],
    stderrTail: target.stderrTail ?? '',
    error: target.error,
    hint: target.hint,
  }))
  // D-7/D-10: face coverage comes from the snappy log (checkMesh only reports cells), so the caller
  // hands it in and the threshold from the profile decides. Re-applied after a tightening re-run,
  // which rebuilds the result list from the retry.
  const applyLayerCoverage = (items) => {
    if (!options.layerFaces || !items.length) return null
    const thresholds = items[0].thresholds ?? {}
    const check = layerCoverageCheck({ layersFaces: options.layerFaces, required: thresholds.minLayerCoverage })
    for (const item of items) {
      item.layers = { ...(item.layers ?? {}), faces: options.layerFaces, required: check.required, status: check.status }
      if (check.status === 'below') {
        item.verdict = 'FAIL'
        item.pass = false
        item.failKind = item.failKind ?? 'layers'
        item.advisory = [...(item.advisory ?? []), `${check.message}; the gate profile asks for minLayerCoverage ${check.required}.`]
      }
    }
    if (check.status === 'below') {
      result.verdict = 'FAIL'
      result.pass = false
      result.failingRegions = [...new Set([...(result.failingRegions ?? []), ...items.map((item) => item.region)])]
    }
    return check
  }

  let layerOutcome = applyLayerCoverage(results)
  let tightened = null
  let usedMeasured = false
  if (derived && result.verdict === 'FAIL') {
    // A derived `h_min^3/6` describes the intended cell; snappy also makes thinner boundary cells, and
    // one face pyramid below the threshold marks the mesh illegal. The evidence is the run itself:
    // retry at checkMesh's own advice (`minVolume / 12`) and, if that is still on the edge, once more at
    // half of it. Two attempts at most — beyond that the mesh really has a bad face, and a FAIL is honest.
    const failing = results.filter((item) => item.verdict === 'FAIL')
    const onlyVolume = failing.length > 0 && failing.every((item) => item.failKind === 'minVol-threshold')
    const advice = failing
      .map((item) => (Number.isFinite(item.minVolSuggestion) && item.minVolSuggestion > 0
        ? item.minVolSuggestion
        : (Number(item.metrics?.minVolume) > 0 ? Number(item.metrics.minVolume) / 12 : NaN)))
      .filter((value) => Number.isFinite(value) && value > 0 && value < derived.minVol)
    if (onlyVolume && advice.length === failing.length) {
      const attempts = [Math.min(...advice), Math.min(...advice) / 2]
      for (let attempt = 0; attempt < attempts.length; attempt += 1) {
        const retry = coreGateCase({
          config,
          caseDir,
          regions: options.regions,
          profile: options.profile ?? config.gate?.profile,
          minVol: attempts[attempt],
          engine: options.engine,
          script: options.script,
          writeFields: options.writeFields ?? null,
          timeoutMs: config.timeoutMs,
          maxOutputChars: config.maxOutputChars,
          openfoamBashrc: config.openfoamBashrc,
        })
        tightened = attempts[attempt]
        usedMeasured = true
        result.verdict = retry.verdict
        result.pass = retry.pass
        result.failingRegions = retry.failingRegions
        result.targets = retry.targets
        results.length = 0
        for (const target of retry.targets) {
          results.push({
            region: target.region,
            pass: target.pass,
            verdict: target.verdict,
            profile: target.profile,
            engine: target.engine,
            failKind: target.failKind ?? null,
            minVol: target.minVol ?? null,
            minVolSource: 'derived-then-measured',
            minVolDerivation: derived.note,
            minVolSuggestion: target.suggestion?.minVol ?? null,
            thresholds: target.thresholds ?? null,
            metrics: target.metrics ?? null,
            layers: target.layers ?? null,
            advisory: target.advisory ?? [],
            log: target.log ? displayPath(config, target.log) : null,
            writeFields: target.writeFields ?? null,
            writtenFields: target.writtenFields ?? [],
            stderrTail: target.stderrTail ?? '',
            error: target.error,
            hint: target.hint,
          })
        }
        layerOutcome = applyLayerCoverage(results) ?? layerOutcome
        if (retry.verdict === 'PASS') break
        const stillVolume = results.filter((item) => item.verdict === 'FAIL')
        if (!stillVolume.length || !stillVolume.every((item) => item.failKind === 'minVol-threshold')) break
      }
    }
  }
  if (derived && !tightened) {
    for (const item of results) {
      if (item.minVolSource && item.minVolSource !== 'disabled-minVol-not-configured') {
        item.minVolSource = `derived-${derived.source}`
        item.minVolDerivation = derived.note
      }
    }
  }
  const advisory = [...new Set([
    ...(layerOutcome?.status === 'below' ? [`${layerOutcome.message}; minLayerCoverage comes from the gate profile.`] : []),
    ...(derived
      ? [tightened
        ? `minVol derived from the case (${derived.note}) flagged healthy boundary cells; the check was re-run at the measured `
          + `${tightened.toPrecision(3)} (smallest face-pyramid volume / 12) and the verdict comes from that run.`
        : `minVol ${derived.minVol.toPrecision(3)} derived from the case (${derived.note}); pass minVol to override.`]
      : []),
    ...results.flatMap((item) => item.advisory),
  ])]
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
