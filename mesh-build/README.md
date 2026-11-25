# mesh-build — DSH-плагин построения объёмных сеток

Четыре инструмента для проекта `Mesh_3D_pore_scale`: маршруты мешинга (snappyHexMesh, cfMesh, gmsh route D),
скаффолд рабочего кейса snappy по STL, вердикт качества по порогам проекта и поставка двумя дистрибутивами
(OpenFOAM-кейс + Fluent `.msh`). Все команды — реальные
команды OpenFOAM/cfMesh на этой машине, логи остаются на диске, в ответ идёт короткая сводка.

## Инструменты

| Инструмент | Зачем | Аргументы |
|---|---|---|
| `mesh_hints` | карточки знаний: snappy, cfMesh/pMesh, gmsh route D, шлюз, поставка, отклонённые маршруты | `query`, `id`, `limit` |
| `mesh_build` | маршрут + скаффолд кейса + шлюз | `route`, `caseDir`, `scaffold`, `stl`, `scaffoldOptions`, `np`, `splitRegions`, `gate`, `profile`, `minVol`, `overwrite`, `skipBlockMesh`, `dryRun`, `gmshScript`, `gmshArgs`, `msh` |
| `mesh_check` | JS-шлюз по каждому региону; пишет `mesh-passport.json`, сетку не меняет | `caseDir`, `regions`, `profile`, `minVol` |
| `mesh_deliver` | поставка прошедшей шлюз сетки: OF-кейс + `.tar.gz`, Fluent `.msh` + `.zip`, отчёт с проверками | `caseDir`, `name`, `outDir`, `gateProfile`, `minVol`, `regions`, `multiRegion`, `noCombinedMesh`, `skipAnsys`, `keepScratch`, `force`, `dryRun` |


## Description и Topics

**Description** (`package.json` → `description`): объёмные сетки для поровой шкалы — snappyHexMesh
(hex-dominant, слои, многорегионный CHT), cfMesh cartesianMesh, gmsh OCC conformal route D, checkMesh и
строгий шлюз качества по каждой области с корректной обработкой абсолютного `minVol`.

**Topics** (`package.json` → `keywords`): `openfoam`, `snappyhexmesh`, `cfmesh`, `gmsh`, `volume-mesh`,
`cht`, `quality-gate`, `checkmesh`, `pore-scale`, `minvol`.

**Для чата**: `description` инструментов в `index.js`, `description` + `whenToUse` в `lib/skill.js`,
карточка `plugin-mesh-build` в `data/hints/plugin.json`; её `topics` = `keywords`.

Без `route` инструмент показывает маршруты, профили и шаги; без `query` `mesh_hints` — каталог карточек.

## Установка

```json
{ "action": "install_bundle", "target": "<абсолютный путь к репозиторию>/plugins/mesh-build" }
```

Подставьте свой путь — DSH принимает только абсолютный (`$(pwd)/plugins/mesh-build` из корня проекта).

Это инструмент DSH `plugin_manager` (требует подтверждения): он ставит `link:` в профиль и включает
бандл, поэтому правки в `plugins/mesh-build/` видны живой сессии. Повторная активация после правок:
`plugin_manager({ "action": "set_plugin", "target": "include:mesh-build" })`.
Проверка без DSH:

```bash
node plugins/mesh-build/scripts/smoke.mjs   # конфиг, маршруты, карточки, скаффолд в tmp, план serial/parallel
```

Требования: Node ≥ 20, DSH `>= 0.2.1-rc.5 < 0.3.0`, OpenFOAM (ESI v2512; `etc/bashrc` ищется в
стандартных каталогах установки, явный путь — `openfoamBashrc`/`MESH_BUILD_OPENFOAM_BASHRC`),
`tools/qa/mesh_gate.sh`, `tools/deliver/make_delivery.sh`, `mpirun` для параллельного мешинга.

## Конфигурация

```json
// ~/.config/mesh-build/config.json   (или $MESH_BUILD_CONFIG=/path/config.json)
{
  "projectRoot": "/path/to/Mesh_3D_pore_scale",
  "caseRoot": "experiments",
  "workRoot": ".cache/mesh-build",
  "np": 6,
  "timeoutMs": 1800000
}
```

`projectRoot` можно не задавать — ищется вверх от рабочего каталога агента; `caseRoot`/`workRoot` —
пути **относительно** корня проекта.

Переменные: `MESH_BUILD_PROJECT_ROOT`, `MESH_BUILD_PYTHON`, `MESH_BUILD_WORK_ROOT`,
`MESH_BUILD_CASE_ROOT`, `MESH_BUILD_NP`, `MESH_BUILD_TIMEOUT_MS`, `MESH_BUILD_CONFIG`,
`MESH_BUILD_OPENFOAM_BASHRC` и `MESH_BUILD_OPENFOAM_ROOTS` (доп. каталоги установок через `:`).

## Маршруты (`data/engine.json`)

| route | шаги | когда |
|---|---|---|
| `snappy` | blockMesh → surfaceFeatureExtract → (decomposePar → snappy -parallel → reconstruct) или snappy serial → splitMeshRegions | поровые STL, CHT по `cellZones`, hex-dominant + слои |
| `cfmesh` | clean → decomposePar → cartesianMesh -parallel → reconstruct → clean processors (или serial) | робастная hex-сетка, когда snap нестабилен |
| `gmsh` | `<python> <gmshScript> <gmshArgs>` → `gmshToFoam <msh> -case <case>` → splitMeshRegions | conformal CHT из OCC (route D) |
| `check` | — | только проверка существующего кейса |

Шаги декларативные: `{ name, run, when, timeoutMs }`, `when` ∈ `always | blockMesh | features | parallel |
serial | splitRegions`. Плейсхолдеры: `{caseDir} {np} {msh} {python} {gmshScript} {gmshArgs}`. Логи —
`<caseDir>/logs/plugin-<route>-NN-<step>.log`, при падении возвращается `failedStep` и `troubleshooting`
из `failures` маршрута.

## Скаффолд snappy

`mesh_build({ scaffold: true, stl: [...], scaffoldOptions: {...} })` пишет проверенный кейс:

- `system/{blockMeshDict,snappyHexMeshDict,meshQualityDict,surfaceFeatureExtractDict,decomposeParDict,controlDict,fvSchemes,fvSolution}`, `0/.keep`;
- кейс в **метрах** (`convertToMeters 1`), STL проекта в **мм** — в `geometry{}` добавляется `scale 0.001`;
- внешняя граница домена — `symmetry` (иначе snap сдвигает точки с плоскости, exp-006/D-013);
- `locationsInMesh` из `locationInMesh`: `[x,y,z]` или `[{point:[x,y,z], name:"fluid"}]`, multi-region → `cellZones` → `splitMeshRegions`;
- `minVol` абсолютный (по умолчанию `1e-14`, правило `h_min³/6`), `maxNonOrtho` 65 в `meshQualityDict`;
- слои — только для перечисленных `layerSurfaces`.

`scaffoldOptions`: `domainMin`, `domainMax` (метры), `cells` или `cellSize` (метры), `locationInMesh`,
`refinementLevels {surface:level}`, `defaultLevel`, `layerSurfaces`, `nLayers`, `layerThickness`,
`minThickness`, `symmetryDomain`, `minVol`, `maxNonOrtho`, `resolveFeatureAngle`.

## Общее ядро и паспорта

Шлюз, парсер `checkMesh`, конфиг, пути и карточки живут в `../sim-core` (пакет `sim-core`, 0.3.0);
этот плагин — провайдер сервиса `simMesh` (`build`/`check`/`hints`) и потребитель `simHints`.
Профиль проекта — `sim-project.json` в корне (units, caseRoots, scratch, foam, gate, geometry, cores).
После scaffold пишется `case-manifest.json`, после шлюза — `mesh-passport.json`:
route, cells, regions, gate, sha256/size/mtime полимеша. `mesh_check` показывает свежесть паспорта
и расхождение записанного вердикта с текущим.

## Шлюз качества

`mesh_check` (и автоматически после успешного `mesh_build` при `gate` ≠ false) вызывает JS-шлюз
`sim-core/lib/gate.js`: пишет полный `meshQualityDict` (13 ключей), делает overlay
`<case>/.mesh-gate/<target>` и запускает `checkMesh -meshQuality`. Вердикт считается **по тексту**:
`checkMesh` возвращает 0 даже при `Failed N mesh checks`. Результат:
`{ verdict: PASS|FAIL|ERROR, failingRegions, results[{target, pass, failKind, metrics}] }`, где `metrics` —
`cells`, `maxNonOrtho`, `avgNonOrtho`, `maxSkewness`, `minVolume`, `violations`, слои
(`Added N out of M cells (P%)`). `minVol` абсолютный: не задан профилем/вызовом → в словарь пишется `-1`
(проверка отключена) и в ответе будет `disabled-minVol-not-configured`; при провале — совет
`minVol = minVolume/12`. `gate.engine: "script"` + `gate.script` оставлен как escape hatch на
`tools/qa/mesh_gate.sh`.

## Поставка (`mesh_deliver`)

`mesh_deliver` вызывает `tools/deliver/make_delivery.sh` и возвращает короткий JSON вместо лога:

- **OpenFOAM**: `openfoam_<name>/` с настоящей `constant/` (`polyMesh`, `triSurface`), `system/`, `0/`,
  маркером `<name>.foam` (открывается в ParaView) и архив `.tar.gz`.
- **ANSYS/Fluent**: `ansys_<name>/<name>.msh`, журнал `read_mesh.jou`, архив `.zip`; для CHT — по `.msh`
  на регион, база уходит в `constant/polyMesh_combined`.
- **Отчёт**: `delivery_<name>.{json,md}` — ячейки/патчи/объём, round-trip `.msh` → OpenFOAM,
  смежность интерфейса, вердикт шлюза.

Скрипт проверяет всё реальным запуском: `checkMesh` внутри упакованного кейса, интерфейс `<a>_to_<b>` ↔
`<b>_to_<a>` по числу граней, сумму объёмов регионов против combined, round-trip через
`fluentMeshToFoam`/`fluent3DMeshToFoam`, строгий шлюз по каждому региону и целостность архивов.

Предусловие — свежий `mesh-passport.json`: без паспорта инструмент вернёт `passport-missing`,
при изменённом полимеше — `passport-stale`; `force: true` снимает запрет (шлюз поставки всё равно
прогоняется). `minVol` передавайте явно — иначе скрипт берёт свой порог `1e-14`, который для поровых
ячеек 0.05–0.1 мм слишком велик. Пример:

```json
{"caseDir":"experiments/exp-018_snappy-parameter-study/cases/v13_best",
 "name":"cht_v13","minVol":1e-16,"outDir":"deliver"}
```

Результат (проверено): multi-region 575 757 ячеек, интерфейс сходится, оба региона PASS,
round-trip ok, 66.6 с; single-region FCC — 27 424 ячейки, 3.5 с.

## Карточки знаний (`data/hints/`)

`snappy.json` (10) — ловушки параметров; `cfmesh-gmsh.json` (4) — cartesianMesh/pMesh/слои поверх тетра/route D;
`quality.json` (7) — шлюз, абсолютный minVol, поставка, полиэдры, ParaView, отклонённые маршруты, Fluent.

## Как расширять

- **Маршрут**: запись в `data/engine.json` (шаги + `failures` с дословными строками ошибок). Удаление записи
  убирает маршрут из инструмента.
- **Знание**: карточка в `data/hints/*.json` (см. формат в mesh-stl/README).
- **Шаблон кейса**: `lib/scaffold.js` (`writeSnappyCase`) — единственное место, где пишутся словари;
  менять вместе с `node plugins/mesh-build/scripts/smoke.mjs`.
- После правок — smoke и перезапуск DSH.

## Границы

- Не строит геометрию (это `mesh-stl`) и не запускает решатели.
- Долгие прогоны — в фоне: инструмент возвращает управление по `timeoutMs` шага, полный лог на диске.
- Существующий кейс не перезаписывается без `overwrite: true`; `mesh_check` не меняет сетку, но пишет `mesh-passport.json`.
