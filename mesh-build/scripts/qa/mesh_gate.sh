#!/usr/bin/env bash
# tools/qa/mesh_gate.sh — СТРОГИЙ QA-шлюз OpenFOAM-сетки.
#
# Зачем: `checkMesh` без флага `-meshQuality` НЕ применяет пороги качества
# (см. src/OpenFOAM/meshes/polyMesh/polyMeshCheck/polyMeshCheck.C в v2512:
#  errorNonOrth считается только для лиц с неортогональностью > 90°,
#  а «severely non-orthogonal» > primitiveMesh::nonOrthThreshold_ = 70° лишь логируется).
# Поэтому «Mesh OK» по умолчанию ≠ «сетка качественная».
#
# Этот скрипт запускает `checkMesh -meshQuality` с ЯВНЫМ system/meshQualityDict,
# не изменяя каталог кейса: создаётся временный overlay в <проект>/.cache/qa/,
# где system/ копируется, а constant/polyMesh и 0/ — симлинки на оригинал.
#
# Использование:
#   tools/qa/mesh_gate.sh --case experiments/exp-000-openfoam-smoke/cases/cfmesh-pore
#   tools/qa/mesh_gate.sh --case <dir> --profile project --log logs/gate.log --csv metrics.csv
#
# Профили порогов:
#   gate     — шаблон OpenFOAM v2512 (etc/caseDicts/annotated/meshQualityDict): nonOrtho 65, internalSkew 4, boundarySkew 20
#   project  — цели проекта (AGENTS.md §6): nonOrtho 60, internalSkew 2, boundarySkew 4
#   relaxed  — для отладки: nonOrtho 75, internalSkew 4, boundarySkew 20
#
# Важно про minVol: в meshQualityDict это АБСОЛЮТНЫЙ объём в м³ (пирамида «грань–центр ячейки»).
# Шаблонное 1e-13 рассчитано на ячейки ~1 мм. Для поровых сеток с ячейками < 0.1 мм порог надо
# опускать: --min-vol ~ (h_min)³/6, иначе нормальные мелкие ячейки попадают в «illegal faces».
# Пример: exp-003 (ячейка 0.063 мм) → 4.2e-14, использовано --min-vol 1e-14.
#
# То же касается `minTetQuality` (проверка «faces with face-decomposition tet quality»):
# это тоже АБСОЛЮТНЫЙ объём. Шаблонное 1e-15 рассчитано на ячейки ~1 мм и на мелких
# сетках валит нормальные грани. Поэтому по умолчанию minTetQuality = minVol/100
# (масштабируется вместе с --min-vol); можно задать явно: --min-tet-quality <объём>.
#
# Коды возврата: 0 — в допусках; 1 — есть нарушения; 2 — ошибка запуска/аргументов.

set -euo pipefail

FOAM_BASHRC_DEFAULT="/usr/lib/openfoam/openfoam2512/etc/bashrc"

CASE=""
PROFILE="gate"
LOG=""
CSV=""
JSON=""
FOAM_BASHRC="${FOAM_BASHRC:-$FOAM_BASHRC_DEFAULT}"
KEEP=0
MINVOL_CLI=""
MINTETQ_CLI=""

usage() {
  sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --case|-c)      CASE="$2"; shift 2 ;;
    --profile|-p)   PROFILE="$2"; shift 2 ;;
    --log|-l)       LOG="$2"; shift 2 ;;
    --csv)          CSV="$2"; shift 2 ;;
    --json)         JSON="$2"; shift 2 ;;
    --foam-bashrc)  FOAM_BASHRC="$2"; shift 2 ;;
    --min-vol)      MINVOL_CLI="$2"; shift 2 ;;
    --min-tet-quality) MINTETQ_CLI="$2"; shift 2 ;;
    --keep)         KEEP=1; shift ;;
    -h|--help)      usage 0 ;;
    *) echo "mesh_gate: неизвестный аргумент: $1" >&2; usage 2 ;;
  esac
done

[[ -n "$CASE" ]] || { echo "mesh_gate: нужен --case <dir>" >&2; usage 2; }
[[ -d "$CASE" ]] || { echo "mesh_gate: нет каталога: $CASE" >&2; exit 2; }
CASE="$(cd "$CASE" && pwd)"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

case "$PROFILE" in
  gate)    NONORTH=65; ISKEW=4;  BSKEW=20 ;;
  project) NONORTH=60; ISKEW=2;  BSKEW=4  ;;
  relaxed) NONORTH=75; ISKEW=4;  BSKEW=20 ;;
  *) echo "mesh_gate: неизвестный профиль: $PROFILE (gate|project|relaxed)" >&2; exit 2 ;;
esac
MINVOL_CFG="${MINVOL_CLI:-1e-13}"
# minTetQuality — тоже абсолютный объём; по умолчанию масштабируем вместе с minVol (см. шапку)
MINTETQ_CFG="${MINTETQ_CLI:-$(awk -v v="$MINVOL_CFG" 'BEGIN{printf "%.3g", v/100}')}"

# --- OpenFOAM: source с обходом set -eu (иначе pop_var_context) ---
set +eu
# shellcheck disable=SC1090
source "$FOAM_BASHRC" >/dev/null 2>&1 || { echo "mesh_gate: не удалось source $FOAM_BASHRC" >&2; exit 2; }
set -eu
command -v checkMesh >/dev/null || { echo "mesh_gate: checkMesh не в PATH" >&2; exit 2; }

# --- временный overlay (внутри проекта, .cache исключён из git) ---
# The packaged copy must not write into the installed bundle: honour MESH_GATE_CACHE_DIR (plan 1.4).
QA_ROOT="${MESH_GATE_CACHE_DIR:-$PROJECT_ROOT/.cache/qa}"
mkdir -p "$QA_ROOT"
OVERLAY="$(mktemp -d "$QA_ROOT/gate-XXXXXX")"
cleanup() { [[ "$KEEP" == "1" ]] || rm -rf "$OVERLAY"; }
trap cleanup EXIT

mkdir -p "$OVERLAY/constant" "$OVERLAY/system"
cp -r "$CASE/system/." "$OVERLAY/system/" 2>/dev/null || true
if [[ -d "$CASE/constant/polyMesh" ]]; then
  ln -s "$CASE/constant/polyMesh" "$OVERLAY/constant/polyMesh"
else
  echo "mesh_gate: в $CASE нет constant/polyMesh" >&2; exit 2
fi
[[ -d "$CASE/0" ]] && ln -s "$CASE/0" "$OVERLAY/0"

# --- строгий meshQualityDict ---
cat > "$OVERLAY/system/meshQualityDict" <<EOF
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      meshQualityDict;
}
maxNonOrtho          $NONORTH;
maxBoundarySkewness  $BSKEW;
maxInternalSkewness  $ISKEW;
maxConcave           80;
minVol               $MINVOL_CFG;
minTetQuality        $MINTETQ_CFG;
minArea              -1;
minTwist             0.02;
minDeterminant       0.001;
minFaceWeight        0.05;
minVolRatio          0.01;
minTriangleTwist     -1;
minEdgeLength        -1;
EOF

# логи по умолчанию — в .cache/qa (в рабочем дереве проекта мусор не оставляем)
if [[ -n "$LOG" ]]; then
  mkdir -p "$(dirname "$LOG")"
  LOG_PATH="$LOG"
else
  mkdir -p "$PROJECT_ROOT/.cache/qa"
  LOG_PATH="$QA_ROOT/gate_$(basename "$CASE").log"
fi

set +e
checkMesh -case "$OVERLAY" -meshQuality > "$LOG_PATH" 2>&1
CHECK_RC=$?
set -e

# --- разбор ---
parse() { grep -oE "$1" "$LOG_PATH" | tail -1 || true; }
CELLS="$(grep -oE 'cells: +[0-9]+' "$LOG_PATH" | grep -oE '[0-9]+' | head -1 || true)"
NONORTH_MAX="$(grep -oE 'Mesh non-orthogonality Max: [0-9.]+' "$LOG_PATH" | grep -oE '[0-9.]+$' | tail -1 || true)"
NONORTH_AVE="$(grep -oE 'average: [0-9.]+' "$LOG_PATH" | grep -oE '[0-9.]+' | head -1 || true)"
NONORTH_OVER="$(grep -oE 'non-orthogonality > +[0-9]+ degrees +: +[0-9]+' "$LOG_PATH" | grep -oE ': +[0-9]+$' | grep -oE '[0-9]+' | tail -1 || true)"
SKEW="$(grep -oE 'Max skewness = [0-9]+\.?[0-9]*(e[-+]?[0-9]+)?' "$LOG_PATH" | awk '{print $NF}' | tail -1 || true)"
MINVOL="$(grep -oE 'Min volume = [0-9]+\.?[0-9]*(e[-+]?[0-9]+)?' "$LOG_PATH" | awk '{print $NF}' | tail -1 || true)"
CONCAVE="$(grep -oE 'Max concavity = [0-9]+\.?[0-9]*(e[-+]?[0-9]+)?' "$LOG_PATH" | awk '{print $NF}' | tail -1 || true)"
FAILED_N="$(grep -oE 'Failed [0-9]+ mesh checks?' "$LOG_PATH" | grep -oE '[0-9]+' | tail -1 || true)"
if grep -q 'Mesh OK' "$LOG_PATH"; then VERDICT="OK"; else VERDICT="FAILED"; fi

echo "── mesh_gate: $(basename "$CASE") · профиль $PROFILE (nonOrtho ≤ $NONORTH°, internalSkew ≤ $ISKEW, boundarySkew ≤ $BSKEW)"
echo "   cells=$CELLS  maxNonOrtho={$NONORTH_MAX}°  avg={$NONORTH_AVE}°  faces>${NONORTH}°=${NONORTH_OVER:-0}"
echo "   maxSkew=$SKEW  minVol=$MINVOL (порог minVol=$MINVOL_CFG, minTetQ=$MINTETQ_CFG)  maxConcave=$CONCAVE  verdict=$VERDICT${FAILED_N:+ (failed checks: $FAILED_N)}"
echo "   log: $LOG_PATH"

if [[ -n "$JSON" ]]; then
  mkdir -p "$(dirname "$JSON")"
  cat > "$JSON" <<EOF
{
  "case": "$CASE",
  "profile": "$PROFILE",
  "thresholds": {"maxNonOrtho": $NONORTH, "maxInternalSkewness": $ISKEW, "maxBoundarySkewness": $BSKEW, "minVol": $MINVOL_CFG, "minTetQuality": $MINTETQ_CFG},
  "cells": ${CELLS:-null},
  "maxNonOrtho": ${NONORTH_MAX:-null},
  "aveNonOrtho": ${NONORTH_AVE:-null},
  "facesOverThreshold": ${NONORTH_OVER:-0},
  "maxSkewness": ${SKEW:-null},
  "minVolume": ${MINVOL:-null},
  "maxConcavity": ${CONCAVE:-null},
  "failedChecks": ${FAILED_N:-0},
  "verdict": "$VERDICT",
  "checkMeshRc": $CHECK_RC,
  "log": "$LOG_PATH"
}
EOF
  echo "   json: $JSON"
fi

if [[ -n "$CSV" ]]; then
  mkdir -p "$(dirname "$CSV")"
  [[ -f "$CSV" ]] || echo "case,profile,cells,max_nonorth_deg,avg_nonorth_deg,faces_over_thr,max_skew,min_vol_m3,max_concave,failed_checks,verdict,date" > "$CSV"
  echo "$(basename "$CASE"),$PROFILE,${CELLS:-},${NONORTH_MAX:-},${NONORTH_AVE:-},${NONORTH_OVER:-0},${SKEW:-},${MINVOL:-},${CONCAVE:-},${FAILED_N:-0},$VERDICT,$(date -Iseconds)" >> "$CSV"
  echo "   csv: $CSV"
fi

[[ "$VERDICT" == "OK" ]] && exit 0 || exit 1
