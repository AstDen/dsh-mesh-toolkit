Сетка demo — дистрибутив OpenFOAM
==================================
Просмотр в ParaView:
  paraview /mnt/HDD-2Tb-PC-Danii/Science_Projects/Mesh_3D_pore_scale/.cache/tk/.cache/demo2/deliver/openfoam_demo/demo.foam
  (открывается весь кейс: constant/polyMesh + system/)

Проверка качества:
  source /usr/lib/openfoam/openfoam2512/etc/bashrc
  checkMesh -case /mnt/HDD-2Tb-PC-Danii/Science_Projects/Mesh_3D_pore_scale/.cache/tk/.cache/demo2/deliver/openfoam_demo
  /mnt/HDD-2Tb-PC-Danii/Science_Projects/Mesh_3D_pore_scale/tools/qa/mesh_gate.sh --case /mnt/HDD-2Tb-PC-Danii/Science_Projects/Mesh_3D_pore_scale/.cache/tk/.cache/demo2/deliver/openfoam_demo --profile project

Единицы: координаты в СИ (метры). Исходный STL был в мм.
