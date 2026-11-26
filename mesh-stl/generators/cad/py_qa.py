#!/usr/bin/env python3
"""stl_qa.py — STL QA for the Mesh_3D_pore_scale project.

Why: only a watertight STL with consistent normals goes into volume meshing
(root AGENTS.md, R9). This script is the single check point: it reads the STL through trimesh,
reports the metrics and compares the volume/area with the analytics when given.

Basic metrics (all from actually reading the file, not «from memory»):
  * number of triangles, vertices (processed), bodies (connected components);
  * is_watertight, is_winding_consistent, euler_number;
  * volume, area (trimesh, mm^3 / mm^2 for an STL in mm);
  * bbox (min/max/size);
  * degenerate faces (zero area), duplicate vertices after merge;
  * volume/area vs analytics: absolute and relative deviation, %.

The analytics is passed from outside (`--expect-volume`, `--expect-area`) because its formula
depends on the geometry (see `geometry/cad/README.md`):

    V_fluid  = V_domain − Σ V_holes,
    V_domain = Lx·Ly·Lz,
    V_sphere = 4/3·π·R³,
    V_cylinder = π·R²·h,
    A_fluid  = A_domain_box − Σ A_hole_inside_block + Σ A_hole_intersection…

For our cases (spheres/cylinders fully inside the block) it is more convenient to compute the surface area
as A = A_box + Σ A_solid_removed_inside (subtracting holes adds their surface):

    A = 2(Lx·Ly + Ly·Lz + Lz·Lx) + Σ_holes (4πR²  or  2πR·h + 2πR² for a cylinder with caps).

The volume deviation of a faceted surface is always NEGATIVE (inscribed polyhedron),
this is not an error (see env/ENV_REPORT.md §5 item 9). For QA in this experiment the tolerance is
|ΔV| ≤ 2 % on the sphere/plate and ≤ 3 % on the cylinders (checked by the --max-volume-err flag).

Degenerate face check: OCC (CadQuery) produces zero-area triangles at the sphere poles —
because of them trimesh does not consider the raw STL watertight even though there are no holes. Therefore
the metrics are computed twice: «raw» and after cleanup (remove degenerate faces + weld
vertices), and `--clean-out PATH` writes a cleaned binary STL for meshing.

Return codes:
  0 — all checks passed (watertight after cleanup, winding consistent,
      number of shells == --expect-bodies, |ΔV| ≤ tolerance);
  1 — QA failed (prints what exactly);
  2 — input error (file not found / unreadable / bad arguments).

Usage:
  .venv/bin/python tools/qa/stl_qa.py --stl experiments/exp-002-cadquery-stl/stl/case2_tol0.05.stl \
      --expect-volume 342.094164 --expect-area 504.764589 --json out.json

metrics.csv in the experiment is collected by a separate script (scripts/collect_metrics.py),
so that the column schema is the same for the whole experiment.
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
    """Total area of a cylinder with two caps."""
    return 2.0 * math.pi * r * h + 2.0 * math.pi * r**2


def qa_stl(path: str, expect_bodies: int | None = None) -> dict:
    """STL metrics: «raw» (as delivered by the exporter) and after cleaning the degenerate faces.

    Why two versions: OCC (CadQuery) produces degenerate
    zero-area triangles at the sphere poles/seams, because of which trimesh does not consider the surface
    watertight even though there are no holes in the geometry. Cleanup = remove the zero-area faces and
    weld the vertices; it does not affect the volume (verified in exp-002).

    expect_bodies — how many closed shells there should be: 1 + the number of closed
    cavities (a block with 8 impermeable spheres inside has 9 shells: the outer one + 8 spheres).
    """
    mesh = trimesh.load(path, process=True, force="mesh")
    # process=True -> weld the vertices by coordinates (STL stores vertices per triangle)
    triangles = int(len(mesh.faces))
    if triangles == 0:
        raise ValueError(f"{path}: the file has no triangles")

    # face areas (to find the degenerate ones)
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

    # duplicate faces (by sorted vertices)
    faces_sorted = np.sort(mesh.faces, axis=1)
    _, counts = np.unique(faces_sorted, axis=0, return_counts=True)
    result["duplicate_face_groups"] = int(np.count_nonzero(counts > 1))
    if result["duplicate_face_groups"]:
        result["warnings"].append(f"duplicate faces: {result['duplicate_face_groups']} groups")

    # non-manifold: edges with more than two faces — zero-thickness surface contact.
    # trimesh considers such a surface not watertight, while snappy meshes it anyway; therefore
    # the count is reported in a separate field (benchmark DEF-02).
    edges = np.sort(np.vstack([
        mesh.faces[:, [0, 1]], mesh.faces[:, [1, 2]], mesh.faces[:, [2, 0]],
    ]), axis=1)
    _, edge_counts = np.unique(edges, axis=0, return_counts=True)
    non_manifold = int(np.count_nonzero(edge_counts > 2))
    result["non_manifold_edges"] = non_manifold
    if non_manifold:
        result["warnings"].append(
            f"non-manifold: {non_manifold} edges with >2 faces (zero-thickness surface contact: "
            "snappy meshes it, but the shell is not closed; keep the gap >= 2*MeshSizeMin, D-007)"
        )
    if degenerate:
        result["warnings"].append(
            f"degenerate faces: {degenerate} (they do not distort the volume but break is_watertight)"
        )

    # --- cleaned version: remove the degenerate faces, weld the vertices ---
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
            f"bodies {result['cleaned']['bodies']}, expected {expect_bodies} "
            "(1 + number of closed voids)"
        )
    if degenerate:
        flag = "True" if result["is_watertight"] else "False"
        result["warnings"].append(
            f"raw STL: {degenerate} degenerate faces, is_watertight={flag} -> "
            "a cleanup step is needed (--clean-out)"
        )
    return result


def clean_stl(path: str, out_path: str) -> dict:
    """Write a cleaned STL (no degenerate faces, vertices welded), binary."""
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
        description="STL QA: watertight/winding/euler/volume/area + comparison with the analytics."
    )
    ap.add_argument("--stl", required=True, help="path to the STL")
    ap.add_argument("--expect-volume", type=float, default=None, help="analytic volume, mm^3")
    ap.add_argument("--expect-area", type=float, default=None, help="analytic area, mm^2")
    ap.add_argument(
        "--max-volume-err",
        type=float,
        default=2.0,
        help="tolerance |ΔV| to the analytics, %% (default 2.0 — as in env/ENV_REPORT.md §5 item 9)",
    )
    ap.add_argument("--max-area-err", type=float, default=5.0, help="tolerance |ΔA| to the analytics, %%")
    ap.add_argument(
        "--expect-bodies",
        type=int,
        default=None,
        help="expected number of closed shells: 1 + the number of closed cavities "
             "(not checked by default — guessing 1 is not allowed)",
    )
    ap.add_argument(
        "--clean-out",
        default=None,
        metavar="PATH",
        help="write the cleaned STL (without degenerate faces) to this file",
    )
    ap.add_argument("--json", dest="json_out", default=None, help="where to write the full JSON")
    ap.add_argument("--quiet", action="store_true", help="do not print the human-readable report")
    args = ap.parse_args(argv)

    try:
        res = qa_stl(args.stl, expect_bodies=args.expect_bodies)
    except Exception as exc:  # noqa: BLE001
        print(f"QA ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2

    # the verdict is based on the CLEANED surface: OCC degenerate faces do not distort the volume,
    # but formally break is_watertight «as is» — this is flagged by a warning.
    cl = res["cleaned"]
    problems: list[str] = []
    if not cl["is_watertight"]:
        problems.append("STL is NOT watertight (even after removing degenerate faces)")
    if not cl["is_winding_consistent"]:
        problems.append("normals are inconsistent (winding inconsistent)")
    if args.expect_bodies is not None and cl["bodies"] != args.expect_bodies:
        problems.append(f"bodies: {cl['bodies']} (expected {args.expect_bodies})")
    if cl["volume"] <= 0:
        problems.append(f"volume <= 0 ({cl['volume']:.4f})")
    # as-is verdict: the raw STL is not watertight and no cleanup was requested — it must not go to
    # the mesher (previously such a file got PASS with a warning — benchmark DEF-05).
    if not args.clean_out and not res["is_watertight"]:
        problems.append(
            f"raw STL is not watertight (degenerate faces: {res['degenerate_faces']}, "
            f"non-manifold edges: {res['non_manifold_edges']}): run --clean-out before meshing "
            "(cleanup: true in stl_check)"
        )

    vol_err = area_err = None
    if args.expect_volume is not None:
        vol_err = (cl["volume"] - args.expect_volume) / args.expect_volume * 100.0
        res["expected_volume"] = args.expect_volume
        res["volume_err_pct"] = vol_err
        if abs(vol_err) > args.max_volume_err:
            problems.append(
                f"|ΔV| = {abs(vol_err):.3f}% > tolerance {args.max_volume_err}% "
                f"(V={cl['volume']:.4f}, expected {args.expect_volume:.4f})"
            )
    if args.expect_area is not None:
        area_err = (cl["area"] - args.expect_area) / args.expect_area * 100.0
        res["expected_area"] = args.expect_area
        res["area_err_pct"] = area_err
        if abs(area_err) > args.max_area_err:
            problems.append(f"|ΔA| = {abs(area_err):.3f}% > tolerance {args.max_area_err}%")

    verdict = "PASS" if not problems else "FAIL"
    res["qa_problems"] = problems
    res["verdict"] = verdict

    if not args.quiet:
        print(f"=== stl_qa.py: {args.stl} ===")
        print(f"format:               {res['stl_format']}")
        print(f"file size:            {res['file_size_bytes']} B")
        print(f"triangles:            {res['triangles']}")
        print(f"vertices (raw/merged):{res['vertices_raw']} / {res['vertices_merged']}")
        print(f"watertight (raw):     {res['is_watertight']}")
        print(f"watertight (cleaned): {cl['is_watertight']}")
        print(f"winding consistent:   {cl['is_winding_consistent']}")
        print(f"euler number:         {cl['euler_number']}")
        expected = "" if args.expect_bodies is None else f" (expected {args.expect_bodies})"
        print(f"bodies (raw/clean):   {res['bodies']} / {cl['bodies']}{expected}")
        print(f"triangles (raw/clean):{res['triangles']} / {cl['triangles']}")
        print(f"volume (clean):       {cl['volume']:.6f} mm3")
        if vol_err is not None:
            print(
                f"  analytic:           {args.expect_volume:.6f} mm3  "
                f"err = {vol_err:+.4f} %"
            )
        print(f"area (clean):         {cl['area']:.6f} mm2")
        if area_err is not None:
            print(
                f"  analytic:           {args.expect_area:.6f} mm2  "
                f"err = {area_err:+.4f} %"
            )
        print(f"bbox size:            {[round(v, 6) for v in res['bbox_size']]} mm")
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
                f"[stl_qa] cleaned STL: {args.clean_out} "
                f"(triangles {info['triangles_before']} -> {info['triangles_after']}, "
                f"watertight={info['is_watertight']}, filesize={info['file_size_bytes']} B)"
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[stl_qa] CLEANUP ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
            problems.append(f"STL cleanup failed: {exc}")
            res["verdict"] = "FAIL"

    if args.json_out:
        os.makedirs(os.path.dirname(os.path.abspath(args.json_out)), exist_ok=True)
        with open(args.json_out, "w", encoding="utf-8") as fh:
            json.dump(res, fh, ensure_ascii=False, indent=2)
        print(f"[stl_qa] JSON: {args.json_out}")

    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
