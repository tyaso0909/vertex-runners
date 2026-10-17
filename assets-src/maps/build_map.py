"""
マップの見た目を Blender で作り、glTF（.glb）で書き出すスクリプト。

使い方：
  npx tsx scripts/export-map.ts                 # まず配置を JSON に書き出す
  python assets-src/maps/build_map.py           # pip install bpy（Python 3.11）
  または blender --background --python assets-src/maps/build_map.py
オプション：
  --blend    確認用に assets-src/maps/neon_city.blend も保存する
  --preview  assets-src/maps/preview/ に確認用の画像を描く

作り方
  - 当たり判定の箱（shared/levels/neonCity.ts）と同じ配置 JSON（neon_city_layout.json）を読み、
    箱の種類（tag）ごとに見た目を作る：ビルの外壁と窓・橋とトラス・ガラスの連絡橋・手すり・階段・
    コンテナ・空調ユニット・木箱・植え込み・売店・ヘリポート・街灯・植木・桜の木・高架レールなど。
  - 街のマップ：地面と道路（車線・横断歩道）、中に入れる建物（外壁の外はコンクリート・内は内装、扉の上のネオン、
    各階の床と天井の照明、階段の穴の縁の黄色の線）、立体駐車場（床・車路・柱・腰壁・駐車枠）、家具（ゲーム機・棚・カウンター）、車。
  - 当たり判定と見た目がずれないよう、足場の上面・壁の面は箱の面とそろえる（飾りは 0.2m 以内しか出っ張らせない）。
  - マテリアルは名前で区別する（Concrete・Floor・Window・Glass・Neon* など）。ゲーム側（client/scene/mapView.ts）が
    名前を見て、濡れた床・窓明かり・ネオンなどの専用の質感に置き換える。
  - 窓の明かりの色は頂点カラーで持たせる（ゲーム側でその色を光らせる）。
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
LAYOUT = os.path.join(HERE, "neon_city_layout.json")
OUT = os.path.join(ROOT, "client", "assets", "maps", "neon_city.glb")
RAW = os.path.join(HERE, "neon_city_raw.glb")  # 圧縮前（gltfpack で圧縮して OUT へ）

rnd = random.Random(20261012)

# ---------------------------------------------------------------------------
# 座標の変換
# ---------------------------------------------------------------------------


def T(p):
    """three.js の座標 → Blender の座標"""
    if isinstance(p, dict):
        return Vector((p["x"], -p["z"], p["y"]))
    return Vector((p[0], -p[2], p[1]))


def box_matrix(b):
    """当たり判定の箱の中心・回転を、Blender の 4x4 行列にする（ローカルは Blender の軸）"""
    r = b.get("rot") or {"x": 0, "y": 0, "z": 0}
    yaw = math.radians(r["y"])
    pitch = math.radians(r["x"])
    return Matrix.Translation(T(b["center"])) @ Matrix.Rotation(yaw, 4, "Z") @ Matrix.Rotation(pitch, 4, "X")


def box_half(b):
    s = b["size"]
    return Vector((s["x"] / 2, s["z"] / 2, s["y"] / 2))


# ---------------------------------------------------------------------------
# 面をマテリアルごとに貯めておき、最後に1つのメッシュにする
# ---------------------------------------------------------------------------

WHITE = (1.0, 1.0, 1.0, 1.0)
WIN_UV = [(0, 0), (1, 0), (1, 1), (0, 1)]
# 店の窓：UV の範囲を広げて、窓の中の模様（桟・カーテン）を大きなガラスに合わせる
SHOP_UV = [(0, 0), (1, 0), (1, 1), (0, 1)]


class Acc:
    def __init__(self):
        self.groups = {}  # マテリアル名 → [頂点, 面, 面の色]

    def _g(self, mat):
        if mat not in self.groups:
            self.groups[mat] = ([], [], [], [])
        return self.groups[mat]

    def poly(self, pts, mat, color=WHITE, M=None, uv=None):
        """多角形を1枚。uv を渡すと、その面にテクスチャ座標（0〜1）を付ける（窓の中の模様用）"""
        verts, faces, cols, uvs = self._g(mat)
        uvs.append(uv)
        i0 = len(verts)
        for p in pts:
            v = Vector(p)
            verts.append(tuple(M @ v) if M is not None else tuple(v))
        faces.append(tuple(range(i0, i0 + len(pts))))
        cols.append(color)

    def box(self, lo, hi, M, mat, top=None, bottom=None, color=WHITE, skip=()):
        """ローカル座標の範囲 lo〜hi の箱。top / bottom で上面・下面だけ別のマテリアルにできる"""
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
            m = top if (k == "top" and top) else bottom if (k == "bottom" and bottom) else mat
            self.poly(pts, m, color, M)

    def cyl(self, a, b, r, M, mat, n=10, caps=True, color=WHITE, r2=None):
        """a から b への円柱（ローカル座標）"""
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
            self.poly(list(reversed(ring_a)), mat, color, M)
            self.poly(ring_b, mat, color, M)

    def disc(self, c, r, M, mat, n=24, z=0.0, color=WHITE):
        c = Vector(c)
        pts = [c + Vector((math.cos(i * 2 * math.pi / n) * r, math.sin(i * 2 * math.pi / n) * r, z)) for i in range(n)]
        self.poly(pts, mat, color, M)

    def ring(self, c, r0, r1, M, mat, n=48, z=0.0, a0=0.0, a1=2 * math.pi, color=WHITE):
        """平らな輪（地面の模様など）"""
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

    def ico(self, c, r, M, mat, sub=1, color=WHITE, squash=1.0, jitter=0.0):
        """小さな多面体（葉・花のかたまり）"""
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
        scale = [1 + rnd.uniform(-jitter, jitter) for _ in vs]
        pts = [c + Vector((v.x * r * scale[i], v.y * r * scale[i], v.z * r * squash * scale[i])) for i, v in enumerate(vs)]
        for f in fs:
            self.poly([pts[i] for i in f], mat, color, M)

    def build(self, collection):
        """マテリアルごとに1つのオブジェクトを作る"""
        objs = []
        for mat_name, (verts, faces, cols, uvs) in self.groups.items():
            if not faces:
                continue
            me = bpy.data.meshes.new("map_" + mat_name)
            me.from_pydata(verts, [], faces)
            me.update()
            # 頂点カラー（窓の明かり）。窓のメッシュだけに付ける
            if mat_name.endswith("Window"):
                attr = me.color_attributes.new("Color", "FLOAT_COLOR", "CORNER")
                for poly in me.polygons:
                    c = cols[poly.index]
                    for li in poly.loop_indices:
                        attr.data[li].color = c
                me.color_attributes.active_color = attr
                me.color_attributes.render_color_index = 0
            if any(u is not None for u in uvs):
                layer = me.uv_layers.new(name="UVMap")
                for poly in me.polygons:
                    u = uvs[poly.index] or WIN_UV
                    for k, li in enumerate(poly.loop_indices):
                        layer.data[li].uv = u[k % len(u)]
            me.materials.append(material(mat_name))
            ob = bpy.data.objects.new("map_" + mat_name, me)
            collection.objects.link(ob)
            objs.append(ob)
        return objs


# ---------------------------------------------------------------------------
# マテリアル（色はゲーム側で置き換える。Blender の確認用に近い色をつけておく）
# ---------------------------------------------------------------------------

MAT_COLORS = {
    "Concrete": ("#3b3a44", 0.0, 0.8, None),
    "ConcreteDark": ("#24232b", 0.0, 0.85, None),
    "Floor": ("#2a2932", 0.0, 0.25, None),
    "Metal": ("#6a6f7a", 0.8, 0.35, None),
    "MetalDark": ("#26282e", 0.7, 0.45, None),
    "Glass": ("#5aa0c8", 0.2, 0.05, None),
    "Window": ("#101018", 0.5, 0.15, None),
    "NeonCyan": ("#4fd1ff", 0, 0.5, "#4fd1ff"),
    "NeonPink": ("#ff4fd8", 0, 0.5, "#ff4fd8"),
    "NeonPurple": ("#8a5cff", 0, 0.5, "#8a5cff"),
    "NeonAmber": ("#ffb45c", 0, 0.5, "#ffb45c"),
    "NeonWhite": ("#e8f0ff", 0, 0.5, "#e8f0ff"),
    "NeonRed": ("#ff3040", 0, 0.5, "#ff3040"),
    "NeonSoft": ("#4fd1ff", 0, 0.5, "#4fd1ff"),
    "ContainerRed": ("#8a2a2a", 0.3, 0.55, None),
    "ContainerBlue": ("#24508a", 0.3, 0.55, None),
    "ContainerTeal": ("#1f6e6a", 0.3, 0.55, None),
    "ContainerOrange": ("#a8561e", 0.3, 0.55, None),
    "Wood": ("#6b4a2e", 0.0, 0.8, None),
    "Stone": ("#4a4852", 0.0, 0.7, None),
    "Bark": ("#3a2a26", 0.0, 0.9, None),
    "Blossom": ("#ff9ad8", 0.0, 0.6, "#ff6fc8"),
    "Leaf": ("#1f4a36", 0.0, 0.7, None),
    "Awning": ("#7a2a5a", 0.0, 0.7, None),
    "Screen": ("#05060a", 0.2, 0.2, None),
    "Asphalt": ("#1c1b22", 0.0, 0.5, None),
    "GarageFloor": ("#3a3940", 0.0, 0.6, None),
    "FloorIn": ("#5a5560", 0.1, 0.3, None),
    "Interior": ("#4a4550", 0.0, 0.85, None),
    "Ceiling": ("#2e2c34", 0.0, 0.9, None),
    "Paint": ("#cfcac0", 0.0, 0.6, None),
    "PaintYellow": ("#d8a92a", 0.0, 0.6, None),
    "NeonWarm": ("#fff0d8", 0, 0.5, "#fff0d8"),
    "CarRed": ("#8c1d28", 0.5, 0.3, None),
    "CarBlue": ("#1d3f8c", 0.5, 0.3, None),
    "CarWhite": ("#c9ccd4", 0.4, 0.3, None),
    "CarBlack": ("#16171c", 0.5, 0.3, None),
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
    if base == "Glass":
        bsdf.inputs["Alpha"].default_value = 0.3
    if base == "Window":
        # 窓の明かりは頂点カラー（Blender の確認画像でも光って見えるように）
        attr = m.node_tree.nodes.new("ShaderNodeVertexColor")
        attr.layer_name = "Color"
        m.node_tree.links.new(attr.outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = 2.0
    _mats[name] = m
    return m


# ---------------------------------------------------------------------------
# 配置データ
# ---------------------------------------------------------------------------

layout = json.load(open(LAYOUT, encoding="utf-8"))
BOXES = layout["boxes"]
DECOR = layout["decor"]

# 窓が他の箱に埋まっていないか調べるため、箱をワールド座標の AABB と行列で持っておく
SOLIDS = []
for b in BOXES:
    if b.get("tag") in ("barrier", "rail", "glass", "roof"):
        continue
    M = box_matrix(b)
    SOLIDS.append((M.inverted(), box_half(b), b))


CELL = 8.0
GRID = {}
for _i, (_Minv, _h, _b) in enumerate(SOLIDS):
    _M = _Minv.inverted()
    _pts = [_M @ Vector((sx * _h.x, sy * _h.y, sz * _h.z)) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
    for gx in range(math.floor(min(p.x for p in _pts) / CELL), math.floor(max(p.x for p in _pts) / CELL) + 1):
        for gy in range(math.floor(min(p.y for p in _pts) / CELL), math.floor(max(p.y for p in _pts) / CELL) + 1):
            GRID.setdefault((gx, gy), []).append(_i)


def inside_other(p_world, self_box, margin=0.05, tags=None):
    """p_world（Blender の座標）が、self_box 以外の箱の中にあるか。tags を渡すとその種類の箱だけ調べる"""
    for i in GRID.get((math.floor(p_world.x / CELL), math.floor(p_world.y / CELL)), ()):
        Minv, h, b = SOLIDS[i]
        if b is self_box:
            continue
        if tags is not None and b.get("tag") not in tags:
            continue
        l = Minv @ p_world
        if abs(l.x) < h.x + margin and abs(l.y) < h.y + margin and abs(l.z) < h.z + margin:
            return True
    return False


def to_three(p):
    """Blender の座標 → three.js の (x, z)"""
    return p.x, -p.y


# ---------------------------------------------------------------------------
# 各部品
# ---------------------------------------------------------------------------

VIS_BOTTOM = -1.0  # 見た目のビルの下端（地面の少し下）
RAIL_Y = 38.0  # 外周の高架レールの高さ（マップを囲むビルの上に見える。ゲーム側の列車と同じ）
FLOOR_H = 3.6  # 1階分の高さ


def window_color():
    r = rnd.random()
    if r < 0.38:
        warm = rnd.uniform(0.6, 1.0)
        return (1.0 * warm, 0.62 * warm, 0.3 * warm, 1)
    if r < 0.46:
        return (0.25, 0.75, 1.0, 1) if rnd.random() < 0.5 else (0.55, 0.36, 1.0, 1)
    if r < 0.5:
        return (1.0, 0.3, 0.75, 1)
    return (0.0, 0.0, 0.0, 1)


def facade(acc, M, h, top_local, box, style="office"):
    """箱の4つの側面に、階ごとの帯・柱・窓をつける。h は半分の大きさ（ローカル）、top_local は屋上の高さ"""
    bottom = max(-h.z, VIS_BOTTOM - (M.translation.z))
    sides = [
        # (面の法線, 面に沿う軸, 幅の半分, 面の位置)
        (Vector((1, 0, 0)), Vector((0, 1, 0)), h.y, h.x),
        (Vector((-1, 0, 0)), Vector((0, -1, 0)), h.y, h.x),
        (Vector((0, 1, 0)), Vector((-1, 0, 0)), h.x, h.y),
        (Vector((0, -1, 0)), Vector((1, 0, 0)), h.x, h.y),
    ]
    ground_local = -M.translation.z  # ワールドの地面（高さ 0）のローカルの高さ
    street = bottom <= ground_local + 0.05  # 地面から建っている建物は、1階を店先にする
    for n, t, half_w, off in sides:
        W = half_w * 2
        if W < 3:
            continue
        cols = max(1, int(W / 2.4))
        cw = W / cols
        # 屋上のすぐ下は窓のない帯（ネオンの線）
        band_top = top_local - 0.25
        # 帯（ネオンの線）
        p0 = n * (off + 0.04)
        line_z = top_local - 0.55
        acc.poly(
            [p0 - t * half_w + Vector((0, 0, line_z - 0.06)), p0 + t * half_w + Vector((0, 0, line_z - 0.06)), p0 + t * half_w + Vector((0, 0, line_z + 0.06)), p0 - t * half_w + Vector((0, 0, line_z + 0.06))],
            rnd.choice(["NeonCyan", "NeonPurple", "NeonPink"]) if style != "plain" else "NeonCyan",
            WHITE,
            M,
        )
        # 階の帯（少し出っ張る）と窓
        z = band_top - 1.2
        floor = 0
        stop = ground_local + 4.6 if street else bottom
        if street:
            storefront(acc, M, n, t, half_w, off, ground_local, box)
        while z - FLOOR_H > stop:
            # 階の帯
            zb = z - 0.25
            lo = p0 - t * half_w + Vector((0, 0, zb))
            acc.poly(
                [lo, lo + t * W, lo + t * W + Vector((0, 0, 0.25)), lo + Vector((0, 0, 0.25))],
                "ConcreteDark",
                WHITE,
                M,
            )
            # 窓（2.4m ごと）
            for i in range(cols):
                cx = -half_w + cw * (i + 0.5)
                wc = p0 + t * cx + n * 0.01
                w = cw * 0.38
                hh = FLOOR_H * 0.36
                zc = z - FLOOR_H / 2 - 0.1
                # 他の箱に埋まっている窓は作らない
                world = M @ (wc + n * 0.5 + Vector((0, 0, zc)))
                if inside_other(world, box):
                    continue
                col = window_color() if floor < 14 else (0, 0, 0, 1)
                acc.poly(
                    [wc - t * w + Vector((0, 0, zc - hh)), wc + t * w + Vector((0, 0, zc - hh)), wc + t * w + Vector((0, 0, zc + hh)), wc - t * w + Vector((0, 0, zc + hh))],
                    "Window",
                    col,
                    M,
                    uv=WIN_UV,
                )
            z -= FLOOR_H
            floor += 1
        # 柱（7.2m ごと。0.15m 出っ張る）
        npil = max(2, int(W / 7.2) + 1)
        for i in range(npil):
            cx = -half_w + W * i / (npil - 1)
            cx = max(-half_w + 0.2, min(half_w - 0.2, cx))
            c = n * (off + 0.08) + t * cx
            lo = Vector((min(c.x - 0.2 * abs(t.x) - 0.08 * abs(n.x), c.x + 0.2 * abs(t.x) + 0.08 * abs(n.x)), min(c.y - 0.2 * abs(t.y) - 0.08 * abs(n.y), c.y + 0.2 * abs(t.y) + 0.08 * abs(n.y)), bottom))
            hi = Vector((max(c.x - 0.2 * abs(t.x) - 0.08 * abs(n.x), c.x + 0.2 * abs(t.x) + 0.08 * abs(n.x)), max(c.y - 0.2 * abs(t.y) - 0.08 * abs(n.y), c.y + 0.2 * abs(t.y) + 0.08 * abs(n.y)), top_local - 0.9))
            acc.box(lo, hi, M, "ConcreteDark")


def storefront(acc, M, n, t, half_w, off, g, box):
    """地面から建つ建物の1階：明るい店の窓・ひさし・ネオンの線（当たり判定の面から 0.15m 以内）"""
    W = half_w * 2
    p0 = n * (off + 0.02)
    shops = max(1, int(W / 6.5))
    sw = W / shops
    for i in range(shops):
        c = -half_w + sw * (i + 0.5)
        world = M @ (p0 + t * c + n * 0.5 + Vector((0, 0, g + 1.8)))
        if inside_other(world, box) or rnd.random() < 0.25:
            # 閉まった店：シャッター
            acc.poly([p0 + t * (c - sw / 2 + 0.4) + Vector((0, 0, g + 0.05)), p0 + t * (c + sw / 2 - 0.4) + Vector((0, 0, g + 0.05)), p0 + t * (c + sw / 2 - 0.4) + Vector((0, 0, g + 3.0)), p0 + t * (c - sw / 2 + 0.4) + Vector((0, 0, g + 3.0))], "MetalDark", WHITE, M)
            continue
        w = sw / 2 - 0.5
        warm = rnd.random() < 0.6
        col = (1.0, 0.7, 0.42, 1) if warm else rnd.choice([(0.35, 0.8, 1.0, 1), (1.0, 0.4, 0.8, 1), (0.6, 0.45, 1.0, 1)])
        acc.poly(
            [p0 + t * (c - w) + Vector((0, 0, g + 0.35)), p0 + t * (c + w) + Vector((0, 0, g + 0.35)), p0 + t * (c + w) + Vector((0, 0, g + 2.9)), p0 + t * (c - w) + Vector((0, 0, g + 2.9))],
            "Window",
            col,
            M,
            uv=SHOP_UV,
        )
        # ひさしの下のネオンの線
        neon = rnd.choice(["NeonPink", "NeonCyan", "NeonAmber", "NeonPurple"])
        q = p0 + n * 0.03
        acc.poly([q + t * (c - w - 0.2) + Vector((0, 0, g + 3.15)), q + t * (c + w + 0.2) + Vector((0, 0, g + 3.15)), q + t * (c + w + 0.2) + Vector((0, 0, g + 3.25)), q + t * (c - w - 0.2) + Vector((0, 0, g + 3.25))], neon, WHITE, M)
    # 1階と2階の境の帯
    acc.poly([p0 - t * half_w + Vector((0, 0, g + 3.9)), p0 + t * half_w + Vector((0, 0, g + 3.9)), p0 + t * half_w + Vector((0, 0, g + 4.3)), p0 - t * half_w + Vector((0, 0, g + 4.3))], "ConcreteDark", WHITE, M)


def build_building(acc, b):
    M = box_matrix(b)
    h = box_half(b)
    top = h.z
    vis = b.get("vis") or {}
    floor_mat = "Floor"
    # 本体（上面は濡れた床、横は壁）
    acc.box((-h.x, -h.y, max(-h.z, VIS_BOTTOM - M.translation.z)), (h.x, h.y, top), M, "Concrete", top=floor_mat, skip=("bottom",))
    facade(acc, M, h, top, b, "plain" if vis.get("floor") == "street" else "office")
    # 屋上の縁の小さな縁石
    for sx, sy, lx, ly in ((1, 0, 0.12, h.y), (-1, 0, 0.12, h.y), (0, 1, h.x, 0.12), (0, -1, h.x, 0.12)):
        c = Vector((sx * (h.x - 0.12), sy * (h.y - 0.12), top))
        lo = c - Vector((lx, ly, 0))
        hi = c + Vector((lx, ly, 0.06))
        world = M @ (c + Vector((sx * 0.5, sy * 0.5, 0.2)))
        if inside_other(world, b):
            continue
        acc.box(lo, hi, M, "MetalDark")


def build_tower(acc, b):
    """飾りの高層部分（ガラスのカーテンウォールと、てっぺんのアンテナ）"""
    M = box_matrix(b)
    h = box_half(b)
    acc.box((-h.x, -h.y, max(-h.z, VIS_BOTTOM - M.translation.z)), (h.x, h.y, h.z), M, "Concrete", skip=("bottom",))
    facade(acc, M, h, h.z, b)
    # 屋上の冠とアンテナ・赤い航空灯
    acc.box((-h.x + 0.6, -h.y + 0.6, h.z), (h.x - 0.6, h.y - 0.6, h.z + 1.6), M, "ConcreteDark")
    acc.box((-h.x + 0.4, -h.y + 0.4, h.z + 1.6), (h.x - 0.4, h.y - 0.4, h.z + 1.8), M, "NeonPurple")
    for sx, sy in ((1, 1), (-1, -1)):
        base = Vector((sx * h.x * 0.5, sy * h.y * 0.5, h.z + 1.8))
        acc.cyl(base, base + Vector((0, 0, 7)), 0.12, M, "Metal", n=6)
        acc.ico(base + Vector((0, 0, 7.2)), 0.25, M, "NeonRed", sub=0)


def build_deck(acc, b):
    M = box_matrix(b)
    h = box_half(b)
    vis = b.get("vis") or {}
    acc.box((-h.x, -h.y, -h.z), (h.x, h.y, h.z), M, "ConcreteDark", top="Floor")
    long_x = h.x >= h.y
    L = h.x if long_x else h.y
    # 下の縁にネオンの線
    for s in (-1, 1):
        if long_x:
            acc.box((-h.x, s * h.y - 0.04, -h.z - 0.02), (h.x, s * h.y + 0.04, -h.z + 0.06), M, "NeonCyan")
        else:
            acc.box((s * h.x - 0.04, -h.y, -h.z - 0.02), (s * h.x + 0.04, h.y, -h.z + 0.06), M, "NeonCyan")
    # 下のトラス
    if vis.get("truss") or vis.get("bridge"):
        depth = 1.4
        n = max(2, int(L * 2 / 2.5))
        for s in (-1, 1):
            for i in range(n):
                a0 = -L + 2 * L * i / n
                a1 = -L + 2 * L * (i + 1) / n
                if long_x:
                    p = Vector((a0, s * (h.y - 0.2), -h.z))
                    q = Vector((a1, s * (h.y - 0.2), -h.z - depth))
                    if i % 2:
                        p.z, q.z = q.z, p.z
                else:
                    p = Vector((s * (h.x - 0.2), a0, -h.z))
                    q = Vector((s * (h.x - 0.2), a1, -h.z - depth))
                    if i % 2:
                        p.z, q.z = q.z, p.z
                acc.cyl(p, q, 0.06, M, "MetalDark", n=5, caps=False)
            if long_x:
                acc.cyl((-L, s * (h.y - 0.2), -h.z - depth), (L, s * (h.y - 0.2), -h.z - depth), 0.08, M, "MetalDark", n=5, caps=False)
            else:
                acc.cyl((s * (h.x - 0.2), -L, -h.z - depth), (s * (h.x - 0.2), L, -h.z - depth), 0.08, M, "MetalDark", n=5, caps=False)


def build_glass(acc, b):
    """スカイブリッジのガラスの壁：ガラス板と、2m ごとの枠"""
    M = box_matrix(b)
    h = box_half(b)
    acc.box((-h.x, -h.y, -h.z), (h.x, h.y, h.z), M, "Glass")
    long_x = h.x >= h.y
    L = h.x if long_x else h.y
    n = max(1, int(L * 2 / 2.0))
    for i in range(n + 1):
        a = -L + 2 * L * i / n
        if long_x:
            acc.box((a - 0.06, -h.y - 0.03, -h.z), (a + 0.06, h.y + 0.03, h.z), M, "MetalDark")
        else:
            acc.box((-h.x - 0.03, a - 0.06, -h.z), (h.x + 0.03, a + 0.06, h.z), M, "MetalDark")
    # 上下の枠と、ネオンの線
    if long_x:
        acc.box((-h.x, -h.y - 0.04, -h.z), (h.x, h.y + 0.04, -h.z + 0.18), M, "MetalDark")
        acc.box((-h.x, -h.y - 0.04, h.z - 0.12), (h.x, h.y + 0.04, h.z), M, "MetalDark")
        acc.box((-h.x, -h.y - 0.05, -h.z + 0.18), (h.x, h.y + 0.05, -h.z + 0.22), M, "NeonSoft")
    else:
        acc.box((-h.x - 0.04, -h.y, -h.z), (h.x + 0.04, h.y, -h.z + 0.18), M, "MetalDark")
        acc.box((-h.x - 0.04, -h.y, h.z - 0.12), (h.x + 0.04, h.y, h.z), M, "MetalDark")
        acc.box((-h.x - 0.05, -h.y, -h.z + 0.18), (h.x + 0.05, h.y, -h.z + 0.22), M, "NeonSoft")


def build_roof(acc, b):
    M = box_matrix(b)
    h = box_half(b)
    if (b.get("vis") or {}).get("arcade"):
        # 商店街のガラスの屋根：ガラス・梁・縁のネオン・店の屋上へ下ろす支え（長い向きをローカル y にそろえる）
        if h.x > h.y:
            M = M @ Matrix.Rotation(math.pi / 2, 4, "Z")
            h = Vector((h.y, h.x, h.z))
        acc.box((-h.x, -h.y, -h.z), (h.x, h.y, h.z), M, "Glass")
        n = max(2, int(h.y * 2 / 2.0))
        for i in range(n + 1):
            yy = -h.y + 2 * h.y * i / n
            acc.box((-h.x, yy - 0.06, -h.z - 0.12), (h.x, yy + 0.06, h.z + 0.04), M, "MetalDark")
            if i % 2 == 0:
                for sx in (-1, 1):
                    acc.box((sx * h.x - 0.08, yy - 0.06, -h.z - 1.5), (sx * h.x + 0.08, yy + 0.06, -h.z), M, "MetalDark")
        for sx in (-1, 1):
            acc.box((sx * h.x - 0.1, -h.y, -h.z - 0.14), (sx * h.x + 0.1, h.y, h.z + 0.06), M, "MetalDark")
            acc.box((sx * (h.x - 0.12) - 0.03, -h.y, -h.z - 0.2), (sx * (h.x - 0.12) + 0.03, h.y, -h.z - 0.14), M, "NeonAmber")
        return
    acc.box((-h.x, -h.y, -h.z), (h.x, h.y, h.z), M, "MetalDark")
    # 縁のネオン
    acc.box((-h.x - 0.03, -h.y - 0.03, -h.z + 0.05), (h.x + 0.03, h.y + 0.03, -h.z + 0.12), M, "NeonPurple")
    # 屋根の上の天窓の筋
    long_x = h.x >= h.y
    L = h.x if long_x else h.y
    for i in range(int(L * 2 / 3)):
        a = -L + 1.5 + 3 * i
        if long_x:
            acc.box((a - 0.5, -h.y + 0.6, h.z), (a + 0.5, h.y - 0.6, h.z + 0.06), M, "Glass")
        else:
            acc.box((-h.x + 0.6, a - 0.5, h.z), (h.x - 0.6, a + 0.5, h.z + 0.06), M, "Glass")


def build_rail(acc, b):
    """手すり：1.5m ごとの支柱、上の手すり、中の横棒、足元の光"""
    M = box_matrix(b)
    h = box_half(b)
    L = h.y  # 手すりはローカルの z（Blender の -y）方向に長い
    n = max(1, int(L * 2 / 1.5))
    for i in range(n + 1):
        a = -L + 2 * L * i / n
        acc.box((-0.04, a - 0.04, -h.z), (0.04, a + 0.04, h.z), M, "MetalDark")
    acc.box((-0.06, -L, h.z - 0.07), (0.06, L, h.z), M, "Metal")
    acc.box((-0.02, -L, -0.1), (0.02, L, -0.05), M, "Metal")
    acc.box((-0.015, -L, -h.z + 0.25), (0.015, L, h.z - 0.2), M, "Glass")
    acc.box((-0.05, -L, -h.z), (0.05, L, -h.z + 0.04), M, "NeonCyan")


def build_step(acc, b):
    """階段の1段（見た目は段の上の部分だけ。段鼻に光る線）"""
    M = box_matrix(b)
    h = box_half(b)
    vis = b.get("vis") or {}
    rise = float(vis.get("rise", 0.25))
    depth = min(h.z * 2, rise * 4 + 0.6)
    acc.box((-h.x, -h.y, h.z - depth), (h.x, h.y, h.z), M, "ConcreteDark", top="Floor")
    # 段鼻（上り方向はローカル -y の向き）。建物の中の階段は控えめに（1段おきに細い線）
    indoor = any(in_room(M.translation, r) for r in ROOMS.values())
    if indoor:
        acc.box((-h.x + 0.1, -h.y - 0.01, h.z - 0.03), (h.x - 0.1, -h.y + 0.06, h.z + 0.004), M, "PaintYellow")
    else:
        acc.box((-h.x, -h.y - 0.01, h.z - 0.05), (h.x, -h.y + 0.05, h.z + 0.005), M, "NeonCyan" if vis.get("step", 0) % 2 == 0 else "NeonAmber")
    # 横の側板
    for s in (-1, 1):
        acc.box((s * h.x - 0.08 * (s > 0) - 0.0 * (s < 0) if s > 0 else -h.x, -h.y, h.z - depth - 0.3), (h.x if s > 0 else -h.x + 0.08, h.y, h.z + 0.08), M, "MetalDark")


def build_ramp(acc, b):
    """坂（見た目は階段）。上面の高さに段の中央をそろえる"""
    if (b.get("vis") or {}).get("smooth"):
        return build_ramp_smooth(acc, b)
    M = box_matrix(b)
    h = box_half(b)
    # 坂の箱はローカルで傾いている。ワールドの上下方向に段を作るため、両端の上面の点を求める
    r = b.get("rot") or {"x": 0, "y": 0}
    yaw = math.radians(r["y"])
    top_a = M @ Vector((0, h.y, h.z))  # ローカル +y 側（three の -z 側）
    top_b = M @ Vector((0, -h.y, h.z))
    lo, hi = (top_a, top_b) if top_a.z < top_b.z else (top_b, top_a)
    rise_total = hi.z - lo.z
    n = max(1, int(round(rise_total / 0.25)))
    W = h.x
    R = Matrix.Rotation(yaw, 4, "Z")
    for i in range(n):
        t0 = i / n
        t1 = (i + 1) / n
        p0 = lo.lerp(hi, t0)
        p1 = lo.lerp(hi, t1)
        ztop = lo.z + rise_total * (i + 0.5) / n + 0.125
        c = (p0 + p1) / 2
        Ms = Matrix.Translation(Vector((c.x, c.y, 0))) @ R
        half_run = (Vector((p1.x - p0.x, p1.y - p0.y, 0))).length / 2
        acc.box((-W, -half_run - 0.01, ztop - 0.6), (W, half_run + 0.01, ztop), Ms, "ConcreteDark", top="Floor")
        acc.box((-W, -half_run - 0.02, ztop - 0.05), (W, -half_run + 0.04, ztop + 0.004), Ms, "NeonAmber")
    # 側面の支え
    for s in (-1, 1):
        a = lo + R @ Vector((s * W, 0, 0))
        bb = hi + R @ Vector((s * W, 0, 0))
        acc.cyl(a + Vector((0, 0, -0.4)), bb + Vector((0, 0, -0.4)), 0.12, Matrix.Identity(4), "MetalDark", n=6)


CONTAINER_MAT = {"red": "ContainerRed", "blue": "ContainerBlue", "teal": "ContainerTeal", "orange": "ContainerOrange"}


def build_container(acc, b):
    M = box_matrix(b)
    h = box_half(b)
    mat = CONTAINER_MAT.get((b.get("vis") or {}).get("color", "blue"), "ContainerBlue")
    acc.box((-h.x, -h.y, -h.z), (h.x, h.y, h.z), M, mat)
    # 波板（長い側面に縦の筋）
    n = int(h.y * 2 / 0.32)
    for s in (-1, 1):
        for i in range(n):
            a = -h.y + 0.25 + i * (h.y * 2 - 0.5) / max(1, n - 1)
            acc.box((s * h.x - 0.03 if s > 0 else -h.x - 0.03, a - 0.06, -h.z + 0.1), (s * h.x + 0.03 if s > 0 else -h.x + 0.03, a + 0.06, h.z - 0.1), M, mat)
    # 角の柱と扉の取っ手
    for sx in (-1, 1):
        for sy in (-1, 1):
            acc.box((sx * h.x - 0.08, sy * h.y - 0.08, -h.z), (sx * h.x + 0.08, sy * h.y + 0.08, h.z), M, "MetalDark")
    for i in (-0.4, 0.4):
        acc.box((i - 0.03, -h.y - 0.06, -h.z + 0.2), (i + 0.03, -h.y - 0.02, h.z - 0.2), M, "Metal")
    # 白い番号の帯
    acc.box((-h.x - 0.035, -1.2, h.z - 0.6), (-h.x - 0.03, 1.2, h.z - 0.35), M, "NeonWhite")


def build_ac(acc, b):
    M = box_matrix(b)
    h = box_half(b)
    acc.box((-h.x, -h.y, -h.z), (h.x, h.y, h.z), M, "Metal")
    r = min(h.x, h.y) * 0.75
    acc.disc((0, 0, h.z + 0.01), r, M, "MetalDark", n=20)
    for a in range(4):
        t = a * math.pi / 4
        acc.box((-r, -0.03, h.z + 0.01), (r, 0.03, h.z + 0.05), M @ Matrix.Rotation(t, 4, "Z"), "Metal")
    # 横の吸気口
    for i in range(5):
        z = -h.z + 0.2 + i * (h.z * 2 - 0.4) / 5
        acc.box((-h.x * 0.8, -h.y - 0.02, z), (h.x * 0.8, -h.y + 0.01, z + 0.07), M, "MetalDark")
    acc.box((h.x - 0.25, -h.y - 0.02, h.z - 0.3), (h.x - 0.12, -h.y + 0.01, h.z - 0.17), M, "NeonCyan")


def build_crate(acc, b):
    M = box_matrix(b)
    h = box_half(b)
    acc.box((-h.x, -h.y, -h.z), (h.x, h.y, h.z), M, "Wood")
    e = 0.07
    for sx in (-1, 1):
        for sy in (-1, 1):
            acc.box((sx * h.x - e, sy * h.y - e, -h.z), (sx * h.x + e, sy * h.y + e, h.z), M, "MetalDark")
    for sz in (-1, 1):
        acc.box((-h.x - e, -h.y - e, sz * h.z - e), (h.x + e, h.y + e, sz * h.z + e), M, "MetalDark")


def build_lowwall(acc, b):
    M = box_matrix(b)
    h = box_half(b)
    if (b.get("vis") or {}).get("parapet"):
        # 立体駐車場の腰壁：コンクリートと、上の金属の笠木・外側の光の線
        acc.box((-h.x, -h.y, -h.z), (h.x, h.y, h.z - 0.06), M, "Concrete")
        acc.box((-h.x - 0.03, -h.y - 0.03, h.z - 0.06), (h.x + 0.03, h.y + 0.03, h.z), M, "MetalDark")
        acc.box((-h.x - 0.012, -h.y - 0.012, -h.z + 0.4), (h.x + 0.012, h.y + 0.012, -h.z + 0.46), M, "NeonCyan")
        return
    acc.box((-h.x, -h.y, -h.z), (h.x, h.y, h.z), M, "Concrete", top="ConcreteDark")
    acc.box((-h.x - 0.01, -h.y - 0.01, h.z - 0.18), (h.x + 0.01, h.y + 0.01, h.z - 0.1), M, "NeonAmber")


def build_kiosk(acc, b):
    M = box_matrix(b)
    h = box_half(b)
    acc.box((-h.x, -h.y, -h.z), (h.x, h.y, h.z), M, "ConcreteDark", top="MetalDark")
    # 正面（three の +z ＝ Blender の -y）にシャッターと庇
    acc.box((-h.x + 0.4, -h.y - 0.05, -h.z + 0.1), (h.x - 0.4, -h.y, h.z - 0.9), M, "Window", color=(1.0, 0.55, 0.25, 1))  # （箱の窓は UV なし：中の模様なしで光る）
    acc.box((-h.x - 0.2, -h.y - 1.4, h.z - 0.9), (h.x + 0.2, -h.y, h.z - 0.75), M, "Awning")
    acc.box((-h.x - 0.2, -h.y - 1.45, h.z - 0.95), (h.x + 0.2, -h.y - 1.38, h.z - 0.75), M, "NeonPink")
    # 裏側にも窓
    acc.box((-h.x + 0.6, h.y, -h.z + 1.0), (h.x - 0.6, h.y + 0.05, h.z - 1.0), M, "Window", color=(0.3, 0.75, 1.0, 1))


def build_billboard(acc, b):
    """ホログラム看板の枠（画面はゲーム側で描く）"""
    M = box_matrix(b)
    h = box_half(b)
    acc.box((-h.x * 0.4, -h.y, -h.z), (h.x * 0.4, h.y, h.z), M, "Screen")
    e = 0.18
    for sz in (-1, 1):
        acc.box((-h.x - 0.05, -h.y - e, sz * h.z - e), (h.x + 0.05, h.y + e, sz * h.z + e), M, "MetalDark")
    for sy in (-1, 1):
        acc.box((-h.x - 0.05, sy * h.y - e, -h.z), (h.x + 0.05, sy * h.y + e, h.z), M, "MetalDark")
    # 吊り下げのワイヤー（上へ）
    for sy in (-0.7, 0.7):
        acc.cyl((0, sy * h.y, h.z), (0, sy * h.y * 1.1, h.z + 6), 0.03, M, "Metal", n=4, caps=False)


def build_plaza(acc, b):
    """円形広場：八角形の床の帯（4本）。模様は代表の1本（octagon=0）のときにまとめて作る"""
    M = box_matrix(b)
    h = box_half(b)
    vis = b.get("vis") or {}
    acc.box((-h.x, -h.y, max(-h.z, VIS_BOTTOM - M.translation.z)), (h.x, h.y, h.z), M, "Concrete", top="Floor", skip=("bottom",))
    if vis.get("octagon") != 0:
        return
    top = h.z
    C = Matrix.Translation(Vector((M.translation.x, M.translation.y, 0)))
    ztop = M.translation.z + top
    # 床の円の模様（ネオンの輪と放射状の線）
    for r0, r1, mat in ((7.6, 7.75, "NeonPink"), (11.0, 11.12, "NeonCyan"), (12.6, 12.68, "NeonPurple")):
        acc.ring((0, 0, 0), r0, r1, C, mat, n=72, z=ztop + 0.006)
    for k in range(16):
        t = k * math.pi / 8
        R = C @ Matrix.Rotation(t, 4, "Z")
        acc.poly([(7.8, -0.04, ztop + 0.006), (10.9, -0.04, ztop + 0.006), (10.9, 0.04, ztop + 0.006), (7.8, 0.04, ztop + 0.006)], "NeonWhite" if k % 4 == 0 else "ConcreteDark", WHITE, R)
    # 外周の縁の帯
    r = vis.get("r", 14)
    for k in range(8):
        t0 = (k - 0.5) * math.pi / 4
        t1 = (k + 0.5) * math.pi / 4
        R = r / math.cos(math.pi / 8)
        p0 = Vector((math.cos(t0) * R, math.sin(t0) * R, ztop - 0.6))
        p1 = Vector((math.cos(t1) * R, math.sin(t1) * R, ztop - 0.6))
        acc.poly([p0 * 1.002, p1 * 1.002, p1 * 1.002 + Vector((0, 0, 0.1)), p0 * 1.002 + Vector((0, 0, 0.1))], "NeonPink", WHITE, C)
    # ベンチ（低い。当たり判定なし。座面が低いので邪魔にならない）
    for k in range(4):
        t = k * math.pi / 2 + math.pi / 4
        R = C @ Matrix.Rotation(t, 4, "Z") @ Matrix.Translation(Vector((6.0, 0, ztop)))
        acc.box((-0.3, -1.2, 0), (0.3, 1.2, 0.42), R, "Wood")
        acc.box((-0.35, -1.25, 0.0), (0.35, 1.25, 0.08), R, "MetalDark")


def build_planter(acc, b):
    M = box_matrix(b)
    h = box_half(b)
    acc.box((-h.x, -h.y, -h.z), (h.x, h.y, h.z), M, "Stone", top="ConcreteDark")
    vis = b.get("vis") or {}
    if vis.get("octagon") == 0 and vis.get("r", 0) < 4:
        C = Matrix.Translation(Vector((M.translation.x, M.translation.y, 0)))
        acc.ring((0, 0, 0), 2.6, 3.0, C, "NeonPink", n=48, z=M.translation.z + h.z + 0.01)
        # 土
        acc.disc((0, 0, M.translation.z + h.z + 0.015), 2.55, C, "Bark", n=32)


def build_trunk(acc, b):
    pass  # 桜の木の飾りで描く


def build_box_plain(acc, b, mat="Concrete"):
    M = box_matrix(b)
    h = box_half(b)
    acc.box((-h.x, -h.y, -h.z), (h.x, h.y, h.z), M, mat)


# ---------------------------------------------------------------------------
# 街（地面・中に入れる建物・各階の床・立体駐車場・家具・車）
# ---------------------------------------------------------------------------

# 部屋（中に入れる建物）の範囲。three.js の座標（x, z）。名前 → (x0, z0, x1, z1)
ROOMS = {}
for _b in BOXES:
    if _b.get("tag") == "shell":
        v = _b["vis"]
        ROOMS[v["name"]] = (v["rx0"], v["rz0"], v["rx1"], v["rz1"])

ROOM_NEON = {
    "station": "NeonCyan",
    "arcade": "NeonPink",
    "pachinko": "NeonAmber",
    "office": "NeonWhite",
    "cafe": "NeonAmber",
    "hotel": "NeonPink",
    "ramen": "NeonRed",
    "bathhouse": "NeonCyan",
    "store": "NeonWhite",
    "shop_a": "NeonCyan",
    "shop_b": "NeonPurple",
    "shop_c": "NeonAmber",
    "shop_d": "NeonPink",
}


def room_neon(name):
    return ROOM_NEON.get(str(name).rstrip("'"), "NeonSoft")


def in_room(p_world, room, margin=0.0):
    x, z = to_three(p_world)
    x0, z0, x1, z1 = room
    return x0 - margin < x < x1 + margin and z0 - margin < z < z1 + margin


def quad_xz(acc, x0, z0, x1, z1, y, mat, color=WHITE):
    """three.js の座標の長方形（水平。上向き）"""
    acc.poly([T((x0, y, z1)), T((x1, y, z1)), T((x1, y, z0)), T((x0, y, z0))], mat, color)


def build_ground(acc, b):
    """地面：上の面だけ（濡れたタイルの歩道。道路は 'road' の飾りで上に描く）"""
    c, s = b["center"], b["size"]
    y = c["y"] + s["y"] / 2
    quad_xz(acc, c["x"] - s["x"] / 2, c["z"] - s["z"] / 2, c["x"] + s["x"] / 2, c["z"] + s["z"] / 2, y, "Floor")


def box_faces(M, h):
    """箱の6つの面：(名前, ローカルの中心, ローカルの法線, 頂点)"""
    x0, y0, z0 = -h.x, -h.y, -h.z
    x1, y1, z1 = h.x, h.y, h.z
    return [
        ("top", Vector((0, 0, z1)), Vector((0, 0, 1)), [(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]),
        ("bottom", Vector((0, 0, z0)), Vector((0, 0, -1)), [(x0, y0, z0), (x0, y1, z0), (x1, y1, z0), (x1, y0, z0)]),
        ("+x", Vector((x1, 0, 0)), Vector((1, 0, 0)), [(x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)]),
        ("-x", Vector((x0, 0, 0)), Vector((-1, 0, 0)), [(x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0)]),
        ("+y", Vector((0, y1, 0)), Vector((0, 1, 0)), [(x0, y1, z0), (x0, y1, z1), (x1, y1, z1), (x1, y1, z0)]),
        ("-y", Vector((0, y0, 0)), Vector((0, -1, 0)), [(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)]),
    ]


def build_shell(acc, b):
    """中に入れる建物の外壁。外側はコンクリート、内側は内装の壁。扉の上にネオン、内側の壁に光の帯"""
    M = box_matrix(b)
    h = box_half(b)
    vis = b.get("vis") or {}
    room = (vis["rx0"], vis["rz0"], vis["rx1"], vis["rz1"])
    neon = room_neon(vis.get("name"))
    wy0 = M.translation.z - h.z  # 箱の下端（ワールドの高さ）
    floor_y = max(0.0, wy0)
    for name, c, n, pts in box_faces(M, h):
        cw = M @ c
        if name == "bottom":
            if wy0 < 0:
                continue  # 地面の下
            if vis.get("lintel"):
                acc.poly(pts, "ConcreteDark", WHITE, M)
            continue
        if name == "top":
            # 屋上の床と重なる上の面は描かない
            if inside_other(cw - Vector((0, 0, 0.03)), b, 0.0, ("slab",)):
                continue
            acc.poly(pts, "MetalDark" if vis.get("sill") else "ConcreteDark", WHITE, M)
            continue
        out = cw + (M.to_3x3() @ n) * 0.05
        interior = in_room(out, room)
        acc.poly(pts, "Interior" if interior else "Concrete", WHITE, M)
        # 面の向き・大きさ（ローカル）
        if abs(n.x) > 0.5:
            t = Vector((0, 1, 0))
            half_w = h.y
        else:
            t = Vector((1, 0, 0))
            half_w = h.x
        p0 = c + n * 0.015
        if half_w < 0.25:
            continue  # 開口の横の小口
        if interior:
            # 腰の高さの帯と、天井近くの光の帯（各階の床から）
            for y_rel, hh, mat in ((0.0, 0.12, "ConcreteDark"), (2.75, 0.05, neon)):
                zw = floor_y + y_rel
                if vis.get("lintel") or vis.get("sill"):
                    continue
                if zw < wy0 - 0.01 or zw + hh > wy0 + 2 * h.z + 0.01:
                    continue
                zl = zw - M.translation.z
                acc.poly([p0 - t * half_w + Vector((0, 0, zl)), p0 + t * half_w + Vector((0, 0, zl)), p0 + t * half_w + Vector((0, 0, zl + hh)), p0 - t * half_w + Vector((0, 0, zl + hh))], mat, WHITE, M)
        else:
            # 外側：上の階の床の高さの帯、扉の上のネオン
            if 3.5 < wy0 < 30 and not vis.get("lintel"):
                zl = -h.z
                acc.poly([p0 - t * half_w + Vector((0, 0, zl)), p0 + t * half_w + Vector((0, 0, zl)), p0 + t * half_w + Vector((0, 0, zl + 0.3)), p0 - t * half_w + Vector((0, 0, zl + 0.3))], "ConcreteDark", WHITE, M)
            if vis.get("door"):
                zl = -h.z
                acc.poly([p0 - t * half_w + Vector((0, 0, zl + 0.02)), p0 + t * half_w + Vector((0, 0, zl + 0.02)), p0 + t * half_w + Vector((0, 0, zl + 0.12)), p0 - t * half_w + Vector((0, 0, zl + 0.12))], neon, WHITE, M)
            # 2階より上の、開口のない壁には窓（中は見えない。明かりだけ）
            if 3.5 < wy0 < 30 and not vis.get("lintel") and not vis.get("sill") and half_w > 1.4:
                cols = max(1, int(half_w * 2 / 2.6))
                cwid = half_w * 2 / cols
                zl0 = -h.z + 1.0
                zl1 = min(h.z - 0.5, -h.z + 2.6)
                for i in range(cols):
                    cx = -half_w + cwid * (i + 0.5)
                    ww = min(0.75, cwid * 0.32)
                    acc.poly([p0 + t * (cx - ww) + Vector((0, 0, zl0)), p0 + t * (cx + ww) + Vector((0, 0, zl0)), p0 + t * (cx + ww) + Vector((0, 0, zl1)), p0 + t * (cx - ww) + Vector((0, 0, zl1))], "Window", window_color(), M, uv=WIN_UV)
            # 1階の外壁：縦のネオンの線（6m ごと）
            if wy0 < 0 and not vis.get("sill") and not vis.get("lintel") and half_w > 2.5:
                k = max(1, int(half_w * 2 / 6))
                for i in range(1, k + 1):
                    cx = -half_w + half_w * 2 * i / (k + 1)
                    zl = -M.translation.z
                    acc.poly([p0 + t * (cx - 0.04) + Vector((0, 0, zl + 0.5)), p0 + t * (cx + 0.04) + Vector((0, 0, zl + 0.5)), p0 + t * (cx + 0.04) + Vector((0, 0, zl + 3.6)), p0 + t * (cx - 0.04) + Vector((0, 0, zl + 3.6))], neon, WHITE, M)
            # 地面から建つ壁の足元
            if wy0 < 0 and not vis.get("sill"):
                zl = -M.translation.z
                acc.poly([p0 - t * half_w + Vector((0, 0, zl)), p0 + t * half_w + Vector((0, 0, zl)), p0 + t * half_w + Vector((0, 0, zl + 0.35)), p0 - t * half_w + Vector((0, 0, zl + 0.35))], "ConcreteDark", WHITE, M)
    # 窓の開口：腰壁の上と、まぐさの下に金属の枠
    if vis.get("sill"):
        acc.box((-h.x - 0.02, -h.y - 0.02, h.z - 0.06), (h.x + 0.02, h.y + 0.02, h.z), M, "MetalDark")


def ceiling_panels(acc, x0, z0, x1, z1, y, mat, size=(1.2, 0.5), step=4.0):
    """天井の照明パネル（three.js の座標の長方形の下の面に並べる）"""
    W, D = x1 - x0, z1 - z0
    if W < 2.0 or D < 2.0:
        return
    nx = max(1, int(W / step))
    nz = max(1, int(D / step))
    for i in range(nx):
        for k in range(nz):
            cx = x0 + W * (i + 0.5) / nx
            cz = z0 + D * (k + 0.5) / nz
            a, d = size if W >= D else (size[1], size[0])
            acc.poly([T((cx - a / 2, y, cz - d / 2)), T((cx + a / 2, y, cz - d / 2)), T((cx + a / 2, y, cz + d / 2)), T((cx - a / 2, y, cz + d / 2))], mat)


def build_slab(acc, b):
    """床の板：屋上（濡れた床と縁のネオン）・建物の中の床（天井に照明）・立体駐車場の床"""
    M = box_matrix(b)
    h = box_half(b)
    vis = b.get("vis") or {}
    c, s = b["center"], b["size"]
    x0, x1 = c["x"] - s["x"] / 2, c["x"] + s["x"] / 2
    z0, z1 = c["z"] - s["z"] / 2, c["z"] + s["z"] / 2
    top_y = c["y"] + s["y"] / 2
    bot_y = c["y"] - s["y"] / 2
    roof = bool(vis.get("roof"))
    garage = bool(vis.get("garage"))
    name = vis.get("name")
    room = (vis["rx0"], vis["rz0"], vis["rx1"], vis["rz1"]) if name else None
    if garage:
        top_mat = "Floor" if top_y >= 14.9 else "GarageFloor"
    else:
        top_mat = "Floor" if roof or not name else "FloorIn"
    for fname, lc, n, pts in box_faces(M, h):
        cw = M @ lc
        if fname == "top":
            acc.poly(pts, top_mat, WHITE, M)
            continue
        if fname == "bottom":
            acc.poly(pts, "Ceiling", WHITE, M)
            continue
        nw = M.to_3x3() @ n
        out = cw + nw * 0.05
        if inside_other(out, b, 0.0, ("shell",)):
            continue  # 外壁に接する面
        on_edge = room is not None and not in_room(out, room, 0.45)
        if roof and on_edge:
            continue  # 屋上の外周は軒（下で作る）
        acc.poly(pts, "ConcreteDark", WHITE, M)
        # 穴の縁（階段の上など）：床の上に黄色の線
        if room is not None and not on_edge and not inside_other(out, b, 0.0, ("slab",)):
            if abs(n.x) > 0.5:
                t, half_w = Vector((0, 1, 0)), h.y
            else:
                t, half_w = Vector((1, 0, 0)), h.x
            q = lc - n * 0.12
            zt = h.z + 0.006
            acc.poly([q - t * half_w - n * 0.0 + Vector((0, 0, zt - lc.z)), q + t * half_w + Vector((0, 0, zt - lc.z)), q + t * half_w + n * 0.1 + Vector((0, 0, zt - lc.z)), q - t * half_w + n * 0.1 + Vector((0, 0, zt - lc.z))], "PaintYellow", WHITE, M)
        if garage:
            # 駐車場の床の縁のネオン
            if abs(n.x) > 0.5:
                t, half_w = Vector((0, 1, 0)), h.y
            else:
                t, half_w = Vector((1, 0, 0)), h.x
            q = lc + n * 0.015
            acc.poly([q - t * half_w + Vector((0, 0, -0.05)), q + t * half_w + Vector((0, 0, -0.05)), q + t * half_w + Vector((0, 0, 0.05)), q - t * half_w + Vector((0, 0, 0.05))], "NeonCyan", WHITE, M)
    # 屋上の軒（外周に 8cm 張り出す帯と、ネオンの線）
    if roof and room is not None:
        fx0, fz0, fx1, fz1 = room[0] - 0.4, room[1] - 0.4, room[2] + 0.4, room[3] + 0.4
        e = 0.08
        for side in ("w", "e", "n", "s"):
            if side == "w" and abs(x0 - fx0) < 0.02:
                lo, hi = (x0 - e, bot_y - 0.1, z0 - (e if abs(z0 - fz0) < 0.02 else 0)), (x0, top_y, z1 + (e if abs(z1 - fz1) < 0.02 else 0))
            elif side == "e" and abs(x1 - fx1) < 0.02:
                lo, hi = (x1, bot_y - 0.1, z0 - (e if abs(z0 - fz0) < 0.02 else 0)), (x1 + e, top_y, z1 + (e if abs(z1 - fz1) < 0.02 else 0))
            elif side == "n" and abs(z0 - fz0) < 0.02:
                lo, hi = (x0, bot_y - 0.1, z0 - e), (x1, top_y, z0)
            elif side == "s" and abs(z1 - fz1) < 0.02:
                lo, hi = (x0, bot_y - 0.1, z1), (x1, top_y, z1 + e)
            else:
                continue
            tb = Matrix.Identity(4)
            a, bb = T(lo), T(hi)
            acc.box((min(a.x, bb.x), min(a.y, bb.y), a.z), (max(a.x, bb.x), max(a.y, bb.y), bb.z), tb, "ConcreteDark", top="MetalDark")
            # ネオンの線
            a2, b2 = T((lo[0] - 0.01 if side == "w" else lo[0], bot_y + 0.12, lo[2] - 0.01 if side == "n" else lo[2])), T((hi[0] + 0.01 if side == "e" else hi[0], bot_y + 0.2, hi[2] + 0.01 if side == "s" else hi[2]))
            acc.box((min(a2.x, b2.x), min(a2.y, b2.y), a2.z), (max(a2.x, b2.x), max(a2.y, b2.y), b2.z), tb, "NeonPurple")
    # 天井の照明
    if name and not (roof and False):
        ceiling_panels(acc, x0, z0, x1, z1, bot_y - 0.01, "NeonWarm")
    elif garage:
        ceiling_panels(acc, x0, z0, x1, z1, bot_y - 0.01, "NeonWhite", size=(2.4, 0.12), step=5.0)


def room_floors(acc):
    """建物の1階の床（内装のタイル）"""
    for name, (x0, z0, x1, z1) in ROOMS.items():
        quad_xz(acc, x0, z0, x1, z1, 0.012, "FloorIn")


def garage_marks(acc):
    """立体駐車場：1階の床と、各階の駐車枠の線（車路の列のない所に並べる）"""
    ramps = [b for b in BOXES if b.get("tag") == "ramp" and (b.get("vis") or {}).get("smooth")]
    slabs = [b for b in BOXES if b.get("tag") == "slab" and (b.get("vis") or {}).get("garage")]
    if not slabs or not ramps:
        return
    gx0 = min(b["center"]["x"] - b["size"]["x"] / 2 for b in slabs)
    gx1 = max(b["center"]["x"] + b["size"]["x"] / 2 for b in slabs)
    gz0 = min(b["center"]["z"] - b["size"]["z"] / 2 for b in slabs)
    gz1 = max(b["center"]["z"] + b["size"]["z"] / 2 for b in slabs)
    lanes = sorted({(round(b["center"]["x"] - b["size"]["x"] / 2, 2), round(b["center"]["x"] + b["size"]["x"] / 2, 2)) for b in ramps})
    quad_xz(acc, gx0, gz0, gx1, gz1, 0.012, "GarageFloor")
    # 車路の列のない帯
    strips = []
    cur = gx0 + 0.4
    for a, bb in lanes:
        if a - cur > 4.5:
            strips.append((cur, a - 0.3))
        cur = bb + 0.3
    if gx1 - 0.4 - cur > 4.5:
        strips.append((cur, gx1 - 0.4))
    levels = sorted({round(b["center"]["y"] + b["size"]["y"] / 2, 2) for b in slabs})
    for y in [0.0] + levels:
        yy = y + 0.018
        for x0, x1 in strips:
            L = min(5.0, x1 - x0)
            for xa, xb in ((x0, x0 + L), (x1 - L, x1)) if x1 - x0 > 9 else ((x0, x0 + L),):
                z = gz0 + 1.5
                while z < gz1 - 1.4:
                    quad_xz(acc, xa, z - 0.06, xb, z + 0.06, yy, "Paint")
                    z += 2.9
        # 車路の縁の黄色の線
        for a, bb in lanes:
            quad_xz(acc, a - 0.25, gz0 + 1, a - 0.12, gz1 - 1, yy, "PaintYellow")
            quad_xz(acc, bb + 0.12, gz0 + 1, bb + 0.25, gz1 - 1, yy, "PaintYellow")


def build_ramp_smooth(acc, b):
    """立体駐車場の車路（なめらかな坂）。上面に矢印"""
    M = box_matrix(b)
    h = box_half(b)
    acc.box((-h.x, -h.y, -h.z), (h.x, h.y, h.z), M, "ConcreteDark", top="GarageFloor", bottom="Ceiling")
    # 端の縁石と光
    for sx in (-1, 1):
        acc.box((sx * h.x - (0.15 if sx > 0 else 0), -h.y, h.z), (sx * h.x + (0.15 if sx < 0 else 0), h.y, h.z + 0.012), M, "PaintYellow")
        acc.box((sx * h.x - 0.01 if sx > 0 else -h.x - 0.02, -h.y, -0.05), (h.x + 0.02 if sx > 0 else -h.x + 0.01, h.y, 0.05), M, "NeonAmber")
    # 上り方向の矢印（three の向きで from → to。ローカル -y が to の側）
    zt = h.z + 0.012
    for k in (-0.5, 0.0, 0.5):
        yc = k * h.y * 1.4
        for sx in (-1, 1):
            acc.poly([(0, yc - 0.6, zt), (sx * 0.9, yc + 0.3, zt), (sx * 0.9, yc + 0.55, zt), (0, yc - 0.35, zt)][:: 1 if sx < 0 else -1], "Paint", WHITE, M)


def build_pillar(acc, b):
    M = box_matrix(b)
    h = box_half(b)
    acc.box((-h.x, -h.y, -h.z), (h.x, h.y, h.z), M, "Concrete", skip=("bottom",))
    # 足元の黄色と黒の帯、上の方にネオンの線
    acc.box((-h.x - 0.01, -h.y - 0.01, -h.z), (h.x + 0.01, h.y + 0.01, -h.z + 0.9), M, "PaintYellow")
    for k in range(3):
        z = -h.z + 0.15 + k * 0.28
        acc.box((-h.x - 0.015, -h.y - 0.015, z), (h.x + 0.015, h.y + 0.015, z + 0.12), M, "MetalDark")
    if h.z > 3:
        acc.box((-h.x - 0.015, -h.y - 0.015, h.z - 0.6), (h.x + 0.015, h.y + 0.015, h.z - 0.52), M, "NeonCyan")


CAR_MAT = {"red": "CarRed", "blue": "CarBlue", "white": "CarWhite", "black": "CarBlack"}


def build_car(acc, b):
    """駐車している車（当たり判定の箱 1.9 × 1.45 × 4.5 の中に収める）。前は three の +z（ローカル -y）"""
    M = box_matrix(b)
    h = box_half(b)
    mat = CAR_MAT.get((b.get("vis") or {}).get("color", "white"), "CarWhite")
    z0 = -h.z
    # 車体
    acc.box((-h.x + 0.03, -h.y + 0.05, z0 + 0.32), (h.x - 0.03, h.y - 0.05, z0 + 0.86), M, mat)
    acc.box((-h.x + 0.08, -h.y + 0.15, z0 + 0.86), (h.x - 0.08, -h.y + 1.25, z0 + 0.92), M, mat)  # ボンネットの段
    # 屋根と窓
    acc.box((-h.x + 0.16, -0.95, z0 + 0.86), (h.x - 0.16, 1.35, z0 + 1.32), M, "Screen")
    acc.box((-h.x + 0.2, -0.75, z0 + 1.32), (h.x - 0.2, 1.2, h.z), M, mat)
    # 車輪
    for sy in (-1.42, 1.42):
        for sx in (-1, 1):
            acc.cyl((sx * (h.x - 0.24), sy, z0 + 0.34), (sx * (h.x - 0.02), sy, z0 + 0.34), 0.33, M, "MetalDark", n=12)
    # 前の明かり・後ろの赤い明かり
    for sx in (-1, 1):
        acc.box((sx * (h.x - 0.32) - 0.22, -h.y + 0.03, z0 + 0.62), (sx * (h.x - 0.32) + 0.22, -h.y + 0.06, z0 + 0.74), M, "NeonWhite")
    acc.box((-h.x + 0.15, h.y - 0.06, z0 + 0.66), (h.x - 0.15, h.y - 0.03, z0 + 0.74), M, "NeonRed")
    # 車の下の影の板
    acc.box((-h.x + 0.1, -h.y + 0.3, z0 + 0.02), (h.x - 0.1, h.y - 0.3, z0 + 0.32), M, "MetalDark")


def build_furniture(acc, b):
    M = box_matrix(b)
    h = box_half(b)
    kind = (b.get("vis") or {}).get("kind", "counter")
    if kind == "cabinet":
        # ゲーム機：前はローカル -y
        acc.box((-h.x, -h.y + 0.35, -h.z), (h.x, h.y, h.z - 0.18), M, "MetalDark")
        acc.box((-h.x, -h.y, -h.z), (h.x, -h.y + 0.35, -h.z + 0.95), M, "MetalDark")
        acc.box((-h.x + 0.04, -h.y, -h.z + 0.95), (h.x - 0.04, -h.y + 0.35, -h.z + 1.02), M, "ConcreteDark")
        scr = rnd.choice(["NeonSoft", "NeonPurple", "NeonCyan"])
        acc.poly([(-h.x + 0.09, -h.y + 0.34, -h.z + 1.12), (h.x - 0.09, -h.y + 0.34, -h.z + 1.12), (h.x - 0.09, -h.y + 0.34, -h.z + 1.5), (-h.x + 0.09, -h.y + 0.34, -h.z + 1.5)], scr, WHITE, M)
        acc.box((-h.x, -h.y + 0.3, h.z - 0.18), (h.x, h.y, h.z), M, rnd.choice(["NeonPink", "NeonAmber", "NeonCyan"]))
        for i, mt in enumerate(("NeonRed", "NeonCyan", "NeonAmber")):
            xx = -0.2 + i * 0.16
            acc.box((xx - 0.04, -h.y + 0.12, -h.z + 1.02), (xx + 0.04, -h.y + 0.2, -h.z + 1.05), M, mt)
        # 横の光の線
        for sx in (-1, 1):
            acc.box((sx * h.x - 0.01 if sx > 0 else -h.x - 0.005, -h.y + 0.4, -h.z + 0.1), (h.x + 0.005 if sx > 0 else -h.x + 0.01, -h.y + 0.46, h.z - 0.2), M, "NeonPink")
    elif kind == "shelf":
        acc.box((-h.x, -h.y, -h.z), (h.x, h.y, -h.z + 0.12), M, "MetalDark")
        acc.box((-0.04, -h.y, -h.z), (0.04, h.y, h.z), M, "MetalDark")
        for sy in (-1, 1):
            acc.box((-h.x, sy * h.y - 0.04 if sy > 0 else -h.y, -h.z), (h.x, h.y if sy > 0 else -h.y + 0.04, h.z), M, "MetalDark")
        boards = [-h.z + 0.12, -h.z + 0.55, -h.z + 0.98, h.z - 0.03]
        for z in boards[1:]:
            acc.box((-h.x, -h.y, z - 0.03), (h.x, h.y, z), M, "Metal")
        mats = ["ContainerRed", "ContainerBlue", "ContainerTeal", "ContainerOrange", "Wood", "CarWhite"]
        for zi in range(3):
            zb = boards[zi]
            y = -h.y + 0.1
            while y < h.y - 0.3:
                wdt = rnd.uniform(0.18, 0.32)
                hh = rnd.uniform(0.18, 0.34)
                for sx in (-1, 1):
                    if rnd.random() < 0.15:
                        continue
                    x_in, x_out = (0.06, h.x - 0.03) if sx > 0 else (-h.x + 0.03, -0.06)
                    acc.box((x_in, y, zb), (x_out, y + wdt, zb + hh), M, rnd.choice(mats))
                y += wdt + 0.04
        acc.box((-h.x - 0.005, -h.y, h.z - 0.1), (h.x + 0.005, h.y, h.z - 0.05), M, "NeonWhite")
    else:
        acc.box((-h.x, -h.y, -h.z), (h.x, h.y, h.z - 0.06), M, "ConcreteDark")
        acc.box((-h.x - 0.04, -h.y - 0.04, h.z - 0.06), (h.x + 0.04, h.y + 0.04, h.z), M, "Wood")
        acc.box((-h.x - 0.01, -h.y - 0.01, -h.z + 0.08), (h.x + 0.01, h.y + 0.01, -h.z + 0.13), M, "NeonAmber")


def build_road(acc, d):
    """道路：アスファルト・縁石・中央の点線・横断歩道（見た目だけ。高さ 0 の地面の上に数 mm）"""
    p = d["params"] or {}
    cx, cz = d["pos"]["x"], d["pos"]["z"]
    sx, sz = d["size"]["x"], d["size"]["z"]
    x0, x1, z0, z1 = cx - sx / 2, cx + sx / 2, cz - sz / 2, cz + sz / 2
    axis = p.get("axis", "x")
    crossings = [float(v) for v in str(p.get("crossings", "")).split(",") if v.strip()]
    SW = 2.0  # 歩道の幅（道の両側。歩道は地面のタイルのまま）
    if axis == "x":
        quad_xz(acc, x0, z0 + SW, x1, z1 - SW, 0.008, "Asphalt")
    else:
        quad_xz(acc, x0 + SW, z0, x1 - SW, z1, 0.008, "Asphalt")

    def in_other(x, z, m=0.0):
        for o in ROADS:
            if o is d:
                continue
            ox, oz = o["pos"]["x"], o["pos"]["z"]
            hx, hz = o["size"]["x"] / 2, o["size"]["z"] / 2
            if abs(x - ox) < hx + m and abs(z - oz) < hz + m:
                return True
        return False

    def in_cross(a):
        return any(abs(a - c) < 2.2 for c in crossings)

    # 道に沿う向き a と、横の向き w
    if axis == "x":
        a0, a1, w0, w1 = x0, x1, z0, z1
        P = lambda a, w: (a, w)
    else:
        a0, a1, w0, w1 = z0, z1, x0, x1
        P = lambda a, w: (w, a)
    wc = (w0 + w1) / 2
    width = w1 - w0
    # 縁石（1m ごと。ほかの道路と交わる所は作らない）
    a = a0
    while a < a1 - 0.01:
        b_ = min(a1, a + 1.0)
        for w_in, w_out in ((w0 + SW + 0.22, w0 + SW), (w1 - SW - 0.22, w1 - SW)):
            mx, mz = P((a + b_) / 2, w_out + (0.6 if w_out < wc else -0.6))
            if in_other(*P((a + b_) / 2, w_out - (SW + 0.3 if w_out < wc else -SW - 0.3))):
                continue
            px0, pz0 = P(a, min(w_in, w_out))
            px1, pz1 = P(b_, max(w_in, w_out))
            quad_xz(acc, min(px0, px1), min(pz0, pz1), max(px0, px1), max(pz0, pz1), 0.014, "ConcreteDark")
        a = b_
    # 中央の点線（幅 7m 以上の道）
    if width >= 7:
        a = a0 + 1.0
        while a < a1 - 1.0:
            b_ = min(a1 - 1.0, a + 2.6)
            m = P((a + b_) / 2, wc)
            if not in_other(*m, 0.5) and not in_cross((a + b_) / 2):
                px0, pz0 = P(a, wc - 0.08)
                px1, pz1 = P(b_, wc + 0.08)
                quad_xz(acc, min(px0, px1), min(pz0, pz1), max(px0, px1), max(pz0, pz1), 0.016, "PaintYellow")
            a += 5.2
    # 横断歩道
    for c in crossings:
        w = w0 + SW + 0.5
        while w < w1 - SW - 0.8:
            px0, pz0 = P(c - 1.5, w)
            px1, pz1 = P(c + 1.5, w + 0.5)
            quad_xz(acc, min(px0, px1), min(pz0, pz1), max(px0, px1), max(pz0, pz1), 0.016, "Paint")
            w += 1.0


ROADS = [d for d in DECOR if d["type"] == "road"]


# ---------------------------------------------------------------------------
# 飾り（当たり判定なし）
# ---------------------------------------------------------------------------


def decor_matrix(d):
    return Matrix.Translation(T(d["pos"])) @ Matrix.Rotation(math.radians(d["yaw"]), 4, "Z")


def build_sakura(acc, d):
    """桜の木：曲がった幹、枝、ピンクに光る花のかたまり"""
    M = decor_matrix(d)
    trunk = [Vector((0, 0, 0)), Vector((0.2, 0.1, 1.2)), Vector((0.1, -0.2, 2.4)), Vector((-0.2, 0.0, 3.4))]
    radii = [0.55, 0.42, 0.34, 0.26]
    for i in range(len(trunk) - 1):
        acc.cyl(trunk[i], trunk[i + 1], radii[i], M, "Bark", n=10, r2=radii[i + 1], caps=i == 0)
    # 根元の張り出し
    for k in range(5):
        t = k * 2 * math.pi / 5
        acc.cyl((0, 0, 0.3), (math.cos(t) * 1.1, math.sin(t) * 1.1, -0.02), 0.22, M, "Bark", n=6, r2=0.06)
    ends = []

    def branch(p, d, r, depth):
        if depth == 0 or r < 0.05:
            ends.append(p)
            return
        L = rnd.uniform(1.2, 2.0) * (0.75 ** (3 - depth))
        q = p + d.normalized() * L
        acc.cyl(p, q, r, M, "Bark", n=6, r2=r * 0.7, caps=False)
        for _ in range(2 if depth > 1 else 3):
            nd = d.normalized() + Vector((rnd.uniform(-0.8, 0.8), rnd.uniform(-0.8, 0.8), rnd.uniform(-0.1, 0.5)))
            branch(q, nd, r * 0.65, depth - 1)

    top = trunk[-1]
    for k in range(5):
        t = k * 2 * math.pi / 5 + rnd.uniform(-0.3, 0.3)
        branch(top, Vector((math.cos(t), math.sin(t), rnd.uniform(0.4, 0.9))), 0.2, 3)
    # 花のかたまり（小さめのかたまりを枝先にたくさん。上から見ると丸い傘の形）
    for e in ends:
        for _ in range(4):
            c = e + Vector((rnd.uniform(-0.7, 0.7), rnd.uniform(-0.7, 0.7), rnd.uniform(-0.3, 0.4)))
            acc.ico(c, rnd.uniform(0.38, 0.62), M, "Blossom", sub=0, squash=0.8, jitter=0.25)
    for _ in range(46):
        a = rnd.uniform(0, 2 * math.pi)
        rr = math.sqrt(rnd.uniform(0.05, 1.0)) * 4.6
        zc = 5.6 - (rr / 4.6) ** 2 * 1.8 + rnd.uniform(-0.4, 0.4)
        c = Vector((math.cos(a) * rr, math.sin(a) * rr, zc))
        acc.ico(c, rnd.uniform(0.45, 0.75), M, "Blossom", sub=1, squash=0.75, jitter=0.25)


def build_lamp(acc, d):
    M = decor_matrix(d)
    col = (d.get("params") or {}).get("color", "#4fd1ff")
    neon = {"#4fd1ff": "NeonCyan", "#ff4fd8": "NeonPink", "#8a5cff": "NeonPurple", "#ff9ad8": "NeonPink", "#ffb45c": "NeonAmber"}.get(col, "NeonCyan")
    acc.cyl((0, 0, 0), (0, 0, 4.2), 0.08, M, "MetalDark", n=8)
    acc.box((-0.25, -0.25, 0), (0.25, 0.25, 0.25), M, "MetalDark")
    acc.cyl((0, 0, 4.2), (0.9, 0, 4.4), 0.05, M, "MetalDark", n=6, caps=False)
    acc.box((0.7, -0.16, 4.15), (1.25, 0.16, 4.3), M, "MetalDark")
    acc.box((0.72, -0.13, 4.12), (1.23, 0.13, 4.15), M, neon)
    acc.box((-0.03, -0.09, 1.0), (0.03, 0.09, 3.6), M, neon)


def build_plant(acc, d):
    M = decor_matrix(d)
    kind = (d.get("params") or {}).get("kind", "palm")
    # 鉢
    acc.cyl((0, 0, 0), (0, 0, 0.7), 0.55, M, "Stone", n=10, r2=0.65)
    acc.ring((0, 0, 0), 0.55, 0.66, M, "NeonCyan", n=16, z=0.71)
    if kind == "palm":
        pts = [Vector((0, 0, 0.7)), Vector((0.15, 0.05, 2.2)), Vector((0.05, 0.2, 3.6))]
        for i in range(2):
            acc.cyl(pts[i], pts[i + 1], 0.14 - i * 0.03, M, "Bark", n=6, r2=0.11 - i * 0.03)
        top = pts[-1]
        for k in range(8):
            t = k * 2 * math.pi / 8 + rnd.uniform(-0.2, 0.2)
            dirv = Vector((math.cos(t), math.sin(t), 0))
            mid = top + dirv * 0.9 + Vector((0, 0, 0.25))
            end = top + dirv * 1.8 + Vector((0, 0, -0.5))
            side = Vector((-dirv.y, dirv.x, 0)) * 0.22
            acc.poly([top, mid + side, end, mid - side], "Leaf", WHITE, M)
            acc.poly([top, mid - side, end, mid + side], "Leaf", WHITE, M)
    else:
        for _ in range(5):
            c = Vector((rnd.uniform(-0.4, 0.4), rnd.uniform(-0.4, 0.4), rnd.uniform(0.9, 1.5)))
            acc.ico(c, rnd.uniform(0.4, 0.6), M, "Leaf", sub=1, jitter=0.15)


def build_helipad(acc, d):
    M = decor_matrix(d)
    s = d["size"]["x"] / 2
    z = 0.008
    acc.ring((0, 0, 0), s - 0.5, s - 0.25, M, "NeonAmber", n=64, z=z)
    acc.ring((0, 0, 0), s * 0.55, s * 0.55 + 0.18, M, "NeonWhite", n=48, z=z)
    # H の字
    for lo, hi in (((-1.6, -2.2), (-1.0, 2.2)), ((1.0, -2.2), (1.6, 2.2)), ((-1.0, -0.3), (1.0, 0.3))):
        acc.poly([(lo[0], lo[1], z), (hi[0], lo[1], z), (hi[0], hi[1], z), (lo[0], hi[1], z)], "NeonWhite", WHITE, M)
    for k in range(8):
        t = k * math.pi / 4
        acc.box((math.cos(t) * (s - 0.1) - 0.12, math.sin(t) * (s - 0.1) - 0.12, 0), (math.cos(t) * (s - 0.1) + 0.12, math.sin(t) * (s - 0.1) + 0.12, 0.12), M, "NeonRed")


def build_screen_frame(acc, d):
    """大画面・看板の枠と、裏の構造（画面そのものはゲーム側で描く）"""
    M = decor_matrix(d)
    w = d["size"]["x"] / 2
    hh = d["size"]["y"] / 2
    t = d["type"]
    if t in ("screen", "logo"):
        e = 0.22
        # 画面の後ろの黒い板（画面より 5cm 奥）
        acc.box((-w, 0.06, -hh), (w, 0.3, hh), M, "MetalDark")
        for sz in (-1, 1):
            acc.box((-w - e, 0.0, sz * hh - e), (w + e, 0.3, sz * hh + e), M, "MetalDark")
        for sx in (-1, 1):
            acc.box((sx * w - e, 0.0, -hh), (sx * w + e, 0.3, hh), M, "MetalDark")
        # 縁の光
        acc.box((-w - e, -0.02, -hh - e - 0.05), (w + e, 0.02, -hh - e), M, "NeonCyan" if t == "screen" else "NeonPurple")
    elif t == "vneon":
        # 縦長の看板の箱
        acc.box((-w, 0.05, -hh), (w, 0.45, hh), M, "MetalDark")
        acc.box((-w - 0.06, -0.02, -hh - 0.06), (w + 0.06, 0.06, -hh), M, "MetalDark")
        acc.box((-w - 0.06, -0.02, hh), (w + 0.06, 0.06, hh + 0.06), M, "MetalDark")


# ---------------------------------------------------------------------------
# 遠景：マップを囲む高層ビル群と、外周の高架レール
# ---------------------------------------------------------------------------


def build_backdrop(acc):
    rng = random.Random(7)
    # マップを囲むビル（遠いほど高い）
    for i in range(46):
        a = i / 46 * 2 * math.pi + rng.uniform(-0.04, 0.04)
        r = rng.uniform(150, 215)
        x, y = math.cos(a) * r, math.sin(a) * r
        w = rng.uniform(14, 30)
        d = rng.uniform(14, 30)
        top = rng.uniform(30, 75) + (r - 150) * 0.6
        M = Matrix.Translation(Vector((x, y, 0))) @ Matrix.Rotation(rng.uniform(0, math.pi), 4, "Z")
        fake = {"center": {"x": x, "y": 0, "z": -y}}
        h = Vector((w / 2, d / 2, top))
        acc.box((-w / 2, -d / 2, VIS_BOTTOM), (w / 2, d / 2, top), M, "Concrete", skip=("bottom",))
        # 窓（大きめの格子）
        for s in range(4):
            n = Vector((1, 0, 0)) if s == 0 else Vector((-1, 0, 0)) if s == 1 else Vector((0, 1, 0)) if s == 2 else Vector((0, -1, 0))
            t = Vector((-n.y, n.x, 0))
            half_w = d / 2 if s < 2 else w / 2
            off = w / 2 if s < 2 else d / 2
            cols = int(half_w * 2 / 3.2)
            z = top - 3
            while z > -20:
                for c in range(cols):
                    if rng.random() < 0.55:
                        continue
                    cx = -half_w + (c + 0.5) * half_w * 2 / cols
                    p = n * (off + 0.02) + t * cx
                    col = window_color()
                    if col[0] == 0 and rng.random() < 0.6:
                        continue
                    acc.poly([p - t * 0.9 + Vector((0, 0, z - 1.2)), p + t * 0.9 + Vector((0, 0, z - 1.2)), p + t * 0.9 + Vector((0, 0, z)), p - t * 0.9 + Vector((0, 0, z))], "Window", col, M, uv=WIN_UV)
                z -= 3.6
        # 屋上のネオン
        acc.box((-w / 2 - 0.05, -d / 2 - 0.05, top - 1.0), (w / 2 + 0.05, d / 2 + 0.05, top - 0.8), M, rng.choice(["NeonCyan", "NeonPink", "NeonPurple", "NeonAmber"]))
        if rng.random() < 0.5:
            acc.cyl((0, 0, top), (0, 0, top + rng.uniform(8, 20)), 0.3, M, "Metal", n=6)
    # 外周の高架レール（マップを大きく回る輪。橋脚つき）
    R = 128
    n = 96
    zr = RAIL_Y
    for i in range(n):
        a0 = i / n * 2 * math.pi
        a1 = (i + 1) / n * 2 * math.pi
        p0 = Vector((math.cos(a0) * R, math.sin(a0) * R, zr))
        p1 = Vector((math.cos(a1) * R, math.sin(a1) * R, zr))
        mid = (p0 + p1) / 2
        L = (p1 - p0).length / 2 + 0.05
        M = Matrix.Translation(mid) @ Matrix.Rotation(a0 + math.pi / n + math.pi / 2, 4, "Z")
        acc.box((-L, -2.2, -0.8), (L, 2.2, 0), M, "ConcreteDark", top="MetalDark")
        acc.box((-L, -2.25, -0.55), (L, -2.18, -0.45), M, "NeonCyan")
        acc.box((-L, 2.18, -0.55), (L, 2.25, -0.45), M, "NeonPink")
        for s in (-0.8, 0.8):
            acc.box((-L, s - 0.08, 0), (L, s + 0.08, 0.15), M, "Metal")
        if i % 6 == 0:
            acc.box((-1.0, -1.0, VIS_BOTTOM), (1.0, 1.0, -0.8), M, "ConcreteDark")
            acc.box((-1.05, -1.05, -6), (1.05, 1.05, -5.85), M, "NeonCyan")
    # マップの外の地面（遠くのビルの足元まで）
    acc.ring((0, 0, 0), 60, 700, Matrix.Identity(4), "Asphalt", n=48, z=-0.05)


# ---------------------------------------------------------------------------


BUILDERS = {
    "building": build_building,
    "tower": build_tower,
    "deck": build_deck,
    "glass": build_glass,
    "roof": build_roof,
    "rail": build_rail,
    "stairs": build_step,
    "ramp": build_ramp,
    "container": build_container,
    "ac": build_ac,
    "crate": build_crate,
    "wall": build_lowwall,
    "kiosk": build_kiosk,
    "billboard": build_billboard,
    "plaza": build_plaza,
    "planter": build_planter,
    "trunk": build_trunk,
    "ground": build_ground,
    "shell": build_shell,
    "slab": build_slab,
    "pillar": build_pillar,
    "car": build_car,
    "furniture": build_furniture,
}

DECOR_BUILDERS = {
    "sakura": build_sakura,
    "lamp": build_lamp,
    "plant": build_plant,
    "helipad": build_helipad,
    "screen": build_screen_frame,
    "logo": build_screen_frame,
    "vneon": build_screen_frame,
    "road": build_road,
}


def main():
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    col = bpy.context.scene.collection
    acc = Acc()
    counts = {}
    for b in BOXES:
        tag = b.get("tag")
        if tag == "barrier":
            continue
        fn = BUILDERS.get(tag)
        if fn is None:
            build_box_plain(acc, b)
        else:
            fn(acc, b)
        counts[tag] = counts.get(tag, 0) + 1
    for d in DECOR:
        fn = DECOR_BUILDERS.get(d["type"])
        if fn:
            fn(acc, d)
    room_floors(acc)
    garage_marks(acc)
    # 遠景（マップの外のビル・高架・地面）は別のメッシュにする（ゲーム側で影の計算から外す）
    bg = Acc()
    build_backdrop(bg)
    for k, v in bg.groups.items():
        acc.groups["Bg_" + k] = v
    objs = acc.build(col)
    tris = sum(len(o.data.polygons) for o in objs)
    print("部品:", counts)
    print(f"メッシュ {len(objs)} 個・面 {tris}")
    if "--stats" in args:
        for o in sorted(objs, key=lambda o: -len(o.data.polygons))[:14]:
            print(f"  {o.name}: 面 {len(o.data.polygons)}・頂点 {len(o.data.vertices)}")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=RAW,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_vertex_color="ACTIVE",  # 頂点カラーは窓のメッシュだけにある
        export_all_vertex_colors=False,
        export_active_vertex_color_when_no_material=False,
    )
    print(f"書き出し（圧縮前）: {RAW} ({os.path.getsize(RAW) // 1024} KB)")
    # gltfpack で圧縮する（頂点を量子化し、meshopt で圧縮。ゲーム側は MeshoptDecoder で読む）
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
    except Exception as e:  # gltfpack がなければ圧縮しないで使う
        print("gltfpack が使えないため、圧縮せずに書き出します:", e)
        shutil.copy(RAW, OUT)
    if "--blend" in args:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, "neon_city.blend"))
    if "--preview" in args:
        render_preview()


def render_preview():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 24
    scene.cycles.use_denoising = False
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    world = bpy.data.worlds.new("W")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.12, 0.05, 0.18, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.6
    sun = bpy.data.lights.new("S", "SUN")
    sun.energy = 1.5
    sun.color = (1.0, 0.65, 0.5)
    so = bpy.data.objects.new("S", sun)
    so.rotation_euler = (math.radians(70), 0, math.radians(-60))
    scene.collection.objects.link(so)
    cam_data = bpy.data.cameras.new("C")
    cam_data.lens = 24
    cam = bpy.data.objects.new("C", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    pdir = os.path.join(HERE, "preview")
    os.makedirs(pdir, exist_ok=True)
    for name, loc, target in (
        ("overview", (-110, 95, 75), (0, 0, 0)),
        ("plaza", (-20, 26, 14), (0, 0, 8)),
        ("north", (-60, -10, 22), (-15, -50, 12)),
    ):
        cam.location = loc
        cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(pdir, name + ".png")
        bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    main()
