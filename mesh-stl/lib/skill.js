/**
 * mesh-stl/lib/skill.js — bundled skill text (registered via ctx.skills.register).
 * @module mesh-stl/lib/skill
 */
export const SKILL = {
  name: 'mesh-stl',
  description: 'STL geometry generation and QA for the Mesh_3D_pore_scale project: generator families '
    + '(FCC cell, channel with sphere packing, double-layer burner, packings, CadQuery CAD), STL contract '
    + 'checks (watertight, winding, units mm), cleanup, passport registration. Use before meshing or when '
    + 'an STL fails QA.',
  whenToUse: 'When you need to create or verify a pore-scale STL, register a geometry passport, or decide '
    + 'which generator/preset to use. Pair with the mesh-build plugin for meshing.',
  content: `# mesh-stl — STL generation and QA

## Tools (3)
- **stl_hints** — the project's knowledge cards (verified rules + evidence + recipes).
  Without arguments — the catalogue; \`query\` — search; \`id\` — one card.
- **stl_generate** — runs a real generator from the registry \`data/generators.json\`.
  Without \`family\` — the list of families and presets. Writes params/logs/STL and checks every output
  with the built-in QA (JS, no python).
- **stl_check** — STL check: watertight, winding, body count, volume/area/bbox, cleanup
  (\`cleanup:true\`) and a passport row in \`stl/registry.csv\` (\`register:true\`).

## Workflow
1. \`stl_hints({ query: "<task>" })\` — read the applicable rules, do not invent numbers.
2. \`stl_generate({ family, preset, name, params? })\` — generate (dryRun:true first if expensive).
3. \`stl_check({ stl, cleanup:true, register:true, expectVolume })\` — the PASS verdict is mandatory.
4. Pass the clean STL to mesh-build: \`mesh_build({ route:"snappy", scaffold:true, caseDir, stl:["<name>.clean.stl"], scaffoldOptions:{ domainMin, domainMax, cellSize, locationInMesh } })\`;
   for an existing case — \`scaffold:false\` + \`caseDir\`.

## Hard rules
- STL in **mm** only; watertight + consistent normals are the contract (R9).
- Do not mesh a raw CAD/CSG STL: run \`cleanup\` first, and give the mesher \`*.clean.stl\`.
- Minimum gap >= 2*MeshSizeMin; zero-gap contacts are forbidden (D-007/D-008).
- Generation parameters are recorded in \`<name>.params.json\` next to the STL — reproducibility (R4).
- If \`stl_check\` returns FAIL — first the \`stl-cleanup\` card, then re-check; never mesh a broken STL.

## How to extend (without code changes)
- A new generator: add an object to \`data/generators.json\` (id, script, steps, outputs, preset).
  Placeholders: \`{paramsFile} {outDir} {name} {json} {rawOut} {cleanOut} {solidOut} {fluidOut}\`
  \`{fluidPatchesOut} {ballsCsv} {contactsCsv} {packingJson}\`.
- A new rule/pitfall: add a JSON card to \`data/hints/*.json\` (fields id, title, topics,
  status verified/derived/unverified, when, statement, recipe[], evidence[], improves[], appliesTo[]).
- Remove a tool or family: delete the data entry; the generator list is visible in stl_generate.
- After changing data: \`plugin_manager action:"list_plugins"\` → reinstall/restart if needed.
`,
}
