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
* Inside/outside test: sign of (p - closest point) . normal on the SAME nearest
  triangle that gives the clearance. Ray casting along +x came first, but on the
  D1 400-sphere packing its parity came out wrong for points plainly outside the
  cylinder (coincident and grazing triangles defeat the parity count); a centroid
  KD-tree also failed, because a coarse wall triangle has its centroid far away
  while the triangle itself is near (benchmark ENV-2).
* Clearance: the exact distance to the surface, evaluated only against the
  triangles of the (y,z) bucket neighbourhood of the candidate (every triangle
  within `clearance` must intersect that square, so no triangle is missed). The
  cost is per-cell, not per-mesh: the earlier version called
  trimesh.proximity.closest_point_naive for every candidate, i.e. brute force over
  all triangles — on the 862k-triangle E2 packing with --clearance 0.2 it ran for
  over ten minutes without an answer (benchmark ENV-1).
* Budget: --max-seconds / --tries bound the search; when nothing fits, the answer
  reports the best clearance actually seen, so the caller lowers --clearance with
  evidence instead of guessing.

Output (stdout, JSON)
---------------------
    {"ok": true, "file": "...", "point_mm": [x, y, z],
     "clearance_mm": 0.21, "tries": 137, "bbox_mm": {...}}
    {"ok": false, ..., "best_clearance_mm": 0.11, "tries": 240,
     "elapsed_s": 60.0, "error": "..."}

Exit codes: 0 found, 1 not found (geometry too thin for the clearance or open),
2 input error.
"""

from __future__ import annotations

import argparse
import json
import sys
import time

import numpy as np


def load_triangles(path: str) -> np.ndarray:
    import trimesh

    mesh = trimesh.load(path, force="mesh")
    tris = np.asarray(mesh.triangles, dtype=float)
    if tris.ndim != 3 or tris.shape[0] == 0:
        raise SystemExit(f"no triangles in {path}")
    return tris


def closest_point_on_triangle(p: np.ndarray, a: np.ndarray, b: np.ndarray, c: np.ndarray) -> np.ndarray:
    """Closest point of one triangle to `p` (Ericson, Real-Time Collision Detection)."""
    ab, ac, ap = b - a, c - a, p - a
    d1, d2 = float(ab @ ap), float(ac @ ap)
    if d1 <= 0.0 and d2 <= 0.0:
        return a
    bp = p - b
    d3, d4 = float(ab @ bp), float(ac @ bp)
    if d3 >= 0.0 and d4 <= d3:
        return b
    vc = d1 * d4 - d3 * d2
    if vc <= 0.0 and d1 >= 0.0 and d3 <= 0.0:
        return a + (d1 / (d1 - d3)) * ab
    cp = p - c
    d5, d6 = float(ab @ cp), float(ac @ cp)
    if d6 >= 0.0 and d5 <= d6:
        return c
    vb = d5 * d2 - d1 * d6
    if vb <= 0.0 and d2 >= 0.0 and d6 <= 0.0:
        return a + (d2 / (d2 - d6)) * ac
    va = d3 * d6 - d5 * d4
    if va <= 0.0 and (d4 - d3) >= 0.0 and (d5 - d6) >= 0.0:
        return b + ((d4 - d3) / ((d4 - d3) + (d5 - d6))) * (c - b)
    denom = 1.0 / (va + vb + vc)
    v, w = vb * denom, vc * denom
    return a + ab * v + ac * w


def _segment_distance(p: np.ndarray, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Distance from `p` to each segment a[i]-b[i] (vectorised)."""
    ab = b - a
    denom = np.maximum(np.einsum("ij,ij->i", ab, ab), 1e-30)
    t = np.clip(np.einsum("ij,ij->i", p - a, ab) / denom, 0.0, 1.0)
    q = a + t[:, None] * ab
    return np.linalg.norm(p - q, axis=1)


def clearance_to_triangles(p: np.ndarray, tris: np.ndarray) -> np.ndarray:
    """Exact distance from point `p` to each of the given triangles."""
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    # distance to the plane, used only where the projection falls inside the triangle
    ab, ac = b - a, c - a
    n = np.cross(ab, ac)
    nn = np.einsum("ij,ij->i", n, n)
    safe = np.maximum(nn, 1e-30)
    plane_d = np.abs(np.einsum("ij,ij->i", p - a, n)) / np.sqrt(safe)
    # barycentric test (projected point inside the triangle?)
    ap = p - a
    d00 = np.einsum("ij,ij->i", ab, ab)
    d01 = np.einsum("ij,ij->i", ab, ac)
    d11 = np.einsum("ij,ij->i", ac, ac)
    d20 = np.einsum("ij,ij->i", ap, ab)
    d21 = np.einsum("ij,ij->i", ap, ac)
    denom = d00 * d11 - d01 * d01
    v = (d11 * d20 - d01 * d21) / np.where(np.abs(denom) > 1e-30, denom, np.nan)
    w = (d00 * d21 - d01 * d20) / np.where(np.abs(denom) > 1e-30, denom, np.nan)
    inside = np.isfinite(v) & np.isfinite(w) & (v >= -1e-9) & (w >= -1e-9) & (v + w <= 1 + 1e-9)
    edge = np.minimum(
        np.minimum(_segment_distance(p, a, b), _segment_distance(p, b, c)),
        _segment_distance(p, c, a),
    )
    return np.where(inside, plane_d, edge)


def build_yz_index(tris: np.ndarray, n: int = 96) -> dict:
    """Uniform (y,z) bucket index over the triangles (bbox overlap, not centroids)."""
    yz_lo = tris[:, :, 1:3].min(axis=1)
    yz_hi = tris[:, :, 1:3].max(axis=1)
    lo = yz_lo.min(axis=0)
    hi = yz_hi.max(axis=0)
    span = np.maximum(hi - lo, 1e-12)
    iy0 = np.clip(((yz_lo[:, 0] - lo[0]) / span[0] * n).astype(int), 0, n - 1)
    iy1 = np.clip(((yz_hi[:, 0] - lo[0]) / span[0] * n).astype(int), 0, n - 1)
    iz0 = np.clip(((yz_lo[:, 1] - lo[1]) / span[1] * n).astype(int), 0, n - 1)
    iz1 = np.clip(((yz_hi[:, 1] - lo[1]) / span[1] * n).astype(int), 0, n - 1)

    same = (iy0 == iy1) & (iz0 == iz1)
    cells = [iy0[same] * n + iz0[same]]
    tri_ids = [np.flatnonzero(same)]
    for t in np.flatnonzero(~same):  # triangles spanning a cell border: add to every cell
        for iy in range(iy0[t], iy1[t] + 1):
            for iz in range(iz0[t], iz1[t] + 1):
                cells.append(np.array([iy * n + iz]))
                tri_ids.append(np.array([t], dtype=np.int64))
    cells_arr = np.concatenate(cells)
    ids_arr = np.concatenate(tri_ids)
    order = np.argsort(cells_arr, kind="stable")
    cells_arr, ids_arr = cells_arr[order], ids_arr[order]
    bounds = np.searchsorted(cells_arr, np.arange(n * n + 1))
    buckets = [ids_arr[bounds[c]:bounds[c + 1]] for c in range(n * n)]
    return {
        "lo": lo,
        "hi": hi,
        "span": span,
        "n": n,
        "buckets": buckets,
        "tris": tris,
        "cell": float(min(span[0], span[1]) / n),
        "diag": float(np.linalg.norm(span)),
    }


def _bucket_ids(p: np.ndarray, index: dict, reach: float) -> np.ndarray:
    """Triangle ids of the bucket square of half-size `reach` around `p`."""
    lo, n, span = index["lo"], index["n"], index["span"]
    y0 = int(np.floor((p[1] - reach - lo[0]) / span[0] * n))
    y1 = int(np.floor((p[1] + reach - lo[0]) / span[0] * n))
    z0 = int(np.floor((p[2] - reach - lo[1]) / span[1] * n))
    z1 = int(np.floor((p[2] + reach - lo[1]) / span[1] * n))
    y0, z0 = max(y0, 0), max(z0, 0)
    y1, z1 = min(y1, n - 1), min(z1, n - 1)
    parts = []
    for iy in range(y0, y1 + 1):
        for iz in range(z0, z1 + 1):
            ids = index["buckets"][iy * n + iz]
            if ids is not None and len(ids):
                parts.append(ids)
    return np.concatenate(parts) if parts else np.empty(0, dtype=np.int64)


def _ray_parity(p: np.ndarray, index: dict) -> bool:
    """Cheap pre-filter: odd number of +x ray crossings in the (y,z) cell neighbourhood.

    Parity alone is not reliable on packings (coincident/grazing triangles), so it is used only as
    a filter — the exact signed probe decides. It is what keeps the search fast: without it every
    grid candidate far outside the material paid for the expanding exact probe.
    """
    lo, n, span = index["lo"], index["n"], index["span"]
    iy = int(np.floor((p[1] - lo[0]) / span[0] * n))
    iz = int(np.floor((p[2] - lo[1]) / span[1] * n))
    tris = index["tris"]
    hits = 0
    for yy in (iy - 1, iy, iy + 1):
        for zz in (iz - 1, iz, iz + 1):
            if not (0 <= yy < n and 0 <= zz < n):
                continue
            ids = index["buckets"][yy * n + zz]
            if ids is None or not len(ids):
                continue
            tr = tris[ids]
            v0, v1, v2 = tr[:, 0], tr[:, 1], tr[:, 2]
            e1, e2 = v1 - v0, v2 - v0
            h = np.cross(np.array([1.0, 0.0, 0.0]), e2)
            a = np.einsum("ij,ij->i", e1, h)
            ok = np.abs(a) > 1e-12
            f = np.zeros_like(a)
            f[ok] = 1.0 / a[ok]
            sv = p - v0
            u = f * np.einsum("ij,ij->i", sv, h)
            q = np.cross(sv, e1)
            v = f * q[:, 0]
            t = f * np.einsum("ij,ij->i", e2, q)
            hit = ok & (u >= -1e-9) & (u <= 1 + 1e-9) & (v >= -1e-9) & (v <= 1 + 1e-9) & (t > 1e-9)
            hits += int(hit.sum())
    return bool(hits % 2 == 1)


def surface_probe(p: np.ndarray, index: dict, min_reach: float) -> tuple[float, float]:
    """Exact distance to the nearest triangle plus the side of the surface `p` lies on.

    The bucket square grows until the nearest triangle found lies inside it: if the true nearest
    distance were smaller, that triangle would intersect the smaller square, so both the distance
    and the triangle are exact (a fixed small square reports some far triangle instead — ENV-2).
    Sign = dot(p - closest point, normal); the STLs are watertight with outward normals, so a
    NEGATIVE sign means inside the material. Distance and side come from the same triangle, which
    keeps the inside test and the clearance consistent.
    """
    reach = max(min_reach, index["cell"])
    limit = 4.0 * index["diag"]
    tris = index["tris"]
    ids = None
    while reach <= limit:
        ids = _bucket_ids(p, index, reach)
        if len(ids):
            d = clearance_to_triangles(p, tris[ids])
            i = int(np.argmin(d))
            if float(d[i]) <= reach:
                break
        reach *= 2.0
    else:
        ids = _bucket_ids(p, index, limit)
        d = clearance_to_triangles(p, tris[ids])
        i = int(np.argmin(d))
    tri = tris[ids[i]]
    cp = closest_point_on_triangle(p, tri[0], tri[1], tri[2])
    normal = np.cross(tri[1] - tri[0], tri[2] - tri[0])
    return float(d[i]), float(np.dot(p - cp, normal))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("stl")
    ap.add_argument("--clearance", type=float, default=0.1,
                    help="minimum distance to the surface, mm (default 0.1)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--tries", type=int, default=20000)
    ap.add_argument("--max-seconds", type=float, default=60.0,
                    help="time budget for the search, s (default 60)")

    args = ap.parse_args()

    try:
        import trimesh  # noqa: F401  (only for loading the STL)
    except Exception as exc:  # pragma: no cover
        print(f"error: trimesh is required: {exc}", file=sys.stderr)
        return 2

    try:
        tris = load_triangles(args.stl)
    except SystemExit as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    index = build_yz_index(tris)
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

    started = time.time()
    tries = 0
    best = 0.0
    for p in candidates:
        if time.time() - started > args.max_seconds:
            break
        tries += 1
        if not _ray_parity(p, index):
            continue
        clearance, side = surface_probe(p, index, max(args.clearance, index["cell"]))
        if side >= 0.0:  # outside the fluid material (or exactly on the surface)
            continue
        if clearance > best:
            best = clearance
        if clearance >= args.clearance:
            print(json.dumps({
                "ok": True,
                "file": args.stl,
                "point_mm": [round(float(c), 6) for c in p],
                "clearance_mm": round(clearance, 6),
                "tries": tries,
                "elapsed_s": round(time.time() - started, 2),
                "bbox_mm": {"min": lo.round(6).tolist(), "max": hi.round(6).tolist()},
            }, ensure_ascii=False))
            return 0

    elapsed = round(time.time() - started, 2)
    print(json.dumps({
        "ok": False,
        "file": args.stl,
        "best_clearance_mm": round(best, 6),
        "tries": tries,
        "elapsed_s": elapsed,
        "budget_s": args.max_seconds,
        "error": f"no inside point with clearance >= {args.clearance} mm "
                 f"({tries} candidates, {elapsed} s); the widest gap found is about {best:.4f} mm — "
                 f"pass --clearance <= that value, or check that the STL is watertight",
    }, ensure_ascii=False))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
