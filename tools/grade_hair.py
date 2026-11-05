"""只改头发颜色，别的一个像素都不碰。

为什么单独做一个：
  之前用 ImageEnhance.Color 整张图压饱和度，结果脸、围裙、碗一起被洗淡，
  看起来比原图还差。头发是唯一要调的，那就只挑头发。

做法：
  1. 转 HSV，按「蓝色系 + 够亮」挑出头发像素（深藏青的裙子因为亮度低会被排除）
  2. 只对这些像素做降饱和 / 提亮，其余原样
  3. 用轻微羽化后的蒙版混合，避免边缘出现硬边

用法：
  python_embeded\\python.exe tools/grade_hair.py <输入> <输出> [--sat 0.6] [--val 1.05]
"""

import argparse
import colorsys
import sys

import numpy as np
from PIL import Image, ImageFilter

# 头发判定：这些范围把「亮蓝头发」圈进来，同时排除深色裙子
HUE_LO, HUE_HI = 195.0, 255.0     # 蓝到蓝紫
SAT_MIN = 0.22                     # 太灰的不算
VAL_MIN = 0.28                     # 太暗的是裙子/描边，不算
VAL_MAX = 0.98                     # 近白的是高光/头箍，不动


def build_hair_mask(rgb_u8):
    arr = rgb_u8.astype(np.float32) / 255.0
    maxc = arr.max(axis=2)
    minc = arr.min(axis=2)
    delta = maxc - minc

    # 色相（vectorized）
    hue = np.zeros_like(maxc)
    nz = delta > 1e-6
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    idx = nz & (maxc == r)
    hue[idx] = (60 * ((g[idx] - b[idx]) / delta[idx])) % 360
    idx = nz & (maxc == g)
    hue[idx] = 60 * ((b[idx] - r[idx]) / delta[idx]) + 120
    idx = nz & (maxc == b)
    hue[idx] = 60 * ((r[idx] - g[idx]) / delta[idx]) + 240

    sat = np.where(maxc > 1e-6, delta / np.maximum(maxc, 1e-6), 0.0)
    val = maxc

    colour = (
        (hue >= HUE_LO) & (hue <= HUE_HI)
        & (sat >= SAT_MIN)
        & (val >= VAL_MIN) & (val <= VAL_MAX)
    )

    # 只按颜色挑：蓝色系 + 够亮。
    # 脸的肤色（红系）、白围裙（低饱和）、深色描边（低亮度）都会被排除，
    # 所以不需要再叠几何限制 —— 那样反而会把两侧发尾切掉。
    return colour


def grade(src, dst, sat_scale, val_scale):
    im = Image.open(src).convert("RGBA")
    rgb = np.array(im.convert("RGB"))
    alpha = np.array(im.getchannel("A"))

    mask = build_hair_mask(rgb)
    # 蒙版轻微羽化，避免头发和皮肤交界处出现硬边
    m_img = Image.fromarray((mask * 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(1.2))
    m = np.array(m_img).astype(np.float32) / 255.0
    m = np.clip(m * (1.0 / 0.75), 0.0, 1.0)  # 提高覆盖，让核心区域完全按目标值走
    m = m[:, :, None]

    # 逐像素 HLS 调整
    flat = rgb.reshape(-1, 3) / 255.0
    out = flat.copy()
    hls = np.array([colorsys.rgb_to_hls(*p) for p in flat])
    hls[:, 1] = np.clip(hls[:, 1] * val_scale, 0.0, 1.0)   # 亮度
    hls[:, 2] = np.clip(hls[:, 2] * sat_scale, 0.0, 1.0)   # 饱和度
    out = np.array([colorsys.hls_to_rgb(*p) for p in hls]) * 255.0

    mixed = flat.reshape(rgb.shape) * 255.0 * (1 - m) + out.reshape(rgb.shape) * m
    res = np.clip(mixed, 0, 255).astype(np.uint8)

    result = Image.fromarray(res, "RGB").convert("RGBA")
    result.putalpha(Image.fromarray(alpha, "L"))
    result.save(dst, "PNG", optimize=True)
    return float(mask.mean())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--sat", type=float, default=0.62)
    ap.add_argument("--val", type=float, default=1.08)
    a = ap.parse_args()
    ratio = grade(a.src, a.dst, a.sat, a.val)
    print("hair pixels: %.1f%%  -> %s" % (ratio * 100, a.dst))


if __name__ == "__main__":
    sys.exit(main())
