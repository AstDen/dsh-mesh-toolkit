# Workbench side of the integration (for the author of dsh-openfoam-workbench)

This document is the `dsh-openfoam-workbench` half of the integration plan. The normative exchange
contract is [`WORKBENCH-CONTRACT.md`](WORKBENCH-CONTRACT.md); the full analysis and our side of the work
are in [`PLAN-workbench-integration.md`](PLAN-workbench-integration.md).

Tracked upstream as https://github.com/yakovlev-i-a/dsh-openfoam-workbench/issues/1 — discuss there,
or open a separate issue for a specific item.

Status of the mesh-toolkit side (2026-11-26): **`handoff.json`, the `meshToolkit` service and patch-role
assignment ship in 0.6.1** — `mesh_check`/`mesh_deliver` write the handoff, the service answers `generate`, `qa`,
`mesh`, `gate`, `deliver`, `patchTypes` (`revise` answers `not-provided` until A3). Workbench can adopt the file
contract today; reading `handoff.json` and its patch roles needs no code from us, and `patchTypes({caseDir, roles})`
turns a single snappy `wall` patch into solver roles with a diff and explicit refusals.

---

## 1. What you get

Two exchange channels, either of which is sufficient:

1. **File channel (recommended first step).** `mesh_deliver` and `mesh_check` write `<caseDir>/handoff.json`
   (schema `mesh-handoff/1`): units and scale actually written, geometry provenance and SHA-256, mesh
   metrics, gate verdict with the exact thresholds, patch list with **roles**, domain, recommendations,
   and `next[]` with ready-to-call tools. A delivered case already contains `constant/polyMesh` with typed
   patches and a `.foam` marker, so `openfoam_case_scaffold` can consume it directly.
2. **Service channel (optional, later).** Cordis service `meshToolkit`, `apiVersion: 1`:
   `capabilities()`, `generate(request)`, `mesh(request)`, `revise(feedback)`, `patchTypes({caseDir, roles})`,
   `gate({caseDir, profile, minVol})`, `deliver({caseDir, name, minVol})`. Resolve it at call time
   (`ctx.get('meshToolkit')`), exactly like you already resolve `approval`; no bootstrap-order coupling.

Everything is additive: without the toolkit installed nothing changes for your users.

---

## 2. What to implement (B1–B7)

| # | Item | Where | Acceptance |
|---|---|---|---|
| B1 | Provider discovery at call time with `apiVersion` check; on absence or mismatch fall back to the current `openfoam_mesh_plan` + `openfoam_mesh_verify` and record `mesh.provider: "workbench-fallback"` | a small helper next to your existing `getApproval()` pattern | with and without the provider, the same call succeeds |
| B2 | `openfoam_mesh_request` — build `mesh-request/1` from physics (y+ via `openfoam_compute_first_layer`, domain type and margins, cell budget), call `mesh.mesh(request)` or the fallback; return `{caseDir, handoff, verdict}` | `lib/tools/mesh.js` | T1 below passes |
| B3 | `openfoam_mesh_feedback` — pack a diagnosis into `mesh-feedback/1` (category from the enum, evidence = log lines + metrics), call `mesh.revise(feedback)`, return `changes[]` and the new handoff | `lib/tools/mesh.js`, `lib/tools/run.js` | T2 below passes |
| B4 | Consume `handoff.json` in `openfoam_case_scaffold`: take patch roles from the handoff instead of guessing by name; refuse to write BCs when a required role is `unknown`; record `provenance: "mesh-toolkit@<version>"` | `lib/tools/case.js` | T1/T5 below pass; no silent re-guessing |
| B5 | Post-run mesh diagnosis: map failures to feedback categories with evidence (`nonortho` from checkMesh warnings, `yplus` from the `yPlus` function object or a field stat, `patch-roles` from BC mismatches). Do not diagnose on a mesh that never went through the gate | `lib/tools/run.js`, `lib/knowledge.js` | a bad case produces a feedback object with a category and evidence |
| B6 | De-duplication: when the provider is present, do not run `openfoam_mesh_plan` for the same case; document the precedence in the meshing skill | `CORE.md`, `skills/openfoam-meshing/SKILL.md` | no double build in a T1 run |
| B7 | Contract tests: stub provider + T1–T6; keep your golden matrix green **without** the provider; declare an optional peer (not auto-installed) | `test/` | CI green in both modes |

Suggested order: B1 + B4 first (they already work with the file channel), then B2/B3, then B5, then B6/B7.

---

## 3. Data you will read

`handoff.json` (abridged; full schema in the contract):

```json
{
  "schemaVersion": "mesh-handoff/1",
  "producer": { "plugin": "mesh-build", "version": "0.6.0", "openfoam": { "version": "v2512" } },
  "units": { "stl": "mm", "case": "m", "scale": 0.001 },
  "mesh": { "route": "snappy", "cells": 202440, "regions": ["fluid"] },
  "quality": { "profile": "project", "verdict": "PASS", "maxNonOrtho": 14.6, "minVolume": 3.2e-13 },
  "patches": [{ "name": "fluid", "type": "wall", "role": "wall", "nFaces": 56560 }],
  "recommendations": { "suggestedFamily": "incompressible", "notes": ["retype inlet/outlet"] },
  "next": [{ "tool": "mesh_patch_types", "args": { "caseDir": ".", "roles": { "inlet": [], "outlet": [] } } }]
}
```

Rules that matter for you:

- **Units**: the STL is in mm, the case in metres; trust `units.scale`, and verify it against
  `system/blockMeshDict` before running. If a geometry is suspiciously large, ask the user (mm vs m) —
  the toolkit does the same (`scaleAskAbove` = 0.1 m).
- **Verdict**: `quality.verdict` is our gate, not `checkMesh`. `checkMesh` exits 0 on threshold failures,
  so treat a `PASS` in the handoff as the only green light.
- **Roles**: `inlet | outlet | wall | symmetry | cyclic | empty | interface | wedge | unknown`. A mesh is
  allowed to pass the gate with `role: "unknown"` patches — that is exactly when `next[]` offers
  `mesh_patch_types`.
- **`minVol`**: absolute volume (m³), not a fraction. Our gate suggests `minVolume/12` when a threshold
  is stricter than the mesh deserves; do not re-invent it on your side.

---

## 4. Feedback loop you drive

```
mesh-request → mesh-toolkit → handoff.json → case_scaffold → check → short run
      ↑                                                              │
      └──────────── mesh-feedback (category + evidence) ◄─────────────┘
```

- Categories: `yplus | nonortho | skewness | patch-roles | resolution | domain | units | layers |
  cells-budget | stl-quality`.
- Our side applies a **deterministic** advice table (data, not code) and returns `changes[]` plus a new
  handoff; the attempt counter lives in the request. Default cap 3, maximum 8.
- When the cap is reached we return `{ok:false, escalated:true, options:[…]}` — show the options to the
  user; each option carries a cost (cells, runtime) and an expected effect.
- One rule worth adopting on your side as well: after three failed snappy attempts, change the strategy
  (coarsen → snappier route) rather than repeating the same knobs. Your `openfoam-meshing` skill already
  says this; we put it into the advice table.

---

## 5. Acceptance (bilateral)

| id | scenario | criterion |
|---|---|---|
| T1 | parametric → mesh → gate → handoff → `openfoam_case_scaffold` on the delivered case → `openfoam_check` | PASS with no manual edits; BC patch names equal `handoff.patches` |
| T2 | deliberately bad y+ → feedback(`yplus`) → `revise` → re-run | PASS within 2 attempts; `changes[]` explains the fix |
| T3 | independence | your golden matrix is green without the toolkit; our CI is green without the workbench |
| T4 | units | an STL in metres produces a question/refusal, not a silently clipped mesh |
| T5 | patch roles | `mesh_patch_types` → handoff roles → BCs in the scaffold; a repeated gate keeps the metrics |
| T6 | timeout | an interrupted `mesh()` leaves a case that can be continued |

T1–T5 are the minimum for `1.0.0`; T6 is a robustness check.

---

## 6. Questions for you

1. **Patch roles**: are you comfortable reading `handoff.patches[].role` in `openfoam_case_scaffold`
   instead of inferring from names? If yes, who owns retyping — our `mesh_patch_types` or your
   `openfoam_dict_set` with a note in the case report?
2. **Provider mode in `mesh_plan`**: would you add a delegation mode (service present → `mesh.mesh()`,
   otherwise current behaviour)? That removes double builds without a hard dependency.
3. **Service vs tools**: do you prefer the Cordis service `meshToolkit` or calling our tools through
   `ToolsService.get('mesh_build')`? We can provide both but want one canonical path.
4. **Units**: should `scaleAskAbove` become a shared profile setting and be echoed in
   `handoff.units.scale`?
5. **Feedback categories**: is our enum enough, or do you need solver-side categories
   (`solver-divergence`, `boundedness`)? The advice table is data and can grow.
6. **Golden cases**: may we add an optional "mesh-toolkit connected" step to your CI (our
   `mesh_build` + `mesh_check` on your cavity/sphereBox) so the contract is regression-tested on your side?
7. **Licences**: workbench is Apache-2.0, the toolkit MIT. We re-implement behaviour from the spec
   (y+, Hausdorff approximation, domain modes) instead of copying code — any objection?
8. **Naming**: is `handoff.json` at the case root acceptable, or would you prefer `deliver/handoff.json`
   to keep the case root clean?

---

## 7. What we do on our side (for context)

A1 handoff writer, A2 `mesh_patch_types`, A3 `mesh_revise`, A4 cone/pipe/`parts[]` primitives,
A5 y+ → layers, A6 domain modes and scale suspicion, A7 `mesh_surface_check` (bbox/area/volume +
approximate Hausdorff), A8 capability probing, A9 service + contract tests — about 8–10 working days,
tracked in `PLAN-workbench-integration.md`.
