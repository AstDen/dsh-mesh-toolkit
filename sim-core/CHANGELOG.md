# Changelog — sim-core

## 0.4.4 — 2026-11-26

- Добавлено `engines.dsh: ">=0.2.2-rc.1 <0.3.0"` (ядро тоже проверяет совместимость с рантаймом).
- Заполнено поле `repository` (`directory: sim-core`); версия участвует в проверке
  `scripts/check-versions.mjs` (package.json == CHANGELOG == баннер README).

## 0.4.3 — 2026-11-26

### Добавлено
- `resolveConfig` возвращает метку `project`: имя проекта из профиля или `"defaults"` в
  case-local режиме (план 1.4, портативность). Плагины показывают её в ответах инструментов.

## 0.4.2 — 2026-11-26

- **`project.js`: case-local по умолчанию `caseRoots: ["./cases"]`** (было `['experiments','cases']`).
  Профиль по-прежнему переопределяет корни; смысл — в голом каталоге без `sim-project.json` кейсы
  лежат в `./cases`, а не в исследовательских `experiments/` (план 1.3).

## 0.4.1 — 2026-11-26

- **`lib/gate.js`: `ensureGateDicts(overlay)`** — если в кейсе нет `system/fvSchemes` или
  `system/fvSolution`, в overlay пишутся минимальные копии (mesh-метрики от них не зависят);
  результат гейта получает поле `synthesized` и advisory. Раньше `checkMesh -meshQuality`
  падал с `cannot find file …/system/fvSchemes`, и гейт отдавал `ERROR` с пустыми метриками
  (бенчмарк: cfMesh-кейс без решательских словарей, DEF-04).

## 0.4.0 — 2026-11-25

- `lib/foam.js`: реестр установок OpenFOAM (`normalizeInstallations`, `resolveFoam`, `withFoam`):
  выбор по id из профиля или по абсолютному пути к `etc/bashrc`, ошибка со списком доступных.
- `lib/config.js`: `foamInstallations`, `foamDefault`, `foamSelected`, `openfoamBashrcExists`;
  bashrc по умолчанию берётся из профиля, затем из конвенциональных каталогов.
- `lib/passport.js`: необязательное поле `environment {id, distribution, version, bashrc}`.

## 0.3.0 — 2026-11-25

- Первый выпуск: профиль `sim-project.json`, пути с `resolvedFrom`, JS-гейт (`checkMesh` + профили),
  паспорт сетки и манифест кейса, `simHints`, `simGeometry`/`simMesh`, общие утилиты и процессы.
