"""
武器のサイト（照準器）とアタッチメントのモデルを Blender で作り、1 つの glTF（client/assets/weapons/sights.glb）に書き出す。

使い方：python assets-src/weapons/build_sights.py [--preview]

座標の約束（build_weapons.py と同じ）
  - Blender の +Y が前（銃口の向き）、+Z が上
  - サイトは原点が「のぞく線の中心」。武器の "SightMount" の位置に、そのまま置く（のぞく線の高さが照門・照星とそろう）
  - サイトの後ろの端（目の側）に "Eye" という空のオブジェクト。エイムしたときの目との距離をここから決める
  - 銃口のアタッチメント（サプレッサーなど）は原点が銃口。前の端に "Tip"（そこからマズルフラッシュを出す）
  - レーザーサイトは原点が取り付け位置、前の端に "Emitter"
  - のぞく所は筒を中空にして、前と後ろに半透明のレンズ（"Lens"）を入れる。照準（レティクル）は画面の側で描く

出す物（それぞれ空の親の下に部品）
  Sight_reddot / Sight_holo / Sight_x2 / Sight_x3 / Sight_threat / Sight_sniper / Sight_variable
  Att_suppressor / Att_compensator / Att_longbarrel / Att_laser / Att_magpull
"""

import math
import os
import sys

import bpy
import bmesh  # noqa: E402（bpy の後でないと読み込めない）
from mathutils import Euler, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(ROOT, "client", "assets", "weapons", "sights.glb")


def srgb_to_linear(c):
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)


def make_material(name, color, metallic=0.0, roughness=0.5, emission=None, emission_strength=0.0, alpha=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*srgb_to_linear(color), 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if emission is not None:
        bsdf.inputs["Emission Color"].default_value = (*srgb_to_linear(emission), 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
        m.surface_render_method = "BLENDED"
    return m


class Kit:
    def __init__(self):
        cyan = (0.31, 0.82, 1.0)
        red = (1.0, 0.22, 0.25)
        self.mat = {
            "body": make_material("SBody", (0.13, 0.14, 0.165), metallic=0.6, roughness=0.38),
            "dark": make_material("SPolymer", (0.055, 0.06, 0.07), metallic=0.0, roughness=0.7),
            "rubber": make_material("SRubber", (0.03, 0.03, 0.035), metallic=0.0, roughness=0.9),
            "steel": make_material("SSteel", (0.42, 0.44, 0.48), metallic=0.9, roughness=0.28),
            "accent": make_material("SAccent", cyan, emission=cyan, emission_strength=3.0),
            "red": make_material("SRed", red, emission=red, emission_strength=1.6),
            "amber": make_material("SAmber", (1.0, 0.7, 0.3), emission=(1.0, 0.62, 0.2), emission_strength=3.5),
            "glass": make_material("SGlass", (0.55, 0.75, 0.95), metallic=0.0, roughness=0.04, emission=(0.2, 0.4, 0.6), emission_strength=0.25, alpha=0.16),
            "glassRed": make_material("SGlassRed", (0.95, 0.35, 0.35), metallic=0.0, roughness=0.04, emission=(0.5, 0.08, 0.08), emission_strength=0.35, alpha=0.2),
            "coat": make_material("SCoat", (0.35, 0.2, 0.6), metallic=0.4, roughness=0.1, emission=(0.25, 0.1, 0.5), emission_strength=0.5, alpha=0.35),
        }
        self.groups = {}

    def _add(self, obj, mat, group):
        obj.data.materials.append(self.mat[mat])
        self.groups.setdefault(group, []).append(obj)
        return obj

    def _bevel(self, obj, w):
        if w <= 0:
            return
        mod = obj.modifiers.new("Bevel", "BEVEL")
        mod.width = w
        mod.segments = 2
        mod.limit_method = "ANGLE"
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)

    def box(self, size, loc, mat="body", group="Body", rot=(0, 0, 0), bevel=0.0015):
        bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=Euler([math.radians(r) for r in rot]))
        o = bpy.context.active_object
        o.scale = size
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        self._bevel(o, min(bevel, min(size) * 0.3))
        return self._add(o, mat, group)

    def cyl(self, r, length, loc, mat="body", axis="Y", verts=24, group="Body", bevel=0.001, r2=None):
        """円柱（r2 を指定すると先細りの円すい台）。axis は向き"""
        rot = {"X": (0, 90, 0), "Y": (90, 0, 0), "Z": (0, 0, 0)}[axis]
        if r2 is None:
            bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=length, location=loc, rotation=Euler([math.radians(a) for a in rot]))
        else:
            bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=r2, depth=length, location=loc, rotation=Euler([math.radians(a) for a in rot]))
        o = bpy.context.active_object
        self._bevel(o, min(bevel, r * 0.2))
        return self._add(o, mat, group)

    def tube(self, r_back, r_front, length, y0, mat="body", wall=0.0022, verts=32, group="Body", square=False, w=None, h=None):
        """中空の筒（後ろの端 y0 から前へ length）。のぞいて向こうが見えるように、両端は開けておく"""
        bm = bmesh.new()
        segs = 4 if square else verts
        rings = []
        for (y, r, ww, hh) in ((y0, r_back, w, h), (y0 + length, r_front, w, h)):
            ring = []
            for i in range(segs):
                a = (i / segs) * math.pi * 2 + (math.pi / 4 if square else 0)
                if square:
                    sx = math.copysign(1, math.cos(a)) * (ww / 2)
                    sz = math.copysign(1, math.sin(a)) * (hh / 2)
                    ring.append(bm.verts.new((sx, y, sz)))
                else:
                    ring.append(bm.verts.new((math.cos(a) * r, y, math.sin(a) * r)))
            rings.append(ring)
        for i in range(segs):
            j = (i + 1) % segs
            bm.faces.new((rings[0][i], rings[0][j], rings[1][j], rings[1][i]))
        me = bpy.data.meshes.new("tube")
        bm.to_mesh(me)
        bm.free()
        o = bpy.data.objects.new("tube", me)
        bpy.context.collection.objects.link(o)
        bpy.context.view_layer.objects.active = o
        o.select_set(True)
        sol = o.modifiers.new("Solid", "SOLIDIFY")
        sol.thickness = wall
        sol.offset = 1.0
        bpy.ops.object.modifier_apply(modifier=sol.name)
        if square:
            self._bevel(o, wall * 0.45)
        for p in me.polygons:
            p.use_smooth = not square
        return self._add(o, mat, group)

    def lens(self, r, y, mat="glass", square=False, w=None, h=None):
        """レンズ（薄い板）。のぞいたときに向こうがうっすら色づいて見える"""
        if square:
            return self.box((w, 0.0006, h), (0, y, 0), mat, group="Lens", bevel=0)
        return self.cyl(r, 0.0006, (0, y, 0), mat, verts=32, group="Lens", bevel=0)

    def riser(self, y, length, top_z, width=0.022, bottom_z=-0.036):
        """レールに付ける台（下の端は銃の中に少し入る）"""
        self.box((width, length, top_z - bottom_z), (0, y, (top_z + bottom_z) / 2), "dark")
        # レールをつかむ爪
        for sx in (-1, 1):
            self.box((0.004, length * 0.9, 0.008), (sx * (width / 2 + 0.001), y, bottom_z + 0.008), "body", bevel=0.0008)

    def empty(self, name, loc):
        e = bpy.data.objects.new(name, None)
        e.location = loc
        e.empty_display_size = 0.01
        bpy.context.collection.objects.link(e)
        self.groups.setdefault("_empties", []).append(e)
        return e

    def finish(self, name):
        """部品をグループごとに 1 つにまとめ、空の親 name の下に入れる"""
        root = bpy.data.objects.new(name, None)
        bpy.context.collection.objects.link(root)
        for group, objs in self.groups.items():
            if group == "_empties":
                for e in objs:
                    e.parent = root
                continue
            bpy.ops.object.select_all(action="DESELECT")
            for o in objs:
                o.select_set(True)
            bpy.context.view_layer.objects.active = objs[0]
            if len(objs) > 1:
                bpy.ops.object.join()
            m = bpy.context.active_object
            m.name = f"{name}_{group}"
            m.data.name = m.name
            m.parent = root
        self.groups = {}
        return root


# ---------------------------------------------------------------------------
# サイト
# ---------------------------------------------------------------------------


def sight_reddot(k: Kit):
    """小さな筒のドットサイト（等倍）"""
    k.tube(0.0165, 0.0175, 0.048, -0.024, "body", wall=0.0028)
    k.tube(0.0185, 0.0185, 0.007, 0.019, "rubber", wall=0.0016)  # 前のカバーの縁
    k.tube(0.0176, 0.0176, 0.0016, -0.0128, "accent", wall=0.0008)  # 光る輪（のぞく所をふさがないよう輪にする）
    k.cyl(0.006, 0.012, (0.02, -0.004, 0), "body", axis="X", verts=16)  # 明るさのつまみ
    k.cyl(0.0062, 0.002, (0.026, -0.004, 0), "red", axis="X", verts=16, bevel=0)
    k.cyl(0.0055, 0.01, (0, -0.004, 0.0195), "body", axis="Z", verts=16)  # 上の調整つまみ
    k.riser(0.0, 0.034, -0.012)
    k.lens(0.0145, 0.016, "coat")
    k.lens(0.0145, -0.021)
    k.empty("Eye", (0, -0.024, 0))


def sight_holo(k: Kit):
    """四角い窓のホロサイト（約 1.5 倍）"""
    W, H, L = 0.038, 0.03, 0.05
    # 窓の枠（上と両側。下は台）
    k.box((W + 0.008, L, 0.0045), (0, 0.0, H / 2 + 0.002), "dark")
    for sx in (-1, 1):
        k.box((0.004, L, H + 0.006), (sx * (W / 2 + 0.002), 0.0, 0.0), "dark")
        k.box((0.0015, L * 0.7, 0.003), (sx * (W / 2 + 0.0045), 0.0, H / 2 - 0.006), "accent", bevel=0)
    # 台（電池の箱とボタン）
    k.box((W + 0.006, 0.082, 0.013), (0, -0.008, -H / 2 - 0.0055), "body")
    k.box((0.016, 0.018, 0.009), (0.006, -0.042, -H / 2 - 0.004), "dark")
    k.box((0.006, 0.006, 0.004), (-0.008, -0.044, -H / 2 + 0.003), "red", bevel=0)
    k.box((0.006, 0.006, 0.004), (0.0, -0.044, -H / 2 + 0.003), "rubber", bevel=0)
    k.riser(-0.008, 0.06, -H / 2 - 0.011)
    k.lens(0, 0.02, "coat", square=True, w=W, h=H)
    k.lens(0, -0.02, square=True, w=W, h=H)
    k.empty("Eye", (0, -0.025, 0))


def sight_x2(k: Kit):
    """短いプリズムスコープ（2 倍）"""
    k.tube(0, 0, 0.098, -0.05, "body", wall=0.0032, square=True, w=0.036, h=0.032)
    k.tube(0.0165, 0.0165, 0.016, -0.066, "rubber", wall=0.003)  # 目当てのゴム
    k.box((0.012, 0.07, 0.006), (0, -0.004, 0.0185), "dark")  # 上の予備のレール
    k.box((0.0016, 0.08, 0.004), (0.0186, -0.004, 0.008), "accent", bevel=0)
    k.cyl(0.006, 0.008, (0.0205, 0.006, -0.004), "body", axis="X", verts=16)
    k.riser(0.0, 0.07, -0.016)
    k.lens(0, 0.046, "coat", square=True, w=0.03, h=0.026)
    k.lens(0, -0.046, square=True, w=0.03, h=0.026)
    k.empty("Eye", (0, -0.066, 0))


def sight_x3(k: Kit):
    """光ファイバーの付いた中距離スコープ（3 倍）"""
    k.tube(0.0175, 0.0215, 0.13, -0.07, "body", wall=0.0028)
    k.tube(0.0175, 0.0175, 0.012, -0.082, "rubber", wall=0.003)
    k.tube(0.0235, 0.0235, 0.012, 0.049, "body", wall=0.0035)  # 対物側の縁
    # 上の光ファイバー（照準が光る）
    k.cyl(0.0032, 0.085, (0, -0.005, 0.0235), "amber", verts=12, bevel=0)
    k.box((0.012, 0.09, 0.004), (0, -0.005, 0.0205), "dark")
    # 横と上の調整つまみ
    k.cyl(0.0058, 0.009, (0.022, -0.012, 0), "body", axis="X", verts=16)
    k.cyl(0.0058, 0.009, (0, -0.012, -0.0) , "body", axis="Z", verts=16).location.z = 0.024
    k.riser(-0.005, 0.07, -0.017)
    k.lens(0.019, 0.058, "coat")
    k.lens(0.0158, -0.066)
    k.empty("Eye", (0, -0.082, 0))


def sight_threat(k: Kit):
    """敵を浮かび上がらせるデジタルスコープ（約 1.6 倍）"""
    k.tube(0, 0, 0.092, -0.048, "dark", wall=0.0034, square=True, w=0.044, h=0.038)
    k.tube(0.017, 0.017, 0.014, -0.062, "rubber", wall=0.003)
    # 上のセンサーと、赤く光る帯
    k.box((0.03, 0.05, 0.012), (0, 0.01, 0.025), "body")
    k.box((0.022, 0.006, 0.006), (0, 0.036, 0.025), "red", bevel=0)
    for sx in (-1, 1):
        k.box((0.0016, 0.07, 0.004), (sx * 0.0226, 0.0, 0.01), "red", bevel=0)
    # 横の電池
    k.cyl(0.008, 0.05, (-0.03, -0.004, -0.004), "body", verts=16)
    k.riser(0.0, 0.07, -0.019)
    k.lens(0, 0.044, "glassRed", square=True, w=0.036, h=0.03)
    k.lens(0, -0.044, "glassRed", square=True, w=0.036, h=0.03)
    k.empty("Eye", (0, -0.062, 0))


def scope_rings(k: Kit, ys, r):
    for y in ys:
        k.tube(r + 0.003, r + 0.003, 0.014, y - 0.007, "dark", wall=0.0035)
        k.box((0.02, 0.014, 0.036 - r), (0, y, -(0.036 + r) / 2 - 0.002), "dark")
        k.box((0.028, 0.016, 0.008), (0, y, -0.034), "body")


def sight_sniper(k: Kit):
    """狙撃用の標準スコープ"""
    k.tube(0.021, 0.021, 0.2, -0.07, "body", wall=0.003)
    k.tube(0.021, 0.031, 0.04, 0.13, "body", wall=0.003)
    k.tube(0.031, 0.031, 0.05, 0.17, "body", wall=0.003)  # 対物レンズ側
    k.tube(0.027, 0.021, 0.03, -0.1, "body", wall=0.003)
    k.tube(0.027, 0.027, 0.05, -0.15, "dark", wall=0.003)  # 接眼レンズ側
    k.tube(0.0215, 0.0215, 0.01, 0.035, "accent", wall=0.0008)
    k.cyl(0.008, 0.03, (0.026, 0.03, 0.0), "dark", axis="X", verts=16)
    k.cyl(0.008, 0.03, (0, 0.03, 0.026), "dark", axis="Z", verts=16)
    scope_rings(k, (-0.04, 0.09), 0.021)
    k.lens(0.029, 0.215, "coat")
    k.lens(0.025, -0.145)
    k.empty("Eye", (0, -0.15, 0))


def sight_variable(k: Kit):
    """倍率を切り替えられる大きなスコープ（4〜8 倍）"""
    k.tube(0.022, 0.022, 0.2, -0.07, "body", wall=0.003)
    k.tube(0.022, 0.035, 0.05, 0.13, "body", wall=0.003)
    k.tube(0.035, 0.035, 0.06, 0.18, "body", wall=0.003)
    k.tube(0.036, 0.036, 0.02, 0.22, "rubber", wall=0.003)  # 日よけ
    k.tube(0.029, 0.022, 0.03, -0.1, "body", wall=0.003)
    k.tube(0.029, 0.029, 0.06, -0.16, "dark", wall=0.003)
    # 倍率リング（光る目盛り付き）
    k.tube(0.0305, 0.0305, 0.018, -0.13, "rubber", wall=0.002)
    for i in range(10):
        a = i / 10 * math.pi * 2
        k.box((0.002, 0.003, 0.004), (math.cos(a) * 0.0325, -0.121, math.sin(a) * 0.0325), "accent", bevel=0)
    # 大きな調整つまみ（上・横）と、視差のつまみ
    k.cyl(0.011, 0.024, (0, 0.03, 0.033), "body", axis="Z", verts=20)
    k.cyl(0.0115, 0.004, (0, 0.03, 0.046), "accent", axis="Z", verts=20, bevel=0)
    k.cyl(0.011, 0.024, (0.033, 0.03, 0), "body", axis="X", verts=20)
    k.cyl(0.014, 0.012, (-0.03, 0.03, 0), "dark", axis="X", verts=20)
    scope_rings(k, (-0.045, 0.1), 0.022)
    k.lens(0.032, 0.235, "coat")
    k.lens(0.027, -0.155)
    k.empty("Eye", (0, -0.16, 0))


# ---------------------------------------------------------------------------
# アタッチメント
# ---------------------------------------------------------------------------


def att_suppressor(k: Kit):
    k.cyl(0.02, 0.165, (0, 0.0525, 0), "body", verts=28)
    k.cyl(0.0205, 0.006, (0, 0.11, 0), "accent", verts=28, bevel=0)
    k.cyl(0.021, 0.02, (0, -0.02, 0), "dark", verts=28)
    k.cyl(0.0165, 0.006, (0, 0.136, 0), "dark", verts=28, bevel=0)
    for i in range(6):  # 表面の溝
        k.cyl(0.0203, 0.003, (0, 0.0 + i * 0.016, 0), "dark", verts=28, bevel=0)
    k.empty("Tip", (0, 0.14, 0))


def att_compensator(k: Kit):
    k.box((0.03, 0.062, 0.03), (0, 0.016, 0), "body", bevel=0.003)
    for i in range(3):  # 上に抜けるガス穴
        k.box((0.02, 0.007, 0.002), (0, 0.0 + i * 0.016, 0.0151), "accent", bevel=0)
        for sx in (-1, 1):
            k.box((0.002, 0.007, 0.014), (sx * 0.0151, 0.0 + i * 0.016, 0.0), "rubber", bevel=0)
    k.empty("Tip", (0, 0.05, 0))


def att_longbarrel(k: Kit):
    k.cyl(0.0125, 0.11, (0, 0.04, 0), "steel", verts=20)
    k.cyl(0.0175, 0.04, (0, 0.11, 0), "body", verts=8)
    k.cyl(0.013, 0.004, (0, 0.06, 0), "accent", verts=20, bevel=0)
    k.empty("Tip", (0, 0.13, 0))


def att_laser(k: Kit):
    k.box((0.016, 0.056, 0.022), (0, 0.0, 0), "dark", bevel=0.002)
    k.box((0.018, 0.02, 0.024), (0, -0.01, 0), "body", bevel=0.002)
    k.cyl(0.0045, 0.006, (0, 0.029, 0.004), "red", bevel=0)
    k.cyl(0.004, 0.006, (0, 0.029, -0.005), "steel", bevel=0)
    k.box((0.004, 0.008, 0.003), (0.0095, -0.014, 0.004), "red", bevel=0)
    k.empty("Emitter", (0, 0.033, 0.004))


def att_magpull(k: Kit):
    """クイックリロードの引き手（弾倉の底に付ける）"""
    k.box((0.03, 0.05, 0.008), (0, 0.0, -0.004), "dark")
    k.box((0.022, 0.006, 0.026), (0, 0.022, -0.018), "accent", bevel=0.001)
    k.box((0.022, 0.006, 0.006), (0, 0.014, -0.029), "accent", bevel=0.001)


PARTS = {
    "Sight_reddot": sight_reddot,
    "Sight_holo": sight_holo,
    "Sight_x2": sight_x2,
    "Sight_x3": sight_x3,
    "Sight_threat": sight_threat,
    "Sight_sniper": sight_sniper,
    "Sight_variable": sight_variable,
    "Att_suppressor": att_suppressor,
    "Att_compensator": att_compensator,
    "Att_longbarrel": att_longbarrel,
    "Att_laser": att_laser,
    "Att_magpull": att_magpull,
}


def render_preview(path):
    """確認用：全部を並べて描く"""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 64
    scene.render.resolution_x = 1400
    scene.render.resolution_y = 700
    world = bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.05, 0.04, 0.08, 1)
    cam_data = bpy.data.cameras.new("Cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = 1.45
    cam = bpy.data.objects.new("Cam", cam_data)
    scene.collection.objects.link(cam)
    cam.location = (1.4, 0.3, 0.55)
    cam.rotation_euler = (Vector((0, 0.3, -0.1)) - cam.location).to_track_quat("-Z", "Z").to_euler()
    scene.camera = cam
    for loc, e in (((2, -1, 2), 400), ((-1.5, 1.5, 1), 200)):
        ld = bpy.data.lights.new("L", "AREA")
        ld.energy = e
        ld.size = 2
        lo = bpy.data.objects.new("L", ld)
        lo.location = loc
        lo.rotation_euler = (Vector((0, 0.3, 0)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        scene.collection.objects.link(lo)
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def main():
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    k = Kit()
    roots = []
    for name, fn in PARTS.items():
        fn(k)
        roots.append(k.finish(name))
    bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_yup=True, export_apply=True)
    print(f"書き出し: {OUT} ({os.path.getsize(OUT) // 1024} KB)")
    if "--preview" in args:
        # 並べて描く（書き出しのあとで位置を動かす）
        for i, r in enumerate(roots):
            r.location = (0, (i % 4) * 0.33, -(i // 4) * 0.2 + 0.1)
        os.makedirs(os.path.join(HERE, "preview"), exist_ok=True)
        render_preview(os.path.join(HERE, "preview", "sights.png"))


if __name__ == "__main__":
    main()
