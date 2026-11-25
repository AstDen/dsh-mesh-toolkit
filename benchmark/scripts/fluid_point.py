#!/usr/bin/env python3
"""Find a point strictly inside a closed STL with a requested clearance.

Why this exists
---------------
snappyHexMesh needs `locationInMesh` to be inside the fluid region. For random
sphere packings and other generated geometries the inside is not obvious by eye,
and a wrong point produces the fatal error

    Point (x y z) is not inside the mesh or on a face or edge

The test suite (benchmark/TESTS.md) uses this script to derive the point from the
STL itself instead of hard-coding coordinates.

Method
------
* Inside/outside test: ray casting along +x (Moller-Trumbore, vectorised over
  triangles). Odd number of hits => inside. No rtree/embree dependency.
* Clearance: minimum distance from the candidate to the mesh surface, computed
  with trimesh.proximity.closest_point_naive (brute force; slow but exact).

Output (stdout, JSON)
---------------------
    {"ok": true, "file": "...", "point_mm": [x, y, z],
     "clearance_mm": 0.21, "tries": 137, "bbox_mm": {...}}

Exit codes: 0 found, 1 not found (geometry too thin for the clearance or open),
2 input error.
"""

from __future__ import annotations

import argparse
import json
import sys

import numpy as np


def load_triangles(path: str) -> np.ndarray:
    import trimesh

    mesh = trimesh.load(path, force="mesh")
    tris = np.asarray(mesh.triangles, dtype=float)
    if tris.ndim != 3 or tris.shape[0] == 0:
        raise SystemExit(f"no triangles in {path}")
    return tris


def inside(p: np.ndarray, tris: np.ndarray) -> bool:
    """Ray casting along +x; odd crossings means inside."""
    d = np.array([1.0, 0.0, 0.0])
    v0, v1, v2 = tris[:, 0], tris[:, 1], tris[:, 2]
    e1, e2 = v1 - v0, v2 - v0
    h = np.cross(d, e2)
    a = np.einsum("ij,ij->i", e1, h)
    eps = 1e-12
    ok = np.abs(a) > eps
    if not ok.any():
        return False
    f = np.zeros_like(a)
    f[ok] = 1.0 / a[ok]
    s = p - v0
    u = f * np.einsum("ij,ij->i", s, h)
    q = np.cross(s, e1)
    v = f * (q @ d)
    t = f * np.einsum("ij,ij->i", e2, q)
    hit = ok & (u >= -1e-9) & (u <= 1 + 1e-9) & (v >= -1e-9) & (v <= 1 + 1e-9) & (t > 1e-9)
    return bool(int(hit.sum()) % 2 == 1)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("stl")
    ap.add_argument("--clearance", type=float, default=0.1,
                    help="minimum distance to the surface, mm (default 0.1)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--tries", type=int, default=20000)
    args = ap.parse_args()

    try:
        import trimesh
        from trimesh.proximity import closest_point_naive
    except Exception as exc:  # pragma: no cover
        print(f"error: trimesh is required: {exc}", file=sys.stderr)
        return 2

    try:
        tris = load_triangles(args.stl)
    except SystemExit as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    mesh = trimesh.Trimesh(vertices=tris.reshape(-1, 3), faces=np.arange(len(tris) * 3).reshape(-1, 3),
                           process=False)
    lo, hi = tris.reshape(-1, 3).min(0), tris.reshape(-1, 3).max(0)
    size = float(hi[0] - lo[0]) or 1.0
    rng = np.random.default_rng(args.seed)

    # Start from a coarse deterministic grid, then fall back to random sampling.
    step = size / 40.0
    grid = [lo + step * (np.array([i, j, k]) + 0.5)
            for i in range(int((hi[0] - lo[0]) / step) + 1)
            for j in range(int((hi[1] - lo[1]) / step) + 1)
            for k in range(int((hi[2] - lo[2]) / step) + 1)]
    candidates = grid + list(lo + (hi - lo) * rng.random((args.tries, 3)))

    tries = 0
    for p in candidates:
        tries += 1
        if not inside(p, tris):
            continue
        _, dist, _ = closest_point_naive(mesh, np.array([p]))
        clearance = float(dist[0]) if hasattr(dist, "__len__") else float(dist)
        if clearance >= args.clearance:
            print(json.dumps({
                "ok": True,
                "file": args.stl,
                "point_mm": [round(float(c), 6) for c in p],
                "clearance_mm": round(clearance, 6),
                "tries": tries,
                "bbox_mm": {"min": lo.round(6).tolist(), "max": hi.round(6).tolist()},
            }, ensure_ascii=False))
            return 0

    print(json.dumps({
        "ok": False,
        "file": args.stl,
        "error": f"no inside point with clearance >= {args.clearance} mm in {tries} tries; "
                 f"lower --clearance or check that the STL is watertight",
    }, ensure_ascii=False))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
