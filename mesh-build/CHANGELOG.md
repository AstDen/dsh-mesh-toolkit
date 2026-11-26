# Changelog

## 0.5.2 — 2026-11-26

- **`scripts/fluid-point.py` в пакете** — подбор `locationInMesh` по STL больше не требует дерева
  `benchmark/scripts/` исследовательского проекта. Скрипт тот же (bucket-индекс, точная дистанция и
  сторона по одной грани, бюджет `--max-seconds`); `benchmark/scripts/fluid_point.py` остаётся шимом.
- `caseRoot` по умолчанию `cases` (без профиля — относительно текущего каталога), сообщения `next:`
  указывают на упакованный скрипт.

## 0.5.1 — 2026-11-26

Исправления по сквозному бенчмарку `benchmark/runs/20261125-1805` (61 кейс, 18 дефектов;
перепроверка — `experiments/_scratch/verify-fixes.mjs`, 15/15 PASS).

- **Guard'ы вместо молчаливого неверного меша** (`lib/precheck.js`, новый модуль):
  STL-оболочка за пределами домена (бинарный и ASCII STL), бюджет фоновой сетки
  (`maxCells`, по умолчанию 5e6), отказ cfMesh при несовпадении единиц
  (`surfaceTransformPoints -scale`), sanity «в меше нет патча `world`» ⇒ `locationInMesh`
  попал внутрь твёрдого тела.
- **`refinementLevels`**: пара уровней `[min, max]` теперь проходит в `snappyHexMeshDict`
  как `level (min max)` (DEF-12: скалярный API не мог воспроизвести проектный эталон),
  неизвестный ключ бросает ошибку со списком поверхностей (DEF-13).
- **`system/meshQualityDict` пишется по порогам профиля гейта** (`maxNonOrtho`, `minVolRatio`,
  `minTwist`): snappy оптимизирует ровно по тем числам, по которым его судит гейт
  (exp-022: `minTwist -1` оставлял twisted-грани, которые гейт затем браковал).
- **Гейт**: минимальные `fvSchemes`/`fvSolution` синтезируются в overlay, если в кейсе их нет
  (DEF-04: `mesh_build` на cfMesh-кейсе отдавал `gate.verdict ERROR` с пустыми метриками),
  с advisory «напишите настоящие перед запуском решателя».
- **`mesh_check`**: свежесть паспорта считается ДО его перезаписи (DEF-09: `passport-stale`
  после правки `polyMesh/points` больше не маскируется), паспорт штампуется версией с диска.
- **Версия в ответах инструментов**: блок `version {reported, onDisk, stale}` + предупреждение
  «restart DSH», если процесс загрузил старую версию (DEF-08).
- **Карточки знаний**: `mesh_hints` регистрирует и каталог `mesh-stl` — один каталог из 33 карточек
  (DEF-15/DEF-16: `openfoam-versions` не находился по запросам про org14/cfMesh).


## 0.5.0 — 2026-11-25

Кросс-версионная совместимость OpenFOAM (com v2412…v2606, org v14):

- `sim-project.json → foam.installations` + `foam.default`; инструменты принимают `openfoam: "<id>|<bashrc>"`,
  по умолчанию — из профиля. Паспорт пишет `environment {id, distribution, version, bashrc}`.
- `routes.js`: `probeInstallation` (кэш по bashrc) — наличие всех инструментов маршрута, `mergeTol`,
  `surfaceFeatures`; `preflight` отказывает до запуска с подсказкой, где инструмент есть.
- Маршрут snappy: `surfaceFeatureExtract` на com, `surfaceFeatures` на org; `-mergeTol` только там, где он есть.
- scaffold: явный `file "<name>.stl"` в geometry (требование org14), `system/surfaceFeaturesDict`,
  `locationInMesh` для одной зоны вместо `locationsInMesh`.
- Проверено (exp-019): куб 10 мм на com2512 / com2606 / org14 — 2584 ячеек, PASS; org14 даёт 25.21° против 9.71°.
  `gmshToFoam` на com2512 и org14 — OK.

## 0.4.0 — 2026-11-25
Новый инструмент `mesh_deliver` — поставка сетки двумя дистрибутивами.

- Обёртка над `tools/deliver/make_delivery.sh`: открытый OpenFOAM-кейс с настоящей `constant/`
  и маркером `.foam`, `.tar.gz`, Fluent `.msh` + `read_mesh.jou` + `.zip`, отчёт
  `delivery_<name>.{json,md}` с проверками (round-trip, интерфейс CHT, объёмы, шлюз, архивы).
- Предусловие — свежий `mesh-passport.json` (`passport-missing` / `passport-stale`), `force:true`
  снимает запрет, но шлюз поставки всё равно прогоняется.
- `dryRun`, `gateProfile`, `minVol`, `regions`, `multiRegion`, `noCombinedMesh`, `skipAnsys`,
  `keepScratch`; автоопределение multi-region.
- `mesh_check` теперь пишет `mesh-passport.json` с вердиктом PASS/FAIL (сетку не меняет) — паспорт
  и есть вход в поставку; `passport-not-pass` блокирует упаковку.
- Проверено: v13_best (CHT, 575 757 ячеек, интерфейс ok, оба региона PASS, round-trip ok, 66.6 с)
  и FCC single-region (27 424 ячейки, 3.5 с); живые проверки guard: missing → force → stale → not-pass.

## 0.3.0 — 2026-11-25
Шлюз качества переехал в `sim-core`, появились паспорта и манифест кейса.

- **JS-шлюз авторитетный:** `sim-core/lib/gate.js` пишет полный `meshQualityDict` (все 13 ключей),
  делает overlay `<case>/.mesh-gate/<target>`, запускает `checkMesh -meshQuality` и выносит вердикт
  **по тексту** — `checkMesh` возвращает 0 даже при `Failed N mesh checks`.
- **`minVol` абсолютный и осознанный:** не задан профилем/вызовом → в словарь пишется `-1`
  (проверка отключена) и результат помечается `disabled-minVol-not-configured`; при провале
  выдаётся совет `minVol = minVolume/12`. `minTetQuality = minVol/100`.
- **Профили из профиля проекта:** пороги `gate`/`project`/`relaxed` можно переопределять в
  `sim-project.json.gate.profiles`, а `gate.engine:"script"` + `gate.script` оставлены как escape hatch
  на bash-скрипт (паритет с `tools/qa/mesh_gate.sh`).
- **Паспорт и манифест:** после scaffold пишется `case-manifest.json`, после шлюза — `mesh-passport.json`
  (route, cells, regions, gate, sha256/size/mtime полимеша). `mesh_check` показывает свежесть паспорта
  и расхождение записанного вердикта с текущим.
- **Сервис `simMesh`:** `build`/`check`/`hints` для других плагинов семейства.
- **Логи:** `checkMesh` пишет `<case>/logs/checkMesh-<target>.log`; overlay не попадает в `.cache` проекта.

## 0.2.0 — 2026-11-23
Исправления по бенчмарку `benchmark/verify-20261123-1851` (оценка была 33/100, мешинг был
заблокирован).

- **Блокер снят:** `mesh_build` падал на любом `scaffold:true` с `STL not found: .../[object Object]`.
  `expandStlInputs()` возвращает `{files, missing}`, а `scaffold.js` ждал массив. Теперь `index.js`
  разбирает объект, отдаёт структурную ошибку со списком недостающих файлов, а `writeSnappyCase()`
  дополнительно принимает `{files:[...]}`.
- **Dry run стал настоящим preflight:** `dryRun` гоняет `preflight()`, рендерит команды через
  `renderCommand()` (поле `unresolved`), возвращает `problems`/`requires` и не создаёт каталоги.
  `cfmesh` без `system/meshDict` теперь говорит `missing system/meshDict (cfMesh dictionary)`.
- **Проверка входа `caseDir`:** `resolveCase({mustExist})` — ошибка `case directory not found: <path> — <reason>`
  до запуска; `mesh_check` подсказывает, что нужен собранный кейс.
- **Локальная точка входа в метрах:** `scaffoldOptions.locationInMesh` принимает и `[x,y,z]`,
  и `[{point:[x,y,z], name}]` (как обещает описание инструмента).
- **Патчи в ответе:** новый `lib/patches.js` — `mesh_build` и `mesh_check` возвращают `patches`
  (`{name, type, nFaces}` по регионам) и `notes`: один тип на все патчи, `symmetry` (ретипировать
  после мешинга), отсутствие `patch`/`cyclic`.
- **Диагностика шлюза:** результат несёт `failKind`, `minVolSuggestion` и `advisory`. Если нарушен
  только абсолютный `minVol`, шлюз объясняет, что порог не масштабируется с сеткой, и даёт рабочее
  значение (`V_min/12`); если виноваты `face twist` — что это сливеры на зазорах меньше ячейки.
- **Карточки соседнего плагина:** `mesh_hints` видит `data/hints` плагина `mesh-stl` (hit@3 = 5/5).
- **Версия сверяется с диском:** `versionInfo()` → `{reported, onDisk, stale}`.
- Smoke-тесты дополнены регрессиями на все перечисленные пункты.

## 0.1.1 — 2026-11-23
- Портируемость: из README/примеров убраны абсолютные пути машины; лицензионный сервер Fluent в карточке заменён плейсхолдером.
- OpenFOAM-окружение настраивается: `openfoamRoots` / `MESH_BUILD_OPENFOAM_ROOTS` (стандартные каталоги — дефолт).
- Оверлей шлюза проверяется от `workRoot`, а не по жёсткому пути `/.cache/mesh-build/` (работает с кастомным workRoot).
- Уточнены карточки: `cfmesh-layers-tetra` (почему 3D-слои в gmsh 4.15.2 не строятся), `cfmesh-cartesian` (cfMesh в составе OpenFOAM), `units-mm` (три места с единицами).
- Проверены все числовые утверждения карточек по `journal/` и `experiments/` (расхождений не найдено).

## 0.1.0 — 2026-11-23
- Первая версия: три инструмента, JSON-данные (карточки знаний + реестр семейств/маршрутов).
- Собрано по журналу проекта `experiments/exp-000…exp-018` и ADR `D-001…D-019`.
- Smoke-тесты без DSH (`scripts/smoke.mjs`).
