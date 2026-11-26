# План до релиза 1.0: снятие трёх блокеров

Состояние на 2026-11-26: код 0.5.1 опубликован (`master` = `d7ac1aa`, тег `v0.5.1`, Release есть).
Ниже — что осталось, чтобы toolkit можно было ставить на чужую машину и связывать с
`@yakovlev-i-a/dsh-openfoam-workbench` (0.9.20) без ручной правки путей.

Обозначения: ✅ сделано · 🟡 частично · ⬜ не начато. Оценки — в человеко-днях одного агента.

---

## Блокер 1. Привязка к исследовательскому проекту (🟡 2–3 дня: 1.1 готова)

Сейчас вне `Mesh_3D_pore_scale` работает только семейство `primitive`: остальное упирается
в `tools/qa/stl_qa.py`, `geometry/*.py`, `stl/registry.csv`, `caseRoots: experiments/...`.

### 1.1 QA STL внутри плагина (✅ готово, 2026-11-26) — главный кусок
Сделано в `mesh-stl/lib/qa/` (dependency-free ESM, без python и без проекта), версия пакета 0.3.2:
- `reader.js` — бинарный и ASCII STL, `mergeVertices` по 8 знакам (как `tol.merge` trimesh), для ASCII
  — с учётом нормали файла, как делает загрузчик trimesh; вырожденные треугольники сохраняются.
- `metrics.js` — watertight (каждое ребро ровно в 2 гранях), согласованность обхода (только рёбра
  с кратностью 2), тела = компоненты связности по граням через такие рёбра, объём по дивергенции,
  площадь, bbox, вырожденные грани (площадь ≤ 1e-12), дубликаты, non-manifold рёбра.
  Реализация — open-addressing хеш-таблица рёбер (без аллокаций на ребро).
- `verdict.js` — те же тексты и порядок `problems`/`warnings`, что у `stl_qa.py`, включая
  `|ΔV| … > допуска 2.0%`, `объём <= 0 (…)`, предупреждение `тел N, ожидалось M` и
  проблему «сырой STL не watertight … нужен `--clean-out`» только когда чистка не запрошена.
- `clean.js` — чистка по правилу trimesh (`nondegenerate_faces(height=1e-8)`: минимальное ребро и
  минимальная высота > 1e-8), а **не** по площади: у blob-пены 2 грани с площадью 1e-13 мм² —
  законная геометрия, их удаление открывало поверхность и давало ложный FAIL.
- Выбор движка: `stl_check(engine)` / `qaEngine` / `MESH_STL_QA_ENGINE`, по умолчанию `js`;
  `python` оставлен эталоном, при исключении в JS — автоматический откат `python-fallback`.

**Приёмка (факты):** `scripts/qa-parity.mjs --project` → **15/15 проверок совпадают** с
`tools/qa/stl_qa.py` на синтетических фикстурах (куб, вырожденные грани, открытая коробка, касание
кубов, трижды продублированный ASCII) и реальных STL (A1, A2, E1 raw, C4 raw, fluid, patches):
вердикт, `bodies`, объём/площадь (объём совпадает до 1e-10 отн.), вырожденные грани и дубликаты.
Единственное документированное расхождение — `fluid_patches.stl`: trimesh сливает вершины ASCII-фасетов
по нормали файла, поэтому `vertices_merged/non_manifold/euler` у него меньше (4592/12947/16701 против
20880/22956/22980 у нас), при том что вердикт, watertight и объём совпадают.
Скорость/память: 862 898 треугольников — 6.6 с / 846 МБ; 1 471 974 — 11.9 с / 1.3 ГБ.

### 1.2 Генераторы без проекта (⬜ 1 день)
- Python-скрипты семейств переносятся **внутрь пакета**: `mesh-stl/generators/{pore_cell,cad,stratified}/…`
  (сейчас они лежат в исследовательском `geometry/`). `generators.json` получает `script` относительно
  `PACKAGE_ROOT`, режим `generators.root: "package" | "project"`.
- Простые семейства переписываются на JS (без python вообще): `primitive` (есть), `stratified-channel`
  (две коробки — 12 треугольников на часть), `box-array` (решётка сфер/цилиндров как отдельные STL).
- Для python-семейств — предварительная проверка: `python3 -c "import trimesh, numpy"` → понятная
  ошибка `python-bridge-missing` с командой установки, а не stack trace.
- **Приёмка:** в пустом каталоге с минимальным `sim-project.json` работают `stl_generate` для
  `primitive`, `stratified-channel`, `box-array` + `stl_check` + `mesh_build(snappy)`.

### 1.3 Реестр STL и caseRoots (⬜ 0.5 дня)
- `registry.path` (по умолчанию `./stl/registry.csv`, относительно `projectRoot`): файл создаётся
  с заголовком по требованию; при read-only ФС — `registered: false` + предупреждение, вердикт не меняется.
- `caseRoots` по умолчанию `["./cases"]` (сейчас `["experiments","cases/openfoam","cases/fluent"]`);
  `next:`-сообщения строятся из фактического корня, а не хардкодом `experiments/exp-NNN`.
- `benchmark/scripts/fluid_point.py` → переносится в `mesh-build/scripts/fluid-point.py`; сообщения
  `next:` ссылаются на утилиту внутри пакета.

### 1.4 Первый запуск без проекта (⬜ 0.5 дня)
- `sim-core/lib/config.js`: если `sim-project.json` нет — работать на дефолтах и вернуть
  `project: "defaults"` в ответах; отдельная карточка-подсказка `portable-setup`.
- `mesh_hints`/`stl_hints` получают карточку «работа без исследовательского проекта: что доступно».
- **Приёмка блокера:** `docs/PORTABLE.md` + сквозной сценарий в `experiments/portable-smoke/`
  (gitignored), который в чистом каталоге проходит STL → snappy → gate → delivery.

---

## Блокер 2. Упаковка и релиз-инжиниринг (🟡 2 дня)

Сделано в 0.5.1: отдельный репозиторий, теги, GitHub Release, CHANGELOG всех трёх пакетов,
`repository`/`homepage` в `package.json`. Осталось:

### 2.1 CI (⬜ 0.5 дня)
`.github/workflows/ci.yml`, matrix node 20/24, без OpenFOAM:
- `node --check` по всем `.js/.mjs` (через `find`, не `git ls-files` — удалённые файлы ломают проверку);
- `node mesh-build/scripts/smoke.mjs` и `node mesh-stl/scripts/smoke.mjs`;
- `node scripts/check-catalogue.mjs` — id карточек уникальны после слияния каталогов, у каждой есть
  `evidence`, нет карточек без `topics`;
- `node scripts/check-versions.mjs` — версии трёх `package.json` согласованы, верхняя запись CHANGELOG
  совпадает с версией, `sim-core` peer-диапазон валиден;
- `node scripts/qa-parity.mjs` (из 1.1).

### 2.2 Публикация (⬜ 0.5 дня)
- Решить канал: **npm** (`@astden/dsh-mesh-build`, `-mesh-stl`, `-sim-core`) или git-установка
  (`dsh plugin add github:AstDen/dsh-mesh-toolkit#path:/mesh-build`). Workbench ставится из GitHub
  (`"private": true`), поэтому git-канал — рабочий вариант без токена npm.
- `files` в `package.json`: только `lib/`, `data/`, `locale/`, `scripts/`, `generators/`, `*.md`
  (исключить тесты и скретч).
- `scripts/bump.mjs`: одна команда поднимает три версии + заголовки CHANGELOG + git tag.

### 2.3 `engines.dsh` (⬜ 0.5 дня)
- Сейчас `">=0.2.1-rc.5 <0.3.0"` при установленном 0.2.2-rc.5 и workbench `">=0.2.2-rc.1"`.
  Выровнять на `">=0.2.2-rc.1"` (без верхней границы), проверить загрузку на 0.2.2-rc.5,
  записать матрицу в README.

### 2.4 Release workflow (⬜ 0.5 дня)
`.github/workflows/release.yml` на тег `v*`: собрать тело релиза из CHANGELOG, создать Release
(в Actions `gh release create` с `GITHUB_TOKEN` — токен не нужен), приложить `.zip/.tar.gz` пакетов.

---

## Блокер 3. Контракт с workbench (⬜ 2–3 дня)

Поставка сейчас mesh-центрична: в `deliver/openfoam_<name>/` пустая `0/` и мешерские словари;
пользователь вручную делает поля и решательские словари. Workbench
(`@yakovlev-i-a/dsh-openfoam-workbench` 0.9.20, `openfoam_case_scaffold`) умеет их создать —
нужен явный стык.

### 3.1 Документ контракта (⬜ 0.5 дня)
`docs/WORKBENCH-CONTRACT.md`: кто владеет чем.

| Этап | Владелец | Инструменты |
|---|---|---|
| геометрия → STL | mesh-toolkit | `stl_generate`, `stl_check` |
| STL → сетка, качество, паспорт | mesh-toolkit | `mesh_build`, `mesh_check` |
| типы патчей (inlet/outlet/wall/symmetry/cavity) | mesh-toolkit (новый `mesh_patch_types`) | — |
| поставка кейса + handoff | mesh-toolkit | `mesh_deliver` + `handoff.json` |
| `0/` поля, `fvSchemes/fvSolution`, решатель, пост | workbench | `openfoam_case_scaffold`, `openfoam_check`, … |

### 3.2 `handoff.json` в поставке (⬜ 0.5 дня)
`mesh_deliver` пишет рядом с `delivery_<name>.json`:
`{units, scale, regions[], patches[{name, type, role, nFaces, area_m3}], cells, gate, bbox_m,
suggestedFamily: "incompressible|compressible|cht", suggestedToolCalls: [{tool, args}]}`
(`role` выводится из имени патча и типа; `suggestedToolCalls` — готовый вызов `openfoam_case_scaffold`).
Схема версионируется (`handoffVersion: 1`).

### 3.3 `mesh_patch_types` (⬜ 1 день)
Новый инструмент mesh-build: конфиг `patches: {inlet: "patch", outlet: "patch", walls: "wall", ...}`
→ правит `constant/<region>/polyMesh/boundary` (в multi-region — каждый регион), пишет `.bak`,
пересчитывает `mesh-passport.json` (пометка `patchedBy`) и **не** меняет метрики.
Заменяет ручной шаг `foamDictionary -entry boundary.inlet.type -set patch` из Appendix C.

### 3.4 Снятие дублирования (⬜ 0.5 дня)
- В README обоих плагинов: `mesh_build` — основной путь, `openfoam_mesh_plan` — фолбэк, когда
  mesh-toolkit не установлен или нужен «нулевой конфиг».
- Скилл `openfoam-meshing` (workbench) получает в начале раздел «если установлен mesh-build —
  используйте `mesh_build`/`mesh_check`» (правка в репозитории workbench, отдельный PR).
- `simMesh`-сервис описывается в контракте как программный вход для workbench.

### 3.5 Сквозной тест стыка (⬜ 0.5 дня)
`scripts/contract-test.mjs`: A1m → `mesh_deliver` → `openfoam_case_scaffold` (workbench) →
проверка `0/`, `system/fvSchemes`, `openfoam_check` без ошибок. В CI — `skip` без OpenFOAM.

---

## Порядок и вехи

| Веха | Содержание | Итог |
|---|---|---|
| M1 (дни 1–4) | 1.1–1.4 | toolkit ставится в пустой каталог, 3 семейства + snappy работают |
| M2 (дни 5–6) | 2.1–2.4 | CI зелёный, версии/CHANGELOG автоматизированы, канал установки выбран |
| M3 (дни 7–9) | 3.1–3.5 | «сетка → решаемый кейс» за 2 вызова инструментов по контракту |
| 1.0.0-rc.1 | M1+M2 + QUICKSTART/TROUBLESHOOTING | публичный предрелиз |
| 1.0.0 | + M3 + приёмка на чужой машине | GA |

## Риски

- **Паритет JS-QA с python**: считать объём/площадь тем же способом (дивергенция по треугольникам),
  тест на 12 фикстурах обязателен, иначе вердикты разъедутся.
- **Python-генераторы**: без python/numpy/trimesh 3 из 6 семейств недоступны — это должно быть
  в README и в ошибке инструмента, а не выясняться на середине.
- **Версия workbench**: контракт привязать к `>=0.9.20`; при отсутствии workbench — `handoff.json`
  остаётся валидным артефактом.
- **npm-скоуп** `@astden` может быть занят — зарезервировать до M2.

## Определение готовности 1.0

- [ ] В пустом каталоге: `stl_generate` → `stl_check` → `mesh_build` → `mesh_check` → `mesh_deliver`
      без единого пути за пределы рабочего каталога.
- [ ] CI на двух версиях node, без OpenFOAM, зелёный; релизный workflow создаёт Release по тегу.
- [ ] `handoff.json` + `mesh_patch_types`: после поставки `openfoam_case_scaffold` даёт рабочий кейс
      без ручной правки `boundary`.
- [ ] Документация: QUICKSTART, TROUBLESHOOTING (15 точных строк ошибок), CONFIG, WORKBENCH-CONTRACT.
- [ ] Установка на чистой машине проверена по README не автором.
