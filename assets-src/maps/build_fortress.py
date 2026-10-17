"""
軍事要塞（仕様 6.2）の見た目を Blender で作り、glTF（.glb）で書き出すスクリプト。

使い方：
  npx tsx scripts/export-map.ts fortress           # まず配置を JSON に書き出す
  python assets-src/maps/build_fortress.py          # pip install bpy（Python 3.11）
オプション：
  --blend    確認用に assets-src/maps/fortress.blend も保存する
  --preview  assets-src/maps/preview/fortress_*.png に確認用の画像を描く
  --stats    メッシュの大きさを表示する

作り方
  - 当たり判定の箱（shared/levels/fortress.ts）と同じ配置 JSON（fortress_layout.json）を読み、箱の種類（tag）ごとに見た目を作る：
    防壁（継ぎ目・控え壁・上の通路）・見張り塔（小屋・窓枠）・格納庫（大型ゲート・中の壁）・兵舎・別棟・指令塔・
    屋根付きの空中連絡橋（トラス・屋根）・橋脚・コアの台座・軍用トラック・装甲車・コンテナ・木箱・ジャージー壁・土のう・
    燃料タンク・岩・積み降ろし台・ひさし・崖の擁壁・坂道。
  - 地面：要塞の中は舗装（コンクリートの板）、外は草原と土の道。道路の黄色の線・駐車枠・コアのまわりの縞模様。
  - 遠景：まわりの高原の起伏・遠くの青い山脈（雪をかぶった頂）・岩と針葉樹。「Bg_」の名前にして、影の計算から外す。
  - 当たり判定と見た目がずれないよう、足場の上面・壁の面は箱の面とそろえる（飾りは 0.2m 以内しか出っ張らせない）。
  - マテリアルは名前で区別する（F で始まる名前）。ゲーム側（client/scene/fortressMaterials.ts）が名前を見て、
    コンクリートの継ぎ目・しみ・舗装の目地・草のむらなどの質感に置き換える。
  - 同じマテリアルの面は1つのメッシュにまとめる（描画の負荷を下げる）。

座標：ゲーム（three.js）は Y が上、Blender は Z が上。(x, y, z)_three = (x, z, -y)_blender
"""

import json
import math
import os
import random
import sys

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
LAYOUT = os.path.join(HERE, "fortress_layout.json")
OUT = os.path.join(ROOT, "client", "assets", "maps", "fortress.glb")
RAW = os.path.join(HERE, "fortress_raw.glb")

rnd = random.Random(20261012)

# 要塞の防壁の外側（fortress.ts と同じ）
WALL_X = 62.0
WALL_N = -50.0
WALL_S = 40.0
CLIFF_X = -76.0
LOW_Y = -6.0
PLAY_MIN = (-132.0, -92.0)  # (x, z)（three の座標）。shared/levels/fortress.ts の PLAY_X・PLAY_Z と同じ
PLAY_MAX = (132.0, 116.0)


def T(p):
    """three.js の座標 → Blender の座標"""
    if isinstance(p, dict):
        return Vector((p["x"], -p["z"], p["y"]))
    return Vector((p[0], -p[2], p[1]))


def box_matrix(b):
    r = b.get("rot") or {"x": 0, "y": 0, "z": 0}
    yaw = math.radians(r["y"])
    pitch = math.radians(r["x"])
    return Matrix.Translation(T(b["center"])) @ Matrix.Rotation(yaw, 4, "Z") @ Matrix.Rotation(pitch, 4, "X")


def box_half(b):
    s = b["size"]
    return Vector((s["x"] / 2, s["z"] / 2, s["y"] / 2))


def box_range(b):
    """回転のない箱の、three の座標での範囲 (x0, y0, z0, x1, y1, z1)"""
    c, s = b["center"], b["size"]
    return (c["x"] - s["x"] / 2, c["y"] - s["y"] / 2, c["z"] - s["z"] / 2, c["x"] + s["x"] / 2, c["y"] + s["y"] / 2, c["z"] + s["z"] / 2)


WHITE = (1.0, 1.0, 1.0, 1.0)


class Acc:
    """面をマテリアルごとに貯めておき、最後に1つのメッシュにする"""

    def __init__(self):
        self.groups = {}

    def _g(self, mat):
        if mat not in self.groups:
            self.groups[mat] = ([], [], [], [])
        return self.groups[mat]

    def poly(self, pts, mat, color=WHITE, M=None, uv=None):
        verts, faces, cols, uvs = self._g(mat)
        uvs.append(uv)
        i0 = len(verts)
        for p in pts:
            v = Vector(p)
            verts.append(tuple(M @ v) if M is not None else tuple(v))
        faces.append(tuple(range(i0, i0 + len(pts))))
        cols.append(color)

    def box(self, lo, hi, M, mat, top=None, bottom=None, color=WHITE, skip=(), side=None):
        """ローカル座標の範囲 lo〜hi の箱。top / bottom / side で面ごとにマテリアルを変えられる"""
        x0, y0, z0 = lo
        x1, y1, z1 = hi
        faces = {
            "top": [(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)],
            "bottom": [(x0, y0, z0), (x0, y1, z0), (x1, y1, z0), (x1, y0, z0)],
            "+x": [(x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)],
            "-x": [(x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0)],
            "+y": [(x0, y1, z0), (x0, y1, z1), (x1, y1, z1), (x1, y1, z0)],
            "-y": [(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)],
        }
        for k, pts in faces.items():
            if k in skip:
                continue
            m = top if (k == "top" and top) else bottom if (k == "bottom" and bottom) else (side if (side and k not in ("top", "bottom")) else mat)
            self.poly(pts, m, color, M)

    def cyl(self, a, b, r, M, mat, n=10, caps=True, color=WHITE, r2=None, cap_mat=None):
        a, b = Vector(a), Vector(b)
        d = b - a
        if d.length < 1e-6:
            return
        q = Vector((0, 0, 1)).rotation_difference(d.normalized())
        r2 = r if r2 is None else r2
        ring_a = [a + q @ Vector((math.cos(t) * r, math.sin(t) * r, 0)) for t in [i * 2 * math.pi / n for i in range(n)]]
        ring_b = [b + q @ Vector((math.cos(t) * r2, math.sin(t) * r2, 0)) for t in [i * 2 * math.pi / n for i in range(n)]]
        for i in range(n):
            j = (i + 1) % n
            self.poly([ring_a[i], ring_a[j], ring_b[j], ring_b[i]], mat, color, M)
        if caps:
            self.poly(list(reversed(ring_a)), cap_mat or mat, color, M)
            self.poly(ring_b, cap_mat or mat, color, M)

    def disc(self, c, r, M, mat, n=24, z=0.0, color=WHITE):
        c = Vector(c)
        pts = [c + Vector((math.cos(i * 2 * math.pi / n) * r, math.sin(i * 2 * math.pi / n) * r, z)) for i in range(n)]
        self.poly(pts, mat, color, M)

    def ring(self, c, r0, r1, M, mat, n=48, z=0.0, a0=0.0, a1=2 * math.pi, color=WHITE):
        c = Vector(c)
        for i in range(n):
            t0 = a0 + (a1 - a0) * i / n
            t1 = a0 + (a1 - a0) * (i + 1) / n
            p = [
                c + Vector((math.cos(t0) * r0, math.sin(t0) * r0, z)),
                c + Vector((math.cos(t0) * r1, math.sin(t0) * r1, z)),
                c + Vector((math.cos(t1) * r1, math.sin(t1) * r1, z)),
                c + Vector((math.cos(t1) * r0, math.sin(t1) * r0, z)),
            ]
            self.poly(p, mat, color, M)

    def extrude(self, profile, length, M, mat, cap=True, cap_mat=None):
        """断面（x-z 平面の多角形、反時計回り）を y 方向に -length/2〜length/2 だけ押し出す"""
        y0, y1 = -length / 2, length / 2
        n = len(profile)
        for i in range(n):
            a = profile[i]
            b = profile[(i + 1) % n]
            self.poly([(a[0], y0, a[1]), (b[0], y0, b[1]), (b[0], y1, b[1]), (a[0], y1, a[1])], mat, M=M)
        if cap:
            self.poly([(p[0], y1, p[1]) for p in profile], cap_mat or mat, M=M)
            self.poly([(p[0], y0, p[1]) for p in reversed(profile)], cap_mat or mat, M=M)

    def blob(self, c, r, M, mat, sub=1, jitter=0.25, squash=(1.0, 1.0, 1.0), seed=0):
        """でこぼこの多面体（岩）"""
        rr = random.Random(seed)
        t = (1 + 5**0.5) / 2
        vs = [(-1, t, 0), (1, t, 0), (-1, -t, 0), (1, -t, 0), (0, -1, t), (0, 1, t), (0, -1, -t), (0, 1, -t), (t, 0, -1), (t, 0, 1), (-t, 0, -1), (-t, 0, 1)]
        fs = [(0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11), (1, 5, 9), (5, 11, 4), (11, 10, 2), (10, 7, 6), (7, 1, 8), (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9), (4, 9, 5), (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1)]
        vs = [Vector(v).normalized() for v in vs]
        for _ in range(sub):
            nf = []
            cache = {}

            def mid(i, j):
                k = (min(i, j), max(i, j))
                if k not in cache:
                    vs.append(((vs[i] + vs[j]) / 2).normalized())
                    cache[k] = len(vs) - 1
                return cache[k]

            for a, b2, c2 in fs:
                ab, bc, ca = mid(a, b2), mid(b2, c2), mid(c2, a)
                nf += [(a, ab, ca), (b2, bc, ab), (c2, ca, bc), (ab, bc, ca)]
            fs = nf
        c = Vector(c)
        sc = [1 - rr.uniform(0, jitter) for _ in vs]
        pts = [c + Vector((v.x * r * squash[0] * sc[i], v.y * r * squash[1] * sc[i], v.z * r * squash[2] * sc[i])) for i, v in enumerate(vs)]
        for f in fs:
            self.poly([pts[i] for i in f], mat, M=M)

    def build(self, collection):
        objs = []
        for mat_name, (verts, faces, cols, uvs) in self.groups.items():
            if not faces:
                continue
            me = bpy.data.meshes.new("fort_" + mat_name)
            me.from_pydata(verts, [], faces)
            me.update()
            me.materials.append(material(mat_name))
            ob = bpy.data.objects.new("fort_" + mat_name, me)
            collection.objects.link(ob)
            objs.append(ob)
        return objs


# ---------------------------------------------------------------------------
# マテリアル（色はゲーム側で置き換える。Blender の確認用に近い色をつけておく）
# ---------------------------------------------------------------------------

MAT_COLORS = {
    "FConcrete": ("#a8a7a1", 0.0, 0.85, None),
    "FConcreteDark": ("#7b7a75", 0.0, 0.85, None),
    "FConcreteLight": ("#c6c4bc", 0.0, 0.8, None),
    "FConcreteInner": ("#8f8e88", 0.0, 0.9, None),
    "FWalk": ("#9a9891", 0.0, 0.85, None),
    "FPavement": ("#8d8b85", 0.0, 0.8, None),
    "FAsphalt": ("#55555a", 0.0, 0.7, None),
    "FMarkYellow": ("#d8b02a", 0.0, 0.6, None),
    "FMarkWhite": ("#dcdcd4", 0.0, 0.6, None),
    "FHazardBlack": ("#202022", 0.0, 0.6, None),
    "FGrass": ("#6b8a3c", 0.0, 0.95, None),
    "FGrassDry": ("#9a9a58", 0.0, 0.95, None),
    "FDirt": ("#8a7556", 0.0, 0.95, None),
    "FRock": ("#7d786f", 0.0, 0.9, None),
    "FOlive": ("#4f5a33", 0.2, 0.6, None),
    "FOliveDark": ("#363d24", 0.2, 0.65, None),
    "FTan": ("#a8986f", 0.2, 0.65, None),
    "FTanDark": ("#8c7d58", 0.2, 0.65, None),
    "FCanvas": ("#68683f", 0.0, 0.95, None),
    "FMetal": ("#8b9097", 0.8, 0.4, None),
    "FMetalDark": ("#3c3f45", 0.7, 0.5, None),
    "FGrating": ("#5d6168", 0.8, 0.5, None),
    "FGlass": ("#26394a", 0.6, 0.1, None),
    "FRubber": ("#1b1b1c", 0.0, 0.9, None),
    "FWood": ("#8d6b44", 0.0, 0.85, None),
    "FWoodDark": ("#5e452b", 0.0, 0.85, None),
    "FSandbag": ("#a6956b", 0.0, 0.95, None),
    "FRust": ("#7a4a2e", 0.3, 0.8, None),
    "FTank": ("#c9c7bf", 0.4, 0.5, None),
    "FNavy": ("#2a3a5c", 0.0, 0.8, None),
    "FLightWarm": ("#ffe9bf", 0, 0.5, "#ffe9bf"),
    "FLightRed": ("#ff3030", 0, 0.5, "#ff3030"),
    "FLightCyan": ("#54d8ff", 0, 0.5, "#54d8ff"),
    "FMountain": ("#6c7685", 0.0, 0.95, None),
    "FSnow": ("#eef2f6", 0.0, 0.7, None),
    "FTree": ("#3a5530", 0.0, 0.9, None),
}


def hexc(h):
    h = h.lstrip("#")
    c = tuple(int(h[i : i + 2], 16) / 255 for i in (0, 2, 4))
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)


_mats = {}


def material(name):
    if name in _mats:
        return _mats[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    base = name[3:] if name.startswith("Bg_") else name
    col, metal, rough, emis = MAT_COLORS.get(base, ("#808080", 0, 0.6, None))
    bsdf.inputs["Base Color"].default_value = (*hexc(col), 1)
    bsdf.inputs["Metallic"].default_value = metal
    bsdf.inputs["Roughness"].default_value = rough
    if emis:
        bsdf.inputs["Emission Color"].default_value = (*hexc(emis), 1)
        bsdf.inputs["Emission Strength"].default_value = 3.0
    _mats[name] = m
    return m


# ---------------------------------------------------------------------------
# 配置データ
# ---------------------------------------------------------------------------

layout = json.load(open(LAYOUT, encoding="utf-8"))
BOXES = layout["boxes"]
DECOR = layout["decor"]

# 面がほかの箱に埋まっていないか調べるため、回転のない箱の範囲を持っておく
SOLIDS = []
for i, b in enumerate(BOXES):
    r = b.get("rot") or {"x": 0, "y": 0, "z": 0}
    if abs(r["x"]) > 0.01 or abs(r["y"]) > 0.01 or b.get("kind") == "boundary" or b.get("tag") in ("barrier", "rail", "ground", "core"):
        continue
    SOLIDS.append((i, box_range(b)))


def covered(p, self_index, margin=0.05):
    """three の座標の点 p が、ほかの箱の中にあるか（窓や控え壁を埋まった面に付けないため）"""
    for i, (x0, y0, z0, x1, y1, z1) in SOLIDS:
        if i == self_index:
            continue
        if x0 - margin < p[0] < x1 + margin and y0 - margin < p[1] < y1 + margin and z0 - margin < p[2] < z1 + margin:
            return True
    return False


def in_fortress(x, z):
    return -WALL_X <= x <= WALL_X and WALL_N <= z <= WALL_S


def V(x, y, z):
    """three の座標 → Blender の Vector"""
    return Vector((x, -z, y))


# ---------------------------------------------------------------------------
# 共通の小道具
# ---------------------------------------------------------------------------

I4 = Matrix.Identity(4)

# 面の名前（Acc.box の名前）と、three の座標での外向きの向き
FACE_DIRS = {"top": (0, 1, 0), "bottom": (0, -1, 0), "+x": (1, 0, 0), "-x": (-1, 0, 0), "+y": (0, 0, -1), "-y": (0, 0, 1)}


def wbox(acc, x0, y0, z0, x1, y1, z1, mat, **kw):
    """three の座標の範囲で、回転のない箱を置く"""
    acc.box((x0, -z1, y0), (x1, -z0, y1), I4, mat, **kw)


def wquad_y(acc, x0, z0, x1, z1, y, mat):
    """three の座標の水平な四角（上向き）"""
    acc.poly([V(x0, y, z1), V(x1, y, z1), V(x1, y, z0), V(x0, y, z0)], mat)


def solid_box(acc, b, idx, mat, top=None, bottom=None, faces=None, skip_bottom=True):
    """回転のない当たり判定の箱を、ほかの箱に埋まった面を除いて描く。faces で面ごとのマテリアルを決められる"""
    x0, y0, z0, x1, y1, z1 = box_range(b)
    cx, cy, cz = (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2
    hx, hy, hz = (x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2
    skip = []
    for k, (dx, dy, dz) in FACE_DIRS.items():
        if k == "bottom" and skip_bottom:
            skip.append(k)
            continue
        p = (cx + dx * (hx + 0.08), cy + dy * (hy + 0.08), cz + dz * (hz + 0.08))
        # 面の上の 3×3 の点がどれも埋まっていたら描かない（細い物が面に触れているだけなら描く）
        us = [-0.7, 0.0, 0.7]
        pts = []
        for a in us:
            for c in us:
                if dx != 0:
                    pts.append((p[0], cy + hy * a, cz + hz * c))
                elif dy != 0:
                    pts.append((cx + hx * a, p[1], cz + hz * c))
                else:
                    pts.append((cx + hx * a, cy + hy * c, p[2]))
        if all(covered(q, idx) for q in pts):
            skip.append(k)
    lo = (x0, -z1, y0)
    hi = (x1, -z0, y1)
    if faces:
        x_0, y_0, z_0 = lo
        x_1, y_1, z_1 = hi
        quads = {
            "top": [(x_0, y_0, z_1), (x_1, y_0, z_1), (x_1, y_1, z_1), (x_0, y_1, z_1)],
            "bottom": [(x_0, y_0, z_0), (x_0, y_1, z_0), (x_1, y_1, z_0), (x_1, y_0, z_0)],
            "+x": [(x_1, y_0, z_0), (x_1, y_1, z_0), (x_1, y_1, z_1), (x_1, y_0, z_1)],
            "-x": [(x_0, y_0, z_0), (x_0, y_0, z_1), (x_0, y_1, z_1), (x_0, y_1, z_0)],
            "+y": [(x_0, y_1, z_0), (x_0, y_1, z_1), (x_1, y_1, z_1), (x_1, y_1, z_0)],
            "-y": [(x_0, y_0, z_0), (x_1, y_0, z_0), (x_1, y_0, z_1), (x_0, y_0, z_1)],
        }
        for k, q in quads.items():
            if k in skip:
                continue
            acc.poly(q, faces.get(k, mat))
    else:
        acc.box(lo, hi, I4, mat, top=top, bottom=bottom, skip=tuple(skip))
    return [k for k in FACE_DIRS if k not in skip]


def exposed_sides(b, idx):
    """回転のない箱の、ほかの箱に埋まっていない横の面（three の向き 'n','s','e','w'）"""
    x0, y0, z0, x1, y1, z1 = box_range(b)
    cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
    out = []
    for side, (px, pz) in {"e": (x1 + 0.1, cz), "w": (x0 - 0.1, cz), "n": (cx, z0 - 0.1), "s": (cx, z1 + 0.1)}.items():
        y = (y0 + y1) / 2
        if not covered((px, y, pz), idx):
            out.append(side)
    return out


def side_frame(b, side):
    """箱の横の面の座標系：面の上の点を (u：面に沿った位置, y：高さ) から three の座標にする関数と、面の幅"""
    x0, y0, z0, x1, y1, z1 = box_range(b)
    if side == "e":
        return (lambda u, y, d=0.0: V(x1 + d, y, z1 - u)), z1 - z0, (1, 0, 0)
    if side == "w":
        return (lambda u, y, d=0.0: V(x0 - d, y, z0 + u)), z1 - z0, (-1, 0, 0)
    if side == "n":
        return (lambda u, y, d=0.0: V(x1 - u, y, z0 - d)), x1 - x0, (0, 0, -1)
    return (lambda u, y, d=0.0: V(x0 + u, y, z1 + d)), x1 - x0, (0, 0, 1)


def face_rect(acc, P, u0, u1, y0, y1, d, mat):
    """面の上の四角（外向き）"""
    acc.poly([P(u0, y0, d), P(u1, y0, d), P(u1, y1, d), P(u0, y1, d)], mat)


def face_box(acc, P, u0, u1, y0, y1, d0, d1, mat):
    """面から d0〜d1 だけ出っ張った箱（控え壁・ひさし・ひれ）"""
    a = [P(u0, y0, d1), P(u1, y0, d1), P(u1, y1, d1), P(u0, y1, d1)]  # 前
    acc.poly(a, mat)
    acc.poly([P(u0, y1, d0), P(u0, y1, d1), P(u1, y1, d1), P(u1, y1, d0)], mat)  # 上
    acc.poly([P(u0, y0, d0), P(u1, y0, d0), P(u1, y0, d1), P(u0, y0, d1)], mat)  # 下
    acc.poly([P(u0, y0, d0), P(u0, y0, d1), P(u0, y1, d1), P(u0, y1, d0)], mat)  # 左
    acc.poly([P(u1, y0, d1), P(u1, y0, d0), P(u1, y1, d0), P(u1, y1, d1)], mat)  # 右


def hazard_strip(acc, P, u0, u1, y0, y1, d, step=0.6):
    """黄色と黒の縞（斜めの縞の代わりに、交互の帯）"""
    u = u0
    k = 0
    while u < u1 - 1e-3:
        e = min(u1, u + step)
        face_rect(acc, P, u, e, y0, y1, d, "FMarkYellow" if k % 2 == 0 else "FHazardBlack")
        u = e
        k += 1


# ---------------------------------------------------------------------------
# 地面・崖・坂
# ---------------------------------------------------------------------------


def build_ground(acc, b, idx):
    x0, y0, z0, x1, y1, z1 = box_range(b)
    if (b.get("vis") or {}).get("low"):
        wquad_y(acc, x0, z0, x1, z1, y1, "FGrass")
        return
    # 要塞の中は舗装、外は草原
    fx0, fx1, fz0, fz1 = -WALL_X, WALL_X, WALL_N, WALL_S
    wquad_y(acc, fx0, fz0, fx1, fz1, y1, "FPavement")
    wquad_y(acc, x0, z0, x1, fz0, y1, "FGrass")  # 北
    wquad_y(acc, x0, fz1, x1, z1, y1, "FGrass")  # 南
    wquad_y(acc, x0, fz0, fx0, fz1, y1, "FGrass")  # 西
    wquad_y(acc, fx1, fz0, x1, fz1, y1, "FGrass")  # 東


def build_cliff(acc, b, idx):
    x0, y0, z0, x1, y1, z1 = box_range(b)
    wbox(acc, x0, y0, z0, x1, y1, z1, "FConcreteDark", top="FConcrete", skip=("bottom",))
    # 西の岩場側の控え壁（8m ごと）と、上の縁
    P, W, _ = side_frame(b, "w")
    u = 4.0
    while u < W - 2:
        face_box(acc, P, u - 0.5, u + 0.5, LOW_Y, -0.35, 0.0, 0.18, "FConcrete")
        u += 8.0
    face_box(acc, P, 0, W, -0.35, 0.0, 0.0, 0.12, "FConcrete")


def build_ramp(acc, b, idx):
    M = box_matrix(b)
    h = box_half(b)
    vis = b.get("vis") or {}
    if b.get("tag") == "barrier":
        acc.box(-h, h, M, "FConcreteLight", skip=("bottom",))
        return
    acc.box(-h, h, M, "FConcreteDark", top="FAsphalt", skip=("bottom",))
    if vis.get("road"):
        # 黄色の縁の線と、白い破線の中央線
        z = h.z + 0.012
        for s in (-1, 1):
            x = s * (h.x - 0.5)
            acc.poly([(x - 0.08, -h.y, z), (x + 0.08, -h.y, z), (x + 0.08, h.y, z), (x - 0.08, h.y, z)], "FMarkYellow", M=M)
        y = -h.y + 1
        while y < h.y - 1:
            acc.poly([(-0.07, y, z), (0.07, y, z), (0.07, y + 2, z), (-0.07, y + 2, z)], "FMarkWhite", M=M)
            y += 4


# ---------------------------------------------------------------------------
# 防壁・胸壁・見張り塔
# ---------------------------------------------------------------------------


def build_fortwall(acc, b, idx):
    vis = b.get("vis") or {}
    outer = vis.get("outer", "s")
    solid_box(acc, b, idx, "FConcrete", top="FWalk")
    x0, y0, z0, x1, y1, z1 = box_range(b)
    inner = {"n": "s", "s": "n", "e": "w", "w": "e"}[outer]
    # 外側：控え壁（9m ごと）と、足元の帯
    P, W, _ = side_frame(b, outer)
    u = 4.5
    while u < W - 2:
        mid = (P(u, 0.0, 0.0))
        three = (mid.x, 0.5, -mid.y)
        if not covered((three[0] + {"e": 0.3, "w": -0.3}.get(outer, 0), 3, three[2] + {"n": -0.3, "s": 0.3}.get(outer, 0)), idx):
            face_box(acc, P, u - 0.7, u + 0.7, 0.0, y1 - 0.4, 0.0, 0.15, "FConcreteLight")
        u += 9.0
    face_box(acc, P, 0.0, W, 0.0, 0.7, 0.0, 0.1, "FConcreteDark")
    # 内側：壁の灯り（12m ごと）
    Pi, Wi, _ = side_frame(b, inner)
    u = 6.0
    while u < Wi - 3:
        mid = Pi(u, 4.5, 0.3)
        if not covered((mid.x, 4.5, -mid.y), idx):
            face_box(acc, Pi, u - 0.25, u + 0.25, 4.3, 4.55, 0.0, 0.16, "FMetalDark")
            face_rect(acc, Pi, u - 0.2, u + 0.2, 4.3, 4.32, 0.16, "FLightWarm")
        u += 12.0


def build_parapet(acc, b, idx):
    vis = b.get("vis") or {}
    if vis.get("bridge"):
        solid_box(acc, b, idx, "FConcreteLight", top="FMetal")
        return
    solid_box(acc, b, idx, "FConcreteLight", top="FConcrete")


def build_watchtower(acc, b, idx):
    vis = b.get("vis") or {}
    solid_box(acc, b, idx, "FConcrete", top="FWalk")
    x0, y0, z0, x1, y1, z1 = box_range(b)
    for side in exposed_sides(b, idx):
        P, W, _ = side_frame(b, side)
        # 足元のすそ・7m（防壁の上の高さ）と上の帯
        face_box(acc, P, 0, W, 0.0, 1.4, 0.0, 0.15, "FConcreteDark")
        face_box(acc, P, 0, W, 6.9, 7.15, 0.0, 0.1, "FConcreteLight")
        face_box(acc, P, 0, W, y1 - 0.45, y1 - 0.2, 0.0, 0.12, "FConcreteLight")
        # 細い窓（銃眼）
        n = max(1, int(W // 3.2))
        for i in range(n):
            u = (i + 0.5) * W / n
            for ya, yb in ((3.6, 5.2), (8.2, 9.8)):
                if yb > y1 - 0.5:
                    continue  # 低い塔（外の見張り台）
                mid = P(u, (ya + yb) / 2, 0.3)
                if covered((mid.x, (ya + yb) / 2, -mid.y), idx):
                    continue
                face_rect(acc, P, u - 0.22, u + 0.22, ya, yb, 0.015, "FGlass")
                face_box(acc, P, u - 0.35, u + 0.35, ya - 0.12, ya, 0.0, 0.08, "FConcreteLight")
        if vis.get("gate"):
            # ゲートの塔：ゲート側の面に紋章の板（ゲーム側で絵を貼る）
            pass


def build_cabin(acc, b, idx):
    x0, y0, z0, x1, y1, z1 = box_range(b)
    vis = b.get("vis") or {}
    if vis.get("roof"):
        wbox(acc, x0, y0, z0, x1, y1, z1, "FMetalDark", top="FConcreteDark", bottom="FMetal")
        # 屋根の縁
        wbox(acc, x0 - 0.02, y0 - 0.25, z0 - 0.02, x1 + 0.02, y0, z0 + 0.12, "FOliveDark")
        wbox(acc, x0 - 0.02, y0 - 0.25, z1 - 0.12, x1 + 0.02, y0, z1 + 0.02, "FOliveDark")
        # 屋根の下の窓枠（柱と柱のあいだ。ガラスはない＝弾は通る）
        ty = y0  # 屋根の下面
        by = ty - 1.9  # 胸壁の上
        X0, X1, Z0, Z1 = x0 + 0.65, x1 - 0.65, z0 + 0.65, z1 - 0.65
        for (ax, az, bx, bz) in ((X0, Z0, X1, Z0), (X0, Z1, X1, Z1), (X0, Z0, X0, Z1), (X1, Z0, X1, Z1)):
            L = math.hypot(bx - ax, bz - az)
            n = int(L // 1.3)
            for k in range(1, n):
                t = k / n
                px, pz = ax + (bx - ax) * t, az + (bz - az) * t
                acc.cyl(V(px, by, pz), V(px, ty, pz), 0.045, I4, "FMetalDark", n=5)
            acc.cyl(V(ax, ty - 0.12, az), V(bx, ty - 0.12, bz), 0.07, I4, "FMetalDark", n=5)
        return
    wbox(acc, x0, y0, z0, x1, y1, z1, "FMetalDark", skip=("bottom",))


def build_pier(acc, b, idx):
    x0, y0, z0, x1, y1, z1 = box_range(b)
    if (x1 - x0) < 1.2:
        wbox(acc, x0, y0, z0, x1, y1, z1, "FMetalDark", skip=("bottom",))
        return
    wbox(acc, x0, y0, z0, x1, y1, z1, "FConcrete", skip=("bottom",))
    wbox(acc, x0 - 0.12, 0.0, z0 - 0.12, x1 + 0.12, 0.9, z1 + 0.12, "FConcreteDark", skip=("bottom",))
    wbox(acc, x0 - 0.1, y1 - 0.5, z0 - 0.1, x1 + 0.1, y1, z1 + 0.1, "FConcreteLight", skip=("bottom",))


# ---------------------------------------------------------------------------
# 建物（格納庫・兵舎・別棟・塔）
# ---------------------------------------------------------------------------


def in_room(p, vis, margin=0.0):
    return vis.get("rx0", 1e9) - margin < p[0] < vis.get("rx1", -1e9) + margin and vis.get("rz0", 1e9) - margin < p[2] < vis.get("rz1", -1e9) + margin


def build_shell(acc, b, idx):
    """格納庫の外壁（中は暗い色、外はコンクリート）"""
    vis = b.get("vis") or {}
    x0, y0, z0, x1, y1, z1 = box_range(b)
    cx, cy, cz = (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2
    hx, hy, hz = (x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2
    faces = {}
    for k, (dx, dy, dz) in FACE_DIRS.items():
        p = (cx + dx * (hx + 0.3), cy + dy * (hy + 0.3), cz + dz * (hz + 0.3))
        inside = in_room(p, vis)
        if k == "bottom":
            faces[k] = "FMetalDark" if vis.get("lintel") else "FConcreteInner"
        elif k == "top":
            faces[k] = "FConcrete"
        else:
            faces[k] = "FConcreteInner" if inside else "FConcrete"
    solid_box(acc, b, idx, "FConcrete", faces=faces, skip_bottom=not vis.get("lintel"))
    # 大型ゲートのまぐさ：外側の下の縁に黄色と黒の縞、巻き上げたシャッター
    if vis.get("lintel") and vis.get("door") and y0 > 5:
        for side in ("e", "w", "n", "s"):
            P, W, n = side_frame(b, side)
            mid = P(W / 2, y0 + 0.3, 0.4)
            p3 = (mid.x, mid.y, mid.z)
            three = (p3[0], p3[2], -p3[1])
            if in_room(three, vis) or covered(three, idx):
                continue
            hazard_strip(acc, P, 0.0, W, y0 + 0.02, y0 + 0.45, 0.012, step=0.8)
        wbox(acc, x0 + 0.05, y0 - 0.02, z0 + 0.05, x1 - 0.05, y0 + 0.0, z1 - 0.05, "FMetal", skip=("top",))


def build_slab(acc, b, idx):
    vis = b.get("vis") or {}
    if vis.get("roof"):
        solid_box(acc, b, idx, "FConcrete", top="FWalk", bottom="FMetalDark", skip_bottom=False)
    else:
        solid_box(acc, b, idx, "FConcrete", top="FWalk", bottom="FConcreteInner", skip_bottom=False)


def build_deck(acc, b, idx):
    vis = b.get("vis") or {}
    x0, y0, z0, x1, y1, z1 = box_range(b)
    if vis.get("catwalk"):
        wbox(acc, x0, y0, z0, x1, y1, z1, "FMetalDark", top="FGrating")
        # 開いた縁（東）の手すり（細い。見た目だけ）
        ex = x1 if x1 < 0 else x0
        n = int((z1 - z0) // 1.6)
        for k in range(n + 1):
            z = z0 + (z1 - z0) * k / max(1, n)
            if z1 - z < 3.4:  # 階段の上りきった所は空ける
                continue
            acc.cyl(V(ex, y1, z), V(ex, y1 + 1.05, z), 0.03, I4, "FMarkYellow", n=5)
        acc.cyl(V(ex, y1 + 1.05, z0), V(ex, y1 + 1.05, z1 - 3.4), 0.035, I4, "FMarkYellow", n=5)
        return
    solid_box(acc, b, idx, "FConcrete", top="FWalk", bottom="FConcreteDark", skip_bottom=False)


def window_row(acc, P, W, y0, y1, step, margin, idx, d=0.015, sill=True):
    n = int((W - margin * 2) // step)
    if n <= 0:
        return
    for i in range(n):
        u = margin + (i + 0.5) * (W - margin * 2) / n
        mid = P(u, (y0 + y1) / 2, 0.3)
        if covered((mid.x, (y0 + y1) / 2, -mid.y), idx):
            continue
        face_rect(acc, P, u - step * 0.32, u + step * 0.32, y0, y1, d, "FGlass")
        face_box(acc, P, u - step * 0.36, u + step * 0.36, y1, y1 + 0.12, 0.0, 0.06, "FConcreteLight")
        if sill:
            face_box(acc, P, u - step * 0.36, u + step * 0.36, y0 - 0.1, y0, 0.0, 0.1, "FConcreteLight")


def build_building(acc, b, idx):
    vis = b.get("vis") or {}
    style = vis.get("style", "barracks")
    solid_box(acc, b, idx, "FConcrete", top="FWalk")
    x0, y0, z0, x1, y1, z1 = box_range(b)
    H = y1
    for side in exposed_sides(b, idx):
        P, W, _ = side_frame(b, side)
        face_box(acc, P, 0, W, 0.0, 0.6, 0.0, 0.1, "FConcreteDark")
        if style == "barracks":
            window_row(acc, P, W, 2.0, 3.2, 3.0, 1.0, idx)
            # 扉（一つ）
            u = W * 0.3
            mid = P(u, 1.1, 0.3)
            if not covered((mid.x, 1.1, -mid.y), idx):
                face_rect(acc, P, u - 0.6, u + 0.6, 0.0, 2.2, 0.02, "FMetalDark")
                face_box(acc, P, u - 0.85, u + 0.85, 2.2, 2.4, 0.0, 0.18, "FConcreteLight")
            face_box(acc, P, 0, W, H - 0.35, H, 0.0, 0.08, "FConcreteLight")
        elif style == "annex":
            # 縦のひれ（2m ごと）と、窓の帯
            u = 1.0
            while u < W - 0.5:
                face_box(acc, P, u - 0.15, u + 0.15, 0.6, H - 0.6, 0.0, 0.15, "FConcreteLight")
                u += 2.0
            face_rect(acc, P, 0.2, W - 0.2, 6.4, 8.6, 0.01, "FGlass")
            face_box(acc, P, 0, W, 8.6, 9.0, 0.0, 0.12, "FConcreteLight")
            face_box(acc, P, 0, W, 6.0, 6.4, 0.0, 0.12, "FConcreteLight")
        else:  # tower
            y = 4.0
            while y < H - 5:
                face_box(acc, P, 0, W, y, y + 0.25, 0.0, 0.1, "FConcreteLight")
                y += 4.0
            face_rect(acc, P, 0.4, W - 0.4, H - 4.6, H - 2.2, 0.01, "FGlass")
            face_box(acc, P, 0, W, H - 2.2, H - 1.8, 0.0, 0.15, "FConcreteDark")
            face_box(acc, P, 0, W, H - 5.0, H - 4.6, 0.0, 0.15, "FConcreteDark")
            window_row(acc, P, W, 6.0, 7.0, 2.4, 1.0, idx)
            window_row(acc, P, W, 10.0, 11.0, 2.4, 1.0, idx)


def build_ac(acc, b, idx):
    M = box_matrix(b)
    h = box_half(b)
    acc.box(-h, h, M, "FMetal", skip=("bottom",))
    acc.disc((0, 0, h.z + 0.01), min(h.x, h.y) * 0.7, M, "FMetalDark", n=16)
    for k in range(4):
        y = -h.y + (k + 0.5) * 2 * h.y / 4
        acc.poly([(h.x + 0.01, y - 0.15, -h.z + 0.2), (h.x + 0.01, y + 0.15, -h.z + 0.2), (h.x + 0.01, y + 0.15, h.z - 0.2), (h.x + 0.01, y - 0.15, h.z - 0.2)], "FMetalDark", M=M)


# ---------------------------------------------------------------------------
# 連絡橋・コアの台座
# ---------------------------------------------------------------------------


def build_bridgedeck(acc, b, idx):
    vis = b.get("vis") or {}
    x0, y0, z0, x1, y1, z1 = box_range(b)
    if vis.get("roof"):
        wbox(acc, x0, y0, z0, x1, y1, z1, "FConcreteLight", top="FConcrete", bottom="FMetal")
        # 屋根の上の筋（0.08m）
        x = x0 + 1.0
        while x < x1 - 0.5:
            wbox(acc, x - 0.06, y1, z0 + 0.1, x + 0.06, y1 + 0.08, z1 - 0.1, "FConcreteDark", skip=("bottom",))
            x += 2.0
        # 天井の灯り
        x = x0 + 3.0
        while x < x1:
            wquad = [V(x - 1.2, y0 - 0.01, (z0 + z1) / 2 - 0.25), V(x + 1.2, y0 - 0.01, (z0 + z1) / 2 - 0.25), V(x + 1.2, y0 - 0.01, (z0 + z1) / 2 + 0.25), V(x - 1.2, y0 - 0.01, (z0 + z1) / 2 + 0.25)]
            acc.poly(wquad, "FLightWarm")
            x += 6.0
        # トラス（腰壁の上から屋根まで。斜めの部材。見た目だけ）
        y_lo = y0 - 2.5
        for z in (z0 + 0.85, z1 - 0.85):
            xs = list(range(int(x0 + 0.5), int(x1), 8))
            for i in range(len(xs) - 1):
                a, c = xs[i], xs[i + 1]
                m = (a + c) / 2
                acc.cyl(V(a, y_lo, z), V(m, y0, z), 0.07, I4, "FMetal", n=5)
                acc.cyl(V(m, y0, z), V(c, y_lo, z), 0.07, I4, "FMetal", n=5)
            acc.cyl(V(x0 + 0.5, y_lo + 0.05, z), V(x1 - 0.5, y_lo + 0.05, z), 0.08, I4, "FMetal", n=5)
        return
    wbox(acc, x0, y0, z0, x1, y1, z1, "FConcreteLight", top="FWalk", bottom="FConcreteDark")
    # 床の下の梁（深さ 0.18m）と、横の黄色の帯
    for z in (z0 + 1.0, (z0 + z1) / 2, z1 - 1.0):
        wbox(acc, x0, y0 - 0.18, z - 0.15, x1, y0, z + 0.15, "FMetal", skip=("top",))
    for z, d in ((z0, -1), (z1, 1)):
        acc.poly([V(x0, y0 + 0.25, z + d * 0.012), V(x1, y0 + 0.25, z + d * 0.012), V(x1, y0 + 0.4, z + d * 0.012), V(x0, y0 + 0.4, z + d * 0.012)][:: (1 if d > 0 else -1)], "FMarkYellow")


def build_corepad(acc, b, idx):
    x0, y0, z0, x1, y1, z1 = box_range(b)
    wbox(acc, x0, y0, z0, x1, y1, z1, "FConcreteDark", top="FConcrete", skip=("bottom",))
    # 縁の黄色と黒の縞（上面）
    y = y1 + 0.006
    band = 0.55
    for (ax, az, bx, bz) in ((x0, z0, x1, z0 + band), (x0, z1 - band, x1, z1), (x0, z0 + band, x0 + band, z1 - band), (x1 - band, z0 + band, x1, z1 - band)):
        horiz = (bx - ax) > (bz - az)
        L = (bx - ax) if horiz else (bz - az)
        n = int(L // 0.8)
        for k in range(n):
            mat = "FMarkYellow" if k % 2 == 0 else "FHazardBlack"
            if horiz:
                wquad_y(acc, ax + L * k / n, az, ax + L * (k + 1) / n, bz, y, mat)
            else:
                wquad_y(acc, ax, az + L * k / n, bx, az + L * (k + 1) / n, y, mat)
    # 光る溝（コアのまわりの輪）
    cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
    acc.ring(V(cx, y + 0.002, cz), 3.05, 3.2, I4, "FLightCyan", n=48)
    acc.ring(V(cx, y + 0.002, cz), 3.9, 3.98, I4, "FLightCyan", n=48)


# ---------------------------------------------------------------------------
# 車両・コンテナ・小物
# ---------------------------------------------------------------------------


def wheel(acc, M, x, y, z, r, w, n=12):
    """車輪（x の向きに幅 w の円柱）。ホイールの中心を少し明るく"""
    s = 1 if x > 0 else -1
    acc.cyl((x - s * w / 2, y, z), (x + s * w / 2, y, z), r, M, "FRubber", n=n, cap_mat="FRubber")
    acc.disc((0, 0, 0), r * 0.5, M @ Matrix.Translation((x + s * (w / 2 + 0.005), y, z)) @ Matrix.Rotation(math.pi / 2 * s, 4, "Y"), "FOliveDark", n=n)


def build_truck(acc, b, idx):
    M = box_matrix(b)
    h = box_half(b)  # x：幅の半分、y：長さの半分、z：高さの半分
    vis = b.get("vis") or {}
    kind = vis.get("kind", "cargo")
    W, L, H = h.x, h.y, h.z
    zb = -H  # 地面
    r = 0.55
    for y in (L - 1.3, -L + 2.6, -L + 1.25):
        for s in (-1, 1):
            wheel(acc, M, s * (W - 0.22), y, zb + r, r, 0.42)
    # 車台
    acc.box((-W + 0.45, -L + 0.1, zb + 0.5), (W - 0.45, L - 0.1, zb + 0.95), M, "FMetalDark")
    # 運転台（前 = +y）
    cab0 = L - 2.0
    acc.box((-W + 0.05, cab0, zb + 0.95), (W - 0.05, L - 0.15, zb + 2.45), M, "FOlive")
    acc.box((-W + 0.1, L - 0.95, zb + 0.95), (W - 0.1, L - 0.02, zb + 1.7), M, "FOlive")  # ボンネット
    acc.poly([(-W + 0.2, L - 0.16, zb + 1.85), (W - 0.2, L - 0.16, zb + 1.85), (W - 0.2, L - 0.16, zb + 2.35), (-W + 0.2, L - 0.16, zb + 2.35)][::-1], "FGlass", M=M)
    for s in (-1, 1):
        x = s * (W - 0.04)
        pts = [(x, cab0 + 0.25, zb + 1.75), (x, L - 1.05, zb + 1.75), (x, L - 1.05, zb + 2.3), (x, cab0 + 0.25, zb + 2.3)]
        acc.poly(pts if s > 0 else pts[::-1], "FGlass", M=M)
    acc.box((-W + 0.25, L - 0.06, zb + 1.0), (W - 0.25, L, zb + 1.5), M, "FMetalDark")  # 前の格子
    for s in (-1, 1):
        acc.box((s * (W - 0.45) - 0.18, L - 0.03, zb + 1.2), (s * (W - 0.45) + 0.18, L, zb + 1.38), M, "FLightWarm")
    # 荷台
    if kind == "tanker":
        acc.cyl((0, -L + 0.3, zb + 2.0), (0, cab0 - 0.2, zb + 2.0), W - 0.2, M, "FOlive", n=18)
        for y in (-L + 1.4, -L + 3.2, cab0 - 1.3):
            acc.cyl((0, y - 0.06, zb + 2.0), (0, y + 0.06, zb + 2.0), W - 0.12, M, "FOliveDark", n=18)
        acc.box((-0.3, -L + 1.0, zb + 2.0 + W - 0.3), (0.3, -L + 1.6, zb + 2.0 + W - 0.05), M, "FMetalDark")
    else:
        acc.box((-W + 0.02, -L + 0.05, zb + 0.95), (W - 0.02, cab0 - 0.1, zb + 1.35), M, "FOliveDark")
        acc.box((-W + 0.05, -L + 0.1, zb + 1.35), (W - 0.05, cab0 - 0.15, zb + 2.75), M, "FCanvas")
        # 幌の丸い屋根
        acc.poly([(-W + 0.05, -L + 0.1, zb + 2.75), (W - 0.05, -L + 0.1, zb + 2.75), (W - 0.35, -L + 0.1, zb + 3.15), (-W + 0.35, -L + 0.1, zb + 3.15)][::-1], "FCanvas", M=M)
        acc.poly([(-W + 0.05, cab0 - 0.15, zb + 2.75), (W - 0.05, cab0 - 0.15, zb + 2.75), (W - 0.35, cab0 - 0.15, zb + 3.15), (-W + 0.35, cab0 - 0.15, zb + 3.15)], "FCanvas", M=M)
        acc.poly([(W - 0.05, -L + 0.1, zb + 2.75), (W - 0.05, cab0 - 0.15, zb + 2.75), (W - 0.35, cab0 - 0.15, zb + 3.15), (W - 0.35, -L + 0.1, zb + 3.15)][::-1], "FCanvas", M=M)
        acc.poly([(-W + 0.05, -L + 0.1, zb + 2.75), (-W + 0.05, cab0 - 0.15, zb + 2.75), (-W + 0.35, cab0 - 0.15, zb + 3.15), (-W + 0.35, -L + 0.1, zb + 3.15)], "FCanvas", M=M)
        acc.poly([(-W + 0.35, -L + 0.1, zb + 3.15), (W - 0.35, -L + 0.1, zb + 3.15), (W - 0.35, cab0 - 0.15, zb + 3.15), (-W + 0.35, cab0 - 0.15, zb + 3.15)], "FCanvas", M=M)
        y = -L + 0.6
        while y < cab0 - 0.4:
            acc.box((-W + 0.02, y - 0.04, zb + 1.35), (W - 0.02, y + 0.04, zb + 2.78), M, "FOliveDark")
            y += 1.2


def build_apc(acc, b, idx):
    M = box_matrix(b)
    h = box_half(b)
    W, L, H = h.x, h.y, h.z
    zb = -H
    r = 0.5
    for y in (-L + 1.0, -L + 2.45, L - 2.45, L - 1.0):
        for s in (-1, 1):
            wheel(acc, M, s * (W - 0.25), y, zb + r, r, 0.45)
    # 車体（横から見ると前が斜め）。断面を x の向きに押し出す
    prof = [(-L + 0.05, zb + 0.6), (L - 0.6, zb + 0.6), (L - 0.02, zb + 1.15), (L - 1.3, zb + 1.95), (-L + 0.3, zb + 1.95), (-L + 0.05, zb + 1.6)]
    w = W - 0.5
    for i in range(len(prof)):
        a = prof[i]
        c = prof[(i + 1) % len(prof)]
        acc.poly([(-w, a[0], a[1]), (-w, c[0], c[1]), (w, c[0], c[1]), (w, a[0], a[1])][::-1], "FOlive", M=M)
    acc.poly([(w, p[0], p[1]) for p in prof], "FOlive", M=M)
    acc.poly([(-w, p[0], p[1]) for p in reversed(prof)], "FOlive", M=M)
    # 車輪の上の張り出し
    for s in (-1, 1):
        acc.box((s * w - (0.3 if s > 0 else 0) + (0 if s > 0 else -0.0), -L + 0.4, zb + 1.05), (s * w + (0.3 if s > 0 else 0), L - 0.4, zb + 1.2), M, "FOliveDark") if s > 0 else acc.box((-w - 0.3, -L + 0.4, zb + 1.05), (-w, L - 0.4, zb + 1.2), M, "FOliveDark")
    # 砲塔
    acc.box((-0.75, -0.6, zb + 1.95), (0.75, 0.9, zb + 2.45), M, "FOliveDark")
    acc.cyl((0, 0.9, zb + 2.22), (0, L + 0.15, zb + 2.22), 0.07, M, "FMetalDark", n=8)
    acc.box((-0.35, -L + 0.05, zb + 0.9), (0.35, -L + 0.02, zb + 1.5), M, "FMetalDark")  # 後ろの扉
    for s in (-1, 1):
        acc.box((s * 0.9 - 0.15, L - 0.6, zb + 1.2), (s * 0.9 + 0.15, L - 0.45, zb + 1.32), M, "FLightWarm")


CONTAINER_MAT = {"olive": "FOlive", "tan": "FTan"}


def build_container(acc, b, idx):
    M = box_matrix(b)
    h = box_half(b)
    mat = CONTAINER_MAT.get((b.get("vis") or {}).get("color"), "FOlive")
    acc.box(-h, h, M, mat, top="FOliveDark" if mat == "FOlive" else "FTan")
    # 波板（長い面の縦の筋）
    y = -h.y + 0.3
    while y < h.y - 0.2:
        for s in (-1, 1):
            x = s * h.x
            acc.poly([(x, y - 0.07, -h.z + 0.12), (x, y + 0.07, -h.z + 0.12), (x, y + 0.07, h.z - 0.12), (x, y - 0.07, h.z - 0.12)][:: (1 if s > 0 else -1)], "FOliveDark" if mat == "FOlive" else "FTanDark", M=M @ Matrix.Translation((s * 0.03, 0, 0)))
        y += 0.42
    # 扉（-y の端）と角の金具
    for s in (-1, 1):
        for k in (-0.6, 0.6):
            acc.box((s * 0.6 + k * 0.25 - 0.03, -h.y - 0.05, -h.z + 0.2), (s * 0.6 + k * 0.25 + 0.03, -h.y, h.z - 0.2), M, "FMetalDark")
    for sx in (-1, 1):
        for sy in (-1, 1):
            for sz in (-1, 1):
                c = Vector((sx * (h.x - 0.09), sy * (h.y - 0.09), sz * (h.z - 0.09)))
                acc.box(c - Vector((0.1, 0.1, 0.1)), c + Vector((0.1, 0.1, 0.1)), M, "FMetalDark")


def build_crate(acc, b, idx):
    M = box_matrix(b)
    h = box_half(b)
    acc.box(-h, h, M, "FWood")
    e = 0.09
    for sx in (-1, 1):
        for sy in (-1, 1):
            acc.box((sx * h.x - (e if sx > 0 else -e) * 1 - 0.0 if False else min(sx * h.x, sx * (h.x - e)), min(sy * h.y, sy * (h.y - e)), -h.z), (max(sx * h.x, sx * (h.x - e)) + 0.01 * sx, max(sy * h.y, sy * (h.y - e)) + 0.01 * sy, h.z), M, "FWoodDark")
    for sz in (-1, 1):
        acc.box((-h.x - 0.01, -h.y - 0.01, sz * h.z - (e if sz > 0 else 0)), (h.x + 0.01, h.y + 0.01, sz * h.z + (0 if sz > 0 else e)), M, "FWoodDark", skip=("top", "bottom"))


def build_barrier(acc, b, idx):
    vis = b.get("vis") or {}
    if vis.get("invisible") or b.get("kind") == "boundary":
        return
    r = b.get("rot") or {"x": 0, "y": 0, "z": 0}
    M = box_matrix(b)
    h = box_half(b)
    if abs(r["x"]) > 0.01:
        acc.box(-h, h, M, "FConcreteLight", skip=("bottom",))
        return
    # ジャージー壁の断面（幅 0.8・高さ 1.1）を長さ方向へ押し出す
    w, H = h.x, h.z
    prof = [(-w, -H), (w, -H), (w, -H + 0.15), (w * 0.45, -H + 0.38), (w * 0.38, H), (-w * 0.38, H), (-w * 0.45, -H + 0.38), (-w, -H + 0.15)]
    L = h.y * 2 - 0.04
    for i in range(len(prof)):
        a = prof[i]
        c = prof[(i + 1) % len(prof)]
        acc.poly([(a[0], -L / 2, a[1]), (a[0], L / 2, a[1]), (c[0], L / 2, c[1]), (c[0], -L / 2, c[1])], "FConcreteLight", M=M)
    acc.poly([(p[0], L / 2, p[1]) for p in reversed(prof)], "FConcreteLight", M=M)
    acc.poly([(p[0], -L / 2, p[1]) for p in prof], "FConcreteLight", M=M)
    # 反射板（黄色）
    for s in (-1, 1):
        x = s * (w * 0.4 + 0.012)
        pts = [(x, -0.25, H - 0.32), (x, 0.25, H - 0.32), (x, 0.25, H - 0.18), (x, -0.25, H - 0.18)]
        acc.poly(pts if s > 0 else pts[::-1], "FMarkYellow", M=M)


def build_sandbag(acc, b, idx):
    M = box_matrix(b)
    h = box_half(b)
    rows = [(-h.z, -h.z + 0.34, 0.0), (-h.z + 0.32, -h.z + 0.66, 0.4), (-h.z + 0.64, h.z - 0.02, 0.0)]
    for ri, (z0, z1, off) in enumerate(rows):
        x = -h.x + off
        while x < h.x - 0.2:
            x1 = min(h.x, x + 0.78)
            inset = 0.06 * ri
            # 角を落とした袋（断面の八角形を x の向きに）
            yy = h.y - inset
            cz = (z0 + z1) / 2
            hz = (z1 - z0) / 2
            prof = [(-yy, cz - hz * 0.6), (-yy * 0.7, cz - hz), (yy * 0.7, cz - hz), (yy, cz - hz * 0.6), (yy, cz + hz * 0.6), (yy * 0.7, cz + hz), (-yy * 0.7, cz + hz), (-yy, cz + hz * 0.6)]
            for i in range(len(prof)):
                a = prof[i]
                c = prof[(i + 1) % len(prof)]
                acc.poly([(x + 0.03, a[0], a[1]), (x + 0.03, c[0], c[1]), (x1 - 0.03, c[0], c[1]), (x1 - 0.03, a[0], a[1])][::-1], "FSandbag", M=M)
            acc.poly([(x1 - 0.03, p[0], p[1]) for p in prof][::-1], "FSandbag", M=M)
            acc.poly([(x + 0.03, p[0], p[1]) for p in prof], "FSandbag", M=M)
            x = x1


def build_fueltank(acc, b, idx):
    vis = b.get("vis") or {}
    if vis.get("octagon", 0) != 0:
        return
    c = b["center"]
    s = b["size"]
    r = float(vis.get("r", 2.5))
    y0 = c["y"] - s["y"] / 2
    y1 = c["y"] + s["y"] / 2
    base = V(c["x"], y0, c["z"])
    top = V(c["x"], y1, c["z"])
    acc.cyl(base, top - Vector((0, 0, 0.3)), r * 0.98, I4, "FTank", n=24, caps=False)
    acc.cyl(top - Vector((0, 0, 0.3)), top + Vector((0, 0, 0.45)), r * 0.98, I4, "FTank", n=24, r2=r * 0.25, caps=False)
    for t in (0.25, 0.55, 0.85):
        z = y0 + (y1 - y0) * t
        acc.cyl(V(c["x"], z - 0.05, c["z"]), V(c["x"], z + 0.05, c["z"]), r, I4, "FMetalDark", n=24, caps=False)
    # はしご
    for dx in (-0.25, 0.25):
        acc.cyl(V(c["x"] + dx, y0 + 0.3, c["z"] + r + 0.08), V(c["x"] + dx, y1, c["z"] + r + 0.08), 0.03, I4, "FMetalDark", n=5)
    yy = y0 + 0.5
    while yy < y1:
        acc.cyl(V(c["x"] - 0.25, yy, c["z"] + r + 0.08), V(c["x"] + 0.25, yy, c["z"] + r + 0.08), 0.025, I4, "FMetalDark", n=4)
        yy += 0.4
    # 注意の帯
    acc.cyl(V(c["x"], y0 + 1.6, c["z"]), V(c["x"], y0 + 1.95, c["z"]), r * 1.0, I4, "FMarkYellow", n=24, caps=False)


def build_rock(acc, b, idx, bg=False):
    M = box_matrix(b)
    h = box_half(b)
    seed = int((b.get("vis") or {}).get("seed", 7))
    acc.blob((0, 0, 0), 1.0, M @ Matrix.Diagonal((h.x * 0.98, h.y * 0.98, h.z * 1.0, 1)), "FRock", sub=1, jitter=0.28, seed=seed)
    rr = random.Random(seed + 3)
    for k in range(2):
        a = rr.uniform(0, math.pi * 2)
        rad = max(h.x, h.y) * rr.uniform(0.25, 0.4)
        p = Vector((math.cos(a) * (h.x + rad * 0.2), math.sin(a) * (h.y + rad * 0.2), -h.z + rad * 0.3))
        acc.blob(p, rad, M, "FRock", sub=1, jitter=0.3, squash=(1, 1, 0.7), seed=seed + k + 10)


def build_dock(acc, b, idx):
    solid_box(acc, b, idx, "FConcrete", top="FWalk")
    x0, y0, z0, x1, y1, z1 = box_range(b)
    P, W, _ = side_frame(b, "w")
    face_rect(acc, P, 0, W, y1 - 0.15, y1 - 0.02, 0.012, "FMarkYellow")
    u = 1.2
    while u < W - 0.5:
        face_box(acc, P, u - 0.25, u + 0.25, 0.35, 1.15, 0.0, 0.15, "FRubber")
        u += 2.2
    wquad_y(acc, x0 + 0.05, z0 + 0.05, x0 + 0.35, z1 - 0.05, y1 + 0.006, "FMarkYellow")


def build_canopy(acc, b, idx):
    x0, y0, z0, x1, y1, z1 = box_range(b)
    wbox(acc, x0, y0, z0, x1, y1, z1, "FMetalDark", top="FOliveDark", bottom="FMetal")
    x = x0 + 1.5
    while x < x1:
        wbox(acc, x - 0.12, y0 - 0.18, z0 + 0.1, x + 0.12, y0, z1 - 0.1, "FMetalDark", skip=("top",))
        x += 3.0
    # 縁の縞
    b2 = {"center": b["center"], "size": b["size"]}
    P, W, _ = side_frame(b2, "e")
    hazard_strip(acc, P, 0, W, y0 + 0.08, y1 - 0.08, 0.012, step=0.9)


def build_stairs(acc, b, idx):
    M = box_matrix(b)
    h = box_half(b)
    acc.box(-h, h, M, "FConcrete", top="FWalk", skip=("bottom",))
    # 段の先の黄色の線
    acc.poly([(-h.x + 0.1, -h.y, h.z + 0.005), (h.x - 0.1, -h.y, h.z + 0.005), (h.x - 0.1, -h.y + 0.08, h.z + 0.005), (-h.x + 0.1, -h.y + 0.08, h.z + 0.005)], "FMarkYellow", M=M)
    acc.poly([(-h.x + 0.1, h.y, h.z + 0.005), (h.x - 0.1, h.y, h.z + 0.005), (h.x - 0.1, h.y - 0.08, h.z + 0.005), (-h.x + 0.1, h.y - 0.08, h.z + 0.005)][::-1], "FMarkYellow", M=M)


def build_ruin(acc, b, idx):
    """崩れたコンクリートの壁（要塞の外）。上の縁は崩れて斜めにぎざぎざ、鉄筋が飛び出し、足元にがれき"""
    x0, y0, z0, x1, y1, z1 = box_range(b)
    seed = int((b.get("vis") or {}).get("seed", 3))
    rr = random.Random(seed)
    along_x = (x1 - x0) >= (z1 - z0)
    L = (x1 - x0) if along_x else (z1 - z0)
    T = (z1 - z0) if along_x else (x1 - x0)
    # 上の縁は、当たり判定の箱の上面のまわり（少し下〜少し上）で崩す（大きな形は、高さの違う箱の並びで作ってある）
    low = y1 - 0.25
    high = y1 + 0.35
    # 上の縁の高さの並び（0.5〜1.1m ごと。ときどき大きく欠ける）
    us = [0.0]
    while us[-1] < L - 0.3:
        us.append(min(L, us[-1] + rr.uniform(0.5, 1.1)))
    us[-1] = L
    hs = []
    h = rr.uniform(low, high)
    for i, u in enumerate(us):
        h = max(low, min(high, h + rr.uniform(-0.3, 0.3)))
        hs.append(h)

    def P(u, y, t):
        """壁の座標（u：長さの向き、t：厚みの向き 0〜1）→ Blender の点"""
        if along_x:
            return V(x0 + u, y, z0 + t * T)
        return V(x0 + t * T, y, z0 + u)

    base = y0
    for i in range(len(us) - 1):
        ua, ub = us[i], us[i + 1]
        ha, hb = hs[i], hs[i + 1]
        # 両側の面（台形）と、斜めの上の面
        for t, flip in ((0.0, False), (1.0, True)):
            q = [P(ua, base, t), P(ub, base, t), P(ub, hb, t), P(ua, ha, t)]
            if along_x == flip:
                q = q[::-1]
            acc.poly(q, "FConcrete")
        top = [P(ua, ha, 0.0), P(ub, hb, 0.0), P(ub, hb, 1.0), P(ua, ha, 1.0)]
        if not along_x:
            top = top[::-1]
        acc.poly(top, "FConcreteLight")
        # 鉄筋
        if rr.random() < 0.4:
            u = (ua + ub) / 2
            hh = (ha + hb) / 2
            for k in range(rr.randint(1, 3)):
                t = rr.uniform(0.25, 0.75)
                p0 = P(u + rr.uniform(-0.2, 0.2), hh - 0.1, t)
                p1 = p0 + Vector((rr.uniform(-0.25, 0.25), rr.uniform(-0.25, 0.25), rr.uniform(0.3, 0.9)))
                acc.cyl(p0, p1, 0.016, I4, "FMetalDark", n=4)
    # 両端の面
    for u, hh, sgn in ((0.0, hs[0], -1), (L, hs[-1], 1)):
        q = [P(u, base, 0.0), P(u, base, 1.0), P(u, hh, 1.0), P(u, hh, 0.0)]
        if (sgn > 0) != along_x:
            q = q[::-1]
        acc.poly(q, "FConcreteDark")
    # 足元のがれき（大きな塊と、細かい破片）
    for k in range(int(L / 1.6) + 3):
        u = rr.uniform(0.2, L - 0.2)
        side = rr.choice((-1, 1))
        t = 0.5 + side * (0.5 + rr.uniform(0.15, 0.9) / max(0.5, T))
        r = rr.uniform(0.14, 0.45) if rr.random() < 0.7 else rr.uniform(0.45, 0.75)
        p = P(u, y0 + 0.5 + r * 0.25, t)
        acc.blob(p, r, I4, "FConcreteDark" if rr.random() < 0.6 else "FConcrete", sub=1, jitter=0.4, squash=(1, 1, 0.6), seed=seed + k)


def build_dirtpatch(acc, d):
    """草原の土の地面（ぎざぎざの縁の円）"""
    p = d["pos"]
    pr = d.get("params") or {}
    r = float(pr.get("r", 5))
    rr = random.Random(int(p["x"] * 7 + p["z"] * 3))
    n = 16
    c = V(p["x"], p["y"] + 0.011, p["z"])
    pts = []
    for k in range(n):
        a = k / n * math.pi * 2
        rad = r * rr.uniform(0.7, 1.15)
        pts.append(c + Vector((math.cos(a) * rad, math.sin(a) * rad, 0)))
    for k in range(n):
        acc.poly([c, pts[k], pts[(k + 1) % n]], "FDirt")


def build_crater(acc, d):
    """砲弾の跡（焦げた真ん中・土の盛り上がった縁）"""
    p = d["pos"]
    pr = d.get("params") or {}
    r = float(pr.get("r", 2.5))
    rr = random.Random(int(p["x"] * 5 + p["z"] * 11))
    c = V(p["x"], p["y"], p["z"])
    n = 14
    for k in range(n):
        a0, a1 = k / n * math.pi * 2, (k + 1) / n * math.pi * 2
        acc.poly([c + Vector((0, 0, 0.012)), c + Vector((math.cos(a0) * r, math.sin(a0) * r, 0.012)), c + Vector((math.cos(a1) * r, math.sin(a1) * r, 0.012))], "FDirt")
        acc.poly([c + Vector((0, 0, 0.016)), c + Vector((math.cos(a0) * r * 0.45, math.sin(a0) * r * 0.45, 0.016)), c + Vector((math.cos(a1) * r * 0.45, math.sin(a1) * r * 0.45, 0.016))], "FRubber")
    for k in range(9):
        a = rr.uniform(0, math.pi * 2)
        rad = r * rr.uniform(0.85, 1.1)
        q = c + Vector((math.cos(a) * rad, math.sin(a) * rad, 0.05))
        acc.blob(q, rr.uniform(0.3, 0.6), I4, "FDirt", sub=1, jitter=0.35, squash=(1.4, 1.0, 0.35), seed=k + int(p["x"]))


def build_plain(acc, b, idx, mat="FConcrete"):
    r = b.get("rot") or {"x": 0, "y": 0, "z": 0}
    if abs(r["x"]) > 0.01 or abs(r["y"]) > 0.01:
        acc.box(-box_half(b), box_half(b), box_matrix(b), mat, skip=("bottom",))
    else:
        solid_box(acc, b, idx, mat, top="FWalk")


# ---------------------------------------------------------------------------
# 飾り（当たり判定なし）
# ---------------------------------------------------------------------------


def dpos(d):
    return V(d["pos"]["x"], d["pos"]["y"], d["pos"]["z"])


def build_antenna(acc, d):
    p = dpos(d)
    hgt = float((d.get("params") or {}).get("h", 4))
    w0, w1 = 0.35, 0.08
    legs = [Vector((sx, sy, 0)) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    for lg in legs:
        acc.cyl(p + lg * w0, p + lg * w1 + Vector((0, 0, hgt)), 0.03, I4, "FMetalDark", n=4)
    k = 0.8
    while k < hgt - 0.2:
        t = k / hgt
        w = w0 + (w1 - w0) * t
        for i in range(4):
            a = legs[i] * w + Vector((0, 0, k))
            c = legs[(i + 1) % 4] * w + Vector((0, 0, k))
            acc.cyl(p + a, p + c, 0.02, I4, "FMetalDark", n=4)
        k += 0.9
    acc.cyl(p + Vector((0, 0, hgt)), p + Vector((0, 0, hgt + 1.2)), 0.025, I4, "FMetal", n=4)
    acc.box((-0.08, -0.08, 0), (0.08, 0.08, 0.16), Matrix.Translation(p + Vector((0, 0, hgt + 1.2))), "FLightRed")


def build_radar(acc, d):
    p = dpos(d)
    pr = d.get("params") or {}
    r = float(pr.get("r", 3))
    acc.cyl(p, p + Vector((0, 0, 1.6)), 0.7, I4, "FMetalDark", n=12)
    acc.cyl(p + Vector((0, 0, 1.6)), p + Vector((0, 0, 2.1)), 1.0, I4, "FMetal", n=12)
    if pr.get("dish"):
        # 皿形のアンテナ（斜め上を向く）
        M = Matrix.Translation(p + Vector((0, 0, 2.6 + r * 0.5))) @ Matrix.Rotation(math.radians(-35), 4, "X")
        n = 20
        rings = [(0.0, 0.0), (r * 0.35, r * 0.04), (r * 0.7, r * 0.16), (r, r * 0.36)]
        for i in range(len(rings) - 1):
            (ra, za), (rb, zb2) = rings[i], rings[i + 1]
            for k in range(n):
                t0 = k / n * 2 * math.pi
                t1 = (k + 1) / n * 2 * math.pi
                q = [(math.cos(t0) * ra, math.sin(t0) * ra, za), (math.cos(t1) * ra, math.sin(t1) * ra, za), (math.cos(t1) * rb, math.sin(t1) * rb, zb2), (math.cos(t0) * rb, math.sin(t0) * rb, zb2)]
                acc.poly(q, "FTank", M=M)
                acc.poly(q[::-1], "FMetal", M=M)
        acc.cyl((0, 0, 0), (0, 0, r * 0.9), 0.08, M, "FMetalDark", n=6)
        acc.cyl(p + Vector((0, 0, 2.1)), p + Vector((0, 0, 2.6 + r * 0.5)), 0.25, I4, "FMetalDark", n=8)
    else:
        # 回る棒形のレーダー
        M = Matrix.Translation(p + Vector((0, 0, 2.4)))
        acc.box((-r, -0.15, -0.3), (r, 0.15, 0.3), M, "FTank")
        acc.box((-r, 0.15, -0.25), (r, 0.18, 0.25), M, "FMetalDark")
        acc.cyl(p + Vector((0, 0, 2.1)), p + Vector((0, 0, 2.4)), 0.2, I4, "FMetalDark", n=8)


def build_searchlight(acc, d):
    p = dpos(d)
    acc.cyl(p, p + Vector((0, 0, 0.6)), 0.08, I4, "FMetalDark", n=6)
    M = Matrix.Translation(p + Vector((0, 0, 0.8))) @ Matrix.Rotation(math.radians(70), 4, "X")
    acc.cyl((0, 0, -0.35), (0, 0, 0.35), 0.32, M, "FMetalDark", n=12)
    acc.disc((0, 0, 0.36), 0.28, M, "FLightWarm", n=12)


def build_lightpole(acc, d):
    p = dpos(d)
    acc.cyl(p, p + Vector((0, 0, 0.5)), 0.28, I4, "FConcreteDark", n=8)
    acc.cyl(p + Vector((0, 0, 0.5)), p + Vector((0, 0, 9.0)), 0.12, I4, "FMetal", n=8, r2=0.08)
    for a in (0, math.pi):
        dv = Vector((math.cos(a), math.sin(a), 0))
        acc.cyl(p + Vector((0, 0, 8.8)), p + Vector((0, 0, 8.9)) + dv * 1.3, 0.05, I4, "FMetal", n=5)
        hp = p + Vector((0, 0, 8.85)) + dv * 1.45
        acc.box((-0.35, -0.2, -0.12), (0.35, 0.2, 0.08), Matrix.Translation(hp) @ Matrix.Rotation(a, 4, "Z"), "FMetalDark", bottom="FLightWarm")


def build_hangarlight(acc, d):
    p = d["pos"]
    s = d.get("size") or {"x": 20, "z": 14}
    y = p["y"]
    x0, x1 = p["x"] - s["x"] / 2, p["x"] + s["x"] / 2
    z0, z1 = p["z"] - s["z"] / 2, p["z"] + s["z"] / 2
    # 天井の梁（トラス）と照明
    x = x0
    while x <= x1 + 0.01:
        wbox(acc, x - 0.15, y - 0.6, z0 - 2.5, x + 0.15, y, z1 + 2.5, "FMetalDark")
        x += 4.0
    for x in (x0 + 2, (x0 + x1) / 2, x1 - 2):
        for z in (z0 + 2, (z0 + z1) / 2, z1 - 2):
            wbox(acc, x - 0.6, y - 0.75, z - 0.3, x + 0.6, y - 0.6, z + 0.3, "FMetalDark", bottom="FLightWarm")


def build_marking(acc, d):
    pr = d.get("params") or {}
    style = pr.get("style", "road")
    p = d["pos"]
    s = d.get("size") or {"x": 8, "z": 20}
    yaw = math.radians(d.get("yaw", 0))
    M = Matrix.Translation(V(p["x"], p["y"] + 0.012, p["z"])) @ Matrix.Rotation(yaw, 4, "Z")
    w, L = s["x"] / 2, s["z"] / 2

    def q(xa, ya, xb, yb, mat, z=0.0):
        acc.poly([(xa, ya, z), (xb, ya, z), (xb, yb, z), (xa, yb, z)], mat, M=M)

    if style == "road":
        for sx in (-1, 1):
            x = sx * (w - 0.35)
            q(x - 0.08, -L, x + 0.08, L, "FMarkYellow")
        y = -L + 0.5
        while y < L - 0.5:
            q(-0.07, y, 0.07, min(L, y + 2.0), "FMarkYellow")
            y += 4.0
    elif style == "parking":
        q(-w, L - 0.1, w, L, "FMarkWhite")
        x = -w
        while x <= w + 0.01:
            q(x - 0.06, L - 5.0, x + 0.06, L, "FMarkWhite")
            x += 3.6
    elif style == "hazard":
        band = 0.5
        n = 24
        for side in range(4):
            for k in range(n):
                t0, t1 = -1 + 2 * k / n, -1 + 2 * (k + 1) / n
                mat = "FMarkYellow" if k % 2 == 0 else "FHazardBlack"
                if side == 0:
                    q(t0 * w, L - band, t1 * w, L, mat)
                elif side == 1:
                    q(t0 * w, -L, t1 * w, -L + band, mat)
                elif side == 2:
                    q(-w, t0 * L, -w + band, t1 * L, mat)
                else:
                    q(w - band, t0 * L, w, t1 * L, mat)
    elif style == "dirtroad":
        # 草原の土の道（縁はぎざぎざ）
        rr = random.Random(int(p["x"] * 3 + p["z"]))
        n = int(L * 2 // 2.0)
        for k in range(n):
            y0 = -L + k * 2.0
            y1 = y0 + 2.0
            ja, jb = rr.uniform(-0.6, 0.6), rr.uniform(-0.6, 0.6)
            acc.poly([(-w + ja, y0, 0), (w - jb, y0, 0), (w - jb * 0.5, y1, 0), (-w + ja * 0.5, y1, 0)], "FDirt", M=M)


def build_banner_rod(acc, d):
    p = d["pos"]
    s = d.get("size") or {"x": 4, "y": 7}
    yaw = math.radians(d.get("yaw", 0))
    M = Matrix.Translation(V(p["x"], p["y"] + s["y"] / 2 + 0.1, p["z"])) @ Matrix.Rotation(yaw, 4, "Z")
    acc.cyl((-s["x"] / 2 - 0.2, -0.06, 0), (s["x"] / 2 + 0.2, -0.06, 0), 0.05, M, "FMetalDark", n=6)


def build_gatesign_plate(acc, d):
    p = d["pos"]
    s = d.get("size") or {"x": 8, "y": 1.5}
    yaw = math.radians(d.get("yaw", 0))
    M = Matrix.Translation(V(p["x"], p["y"], p["z"])) @ Matrix.Rotation(yaw, 4, "Z")
    acc.box((-s["x"] / 2 - 0.2, -0.0, -s["y"] / 2 - 0.15), (s["x"] / 2 + 0.2, 0.06, s["y"] / 2 + 0.15), M, "FMetalDark")


BUILDERS = {
    "ground": build_ground,
    "cliff": build_cliff,
    "ramp": build_ramp,
    "fortwall": build_fortwall,
    "parapet": build_parapet,
    "watchtower": build_watchtower,
    "cabin": build_cabin,
    "pier": build_pier,
    "shell": build_shell,
    "slab": build_slab,
    "deck": build_deck,
    "building": build_building,
    "ac": build_ac,
    "bridgedeck": build_bridgedeck,
    "corepad": build_corepad,
    "truck": build_truck,
    "apc": build_apc,
    "container": build_container,
    "crate": build_crate,
    "barrier": build_barrier,
    "sandbag": build_sandbag,
    "fueltank": build_fueltank,
    "rock": build_rock,
    "dock": build_dock,
    "canopy": build_canopy,
    "stairs": build_stairs,
    "ruin": build_ruin,
}

DECOR_BUILDERS = {
    "antenna": build_antenna,
    "radar": build_radar,
    "searchlight": build_searchlight,
    "lightpole": build_lightpole,
    "hangarlight": build_hangarlight,
    "marking": build_marking,
    "banner": build_banner_rod,
    "gatesign": build_gatesign_plate,
    "dirtpatch": build_dirtpatch,
    "crater": build_crater,
}


# ---------------------------------------------------------------------------
# 遠景：まわりの高原・遠くの山脈・岩と木
# ---------------------------------------------------------------------------


def _hash(ix, iz, s=0):
    n = (ix * 374761393 + iz * 668265263 + s * 1442695041) & 0xFFFFFFFF
    n = (n ^ (n >> 13)) * 1274126177 & 0xFFFFFFFF
    return ((n ^ (n >> 16)) & 0xFFFF) / 65535.0


def vnoise(x, z, s=0):
    ix, iz = math.floor(x), math.floor(z)
    fx, fz = x - ix, z - iz
    ux, uz = fx * fx * (3 - 2 * fx), fz * fz * (3 - 2 * fz)
    a = _hash(ix, iz, s)
    b2 = _hash(ix + 1, iz, s)
    c = _hash(ix, iz + 1, s)
    d2 = _hash(ix + 1, iz + 1, s)
    return a + (b2 - a) * ux + (c - a) * uz + (a - b2 - c + d2) * ux * uz


def fbm(x, z, octaves=5, s=0):
    v, a, f = 0.0, 0.5, 1.0
    for i in range(octaves):
        v += a * vnoise(x * f, z * f, s + i * 17)
        f *= 2.03
        a *= 0.5
    return v


def ridge(x, z, s=0):
    v, a, f = 0.0, 0.55, 1.0
    for i in range(5):
        n = 1 - abs(vnoise(x * f, z * f, s + i * 31) * 2 - 1)
        v += a * n * n
        f *= 2.1
        a *= 0.5
    return v


def smooth(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def terrain_height(x, z, t):
    """プレイ範囲の外の高さ。t はプレイ範囲の縁からの距離"""
    # 縁の高さ：西の低地は -6、ほかは 0
    edge = LOW_Y + (0 - LOW_Y) * smooth(-84, -70, x)
    base = edge * (1 - smooth(20, 160, t))
    hills = (fbm(x * 0.006, z * 0.006, 4, 3) - 0.45) * 40 * smooth(8, 140, t)
    gentle = (fbm(x * 0.02, z * 0.02, 3, 9) - 0.5) * 4 * smooth(4, 40, t)
    # 遠くの山脈（北と東西に高く、南は低め）
    ang = math.atan2(-z, x)
    north = 0.6 + 0.4 * math.sin(ang)
    mount = smooth(420, 1050, t) * (ridge(x * 0.0024, z * 0.0024, 5) * 360 + 30) * north
    return base + hills + gentle + mount


def rect_point(s):
    """プレイ範囲の長方形の縁の、周の位置 s（0〜1）の点と外向きの向き（角では向きが回る）"""
    x0, z0 = PLAY_MIN
    x1, z1 = PLAY_MAX
    W, H = x1 - x0, z1 - z0
    per = 2 * (W + H)
    L = s * per
    # 辺：南（+z）を西→東、東を南→北、北を東→西、西を北→南
    if L < W:
        return (x0 + L, z1), (0, 1)
    L -= W
    if L < H:
        return (x1, z1 - L), (1, 0)
    L -= H
    if L < W:
        return (x1 - L, z0), (0, -1)
    L -= W
    return (x0, z0 + L), (-1, 0)


def build_backdrop(acc, objs_rocks):
    # 長方形の縁から外へ広がる、帯状の格子（角は丸く回る）
    levels = [0, 3, 8, 16, 28, 44, 66, 95, 135, 190, 260, 350, 470, 620, 800, 1020, 1300, 1700, 2200]
    N = 260
    # 周の点：辺ごとに点を並べ、角では外向きの向きを回す点を足す
    samples = []
    x0, z0 = PLAY_MIN
    x1, z1 = PLAY_MAX
    corners = [((x0, z1), math.pi, math.pi / 2), ((x1, z1), math.pi / 2, 0), ((x1, z0), 0, -math.pi / 2), ((x0, z0), -math.pi / 2, -math.pi)]
    edges = [((x0, z1), (x1, z1)), ((x1, z1), (x1, z0)), ((x1, z0), (x0, z0)), ((x0, z0), (x0, z1))]
    normals = [(0, 1), (1, 0), (0, -1), (-1, 0)]
    for e in range(4):
        (ax, az), (bx, bz) = edges[e]
        L = math.hypot(bx - ax, bz - az)
        n = max(4, int(L / 12))
        for k in range(n):
            t = k / n
            samples.append(((ax + (bx - ax) * t, az + (bz - az) * t), normals[e]))
        # 角（次の辺の始まり）：向きを 90° 回す
        c = edges[(e + 1) % 4][0]
        na = math.atan2(normals[e][1], normals[e][0])
        nb = math.atan2(normals[(e + 1) % 4][1], normals[(e + 1) % 4][0])
        d = nb - na
        while d > math.pi:
            d -= 2 * math.pi
        while d < -math.pi:
            d += 2 * math.pi
        for k in range(8):
            a = na + d * k / 8
            samples.append((c, (math.cos(a), math.sin(a))))
    grid = []
    for t in levels:
        row = []
        for (px, pz), (nx, nz) in samples:
            x, z = px + nx * t, pz + nz * t
            y = terrain_height(x, z, t) if t > 0 else (LOW_Y if px < CLIFF_X else 0.0)
            row.append((x, y, z))
        grid.append(row)
    M = len(samples)
    for li in range(len(levels) - 1):
        for k in range(M):
            a = grid[li][k]
            b2 = grid[li][(k + 1) % M]
            c = grid[li + 1][(k + 1) % M]
            d2 = grid[li + 1][k]
            ym = (a[1] + b2[1] + c[1] + d2[1]) / 4
            t = levels[li]
            # 高さと傾きで色を変える
            steep = abs(c[1] - b2[1]) / max(1.0, levels[li + 1] - levels[li])
            if ym > 230 + 30 * math.sin(a[0] * 0.01):
                mat = "Bg_FSnow"
            elif ym > 70 or steep > 0.55:
                mat = "Bg_FMountain"
            elif t > 200:
                mat = "Bg_FGrassDry"
            else:
                mat = "Bg_FGrass"
            acc.poly([V(*a), V(*d2), V(*c), V(*b2)], mat)
    # 近くの岩と針葉樹（プレイ範囲のすぐ外。影は落とさない）
    rr = random.Random(5)
    for i in range(170):
        k = rr.randrange(M)
        (px, pz), (nx, nz) = samples[k]
        t = rr.uniform(8, 260)
        x, z = px + nx * t + rr.uniform(-6, 6), pz + nz * t + rr.uniform(-6, 6)
        y = terrain_height(x, z, t)
        if rr.random() < 0.45:
            r = rr.uniform(1.2, 4.5)
            acc.blob(V(x, y + r * 0.2, z), r, I4, "Bg_FRock", sub=1, jitter=0.3, squash=(1.0, 0.8, 0.65), seed=i)
        else:
            h = rr.uniform(5, 11)
            for j in range(rr.randint(1, 3)):
                ox, oz = rr.uniform(-3, 3), rr.uniform(-3, 3)
                base = V(x + ox, y - 0.2, z + oz)
                acc.cyl(base, base + Vector((0, 0, h * 0.25)), 0.25, I4, "Bg_FWoodDark", n=5)
                for lv in range(3):
                    r0 = h * (0.32 - lv * 0.08)
                    z0_ = base.z + h * (0.18 + lv * 0.22)
                    acc.cyl(Vector((base.x, base.y, z0_)), Vector((base.x, base.y, z0_ + h * 0.42)), r0, I4, "Bg_FTree", n=7, r2=0.05)


# ---------------------------------------------------------------------------


def main():
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    col = bpy.context.scene.collection
    acc = Acc()
    counts = {}
    for i, b in enumerate(BOXES):
        tag = b.get("tag")
        if tag == "core":
            continue  # コアはゲーム側のモデル（光る炉）
        fn = BUILDERS.get(tag)
        if b.get("kind") == "boundary":
            continue
        if fn is None:
            build_plain(acc, b, i)
        else:
            fn(acc, b, i)
        counts[tag] = counts.get(tag, 0) + 1
    for d in DECOR:
        fn = DECOR_BUILDERS.get(d["type"])
        if fn:
            fn(acc, d)
    bg = Acc()
    build_backdrop(bg, None)
    for k, v in bg.groups.items():
        acc.groups[k] = v
    objs = acc.build(col)
    tris = sum(len(o.data.polygons) for o in objs)
    print("部品:", counts)
    print(f"メッシュ {len(objs)} 個・面 {tris}")
    if "--stats" in args:
        for o in sorted(objs, key=lambda o: -len(o.data.polygons))[:16]:
            print(f"  {o.name}: 面 {len(o.data.polygons)}・頂点 {len(o.data.vertices)}")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=RAW, export_format="GLB", export_yup=True, export_apply=True, export_vertex_color="NONE")
    print(f"書き出し（圧縮前）: {RAW} ({os.path.getsize(RAW) // 1024} KB)")
    import shutil
    import subprocess

    npx = shutil.which("npx")
    try:
        subprocess.run([npx or "npx", "gltfpack", "-i", RAW, "-o", OUT, "-cc", "-vp", "16", "-kv", "-km", "-vtf"], check=True, cwd=ROOT)
        print(f"書き出し: {OUT} ({os.path.getsize(OUT) // 1024} KB)")
        # 公開ページ用（npm run build:artifact）：meshopt 圧縮なし（量子化だけ）の版。公開ページでは WebAssembly の展開器が使えないため
        plain = OUT.replace(".glb", "_plain.glb")
        subprocess.run([npx or "npx", "gltfpack", "-i", RAW, "-o", plain, "-vp", "16", "-kv", "-km", "-vtf"], check=True, cwd=ROOT)
        print(f"書き出し: {plain} ({os.path.getsize(plain) // 1024} KB)")
    except Exception as e:
        print("gltfpack が使えないため、圧縮せずに書き出します:", e)
        shutil.copy(RAW, OUT)
    if "--blend" in args:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, "fortress.blend"))
    if "--preview" in args:
        render_preview()


def render_preview():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 16
    scene.cycles.use_denoising = False
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    world = bpy.data.worlds.new("W")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.45, 0.62, 0.9, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.9
    sun = bpy.data.lights.new("S", "SUN")
    sun.energy = 4.0
    sun.color = (1.0, 0.96, 0.9)
    so = bpy.data.objects.new("S", sun)
    so.rotation_euler = (math.radians(38), 0, math.radians(-30))
    scene.collection.objects.link(so)
    cam_data = bpy.data.cameras.new("C")
    cam_data.lens = 22
    cam_data.clip_end = 5000
    cam = bpy.data.objects.new("C", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    pdir = os.path.join(HERE, "preview")
    os.makedirs(pdir, exist_ok=True)
    for name, loc, target in (
        ("fortress_overview", V(-30, 70, 150), V(0, 0, -5)),
        ("fortress_plaza", V(14, 6, 26), V(0, 4, -18)),
        ("fortress_west", V(-96, 2, 56), V(-60, 2, 18)),
        ("fortress_north", V(0, 14, 2), V(-30, 8, -40)),
        ("fortress_south_field", V(-60, 26, 118), V(10, 0, 70)),
        ("fortress_north_field", V(60, 22, -96), V(-10, 0, -66)),
        ("fortress_lowland", V(-128, 10, -60), V(-100, -4, 20)),
        ("fortress_ruin", V(-104, -2, 24), V(-94, -4, 33)),
    ):
        only = os.environ.get("PREVIEW_VIEWS")
        if only and name not in only.split(","):
            continue
        cam.location = loc
        cam.rotation_euler = (target - loc).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(pdir, name + ".png")
        bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    main()
