#!/usr/bin/env python3
"""gen_channel_spheres.py — parametric geometry of a «channel with spheres» (analogue of the good_mesing reference).

Family (see experiments/exp-017_channel-spheres-mesh/DIALOG.md):
    d = 2r, W = r*sqrt(2), H = sqrt((2r)^2 - W^2) = W
    14 levels with 2 spheres on the 4 channel edges, the diagonals alternate,
    empty inlet section L_in = inlet_plenum_d * d, outlet — a plane through the centers
    of the last level (the hemispheres are cut off).

Artifacts (ASCII STL, units --units mm|m):
    interface.stl        28 spheres (closed shells, patch wall)
    interface_necks.stl  necks at the contacts (patch wall, level +1)
    inlet.stl            z = z_min, the full square (patch symmetry when meshing)
    outlet.stl           z = z_max, the fluid part (square minus quarter disks)
    outlet_solid.stl     z = z_max, the solid part (quarter disks of the spheres)
    walls.stl            4 side faces of the domain (patch symmetry)
    solid.stl            union(spheres + necks) — for cfMesh / reference
    fluid.stl            domain − solid — the closed fluid surface (cfMesh)
    geom_report.json     all numbers + watertight checks

Example:
    python3 geometry/pore_cell/gen_channel_spheres.py \
        --params geometry/pore_cell/params/channel_spheres_ref.json \
        --out-dir experiments/exp-017_channel-spheres-mesh/triSurface_mm --units mm
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
import trimesh

PROJ = Path(__file__).resolve().parents[2]


# --------------------------------------------------------------------------- #
# write an ASCII STL under the solid name
# --------------------------------------------------------------------------- #
def write_stl(mesh: trimesh.Trimesh, path: Path, name: str, scale: float = 1.0,
              fmt: str = "binary") -> int:
    """Writes a Trimesh to STL (binary|ascii) under the solid name. Returns the triangle count."""
    if fmt == "binary":
        m = mesh.copy()
        m.vertices = np.asarray(m.vertices, dtype=float) * scale
        path.parent.mkdir(parents=True, exist_ok=True)
        m.export(path, file_type="stl")
        return len(m.faces)
    v = np.asarray(mesh.vertices, dtype=float) * scale
    f = np.asarray(mesh.faces, dtype=int)
    if len(f) == 0:
        raise ValueError(f"{name}: empty mesh")
    tri = v[f]                                       # (n,3,3)
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    n = np.divide(n, ln, out=np.zeros_like(n), where=ln > 0)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as fh:
        fh.write(f"solid {name}\n")
        for (a, b, c), nn in zip(tri, n):
            fh.write(f"facet normal {nn[0]:.9e} {nn[1]:.9e} {nn[2]:.9e}\n outer loop\n")
            fh.write(f"  vertex {a[0]:.9e} {a[1]:.9e} {a[2]:.9e}\n")
            fh.write(f"  vertex {b[0]:.9e} {b[1]:.9e} {b[2]:.9e}\n")
            fh.write(f"  vertex {c[0]:.9e} {c[1]:.9e} {c[2]:.9e}\n")
            fh.write(" endloop\nendfacet\n")
        fh.write(f"endsolid {name}\n")
    return len(f)


# --------------------------------------------------------------------------- #
# geometry
# --------------------------------------------------------------------------- #
def levels_and_centers(r: float, W: float, n_levels: int):
    """Sphere centers: one diagonal per level (even — A-D, odd — B-C)."""
    H = math.sqrt(max((2.0 * r) ** 2 - W ** 2, 0.0)) if W <= 2.0 * r else W
    corners = {
        "A": (0.0, 0.0),
        "B": (W, 0.0),
        "C": (W, W),
        "D": (0.0, W),
    }
    centers = []
    for k in range(n_levels):
        diag = ("A", "C") if k % 2 == 0 else ("B", "D")
        for name in diag:
            x, y = corners[name]
            centers.append((x, y, k * H))
    return H, centers


def sphere_at(r: float, center, subdivisions: int) -> trimesh.Trimesh:
    m = trimesh.creation.icosphere(subdivisions=subdivisions, radius=r)
    m.apply_translation(center)
    return m


def contact_pairs(centers, r: float, tol: float = 1e-6):
    """Pairs (i, j) of spheres touching exactly (|c_i - c_j| = 2r)."""
    c = np.asarray(centers, dtype=float)
    pairs = []
    n = len(c)
    for i in range(n):
        for j in range(i + 1, n):
            d = float(np.linalg.norm(c[j] - c[i]))
            if abs(d - 2.0 * r) <= tol:
                pairs.append((i, j, d))
    return pairs


def neck_at(c_i, c_j, r_neck: float, length: float, sections: int) -> trimesh.Trimesh:
    """Neck cylinder at the contact point, axis along (c_j - c_i)."""
    c_i = np.asarray(c_i, float)
    c_j = np.asarray(c_j, float)
    axis = c_j - c_i
    axis /= np.linalg.norm(axis)
    cyl = trimesh.creation.cylinder(radius=r_neck, height=length, sections=sections)
    # the cylinder is along +z by default
    rot = trimesh.geometry.align_vectors([0.0, 0.0, 1.0], axis)
    cyl.apply_transform(rot)
    cyl.apply_translation((c_i + c_j) / 2.0)
    return cyl


def neck_band(c_i, c_j, r_neck: float, r_sphere: float, sections: int = 24) -> trimesh.Trimesh:
    """OPEN cylindrical band (waist) — the part of the neck lying outside both spheres.

    Needed for multi-region snappyHexMesh: a closed neck cylinder gives an end cap INSIDE
    a sphere, the cellZone fill stops there and the solid region breaks up into
    disconnected components (exp-017: solid 1071 cells instead of ~550k). The band is open at
    both ends, so the fill passes from sphere A into sphere B, while the fluid outside
    cannot get inside — the end rings lie inside the spheres.
    """
    c_i = np.asarray(c_i, float)
    c_j = np.asarray(c_j, float)
    axis = c_j - c_i
    L = float(np.linalg.norm(axis))
    u = axis / L
    half = math.sqrt(max(r_sphere ** 2 - r_neck ** 2, 0.0))
    t1, t2 = half, L - half
    if t2 <= t1:
        raise SystemExit(f"ERROR: degenerate neck: r_neck={r_neck} is too large for r={r_sphere}")
    e1 = np.cross(u, [0.0, 0.0, 1.0])
    if np.linalg.norm(e1) < 1e-9:
        e1 = np.cross(u, [0.0, 1.0, 0.0])
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(u, e1)
    ang = np.linspace(0.0, 2.0 * math.pi, sections, endpoint=False)
    ring = [r_neck * (math.cos(a) * e1 + math.sin(a) * e2) for a in ang]
    pts = np.array([c_i + t1 * u + q for q in ring] + [c_i + t2 * u + q for q in ring])
    faces = []
    for k in range(sections):
        k2 = (k + 1) % sections
        faces.append([k, k2, sections + k2])
        faces.append([k, sections + k2, sections + k])
    return trimesh.Trimesh(vertices=pts, faces=np.asarray(faces), process=False)


def fan_2d(contour_xy, center_xy) -> np.ndarray:
    """Fan triangulation of a closed contour (star-shaped about center). Returns (n,3,2)."""
    c = np.asarray(center_xy, float)
    tris = []
    n = len(contour_xy)
    for i in range(n):
        p = np.asarray(contour_xy[i], float)
        q = np.asarray(contour_xy[(i + 1) % n], float)
        tris.append(np.array([c, p, q]))
    return np.asarray(tris, float)


def mesh_2d(tris_2d, plane: str, value: float, outward=None) -> trimesh.Trimesh:
    """(n,3,2) in a plane -> Trimesh. plane: 'z'|'x'|'y'. outward — the desired normal."""
    tris_2d = np.asarray(tris_2d, float)
    if plane == "z":
        pts = np.stack([tris_2d[..., 0], tris_2d[..., 1],
                        np.full(tris_2d.shape[:2], value)], axis=-1)
    elif plane == "x":
        pts = np.stack([np.full(tris_2d.shape[:2], value), tris_2d[..., 0], tris_2d[..., 1]], axis=-1)
    elif plane == "y":
        pts = np.stack([tris_2d[..., 0], np.full(tris_2d.shape[:2], value), tris_2d[..., 1]], axis=-1)
    else:
        raise ValueError(plane)
    keep = np.linalg.norm(np.cross(pts[:, 1] - pts[:, 0], pts[:, 2] - pts[:, 0]), axis=1) > 1e-12
    verts, faces = [], []
    for tri_pts in pts[keep]:
        base = len(verts)
        verts.extend(tri_pts)
        faces.append([base, base + 1, base + 2])
    m = trimesh.Trimesh(vertices=np.asarray(verts), faces=np.asarray(faces), process=False)
    if outward is not None:
        nrm = m.face_normals
        if float(np.dot(nrm.mean(axis=0), np.asarray(outward, float))) < 0:
            m.invert()
    return m


def arc(center, r, a0_deg, a1_deg, nseg):
    ts = np.radians(np.linspace(a0_deg, a1_deg, nseg + 1))
    return np.stack([center[0] + r * np.cos(ts), center[1] + r * np.sin(ts)], axis=-1)


def classify_fluid_triangles(fluid: trimesh.Trimesh, g, eps: float = 1e-9):
    """Splits the fluid boundary triangles by patch name (for cfMesh: separate solids).

    inlet  — the plane z = z_min
    outlet — the plane z = z_max
    walls  — the four side planes of the domain
    interface — everything else (sphere and neck surfaces)
    """
    W, z0, z1 = g["W"], g["z_min"], g["z_max"]
    c = fluid.triangles_center
    names = np.full(len(c), "interface", dtype=object)
    names[np.abs(c[:, 2] - z1) < max(eps, 1e-12)] = "outlet"
    names[np.abs(c[:, 2] - z0) < max(eps, 1e-12)] = "inlet"
    side = ((np.abs(c[:, 0]) < eps) | (np.abs(c[:, 0] - W) < eps)
            | (np.abs(c[:, 1]) < eps) | (np.abs(c[:, 1] - W) < eps))
    names[side] = "walls"
    out = {}
    for nm in ("inlet", "outlet", "walls", "interface"):
        sel = names == nm
        if sel.any():
            out[nm] = trimesh.Trimesh(vertices=fluid.vertices, faces=fluid.faces[sel], process=False)
    return out


def write_stl_multi(parts: dict, path: Path, scale: float = 1.0) -> dict:
    """Writes an ASCII STL with SEVERAL named solids — cfMesh will split them into patches."""
    lines = []
    counts = {}
    for name, mesh in parts.items():
        v = np.asarray(mesh.vertices, float) * scale
        f = np.asarray(mesh.faces, int)
        tri = v[f]
        n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        ln = np.linalg.norm(n, axis=1, keepdims=True)
        n = np.divide(n, ln, out=np.zeros_like(n), where=ln > 0)
        lines.append(f"solid {name}")
        for i in range(len(f)):
            # one facet per triangle: the nested k loop wrote each facet three times
            # (25 056 instead of 8352, benchmark DEF-01)
            lines.append(f"facet normal {n[i,0]:.9e} {n[i,1]:.9e} {n[i,2]:.9e}")
            lines.append("outer loop")
            for j in range(3):
                q = tri[i, j]
                lines.append(f"vertex {q[0]:.9e} {q[1]:.9e} {q[2]:.9e}")
            lines.append("endloop")
            lines.append("endfacet")
        lines.append(f"endsolid {name}")
        counts[name] = len(f)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n")
    return counts


def build(params: dict):
    r = float(params["r_mm"])
    n_levels = int(params["levels"])
    d = 2.0 * r
    W = params.get("W_mm", "auto")
    W = r * math.sqrt(2.0) if W in (None, "auto") else float(W)
    L_in = float(params.get("inlet_plenum_d", 2.0)) * d
    H, centers = levels_and_centers(r, W, n_levels)
    z_min = -(L_in + r)
    z_max = (n_levels - 1) * H
    outlet_mode = params.get("outlet_mode", "equator")
    if outlet_mode == "plenum":
        z_max = z_max + r + float(params.get("outlet_plenum_d", 2.0)) * d
    sub = int(params.get("icosphere_subdivisions", 4))
    contact = params.get("contact", "necks")
    r_neck = float(params.get("neck_radius_fraction", 0.1)) * d
    neck_len = float(params.get("neck_length_d", 1.5)) * d
    nseg_arc = int(params.get("planar_arc_segments", 24))

    if W > 2.0 * r + 1e-9:
        raise SystemExit(f"ERROR: W = {W:.6f} > 2r = {2*r:.6f}: the spheres do not reach the walls of the opposite corner")

    pairs = contact_pairs(centers, r) if contact != "none" else []

    # --- spheres ---------------------------------------------------------- #
    # the spheres are clipped by the domain: their centers lie on the channel walls, otherwise they stick out
    # beyond the domain by r (as in the reference: interface.stl — 28 pads cut by the planes)
    spheres = [sphere_at(r, c, sub) for c in centers]
    raw_interface = trimesh.util.concatenate(spheres)
    domain_box = trimesh.creation.box(extents=[W, W, z_max - z_min])
    domain_box.apply_translation([W / 2, W / 2, (z_min + z_max) / 2])
    interface = trimesh.boolean.intersection([raw_interface, domain_box], engine="manifold")

    # --- necks ---------------------------------------------------------- #
    # neck_surface: "waist" — open band (for snappy, links the spheres for the fill),
    #               "solid" — closed cylinder (for boolean and meshers without regions)
    neck_surface = params.get("neck_surface", "waist")
    necks = []
    necks_closed = []
    if contact == "necks":
        necks_closed = [neck_at(centers[i], centers[j], r_neck, neck_len, 24) for i, j, _ in pairs]
        if neck_surface == "waist":
            necks = [neck_band(centers[i], centers[j], r_neck, r, 24) for i, j, _ in pairs]
        else:
            necks = list(necks_closed)
    elif contact == "gap":
        gap = float(params.get("gap_mm", 0.1))
        # no neck is built, and there is no contact either — a model-level warning
        if gap <= 0:
            raise SystemExit("ERROR: contact=gap requires gap_mm > 0")
    if necks:
        neck_mesh = trimesh.util.concatenate(necks)
    else:
        neck_mesh = trimesh.Trimesh()

    # --- planes ------------------------------------------------------ #
    # The single source of arc points: outlet and outlet_solid must join EXACTLY
    # (otherwise a ring not covered by any patch remains in the z_max plane).
    def arc_pts(center, rad, a0, a1, nseg):
        """Arc points INCLUDING both ends."""
        ts = np.radians(np.linspace(a0, a1, nseg + 1))
        return [tuple(center + rad * np.array([math.cos(t), math.sin(t)])) for t in ts]

    def dedupe(pts, eps=1e-9):
        out = []
        for q in pts:
            if not out or (abs(q[0] - out[-1][0]) > eps or abs(q[1] - out[-1][1]) > eps):
                out.append(q)
        while len(out) > 1 and abs(out[0][0] - out[-1][0]) < eps and abs(out[0][1] - out[-1][1]) < eps:
            out.pop()
        return out

    # z_min: the full square (fluid only there)
    square = [(0.0, 0.0), (W, 0.0), (W, W), (0.0, W)]
    inlet = mesh_2d(fan_2d(square, (W / 2, W / 2)), "z", z_min, outward=(0, 0, -1))

    # z_max: the plane passes through the sphere centers of the last level -> quarter disks in the corners.
    # The plane is a section through the sphere CENTER: two corner disks of radius r touch at the center
    # of the square (corner distance = W*sqrt(2) = 2r), so the fluid section
    # splits into TWO lobes meeting at one point. A fan from the center is impossible
    # (the center lies on the arcs) -> each lobe is triangulated by a fan from its own domain corner.
    if nseg_arc % 2:
        raise SystemExit("ERROR: planar_arc_segments must be even (the arc is split in half)")
    k = nseg_arc // 2
    last_diag = ("A", "C") if ((n_levels - 1) % 2 == 0) else ("B", "D")
    corners = {"A": (0.0, 0.0), "B": (W, 0.0), "C": (W, W), "D": (0.0, W)}
    if last_diag == ("B", "D"):
        # disks at B and D, free corners A and C
        arcB = arc_pts(corners["B"], r, 180.0, 90.0, nseg_arc)     # (W-r,0) … center … (W,r)
        arcD = arc_pts(corners["D"], r, 270.0, 360.0, nseg_arc)    # (0,W-r) … center … (r,W)
        solid_contours = [([corners["B"]] + arcB, corners["B"]),
                          ([corners["D"]] + arcD, corners["D"])]
        lobe1 = ([(W - r, 0.0)] + arcB[:k + 1] + arcD[k::-1] + [(0.0, 0.0)])   # the lobe at A
        lobe2 = ([(W, W), (W, r)] + arcB[k:][::-1] + arcD[k:])                  # the lobe at C
        lobes = [(lobe1, corners["A"]), (lobe2, corners["C"])]
    else:
        # disks at A and C, free corners B and D
        arcA = arc_pts(corners["A"], r, 0.0, 90.0, nseg_arc)       # (r,0) … center … (0,r)
        arcC = arc_pts(corners["C"], r, 180.0, 270.0, nseg_arc)    # (W-r,W) … center … (W,W-r)
        solid_contours = [([corners["A"]] + arcA, corners["A"]),
                          ([corners["C"]] + arcC, corners["C"])]
        lobe1 = ([(0.0, W), (W - r, W)] + arcC[:k + 1] + arcA[k:])              # the lobe at D
        lobe2 = ([(W, 0.0), (r, 0.0)] + arcA[:k + 1] + arcC[k:])                # the lobe at B
        lobes = [(lobe1, corners["D"]), (lobe2, corners["B"])]

    # each lobe is a separate triangulation: the lobes wind in different directions,
    # so the normal is fixed PER LOBE, not over the merged mesh
    outlet = trimesh.util.concatenate([
        mesh_2d(fan_2d(dedupe(pts), ctr), "z", z_max, outward=(0, 0, 1))
        for pts, ctr in lobes])
    outlet_solid = mesh_2d(
        np.concatenate([fan_2d(c, ctr) for c, ctr in solid_contours]), "z", z_max, outward=(0, 0, 1))

    # side walls: 4 rectangles (normals pointing outwards)
    zmid = (z_min + z_max) / 2.0
    rect = [(0.0, z_min), (W, z_min), (W, z_max), (0.0, z_max)]
    walls = trimesh.util.concatenate([
        mesh_2d(fan_2d(rect, (W / 2, zmid)), "x", 0.0, outward=(-1, 0, 0)),
        mesh_2d(fan_2d(rect, (W / 2, zmid)), "x", W, outward=(1, 0, 0)),
        mesh_2d(fan_2d(rect, (W / 2, zmid)), "y", 0.0, outward=(0, -1, 0)),
        mesh_2d(fan_2d(rect, (W / 2, zmid)), "y", W, outward=(0, 1, 0)),
    ])

    return dict(
        r=r, d=d, W=W, H=H, n_levels=n_levels, centers=centers, z_min=z_min, z_max=z_max,
        raw_interface=raw_interface, domain_box=domain_box,
        raw_interface_faces=len(raw_interface.faces),
        L_in=L_in, outlet_mode=outlet_mode, pairs=pairs, contact=contact,
        r_neck=r_neck, neck_len=neck_len, sub=sub, neck_surface=neck_surface,
        necks_closed=(trimesh.util.concatenate(necks_closed) if necks_closed else trimesh.Trimesh()),
        interface=interface, necks=neck_mesh, inlet=inlet, outlet=outlet,
        outlet_solid=outlet_solid, walls=walls,
    )


def solid_union(g, engine="manifold") -> trimesh.Trimesh:
    """Solid body: union(spheres + necks) -> clipped by the domain.

    The union must happen BEFORE clipping: manifold computes the union of already clipped shells
    incorrectly (ref14 gave 677 mm³ instead of ~442 with 28 components).
    """
    parts = [g["raw_interface"]]
    if len(g["necks_closed"].faces):
        parts.append(g["necks_closed"])
    solid = trimesh.boolean.union(parts, engine=engine)
    return trimesh.boolean.intersection([solid, g["domain_box"]], engine=engine)


def split_union_surface(solid, g, rel_tol: float = 0.05, plane_tol: float = 1e-6):
    """Splits the SOLID BOUNDARY into two parts: the neck bands and the rest (spheres + pads on the walls).

    Multi-region snappy needs the boundary of the union body itself, not the set of original
    shells: 28 closed spheres + closed neck cylinders produce internal surfaces
    (sphere caps inside the neck) where the cellZone fill stops — the solid
    region breaks up (exp-017: solid 30053 cells instead of ~550k, i.e. roughly one sphere).
    The parts are cut along triangles, so after the cut they match vertex to vertex.
    """
    centers = np.asarray(g["centers"], float)
    r, rn = g["r"], g["r_neck"]
    hw = math.sqrt(max(r ** 2 - rn ** 2, 0.0))
    ctr = solid.triangles_center
    n = len(ctr)
    is_neck = np.zeros(n, dtype=bool)
    tol_r = rel_tol * rn
    for i, j, _ in g["pairs"]:
        ci = centers[i]
        axis = centers[j] - ci
        L = float(np.linalg.norm(axis))
        u = axis / L
        rel = ctr - ci
        t = rel @ u
        rho = np.linalg.norm(rel - t[:, None] * u, axis=1)
        is_neck |= (t > hw - 1e-6) & (t < L - hw + 1e-6) & (np.abs(rho - rn) < tol_r)
    # Flat pads on the domain walls (x=0, x=W, y=0, y=W, z=z_min, z=z_max) are NOT the interface
    # fluid/solid: that is the domain boundary, closed by blockMesh itself. If they stay in interface.stl,
    # snappy puts one-sided interface patch faces on them (exp-017: 71170 extra solid faces).
    verts = solid.vertices[solid.faces]                      # (n, 3, 3)
    planes = [(0, 0.0), (0, g["W"]), (1, 0.0), (1, g["W"]),
              (2, g["z_min"]), (2, g["z_max"])]
    is_wall = np.zeros(n, dtype=bool)
    for axis, val in planes:
        on = np.all(np.abs(verts[:, :, axis] - val) < plane_tol, axis=1)
        is_wall |= on
    is_wall &= ~is_neck

    idx_neck = np.where(is_neck)[0]
    idx_wall = np.where(is_wall)[0]
    idx_rest = np.where(~is_neck & ~is_wall)[0]
    if len(idx_neck) == 0:
        raise SystemExit("ERROR: no triangle found on the neck bands")
    neck_part = solid.submesh([idx_neck], append=True)
    rest_part = solid.submesh([idx_rest], append=True)
    wall_part = solid.submesh([idx_wall], append=True) if len(idx_wall) else trimesh.Trimesh()
    return rest_part, neck_part, wall_part


def fluid_volume(g, solid: trimesh.Trimesh, engine="manifold") -> trimesh.Trimesh:
    box = trimesh.creation.box(extents=[g["W"], g["W"], g["z_max"] - g["z_min"]])
    box.apply_translation([g["W"] / 2, g["W"] / 2, (g["z_min"] + g["z_max"]) / 2])
    return trimesh.boolean.difference([box, solid], engine=engine)


def main(argv=None):
    ap = argparse.ArgumentParser(description="'Channel with spheres' geometry (analogue of good_mesing)")
    ap.add_argument("--params", required=True, help="JSON with the parameters")
    ap.add_argument("--out-dir", required=True, help="where to write the STL files")
    ap.add_argument("--units", choices=["mm", "m"], default="mm")
    ap.add_argument("--no-boolean", action="store_true", help="do not build solid.stl/fluid.stl (boolean)")
    ap.add_argument("--format", choices=["binary", "ascii"], default="binary", help="STL format")
    ap.add_argument("--fluid-patches", action="store_true",
                    help="write fluid_patches.stl — ASCII with named solids (inlet/outlet/walls/interface) for cfMesh")
    args = ap.parse_args(argv)

    params = json.loads(Path(args.params).read_text())
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    scale = 1.0 if args.units == "mm" else 0.001
    fmt = args.format

    g = build(params)
    files = {}
    # interface_source: "raw" — spheres (as shells) + neck bands; "union" — the boundary of the union body,
    # split into «spheres/pads» and «bands» (needed for the cellZone fill in snappyHexMesh)
    interface_source = params.get("interface_source", "raw")
    solid = None
    if interface_source == "union":
        solid = solid_union(g)
        iface_part, neck_part, wall_part = split_union_surface(solid, g)
        drop_wall = bool(params.get("drop_domain_plane_faces", True))
        if not drop_wall and len(wall_part.faces):
            iface_part = trimesh.util.concatenate([iface_part, wall_part])
        files["interface.stl"] = write_stl(iface_part, out / "interface.stl", "interface", scale, fmt)
        files["interface_necks.stl"] = write_stl(neck_part, out / "interface_necks.stl",
                                                 "interface_necks", scale, fmt)
        g["interface_parts"] = {"interface": iface_part, "interface_necks": neck_part}
        g["wall_faces"] = wall_part
        g["drop_domain_plane_faces"] = drop_wall
    else:
        files["interface.stl"] = write_stl(g["interface"], out / "interface.stl", "interface", scale, fmt)
        if len(g["necks"].faces):
            files["interface_necks.stl"] = write_stl(g["necks"], out / "interface_necks.stl",
                                                     "interface_necks", scale, fmt)
    files["inlet.stl"] = write_stl(g["inlet"], out / "inlet.stl", "inlet", scale, fmt)
    files["outlet.stl"] = write_stl(g["outlet"], out / "outlet.stl", "outlet", scale, fmt)
    files["outlet_solid.stl"] = write_stl(g["outlet_solid"], out / "outlet_solid.stl", "outlet_solid", scale, fmt)
    files["walls.stl"] = write_stl(g["walls"], out / "walls.stl", "walls", scale, fmt)

    report = dict(
        units=args.units, format=fmt, scale=scale, params=params,
        r_mm=g["r"], d_mm=g["d"], W_mm=g["W"], H_mm=g["H"], n_levels=g["n_levels"],
        n_spheres=len(g["centers"]), n_contacts=len(g["pairs"]),
        contact=g["contact"], r_neck_mm=g["r_neck"], neck_len_mm=g["neck_len"],
        neck_surface=g["neck_surface"],
        inlet_plenum_mm=g["L_in"], outlet_mode=g["outlet_mode"],
        z_min_mm=g["z_min"], z_max_mm=g["z_max"], L_mm=g["z_max"] - g["z_min"],
        domain_volume_mm3=g["W"] ** 2 * (g["z_max"] - g["z_min"]),
        drop_domain_plane_faces=g.get("drop_domain_plane_faces"),
        wall_faces_dropped=(len(g["wall_faces"].faces) if g.get("wall_faces") is not None else 0),
        triangles={k: v for k, v in files.items()},
        faces={
            "interface": len(g["interface"].faces),
            "necks": len(g["necks"].faces),
            "inlet": len(g["inlet"].faces),
            "outlet": len(g["outlet"].faces),
            "outlet_solid": len(g["outlet_solid"].faces),
            "walls": len(g["walls"].faces),
        },
        areas_mm2={
            "inlet": float(g["inlet"].area),
            "outlet": float(g["outlet"].area),
            "outlet_solid": float(g["outlet_solid"].area),
            "walls": float(g["walls"].area),
            "interface": float(g["interface"].area),
            "interface_written": float(g["interface_parts"]["interface"].area) if "interface_parts" in g else None,
            "necks_written": float(g["interface_parts"]["interface_necks"].area) if "interface_parts" in g else None,
            "wall_faces_dropped": float(g["wall_faces"].area) if g.get("wall_faces") is not None else None,
            "necks": float(g["necks"].area),
        },
        volumes_mm3={
            "interface": float(abs(g["interface"].volume)),
            "raw_interface": float(abs(g["raw_interface"].volume)),
        },
        watertight={
            "interface": bool(g["interface"].is_watertight),
            "necks": bool(g["necks"].is_watertight) if len(g["necks"].faces) else None,
        },
    )

    if not args.no_boolean:
        if solid is None:
            solid = solid_union(g)
        files["solid.stl"] = write_stl(solid, out / "solid.stl", "solid", scale, fmt)
        fluid = fluid_volume(g, solid)
        files["fluid.stl"] = write_stl(fluid, out / "fluid.stl", "fluid", scale, fmt)
        report["triangles"].update({"solid.stl": files["solid.stl"], "fluid.stl": files["fluid.stl"]})
        report["boolean"] = {
            "solid_faces": len(solid.faces),
            "solid_volume_mm3": float(abs(solid.volume)),
            "solid_watertight": bool(solid.is_watertight),
            "solid_bodies": len(solid.split(only_watertight=False)),
            "fluid_faces": len(fluid.faces),
            "fluid_volume_mm3": float(abs(fluid.volume)),
            "fluid_watertight": bool(fluid.is_watertight),
            "fluid_bodies": len(fluid.split(only_watertight=False)),
        }
        fs = report["boolean"]["solid_volume_mm3"]
        fv = report["boolean"]["fluid_volume_mm3"]
        report["porosity"] = fv / report["domain_volume_mm3"]
        report["solid_fraction"] = fs / report["domain_volume_mm3"]
        report["volume_check_pct"] = 100.0 * (fs + fv - report["domain_volume_mm3"]) / report["domain_volume_mm3"]

    if args.fluid_patches and "fluid.stl" in files:
        fluid = trimesh.load(out / "fluid.stl", process=True)
        fluid_mm = fluid.copy()
        fluid_mm.vertices = np.asarray(fluid.vertices, float) / scale     # classification in mm
        parts = classify_fluid_triangles(fluid_mm, g, eps=1e-3)  # the binary STL stores float32, tolerance ~1e-3 mm
        report["fluid_patches"] = write_stl_multi(parts, out / "fluid_patches.stl", scale)
        files["fluid_patches.stl"] = sum(report["fluid_patches"].values())
        print(f"  fluid_patches.stl      {files['fluid_patches.stl']:8d} triangles "
              f"({', '.join(f'{k}:{v}' for k, v in report['fluid_patches'].items())})")

    (out / "geom_report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))

    print(f"== {out} ({args.units}) ==")
    print(f"  r = {g['r']:.4f} mm  W = {g['W']:.4f}  H = {g['H']:.4f}  levels {g['n_levels']} "
          f"(spheres {len(g['centers'])})  contacts {len(g['pairs'])}")
    print(f"  z = {g['z_min']:.4f} … {g['z_max']:.4f} mm  (L = {g['z_max']-g['z_min']:.4f}, inlet {g['L_in']:.4f} mm)")
    for k, v in files.items():
        print(f"  {k:22s} {v:8d} triangles")
    if "boolean" in report:
        b = report["boolean"]
        print(f"  solid: {b['solid_volume_mm3']:.4f} mm³ ({b['solid_bodies']} bodies, watertight={b['solid_watertight']})")
        print(f"  fluid: {b['fluid_volume_mm3']:.4f} mm³ ({b['fluid_bodies']} bodies, watertight={b['fluid_watertight']})")
        print(f"  porosity {report['porosity']:.4f}  solid fraction {report['solid_fraction']:.4f}  "
              f"volume sum: {report['volume_check_pct']:+.4f} % of the domain")
    print(f"  report: {out/'geom_report.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
