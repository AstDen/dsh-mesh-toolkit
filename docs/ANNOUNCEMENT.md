# Announcement drafts

Ready-to-post text. Figures are from `docs/ACCEPTANCE.md` and the 60-second demo; do not add numbers that are
not in those files.

## Show HN / r/CFD / r/OpenFOAM (~180 words)

**Show HN: poremesh — 3D pore geometries to OpenFOAM meshes, with a gate that means something**

Wrapping snappyHexMesh is easy. Getting a mesh you can defend is not: `checkMesh` prints "Mesh OK" while
carrying 60° non-orthogonality, `minVol` is an absolute volume that silently eats boundary layers, and STL
units are a trap that costs a rebuild every time.

I built an agent-driven toolkit for pore-scale work (FCC cells, packings, foams, CAD porous parts). Nine
generator families produce watertight STL, three meshing routes (snappy, cfMesh, gmsh OCC), and every mesh
gets a threshold gate whose verdict is read from the log text — not from an exit code — plus a passport that
detects a stale verdict. One command delivers an OpenFOAM case, a `.tar.gz` and a Fluent `.msh` with a
round-trip check.

It ships 40 knowledge cards distilled from a benchmark of 61 cases (45 pass, 18 defects found — mine included)
and a handoff contract so a solver-side agent can pick the mesh up without guessing patch roles.

MIT, runs as a DSH plugin or from a shell: `node scripts/doctor.mjs && node scripts/demo.mjs`.

## awesome-cfd / lists (~60 words)

`poremesh` — STL geometry → OpenFOAM mesh for pore-scale problems, driven by an AI agent. Nine pore/packing
generators, snappy/cfMesh/gmsh routes, a threshold quality gate with a mesh passport, and one-command delivery
to OpenFOAM and Fluent. 40 knowledge cards, MIT. https://github.com/AstDen/dsh-mesh-toolkit

## DSH plugin community (~80 words)

New bundle: `mesh-toolkit` (DSH plugin) — 12 tools for STL generation, volumetric meshing and delivery.
Add it as a market index source: the index is a plain format-1 JSON at
https://raw.githubusercontent.com/AstDen/dsh-mesh-toolkit/master/market/index.json
(Plugins → Discover → add index source; enable custom indexes). Installs as one package from git, runs in
portable mode without a project file, and talks to `dsh-openfoam-workbench` through `handoff.json`.

## Notes before posting

- The package name is still `mesh-toolkit`; the rename to `poremesh` is a separate decision — update this file
  and the repository name first if it happens.
- Do not promise Fluent end-to-end: the `.msh` is built and round-tripped through OpenFOAM, never opened in
  Fluent (see `docs/TROUBLESHOOTING.md`).
- The hyphenated-patch defect in the workbench is described in the README comparison table; mention it if
  someone asks about the neighbour package, and link issue #1 instead of guessing whether it is fixed.
