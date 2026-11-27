# 1.3.1 — a clipped surface is refused, the scaffold writes a real solver skeleton

Patch release after the first real solver run on a plugin-built mesh (exp-027: laminar `simpleFoam` through a
channel-with-spheres packing, 351 iterations, mass balance exact). Two code defects and one shape fix.

## What changed

| Area | Before | Now |
|---|---|---|
| STL outside the domain | a warning; snappy clipped the surface silently and the gate still said PASS (exp-027: 242 699 cells, 438 787 illegal faces, only `world` + `walls` left) | `mesh_build` **refuses** with `… — refusing to mesh: a clipped surface yields a mesh that passes checkMesh but has no inlet/outlet; enlarge the domain or pass scaffoldOptions.allowClipping: true if the cut is deliberate`; `allowClipping: true` keeps the old behaviour plus the warning |
| Scaffolded case, solver side | `application snappyHexMesh`, `solvers { }`, `SIMPLE { }`, no `fvSchemes` blocks — a solver run needed the workbench's `force: true` pass | `controlDict` `application simpleFoam` / `endTime 1000` / `writeInterval 100`; full `fvSchemes` (`div(phi,U) Gauss linearUpwind grad(U)`, `div((nuEff*dev2(T(grad(U))))) Gauss linear`); `fvSolution` with `GAMG`/`smoothSolver`, `SIMPLE` (`nNonOrthogonalCorrectors 1`, `residualControl`), `relaxationFactors`; `solverSkeleton` in the payload |
| snappy `illegal faces` count | not read | parsed into a `mesher` block (`status`, `illegalFaces`, `cells`) plus an advisory — **reported, not a verdict** (snappy counts at its own, much stricter `minVol`; a case with 83 246 such faces solved fine) |
| Tool refusals | `{ error, tool }` | `{ ok: false, phase: 'error', error, tool }` |

## Evidence

- Suite: **103 tests / 103 pass, 0 fail, 2 skipped** (`mesh-build/test/mesher-verdict.test.mjs` adds the snappy-log
  parser, the skeleton text and the clipping refusal; the refusal is also asserted through the tool).
- Skeleton end-to-end: a channel case scaffolded by 1.3.1, then `openfoam_case_scaffold` (no `force`) added only
  `0/U` and `0/p` while keeping `system/`, then `simpleFoam` ran **10 iterations, exit 0** on the scaffolded
  dictionaries (`GAMG` for p, `smoothSolver` for U).
- Clipping: a 10 mm cube with `domainMax (0.005 0.005 0.005)` is refused; the same call with `allowClipping: true`
  meshes and keeps the `exceeds the domain` warning.
- exp-027 remains the solver evidence: 290 099 cells, gate PASS, 351 iterations, inlet/outlet flux exactly balanced
  at 2.55838e-07 m³/s, |U|max 0.738 m/s, p 4.84e-04…2.43865 m²/s² (see `docs/ACCEPTANCE.md` § Fifth run).

## Compatibility

- Existing cases keep working; the new refusal only fires when an STL really sticks out of the domain. If you relied on
  silent clipping, pass `scaffoldOptions.allowClipping: true`.
- `mesher` and `solverSkeleton` are new informational fields; no existing field changed meaning.
- `fvSchemes`/`fvSolution` written by the scaffold are laminar `simpleFoam` defaults — a turbulent or compressible study
  still replaces them.

## Install

```bash
dsh plugin --profile web add "git+https://github.com/AstDen/dsh-mesh-toolkit.git#v1.3.1"
```

or unpack the `mesh-toolkit-1.3.1.tgz` asset into `node_modules` (single package), or add the market index
`https://raw.githubusercontent.com/AstDen/dsh-mesh-toolkit/master/market/index.json`.

## Known gaps

- No *physical* validation: exp-027 proves the pipeline, not the physics (no experimental or literature comparison).
- The `.msh` still has no Fluent *solver* run, only a mesh read (exp-026).
- `minVol` remains absolute and domain-specific; the gate derives and then measures it, and reports `minVolSource`.
