# Changelog — sim-core

## 1.1.1 — 2026-11-27

- `parseCheckMesh` returns `layersFaces` from `Extruding N out of M faces (P%)`, and new `parseLayerFaces(text)`
  reads that line out of a snappyHexMesh log — `checkMesh` only prints the cell form (`Added … cells`), so face
  coverage needs both.
- `layerCoverageCheck({layersFaces, required})`: `disabled` / `no-faces` / `ok` / `below` with the exact message
  `layer coverage 10% < 80% (Extruding 100 out of 1000 faces)`. `gateTarget` turns `below` into `FAIL` with
  `failKind: 'layers'` and returns `layers {faces, cells, required, status}` — `minLayerCoverage` lived in every
  profile and decided nothing (D-10).
- `buildOverlay(...)` unchanged; no metric changed, so existing passports stay comparable.

## 1.1.0 — 2026-11-26

- `checkMesh -writeFields` in the JS gate: `runCheckMesh({writeFields})` adds the flag, and
  `collectWrittenFields`/`fieldStats` read the field back from the overlay (uniform or
  `nonuniform List<scalar>`: count/min/max/avg). `gateTarget` returns `writeFields` + `writtenFields`.
- `buildOverlay(caseDir, region, {copyZero})`: with `writeFields`, `0/` is copied instead of linked — otherwise
  the written field landed in the real case. Found by running `mesh_check writeFields='(nonOrthoAngle)'` on a
  tutorial case and inspecting where the field appeared.

## 1.0.1 — 2026-11-26

Fix: enabling both bundles in one DSH profile failed to load the second one —
`service "meshToolkit" has been registered at <mesh-stl>`. `sim-core/lib/toolkit.js` now keeps one service
per application root and treats `ctx.provide` as best-effort: the second bundle reuses the registered object
(and its methods land in the same map) instead of registering a duplicate. Found by installing the published
1.0.0 bundle through the plugin details route; the unit and contract suites never covered a double `apply`.

## 1.0.0 — 2026-11-26

First stable release of the shared library: layered config with `sim-project.json` discovery and portable-mode
defaults, the JS quality gate with a full `meshQualityDict` overlay, the mesh passport and freshness check,
`handoff.json` (`mesh-handoff/1`), the `meshToolkit` service shim, and intent-first hint ranking. Versioned
together with `mesh-build` and `mesh-stl` from 1.0.0-rc.1 on.

## 1.0.0-rc.3 — 2026-11-26

No functional change: the version moves with the toolkit so the three packages stay aligned.

## 1.0.0-rc.2 — 2026-11-26

No functional change: the version moves with the toolkit so the three packages stay aligned.

## 1.0.0-rc.1 — 2026-11-26

Version aligned with the toolkit 1.0 release candidate (the three packages are versioned together from here on).
Functional content is 0.5.1: `handoff.json` (`mesh-handoff/1`) with units, roles and suggested calls, the
`meshToolkit` service shim, the JS quality gate with `ensureGateDicts` overlays, intent-first hint ranking
with deduplicated file counts, and portable mode defaults.
No behaviour change relative to 0.5.1.

## 0.5.1 — 2026-11-26

- `hints.js`: `registerDir` counts each hint file once, so a long-lived DSH process that re-registers the same
  directories on every plugin reload no longer inflates `mesh_hints().hintFiles` (observed 59 instead of 11).
- `hints.js`: ranking prefers the card whose **id** names the query term (`minvol-absolute` for `minVol layers`),
  adds a coverage bonus for cards matching several distinct query terms in title/id/topics, and breaks ties by
  the first two query tokens. `cone pipe parts` now returns `primitive-parts` first; `org14 cfmesh version`
  still returns `openfoam-versions`.
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
