#!/usr/bin/env python3
"""gen_packing_table.py — генератор таблицы шаров (упаковка) для STL-билдера.

Алгоритм и модель — в `packing_lib.py` (гравитационная засыпка с устойчивыми
положениями, опциональная компакция). Здесь только CLI и отчёт.

CLI:
    python gen_packing_table.py --params-file params/packing_box_mono.json \
        --out tables/packing_box_mono.csv \
        --contacts-out tables/packing_box_mono_contacts.csv \
        --json logs/packing_box_mono.json [--seed N] [--check] \
        [--preview-stl tables/packing_box_mono_preview.stl]

Выход:
    * `--out`           таблица шаров: id,x_mm,y_mm,z_mm,r_mm
    * `--contacts-out`  контакты:      i,j,dist_mm,gap_mm (по ним ставятся шейки)
    * `--json`          сводка: плотность, пористость, координационные числа и т.п.
    * `--preview-stl`   шары как STL (только для просмотра в ParaView)

Exit code: 0 — успех и (при `--check`) независимая проверка пройдена; 1 — провал.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from packing_lib import (  # noqa: E402
    Packing,
    RadiusSampler,
    check_packing,
    make_container,
    read_table,
    shrink_spec,
    write_contacts,
    write_preview_stl,
    write_summary,
    write_table,
)

DEFAULTS = {
    "seed": 1,
    "max_spheres": 20000,
    "stop_after_fail": 200,
    "overlap_tol_mm": 1e-9,
    "contact_tol_mm": 1e-6,
    "gap_policy": "uniform",
    "gap_mm": 0.0,
    "gap_rel": 0.0,
    "wall_gap_mm": 0.0,
    "step0_frac": 0.5,
    "min_step_frac": 1e-3,
    "slope_min": 0.02,
    "max_settle_iters": 5000,
    "stall_limit": 60,
    "fill_cycles": 1,
    "compaction_cycles": 0,
    "compaction_shake_frac": 0.02,
    "compaction_sweeps": 200,
    "compaction_tol_mm": 1e-9,
    "preview_subdivisions": 1,
}


def load_params(path: str | None, overrides: dict) -> dict:
    p = dict(DEFAULTS)
    if path:
        with Path(path).open(encoding="utf-8") as f:
            raw = json.load(f)
        if not isinstance(raw, dict):
            raise ValueError(f"{path}: ожидается JSON-объект")
        p.update(raw)
    for k, v in overrides.items():
        if v is not None:
            p[k] = v
    for req in ("container", "radii"):
        if req not in p:
            raise ValueError(f"в параметрах нет обязательного ключа {req!r}")
    return p


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Гравитационная засыпка шаров → таблица центров и радиусов")
    ap.add_argument("--params-file", help="JSON с параметрами (container, radii, packing, seed)")
    ap.add_argument("--out", required=True, help="путь к CSV-таблице шаров")
    ap.add_argument("--contacts-out", help="путь к CSV-таблице контактов (для шеек в STL)")
    ap.add_argument("--json", dest="json_out", help="путь к JSON-сводке")
    ap.add_argument("--preview-stl", help="записать STL из шаров (для визуальной проверки)")
    ap.add_argument("--seed", type=int, help="переопределить seed")
    ap.add_argument("--max-spheres", type=int, help="переопределить max_spheres")
    ap.add_argument("--compaction-cycles", type=int, help="переопределить compaction_cycles")
    ap.add_argument("--fill-cycles", type=int,
                    help="сколько раз «засыпать + компактировать» (нужно >1 для роста плотности)")
    ap.add_argument("--check", action="store_true", help="независимая проверка результата")
    args = ap.parse_args(argv)

    t_start = time.perf_counter()
    params = load_params(args.params_file, {
        "seed": args.seed,
        "max_spheres": args.max_spheres,
        "compaction_cycles": args.compaction_cycles,
        "fill_cycles": args.fill_cycles,
    })

    container_domain = make_container(params["container"])
    wall_gap = float(params["wall_gap_mm"])
    # шар не должен касаться стенки/дна/потолка в ноль: засыпаем в сжатый контейнер
    container = make_container(shrink_spec(params["container"], wall_gap))
    sampler = RadiusSampler(params["radii"])
    pack = Packing(
        container,
        sampler,
        seed=int(params["seed"]),
        max_spheres=int(params["max_spheres"]),
        overlap_tol=float(params["overlap_tol_mm"]),
        contact_tol=float(params["contact_tol_mm"]),
        gap_policy=str(params["gap_policy"]),
        gap_mm=float(params["gap_mm"]),
        gap_rel=float(params["gap_rel"]),
        step0_frac=float(params["step0_frac"]),
        min_step_frac=float(params["min_step_frac"]),
        slope_min=float(params["slope_min"]),
        max_settle_iters=int(params["max_settle_iters"]),
        stall_limit=int(params["stall_limit"]),
        log=print,
    )

    print(f"[pack] контейнер: {container_domain.describe()}")
    if wall_gap > 0.0:
        print(f"[pack] зазор шар-стенка {wall_gap} мм -> контейнер засыпки: {container.describe()}")
    print(f"[pack] радиусы:   {sampler.describe()}")
    print(f"[pack] seed={params['seed']} max_spheres={params['max_spheres']} "
          f"gap={params['gap_policy']}:{params['gap_mm']}мм/rel={params['gap_rel']} "
          f"fill_cycles={params['fill_cycles']} compaction_cycles={params['compaction_cycles']}")

    fill_cycles = max(1, int(params["fill_cycles"]))
    compaction_cycles = int(params["compaction_cycles"])
    history: list[dict] = []
    phi_fill0 = 0.0
    compaction_all: list[dict] = []
    for cyc in range(fill_cycles):
        t0 = time.perf_counter()
        n_cycle = pack.run(stop_after_fail=int(params["stop_after_fail"]))
        t_fill = time.perf_counter() - t0
        phi_cycle = pack.packing_fraction()
        if cyc == 0:
            phi_fill0 = phi_cycle
        print(f"[pack] засыпка {cyc + 1}/{fill_cycles}: N={n_cycle} phi={phi_cycle:.4f} "
              f"за {t_fill:.2f} с (средн. {pack.t_place / max(n_cycle, 1) * 1000:.1f} мс/шар, "
              f"итераций спуска в среднем "
              f"{pack.stats['settle_iters_total'] / max(pack.stats['place_attempts'], 1):.1f})")
        history.append({"cycle": cyc + 1, "n_spheres": n_cycle,
                        "phi": phi_cycle, "time_s": t_fill})
        if compaction_cycles > 0 and cyc < fill_cycles - 1:
            info = pack.compact(
                cycles=compaction_cycles,
                shake_frac=float(params["compaction_shake_frac"]),
                sweeps=int(params["compaction_sweeps"]),
                tol=float(params["compaction_tol_mm"]),
            )
            info["cycle"] = cyc + 1
            compaction_all.append(info)
            print(f"[pack]   компакция после цикла {cyc + 1}: z_top "
                  f"{info['z_top_before_mm']:.3f} -> {info['z_top_after_mm']:.3f}, "
                  f"перекрытие {info['max_overlap_after_mm']:.2e} мм, "
                  f"свипов до сходимости {info['sweeps_used_max']}")
    phi_before, phi_after = phi_fill0, pack.packing_fraction()
    print(f"[pack] плотность: {phi_before:.4f} (после первой засыпки) -> {phi_after:.4f} "
          f"(итог, пористость {1 - phi_after:.4f})")
    compaction = None
    if compaction_all:
        compaction = {"cycles_total": compaction_cycles * len(compaction_all),
                      "per_fill_cycle": compaction_all,
                      "max_overlap_after_mm": pack.max_overlap(),
                      "phi_before": phi_before, "phi_after": phi_after}

    p = pack.p[: pack.n].copy()
    r = pack.r[: pack.n].copy()

    table_path = write_table(args.out, p, r)
    print(f"[pack] таблица: {table_path} ({len(r)} строк)")

    contacts = pack.contacts_table()
    if args.contacts_out:
        cpath = write_contacts(args.contacts_out, contacts)
        print(f"[pack] контакты: {cpath} ({len(contacts)} пар, "
              f"макс. |gap| = {max((abs(c['gap_mm']) for c in contacts), default=0.0):.2e} мм)")

    summary = pack.summary(compaction=compaction)
    summary["container"] = container_domain.describe()
    summary["container_packing"] = container.describe()
    summary["wall_gap_mm"] = wall_gap
    summary["time_s"]["fill"] = sum(h["time_s"] for h in history)
    summary["time_s"]["total"] = time.perf_counter() - t_start
    summary["params"] = params
    summary["fill_history"] = history

    if args.preview_stl:
        t0 = time.perf_counter()
        write_preview_stl(args.preview_stl, p, r, subdivisions=int(params["preview_subdivisions"]))
        summary["preview_stl"] = {"path": str(args.preview_stl),
                                  "time_s": time.perf_counter() - t0}
        print(f"[pack] превью-STL: {args.preview_stl} ({summary['preview_stl']['time_s']:.1f} с)")

    if args.json_out:
        write_summary(args.json_out, summary)
        print(f"[pack] сводка: {args.json_out}")

    print(f"[pack] N={len(r)}  phi={summary['packing_fraction']:.4f}  "
          f"пористость={summary['porosity']:.4f}  контактов={summary['n_contacts']}  "
          f"<Z_sphere>={summary['coordination_sphere_mean']:.2f}  "
          f"max_overlap={summary['max_overlap_mm']:.2e} мм  "
          f"время={summary['time_s']['total']:.2f} с")

    rc = 0
    if args.check:
        p_back, r_back = read_table(table_path)
        if len(r_back) != len(r) or not np.allclose(p_back, p, atol=1e-9) or not np.allclose(r_back, r, atol=1e-12):
            print("[check] FAIL: прочитанная таблица не совпадает с результатом", file=sys.stderr)
            return 1
        verdict = check_packing(p, r, container,
                               overlap_tol=max(float(params["overlap_tol_mm"]), 1e-9),
                               contact_tol=float(params["contact_tol_mm"]),
                               gap_policy=str(params["gap_policy"]),
                               gap_mm=float(params["gap_mm"]),
                               gap_rel=float(params["gap_rel"]))
        print(f"[check] {'PASS' if verdict['ok'] else 'FAIL'}: {json.dumps(verdict, ensure_ascii=False)}")
        if not verdict["ok"]:
            rc = 1
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
