#!/usr/bin/env python3
"""Backward-compatible entry point: the point picker now ships inside mesh-build.

Canonical implementation: plugins/mesh-build/scripts/fluid-point.py
(mesh-build/scripts/fluid-point.py inside the published bundle). This shim only
forwards argv so older benchmark commands keep working; it adds no logic.
"""
import runpy
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
CANDIDATES = [
    HERE.parents[2] / "plugins" / "mesh-build" / "scripts" / "fluid-point.py",
]
CANONICAL = next((path for path in CANDIDATES if path.is_file()), None)
if CANONICAL is None:
    sys.exit(
        "fluid-point.py not found; expected plugins/mesh-build/scripts/fluid-point.py "
        "next to benchmark/ (canonical script ships with mesh-build)"
    )
runpy.run_path(str(CANONICAL), run_name="__main__")
