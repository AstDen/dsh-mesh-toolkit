#!/usr/bin/env python3
"""gen_cq_porous.py — параметрический генератор пористой геометрии на CadQuery.

Строит домен жидкости = блок МИНУС полости (сферы/цилиндры), экспортирует бинарный STL
в мм и (по флагу --check) прогоняет QA через trimesh.

Аналитика (формула продублирована в geometry/cad/README.md и в cq_common.py):

    V_fluid = V_domain − Σ V_holes + Σ V_overlaps
    V_domain  = Lx · Ly · Lz
    V_sphere  = 4/3 · π · R³
    V_cyl     = π · R² · h            (h — длина цилиндра внутри домена)
    V_overlap = 16/3 · R³             (пересечение двух перпендикулярных цилиндров равного R)
    A_fluid   = 2(Lx·Ly + Ly·Lz + Lz·Lx) + Σ A_holes_inside   (сферы целиком внутри блока)
    A_cyl     = A_box − Σ 2πR² + Σ 2πR·h   (цилиндр пробивает две противоположные грани)

Фасетный STL всегда даёт объём МЕНЬШЕ аналитики (вписанный многогранник) — это дискретизация,
а не ошибка геометрии (env/ENV_REPORT.md §5 п.9).

Примеры:
  # плита 10×10×4 мм минус 8 сфер R=1.2 мм, допуск 0.05
  .venv/bin/python geometry/cad/gen_cq_porous.py \
      --params-file geometry/cad/params/plate_spheres_8.json \
      --out experiments/exp-002-cadquery-stl/stl/case2_tol0.05.stl \
      --tolerance 0.05 --check --json experiments/exp-002-cadquery-stl/logs/case2.json

  # канал с пересекающимися цилиндрами
  .venv/bin/python geometry/cad/gen_cq_porous.py \
      --params-file geometry/cad/params/channel_cylinders.json \
      --out experiments/exp-002-cadquery-stl/stl/case6.stl --check

Коды возврата: 0 — успех (и QA пройден, если --check), 1 — QA не пройден, 2 — ошибка входа.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from importlib.metadata import version as pkg_version

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
for path in (HERE, PROJECT_ROOT):
    if path not in sys.path:
        sys.path.insert(0, path)

import cadquery as cq  # noqa: E402

import cq_common as cc  # noqa: E402
# in-package copy of tools/qa/stl_qa.py: the generator must work outside the research project
from py_qa import clean_stl, qa_stl  # noqa: E402


def ocp_version() -> str:
    try:
        return pkg_version("cadquery-ocp")
    except Exception:  # noqa: BLE001
        return "unknown"


def log(msg: str) -> None:
    print(msg, flush=True)


def build_lattice_spheres(params: dict) -> tuple[cq.Workplane, list[cq.Solid], cc.CaseGeometry]:
    lx, ly, lz = (float(v) for v in params["domain_mm"])
    r = float(params["sphere_radius_mm"])
    nx, ny, nz = (int(v) for v in params["lattice"])
    centers = cc.lattice_centers(lx, ly, lz, nx, ny, nz)
    cc.check_spheres_inside(centers, r, (lx, ly, lz))

    base = cc.make_block(lx, ly, lz)
    tools = [cc.make_sphere(r, c) for c in centers]
    n = len(tools)
    geo = cc.CaseGeometry(
        kind="lattice_spheres",
        domain=(lx, ly, lz),
        n_holes=n,
        expected_volume=cc.box_volume(lx, ly, lz) - n * cc.sphere_volume(r),
        expected_area=cc.box_area(lx, ly, lz) + n * cc.sphere_area(r),
        expected_bodies=1 + n,  # внешняя оболочка + по одной на каждую замкнутую сферу
        details={
            "sphere_radius_mm": r,
            "lattice": [nx, ny, nz],
            "centers_mm": [list(c) for c in centers],
        },
    )
    return base, tools, geo


def build_cylinders(params: dict) -> tuple[cq.Workplane, list[cq.Solid], cc.CaseGeometry]:
    lx, ly, lz = (float(v) for v in params["domain_mm"])
    domain = (lx, ly, lz)
    sizes = {"x": lx, "y": ly, "z": lz}
    tools: list[cq.Solid] = []
    cyl_meta: list[dict] = []
    perp_of = {"x": ("y", "z"), "y": ("x", "z"), "z": ("x", "y")}
    axis_len = dict(sizes)

    for idx, cyl in enumerate(params["cylinders"]):
        axis = cyl["axis"].lower()
        r = float(cyl["radius_mm"])
        extend = float(cyl.get("extend_mm", 1.0))
        p1, p2 = perp_of[axis]
        if p1 not in cyl or p2 not in cyl:
            raise ValueError(f"цилиндр #{idx}: для оси {axis} нужны координаты {p1} и {p2}")
        a, b = float(cyl[p1]), float(cyl[p2])
        # проверка, что сам цилиндр внутри домена по поперечным осям
        for val, name in ((a, p1), (b, p2)):
            if val - r < -1e-6 or val + r > sizes[name] + 1e-6:
                raise ValueError(
                    f"цилиндр #{idx} выходит за грань {name}: центр {val}, R={r}, "
                    f"домен {sizes[name]}"
                )
        solid = cc.make_cylinder(r, axis, a, b, axis_len[axis], extend=extend)
        tools.append(solid)
        cyl_meta.append(
            {
                "axis": axis,
                "a": a,
                "b": b,
                "radius": r,
                "length": axis_len[axis],
                p1: a,
                p2: b,
                "extend_mm": extend,
            }
        )

    overlap = cc.check_crossing_cylinders(cyl_meta, domain)
    holes = sum(cc.cylinder_volume(c["radius"], c["length"]) for c in cyl_meta)

    # площадь аналитически считается только когда цилиндры не пересекаются друг с другом
    area = None
    if overlap == 0.0:
        area = cc.box_area(lx, ly, lz)
        for c in cyl_meta:
            area += cc.cylinder_lateral_area(c["radius"], c["length"]) - 2.0 * (
                cc.PI * c["radius"] ** 2
            )

    base = cc.make_block(lx, ly, lz)
    geo = cc.CaseGeometry(
        kind="cylinders",
        domain=domain,
        n_holes=len(tools),
        expected_volume=cc.box_volume(lx, ly, lz) - holes + overlap,
        expected_area=area,
        expected_bodies=1,  # сквозные цилиндры открывают полости на грани -> одна оболочка
        details={
            "cylinders": [{k: v for k, v in c.items() if k not in ("a", "b")} for c in cyl_meta],
            "cyl_holes_volume": holes,
            "overlap_volume": overlap,
            "openings_on_faces": 2 * len(cyl_meta),
        },
    )
    return base, tools, geo


BUILDERS = {
    "lattice_spheres": build_lattice_spheres,
    "cylinders": build_cylinders,
}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Генератор пористой геометрии на CadQuery: блок минус сферы/цилиндры → STL (мм).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument("--params-file", required=True, help="JSON с параметрами геометрии")
    ap.add_argument("--out", required=True, help="куда писать STL")
    ap.add_argument("--tolerance", type=float, default=0.05, help="tolerance экспорта STL, мм")
    ap.add_argument(
        "--angular-tolerance",
        type=float,
        default=0.1,
        help="angularTolerance экспорта STL, рад",
    )
    ap.add_argument(
        "--strategy",
        choices=["single", "sequential", "fused", "both"],
        default="sequential",
        help="стратегия булева вычитания: sequential (по умолчанию, верна для пересекающихся "
        "полостей), single = одна операция с компаундом (теряет объём пересечения), "
        "fused = фьюз полостей + один cut, both = сверка single и sequential по объёму",
    )
    ap.add_argument(
        "--lattice",
        default=None,
        help="переопределить упаковку сфер 'nx,ny,nz' (только для kind=lattice_spheres)",
    )
    ap.add_argument("--seed", type=int, default=None, help="seed (для этих кейсов роли не играет)")
    ap.add_argument("--check", action="store_true", help="выполнить QA STL через trimesh")
    ap.add_argument("--json", dest="json_out", default=None, help="куда записать отчёт JSON")
    ap.add_argument(
        "--max-volume-err", type=float, default=2.0, help="допуск |ΔV| к аналитике, %%"
    )
    ap.add_argument(
        "--export-api",
        choices=["exporters", "exportStl"],
        default="exporters",
        help="exporters = cq.exporters.export (всегда relative tolerance); "
        "exportStl = прямой Shape.exportStl (умеет absolute tolerance)",
    )
    ap.add_argument(
        "--relative-tolerance",
        choices=["default", "abs"],
        default="default",
        help="для --export-api exportStl: default = relative=True (как у exporters), "
        "abs = relative=False (абсолютный допуск в мм)",
    )
    ap.add_argument(
        "--clean-stl",
        action="store_true",
        help="записать рядом очищенный STL <имя>_clean.stl (без вырожденных граней OCC)",
    )
    args = ap.parse_args(argv)

    try:
        with open(args.params_file, encoding="utf-8") as fh:
            params = json.load(fh)
    except Exception as exc:  # noqa: BLE001
        print(f"ОШИБКА чтения {args.params_file}: {exc}", file=sys.stderr)
        return 2

    kind = params.get("kind")
    if kind not in BUILDERS:
        print(f"ОШИБКА: неизвестный kind={kind!r}, есть {sorted(BUILDERS)}", file=sys.stderr)
        return 2

    if args.lattice:
        try:
            lat = [int(v) for v in args.lattice.replace("x", ",").split(",")]
            assert len(lat) == 3 and all(v > 0 for v in lat)
        except Exception:  # noqa: BLE001
            print(f"ОШИБКА: --lattice={args.lattice!r}, нужно 'nx,ny,nz'", file=sys.stderr)
            return 2
        if kind != "lattice_spheres":
            print("ОШИБКА: --lattice применим только к kind=lattice_spheres", file=sys.stderr)
            return 2
        params["lattice"] = lat
        params["lattice_override"] = args.lattice

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)

    log("=" * 70)
    log(f"gen_cq_porous.py: {params.get('name', os.path.basename(args.params_file))}")
    log(f"  cadquery {cq.__version__}, OCP {ocp_version()}, python {sys.version.split()[0]}")
    log(f"  kind={kind}, tolerance={args.tolerance} мм, angularTolerance={args.angular_tolerance} рад")
    log(f"  strategy={args.strategy}, out={args.out}")
    log("=" * 70)

    t_start = time.perf_counter()
    t_geo0 = time.perf_counter()
    base, tools, geo = BUILDERS[kind](params)
    geometry_build_time = time.perf_counter() - t_geo0

    def _cut(strategy: str) -> tuple[cq.Shape, float]:
        t0 = time.perf_counter()
        result_shape = cc.cut_tools(base, tools, strategy=strategy)
        return result_shape, time.perf_counter() - t0

    strategy_used = args.strategy
    strategy_times: dict[str, float] = {}
    strategy_volumes: dict[str, float] = {}
    strategy_volume_rel_diff_pct = None

    if args.strategy == "both":
        shape, t_single = _cut("single")
        shape_seq, t_seq = _cut("sequential")
        v_single = float(shape.Volume())
        v_seq = float(shape_seq.Volume())
        strategy_times = {"single": round(t_single, 6), "sequential": round(t_seq, 6)}
        strategy_volumes = {"single": v_single, "sequential": v_seq}
        strategy_volume_rel_diff_pct = (
            abs(v_single - v_seq) / max(abs(v_single), 1e-12) * 100.0
        )
        if strategy_volume_rel_diff_pct > 1e-6:
            # Найдено в exp-002 на case6: если ПОЛОСТИ ПЕРЕСЕКАЮТСЯ между собой,
            # один Cut с компаундом вычитает общие области дважды и теряет объём
            # (single=359.6177 vs sequential=367.8097 мм3 при аналитике 367.8097).
            # Поэтому при расхождении экспортируем результат sequential.
            log(
                "ВНИМАНИЕ: стратегии дали разный объём OCC: "
                f"single={v_single:.9f}, sequential={v_seq:.9f} "
                f"({strategy_volume_rel_diff_pct:.3e} %) — берём sequential "
                "(пересекающиеся полости: компаундный Cut теряет объём)"
            )
            strategy_used = "sequential"
            shape = shape_seq
            build_time = t_seq
        else:
            strategy_used = "single"
            build_time = t_single
        log(
            f"стратегия single: {t_single:.3f} с, sequential: {t_seq:.3f} с, "
            f"ΔV(strategies)={strategy_volume_rel_diff_pct:.3e} %"
        )
    else:
        try:
            shape, build_time = _cut(args.strategy)
        except Exception as exc:  # noqa: BLE001
            log(
                f"ВНИМАНИЕ: стратегия {args.strategy} упала "
                f"({type(exc).__name__}: {exc}); откат на sequential"
            )
            shape, build_time = _cut("sequential")
            strategy_used = "sequential"

    n_solids = len(shape.Solids())
    occ_volume = float(shape.Volume())
    occ_volume_err_pct = (occ_volume - geo.expected_volume) / geo.expected_volume * 100.0
    log(
        f"геометрия: {geometry_build_time:.3f} с; булевы операции ({strategy_used}): "
        f"{build_time:.3f} с; тел: {n_solids}"
    )
    log(
        f"объём OCC (точный): {occ_volume:.9f} мм3; аналитика {geo.expected_volume:.9f} мм3; "
        f"ΔV_occ={occ_volume_err_pct:+.6f} %"
    )
    # Ошибка булевых операций видна ТОЛЬКО здесь (тесселяция даёт <0.1 %): гейт всегда,
    # независимо от --check, иначе генератор отдаёт битую геометрию с rc=0.
    volume_tol_pct = 0.5
    volume_ok = abs(occ_volume_err_pct) <= volume_tol_pct
    if not volume_ok:
        log(
            f"ОШИБКА: объём OCC расходится с аналитикой на {occ_volume_err_pct:+.6f} % "
            f"(допуск {volume_tol_pct} %) — это ошибка булевых операций, а не тесселяции; "
            "STL не годится (проверь --strategy: single теряет объём пересечения полостей)"
        )

    export_time = cc.export_stl(
        shape,
        args.out,
        args.tolerance,
        args.angular_tolerance,
        api=args.export_api,
        relative=(args.relative_tolerance != "abs"),
    )
    log(f"экспорт STL: {export_time:.3f} с, размер {os.path.getsize(args.out)} Б")

    result = {
        "name": params.get("name"),
        "kind": kind,
        "params_file": os.path.abspath(args.params_file),
        "params": params,
        "stl": os.path.abspath(args.out),
        "seed": args.seed if args.seed is not None else params.get("seed", 0),
        "tolerance_mm": args.tolerance,
        "angular_tolerance_rad": args.angular_tolerance,
        "export_api": args.export_api,
        "relative_tolerance": args.relative_tolerance,
        "strategy_requested": args.strategy,
        "strategy_used": strategy_used,
        "strategy_times_s": strategy_times,
        "strategy_ocp_volumes_mm3": strategy_volumes,
        "strategy_volume_rel_diff_pct": strategy_volume_rel_diff_pct,
        "geometry_build_time_s": round(geometry_build_time, 6),
        "build_time_s": round(build_time, 6),
        "export_time_s": round(export_time, 6),
        "total_time_s": round(time.perf_counter() - t_start, 6),
        "n_holes": geo.n_holes,
        "expected_bodies": geo.expected_bodies,
        "n_solids_occ": n_solids,
        "occ_volume_mm3": occ_volume,
        "occ_volume_err_pct": round(occ_volume_err_pct, 9),
        "volume_tol_pct": volume_tol_pct,
        "volume_ok": volume_ok,
        "expected_volume_mm3": round(geo.expected_volume, 9),
        "expected_area_mm2": round(geo.expected_area, 9) if geo.expected_area else None,
        "geometry_details": geo.details,
        "cadquery_version": cq.__version__,
        "ocp_version": ocp_version(),
    }

    stl_clean_path = None
    if args.clean_stl:
        stl_clean_path = os.path.splitext(args.out)[0] + "_clean.stl"
        clean_info = clean_stl(args.out, stl_clean_path)
        result["stl_clean"] = os.path.abspath(stl_clean_path)
        result["clean_info"] = clean_info
        log(
            f"чистка STL: {clean_info['triangles_before']} -> {clean_info['triangles_after']} "
            f"треугольников, watertight={clean_info['is_watertight']} -> {stl_clean_path}"
        )

    rc = 0
    if not volume_ok:
        rc = 1
    if args.check:
        qa = qa_stl(args.out, expect_bodies=geo.expected_bodies)
        cl = qa["cleaned"]
        vol_err = (cl["volume"] - geo.expected_volume) / geo.expected_volume * 100.0
        result["qa"] = qa
        result["volume_err_pct"] = round(vol_err, 6)
        result["triangles"] = qa["triangles"]
        result["triangles_clean"] = cl["triangles"]
        result["watertight"] = cl["is_watertight"]
        result["watertight_raw"] = qa["is_watertight"]
        if geo.expected_area:
            result["area_err_pct"] = round(
                (cl["area"] - geo.expected_area) / geo.expected_area * 100.0, 6
            )
        problems = []
        if abs(occ_volume_err_pct) > 1e-6:
            problems.append(
                f"ОБЪЁМ OCC не совпал с аналитикой: {occ_volume_err_pct:+.6f} % "
                "(ошибка булевых операций, а не дискретизации)"
            )
        if not cl["is_watertight"]:
            problems.append("НЕ watertight (даже после удаления вырожденных граней)")
        if not cl["is_winding_consistent"]:
            problems.append("нормали несогласованы")
        if cl["bodies"] != geo.expected_bodies:
            problems.append(
                f"оболочек: {cl['bodies']} (ожидалось {geo.expected_bodies} = "
                "1 + число замкнутых полостей)"
            )
        result["degenerate_faces_occ"] = qa["degenerate_faces"]
        # Вырожденные грани — свойство тесселяции OCC (полюса/швы сфер), а не ошибка
        # булевых операций: объём они не искажают, но ломают is_watertight «сырого» файла.
        # Это предупреждение, а не провал: R9 закрывается либо --clean-stl, либо мешером.
        if qa["degenerate_faces"]:
            result.setdefault("notes", []).append(
                f"вырожденных граней OCC: {qa['degenerate_faces']}; "
                f"is_watertight сырого файла = {qa['is_watertight']} "
                "(для R9 нужен --clean-stl или толерантный мешер)"
            )
        if abs(vol_err) > args.max_volume_err:
            problems.append(
                f"|ΔV|={abs(vol_err):.3f}% > {args.max_volume_err}% "
                f"(V={cl['volume']:.4f}, аналитика={geo.expected_volume:.4f})"
            )
        result["qa_problems"] = problems
        result["qa_verdict"] = "PASS" if not problems else "FAIL"
        log("")
        log("--- QA STL (trimesh) ---")
        log(f"  triangles          : {qa['triangles']} (после чистки {cl['triangles']})")
        log(f"  watertight         : {cl['is_watertight']} (сырой файл: {qa['is_watertight']})")
        log(f"  winding consistent : {cl['is_winding_consistent']}")
        log(f"  euler number       : {cl['euler_number']}")
        log(f"  bodies             : {cl['bodies']} (ожидалось {geo.expected_bodies})")
        log(f"  volume             : {cl['volume']:.6f} мм3")
        log(f"  analytic volume    : {geo.expected_volume:.6f} мм3")
        log(f"  ΔV                 : {vol_err:+.4f} %")
        log(f"  area               : {cl['area']:.6f} мм2")
        if geo.expected_area:
            log(f"  analytic area      : {geo.expected_area:.6f} мм2")
            log(f"  ΔA                 : {result['area_err_pct']:+.4f} %")
        else:
            log("  analytic area      : — (пересекающиеся цилиндры, аналитика не считалась)")
        log(f"  bbox size          : {[round(v, 6) for v in qa['bbox_size']]} мм")
        log(f"  degenerate faces   : {qa['degenerate_faces']}")
        log(f"  QA VERDICT         : {result['qa_verdict']}")
        for p in problems:
            log(f"    - {p}")
        if problems:
            rc = 1

    log("")
    verdict = result.get("qa_verdict") if args.check else ("volume-ok" if volume_ok else "volume-FAIL")
    log(
        f"ИТОГ: {verdict}; build {build_time:.3f} с + export {export_time:.3f} с"
    )

    if args.json_out:
        os.makedirs(os.path.dirname(os.path.abspath(args.json_out)), exist_ok=True)
        with open(args.json_out, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=2)
        log(f"JSON: {args.json_out}")

    return rc


if __name__ == "__main__":
    sys.exit(main())
