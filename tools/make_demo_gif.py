"""做 README 和 B站 用的演示动图。

不依赖录屏：用现成的四态立绘 + 手画的聊天气泡合成一段循环，
演示「文件在长 → 百分比往上走 → 下完了换表情」这件事。

用法：
  python_embeded\\python.exe tools/make_demo_gif.py
产出：
  docs/demo.gif
"""

import os
import sys

from PIL import Image, ImageDraw, ImageFont

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(_ROOT, "assets", "blue")
OUT = os.path.join(_ROOT, "docs", "demo.gif")

# 画布与气泡（跟真实挂件比例接近）
W, H = 320, 400
BUBBLE_W = 268
BUBBLE_PAD = 10
RADIUS = 18

FONT_CN = r"C:\Windows\Fonts\msyh.ttc"
FONT_CN_BD = r"C:\Windows\Fonts\msyhbd.ttc"

# 气泡配色：跟 client.js 里的 data-bface 一一对应
BG_EATING = ((41, 66, 148), (58, 47, 124))
BG_DONE = ((6, 120, 86), (4, 96, 70))

FILENAME = "Qwen3-8B.safetensors"
TOTAL_MB = 8521


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


F_NAME = font(FONT_CN, 15)
F_MAIN = font(FONT_CN_BD, 26)
F_SUB = font(FONT_CN, 14)


def vgrad(size, c0, c1):
    """竖向渐变，模拟气泡的 linear-gradient。"""
    w, h = size
    img = Image.new("RGB", (1, h))
    px = img.load()
    for y in range(h):
        t = y / max(h - 1, 1)
        px[0, y] = (
            int(c0[0] + (c1[0] - c0[0]) * t),
            int(c0[1] + (c1[1] - c0[1]) * t),
            int(c0[2] + (c1[2] - c0[2]) * t),
        )
    return img.resize((w, h), Image.BILINEAR)


def round_rect_mask(size, radius):
    m = Image.new("L", size, 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return m


def draw_bubble(percent, speed, done):
    """画一个气泡，返回 RGBA 图。画布比气泡高一点，给底下的鲸尾尖留位置。"""
    main = "吃完啦" if done else f"{percent}%"
    sub = f"{TOTAL_MB * percent // 100:,} MB / {TOTAL_MB:,} MB" if not done else "8.3 GB"
    head = "下好了" if done else f"{speed} MB/s"

    bh = 104
    TAIL = 14
    canvas = Image.new("RGBA", (BUBBLE_W, bh + TAIL), (0, 0, 0, 0))

    c0, c1 = BG_DONE if done else BG_EATING
    body = vgrad((BUBBLE_W, bh), c0, c1).convert("RGBA")
    body.putalpha(round_rect_mask((BUBBLE_W, bh), RADIUS))
    canvas.alpha_composite(body)

    # 底下那对鲸尾尖（跟 CSS 里 ::before/::after 两个斜三角对应）
    d = ImageDraw.Draw(canvas)
    d.polygon([(BUBBLE_W // 2 - 15, bh - 1), (BUBBLE_W // 2 - 2, bh - 1), (BUBBLE_W // 2 - 11, bh + TAIL - 2)],
              fill=c1 + (255,))
    d.polygon([(BUBBLE_W // 2 + 2, bh - 1), (BUBBLE_W // 2 + 15, bh - 1), (BUBBLE_W // 2 + 4, bh + TAIL - 2)],
              fill=c1 + (255,))

    # 三行字
    d.text((BUBBLE_PAD + 4, 10), FILENAME, font=F_NAME, fill=(255, 255, 255, 200))
    d.text((BUBBLE_PAD + 4, 30), main, font=F_MAIN, fill=(255, 255, 255, 255))
    d.text((BUBBLE_PAD + 4, 66), sub, font=F_SUB, fill=(255, 255, 255, 175))

    # 进度条
    bar_y = bh - 8
    d.rounded_rectangle([BUBBLE_PAD, bar_y, BUBBLE_W - BUBBLE_PAD, bar_y + 4], radius=2,
                        fill=(255, 255, 255, 60))
    fw = int((BUBBLE_W - BUBBLE_PAD * 2) * max(percent, 1) / 100)
    if fw > 2:
        d.rounded_rectangle([BUBBLE_PAD, bar_y, BUBBLE_PAD + fw, bar_y + 4], radius=2,
                            fill=(125, 211, 252, 255) if not done else (110, 231, 183, 255))
    return canvas


def load_state(name, size):
    """读立绘并削掉边缘那圈半透明白边 —— 不然贴在深色背景上会有光晕。"""
    p = os.path.join(ASSETS, name + ".png")
    im = Image.open(p).convert("RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 40:
                px[x, y] = (r, g, b, 0)
            elif a < 190:
                # 边缘像素往主体色靠，压掉白边
                px[x, y] = (r, g, b, a)
    return im.resize((size, size), Image.LANCZOS)


CHARS = {n: load_state(n, 168) for n in ("eating", "idle", "stuck", "done")}


def compose(percent, speed, done, bob):
    frame = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    bubble = draw_bubble(percent, speed, done)
    bx = (W - BUBBLE_W) // 2
    frame.alpha_composite(bubble, (bx, 20))
    state = "done" if done else "eating"
    ch = CHARS[state]
    cx = (W - ch.width) // 2
    cy = 150 + bob
    frame.alpha_composite(ch, (cx, cy))
    return frame


def main():
    frames = []
    durations = []

    # 0 → 96%：吃饭中，进度条往上爬
    steps = list(range(0, 97, 3))
    for i, p in enumerate(steps):
        bob = [-2, 0, 2, 0][i % 4]
        frames.append(compose(p, 2.6, False, bob))
        durations.append(70)

    # 停下 → 100% → 换表情
    for i in range(3):
        frames.append(compose(100, 2.6, False, [-2, 0, 2][i]))
        durations.append(70)
    for i in range(22):
        bob = [-5, 0, -2, 0][i % 4]
        frames.append(compose(100, 0, True, bob))
        durations.append(80)

    # 收尾停顿
    for i in range(6):
        frames.append(compose(100, 0, True, 0))
        durations.append(120)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    frames[0].save(
        OUT,
        "GIF",
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=0,
        disposal=2,
        optimize=True,
    )
    kb = os.path.getsize(OUT) / 1024
    print("写好了 %s   %d 帧   %.0f KB" % (OUT, len(frames), kb))


if __name__ == "__main__":
    sys.exit(main())
