# WORKBENCH-CONTRACT — dsh-mesh-toolkit ↔ dsh-openfoam-workbench

> Analysis, comparison with the current implementation and a per-object work plan — in
> [`PLAN-workbench-integration.md`](PLAN-workbench-integration.md).

Normative document for two-way integration. Contract version: **1** (`mesh-handoff/1`,
`mesh-request/1`, `mesh-feedback/1`). Both sides implement it independently; neither is obliged to
install the other.

- Author of the contract and owner of the "geometry/mesh" side: **dsh-mesh-toolkit** (`mesh-stl`, `mesh-build`, `sim-core`).
- Owner of the "physics/solver" side: **dsh-openfoam-workbench**.
- Principle: **the file comes first, the service is an accelerator**. Any handoff is reproducible through `handoff.json`
  on disk; the Cordis service removes the need for manual tool calls, but is not mandatory.

---

## 1. Roles and boundaries

| Area | mesh-toolkit | openfoam-workbench |
|---|---|---|
| Parametric geometry (porous, packings, channels, TPMS) | **owner** | — |
| Simple primitives (box/sphere/cylinder/cone/pipe, parts[]) | owner after A5 | duplicates as fallback |
| STL contract (watertight, normals, mm), cleanup, registry | **owner** | only reads the verdict |
| Volume mesh (snappy/cfMesh/gmsh), layers, CHT regions | **owner** | snappy fallback if the toolkit is not installed |
| Quality gate (absolute thresholds, profiles, passport) | **owner** | does not override the verdict |
| Patch types and roles (inlet/outlet/wall/symmetry/interface) | **owner** (`mesh_patch_types`) | may override explicitly and record it in the report |
| Delivery (OF case + ANSYS `.msh` + report) | **owner** | reads `handoff.json`, packages nothing |
| Solver dictionaries (`0/`, `fvSchemes`, `fvSolution`, `constant/*`) | **does not write** | **owner** |
| Solver launch, convergence, y+ from the computation results | **does not launch** | **owner** |
| Diagnosis "the mesh is at fault / the physics is at fault" | accepts `mesh-feedback` | **owner** of the diagnosis |

Hard prohibitions:

1. mesh-toolkit **never** writes to `0/`, `fvSchemes`, `fvSolution`, `constant/*` (except `polyMesh`,
   `triSurface`, `extendedFeatureEdgeMesh`) and does not launch the solver.
2. workbench **never** edits `constant/polyMesh/*` and does not change `polyMesh/boundary` silently:
   any retyping — either through `mesh_patch_types`, or `openfoam_dict_set` with a record in the report
   (`handoff.patches[].retypedBy = "openfoam-workbench"`).
3. Neither side imports the other's internal modules; the only connection points are
   `handoff.json`, the JSON schemas from §3 and (optionally) the service from §5.

---

## 2. Workflow (target scenario)

```
user → workbench: computation task (physics, BC, targets)
workbench:      MeshRequest  ─────────────►  mesh-toolkit: geometry → mesh → gate → deliver
                                                 │
workbench:      reads handoff.json  ◄────────────┘   (the case already contains polyMesh + typed patches)
workbench:      openfoam_case_scaffold on the delivered case → openfoam_check → a short run
workbench:      diagnosis: y+, non-ortho, patch roles, resolution, domain, units
workbench:      MeshFeedback  ────────────►  mesh-toolkit: mesh_revise (deterministic revision table)
                                                 │
                up to N attempts (3 by default, 8 maximum) → a new handoff.json
                │
                └─► workbench retries the computation; when the attempts are exhausted — escalation to the user
                    with options (coarser/finer/another route/another domain)
```

Loop invariants: every request has a `requestId`; every revision increments `attempt`;
`handoff.history[]` accumulates what changed and why; a repeated call with the same inputs must not
change the result (determinism of the parameters; `seed` is fixed in `geometry.spec`).

---

## 3. Schemas

All schemas are JSON Schema draft 2020-12, published in `mesh-toolkit/schemas/` and mirrored
in workbench. Fields marked with `*` are mandatory.

### 3.1 `mesh-request/1` (workbench → mesh-toolkit)

```json
{
  "schemaVersion": "mesh-request/1",
  "requestId": "wf-2026-11-26-0001",
  "attempt": 0,
  "intent": "mesh-for-solver",
  "geometry": {
    "kind": "parametric | stl",
    "family": "channel-spheres",
    "preset": "channel_spheres_L3",
    "params": { "gap_mm": 0.05 },
    "stl": "stl/b1/fluid.clean.stl",
    "units": "mm",
    "seed": 11,
    "sha256": "…"
  },
  "domain": {
    "type": "external | internal | box | wrap",
    "margins": { "upstream": 3, "downstream": 5, "lateral": 3, "vertical_top": 3, "vertical_bottom": 3 },
    "sizeFactor": 1.0,
    "bboxMin": [0, 0, 0],
    "bboxMax": [0.02, 0.02, 0.02]
  },
  "sizing": {
    "kind": "cellSize | cells | auto",
    "cellSize_m": 0.0002,
    "cells": [44, 44, 44],
    "targetCells": 700000,
    "maxCells": 5000000,
    "refinement": { "surface": [1, 2], "feature": 2, "interfaces": 2 }
  },
  "layers": {
    "mode": "none | yplus | explicit",
    "yPlusTarget": 30,
    "U_ref": 12.5,
    "L_ref": 0.01,
    "nu": 1.5e-5,
    "nLayers": 5,
    "firstLayer_m": 2e-5,
    "expansionRatio": 1.2
  },
  "route": { "preferred": ["snappy", "cfmesh", "gmsh"], "openfoam": "com2512" },
  "gate": { "profile": "project", "minVol": null },
  "regions": [{ "name": "fluid", "kind": "fluid" }, { "name": "solid", "kind": "solid" }],
  "delivery": { "enabled": true, "name": "case-001", "ansys": true },
  "feedback": { "categories": [], "evidence": [] }
}
```

Rules: `geometry.kind=parametric` requires `family`; `stl` is a path relative to the project root
(absolute paths are allowed). `sizing.kind=auto` means "mesh-toolkit chooses from the geometry and `targetCells`"
and must return the chosen values in `handoff.mesh.selection`. `layers.mode=yplus` requires
`U_ref`, `L_ref` and allows `nu` to default to 1.5e-5.

### 3.2 `mesh-handoff/1` (mesh-toolkit → workbench, file `<caseDir>/handoff.json`)

```json
{
  "schemaVersion": "mesh-handoff/1",
  "requestId": "wf-2026-11-26-0001",
  "attempt": 0,
  "producer": {
    "plugin": "mesh-build",
    "version": "0.6.0",
    "openfoam": { "distribution": "com", "version": "v2512", "bashrc": "/usr/lib/openfoam/openfoam2512/etc/bashrc" }
  },
  "units": { "stl": "mm", "case": "m", "scale": 0.001 },
  "geometry": {
    "kind": "parametric",
    "family": "channel-spheres",
    "stl": "constant/triSurface/fluid.stl",
    "sha256": "…",
    "bbox_m": { "min": [-0.001, -0.001, -0.0135], "max": [0.0045, 0.0045, 0.0081] },
    "volume_m3": 1.627e-10,
    "qa": { "verdict": "PASS", "watertight": true, "bodies": 1 }
  },
  "mesh": {
    "route": "snappy",
    "selection": { "cellSize_m": 0.0002, "cells": [18, 18, 72], "levels": { "fluid": 2 }, "defaultLevel": 1 },
    "cells": 202440,
    "points": 242540,
    "faces": 647234,
    "regions": ["fluid"],
    "layers": { "nLayers": 0, "coverage": null }
  },
  "quality": {
    "profile": "project",
    "minVol": 5e-14,
    "verdict": "PASS",
    "maxNonOrtho": 14.6088,
    "avgNonOrtho": 2.40614,
    "maxSkewness": 0.680732,
    "minVolume": 3.222e-13,
    "violations": [],
    "passport": { "path": "mesh-passport.json", "status": "fresh", "createdAt": "…" }
  },
  "patches": [
    { "region": null, "name": "fluid", "type": "wall", "role": "wall", "nFaces": 56560, "area_m2": 1.2e-4 }
  ],
  "domain": { "type": "box", "bbox_m": { "min": […], "max": […] }, "locationInMesh": [0.0017, 0.0017, -0.003] },
  "recommendations": {
    "suggestedFamily": "incompressible",
    "suggestedSolverSetup": { "algorithm": "SIMPLE", "turbulence": "laminar" },
    "yPlus": { "target": null, "firstLayer_m": null },
    "notes": ["patch fluid is walls only: retype inlet/outlet before a flow run (mesh_patch_types)"]
  },
  "files": { "case": ".", "polyMesh": "constant/polyMesh", "handoff": "handoff.json", "delivery": "deliver/delivery_case-001.json" },
  "history": [],
  "next": [
    { "tool": "mesh_patch_types", "args": { "caseDir": ".", "roles": { "inlet": [], "outlet": [], "walls": ["fluid"] } } }
  ]
}
```

Mandatory handoff validity conditions: `quality.verdict == "PASS"` (otherwise workbench must not
launch the computation, but is obliged to call `mesh_revise`); `units.scale` matches the actually written
`scale`/`convertToMeters` in `system/blockMeshDict`; every patch has a `role` from the enumeration
`inlet | outlet | wall | symmetry | cyclic | empty | interface | wedge | unknown`;
`next[]` contains tools ready to be called if anything remained unfinished.

### 3.3 `mesh-feedback/1` (workbench → mesh-toolkit)

```json
{
  "schemaVersion": "mesh-feedback/1",
  "requestId": "wf-2026-11-26-0001",
  "attempt": 1,
  "caseDir": "cases/case-001",
  "category": "yplus | nonortho | skewness | patch-roles | resolution | domain | units | layers | cells-budget | stl-quality",
  "severity": "blocker | major | minor",
  "evidence": {
    "tool": "openfoam_check",
    "log": ["… last 20 lines …"],
    "metrics": { "maxNonOrtho": 68.2, "yPlusMax": 480, "yPlusAvg": 210, "cells": 202440, "runtime_s": 41 }
  },
  "expected": { "yPlusMax": 100, "maxNonOrtho": 60 },
  "changes": { "cellSizeFactor": 0.7, "nLayers": 5, "route": "cfmesh" },
  "note": "free text for a human"
}
```

Deterministic reaction table (mandatory for both sides, extended with data, not with code):

| category | mesh-toolkit action | ceiling |
|---|---|---|
| `yplus` | recompute the layers: `firstLayer = y+·ν/u_τ` (the same correlation as `compute_first_layer`), enable layers | 3 iterations |
| `nonortho` | +1 level on the surface/interface, then reduce `nLayers`, then switch the route snappy→cfmesh | 3 iterations |
| `skewness` | local surface refinement, smaller `resolveFeatureAngle`, more snap iterations | 2 iterations |
| `patch-roles` | `mesh_patch_types` by the role map; repeated gate check | 1 iteration |
| `resolution` | `cellSize × 0.7` (or +1 level), recompute the cell budget | 2 iterations |
| `domain` | domain multipliers +25 % in the specified direction (blockage), rebuild | 1 iteration |
| `units` | require confirmation of the scale, rebuild with an explicit `scale` | 1 iteration |
| `layers` | reduce `nLayers`/`expansionRatio`, enable `minTwist` from the profile | 2 iterations |
| `cells-budget` | coarsen to `maxCells`, on failure — cfmesh | 1 iteration |
| `nonortho`×3 in a row | downgrade the assembly strategy: snappy → cfmesh (instead of repeating the same parameters) | 1 iteration |
| `stl-quality` | `stl_check` + `cleanup`, on failure — return FAIL with the reason | 1 iteration |

Every revision returns `changes[]` (what actually changed) and a new `handoff.json`;
`history[]` is appended with a record `{attempt, category, changes, verdict}`.

### 3.4 Escalation

After `attempt >= maxAttempts` mesh-toolkit returns `{ok:false, escalated:true, options:[…]}`,
where `options` are 2–4 mutually exclusive variants with a cost (cells/time) and the expected effect.
workbench shows them to the user through `ask_user_question`; the choice is fixed in
`requestId` (a new attempt).

---

## 4. Units and scale

1. STL — **always mm**; OpenFOAM case — **always metres**; `scale 0.001` (com: `convertToMeters`).
2. `handoff.units.scale` is the actually written value; workbench must compare it with
   `system/blockMeshDict` and fail with a clear error on a mismatch.
3. Unit suspicion: if the maximum STL extent > `scaleAskAbove` (default 0.1 m
   converted to mm — 100 mm) or `< 1e-5`, the tool **asks** (mm/m) instead of continuing
   silently. This rule is taken from workbench (`scaleAskAbove`, `needs_input`) and is mandatory for both sides.
4. `locationInMesh` is in metres; handoff stores it in metres and duplicates it in mm in
   `recommendations.notes` for a human.

---

## 5. Service (optional acceleration)

mesh-toolkit provides the Cordis service `meshToolkit` (the name is stable, `apiVersion: 1`):

```js
// provided by mesh-build
ctx.provide('meshToolkit', {
  apiVersion: 1,
  capabilities: () => ({ families: [...], routes: [...], gateProfiles: [...], features: ['handoff','patch-types','revise','surface-check'] }),
  generate: async (request) => ({ requestId, stl, qa }),            // §3.1 geometry
  mesh: async (request) => ({ requestId, handoff, caseDir }),      // §3.1 → §3.2 (full cycle)
  revise: async (feedback) => ({ requestId, attempt, handoff, changes }),
  patchTypes: async ({ caseDir, roles }) => ({ patches, handoff }),
  gate: async ({ caseDir, profile, minVol }) => ({ verdict, metrics, passport }),
  deliver: async ({ caseDir, name, minVol }) => ({ delivery, handoff }),
})
```

Status (2026-11-26, mesh-toolkit 0.6.1): the service exists and is filled lazily by whichever package is
installed — mesh-stl registers `generate`, `qa`, `hints`; mesh-build registers `mesh`, `gate`, `deliver`,
`patchTypes`, `hints`. `revise` answers `{ok:false, error:"not-provided", available, hint}` until A3 lands. Methods
return the tool payload itself (the same JSON a tool call gives); failures are the structured error above, never
a thrown exception. `capabilities()` reports `{apiVersion, methods[], missing[]}` for discovery.

Rules:

- workbench obtains the service **at call time**: `ctx.get('meshToolkit')` (bootstrap order is free),
  checks `apiVersion === 1`; if it is absent or incompatible it works its own way
  (`openfoam_mesh_plan` + `openfoam_mesh_verify`) and reports `mesh.provider: "workbench-fallback"` in the report.
- mesh-toolkit does not look for workbench and does not depend on it; the service is provided even if workbench
  is not installed.
- Service errors are structured `{ok:false, error, phase, next[]}`; no exceptions across the boundary.
- Time: `mesh()` may last minutes; the calling side must have a timeout and treat
  a timeout as `blocked` with a preserved `caseDir` (the mesh is not deleted, progress is visible in the logs).

---

## 6. Compatibility and versioning

- `apiVersion` is an integer; a mismatch = a refusal with a hint to update the package.
- `*/1` schemas are extended only by adding optional fields; removal/renaming —
  a new version (`handoff/2`), both are supported for one minor release.
- The packages declare an **optional** peer: workbench — `dsh-mesh-toolkit` (not installed
  automatically), mesh-toolkit — nothing (it stays independent).

---

## 7. Contract acceptance (two-way tests)

| id | scenario | criterion |
|---|---|---|
| T1 | parametric → mesh → gate → handoff → `openfoam_case_scaffold` on the delivered case → `openfoam_check` | PASS with no manual edits; the patches in the BC match `handoff.patches` |
| T2 | deliberately bad y+ → feedback(`yplus`) → `revise` → repeated run | PASS in ≤ 2 attempts; `changes[]` explains the revision |
| T3 | independence | workbench without the toolkit: its golden matrix is green; toolkit without workbench: CI is green |
| T4 | units | STL in metres → `needs_input`/refusal, and not a silent trimming of the geometry |
| T5 | patch roles | `mesh_patch_types` → handoff roles → BC in the scaffold; a repeated gate did not change the metrics |
| T6 | timeout | an interrupted `mesh()` does not leave the case in a "cannot continue" state |

---

## 8. What the contract does not cover

- Transfer of fields/computation results (this is the domain of workbench and post-processing).
- Joint use with `dsh-ansys-fluent-workbench`: the contract is compatible with it (patch roles
  and `.msh` in the delivery), but a separate specification is not issued until such a package exists.
- Automatic installation of each other's packages.
