# Доставка сетки `demo`

Источник: `/mnt/HDD-2Tb-PC-Danii/Science_Projects/Mesh_3D_pore_scale/.cache/tk/.cache/demo2/case`

Режим: **single-region** (одна сетка `constant/polyMesh`)

## Что отдано

| Артефакт | Путь |
|---|---|
| Кейс OpenFOAM (ParaView) | `openfoam_demo/demo.foam` |
| Архив OpenFOAM | `openfoam_demo.tar.gz` |
| Сетка ANSYS/Fluent | `ansys_demo/demo.msh` |
| Журнал проверки в Fluent | `ansys_demo/read_mesh.jou` |
| Архив ANSYS | `ansys_demo.zip` |

## Сетка

- ячеек **148288**, граничных патчей **2**
- суммарный объём **0.000440003** м³, max non-ortho **26.4119°**
- `checkMesh` в упакованном кейсе: rc=0
- папка `constant/polyMesh` на месте: **True**

## Проверки

- round-trip `.msh` → OpenFOAM через `fluent3DMeshToFoam`: **ok** (cells 148288, patches 2, V 0.000440003, nonOrtho 26.4119°)
- строгий шлюз `mesh_gate --profile project`: **rc=0** (minVol=1e-14)

## Размеры

- `openfoam_demo.tar.gz`: 4.86 МБ
- `ansys_demo.zip`: 5.08 МБ
- `ansys_demo/demo.msh`: 26.19 МБ
