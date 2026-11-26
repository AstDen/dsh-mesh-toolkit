#!/usr/bin/env python3
"""gen_channel_spheres.py — параметрическая геометрия «канал с шарами» (аналог эталона good_mesing).

Семейство (см. experiments/exp-017_channel-spheres-mesh/DIALOG.md):
    d = 2r, W = r*sqrt(2), H = sqrt((2r)^2 - W^2) = W
    14 уровней по 2 шара на 4 рёбрах канала, диагонали чередуются,
    входной пустой участок L_in = inlet_plenum_d * d, выход — плоскость через центры
    последнего уровня (полушары срезаны).

Артефакты (ASCII STL, единицы --units мм|м):
    interface.stl        28 сфер (замкнутые оболочки, patch wall)
    interface_necks.stl  шейки в контактах (patch wall, уровень +1)
    inlet.stl            z = z_min, полный квадрат (patch symmetry при мешинге)
    outlet.stl           z = z_max, жидкостная часть (квадрат минус четверть-диски)
    outlet_solid.stl     z = z_max, твёрдая часть (четверть-диски сфер)
    walls.stl            4 боковые грани домена (patch symmetry)
    solid.stl            union(сферы + шейки) — для cfMesh / справки
    fluid.stl            домен − solid — замкнутая поверхность жидкости (cfMesh)
    geom_report.json     все числа + проверки watertight

Пример:
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
# запись ASCII STL с именем solid
# --------------------------------------------------------------------------- #
def write_stl(mesh: trimesh.Trimesh, path: Path, name: str, scale: float = 1.0,
              fmt: str = "binary") -> int:
    """Пишет Trimesh в STL (binary|ascii) под именем solid. Возвращает число треугольников."""
    if fmt == "binary":
        m = mesh.copy()
        m.vertices = np.asarray(m.vertices, dtype=float) * scale
        path.parent.mkdir(parents=True, exist_ok=True)
        m.export(path, file_type="stl")
        return len(m.faces)
    v = np.asarray(mesh.vertices, dtype=float) * scale
    f = np.asarray(mesh.faces, dtype=int)
    if len(f) == 0:
        raise ValueError(f"{name}: пустая сетка")
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
# геометрия
# --------------------------------------------------------------------------- #
def levels_and_centers(r: float, W: float, n_levels: int):
    """Центры шаров: на каждом уровне одна диагональ (чёт — A-D, нечёт — B-C)."""
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
    """Пары (i, j) шаров, касающихся в ноль (|c_i - c_j| = 2r)."""
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
    """Цилиндр-шейка в точке касания, ось вдоль (c_j - c_i)."""
    c_i = np.asarray(c_i, float)
    c_j = np.asarray(c_j, float)
    axis = c_j - c_i
    axis /= np.linalg.norm(axis)
    cyl = trimesh.creation.cylinder(radius=r_neck, height=length, sections=sections)
    # цилиндр по умолчанию вдоль +z
    rot = trimesh.geometry.align_vectors([0.0, 0.0, 1.0], axis)
    cyl.apply_transform(rot)
    cyl.apply_translation((c_i + c_j) / 2.0)
    return cyl


def neck_band(c_i, c_j, r_neck: float, r_sphere: float, sections: int = 24) -> trimesh.Trimesh:
    """ОТКРЫТАЯ цилиндрическая полоса (waist) — часть шейки, лежащая снаружи обеих сфер.

    Нужна для многорегионального snappyHexMesh: закрытый цилиндр-шейка даёт торец ВНУТРИ
    сферы, на нём заливка cellZone останавливается и твёрдая область распадается на
    несвязные компоненты (exp-017: solid 1071 ячейка вместо ~550k). Полоса открыта с
    обоих концов, поэтому заливка проходит из сферы A в сферу B, а жидкость снаружи
    не может попасть внутрь — торцы лежат внутри сфер.
    """
    c_i = np.asarray(c_i, float)
    c_j = np.asarray(c_j, float)
    axis = c_j - c_i
    L = float(np.linalg.norm(axis))
    u = axis / L
    half = math.sqrt(max(r_sphere ** 2 - r_neck ** 2, 0.0))
    t1, t2 = half, L - half
    if t2 <= t1:
        raise SystemExit(f"ERROR: шейка вырождена: r_neck={r_neck} слишком велик для r={r_sphere}")
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
    """Веерная триангуляция замкнутого контура (звёздного относительно center). Возвращает (n,3,2)."""
    c = np.asarray(center_xy, float)
    tris = []
    n = len(contour_xy)
    for i in range(n):
        p = np.asarray(contour_xy[i], float)
        q = np.asarray(contour_xy[(i + 1) % n], float)
        tris.append(np.array([c, p, q]))
    return np.asarray(tris, float)


def mesh_2d(tris_2d, plane: str, value: float, outward=None) -> trimesh.Trimesh:
    """(n,3,2) в плоскости -> Trimesh. plane: 'z'|'x'|'y'. outward — желаемая нормаль."""
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
    """Разносит треугольники границы жидкости по именам патчей (для cfMesh: отдельные solid-ы).

    inlet  — плоскости z = z_min
    outlet — плоскость z = z_max
    walls  — четыре боковые плоскости домена
    interface — всё остальное (поверхности сфер и шеек)
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
    """Пишет ASCII STL с НЕСКОЛЬКИМИ именованными solid-ами — cfMesh разложит их в патчи."""
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
            # один фасет на треугольник: вложенный цикл по k писал каждый фасет трижды
            # (25 056 вместо 8352, benchmark DEF-01)
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
        raise SystemExit(f"ERROR: W = {W:.6f} > 2r = {2*r:.6f}: шары не достигают стенок противоположного угла")

    pairs = contact_pairs(centers, r) if contact != "none" else []

    # --- сферы ---------------------------------------------------------- #
    # сферы обрезаются доменом: центры лежат на стенках канала, иначе шары торчат
    # за домен на r (как в эталоне: interface.stl — 28 площадок, срезанных плоскостями)
    spheres = [sphere_at(r, c, sub) for c in centers]
    raw_interface = trimesh.util.concatenate(spheres)
    domain_box = trimesh.creation.box(extents=[W, W, z_max - z_min])
    domain_box.apply_translation([W / 2, W / 2, (z_min + z_max) / 2])
    interface = trimesh.boolean.intersection([raw_interface, domain_box], engine="manifold")

    # --- шейки ---------------------------------------------------------- #
    # neck_surface: "waist" — открытая полоса (для snappy, связывает сферы для заливки),
    #               "solid" — закрытый цилиндр (для boolean и мешеров без регионов)
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
        # шейку не строим, но и касания нет — предупреждение на уровне модели
        if gap <= 0:
            raise SystemExit("ERROR: contact=gap требует gap_mm > 0")
    if necks:
        neck_mesh = trimesh.util.concatenate(necks)
    else:
        neck_mesh = trimesh.Trimesh()

    # --- плоскости ------------------------------------------------------ #
    # Единственный источник точек дуг: outlet и outlet_solid обязаны ТОЧНО стыковаться
    # (иначе в плоскости z_max остаётся кольцо, не покрытое ни одним патчем).
    def arc_pts(center, rad, a0, a1, nseg):
        """Точки дуги ВКЛЮЧАЯ оба конца."""
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

    # z_min: полный квадрат (там только жидкость)
    square = [(0.0, 0.0), (W, 0.0), (W, W), (0.0, W)]
    inlet = mesh_2d(fan_2d(square, (W / 2, W / 2)), "z", z_min, outward=(0, 0, -1))

    # z_max: плоскость проходит через центры сфер последнего уровня -> в углах четверть-диски.
    # Плоскость — сечение через ЦЕНТР сфер: два угловых диска радиуса r касаются в центре
    # квадрата (расстояние между углами = W*sqrt(2) = 2r), поэтому жидкостное сечение
    # распадается на ДВЕ доли, сходящиеся в одной точке. Веер из центра невозможен
    # (центр лежит на дугах) -> каждая доля триангулируется веером от своего угла домена.
    if nseg_arc % 2:
        raise SystemExit("ERROR: planar_arc_segments должен быть чётным (деление дуги пополам)")
    k = nseg_arc // 2
    last_diag = ("A", "C") if ((n_levels - 1) % 2 == 0) else ("B", "D")
    corners = {"A": (0.0, 0.0), "B": (W, 0.0), "C": (W, W), "D": (0.0, W)}
    if last_diag == ("B", "D"):
        # диски в B и D, свободные углы A и C
        arcB = arc_pts(corners["B"], r, 180.0, 90.0, nseg_arc)     # (W-r,0) … центр … (W,r)
        arcD = arc_pts(corners["D"], r, 270.0, 360.0, nseg_arc)    # (0,W-r) … центр … (r,W)
        solid_contours = [([corners["B"]] + arcB, corners["B"]),
                          ([corners["D"]] + arcD, corners["D"])]
        lobe1 = ([(W - r, 0.0)] + arcB[:k + 1] + arcD[k::-1] + [(0.0, 0.0)])   # доля у A
        lobe2 = ([(W, W), (W, r)] + arcB[k:][::-1] + arcD[k:])                  # доля у C
        lobes = [(lobe1, corners["A"]), (lobe2, corners["C"])]
    else:
        # диски в A и C, свободные углы B и D
        arcA = arc_pts(corners["A"], r, 0.0, 90.0, nseg_arc)       # (r,0) … центр … (0,r)
        arcC = arc_pts(corners["C"], r, 180.0, 270.0, nseg_arc)    # (W-r,W) … центр … (W,W-r)
        solid_contours = [([corners["A"]] + arcA, corners["A"]),
                          ([corners["C"]] + arcC, corners["C"])]
        lobe1 = ([(0.0, W), (W - r, W)] + arcC[:k + 1] + arcA[k:])              # доля у D
        lobe2 = ([(W, 0.0), (r, 0.0)] + arcA[:k + 1] + arcC[k:])                # доля у B
        lobes = [(lobe1, corners["D"]), (lobe2, corners["B"])]

    # каждая доля — отдельная триангуляция: у долей разное направление обхода,
    # поэтому нормаль нормируется ПО ДОЛЕ, а не по объединённой сетке
    outlet = trimesh.util.concatenate([
        mesh_2d(fan_2d(dedupe(pts), ctr), "z", z_max, outward=(0, 0, 1))
        for pts, ctr in lobes])
    outlet_solid = mesh_2d(
        np.concatenate([fan_2d(c, ctr) for c, ctr in solid_contours]), "z", z_max, outward=(0, 0, 1))

    # боковые стенки: 4 прямоугольника (нормали наружу)
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
    """Твёрдое тело: union(сферы + шейки) -> обрезка доменом.

    Объединять надо ДО обрезки: union уже обрезанных оболочек manifold считает
    неправильно (на ref14 получалось 677 мм³ вместо ~442 при 28 компонентах).
    """
    parts = [g["raw_interface"]]
    if len(g["necks_closed"].faces):
        parts.append(g["necks_closed"])
    solid = trimesh.boolean.union(parts, engine=engine)
    return trimesh.boolean.intersection([solid, g["domain_box"]], engine=engine)


def split_union_surface(solid, g, rel_tol: float = 0.05, plane_tol: float = 1e-6):
    """Делит ГРАНИЦУ ТВЁРДОГО на две части: пояски шеек и остальное (сферы + пятна на стенках).

    Для многорегионального snappy нужна именно граница union-тела, а не набор исходных
    оболочек: 28 закрытых сфер + закрытые цилиндры-шейки дают внутренние поверхности
    (шапки сфер внутри шейки), на которых заливка cellZone останавливается — твёрдая
    область распадается (exp-017: solid 30053 ячейки вместо ~550k, т.е. примерно один шар).
    Части режутся по треугольникам, поэтому после разреза они стыкуются вершина-в-вершину.
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
    # Плоские пятна на стенках домена (x=0, x=W, y=0, y=W, z=z_min, z=z_max) — это НЕ интерфейс
    # fluid/solid: там граница домена, её закрывает сам blockMesh. Если оставить их в interface.stl,
    # snappy ставит на них односторонние грани-патч interface (exp-017: 71170 лишних граней solid).
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
        raise SystemExit("ERROR: не найдено ни одного треугольника на поясках шеек")
    neck_part = solid.submesh([idx_neck], append=True)
    rest_part = solid.submesh([idx_rest], append=True)
    wall_part = solid.submesh([idx_wall], append=True) if len(idx_wall) else trimesh.Trimesh()
    return rest_part, neck_part, wall_part


def fluid_volume(g, solid: trimesh.Trimesh, engine="manifold") -> trimesh.Trimesh:
    box = trimesh.creation.box(extents=[g["W"], g["W"], g["z_max"] - g["z_min"]])
    box.apply_translation([g["W"] / 2, g["W"] / 2, (g["z_min"] + g["z_max"]) / 2])
    return trimesh.boolean.difference([box, solid], engine=engine)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Геометрия 'канал с шарами' (аналог good_mesing)")
    ap.add_argument("--params", required=True, help="JSON с параметрами")
    ap.add_argument("--out-dir", required=True, help="куда писать STL")
    ap.add_argument("--units", choices=["mm", "m"], default="mm")
    ap.add_argument("--no-boolean", action="store_true", help="не строить solid.stl/fluid.stl (boolean)")
    ap.add_argument("--format", choices=["binary", "ascii"], default="binary", help="формат STL")
    ap.add_argument("--fluid-patches", action="store_true",
                    help="писать fluid_patches.stl — ASCII с именованными solid-ами (inlet/outlet/walls/interface) для cfMesh")
    args = ap.parse_args(argv)

    params = json.loads(Path(args.params).read_text())
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    scale = 1.0 if args.units == "mm" else 0.001
    fmt = args.format

    g = build(params)
    files = {}
    # interface_source: "raw" — сферы (как оболочки) + полосы шеек; "union" — граница union-тела,
    # разрезанная на «сферы/пятна» и «пояски» (нужно для заливки cellZone в snappyHexMesh)
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
        fluid_mm.vertices = np.asarray(fluid.vertices, float) / scale     # классификация в мм
        parts = classify_fluid_triangles(fluid_mm, g, eps=1e-3)  # бинарный STL хранит float32, допуск ~1e-3 мм
        report["fluid_patches"] = write_stl_multi(parts, out / "fluid_patches.stl", scale)
        files["fluid_patches.stl"] = sum(report["fluid_patches"].values())
        print(f"  fluid_patches.stl      {files['fluid_patches.stl']:8d} треугольников "
              f"({', '.join(f'{k}:{v}' for k, v in report['fluid_patches'].items())})")

    (out / "geom_report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))

    print(f"== {out} ({args.units}) ==")
    print(f"  r = {g['r']:.4f} мм  W = {g['W']:.4f}  H = {g['H']:.4f}  уровней {g['n_levels']} "
          f"(шаров {len(g['centers'])})  контактов {len(g['pairs'])}")
    print(f"  z = {g['z_min']:.4f} … {g['z_max']:.4f} мм  (L = {g['z_max']-g['z_min']:.4f}, вход {g['L_in']:.4f} мм)")
    for k, v in files.items():
        print(f"  {k:22s} {v:8d} треугольников")
    if "boolean" in report:
        b = report["boolean"]
        print(f"  solid: {b['solid_volume_mm3']:.4f} мм³ ({b['solid_bodies']} тел, watertight={b['solid_watertight']})")
        print(f"  fluid: {b['fluid_volume_mm3']:.4f} мм³ ({b['fluid_bodies']} тел, watertight={b['fluid_watertight']})")
        print(f"  пористость {report['porosity']:.4f}  доля твёрдого {report['solid_fraction']:.4f}  "
              f"сумма объёмов: {report['volume_check_pct']:+.4f} % от домена")
    print(f"  отчёт: {out/'geom_report.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
