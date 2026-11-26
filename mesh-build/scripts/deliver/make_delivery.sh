#!/usr/bin/env bash
# tools/deliver/make_delivery.sh — упаковка построенной сетки в два «дистрибутива».
#
# Вход:  OpenFOAM-кейс с готовой сеткой. Поддерживаются два режима:
#   single (по умолчанию)  — одна сетка в <case>/constant/polyMesh;
#   multi  (--multi-region / автоопределение) — многорегиональная сетка (fluid+solid,
#          conjugate heat transfer): <case>/constant/<region>/polyMesh и/или cellZones,
#          которые ещё нужно разделить утилитой splitMeshRegions.
#
# Выход (в --out), на каждую сетку:
#   openfoam_<name>/            — рабочий кейс OpenFOAM: настоящая папка constant/
#                                 (polyMesh, triSurface), system/, 0/ (если есть) и маркер
#                                 <name>.foam. Открыть в ParaView: openfoam_<name>/<name>.foam
#   openfoam_<name>.tar.gz      — архив этого кейса (перенос/расчёт)
#   ansys_<name>/<name>.msh     — сетка Fluent (foamMeshToFluent, полиэдры сохраняются)
#   ansys_<name>/read_mesh.jou  — журнал Fluent: прочитать .msh и проверить качество
#   ansys_<name>.zip            — архив ANSYS-директории
#   delivery_<name>.{json,md}   — отчёт: ячейки/патчи/объём, round-trip, шлюз качества
#
# В многорегиональном режиме дополнительно:
#   openfoam_<name>/constant/<region>/polyMesh   — настоящая сетка каждого региона
#   openfoam_<name>/system/<region>/             — словари региона
#   openfoam_<name>/constant/regionProperties    — список регионов для chtMultiRegionFoam
#   openfoam_<name>/constant/polyMesh_combined   — исходная неразделённая сетка (справочно;
#                                                  ParaView её не видит, чтобы не было третьего
#                                                  дублирующего региона; --no-combined-mesh убирает)
#   ansys_<name>/mesh_region_<region>.msh        — по сетке Fluent на регион
#   ansys_<name>/read_mesh.jou                   — журнал читает ВСЕ регионы по очереди
#
# Проверки (реальным запуском, не «по построению»):
#   1) checkMesh внутри упакованного openfoam_<name>/ — кейс самодостаточен;
#      в multi — checkMesh -region <r> по каждому региону + по combined-сетке;
#   2) смежность интерфейса (multi): патчи <a>_to_<b> и <b>_to_<a> существуют оба и имеют
#      одинаковое число граней (region_layout.py); сумма объёмов регионов ≈ объём combined;
#   3) round-trip .msh → OpenFOAM: fluentMeshToFoam, при отказе на полиэдрах —
#      legacy fluent3DMeshToFoam; сверяются ячейки, патчи, суммарный объём и max non-ortho;
#      в multi — по каждому региону отдельно;
#   4) строгий шлюз tools/qa/mesh_gate.sh --profile project по упакованному кейсу
#      (в multi — по каждому региону через подготовленную директорию с symlink на polyMesh);
#   5) целостность архивов (tar -tzf / unzip -l).
#
# Пример (одна сетка):
#   tools/deliver/make_delivery.sh \
#       --case experiments/exp-003_fcc-elementary-cell/cases/fcc_r049_gap01 \
#       --name fcc_r049_gap01 \
#       --out  experiments/exp-004_delivery-bundle/deliver \
#       [--gate-profile project|gate|none] [--gate-min-vol 1e-14|auto]
#
# Пример (два региона; кейс уже разделён splitMeshRegions):
#   tools/deliver/make_delivery.sh --case <case> --name cht_sphere --out <dir>
#
# Пример (в кейсе только cellZones → разделить в scratch и упаковать):
#   tools/deliver/make_delivery.sh --case <case> --name cht_sphere --out <dir> --multi-region
#
# rc: 0 — упаковано, все проверки сошлись; 1 — расхождение round-trip / интерфейса /
#     объёмов / шлюз не пройден (артефакты при этом на месте, причина в отчёте);
#     2 — ошибка входа/окружения.

set -uo pipefail

CASE=""; NAME=""; OUT=""
FOAM_BASHRC="${FOAM_BASHRC:-/usr/lib/openfoam/openfoam2512/etc/bashrc}"
KEEP_SCRATCH=0; SKIP_ANSYS=0
GATE_PROFILE="project"; GATE_MIN_VOL="1e-14"   # порог для поровых ячеек ~0.05–0.1 мм; "auto" = minCell/10
MULTI_FORCE=0; REGIONS_ARG=""; KEEP_COMBINED=1

die() { echo "ERROR: $*" >&2; exit 2; }

usage() { awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 {exit}' "$0"; exit 0; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --case)             CASE="$2"; shift 2 ;;
    --name)             NAME="$2"; shift 2 ;;
    --out)              OUT="$2"; shift 2 ;;
    --foam-bashrc)      FOAM_BASHRC="$2"; shift 2 ;;
    --gate-profile)     GATE_PROFILE="$2"; shift 2 ;;
    --gate-min-vol)     GATE_MIN_VOL="$2"; shift 2 ;;
    --regions)          REGIONS_ARG="$2"; shift 2 ;;
    --multi-region)     MULTI_FORCE=1; shift ;;
    --no-combined-mesh) KEEP_COMBINED=0; shift ;;
    --keep-scratch)     KEEP_SCRATCH=1; shift ;;
    --skip-ansys)       SKIP_ANSYS=1; shift ;;
    -h|--help)          usage ;;
    *) die "неизвестный аргумент: $1" ;;
  esac
done

[[ -n "$CASE" && -n "$NAME" && -n "$OUT" ]] || die "нужны --case, --name, --out"
[[ -d "$CASE" ]] || die "нет каталога кейса: $CASE"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJ_DIR="$(cd "$SELF_DIR/../.." && pwd)"
CASE="$(cd "$CASE" && pwd)"
mkdir -p "$OUT" || die "не создать $OUT"
OUT="$(cd "$OUT" && pwd)"

if [[ -f "$FOAM_BASHRC" ]]; then
  set +eu
  # shellcheck disable=SC1090
  source "$FOAM_BASHRC" >/dev/null 2>&1
  set +eu
else
  die "не найден OpenFOAM bashrc: $FOAM_BASHRC"
fi
for c in checkMesh foamMeshToFluent; do
  command -v "$c" >/dev/null 2>&1 || die "в PATH нет $c (OpenFOAM не подхватился)"
done
RT_TOOL_DEFAULT=""
for c in fluentMeshToFoam fluent3DMeshToFoam; do
  command -v "$c" >/dev/null 2>&1 && { RT_TOOL_DEFAULT="$c"; break; }
done

OF_DIR="$OUT/openfoam_$NAME"
AN_DIR="$OUT/ansys_$NAME"
SCRATCH="$OUT/.scratch_$NAME"
LOG="$OUT/deliver.log"
say() { echo "[deliver] $*" | tee -a "$LOG"; }
: > "$LOG"

rm -rf "$OF_DIR" "$AN_DIR" "$SCRATCH"
mkdir -p "$OF_DIR" "$AN_DIR" "$SCRATCH"

# =====================================================================
# 0. Режим и регионы
# =====================================================================
# Регион = каталог <root>/constant/<name>/polyMesh (сам polyMesh регионом не считается).
find_regions() {
  local root="$1" d n
  [[ -d "$root/constant" ]] || return 0
  for d in "$root/constant"/*/; do
    [[ -d "${d}polyMesh" ]] || continue
    n="$(basename "$d")"
    [[ "$n" == polyMesh* ]] && continue
    printf '%s\n' "$n"
  done | sort
}

# сколько cellZone в базовой сетке (0 = нет файла)
count_cellzones() {
  local f="$1/constant/polyMesh/cellZones"
  [[ -f "$f" ]] || { echo 0; return; }
  # каждая клеточная зона — блок с "type cellZone;" (имена зон и списки меток не считаем)
  awk '/^[[:space:]]*type[[:space:]]+cellZone[[:space:]]*;/ {n++} END {print n+0}' "$f"
}

REGION_ROOT="$CASE"
mapfile -t FOUND < <(find_regions "$CASE")
SPLIT_DONE=0

if (( MULTI_FORCE )) && (( ${#FOUND[@]} < 1 )); then
  NZ=$(count_cellzones "$CASE")
  if (( NZ >= 2 )); then
    command -v splitMeshRegions >/dev/null 2>&1 || die "--multi-region: в PATH нет splitMeshRegions"
    say "multi: региональных папок нет, но в базовой сетке $NZ cellZone(s) → splitMeshRegions -cellZones -overwrite (в scratch)"
    mkdir -p "$SCRATCH/split"
    cp -a "$CASE/constant" "$SCRATCH/split/" || die "копирование constant для splitMeshRegions"
    cp -a "$CASE/system"   "$SCRATCH/split/" || die "копирование system для splitMeshRegions"
    if [[ -d "$CASE/0" ]]; then cp -a "$CASE/0" "$SCRATCH/split/" || die "копирование 0"; fi
    ( cd "$SCRATCH/split" && splitMeshRegions -cellZones -overwrite ) \
      > "$OUT/.splitMeshRegions_$NAME.log" 2>&1
    SPLIT_RC=$?
    if [[ $SPLIT_RC -ne 0 ]]; then
      say "multi: splitMeshRegions rc=$SPLIT_RC → $OUT/.splitMeshRegions_$NAME.log"
      die "splitMeshRegions не смог разделить регионы (см. лог)"
    fi
    REGION_ROOT="$SCRATCH/split"
    SPLIT_DONE=1
    mapfile -t FOUND < <(find_regions "$REGION_ROOT")
    say "multi: splitMeshRegions ok, регионы: ${FOUND[*]:-нет} → $OUT/.splitMeshRegions_$NAME.log"
  else
    die "--multi-region: нет ни региональных папок (constant/<region>/polyMesh), ни 2+ cellZones в $CASE/constant/polyMesh/cellZones"
  fi
fi

MODE="single"
if (( MULTI_FORCE )); then
  MODE="multi"
elif (( ${#FOUND[@]} >= 2 )); then
  MODE="multi"
elif (( ${#FOUND[@]} == 1 )) && [[ ! -d "$CASE/constant/polyMesh" ]]; then
  MODE="multi"          # кейс уже разрезан, базовой сетки нет — иначе single-режим не соберётся
fi
if [[ -n "$REGIONS_ARG" ]]; then MODE="multi"; fi

REGIONS=()
if [[ "$MODE" == "multi" ]]; then
  (( ${#FOUND[@]} >= 1 )) || die "multi: регионов не найдено (ни constant/<region>/polyMesh, ни splitMeshRegions)"
  if [[ -n "$REGIONS_ARG" ]]; then
    IFS=',' read -r -a REGIONS <<< "$REGIONS_ARG"
    for i in "${!REGIONS[@]}"; do REGIONS[$i]="$(echo "${REGIONS[$i]}" | tr -d '[:space:]')"; done
    for r in "${REGIONS[@]}"; do
      [[ -n "$r" ]] || die "--regions: пустое имя региона в '$REGIONS_ARG'"
      [[ -d "$REGION_ROOT/constant/$r/polyMesh" ]] \
        || die "--regions: нет региона '$r' (в $REGION_ROOT/constant найдены: ${FOUND[*]})"
    done
  else
    REGIONS=("${FOUND[@]}")
  fi
  say "режим: multi, регионы: ${REGIONS[*]} (корень сетки: $REGION_ROOT)"
else
  [[ -d "$CASE/constant/polyMesh" ]] || die "нет сетки: $CASE/constant/polyMesh"
  say "режим: single (одна сетка $CASE/constant/polyMesh)"
fi

region_selected() {
  local x="$1" r
  for r in "${REGIONS[@]}"; do [[ "$r" == "$x" ]] && return 0; done
  return 1
}

# разбор лога checkMesh → CM_CELLS CM_PATCHES CM_VOLUME CM_MINCELL CM_NONORTHO
cm_parse() {
  local log="$1"
  CM_CELLS=$(awk '/^ *cells:/ {print $2; exit}' "$log")
  CM_PATCHES=$(awk '/boundary patches:/ {print $3; exit}' "$log")
  CM_VOLUME=$(grep -o 'Total volume = [0-9.eE+-]*' "$log" | tail -1 | awk '{print $4}' | sed 's/\.$//')
  CM_MINCELL=$(grep -o 'Min volume = [0-9.eE+-]*' "$log" | tail -1 | awk '{print $4}' | sed 's/\.$//')
  CM_NONORTHO=$(grep -o 'Mesh non-orthogonality Max: [0-9.]*' "$log" | tail -1 | awk '{print $NF}')
}

# объёмы сравниваем ЧИСЛЕННО: округление в последнем разряде — это не расхождение
vol_close() {  # $1 $2 [rel-tol] → 0 если |a-b|/|b| < tol
  python3 -c "
import sys
a=float(sys.argv[1]); b=float(sys.argv[2]); tol=float(sys.argv[3])
print(1 if abs(a-b) <= tol*abs(b) else 0)" "$1" "$2" "${3:-1e-6}" | grep -q 1
}

# факты для отчёта: TSV-файл, который читает python в шаге 5
FACTS="$OUT/.facts_$NAME.tsv"
: > "$FACTS"
printf 'mode\t%s\n' "$MODE" >> "$FACTS"

# строки фактов по регионам (в single — один регион с именем "-")
declare -A R_CELLS R_PATCHES R_VOL R_MINCELL R_NONORTHO R_CMRC R_RT_TOOL R_RT_CELLS
declare -A R_RT_PATCHES R_RT_VOL R_RT_NONORTHO R_ANSYS R_GATE R_GATEMINVOL

BASE_CELLS=""; BASE_VOLUME=""; BASE_NONORTHO=""; BASE_MINCEL=""

# =====================================================================
# 1. OpenFOAM-дистрибутив
# =====================================================================
if [[ "$MODE" == "single" ]]; then
  say "openfoam: constant/ + system/ из $CASE"
  cp -a "$CASE/constant" "$OF_DIR/" || die "копирование constant"
  cp -a "$CASE/system"   "$OF_DIR/" || die "копирование system"
  if [[ -d "$CASE/0" ]] && [[ -n "$(ls -A "$CASE/0" 2>/dev/null)" ]]; then
    cp -a "$CASE/0" "$OF_DIR/"; say "openfoam: поля 0/ скопированы"
  else
    say "openfoam: 0/ с полями отсутствует — дистрибутив содержит сетку и system/"
  fi
  # маркер НЕ пустой: файл 0 байт GLib определяет как application/x-zerosize,
  # и двойной клик по *.foam не попадает в ассоциацию с ParaView (D-010, tools/pv/foam_marker.sh)
  printf '%s\n' '// OpenFOAM case marker: открывать ЭТИМ файлом в ParaView (File -> Open).' \
      > "$OF_DIR/$NAME.foam"

  cat > "$OF_DIR/README.txt" <<EOF
Сетка $NAME — дистрибутив OpenFOAM
==================================
Просмотр в ParaView:
  paraview $OF_DIR/$NAME.foam
  (открывается весь кейс: constant/polyMesh + system/)

Проверка качества:
  source /usr/lib/openfoam/openfoam2512/etc/bashrc
  checkMesh -case $OF_DIR
  "$SELF_DIR/../qa/mesh_gate.sh" --case $OF_DIR --profile project

Единицы: координаты в СИ (метры). Исходный STL был в мм.
EOF

  checkMesh -case "$OF_DIR" > "$OUT/.checkMesh_$NAME.log" 2>&1
  CMRC=$?
  cm_parse "$OUT/.checkMesh_$NAME.log"
  CELLS="$CM_CELLS"; PATCHES="$CM_PATCHES"; VOLUME="$CM_VOLUME"
  MINCELL="$CM_MINCELL"; NONORTHO="$CM_NONORTHO"
  say "openfoam: checkMesh rc=$CMRC, cells=${CELLS:-?}, patches=${PATCHES:-?}, V=${VOLUME:-?}, nonOrtho=${NONORTHO:-?}, minCellV=${MINCELL:-?}"
  [[ -n "$CELLS" ]] || die "checkMesh не дал числа ячеек (см. $OUT/.checkMesh_$NAME.log)"
else
  # ---------- 1b. многорегиональный дистрибутив ----------
  say "openfoam: constant/ + system/ из $REGION_ROOT (регионы: ${REGIONS[*]})"
  cp -a "$REGION_ROOT/constant" "$OF_DIR/" || die "копирование constant"
  cp -a "$REGION_ROOT/system"   "$OF_DIR/" || die "копирование system"
  if [[ -d "$REGION_ROOT/0" ]] && [[ -n "$(ls -A "$REGION_ROOT/0" 2>/dev/null)" ]]; then
    cp -a "$REGION_ROOT/0" "$OF_DIR/"; say "openfoam: поля 0/ (включая 0/<region>/) скопированы"
  else
    say "openfoam: 0/ с полями отсутствует — дистрибутив содержит сетки регионов и system/"
  fi

  # оставить только выбранные регионы (--regions fluid,solid)
  for d in "$OF_DIR"/constant/*/; do
    [[ -d "${d}polyMesh" ]] || continue
    n="$(basename "$d")"; [[ "$n" == polyMesh* ]] && continue
    region_selected "$n" || { rm -rf "$d"; say "openfoam: регион '$n' не запрошен — убран из дистрибутива"; }
  done
  for d in "$OF_DIR"/system/*/; do
    [[ -d "$d" ]] || continue
    n="$(basename "$d")"
    region_selected "$n" || rm -rf "$d"
  done
  for r in "${REGIONS[@]}"; do mkdir -p "$OF_DIR/system/$r"; done

  # базовая (неразделённая) сетка: справочно как polyMesh_combined, чтобы ParaView
  # не показывал третий дублирующий регион
  COMBINED_IN_DIST=0
  if [[ -d "$OF_DIR/constant/polyMesh" ]]; then
    if [[ "$KEEP_COMBINED" -eq 1 ]]; then
      mv "$OF_DIR/constant/polyMesh" "$OF_DIR/constant/polyMesh_combined" \
        || die "не удалось переименовать constant/polyMesh → polyMesh_combined"
      COMBINED_IN_DIST=1
      say "openfoam: базовая сетка сохранена как constant/polyMesh_combined (ParaView её игнорирует)"
    else
      rm -rf "$OF_DIR/constant/polyMesh"
      say "openfoam: базовая сетка убрана (--no-combined-mesh)"
    fi
  fi

  # regionProperties — чтобы кейс был готов к chtMultiRegionFoam и checkMesh -region
  {
    echo "FoamFile"
    echo "{"
    echo "    version     2.0;"
    echo "    format      ascii;"
    echo "    class       dictionary;"
    echo "    object      regionProperties;"
    echo "}"
    echo ""
    echo "regions"
    echo "("
    for r in "${REGIONS[@]}"; do printf '    (%s %s)\n' "$r" "$r"; done
    echo ");"
  } > "$OF_DIR/constant/regionProperties"

  {
    echo "Сетка $NAME — многорегиональный дистрибутив OpenFOAM (conjugate heat transfer)"
    echo "================================================================================="
    echo "Регионы: ${REGIONS[*]}"
    echo ""
    echo "Просмотр в ParaView (открываются ОБА региона):"
    echo "  paraview $OF_DIR/$NAME.foam"
    echo "  дерево: $(for r in "${REGIONS[@]}"; do printf '/%s/internalMesh ' "$r"; done)"
    echo ""
    echo "Структура:"
    for r in "${REGIONS[@]}"; do
      echo "  constant/$r/polyMesh        сетка региона $r"
      echo "  system/$r/                  словари региона $r"
    done
    [[ "$COMBINED_IN_DIST" -eq 1 ]] && {
      echo "  constant/polyMesh_combined  исходная неразделённая сетка (справочно;"
      echo "                              ParaView её не видит, чтобы не было 3-го региона)"
    }
    echo "  constant/regionProperties   список регионов для chtMultiRegionFoam"
    echo "  $NAME.foam                  маркер кейса"
    echo ""
    echo "Проверка качества (по каждому региону):"
    echo "  source /usr/lib/openfoam/openfoam2512/etc/bashrc"
    for r in "${REGIONS[@]}"; do echo "  checkMesh -region $r -case $OF_DIR"; done
    echo ""
    echo "Единицы: координаты в СИ (метры)."
  } > "$OF_DIR/README.txt"
  # маркер НЕ пустой: файл 0 байт GLib определяет как application/x-zerosize,
  # и двойной клик по *.foam не попадает в ассоциацию с ParaView (D-010, tools/pv/foam_marker.sh)
  printf '%s\n' '// OpenFOAM case marker: открывать ЭТИМ файлом в ParaView (File -> Open).' \
      > "$OF_DIR/$NAME.foam"

  # checkMesh по каждому региону в уже упакованном кейсе
  SUM_VOL="0"
  for r in "${REGIONS[@]}"; do
    lg="$OUT/.checkMesh_${NAME}_${r}.log"
    checkMesh -region "$r" -case "$OF_DIR" > "$lg" 2>&1
    rc=$?
    cm_parse "$lg"
    R_CELLS[$r]="$CM_CELLS"; R_PATCHES[$r]="$CM_PATCHES"; R_VOL[$r]="$CM_VOLUME"
    R_MINCELL[$r]="$CM_MINCELL"; R_NONORTHO[$r]="$CM_NONORTHO"; R_CMRC[$r]="$rc"
    say "openfoam[$r]: checkMesh -region rc=$rc, cells=${CM_CELLS:-?}, patches=${CM_PATCHES:-?}, V=${CM_VOLUME:-?}, nonOrtho=${CM_NONORTHO:-?}, minCellV=${CM_MINCELL:-?}"
    [[ -n "$CM_CELLS" ]] || die "checkMesh -region $r не дал числа ячеек (см. $lg)"
    SUM_VOL=$(python3 -c "print(repr(float('$SUM_VOL') + float('${CM_VOLUME:-0}')))")
  done

  # checkMesh по combined-сетке (что именно лежит в архиве)
  if [[ "$COMBINED_IN_DIST" -eq 1 ]]; then
    mkdir -p "$SCRATCH/combined/constant" "$SCRATCH/combined/system"
    ln -sfn "$OF_DIR/constant/polyMesh_combined" "$SCRATCH/combined/constant/polyMesh"
    cp -a "$OF_DIR/system/." "$SCRATCH/combined/system/" 2>/dev/null || true
    checkMesh -case "$SCRATCH/combined" > "$OUT/.checkMesh_combined_$NAME.log" 2>&1
    BRC=$?
    cm_parse "$OUT/.checkMesh_combined_$NAME.log"
    BASE_CELLS="$CM_CELLS"; BASE_VOLUME="$CM_VOLUME"; BASE_NONORTHO="$CM_NONORTHO"; BASE_MINCEL="$CM_MINCEL"
    say "openfoam[combined]: checkMesh rc=$BRC, cells=${BASE_CELLS:-?}, V=${BASE_VOLUME:-?}, nonOrtho=${BASE_NONORTHO:-?}"
  elif [[ -d "$REGION_ROOT/constant/polyMesh" ]]; then
    checkMesh -case "$REGION_ROOT" > "$OUT/.checkMesh_combined_$NAME.log" 2>&1
    BRC=$?
    cm_parse "$OUT/.checkMesh_combined_$NAME.log"
    BASE_CELLS="$CM_CELLS"; BASE_VOLUME="$CM_VOLUME"; BASE_NONORTHO="$CM_NONORTHO"; BASE_MINCEL="$CM_MINCEL"
    say "openfoam[combined]: в дистрибутиве нет combined; сверка с исходной сеткой $REGION_ROOT, cells=${BASE_CELLS:-?}, V=${BASE_VOLUME:-?}"
  else
    say "openfoam[combined]: базовой сетки нет (кейс пришёл уже разрезанным) — сверка суммарного объёма пропущена"
  fi

  # смежность интерфейса + список патчей (по упакованному дистрибутиву)
  LAYOUT="$OUT/.region_layout_$NAME.json"
  REGIONS_CSV="$(IFS=','; echo "${REGIONS[*]}")"
  python3 "$SELF_DIR/region_layout.py" --case "$OF_DIR" --regions "$REGIONS_CSV" --json "$LAYOUT" \
    > >(tee -a "$LOG") 2>&1
  LAYOUT_RC=$?
  [[ $LAYOUT_RC -eq 0 ]] || say "интерфейс: РАСХОЖДЕНИЕ/нет пары (rc=$LAYOUT_RC) — см. $LAYOUT"
  [[ $LAYOUT_RC -eq 2 ]] && die "region_layout.py: разбор регионов не удался"

  # сверка суммы объёмов регионов с combined
  VOL_REL=""; VOL_OK=""
  if [[ -n "$REGIONS_ARG" ]] && (( ${#REGIONS[@]} < ${#FOUND[@]} )); then
    say "объём: запрошено подмножество регионов (${REGIONS[*]} из ${FOUND[*]}) — сверка суммы с combined пропущена"
  elif [[ -n "$BASE_VOLUME" ]]; then
    read -r VOL_OK VOL_REL < <(python3 -c "
s=float('$SUM_VOL'); b=float('$BASE_VOLUME')
rel=abs(s-b)/abs(b) if b else float('inf')
print(1 if rel < 1e-6 else 0, f'{rel:.3e}')")
    if [[ "$VOL_OK" == "1" ]]; then
      say "объём: сумма регионов $SUM_VOL ≈ combined $BASE_VOLUME (rel=$VOL_REL) — сходится"
    else
      say "объём: РАСХОЖДЕНИЕ сумма регионов $SUM_VOL vs combined $BASE_VOLUME (rel=$VOL_REL)"
    fi
  else
    say "объём: сверка невозможна (нет базовой сетки)"
  fi
  printf 'combined\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "${BASE_CELLS:-}" "${BASE_VOLUME:-}" "${BASE_NONORTHO:-}" "${BASE_MINCEL:-}" \
    "$SUM_VOL" "$VOL_REL" >> "$FACTS"
  printf 'layout\t%s\t%s\n' "$LAYOUT_RC" "$LAYOUT" >> "$FACTS"
fi

# =====================================================================
# 2. ANSYS-дистрибутив
# =====================================================================
MSH=""; ANSYS_STATUS="skipped"; RT_TOOL_USED=""
RT_CELLS=""; RT_PATCHES=""; RT_VOLUME=""; RT_NONORTHO=""

# round-trip одного .msh → OpenFOAM; $1=msh $2=подпись(для имён файлов) $3=system для копирования
roundtrip_msh() {
  local msh="$1" tag="$2" sysdir="$3" tool rc
  mkdir -p "$SCRATCH/rt_$tag/system"
  cp -a "$sysdir/." "$SCRATCH/rt_$tag/system/" 2>/dev/null || true
  for tool in fluentMeshToFoam fluent3DMeshToFoam; do
    command -v "$tool" >/dev/null 2>&1 || continue
    rm -rf "$SCRATCH/rt_$tag/constant"
    ( cd "$SCRATCH/rt_$tag" && "$tool" "$msh" ) > "$OUT/.roundtrip_${tool}_${tag}.log" 2>&1
    if [[ $? -eq 0 && -d "$SCRATCH/rt_$tag/constant/polyMesh" ]]; then
      RT_TOOL_USED="$tool"
      checkMesh -case "$SCRATCH/rt_$tag" > "$OUT/.checkMesh_roundtrip_${tag}.log" 2>&1
      cm_parse "$OUT/.checkMesh_roundtrip_${tag}.log"
      RT_CELLS="$CM_CELLS"; RT_PATCHES="$CM_PATCHES"
      RT_VOLUME="$CM_VOLUME"; RT_NONORTHO="$CM_NONORTHO"
      return 0
    fi
    say "ansys[$tag]: $tool не прочитал .msh (ожидаемо для полиэдров) → $OUT/.roundtrip_${tool}_${tag}.log"
  done
  RT_CELLS=""; RT_PATCHES=""; RT_VOLUME=""; RT_NONORTHO=""
  return 1
}

if [[ "$MODE" == "single" ]]; then
  if [[ "$SKIP_ANSYS" -eq 0 ]]; then
    mkdir -p "$SCRATCH/constant" "$SCRATCH/system"
    cp -a "$CASE/constant/polyMesh" "$SCRATCH/constant/"
    cp -a "$CASE/system/." "$SCRATCH/system/" 2>/dev/null || true
    ( cd "$SCRATCH" && foamMeshToFluent ) > "$OUT/.foamMeshToFluent_$NAME.log" 2>&1
    FMR=$?
    SRC_MSH=$(find "$SCRATCH/fluentInterface" -maxdepth 1 -name '*.msh' -print -quit 2>/dev/null || true)
    if [[ $FMR -ne 0 || -z "$SRC_MSH" ]]; then
      ANSYS_STATUS="failed"
      say "ansys: foamMeshToFluent rc=$FMR, .msh не найден → $OUT/.foamMeshToFluent_$NAME.log"
    else
      cp -a "$SRC_MSH" "$AN_DIR/$NAME.msh"; MSH="$AN_DIR/$NAME.msh"
      say "ansys: $NAME.msh ($(awk -v b="$(stat -c%s "$MSH")" 'BEGIN{printf "%.1f", b/1048576}') МБ)"

      cat > "$AN_DIR/read_mesh.jou" <<EOF
; Чтение и проверка сетки $NAME в ANSYS Fluent (TUI, batch)
/file/read-case "$NAME.msh"
/mesh/check
/mesh/quality
/exit yes
EOF

      if roundtrip_msh "$MSH" "$NAME" "$CASE/system"; then
        if [[ "$RT_CELLS" == "$CELLS" && "$RT_PATCHES" == "$PATCHES" ]] \
           && vol_close "${RT_VOLUME:-0}" "${VOLUME:-0}"; then
          ANSYS_STATUS="ok"
          say "ansys: round-trip ($RT_TOOL_USED) совпал: cells=$RT_CELLS, patches=$RT_PATCHES, V=$RT_VOLUME"
        else
          ANSYS_STATUS="mismatch"
          say "ansys: ROUND-TRIP РАСХОЖДЕНИЕ: cells $CELLS→$RT_CELLS, patches $PATCHES→$RT_PATCHES, V $VOLUME→$RT_VOLUME"
        fi
      else
        ANSYS_STATUS="roundtrip_failed"
        say "ansys: ни fluentMeshToFoam, ни fluent3DMeshToFoam не прочитали .msh"
      fi
    fi
  fi
else
  # ---------- 2b. по .msh на регион ----------
  ANSYS_ANY=0; ANSYS_ALL_OK=1
  if [[ "$SKIP_ANSYS" -eq 0 ]]; then
    for r in "${REGIONS[@]}"; do
      rdir="$SCRATCH/one_$r"
      mkdir -p "$rdir/constant" "$rdir/system"
      cp -a "$OF_DIR/constant/$r/polyMesh" "$rdir/constant/" || die "копирование polyMesh региона $r"
      cp -a "$OF_DIR/system/." "$rdir/system/" 2>/dev/null || true
      ( cd "$rdir" && foamMeshToFluent ) > "$OUT/.foamMeshToFluent_${NAME}_${r}.log" 2>&1
      FMR=$?
      SRC_MSH=$(find "$rdir/fluentInterface" -maxdepth 1 -name '*.msh' -print -quit 2>/dev/null || true)
      if [[ $FMR -ne 0 || -z "$SRC_MSH" ]]; then
        R_ANSYS[$r]="failed"; ANSYS_ALL_OK=0
        say "ansys[$r]: foamMeshToFluent rc=$FMR, .msh не найден → $OUT/.foamMeshToFluent_${NAME}_${r}.log"
        continue
      fi
      cp -a "$SRC_MSH" "$AN_DIR/mesh_region_$r.msh"
      ANSYS_ANY=1
      say "ansys[$r]: mesh_region_$r.msh ($(awk -v b="$(stat -c%s "$AN_DIR/mesh_region_$r.msh")" 'BEGIN{printf "%.1f", b/1048576}') МБ)"
      if roundtrip_msh "$AN_DIR/mesh_region_$r.msh" "${NAME}_${r}" "$OF_DIR/system"; then
        R_RT_TOOL[$r]="$RT_TOOL_USED"; R_RT_CELLS[$r]="$RT_CELLS"
        R_RT_PATCHES[$r]="$RT_PATCHES"; R_RT_VOL[$r]="$RT_VOLUME"; R_RT_NONORTHO[$r]="$RT_NONORTHO"
        if [[ "$RT_CELLS" == "${R_CELLS[$r]}" && "$RT_PATCHES" == "${R_PATCHES[$r]}" ]] \
           && vol_close "${RT_VOLUME:-0}" "${R_VOL[$r]:-0}"; then
          R_ANSYS[$r]="ok"
          say "ansys[$r]: round-trip ($RT_TOOL_USED) совпал: cells=$RT_CELLS, patches=$RT_PATCHES, V=$RT_VOLUME"
        else
          R_ANSYS[$r]="mismatch"; ANSYS_ALL_OK=0
          say "ansys[$r]: ROUND-TRIP РАСХОЖДЕНИЕ: cells ${R_CELLS[$r]}→$RT_CELLS, patches ${R_PATCHES[$r]}→$RT_PATCHES, V ${R_VOL[$r]}→$RT_VOLUME"
        fi
      else
        R_ANSYS[$r]="roundtrip_failed"; ANSYS_ALL_OK=0
        say "ansys[$r]: ни fluentMeshToFoam, ни fluent3DMeshToFoam не прочитали .msh"
      fi
    done
    {
      echo "; Чтение и проверка региональных сеток $NAME в ANSYS Fluent (TUI, batch)"
      echo "; регионы: ${REGIONS[*]} — читаются по очереди"
      for r in "${REGIONS[@]}"; do
        echo "/file/read-case \"mesh_region_$r.msh\""
        echo "/mesh/check"
        echo "/mesh/quality"
      done
      echo "/exit yes"
    } > "$AN_DIR/read_mesh.jou"
  else
    for r in "${REGIONS[@]}"; do R_ANSYS[$r]="skipped"; done
  fi
  MSH="$AN_DIR/mesh_region_${REGIONS[0]}.msh"; [[ "$ANSYS_ANY" -eq 1 ]] || MSH=""
  if [[ "$SKIP_ANSYS" -eq 1 ]]; then ANSYS_STATUS="skipped"
  elif [[ "$ANSYS_ALL_OK" -eq 1 && "$ANSYS_ANY" -eq 1 ]]; then ANSYS_STATUS="ok"
  elif [[ "$ANSYS_ANY" -eq 1 ]]; then ANSYS_STATUS="mismatch"
  else ANSYS_STATUS="failed"; fi
fi

# =====================================================================
# 3. Строгий шлюз качества
# =====================================================================
GATE_RC=""; GATE_MIN_VOL_USED="$GATE_MIN_VOL"; GATE_DETAIL=""
gate_one() {  # $1 = case-dir для шлюза, $2 = метка (для имён логов), $3 = minVol override
  local gcase="$1" tag="$2" mv="${3:-$GATE_MIN_VOL}" rc
  local args=(--case "$gcase" --profile "$GATE_PROFILE")
  [[ -n "$mv" ]] && args+=(--min-vol "$mv")
  args+=(--json "$OUT/.gate_${tag}.json" --log "$OUT/delivery_gate_${tag}.log")
  "$SELF_DIR/../qa/mesh_gate.sh" "${args[@]}" > "$OUT/.gate_${tag}.out" 2>&1
  rc=$?
  [[ -f "$OUT/delivery_gate_${tag}.log" ]] && cp -f "$OUT/delivery_gate_${tag}.log" "$OUT/.gate_${tag}.log"
  # краткая сводка шлюза для консоли/лога
  GATE_DETAIL=$(grep -oE 'maxNonOrtho=\{[0-9.]+\}°|faces>[0-9]+°=[0-9]+|failed checks: [0-9]+' \
    "$OUT/.gate_${tag}.out" 2>/dev/null | tr '\n' ' ' | sed 's/ *$//')
  return $rc
}

if [[ "$GATE_PROFILE" != "none" && -x "$SELF_DIR/../qa/mesh_gate.sh" ]]; then
  if [[ "$MODE" == "single" ]]; then
    if [[ "$GATE_MIN_VOL" == "auto" && -n "${MINCELL:-}" ]]; then
      GATE_MIN_VOL_USED=$(python3 -c "print(f'{float('${MINCELL}')/10:.3g}')")
      say "gate: minVol=auto → $GATE_MIN_VOL_USED м³ (minCell/10)"
    fi
    gate_one "$OF_DIR" "$NAME"; GATE_RC=$?
    say "gate($GATE_PROFILE${GATE_MIN_VOL_USED:+, minVol=$GATE_MIN_VOL_USED}): rc=$GATE_RC ${GATE_DETAIL:+· $GATE_DETAIL}"
  else
    # mesh_gate.sh ждёт <case>/constant/polyMesh и не умеет -region → готовим каталог:
    # constant/polyMesh = symlink на регион, system/ = базовый + наложение system/<region>
    GATE_ALL=0
    for r in "${REGIONS[@]}"; do
      gd="$SCRATCH/gate_$r"
      mkdir -p "$gd/constant" "$gd/system"
      ln -sfn "$OF_DIR/constant/$r/polyMesh" "$gd/constant/polyMesh"
      cp -a "$OF_DIR/system/." "$gd/system/" 2>/dev/null || true
      [[ -d "$OF_DIR/system/$r" ]] && cp -a "$OF_DIR/system/$r/." "$gd/system/" 2>/dev/null || true
      mv_one="$GATE_MIN_VOL"
      if [[ "$GATE_MIN_VOL" == "auto" && -n "${R_MINCELL[$r]:-}" ]]; then
        mv_one=$(python3 -c "print(f'{float('${R_MINCELL[$r]}')/10:.3g}')")
      fi
      if gate_one "$gd" "${NAME}_${r}" "$mv_one"; then GATE_RC_R=0; else GATE_RC_R=$?; fi
      R_GATE[$r]="$GATE_RC_R"; R_GATEMINVOL[$r]="$mv_one"
      [[ $GATE_RC_R -eq 0 ]] || GATE_ALL=1
      say "gate[$r]($GATE_PROFILE${mv_one:+, minVol=$mv_one}): rc=$GATE_RC_R ${GATE_DETAIL:+· $GATE_DETAIL}"
    done
    GATE_RC="$GATE_ALL"
  fi
fi

# =====================================================================
# 4. Архивы
# =====================================================================
TAR="$OUT/openfoam_$NAME.tar.gz"
ZIP="$OUT/ansys_$NAME.zip"
tar -czf "$TAR" -C "$OUT" "openfoam_$NAME" || die "tar"
TAR_ENTRIES=$(tar -tzf "$TAR" > "$OUT/.tar_list_$NAME.txt" 2>/dev/null; wc -l < "$OUT/.tar_list_$NAME.txt")
say "archive: $(basename "$TAR") ($(du -h "$TAR" | cut -f1), записей $TAR_ENTRIES)"
ZIP_MSH=0
if compgen -G "$AN_DIR/*.msh" > /dev/null; then
  rm -f "$ZIP"
  ( cd "$OUT" && zip -qr "ansys_$NAME.zip" "ansys_$NAME" ) || die "zip"
  ZIP_MSH=$(unzip -l "$ZIP" | grep -c '\.msh') || true
  say "archive: $(basename "$ZIP") ($(du -h "$ZIP" | cut -f1), .msh в архиве: $ZIP_MSH)"
fi

# =====================================================================
# 5. Отчёт
# =====================================================================
for r in "${REGIONS[@]:-}"; do
  [[ -n "$r" ]] || continue
  printf 'region\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$r" "${R_CELLS[$r]:-}" "${R_PATCHES[$r]:-}" "${R_VOL[$r]:-}" "${R_MINCELL[$r]:-}" \
    "${R_NONORTHO[$r]:-}" "${R_CMRC[$r]:-}" "${R_RT_TOOL[$r]:-}" "${R_RT_CELLS[$r]:-}" \
    "${R_RT_PATCHES[$r]:-}" "${R_RT_VOL[$r]:-}" "${R_RT_NONORTHO[$r]:-}" \
    "${R_ANSYS[$r]:-}" "${R_GATE[$r]:-}" >> "$FACTS"
done
if [[ "$MODE" == "single" ]]; then
  printf 'region\t-\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$CELLS" "$PATCHES" "$VOLUME" "$MINCELL" "$NONORTHO" "$CMRC" \
    "$RT_TOOL_USED" "$RT_CELLS" "$RT_PATCHES" "$RT_VOLUME" "$RT_NONORTHO" \
    "$ANSYS_STATUS" "${GATE_RC:-}" >> "$FACTS"
fi
printf 'regions_list\t%s\n' "$(IFS=','; echo "${REGIONS[*]}" 2>/dev/null)" >> "$FACTS"

python3 - "$OUT" "$NAME" "$CASE" "$GATE_PROFILE" "$GATE_MIN_VOL_USED" "$FACTS" "$SPLIT_DONE" <<'PY' >> "$LOG"
import json, os, sys, glob

out, name, case, gate_profile, gate_min_vol, facts_path, split_done = sys.argv[1:]
facts = {"mode": "single", "regions": [], "lines": {}}
regions = {}
combined = None
layout = None
for line in open(facts_path, encoding="utf-8"):
    f = line.rstrip("\n").split("\t")
    kind = f[0]
    if kind == "mode":
        facts["mode"] = f[1]
    elif kind == "regions_list":
        facts["lines"]["regions_list"] = f[1] if len(f) > 1 else ""
    elif kind == "region":
        (r, cells, patches, vol, mincell, nonortho, cmrc, rt_tool, rt_cells,
         rt_patches, rt_vol, rt_nonortho, ansys, gate) = (f[1:] + [""] * 14)[:14]
        def num(v, cast=float):
            try:
                return cast(v)
            except (TypeError, ValueError):
                return None
        regions[r] = {
            "cells": num(cells, int),
            "boundary_patches": num(patches, int),
            "total_volume_m3": num(vol),
            "min_cell_volume_m3": num(mincell),
            "max_nonortho_deg": num(nonortho),
            "checkmesh_rc": num(cmrc, int),
            "ansys_roundtrip": {
                "status": ansys or None, "tool": rt_tool or None,
                "cells": num(rt_cells, int), "boundary_patches": num(rt_patches, int),
                "total_volume_m3": num(rt_vol), "max_nonortho_deg": num(rt_nonortho),
            },
            "quality_gate": {
                "profile": gate_profile, "min_vol": gate_min_vol or None,
                "rc": num(gate, int),
                "pass": (num(gate, int) == 0) if gate else None,
            },
        }
    elif kind == "combined":
        cells, vol, nonortho, mincell, sum_vol, rel = (f[1:] + [""] * 6)[:6]
        combined = {"cells": int(cells) if cells else None,
                    "total_volume_m3": float(vol) if vol else None,
                    "max_nonortho_deg": float(nonortho) if nonortho else None,
                    "sum_regions_m3": float(sum_vol) if sum_vol else None,
                    "rel_diff": float(rel) if rel else None,
                    "match": (float(rel) < 1e-6) if rel else None}
    elif kind == "layout":
        layout = {"rc": int(f[1]) if f[1] else None, "file": f[2] if len(f) > 2 else None}

mode = facts["mode"]
sizes = {}
for pat in [f"openfoam_{name}.tar.gz", f"ansys_{name}.zip"] + [f"ansys_{name}/*.msh"]:
    for p in glob.glob(os.path.join(out, pat)):
        sizes[os.path.relpath(p, out)] = round(os.path.getsize(p) / 1048576, 2)

layout_doc = None
if layout and layout.get("file") and os.path.exists(layout["file"]):
    with open(layout["file"], encoding="utf-8") as f:
        layout_doc = json.load(f)

deliver = {
    "openfoam": {
        "dir": f"openfoam_{name}",
        "paraview_marker": f"openfoam_{name}/{name}.foam",
        "archive": f"openfoam_{name}.tar.gz",
        "has_constant_dir": True,
    },
    "ansys": {},
}

if mode == "single":
    m = regions.get("-", {})
    deliver["openfoam"]["has_constant_dir"] = os.path.isdir(
        os.path.join(out, f"openfoam_{name}", "constant", "polyMesh"))
    msh = glob.glob(os.path.join(out, f"ansys_{name}", "*.msh"))
    if msh:
        deliver["ansys"] = {
            "dir": f"ansys_{name}",
            "msh": f"ansys_{name}/{os.path.basename(msh[0])}",
            "journal": f"ansys_{name}/read_mesh.jou",
            "archive": f"ansys_{name}.zip",
            "note": "полиэдрические ячейки: fluentMeshToFoam их не читает, "
                    "локальная сверка выполнена через fluent3DMeshToFoam",
        }
    report = {
        "name": name,
        "mode": "single_region",
        "source_case": case,
        "deliverables": deliver,
        "mesh": {k: m.get(k) for k in ("cells", "boundary_patches", "total_volume_m3",
                                       "max_nonortho_deg", "checkmesh_rc")},
        "ansys_roundtrip": m.get("ansys_roundtrip", {}),
        "quality_gate": m.get("quality_gate", {}),
        "sizes_mb": sizes,
    }
    with open(os.path.join(out, f"delivery_{name}.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    mm = report["mesh"]; rt = report["ansys_roundtrip"]; g = report["quality_gate"]
    L = [f"# Доставка сетки `{name}`", "",
         f"Источник: `{case}`", "",
         "Режим: **single-region** (одна сетка `constant/polyMesh`)", "",
         "## Что отдано", "",
         "| Артефакт | Путь |", "|---|---|",
         f"| Кейс OpenFOAM (ParaView) | `openfoam_{name}/{name}.foam` |",
         f"| Архив OpenFOAM | `openfoam_{name}.tar.gz` |"]
    if msh:
        L += [f"| Сетка ANSYS/Fluent | `ansys_{name}/{os.path.basename(msh[0])}` |",
              f"| Журнал проверки в Fluent | `ansys_{name}/read_mesh.jou` |",
              f"| Архив ANSYS | `ansys_{name}.zip` |"]
    L += ["", "## Сетка", "",
          f"- ячеек **{mm['cells']}**, граничных патчей **{mm['boundary_patches']}**",
          f"- суммарный объём **{mm['total_volume_m3']}** м³, max non-ortho **{mm['max_nonortho_deg']}°**",
          f"- `checkMesh` в упакованном кейсе: rc={mm['checkmesh_rc']}",
          f"- папка `constant/polyMesh` на месте: **{deliver['openfoam']['has_constant_dir']}**",
          "", "## Проверки", "",
          f"- round-trip `.msh` → OpenFOAM через `{rt.get('tool')}`: **{rt.get('status')}**"
          f" (cells {rt.get('cells')}, patches {rt.get('boundary_patches')}, V {rt.get('total_volume_m3')}, "
          f"nonOrtho {rt.get('max_nonortho_deg')}°)",
          f"- строгий шлюз `mesh_gate --profile {g.get('profile')}`: **rc={g.get('rc')}**"
          + (f" (minVol={g.get('min_vol')})" if g.get('min_vol') else ""),
          "", "## Размеры", ""]
    for k, v in report["sizes_mb"].items():
        L.append(f"- `{k}`: {v} МБ")
    with open(os.path.join(out, f"delivery_{name}.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(L) + "\n")
    print(json.dumps(report, ensure_ascii=False))
else:
    regions_list = [r for r in regions if r != "-"]
    of_root = os.path.join(out, f"openfoam_{name}")
    deliver["openfoam"].update({
        "regions": regions_list,
        "region_meshes": {r: f"openfoam_{name}/constant/{r}/polyMesh" for r in regions_list},
        "region_system": {r: f"openfoam_{name}/system/{r}" for r in regions_list},
        "has_constant_dir": os.path.isdir(os.path.join(of_root, "constant")),
        "region_properties": f"openfoam_{name}/constant/regionProperties"
        if os.path.exists(os.path.join(of_root, "constant", "regionProperties")) else None,
        "combined_mesh": f"openfoam_{name}/constant/polyMesh_combined"
        if os.path.isdir(os.path.join(of_root, "constant", "polyMesh_combined")) else None,
        "split_by_tool": bool(int(split_done or 0)),
    })
    mshes = sorted(glob.glob(os.path.join(out, f"ansys_{name}", "*.msh")))
    if mshes:
        deliver["ansys"] = {
            "dir": f"ansys_{name}",
            "mshes": [f"ansys_{name}/{os.path.basename(p)}" for p in mshes],
            "journal": f"ansys_{name}/read_mesh.jou",
            "archive": f"ansys_{name}.zip",
            "note": "по одному .msh на регион; полиэдры сверены через fluent3DMeshToFoam",
        }
    def gate_block():
        # шлюз мог не запускаться (--gate-profile none) — тогда не выдаём «rc=0/pass»
        per_region = {r: v.get("quality_gate", {}).get("rc") for r, v in regions.items()}
        ran = any(v is not None for v in per_region.values())
        return {
            "profile": gate_profile,
            "min_vol": (gate_min_vol or None) if ran else None,
            "rc": (0 if all(v in (0, None) for v in per_region.values()) else 1) if ran else None,
            "pass": all(v in (0, None) for v in per_region.values()) if ran else None,
            "per_region": per_region,
        }

    tot_cells = sum(v.get("cells") or 0 for v in regions.values())
    report = {
        "name": name,
        "mode": "multi_region",
        "source_case": case,
        "deliverables": deliver,
        "regions": regions,
        "regions_total_cells": tot_cells,
        "combined_mesh": combined,
        "interface": (layout_doc or {}).get("interfaces", []),
        "interface_ok": (layout_doc or {}).get("ok"),
        "unpaired_patches": (layout_doc or {}).get("unpaired_patches", []),
        "external_patches": (layout_doc or {}).get("external_patches", []),
        "quality_gate": gate_block(),
        "sizes_mb": sizes,
    }
    with open(os.path.join(out, f"delivery_{name}.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    L = [f"# Доставка многорегиональной сетки `{name}`", "",
         f"Источник: `{case}`", "",
         f"Режим: **multi-region** — регионы: " + ", ".join(f"`{r}`" for r in regions_list) + "",
         "", "## Что отдано", "",
         "| Артефакт | Путь |", "|---|---|",
         f"| Кейс OpenFOAM (ParaView, оба региона) | `openfoam_{name}/{name}.foam` |"]
    for r in regions_list:
        L.append(f"| Сетка региона `{r}` | `openfoam_{name}/constant/{r}/polyMesh` |")
    if deliver["openfoam"].get("combined_mesh"):
        L.append(f"| Исходная неразделённая сетка (справочно) | `{deliver['openfoam']['combined_mesh']}` |")
    L.append(f"| Архив OpenFOAM | `openfoam_{name}.tar.gz` |")
    for p in deliver.get("ansys", {}).get("mshes", []):
        L.append(f"| Сетка ANSYS/Fluent | `{p}` |")
    if deliver.get("ansys"):
        L += [f"| Журнал проверки в Fluent (все регионы) | `ansys_{name}/read_mesh.jou` |",
              f"| Архив ANSYS | `ansys_{name}.zip` |"]
    L += ["", "## Регионы", "",
          "| Регион | Ячеек | Патчей | Объём, м³ | max non-ortho, ° | checkMesh rc | Шлюз rc |",
          "|---|---|---|---|---|---|---|"]
    for r in regions_list:
        v = regions[r]
        g = v.get("quality_gate", {})
        L.append(f"| `{r}` | {v.get('cells')} | {v.get('boundary_patches')} | "
                 f"{v.get('total_volume_m3')} | {v.get('max_nonortho_deg')} | "
                 f"{v.get('checkmesh_rc')} | {g.get('rc')} |")
    L += ["", f"Сумма ячеек регионов: **{tot_cells}**"]
    if combined:
        L += [f"Объём: сумма регионов **{combined.get('sum_regions_m3')}** м³ vs combined "
              f"**{combined.get('total_volume_m3')}** м³ "
              f"(rel diff {combined.get('rel_diff')}, сходится: **{combined.get('match')}**)"]
    L += ["", "## Интерфейс регионов", ""]
    if report["interface"]:
        L += ["| Патч A | Граней A | Патч B | Граней B | Совпало |", "|---|---|---|---|---|"]
        for it in report["interface"]:
            L.append(f"| `{it['patch_a']}` ({it['regions'][0]}) | {it['n_faces_a']} | "
                     f"`{it['patch_b']}` ({it['regions'][1]}) | {it['n_faces_b']} | "
                     f"{'✅' if it['match'] else '❌'} |")
        L.append("")
        L.append(f"Смежность в порядке: **{report['interface_ok']}**")
    else:
        L.append("Интерфейсных патчей `<a>_to_<b>` не найдено "
                 "(регионы не связаны общей границей).")
    if report["unpaired_patches"]:
        L += ["", "Патчи без пары (ОШИБКА): "
              + ", ".join(f"`{u['region']}/{u['patch']}`" for u in report["unpaired_patches"])]
    if report.get("external_patches"):
        L += ["", "Интерфейс ведёт в регион, который не отгружается (`--regions`): "
              + ", ".join(f"`{u['region']}/{u['patch']}` → `{u['counterpart']}`"
                          for u in report["external_patches"])]
    L += ["", "## Проверки", "", "| Регион | round-trip `.msh` | tool | cells | patches | V, м³ |",
          "|---|---|---|---|---|---|"]
    for r in regions_list:
        rt = regions[r].get("ansys_roundtrip", {})
        L.append(f"| `{r}` | **{rt.get('status')}** | `{rt.get('tool')}` | {rt.get('cells')} | "
                 f"{rt.get('boundary_patches')} | {rt.get('total_volume_m3')} |")
    L += ["", f"Шлюз `mesh_gate --profile {gate_profile}`"
              + (f" (minVol={gate_min_vol})" if gate_min_vol else "") + ": "
              + ", ".join(f"`{r}` rc={regions[r].get('quality_gate', {}).get('rc')}"
                          for r in regions_list),
          "", "## Размеры", ""]
    for k, v in report["sizes_mb"].items():
        L.append(f"- `{k}`: {v} МБ")
    with open(os.path.join(out, f"delivery_{name}.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(L) + "\n")
    print(json.dumps(report, ensure_ascii=False))
PY

# =====================================================================
# 6. Итог
# =====================================================================
RC=0
if [[ "$MODE" == "single" ]]; then
  [[ "$ANSYS_STATUS" == "ok" || "$ANSYS_STATUS" == "skipped" ]] || RC=1
  [[ -z "$GATE_RC" || "$GATE_RC" -eq 0 ]] || RC=1
else
  [[ "$ANSYS_STATUS" == "ok" || "$ANSYS_STATUS" == "skipped" ]] || RC=1
  [[ -z "$GATE_RC" || "$GATE_RC" -eq 0 ]] || RC=1
  [[ "${LAYOUT_RC:-2}" -eq 0 ]] || RC=1
  [[ -z "${VOL_OK:-}" || "$VOL_OK" == "1" ]] || RC=1
  for r in "${REGIONS[@]}"; do
    [[ "${R_CMRC[$r]:-0}" == "0" ]] || RC=1
  done
fi
[[ "$KEEP_SCRATCH" -eq 0 ]] && rm -rf "$SCRATCH"
say "готово: режим=$MODE, rc=$RC → $OUT/delivery_$NAME.md"
exit "$RC"
