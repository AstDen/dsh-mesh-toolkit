#!/usr/bin/env python3
"""packing_lib.py — ball packing by «gravitational filling» into a container.

Problem
-------
For a container of arbitrary (in this implementation — analytically defined) shape
obtain a static filling of balls with random/constant radii and output
a table of centers and radii: `id,x_mm,y_mm,z_mm,r_mm`. The STL is then built from it:
neck cylinders are placed at the ball contact points so that there is no point contact
(see exp-009 — the same «balls + necks» idea, but there the FCC lattice was set by hand).

Model (quasi-static, frictionless)
-------------------------------------
1. A ball of radius r «falls» onto a random point (x, y) of the container top boundary.
2. For fixed (x, y) its height z is determined uniquely — it settles on
   the maximum of the supports: the container bottom and the balls already lying there

       z(x, y) = max( z_floor(x, y, r),
                      max_j [ z_j + sqrt((r + r_j)^2 - d_xy^2) ] )

   over those j with d_xy < r + r_j. The formula is exact: for fixed (x, y)
   the set of forbidden heights around ball j is the interval (z_j - h_j, z_j + h_j),
   h_j = sqrt((r + r_j)^2 - d_xy^2); taking the max of the upper bounds = «lie on top
   of the tallest column», with no intersection with any ball. This replaces
   stepping through the fall: one formula gives the exact position.
3. Equilibrium. We collect the normals of all contacts (ball-ball and ball-wall). If the normals
   span the whole 3D space — there are no free directions and the ball stands. Otherwise
   it rolls along the steepest descent direction allowed by the constraints: d = -P·e_z,
   where P is the projector onto the null space of the normals (contact = motion only
   perpendicular to the normal). The step is reduced when the descent fails.
   This is a «mechanical» filling: the ball rolls over the balls already lying there and jams
   in a stable position, like a real one.
4. The filling ends when `stop_after_fail` attempts in a row found no room.
5. Optional compaction (`compaction_cycles>0`): vector relaxation of the overlaps
   over a cKDTree with a downward «shake» — it mimics vibration and raises the density.

What is given on output
--------------------
* ball table (CSV): `id,x_mm,y_mm,z_mm,r_mm`;
* contacts table (CSV): `i,j,dist_mm,gap_mm` — pairs of touching balls; from it
  the STL builder places the necks (a neck per pair with `gap_mm <= tol`);
* summary (JSON): packing density, porosity, number of balls, coordination number
  (distribution and mean), wall contacts, maximum overlap,
  minimum gap between non-touching balls, time, parameters.

Units are **mm** (like the STL in the project). Radii/coordinates are float64.

Limitations (honestly)
--------------------
* Friction is not modelled: stability is determined by the normals only. A real
  filling with friction can stand steeper; ours is «perfectly slippery».
* The bed is frozen: balls already lying there do not move when a new one falls (except
  for explicit compaction). This gives a slightly looser packing than the real one.
* Containers are analytic only: a parallelepiped (`box`), a cylinder along z
  (`cylinder`), a sphere (`sphere`). An arbitrary mesh/STL is an extension through
  an implementation of the same interface (step 2 needs the «bottom height» and normals).
"""
from __future__ import annotations

import json
import math
import time
from pathlib import Path
from typing import Iterable, Optional, Sequence

import numpy as np

try:  # scipy is needed only for compaction and fast contact pairs
    from scipy.spatial import cKDTree

    HAVE_SCIPY = True
except Exception:  # pragma: no cover
    cKDTree = None  # type: ignore
    HAVE_SCIPY = False


# ---------------------------------------------------------------------------
# Containers
# ---------------------------------------------------------------------------
class Container:
    """Base container interface (everything in mm)."""

    name = "container"

    # --- container geometry ---------------------------------------------------
    def volume(self) -> float:
        raise NotImplementedError

    def bbox(self) -> tuple[np.ndarray, np.ndarray]:
        raise NotImplementedError

    def max_sphere_radius(self) -> float:
        """Maximum ball radius that still fits into the container."""
        raise NotImplementedError

    # --- ball placement -------------------------------------------------------
    def drop_xy(self, rng: np.random.Generator, r: float) -> Optional[np.ndarray]:
        """Random (x, y) «entry» point of the ball on the top boundary; None — does not fit."""
        raise NotImplementedError

    def bottom_z(self, x: float, y: float, r: float) -> float:
        """Height of the center of a ball resting on the container bottom at (x, y)."""
        raise NotImplementedError

    def clamp_xy(self, xy: np.ndarray, r: float) -> np.ndarray:
        raise NotImplementedError

    def clamp(self, p: np.ndarray, r: float) -> np.ndarray:
        raise NotImplementedError

    def clamp_many(self, p: np.ndarray, r: np.ndarray) -> np.ndarray:
        raise NotImplementedError

    def contains(self, p: np.ndarray, r: float, tol: float = 0.0) -> bool:
        raise NotImplementedError

    def contacts(self, p: np.ndarray, r: float, tol: float) -> list[np.ndarray]:
        """Wall contact normals of the ball (unit, pointing into the container)."""
        raise NotImplementedError

    def describe(self) -> dict:
        raise NotImplementedError


class Box(Container):
    """Parallelepiped with axis-aligned faces: [lo, hi] (mm)."""

    name = "box"

    def __init__(self, lo: Sequence[float], hi: Sequence[float]):
        self.lo = np.asarray(lo, dtype=float)
        self.hi = np.asarray(hi, dtype=float)
        if np.any(self.hi <= self.lo):
            raise ValueError(f"box: hi must be greater than lo, got lo={self.lo}, hi={self.hi}")

    def volume(self) -> float:
        return float(np.prod(self.hi - self.lo))

    def bbox(self):
        return self.lo.copy(), self.hi.copy()

    def max_sphere_radius(self) -> float:
        return float(np.min(self.hi - self.lo) / 2.0)

    def drop_xy(self, rng, r):
        lo = self.lo[:2] + r
        hi = self.hi[:2] - r
        if np.any(hi <= lo):
            return None
        return rng.uniform(lo, hi)

    def bottom_z(self, x, y, r):
        return float(self.lo[2] + r)

    def clamp_xy(self, xy, r):
        return np.clip(np.asarray(xy, dtype=float), self.lo[:2] + r, self.hi[:2] - r)

    def clamp(self, p, r):
        return np.clip(np.asarray(p, dtype=float), self.lo + r, self.hi - r)

    def clamp_many(self, p, r):
        r = np.asarray(r, dtype=float)
        return np.minimum(np.maximum(p, self.lo + r[:, None]), self.hi - r[:, None])

    def contains(self, p, r, tol=0.0):
        p = np.asarray(p, dtype=float)
        return bool(np.all(p >= self.lo + r - tol) and np.all(p <= self.hi - r + tol))

    def contacts(self, p, r, tol):
        out = []
        p = np.asarray(p, dtype=float)
        for i in range(3):
            if p[i] - (self.lo[i] + r) <= tol:
                n = np.zeros(3)
                n[i] = 1.0
                out.append(n)
            if (self.hi[i] - r) - p[i] <= tol:
                n = np.zeros(3)
                n[i] = -1.0
                out.append(n)
        return out

    def describe(self):
        return {"type": self.name, "lo_mm": self.lo.tolist(), "hi_mm": self.hi.tolist(),
                "volume_mm3": self.volume()}


class Cylinder(Container):
    """Cylinder with a z axis: center (cx, cy), radius R, height z0..z1 (mm)."""

    name = "cylinder"

    def __init__(self, center_xy: Sequence[float], radius: float, z0: float, z1: float):
        self.c = np.asarray(center_xy, dtype=float)
        self.R = float(radius)
        self.z0 = float(z0)
        self.z1 = float(z1)
        if self.R <= 0 or self.z1 <= self.z0:
            raise ValueError("cylinder: R > 0 and z1 > z0 are required")

    def volume(self) -> float:
        return float(math.pi * self.R**2 * (self.z1 - self.z0))

    def bbox(self):
        return (np.array([self.c[0] - self.R, self.c[1] - self.R, self.z0]),
                np.array([self.c[0] + self.R, self.c[1] + self.R, self.z1]))

    def max_sphere_radius(self) -> float:
        return float(min(self.R, (self.z1 - self.z0) / 2.0))

    def drop_xy(self, rng, r):
        R = self.R - r
        if R <= 0:
            return None
        rho = R * math.sqrt(float(rng.random()))
        th = float(rng.random()) * 2.0 * math.pi
        return self.c + np.array([rho * math.cos(th), rho * math.sin(th)])

    def bottom_z(self, x, y, r):
        return float(self.z0 + r)

    def clamp_xy(self, xy, r):
        v = np.asarray(xy, dtype=float) - self.c
        L = float(np.hypot(v[0], v[1]))
        Rmax = self.R - r
        if L > Rmax and L > 0.0:
            v = v * (Rmax / L)
        return self.c + v

    def clamp(self, p, r):
        p = np.asarray(p, dtype=float)
        xy = self.clamp_xy(p[:2], r)
        z = min(max(float(p[2]), self.z0 + r), self.z1 - r)
        return np.array([xy[0], xy[1], z])

    def clamp_many(self, p, r):
        p = np.array(p, dtype=float)
        r = np.asarray(r, dtype=float)
        v = p[:, :2] - self.c
        L = np.hypot(v[:, 0], v[:, 1])
        Rmax = np.maximum(self.R - r, 0.0)
        scale = np.where(L > Rmax, Rmax / np.maximum(L, 1e-300), 1.0)
        p[:, :2] = self.c + v * scale[:, None]
        p[:, 2] = np.minimum(np.maximum(p[:, 2], self.z0 + r), self.z1 - r)
        return p

    def contains(self, p, r, tol=0.0):
        p = np.asarray(p, dtype=float)
        rho = float(np.hypot(p[0] - self.c[0], p[1] - self.c[1]))
        return bool(rho <= self.R - r + tol
                    and p[2] >= self.z0 + r - tol
                    and p[2] <= self.z1 - r + tol)

    def contacts(self, p, r, tol):
        out = []
        p = np.asarray(p, dtype=float)
        v = p[:2] - self.c
        L = float(np.hypot(v[0], v[1]))
        if L > 0.0 and (self.R - r) - L <= tol:
            out.append(np.array([-v[0] / L, -v[1] / L, 0.0]))
        if p[2] - (self.z0 + r) <= tol:
            out.append(np.array([0.0, 0.0, 1.0]))
        if (self.z1 - r) - p[2] <= tol:
            out.append(np.array([0.0, 0.0, -1.0]))
        return out

    def describe(self):
        return {"type": self.name, "center_xy_mm": self.c.tolist(), "radius_mm": self.R,
                "z_range_mm": [self.z0, self.z1], "volume_mm3": self.volume()}


class SphereContainer(Container):
    """Spherical cavity: center c, radius R (mm)."""

    name = "sphere"

    def __init__(self, center: Sequence[float], radius: float):
        self.c = np.asarray(center, dtype=float)
        self.R = float(radius)
        if self.R <= 0:
            raise ValueError("sphere: R > 0")

    def volume(self) -> float:
        return float(4.0 / 3.0 * math.pi * self.R**3)

    def bbox(self):
        return self.c - self.R, self.c + self.R

    def max_sphere_radius(self) -> float:
        return float(self.R)

    def drop_xy(self, rng, r):
        R = self.R - r
        if R <= 0:
            return None
        rho = R * math.sqrt(float(rng.random()))
        th = float(rng.random()) * 2.0 * math.pi
        return self.c[:2] + np.array([rho * math.cos(th), rho * math.sin(th)])

    def bottom_z(self, x, y, r):
        R = self.R - r
        d2 = (x - self.c[0]) ** 2 + (y - self.c[1]) ** 2
        s = math.sqrt(max(R * R - d2, 0.0))
        return float(self.c[2] - s)

    def clamp_xy(self, xy, r):
        v = np.asarray(xy, dtype=float) - self.c[:2]
        Rmax = self.R - r
        L = float(np.hypot(v[0], v[1]))
        if L > Rmax and L > 0.0:
            v = v * (Rmax / L)
        return self.c[:2] + v

    def clamp(self, p, r):
        p = np.asarray(p, dtype=float)
        v = p - self.c
        L = float(np.linalg.norm(v))
        Rmax = self.R - r
        if L > Rmax and L > 0.0:
            p = self.c + v * (Rmax / L)
        return p

    def clamp_many(self, p, r):
        p = np.array(p, dtype=float)
        r = np.asarray(r, dtype=float)
        v = p - self.c
        L = np.linalg.norm(v, axis=1)
        Rmax = np.maximum(self.R - r, 0.0)
        scale = np.where(L > Rmax, Rmax / np.maximum(L, 1e-300), 1.0)
        return self.c + v * scale[:, None]

    def contains(self, p, r, tol=0.0):
        p = np.asarray(p, dtype=float)
        return bool(np.linalg.norm(p - self.c) <= self.R - r + tol)

    def contacts(self, p, r, tol):
        p = np.asarray(p, dtype=float)
        v = p - self.c
        L = float(np.linalg.norm(v))
        if L > 0.0 and (self.R - r) - L <= tol:
            return [-v / L]
        return []

    def describe(self):
        return {"type": self.name, "center_mm": self.c.tolist(), "radius_mm": self.R,
                "volume_mm3": self.volume()}


def make_container(spec: dict) -> Container:
    """Build a container from the description in the parameters (JSON)."""
    if not isinstance(spec, dict):
        raise TypeError("container: a dict is expected")
    kind = str(spec.get("type", "")).lower()
    if kind in ("box", "parallelepiped", "brick"):
        return Box(spec["lo_mm"], spec["hi_mm"])
    if kind == "cylinder":
        z0, z1 = spec["z_range_mm"]
        return Cylinder(spec["center_xy_mm"], float(spec["radius_mm"]), float(z0), float(z1))
    if kind == "sphere":
        return SphereContainer(spec["center_mm"], float(spec["radius_mm"]))
    raise ValueError(f"container.type={kind!r} is not supported (box|cylinder|sphere)")


def shrink_spec(spec: dict, gap_mm: float) -> dict:
    """Description of the container shrunk by `gap_mm` on all sides.

    Needed for the «ball–wall» gap: the filling goes into the shrunk container, while the STL is cut
    along the original domain. Otherwise a ball touches the wall/bottom/top exactly, and during
    meshing this produces slivers (rule «gap ≥ 2·MeshSizeMin», D-007).
    """
    if gap_mm <= 0.0:
        return dict(spec)
    kind = str(spec.get("type", "")).lower()
    out = dict(spec)
    if kind in ("box", "parallelepiped", "brick"):
        lo = [float(v) + gap_mm for v in spec["lo_mm"]]
        hi = [float(v) - gap_mm for v in spec["hi_mm"]]
        if any(h <= l for l, h in zip(lo, hi)):
            raise ValueError("shrink_spec: the gap is larger than the container (box)")
        out["lo_mm"], out["hi_mm"] = lo, hi
        return out
    if kind == "cylinder":
        z0, z1 = (float(v) for v in spec["z_range_mm"])
        r = float(spec["radius_mm"]) - gap_mm
        if r <= 0.0 or z1 - z0 <= 2 * gap_mm:
            raise ValueError("shrink_spec: the gap is larger than the container (cylinder)")
        out["radius_mm"] = r
        out["z_range_mm"] = [z0 + gap_mm, z1 - gap_mm]
        return out
    if kind == "sphere":
        r = float(spec["radius_mm"]) - gap_mm
        if r <= 0.0:
            raise ValueError("shrink_spec: the gap is larger than the container (sphere)")
        out["radius_mm"] = r
        return out
    raise ValueError(f"container.type={kind!r} is not supported (box|cylinder|sphere)")


# ---------------------------------------------------------------------------
# Radius distribution
# ---------------------------------------------------------------------------
class RadiusSampler:
    """Radius policy: constant | uniform | lognormal | list.

    * constant  — all balls have the same radius;
    * uniform   — uniform in [r_min_mm, r_max_mm];
    * lognormal — lognormal, median r_median_mm and sigma (in ln), truncation
                  by resampling in [r_min_mm, r_max_mm];
    * list      — a given list of radii: `sampling` = `cycle` (in order)
                  or `random` (randomly with replacement); `file` is also possible — a CSV with
                  a `r_mm` column.
    """

    def __init__(self, spec: dict):
        if not isinstance(spec, dict):
            raise TypeError("radii: a dict is expected")
        self.spec = dict(spec)
        self.kind = str(spec.get("policy", "constant")).lower()
        self._values: Optional[np.ndarray] = None
        self._cursor = 0
        if self.kind == "constant":
            self._r_const = float(spec["r_mm"])
        elif self.kind == "uniform":
            self._r_min = float(spec["r_min_mm"])
            self._r_max = float(spec["r_max_mm"])
            if not (self._r_max > self._r_min > 0):
                raise ValueError("radii.uniform: r_max_mm > r_min_mm > 0 is required")
        elif self.kind == "lognormal":
            self._median = float(spec["r_median_mm"])
            self._sigma = float(spec.get("sigma", 0.25))
            self._r_min = float(spec.get("r_min_mm", 0.1 * self._median))
            self._r_max = float(spec.get("r_max_mm", 5.0 * self._median))
        elif self.kind == "list":
            vals = spec.get("values_mm")
            if vals is None and spec.get("file"):
                vals = self._read_csv(Path(spec["file"]))
            if not vals:
                raise ValueError("radii.list: values_mm or file is required")
            self._values = np.asarray(vals, dtype=float)
            if np.any(self._values <= 0):
                raise ValueError("radii.list: the radii must be > 0")
            self._sampling = str(spec.get("sampling", "cycle")).lower()
        else:
            raise ValueError(f"radii.policy={self.kind!r} is not supported")

    @staticmethod
    def _read_csv(path: Path) -> list[float]:
        import csv

        out: list[float] = []
        with path.open(newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                key = "r_mm" if "r_mm" in row else "radius_mm" if "radius_mm" in row else None
                if key is None:
                    raise ValueError(f"{path}: a r_mm or radius_mm column is required")
                out.append(float(row[key]))
        return out

    def sample(self, rng: np.random.Generator) -> float:
        if self.kind == "constant":
            return self._r_const
        if self.kind == "uniform":
            return float(rng.uniform(self._r_min, self._r_max))
        if self.kind == "lognormal":
            for _ in range(10000):
                r = float(self._median * math.exp(self._sigma * float(rng.standard_normal())))
                if self._r_min <= r <= self._r_max:
                    return r
            return float(min(max(self._median, self._r_min), self._r_max))
        if self._sampling == "cycle":
            r = float(self._values[self._cursor % self._values.size])
            self._cursor += 1
            return r
        return float(rng.choice(self._values))

    def rmax(self) -> float:
        """Upper bound of the possible radius (for the grid cell sizes)."""
        if self.kind == "constant":
            return self._r_const
        if self.kind == "uniform":
            return self._r_max
        if self.kind == "lognormal":
            return self._r_max
        return float(np.max(self._values))

    def describe(self) -> dict:
        d = dict(self.spec)
        d["policy"] = self.kind
        d["r_max_possible_mm"] = self.rmax()
        return d


# ---------------------------------------------------------------------------
# Packing
# ---------------------------------------------------------------------------
_DIRS8 = tuple(np.array([math.cos(a), math.sin(a)]) for a in
               [k * math.pi / 4.0 for k in range(8)])


class Packing:
    """Gravitational filling of balls into a container (see the module docstring)."""

    def __init__(
        self,
        container: Container,
        sampler: RadiusSampler,
        *,
        seed: int = 0,
        max_spheres: int = 100000,
        overlap_tol: float = 1e-9,
        contact_tol: float = 1e-6,
        gap_policy: str = "uniform",
        gap_mm: float = 0.0,
        gap_rel: float = 0.0,
        step0_frac: float = 0.5,
        min_step_frac: float = 1e-3,
        slope_min: float = 0.02,
        max_settle_iters: int = 5000,
        stall_limit: int = 60,
        log=None,
    ):
        self.container = container
        self.sampler = sampler
        self.rng = np.random.default_rng(seed)
        self.seed = int(seed)
        self.cap = int(max_spheres)
        self.p = np.zeros((self.cap, 3), dtype=float)
        self.r = np.zeros(self.cap, dtype=float)
        self.n = 0
        self.overlap_tol = float(overlap_tol)
        self.contact_tol = float(contact_tol)
        if gap_policy not in ("uniform", "pairwise"):
            raise ValueError(f"gap_policy: {gap_policy!r} (uniform|pairwise required)")
        self.gap_policy = gap_policy
        self.gap_mm = float(gap_mm)
        self.gap_rel = float(gap_rel)
        self.step0_frac = float(step0_frac)
        self.min_step_frac = float(min_step_frac)
        self.slope_min = float(slope_min)
        self.max_settle_iters = int(max_settle_iters)
        self.stall_limit = int(stall_limit)
        self.log = log or (lambda *a, **k: None)

        self.rmax = float(sampler.rmax())
        if self.rmax <= 0:
            raise ValueError("a positive radius is required")
        # cell 2*rmax: any two spheres with |d| <= r_i + r_j <= 2*rmax land
        # in neighbouring cells (3x3 in the xy plane) -> a 9-cell query is exact
        # maximum pair gap (for the neighbour search and the reach margin)
        self.gap_max = self.gap_mm + (self.gap_rel * self.rmax
                                      if self.gap_policy == "pairwise" else 0.0)
        self.cell = 2.0 * self.rmax
        self.grid: dict[tuple[int, int], list[int]] = {}

        self.stats = {
            "place_attempts": 0,
            "place_ok": 0,
            "place_fail_full": 0,
            "place_fail_unstable": 0,
            "settle_hit_iter_cap": 0,
            "place_fail_oversize": 0,
            "settle_iters_total": 0,
            "settle_iters_max": 0,
        }
        self.t_place = 0.0

    # --- gap (guaranteed clearance between the ball surfaces) -----------------
    def _gap(self, r_a: float, r_b: float) -> float:
        """Required clearance between two balls.

        uniform  — the same for all pairs (gap_mm), the neck size in the STL is constant;
        pairwise — max(gap_mm, gap_rel*min(r_a, r_b)), the neck is ~proportional to the smaller
                   ball (convenient for polydisperse packings: no «bridges» between
                   a large and a small ball).
        """
        if self.gap_policy == "uniform":
            return self.gap_mm
        return max(self.gap_mm, self.gap_rel * min(r_a, r_b))

    def _gapv(self, r_a: float, rs: np.ndarray) -> np.ndarray:
        if self.gap_policy == "uniform":
            return np.full(rs.shape, self.gap_mm, dtype=float)
        return np.maximum(self.gap_mm, self.gap_rel * np.minimum(r_a, rs))

    # --- grid ----------------------------------------------------------------
    def _key(self, x: float, y: float) -> tuple[int, int]:
        return (int(math.floor(x / self.cell)), int(math.floor(y / self.cell)))

    def _grid_add(self, idx: int) -> None:
        k = self._key(self.p[idx, 0], self.p[idx, 1])
        self.grid.setdefault(k, []).append(idx)

    def _grid_drop(self, idx: int) -> None:
        """Remove the index from the grid (the ball position must still be the old one)."""
        k = self._key(self.p[idx, 0], self.p[idx, 1])
        lst = self.grid.get(k)
        if lst:
            try:
                lst.remove(idx)
            except ValueError:
                pass
            if not lst:
                self.grid.pop(k, None)

    def _rebuild_grid(self) -> None:
        self.grid = {}
        for idx in range(self.n):
            self._grid_add(idx)

    def _query_xy(self, x: float, y: float, reach: float) -> np.ndarray:
        """Ball indices from the cells covering the square (x±reach, y±reach)."""
        if self.n == 0:
            return np.empty(0, dtype=np.int64)
        span = int(math.ceil(reach / self.cell))
        i0 = int(math.floor(x / self.cell))
        j0 = int(math.floor(y / self.cell))
        buf: list[int] = []
        for i in range(i0 - span, i0 + span + 1):
            for j in range(j0 - span, j0 + span + 1):
                v = self.grid.get((i, j))
                if v:
                    buf.extend(v)
        if not buf:
            return np.empty(0, dtype=np.int64)
        return np.fromiter(buf, dtype=np.int64, count=len(buf))

    # --- support -------------------------------------------------------------
    def support_z(self, x: float, y: float, r: float) -> float:
        """Exact height of the ball center above the frozen bed (see item 2 of the docstring)."""
        z = self.container.bottom_z(x, y, r)
        idx = self._query_xy(x, y, r + self.rmax + self.gap_max)
        if idx.size:
            d2 = (self.p[idx, 0] - x) ** 2 + (self.p[idx, 1] - y) ** 2
            sumr = r + self.r[idx] + self._gapv(r, self.r[idx])
            s2 = sumr * sumr
            m = s2 > d2
            if np.any(m):
                zmax = float(np.max(self.p[idx[m], 2] + np.sqrt(s2[m] - d2[m])))
                if zmax > z:
                    z = zmax
        return z

    # --- contacts ------------------------------------------------------------
    def _contacts(self, p: np.ndarray, r: float) -> list[np.ndarray]:
        normals = list(self.container.contacts(p, r, self.contact_tol))
        idx = self._query_xy(p[0], p[1], r + self.rmax + self.gap_max)
        if idx.size:
            delta = self.p[idx] - p
            dist = np.linalg.norm(delta, axis=1)
            sumr = r + self.r[idx] + self._gapv(r, self.r[idx])
            m = np.abs(dist - sumr) <= self.contact_tol
            if np.any(m):
                for q in delta[m] / dist[m, None]:
                    normals.append(q)
        return normals

    @staticmethod
    def _descent_dir(normals: list[np.ndarray]) -> Optional[np.ndarray]:
        """Rolling direction: projection of -e_z onto the null space of the normals."""
        if not normals:
            return None
        A = np.asarray(normals, dtype=float)
        if A.shape[0] == 1:
            n = A[0] / np.linalg.norm(A[0])
            d = np.array([0.0, 0.0, -1.0])
            d = d - (d @ n) * n
        else:
            _, s, vt = np.linalg.svd(A)
            k = s.size
            tol = 1e-8
            rows = [vt[i] for i in range(k) if s[i] < tol]
            rows += [vt[i] for i in range(k, 3)]
            if not rows:
                return None
            B = np.asarray(rows)
            d = B.T @ (B @ np.array([0.0, 0.0, -1.0]))
        if float(np.linalg.norm(d)) < 1e-12:
            return None
        return d

    # --- placing a single ball ----------------------------------------------
    def _settle_xy(self, xy: np.ndarray, r: float) -> Optional[np.ndarray]:
        """Lower a ball starting from (x, y): rolling down to a local minimum of the support.

        Physics: a frictionless ball rolls down the support surface; we look for the minimum
        of the function z(x,y) = support_z by a search over 8 directions with a decreasing step.
        The bottom of the dimple corresponds to touching 2–3 neighbours (dense packing).
        Returns the center position or None if the ball does not fit into the container.
        """
        t0 = time.perf_counter()
        xy = np.array([float(xy[0]), float(xy[1])], dtype=float)
        z = self.support_z(xy[0], xy[1], r)
        step = self.step0_frac * r
        step_min = self.min_step_frac * r
        it = 0
        # search over 8 directions: the ball rolls where the support is lowest —
        # this way it finds the bottom of the dimple (touching 2-3 neighbours) instead of «rolling»
        # along a single sphere only until the first obstacle
        while step > step_min and it < self.max_settle_iters:
            it += 1
            best_z = z
            best_xy = None
            dirs = list(_DIRS8)
            # analytic direction along the crease/groove between the neighbours:
            # without it the discrete 8 directions cannot follow the «ridge»,
            # and the ball freezes in a metastable position with 1–2 contacts
            cand = np.array([xy[0], xy[1], z])
            dn = self._descent_dir(self._contacts(cand, r))
            if dn is not None:
                nxy = math.hypot(dn[0], dn[1])
                if nxy > 1e-9:
                    dirs.append(np.array([dn[0], dn[1]]) / nxy)
            for d in dirs:
                c = self.container.clamp_xy(xy + step * d, r)
                zc = self.support_z(c[0], c[1], r)
                if zc < best_z:
                    best_z, best_xy = zc, c
            if best_xy is not None and (z - best_z) > 1e-6 * step:
                xy, z = best_xy, best_z
            else:
                step *= 0.5

        # final placement exactly on the support and inside the container.
        # IMPORTANT: the support may be ABOVE the ceiling (the ball must lie on a tall
        # neighbour) — then there is no room, rather than «sticking out of the container».
        p = np.array([xy[0], xy[1], z], dtype=float)
        p = self.container.clamp(p, r)
        p[2] = self.support_z(p[0], p[1], r)
        if not self.container.contains(p, r, self.overlap_tol):
            self.stats["place_fail_full"] += 1
            self.stats["settle_iters_total"] += it + 1
            self.t_place += time.perf_counter() - t0
            return None

        it_total = it + 1
        if it >= self.max_settle_iters:
            self.stats["settle_hit_iter_cap"] += 1
        self.stats["settle_iters_total"] += it_total
        self.stats["settle_iters_max"] = max(self.stats["settle_iters_max"], it_total)
        self.t_place += time.perf_counter() - t0

        if not self.container.contains(p, r, max(self.overlap_tol, 1e-9)):
            self.stats["place_fail_full"] += 1
            return None
        return p

    def _insert(self, p: np.ndarray, r: float) -> None:
        self.p[self.n] = p
        self.r[self.n] = r
        self._grid_add(self.n)
        self.n += 1
        self.stats["place_ok"] += 1

    def _remove(self, k: int) -> None:
        """Remove ball k (swap with the last one, the grid stays consistent)."""
        last = self.n - 1
        self._grid_drop(last)
        if k != last:
            self.p[k] = self.p[last]
            self.r[k] = self.r[last]
            self._grid_add(k)
        self.n = last

    def try_place(self, r: float) -> Optional[np.ndarray]:
        """Throw a ball to a random point of the container and let it roll down."""
        self.stats["place_attempts"] += 1
        xy = self.container.drop_xy(self.rng, r)
        if xy is None:
            self.stats["place_fail_oversize"] += 1
            return None
        p = self._settle_xy(xy, r)
        if p is None:
            return None
        self._insert(p, r)
        return p

    # --- filling -------------------------------------------------------------
    def run(self, stop_after_fail: int = 200, max_spheres: Optional[int] = None) -> int:
        target = min(self.cap, int(max_spheres) if max_spheres else self.cap)
        rmax_ok = self.container.max_sphere_radius()
        fails = 0
        t0 = time.perf_counter()
        while self.n < target and fails < stop_after_fail:
            r = self.sampler.sample(self.rng)
            if not (0.0 < r <= rmax_ok):
                fails += 1
                self.stats["place_fail_oversize"] += 1
                continue
            if self.try_place(r) is None:
                fails += 1
            else:
                fails = 0
        self.t_run = time.perf_counter() - t0
        return self.n

    # --- compaction ----------------------------------------------------------
    def _pairs(self, cutoff: float) -> np.ndarray:
        if self.n < 2:
            return np.empty((0, 2), dtype=np.int64)
        if not HAVE_SCIPY:
            raise RuntimeError("compaction/contacts need scipy (cKDTree)")
        tree = cKDTree(self.p[: self.n])
        out = tree.query_pairs(cutoff, output_type="ndarray")
        return np.asarray(out, dtype=np.int64)

    def compact(self, cycles: int = 10, shake_frac: float = 0.02,
                sweeps: int = 50, tol: float = 1e-9, log=None) -> dict:
        """Densification by «vibration»: shift all balls down + resolve the overlaps.

        One cycle: all balls are lowered by `shake_frac * r_max` (gravity), then
        the overlaps are resolved iteratively (position-based dynamics) down to `tol` (mm).
        The structure settles lower -> room is freed -> more balls can be poured in
        (`run()`), so the density grows from cycle to cycle.
        """
        log = log or (lambda *a, **k: None)
        if cycles <= 0 or self.n == 0:
            return {"cycles": 0}
        phi0 = self.packing_fraction()
        z_before = float(self.p[: self.n, 2].max()) if self.n else 0.0
        max_ov_hist = []
        sweeps_hist = []
        for c in range(int(cycles)):
            if shake_frac > 0:
                self.p[: self.n, 2] -= shake_frac * self.rmax
                self.p[: self.n] = self.container.clamp_many(
                    self.p[: self.n], self.r[: self.n])
            used = 0
            for _sweep in range(int(sweeps)):
                used += 1
                pairs = self._pairs(2.0 * self.rmax + self.gap_max + max(tol, 1e-12))
                if pairs.size == 0:
                    break
                i, j = pairs[:, 0], pairs[:, 1]
                delta = self.p[j] - self.p[i]
                dist = np.linalg.norm(delta, axis=1)
                g = self._gapv(self.r[i], self.r[j]) if self.gap_policy == "uniform" else \
                    np.array([self._gap(a, b) for a, b in zip(self.r[i], self.r[j])])
                ov = (self.r[i] + self.r[j] + g) - dist
                m = ov > tol
                if not np.any(m):
                    break
                max_ov_hist.append(float(np.max(ov[m])))
                i, j, ov, delta, dist = i[m], j[m], ov[m], delta[m], dist[m]
                u = delta / np.maximum(dist, 1e-300)[:, None]
                corr = 0.5 * ov[:, None] * u
                disp = np.zeros((self.n, 3), dtype=float)
                np.add.at(disp, i, -corr)
                np.add.at(disp, j, corr)
                self.p[: self.n] += disp
                self.p[: self.n] = self.container.clamp_many(
                    self.p[: self.n], self.r[: self.n])
            sweeps_hist.append(used)
            self.resettle_all()
            log(f"[compact] cycle {c + 1}/{cycles}: N={self.n} phi={self.packing_fraction():.4f} "
                f"z_top={self.p[:self.n, 2].max():.2f} ovl={self.max_overlap():.1e} "
                f"sweeps={used}")
        # after the shifts the xy grid is stale
        self._rebuild_grid()
        return {"cycles": int(cycles), "shake_frac": float(shake_frac),
                "sweeps_used_max": int(max(sweeps_hist)) if sweeps_hist else 0,
                "max_overlap_during_mm": max(max_ov_hist) if max_ov_hist else 0.0,
                "max_overlap_after_mm": self.max_overlap(),
                "z_top_before_mm": z_before,
                "z_top_after_mm": float(self.p[: self.n, 2].max()) if self.n else 0.0,
                "phi_before": phi0, "phi_after": self.packing_fraction()}

    def resettle_all(self) -> dict:
        """Lower all balls onto their exact support (bottom to top), xy unchanged.

        After the «shake» (compact) the balls may overlap and hang in the air.
        Here they are laid onto the support again in increasing z order: no overlaps
        appear (the support is the exact height of the first contact), the structure settles
        lower, freeing room for more pouring. This is the «vibration + shrinkage».
        """
        if self.n == 0:
            return {"n": 0, "dz_total_mm": 0.0, "moved": 0, "failed": 0}
        pos = self.p[: self.n].copy()
        rad = self.r[: self.n].copy()
        order = np.argsort(pos[:, 2])
        self.n = 0
        self.grid = {}
        dz = 0.0
        moved = 0
        failed = 0
        for k in order:
            xy = pos[k, :2]
            r = float(rad[k])
            p_new = self._settle_xy(xy, r)
            if p_new is None:
                # no room (the support is above the ceiling) — the ball drops out of the packing
                failed += 1
                continue
            dz += float(pos[k, 2] - p_new[2])
            if abs(pos[k, 2] - p_new[2]) > 1e-12:
                moved += 1
            self._insert(p_new, r)
        self._rebuild_grid()
        return {"n": self.n, "dz_total_mm": dz, "moved": moved, "failed": failed,
                "max_overlap_mm": self.max_overlap()}

    # --- re-settling (vibration) --------------------------------------------
    def packing_fraction(self) -> float:
        v = float(np.sum(4.0 / 3.0 * math.pi * self.r[: self.n] ** 3))
        return v / self.container.volume()

    def resediment(self, sweeps: int = 3, jitter_frac: float = 0.0,
                   log=None) -> dict:
        """Re-settling: each ball is taken out in turn and rolled down again.

        Imitation of vibration/creep: the ball starts from its own (x, y) (with
        `jitter_frac` > 0 — with a random shift) and finds a lower dimple
        freed by the rearrangement of the neighbours. The order is random, the number of sweeps
        is `sweeps`. The density grows; no overlaps appear (the support is analytic).
        """
        log = log or (lambda *a, **k: None)
        if sweeps <= 0 or self.n == 0:
            return {"sweeps": 0, "phi_before": self.packing_fraction(),
                    "phi_after": self.packing_fraction()}
        phi0 = self.packing_fraction()
        moved = 0
        failed = 0
        dz_total = 0.0
        for sw in range(int(sweeps)):
            order = self.rng.permutation(self.n)
            for k in order:
                k = int(k)
                if k >= self.n:
                    continue
                p_old = self.p[k].copy()
                r = float(self.r[k])
                self._remove(k)
                xy = p_old[:2].copy()
                if jitter_frac > 0:
                    xy = xy + self.rng.normal(0.0, jitter_frac * r, size=2)
                    xy = self.container.clamp_xy(xy, r)
                p_new = self._settle_xy(xy, r)
                if p_new is None:  # did not fit -> put it back
                    self._insert(p_old, r)
                    failed += 1
                    continue
                if np.linalg.norm(p_new - p_old) > 1e-9:
                    moved += 1
                dz_total += float(p_old[2] - p_new[2])
                self._insert(p_new, r)
            phi = self.packing_fraction()
            log(f"[resediment] sweep {sw + 1}/{sweeps}: N={self.n} phi={phi:.4f} "
                f"(moved {moved}, did not fit {failed})")
        # safety net: overlaps cannot appear from the analytic support, but
        # the grid must stay consistent after the permutations
        self._rebuild_grid()
        return {"sweeps": int(sweeps), "jitter_frac": float(jitter_frac),
                "moved": moved, "failed": failed,
                "dz_total_mm": dz_total,
                "phi_before": phi0, "phi_after": self.packing_fraction()}

    # --- contacts/metrics ----------------------------------------------------
    def contact_pairs(self, tol: Optional[float] = None) -> np.ndarray:
        """Pairs of touching balls (i, j) — i < j."""
        tol = self.contact_tol if tol is None else float(tol)
        if self.n < 2:
            return np.empty((0, 2), dtype=np.int64)
        # the search radius must include the gap: in the model the balls are separated by gap
        pairs = self._pairs(2.0 * self.rmax + self.gap_max + tol)
        if pairs.size == 0:
            return np.empty((0, 2), dtype=np.int64)
        i, j = pairs[:, 0], pairs[:, 1]
        dist = np.linalg.norm(self.p[j] - self.p[i], axis=1)
        g = self._gapv(self.r[i], self.r[j]) if self.gap_policy == "uniform" else \
            np.array([self._gap(a, b) for a, b in zip(self.r[i], self.r[j])])
        return pairs[np.abs(dist - (self.r[i] + self.r[j] + g)) <= tol]

    def contacts_table(self, tol: Optional[float] = None) -> list[dict]:
        """Pair contacts: contact point and normal — the input data for the necks in the STL."""
        tol = self.contact_tol if tol is None else float(tol)
        out = []
        for i, j in self.contact_pairs(tol):
            pi = self.p[i]
            d_vec = self.p[j] - pi
            d = float(np.linalg.norm(d_vec))
            u = d_vec / d if d > 0 else np.array([0.0, 0.0, 1.0])
            c = pi + float(self.r[i]) * u
            out.append({"i": int(i), "j": int(j), "dist_mm": d,
                        "gap_mm": d - float(self.r[i] + self.r[j]),
                        "cx_mm": float(c[0]), "cy_mm": float(c[1]), "cz_mm": float(c[2]),
                        "nx": float(u[0]), "ny": float(u[1]), "nz": float(u[2])})
        out.sort(key=lambda row: (row["i"], row["j"]))
        return out

    def wall_contacts(self, tol: Optional[float] = None) -> np.ndarray:
        tol = self.contact_tol if tol is None else float(tol)
        return np.array([len(self.container.contacts(self.p[k], self.r[k], tol))
                         for k in range(self.n)], dtype=np.int64)

    def max_overlap(self) -> float:
        if self.n < 2:
            return 0.0
        pairs = self._pairs(2.0 * self.rmax + self.gap_max + self.overlap_tol)
        if pairs.size == 0:
            return 0.0
        i, j = pairs[:, 0], pairs[:, 1]
        dist = np.linalg.norm(self.p[j] - self.p[i], axis=1)
        g = self._gapv(self.r[i], self.r[j]) if self.gap_policy == "uniform" else \
            np.array([self._gap(a, b) for a, b in zip(self.r[i], self.r[j])])
        return float(max(0.0, np.max((self.r[i] + self.r[j] + g) - dist)))

    def summary(self, compaction: Optional[dict] = None) -> dict:
        n = self.n
        r = self.r[:n]
        p = self.p[:n]
        vol = self.container.volume()
        v_solid = float(np.sum(4.0 / 3.0 * math.pi * r**3))
        phi = v_solid / vol if vol > 0 else float("nan")
        pairs = self.contact_pairs()
        z_sphere = np.zeros(n, dtype=np.int64)
        if pairs.size:
            np.add.at(z_sphere, pairs[:, 0], 1)
            np.add.at(z_sphere, pairs[:, 1], 1)
        z_wall = self.wall_contacts()
        z_total = z_sphere + z_wall
        # minimum gap between NON-touching pairs (within 2*rmax)
        min_gap = None
        if n >= 2:
            allp = self._pairs(2.0 * self.rmax + 1e-6)
            if allp.size:
                d = np.linalg.norm(p[allp[:, 1]] - p[allp[:, 0]], axis=1)
                gap = d - (r[allp[:, 0]] + r[allp[:, 1]])
                far = gap[gap > self.contact_tol]
                if far.size:
                    min_gap = float(np.min(far))
        hist = {}
        for k in range(0, int(z_sphere.max()) + 2 if n else 1):
            c = int(np.count_nonzero(z_sphere == k))
            if c:
                hist[str(k)] = c
        lo, hi = self.container.bbox()
        out = {
            "n_spheres": int(n),
            "seed": self.seed,
            "container": self.container.describe(),
            "container_volume_mm3": vol,
            "radii": self.sampler.describe(),
            "r_mean_mm": float(np.mean(r)) if n else 0.0,
            "r_min_mm": float(np.min(r)) if n else 0.0,
            "r_max_mm": float(np.max(r)) if n else 0.0,
            "solid_volume_mm3": v_solid,
            "packing_fraction": phi,
            "porosity": 1.0 - phi,
            "max_theoretical_fraction": 0.7404804896930611,  # FCC/HCP, sanity check
            "centers_bbox_mm": {"lo": p.min(axis=0).tolist() if n else [0, 0, 0],
                                "hi": p.max(axis=0).tolist() if n else [0, 0, 0]},
            "container_bbox_mm": {"lo": np.asarray(lo).tolist(), "hi": np.asarray(hi).tolist()},
            "n_contacts": int(pairs.shape[0]),
            "coordination_sphere_mean": float(np.mean(z_sphere)) if n else 0.0,
            "coordination_total_mean": float(np.mean(z_total)) if n else 0.0,
            "coordination_sphere_hist": hist,
            "n_spheres_touching_wall": int(np.count_nonzero(z_wall > 0)),
            "wall_contacts_total": int(np.sum(z_wall)),
            "max_overlap_mm": self.max_overlap(),
            "min_gap_noncontact_mm": min_gap,
            "time_s": {"run": getattr(self, "t_run", 0.0), "place": self.t_place},
            "stats": dict(self.stats),
        }
        if compaction is not None:
            out["compaction"] = compaction
        return out


# ---------------------------------------------------------------------------
# Input-output
# ---------------------------------------------------------------------------
TABLE_COLUMNS = ["id", "x_mm", "y_mm", "z_mm", "r_mm"]


def write_table(path: str | Path, p: np.ndarray, r: np.ndarray, fmt: str = "%.9f") -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        f.write(",".join(TABLE_COLUMNS) + "\n")
        for i in range(len(r)):
            f.write("%d,%s,%s,%s,%s\n" % (i, fmt % p[i, 0], fmt % p[i, 1], fmt % p[i, 2], fmt % r[i]))
    return path


def read_table(path: str | Path) -> tuple[np.ndarray, np.ndarray]:
    """Read the ball table (inverse of write_table)."""
    import csv

    p, r = [], []
    with Path(path).open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            p.append([float(row["x_mm"]), float(row["y_mm"]), float(row["z_mm"])])
            r.append(float(row["r_mm"]))
    return np.asarray(p, dtype=float).reshape(-1, 3), np.asarray(r, dtype=float)


def write_contacts(path: str | Path, rows: Iterable[dict], fmt: str = "%.9f") -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        f.write("i,j,dist_mm,gap_mm,cx_mm,cy_mm,cz_mm,nx,ny,nz\n")
        for row in rows:
            f.write("%d,%d,%s,%s,%s,%s,%s,%s,%s,%s\n" % (
                row["i"], row["j"], fmt % row["dist_mm"], fmt % row["gap_mm"],
                fmt % row["cx_mm"], fmt % row["cy_mm"], fmt % row["cz_mm"],
                fmt % row["nx"], fmt % row["ny"], fmt % row["nz"]))
    return path


def write_summary(path: str | Path, summary: dict, extra: Optional[dict] = None) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = dict(summary)
    if extra:
        payload["meta"] = extra
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2, sort_keys=False)
        f.write("\n")
    return path


def write_preview_stl(path: str | Path, p: np.ndarray, r: np.ndarray, subdivisions: int = 1) -> Path:
    """Preview STL from the balls (visual check only, not for meshing)."""
    import trimesh

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    cache: dict[float, object] = {}
    meshes = []
    for k in range(len(r)):
        key = round(float(r[k]), 9)
        proto = cache.get(key)
        if proto is None:
            proto = trimesh.creation.icosphere(subdivisions=int(subdivisions), radius=float(r[k]))
            cache[key] = proto
        m = proto.copy()
        m.apply_translation(p[k])
        meshes.append(m)
    mesh = trimesh.util.concatenate(meshes) if meshes else trimesh.Trimesh()
    mesh.export(path)
    return path


def check_packing(p: np.ndarray, r: np.ndarray, container: Container,
                  overlap_tol: float = 1e-6, contact_tol: float = 1e-6,
                  gap_policy: str = "uniform", gap_mm: float = 0.0,
                  gap_rel: float = 0.0) -> dict:
    """Independent check of the table: no overlaps, all inside, plausible density."""
    n = len(r)
    problems: list[str] = []
    if n == 0:
        return {"ok": False, "problems": ["empty table"], "n_spheres": 0}
    if not np.all(np.isfinite(p)) or not np.all(np.isfinite(r)):
        problems.append("NaN/inf in the table")
    outside = [int(k) for k in range(n) if not container.contains(p[k], r[k], overlap_tol)]
    if outside:
        problems.append(f"{len(outside)} balls outside the container (e.g. {outside[:5]})")
    if np.any(r <= 0):
        problems.append("there are radii <= 0")
    if HAVE_SCIPY and n >= 2:
        tree = cKDTree(p)
        gmax = gap_mm + (gap_rel * float(np.max(r)) if gap_policy == "pairwise" else 0.0)
        pairs = np.asarray(tree.query_pairs(2.0 * float(np.max(r)) + gmax + overlap_tol,
                                            output_type="ndarray"), dtype=np.int64)
        if pairs.size:
            d = np.linalg.norm(p[pairs[:, 1]] - p[pairs[:, 0]], axis=1)
            ra, rb = r[pairs[:, 0]], r[pairs[:, 1]]
            if gap_policy == "pairwise":
                g = np.maximum(gap_mm, gap_rel * np.minimum(ra, rb))
            else:
                g = np.full(ra.shape, gap_mm, dtype=float)
            ov = (ra + rb + g) - d
            worst = float(np.max(ov))
            if worst > overlap_tol:
                bad = int(np.count_nonzero(ov > overlap_tol))
                problems.append(f"overlap {worst:.3e} mm on {bad} pairs (> {overlap_tol:.1e})")
        else:
            worst = 0.0
    else:
        worst = 0.0
    vol = container.volume()
    phi = float(np.sum(4.0 / 3.0 * math.pi * r**3) / vol) if vol > 0 else float("nan")
    if not (0.0 < phi < 0.7404804896930611 + 1e-9):
        problems.append(f"packing density {phi:.4f} outside (0, 0.7405]")
    return {
        "ok": not problems,
        "problems": problems,
        "n_spheres": int(n),
        "packing_fraction": phi,
        "porosity": 1.0 - phi,
        "max_overlap_mm": worst,
        "n_outside": len(outside),
        "overlap_tol_mm": overlap_tol,
    }
