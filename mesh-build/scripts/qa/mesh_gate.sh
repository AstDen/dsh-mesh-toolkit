#!/usr/bin/env bash
# tools/qa/mesh_gate.sh — STRICT QA gate for an OpenFOAM mesh.
#
# Why: `checkMesh` without the `-meshQuality` flag does NOT apply quality
# thresholds (see src/OpenFOAM/meshes/polyMesh/polyMeshCheck/polyMeshCheck.C in v2512:
#  errorNonOrth is raised only for faces with non-orthogonality > 90°,
#  while "severely non-orthogonal" > primitiveMesh::nonOrthThreshold_ = 70° is merely logged).
# So "Mesh OK" by default does NOT mean "the mesh is good".
#
# This script runs `checkMesh -meshQuality` with an EXPLICIT system/meshQualityDict,
# without touching the case directory: a temporary overlay is created in <project>/.cache/qa/,
# where system/ is copied and constant/polyMesh and 0/ are symlinks to the original.
#
# Usage:
#   tools/qa/mesh_gate.sh --case experiments/exp-000-openfoam-smoke/cases/cfmesh-pore
#   tools/qa/mesh_gate.sh --case <dir> --profile project --log logs/gate.log --csv metrics.csv
#
# Threshold profiles:
#   gate     — OpenFOAM v2512 template (etc/caseDicts/annotated/meshQualityDict): nonOrtho 65, internalSkew 4, boundarySkew 20
#   project  — project targets (AGENTS.md §6): nonOrtho 60, internalSkew 2, boundarySkew 4
#   relaxed  — for debugging: nonOrtho 75, internalSkew 4, boundarySkew 20
#
# Note on minVol: in meshQualityDict it is an ABSOLUTE volume in m³ (the "face–cell centre" pyramid).
# The template value 1e-13 is meant for cells of ~1 mm. For pore meshes with cells < 0.1 mm the threshold
# must be lowered: --min-vol ~ (h_min)³/6, otherwise normal small cells end up as "illegal faces".
# Example: exp-003 (cell 0.063 mm) -> 4.2e-14, used --min-vol 1e-14.
#
# The same applies to `minTetQuality` ("faces with face-decomposition tet quality" check):
# it is also an ABSOLUTE volume. The template value 1e-15 is meant for cells of ~1 mm and on fine
# meshes it flags normal faces. Therefore by default minTetQuality = minVol/100
# (it is scaled together with --min-vol); it can be set explicitly: --min-tet-quality <volume>.
#
# Return codes: 0 — within tolerances; 1 — violations found; 2 — startup/argument error.

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
    *) echo "mesh_gate: unknown argument: $1" >&2; usage 2 ;;
  esac
done

[[ -n "$CASE" ]] || { echo "mesh_gate: --case <dir> is required" >&2; usage 2; }
[[ -d "$CASE" ]] || { echo "mesh_gate: no such directory: $CASE" >&2; exit 2; }
CASE="$(cd "$CASE" && pwd)"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

case "$PROFILE" in
  gate)    NONORTH=65; ISKEW=4;  BSKEW=20 ;;
  project) NONORTH=60; ISKEW=2;  BSKEW=4  ;;
  relaxed) NONORTH=75; ISKEW=4;  BSKEW=20 ;;
  *) echo "mesh_gate: unknown profile: $PROFILE (gate|project|relaxed)" >&2; exit 2 ;;
esac
MINVOL_CFG="${MINVOL_CLI:-1e-13}"
# minTetQuality is also an absolute volume; by default it scales with minVol (see header)
MINTETQ_CFG="${MINTETQ_CLI:-$(awk -v v="$MINVOL_CFG" 'BEGIN{printf "%.3g", v/100}')}"

# --- OpenFOAM: source while bypassing set -eu (otherwise pop_var_context) ---
set +eu
# shellcheck disable=SC1090
source "$FOAM_BASHRC" >/dev/null 2>&1 || { echo "mesh_gate: failed to source $FOAM_BASHRC" >&2; exit 2; }
set -eu
command -v checkMesh >/dev/null || { echo "mesh_gate: checkMesh is not in PATH" >&2; exit 2; }

# --- temporary overlay (inside the project, .cache is excluded from git) ---
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
  echo "mesh_gate: $CASE has no constant/polyMesh" >&2; exit 2
fi
[[ -d "$CASE/0" ]] && ln -s "$CASE/0" "$OVERLAY/0"

# --- strict meshQualityDict ---
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

# logs go to .cache/qa by default (no litter left in the project working tree)
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

# --- parsing ---
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

echo "── mesh_gate: $(basename "$CASE") · profile $PROFILE (nonOrtho ≤ $NONORTH°, internalSkew ≤ $ISKEW, boundarySkew ≤ $BSKEW)"
echo "   cells=$CELLS  maxNonOrtho={$NONORTH_MAX}°  avg={$NONORTH_AVE}°  faces>${NONORTH}°=${NONORTH_OVER:-0}"
echo "   maxSkew=$SKEW  minVol=$MINVOL (threshold minVol=$MINVOL_CFG, minTetQ=$MINTETQ_CFG)  maxConcave=$CONCAVE  verdict=$VERDICT${FAILED_N:+ (failed checks: $FAILED_N)}"
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
