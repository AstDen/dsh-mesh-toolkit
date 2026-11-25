# Changelog — sim-core

## 0.4.0 — 2026-11-25

- `lib/foam.js`: реестр установок OpenFOAM (`normalizeInstallations`, `resolveFoam`, `withFoam`):
  выбор по id из профиля или по абсолютному пути к `etc/bashrc`, ошибка со списком доступных.
- `lib/config.js`: `foamInstallations`, `foamDefault`, `foamSelected`, `openfoamBashrcExists`;
  bashrc по умолчанию берётся из профиля, затем из конвенциональных каталогов.
- `lib/passport.js`: необязательное поле `environment {id, distribution, version, bashrc}`.

## 0.3.0 — 2026-11-25

- Первый выпуск: профиль `sim-project.json`, пути с `resolvedFrom`, JS-гейт (`checkMesh` + профили),
  паспорт сетки и манифест кейса, `simHints`, `simGeometry`/`simMesh`, общие утилиты и процессы.
