#!/usr/bin/env python3
"""gen_blob_foam.py — porous «blob» foam: metaball field → isosurface → clipping by the domain.

Reproduces the approach of the Blender script `Blender_porous/test_01/script_generation.py`
(metaballs in a cylinder + voxel remesh + Boolean Intersect), but without Blender and without CAD:

    field   f(x) = Σ_i s·(1 − |x−c_i|²/R_i²)³   for |x−c_i| < R_i, otherwise 0
    solid   f ≥ threshold
    domain  smooth analytic SDF (cylinder along z or a box)
    output  volume boundary min(…) → marching cubes once, watertight by construction

Key replacement of the Blender pipeline: instead of «convert + voxel remesh + boolean intersect»
we evaluate a scalar field on a regular grid and take the isosurface

    g(x) = max( threshold − f(x),  sdf_domain(x) ),      g = 0 — the wanted surface

— the clipping by the domain comes out exact (the smooth SDF is interpolated by marching cubes),
boolean operations and remeshing are not needed, the surface closes by itself.

Parameters (JSON) — see DEFAULTS; `target_porosity` enables threshold selection by bisection,
in that case the `threshold` field in the parameter file is ignored.

Output: binary STL of the solid phase in mm, a cleaned STL for meshing, a JSON report with
porosity, connectivity of the solid/pore space and thicknesses (from the voxels).

CLI:
    python gen_blob_foam.py --params-file params/blob_foam_d10x10.json \
        --out stl/blob_raw.stl --clean-out stl/blob.stl --json logs/gen_blob_foam.json
"""
from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import numpy as np
import trimesh
from scipy import ndimage
from skimage import measure


DEFAULTS: dict = {
    "seed": 1,
    # domain: {"kind": "cylinder", "radius_mm": 5.0, "height_mm": 10.0}  (z axis)
    #        {"kind": "box", "size_mm": [10, 10, 10]}
    "domain": {"kind": "cylinder", "radius_mm": 5.0, "height_mm": 10.0},
    "n_balls": 680,
    # ball radius distribution: uniform | lognormal | mono
    "radius_mm": {"dist": "uniform", "min": 0.425, "max": 1.375},
    "stiffness": 2.0,          # field multiplier (like s in a Blender metaball)
    "threshold": 0.53,         # isothreshold of the field sum (like meta_threshold)
    "target_porosity": None,   # when set — threshold is fitted by bisection to φ
    "voxel_mm": 0.06,          # field grid step (analogue of voxel_remesh_size)
    "wall_margin_cells": 2,    # grid margin beyond the domain so that the surface closes
}


# --------------------------------------------------------------------------- parameters
def load_params(path: str | None) -> dict:
    p = json.loads(json.dumps(DEFAULTS))          # deep copy
    if path:
        user = json.loads(Path(path).read_text(encoding="utf-8"))
        for k, v in user.items():
            if isinstance(v, dict) and isinstance(p.get(k), dict):
                p[k].update(v)
            else:
                p[k] = v
    return p


def sample_radii(p: dict, rng: np.random.Generator, n: int) -> np.ndarray:
    spec = p["radius_mm"]
    dist = spec.get("dist", "uniform")
    if dist == "mono":
        return np.full(n, float(spec.get("value", spec.get("min", 1.0))), dtype=np.float64)
    if dist == "lognormal":
        med = float(spec.get("median", 0.5 * (spec["min"] + spec["max"])))
        sigma = float(spec.get("sigma", 0.35))
        r = rng.lognormal(mean=math.log(med), sigma=sigma, size=n)
        return np.clip(r, float(spec["min"]), float(spec["max"]))
    lo, hi = float(spec["min"]), float(spec["max"])
    return rng.uniform(lo, hi, size=n)


def sample_centers(p: dict, rng: np.random.Generator, n: int) -> np.ndarray:
    """Uniform over the domain volume (cylinder: r = R·√u over the section, as in the Blender script)."""
    dom = p["domain"]
    if dom["kind"] == "cylinder":
        R = float(dom["radius_mm"])
        H = float(dom["height_mm"])
        rr = R * np.sqrt(rng.random(n))
        th = rng.random(n) * 2.0 * math.pi
        x = rr * np.cos(th)
        z = rr * np.sin(th)
        y = rng.uniform(-H / 2.0, H / 2.0, n)
        return np.column_stack([x, y, z])
    sx, sy, sz = (float(v) for v in dom["size_mm"])
    return np.column_stack([
        rng.uniform(-sx / 2, sx / 2, n),
        rng.uniform(-sy / 2, sy / 2, n),
        rng.uniform(-sz / 2, sz / 2, n),
    ])


# --------------------------------------------------------------------------- grid and field
def make_grid(p: dict) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    h = float(p["voxel_mm"])
    dom = p["domain"]
    if dom["kind"] == "cylinder":
        R, H = float(dom["radius_mm"]), float(dom["height_mm"])
        ext = np.array([R, H / 2.0, R])
    else:
        ext = np.array([float(v) / 2.0 for v in dom["size_mm"]])
    pad = p["wall_margin_cells"] * h
    lo, hi = -ext - pad, ext + pad
    n = np.maximum(np.ceil((hi - lo) / h).astype(int) + 1, 3)
    xs = lo[0] + h * np.arange(n[0])
    ys = lo[1] + h * np.arange(n[1])
    zs = lo[2] + h * np.arange(n[2])
    # axis grid with margin: the ball centers lie inside the domain, so hi-lo covers the field
    return xs.astype(np.float64), ys.astype(np.float64), zs.astype(np.float64), n


def domain_sdf(X, Y, Z, p: dict) -> np.ndarray:
    """Smooth SDF of the domain: <0 inside, >0 outside (exact distance, mm)."""
    dom = p["domain"]
    if dom["kind"] == "cylinder":
        R, Hh = float(dom["radius_mm"]), float(dom["height_mm"]) / 2.0
        qr = np.sqrt(X * X + Z * Z) - R
        qy = np.abs(Y) - Hh
        outside = np.sqrt(np.maximum(qr, 0) ** 2 + np.maximum(qy, 0) ** 2)
        inside = np.minimum(np.maximum(qr, qy), 0.0)
        return inside + outside
    ex = np.abs(X) - float(dom["size_mm"][0]) / 2.0
    ey = np.abs(Y) - float(dom["size_mm"][1]) / 2.0
    ez = np.abs(Z) - float(dom["size_mm"][2]) / 2.0
    outside = np.sqrt(np.maximum(ex, 0) ** 2 + np.maximum(ey, 0) ** 2 + np.maximum(ez, 0) ** 2)
    inside = np.minimum(np.maximum(np.maximum(ex, ey), ez), 0.0)
    return inside + outside


def ball_field(xs, ys, zs, centers, radii, stiffness) -> np.ndarray:
    """Sum of the ball fields, only inside local boxes (fast and without extra memory)."""
    f = np.zeros((len(xs), len(ys), len(zs)), dtype=np.float32)
    s = float(stiffness)
    h = xs[1] - xs[0]
    for (cx, cy, cz), R in zip(centers, radii):
        i0 = max(int(math.floor((cx - R - xs[0]) / h)), 0)
        i1 = min(int(math.ceil((cx + R - xs[0]) / h)) + 1, len(xs))
        j0 = max(int(math.floor((cy - R - ys[0]) / h)), 0)
        j1 = min(int(math.ceil((cy + R - ys[0]) / h)) + 1, len(ys))
        k0 = max(int(math.floor((cz - R - zs[0]) / h)), 0)
        k1 = min(int(math.ceil((cz + R - zs[0]) / h)) + 1, len(zs))
        if i0 >= i1 or j0 >= j1 or k0 >= k1:
            continue
        dx = (xs[i0:i1] - cx) ** 2
        dy = (ys[j0:j1] - cy) ** 2
        dz = (zs[k0:k1] - cz) ** 2
        d2 = (dx[:, None, None] + dy[None, :, None] + dz[None, None, :]) / (R * R)
        loc = 1.0 - d2
        np.maximum(loc, 0.0, out=loc)
        loc = loc * loc * loc
        f[i0:i1, j0:j1, k0:k1] += s * loc.astype(np.float32)
    return f


def solid_mask(f, sdf, threshold) -> np.ndarray:
    return (f >= threshold) & (sdf < 0.0)


def porosity_of(f, sdf, threshold) -> float:
    inside = sdf < 0.0
    n_in = int(inside.sum())
    if n_in == 0:
        return 0.0
    n_solid = int(((f >= threshold) & inside).sum())
    return 1.0 - n_solid / n_in


def solve_threshold(f, sdf, target: float, lo: float = 1e-6, hi: float = None,
                    iters: int = 28) -> tuple[float, float]:
    """Bisection on the isothreshold: φ GROWS MONOTONICALLY with threshold (the blob shrinks).

    Upper bound is the field peak: for threshold > peak there is no solid phase (φ → 1).
    """
    if hi is None:
        hi = float(f.max()) * 1.02 + 1e-6
    phi_hi = porosity_of(f, sdf, hi)
    if phi_hi < target:                      # the target is unreachable even with no solid at all
        return hi, phi_hi
    phi_lo = porosity_of(f, sdf, lo)
    if phi_lo > target:                      # the target is below the minimum porosity (everything solid)
        return lo, phi_lo
    for _ in range(iters):
        mid = 0.5 * (lo + hi)
        if porosity_of(f, sdf, mid) < target:
            lo = mid
        else:
            hi = mid
    t = 0.5 * (lo + hi)
    return t, porosity_of(f, sdf, t)


# --------------------------------------------------------------------------- analysis
def medial_thickness(mask: np.ndarray, h: float) -> dict:
    """Local thickness = 2·EDT at the skeleton voxels (local maxima of the EDT)."""
    if not mask.any():
        return {}
    edt = ndimage.distance_transform_edt(mask, sampling=h).astype(np.float32)
    local_max = edt == ndimage.maximum_filter(edt, size=3)
    skeleton_vals = 2.0 * edt[local_max & mask]
    if skeleton_vals.size == 0:
        skeleton_vals = 2.0 * edt[mask]
    q = np.percentile(skeleton_vals, [5, 25, 50, 75, 95])
    return {
        "p5_mm": round(float(q[0]), 4), "p25_mm": round(float(q[1]), 4),
        "median_mm": round(float(q[2]), 4), "p75_mm": round(float(q[3]), 4),
        "p95_mm": round(float(q[4]), 4),
        "max_mm": round(float(skeleton_vals.max()), 4),
        "n_skeleton_voxels": int(skeleton_vals.size),
    }


def connectivity_stats(mask: np.ndarray) -> dict:
    """Connected components under 6-connectivity (face neighbours), fraction of the largest one."""
    total = int(mask.sum())
    if total == 0:
        return {"n_components": 0, "largest_fraction": 0.0, "total_voxels": 0}
    lab, n = ndimage.label(mask)
    sizes = np.bincount(lab.ravel())[1:] if n else np.array([0])
    return {
        "n_components": int(n),
        "largest_fraction": round(float(sizes.max() / total), 5) if n else 0.0,
        "largest_voxels": int(sizes.max()) if n else 0,
        "total_voxels": total,
        "sizes_top5": [int(v) for v in np.sort(sizes)[-5:][::-1]],
    }


# --------------------------------------------------------------------------- STL
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
        "volume_mm3": round(float(m2.volume), 4), "area_mm2": round(float(m2.area), 3),
        "bodies": len(m2.split(only_watertight=False)),
        "bbox_mm": [round(float(v), 5) for v in m2.bounds.flatten()],
        "dst": str(dst), "bytes": dst.stat().st_size,
    }


# --------------------------------------------------------------------------- main
def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Porous blob foam: metaballs → STL (mm)")
    ap.add_argument("--params-file", default=None)
    ap.add_argument("--out", required=True, help="raw STL")
    ap.add_argument("--clean-out", default=None, help="cleaned STL")
    ap.add_argument("--json", default=None, help="JSON report")
    ap.add_argument("--seed", type=int, default=None, help="override the seed from the parameters")
    ap.add_argument("--check", action="store_true", help="QA: watertight, winding, volume, bbox; exit≠0 on failure")
    args = ap.parse_args(argv)

    p = load_params(args.params_file)
    if args.seed is not None:
        p["seed"] = int(args.seed)
    rng = np.random.default_rng(int(p["seed"]))
    t_all = time.perf_counter()

    centers = sample_centers(p, rng, int(p["n_balls"]))
    radii = sample_radii(p, rng, int(p["n_balls"]))
    xs, ys, zs, n = make_grid(p)
    h = float(p["voxel_mm"])

    t0 = time.perf_counter()
    X = xs[:, None, None]
    Y = ys[None, :, None]
    Z = zs[None, None, :]
    sdf = domain_sdf(X, Y, Z, p).astype(np.float32)
    del X, Y, Z
    f = ball_field(xs, ys, zs, centers, radii, p["stiffness"])
    t_field = time.perf_counter() - t0

    # --- isothreshold
    if p.get("target_porosity") is not None:
        threshold, phi_solved = solve_threshold(f, sdf, float(p["target_porosity"]))
        threshold_mode = "bisection"
    else:
        threshold = float(p["threshold"])
        phi_solved = porosity_of(f, sdf, threshold)
        threshold_mode = "fixed"

    mask = solid_mask(f, sdf, threshold)
    void = (sdf < 0.0) & ~mask

    g = np.maximum(threshold - f, sdf)

    t0 = time.perf_counter()
    verts, faces, _, _ = measure.marching_cubes(g, level=0.0, spacing=(h, h, h), allow_degenerate=False)
    verts = verts + np.array([xs[0], ys[0], zs[0]], dtype=np.float64)
    t_mc = time.perf_counter() - t0

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    trimesh.Trimesh(vertices=verts, faces=faces, process=True).export(str(out))

    dom = p["domain"]
    if dom["kind"] == "cylinder":
        v_domain = math.pi * float(dom["radius_mm"]) ** 2 * float(dom["height_mm"])
    else:
        v_domain = float(np.prod(np.array(dom["size_mm"], dtype=np.float64)))

    report = {
        "params_file": args.params_file,
        "domain": dom,
        "grid": {"n": [int(v) for v in n], "voxel_mm": h,
                 "n_voxels": int(np.prod(n)), "t_field_s": round(t_field, 3)},
        "balls": {
            "n": int(len(radii)),
            "radius_mm": {"min": round(float(radii.min()), 4), "max": round(float(radii.max()), 4),
                          "mean": round(float(radii.mean()), 4)},
            "dist": p["radius_mm"].get("dist", "uniform"),
            "nominal_volume_mm3": round(float((4.0 / 3.0 * math.pi * radii ** 3).sum()), 3),
            "nominal_over_domain": round(float((4.0 / 3.0 * math.pi * radii ** 3).sum()) / v_domain, 4),
        },
        "threshold": {"value": round(float(threshold), 6), "mode": threshold_mode,
                      "stiffness": float(p["stiffness"])},
        "porosity": {
            "voxel": round(float(phi_solved), 5),
            "target": p.get("target_porosity"),
        },
        "connectivity": {
            "solid": connectivity_stats(mask),
            "void": connectivity_stats(void),
        },
        "thickness": {
            "strut_mm": medial_thickness(mask, h),
            "pore_mm": medial_thickness(void, h),
        },
        "mesh": {"t_marching_cubes_s": round(t_mc, 3),
                 "raw_triangles": int(len(faces)),
                 "raw_vertices": int(len(verts))},
        "raw_stl": {"path": str(out), "bytes": out.stat().st_size},
        "domain_volume_mm3": round(float(v_domain), 3),
        "total_s": round(time.perf_counter() - t_all, 3),
        "python": f"{np.__version__}",
    }

    if args.clean_out:
        report["clean"] = clean_stl(out, Path(args.clean_out))
        v_solid = report["clean"]["volume_mm3"]
        report["porosity"]["mesh"] = round(1.0 - v_solid / v_domain, 5)

    rc = 0
    if args.check:
        cl = report.get("clean") or clean_stl(out, out)
        checks = {
            "watertight": bool(cl["watertight"]),
            "winding_consistent": bool(cl["winding_consistent"]),
            "volume_positive": cl["volume_mm3"] > 0.0,
            "volume_matches_voxels": abs((report["porosity"].get("mesh") or phi_solved)
                                         - phi_solved) <= 0.03,
            "bbox_inside_domain_plus_pad": None,
        }
        b = cl["bbox_mm"]
        tol = (p["wall_margin_cells"] + 1) * h
        if dom["kind"] == "cylinder":
            R, Hh = float(dom["radius_mm"]), float(dom["height_mm"]) / 2.0
            checks["bbox_inside_domain_plus_pad"] = bool(
                max(abs(b[0]), abs(b[2]), abs(b[3]), abs(b[5])) <= R + tol
                and max(abs(b[1]), abs(b[4])) <= Hh + tol)
        else:
            half = np.array(dom["size_mm"], dtype=float) / 2.0 + tol
            checks["bbox_inside_domain_plus_pad"] = bool(
                all(abs(b[i]) <= half[i % 3] for i in range(6)))
        report["qa"] = {"checks": checks, "passed": all(checks.values())}
        rc = 0 if report["qa"]["passed"] else 1

    if args.json:
        Path(args.json).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(json.dumps({k: report[k] for k in ("grid", "balls", "threshold", "porosity", "connectivity")},
                     ensure_ascii=False, indent=2))
    if "clean" in report:
        print(json.dumps(report["clean"], ensure_ascii=False, indent=2))
    if "qa" in report:
        print(json.dumps(report["qa"], ensure_ascii=False, indent=2))
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
