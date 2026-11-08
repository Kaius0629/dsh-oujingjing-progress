"""用同一 seed 重新出的四张，走一遍 cut + 发色拉齐，先落到临时目录看效果。

不覆盖 assets/blue/ —— 确认好看再手动换。

源图放在 docs/raw/（被 gitignore，不进仓库）。

用法：
  python_embeded\\python.exe tools/preview_blue.py [源目录]
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image

from cut_states import cut
from grade_hair import build_hair_mask

import numpy as np
import colorsys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)

# 同 seed 出的四张
JOBS = [
    ("eating", "char_00035_.png"),
    ("idle", "char_00040_.png"),
    ("stuck", "char_00041_.png"),
    ("done", "char_00042_.png"),
]


def boost_hair(im, sat_mul):
    """只提高头发像素的饱和度 —— 和 rebuild_blue.py 里同一套做法。"""
    if abs(sat_mul - 1.0) < 1e-3:
        return im
    from PIL import ImageFilter

    rgb = np.array(im.convert("RGB"))
    alpha = im.getchannel("A")
    mask = build_hair_mask(rgb)
    soft = Image.fromarray((mask * 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(0.8))
    m = np.clip((np.array(soft).astype(np.float32) / 255.0) * 1.3, 0, 1)[:, :, None]

    flat = rgb.reshape(-1, 3) / 255.0
    hls = np.array([colorsys.rgb_to_hls(*p) for p in flat])
    hls[:, 2] = np.clip(hls[:, 2] * sat_mul, 0, 1)
    out = np.array([colorsys.hls_to_rgb(*p) for p in hls]) * 255.0
    mixed = flat.reshape(rgb.shape) * 255.0 * (1 - m) + out.reshape(rgb.shape) * m
    res = Image.fromarray(np.clip(mixed, 0, 255).astype(np.uint8), "RGB").convert("RGBA")
    res.putalpha(alpha)
    return res


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(_ROOT, "docs", "raw")
    dst = os.path.join(os.environ.get("TEMP", "."), "ojj_preview_blue")
    os.makedirs(dst, exist_ok=True)

    for state, fn in JOBS:
        base = os.path.join(src, fn)
        if not os.path.exists(base):
            print("MISSING", base)
            continue
        tmp = os.path.join(dst, "_tmp_" + state + ".png")
        cut(base, tmp, saturation=0.62, brightness=1.03)
        im = Image.open(tmp).convert("RGBA")
        im = boost_hair(im, 1.50)
        out = os.path.join(dst, state + ".png")
        im.save(out, "PNG", optimize=True)
        os.remove(tmp)
        print("%-7s <- %-16s %5d B" % (state, fn, os.path.getsize(out)))

    print("输出目录:", dst)


if __name__ == "__main__":
    sys.exit(main())
