#!/usr/bin/env python3
"""gen_fcc_cell.py — elementary 3D unit cell of an FCC sphere packing with necks.

Reproduces the geometry from the Blender script
`14_OpenFoam-test/elementary_cell_face_centered/mesing/blender/skript` (verified by reading, 2026-11-18):

    a = sqrt(2) * diameter                        # FCC spacing along a coordinate axis
    spheres: radius diameter/2 at the corners (0,0,0) and at the face centers
          (d/sqrt2, d/sqrt2, 0), (d/sqrt2, 0, d/sqrt2), (0, d/sqrt2, d/sqrt2)
    necks: cylinders of radius 0.1*diameter, length 1.5*diameter, 6 at every center
           rotated by (±45°, 0, 0), (±45°, 90°, 0), (±45°, 0, 90°)
    everything is clipped by the domain box (in Blender — by symmetry planes)

Output: binary STL of the solid skeleton (mm) + cleaned STL + JSON passport with QA.

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


# ----------------------------------------------------------------------------- parameters
DEFAULTS = {
    "diameter_mm": 5.0,
    "sphere_r_frac": 0.5,             # r = frac*diameter; 0.49 -> 0.1 mm gap at the contact points
    "lattice_mode": "quarter_cell",   # quarter_cell: x,y in [0,a/2], z in [0,a]
    "neck_radius_frac": 0.1,          # 0.1*diameter (as in the Blender script)
    "neck_depth_frac": 1.5,           # 1.5*diameter
    "neck_angles_deg": [[45, 0, 0], [-45, 0, 0], [45, 90, 0], [-45, 90, 0], [45, 0, 90], [-45, 0, 90]],
    "sphere_ang_tol_rad": 0.1,        # angularTolerance of the STL export
    "sphere_lin_tol_mm": 0.05,
    "clip_pad_mm": 0.0,               # >0: clip by a box with a margin (the necks stick out)
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
    a = math.sqrt(2.0) * d            # FCC spacing along the axis
    r = float(p.get("sphere_r_frac", 0.5)) * d
    off = d / math.sqrt(2.0)          # = a/2 — offset of the face centers
    if p["lattice_mode"] == "quarter_cell":
        x0, x1 = 0.0, a / 2.0
        y0, y1 = 0.0, a / 2.0
        z0, z1 = 0.0, a
    elif p["lattice_mode"] == "unit_cell":
        x0, x1 = 0.0, a
        y0, y1 = 0.0, a
        z0, z1 = 0.0, a
    else:
        raise ValueError(f"unknown lattice_mode: {p['lattice_mode']}")
    pad = float(p.get("clip_pad_mm", 0.0))
    # sphere centers that fall inside the domain (one cell along z and symmetric x,y)
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
        # IMPORTANT: cq.Solid.makeSphere(r, center) gives a HALF-SPHERE by default
        # (bbox z 0..r, V = 2/3*pi*r^3) — verified in exp-003. Set the latitudes -90..90 explicitly.
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

    # boolean union (fuse sequentially; fast for dozens of bodies)
    t1 = time.perf_counter()
    fused = solids[0]
    for s in solids[1:]:
        fused = fused.fuse(s)
    # remove internal faces (OCC: the union already yields one solid, but simplify it)
    try:
        fused = fused.clean()
    except Exception:  # noqa: BLE001 — clean is not critical
        pass
    t_fuse = time.perf_counter() - t1

    # clip by the domain
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
    ap.add_argument("--out", required=True, help="raw STL")
    ap.add_argument("--clean-out", default=None, help="cleaned STL")
    ap.add_argument("--json", default=None, help="JSON passport")
    ap.add_argument("--check", action="store_true", help="checks + return code")
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
                problems.append(f"mesh volume differs from OCC by {dv:.3f} %")
            if not cl["watertight"]:
                problems.append("cleaned STL is not watertight")
            if cl["bodies"] < 1:
                problems.append("no bodies in the STL")
        x0, y0, z0 = geo["cell_min"]
        x1, y1, z1 = geo["cell_max"]
        bb = cl.get("bbox_mm") or [0] * 6
        exp = [x0, y0, z0, x1, y1, z1]
        if bb and any(abs(a - b) > 1e-3 for a, b in zip(bb, exp)):
            problems.append(f"bbox {bb} != domain {exp}")
        # self-check: a full sphere must have volume 4/3*pi*r^3 (guards against the makeSphere trap)
        r_test = geo["sphere_r_mm"]
        v_test = occ_volume(cq.Solid.makeSphere(
            r_test, pnt=cq.Vector(0, 0, 0),
            angleDegrees1=-90.0, angleDegrees2=90.0, angleDegrees3=360.0,
        ))
        v_expect = 4.0 / 3.0 * math.pi * r_test ** 3
        err = abs(v_test - v_expect) / v_expect * 100.0
        report["sphere_selftest"] = {"volume_mm3": v_test, "expected_mm3": v_expect, "err_pct": round(err, 4)}
        if err > 1.0:
            problems.append(f"sphere self-check: {v_test:.3f} != {v_expect:.3f} mm³ ({err:.2f} %) — half-sphere?")
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
