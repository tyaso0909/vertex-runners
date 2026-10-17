"""
6人のキャラクターモデルを Blender で作り、glTF（.glb）で書き出すスクリプト。

使い方：
  blender --background --python assets-src/characters/build_characters.py
  または  python assets-src/characters/build_characters.py   （pip install bpy、Python 3.11）
オプション：
  --preview   assets-src/characters/preview/<id>.png に確認用の画像を描く（正面・横・走りのポーズ）
  --blend     確認用に assets-src/characters/<id>.blend も保存する
  キャラクター名（meia など）を並べると、そのキャラクターだけ作る

書き出すもの（client/assets/characters/）
  <id>.glb      三人称の全身モデル。骨格（Rig）とアニメーション
                Idle / Run / WallRun / Slide / Jump / Shoot / Ability
                右手の骨 "hand.R" に武器を持たせる
  fp_<id>.glb   一人称視点の腕。"ArmR"（右）と "ArmL"（左）。原点は手のひら（銃を握る位置）、
                前腕は -Y（手前）へ伸びる

作り方
  - 参考画像（images/characters/）の特徴を、基本図形を組み合わせたローポリで再現する。
  - 体の部品はそれぞれ骨に固定する（スキニングなし）。骨が動くと部品がついて動く。
  - 正面は Blender の -Y（glTF / three.js では +Z）。原点は足元。身長はおよそ 1.7m。
"""

import math
import os
import sys

import bpy
from mathutils import Euler, Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT_DIR = os.path.join(ROOT, "client", "assets", "characters")
FPS = 30

# ---------------------------------------------------------------------------
# マテリアル
# ---------------------------------------------------------------------------


def srgb_to_linear(c):
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)


def hexcol(h):
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) / 255 for i in (0, 2, 4))


_mats = {}


def mat(name, color, metallic=0.0, roughness=0.6, emission=None, strength=0.0, alpha=1.0):
    key = (name, color, metallic, roughness, emission, strength, alpha)
    if key in _mats:
        return _mats[key]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    col = hexcol(color) if isinstance(color, str) else color
    b.inputs["Base Color"].default_value = (*srgb_to_linear(col), 1)
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = roughness
    if emission:
        ecol = hexcol(emission) if isinstance(emission, str) else emission
        b.inputs["Emission Color"].default_value = (*srgb_to_linear(ecol), 1)
        b.inputs["Emission Strength"].default_value = strength
    if alpha < 1:
        b.inputs["Alpha"].default_value = alpha
        m.surface_render_method = "BLENDED"
    _mats[key] = m
    return m


# ---------------------------------------------------------------------------
# 骨格
# ---------------------------------------------------------------------------

# 骨の名前：(頭の位置, しっぽの位置, 親)。L は本人の左（+X）、R は本人の右（-X）
BONES = {
    "hips": ((0, 0, 0.93), (0, 0, 1.03), None),
    "spine": ((0, 0, 1.03), (0, 0, 1.2), "hips"),
    "chest": ((0, 0, 1.2), (0, 0, 1.4), "spine"),
    "neck": ((0, 0, 1.4), (0, 0, 1.48), "chest"),
    "head": ((0, 0, 1.48), (0, 0, 1.7), "neck"),
    "shoulder.L": ((0.04, 0, 1.38), (0.16, 0, 1.38), "chest"),
    "upperarm.L": ((0.17, 0, 1.38), (0.2, 0, 1.11), "shoulder.L"),
    "forearm.L": ((0.2, 0, 1.11), (0.22, -0.01, 0.87), "upperarm.L"),
    "hand.L": ((0.22, -0.01, 0.87), (0.225, -0.015, 0.78), "forearm.L"),
    "shoulder.R": ((-0.04, 0, 1.38), (-0.16, 0, 1.38), "chest"),
    "upperarm.R": ((-0.17, 0, 1.38), (-0.2, 0, 1.11), "shoulder.R"),
    "forearm.R": ((-0.2, 0, 1.11), (-0.22, -0.01, 0.87), "upperarm.R"),
    "hand.R": ((-0.22, -0.01, 0.87), (-0.225, -0.015, 0.78), "forearm.R"),
    "thigh.L": ((0.095, 0, 0.93), (0.1, 0, 0.51), "hips"),
    "shin.L": ((0.1, 0, 0.51), (0.1, 0.02, 0.09), "thigh.L"),
    "foot.L": ((0.1, 0.02, 0.09), (0.1, -0.12, 0.03), "shin.L"),
    "thigh.R": ((-0.095, 0, 0.93), (-0.1, 0, 0.51), "hips"),
    "shin.R": ((-0.1, 0, 0.51), (-0.1, 0.02, 0.09), "thigh.R"),
    "foot.R": ((-0.1, 0.02, 0.09), (-0.1, -0.12, 0.03), "shin.R"),
}


def lerp3(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def bone_point(name, t):
    h, tl, _ = BONES[name]
    return Vector(lerp3(h, tl, t))


class Character:
    def __init__(self, cid):
        self.cid = cid
        arm_data = bpy.data.armatures.new("Rig")
        self.rig = bpy.data.objects.new("Rig", arm_data)
        bpy.context.collection.objects.link(self.rig)
        bpy.context.view_layer.objects.active = self.rig
        bpy.ops.object.mode_set(mode="EDIT")
        eb = {}
        for name, (h, t, parent) in BONES.items():
            b = arm_data.edit_bones.new(name)
            b.head = h
            b.tail = t
            # 腕と脚の骨は、ひねりの向きをそろえる（前に曲げる回転が X 軸になるように）
            b.align_roll(Vector((0, -1, 0)) if name.startswith(("upperarm", "forearm", "hand", "thigh", "shin")) else Vector((0, -1, 0)))
            if parent:
                b.parent = eb[parent]
                b.use_connect = False
            eb[name] = b
        bpy.ops.object.mode_set(mode="OBJECT")
        for pb in self.rig.pose.bones:
            pb.rotation_mode = "XYZ"
        self.parts = []

    # --- 部品を骨に固定する ---
    def attach(self, obj, bone, material, smooth=False, bevel=0.0):
        if material is not None:
            obj.data.materials.append(material)
        if bevel > 0:
            mod = obj.modifiers.new("Bevel", "BEVEL")
            mod.width = bevel
            mod.segments = 2
            mod.limit_method = "ANGLE"
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.modifier_apply(modifier=mod.name)
        if smooth:
            for p in obj.data.polygons:
                p.use_smooth = True
        pb = self.rig.pose.bones[bone]
        world = obj.matrix_world.copy()
        obj.parent = self.rig
        obj.parent_type = "BONE"
        obj.parent_bone = bone
        obj.matrix_parent_inverse = (self.rig.matrix_world @ pb.matrix @ Matrix.Translation((0, pb.bone.length, 0))).inverted()
        obj.matrix_world = world
        self.parts.append(obj)
        return obj

    def _apply(self, obj, size=None, rot=(0, 0, 0)):
        obj.rotation_euler = Euler([math.radians(r) for r in rot])
        if size is not None:
            obj.scale = size
        bpy.context.view_layer.update()
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
        return obj

    def box(self, bone, size, loc, m, rot=(0, 0, 0), bevel=0.006):
        bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
        o = self._apply(bpy.context.active_object, size, rot)
        return self.attach(o, bone, m, bevel=min(bevel, min(size) * 0.3))

    def ball(self, bone, radius, loc, m, scale=(1, 1, 1), rot=(0, 0, 0), seg=16, smooth=True, cut=None):
        """球。cut(v) が真になる頂点（世界座標）を消して穴をあけられる（フードの顔の部分など）"""
        bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=max(6, seg // 2), radius=radius, location=loc)
        o = self._apply(bpy.context.active_object, scale, rot)
        if cut is not None:
            import bmesh

            bm = bmesh.new()
            bm.from_mesh(o.data)
            mw = o.matrix_world
            bmesh.ops.delete(bm, geom=[v for v in bm.verts if cut(mw @ v.co)], context="VERTS")
            bm.to_mesh(o.data)
            bm.free()
            # 裏側も見えるように（穴の縁から中をのぞいても抜けない）
            mod = o.modifiers.new("Solid", "SOLIDIFY")
            mod.thickness = 0.006
            bpy.context.view_layer.objects.active = o
            bpy.ops.object.modifier_apply(modifier=mod.name)
        return self.attach(o, bone, m, smooth=smooth)

    def limb(self, bone, r0, r1, m, t0=0.0, t1=1.0, verts=12, scale_xy=(1, 1), smooth=True):
        """骨に沿った円すい台（腕・脚）。t0〜t1 は骨の上の範囲"""
        a = Vector(bone_point(bone, t0))
        b = Vector(bone_point(bone, t1))
        return self.tube(bone, a, b, r0, r1, m, verts, scale_xy, smooth)

    def tube(self, bone, a, b, r0, r1, m, verts=12, scale_xy=(1, 1), smooth=True):
        a, b = Vector(a), Vector(b)
        d = b - a
        bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r0, radius2=r1, depth=d.length, location=(a + b) / 2)
        o = bpy.context.active_object
        o.scale = (scale_xy[0], scale_xy[1], 1)
        o.rotation_euler = Vector((0, 0, 1)).rotation_difference(d.normalized()).to_euler()
        bpy.context.view_layer.update()
        bpy.ops.object.select_all(action="DESELECT")
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
        return self.attach(o, bone, m, smooth=smooth)

    def cone(self, bone, base, tip, r, m, verts=6, smooth=False):
        return self.tube(bone, base, tip, r, 0.0005, m, verts, smooth=smooth)

    def strip(self, bone, a, b, width, thick, m, twist=0.0):
        """布や帯（a から b へ伸びる薄い板）"""
        a, b = Vector(a), Vector(b)
        d = b - a
        bpy.ops.mesh.primitive_cube_add(size=1, location=(a + b) / 2)
        o = bpy.context.active_object
        o.scale = (width, thick, d.length)
        q = Vector((0, 0, 1)).rotation_difference(d.normalized())
        o.rotation_euler = (q @ Euler((0, 0, math.radians(twist))).to_quaternion()).to_euler()
        bpy.context.view_layer.update()
        bpy.ops.object.select_all(action="DESELECT")
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
        return self.attach(o, bone, m)

    def torus(self, bone, loc, major, minor, m, rot=(0, 0, 0)):
        bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, location=loc, major_segments=20, minor_segments=8)
        o = self._apply(bpy.context.active_object, None, rot)
        return self.attach(o, bone, m, smooth=True)

    def join_by_bone(self):
        """同じ骨に付いた部品を1つのメッシュにまとめる（描画の負荷を下げる）"""
        by_bone = {}
        for o in self.parts:
            by_bone.setdefault(o.parent_bone, []).append(o)
        for bone, objs in by_bone.items():
            bpy.ops.object.select_all(action="DESELECT")
            for o in objs:
                o.select_set(True)
            bpy.context.view_layer.objects.active = objs[0]
            if len(objs) > 1:
                bpy.ops.object.join()
            j = bpy.context.active_object
            j.name = "mesh_" + bone
            j.data.name = "mesh_" + bone


# ---------------------------------------------------------------------------
# 共通の体
# ---------------------------------------------------------------------------


def base_body(c: Character, skin, suit, midriff_skin=True, eye="#4fd1ff", leg=None, arm=None):
    """頭・首・胴・腕・脚の素体。服はキャラクターごとに上から重ねる"""
    leg = leg or suit
    arm = arm or skin
    # 頭
    c.ball("head", 0.1, (0, 0.005, 1.585), skin, scale=(0.92, 1.0, 1.12), seg=20)
    c.ball("head", 0.045, (0, -0.045, 1.525), skin, scale=(1.2, 1.0, 0.8), seg=12)  # あご
    eyem = mat("Eye_" + eye, eye, emission=eye, strength=2.5)
    dark = mat("EyeLine", "#1a1418", roughness=0.8)
    for s in (-1, 1):
        c.box("head", (0.03, 0.006, 0.02), (s * 0.034, -0.093, 1.597), eyem, bevel=0.002)
        c.box("head", (0.036, 0.008, 0.006), (s * 0.035, -0.095, 1.61), dark, rot=(0, s * -8, 0), bevel=0.001)  # まつげ
    c.box("head", (0.022, 0.004, 0.004), (0, -0.098, 1.54), mat("Mouth", "#b06a6a", roughness=0.7), bevel=0.001)
    # 首
    c.limb("neck", 0.036, 0.034, skin, -0.2, 1.1)
    # 胴：胸（肩幅が広い）・腹（細い）・腰
    c.tube("chest", (0, 0.005, 1.2), (0, 0.0, 1.38), 0.082, 0.098, suit, verts=16, scale_xy=(1.45, 0.92))
    c.ball("chest", 0.098, (0, 0.0, 1.38), suit, scale=(1.45, 0.92, 0.42), seg=16)
    c.ball("chest", 0.05, (0.045, -0.055, 1.3), suit, scale=(1.0, 0.9, 0.85), seg=12)  # 胸
    c.ball("chest", 0.05, (-0.045, -0.055, 1.3), suit, scale=(1.0, 0.9, 0.85), seg=12)
    c.tube("spine", (0, 0.01, 1.0), (0, 0.006, 1.22), 0.1, 0.08, skin if midriff_skin else suit, verts=16, scale_xy=(1.3, 0.82))  # 腹
    c.ball("hips", 0.105, (0, 0.01, 0.96), suit, scale=(1.4, 1.0, 0.75), seg=16)  # 腰
    # 腕
    for s, side in ((1, "L"), (-1, "R")):
        c.ball("chest", 0.05, (s * 0.165, 0, 1.37), suit, seg=12)  # 肩
        c.limb("upperarm." + side, 0.042, 0.036, arm, 0.0, 1.0)
        c.limb("forearm." + side, 0.035, 0.03, arm, 0.0, 1.0)
        c.ball("hand." + side, 0.034, bone_point("hand." + side, 0.45), skin, scale=(0.75, 1.0, 1.25), seg=10)
        # 脚
        c.limb("thigh." + side, 0.068, 0.05, leg, 0.0, 1.0)
        c.limb("shin." + side, 0.048, 0.036, leg, 0.0, 1.0)


def shirt(c: Character, m, low=1.22):
    """上着（胸を覆う。low は裾の高さ）"""
    c.tube("chest", (0, 0.005, low), (0, 0.0, 1.385), 0.088, 0.103, m, verts=16, scale_xy=(1.45, 0.95))
    c.ball("chest", 0.103, (0, 0.0, 1.385), m, scale=(1.45, 0.95, 0.42), seg=16)
    for s in (-1, 1):
        c.ball("chest", 0.053, (s * 0.045, -0.058, 1.3), m, scale=(1.0, 0.9, 0.85), seg=12)


def boots(c: Character, main, accent, sole, heel=False, chunky=1.0, accent_glow=None):
    for s, side in ((1, "L"), (-1, "R")):
        x = s * 0.1
        c.box("foot." + side, (0.1 * chunky, 0.22, 0.075), (x, -0.045, 0.045), main, bevel=0.02)
        c.box("foot." + side, (0.106 * chunky, 0.226, 0.03), (x, -0.045, 0.012), sole, bevel=0.008)
        c.limb("shin." + side, 0.06 * chunky, 0.055 * chunky, main, 0.62, 1.0)  # 長靴の筒
        c.box("shin." + side, (0.11 * chunky, 0.03, 0.03), bone_point("shin." + side, 0.8) + Vector((0, -0.05, 0)), accent, bevel=0.005)
        if accent_glow:
            c.box("foot." + side, (0.108 * chunky, 0.06, 0.012), (x, -0.13, 0.03), accent_glow, bevel=0.003)
        if heel:
            c.box("foot." + side, (0.04, 0.04, 0.08), (x, 0.045, 0.02), sole, bevel=0.005)


def knee_pads(c: Character, m, glow=None, size=1.0):
    for s, side in ((1, "L"), (-1, "R")):
        p = Vector(bone_point("shin." + side, 0.02)) + Vector((0, -0.05, 0))
        c.box("shin." + side, (0.09 * size, 0.04, 0.1 * size), p, m, bevel=0.015)
        if glow:
            c.box("shin." + side, (0.05, 0.006, 0.012), p + Vector((0, -0.022, 0.0)), glow, bevel=0.002)


def gloves(c: Character, m, accent=None, fingerless=True):
    for s, side in ((1, "L"), (-1, "R")):
        c.ball("hand." + side, 0.037, bone_point("hand." + side, 0.42), m, scale=(0.78, 1.05, 1.15), seg=10)
        c.limb("forearm." + side, 0.037, 0.034, m, 0.82, 1.02)
        if accent:
            c.limb("forearm." + side, 0.039, 0.039, accent, 0.9, 0.95)


def belt(c: Character, m, buckle, pouches=None, n=4):
    c.tube("hips", (0, 0, 1.0), (0, 0, 1.04), 0.112, 0.112, m, verts=16, scale_xy=(1.35, 1.0))
    c.box("hips", (0.05, 0.02, 0.035), (0, -0.118, 1.02), buckle, bevel=0.004)
    if pouches:
        for i in range(n):
            a = math.radians(-60 + i * (120 / max(1, n - 1)) + 180)
            x = math.sin(a) * 0.15
            y = -math.cos(a) * 0.115
            c.box("hips", (0.05, 0.035, 0.06), (x, y, 0.985), pouches, rot=(0, 0, -math.degrees(a)), bevel=0.006)


def thigh_band(c: Character, m, side, t=0.3, r=0.072):
    c.limb("thigh." + side, r, r * 0.97, m, t, t + 0.06)


# ---------------------------------------------------------------------------
# 髪
# ---------------------------------------------------------------------------


def hair_cap(c: Character, m, back_len=0.0, scale=1.0):
    """頭を覆う髪の土台（頭頂から後頭部・耳の上まで）"""
    c.ball("head", 0.108 * scale, (0, 0.012, 1.615), m, scale=(0.98, 1.0, 1.0), seg=18)
    c.ball("head", 0.1 * scale, (0, 0.03, 1.57), m, scale=(1.04, 0.96, 1.0), seg=16)
    if back_len > 0:
        c.ball("head", 0.1, (0, 0.04, 1.56 - back_len * 0.3), m, scale=(1.0, 0.75, 1.0 + back_len), seg=14)


def spikes(c: Character, m, n, center, radius, length, spread=1.0, up=0.6, seed=1, back=0.0, front_bias=0.0, flare=0.45):
    """毛束をたくさん付ける。頭の表面から生えて、下（と後ろ）へ流れ、毛先が少し外へはねる"""
    import random

    rnd = random.Random(seed)
    cx, cy, cz = center
    placed = 0
    tries = 0
    while placed < n and tries < n * 20:
        tries += 1
        a = rnd.uniform(-math.pi, math.pi) * spread
        el = rnd.uniform(-0.35, 1.0)
        d = Vector((math.sin(a) * math.cos(el), math.cos(a) * math.cos(el) + back * 0.5, math.sin(el) * up + 0.15)).normalized()
        if d.y < -0.35 and d.z < 0.55:
            continue  # 顔の前には生やさない（前髪は bangs で作る）
        placed += 1
        base = Vector((cx, cy, cz)) + d * radius * 0.92
        flow = Vector((0, 0.35 + back * 0.4, -1))
        flow = (flow - d * flow.dot(d)).normalized()  # 頭の表面に沿って下へ
        L = length * rnd.uniform(0.7, 1.25)
        tip = base + (flow * (1 - flare) + d * flare).normalized() * L
        c.cone("head", base, tip, length * 0.3, m, verts=5)


def bangs(c: Character, m, n=7, width=0.16, z=1.655, length=0.05, seed=3, cover=0.0):
    """前髪（目にかからない長さ）"""
    import random

    rnd = random.Random(seed)
    for i in range(n):
        x = -width / 2 + width * (i + 0.5) / n
        base = Vector((x, -0.085, z + 0.025))
        tip = Vector((x * 1.15 + rnd.uniform(-0.01, 0.01), -0.104 - cover, z - length * rnd.uniform(0.7, 1.15)))
        c.cone("head", base, tip, 0.024, m, verts=5)


def ponytail(c: Character, m, root, length, thickness, droop=0.6, seed=5, strands=7, sway=0.0):
    """高い位置で結んだポニーテール（後ろへ垂れる毛束の集まり）"""
    import random

    rnd = random.Random(seed)
    r = Vector(root)
    c.ball("head", thickness * 0.9, r, m, seg=12)
    for i in range(strands):
        a = (i / strands) * math.pi * 2
        off = Vector((math.cos(a) * thickness * 0.5, math.sin(a) * thickness * 0.3, 0))
        p0 = r + off
        p1 = p0 + Vector((rnd.uniform(-0.03, 0.03) + sway, length * (1 - droop) * 0.6 + 0.04, -length * droop * 0.5))
        p2 = p1 + Vector((rnd.uniform(-0.04, 0.04) + sway, length * (1 - droop) * 0.3, -length * droop * 0.55))
        c.tube("head", p0, p1, thickness * 0.55, thickness * 0.45, m, verts=6, smooth=False)
        c.cone("head", p1, p2, thickness * 0.45, m, verts=6)


# ---------------------------------------------------------------------------
# 各キャラクター（参考画像 images/characters/<id>_*.png）
# ---------------------------------------------------------------------------


def build_meia(c: Character):
    """黒髪に赤いメッシュのショート、赤い瞳、赤いスカーフ、両腕の機械式ガントレット"""
    skin = mat("Skin", "#f2d0bd", roughness=0.7)
    black = mat("Black", "#17151a", roughness=0.75)
    leather = mat("Leather", "#24191c", metallic=0.2, roughness=0.5)
    red = mat("Red", "#e8202e", roughness=0.5)
    redglow = mat("RedGlow", "#ff3040", emission="#ff3040", strength=3.0)
    metal = mat("GunMetal", "#4a4d55", metallic=0.85, roughness=0.35)
    hair = mat("HairBlack", "#1c1416", roughness=0.6)
    hairred = mat("HairRed", "#c8202c", roughness=0.55)
    base_body(c, skin, black, midriff_skin=True, eye="#ff3040", leg=black)
    # 髪
    hair_cap(c, hair)
    spikes(c, hair, 22, (0, 0.015, 1.62), 0.1, 0.07, seed=11, back=0.25)
    spikes(c, hairred, 9, (0, 0.03, 1.6), 0.1, 0.075, seed=12, back=0.5)
    bangs(c, hair, n=6, seed=13, length=0.05)
    bangs(c, hairred, n=2, width=0.06, seed=14, length=0.045)
    # 上半身：クロップドトップ＋赤いハーネス
    shirt(c, black)
    for s in (-1, 1):
        c.strip("chest", (s * 0.09, -0.11, 1.39), (s * -0.06, -0.12, 1.22), 0.02, 0.012, red)
        c.strip("chest", (s * 0.12, 0.09, 1.4), (s * -0.06, 0.11, 1.22), 0.02, 0.012, red)
    c.tube("chest", (0, 0, 1.215), (0, 0, 1.235), 0.13, 0.13, leather, verts=16, scale_xy=(1.25, 0.95))
    # スカーフ（首に巻き、片側が背中へ長く流れる）
    c.tube("neck", (0, 0.0, 1.4), (0, 0.0, 1.47), 0.07, 0.06, red, verts=12)
    c.ball("neck", 0.06, (0.02, -0.03, 1.42), red, scale=(1.3, 1.0, 0.7), seg=10)
    c.strip("chest", (0.06, 0.07, 1.42), (0.12, 0.2, 1.1), 0.1, 0.01, red, twist=20)
    c.strip("chest", (0.12, 0.2, 1.1), (0.16, 0.3, 0.8), 0.09, 0.008, red, twist=30)
    c.strip("chest", (0.16, 0.3, 0.8), (0.2, 0.38, 0.58), 0.07, 0.006, redglow, twist=35)
    # 下半身：ショートパンツ、サスペンダー、太ももベルト
    c.ball("hips", 0.11, (0, 0.012, 0.95), black, scale=(1.42, 1.08, 0.75), seg=16)
    for s, side in ((1, "L"), (-1, "R")):
        c.limb("thigh." + side, 0.074, 0.07, black, 0.0, 0.2)
        thigh_band(c, leather, side, 0.3)
        thigh_band(c, leather, side, 0.45)
        c.box("thigh." + side, (0.05, 0.03, 0.08), Vector(bone_point("thigh." + side, 0.35)) + Vector((s * 0.06, 0, 0)), leather, bevel=0.006)
        c.strip("hips", (s * 0.08, -0.1, 1.0), (s * 0.1, -0.08, 0.78), 0.015, 0.008, red)
    belt(c, leather, metal, pouches=leather, n=4)
    # 腕：機械式ガントレット
    for s, side in ((1, "L"), (-1, "R")):
        c.limb("forearm." + side, 0.05, 0.046, leather, 0.25, 0.85, verts=8, smooth=False)
        c.limb("forearm." + side, 0.052, 0.052, metal, 0.35, 0.42, verts=8, smooth=False)
        c.box("forearm." + side, (0.04, 0.035, 0.12), Vector(bone_point("forearm." + side, 0.55)) + Vector((s * 0.0, -0.05, 0)), metal, bevel=0.006)
        c.box("forearm." + side, (0.02, 0.012, 0.06), Vector(bone_point("forearm." + side, 0.55)) + Vector((0, -0.07, 0)), redglow, bevel=0.002)
        c.tube("forearm." + side, Vector(bone_point("forearm." + side, 0.75)) + Vector((0, -0.05, 0)), Vector(bone_point("forearm." + side, 0.95)) + Vector((0, -0.06, 0)), 0.012, 0.012, metal, verts=8)
        c.limb("upperarm." + side, 0.045, 0.045, leather, 0.55, 0.65)
    gloves(c, black, accent=red)
    knee_pads(c, leather, glow=redglow)
    boots(c, black, red, mat("SoleRed", "#7a0e16", roughness=0.8), chunky=1.15, accent_glow=redglow)


def build_pearl(c: Character):
    """結晶片でできたフード付きの長いマント、灰色がかった銀髪、黄緑の差し色"""
    skin = mat("Skin", "#eed6c8", roughness=0.7)
    black = mat("Black", "#141418", roughness=0.75)
    strap = mat("Strap", "#1e1f20", metallic=0.2, roughness=0.55)
    lime = mat("Lime", "#b4e44a", emission="#b4e44a", strength=1.5)
    silver = mat("Silver", "#c8c8d0", metallic=0.85, roughness=0.3)
    hair = mat("HairGray", "#a8a8a6", roughness=0.6)
    crystal = mat("Crystal", "#cfe8b0", metallic=0.1, roughness=0.05, emission="#b4e44a", strength=0.35, alpha=0.38)
    crystal_dark = mat("CrystalDark", "#4a5a3a", metallic=0.2, roughness=0.1, emission="#b4e44a", strength=0.25, alpha=0.55)
    base_body(c, skin, black, midriff_skin=False, eye="#b4e44a", leg=black, arm=black)
    # 髪（フードの中から長い前髪と横髪）
    hair_cap(c, hair)
    bangs(c, hair, n=7, seed=21, length=0.075, cover=0.005)
    for s in (-1, 1):
        c.cone("head", (s * 0.08, -0.02, 1.6), (s * 0.085, -0.03, 1.42), 0.03, hair, verts=5)
    # 多面体のフード（顔の前は開いている）。黒地に結晶の縁取り
    import random

    rnd = random.Random(7)
    hood = mat("Hood", "#1a1d1a", roughness=0.6)
    c.ball("head", 0.135, (0, 0.025, 1.615), hood, scale=(1.0, 1.05, 1.08), seg=10, smooth=False, cut=lambda v: v.y < -0.045 and v.z < 1.69 and v.z > 1.47)
    c.cone("head", (0, 0.05, 1.7), (0, 0.1, 1.8), 0.07, hood, verts=4)
    c.torus("head", (0, -0.07, 1.6), 0.108, 0.004, lime, rot=(90, 0, 0))
    for k in range(5):
        a = math.radians(-60 + k * 30)
        top = Vector((math.sin(a) * 0.13, -0.06 + abs(math.sin(a)) * 0.05, 1.72 - abs(math.sin(a)) * 0.08))
        c.tube("head", top, top + Vector((math.sin(a) * 0.02, -0.02, -0.07)), 0.022, 0.002, crystal, verts=4, scale_xy=(1, 0.3), smooth=False)
    # 胸元のハーネスとバックル
    shirt(c, black, low=1.12)
    for s in (-1, 1):
        c.strip("chest", (s * 0.1, -0.11, 1.4), (s * -0.05, -0.12, 1.2), 0.02, 0.012, strap)
    c.box("chest", (0.05, 0.015, 0.035), (0, -0.125, 1.32), silver, bevel=0.004)
    belt(c, strap, silver, pouches=strap, n=5)
    for s, side in ((1, "L"), (-1, "R")):
        thigh_band(c, strap, side, 0.25)
        thigh_band(c, strap, side, 0.5)
        c.box("thigh." + side, (0.045, 0.03, 0.07), Vector(bone_point("thigh." + side, 0.4)) + Vector((s * 0.065, 0, 0)), strap, bevel=0.005)
        c.strip("hips", (s * 0.05, -0.115, 1.0), (s * 0.06, -0.09, 0.7), 0.02, 0.006, lime)
    # 膝からすねの菱形の装甲
    for s, side in ((1, "L"), (-1, "R")):
        for t in (0.05, 0.3):
            p = Vector(bone_point("shin." + side, t)) + Vector((0, -0.05, 0))
            c.box("shin." + side, (0.06, 0.03, 0.06), p, silver, rot=(0, 45, 0), bevel=0.006)
    gloves(c, black, accent=lime)
    boots(c, black, lime, mat("SoleGray", "#3a3d38", roughness=0.8), chunky=1.1)
    # 結晶片のマント：肩から足元近くまで、尖った半透明の破片がいくつも垂れ下がる
    for i in range(26):
        a = math.radians(rnd.uniform(70, 290))  # 背中側を中心に、体のまわりに
        r = 0.2 + rnd.uniform(0, 0.05)
        top = Vector((math.sin(a) * r * 1.1, -math.cos(a) * r * 0.75 + 0.04, 1.38 + rnd.uniform(-0.04, 0.02)))
        length = rnd.uniform(0.55, 1.15)
        out = Vector((math.sin(a), -math.cos(a), 0)) * rnd.uniform(0.04, 0.12)
        bot = top + out + Vector((0, 0, -length))
        c.tube("chest", top, bot, rnd.uniform(0.035, 0.06), 0.003, crystal if i % 3 else crystal_dark, verts=4, scale_xy=(1, 0.25), smooth=False)
    # 前側の短い破片
    for s in (-1, 1):
        for k in range(3):
            top = Vector((s * (0.15 + k * 0.03), -0.08 + k * 0.04, 1.37))
            c.tube("chest", top, top + Vector((s * 0.04, -0.03, -0.55 - k * 0.2)), 0.045, 0.003, crystal, verts=4, scale_xy=(1, 0.25), smooth=False)


def build_miranda(c: Character):
    """茶色から毛先がオレンジのポニーテール、腕と脚の重厚な装甲、腰と太ももに多数のポーチ"""
    skin = mat("Skin", "#e9c2a6", roughness=0.7)
    black = mat("Black", "#1c1714", roughness=0.75)
    pants = mat("Pants", "#2a211c", roughness=0.8)
    armor = mat("Armor", "#2a2624", metallic=0.55, roughness=0.4)
    orange = mat("Orange", "#ff7a1a", roughness=0.5)
    oglow = mat("OrangeGlow", "#ffa04a", emission="#ffa04a", strength=3.0)
    hair = mat("HairBrown", "#6b3a1e", roughness=0.6)
    hairtip = mat("HairOrange", "#e3762a", roughness=0.55)
    base_body(c, skin, black, midriff_skin=True, eye="#d9902a", leg=pants)
    # 髪：高いポニーテール
    hair_cap(c, hair)
    bangs(c, hair, n=6, seed=31, length=0.05)
    for s in (-1, 1):
        c.cone("head", (s * 0.085, -0.04, 1.62), (s * 0.09, -0.06, 1.5), 0.025, hairtip, verts=5)
    ponytail(c, hair, (0, 0.07, 1.7), 0.42, 0.06, droop=0.75, seed=32, strands=7)
    ponytail(c, hairtip, (0, 0.11, 1.55), 0.25, 0.045, droop=0.9, seed=33, strands=5)
    c.torus("head", (0, 0.07, 1.7), 0.04, 0.01, orange, rot=(70, 0, 0))
    # スヌード
    c.tube("neck", (0, 0, 1.38), (0, 0, 1.48), 0.075, 0.06, black, verts=12)
    # クロップドトップ＋ハーネス
    shirt(c, black)
    for s in (-1, 1):
        c.strip("chest", (s * 0.1, -0.11, 1.4), (s * 0.06, -0.12, 1.22), 0.025, 0.012, orange)
        c.strip("chest", (s * 0.11, 0.1, 1.4), (s * -0.07, 0.11, 1.22), 0.02, 0.012, armor)
    c.tube("chest", (0, 0, 1.215), (0, 0, 1.24), 0.13, 0.13, armor, verts=16, scale_xy=(1.25, 0.95))
    c.box("chest", (0.12, 0.012, 0.012), (0, -0.13, 1.23), oglow, bevel=0.002)
    # 腕の装甲バンド
    for s, side in ((1, "L"), (-1, "R")):
        for t in (0.2, 0.55):
            c.limb("upperarm." + side, 0.05, 0.048, armor, t, t + 0.18, verts=8, smooth=False)
        c.limb("forearm." + side, 0.052, 0.046, armor, 0.15, 0.8, verts=8, smooth=False)
        c.box("forearm." + side, (0.03, 0.012, 0.1), Vector(bone_point("forearm." + side, 0.45)) + Vector((0, -0.05, 0)), oglow, bevel=0.002)
    gloves(c, armor, accent=orange, fingerless=False)
    # 腰：大量のポーチ、太ももの大型ホルスター
    c.ball("hips", 0.112, (0, 0.012, 0.95), pants, scale=(1.42, 1.08, 0.8), seg=16)
    belt(c, black, orange, pouches=armor, n=7)
    for s, side in ((1, "L"), (-1, "R")):
        p = Vector(bone_point("thigh." + side, 0.35)) + Vector((s * 0.07, 0, 0))
        c.box("thigh." + side, (0.05, 0.08, 0.16), p, armor, bevel=0.01)
        c.box("thigh." + side, (0.052, 0.012, 0.1), p + Vector((s * 0.0, -0.042, 0)), oglow, bevel=0.002)
        thigh_band(c, black, side, 0.25)
        thigh_band(c, black, side, 0.55)
        # 膝から足先までの脚部装甲
        c.limb("shin." + side, 0.062, 0.055, armor, 0.0, 0.75, verts=8, smooth=False)
        c.box("shin." + side, (0.012, 0.012, 0.25), Vector(bone_point("shin." + side, 0.4)) + Vector((s * 0.058, -0.02, 0)), orange, bevel=0.002)
    knee_pads(c, armor, glow=oglow, size=1.25)
    boots(c, armor, orange, mat("SoleDark", "#14110f", roughness=0.85), chunky=1.2, accent_glow=oglow)


def build_sora(c: Character):
    """金色の長いハイポニーテール、獣耳のようなアンテナ付きヘッドセット、白黄色のジャケット、背中の索敵ユニット"""
    skin = mat("Skin", "#f5d8c4", roughness=0.7)
    black = mat("Black", "#141418", roughness=0.75)
    white = mat("White", "#eceef0", roughness=0.5)
    yellow = mat("Yellow", "#ffd21f", roughness=0.45)
    cyan = mat("CyanGlow", "#4fe3ff", emission="#4fe3ff", strength=3.0)
    hair = mat("HairGold", "#f2c64a", roughness=0.5)
    base_body(c, skin, black, midriff_skin=True, eye="#f0b020", leg=black)
    # 髪：腰まで届くハイポニーテール
    hair_cap(c, hair)
    bangs(c, hair, n=8, seed=41, length=0.055)
    for s in (-1, 1):
        c.cone("head", (s * 0.085, -0.03, 1.6), (s * 0.095, -0.04, 1.4), 0.03, hair, verts=5)
    ponytail(c, hair, (0, 0.08, 1.72), 0.9, 0.08, droop=0.85, seed=42, strands=9)
    # ヘッドセット＋アンテナの耳
    c.tube("head", (-0.11, 0.0, 1.69), (0.11, 0.0, 1.69), 0.012, 0.012, white, verts=8)
    for s in (-1, 1):
        c.tube("head", (s * 0.1, 0.0, 1.6), (s * 0.125, 0.0, 1.6), 0.042, 0.042, black, verts=14)
        c.tube("head", (s * 0.124, 0.0, 1.6), (s * 0.13, 0.0, 1.6), 0.03, 0.03, yellow, verts=14)
        c.cone("head", (s * 0.07, 0.0, 1.7), (s * 0.1, 0.01, 1.84), 0.03, white, verts=4)
        c.cone("head", (s * 0.072, -0.005, 1.71), (s * 0.095, 0.0, 1.8), 0.015, cyan, verts=4)
    c.tube("head", (-0.12, -0.02, 1.57), (-0.06, -0.09, 1.54), 0.006, 0.006, black, verts=6)  # マイク
    # ジャケット（白に黄色）
    shirt(c, black)
    for s, side in ((1, "L"), (-1, "R")):
        c.box("chest", (0.09, 0.2, 0.2), (s * 0.12, 0.01, 1.3), white, bevel=0.02)
        c.box("chest", (0.02, 0.205, 0.04), (s * 0.12, 0.01, 1.25), yellow, bevel=0.004)
        c.limb("upperarm." + side, 0.058, 0.055, white, 0.0, 1.0, verts=10)
        c.limb("upperarm." + side, 0.06, 0.06, yellow, 0.4, 0.55, verts=10)
        c.limb("forearm." + side, 0.05, 0.048, black, 0.0, 0.2, verts=10)
        c.limb("forearm." + side, 0.052, 0.052, white, 0.18, 0.3, verts=10)
    # 背中の索敵ユニット（中央にシアンに光る円形のレンズ）
    c.box("chest", (0.24, 0.1, 0.3), (0, 0.15, 1.27), black, bevel=0.015)
    c.box("chest", (0.26, 0.08, 0.06), (0, 0.15, 1.42), yellow, bevel=0.01)
    c.tube("chest", (0, 0.2, 1.27), (0, 0.215, 1.27), 0.075, 0.075, black, verts=20)
    c.torus("chest", (0, 0.218, 1.27), 0.06, 0.008, cyan, rot=(90, 0, 0))
    c.tube("chest", (0, 0.21, 1.27), (0, 0.222, 1.27), 0.025, 0.025, cyan, verts=14)
    # 下半身
    c.ball("hips", 0.11, (0, 0.012, 0.95), black, scale=(1.42, 1.08, 0.75), seg=16)
    belt(c, black, yellow, pouches=white, n=4)
    for s, side in ((1, "L"), (-1, "R")):
        c.limb("thigh." + side, 0.074, 0.07, black, 0.0, 0.18)
        c.strip("thigh." + side, Vector(bone_point("thigh." + side, 0.25)) + Vector((s * 0.058, -0.02, 0)), Vector(bone_point("thigh." + side, 0.97)) + Vector((s * 0.045, -0.02, 0)), 0.006, 0.004, cyan)
        c.strip("shin." + side, Vector(bone_point("shin." + side, 0.05)) + Vector((s * 0.045, -0.02, 0)), Vector(bone_point("shin." + side, 0.6)) + Vector((s * 0.04, -0.02, 0)), 0.006, 0.004, cyan)
        thigh_band(c, black, side, 0.3)
        c.box("thigh." + side, (0.04, 0.06, 0.07), Vector(bone_point("thigh." + side, 0.15)) + Vector((s * 0.08, 0, 0)), white, bevel=0.008)
    knee_pads(c, white, glow=mat("YellowGlow", "#ffd21f", emission="#ffd21f", strength=2.0), size=1.2)
    gloves(c, black, accent=yellow)
    boots(c, black, yellow, mat("SoleYellow", "#ffd21f", roughness=0.6), chunky=1.25, accent_glow=None)
    for s, side in ((1, "L"), (-1, "R")):
        c.box("foot." + side, (0.13, 0.12, 0.05), (s * 0.1, -0.08, 0.06), white, bevel=0.015)


def build_alex(c: Character):
    """青いショートヘア、額にゴーグル、黒のテックウェア、右太ももに青い注射器3本"""
    skin = mat("Skin", "#f3d6c4", roughness=0.7)
    black = mat("Black", "#141418", roughness=0.75)
    blue = mat("RoyalBlue", "#2f6bff", roughness=0.5)
    bglow = mat("BlueGlow", "#4f8bff", emission="#4f8bff", strength=3.0)
    gray = mat("Gray", "#9aa0a8", metallic=0.6, roughness=0.35)
    strap = mat("Strap", "#1b1c20", metallic=0.2, roughness=0.55)
    hair = mat("HairBlue", "#2a4bb0", roughness=0.55)
    glass = mat("GogglesGlass", "#6fb0ff", metallic=0.3, roughness=0.1, emission="#6fb0ff", strength=0.6, alpha=0.6)
    base_body(c, skin, black, midriff_skin=True, eye="#4f8bff", leg=black)
    # 髪：毛先の跳ねたショート
    hair_cap(c, hair)
    spikes(c, hair, 20, (0, 0.02, 1.62), 0.1, 0.075, seed=51, back=0.35)
    bangs(c, hair, n=7, seed=52, length=0.05)
    # 額のゴーグル
    c.torus("head", (0, 0.005, 1.665), 0.104, 0.011, black, rot=(-8, 0, 0))  # ゴーグルのバンド
    for s in (-1, 1):
        c.box("head", (0.07, 0.03, 0.045), (s * 0.045, -0.1, 1.675), black, bevel=0.01)
        c.box("head", (0.06, 0.01, 0.035), (s * 0.045, -0.117, 1.675), glass, bevel=0.005)
    # ハイネックのクロップドジャケット＋プレートキャリア
    c.tube("neck", (0, 0, 1.38), (0, 0, 1.47), 0.065, 0.058, black, verts=12)
    shirt(c, black)
    c.box("chest", (0.24, 0.07, 0.2), (0, -0.09, 1.3), strap, bevel=0.015)
    c.box("chest", (0.06, 0.012, 0.06), (0, -0.128, 1.33), mat("WhiteMark", "#e8eaf0", roughness=0.5), rot=(0, 45, 0), bevel=0.004)
    c.box("chest", (0.22, 0.06, 0.18), (0, 0.1, 1.3), strap, bevel=0.015)
    for s, side in ((1, "L"), (-1, "R")):
        c.limb("upperarm." + side, 0.055, 0.052, black, 0.0, 1.0, verts=10)
        c.limb("upperarm." + side, 0.057, 0.055, blue, 0.35, 0.75, verts=10)
        c.limb("forearm." + side, 0.048, 0.045, black, 0.0, 0.35, verts=10)
        c.limb("forearm." + side, 0.05, 0.05, strap, 0.3, 0.4, verts=10)
    # 下半身：カーゴパンツ（青いライン）、右太ももの注射器
    c.ball("hips", 0.112, (0, 0.012, 0.95), black, scale=(1.42, 1.08, 0.8), seg=16)
    belt(c, strap, mat("BeltMetal", "#4a4d55", metallic=0.8, roughness=0.35), pouches=strap, n=5)
    for s, side in ((1, "L"), (-1, "R")):
        c.limb("thigh." + side, 0.078, 0.062, black, 0.0, 1.0)
        c.limb("shin." + side, 0.06, 0.05, black, 0.0, 0.7)
        c.strip("thigh." + side, Vector(bone_point("thigh." + side, 0.05)) + Vector((s * 0.078, 0, 0)), Vector(bone_point("thigh." + side, 0.97)) + Vector((s * 0.062, 0, 0)), 0.012, 0.006, blue)
        c.strip("shin." + side, Vector(bone_point("shin." + side, 0.05)) + Vector((s * 0.06, 0, 0)), Vector(bone_point("shin." + side, 0.6)) + Vector((s * 0.058, 0, 0)), 0.012, 0.006, blue)
    hol = Vector(bone_point("thigh.R", 0.35)) + Vector((-0.08, -0.02, 0))
    c.box("thigh.R", (0.03, 0.09, 0.12), hol, strap, bevel=0.006)
    for k in range(3):
        p = hol + Vector((-0.02, -0.03 + k * 0.03, 0))
        c.tube("thigh.R", p + Vector((0, 0, -0.06)), p + Vector((0, 0, 0.06)), 0.01, 0.01, bglow, verts=8)
        c.tube("thigh.R", p + Vector((0, 0, 0.06)), p + Vector((0, 0, 0.085)), 0.006, 0.006, gray, verts=6)
    thigh_band(c, strap, "R", 0.25, r=0.08)
    thigh_band(c, strap, "R", 0.48, r=0.075)
    c.tube("hips", (0.12, -0.08, 0.97), (0.13, -0.085, 0.9), 0.012, 0.012, blue, verts=8)  # カラビナ
    knee_pads(c, black, glow=bglow, size=1.1)
    gloves(c, black, accent=blue)
    boots(c, black, blue, mat("SoleBlue", "#9aa0a8", roughness=0.7), chunky=1.2, accent_glow=bglow)


def build_ranmaru(c: Character):
    """銀髪の無造作なポニーテール、黒いフェイスマスク、紫に光る結晶、裂けたマント、とげ状のハイヒールブーツ"""
    skin = mat("Skin", "#f2dcd6", roughness=0.7)
    black = mat("Black", "#141418", roughness=0.75)
    silver = mat("Silver", "#c8c8d0", metallic=0.85, roughness=0.3)
    purple = mat("Purple", "#8a5cff", roughness=0.5)
    pglow = mat("PurpleGlow", "#b48cff", emission="#b48cff", strength=3.5)
    cloth = mat("TatteredCloth", "#231c2e", roughness=0.85)
    clothp = mat("TatteredPurple", "#5b3fa8", roughness=0.7, emission="#8a5cff", strength=0.4)
    hair = mat("HairSilver", "#cfcfd8", roughness=0.5)
    base_body(c, skin, black, midriff_skin=False, eye="#b48cff", leg=black, arm=black)
    # 髪：高い位置の無造作なポニーテール
    hair_cap(c, hair)
    bangs(c, hair, n=6, seed=61, length=0.06)
    spikes(c, hair, 10, (0, 0.05, 1.68), 0.07, 0.07, seed=62, back=0.6, up=1.0)
    ponytail(c, hair, (0, 0.06, 1.74), 0.32, 0.06, droop=0.4, seed=63, strands=8)
    c.torus("head", (0, 0.06, 1.73), 0.045, 0.012, black, rot=(60, 0, 0))
    c.cone("head", (0.02, 0.07, 1.75), (0.03, 0.12, 1.86), 0.012, black, verts=4)  # 髪留めの飾り
    # 黒いフェイスマスク
    c.ball("head", 0.088, (0, -0.032, 1.535), black, scale=(1.05, 0.85, 0.75), seg=14)
    # 左目の下の結晶
    c.cone("head", (0.05, -0.09, 1.58), (0.06, -0.095, 1.555), 0.008, pglow, verts=4)
    # ボディスーツとハーネス、胸の結晶
    shirt(c, black, low=1.12)
    for s in (-1, 1):
        c.strip("chest", (s * 0.1, -0.11, 1.4), (s * -0.07, -0.12, 1.15), 0.016, 0.012, mat("Strap", "#1e1d22", roughness=0.55))
    c.cone("chest", (0, -0.12, 1.38), (0, -0.14, 1.34), 0.018, pglow, verts=4)
    c.tube("neck", (0, 0, 1.38), (0, 0, 1.46), 0.062, 0.055, cloth, verts=10)  # 首元の布
    # 裂けたフード付きの長いマント（フードは下ろしている）
    import random

    rnd = random.Random(64)
    c.ball("chest", 0.11, (0, 0.11, 1.42), cloth, scale=(1.3, 0.6, 0.6), seg=10)  # 下ろしたフード
    for i in range(14):
        a = math.radians(rnd.uniform(80, 280))
        top = Vector((math.sin(a) * 0.19, math.cos(a) * 0.12 + 0.06, 1.4))
        length = rnd.uniform(0.6, 1.1)
        bot = top + Vector((math.sin(a) * 0.12, abs(math.cos(a)) * 0.12 + 0.05, -length))
        w = rnd.uniform(0.045, 0.07)
        c.tube("chest", top, bot, w, w * 0.25, clothp if i % 2 else cloth, verts=4, scale_xy=(1, 0.18), smooth=False)
    # 裂けた布の短い腰布、鎖とひし形の飾り
    for i in range(12):
        a = math.radians(i * 30)
        top = Vector((math.sin(a) * 0.15, -math.cos(a) * 0.12, 1.0))
        bot = top + Vector((math.sin(a) * 0.04, -math.cos(a) * 0.03, -rnd.uniform(0.15, 0.3)))
        c.strip("hips", top, bot, 0.07, 0.008, cloth, twist=-math.degrees(a))
    for s in (-1, 1):
        c.cone("hips", (s * 0.13, -0.07, 0.86), (s * 0.13, -0.07, 0.8), 0.015, silver, verts=4)
    c.tube("hips", (0, 0, 1.0), (0, 0, 1.035), 0.112, 0.112, mat("Belt", "#24222a", metallic=0.3, roughness=0.5), verts=16, scale_xy=(1.35, 1.0))
    for s, side in ((1, "L"), (-1, "R")):
        thigh_band(c, black, side, 0.15, r=0.075)
        thigh_band(c, black, side, 0.3, r=0.072)
    # 手：爪のような金属装甲のロンググローブ
    for s, side in ((1, "L"), (-1, "R")):
        c.limb("forearm." + side, 0.04, 0.036, black, 0.0, 1.0)
        c.limb("upperarm." + side, 0.044, 0.042, black, 0.45, 1.0)
        c.ball("hand." + side, 0.038, bone_point("hand." + side, 0.42), black, scale=(0.8, 1.05, 1.15), seg=10)
        hp = Vector(bone_point("hand." + side, 0.85))
        for k in range(3):
            c.cone("hand." + side, hp + Vector(((k - 1) * 0.014, -0.01, 0.01)), hp + Vector(((k - 1) * 0.016, -0.03, -0.05)), 0.008, silver, verts=4)
        c.cone("forearm." + side, Vector(bone_point("forearm." + side, 0.9)) + Vector((0, -0.035, 0)), Vector(bone_point("forearm." + side, 0.9)) + Vector((0, -0.05, 0)), 0.012, pglow, verts=4)
    # とげ状の金属装甲を重ねたハイヒールブーツ
    for s, side in ((1, "L"), (-1, "R")):
        x = s * 0.1
        c.limb("shin." + side, 0.06, 0.05, black, 0.45, 1.0, verts=8, smooth=False)
        for t in (0.5, 0.65, 0.8):
            p = Vector(bone_point("shin." + side, t))
            for a in (0, 120, 240):
                d = Vector((math.sin(math.radians(a)) * 0.06, -math.cos(math.radians(a)) * 0.06, 0))
                c.cone("shin." + side, p + d * 0.8, p + d * 1.4 + Vector((0, 0, 0.03)), 0.018, silver, verts=4)
        c.box("foot." + side, (0.08, 0.2, 0.06), (x, -0.06, 0.07), black, rot=(-12, 0, 0), bevel=0.015)
        c.cone("foot." + side, (x, -0.13, 0.06), (x, -0.19, 0.04), 0.035, silver, verts=4)
        c.tube("foot." + side, (x, 0.04, 0.09), (x, 0.045, 0.0), 0.012, 0.006, silver, verts=6)  # ヒール
        c.cone("shin." + side, Vector(bone_point("shin." + side, 0.92)) + Vector((s * 0.04, -0.02, 0)), Vector(bone_point("shin." + side, 0.92)) + Vector((s * 0.06, -0.02, -0.04)), 0.012, pglow, verts=4)


BUILDERS = {
    "meia": build_meia,
    "pearl": build_pearl,
    "miranda": build_miranda,
    "sora": build_sora,
    "alex": build_alex,
    "ranmaru": build_ranmaru,
}

# ---------------------------------------------------------------------------
# アニメーション
# ---------------------------------------------------------------------------
# 回転の向き（骨のローカル軸、度）
#   腕・脚の骨：+X で前へ振る。ひざは -X で曲がる。ひじは +X で曲がる。
#   右腕は -Z で外へ開く、左腕は +Z で外へ開く。
#   背骨・首・頭：+X で前かがみ、+Y で左へひねる（上から見て反時計回り）。
#   足首：+X でつま先が上がる。

# 銃を構えた体幹（腕は IK で手の位置から決める）
TORSO_HOLD = {"spine": (3, 0, 0), "chest": (2, -14, 0), "neck": (0, 6, 0), "head": (-3, 8, 0)}

# 手を置く位置（立ったとき・体の座標。正面は -Y）と、ひじを向ける方向
HAND_TARGETS = {
    # 右手：銃のグリップ（胸の前・少し右）
    "R": ((-0.07, -0.27, 1.2), (-0.45, 0.1, 0.85)),
    # 左手：銃の前側（ハンドガード）
    "L": ((0.0, -0.47, 1.24), (0.35, -0.1, 0.8)),
}
# 左手を突き出す（アビリティ）
REACH_TARGET_L = ((0.16, -0.56, 1.42), (0.5, 0.0, 1.0))


def _set_pose(rig, pose):
    for pb in rig.pose.bones:
        r = pose.get(pb.name, (0, 0, 0))
        pb.rotation_euler = Euler([math.radians(a) for a in r])
        pb.location = (0, 0, 0)
    bpy.context.view_layer.update()


def solve_arms(c: Character, torso, targets, hand_dirs):
    """体幹の姿勢 torso のうえで、手首が targets の位置に来る腕の角度を IK で求める。
    hand_dirs は手の骨の向き（体の座標）。戻り値は腕の骨の姿勢 {骨: (x, y, z)度}"""
    rig = c.rig
    _set_pose(rig, torso)
    made = []
    for side, (tgt, pole) in targets.items():
        te = bpy.data.objects.new("ik_t_" + side, None)
        pe = bpy.data.objects.new("ik_p_" + side, None)
        bpy.context.collection.objects.link(te)
        bpy.context.collection.objects.link(pe)
        te.location = tgt
        pe.location = pole
        made += [te, pe]
        con = rig.pose.bones["forearm." + side].constraints.new("IK")
        con.target = te
        con.pole_target = pe
        con.pole_angle = math.radians(-90)
        con.chain_count = 2
    bpy.context.view_layer.update()
    mats = {}
    for side in targets:
        for b in ("upperarm.", "forearm."):
            mats[b + side] = rig.pose.bones[b + side].matrix.copy()
    for side in targets:
        pb = rig.pose.bones["forearm." + side]
        pb.constraints.remove(pb.constraints[0])
    for o in made:
        bpy.data.objects.remove(o)
    out = {}
    for side in targets:
        for b in ("upperarm.", "forearm."):
            pb = rig.pose.bones[b + side]
            pb.matrix = mats[b + side]
            bpy.context.view_layer.update()
        # 手の向き
        pb = rig.pose.bones["hand." + side]
        y = Vector(hand_dirs[side][0]).normalized()
        zhint = Vector(hand_dirs[side][1])
        x = y.cross(zhint).normalized()
        z = x.cross(y).normalized()
        m = Matrix((x, y, z)).transposed().to_4x4()
        m.translation = pb.matrix.translation
        pb.matrix = m
        bpy.context.view_layer.update()
        for b in ("upperarm.", "forearm.", "hand."):
            pb = rig.pose.bones[b + side]
            out[b + side] = tuple(math.degrees(a) for a in pb.rotation_euler)
    _set_pose(rig, {})
    return out


HAND_DIRS = {
    # (手の骨が向く方向, 手の甲の向きのめやす)
    "R": ((0.1, -0.6, -0.8), (-1, 0, 0)),
    "L": ((-0.25, -0.75, -0.3), (1, 0, -0.4)),
}


def pose_merge(*poses):
    out = {}
    for p in poses:
        for k, v in p.items():
            if k.startswith("@"):
                out[k] = v
                continue
            prev = out.get(k, (0, 0, 0))
            out[k] = tuple(prev[i] + v[i] for i in range(3))
    return out


def run_pose(hold, phase, stride=1.0, lean=12):
    """走りの1コマ（phase は 0〜1）。左脚は sin が正のとき前"""
    s = math.sin(phase * math.pi * 2)
    c2 = math.cos(phase * math.pi * 2)
    # 後ろへ振っている脚のひざを大きく曲げる（前へ戻すときに足を引き上げる）
    knee_l = -(max(0.0, -s) * 85 + max(0.0, s) * 20 + 12)
    knee_r = -(max(0.0, s) * 85 + max(0.0, -s) * 20 + 12)
    return pose_merge(
        hold,
        {
            "hips": (0, -s * 8, 0),
            "spine": (lean, s * 5, 0),
            "thigh.L": (s * 45 * stride + 6, 0, 2),
            "shin.L": (knee_l * stride, 0, 0),
            "foot.L": (8 - s * 12, 0, 0),
            "thigh.R": (-s * 45 * stride + 6, 0, -2),
            "shin.R": (knee_r * stride, 0, 0),
            "foot.R": (8 + s * 12, 0, 0),
            "head": (-lean * 0.7, 0, 0),
            # 両脚が前後に開いたとき（|s|=1）が一番低い
            "@hips_z": -0.045 + (1 - abs(s)) * 0.04,
        },
    )


def make_action(c: Character, name, frames):
    """frames: [(フレーム, 姿勢)]。姿勢は {骨: (x, y, z)度}、"@hips_z" で腰の上下。
    すべての骨にキーを打つ（別の動きから切り替えたときに前の角度が残らないように）"""
    rig = c.rig
    rig.animation_data_create()
    act = bpy.data.actions.new(name)
    rig.animation_data.action = act
    for f, pose in frames:
        for pb in rig.pose.bones:
            r = pose.get(pb.name, (0, 0, 0))
            pb.rotation_euler = Euler([math.radians(a) for a in r])
            pb.keyframe_insert("rotation_euler", frame=f)
        hp = rig.pose.bones["hips"]
        hp.location = (0, pose.get("@hips_z", 0.0), 0)  # hips の骨の Y は上向き
        hp.keyframe_insert("location", frame=f)
    act.use_fake_user = True
    track = rig.animation_data.nla_tracks.new()
    track.name = name
    track.strips.new(name, int(frames[0][0]), act)
    rig.animation_data.action = None
    _set_pose(rig, {})


def lowest_point(c: Character, pose):
    """姿勢をとったときに一番低い骨の位置（地面にめり込んでいないかの確認用）"""
    rig = c.rig
    _set_pose(rig, pose)
    hp = rig.pose.bones["hips"]
    hp.location = (0, pose.get("@hips_z", 0.0), 0)
    bpy.context.view_layer.update()
    z = min(min(pb.head.z, pb.tail.z) for pb in rig.pose.bones)
    _set_pose(rig, {})
    return z


def build_animations(c: Character):
    arms = solve_arms(c, TORSO_HOLD, HAND_TARGETS, HAND_DIRS)
    hold = pose_merge(TORSO_HOLD, arms)
    reach_arm = solve_arms(c, pose_merge(TORSO_HOLD, {"chest": (0, 10, 0)}), {"L": REACH_TARGET_L}, {"L": ((0.1, -1, 0.25), (0, 0, 1))})
    reach = pose_merge(hold, {"chest": (0, 10, 0)})
    reach.update(reach_arm)
    c.hold_pose = hold

    stance = {"thigh.L": (4, 0, 4), "thigh.R": (-3, 0, -4), "shin.L": (-8, 0, 0), "shin.R": (-4, 0, 0), "foot.L": (4, 0, 0), "foot.R": (3, 0, 0)}
    # 待機：呼吸（2秒）
    idle0 = pose_merge(hold, stance, {"@hips_z": -0.01})
    idle1 = pose_merge(hold, stance, {"chest": (-2, 0, 0), "head": (2, 0, 0), "@hips_z": -0.016})
    make_action(c, "Idle", [(1, idle0), (31, idle1), (61, idle0)])
    # 走り（0.6秒で1周）
    n = 18
    make_action(c, "Run", [(1 + i, run_pose(hold, i / n)) for i in range(n + 1)])
    # 壁走り：歩幅を大きく、体をまっすぐ（壁側への傾きはゲーム側で付ける）
    make_action(c, "WallRun", [(1 + i, run_pose(hold, i / n, stride=1.15, lean=4)) for i in range(n + 1)])
    # スライディング：腰を落とし、左脚を前に伸ばし、右脚を折りたたむ
    slide = pose_merge(
        hold,
        {
            "spine": (-24, 0, 0),
            "chest": (-6, 0, 0),
            "head": (26, 0, 0),
            "thigh.L": (78, 0, 4),
            "shin.L": (-6, 0, 0),
            "foot.L": (-15, 0, 0),
            "thigh.R": (50, 0, -32),
            "shin.R": (-115, 0, 0),
            "foot.R": (-20, 0, 0),
        },
    )
    low = lowest_point(c, slide)
    slide["@hips_z"] = -(low - 0.11)  # 一番低いところが地面すれすれになるまで腰を下げる
    make_action(c, "Slide", [(1, slide), (16, pose_merge(slide, {"chest": (-2, 0, 0), "head": (2, 0, 0)})), (31, slide)])
    # ジャンプ：脚を縮める
    jump = pose_merge(hold, {"thigh.L": (55, 0, 4), "shin.L": (-85, 0, 0), "thigh.R": (20, 0, -4), "shin.R": (-60, 0, 0), "foot.L": (-10, 0, 0), "foot.R": (-15, 0, 0), "spine": (6, 0, 0)})
    make_action(c, "Jump", [(1, jump), (16, pose_merge(jump, {"thigh.L": (-6, 0, 0), "thigh.R": (6, 0, 0)})), (31, jump)])
    # 射撃：上半身が反動で跳ねる（0.2秒）
    kick = pose_merge(hold, {"chest": (-5, 0, 0), "head": (2, 0, 0)})
    make_action(c, "Shoot", [(1, hold), (3, kick), (7, hold)])
    # アビリティ：左腕を前に突き出す（ワイヤー・ソナー・シールドなどの共通の動き）
    make_action(c, "Ability", [(1, hold), (6, reach), (20, reach), (30, hold)])
    # 倒れる（消耗戦）：撃たれてのけぞり、ひざから崩れて前へうずくまる（1秒）
    make_death(c, hold)


def make_death(c: Character, hold):
    hit = pose_merge(hold, {"spine": (-10, 8, 0), "chest": (-8, 0, 0), "head": (14, 0, 0), "@hips_z": -0.02})
    buckle = pose_merge(hold, {"spine": (10, 4, 0), "chest": (6, 0, 0), "thigh.L": (42, 0, 4), "shin.L": (-80, 0, 0), "thigh.R": (30, 0, -4), "shin.R": (-95, 0, 0), "foot.L": (20, 0, 0), "foot.R": (25, 0, 0), "@hips_z": -0.22})
    kneel = {"spine": (38, 0, 0), "chest": (22, 0, 0), "head": (18, 0, 0), "thigh.L": (12, 0, 6), "shin.L": (-118, 0, 0), "thigh.R": (6, 0, -6), "shin.R": (-122, 0, 0), "foot.L": (40, 0, 0), "foot.R": (40, 0, 0)}
    slump = pose_merge(hold, kneel, {"upperarm.L": (-30, 0, 10), "upperarm.R": (-30, 0, -10)})
    low = lowest_point(c, slump)
    slump["@hips_z"] = -(low - 0.04)
    make_action(c, "Death", [(1, hold), (4, hit), (12, buckle), (24, slump), (31, slump)])


# ---------------------------------------------------------------------------
# 一人称の腕
# ---------------------------------------------------------------------------

ARM_STYLE = {
    # (袖の色, 手袋の色, 差し色, 発光, 袖の太さ, 指先を出すか, 腕の飾り)
    "meia": ("#17151a", "#17151a", "#e8202e", "#ff3040", 1.0, True, "gauntlet"),
    "pearl": ("#141418", "#141418", "#b4e44a", "#b4e44a", 1.0, False, "strap"),
    "miranda": ("#2a2624", "#2a2624", "#ff7a1a", "#ffa04a", 1.15, False, "armor"),
    "sora": ("#eceef0", "#141418", "#ffd21f", "#4fe3ff", 1.15, True, "cuff"),
    "alex": ("#141418", "#141418", "#2f6bff", "#4f8bff", 1.05, True, "panel"),
    "ranmaru": ("#141418", "#141418", "#c8c8d0", "#b48cff", 0.95, False, "claw"),
}


def build_fp_arms(cid):
    """ArmR・ArmL：原点が手のひら。前腕は手前（-Y）へ、少し下・外へ伸びる（一人称のカメラは +Y を向く）"""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    _mats.clear()
    sleeve_c, glove_c, accent_c, glow_c, thick, fingerless, deco = ARM_STYLE[cid]
    skin = mat("Skin", "#f0d2c0", roughness=0.7)
    sleeve = mat("Sleeve", sleeve_c, roughness=0.7)
    glove = mat("Glove", glove_c, roughness=0.6)
    accent = mat("Accent", accent_c, metallic=0.4 if deco in ("claw", "armor") else 0.0, roughness=0.45)
    glow = mat("Glow", glow_c, emission=glow_c, strength=2.5)
    metal = mat("Metal", "#4a4d55", metallic=0.85, roughness=0.35)

    for side, sx in (("ArmR", 1), ("ArmL", -1)):  # 一人称では正面が +Y なので、右腕のひじは +X 側
        objs = []

        def add(o, m, smooth=True):
            o.data.materials.append(m)
            if smooth:
                for p in o.data.polygons:
                    p.use_smooth = True
            objs.append(o)

        # 手（握りこぶし）
        bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=8, radius=0.04, location=(0, 0, 0))
        o = bpy.context.active_object
        o.scale = (0.85, 1.15, 0.9)
        add(o, glove)
        # 指（握った形）。右手は縦のグリップを前から、左手は横の銃身を下から握る
        for k in range(4):
            if side == "ArmR":
                loc = (0.0, 0.03, 0.012 - k * 0.019)
            else:
                loc = (sx * -0.022, 0.03 - k * 0.019, 0.012)
            bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=0.011, depth=0.05, location=loc, rotation=(0, math.radians(90), 0))
            add(bpy.context.active_object, skin if fingerless else glove)
        # 前腕：手首から手前（-Y）・下・外へ 0.35m
        wrist = Vector((sx * 0.004, -0.035, -0.012))
        elbow = (Vector((sx * 0.07, -0.36, -0.14)) if side == "ArmR" else Vector((sx * 0.12, -0.34, -0.1)))
        d = elbow - wrist
        bpy.ops.mesh.primitive_cone_add(vertices=12, radius1=0.036 * thick, radius2=0.045 * thick, depth=d.length, location=(wrist + elbow) / 2)
        o = bpy.context.active_object
        o.rotation_euler = Vector((0, 0, 1)).rotation_difference(d.normalized()).to_euler()
        add(o, sleeve)
        dirn = d.normalized()
        # 手袋の筒
        bpy.ops.mesh.primitive_cone_add(vertices=12, radius1=0.04 * thick, radius2=0.042 * thick, depth=0.06, location=wrist + dirn * 0.04)
        o = bpy.context.active_object
        o.rotation_euler = Vector((0, 0, 1)).rotation_difference(dirn).to_euler()
        add(o, glove)
        # 飾り
        mid = wrist + dirn * 0.16
        up = Vector((0, 0, 1))
        if deco == "gauntlet":
            bpy.ops.mesh.primitive_cube_add(size=1, location=mid + up * 0.035)
            o = bpy.context.active_object
            o.scale = (0.045, 0.14, 0.03)
            o.rotation_euler = Vector((0, 1, 0)).rotation_difference(dirn).to_euler()
            add(o, metal, smooth=False)
            bpy.ops.mesh.primitive_cube_add(size=1, location=mid + up * 0.052)
            o = bpy.context.active_object
            o.scale = (0.012, 0.09, 0.006)
            o.rotation_euler = Vector((0, 1, 0)).rotation_difference(dirn).to_euler()
            add(o, glow, smooth=False)
            bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=0.01, depth=0.08, location=mid + up * 0.045 + dirn * 0.09)
            o = bpy.context.active_object
            o.rotation_euler = Vector((0, 0, 1)).rotation_difference(dirn).to_euler()
            add(o, metal)
        elif deco == "armor":
            for t in (0.08, 0.2):
                bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=0.05 * thick, depth=0.07, location=wrist + dirn * t)
                o = bpy.context.active_object
                o.rotation_euler = Vector((0, 0, 1)).rotation_difference(dirn).to_euler()
                add(o, accent if t < 0.1 else metal, smooth=False)
            bpy.ops.mesh.primitive_cube_add(size=1, location=mid + up * 0.048)
            o = bpy.context.active_object
            o.scale = (0.014, 0.1, 0.006)
            o.rotation_euler = Vector((0, 1, 0)).rotation_difference(dirn).to_euler()
            add(o, glow, smooth=False)
        elif deco == "claw":
            for k in range(3):
                bpy.ops.mesh.primitive_cone_add(vertices=4, radius1=0.007, radius2=0.0005, depth=0.05, location=(sx * 0.02, 0.035, 0.03 - k * 0.019))
                o = bpy.context.active_object
                o.rotation_euler = (math.radians(-90), 0, 0)
                add(o, accent, smooth=False)
            bpy.ops.mesh.primitive_cone_add(vertices=4, radius1=0.012, radius2=0.0005, depth=0.03, location=wrist + dirn * 0.03 + up * 0.04)
            add(bpy.context.active_object, glow, smooth=False)
        elif deco == "cuff":
            bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.052 * thick, depth=0.06, location=wrist + dirn * 0.1)
            o = bpy.context.active_object
            o.rotation_euler = Vector((0, 0, 1)).rotation_difference(dirn).to_euler()
            add(o, accent)
        elif deco == "panel":
            bpy.ops.mesh.primitive_cube_add(size=1, location=mid + up * 0.04)
            o = bpy.context.active_object
            o.scale = (0.05, 0.14, 0.012)
            o.rotation_euler = Vector((0, 1, 0)).rotation_difference(dirn).to_euler()
            add(o, accent, smooth=False)
        elif deco == "strap":
            for t in (0.06, 0.22):
                bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.044 * thick, depth=0.015, location=wrist + dirn * t)
                o = bpy.context.active_object
                o.rotation_euler = Vector((0, 0, 1)).rotation_difference(dirn).to_euler()
                add(o, glow if t < 0.1 else accent)
        # まとめる
        bpy.ops.object.select_all(action="DESELECT")
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
        bpy.ops.object.join()
        j = bpy.context.active_object
        j.name = side
        j.data.name = side
        bpy.context.scene.cursor.location = (0, 0, 0)
        bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
        # 左右で位置をずらして並べる（書き出し後、ゲーム側でそれぞれ手の位置に置く）
        j.location = (sx * 0.3, 0, 0)
    out = os.path.join(OUT_DIR, f"fp_{cid}.glb")
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_yup=True, export_apply=True)
    return out


# ---------------------------------------------------------------------------
# 確認用の画像
# ---------------------------------------------------------------------------


def render_preview(c: Character, path):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 24
    scene.cycles.use_denoising = False
    scene.render.resolution_x = 900
    scene.render.resolution_y = 600
    world = bpy.data.worlds.new("W")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.05, 0.04, 0.08, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.8
    # 3体並べる：正面・横・走り
    cam_data = bpy.data.cameras.new("C")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = 2.6
    cam = bpy.data.objects.new("C", cam_data)
    scene.collection.objects.link(cam)
    cam.location = (0, -6, 0.9)
    cam.rotation_euler = (math.radians(90), 0, 0)
    scene.camera = cam
    for loc, e in (((2, -3, 3), 900), ((-3, -1, 2), 400), ((0, 3, 2), 500)):
        ld = bpy.data.lights.new("L", "AREA")
        ld.energy = e
        ld.size = 3
        lo = bpy.data.objects.new("L", ld)
        lo.location = loc
        lo.rotation_euler = (Vector((0, 0, 1)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        scene.collection.objects.link(lo)
    # 正面（待機）を中央、横向き・走りの2体を複製して左右へ
    rig = c.rig
    rig.animation_data.action = None
    scene.frame_set(1)
    for tr in rig.animation_data.nla_tracks:
        tr.mute = tr.name != "Idle"
    scene.frame_set(1)
    bpy.context.view_layer.update()
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    for tr in rig.animation_data.nla_tracks:
        tr.mute = False


def render_turnaround(c: Character, path, track="Idle", frame=1, yaw=0):
    scene = bpy.context.scene
    rig = c.rig
    for tr in rig.animation_data.nla_tracks:
        tr.mute = tr.name != track
    rig.rotation_euler = (0, 0, math.radians(yaw))
    scene.frame_set(frame)
    bpy.context.view_layer.update()
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    rig.rotation_euler = (0, 0, 0)
    for tr in rig.animation_data.nla_tracks:
        tr.mute = False


def main():
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    only = [a for a in args if not a.startswith("--")]
    os.makedirs(OUT_DIR, exist_ok=True)
    for cid, build in BUILDERS.items():
        if only and cid not in only:
            continue
        bpy.ops.wm.read_factory_settings(use_empty=True)
        _mats.clear()
        c = Character(cid)
        build(c)
        c.join_by_bone()
        build_animations(c)
        bpy.context.scene.render.fps = FPS
        out = os.path.join(OUT_DIR, f"{cid}.glb")
        bpy.ops.export_scene.gltf(
            filepath=out,
            export_format="GLB",
            export_yup=True,
            export_apply=True,
            export_animation_mode="NLA_TRACKS",
            export_force_sampling=True,
        )
        print(f"書き出し: {out} ({os.path.getsize(out) // 1024} KB)")
        if "--blend" in args:
            bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, f"{cid}.blend"))
        if "--preview" in args:
            pdir = os.path.join(HERE, "preview")
            os.makedirs(pdir, exist_ok=True)
            render_preview(c, os.path.join(pdir, f"{cid}_front.png"))
            render_turnaround(c, os.path.join(pdir, f"{cid}_back.png"), "Idle", 1, 180)
            render_turnaround(c, os.path.join(pdir, f"{cid}_side.png"), "Idle", 1, 90)
            render_turnaround(c, os.path.join(pdir, f"{cid}_run.png"), "Run", 5, 60)
            render_turnaround(c, os.path.join(pdir, f"{cid}_slide.png"), "Slide", 1, 70)
        fp = build_fp_arms(cid)
        print(f"書き出し: {fp} ({os.path.getsize(fp) // 1024} KB)")


if __name__ == "__main__":
    main()
