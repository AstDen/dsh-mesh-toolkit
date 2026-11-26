# Changelog — sim-core

## 0.5.0 — 2026-11-26

- **`lib/handoff.js` — `mesh-handoff/1`** (plan A1, docs/WORKBENCH-CONTRACT.md §3.2): `buildHandoff`,
  `writeHandoff`, `readHandoff`, `validateHandoff`, plus the readers the document is built from —
  `scaleFromBlockMeshDict` (snappy `geometry.scale` first, then `blockMeshDict`), `domainFromCase`
  (bbox from `constant/polyMesh/points`, `hex` cells, `refinementSurfaces` levels, `locationInMesh`),
  `stlProvenance` (sha256/bytes), `qualityFromGate`, `patchRole`/`roleSummary`.
- **`lib/toolkit.js` — `meshToolkit` service, apiVersion 1**: `ensureToolkit(ctx)`, lazy per-method
  registration by whichever package is installed, `capabilities()`/`providers()`, typed shims
  (`generate`, `mesh`, `revise`, `patchTypes`, `gate`, `deliver`) and `missingToolkitPayload` for
  consumers that cannot resolve the service. Methods return the tool payload; absent ones return
  `{ok:false, error:'not-provided', available, hint}`.

## 0.4.4 — 2026-11-26

- The default quality profile in the no-`sim-project.json` mode is `project` (60° / skew 2 / boundary 4),
  as `docs/PORTABLE.md` and the `portable-mesh-build` card promise; previously `gate` (65°) was taken silently.
  An explicit `gate.profile` in the profile still takes priority.
- Added `engines.dsh: ">=0.2.2-rc.1 <0.3.0"` (the core also checks compatibility with the runtime).
- Filled in the `repository` field (`directory: sim-core`); the version participates in `scripts/check-versions.mjs`
  (package.json == CHANGELOG == README banner).

## 0.4.3 — 2026-11-26

### Added
- `resolveConfig` returns the `project` label: the project name from the profile, or `"defaults"` in
  case-local mode (plan 1.4, portability). Plugins show it in tool responses.

## 0.4.2 — 2026-11-26

- **`project.js`: case-local default `caseRoots: ["./cases"]`** (was `['experiments','cases']`).
  The profile still overrides the roots; the point is that in a bare directory without `sim-project.json` cases
  live in `./cases`, not in the research `experiments/` (plan 1.3).

## 0.4.1 — 2026-11-26

- **`lib/gate.js`: `ensureGateDicts(overlay)`** — if the case has no `system/fvSchemes` or
  `system/fvSolution`, minimal copies are written into the overlay (mesh metrics do not depend on them);
  the gate result receives a `synthesized` field and an advisory. Previously `checkMesh -meshQuality`
  failed with `cannot find file …/system/fvSchemes`, and the gate returned `ERROR` with empty metrics
  (benchmark: a cfMesh case without solver dictionaries, DEF-04).

## 0.4.0 — 2026-11-25

- `lib/foam.js`: the OpenFOAM installation registry (`normalizeInstallations`, `resolveFoam`, `withFoam`):
  selection by id from the profile or by an absolute path to `etc/bashrc`, an error listing the available ones.
- `lib/config.js`: `foamInstallations`, `foamDefault`, `foamSelected`, `openfoamBashrcExists`;
  the default bashrc is taken from the profile, then from the conventional directories.
- `lib/passport.js`: the optional `environment {id, distribution, version, bashrc}` field.

## 0.3.0 — 2026-11-25

- First release: the `sim-project.json` profile, paths with `resolvedFrom`, the JS gate (`checkMesh` + profiles),
  the mesh passport and case manifest, `simHints`, `simGeometry`/`simMesh`, shared utilities and processes.
