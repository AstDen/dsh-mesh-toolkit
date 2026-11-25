/**
 * mesh-build/lib/deliver.js — package a gated case into the two distributions
 * (OpenFOAM case + archives, ANSYS/Fluent .msh) via tools/deliver/make_delivery.sh.
 *
 * The script does the real work and re-verifies everything by running it:
 * checkMesh inside the packaged case, interface adjacency for CHT, .msh round-trip,
 * the strict quality gate and archive integrity. This module only guards the input
 * (fresh mesh passport), builds the command line and reduces the JSON report.
 * @module mesh-build/lib/deliver
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { displayPath, q, resolveProjectPath, runBash, tail } from './common.js'
import { passportFreshness, readMeshPassport } from '../../sim-core/lib/passport.js'

export const DELIVER_SCRIPT = 'tools/deliver/make_delivery.sh'
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Pick the last JSON object printed by the script (stdout also carries `[deliver]` lines). */
function lastJsonLine(stdout) {
  const lines = String(stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'))
  if (!lines.length) return null
  try {
    return JSON.parse(lines[lines.length - 1])
  } catch {
    return null
  }
}

/**
 * Passport precondition: a delivery is only meaningful for the mesh that was gated.
 * Missing passport needs an explicit `force`; a stale one (polyMesh changed after the
 * gate) is treated the same way.
 */
export function deliveryGuard(caseDir, { force = false } = {}) {
  const passport = readMeshPassport(caseDir)
  if (!passport) {
    if (force) {
      return {
        ok: true,
        passport: null,
        freshness: null,
        warnings: ['passport-missing-forced: кейс не проверялся mesh_check в этой сессии'],
        recordedVerdict: null,
      }
    }
    return {
      ok: false,
      error: 'passport-missing',
      message: 'нет mesh-passport.json: сначала прогоните mesh_check по этому кейсу, '
        + 'либо передайте force:true, если паспорт недоступен для старого кейса',
    }
  }
  const freshness = passportFreshness(caseDir, passport)
  const recorded = passport.gate?.verdict ?? null
  if (recorded !== 'PASS' && !force) {
    return {
      ok: false,
      error: 'passport-not-pass',
      message: `паспорт записан с вердиктом ${recorded ?? 'нет'}: поставка возможна только после PASS `
        + '(перепрогоните mesh_check с подходящим minVol) или с force:true',
      status: freshness.status,
      changed: freshness.changed,
      recordedVerdict: recorded,
    }
  }
  if (!freshness.fresh && !force) {
    return {
      ok: false,
      error: 'passport-stale',
      message: `сетка изменилась после гейта (${freshness.changed.join('; ')}): `
        + 'перепрогоните mesh_check или передайте force:true',
      status: freshness.status,
      changed: freshness.changed,
      recordedVerdict: recorded,
    }
  }
  return {
    ok: true,
    passport,
    freshness,
    warnings: freshness.fresh ? [] : [`passport-stale-forced: ${freshness.changed.join('; ')}`],
    recordedVerdict: recorded,
  }
}

/** Resolve every input of the delivery and return the plan (no side effects). */
export function planDelivery(config, args) {
  if (!args.caseDir) throw new Error('caseDir is required, e.g. "experiments/exp-NNN/case"')
  const caseDir = resolveProjectPath(config, String(args.caseDir))
  if (!existsSync(caseDir)) throw new Error(`нет каталога кейса: ${displayPath(config, caseDir)}`)
  if (!existsSync(join(caseDir, 'constant'))) {
    throw new Error(`в кейсе нет constant/: ${displayPath(config, caseDir)}`)
  }

  const name = String(args.name ?? basename(caseDir))
  if (!NAME_RE.test(name)) throw new Error(`name должен быть безопасным именем файла (${NAME_RE}), получено "${name}"`)

  const outDir = args.outDir
    ? resolveProjectPath(config, String(args.outDir))
    : join(caseDir, 'deliver')

  const script = join(config.projectRoot, DELIVER_SCRIPT)
  if (!existsSync(script)) throw new Error(`нет ${DELIVER_SCRIPT} в ${displayPath(config, config.projectRoot)}`)

  const gateProfile = String(args.gateProfile ?? args.profile ?? config.gate?.profile ?? 'project')
  if (!['project', 'gate', 'relaxed', 'none'].includes(gateProfile)) {
    throw new Error(`gateProfile должен быть project|gate|relaxed|none, получено "${gateProfile}"`)
  }

  const minVol = args.minVol ?? config.gate?.minVol
  const argv = ['bash', q(script), '--case', q(caseDir), '--name', q(name), '--out', q(outDir), '--gate-profile', q(gateProfile)]
  if (minVol !== undefined && minVol !== null && gateProfile !== 'none') argv.push('--gate-min-vol', q(String(minVol)))
  if (config.openfoamBashrc && existsSync(config.openfoamBashrc)) argv.push('--foam-bashrc', q(config.openfoamBashrc))
  if (Array.isArray(args.regions) && args.regions.length) argv.push('--regions', q(args.regions.map(String).join(',')))
  if (args.multiRegion === true) argv.push('--multi-region')
  if (args.noCombinedMesh === true) argv.push('--no-combined-mesh')
  if (args.keepScratch === true) argv.push('--keep-scratch')
  if (args.skipAnsys === true) argv.push('--skip-ansys')

  const warnings = []
  if (gateProfile !== 'none' && (minVol === undefined || minVol === null)) {
    warnings.push('minVol не задан: скрипт использует свой порог 1e-14; для поровых ячеек передайте minVol явно')
  }
  return {
    caseDir, name, outDir, script, gateProfile,
    minVol: minVol ?? null,
    command: argv.join(' '),
    warnings,
  }
}

/** Reduce the script report (single- or multi-region) to a compact tool payload. */
export function summarizeDelivery(report, plan, config) {
  if (!report) return null
  const base = {
    name: report.name ?? plan.name,
    mode: report.mode ?? null,
    sourceCase: report.source_case ? displayPath(config, report.source_case) : displayPath(config, plan.caseDir),
    outDir: displayPath(config, plan.outDir),
    deliverables: report.deliverables ?? null,
    qualityGate: report.quality_gate ?? null,
    sizesMb: report.sizes_mb ?? null,
  }
  if (report.mode === 'multi_region') {
    const regions = report.regions ?? {}
    return {
      ...base,
      cells: report.regions_total_cells ?? null,
      regions: Object.fromEntries(Object.entries(regions).map(([r, v]) => [r, {
        cells: v.cells ?? null,
        patches: v.boundary_patches ?? null,
        volumeM3: v.total_volume_m3 ?? null,
        maxNonOrtho: v.max_nonortho_deg ?? null,
        checkMeshRc: v.checkmesh_rc ?? null,
        gateRc: v.quality_gate?.rc ?? null,
        roundtrip: v.ansys_roundtrip?.status ?? null,
      }])),
      interfaceOk: report.interface_ok ?? null,
      unpairedPatches: report.unpaired_patches ?? [],
      combined: report.combined_mesh ? {
        sumRegionsM3: report.combined_mesh.sum_regions_m3 ?? null,
        volumeM3: report.combined_mesh.total_volume_m3 ?? null,
        relDiff: report.combined_mesh.rel_diff ?? null,
        match: report.combined_mesh.match ?? null,
      } : null,
    }
  }
  const mesh = report.mesh ?? {}
  return {
    ...base,
    cells: mesh.cells ?? null,
    patches: mesh.boundary_patches ?? null,
    volumeM3: mesh.total_volume_m3 ?? null,
    maxNonOrtho: mesh.max_nonortho_deg ?? null,
    checkMeshRc: mesh.checkmesh_rc ?? null,
    roundtrip: report.ansys_roundtrip ?? null,
  }
}

/**
 * Run the delivery. Returns `{ ok, rc, plan, report, payload, stdoutTail, stderrTail }`;
 * `ok` means rc=0, i.e. the script's own checks all agreed.
 */
export function runDelivery(config, args) {
  const plan = planDelivery(config, args)
  const guard = deliveryGuard(plan.caseDir, { force: args.force === true })
  if (!guard.ok) return { ok: false, guard, plan, error: guard.error, message: guard.message }

  if (args.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      plan,
      guard,
      warnings: [...(guard.warnings ?? []), ...plan.warnings],
      stdoutTail: '',
      stderrTail: '',
    }
  }
  const started = Date.now()
  const run = runBash(plan.command, {
    cwd: config.projectRoot,
    timeoutMs: config.timeoutMs,
    openfoamBashrc: config.openfoamBashrc,
    maxBuffer: 128 * 1024 * 1024,
  })
  const durationMs = Date.now() - started
  const reportFile = join(plan.outDir, `delivery_${plan.name}.json`)
  let report = null
  if (existsSync(reportFile)) {
    try {
      report = JSON.parse(readFileSync(reportFile, 'utf8'))
    } catch {
      report = null
    }
  }
  if (!report) report = lastJsonLine(run.stdout)

  const ok = run.code === 0
  return {
    ok,
    rc: run.code,
    timedOut: run.timedOut === true,
    durationMs,
    plan,
    guard,
    report,
    payload: summarizeDelivery(report, plan, config),
    warnings: [...(guard.warnings ?? []), ...plan.warnings],
    stdoutTail: ok ? '' : tail(run.stdout ?? '', 4000),
    stderrTail: ok ? '' : tail(run.stderr ?? '', 4000),
  }
}
