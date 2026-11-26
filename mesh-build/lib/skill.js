/**
 * mesh-build/lib/skill.js — bundled skill text for meshing.
 * @module mesh-build/lib/skill
 */
export const SKILL = {
  name: 'mesh-build',
  description: 'Volume-mesh generation and quality gating for Mesh_3D_pore_scale: snappyHexMesh (hex-dominant, '
    + 'layers, multi-region CHT), cfMesh cartesianMesh, gmsh OCC conformal CHT route D, checkMesh + project '
    + 'quality gate per region. Use when an STL is ready and must become a usable OpenFOAM mesh.',
  whenToUse: 'When you need to build a volume mesh from STL/STEP, create a snappy case from scratch, or decide '
    + 'whether an existing mesh passes the project quality gate.',
  content: `# mesh-build — volume meshes and the quality gate

## Tools (6)
- **mesh_hints** — knowledge cards: snappy, cfMesh/pMesh, gmsh route D, the gate, delivery, rejected routes.
  Without arguments — the catalogue; \`query\` — search; \`id\` — one card.
- **mesh_build** — routes from \`data/engine.json\`:
  \`snappy\` (hex-dominant + layers + CHT via cellZones), \`cfmesh\` (cartesianMesh), \`gmsh\` (route D: .msh → gmshToFoam),
  \`check\` (verification only). With \`scaffold:true\` it writes a working snappy case from the STL and the domain.
- **mesh_check** — the JS gate (\`sim-core/lib/gate.js\`): a full \`meshQualityDict\`, a \`<case>/.mesh-gate\` overlay,
  a verdict from the log text per region; metrics and threshold violations.
- **mesh_deliver** — delivery of a mesh that passed the gate: an OpenFOAM case (a real \`constant/\`, a \`.foam\` marker)
  + \`.tar.gz\`, ANSYS/Fluent \`.msh\` + \`read_mesh.jou\` + \`.zip\`, a report \`delivery_<name>.{json,md}\`.
  Requires a fresh \`mesh-passport.json\`; \`force:true\` — only for old cases.
- **mesh_patch_types** — assign solver roles (inlet/outlet/wall/symmetry/empty/interface) to existing patches by
  retyping \`constant/<region>/polyMesh/boundary\` (a \`.bak\`, a diff, no face splitting); updates \`handoff.json\`,
  \`recheck:true\` proves the gate metrics did not change. Splitting one patch into inlet+outlet needs topoSet+createPatch.
- **mesh_revise** — Plan A3: a \`mesh-feedback/1\` document (yplus, nonortho, skewness, patch-roles, resolution, domain,
  units, layers, cells-budget, stl-quality) becomes the NEXT revision of the mesh. The reaction table is data
  (\`data/advice.json\`), the rung is counted from \`handoff.json\` history: \`apply:false\` returns the plan,
  \`apply:true\` rebuilds, re-gates and records \`{attempt, category, changes, verdict}\`. After three consecutive
  \`nonortho\`/\`skewness\` failures it switches the route once (snappy → cfmesh); at the ceiling it escalates with options.

## Workflow
1. \`mesh_hints({ query: "snappy non-ortho layers" })\` — read the rules.
2. The STL is already checked in mesh-stl: \`stl_check\` → PASS.
3. \`mesh_build({ route:"snappy", caseDir:"experiments/exp-NNN/case", scaffold:true, stl:[...], scaffoldOptions:{...} })\`
   or an existing case: without scaffold, \`stl\` is copied to \`constant/triSurface\`.
4. \`mesh_check({ caseDir, profile:"project", minVol:1e-14 })\` — the verdict.
5. On FAIL: read \`troubleshooting\` and the cards for the specific metric; change the geometry/interface level/layers,
   not the small snappy knobs (hint snappy-toggles-neutral).
6. Delivery: \`mesh_deliver({ caseDir, name, minVol })\` — after a PASS gate and a fresh passport;
   the tool itself checks the round-trip, the interface and the gate inside the packaged case.
7. Solver boundary conditions: \`mesh_patch_types({ caseDir, roles:{ inlet:[...], outlet:[...], walls:[...] } })\`
   then \`mesh_check\` again — the boundary file changed, so the passport is stale until it is refreshed.
8. A solver run sent back feedback (y+ too high, non-ortho, skewness): \`mesh_revise({ caseDir, feedback, apply:true })\`,
   read \`changes[]\`, repeat at most to the ceiling — the advice table decides the next rung, not the operator.

## Hard rules
- Threshold quality — only \`mesh_check\` (the JS gate, profile project); "Mesh OK" without -meshQuality is not a verdict.
- minVol/minTetQuality are ABSOLUTE volumes, \`minVol ≈ h_min³/6\` (hint snappy-minvol).
- STL in mm → \`scale 0.001\` in the snappy geometry; the case is in metres.
- Outer domain planes during meshing are type \`symmetry\`; set the physical type after meshing (D-013).
- Layers are the main source of non-orthogonality: enable them after castellation+snap already gives an acceptable result.
- \`locationsInMesh\` is mandatory; multi-region — a list \`((x y z) fluid)\` / \`((x y z) solid)\` → cellZones → splitMeshRegions.

## How to extend (without code changes)
- A route: an object in \`data/engine.json\` (id, steps[{name,run,when,timeoutMs}], failures). Placeholders
  \`{caseDir} {np} {msh} {python} {gmshScript} {gmshArgs}\`; conditions \`always|blockMesh|features|parallel|serial|splitRegions\`.
- Knowledge: a JSON card in \`data/hints/*.json\` (id, title, topics, status, when, statement, recipe[], evidence[]).
- Remove a route — delete the entry; it disappears from mesh_build without code changes.
- Scaffold templates — \`lib/scaffold.js\`; verify edits by running \`mesh_build\` on a test STL.
`,
}
