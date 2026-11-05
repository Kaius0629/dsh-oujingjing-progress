"""把 ComfyUI 出的四态图抠掉背景、缩成挂件用的小图。

用的是自己写的连通区域（Pillow 12 的 ImageDraw.floodfill 在 fromarray 出来的
大图上不落笔，所以不用它）：

  1. 取四条边像素的中位数当背景色
  2. 算出「像背景色」的掩码
  3. 降采样后从边缘做 BFS，只有连通到边缘的才算真背景（围裙被描边隔着，不会被吃）
  4. 上采样回原尺寸，再和原掩码取交，边界不会糊太多
  5. 丢掉零散的小碎块（模型偶尔在角落多画一个头）

用法（用 ComfyUI 自带的 python，它有 PIL 和 numpy）：
  python_embeded\\python.exe cut_states.py
"""

import os
import sys
from collections import deque

import numpy as np
from PIL import Image, ImageEnhance

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)

# 源图放哪儿：默认 <仓库>/docs/raw（.gitignore 里已忽略），
# 也可以用环境变量 OJJ_SRC 指到别处，比如 ComfyUI 的输出目录。
SRC = os.environ.get("OJJ_SRC") or os.path.join(_ROOT, "docs", "raw")
DST = os.path.join(_ROOT, "assets")

# (皮肤目录, 状态名, 源文件)
JOBS = [
    ("blue", "eating", "char_00022_.png"),
    ("blue", "idle", "char_00029_.png"),
    ("blue", "stuck", "char_00020_.png"),
    ("blue", "done", "char_00026_.png"),
]

SIZE = 128
TOL = 132
COARSE = 320  # BFS 在这个边长上跑
KEEP_RATIO = 0.35  # 副块要够主块的这么大才留（切掉旁边的小角色）
# 默认不调色。要压饱和度只能在「头发」上做（见 tools/grade_hair.py），
# 整张图调色会把脸和衣服一起洗淡，那是错的。
SATURATION = 1.0
BRIGHTNESS = 1.0


def _bfs_from_edges(open_mask):
    """open_mask: bool HxW。返回能与边缘连通的 True 区域（同尺寸）。"""
    h, w = open_mask.shape
    vis = np.zeros((h, w), dtype=bool)
    q = deque()

    def push(y, x):
        if open_mask[y, x] and not vis[y, x]:
            vis[y, x] = True
            q.append((y, x))

    for x in range(w):
        push(0, x)
        push(h - 1, x)
    for y in range(h):
        push(y, 0)
        push(y, w - 1)

    while q:
        y, x = q.popleft()
        if y > 0:
            push(y - 1, x)
        if y < h - 1:
            push(y + 1, x)
        if x > 0:
            push(y, x - 1)
        if x < w - 1:
            push(y, x + 1)
    return vis


def connected_to_edge(close):
    """先粗后细：粗层找连通，细层取交，避免 1M 像素的 Python BFS。"""
    H, W = close.shape
    step = max(1, max(H, W) // COARSE)
    small = close[::step, ::step]
    reach = _bfs_from_edges(small)
    if step == 1:
        return reach & close
    up = np.repeat(np.repeat(reach, step, axis=0), step, axis=1)
    canvas = np.zeros((H, W), dtype=bool)
    hh = min(H, up.shape[0])
    ww = min(W, up.shape[1])
    canvas[:hh, :ww] = up[:hh, :ww]
    return canvas & close


def biggest_blob_mask(solid, step=8, keep_ratio=0.35):
    """solid: bool HxW（非透明区域）。

    只保留「面积够大」的连通块：主角色是第一大，副角色/道具只有
    大于主块 keep_ratio 倍时才留。eating 那张两边的迷你角色就是被这条切掉的。
    """
    H, W = solid.shape
    small = solid[::step, ::step]
    h, w = small.shape
    seen = np.zeros((h, w), dtype=bool)
    comps = []
    for sy in range(h):
        for sx in range(w):
            if not small[sy, sx] or seen[sy, sx]:
                continue
            stack = [(sy, sx)]
            seen[sy, sx] = True
            comp = []
            while stack:
                y, x = stack.pop()
                comp.append((y, x))
                for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                    if 0 <= ny < h and 0 <= nx < w and small[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
            comps.append(comp)

    if not comps:
        return solid
    comps.sort(key=len, reverse=True)
    biggest = len(comps[0])
    keep_comps = [c for c in comps if len(c) >= biggest * keep_ratio]

    keep = np.zeros((h, w), dtype=bool)
    for comp in keep_comps:
        for y, x in comp:
            keep[y, x] = True
    # 邻格也留着，别把手脚边缘削掉
    grown = keep.copy()
    for y, x in np.argwhere(keep):
        for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= ny < h and 0 <= nx < w:
                grown[ny, nx] = True

    up = np.repeat(np.repeat(grown, step, axis=0), step, axis=1)
    canvas = np.zeros((H, W), dtype=bool)
    hh = min(H, up.shape[0])
    ww = min(W, up.shape[1])
    canvas[:hh, :ww] = up[:hh, :ww]
    return canvas


def crop_to_main(arr):
    """最后一道保险：拿主体内容的外接框，按面积裁掉贴边的配角。

    做法：先算所有不透明像素的 bbox；再按列统计「有多少不透明像素」，
    把左右两侧那些稀疏的细条（就是蹲在脚边的小角色）砍掉。
    """
    alpha = arr[:, :, 3]
    ys, xs = np.nonzero(alpha > 8)
    if len(xs) == 0:
        return arr
    x0, x1 = xs.min(), xs.max()
    y0, y1 = ys.min(), ys.max()

    col = (alpha[y0:y1 + 1, x0:x1 + 1] > 8).sum(axis=0)
    if col.size:
        peak = col.max()
        solid_cols = col > peak * 0.06  # 低于这个密度的列当噪声
        idx = np.nonzero(solid_cols)[0]
        if idx.size:
            # 只取包含峰值的连续段，跳过两边的孤立小段
            peak_idx = int(np.argmax(col))
            left = peak_idx
            while left > 0 and solid_cols[left - 1]:
                left -= 1
            right = peak_idx
            while right < col.size - 1 and solid_cols[right + 1]:
                right += 1
            x0 = x0 + left
            x1 = x0 + (right - left)

    return arr[y0:y1 + 1, x0:x1 + 1, :]


def cut(src_path, dst_path, size=SIZE, tol=TOL, keep_ratio=KEEP_RATIO,
        saturation=SATURATION, brightness=BRIGHTNESS):
    im = Image.open(src_path).convert("RGBA")
    arr = np.array(im)
    rgb = arr[:, :, :3]
    H, W, _ = rgb.shape

    edge = np.concatenate([rgb[0, :], rgb[H - 1, :], rgb[:, 0], rgb[:, W - 1]])
    bg = np.median(edge.astype(np.float32), axis=0)
    close = np.abs(rgb.astype(np.int16) - bg).max(axis=2) < tol

    bgmask = connected_to_edge(close)
    arr[bgmask, 3] = 0

    solid = arr[:, :, 3] > 8
    keep = biggest_blob_mask(solid, keep_ratio=keep_ratio)
    arr[~keep, 3] = 0
    arr = crop_to_main(arr)

    out = Image.fromarray(arr, "RGBA")
    # 统一调色：压饱和度 + 微提亮，让四张图放在一起像同一套
    if saturation != 1.0 or brightness != 1.0:
        alpha = out.getchannel("A")
        rgb = out.convert("RGB")
        if saturation != 1.0:
            rgb = ImageEnhance.Color(rgb).enhance(saturation)
        if brightness != 1.0:
            rgb = ImageEnhance.Brightness(rgb).enhance(brightness)
        out = rgb.convert("RGBA")
        out.putalpha(alpha)
    bbox = out.getbbox()
    if bbox:
        out = out.crop(bbox)

    side = max(out.size)
    pad = max(1, int(side * 0.05))
    canvas = Image.new("RGBA", (side + pad * 2, side + pad * 2), (0, 0, 0, 0))
    canvas.paste(out, ((canvas.size[0] - out.size[0]) // 2, (canvas.size[1] - out.size[1]) // 2))
    canvas = canvas.resize((size, size), Image.LANCZOS)
    canvas.save(dst_path, "PNG", optimize=True)
    return os.path.getsize(dst_path), bg, (bgmask.mean(), keep.mean())


def main():
    for skin, name, filename in JOBS:
        src = os.path.join(SRC, filename)
        out_dir = os.path.join(DST, skin)
        if not os.path.exists(src):
            print("MISSING", src)
            continue
        os.makedirs(out_dir, exist_ok=True)
        dst = os.path.join(out_dir, name + ".png")
        n, bg, ratios = cut(src, dst, keep_ratio=KEEP_RATIO)
        print(
            "%-6s %-7s -> %6d bytes (bg=%s bgRatio=%.2f keep=%.2f)"
            % (skin, name, n, np.round(bg).astype(int).tolist(), ratios[0], ratios[1])
        )


if __name__ == "__main__":
    sys.exit(main())
