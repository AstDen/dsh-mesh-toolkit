# WORKBENCH-CONTRACT — dsh-mesh-toolkit ↔ dsh-openfoam-workbench

> Анализ, сравнение с текущей реализацией и пообъектный план работ — в
> [`PLAN-workbench-integration.md`](PLAN-workbench-integration.md).

Нормативный документ для двусторонней интеграции. Версия контракта: **1** (`mesh-handoff/1`,
`mesh-request/1`, `mesh-feedback/1`). Обе стороны реализуют его независимо; ни одна не обязана
устанавливать другую.

- Автор контракта и владелец стороны «геометрия/сетка»: **dsh-mesh-toolkit** (`mesh-stl`, `mesh-build`, `sim-core`).
- Владелец стороны «физика/решатель»: **dsh-openfoam-workbench**.
- Принцип: **файл первичен, сервис — ускорение**. Любая передача воспроизводима через `handoff.json`
  на диске; Cordis-сервис избавляет от ручных вызовов инструментов, но не является обязательным.

---

## 1. Роли и границы

| Область | mesh-toolkit | openfoam-workbench |
|---|---|---|
| Параметрическая геометрия (поровая, засыпки, каналы, TPMS) | **владелец** | — |
| Простые примитивы (box/sphere/cylinder/cone/pipe, parts[]) | владелец после A5 | дублирует как fallback |
| Контракт STL (watertight, нормали, мм), чистка, реестр | **владелец** | только читает вердикт |
| Объёмная сетка (snappy/cfMesh/gmsh), слои, CHT-регионы | **владелец** | snappy-fallback, если toolkit не установлен |
| Шлюз качества (абсолютные пороги, профили, паспорт) | **владелец** | не переопределяет вердикт |
| Типы патчей и роли (inlet/outlet/wall/symmetry/interface) | **владелец** (`mesh_patch_types`) | может переопределить явно и записать в отчёт |
| Поставка (OF-кейс + ANSYS `.msh` + отчёт) | **владелец** | читает `handoff.json`, ничего не пакует |
| Словари решателя (`0/`, `fvSchemes`, `fvSolution`, `constant/*`) | **не пишет** | **владелец** |
| Запуск решателя, сходимость, y+ по результатам расчёта | **не запускает** | **владелец** |
| Диагноз «сетка виновата / физика виновата» | принимает `mesh-feedback` | **владелец** диагноза |

Жёсткие запреты:

1. mesh-toolkit **никогда** не пишет в `0/`, `fvSchemes`, `fvSolution`, `constant/*` (кроме `polyMesh`,
   `triSurface`, `extendedFeatureEdgeMesh`) и не запускает решатель.
2. workbench **никогда** не правит `constant/polyMesh/*` и не меняет `polyMesh/boundary` молча:
   любое перетипизирование — либо через `mesh_patch_types`, либо `openfoam_dict_set` с записью в отчёт
   (`handoff.patches[].retypedBy = "openfoam-workbench"`).
3. Ни одна сторона не импортирует внутренние модули другой; единственные точки связи —
   `handoff.json`, JSON-схемы из §3 и (опционально) сервис из §5.

---

## 2. Поток работы (целевой сценарий)

```
пользователь → workbench: задача расчёта (физика, BC, цели)
workbench:      MeshRequest  ─────────────►  mesh-toolkit: geometry → mesh → gate → deliver
                                                 │
workbench:      читает handoff.json  ◄───────────┘   (кейс уже содержит polyMesh + типизированные патчи)
workbench:      openfoam_case_scaffold на доставленном кейсе → openfoam_check → короткий прогон
workbench:      диагноз: y+, non-ortho, patch roles, разрешение, домен, единицы
workbench:      MeshFeedback  ────────────►  mesh-toolkit: mesh_revise (детерминированная таблица правок)
                                                 │
                до N попыток (по умолчанию 3, максимум 8) → новый handoff.json
                │
                └─► workbench снова пробует расчёт; при исчерпании попыток — эскалация пользователю
                    с вариантами (крупнее/мельче/другой маршрут/другой домен)
```

Инварианты цикла: у каждого запроса есть `requestId`; каждая ревизия увеличивает `attempt`;
в `handoff.history[]` копится, что и почему менялось; повторный вызов с теми же входами не должен
менять результат (детерминизм параметров; `seed` фиксируется в `geometry.spec`).

---

## 3. Схемы

Все схемы — JSON Schema draft 2020-12, публикуются в `mesh-toolkit/schemas/` и зеркалятся
в workbench. Поля, помеченные `*`, обязательны.

### 3.1 `mesh-request/1` (workbench → mesh-toolkit)

```json
{
  "schemaVersion": "mesh-request/1",
  "requestId": "wf-2026-11-26-0001",
  "attempt": 0,
  "intent": "mesh-for-solver",
  "geometry": {
    "kind": "parametric | stl",
    "family": "channel-spheres",
    "preset": "channel_spheres_L3",
    "params": { "gap_mm": 0.05 },
    "stl": "stl/b1/fluid.clean.stl",
    "units": "mm",
    "seed": 11,
    "sha256": "…"
  },
  "domain": {
    "type": "external | internal | box | wrap",
    "margins": { "upstream": 3, "downstream": 5, "lateral": 3, "vertical_top": 3, "vertical_bottom": 3 },
    "sizeFactor": 1.0,
    "bboxMin": [0, 0, 0],
    "bboxMax": [0.02, 0.02, 0.02]
  },
  "sizing": {
    "kind": "cellSize | cells | auto",
    "cellSize_m": 0.0002,
    "cells": [44, 44, 44],
    "targetCells": 700000,
    "maxCells": 5000000,
    "refinement": { "surface": [1, 2], "feature": 2, "interfaces": 2 }
  },
  "layers": {
    "mode": "none | yplus | explicit",
    "yPlusTarget": 30,
    "U_ref": 12.5,
    "L_ref": 0.01,
    "nu": 1.5e-5,
    "nLayers": 5,
    "firstLayer_m": 2e-5,
    "expansionRatio": 1.2
  },
  "route": { "preferred": ["snappy", "cfmesh", "gmsh"], "openfoam": "com2512" },
  "gate": { "profile": "project", "minVol": null },
  "regions": [{ "name": "fluid", "kind": "fluid" }, { "name": "solid", "kind": "solid" }],
  "delivery": { "enabled": true, "name": "case-001", "ansys": true },
  "feedback": { "categories": [], "evidence": [] }
}
```

Правила: `geometry.kind=parametric` требует `family`; `stl` — путь относительно корня проекта
(абсолютные допустимы). `sizing.kind=auto` означает «mesh-toolkit выбирает по геометрии и `targetCells`»
и обязан вернуть выбранные значения в `handoff.mesh.selection`. `layers.mode=yplus` требует
`U_ref`, `L_ref` и допускает `nu` по умолчанию 1.5e-5.

### 3.2 `mesh-handoff/1` (mesh-toolkit → workbench, файл `<caseDir>/handoff.json`)

```json
{
  "schemaVersion": "mesh-handoff/1",
  "requestId": "wf-2026-11-26-0001",
  "attempt": 0,
  "producer": {
    "plugin": "mesh-build",
    "version": "0.6.0",
    "openfoam": { "distribution": "com", "version": "v2512", "bashrc": "/usr/lib/openfoam/openfoam2512/etc/bashrc" }
  },
  "units": { "stl": "mm", "case": "m", "scale": 0.001 },
  "geometry": {
    "kind": "parametric",
    "family": "channel-spheres",
    "stl": "constant/triSurface/fluid.stl",
    "sha256": "…",
    "bbox_m": { "min": [-0.001, -0.001, -0.0135], "max": [0.0045, 0.0045, 0.0081] },
    "volume_m3": 1.627e-10,
    "qa": { "verdict": "PASS", "watertight": true, "bodies": 1 }
  },
  "mesh": {
    "route": "snappy",
    "selection": { "cellSize_m": 0.0002, "cells": [18, 18, 72], "levels": { "fluid": 2 }, "defaultLevel": 1 },
    "cells": 202440,
    "points": 242540,
    "faces": 647234,
    "regions": ["fluid"],
    "layers": { "nLayers": 0, "coverage": null }
  },
  "quality": {
    "profile": "project",
    "minVol": 5e-14,
    "verdict": "PASS",
    "maxNonOrtho": 14.6088,
    "avgNonOrtho": 2.40614,
    "maxSkewness": 0.680732,
    "minVolume": 3.222e-13,
    "violations": [],
    "passport": { "path": "mesh-passport.json", "status": "fresh", "createdAt": "…" }
  },
  "patches": [
    { "region": null, "name": "fluid", "type": "wall", "role": "wall", "nFaces": 56560, "area_m2": 1.2e-4 }
  ],
  "domain": { "type": "box", "bbox_m": { "min": […], "max": […] }, "locationInMesh": [0.0017, 0.0017, -0.003] },
  "recommendations": {
    "suggestedFamily": "incompressible",
    "suggestedSolverSetup": { "algorithm": "SIMPLE", "turbulence": "laminar" },
    "yPlus": { "target": null, "firstLayer_m": null },
    "notes": ["patch fluid is walls only: retype inlet/outlet before a flow run (mesh_patch_types)"]
  },
  "files": { "case": ".", "polyMesh": "constant/polyMesh", "handoff": "handoff.json", "delivery": "deliver/delivery_case-001.json" },
  "history": [],
  "next": [
    { "tool": "mesh_patch_types", "args": { "caseDir": ".", "roles": { "inlet": [], "outlet": [], "walls": ["fluid"] } } }
  ]
}
```

Обязательные условия валидности handoff: `quality.verdict == "PASS"` (иначе workbench не должен
запускать расчёт, а обязан вызвать `mesh_revise`); `units.scale` соответствует реально записанному
`scale`/`convertToMeters` в `system/blockMeshDict`; каждый патч имеет `role` из перечисления
`inlet | outlet | wall | symmetry | cyclic | empty | interface | wedge | unknown`;
`next[]` содержит готовые к вызову инструменты, если что-то осталось незавершённым.

### 3.3 `mesh-feedback/1` (workbench → mesh-toolkit)

```json
{
  "schemaVersion": "mesh-feedback/1",
  "requestId": "wf-2026-11-26-0001",
  "attempt": 1,
  "caseDir": "cases/case-001",
  "category": "yplus | nonortho | skewness | patch-roles | resolution | domain | units | layers | cells-budget | stl-quality",
  "severity": "blocker | major | minor",
  "evidence": {
    "tool": "openfoam_check",
    "log": ["… last 20 lines …"],
    "metrics": { "maxNonOrtho": 68.2, "yPlusMax": 480, "yPlusAvg": 210, "cells": 202440, "runtime_s": 41 }
  },
  "expected": { "yPlusMax": 100, "maxNonOrtho": 60 },
  "changes": { "cellSizeFactor": 0.7, "nLayers": 5, "route": "cfmesh" },
  "note": "свободный текст для человека"
}
```

Детерминированная таблица реакции (обязательна для обеих сторон, расширяется данными, не кодом):

| category | действие mesh-toolkit | потолок |
|---|---|---|
| `yplus` | пересчитать слои: `firstLayer = y+·ν/u_τ` (та же корреляция, что `compute_first_layer`), включить layers | 3 итерации |
| `nonortho` | +1 уровень на поверхности/интерфейсе, затем уменьшить `nLayers`, затем сменить маршрут snappy→cfmesh | 3 итерации |
| `skewness` | локальное измельчение поверхности, `resolveFeatureAngle` меньше, snap iterations выше | 2 итерации |
| `patch-roles` | `mesh_patch_types` по карте ролей; повторная проверка gate | 1 итерация |
| `resolution` | `cellSize × 0.7` (или +1 уровень), пересчёт бюджета ячеек | 2 итерации |
| `domain` | множители домена +25 % в указанную сторону (blockage), перестройка | 1 итерация |
| `units` | потребовать подтверждения масштаба, перестроить с явным `scale` | 1 итерация |
| `layers` | уменьшить `nLayers`/`expansionRatio`, включить `minTwist` из профиля | 2 итерации |
| `cells-budget` | coarsen до `maxCells`, при неудаче — cfmesh | 1 итерация |
| `nonortho`×3 подряд | понижение стратегии сборки: snappy → cfmesh (вместо повтора тех же параметров) | 1 итерация |
| `stl-quality` | `stl_check` + `cleanup`, при провале — вернуть FAIL с причиной | 1 итерация |

Каждая ревизия возвращает `changes[]` (что реально изменилось) и новый `handoff.json`;
`history[]` пополняется записью `{attempt, category, changes, verdict}`.

### 3.4 Эскалация

После `attempt >= maxAttempts` mesh-toolkit возвращает `{ok:false, escalated:true, options:[…]}`,
где `options` — 2–4 взаимоисключающих варианта с ценой (ячейки/время) и ожидаемым эффектом.
workbench показывает их пользователю через `ask_user_question`; выбор фиксируется в
`requestId` (новый attempt).

---

## 4. Единицы и масштаб

1. STL — **всегда мм**; кейс OpenFOAM — **всегда метры**; `scale 0.001` (com: `convertToMeters`).
2. `handoff.units.scale` — фактически записанное значение; workbench обязан сверять его с
   `system/blockMeshDict` и падать с понятной ошибкой при расхождении.
3. Подозрение на единицы: если максимальный габарит STL > `scaleAskAbove` (по умолчанию 0.1 м
   в пересчёте на мм — 100 мм) или `< 1e-5`, инструмент **спрашивает** (mm/m), а не продолжает
   молча. Это правило взято у workbench (`scaleAskAbove`, `needs_input`) и обязательно для обеих сторон.
4. `locationInMesh` — в метрах; handoff хранит его в метрах и дублирует в мм в
   `recommendations.notes` для человека.

---

## 5. Сервис (опциональное ускорение)

mesh-toolkit предоставляет Cordis-сервис `meshToolkit` (имя стабильно, `apiVersion: 1`):

```js
// provided by mesh-build
ctx.provide('meshToolkit', {
  apiVersion: 1,
  capabilities: () => ({ families: [...], routes: [...], gateProfiles: [...], features: ['handoff','patch-types','revise','surface-check'] }),
  generate: async (request) => ({ requestId, stl, qa }),            // §3.1 geometry
  mesh: async (request) => ({ requestId, handoff, caseDir }),      // §3.1 → §3.2 (полный цикл)
  revise: async (feedback) => ({ requestId, attempt, handoff, changes }),
  patchTypes: async ({ caseDir, roles }) => ({ patches, handoff }),
  gate: async ({ caseDir, profile, minVol }) => ({ verdict, metrics, passport }),
  deliver: async ({ caseDir, name, minVol }) => ({ delivery, handoff }),
})
```

Правила:

- workbench получает сервис **в момент вызова**: `ctx.get('meshToolkit')` (bootstrap order свободный),
  проверяет `apiVersion === 1`; при отсутствии или несовместимой версии работает своим путём
  (`openfoam_mesh_plan` + `openfoam_mesh_verify`) и сообщает в отчёте `mesh.provider: "workbench-fallback"`.
- mesh-toolkit не ищет workbench и не зависит от него; сервис предоставляется, даже если workbench
  не установлен.
- Ошибки сервиса — структурированные `{ok:false, error, phase, next[]}`; никаких исключений через границу.
- Время: `mesh()` может длиться минуты; вызывающая сторона обязана иметь таймаут и трактовать
  таймаут как `blocked` с сохранённым `caseDir` (сетка не удаляется, прогресс виден в логах).

---

## 6. Совместимость и версионирование

- `apiVersion` — целое; несовпадение = отказ с подсказкой обновить пакет.
- Схемы `*/1` расширяются только добавлением необязательных полей; удаление/переименование —
  новая версия (`handoff/2`), обе поддерживаются один минорный релиз.
- Пакеты объявляют **опциональный** peer: workbench — `dsh-mesh-toolkit` (не устанавливается
  автоматически), mesh-toolkit — ничего (остаётся независимым).

---

## 7. Приёмка контракта (двусторонние тесты)

| id | сценарий | критерий |
|---|---|---|
| T1 | parametric → mesh → gate → handoff → `openfoam_case_scaffold` на доставленном кейсе → `openfoam_check` | PASS без ручных правок; патчи в BC совпадают с `handoff.patches` |
| T2 | заведомо плохой y+ → feedback(`yplus`) → `revise` → повторный прогон | PASS ≤ 2 попыток; `changes[]` объясняет правку |
| T3 | независимость | workbench без toolkit: его golden-матрица зелёная; toolkit без workbench: CI зелёный |
| T4 | единицы | STL в метрах → `needs_input`/отказ, а не молчаливое обрезание геометрии |
| T5 | роли патчей | `mesh_patch_types` → handoff roles → BC в scaffold; повторный gate не изменил метрики |
| T6 | таймаут | прерванный `mesh()` не оставляет кейс в состоянии «нельзя продолжить» |

---

## 8. Чего контракт не покрывает

- Передачу полей/результатов расчёта (это область workbench и постобработки).
- Совместное использование с `dsh-ansys-fluent-workbench`: контракт ему совместим (роли патчей
  и `.msh` в поставке), но отдельная спецификация не выпускается до появления такого пакета.
- Автоматическую установку пакетов друг друга.
