#!/usr/bin/env python3
"""cq_common.py — shared building blocks of the CadQuery generators of the Mesh_3D_pore_scale project.

Why a separate module: the analytic volume/area formulas and the primitives must be
in ONE place so that the generator, QA and README do not diverge.

Analytics (the same formula is in geometry/cad/README.md and in gen_cq_porous.py):

    V_fluid = V_domain − Σ V_holes + Σ V_overlaps
    V_domain  = Lx · Ly · Lz
    V_sphere  = 4/3 · π · R³
    V_cyl     = π · R² · h            (h — cylinder length INSIDE the domain)
    V_overlap = 16/3 · R³             (intersection of two perpendicular cylinders of equal R,
                                       when their axes cross; for other cases — 0,
                                       and the generator warns that the analytics is approximate)
    A_fluid   = A_domain + Σ A_holes_inside,  A_domain = 2(Lx·Ly + Ly·Lz + Lz·Lx)
    A_sphere  = 4πR²
    A_cyl (pierces two opposite faces) = 2πR·h − 2πR²   (contribution to A_domain)

A faceted surface always gives a volume smaller than the analytics (inscribed polyhedron) — this is
STL discretisation, not a geometry error (env/ENV_REPORT.md §5 item 9).
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Iterable, Sequence

import cadquery as cq

PI = math.pi
AXES = {"x": 0, "y": 1, "z": 2}


# ---------------------------------------------------------------------------
# Analytics
# ---------------------------------------------------------------------------
def box_volume(lx: float, ly: float, lz: float) -> float:
    return lx * ly * lz


def box_area(lx: float, ly: float, lz: float) -> float:
    return 2.0 * (lx * ly + ly * lz + lz * lx)


def sphere_volume(r: float) -> float:
    return 4.0 / 3.0 * PI * r**3


def sphere_area(r: float) -> float:
    return 4.0 * PI * r**2


def cylinder_volume(r: float, h: float) -> float:
    return PI * r**2 * h


def cylinder_lateral_area(r: float, h: float) -> float:
    return 2.0 * PI * r * h


def crossing_cylinder_overlap(r: float) -> float:
    """Volume of the intersection of two perpendicular cylinders of equal radius R.

    Classical result: 16/3 · R³ (equal to the «penalty» volume for a perpendicular
    intersection of two circular cylinders; verified numerically in exp-002 against the STL volume).
    """
    return 16.0 / 3.0 * r**3


@dataclass
class CaseGeometry:
    kind: str
    domain: tuple[float, float, float]
    n_holes: int
    expected_volume: float
    expected_area: float | None
    details: dict = field(default_factory=dict)
    # number of closed shells in the STL: 1 + the number of closed cavities.
    # Cavities open on the domain faces (through cylinders) add no shells.
    expected_bodies: int = 1


# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------
def make_block(lx: float, ly: float, lz: float) -> cq.Workplane:
    """Block with the (0,0,0) corner at the origin, size Lx×Ly×Lz (mm)."""
    return cq.Workplane("XY").box(lx, ly, lz, centered=(False, False, False))


def make_sphere(r: float, center: Sequence[float]) -> cq.Solid:
    """Full sphere of radius r with center center.

    WARNING (verified in exp-002): in `cq.Solid.makeSphere` the default values for
    the angles give a HALF sphere (volume 2/3·πR³, z upward from the center, not a ball) — a silent
    trap. A full ball is obtained only with explicit angleDegrees1=-90, angleDegrees2=90.
    """
    return cq.Solid.makeSphere(
        r, pnt=cq.Vector(*center), angleDegrees1=-90, angleDegrees2=90
    )


def make_cylinder(
    r: float,
    axis: str,
    center_a: float,
    center_b: float,
    length: float,
    extend: float = 1.0,
) -> cq.Solid:
    """Cylinder along axis='x'|'y'|'z', the axis passes through (center_a, center_b) in the
    transverse coordinates. Length is length + 2·extend, the extension is needed so that
    a cut through does not leave zero thickness on the block faces (boolean
    operations with coincident faces are a source of OCC artefacts)."""
    ax = axis.lower()
    if ax not in AXES:
        raise ValueError(f"axis={axis!r}, allowed {sorted(AXES)}")
    a_idx = AXES[ax]
    perp = [i for i in range(3) if i != a_idx]
    start = [0.0, 0.0, 0.0]
    start[perp[0]] = center_a
    start[perp[1]] = center_b
    start[a_idx] = -extend
    direction = [0.0, 0.0, 0.0]
    direction[a_idx] = 1.0
    return cq.Solid.makeCylinder(
        r, length + 2.0 * extend, pnt=cq.Vector(*start), dir=cq.Vector(*direction)
    )


def lattice_centers(
    lx: float, ly: float, lz: float, nx: int, ny: int, nz: int
) -> list[tuple[float, float, float]]:
    """Centers of a simple cubic packing: the domain cell is divided into nx×ny×nz,
    the center of each cell is the sphere center. Deterministic, no seed."""
    centers = []
    for ix in range(nx):
        for iy in range(ny):
            for iz in range(nz):
                centers.append(
                    (
                        (ix + 0.5) * lx / nx,
                        (iy + 0.5) * ly / ny,
                        (iz + 0.5) * lz / nz,
                    )
                )
    return centers


# ---------------------------------------------------------------------------
# Geometry checks BEFORE the boolean operations (cheaper than chasing artefacts later)
# ---------------------------------------------------------------------------
def check_spheres_inside(
    centers: Iterable[Sequence[float]], r: float, domain: Sequence[float], tol: float = 1e-9
) -> None:
    """The sphere must be strictly inside the domain: touching a face gives degenerate
    boolean operations and «zero thickness» bridges in the STL."""
    lx, ly, lz = domain
    for i, c in enumerate(centers):
        for val, size, name in ((c[0], lx, "x"), (c[1], ly, "y"), (c[2], lz, "z")):
            if val - r < -tol or val + r > size + tol:
                raise ValueError(
                    f"sphere #{i} center {tuple(round(v, 6) for v in c)} R={r} "
                    f"is outside {name}: [{val - r:.6g}, {val + r:.6g}] vs domain [0, {size}]"
                )


def check_crossing_cylinders(cyls: list[dict], domain: Sequence[float]) -> float:
    """Check the cylinder intersections and return the total intersection volume.

    The analytics is derived only for a pair of PERPENDICULAR cylinders of equal radius
    whose axes intersect: the intersection volume = 16/3·R³ (Steinmetz solid,
    bicylinder). For other cases (perpendicular with offset axes,
    parallel overlapping, different radii) the intersection volume depends on
    the distance between the axes and there is no simple formula — we raise ValueError so that
    the user separates the cavities or explicitly changes the geometry.
    """
    total = 0.0
    for i in range(len(cyls)):
        for j in range(i + 1, len(cyls)):
            c1, c2 = cyls[i], cyls[j]
            p1, p2 = _axis_point(c1), _axis_point(c2)
            d1, d2 = _dir(c1), _dir(c2)
            r_sum = c1["radius"] + c2["radius"]
            d = _line_distance(p1, d1, p2, d2)
            parallel = _cross(d1, d2) == (0.0, 0.0, 0.0)
            if parallel:
                if d < r_sum - 1e-9:
                    raise ValueError(
                        f"parallel cylinders #{i} and #{j} overlap (d={d:.6g} < "
                        f"R1+R2={r_sum:.6g}); no volume analytics derived — separate them"
                    )
                continue
            if d > r_sum + 1e-9:
                continue  # do not intersect
            if abs(c1["radius"] - c2["radius"]) > 1e-9:
                raise ValueError(
                    f"cylinders #{i} and #{j} intersect with different radii "
                    f"({c1['radius']} vs {c2['radius']}) — no analytics derived"
                )
            if d > 1e-9:
                raise ValueError(
                    f"the axes of cylinders #{i} and #{j} are perpendicular but offset by d={d:.6g} "
                    f"(< R1+R2={r_sum:.6g}); the intersection volume depends on d — the analytics "
                    "is not derived, separate the cylinders by at least R1+R2"
                )
            total += crossing_cylinder_overlap(c1["radius"])
    return total


def _dir(cyl: dict) -> tuple[float, float, float]:
    d = [0.0, 0.0, 0.0]
    d[AXES[cyl["axis"]]] = 1.0
    return tuple(d)  # type: ignore[return-value]


def _axis_point(cyl: dict) -> tuple[float, float, float]:
    p = [0.0, 0.0, 0.0]
    ax = AXES[cyl["axis"]]
    perp = [i for i in range(3) if i != ax]
    p[perp[0]] = cyl["a"]
    p[perp[1]] = cyl["b"]
    return tuple(p)  # type: ignore[return-value]


def _line_distance(p1, d1, p2, d2) -> float:
    """Shortest distance between the lines (p1 + s·d1) and (p2 + t·d2)."""
    n = _cross(d1, d2)
    n_len = math.sqrt(sum(v * v for v in n))
    diff = [p2[i] - p1[i] for i in range(3)]
    if n_len < 1e-12:
        # parallel lines: distance = |diff × d1| / |d1|
        d1_len = math.sqrt(sum(v * v for v in d1)) or 1.0
        c = _cross(diff, d1)
        return math.sqrt(sum(v * v for v in c)) / d1_len
    return abs(sum(n[i] * diff[i] for i in range(3))) / n_len


def _cross(a, b):
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


# ---------------------------------------------------------------------------
# Boolean operations and export
# ---------------------------------------------------------------------------
def cut_tools(
    base: cq.Workplane | cq.Shape,
    tools: Sequence[cq.Workplane | cq.Shape],
    strategy: str = "sequential",
) -> cq.Shape:
    """Subtraction of the cavities from the block.

    strategy="sequential" (default) — one cut per cavity: slower,
        but the only strategy correct for INTERSECTING cavities;
    strategy="single"     — one BRepAlgoAPI_Cut with a compound of the cavities: faster,
        BUT for intersecting cavities OCC loses the intersection volume. Verified
        2026-11-23 (block 12x6x6, two cylinders R=0.8, min test): the compound gave
        407.872568 mm3 where sequential gives 410.603235 mm3. Therefore by
        default single is NOT used;
    strategy="fused"      — fuse the cavities, then one cut: correct also for
        intersecting cavities, usually more expensive than sequential.

    Invariant: the result volume = V_block − V_union(cavities). Always check
    (gen_cq_porous.py compares occ_volume with the analytics and fails above 0.5 %).
    """
    base_shape = base.val() if isinstance(base, cq.Workplane) else base
    tool_shapes = [t.val() if isinstance(t, cq.Workplane) else t for t in tools]
    if not tool_shapes:
        return base_shape

    if strategy == "single":
        tool = (
            tool_shapes[0]
            if len(tool_shapes) == 1
            else cq.Compound.makeCompound(tool_shapes)
        )
        return base_shape.cut(tool)

    if strategy == "sequential":
        shape = base_shape
        for tool in tool_shapes:
            shape = shape.cut(tool)
        return shape

    if strategy == "fused":
        fused = tool_shapes[0]
        for tool in tool_shapes[1:]:
            fused = fused.fuse(tool)
        return base_shape.cut(fused)

    raise ValueError(f"strategy={strategy!r}, allowed 'single'|'sequential'|'fused'")


def export_stl(
    shape: cq.Shape,
    path: str,
    tolerance: float,
    angular_tolerance: float,
    api: str = "exporters",
    relative: bool = True,
) -> float:
    """Export a binary STL (mm); returns the export time, s.

    api="exporters"  — `cq.exporters.export(...)`. WARNING (verified in exp-002):
                       this path always calls `Shape.exportStl(..., relative=True)`,
                       i.e. tolerance is scaled by the face size and is NOT an
                       absolute tolerance in mm;
    api="exportStl"  — direct `Shape.exportStl(path, tolerance, angTol, ascii=False,
                       relative=relative)`: with relative=False you get an ABSOLUTE
                       tolerance in mm (comparable with gmsh/other meshers).

    tolerance — maximum deviation of the chord from the true surface (mm when relative=False);
    angularTolerance — maximum angle between the normals of neighbouring triangles, rad.
    """
    t0 = time.perf_counter()
    if api == "exporters":
        cq.exporters.export(
            shape, path, tolerance=tolerance, angularTolerance=angular_tolerance
        )
    elif api == "exportStl":
        shape.exportStl(
            path,
            tolerance=tolerance,
            angularTolerance=angular_tolerance,
            ascii=False,
            relative=relative,
            parallel=True,
        )
    else:
        raise ValueError(f"api={api!r}, allowed 'exporters'|'exportStl'")
    return time.perf_counter() - t0


def bbox_of(shape: cq.Shape) -> dict:
    bb = shape.BoundingBox()
    return {
        "xmin": bb.xmin,
        "xmax": bb.xmax,
        "ymin": bb.ymin,
        "ymax": bb.ymax,
        "zmin": bb.zmin,
        "zmax": bb.zmax,
        "size": [bb.xlen, bb.ylen, bb.zlen],
    }
