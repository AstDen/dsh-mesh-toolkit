# 0.7.2 — the domain can be inferred, and a suspicious STL asks about its units

Adds plan A6 to the workbench integration series. mesh-stl and sim-core are unchanged.

| Package | Version | Change |
|---|---|---|
| mesh-build | **0.7.2** | `scaffoldOptions.domain`, `targetCells`, unit suspicion, scaffold warnings in the answer |
| mesh-stl | 0.4.1 | — |
| sim-core | 0.5.1 | — |

## Domain without coordinates

```js
mesh_build({ route: "snappy", caseDir: "cases/sphere", scaffold: true, stl: ["sphere.stl"],
  scaffoldOptions: { domain: { type: "external" }, targetCells: 60000, locationInMesh: [-0.01, 0, 0] } })
```

- `type: "external"` builds the box from the STL bounding box using multiples of `L` = the largest extent:
  upstream 3·L, downstream 5·L, lateral 3·L, vertical 3·L below and above, along `flowAxis` (default `x`).
- `type: "internal"` is the bbox itself; `type: "wrap"` pads 0.1·L on every side. `margins` and `sizeFactor`
  override the multiples. Explicit `domainMin`/`domainMax` stay authoritative (with a warning that the mode was
  ignored); `type: "box"` refuses and asks for them.
- `targetCells` picks the background cell size from the domain volume (`(V/targetCells)^(1/3)`) and the answer
  reports the value it chose; `cells` and `cellSize` still win.

## Unit suspicion instead of a silent 1000× box

If the domain is inferred and the STL bbox is wider than 100 mm, `mesh_build` answers
`{ok:false, phase:"domain", needs_input:[{id:"geometry-units", …}]}` — "is this file in millimetres?" — instead of
building a box that is 1000× too large. `assumeUnits: "mm"` continues. Runs with explicit `domainMin/domainMax`
(the benchmark cases, existing scripts) never ask.

## Warnings reach the caller

Scaffold warnings — the domain mode and the chosen cell size, an STL that sticks outside the domain, a background
mesh above the cell budget — used to stay inside `written.scaffold`. They now appear in the tool's `warnings`.

## Measured

- Sphere r5, `domain {type:"external"}`, `targetCells 60000` → box −35…55 × ±35 mm, background 47×37×37,
  snappy builds, gate **PASS**.
- A 40×20×20 mm box with `targetCells 16000` → 1.0 mm cells, `cells [40,20,20]`.
- `experiments/_scratch/verify-a6.mjs`: **26/26** (pure helpers, scaffold dict, tool `needs_input` path, real build).
