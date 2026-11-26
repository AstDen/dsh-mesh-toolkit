#!/usr/bin/env python3
"""gen_packing_stl.py — STL из таблицы упаковки шаров: шары + шейки в контактах.

Идея (та же, что в exp-009 для FCC-решётки, но здесь упаковка произвольная):

* каждый шар — UV-сфера (`--sphere-segments` × `--sphere-rings`, как segments/ring_count
  в Blender; по умолчанию 32×32) радиуса r из таблицы;
* каждая пара из таблицы контактов соединяется цилиндром-шейкой радиуса
  `--neck-radius-frac`·d_min (по умолчанию 0.1 диаметра, как в Blender-скрипте), ось —
  по нормали i→j, торцы утоплены в шары на `--neck-embed-frac`·r_min;
* объединение — булев union (движок `manifold3d`), **по связным кластерам** графа
  контактов: внутри кластера убираются пересечения «шар ↔ шейка», а разные кластеры
  не пересекаются и просто склеиваются в один STL (несколько замкнутых оболочек —
  нормальная ситуация для snappyHexMesh). Один общий union на всё (режим `global`)
  на десятках тысяч тел съедает десятки ГБ памяти — проверено OOM;
* опционально `--fluid-out`: домен контейнера минус твёрдое тело.

Геометрия берётся из шаблонов (одна единичная сфера и один единичный цилиндр,
масштаб+перенос на каждый шар) — иначе trimesh на ~8 тыс. шаров даёт гигабайты
кешей и падает по памяти.

Единицы — мм. STL бинарный, нормали наружу, оболочки замкнутые.

Пример:
  python gen_packing_stl.py --params-file params/cyl.json \\
      --balls tables/balls.csv --contacts tables/balls_contacts.csv \\
      --solid-out stl/solid.stl --json logs/stl.json --check
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
import time
from pathlib import Path

import numpy as np
import trimesh

sys.path.insert(0, str(Path(__file__).resolve().parent))

from packing_lib import make_container  # noqa: E402

DEFAULTS = {
    "sphere_segments": 32,     # долгот (segments в Blender)
    "sphere_rings": 32,        # широт (ring_count в Blender)
    "neck_radius_frac": 0.1,   # радиус шейки = frac * диаметр меньшего шара (Blender: 0.1*d)
    "neck_embed_frac": 0.35,   # насколько торец шейки утоплен в шар (доля min(r_i,r_j))
    "neck_sections": 32,       # боковых граней цилиндра
    "union_mode": "cluster",   # cluster | global
    "wall_gap_mm": 0.0,        # зазор шар-стенка (справочно; на STL не влияет)
}


# ---------------------------------------------------------------------------
# шаблоны мешей
# ---------------------------------------------------------------------------
def sphere_template(segments: int, rings: int) -> tuple[np.ndarray, np.ndarray]:
    m = trimesh.creation.uv_sphere(radius=1.0, count=[int(segments), int(rings)])
    return np.asarray(m.vertices, dtype=np.float64), np.asarray(m.faces, dtype=np.int64)


def cylinder_template(sections: int) -> tuple[np.ndarray, np.ndarray]:
    m = trimesh.creation.cylinder(radius=1.0, height=1.0, sections=int(sections))
    return np.asarray(m.vertices, dtype=np.float64), np.asarray(m.faces, dtype=np.int64)


def sphere_arrays(tv: np.ndarray, tf: np.ndarray, radius: float, center) -> tuple[np.ndarray, np.ndarray]:
    return tv * float(radius) + np.asarray(center, dtype=np.float64)[None, :], tf


def neck_arrays(tv: np.ndarray, tf: np.ndarray, p_i, r_i, p_j, r_j,
                radius: float, embed: float) -> tuple[np.ndarray, np.ndarray]:
    d = np.asarray(p_j, dtype=np.float64) - np.asarray(p_i, dtype=np.float64)
    dist = float(np.linalg.norm(d))
    if dist <= 1e-12:
        raise ValueError("шейка: центры шаров совпали")
    u = d / dist
    start = np.asarray(p_i, dtype=np.float64) + u * (r_i - embed)
    end = np.asarray(p_j, dtype=np.float64) - u * (r_j - embed)
    axis = end - start
    length = float(np.linalg.norm(axis))
    if length <= 1e-9:
        raise ValueError("шейка: нулевая длина (шары перекрываются сильнее зазора)")
    rot = trimesh.geometry.align_vectors([0.0, 0.0, 1.0], axis / length)
    v = tv * np.array([radius, radius, length])[None, :]
    v = v @ np.asarray(rot)[:3, :3].T + ((start + end) / 2.0)[None, :]
    return v, tf


def container_mesh(spec: dict, sections: int = 128) -> trimesh.Trimesh:
    kind = str(spec.get("type", "")).lower()
    if kind in ("box", "parallelepiped", "brick"):
        lo = np.asarray(spec["lo_mm"], dtype=float)
        hi = np.asarray(spec["hi_mm"], dtype=float)
        m = trimesh.creation.box(extents=hi - lo)
        m.apply_translation((lo + hi) / 2.0)
        return m
    if kind == "cylinder":
        cx, cy = (float(v) for v in spec["center_xy_mm"])
        r = float(spec["radius_mm"])
        z0, z1 = (float(v) for v in spec["z_range_mm"])
        m = trimesh.creation.cylinder(radius=r, height=z1 - z0, sections=sections)
        m.apply_translation([cx, cy, (z0 + z1) / 2.0])
        return m
    if kind == "sphere":
        c = np.asarray(spec["center_mm"], dtype=float)
        m = trimesh.creation.uv_sphere(radius=float(spec["radius_mm"]), count=[sections, sections])
        m.apply_translation(c)
        return m
    raise ValueError(f"контейнер {kind!r} не поддерживается")


# ---------------------------------------------------------------------------
# запись STL потоком (без единого гигантского массива)
# ---------------------------------------------------------------------------
def write_binary_stl_stream(path: Path, parts: list[tuple[np.ndarray, np.ndarray]],
                            name: str = "packing") -> int:
    header = (name.encode("ascii", "replace") + b" " * 80)[:80]
    n_tri = sum(len(f) for _, f in parts)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as fh:
        fh.write(header)
        fh.write(struct.pack("<I", n_tri))
        for v, f in parts:
            tri = v[f]                                   # (m, 3, 3)
            n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
            norm = np.linalg.norm(n, axis=1)
            norm[norm == 0] = 1.0
            n = n / norm[:, None]
            rec = np.zeros(len(f), dtype=[("n", "<f4", 3), ("v", "<f4", 9), ("a", "<u2")])
            rec["n"] = n.astype(np.float32)
            rec["v"] = tri.astype(np.float32).reshape(len(f), 9)
            fh.write(rec.tobytes())
    return n_tri


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="STL упаковки: шары + шейки (union по кластерам)")
    ap.add_argument("--params-file", required=True, help="JSON с container/radii и параметрами STL")
    ap.add_argument("--balls", required=True, help="CSV таблицы шаров (id,x_mm,y_mm,z_mm,r_mm)")
    ap.add_argument("--contacts", required=True, help="CSV таблицы контактов")
    ap.add_argument("--solid-out", help="STL твёрдого тела (шары+шейки)")
    ap.add_argument("--fluid-out", help="STL порового пространства (домен − solid)")
    ap.add_argument("--json", dest="json_out", help="сводка в JSON")
    ap.add_argument("--sphere-segments", type=int)
    ap.add_argument("--sphere-rings", type=int)
    ap.add_argument("--neck-radius-frac", type=float)
    ap.add_argument("--neck-embed-frac", type=float)
    ap.add_argument("--union-mode", choices=["cluster", "global"])
    ap.add_argument("--check", action="store_true", help="проверки: watertight, объём, тела")
    ap.add_argument("--reload-check", action="store_true",
                    help="дополнительно перечитать записанный STL целиком (медленно, много RAM)")
    args = ap.parse_args(argv)

    t_start = time.perf_counter()
    params = dict(DEFAULTS)
    raw = json.loads(Path(args.params_file).read_text(encoding="utf-8"))
    for key, val in raw.items():
        if key in DEFAULTS or key in ("container", "radii"):
            params[key] = val
    for key, val in (("sphere_segments", args.sphere_segments), ("sphere_rings", args.sphere_rings),
                     ("neck_radius_frac", args.neck_radius_frac),
                     ("neck_embed_frac", args.neck_embed_frac), ("union_mode", args.union_mode)):
        if val is not None:
            params[key] = val

    seg, rings = int(params["sphere_segments"]), int(params["sphere_rings"])
    sections = int(params["neck_sections"])
    nr_frac = float(params["neck_radius_frac"])
    embed_frac = float(params["neck_embed_frac"])
    mode = str(params["union_mode"])

    balls = np.genfromtxt(args.balls, delimiter=",", names=True)
    p = np.column_stack([balls["x_mm"], balls["y_mm"], balls["z_mm"]]).astype(np.float64)
    r = np.asarray(balls["r_mm"], dtype=np.float64)
    n = len(r)
    if n == 0:
        print("[stl] пустая таблица шаров", file=sys.stderr)
        return 2
    ct = np.genfromtxt(args.contacts, delimiter=",", names=True)
    ct = np.atleast_1d(ct)
    idx_i = np.asarray(ct["i"], dtype=np.int64)
    idx_j = np.asarray(ct["j"], dtype=np.int64)
    n_neck = len(idx_i)

    tv, tf = sphere_template(seg, rings)
    cv, cf = cylinder_template(sections)
    print(f"[stl] шаров {n} (r {r.min():.3f}..{r.max():.3f} мм), контактов {n_neck}; "
          f"тесселяция {seg}x{rings} = {len(tf)} треуг./шар, шейки r = {nr_frac:.3f}·d_min")

    def neck_for(k: int) -> tuple[np.ndarray, np.ndarray]:
        i, j = int(idx_i[k]), int(idx_j[k])
        r_min = float(min(r[i], r[j]))
        return neck_arrays(cv, cf, p[i], r[i], p[j], r[j],
                           nr_frac * 2.0 * r_min, min(embed_frac * r_min, 0.9 * r_min))

    # --- разбиение на связные кластеры ------------------------------------
    t0 = time.perf_counter()
    if mode == "global":
        groups = [{"spheres": list(range(n)), "necks": list(range(n_neck))}]
    else:
        root = np.arange(n)

        def find(a: int) -> int:
            while root[a] != a:
                root[a] = root[root[a]]
                a = int(root[a])
            return a

        for i, j in zip(idx_i, idx_j):
            ra, rb = find(int(i)), find(int(j))
            if ra != rb:
                root[ra] = rb
        buckets: dict[int, dict[str, list[int]]] = {}
        for k in range(n):
            buckets.setdefault(find(k), {"spheres": [], "necks": []})["spheres"].append(k)
        for k in range(n_neck):
            buckets[find(int(idx_i[k]))]["necks"].append(k)
        groups = sorted(buckets.values(), key=lambda g: -len(g["spheres"]))
    print(f"[stl] режим {mode}: групп {len(groups)} (крупнейшая: "
          f"{len(groups[0]['spheres'])} шаров, {len(groups[0]['necks'])} шеек), "
          f"разбиение {time.perf_counter() - t0:.1f} с")

    # --- union по группам, сразу в компактные массивы ----------------------
    parts: list[tuple[np.ndarray, np.ndarray]] = []
    t_union = 0.0
    for gi, g in enumerate(groups):
        t0 = time.perf_counter()
        if not g["necks"]:
            for k in g["spheres"]:
                parts.append(sphere_arrays(tv, tf, r[k], p[k]))
        else:
            local = [trimesh.Trimesh(*sphere_arrays(tv, tf, r[k], p[k]), process=False)
                     for k in g["spheres"]]
            local += [trimesh.Trimesh(*neck_for(k), process=False) for k in g["necks"]]
            merged = local[0] if len(local) == 1 else trimesh.boolean.union(local, engine="manifold")
            parts.append((np.asarray(merged.vertices, dtype=np.float64),
                          np.asarray(merged.faces, dtype=np.int64)))
            del local, merged
        t_union += time.perf_counter() - t0
        if gi < 5 or (gi + 1) % 20 == 0 or gi + 1 == len(groups):
            print(f"[stl]   группа {gi + 1}/{len(groups)}: шаров {len(g['spheres'])}, "
                  f"шеек {len(g['necks'])}, треуг. {len(parts[-1][1])}, "
                  f"{time.perf_counter() - t0:.1f} с")
    n_tri = int(sum(len(f) for _, f in parts))
    print(f"[stl] union готов: {len(parts)} оболочек, {n_tri} треуг., {t_union:.1f} с")

    info: dict = {
        "params_file": str(args.params_file),
        "balls_csv": str(args.balls), "contacts_csv": str(args.contacts),
        "n_spheres": int(n), "n_necks": int(n_neck),
        "sphere_tessellation": [seg, rings],
        "neck_radius_frac": nr_frac, "neck_embed_frac": embed_frac, "neck_sections": sections,
        "union_mode": mode, "n_union_clusters": len(groups),
        "n_triangles": n_tri,
        "time_s": {"union": t_union},
    }

    # --- запись STL --------------------------------------------------------
    if args.solid_out:
        t0 = time.perf_counter()
        write_binary_stl_stream(Path(args.solid_out), parts, name="packing_solid")
        dt = time.perf_counter() - t0
        info["solid_out"] = {"path": str(args.solid_out),
                             "bytes": Path(args.solid_out).stat().st_size,
                             "time_s": dt, "triangles": n_tri}
        print(f"[stl] solid: {args.solid_out} ({info['solid_out']['bytes'] / 1e6:.1f} МБ, "
              f"{n_tri} треуг., запись {dt:.1f} с)")

    # --- проверки ----------------------------------------------------------
    problems: list[str] = []
    args_reload = "--reload-check" in (argv if argv is not None else sys.argv[1:])
    if args_reload and args.solid_out:
        t0 = time.perf_counter()
        mesh = trimesh.load(Path(args.solid_out), process=True)
        info["check_reload_s"] = time.perf_counter() - t0
        info.update({"watertight": bool(mesh.is_watertight),
                     "winding_consistent": bool(mesh.is_winding_consistent),
                     "volume_mm3": float(mesh.volume), "area_mm2": float(mesh.area),
                     "n_bodies": int(len(mesh.split(only_watertight=False)))})
        del mesh
    else:
        # быстрая проверка по частям (для 30+ млн треуг. полная перезагрузка STL
        # не нужна и опасна по памяти): объём/площадь/замкнутость каждой оболочки
        t0 = time.perf_counter()
        vol = area = 0.0
        bad = 0
        for v, f in parts:
            m = trimesh.Trimesh(v, f, process=False)
            vol += float(m.volume)
            area += float(m.area)
            if not m.is_watertight:
                bad += 1
            del m
        info["check_parts_s"] = time.perf_counter() - t0
        info.update({"watertight": bad == 0, "n_bodies": len(parts),
                     "volume_mm3": vol, "area_mm2": area,
                     "unwatertight_shells": int(bad)})

    v_spheres = float((4.0 / 3.0 * np.pi * r ** 3).sum())
    info["volume_spheres_sum_mm3"] = v_spheres
    info["volume_ratio_vs_spheres"] = float(info["volume_mm3"] / v_spheres)
    print(f"[stl] проверка: watertight={info['watertight']}, оболочек/тел={info['n_bodies']}, "
          f"V={info['volume_mm3']:.1f} мм³, S={info['area_mm2']:.1f} мм², "
          f"V/V_шаров={info['volume_ratio_vs_spheres']:.5f}")
    if not info["watertight"]:
        problems.append("есть незамкнутые оболочки")
    if not (0.9 <= info["volume_ratio_vs_spheres"] <= 1.0 + 1e-9):
        problems.append(f"V/V_шаров={info['volume_ratio_vs_spheres']:.6f} вне [0.9, 1.0]")

    if args.fluid_out:
        t0 = time.perf_counter()
        if not args.solid_out:
            raise SystemExit("--fluid-out требует --solid-out")
        dom = container_mesh(params["container"])
        # manifold требует «volume»: собираем solid из частей и сливаем вершины
        # (чтение STL с process=False даёт несшитые вершины -> «Not all meshes are volumes!»)
        solid_mesh = trimesh.util.concatenate(
            [trimesh.Trimesh(v, f, process=False) for v, f in parts])
        solid_mesh.merge_vertices()
        fluid = trimesh.boolean.difference([dom, solid_mesh], engine="manifold")
        fluid.export(args.fluid_out)
        info["fluid_out"] = {"path": str(args.fluid_out),
                             "bytes": Path(args.fluid_out).stat().st_size,
                             "volume_mm3": float(fluid.volume),
                             "area_mm2": float(fluid.area),
                             "watertight": bool(fluid.is_watertight),
                             "n_bodies": int(len(fluid.split(only_watertight=False))),
                             "triangles": int(len(fluid.faces)),
                             "time_s": time.perf_counter() - t0}
        print(f"[stl] fluid: {args.fluid_out} (V={fluid.volume:.1f} мм³, "
              f"S={fluid.area:.1f} мм², watertight={fluid.is_watertight}, "
              f"{info['fluid_out']['time_s']:.1f} с)")
        if not info["fluid_out"]["watertight"]:
            problems.append("fluid не watertight")
        v_dom = float(container_mesh(params["container"]).volume)
        if not (1e-6 < info["fluid_out"]["volume_mm3"] < v_dom):
            problems.append("объём fluid вне (0, V_домена)")

    info["problems"] = problems
    info["time_s"]["total"] = time.perf_counter() - t_start
    rc = 0
    if args.check:
        for pr in problems:
            print(f"[check] FAIL: {pr}", file=sys.stderr)
        if problems:
            rc = 1
        else:
            print("[check] PASS: watertight, нормали согласованы, объёмы в допуске")
    info["verdict"] = "FAIL" if problems else "PASS"
    if args.json_out:
        Path(args.json_out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json_out).write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n",
                                       encoding="utf-8")
        print(f"[stl] сводка: {args.json_out}")
    print(f"[stl] VERDICT: {info['verdict']}  время {info['time_s']['total']:.1f} с")
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
