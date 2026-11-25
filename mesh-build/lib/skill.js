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
  content: `# mesh-build — объёмные сетки и шлюз качества

## Инструменты (4)
- **mesh_hints** — карточки знаний: snappy, cfMesh/pMesh, gmsh route D, шлюз, поставка, отклонённые маршруты.
  Без аргументов — каталог; \`query\` — поиск; \`id\` — карточка.
- **mesh_build** — маршруты из \`data/engine.json\`:
  \`snappy\` (hex-dominant + layers + CHT по cellZones), \`cfmesh\` (cartesianMesh), \`gmsh\` (route D: .msh → gmshToFoam),
  \`check\` (только проверка). С \`scaffold:true\` пишет рабочий кейс snappy по STL и домену.
- **mesh_check** — JS-шлюз (\`sim-core/lib/gate.js\`): полный \`meshQualityDict\`, overlay \`<case>/.mesh-gate\`,
  вердикт по тексту лога по каждому региону; метрики и threshold violations.
- **mesh_deliver** — поставка прошедшей шлюз сетки: OpenFOAM-кейс (настоящая \`constant/\`, маркер \`.foam\`)
  + \`.tar.gz\`, ANSYS/Fluent \`.msh\` + \`read_mesh.jou\` + \`.zip\`, отчёт \`delivery_<name>.{json,md}\`.
  Требует свежий \`mesh-passport.json\`; \`force:true\` — только для старых кейсов.

## Порядок работы
1. \`mesh_hints({ query: "snappy non-ortho layers" })\` — прочитать правила.
2. STL уже проверен в mesh-stl: \`stl_check\` → PASS.
3. \`mesh_build({ route:"snappy", caseDir:"experiments/exp-NNN/case", scaffold:true, stl:[...], scaffoldOptions:{...} })\`
   либо существующий кейс: без scaffold, \`stl\` копируется в \`constant/triSurface\`.
4. \`mesh_check({ caseDir, profile:"project", minVol:1e-14 })\` — вердикт.
5. При FAIL: читать \`troubleshooting\` и карточки по конкретной метрике; менять геометрию/уровень интерфейса/слои,
   а не крутить мелкие ручки snappy (hint snappy-toggles-neutral).
6. Поставка: \`mesh_deliver({ caseDir, name, minVol })\` — после PASS-шлюза и свежего паспорта;
   инструмент сам проверяет round-trip, интерфейс и шлюз уже внутри упакованного кейса.

## Жёсткие правила
- Пороговое качество — только \`mesh_check\` (JS-шлюз, профиль project), «Mesh OK» без -meshQuality не вердикт.
- minVol/minTetQuality — АБСОЛЮТНЫЕ объёмы, \`minVol ≈ h_min³/6\` (hint snappy-minvol).
- STL в мм → \`scale 0.001\` в snappy geometry; case в метрах.
- Внешние плоскости домена при мешинге — тип \`symmetry\`, физический тип ставить после мешинга (D-013).
- Слои — главный источник неортогональности: включать после того, как castellation+snap даёт приемлемый результат.
- \`locationsInMesh\` обязателен; multi-region — список \`((x y z) fluid)\` / \`((x y z) solid)\` → cellZones → splitMeshRegions.

## Как расширять (без правки кода)
- Маршрут: объект в \`data/engine.json\` (id, steps[{name,run,when,timeoutMs}], failures). Плейсхолдеры
  \`{caseDir} {np} {msh} {python} {gmshScript} {gmshArgs}\`; условия \`always|blockMesh|features|parallel|serial|splitRegions\`.
- Знание: JSON-карточка в \`data/hints/*.json\` (id, title, topics, status, when, statement, recipe[], evidence[]).
- Убрать маршрут — удалить запись; он исчезнет из mesh_build без правки кода.
- Шаблоны скаффолда — \`lib/scaffold.js\`; правки проверять запуском \`mesh_build\` на тестовом STL.
`,
}
