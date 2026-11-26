# 0.5.4 — упаковка, CI и релиз без ручных шагов

Три пакета: **mesh-build 0.5.4** · **mesh-stl 0.3.6** · **sim-core 0.4.4**.
Это релиз блокера 2 плана `PLAN-release-1.0.md`: код не менял физику, но упаковка теперь
проверяется автоматически и релиз собирается тегом.

## Что нового по пакетам

### mesh-stl 0.3.6
- `files` включает `generators/` — раньше `npm pack` терял python-генераторы, и семейства
  `fcc-cell`, `channel-spheres`, `packing`, `cad-porous`, `blob-foam` падали бы в установленном
  пакете на `@package/generators/...`.
- `scripts/qa-parity.mjs` сам находит python-эталон (`tools/qa/stl_qa.py` → пакетная копия
  `generators/cad/py_qa.py` → `MESH_STL_QA_SCRIPT`) и требует graph engine (см. ниже), поэтому
  паритет проверяется и в отдельно взятом пакете, и в CI.
- `scripts/smoke.mjs` проходит без `sim-project.json`: в портативном режиме проверяются дефолты
  (`project: "defaults"`, `registry: stl/registry.csv`, QA-движок `js`), а dry-run якорится на cwd.

### mesh-build 0.5.4
- `files` включает `docs/`: `docs/PORTABLE.md`, на который ссылается README, теперь есть в пакете.
- `scripts/smoke.mjs` проходит без профиля (`project: "defaults"`, `caseRoot: "cases"`,
  профиль шлюза `project`).

### sim-core 0.4.4
- Профиль качества по умолчанию в режиме без `sim-project.json` — `project` (60° / skew 2 /
  boundary 4), как обещают `docs/PORTABLE.md` и карточка `portable-mesh-build`. Раньше молча
  брался `gate` (65°) — расхождение кода и документации. Явный `gate.profile` в профиле по-прежнему
  главнее.
- Добавлено `engines.dsh`.

### Общее
- `engines.dsh: ">=0.2.2-rc.1 <0.3.0"` во всех трёх пакетах (было `>=0.2.1-rc.5 <0.3.0`),
  peer-диапазоны `@deepseek-ai/dsh-*` выровнены так же. Верхняя граница сохранена намеренно:
  мажор DSH может менять API.
- Заполнено `repository` с `directory` каждого пакета.
- Python-семействам mesh-stl теперь явно нужен `networkx`: без graph engine trimesh падает с
  `ImportError: no graph engines available!` (ловилось только в чистом окружении CI).

## Автоматизация

- **CI** (`.github/workflows/ci.yml`, node 20 и 24): синтаксис JS/Python/shell, каталог карточек
  (35 уникальных, 10 общих — отчёт, не ошибка), согласованность версий (package.json == CHANGELOG ==
  баннер README), оба smoke, паритет JS-QA против python-эталона, полнота tarball'ов.
- **Release** (`.github/workflows/release.yml`): на тег `v*` прогоняет проверки, собирает три
  `.tgz` и создаёт/обновляет Release с описанием из `docs/RELEASE-<тег>.md`.
- **`scripts/bump.mjs`**: одна команда на три версии + заголовки CHANGELOG + баннер README +
  `check-versions`.
- Решение по каналу публикации и команды установки — `docs/PACKAGING.md` (git + `install_bundle`,
  tarball'ы как оффлайн-вариант; npm отложен: относительный импорт `../sim-core/lib/...` и занятые
  имена без scope).

## Установка

```bash
git clone https://github.com/AstDen/dsh-mesh-toolkit.git
cd dsh-mesh-toolkit
dsh plugin install_bundle "$(pwd)/sim-core"
dsh plugin install_bundle "$(pwd)/mesh-stl"
dsh plugin install_bundle "$(pwd)/mesh-build"
```

Или из ассетов этого релиза: распаковать `.tgz` и `dsh plugin install_bundle "$(pwd)/package"`.

После правок кода перезагрузка без перезапуска DSH: `plugin_manager set_plugin
{target:"include:mesh-stl", enabled:false}` → `enabled:true` (модули перечитываются, если файлы
изменились).

## Проверено

- CI зелёный на node 20 и 24 (все шаги, включая паритет 9/9 и полноту tarball'ов).
- Релиз собран workflow'ом: tag `v0.5.4`, три ассета `mesh-build-0.5.4.tgz`,
  `mesh-stl-0.3.6.tgz`, `sim-core-0.4.4.tgz`.
- `node scripts/check-catalogue.mjs` → 35 карточек; `node scripts/check-versions.mjs` → versions OK.
