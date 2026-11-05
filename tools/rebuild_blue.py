"""重建 blue 这套皮肤的四张图，参数全部显式写在下面。

为什么要有这个脚本：
  之前每调一次就手敲一遍命令，中途改动散在会话里，想退回某一版只能靠记忆。
  现在四条源文件 + 每张的参数都钉在这里，改哪张就改对应的行，跑一次即可。

两种调色的区别（别搞混）：
  cut(saturation=, brightness=)  整张图统一乘，连脸和衣服一起动 —— 只在「建底板」时用
  boost_hair(sat_mul)            只动头发像素，其它不碰 —— 只在「微调发色」时用

用法：
  python_embeded\\python.exe tools\\rebuild_blue.py
"""

import colorsys
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from grade_hair import build_hair_mask  # noqa: E402
from cut_states import cut  # noqa: E402

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)

# 源图目录：默认 <仓库>/docs/raw，可用环境变量 OJJ_SRC 覆盖
OUT = os.environ.get("OJJ_SRC") or os.path.join(_ROOT, "docs", "raw")
DST = os.path.join(_ROOT, "assets", "blue")

# 每张：源文件, 底板全局(饱和/亮度), 头发额外提饱和倍数
JOBS = [
    # idle 用 char_00027_（正面看镜头那一版），其它三张保持统一
    ("idle", "char_00027_.png", 0.62, 1.03, 1.50),
    ("eating", "char_00022_.png", 0.62, 1.03, 1.50),
    ("stuck", "char_00020_.png", 0.62, 1.03, 1.50),
    ("done", "char_00026_.png", 0.62, 1.03, 1.50),
]


def boost_hair(im, sat_mul):
    """只提高头发像素的饱和度，别的原样返回。"""
    if abs(sat_mul - 1.0) < 1e-3:
        return im
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


def measure_hair(im):
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


def main():
    os.makedirs(DST, exist_ok=True)
    only = set(sys.argv[1:]) if len(sys.argv) > 1 else None
    for state, src, sat, bri, hair in JOBS:
        if only and state not in only:
            continue
        base = os.path.join(OUT, src)
        if not os.path.exists(base):
            print("MISSING", base)
            continue
        tmp = os.path.join(DST, "_tmp_" + state + ".png")
        cut(base, tmp, saturation=sat, brightness=bri)
        im = Image.open(tmp).convert("RGBA")
        im = boost_hair(im, hair)
        im.save(os.path.join(DST, state + ".png"), "PNG", optimize=True)
        os.remove(tmp)
        s, l = measure_hair(im)
        print("%-7s <- %-18s hair sat=%.2f light=%.2f" % (state, src, s, l))


if __name__ == "__main__":
    sys.exit(main())
