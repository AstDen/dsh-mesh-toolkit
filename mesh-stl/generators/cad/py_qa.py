#!/usr/bin/env python3
"""stl_qa.py — QA STL-файла для проекта Mesh_3D_pore_scale.

Зачем: в объёмное меширование идёт только watertight STL с согласованными нормалями
(корневой AGENTS.md, R9). Этот скрипт — единая точка проверки: читает STL через trimesh,
снимает метрики и сравнивает объём/площадь с аналитикой, если она передана.

Базовые метрики (все — из реального чтения файла, не «по памяти»):
  * number of triangles, vertices (processed), bodies (connected components);
  * is_watertight, is_winding_consistent, euler_number;
  * volume, area (trimesh, мм^3 / мм^2 при STL в мм);
  * bbox (min/max/size);
  * degenerate faces (нулевая площадь), duplicate vertices после merge;
  * объём/площадь vs аналитика: абсолютное и относительное отклонение, %.

Аналитика передаётся снаружи (`--expect-volume`, `--expect-area`), потому что её формула
зависит от геометрии (см. `geometry/cad/README.md`):

    V_fluid  = V_domain − Σ V_holes,
    V_domain = Lx·Ly·Lz,
    V_sphere = 4/3·π·R³,
    V_cylinder = π·R²·h,
    A_fluid  = A_domain_box − Σ A_hole_inside_block + Σ A_hole_intersection…

Для наших кейсов (сферы/цилиндры, целиком внутри блока) удобнее считать площадь поверхности
как A = A_box + Σ A_solid_removed_inside (вычитание дыр добавляет их поверхность):

    A = 2(Lx·Ly + Ly·Lz + Lz·Lx) + Σ_holes (4πR²  или  2πR·h + 2πR² для цилиндра с крышками).

Отклонение объёма у фасетной поверхности всегда ОТРИЦАТЕЛЬНОЕ (вписанный многогранник),
это не ошибка (см. env/ENV_REPORT.md §5 п.9). Для QA в этом эксперименте принят допуск
|ΔV| ≤ 2 % на сфере/плите и ≤ 3 % на цилиндрах (проверяется флагом --max-volume-err).

Проверка вырожденных граней: OCC (CadQuery) на полюсах сфер выдаёт треугольники нулевой
площади — из-за них trimesh не считает сырой STL watertight, хотя дыр нет. Поэтому
метрики считаются дважды: «сырые» и после чистки (удалить вырожденные грани + сварить
вершины), а `--clean-out PATH` пишет очищенный бинарный STL для мешинга.

Коды возврата:
  0 — все проверки пройдены (watertight после чистки, winding consistent,
      число оболочек == --expect-bodies, |ΔV| ≤ допуска);
  1 — QA не пройден (печатает, что именно);
  2 — ошибка входа (файл не найден / не читается / неверные аргументы).

Использование:
  .venv/bin/python tools/qa/stl_qa.py --stl experiments/exp-002-cadquery-stl/stl/case2_tol0.05.stl \
      --expect-volume 342.094164 --expect-area 504.764589 --json out.json

metrics.csv в эксперименте собирается отдельным скриптом (scripts/collect_metrics.py),
чтобы схема колонок была одна на весь эксперимент.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys

import numpy as np
import trimesh




def analytic_sphere_volume(r: float) -> float:
    return 4.0 / 3.0 * math.pi * r**3


def analytic_sphere_area(r: float) -> float:
    return 4.0 * math.pi * r**2


def analytic_cylinder_volume(r: float, h: float) -> float:
    return math.pi * r**2 * h


def analytic_cylinder_area(r: float, h: float) -> float:
    """Полная площадь цилиндра с двумя крышками."""
    return 2.0 * math.pi * r * h + 2.0 * math.pi * r**2


def qa_stl(path: str, expect_bodies: int | None = None) -> dict:
    """Метрики STL: «сырые» (как отдал экспортёр) и после чистки вырожденных граней.

    Почему две версии: OCC (CadQuery) на полюсах/швах сфер выдаёт вырожденные
    треугольники нулевой площади, из-за которых trimesh не считает поверхность
    watertight, хотя дыр в геометрии нет. Чистка = удалить грани нулевой площади и
    сварить вершины; на объём она не влияет (проверено в exp-002).

    expect_bodies — сколько замкнутых оболочек должно быть: 1 + число замкнутых
    полостей (у блока с 8 непроницаемыми сферами внутри оболочек 9: внешняя + 8 сфер).
    """
    mesh = trimesh.load(path, process=True, force="mesh")
    # process=True → сварка вершин по координатам (STL хранит вершины на каждый треугольник)
    triangles = int(len(mesh.faces))
    if triangles == 0:
        raise ValueError(f"{path}: в файле нет треугольников")

    # площадь граней (для поиска вырожденных)
    areas = np.asarray(mesh.area_faces, dtype=float)
    degenerate = int(np.count_nonzero(areas <= 1e-12))
    raw = trimesh.load(path, process=False, force="mesh")

    result = {
        "path": os.path.abspath(path),
        "file_size_bytes": os.path.getsize(path),
        "stl_format": "ascii" if _is_ascii_stl(path) else "binary",
        "triangles": triangles,
        "vertices_raw": int(len(raw.vertices)),
        "vertices_merged": int(len(mesh.vertices)),
        "is_watertight": bool(mesh.is_watertight),
        "is_winding_consistent": bool(mesh.is_winding_consistent),
        "euler_number": int(mesh.euler_number),
        "bodies": int(len(mesh.split(only_watertight=False))),
        "volume": float(mesh.volume),
        "area": float(mesh.area),
        "bbox_min": [float(v) for v in mesh.bounds[0]],
        "bbox_max": [float(v) for v in mesh.bounds[1]],
        "bbox_size": [float(v) for v in (mesh.bounds[1] - mesh.bounds[0])],
        "degenerate_faces": degenerate,
        "duplicate_face_groups": 0,
        "expected_bodies": expect_bodies,
        "warnings": [],
    }

    # дубликаты граней (по сортированным вершинам)
    faces_sorted = np.sort(mesh.faces, axis=1)
    _, counts = np.unique(faces_sorted, axis=0, return_counts=True)
    result["duplicate_face_groups"] = int(np.count_nonzero(counts > 1))
    if result["duplicate_face_groups"]:
        result["warnings"].append(f"duplicate faces: {result['duplicate_face_groups']} групп")

    # non-manifold: рёбра с более чем двумя гранями — касание поверхностей нулевой толщины.
    # trimesh считает такую поверхность не watertight, а snappy её всё равно мешит; поэтому
    # количество выводится отдельным полем (benchmark DEF-02).
    edges = np.sort(np.vstack([
        mesh.faces[:, [0, 1]], mesh.faces[:, [1, 2]], mesh.faces[:, [2, 0]],
    ]), axis=1)
    _, edge_counts = np.unique(edges, axis=0, return_counts=True)
    non_manifold = int(np.count_nonzero(edge_counts > 2))
    result["non_manifold_edges"] = non_manifold
    if non_manifold:
        result["warnings"].append(
            f"non-manifold: {non_manifold} рёбер с >2 гранями (касание поверхностей нулевой толщины: "
            "snappy это мешит, но оболочка не является замкнутой; держите зазор >= 2*MeshSizeMin, D-007)"
        )
    if degenerate:
        result["warnings"].append(
            f"degenerate faces: {degenerate} (объём не искажают, но ломают is_watertight)"
        )

    # --- версия после чистки: убрать вырожденные грани, сварить вершины ---
    cleaned = mesh.copy()
    cleaned.update_faces(cleaned.nondegenerate_faces())
    cleaned.merge_vertices()
    result["cleaned"] = {
        "triangles": int(len(cleaned.faces)),
        "is_watertight": bool(cleaned.is_watertight),
        "is_winding_consistent": bool(cleaned.is_winding_consistent),
        "euler_number": int(cleaned.euler_number),
        "bodies": int(len(cleaned.split(only_watertight=False))),
        "volume": float(cleaned.volume),
        "area": float(cleaned.area),
    }
    if expect_bodies is not None and result["cleaned"]["bodies"] != expect_bodies:
        result["warnings"].append(
            f"тел {result['cleaned']['bodies']}, ожидалось {expect_bodies} "
            "(1 + число замкнутых полостей)"
        )
    return result


def clean_stl(path: str, out_path: str) -> dict:
    """Записать очищенный STL (без вырожденных граней, вершины сварены), бинарный."""
    mesh = trimesh.load(path, process=True, force="mesh")
    n_before = int(len(mesh.faces))
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.merge_vertices()
    mesh.export(out_path, file_type="stl")
    return {
        "source": os.path.abspath(path),
        "output": os.path.abspath(out_path),
        "triangles_before": n_before,
        "triangles_after": int(len(mesh.faces)),
        "removed": n_before - int(len(mesh.faces)),
        "file_size_bytes": os.path.getsize(out_path),
        "is_watertight": bool(mesh.is_watertight),
        "bodies": int(len(mesh.split(only_watertight=False))),
    }


def _is_ascii_stl(path: str) -> bool:
    with open(path, "rb") as fh:
        head = fh.read(5)
    return head.lower().startswith(b"solid")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="QA STL: watertight/winding/euler/объём/площадь + сверка с аналитикой."
    )
    ap.add_argument("--stl", required=True, help="путь к STL")
    ap.add_argument("--expect-volume", type=float, default=None, help="аналитический объём, мм^3")
    ap.add_argument("--expect-area", type=float, default=None, help="аналитическая площадь, мм^2")
    ap.add_argument(
        "--max-volume-err",
        type=float,
        default=2.0,
        help="допуск |ΔV| к аналитике, %% (по умолчанию 2.0 — как в env/ENV_REPORT.md §5 п.9)",
    )
    ap.add_argument("--max-area-err", type=float, default=5.0, help="допуск |ΔA| к аналитике, %%")
    ap.add_argument(
        "--expect-bodies",
        type=int,
        default=None,
        help="ожидаемое число замкнутых оболочек: 1 + число замкнутых полостей "
             "(по умолчанию не проверяется — угадывать 1 нельзя)",
    )
    ap.add_argument(
        "--clean-out",
        default=None,
        metavar="PATH",
        help="записать очищенный STL (без вырожденных граней) в этот файл",
    )
    ap.add_argument("--json", dest="json_out", default=None, help="куда записать полный JSON")
    ap.add_argument("--quiet", action="store_true", help="не печатать человекочитаемый отчёт")
    args = ap.parse_args(argv)

    try:
        res = qa_stl(args.stl, expect_bodies=args.expect_bodies)
    except Exception as exc:  # noqa: BLE001
        print(f"QA ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2

    # вердикт ставится по ОЧИЩЕННОЙ поверхности: вырожденные грани OCC не искажают объём,
    # но формально ломают is_watertight «как есть» — это отмечается предупреждением.
    cl = res["cleaned"]
    problems: list[str] = []
    if not cl["is_watertight"]:
        problems.append("STL НЕ watertight (даже после удаления вырожденных граней)")
    if not cl["is_winding_consistent"]:
        problems.append("нормали несогласованы (winding inconsistent)")
    if args.expect_bodies is not None and cl["bodies"] != args.expect_bodies:
        problems.append(f"тел: {cl['bodies']} (ожидалось {args.expect_bodies})")
    if res["degenerate_faces"]:
        res["warnings"].append(
            f"сырой STL: {res['degenerate_faces']} вырожденных граней, is_watertight="
            f"{res['is_watertight']} -> нужен шаг чистки (--clean-out)"
        )
    if cl["volume"] <= 0:
        problems.append(f"объём <= 0 ({cl['volume']:.4f})")
    # Вердикт про «как есть»: если сырой STL не watertight и чистка не запрошена, в мешер
    # его отдавать нельзя — раньше такой файл получал PASS с предупреждением (benchmark DEF-05).
    if not args.clean_out and not res["is_watertight"]:
        problems.append(
            f"сырой STL не watertight (вырожденных граней: {res['degenerate_faces']}, "
            f"non-manifold рёбер: {res['non_manifold_edges']}): перед мешированием нужен --clean-out "
            "(в stl_check это cleanup: true)"
        )

    vol_err = area_err = None
    if args.expect_volume is not None:
        vol_err = (cl["volume"] - args.expect_volume) / args.expect_volume * 100.0
        res["expected_volume"] = args.expect_volume
        res["volume_err_pct"] = vol_err
        if abs(vol_err) > args.max_volume_err:
            problems.append(
                f"|ΔV| = {abs(vol_err):.3f}% > допуска {args.max_volume_err}% "
                f"(V={cl['volume']:.4f}, ожидалось {args.expect_volume:.4f})"
            )
    if args.expect_area is not None:
        area_err = (cl["area"] - args.expect_area) / args.expect_area * 100.0
        res["expected_area"] = args.expect_area
        res["area_err_pct"] = area_err
        if abs(area_err) > args.max_area_err:
            problems.append(f"|ΔA| = {abs(area_err):.3f}% > допуска {args.max_area_err}%")

    verdict = "PASS" if not problems else "FAIL"
    res["qa_problems"] = problems
    res["verdict"] = verdict

    if not args.quiet:
        print(f"=== stl_qa.py: {args.stl} ===")
        print(f"format:               {res['stl_format']}")
        print(f"file size:            {res['file_size_bytes']} Б")
        print(f"triangles:            {res['triangles']}")
        print(f"vertices (raw/merged):{res['vertices_raw']} / {res['vertices_merged']}")
        print(f"watertight (raw):     {res['is_watertight']}")
        print(f"watertight (cleaned): {cl['is_watertight']}")
        print(f"winding consistent:   {cl['is_winding_consistent']}")
        print(f"euler number:         {cl['euler_number']}")
        expected = "" if args.expect_bodies is None else f" (ожидалось {args.expect_bodies})"
        print(f"bodies (raw/clean):   {res['bodies']} / {cl['bodies']}{expected}")
        print(f"triangles (raw/clean):{res['triangles']} / {cl['triangles']}")
        print(f"volume (clean):       {cl['volume']:.6f} мм3")
        if vol_err is not None:
            print(
                f"  analytic:           {args.expect_volume:.6f} мм3  "
                f"err = {vol_err:+.4f} %"
            )
        print(f"area (clean):         {cl['area']:.6f} мм2")
        if area_err is not None:
            print(
                f"  analytic:           {args.expect_area:.6f} мм2  "
                f"err = {area_err:+.4f} %"
            )
        print(f"bbox size:            {[round(v, 6) for v in res['bbox_size']]} мм")
        print(f"degenerate faces:     {res['degenerate_faces']}")
        print(f"non-manifold edges:   {res['non_manifold_edges']}")
        print(f"duplicate face groups:{res['duplicate_face_groups']}")
        if res["warnings"]:
            print("warnings:")
            for w in res["warnings"]:
                print(f"  ! {w}")
        print(f"VERDICT:              {verdict}")
        if problems:
            print("problems:")
            for p in problems:
                print(f"  - {p}")

    if args.clean_out:
        try:
            info = clean_stl(args.stl, args.clean_out)
            res["clean"] = info
            print(
                f"[stl_qa] очищенный STL: {args.clean_out} "
                f"(треугольников {info['triangles_before']} -> {info['triangles_after']}, "
                f"watertight={info['is_watertight']}, filesize={info['file_size_bytes']} Б)"
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[stl_qa] ОШИБКА чистки: {type(exc).__name__}: {exc}", file=sys.stderr)
            problems.append(f"чистка STL не удалась: {exc}")
            res["verdict"] = "FAIL"

    if args.json_out:
        os.makedirs(os.path.dirname(os.path.abspath(args.json_out)), exist_ok=True)
        with open(args.json_out, "w", encoding="utf-8") as fh:
            json.dump(res, fh, ensure_ascii=False, indent=2)
        print(f"[stl_qa] JSON: {args.json_out}")

    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
