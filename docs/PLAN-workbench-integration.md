# План интеграции: dsh-mesh-toolkit ↔ dsh-openfoam-workbench

Документ-спутник нормативного [`WORKBENCH-CONTRACT.md`](WORKBENCH-CONTRACT.md). Здесь — анализ
актуальной версии workbench, сравнение с нашим пакетом, методика переноса того, что у них сделано
лучше, и пообъектный план работ для обеих сторон.

Дата анализа: **2026-11-26**. Проверенные версии: workbench **0.9.22** установлен / **0.9.23** в
апстриме; mesh-toolkit **0.5.4 / 0.3.6 / 0.4.4** (mesh-build / mesh-stl / sim-core).

---

## 1. Что проверено и откуда взяты факты

| Источник | Что дал |
|---|---|
| `~/.dsh/profiles/web/node_modules/@yakovlev-i-a/dsh-openfoam-workbench` (0.9.22) | `package.json` (64 инструмента, 11 скиллов, Apache-2.0, `engines.dsh ">=0.2.2-rc.1"`), `lib/*.js` ≈6.2 тыс. строк, `lib/tools/{env,case,run,build,mesh,render,papers,experience,meta}.js` |
| GitHub API `repos/yakovlev-i-a/dsh-openfoam-workbench` | теги `v0.9.23` (2026-11-26T07:31:04Z), `v0.9.22`, `v0.9.21`; описание «63 tools, 11 skills»; README «v0.9.22 · 64 tools · 11 skills · 161 tests»; **v0.9.23 = только усиление write-gate** (фигурные скобки в значениях, все `#`-директивы критичны, инвариант числа `;`, whitelist аргументов, `clean(force:true)` через approval), 165 тестов — набор инструментов и мешинг не менялись |
| `lib/meshlib.js`, `lib/tools/mesh.js`, `lib/tools/build.js`, `lib/registry.js`, `CORE.md`, `skills/*` | фактическое поведение примитивов, `mesh_plan`, `mesh_verify`, `mesh_stl_check`, y+-калькулятора, capability-матрицы |
| `grep` по установленному пакету | workbench **не** ссылается на `dsh-mesh-toolkit`, не вызывает `ctx.provide(...)`; сервисы читает лениво (`ctx.get('approval')`) |
| DSH 0.2.2-rc.5 (`@deepseek-ai/dsh-tools`, Cordis) | `ToolsService.get(name, scope)` → определение инструмента с `execute`; сервисы — `ctx.provide` / `ctx.get` |
| наш пакет (код + `benchmark/runs/20261125-1805/REPORT.md`) | 9 семейств STL, JS-QA с паритетом 15/15, маршруты snappy/cfmesh/gmsh, шлюз качества, поставка, 35 карточек |

Версии сверены не «по памяти»: установленный пакет прочитан, теги и релизы получены через API,
число инструментов взято из `package.json` (64) и сверено с README.

---

## 2. Инструменты геометрии и мешинга у workbench

| Инструмент | Что делает | Замечания |
|---|---|---|
| `openfoam_stl_generate` | примитивы **box / sphere / cylinder / cone / pipe**, `parts[]` с `translate`/`rotate_deg`/`scale` | конус и труба — то, чего у нас нет; `parts[]` — композиция без CAD |
| `openfoam_mesh_box_stl` | STL-коробка внешнего домена | геометрия домена, не физика |
| `openfoam_stl_inspect` | треугольники, bbox, центроид, объём, площадь, watertight | watertight только до 200 тыс. треугольников |
| `openfoam_stl_render` | PNG через pvpython | удобно для «глазной» проверки |
| `openfoam_geom_verify` | watertight / положительный объём / bbox-vs-ожидание | чек-лист, без починки |
| `openfoam_compute_first_layer` | Re → Cf → u_τ → толщина первого слоя, число слоёв, полная толщина | y+ → слои, у нас отсутствует |
| `openfoam_mesh_plan` | домен `external` (3L/5L/3L/3L) / `internal` / `wrap` (по умолчанию) / `box`, `target_cell_size` (default L/30) → `blockMeshDict` + `snappyHexMeshDict` + словарь фич по дистрибутиву | `needs_input` при подозрении на единицы (`scaleAskAbove` = 0.1 м); в `meshQualityControls` жёстко `minVol 1e-13`, `maxNonOrtho 65`, `minTwist 0.02`; фон `maxGlobalCells 8e6` |
| `openfoam_mesh_verify` | `checkMesh` по регионам, вердикт по строке «Mesh OK» | строгие пороги — только предупреждения («not a gate») |
| `openfoam_mesh_stl_check` | STL патчей → bbox/площадь/объём + приближённый Хаусдорф | поймал бы обрезание геометрии (наш DEF-11) |
| `openfoam_patch_diff`, `openfoam_dict_set`, `openfoam_check`, `openfoam_case_scaffold` | диф патчей, правка словарей, «доктор» кейса, скелет кейса (`incompressible`/`compressible`/`cht`) | `case_scaffold` читает уже существующий `polyMesh/boundary` |

### 2.1. Инструкции, которые у них предписаны (скилл `openfoam-meshing`)

Текст скилла задаёт жёсткий порядок и два правила, которых у нас нет как явных инструкций:

```
1. stl_inspect          → треугольники, bbox, watertight
2. stl_render           → глазами проверить нормали/замкнутость
3. compute_first_layer  → толщина первого слоя из y+
4. mesh_plan            → domain.type обязателен (external/internal/box), first_layer_thickness
5. blockMesh            → mesh_verify
6. snappyHexMesh        → mesh_verify
7. patch_diff           → inlet/outlet/walls вырезаны
8. mesh_stl_check       → Хаусдорф к исходному STL
```

Правила из раздела Pitfalls, которые стоит перенести к нам:

- «Нет `domain.type` → неверный расчётный домен» — у нас `domain` задаётся явными `domainMin/Max`,
  то есть ошибка невозможна, но и «домен по типу» недоступен (см. A6).
- «После 3 неудачных snappy — понижать: `strategy=coarsen` → `minimal` → `box_stl`» — прямой кандидат
  в нашу таблицу правок `mesh_revise` (категория `nonortho`/`resolution`).

Сравнение с нашими инструкциями (`plugins/mesh-stl/lib/skill.js`, `plugins/mesh-build/lib/skill.js`,
35 карточек `data/hints/*.json`, `docs/PORTABLE.md`): у нас есть порядок работы и жёсткие правила
(STL в мм, `minVol ≈ h_min³/6`, шлюз только через `mesh_check`, слои после castellation+snap,
`symmetry` на плоскостях домена), но нет четырёх шагов, которые у них оформлены как обязательные:

1. **шаг «y+ → первый слой»** перед планом сетки;
2. **шаг «диф патчей»** (`patch_diff`): проверить, что inlet/outlet/walls действительно вырезаны;
3. **шаг «сверка сетки с STL»** (bbox/площадь/объём/Хаусдорф);
4. **правило понижения** после серии неудач (вместо повтора тех же настроек).

Это ровно пункты A5, A7, A6 и строки 16/A3 в таблицах ниже — то есть расхождение инструкций и
расхождение кода совпадают, и закрываются они одними и теми же работами.


Сильные стороны, которых у нас нет или которые у нас слабее:

1. **Примитивы конуса и трубы** + композиция `parts[]` с трансформациями.
2. **y+ → слои** как отдельный расчёт, связанный со скаффолдом.
3. **Режимы домена** с множителями от габарита и `target_cell_size` → число ячеек фона.
4. **Подозрение на единицы** (`scaleAskAbove`) — спрашивает, а не продолжает молча.
5. **Проверка соответствия сетки STL** (bbox/площадь/объём/Хаусдорф).
6. **Capability-матрица** по дистрибутивам, меняющая имена словарей и ключи.
7. **Golden-кейсы + docker CI** (cavity, sphereBox, sphereCht, pitzDaily) как методика регрессии.

Чего у них нет и что остаётся нашим преимуществом: параметрические поровые семейства с пресетами,
JS-QA STL с паритетом к python, маршруты cfMesh/gmsh, **шлюз качества с профилями и абсолютным `minVol`**,
паспорт свежести, поставка (OF-кейс + ANSYS `.msh` + отчёт), 35 карточек знаний, портативный режим.

Отдельно: их `snappyHexMeshDict` пишет `minVol 1e-13` жёстко — на поровых ячейках это ровно та
ловушка, из-за которой у нас в benchmark появился `minVol = h_min³/6` и совет `minVolume/12`.
Поэтому «шлюз» мы им не отдаём: они остаются потребителем нашего вердикта.

---

## 3. Методика переноса (правило выбора способа)

Для каждого пункта из §2 выбирается **один** из трёх способов:

| Способ | Когда | Что делаем |
|---|---|---|
| **R — re-implement** | логика короткая, спецификация известна, код чужой (Apache-2.0 против нашего MIT) | пишем своё по спецификации, без копирования; закрываем тестом с числовым эталоном |
| **C — contract** | функция нужна обеим сторонам, но живёт на границе | фиксируем в `WORKBENCH-CONTRACT.md` (схема/поле/enum), реализуем у себя, workbench читает |
| **L — leave** | функция принадлежит решателю/физике | не трогаем, оставляем workbench; у нас — только приём результата |

Правила, обязательные при любом способе:

1. **Никакого копирования кода** workbench: Apache-2.0 совместим с MIT, но требует сохранения
   уведомлений; проще и чище — реализовать поведение по спецификации (все нужные формулы и пороги
   зафиксированы в §2 этого документа).
2. **Сначала тест, потом код**: для каждого перенесённого элемента — числовой эталон (для y+ —
   пример из их README/тестов; для Хаусдорфа — пара STL, где расхождение известно заранее).
3. **Обратная совместимость**: новые поля — только необязательные; существующие инструменты и их
   ответы не меняются.
4. **Независимость**: ни один перенос не создаёт обязательной зависимости от workbench.

---

## 4. Что берём и как

| # | Функция | Способ | Куда | Оценка |
|---|---|---|---|---|
| 1 | Конус и труба (внешняя/внутренняя стенка) | R | `mesh-stl/lib/shapes.js` + `primitive` | 0.5 д |
| 2 | `parts[]` с `translate`/`rotate_deg`/`scale` | R | там же, + схема параметров | 1 д |
| 3 | y+ → первый слой/число слоёв | R | новый `mesh_layers` (mesh-build) + привязка к `scaffoldOptions` | 0.5 д |
| 4 | Режимы домена `external/internal/box/wrap` + `target_cell_size` | R | `mesh_build` scaffold (`domain.type`, `margins`, `targetCells`) | 1 д |
| 5 | Подозрение на единицы (`scaleAskAbove`) | R | `precheck.js` + `needs_input`-ответ инструмента | 0.5 д |
| 6 | STL-vs-сетка (bbox/площадь/объём/Хаусдорф) | R | новый `mesh_surface_check` | 1.5 д |
| 7 | Capability-матрица (имена словарей/ключи) | R | `mesh-build/lib/caps.js`, использовать в scaffold | 1 д |
| 8 | Golden-кейс регрессия в CI | R (методика) | CI: A1-куб 2584 ячейки, `mesh/a1` 32 718, E1 75 024 | 0.5 д |
| 9 | Проверка ролей патчей | C | `mesh_patch_types` + `handoff.patches[].role` | 1 д |
| 10 | Цикл «диагноз → правка → пересборка» | C | `mesh_revise` + `mesh-feedback/1` | 1.5 д |
| 11 | Передача кейса | C | `handoff.json` в поставке | 1 д |
| 12 | Сервис `meshToolkit` | C | `ctx.provide('meshToolkit', …)` | 1 д |
| 13 | Проверка ролей и BC на стороне workbench | L | остаётся workbench | — |
| 14 | Запуск решателя, y+ по результатам, диагноз сходимости | L | остаётся workbench | — |
| 15 | Защитный слой записи/запуска (whitelist, approvals) | L | у нас не пишется `0/` и не запускается решатель | — |
| 16 | Понижение стратегии после 3 неудачных snappy (`coarsen` → `minimal` → `box_stl`) | R | таблица правок `mesh_revise` (данные) | 0.5 д |

Итого часть A ≈ **8–10 дней** с тестами и документацией.

---

## 5. Видение: «полное содружество»

```
пользователь ──задача──► dsh-openfoam-workbench (физика, BC, цели)
                              │  MeshRequest
                              ▼
                    dsh-mesh-toolkit (геометрия → сетка → шлюз → поставка)
                              │  handoff.json + кейс
                              ▼
                    dsh-openfoam-workbench (scaffold, openfoam_check, короткий прогон)
                              │  MeshFeedback (y+, non-ortho, роли патчей, разрешение…)
                              ▼
                    dsh-mesh-toolkit (mesh_revise: детерминированная таблица правок)
                              │  attempt += 1, новый handoff.json
                              └────────► повтор до PASS или лимита попыток → эскалация
```

Ключевые принципы:

- **Роли не размываются**: сетка и её качество — наши; физика, словари решателя и прогон — их.
- **Всё воспроизводимо файлами**: `handoff.json` + кейс на диске; сервис только ускоряет.
- **Цикл ограничен**: `attempt` (по умолчанию 3, максимум 8) и таблица правок — детерминированные,
  без «умных» догадок; при исчерпании — 2–4 варианта пользователю с ценой и эффектом.
- **Обе стороны самостоятельны**: workbench без нас работает своим `mesh_plan` + `mesh_verify`;
  мы без workbench отдаём кейс, который открывается в ParaView и в Fluent.

---

## 6. Часть A — работы в dsh-mesh-toolkit

### A1. `handoff.json` в поставке (C)

- Писатель `plugins/mesh-build/lib/handoff.js`: `buildHandoff({caseDir, request, passport, patches, delivery})`.
- Пишется в `mesh_deliver` (рядом с `delivery_<name>.json`) и в `mesh_check` при `handoff:true`.
- Поля — по схеме `mesh-handoff/1` (см. контракт §3.2); роли патчей — из `mesh_patch_types` или
  эвристика по имени (`inlet|outlet|walls|symmetry|interface`), всё неопознанное — `unknown`.
- Приёмка: на `mesh/a1` handoff валиден, `quality.verdict == PASS`, `units.scale == 0.001`,
  `next[]` содержит готовый вызов `mesh_patch_types` для единственного патча `a1-cube`.

### A2. `mesh_patch_types` (C)

- Вход: `caseDir`, `roles: {inlet: [имена], outlet: [...], walls: [...], symmetry: [...], interface: [...]}`,
  `regions?`, `profile?` (перепроверка шлюза после правки), `dryRun`.
- Правит только `constant/<region>/polyMesh/boundary` (бэкап `.bak`), возвращает дифф
  `{before: {name: type}, after: …}` и обновлённый handoff.
- Отказ, если роль и тип несовместимы (`inlet` на `symmetry`), если патч не найден, если кейс
  multi-region и регион не указан.
- Приёмка: B1-кейс `fluid` (один патч `wall` 56 560 граней) → роли inlet/outlet/walls расставлены,
  повторный `mesh_check` даёт те же метрики (шлюз не зависит от типов патчей).

### A3. `mesh_revise` (C)

- Вход: `mesh-feedback/1`; выход: `{ok, attempt, changes[], handoff, caseDir}`.
- Таблица правок — **данные** (`plugins/mesh-build/data/advice.json`), не код: категория → параметр →
  коэффициент/шаг → потолок итераций (см. контракт §3.3).
- Практически: `mesh_revise` переводит feedback в частичный `MeshRequest` (переопределения sizing/layers/
  domain/route/patches) и вызывает `mesh_build` + `mesh_check` (+ `mesh_patch_types`, если категория
  `patch-roles`).
- Приёмка: намеренно испорченный y+ (слои выключены) → feedback(`yplus`) → T2 проходит за ≤2 попытки.
- Отдельное правило: после 3 неудачных сборок подряд с `nonortho`/`skewness` таблица переводит
  маршрут на более робастный (snappy → cfmesh), а не повторяет те же параметры: это дешёвая
  страховка от «бесконечного» цикла и она же зафиксирована в их скилле.

### A4. Примитивы `cone`/`pipe` и `parts[]` (R)

- `shapes.js`: `coneTriangles(r, h, sections)`, `pipeTriangles(rOuter, rInner, h, sections)`
  (внутренняя стенка + два кольцевых пояса), `composeTriangles(parts)` с `translate`/`rotateDeg`/`scale`.
- `primitive`-семейство: `shape: cone|pipe`, `parts: [{shape, params, translate, rotate_deg, scale}]`.
- Тесты: объём конуса `πr²h/3` ±2 %, труба `π(r_o²−r_i²)h` ±2 %, watertight для `parts[]`.

### A5. y+ → слои (R)

- Новый инструмент `mesh_layers` (`U_ref`, `L_ref`, `nu`, `yPlusTarget`, `expansionRatio`, `coverage`)
  → `{Re, Cf, uTau, delta, first_layer_m, n_layers, total_m}`.
- `mesh_build` принимает `scaffoldOptions.layers: {mode: "yplus", yPlusTarget, U_ref, L_ref, nu}` и
  подставляет `nSurfaceLayers`/`firstLayerThickness`/`expansionRatio` (сейчас слои задаются вручную).
- Приёмка: эталон из их теста (U=10, L=0.1, ν=1.5e-5, y+=1) — числа совпадают с точностью 1e-6
  относительно их формулы.

### A6. Домен и масштаб (R)

- `scaffoldOptions.domain: {type: "external|internal|box|wrap", margins: {upstream, downstream, lateral,
  vertical_top, vertical_bottom}, sizeFactor}`; `external` — множители от `L = max extent`.
- `targetCells`/`cellSize`/`cells`: при `targetCells` подбирать `cells` по габариту домена.
- `precheck.js`: `scaleSuspicion(bboxMm, {askAbove: 100 mm})` → ответ `{needs_input: [mm|m]}` вместо
  молчаливого обрезания.
- Приёмка: C1-сфера (домен 40×20×20 мм, 0.5 мм) → `cells [40,20,20]` из `cellSize 5e-4` и
  `targetCells ≈ 16 000` даёт тот же результат; STL в метрах → `needs_input`.

### A7. `mesh_surface_check` (R)

- Вход: `caseDir`, `stl` (эталон), `patches`, `tol` (по умолчанию 0.05).
- `surfaceMeshTriangulate -patches …` → STL, затем bbox/площадь/объём + приближённый Хаусдорф
  (сэмплирование центроидов эталона, `closestPtTriangle`).
- Приёмка: E1 с обрезанным доменом (наш DEF-11) → FAIL с `bboxRel ≈ 0.5`; A1 → PASS.

### A8. Capability-матрица (R)

- `plugins/mesh-build/lib/caps.js`: по `bashrc` определять распределение/версию и набор ключей
  (`scale` vs `convertToMeters`, `surfaceFeaturesDict` vs `surfaceFeatureExtractDict`,
  имена решательских словарей, наличие `cartesianMesh`) — сейчас это размазано по коду.
- Использовать в `scaffold.js` и в описании маршрутов; отдавать в `mesh_build` как `caps`.

### A9. Сервис и тесты (C)

- `plugins/mesh-build/lib/service.js`: `ctx.provide('meshToolkit', {apiVersion: 1, capabilities, generate,
  mesh, revise, patchTypes, gate, deliver})`, регистрация в `apply(ctx)`; ошибки — структурированные.
- `scripts/contract-test.mjs` (в репозитории): фиктивный «workbench» на fake-ctx прогоняет T1, T3, T5
  и проверяет, что без сервиса всё работает.
- CI: golden-кейс регрессия (A1 2584, `mesh/a1` 32 718, E1 75 024 с допуском ±1 %), плюс новые тесты A2–A7.

---

## 7. Часть B — работы в dsh-openfoam-workbench (для автора)

1. **B1. Обнаружение провайдера.** `const mesh = ctx.get('meshToolkit')` в момент вызова, проверка
   `apiVersion === 1`, при отсутствии — обычный путь (`openfoam_mesh_plan` + `openfoam_mesh_verify`) и
   пометка в отчёте `mesh.provider: "workbench-fallback"`.
2. **B2. `openfoam_mesh_request`.** Собирает `mesh-request/1` из физики (y+ через
   `openfoam_compute_first_layer`, домен, `targetCells`), вызывает `mesh.mesh(request)` либо fallback;
   возвращает `{caseDir, handoff, verdict}`.
3. **B3. `openfoam_mesh_feedback`.** Упаковывает диагноз в `mesh-feedback/1` (категория из enum,
   evidence — строки лога и метрики), вызывает `mesh.revise(feedback)`, возвращает `changes[]` и новый handoff.
4. **B4. Потребление `handoff.json`.** `openfoam_case_scaffold` на доставленном кейсе: роли патчей
   берутся из handoff (не угадываются по именам), перед записью BC — проверка, что все роли известны;
   иначе `needs_input`/`mesh_patch_types`. Поле `provenance: "mesh-toolkit@0.6.x"` в отчёте кейса.
5. **B5. Диагноз после прогона.** Маппинг сбоев (non-ortho предупреждения, y+ вне диапазона,
   «bounding box»/`patch` mismatches) в категории feedback с evidence; y+ — из `yPlus` function object
   или `openfoam_field_stats`, если поля нет — `minor` с подсказкой добавить.
6. **B6. Дедупликация.** При наличии провайдера `openfoam_mesh_plan` не вызывается для того же кейса;
   приоритет и запрет двойной сборки описаны в их README/скилле.
7. **B7. Тесты и независимость.** Contract-тесты T1–T6 в их CI с фиктивным провайдером; золотая
   матрица без провайдера остаётся зелёной; опциональный peer `dsh-mesh-toolkit` в `package.json`
   (не устанавливается автоматически).

---

### 7.1. Вопросы автору workbench (для критики и решения)

Эти пункты — не требования, а места, где нужен ваш выбор; они влияют на контракт
[`WORKBENCH-CONTRACT.md`](WORKBENCH-CONTRACT.md) и на часть A у нас.

1. **Роли патчей.** Согласны ли вы читать `handoff.patches[].role` в `openfoam_case_scaffold`
   вместо эвристики по именам (`inlet`/`outlet`/`walls`)? Если да — кто владеет ретипизацией:
   мы (`mesh_patch_types`) или вы (`openfoam_dict_set` с записью в отчёт)?
2. **Делегирование `mesh_plan`.** Готовы ли вы добавить провайдер-режим: при наличии сервиса
   `meshToolkit` (или файла `handoff.json`) `openfoam_mesh_plan` не пишет свои словари, а вызывает
   `mesh.mesh(request)`; fallback — текущее поведение? Это снимает двойную сборку.
3. **Сервис vs инструменты.** Вам удобнее Cordis-сервис `meshToolkit` (`ctx.get`) или вызов наших
   инструментов через `ToolsService.get('mesh_build')`? Мы можем предоставить оба, но хотим
   зафиксировать один основной путь.
4. **Единицы.** Ваш `scaleAskAbove` (0.1 м) — перенести в `sim-project.json` как общий параметр
   и фиксировать в `handoff.units.scale`? У нас уже есть портативный профиль без `sim-project.json`.
5. **Категории feedback.** Достаточно ли enum `yplus|nonortho|skewness|patch-roles|resolution|
   domain|units|layers|cells-budget|stl-quality`, или нужны ваши (`solver-divergence`, `boundedness`)?
   Мы готовы расширять таблицу правок данными.
6. **Golden-кейсы.** Можно ли добавить в ваш CI опциональный шаг «mesh-toolkit подключён» (наш
   `mesh_build` + `mesh_check` на вашем cavity/sphereBox), чтобы регрессия контракта шла у вас?
7. **Лицензии.** Мы реализуем поведение по спецификации (y+, Хаусдорф, режимы домена) без
   копирования кода: Apache-2.0 → MIT-совместимо, но так проще. Возражений нет?
8. **Именование.** `handoff.json` в корне кейса — не конфликтует ли с вашими артефактами
   (например, если `deliver/` уже занят)? Мы можем положить его в `deliver/handoff.json`.

## 8. Часть C — общий контракт

Уже зафиксирован в [`WORKBENCH-CONTRACT.md`](WORKBENCH-CONTRACT.md): три схемы (`mesh-request/1`,
`mesh-handoff/1`, `mesh-feedback/1`), enum ролей патчей, политика единиц, цикл с `attempt` и таблицей
правок, API сервиса, правила совместимости, приёмочные тесты T1–T6, явные non-goals.

Что нужно сделать по части C: положить JSON-схемы в `mesh-toolkit/schemas/` (у нас) и в
`dsh-openfoam-workbench/schemas/` (у автора), добавить обеим сторонам тест «схема ↔ пример handoff»,
и синхронизировать версию контракта при изменениях.

---

## 9. Независимость и совместимость

- **Нет жёсткой зависимости**: mesh-toolkit не импортирует workbench и не требует его; workbench
  работает без mesh-toolkit (fallback + своя золотая матрица).
- **Нет автоустановки**: только опциональный peer и документация «как включить».
- **Файловый контракт самодостаточен**: `handoff.json` + кейс читаются человеком и любым другим
  инструментом; сервис — ускорение.
- **Другие инструменты**: `dsh-ansys-fluent-workbench` (будущий) читает тот же handoff и `.msh` из
  поставки — контракт описывает роли патчей, а не имена решательских полей.
- **Ручной режим**: пользователь может вызвать `mesh_build`/`mesh_check`/`mesh_deliver` напрямую и
  передать кейс в workbench руками — это тот же путь, что и через сервис.

---

## 10. Вехи и оценка

| Веха | Содержание | Дни |
|---|---|---|
| M1 | A1 handoff + A9 сервис (каркас) + схемы | 2 |
| M2 | A2 `mesh_patch_types` + A3 `mesh_revise` (таблица правок) | 2 |
| M3 | A4 примитивы + A5 y+ + A6 домен/масштаб | 2 |
| M4 | A7 `mesh_surface_check` + A8 caps + тесты/CI | 2 |
| M5 | совместные T1–T5 с автором workbench | 1–2 |
| B | часть B у автора workbench | 4–5 |
| C | схемы и синхронизация | 1–2 |

Итог: **mesh-toolkit 1.0-rc** после M4, **1.0** — после зелёных T1–T5 и установки не-автором.

---

## 11. Риски и как их снимаем

| Риск | Снятие |
|---|---|
| Расхождение трактовок handoff | JSON-схемы + тест «схема ↔ пример» в обоих CI; версия контракта в handoff |
| Долгий `mesh()` и таймауты | `caseDir` сохраняется, статус в логах, таймаут = `blocked`, повтор с `attempt+1` |
| Двойная сборка (наш snappy vs их `mesh_plan`) | B6: приоритет провайдера, запрет второго прохода для того же кейса |
| Лицензии (Apache-2.0 против MIT) | только re-implement по спецификации, без копирования кода |
| Разные версии DSH/OpenFOAM | `apiVersion` + capability-матрица; при несовпадении — понятный отказ, не тихая деградация |
| Ложный «PASS» шлюза | шлюз остаётся нашим; workbench не переопределяет вердикт, только просит ревизию |
| Соблазн «умных» правок в цикле | таблица правок — данные с потолками итераций; каждое изменение в `changes[]` |

---

## 12. Что считаем готовым

1. `mesh_check` пишет `handoff.json`, валидный по схеме, с ролями патчей и `next[]`.
2. `mesh_patch_types` и `mesh_revise` проходят свои приёмки на реальных кейсах benchmark.
3. Сервис `meshToolkit` отвечает на fake-ctx тесте; ошибки структурированы.
4. T1 и T3 пройдены без workbench (у нас) и с фиктивным провайдером (у них).
5. Документация: `WORKBENCH-CONTRACT.md` + этот план + раздел «Портативный режим»/README без
   обещаний, которых код не выполняет.
