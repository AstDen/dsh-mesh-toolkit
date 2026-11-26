# mesh-stl — DSH-плагин генерации STL

Набор из трёх инструментов для проекта `Mesh_3D_pore_scale`: параметрическая генерация геометрии,
проверка STL по контракту и паспорт в `stl/registry.csv`. Работает на реальных скриптах проекта
(`geometry/`), ничего не выдумывает: все метрики считает собственный QA на JS (`lib/qa/`), а
`tools/qa/stl_qa.py` остаётся эталоном паритета и доступен как `engine: "python"`.

## Инструменты

| Инструмент | Зачем | Аргументы |
|---|---|---|
| `stl_hints` | карточки знаний: контракт STL, чистка, тесселяция, зазоры, snappy-ловушки | `query`, `id`, `limit` |
| `stl_generate` | запуск генератора из реестра семейств | `family`, `preset`, `name`, `outDir`, `params`, `dryRun` |
| `stl_check` | QA STL + чистка + запись паспорта | `stl`, `cleanup`, `cleanOut`, `expectVolume`, `expectArea`, `expectBodies`, `maxVolumeErr`, `maxAreaErr`, `register`, `family`, `generator`, `paramsFile`, `fluidOrSolid`, `notes` |


## Description и Topics

**Description** (паспорт бандла, `package.json` → `description`): генерация STL из проверенных семейств
(FCC-ячейка, канал с упаковкой сфер, двухслойная горелка, упаковки, CadQuery CAD), контракт QA
(watertight, winding, мм), чистка и паспорт в `stl/registry.csv`.

**Topics** (`package.json` → `keywords`, для поиска/маркетплейса): `stl`, `geometry`, `pore-scale`,
`cadquery`, `trimesh`, `watertight`, `mesh-preparation`, `qa`, `passport`, `generator-presets`.

**Для чата** (то, что реально видит модель): `description` инструментов в `index.js`, `description` +
`whenToUse` в `lib/skill.js`, карточка `plugin-mesh-stl` в `data/hints/plugin.json` (`topics` этой карточки
совпадают с `keywords`). Маршрутизация идёт по этим текстам — меняешь состав инструментов, обновляй их.

Без аргументов `stl_generate` показывает семейства и пресеты, `stl_hints` — каталог карточек.

## Установка

Единственный поддерживаемый путь — инструмент DSH `plugin_manager` (нужно подтверждение пользователя):

```json
{ "action": "install_bundle", "target": "<абсолютный путь к репозиторию>/plugins/mesh-stl" }
```

Подставьте свой путь — DSH принимает только абсолютный (`$(pwd)/plugins/mesh-stl` из корня проекта).

Он добавляет в профиль `link:` на каталог плагина (правки в `plugins/mesh-stl/` подхватываются живой
сессией; после перезапуска DSH — гарантированно) и включает запись в `dsh.profile.bundles`.
Проверка:

```bash
node plugins/mesh-stl/scripts/smoke.mjs        # без DSH: конфиг, карточки, каталог, dry-run
node plugins/mesh-stl/scripts/smoke.mjs --full # + реальная генерация FCC в .cache/mesh-smoke
```

После установки в каталоге скиллов появляются `mesh-stl`, а в инструментах —
`stl_hints`, `stl_generate`, `stl_check`. Если плагин активируется с ошибкой схемы, DSH укажет
точный путь параметра — правьте `index.js`, затем повторите `set_plugin` с `"target": "include:mesh-stl"`.

Требования: Node ≥ 20, DSH `>= 0.2.1-rc.5 < 0.3.0`. Встроенные семейства (`primitive`,
`stratified-channel`, `box-array`) и QA STL работают без python и без данных проекта. Python-семейства
(`fcc-cell`, `channel-spheres`, `double-layer-burner`, `blob-foam`, `packing`, `cad-porous`) запускают
скрипты из `generators/` этого пакета и требуют модули `trimesh` и `numpy` (для части — `cadquery`,
`scipy`, `skimage`). Перед запуском плагин проверяет импорт и возвращает `python-bridge-missing`
с командой установки вместо traceback.

## Конфигурация

Приоритет: `config` строки плагина → внешний JSON → переменные окружения.

```json
// ~/.config/mesh-stl/config.json   (или $MESH_STL_CONFIG=/path/config.json)
{
  "projectRoot": "/path/to/Mesh_3D_pore_scale",
  "python": "/path/to/Mesh_3D_pore_scale/.venv/bin/python",
  "workRoot": "stl/generated",
  "registry": "stl/registry.csv",
  "timeoutMs": 1800000
}
```

`projectRoot` и `python` можно не задавать: корень ищется вверх от рабочего каталога агента по
`sim-project.json`, интерпретатор — `<projectRoot>/.venv/bin/python`.
`workRoot`/`registry` — пути **относительно** корня проекта, а без профиля — **относительно текущего
каталога**; `registry` может быть абсолютным. Таблица паспорта создаётся по требованию (заголовок пишется
сама). Если файл нельзя записать (read-only каталог, чужой заголовок), QA всё равно считается: результат
несёт `registered: {ok: false, error, row}` и строку-предупреждение в `next`, вердикт не ломается.

Переменные: `MESH_STL_PROJECT_ROOT`, `MESH_STL_PYTHON`, `MESH_STL_WORK_ROOT`, `MESH_STL_REGISTRY`,
`MESH_STL_TIMEOUT_MS`, `MESH_STL_CONFIG`, а также `MESH_STL_OPENFOAM_BASHRC` (явный `etc/bashrc`) и
`MESH_STL_OPENFOAM_ROOTS` (доп. каталоги установок через `:`, помимо стандартных `/usr/lib/openfoam`,
`/opt/openfoam`, `~/openfoam`).

Если проект не найден, инструменты не падают, а возвращают `configured: false` и что именно указать.

## Общее ядро и встроенные генераторы

Механика (конфиг, профиль `sim-project.json`, резолвер путей, процесс-раннер, карточки, QA) живёт в
`../sim-core` (пакет `sim-core`, 0.4.x); `lib/common.js` — тонкий фасад. Плагин регистрирует сервис
`simGeometry` (`hints`/`generate`/`qa`) и складывает свои карточки в общий `simHints`.

Три семейства пишут STL на чистом JS и работают **без проекта** и без python: `primitive`
(`lib/primitives.js`; `shape` = `box` | `sphere` | `cylinder`, параметры `size_mm` /
`radius_mm`+`height_mm` / `center_mm` / `segments`/`rings`/`sections`), `stratified-channel`
(`lib/generators/stratified.js`; две коробки по 12 треугольников) и `box-array`
(`lib/generators/box-array.js`; решётка сфер/цилиндров + контейнер). Общие эмиттеры треугольников —
`lib/shapes.js`. QA каждого выхода — встроенный JS (`lib/qa/`).

`generators.root` (`sim-project.json` → `generators.root`, либо `MESH_STL_GENERATORS_ROOT`) выбирает
дерево скриптов: `package` (по умолчанию — `generators/` внутри этого пакета) или `project`
(исследовательское `geometry/` через `projectScript`/`projectPreset`). Пресеты — `generators/presets/<family>/`.
Дополнительные деревья скриптов задаются в `sim-project.json.geometry.scriptRoots` (абсолютные пути):
резолвер вернёт `resolvedFrom`; project-relative путь ищется в проекте первым.

## Семейства генераторов (`data/generators.json`)

| id | скрипт (`generators.root = package`) | пресеты |
|---|---|---|
| `fcc-cell` | `generators/pore_cell/gen_fcc_cell.py` | `generators/presets/pore_cell/fcc_cell_d5*.json` |
| `channel-spheres` | `generators/pore_cell/gen_channel_spheres.py` | `generators/presets/pore_cell/channel_spheres_*.json` |
| `double-layer-burner` | `generators/pore_cell/gen_double_layer_burner.py` | `generators/presets/pore_cell/double_layer_burner_*.json` |
| `blob-foam` | `generators/pore_cell/gen_blob_foam.py` | `generators/presets/pore_cell/blob_foam_*.json` |
| `packing` | `generators/packings/gen_packing_table.py` → `gen_packing_stl.py` | `generators/presets/packings/*.json` |
| `cad-porous` | `generators/cad/gen_cq_porous.py` (+ `py_qa.py`) | `generators/presets/cad/*.json` |
| `primitive` | JS `lib/primitives.js` | `data/primitives/*.json` |
| `stratified-channel` | JS `lib/generators/stratified.js` | `generators/presets/stratified/*.json` |
| `box-array` | JS `lib/generators/box-array.js` | `generators/presets/box-array/*.json` |

При `generators.root = "project"` python-семейства берут `projectScript`/`projectPreset` из
исследовательского дерева (`geometry/pore_cell/...`), то есть старый режим сохраняется.

Каждый запуск: копия/мердж `params.json` → шаги генератора → лог на шаг в `<outDir>/logs/` →
QA каждого объявленного выхода (JS по умолчанию) → возврат `{ok, files[{path, qa}], commands, next}`.

## Карточки знаний (`data/hints/*.json`)

`snappy.json` — ловушки мешинга, влияющие на геометрию (minVol, единицы, пятна на плоскостях домена,
уровень интерфейса, слои, `castellatedBufferLayer`, `symmetry`); `geometry.json` — контракт STL, чистка,
тесселяция CadQuery, правило зазора, непригодность тетра gmsh, именованные патчи, единицы.

Формат карточки: `id`, `title`, `topics[]`, `status` (`verified|derived|unverified`), `when`, `statement`,
`recipe[]`, `evidence[]`, `improves[]`. Поиск — по словам с лёгким стеммингом, точное совпадение весит больше.

## Как расширять (без правки кода)

- **Добавить семейство**: объект в `data/generators.json` — `script`, `presets.dir`, `preset.include`
  (glob, чтобы не показывать чужие пресеты), `args` с плейсхолдерами `{paramsFile} {outDir} {json}
  {rawOut} {cleanOut} {solidRawOut} {solidOut} {fluidRawOut} {fluidOut} {fluidPatchesOut} {ballsCsv}
  {contactsCsv} {packingJson}`, `outputs[{path, role, qa}]`, `steps[]` (несколько шагов с тем же контекстом).
- **Убрать семейство/маршрут**: удалить запись — инструмент перестанет его предлагать.
- **Добавить знание**: JSON-карточка в `data/hints/`; `statement` — проверяемый факт, `evidence` — номера
  экспериментов и/или дословные ошибки.
- После правки: `node scripts/smoke.mjs` и перезапуск DSH.

## Границы

- Не строит сетки (это `mesh-build`) и не запускает решатели.
- Не «починяет» параметры молча: если генератор упал — возвращается `failure` с хвостом лога и путём к полному логу.
- Числа в карточках — из журнала проекта (`journal/EXPERIMENTS.md`, `journal/DECISIONS.md`), а не по памяти.
