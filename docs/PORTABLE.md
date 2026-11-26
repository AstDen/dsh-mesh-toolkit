# Портативный режим: работа без `sim-project.json`

Плагины **mesh-stl** и **mesh-build** работают в пустом каталоге. Профиль проекта
(`sim-project.json`) больше не обязателен: он нужен только там, где вы хотите зафиксировать
свои пути, единицы, пороги шлюза и установки OpenFOAM.

## Что включается автоматически

| Что | По умолчанию без профиля | Как переопределить |
|---|---|---|
| Корень проекта | текущий каталог (`process.cwd()`) | `sim-project.json`, `projectRoot` в конфиге, `MESH_*_PROJECT_ROOT` |
| Метка в ответе | `project: "defaults"`, `configured: false` | `sim-project.json` → `project: "<имя>"` |
| Единицы STL | мм | `sim-project.json` → `units` |
| Реестр STL | `./stl/registry.csv` (заголовок создаётся при первой записи) | `geometry.registry`, `MESH_STL_REGISTRY` |
| Выход генераторов | `./stl/generated/<family>/` | `geometry.workRoot`, `workRoot` |
| Кейсы мешинга | `./cases/` | `caseRoots` |
| Профиль шлюза | `project` (nonOrtho 60, skewness 4/2, minVolRatio 0.05) | `gate.profile`, `gate.profiles` |
| Порог `minVol` | не задан → проверка отключена и об этом сказано в `advisory` | `gate.minVol` или аргумент `minVol` (абсолютный, `h_min³/6`) |
| Скрипт поставки | пакетный `scripts/deliver/make_delivery.sh` внутри бандла | `tools/deliver/make_delivery.sh` в проекте имеет приоритет |
| Кэш шлюза поставки | `<outDir>/.gate` (через `MESH_GATE_CACHE_DIR`) | та же переменная окружения |

## Сквозной сценарий (проверен 2026-11-26)

```bash
mkdir my-case && cd my-case

# 1. Геометрия (JS, без python)
stl_generate({ family: "primitive", name: "cube", params: { size_mm: [10, 10, 10] } })
#   → ./stl/generated/primitive/cube.stl, QA PASS, project: "defaults"

# 2. Контракт STL
stl_check({ stl: "stl/generated/primitive/cube.stl", expectVolume: 1000, expectArea: 600, expectBodies: 1 })
#   → verdict PASS, qa.engine "js"

# 3. Сетка
mesh_build({ route: "snappy", scaffold: true, caseDir: "cases/cube",
             stl: ["stl/generated/primitive/cube.stl"],
             openfoam: "/usr/lib/openfoam/openfoam2512/etc/bashrc",
             scaffoldOptions: { domainMin: [-0.002,-0.002,-0.002], domainMax: [0.012,0.012,0.012],
                                cells: [16,16,16], locationInMesh: [0.001,0.001,0.001], minVol: 1e-12 } })
#   → blockMesh → surfaceFeatureExtract → snappyHexMesh

# 4. Шлюз
mesh_check({ caseDir: "cases/cube", minVol: 1e-12, profile: "project" })
#   → gate.verdict PASS, passport fresh

# 5. Поставка
mesh_deliver({ caseDir: "cases/cube", name: "cube", minVol: 1e-12 })
#   → DELIVERED: openfoam_cube/ + .tar.gz + ansys_cube/ + .zip + delivery_cube.{json,md}
```

Контрольные числа этого прогона: 12 треугольников, объём 1000 мм³, 2584 ячейки,
`gate.verdict PASS` (maxNonOrtho 18.29°, skewness 0.2997), `DELIVERED`, 1.8 МБ артефактов.

## Где всё-таки нужен профиль

- **Установки OpenFOAM.** Без профиля список `foam.installations` пуст: передавайте
  `openfoam: "/path/to/etc/bashrc"` в `mesh_build` / `mesh_check` / `mesh_deliver`
  (или создайте `sim-project.json` — там же id `com2512`/`com2606`/`org14`).
- **Свои пороги шлюза.** `gate.profiles` (например, ослабить `maxNonOrtho` до 75) — только профиль.
- **Единицы не мм.** Явно `units` в профиле; иначе всё трактуется как миллиметры.
- **Многорегиональный CHT** — `caseRoots` и поставка по регионам описаны в профиле, но
  `mesh_deliver --regions/--multi-region` работает и без него.

## Диагностика

- `project: "defaults"` и `next` с подсказкой «working without sim-project.json» — это норма,
  а не ошибка: инструмент сообщает, какие значения по умолчанию применил.
- Реестр только для чтения — не ошибка: `registered: {ok: false, error, row}`, вердикт сохраняется.
- Нет `world`-патча после snappy — `phase: "sanity"`: `locationInMesh` попала внутрь замкнутого
  твёрдого тела; точку подбирает `mesh-build/scripts/fluid-point.py`.
