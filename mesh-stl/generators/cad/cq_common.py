#!/usr/bin/env python3
"""cq_common.py — общие кирпичики CadQuery-генераторов проекта Mesh_3D_pore_scale.

Зачем отдельный модуль: аналитические формулы объёма/площади и примитивы должны быть
в ОДНОМ месте, чтобы генератор, QA и README не расходились.

Аналитика (та же формула — в geometry/cad/README.md и в gen_cq_porous.py):

    V_fluid = V_domain − Σ V_holes + Σ V_overlaps
    V_domain  = Lx · Ly · Lz
    V_sphere  = 4/3 · π · R³
    V_cyl     = π · R² · h            (h — длина цилиндра ВНУТРИ домена)
    V_overlap = 16/3 · R³             (пересечение двух перпендикулярных цилиндров равного R,
                                       когда их оси скрещиваются; для остальных случаев — 0,
                                       и генератор предупреждает, что аналитика приблизительна)
    A_fluid   = A_domain + Σ A_holes_inside,  A_domain = 2(Lx·Ly + Ly·Lz + Lz·Lx)
    A_sphere  = 4πR²
    A_cyl (пробивает две противоположные грани) = 2πR·h − 2πR²   (в вклад в A_domain)

Фасетная поверхность всегда даёт объём меньше аналитики (вписанный многогранник) — это
дискретизация STL, а не ошибка геометрии (env/ENV_REPORT.md §5 п.9).
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
# Аналитика
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
    """Объём пересечения двух перпендикулярных цилиндров равного радиуса R.

    Классический результат: 16/3 · R³ (равен объёму «штрафа» за перпендикулярное
    пересечение двух круговых цилиндров; проверяется численно в exp-002 по объёму STL).
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
    # число замкнутых оболочек в STL: 1 + число замкнутых полостей.
    # Полости, открытые на грани домена (сквозные цилиндры), оболочек не добавляют.
    expected_bodies: int = 1


# ---------------------------------------------------------------------------
# Примитивы
# ---------------------------------------------------------------------------
def make_block(lx: float, ly: float, lz: float) -> cq.Workplane:
    """Блок, угол (0,0,0) — в начале координат, габарит Lx×Ly×Lz (мм)."""
    return cq.Workplane("XY").box(lx, ly, lz, centered=(False, False, False))


def make_sphere(r: float, center: Sequence[float]) -> cq.Solid:
    """Полная сфера радиуса r с центром center.

    ВНИМАНИЕ (проверено в exp-002): у `cq.Solid.makeSphere` значения по умолчанию для
    углов дают ПОЛУсферу (объём 2/3·πR³, z от центра вверх, а не шар) — молчаливая
    ловушка. Полный шар получается только с явными angleDegrees1=-90, angleDegrees2=90.
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
    """Цилиндр вдоль axis='x'|'y'|'z', ось проходит через (center_a, center_b) в
    поперечных координатах. Длина — length + 2·extend, удлинение нужно, чтобы
    вычитание насквозь не оставляло нулевой толщины на гранях блока (булевы
    операции с совпадающими гранями — источник артефактов OCC)."""
    ax = axis.lower()
    if ax not in AXES:
        raise ValueError(f"axis={axis!r}, допустимо {sorted(AXES)}")
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
    """Центры простой кубической упаковки: ячейка домена делится на nx×ny×nz,
    центр каждой ячейки — центр сферы. Детерминированно, без seed."""
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
# Проверки геометрии ДО булевых операций (дешевле, чем ловить артефакты потом)
# ---------------------------------------------------------------------------
def check_spheres_inside(
    centers: Iterable[Sequence[float]], r: float, domain: Sequence[float], tol: float = 1e-9
) -> None:
    """Сфера должна быть строго внутри домена: касание грани даёт вырожденные
    булевы операции и «нулевой толщины» перемычки в STL."""
    lx, ly, lz = domain
    for i, c in enumerate(centers):
        for val, size, name in ((c[0], lx, "x"), (c[1], ly, "y"), (c[2], lz, "z")):
            if val - r < -tol or val + r > size + tol:
                raise ValueError(
                    f"сфера #{i} центр {tuple(round(v, 6) for v in c)} R={r} "
                    f"выходит за {name}: [{val - r:.6g}, {val + r:.6g}] vs домен [0, {size}]"
                )


def check_crossing_cylinders(cyls: list[dict], domain: Sequence[float]) -> float:
    """Проверить пересечения цилиндров и вернуть суммарный объём пересечений.

    Аналитика выведена только для пары ПЕРПЕНДИКУЛЯРНЫХ цилиндров равного радиуса,
    оси которых пересекаются: объём пересечения = 16/3·R³ (тело Штейнмеца,
    двуцилиндр). Для остальных случаев (перпендикулярные со смещением осей,
    параллельные перекрывающиеся, разные радиусы) объём пересечения зависит от
    расстояния между осями и простой формулы нет — бросаем ValueError, чтобы
    пользователь разнёс полости или явно сменил геометрию.
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
                        f"параллельные цилиндры #{i} и #{j} перекрываются (d={d:.6g} < "
                        f"R1+R2={r_sum:.6g}); аналитика объёма не выведена — разнесите их"
                    )
                continue
            if d > r_sum + 1e-9:
                continue  # не пересекаются
            if abs(c1["radius"] - c2["radius"]) > 1e-9:
                raise ValueError(
                    f"цилиндры #{i} и #{j} пересекаются при разных радиусах "
                    f"({c1['radius']} vs {c2['radius']}) — аналитика не выведена"
                )
            if d > 1e-9:
                raise ValueError(
                    f"оси цилиндров #{i} и #{j} перпендикулярны, но смещены на d={d:.6g} "
                    f"(< R1+R2={r_sum:.6g}); объём пересечения зависит от d — аналитика "
                    "не выведена, разнесите цилиндры хотя бы на R1+R2"
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
    """Кратчайшее расстояние между прямыми (p1 + s·d1) и (p2 + t·d2)."""
    n = _cross(d1, d2)
    n_len = math.sqrt(sum(v * v for v in n))
    diff = [p2[i] - p1[i] for i in range(3)]
    if n_len < 1e-12:
        # параллельные прямые: расстояние = |diff × d1| / |d1|
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
# Булевы операции и экспорт
# ---------------------------------------------------------------------------
def cut_tools(
    base: cq.Workplane | cq.Shape,
    tools: Sequence[cq.Workplane | cq.Shape],
    strategy: str = "sequential",
) -> cq.Shape:
    """Вычитание полостей из блока.

    strategy="sequential" (по умолчанию) — по одному cut на полость: медленнее,
        но единственная стратегия, верная для ПЕРЕСЕКАЮЩИХСЯ полостей;
    strategy="single"     — один BRepAlgoAPI_Cut с компаундом полостей: быстрее,
        НО для пересекающихся полостей OCC теряет объём пересечения. Проверено
        2026-11-23 (блок 12x6x6, два цилиндра R=0.8, min-тест): компаунд дал
        407.872568 мм3 там, где sequential даёт 410.603235 мм3. Поэтому по
        умолчанию single НЕ используется;
    strategy="fused"      — фьюз полостей, затем один cut: верно и для
        пересекающихся полостей, обычно дороже sequential.

    Инвариант: объём результата = V_block − V_union(полостей). Проверять всегда
    (gen_cq_porous.py сравнивает occ_volume с аналитикой и падает при > 0.5 %).
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

    raise ValueError(f"strategy={strategy!r}, допустимо 'single'|'sequential'|'fused'")


def export_stl(
    shape: cq.Shape,
    path: str,
    tolerance: float,
    angular_tolerance: float,
    api: str = "exporters",
    relative: bool = True,
) -> float:
    """Экспорт бинарного STL (мм); возвращает время экспорта, с.

    api="exporters"  — `cq.exporters.export(...)`. ВНИМАНИЕ (проверено в exp-002):
                       этот путь всегда вызывает `Shape.exportStl(..., relative=True)`,
                       т.е. tolerance масштабируется размером грани и НЕ является
                       абсолютным допуском в мм;
    api="exportStl"  — прямой `Shape.exportStl(path, tolerance, angTol, ascii=False,
                       relative=relative)`: при relative=False получается АБСОЛЮТНЫЙ
                       допуск в мм (сопоставимо с gmsh/другими мешерами).

    tolerance — максимальное отклонение хорды от истинной поверхности (мм при relative=False);
    angularTolerance — максимальный угол между нормалями соседних треугольников, рад.
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
        raise ValueError(f"api={api!r}, допустимо 'exporters'|'exportStl'")
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
