#!/usr/bin/env python3
"""Render README media from an STL: a clipped view rotated frame by frame.

Run with ParaView's pvpython (headless):

    pvpython --force-offscreen-rendering scripts/make-media.py \
        --input demo.stl --out-dir docs/img/frames --frames 16

Each frame clips the surface at --cut of the Z range (so the interior cavity is
visible) and rotates the camera; assemble the frames into a GIF with
`scripts/make-media.sh`. Nothing here is needed to use the toolkit: the images
in docs/img are committed build artefacts, and this script documents how they
were produced (ParaView 6.2.1, offscreen EGL).
"""

import argparse
import math
import os

from paraview.simple import (
    Clip,
    CreateView,
    GetActiveViewOrCreate,
    GetDisplayProperties,
    OpenDataFile,
    Render,
    ResetCamera,
    SaveScreenshot,
    Show,
)


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="STL file to render")
    parser.add_argument("--out-dir", required=True, help="directory for the PNG frames")
    parser.add_argument("--frames", type=int, default=16, help="number of frames (default 16)")
    parser.add_argument("--cut", type=float, default=0.5, help="clip plane position in Z, 0..1")
    parser.add_argument("--res", default="900x560", help="frame size WxH (default 900x560)")
    parser.add_argument("--elevation", type=float, default=22.0, help="camera elevation in degrees")
    parser.add_argument("--prefix", default="frame", help="frame file prefix")
    return parser.parse_args()


def main():
    args = parse_args()
    width, height = (int(value) for value in args.res.lower().split("x"))
    os.makedirs(args.out_dir, exist_ok=True)

    reader = OpenDataFile(args.input)
    reader.UpdatePipeline()
    bounds = reader.GetDataInformation().GetBounds()
    xmin, xmax, ymin, ymax, zmin, zmax = bounds
    center = [(xmin + xmax) / 2, (ymin + ymax) / 2, (zmin + zmax) / 2]

    clip = Clip(Input=reader)
    clip.ClipType = "Plane"
    clip.ClipType.Origin = [center[0], center[1], zmin + args.cut * (zmax - zmin)]
    clip.ClipType.Normal = [0.0, 0.0, 1.0]

    view = GetActiveViewOrCreate("RenderView")
    view.ViewSize = [width, height]
    # ParaView 6.x: the dark color palette otherwise overrides the background.
    for name, value in (
        ("UseColorPaletteForBackground", 0),
        ("Backgroundmode", "Single Color"),
        ("Background", [1.0, 1.0, 1.0]),
        ("Background2", [1.0, 1.0, 1.0]),
    ):
        try:
            setattr(view, name, value)
        except Exception:  # noqa: BLE001 — property names differ between ParaView builds
            pass
    view.OrientationAxesVisibility = 0

    Show(clip, view)
    props = GetDisplayProperties(clip, view)
    props.Representation = "Surface With Edges"
    props.EdgeColor = [0.15, 0.15, 0.15]
    props.LineWidth = 1.0
    props.DiffuseColor = [0.62, 0.66, 0.72]

    ResetCamera(view)
    radius = max(xmax - xmin, ymax - ymin, zmax - zmin) * 3.1
    elevation = math.radians(args.elevation)
    frames = max(1, args.frames)
    for index in range(frames):
        azimuth = 2.0 * math.pi * index / frames
        view.CameraFocalPoint = center
        view.CameraPosition = [
            center[0] + radius * math.cos(elevation) * math.cos(azimuth),
            center[1] + radius * math.cos(elevation) * math.sin(azimuth),
            center[2] + radius * math.sin(elevation),
        ]
        view.CameraViewUp = [0.0, 0.0, 1.0]
        Render(view)
        path = os.path.join(args.out_dir, "%s%02d.png" % (args.prefix, index))
        SaveScreenshot(path, view, ImageResolution=[width, height])
        print("frame %02d/%02d %s" % (index + 1, frames, path), flush=True)


if __name__ == "__main__":
    main()
