#!/usr/bin/env python3
"""gen_cq_porous.py — parametric generator of porous geometry on CadQuery.

Builds a fluid domain = block MINUS cavities (spheres/cylinders), exports a binary STL
in mm and (with the --check flag) runs QA through trimesh.

Analytics (the formula is duplicated in geometry/cad/README.md and in cq_common.py):

    V_fluid = V_domain − Σ V_holes + Σ V_overlaps
    V_domain  = Lx · Ly · Lz
    V_sphere  = 4/3 · π · R³
    V_cyl     = π · R² · h            (h — cylinder length inside the domain)
    V_overlap = 16/3 · R³             (intersection of two perpendicular cylinders of equal R)
    A_fluid   = 2(Lx·Ly + Ly·Lz + Lz·Lx) + Σ A_holes_inside   (spheres fully inside the block)
    A_cyl     = A_box − Σ 2πR² + Σ 2πR·h   (the cylinder pierces two opposite faces)

A faceted STL always gives a volume SMALLER than the analytics (inscribed polyhedron) — this is discretisation,
not a geometry error (env/ENV_REPORT.md §5 item 9).

Examples:
  # plate 10×10×4 mm minus 8 spheres R=1.2 mm, tolerance 0.05
  .venv/bin/python geometry/cad/gen_cq_porous.py \
      --params-file geometry/cad/params/plate_spheres_8.json \
      --out experiments/exp-002-cadquery-stl/stl/case2_tol0.05.stl \
      --tolerance 0.05 --check --json experiments/exp-002-cadquery-stl/logs/case2.json

  # channel with intersecting cylinders
  .venv/bin/python geometry/cad/gen_cq_porous.py \
      --params-file geometry/cad/params/channel_cylinders.json \
      --out experiments/exp-002-cadquery-stl/stl/case6.stl --check

Return codes: 0 — success (and QA passed, if --check), 1 — QA failed, 2 — input error.
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
        expected_bodies=1 + n,  # outer shell + one per closed sphere
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
            raise ValueError(f"cylinder #{idx}: axis {axis} needs the coordinates {p1} and {p2}")
        a, b = float(cyl[p1]), float(cyl[p2])
        # check that the cylinder itself is inside the domain along the transverse axes
        for val, name in ((a, p1), (b, p2)):
            if val - r < -1e-6 or val + r > sizes[name] + 1e-6:
                raise ValueError(
                    f"cylinder #{idx} goes beyond the face {name}: center {val}, R={r}, "
                    f"domain {sizes[name]}"
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

    # the area is computed analytically only when the cylinders do not intersect each other
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
        expected_bodies=1,  # through cylinders open cavities on the faces -> one shell
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
        description="Porous geometry generator on CadQuery: block minus spheres/cylinders → STL (mm).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument("--params-file", required=True, help="JSON with the geometry parameters")
    ap.add_argument("--out", required=True, help="where to write the STL")
    ap.add_argument("--tolerance", type=float, default=0.05, help="STL export tolerance, mm")
    ap.add_argument(
        "--angular-tolerance",
        type=float,
        default=0.1,
        help="STL export angularTolerance, rad",
    )
    ap.add_argument(
        "--strategy",
        choices=["single", "sequential", "fused", "both"],
        default="sequential",
        help="boolean subtraction strategy: sequential (default, correct for intersecting "
        "cavities), single = one operation with a compound (loses the intersection volume), "
        "fused = fuse the cavities + one cut, both = compare single and sequential by volume",
    )
    ap.add_argument(
        "--lattice",
        default=None,
        help="override the sphere lattice 'nx,ny,nz' (only for kind=lattice_spheres)",
    )
    ap.add_argument("--seed", type=int, default=None, help="seed (irrelevant for these cases)")
    ap.add_argument("--check", action="store_true", help="run STL QA through trimesh")
    ap.add_argument("--json", dest="json_out", default=None, help="where to write the JSON report")
    ap.add_argument(
        "--max-volume-err", type=float, default=2.0, help="tolerance |ΔV| to the analytics, %%"
    )
    ap.add_argument(
        "--export-api",
        choices=["exporters", "exportStl"],
        default="exporters",
        help="exporters = cq.exporters.export (always relative tolerance); "
        "exportStl = direct Shape.exportStl (supports absolute tolerance)",
    )
    ap.add_argument(
        "--relative-tolerance",
        choices=["default", "abs"],
        default="default",
        help="for --export-api exportStl: default = relative=True (like exporters), "
        "abs = relative=False (absolute tolerance in mm)",
    )
    ap.add_argument(
        "--clean-stl",
        action="store_true",
        help="write a cleaned STL <name>_clean.stl alongside (without OCC degenerate faces)",
    )
    args = ap.parse_args(argv)

    try:
        with open(args.params_file, encoding="utf-8") as fh:
            params = json.load(fh)
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR reading {args.params_file}: {exc}", file=sys.stderr)
        return 2

    kind = params.get("kind")
    if kind not in BUILDERS:
        print(f"ERROR: unknown kind={kind!r}, available {sorted(BUILDERS)}", file=sys.stderr)
        return 2

    if args.lattice:
        try:
            lat = [int(v) for v in args.lattice.replace("x", ",").split(",")]
            assert len(lat) == 3 and all(v > 0 for v in lat)
        except Exception:  # noqa: BLE001
            print(f"ERROR: --lattice={args.lattice!r}, 'nx,ny,nz' required", file=sys.stderr)
            return 2
        if kind != "lattice_spheres":
            print("ERROR: --lattice applies only to kind=lattice_spheres", file=sys.stderr)
            return 2
        params["lattice"] = lat
        params["lattice_override"] = args.lattice

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)

    log("=" * 70)
    log(f"gen_cq_porous.py: {params.get('name', os.path.basename(args.params_file))}")
    log(f"  cadquery {cq.__version__}, OCP {ocp_version()}, python {sys.version.split()[0]}")
    log(f"  kind={kind}, tolerance={args.tolerance} mm, angularTolerance={args.angular_tolerance} rad")
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
            # Found in exp-002 on case6: if the CAVITIES INTERSECT each other,
            # one Cut with a compound subtracts the common regions twice and loses volume
            # (single=359.6177 vs sequential=367.8097 mm3 with analytics 367.8097).
            # Therefore, on a mismatch we export the sequential result.
            log(
                "WARNING: the strategies gave a different OCC volume: "
                f"single={v_single:.9f}, sequential={v_seq:.9f} "
                f"({strategy_volume_rel_diff_pct:.3e} %) — taking sequential "
                "(intersecting cavities: the compound Cut loses volume)"
            )
            strategy_used = "sequential"
            shape = shape_seq
            build_time = t_seq
        else:
            strategy_used = "single"
            build_time = t_single
        log(
            f"strategy single: {t_single:.3f} s, sequential: {t_seq:.3f} s, "
            f"ΔV(strategies)={strategy_volume_rel_diff_pct:.3e} %"
        )
    else:
        try:
            shape, build_time = _cut(args.strategy)
        except Exception as exc:  # noqa: BLE001
            log(
                f"WARNING: strategy {args.strategy} failed "
                f"({type(exc).__name__}: {exc}); falling back to sequential"
            )
            shape, build_time = _cut("sequential")
            strategy_used = "sequential"

    n_solids = len(shape.Solids())
    occ_volume = float(shape.Volume())
    occ_volume_err_pct = (occ_volume - geo.expected_volume) / geo.expected_volume * 100.0
    log(
        f"geometry: {geometry_build_time:.3f} s; boolean operations ({strategy_used}): "
        f"{build_time:.3f} s; solids: {n_solids}"
    )
    log(
        f"OCC volume (exact): {occ_volume:.9f} mm3; analytics {geo.expected_volume:.9f} mm3; "
        f"ΔV_occ={occ_volume_err_pct:+.6f} %"
    )
    # A boolean operation error is visible ONLY here (tessellation gives <0.1 %): the gate always runs,
    # regardless of --check, otherwise the generator returns broken geometry with rc=0.
    volume_tol_pct = 0.5
    volume_ok = abs(occ_volume_err_pct) <= volume_tol_pct
    if not volume_ok:
        log(
            f"ERROR: the OCC volume deviates from the analytics by {occ_volume_err_pct:+.6f} % "
            f"(tolerance {volume_tol_pct} %) — this is a boolean operation error, not tessellation; "
            "STL is unusable (check --strategy: single loses the intersection volume of cavities)"
        )

    export_time = cc.export_stl(
        shape,
        args.out,
        args.tolerance,
        args.angular_tolerance,
        api=args.export_api,
        relative=(args.relative_tolerance != "abs"),
    )
    log(f"STL export: {export_time:.3f} s, size {os.path.getsize(args.out)} B")

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
            f"STL cleanup: {clean_info['triangles_before']} -> {clean_info['triangles_after']} "
            f"triangles, watertight={clean_info['is_watertight']} -> {stl_clean_path}"
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
                f"OCC VOLUME did not match the analytics: {occ_volume_err_pct:+.6f} % "
                "(a boolean operation error, not discretisation)"
            )
        if not cl["is_watertight"]:
            problems.append("NOT watertight (even after removing degenerate faces)")
        if not cl["is_winding_consistent"]:
            problems.append("the winding is inconsistent")
        if cl["bodies"] != geo.expected_bodies:
            problems.append(
                f"shells: {cl['bodies']} (expected {geo.expected_bodies} = "
                "1 + the number of closed cavities)"
            )
        result["degenerate_faces_occ"] = qa["degenerate_faces"]
        # Degenerate faces are a property of OCC tessellation (sphere poles/seams), not a
        # boolean operation error: they do not distort the volume but break is_watertight of the «raw» file.
        # This is a warning, not a failure: R9 is closed either by --clean-stl or by the mesher.
        if qa["degenerate_faces"]:
            result.setdefault("notes", []).append(
                f"OCC degenerate faces: {qa['degenerate_faces']}; "
                f"is_watertight of the raw file = {qa['is_watertight']} "
                "(R9 needs --clean-stl or a tolerant mesher)"
            )
        if abs(vol_err) > args.max_volume_err:
            problems.append(
                f"|ΔV|={abs(vol_err):.3f}% > {args.max_volume_err}% "
                f"(V={cl['volume']:.4f}, analytics={geo.expected_volume:.4f})"
            )
        result["qa_problems"] = problems
        result["qa_verdict"] = "PASS" if not problems else "FAIL"
        log("")
        log("--- QA STL (trimesh) ---")
        log(f"  triangles          : {qa['triangles']} (after cleanup {cl['triangles']})")
        log(f"  watertight         : {cl['is_watertight']} (raw file: {qa['is_watertight']})")
        log(f"  winding consistent : {cl['is_winding_consistent']}")
        log(f"  euler number       : {cl['euler_number']}")
        log(f"  bodies             : {cl['bodies']} (expected {geo.expected_bodies})")
        log(f"  volume             : {cl['volume']:.6f} mm3")
        log(f"  analytic volume    : {geo.expected_volume:.6f} mm3")
        log(f"  ΔV                 : {vol_err:+.4f} %")
        log(f"  area               : {cl['area']:.6f} mm2")
        if geo.expected_area:
            log(f"  analytic area      : {geo.expected_area:.6f} mm2")
            log(f"  ΔA                 : {result['area_err_pct']:+.4f} %")
        else:
            log("  analytic area      : — (intersecting cylinders, the analytics was not computed)")
        log(f"  bbox size          : {[round(v, 6) for v in qa['bbox_size']]} mm")
        log(f"  degenerate faces   : {qa['degenerate_faces']}")
        log(f"  QA VERDICT         : {result['qa_verdict']}")
        for p in problems:
            log(f"    - {p}")
        if problems:
            rc = 1

    log("")
    verdict = result.get("qa_verdict") if args.check else ("volume-ok" if volume_ok else "volume-FAIL")
    log(
        f"RESULT: {verdict}; build {build_time:.3f} s + export {export_time:.3f} s"
    )

    if args.json_out:
        os.makedirs(os.path.dirname(os.path.abspath(args.json_out)), exist_ok=True)
        with open(args.json_out, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=2)
        log(f"JSON: {args.json_out}")

    return rc


if __name__ == "__main__":
    sys.exit(main())
