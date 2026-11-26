# Changelog

## 0.6.1 — 2026-11-26

- **plan A2 (workbench contract)**: new tool `mesh_patch_types` assigns contract roles
  (inlet/outlet/wall/symmetry/empty/interface) to existing patches by retyping
  `constant/<region>/polyMesh/boundary` — a `.bak` backup, a before/after diff, and only the `type` line is
  rewritten (`nFaces`/`startFace`/`inGroups` untouched). It never splits faces: a single patch cannot become
  inlet+outlet without a face set (`topoSet` + `createPatch`), and the refusal says so.
- Refusals instead of guesses: an unknown patch name lists the available `name (type)`; one patch in two
  roles; `empty`/`cyclic`/`cyclicAMI` cannot become a flow boundary without rebuilding the mesh; `cyclic`/
  `wedge` need a neighbour patch or wedge geometry; a multi-region case must name `region`.
- Roles that the boundary file cannot express are kept in `handoff.json`: after retyping, inlet and outlet are
  both type `patch`, so the document carries the semantic assignment (and `mesh_check` carries it forward).
- `recheck:true` re-runs the gate and reports `sameAsRecorded` with the earlier cells/non-ortho/minVolume —
  patch types change what a solver sees, not the mesh metrics.
- Role keys accept the contract's plural forms (`walls`, `symmetries`, `interfaces`), so `next[]` args from
  `handoff.json` can be passed verbatim.
- New knowledge card `patch-roles` (hint id), and the bundled skill lists the tool.

## 0.6.0 — 2026-11-26

- **plan A1 (workbench contract)**: `mesh_check` and `mesh_deliver` now write `handoff.json`
  (`mesh-handoff/1`) into the case. The document carries only facts read from the case: `units.scale` from
  `snappyHexMeshDict geometry { scale }` (falling back to `blockMeshDict scale`/`convertToMeters`), domain
  bbox from `constant/polyMesh/points`, background cells and surface levels from the dictionaries, quality
  from the gate that just ran, every boundary patch with a contract `role`, the STL sha256, and `next[]`
  with the patch-retyping step while inlet/outlet are missing.
- `mesh_deliver` copies the handoff into the packaged `openfoam_<name>/` case (with `files.delivery` and a
  `history[]` event), so a solver-side workbench can read it without our tools.
- New `meshToolkit` service (`apiVersion: 1`, `plugins/sim-core/lib/toolkit.js`): registers `mesh`, `gate`,
  `deliver`, `hints`; the consumer resolves it at call time via `ctx.get('meshToolkit')`. Absent methods
  (`revise`, `patchTypes`) answer with a structured `{ok:false, error:'not-provided', hint}` instead of throwing.
- `simMesh` capability service also exposes `deliver`.

## 0.5.4 — 2026-11-26

- `files` now includes `docs/`: the `docs/PORTABLE.md` referenced by the README makes it into `npm pack`
  (previously the tarball shipped without it).
- `scripts/smoke.mjs` also passes without `sim-project.json`: in portable mode it checks the defaults
  (`project: "defaults"`, `caseRoot: "cases"`, gate profile `project`) instead of the "project not detected" failure.
- `engines.dsh` and the `@deepseek-ai/dsh-*` peer ranges are aligned to `>=0.2.2-rc.1 <0.3.0`
  (installed DSH 0.2.2-rc.5, the workbench declares the same minimum).
- Filled in the `repository` field (`git+https://github.com/AstDen/dsh-mesh-toolkit`, `directory: mesh-build`).
- CI: `.github/workflows/ci.yml` (node 20/24, syntax, card catalog, versions, smoke, QA parity,
  tarball completeness) and `.github/workflows/release.yml` on a tag — see `docs/PACKAGING.md`.

## 0.5.3 — 2026-11-26

### Added
- **Portable mode (plan 1.4).** `mesh_build`/`mesh_check`/`mesh_deliver` work without
  `sim-project.json`: the response carries `project: "defaults"` and `configured: false`, cases default to
  `./cases`, gate `project`. The `requireProject` gate no longer blocks calls.
- Bundled delivery: if the project has no `tools/deliver/make_delivery.sh`, `mesh_deliver` takes
  `scripts/deliver/make_delivery.sh` from the bundle (together with `scripts/qa/mesh_gate.sh` and
  `scripts/deliver/region_layout.py`). The delivery gate writes an overlay into `<outDir>/.gate`
  via `MESH_GATE_CACHE_DIR`.
- Knowledge card `portable-mesh-build`; the `docs/PORTABLE.md` document with the end-to-end scenario.

### Verified
- End-to-end run in an empty `/tmp` directory: primitive (12 tri) → `stl_check` PASS →
  `mesh_build` snappy 2584 cells → `mesh_check` gate PASS → `mesh_deliver` DELIVERED
  (`scriptOrigin` = package, 1.8 MB of artefacts).

## 0.5.2 — 2026-11-26

- **`scripts/fluid-point.py` in the package** — picking `locationInMesh` from an STL no longer requires the
  research project's `benchmark/scripts/` tree. The script is the same (bucket index, exact distance and
  side along one face, `--max-seconds` budget); `benchmark/scripts/fluid_point.py` remains a shim.
- `caseRoot` defaults to `cases` (without a profile — relative to the current directory), `next:` messages
  point to the packaged script.

## 0.5.1 — 2026-11-26

Fixes from the end-to-end benchmark `benchmark/runs/20261125-1805` (61 cases, 18 defects;
re-check — `experiments/_scratch/verify-fixes.mjs`, 15/15 PASS).

- **Guards instead of a silently wrong mesh** (`lib/precheck.js`, a new module):
  an STL shell outside the domain (binary and ASCII STL), a background-mesh budget
  (`maxCells`, 5e6 by default), cfMesh refusing on a unit mismatch
  (`surfaceTransformPoints -scale`), a sanity check "the mesh has no `world` patch" ⇒ `locationInMesh`
  landed inside a solid body.
- **`refinementLevels`**: a level pair `[min, max]` now passes into `snappyHexMeshDict`
  as `level (min max)` (DEF-12: the scalar API could not reproduce the project reference),
  an unknown key throws an error with the surface list (DEF-13).
- **`system/meshQualityDict` is written from the gate profile thresholds** (`maxNonOrtho`, `minVolRatio`,
  `minTwist`): snappy optimises against exactly the numbers the gate judges it by
  (exp-022: `minTwist -1` left twisted faces that the gate then rejected).
- **Gate**: minimal `fvSchemes`/`fvSolution` are synthesised into the overlay if the case has none
  (DEF-04: `mesh_build` on a cfMesh case returned `gate.verdict ERROR` with empty metrics),
  with an advisory "write the real ones before running the solver".
- **`mesh_check`**: passport freshness is evaluated BEFORE it is overwritten (DEF-09: `passport-stale`
  after editing `polyMesh/points` is no longer masked), the passport is stamped with the on-disk version.
- **Version in tool responses**: a `version {reported, onDisk, stale}` block + a "restart DSH" warning
  if the process loaded an old version (DEF-08).
- **Knowledge cards**: `mesh_hints` also registers the `mesh-stl` catalog — a single catalog of 33 cards
  (DEF-15/DEF-16: `openfoam-versions` was not found for org14/cfMesh queries).


## 0.5.0 — 2026-11-25

Cross-version OpenFOAM compatibility (com v2412…v2606, org v14):

- `sim-project.json → foam.installations` + `foam.default`; the tools accept `openfoam: "<id>|<bashrc>"`,
  by default — from the profile. The passport writes `environment {id, distribution, version, bashrc}`.
- `routes.js`: `probeInstallation` (cached by bashrc) — availability of every tool of the route, `mergeTol`,
  `surfaceFeatures`; `preflight` refuses before the run with a hint about where the tool exists.
- snappy route: `surfaceFeatureExtract` on com, `surfaceFeatures` on org; `-mergeTol` only where it exists.
- scaffold: an explicit `file "<name>.stl"` in geometry (an org14 requirement), `system/surfaceFeaturesDict`,
  `locationInMesh` for a single region instead of `locationsInMesh`.
- Verified (exp-019): a 10 mm cube on com2512 / com2606 / org14 — 2584 cells, PASS; org14 gives 25.21° versus 9.71°.
  `gmshToFoam` on com2512 and org14 — OK.

## 0.4.0 — 2026-11-25
New tool `mesh_deliver` — mesh delivery in two distributions.

- A wrapper around `tools/deliver/make_delivery.sh`: an openable OpenFOAM case with a real `constant/`
  and a `.foam` marker, `.tar.gz`, Fluent `.msh` + `read_mesh.jou` + `.zip`, a `delivery_<name>.{json,md}`
  report with checks (round-trip, CHT interface, volumes, gate, archives).
- Precondition — a fresh `mesh-passport.json` (`passport-missing` / `passport-stale`), `force:true`
  lifts the restriction, but the delivery gate still runs.
- `dryRun`, `gateProfile`, `minVol`, `regions`, `multiRegion`, `noCombinedMesh`, `skipAnsys`,
  `keepScratch`; automatic multi-region detection.
- `mesh_check` now writes `mesh-passport.json` with a PASS/FAIL verdict (it does not change the mesh) — the passport
  is the entry point to delivery; `passport-not-pass` blocks packing.
- Verified: v13_best (CHT, 575 757 cells, interface ok, both regions PASS, round-trip ok, 66.6 s)
  and FCC single-region (27 424 cells, 3.5 s); live guard checks: missing → force → stale → not-pass.

## 0.3.0 — 2026-11-25
The quality gate moved into `sim-core`, passports and the case manifest appeared.

- **The JS gate is authoritative:** `sim-core/lib/gate.js` writes a complete `meshQualityDict` (all 13 keys),
  makes an overlay `<case>/.mesh-gate/<target>`, runs `checkMesh -meshQuality` and issues the verdict
  **from the text** — `checkMesh` returns 0 even on `Failed N mesh checks`.
- **`minVol` is absolute and deliberate:** not set by the profile/call → `-1` is written into the dictionary
  (the check is disabled) and the result is flagged `disabled-minVol-not-configured`; on failure
  the suggestion `minVol = minVolume/12` is given. `minTetQuality = minVol/100`.
- **Profiles from the project profile:** the `gate`/`project`/`relaxed` thresholds can be overridden in
  `sim-project.json.gate.profiles`, while `gate.engine:"script"` + `gate.script` are left as an escape hatch
  to a bash script (parity with `tools/qa/mesh_gate.sh`).
- **Passport and manifest:** `case-manifest.json` is written after scaffold, `mesh-passport.json` after the gate
  (route, cells, regions, gate, sha256/size/mtime of the polyMesh). `mesh_check` shows passport freshness
  and any divergence between the recorded verdict and the current one.
- **`simMesh` service:** `build`/`check`/`hints` for the other plugins of the family.
- **Logs:** `checkMesh` writes `<case>/logs/checkMesh-<target>.log`; the overlay does not land in the project's `.cache`.

## 0.2.0 — 2026-11-23
Fixes from the benchmark `benchmark/verify-20261123-1851` (the score was 33/100, meshing was
blocked).

- **Blocker removed:** `mesh_build` failed on any `scaffold:true` with `STL not found: .../[object Object]`.
  `expandStlInputs()` returns `{files, missing}`, while `scaffold.js` expected an array. Now `index.js`
  parses the object, returns a structural error with the list of missing files, and `writeSnappyCase()`
  additionally accepts `{files:[...]}`.
- **Dry run became a real preflight:** `dryRun` runs `preflight()`, renders the commands through
  `renderCommand()` (the `unresolved` field), returns `problems`/`requires` and creates no directories.
  `cfmesh` without `system/meshDict` now says `missing system/meshDict (cfMesh dictionary)`.
- **`caseDir` input check:** `resolveCase({mustExist})` — the error `case directory not found: <path> — <reason>`
  before the run; `mesh_check` hints that a built case is required.
- **Case-local point in metres:** `scaffoldOptions.locationInMesh` accepts both `[x,y,z]`
  and `[{point:[x,y,z], name}]` (as the tool description promises).
- **Patches in the response:** a new `lib/patches.js` — `mesh_build` and `mesh_check` return `patches`
  (`{name, type, nFaces}` per region) and `notes`: a single type for all patches, `symmetry` (retype
  after meshing), absence of `patch`/`cyclic`.
- **Gate diagnostics:** the result carries `failKind`, `minVolSuggestion` and `advisory`. If only the
  absolute `minVol` is violated, the gate explains that the threshold does not scale with the mesh and gives a working
  value (`V_min/12`); if `face twist` is to blame — that these are slivers on gaps smaller than a cell.
- **Neighbouring plugin's cards:** `mesh_hints` sees the `mesh-stl` plugin's `data/hints` (hit@3 = 5/5).
- **Version checked against disk:** `versionInfo()` → `{reported, onDisk, stale}`.
- Smoke tests extended with regressions for every item listed above.

## 0.1.1 — 2026-11-23
- Portability: machine absolute paths removed from the README/examples; the Fluent licence server in the card replaced with a placeholder.
- The OpenFOAM environment is configurable: `openfoamRoots` / `MESH_BUILD_OPENFOAM_ROOTS` (the standard directories are the default).
- The gate overlay is resolved from `workRoot` rather than a hard-coded `/.cache/mesh-build/` path (works with a custom workRoot).
- Cards refined: `cfmesh-layers-tetra` (why 3D layers are not built in gmsh 4.15.2), `cfmesh-cartesian` (cfMesh as part of OpenFOAM), `units-mm` (three places with units).
- All numeric claims in the cards verified against `journal/` and `experiments/` (no discrepancies found).

## 0.1.0 — 2026-11-23
- First version: three tools, JSON data (knowledge cards + family/route registry).
- Assembled from the project journal `experiments/exp-000…exp-018` and ADRs `D-001…D-019`.
- Smoke tests without DSH (`scripts/smoke.mjs`).
