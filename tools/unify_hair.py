"""把四张图的头发统一到同一个色调。

之前每张是各自调的，结果 eating/stuck 偏亮（sat 0.53/0.57），
idle/done 偏暗（0.40/0.36），放在一起像两个角色。

这里做法相反：先定一个目标值，然后让每张图各按自己的差值去靠，
脸、衣服、背景一个像素都不动。

用法：
  python_embeded\\python.exe tools/unify_hair.py
"""

import colorsys
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from grade_hair import build_hair_mask  # noqa: E402

ASSETS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")
STATES = ("idle", "eating", "stuck", "done")

# 目标：四张共用的头发色。亮度略高于 original，饱和度居中。
TARGET_SAT = 0.46
TARGET_LIGHT = 0.40


def measure(im):
    rgb = np.array(im.convert("RGB"))
    m = build_hair_mask(rgb)
    if m.sum() < 50:
        return None
    sel = rgb[m].astype(np.float32) / 255.0
    hs = []
    for px in sel[:: max(1, len(sel) // 2500)]:
        h, l, s = colorsys.rgb_to_hls(*px)
        if l > 0.10:
            hs.append((s, l))
    arr = np.array(hs)
    return float(np.median(arr[:, 0])), float(np.median(arr[:, 1]))


def apply_hsl(im, sat_scale, light_scale):
    rgb = np.array(im.convert("RGB"))
    alpha = im.getchannel("A")
    mask = build_hair_mask(rgb)
    soft = Image.fromarray((mask * 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(0.8))
    m = np.clip((np.array(soft).astype(np.float32) / 255.0) * 1.3, 0, 1)[:, :, None]

    flat = rgb.reshape(-1, 3) / 255.0
    hls = np.array([colorsys.rgb_to_hls(*p) for p in flat])
    hls[:, 1] = np.clip(hls[:, 1] * light_scale, 0, 1)
    hls[:, 2] = np.clip(hls[:, 2] * sat_scale, 0, 1)
    out = np.array([colorsys.hls_to_rgb(*p) for p in hls]) * 255.0

    mixed = flat.reshape(rgb.shape) * 255.0 * (1 - m) + out.reshape(rgb.shape) * m
    res = Image.fromarray(np.clip(mixed, 0, 255).astype(np.uint8), "RGB").convert("RGBA")
    res.putalpha(alpha)
    return res


def solve(im, target_sat=TARGET_SAT, target_light=TARGET_LIGHT):
    """二分不着，直接按比例算，再微调两轮。"""
    cur = measure(im)
    if cur is None:
        return im, None, None
    sat_scale, light_scale = 1.0, 1.0
    work = im
    for _ in range(3):
        s, l = measure(work) or (None, None)
        if s is None:
            break
        sat_scale *= (target_sat / max(s, 1e-3)) ** 0.8
        light_scale *= (target_light / max(l, 1e-3)) ** 0.8
        work = apply_hsl(im, sat_scale, light_scale)
    return work, sat_scale, light_scale


def main():
    for skin in ("blue",):
        for state in STATES:
            path = os.path.join(ASSETS, skin, state + ".png")
            if not os.path.exists(path):
                print("skip", path)
                continue
            im = Image.open(path).convert("RGBA")
            before = measure(im)
            out, ss, ls = solve(im)
            out.save(path, "PNG", optimize=True)
            after = measure(out)
            print(
                "%-6s sat %.2f -> %.2f   light %.2f -> %.2f   (scale %.2f/%.2f)"
                % (state, before[0], after[0], before[1], after[1], ss or 1, ls or 1)
            )


if __name__ == "__main__":
    sys.exit(main())
