# Упаковка и публикация (блокер 2)

Документ описывает, как пакеты собираются, проверяются и попадают к пользователю.
Относится к плану `PLAN-release-1.0.md`, блокер 2 «упаковка».

## Канал публикации: git-установка (решение)

Пакеты **не публикуются в npm** на этом этапе, и вот почему — проверено по коду, а не по ощущениям:

- `mesh-stl` и `mesh-build` импортируют общее ядро относительным путём: `../sim-core/lib/index.js`
  (`mesh-stl/index.js`, `mesh-build/index.js`). Это работает, когда три каталога лежат рядом:
  в профиле (`link:`), при клонировании репозитория и в `node_modules` при плоской установке.
  В scoped-пакете (`@astden/mesh-stl`) этот путь не разрешается, а публикация под именами
  `mesh-stl` / `mesh-build` / `sim-core` без scope на npm уже занята посторонними пакетами.
- Все три пакета объявлены `private: true`, как и `@yakovlev-i-a/dsh-openfoam-workbench`
  (он тоже ставится из GitHub, а не из npm). Мы повторяем проверенный канал workbench,
  чтобы у пользователя был один способ установки для всей связки.
- `npm pack` при этом работает и даёт корректные tarball'ы — они прикладываются к каждому
  Release и годятся как второй, оффлайновый канал (`dsh plugin install_bundle <абсолютный путь>`).

Итог: **основной канал — git + `dsh plugin install_bundle` с абсолютным путём; второй —
`*.tgz` из ассетов Release.** Переход на npm (scoped-имена + смена импортов на `sim-core/lib/...`
+ объявление `dependencies`) описан в PLAN как отдельная задача и в 1.0 не входит.

## Установка (пользователь)

```bash
git clone https://github.com/AstDen/dsh-mesh-toolkit.git
cd dsh-mesh-toolkit
# три пакета ставятся по отдельности, порядок не важен
dsh plugin install_bundle "$(pwd)/sim-core"
dsh plugin install_bundle "$(pwd)/mesh-stl"
dsh plugin install_bundle "$(pwd)/mesh-build"
```

После правок кода: `plugin_manager set_plugin {target:"include:mesh-stl", enabled:false}` →
`enabled:true` (модули перечитываются без перезапуска DSH — см. README пакетов).

Из tarball'а:

```bash
tar xzf mesh-build-0.5.4.tgz && dsh plugin install_bundle "$(pwd)/package"
```

## Что проверяет CI (`.github/workflows/ci.yml`)

На каждый push в `master` и на pull request, в матрице node **20 и 24**:

| Шаг | Что ловит |
|---|---|
| `node --check` по `find` (не `git ls-files`) | синтаксис всех `.js`/`.mjs` |
| `python3 -m compileall` | синтаксис `mesh-stl/generators/**` и `benchmark/scripts/**` |
| `bash -n` | синтаксис `mesh-build/scripts/**/*.sh` (включая пакетную поставку) |
| `scripts/check-catalogue.mjs` | карточки: id, заголовок, statement, topics, evidence, допустимые status, дубликаты внутри пакета |
| `scripts/check-versions.mjs` | версии package.json == CHANGELOG == баннер README, `engines`, лицензия, `repository`, наличие `cordis.patch.yml` |
| `smoke.mjs` обоих пакетов | конфиг, карточки, каталог, dry-run без DSH |
| `qa-parity.mjs` (trimesh из pip) | JS-движок QA против python-эталона; эталон берётся из `tools/qa/stl_qa.py`, а в отдельно взятом пакете — из `mesh-stl/generators/cad/py_qa.py` |
| проверка tarball'ов | что в `npm pack` попали `generators/`, `lib/qa/`, `scripts/deliver/`, `docs/` |

## Что проверяет Release-workflow (`.github/workflows/release.yml`)

На push тега `v*` (или вручную с указанием тега):

1. повторяет проверки каталога и версий + оба smoke;
2. собирает `npm pack` для всех трёх пакетов в `dist/`;
3. берёт описание из `docs/RELEASE-<тег>.md`, иначе собирает краткое из CHANGELOG'ов;
4. создаёт Release (или обновляет существующий) и прикладывает три `.tgz`;
5. печатает список ассетов.

Так что после `git tag v0.5.4 && git push origin v0.5.4` Release появляется сам — ручной
вызов API из прошлых релизов больше не нужен.

## Версии и CHANGELOG

```bash
node scripts/bump.mjs patch          # все три пакета: 0.5.4 / 0.3.6 / 0.4.4
node scripts/bump.mjs minor --packages mesh-stl
node scripts/bump.mjs 1.0.0 --dry-run
```

Скрипт правит `package.json`, вставляет заголовок `## X.Y.Z — дата` в CHANGELOG (с TODO-строкой,
которую надо заменить содержанием), обновляет баннер в корневом README и запускает
`scripts/check-versions.mjs`. На грязном дереве отказывается работать без `--force`.

## Найденные и исправленные дефекты упаковки

- `mesh-stl/package.json#files` не содержал `generators/` — tarball ехал **без** python-генераторов,
  и семейства `fcc-cell`, `channel-spheres`, `packing`, `cad-porous`, `blob-foam` падали бы
  на `@package/generators/...`. Теперь `generators` в списке, а CI проверяет наличие файла в tarball.
- `mesh-build/package.json#files` не содержал `docs/` — README ссылался на `docs/PORTABLE.md`,
  которого не было в пакете. Исправлено, CI проверяет.
- `engines.dsh` был `>=0.2.1-rc.5 <0.3.0` при установленном DSH 0.2.2-rc.5 и workbench
  `>=0.2.2-rc.1` — выровнено на `>=0.2.2-rc.1 <0.3.0` во всех трёх пакетах (в `sim-core` поле
  добавлено), peer-диапазоны `@deepseek-ai/dsh-*` выровнены так же.
- `repository` не был заполнен ни в одном пакете — добавлен `git+https://…` с `directory` пакета.

## Ограничения

- npm-канал не открыт (см. выше) — при необходимости это отдельная задача плана.
- CI не запускает мешинг: `mesh_build` требует OpenFOAM, поэтому проверяются только сборка
  конфигов/словарей (smoke + scaffold-тесты в `verify-*.mjs`) и QA-паритет.
- Python-зависимости (`cadquery`, `scipy`, `skimage`) в CI не ставятся: проверяется синтаксис
  и паритет на `trimesh`+`numpy`; семейства, которым нужен CAD, тестируются локально.
