#!/usr/bin/env python3
"""tools/deliver/region_layout.py — разбор многорегионального кейса OpenFOAM для поставки.

Что делает (только чтение, ничего не меняет):
  1) находит региональные сетки `<case>/constant/<region>/polyMesh`;
  2) парсит `polyMesh/boundary` каждого региона → таблица патчей (имя, тип, nFaces);
  3) сверяет СМЕЖНОСТЬ ИНТЕРФЕЙСА: для пары регионов (a, b) патчи `a_to_b` и `b_to_a`
     должны существовать оба и иметь одинаковое число граней (это одни и те же грани,
     разрезанные splitMeshRegions); для `mappedWall` дополнительно проверяются
     sampleRegion/samplePatch, если они записаны;
  4) отдаёт JSON (или текст) + код возврата: 0 — всё сходится, 1 — расхождение,
     2 — ошибка входа.

Пример:
  tools/deliver/region_layout.py --case openfoam_x --regions fluid,solid \
      --json delivery/.region_layout_x.json
"""

import argparse
import json
import os
import re
import sys

ENTRY_RE = re.compile(r"^\s*(\S+)\s*\n\s*\{(.*?)\n\s*\}", re.MULTILINE | re.DOTALL)


def parse_boundary(path):
    """Патчи из polyMesh/boundary: список {name,type,nFaces,inGroups,sampleRegion,samplePatch}."""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()
    # отрезать заголовок FoamFile {...}
    m = re.search(r"FoamFile\s*\{.*?\n\}\s*\n", text, re.DOTALL)
    body = text[m.end():] if m else text
    # тело: "<N>\n(\n  <patch> {...}\n)\n"
    patches = []
    for name, block in ENTRY_RE.findall(body):
        name = name.strip().strip('"')
        if name.startswith("(") or name == ")":
            continue
        entry = {"name": name}
        mt = re.search(r"\btype\s+(\S+?);", block)
        if mt:
            entry["type"] = mt.group(1)
        mn = re.search(r"\bnFaces\s+(\d+)\s*;", block)
        if mn:
            entry["nFaces"] = int(mn.group(1))
        mg = re.search(r"\binGroups\s+(\d+)\(([^)]*)\)", block)
        if mg:
            entry["inGroups"] = mg.group(2).split()
        msr = re.search(r"\bsampleRegion\s+(\S+?);", block)
        if msr:
            entry["sampleRegion"] = msr.group(1)
        msp = re.search(r"\bsamplePatch\s+(\S+?);", block)
        if msp:
            entry["samplePatch"] = msp.group(1)
        patches.append(entry)
    return patches


def find_regions(case_root):
    """Регионы = каталоги <root>/constant/<name>/polyMesh (сам polyMesh не считается)."""
    const = os.path.join(case_root, "constant")
    out = []
    if not os.path.isdir(const):
        return out
    for name in sorted(os.listdir(const)):
        pm = os.path.join(const, name, "polyMesh")
        if os.path.isdir(pm) and os.path.isfile(os.path.join(pm, "boundary")):
            out.append(name)
    return out


def main():
    ap = argparse.ArgumentParser(description="Разбор регионального кейса OpenFOAM")
    ap.add_argument("--case", required=True, help="корень дистрибутива/кейса")
    ap.add_argument("--regions", default="", help="через запятую; пусто = все найденные")
    ap.add_argument("--json", default="", help="куда записать JSON")
    ap.add_argument("--quiet", action="store_true", help="не печатать человекочитаемый итог")
    args = ap.parse_args()

    root = os.path.abspath(args.case)
    if not os.path.isdir(root):
        print(f"region_layout: нет каталога {root}", file=sys.stderr)
        return 2

    found = find_regions(root)
    if args.regions:
        regions = [r.strip() for r in args.regions.split(",") if r.strip()]
        missing = [r for r in regions if r not in found]
        if missing:
            print(f"region_layout: нет региональной сетки для {missing} "
                  f"(найдены: {found})", file=sys.stderr)
            return 2
    else:
        regions = found
    if not regions:
        print(f"region_layout: в {root}/constant нет ни одной региональной сетки "
              f"(<region>/polyMesh)", file=sys.stderr)
        return 2

    report = {"case_root": root, "regions_found": found, "regions": {}, "interfaces": [],
              "unpaired_patches": [], "external_patches": [], "ok": True}
    for r in regions:
        pm_dir = os.path.join(root, "constant", r, "polyMesh")
        patches = parse_boundary(os.path.join(pm_dir, "boundary"))
        report["regions"][r] = {
            "poly_mesh": os.path.relpath(pm_dir, root),
            "n_patches": len(patches),
            "patches": patches,
        }

    def patch_by_name(region, name):
        for p in report["regions"][region]["patches"]:
            if p["name"] == name:
                return p
        return None

    # пары интерфейса: ищем патчи вида "<a>_to_<b>", где b — тоже выбранный регион
    seen = set()
    for a in regions:
        for p in report["regions"][a]["patches"]:
            m = re.match(r"^(.+)_to_(.+)$", p["name"])
            if not m:
                continue
            ra, rb = m.group(1), m.group(2)
            if ra != a or rb not in regions:
                continue
            pair = tuple(sorted((a, rb)))
            if pair in seen:
                continue
            seen.add(pair)
            other_name = f"{rb}_to_{a}"
            q = patch_by_name(rb, other_name)
            item = {
                "regions": [a, rb],
                "patch_a": p["name"], "type_a": p.get("type"), "n_faces_a": p.get("nFaces"),
                "patch_b": other_name,
                "type_b": q.get("type") if q else None,
                "n_faces_b": q.get("nFaces") if q else None,
                "exists_both": q is not None,
                "match": bool(q) and p.get("nFaces") == q.get("nFaces"),
                "mapped_ok": None,
            }
            if q and ("sampleRegion" in p or "samplePatch" in p):
                item["mapped_ok"] = (p.get("sampleRegion") == rb and p.get("samplePatch") == other_name
                                     and q.get("sampleRegion") == a
                                     and q.get("samplePatch") == p["name"])
            report["interfaces"].append(item)

    # патчи вида "<r>_to_<other>", у которых партнёр не выбран (--regions подмножество):
    # это не ошибка — интерфейс просто ведёт в регион, который не отгружается;
    # ошибка — когда партнёр ВЫБРАН, а парного патча нет.
    for r in regions:
        for p in report["regions"][r]["patches"]:
            m = re.match(r"^(.+)_to_(.+)$", p["name"])
            if not m:
                continue
            other = m.group(2) if m.group(1) == r else m.group(1)
            if other not in regions:
                report["external_patches"].append({"region": r, "patch": p["name"], "counterpart": other})
            else:
                name = f"{other}_to_{r}"
                if not patch_by_name(other, name):
                    report["unpaired_patches"].append({"region": r, "patch": p["name"],
                                                       "missing": f"{other}/{name}"})

    for it in report["interfaces"]:
        if not (it["exists_both"] and it["match"]):
            report["ok"] = False
        if it["mapped_ok"] is False:
            report["ok"] = False
    if report["unpaired_patches"]:
        report["ok"] = False

    if args.json:
        os.makedirs(os.path.dirname(os.path.abspath(args.json)) or ".", exist_ok=True)
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)

    if not args.quiet:
        print(f"region_layout: регионы {regions}, интерфейсных пар {len(report['interfaces'])}"
              f" → {'OK' if report['ok'] else 'РАСХОЖДЕНИЕ'}")
        for it in report["interfaces"]:
            print(f"   {it['patch_a']}({it['n_faces_a']}) ↔ {it['patch_b']}({it['n_faces_b']})"
                  f" match={it['match']}"
                  + (f" mapped={it['mapped_ok']}" if it['mapped_ok'] is not None else ""))
        for u in report["unpaired_patches"]:
            print(f"   без пары: {u['region']}/{u['patch']} (нет {u['missing']})")
        for u in report.get("external_patches", []):
            print(f"   интерфейс наружу: {u['region']}/{u['patch']} → регион '{u['counterpart']}' "
                  f"не выбран (--regions)")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
