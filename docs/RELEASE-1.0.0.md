# 1.0.0

The mesh half of an agent-driven pore-scale workflow, released after the clean-user acceptance rather than
before it.

## What you get

Twelve tools, one install line, no runtime dependencies:

| Step | Tool | What it returns |
|---|---|---|
| geometry | `stl_generate` | nine families (FCC cell, channel with spheres, double-layer burner, packings, CAD porous, primitives incl. cone/pipe/`parts[]`, stratified channel, blob foam, box array) |
| contract | `stl_check` | watertight, winding, units, bodies, volume — in-process JS, python reference for parity |
| mesh | `mesh_build` | snappyHexMesh, cfMesh (cartesianMesh/pMesh/tetMesh) or gmsh OCC, scaffold or your dictionaries |
| gate | `mesh_check` | `checkMesh -meshQuality` per region, verdict from the **log text**, `mesh-passport.json`, `handoff.json` |
| revise | `mesh_revise`, `mesh_first_layer`, `mesh_patch_types`, `mesh_surface_check`, `mesh_capabilities` | the feedback ladder with ceilings and a route downgrade; y+ → layers; patch roles; STL-vs-mesh fidelity; what the installed build actually accepts |
| deliver | `mesh_deliver` | OpenFOAM case + `.tar.gz` + Fluent `.msh` + `read_mesh.jou` + a round-trip check + `delivery_*.{json,md}` |

Plus 40 knowledge cards distilled from 20+ experiments, and `handoff.json` so a solver-side agent (for example
`dsh-openfoam-workbench`) can pick the mesh up without guessing patch roles.

## Acceptance evidence

| Evidence | Where |
|---|---|
| clean user, no project / no checkout: `doctor` **READY 7 pass / 2 warn / 0 fail**, `demo` **OK in 25.7 s** | `docs/ACCEPTANCE.md` |
| two defects that run found, fixed before this tag (portable `outDir`, demo diagnostic) | `docs/ACCEPTANCE.md`, CHANGELOG rc.3 |
| 34 unit checks (domain, caps, advice/revise, surfacecheck) | `npm test` |
| 37 contract checks, four tiers incl. the workbench seam (`M3c` pins their hyphenated-patch defect) | `node scripts/contract-test.mjs` |
| 61-case benchmark, 45 pass / 15 fail / 18 defects triaged | `benchmark/` |
| four OpenFOAM builds probed (`com2512`, `com2606`, `org14`, gmsh) | `mesh_capabilities`, `docs/TROUBLESHOOTING.md` |

## Install

```bash
# one package from git (pin the tag)
dsh plugin --profile web add "git+https://github.com/AstDen/dsh-mesh-toolkit.git#v1.0.0"

# or a plugin market: add this index source (Plugins → Discover → add index source)
https://raw.githubusercontent.com/AstDen/dsh-mesh-toolkit/master/market/index.json

# or the release tarball
curl -LO <release>/mesh-toolkit-1.0.0.tgz && mkdir -p node_modules/mesh-toolkit && tar xzf … -C node_modules/mesh-toolkit --strip-components=1
node node_modules/mesh-toolkit/scripts/doctor.mjs
node node_modules/mesh-toolkit/scripts/demo.mjs
```

## Known gaps (unchanged, stated honestly)

- Fluent has never opened a delivered `.msh`; the file is built and round-tripped through OpenFOAM only.
- OpenFOAM.org 14 multi-region CHT is unverified (`locationsInMesh` is OpenCFD-only).
- The workbench's hyphenated-patch parser defect is pinned by contract check `M3c`, not fixed upstream (issue #1).
- Announcements are drafted in `docs/ANNOUNCEMENT.md`; posting needs the maintainer's accounts.

## What 1.0 means for compatibility

`docs/VERSION-POLICY.md`: breaking changes bump the minor inside 1.x, additive changes the patch; the DSH range
is `>=0.2.2-rc.1 <0.3.0` and a new DSH major needs the contract suite before the range is widened.
