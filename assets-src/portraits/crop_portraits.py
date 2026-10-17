"""
キャラクターの顔の絵（キャラクター選択・ロードアウト・試合中の左下の体力表示）を、元の絵から切り抜くスクリプト。

使い方：
  python assets-src/portraits/crop_portraits.py

元の絵：assets-src/portraits/<名前>_art.jpg（1448×1086 のイラスト）
書き出すもの：client/assets/portraits/<名前>.jpg（360×450。縦横 4:5）
  顔のまわりを切り抜く。顔の中心が、横は真ん中、縦は上から 45% の所に来るようにする。
  顔の位置・切り抜く幅は下の FACES で決める（元の絵の座標。幅を小さくするほど顔が大きく写る）
"""

import os

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "..", "..", "client", "assets", "portraits")
OUT_W, OUT_H = 360, 450

# 名前: (顔の中心 x, 顔の中心 y, 切り抜く幅)。高さは幅の 1.25 倍
FACES = {
    "meia": (945, 290, 270),
    "pearl": (950, 205, 270),
    "miranda": (636, 155, 200),
    "sora": (600, 395, 270),
    "alex": (945, 250, 270),
    "ranmaru": (670, 305, 270),
}


def main():
    for name, (cx, cy, w) in FACES.items():
        im = Image.open(os.path.join(HERE, f"{name}_art.jpg")).convert("RGB")
        h = w * OUT_H / OUT_W
        x0 = min(max(0, cx - w / 2), im.width - w)
        y0 = min(max(0, cy - h * 0.45), im.height - h)
        crop = im.crop((round(x0), round(y0), round(x0 + w), round(y0 + h))).resize((OUT_W, OUT_H), Image.LANCZOS)
        out = os.path.join(OUT_DIR, f"{name}.jpg")
        crop.save(out, quality=88)
        print(f"書き出し: {os.path.normpath(out)}")


if __name__ == "__main__":
    main()
