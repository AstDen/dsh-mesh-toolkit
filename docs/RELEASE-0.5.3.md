# 0.5.3 — работает в пустом каталоге

Пакеты: **mesh-build 0.5.3 · mesh-stl 0.3.5 · sim-core 0.4.3** (2026-11-26).
Закрывает блокер 1 плана [`PLAN-release-1.0.md`](PLAN-release-1.0.md): toolkit больше не
требует исследовательский проект.

## Главное

- **`sim-project.json` не обязателен.** Конфиг возвращает `project` = имя профиля или
  `"defaults"`, а инструменты вместо отказа пишут `project: "defaults"`, `configured: false`
  и подсказку в `next`. Значения по умолчанию: кейсы `./cases`, реестр STL `./stl/registry.csv`
  (создаётся сам), выходы генераторов `./stl/generated/<family>/`, профиль шлюза `project`.
- **Поставка едет с пакетом.** `mesh_deliver` больше не зависит от `tools/deliver/`:
  в бандле лежат `scripts/deliver/make_delivery.sh`, `scripts/qa/mesh_gate.sh`,
  `scripts/deliver/region_layout.py`. Шлюз поставки пишет overlay в `<outDir>/.gate`
  через `MESH_GATE_CACHE_DIR`, а `scriptOrigin` показывает, чей скрипт сработал.
- **Сквозной сценарий проверен в `/tmp`:** `stl_generate(primitive)` (12 треугольников, PASS, JS-QA) →
  `stl_check` PASS → `mesh_build` snappy (2584 ячейки: blockMesh → surfaceFeatureExtract →
  snappyHexMesh) → `mesh_check` gate **PASS** (18.29° / 0.2997) → `mesh_deliver` **DELIVERED**
  (1.8 МБ артефактов). Тот же прогон прогнан через реальные обработчики инструментов.
- **Карточки знаний:** `portable-setup` (mesh-stl) и `portable-mesh-build` (mesh-build) —
  что доступно без профиля и как переопределить. Всего в объединённом каталоге 35 карточек.
- **Документ:** [`docs/PORTABLE.md`](PORTABLE.md) — таблица значений по умолчанию, сценарий,
  что всё-таки требует профиля (установки OpenFOAM, свои пороги шлюза, единицы ≠ мм).

## Регрессии

- `plugins/mesh-stl/scripts/smoke.mjs`, `plugins/mesh-build/scripts/smoke.mjs` → SMOKE OK.
- `plugins/mesh-stl/scripts/qa-parity.mjs --project` → 15/15 совпадений с python-эталоном.
- Живой прогон после перезагрузки плагинов: `stl_hints({id:"portable-setup"})` находит карточку,
  `mesh_check` на `benchmark/runs/20261125-1805/mesh/a1` — PASS 18.2905°.

## Обновление

```bash
cd <profile> && dsh plugin update mesh-build mesh-stl sim-core   # или как вы ставите пакеты
# затем перезапустите DSH: ESM-граф живого процесса держит старые версии модулей
```

## Что дальше

Блокер 2 (CI, канал публикации, `engines.dsh`) и блокер 3 (контракт с
`dsh-openfoam-workbench`) — см. план; после них `1.0.0-rc.1`.
