#!/usr/bin/env python3
"""Minimal gmsh cube for the `gmsh` route of mesh_build (Appendix D / case V4).

Writes an ASCII MSH 2.2 file with one physical volume "fluid" so that
`gmshToFoam` can import both the cells and the patch. The cube is placed at the
origin in METRES, which matches a scaffolded or hand-prepared OpenFOAM case.

Usage:
    .venv/bin/python benchmark/scripts/gmsh_cube.py \
        --output benchmark/runs/<RUN>/mesh/v4/cube.msh --size 0.003 --extent 0.014

`--size` is the maximum element size (m); `--extent` is the cube edge (m).
"""

from __future__ import annotations

import argparse


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--output", required=True, help="output .msh path")
    ap.add_argument("--size", type=float, default=0.003, help="max element size, m")
    ap.add_argument("--extent", type=float, default=0.014, help="cube edge, m")
    args = ap.parse_args()

    import gmsh

    gmsh.initialize()
    try:
        gmsh.option.setNumber("Mesh.MshFileVersion", 2.2)
        gmsh.model.add("cube")
        gmsh.model.occ.addBox(0.0, 0.0, 0.0, args.extent, args.extent, args.extent)
        gmsh.model.occ.synchronize()

        volumes = [tag for _, tag in gmsh.model.getEntities(3)]
        if not volumes:
            raise SystemExit("no volume was created")
        gmsh.model.addPhysicalGroup(3, volumes, 1, "fluid")

        gmsh.option.setNumber("Mesh.MeshSizeMax", args.size)
        gmsh.option.setNumber("Mesh.MeshSizeMin", args.size / 4.0)
        gmsh.model.mesh.generate(3)
        gmsh.write(args.output)
    finally:
        gmsh.finalize()

    print(f"wrote {args.output} (extent {args.extent} m, size {args.size} m)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
