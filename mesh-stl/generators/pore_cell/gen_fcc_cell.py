#!/usr/bin/env python3
"""gen_fcc_cell.py — элементарная 3D-ячейка FCC-упаковки шаров с шейками (necks).

Повторяет геометрию из Blender-скрипта
`14_OpenFoam-test/elementary_cell_face_centered/mesing/blender/скрипт` (проверено чтением 2026-11-18):

    a = sqrt(2) * diameter                        # шаг FCC по координатной оси
    шары: радиус diameter/2 в углах (0,0,0) и в центрах граней
          (d/sqrt2, d/sqrt2, 0), (d/sqrt2, 0, d/sqrt2), (0, d/sqrt2, d/sqrt2)
    шейки: цилиндры радиусом 0.1*diameter, длиной 1.5*diameter, по 6 штук в каждом центре
           с поворотами (±45°, 0, 0), (±45°, 90°, 0), (±45°, 0, 90°)
    всё обрезается боксом домена (в Blender — плоскостями симметрии)

Выход: бинарный STL твёрдого скелета (мм) + очищенный STL + JSON-паспорт с QA.

CLI:
    python gen_fcc_cell.py --params-file params/fcc_cell_d5.json --out stl/fcc_cell_d5_solid_raw.stl \
        --clean-out stl/fcc_cell_d5_solid.stl --json logs/gen_fcc_cell.json [--check]
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import cadquery as cq
import numpy as np
import trimesh
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps


# ----------------------------------------------------------------------------- параметры
DEFAULTS = {
    "diameter_mm": 5.0,
    "sphere_r_frac": 0.5,             # r = frac*diameter; 0.49 -> зазор 0.1 мм в точках касания
    "lattice_mode": "quarter_cell",   # quarter_cell: x,y в [0,a/2], z в [0,a]
    "neck_radius_frac": 0.1,          # 0.1*diameter (как в Blender-скрипте)
    "neck_depth_frac": 1.5,           # 1.5*diameter
    "neck_angles_deg": [[45, 0, 0], [-45, 0, 0], [45, 90, 0], [-45, 90, 0], [45, 0, 90], [-45, 0, 90]],
    "sphere_ang_tol_rad": 0.1,        # angularTolerance экспорта STL
    "sphere_lin_tol_mm": 0.05,
    "clip_pad_mm": 0.0,               # >0: обрезка боксом с запасом (шейки торчат наружу)
    "write_debug_step": False,
}


def load_params(path: str | None) -> dict:
    p = dict(DEFAULTS)
    if path:
        user = json.loads(Path(path).read_text(encoding="utf-8"))
        p.update(user)
    return p


def lattice(p: dict) -> dict:
    d = float(p["diameter_mm"])
    a = math.sqrt(2.0) * d            # шаг FCC вдоль оси
    r = float(p.get("sphere_r_frac", 0.5)) * d
    off = d / math.sqrt(2.0)          # = a/2 — смещение центров граней
    if p["lattice_mode"] == "quarter_cell":
        x0, x1 = 0.0, a / 2.0
        y0, y1 = 0.0, a / 2.0
        z0, z1 = 0.0, a
    elif p["lattice_mode"] == "unit_cell":
        x0, x1 = 0.0, a
        y0, y1 = 0.0, a
        z0, z1 = 0.0, a
    else:
        raise ValueError(f"неизвестный lattice_mode: {p['lattice_mode']}")
    pad = float(p.get("clip_pad_mm", 0.0))
    # центры шаров, попадающие в домен (по одной ячейке по z и симметричным x,y)
    centers = [
        (0.0, 0.0, 0.0),
        (0.0, 0.0, a),
        (off, off, 0.0),
        (off, off, a),
        (off, 0.0, a / 2.0),
        (0.0, off, a / 2.0),
    ]
    if p["lattice_mode"] == "unit_cell":
        centers += [
            (a, 0.0, 0.0), (a, a, 0.0), (0.0, a, 0.0),
            (a, 0.0, a), (a, a, a), (0.0, a, a),
            (a / 2.0, 0.0, 0.0), (0.0, a / 2.0, 0.0), (a, a / 2.0, 0.0),
            (a / 2.0, a, 0.0), (a / 2.0, a / 2.0, a / 2.0),
            (a, 0.0, a / 2.0), (a / 2.0, 0.0, a), (0.0, 0.0, a / 2.0),
            (0.0, a / 2.0, a), (a, a, a / 2.0), (a / 2.0, a, a),
        ]
    return {
        "diameter_mm": d, "a_mm": a, "sphere_r_mm": r, "face_offset_mm": off,
        "cell_min": [x0 - pad, y0 - pad, z0 - pad],
        "cell_max": [x1 + pad, y1 + pad, z1 + pad],
        "centers": centers,
        "neck_radius_mm": float(p["neck_radius_frac"]) * d,
        "neck_height_mm": float(p["neck_depth_frac"]) * d,
    }


def occ_volume(shape: cq.Shape) -> float:
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape.wrapped, props)
    return abs(props.Mass())


def build_solid(p: dict, geo: dict) -> tuple[cq.Shape, dict]:
    t0 = time.perf_counter()
    d = geo["diameter_mm"]
    r = geo["sphere_r_mm"]
    nr = geo["neck_radius_mm"]
    nh = geo["neck_height_mm"]
    angles = [tuple(map(float, ang)) for ang in p["neck_angles_deg"]]

    solids: list[cq.Shape] = []
    n_spheres = 0
    n_necks = 0
    for (cx, cy, cz) in geo["centers"]:
        # ВАЖНО: cq.Solid.makeSphere(r, center) по умолчанию даёт ПОЛУСФЕРУ
        # (bbox z 0..r, V = 2/3*pi*r^3) — проверено в exp-003. Явно задаём широты -90..90.
        sph = cq.Solid.makeSphere(
            r, pnt=cq.Vector(cx, cy, cz),
            angleDegrees1=-90.0, angleDegrees2=90.0, angleDegrees3=360.0,
        )
        solids.append(sph)
        n_spheres += 1
        for (rx, ry, rz) in angles:
            cyl = cq.Solid.makeCylinder(
                nr, nh, cq.Vector(0, 0, -nh / 2.0), cq.Vector(0, 0, 1)
            )
            if rx:
                cyl = cyl.rotate(cq.Vector(0, 0, 0), cq.Vector(1, 0, 0), rx)
            if ry:
                cyl = cyl.rotate(cq.Vector(0, 0, 0), cq.Vector(0, 1, 0), ry)
            if rz:
                cyl = cyl.rotate(cq.Vector(0, 0, 0), cq.Vector(0, 0, 1), rz)
            solids.append(cyl.translate(cq.Vector(cx, cy, cz)))
            n_necks += 1

    t_build_objects = time.perf_counter() - t0

    # булево объединение (fuse последовательно; для десятков тел быстро)
    t1 = time.perf_counter()
    fused = solids[0]
    for s in solids[1:]:
        fused = fused.fuse(s)
    # убрать внутренние грани (OCC: объединение уже даёт один solid, но упростим)
    try:
        fused = fused.clean()
    except Exception:  # noqa: BLE001 — clean не критичен
        pass
    t_fuse = time.perf_counter() - t1

    # обрезка доменом
    x0, y0, z0 = geo["cell_min"]
    x1, y1, z1 = geo["cell_max"]
    box = cq.Solid.makeBox(x1 - x0, y1 - y0, z1 - z0, cq.Vector(x0, y0, z0))
    t2 = time.perf_counter()
    clipped = fused.intersect(box)
    t_clip = time.perf_counter() - t2

    info = {
        "n_spheres": n_spheres, "n_necks": n_necks,
        "t_objects_s": round(t_build_objects, 4),
        "t_fuse_s": round(t_fuse, 4),
        "t_clip_s": round(t_clip, 4),
        "volume_occ_mm3": occ_volume(clipped),
        "volume_occ_unclipped_mm3": occ_volume(fused),
        "n_solids_clipped": len(clipped.Solids()),
    }
    return clipped, info


def export_stl(shape: cq.Shape, out: Path, ang_tol: float, lin_tol: float) -> dict:
    out.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.perf_counter()
    cq.exporters.export(shape, str(out), tolerance=lin_tol, angularTolerance=ang_tol)
    return {"path": str(out), "bytes": out.stat().st_size, "t_export_s": round(time.perf_counter() - t0, 4)}


def clean_stl(src: Path, dst: Path) -> dict:
    mesh = trimesh.load(str(src), process=True, force="mesh")
    raw_tris = len(mesh.faces)
    raw_watertight = bool(mesh.is_watertight)
    mesh.merge_vertices()
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.update_faces(mesh.unique_faces())
    mesh.remove_unreferenced_vertices()
    dst.parent.mkdir(parents=True, exist_ok=True)
    mesh.export(str(dst))
    m2 = trimesh.load(str(dst), process=True, force="mesh")
    return {
        "raw_triangles": raw_tris, "raw_watertight": raw_watertight,
        "triangles": len(m2.faces), "watertight": bool(m2.is_watertight),
        "winding_consistent": bool(m2.is_winding_consistent),
        "volume_mm3": float(m2.volume), "area_mm2": float(m2.area),
        "bodies": len(m2.split(only_watertight=False)),
        "bbox_mm": [round(float(v), 5) for v in m2.bounds.flatten()],
        "dst": str(dst), "bytes": dst.stat().st_size,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="FCC elementary cell (spheres + necks) -> STL")
    ap.add_argument("--params-file", default=None)
    ap.add_argument("--out", required=True, help="сырой STL")
    ap.add_argument("--clean-out", default=None, help="очищенный STL")
    ap.add_argument("--json", default=None, help="JSON-паспорт")
    ap.add_argument("--check", action="store_true", help="проверки + код возврата")
    args = ap.parse_args(argv)

    p = load_params(args.params_file)
    geo = lattice(p)
    t_start = time.perf_counter()
    shape, info = build_solid(p, geo)
    raw = export_stl(shape, Path(args.out), p["sphere_ang_tol_rad"], p["sphere_lin_tol_mm"])
    report = {
        "generator": "geometry/pore_cell/gen_fcc_cell.py",
        "params_file": args.params_file,
        "params": p, "geometry": {k: v for k, v in geo.items() if k != "centers"},
        "centers": geo["centers"],
        "build": info, "raw_stl": raw,
        "t_total_s": None,
    }
    if args.clean_out:
        report["clean"] = clean_stl(Path(args.out), Path(args.clean_out))
    report["t_total_s"] = round(time.perf_counter() - t_start, 3)

    ok = True
    if args.check:
        problems = []
        cl = report.get("clean") or {}
        vol_occ = info["volume_occ_mm3"]
        if cl and cl["triangles"] > 0:
            dv = abs(cl["volume_mm3"] - vol_occ) / vol_occ * 100.0
            report["volume_err_pct_mesh_vs_occ"] = round(dv, 4)
            if dv > 1.0:
                problems.append(f"объём сетки расходится с OCC на {dv:.3f} %")
            if not cl["watertight"]:
                problems.append("очищенный STL не watertight")
            if cl["bodies"] < 1:
                problems.append("нет тел в STL")
        x0, y0, z0 = geo["cell_min"]
        x1, y1, z1 = geo["cell_max"]
        bb = cl.get("bbox_mm") or [0] * 6
        exp = [x0, y0, z0, x1, y1, z1]
        if bb and any(abs(a - b) > 1e-3 for a, b in zip(bb, exp)):
            problems.append(f"bbox {bb} != домен {exp}")
        # самопроверка: полный шар должен иметь объём 4/3*pi*r^3 (защита от ловушки makeSphere)
        r_test = geo["sphere_r_mm"]
        v_test = occ_volume(cq.Solid.makeSphere(
            r_test, pnt=cq.Vector(0, 0, 0),
            angleDegrees1=-90.0, angleDegrees2=90.0, angleDegrees3=360.0,
        ))
        v_expect = 4.0 / 3.0 * math.pi * r_test ** 3
        err = abs(v_test - v_expect) / v_expect * 100.0
        report["sphere_selftest"] = {"volume_mm3": v_test, "expected_mm3": v_expect, "err_pct": round(err, 4)}
        if err > 1.0:
            problems.append(f"самопроверка шара: {v_test:.3f} != {v_expect:.3f} мм³ ({err:.2f} %) — полусфера?")
        report["problems"] = problems
        ok = not problems

    if args.json:
        Path(args.json).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: report[k] for k in ("build", "raw_stl")}, ensure_ascii=False, indent=2))
    if report.get("clean"):
        print(json.dumps(report["clean"], ensure_ascii=False, indent=2))
    print(f"VERDICT: {'PASS' if ok else 'FAIL'}  (t_total={report['t_total_s']} s)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
