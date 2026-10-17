"""
武器モデル（12 丁）を Blender で作り、glTF（.glb）で書き出すスクリプト。

使い方（どちらでも同じ結果になる）
  1) Blender 本体：  blender --background --python assets-src/weapons/build_weapons.py
  2) bpy モジュール： python assets-src/weapons/build_weapons.py   （pip install bpy、Python 3.11）

書き出し先：client/assets/weapons/<id>.glb
  オプション --blend を付けると、確認用に assets-src/weapons/<id>.blend も保存する。
  オプション --preview を付けると、assets-src/weapons/preview/<id>.png に確認用の画像を描く。

座標の約束（ゲーム側でこの前提で表示する）
  - Blender の +Y が銃口の向き（glTF / three.js では -Z）、+Z が上
  - 原点は「照準の中心」。エイム（ADS）するとカメラがここに来る。照門・照星（"IronSights"）も、
    サイト（assets-src/weapons/build_sights.py）の中心も、この高さ（z=0）にそろえる
  - 一人称の腕を付ける位置に "GripR"（グリップ）と "GripL"（銃身の下）
  - 銃口の位置に "Muzzle"、弾倉に "Magazine"（ショットガンは先台 "Pump"、リボルバーは "Cylinder"）という名前のオブジェクトを置く
  - 回転式の LMG は、回る銃身の束を "Barrels"（原点が回る軸の上）にする
  - サイトを付ける位置に "SightMount"、レーザーサイトを付ける位置に "LaserMount"（どちらも空のオブジェクト）
"""

import math
import os
import sys

import bpy
from mathutils import Euler, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT_DIR = os.path.join(ROOT, "client", "assets", "weapons")

# ---------------------------------------------------------------------------
# 色（ゲームのネオン調に合わせる）
# ---------------------------------------------------------------------------
ACCENTS = {
    "ar": (0.31, 0.82, 1.0),  # シアン
    "lmg": (1.0, 0.48, 0.10),  # オレンジ
    "smg": (1.0, 0.31, 0.85),  # マゼンタ
    "shotgun": (1.0, 0.71, 0.36),  # アンバー
    "sniper": (0.54, 0.36, 1.0),  # 紫
    "pistol": (0.36, 1.0, 0.62),  # ミントグリーン
    "burst": (0.66, 1.0, 0.25),  # ライム
    "psmg": (1.0, 0.27, 0.32),  # 赤
    "spinlmg": (1.0, 0.84, 0.2),  # 黄色
    "autosg": (0.3, 0.5, 1.0),  # 青
    "marksman": (1.0, 0.9, 0.66),  # 白金
    "revolver": (1.0, 0.45, 0.62),  # 桃色
}


# 光る線の強さ（明るい色はブルームで広がりすぎるので弱める）
ACCENT_STRENGTH = {"burst": 1.3, "spinlmg": 1.2, "marksman": 1.1, "psmg": 2.0, "revolver": 1.9}


def srgb_to_linear(c):
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)


def make_material(name, color, metallic=0.0, roughness=0.5, emission=None, emission_strength=0.0, alpha=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    lin = srgb_to_linear(color)
    bsdf.inputs["Base Color"].default_value = (*lin, 1.0)
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
    """武器1丁ぶんの部品を作る道具"""

    def __init__(self, weapon_id):
        accent = ACCENTS[weapon_id]
        self.mat = {
            "body": make_material("Body", (0.16, 0.17, 0.2), metallic=0.55, roughness=0.42),
            "dark": make_material("Polymer", (0.07, 0.075, 0.085), metallic=0.0, roughness=0.75),
            "steel": make_material("Steel", (0.42, 0.44, 0.48), metallic=0.9, roughness=0.3),
            "accent": make_material("Accent", accent, metallic=0.0, roughness=0.4, emission=accent, emission_strength=ACCENT_STRENGTH.get(weapon_id, 2.5)),
            "paint": make_material("Paint", tuple(0.08 + 0.42 * c for c in accent), metallic=0.25, roughness=0.45),
            "glass": make_material("Glass", accent, metallic=0.0, roughness=0.05, emission=accent, emission_strength=0.6, alpha=0.25),
            "reticle": make_material("Reticle", (1.0, 0.25, 0.3), emission=(1.0, 0.2, 0.25), emission_strength=8.0),
        }
        self.parts = {}

    def _finish(self, obj, group, mat, bevel):
        obj.data.materials.append(self.mat[mat])
        if bevel > 0:
            mod = obj.modifiers.new("Bevel", "BEVEL")
            mod.width = bevel
            mod.segments = 2
            mod.limit_method = "ANGLE"
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.modifier_apply(modifier=mod.name)
        self.parts.setdefault(group, []).append(obj)
        return obj

    def box(self, size, loc, mat="body", rot=(0, 0, 0), group="Body", bevel=0.003):
        """size=(幅x, 長さy, 高さz)、loc=中心、rot=度"""
        bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=Euler([math.radians(r) for r in rot]))
        o = bpy.context.active_object
        o.scale = size
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        return self._finish(o, group, mat, min(bevel, min(size) * 0.3))

    def cyl(self, radius, length, loc, mat="steel", axis="Y", verts=16, group="Body", bevel=0.0015, rot=None):
        r = {"X": (0, 90, 0), "Y": (90, 0, 0), "Z": (0, 0, 0)}[axis] if rot is None else rot
        bpy.ops.mesh.primitive_cylinder_add(
            vertices=verts, radius=radius, depth=length, location=loc, rotation=Euler([math.radians(a) for a in r])
        )
        o = bpy.context.active_object
        return self._finish(o, group, mat, min(bevel, radius * 0.3))

    def ring(self, radius, thickness, width, loc, mat="accent", verts=20, group="Body"):
        """銃身を巻く光る輪（細い円柱の外側だけ）"""
        return self.cyl(radius + thickness, width, loc, mat=mat, verts=verts, group=group, bevel=0)

    def empty(self, name, loc):
        e = bpy.data.objects.new(name, None)
        e.location = loc
        e.empty_display_size = 0.02
        bpy.context.collection.objects.link(e)
        return e

    def red_dot(self, y=0.07, z_top=0.0, base_z=-0.03):
        """ドットサイト。照準の中心（原点の延長線上）に赤い点が来る"""
        self.box((0.03, 0.05, abs(base_z - (z_top - 0.024))), (0, y, (base_z + z_top - 0.024) / 2), "body")
        w, h, d = 0.046, 0.04, 0.03
        t = 0.004
        # 四角い枠
        self.box((w, d, t), (0, y, z_top + h / 2 - t / 2), "dark")
        self.box((t, d, h), (-w / 2 + t / 2, y, z_top), "dark")
        self.box((t, d, h), (w / 2 - t / 2, y, z_top), "dark")
        self.box((w, d, t), (0, y, z_top - h / 2 + t / 2), "dark")
        self.box((w - 2 * t, 0.001, h - 2 * t), (0, y + 0.01, z_top), "glass", bevel=0)
        self.box((0.0025, 0.001, 0.0025), (0, y + 0.0105, z_top), "reticle", bevel=0)

    def iron_sights(self, rear_y, rear_base_z, front_y, front_base_z):
        """折りたたみ式の照門（後ろ）と照星（前）。のぞく線は z=0。サイトを付けると隠す（"IronSights"）"""
        g = "IronSights"
        # 照門：台と、四角い穴の枠（穴の中心が z=0）
        self.box((0.022, 0.018, -0.0065 - rear_base_z), (0, rear_y, (rear_base_z - 0.0065) / 2), "body", group=g)
        for sx in (-1, 1):
            self.box((0.0035, 0.008, 0.017), (sx * 0.0058, rear_y, 0.0015), "dark", group=g, bevel=0.0008)
        self.box((0.0151, 0.008, 0.003), (0, rear_y, -0.0055), "dark", group=g, bevel=0.0006)
        self.box((0.0151, 0.008, 0.0028), (0, rear_y, 0.0086), "dark", group=g, bevel=0.0006)
        # 照星：台、細い柱（先が z=0）、両側の耳
        self.box((0.018, 0.016, -0.011 - front_base_z), (0, front_y, (front_base_z - 0.011) / 2), "body", group=g)
        self.box((0.0022, 0.004, 0.0115), (0, front_y, -0.0058), "dark", group=g, bevel=0)
        self.box((0.0026, 0.0045, 0.0026), (0, front_y, -0.0003), "accent", group=g, bevel=0)
        for sx in (-1, 1):
            self.box((0.0022, 0.009, 0.015), (sx * 0.0072, front_y, -0.004), "dark", group=g, bevel=0.0006)

    def join_groups(self, root_name):
        """部品をグループごとに1つのメッシュにまとめ、空の親の下に入れる"""
        root = bpy.data.objects.new(root_name, None)
        bpy.context.collection.objects.link(root)
        for group, objs in self.parts.items():
            bpy.ops.object.select_all(action="DESELECT")
            for o in objs:
                o.select_set(True)
            bpy.context.view_layer.objects.active = objs[0]
            if len(objs) > 1:
                bpy.ops.object.join()
            merged = bpy.context.active_object
            merged.name = group
            merged.data.name = group
            # 原点を部品の中心に（弾倉などを動かしやすくする）
            if group != "Body":
                bpy.ops.object.origin_set(type="ORIGIN_GEOMETRY", center="BOUNDS")
            merged.parent = root
        return root


# ---------------------------------------------------------------------------
# 各武器
# ---------------------------------------------------------------------------


def build_ar(k: Kit):
    bore = -0.065
    k.box((0.058, 0.32, 0.085), (0, 0.02, -0.072))  # 機関部
    k.box((0.052, 0.10, 0.03), (0, 0.10, -0.125), "body")  # 弾倉の差し込み口
    k.box((0.054, 0.30, 0.062), (0, 0.33, -0.07), "paint")  # ハンドガード
    for s in (-1, 1):
        k.box((0.002, 0.22, 0.006), (s * 0.0275, 0.34, -0.06), "accent", bevel=0)
        k.box((0.002, 0.22, 0.006), (s * 0.0275, 0.34, -0.08), "accent", bevel=0)
    k.box((0.024, 0.42, 0.012), (0, 0.13, -0.024), "dark")  # 上のレール
    k.cyl(0.011, 0.20, (0, 0.57, bore))  # 銃身
    k.cyl(0.017, 0.055, (0, 0.69, bore), "body", verts=8)  # マズルブレーキ
    k.box((0.034, 0.05, 0.11), (0, -0.04, -0.165), "dark", rot=(-18, 0, 0))  # グリップ
    k.box((0.012, 0.06, 0.004), (0, 0.025, -0.125), "steel")  # 用心金
    k.box((0.044, 0.20, 0.068), (0, -0.24, -0.08), "dark")  # 銃床
    k.box((0.048, 0.022, 0.11), (0, -0.345, -0.095), "body")
    k.box((0.002, 0.14, 0.006), (0.0225, -0.24, -0.07), "accent", bevel=0)
    k.box((0.03, 0.07, 0.15), (0, 0.10, -0.2), "dark", rot=(14, 0, 0), group="Magazine")
    k.box((0.032, 0.006, 0.12), (0, 0.137, -0.195), "accent", rot=(14, 0, 0), group="Magazine", bevel=0)
    k.iron_sights(rear_y=-0.05, rear_base_z=-0.018, front_y=0.40, front_base_z=-0.04)
    k.empty("SightMount", (0, 0.06, 0))
    k.empty("LaserMount", (0.038, 0.36, -0.074))
    k.empty("Muzzle", (0, 0.72, bore))
    k.empty("GripR", (0, -0.035, -0.15))  # 右手（引き金の手）の握る位置
    k.empty("GripL", (0, 0.33, -0.105))  # 左手で支える位置


def build_lmg(k: Kit):
    bore = -0.08
    k.box((0.08, 0.40, 0.12), (0, 0.0, -0.09))  # 機関部
    k.box((0.084, 0.22, 0.02), (0, 0.02, -0.022), "dark")  # 上ぶた
    k.cyl(0.032, 0.36, (0, 0.38, bore), "paint", verts=20)  # 銃身のカバー
    for y in (0.24, 0.31, 0.38, 0.45, 0.52):
        k.ring(0.032, 0.002, 0.008, (0, y, bore))
    k.cyl(0.013, 0.20, (0, 0.65, bore))  # 銃身
    k.cyl(0.02, 0.06, (0, 0.77, bore), "body", verts=8)
    # 機関部の横のレール（照準の視界をふさがない高さ）
    for s in (-1, 1):
        k.box((0.008, 0.26, 0.012), (s * 0.044, 0.06, -0.05), "dark")
    for s in (-1, 1):  # 折りたたんだ二脚
        k.cyl(0.006, 0.26, (s * 0.018, 0.42, bore - 0.04), "steel", verts=8)
    k.box((0.038, 0.06, 0.12), (0, -0.07, -0.2), "dark", rot=(-15, 0, 0))  # グリップ
    k.box((0.05, 0.26, 0.05), (0, -0.33, -0.1), "dark")  # 骨組みの銃床
    k.box((0.05, 0.03, 0.14), (0, -0.46, -0.12), "body")
    k.box((0.05, 0.2, 0.02), (0, -0.33, -0.17), "dark")
    k.box((0.002, 0.30, 0.008), (0.0405, 0.0, -0.09), "accent", bevel=0)
    k.box((0.002, 0.30, 0.008), (-0.0405, 0.0, -0.09), "accent", bevel=0)
    # 箱型の弾倉
    k.box((0.10, 0.12, 0.13), (0, 0.06, -0.21), "body", group="Magazine")
    k.box((0.102, 0.08, 0.006), (0, 0.06, -0.19), "accent", group="Magazine", bevel=0)
    k.box((0.024, 0.20, 0.008), (0, 0.02, -0.009), "dark")  # 上ぶたのレール
    k.iron_sights(rear_y=-0.07, rear_base_z=-0.005, front_y=0.5, front_base_z=-0.048)
    k.empty("SightMount", (0, 0.03, 0))
    k.empty("LaserMount", (0.043, 0.43, bore))
    k.empty("Muzzle", (0, 0.81, bore))
    k.empty("GripR", (0, -0.065, -0.18))  # 右手（引き金の手）の握る位置
    k.empty("GripL", (0, 0.3, -0.115))  # 左手で支える位置


def build_smg(k: Kit):
    bore = -0.07
    k.box((0.056, 0.24, 0.09), (0, 0.04, -0.075))  # 機関部
    k.box((0.05, 0.13, 0.06), (0, 0.22, -0.072), "paint")  # 銃身カバー
    for s in (-1, 1):
        k.box((0.002, 0.10, 0.005), (s * 0.0255, 0.22, -0.06), "accent", bevel=0)
    k.cyl(0.01, 0.10, (0, 0.33, bore))  # 短い銃身
    k.cyl(0.016, 0.05, (0, 0.38, bore), "body", verts=10)
    k.box((0.022, 0.30, 0.012), (0, 0.08, -0.025), "dark")
    k.box((0.03, 0.035, 0.09), (0, 0.24, -0.14), "dark", rot=(8, 0, 0))  # 前のグリップ
    k.box((0.034, 0.045, 0.1), (0, -0.05, -0.155), "dark", rot=(-16, 0, 0))  # グリップ
    k.box((0.03, 0.14, 0.03), (0, -0.16, -0.06), "dark")  # 縮めた銃床
    k.box((0.04, 0.02, 0.08), (0, -0.235, -0.07), "body")
    k.box((0.002, 0.10, 0.005), (0.0285, 0.0, -0.09), "accent", bevel=0)
    k.box((0.028, 0.045, 0.19), (0, 0.10, -0.21), "dark", rot=(4, 0, 0), group="Magazine")
    k.box((0.03, 0.006, 0.15), (0, 0.124, -0.2), "accent", rot=(4, 0, 0), group="Magazine", bevel=0)
    k.iron_sights(rear_y=-0.05, rear_base_z=-0.019, front_y=0.25, front_base_z=-0.042)
    k.empty("SightMount", (0, 0.06, 0))
    k.empty("LaserMount", (0.036, 0.22, -0.074))
    k.empty("Muzzle", (0, 0.41, bore))
    k.empty("GripR", (0, -0.045, -0.14))  # 右手（引き金の手）の握る位置
    k.empty("GripL", (0, 0.24, -0.13))  # 左手で支える位置


def build_shotgun(k: Kit):
    bore = -0.06
    k.box((0.064, 0.26, 0.1), (0, 0.0, -0.07))  # 機関部
    k.cyl(0.021, 0.52, (0, 0.38, bore), "steel", verts=20)  # 太い銃身
    k.cyl(0.016, 0.44, (0, 0.34, bore - 0.045), "body", verts=16)  # 弾を入れる筒
    k.ring(0.021, 0.002, 0.01, (0, 0.6, bore))
    k.box((0.058, 0.14, 0.055), (0, 0.33, bore - 0.045), "dark", group="Pump")  # 先台
    for y in (0.29, 0.31, 0.33, 0.35, 0.37):
        k.box((0.06, 0.006, 0.058), (0, y, bore - 0.045), "body", group="Pump", bevel=0.001)
    k.box((0.034, 0.05, 0.11), (0, -0.07, -0.16), "dark", rot=(-20, 0, 0))  # グリップ
    k.box((0.05, 0.26, 0.08), (0, -0.25, -0.11), "dark", rot=(-6, 0, 0))  # 銃床
    k.box((0.054, 0.025, 0.12), (0, -0.375, -0.13), "body", rot=(-6, 0, 0))
    # 機関部の横の予備の弾（光る薬莢）
    for i in range(4):
        y = -0.06 + i * 0.035
        k.cyl(0.009, 0.05, (0.036, y, -0.085), "paint", axis="Z", verts=10)
        k.cyl(0.0095, 0.008, (0.036, y, -0.058), "accent", axis="Z", verts=10, bevel=0)
    # ゴーストリングの照門と照星（サイトを付けると隠す）
    g = "IronSights"
    k.box((0.006, 0.01, 0.03), (0, 0.6, bore + 0.035), "body", group=g)
    k.box((0.004, 0.004, 0.004), (0, 0.6, bore + 0.052), "accent", bevel=0, group=g)
    k.box((0.034, 0.012, 0.006), (0, 0.04, -0.02), "body", group=g)
    k.box((0.006, 0.012, 0.03), (-0.014, 0.04, 0.0), "body", group=g)
    k.box((0.006, 0.012, 0.03), (0.014, 0.04, 0.0), "body", group=g)
    k.box((0.034, 0.012, 0.004), (0, 0.04, 0.017), "body", group=g)
    k.box((0.022, 0.15, 0.006), (0, -0.03, -0.017), "dark")  # 機関部の上のレール
    k.empty("SightMount", (0, -0.02, 0))
    k.empty("LaserMount", (0.033, 0.47, bore))
    k.empty("Muzzle", (0, 0.65, bore))
    k.empty("GripR", (0, -0.065, -0.145))  # 右手（引き金の手）の握る位置
    k.empty("GripL", (0, 0.33, -0.135))  # 左手で支える位置


def build_sniper(k: Kit):
    bore = -0.08
    k.box((0.06, 0.34, 0.09), (0, 0.02, -0.085))  # 機関部
    k.cyl(0.013, 0.80, (0, 0.58, bore), "steel", verts=16)  # 長い銃身
    for y in (0.4, 0.55, 0.7):
        k.ring(0.013, 0.002, 0.008, (0, y, bore))
    k.box((0.042, 0.065, 0.034), (0, 0.99, bore), "body")  # マズルブレーキ
    k.box((0.05, 0.36, 0.05), (0, 0.32, -0.11), "paint")  # 銃身の下の台
    # スコープは別のモデル（build_sights.py）。ここには取り付けるレールだけ
    k.box((0.024, 0.30, 0.01), (0, 0.06, -0.035), "dark")
    for y in range(9):
        k.box((0.026, 0.008, 0.004), (0, -0.07 + y * 0.032, -0.029), "dark", bevel=0)
    k.empty("SightMount", (0, 0.06, 0))
    k.empty("LaserMount", (0.036, 0.40, -0.11))
    k.cyl(0.006, 0.05, (0.04, -0.05, -0.065), "steel", axis="X", verts=8)  # ボルトの取っ手
    k.cyl(0.011, 0.012, (0.067, -0.05, -0.065), "accent", axis="X", verts=10, bevel=0)
    k.box((0.036, 0.055, 0.12), (0, -0.09, -0.17), "dark", rot=(-18, 0, 0))  # グリップ
    k.box((0.052, 0.30, 0.09), (0, -0.3, -0.11), "dark")  # 銃床
    k.box((0.04, 0.16, 0.025), (0, -0.28, -0.05), "paint")  # 頬当て
    k.box((0.056, 0.025, 0.14), (0, -0.46, -0.12), "body")
    k.box((0.002, 0.22, 0.006), (0.0265, -0.3, -0.1), "accent", bevel=0)
    k.box((0.036, 0.07, 0.08), (0, 0.04, -0.165), "dark", group="Magazine")
    k.box((0.038, 0.006, 0.06), (0, 0.076, -0.165), "accent", group="Magazine", bevel=0)
    k.empty("Muzzle", (0, 1.03, bore))
    k.empty("GripR", (0, -0.085, -0.155))  # 右手（引き金の手）の握る位置
    k.empty("GripL", (0, 0.3, -0.14))  # 左手で支える位置


def build_pistol(k: Kit):
    """ハンドガン：スライドの上に 3 点の照門・照星。グリップの中に弾倉"""
    bore = -0.03
    # スライド（上の動く部分）と、前後の溝
    k.box((0.03, 0.2, 0.032), (0, 0.01, -0.024), "body", bevel=0.003)
    for i in range(5):
        for sx in (-1, 1):
            k.box((0.002, 0.004, 0.022), (sx * 0.0152, -0.07 + i * 0.008, -0.024), "dark", bevel=0)
    for sx in (-1, 1):
        k.box((0.002, 0.11, 0.005), (sx * 0.0152, 0.04, -0.018), "accent", bevel=0)
    k.box((0.012, 0.06, 0.004), (0, 0.035, -0.0075), "dark")  # 排莢口
    # フレーム（下の部分）と、前のレール
    k.box((0.028, 0.17, 0.024), (0, -0.002, -0.052), "paint", bevel=0.0025)
    k.box((0.022, 0.05, 0.008), (0, 0.06, -0.068), "dark")
    # 銃身の先
    k.cyl(0.0075, 0.016, (0, 0.112, bore), "steel", verts=16)
    k.cyl(0.0048, 0.004, (0, 0.121, bore), "dark", verts=16, bevel=0)
    # 用心金と引き金
    k.box((0.022, 0.05, 0.004), (0, 0.012, -0.088), "dark", bevel=0.001)
    k.box((0.022, 0.004, 0.026), (0, 0.035, -0.076), "dark", bevel=0.001)
    k.box((0.004, 0.006, 0.016), (0, 0.006, -0.074), "steel", rot=(15, 0, 0), bevel=0)
    # グリップ（少し後ろに傾ける）と、滑り止め
    k.box((0.031, 0.046, 0.1), (0, -0.05, -0.108), "dark", rot=(-16, 0, 0), bevel=0.004)
    for sx in (-1, 1):
        k.box((0.002, 0.03, 0.06), (sx * 0.016, -0.052, -0.11), "body", rot=(-16, 0, 0), bevel=0)
    k.box((0.032, 0.03, 0.012), (0, -0.088, -0.052), "body", bevel=0.002)  # 握りの上の張り出し
    # 弾倉（グリップの底から抜く）
    k.box((0.024, 0.034, 0.09), (0, -0.062, -0.122), "body", rot=(-16, 0, 0), group="Magazine")
    k.box((0.03, 0.04, 0.008), (0, -0.074, -0.165), "accent", rot=(-16, 0, 0), group="Magazine", bevel=0.001)
    # 照門・照星（白い点。のぞく線は z=0）
    g = "IronSights"
    for sx in (-1, 1):
        k.box((0.008, 0.008, 0.009), (sx * 0.007, -0.08, -0.0035), "dark", group=g, bevel=0.0008)
        k.box((0.0026, 0.0012, 0.0026), (sx * 0.007, -0.0844, -0.002), "accent", group=g, bevel=0)
    k.box((0.004, 0.008, 0.0095), (0, 0.095, -0.004), "dark", group=g, bevel=0.0006)
    k.box((0.0026, 0.0012, 0.0026), (0, 0.0905, -0.0015), "accent", group=g, bevel=0)
    k.empty("SightMount", (0, -0.03, 0))
    k.empty("LaserMount", (0, 0.06, -0.08))
    k.empty("Muzzle", (0, 0.124, bore))
    k.empty("GripR", (0, -0.05, -0.1))
    k.empty("GripL", (0, -0.03, -0.12))


def build_burst(k: Kit):
    """トライデント：3点射のブルパップ式ライフル。弾倉はグリップの後ろ。三角の銃身カバーと、銃口の 3 本の爪"""
    bore = -0.06
    k.box((0.056, 0.56, 0.082), (0, -0.04, -0.068))  # 長い機関部（後ろが銃床を兼ねる）
    k.box((0.06, 0.16, 0.05), (0, -0.25, -0.12), "dark")  # 銃床の下
    k.box((0.062, 0.03, 0.13), (0, -0.33, -0.09), "body")  # 床尾
    k.cyl(0.04, 0.26, (0, 0.33, bore), "paint", verts=3, rot=(90, 0, 0))  # 三角の銃身カバー
    for y in (0.24, 0.33, 0.42):
        k.cyl(0.043, 0.008, (0, y, bore), "accent", verts=3, rot=(90, 0, 0), bevel=0)
    k.cyl(0.011, 0.14, (0, 0.52, bore))  # 銃身
    for a in (90, 210, 330):  # 銃口の 3 本の爪
        r = math.radians(a)
        k.box((0.008, 0.05, 0.008), (math.cos(r) * 0.016, 0.6, bore + math.sin(r) * 0.016), "steel", bevel=0.001)
    k.cyl(0.014, 0.02, (0, 0.585, bore), "body", verts=10)
    k.box((0.024, 0.46, 0.012), (0, 0.02, -0.022), "dark")  # 上のレール
    for s_ in (-1, 1):
        k.box((0.002, 0.34, 0.006), (s_ * 0.0285, -0.06, -0.055), "accent", bevel=0)
    k.box((0.034, 0.05, 0.11), (0, 0.08, -0.16), "dark", rot=(-14, 0, 0))  # グリップ（弾倉の前）
    k.box((0.014, 0.08, 0.004), (0, 0.11, -0.115), "steel")  # 用心金
    k.box((0.03, 0.065, 0.13), (0, -0.12, -0.17), "dark", rot=(10, 0, 0), group="Magazine")
    k.box((0.032, 0.006, 0.1), (0, -0.087, -0.165), "accent", rot=(10, 0, 0), group="Magazine", bevel=0)
    k.iron_sights(rear_y=0.0, rear_base_z=-0.017, front_y=0.38, front_base_z=-0.025)
    k.empty("SightMount", (0, 0.08, 0))
    k.empty("LaserMount", (0.044, 0.36, bore))
    k.empty("Muzzle", (0, 0.63, bore))
    k.empty("GripR", (0, 0.085, -0.145))
    k.empty("GripL", (0, 0.32, -0.105))


def build_psmg(k: Kit):
    """ニードル：細長い精密 SMG。長い銃身にひれ、前へ傾いた弾倉、骨組みの銃床"""
    bore = -0.06
    k.box((0.048, 0.26, 0.078), (0, 0.03, -0.068))  # 機関部
    k.box((0.04, 0.24, 0.044), (0, 0.27, bore), "paint")  # 細い銃身カバー
    for i in range(6):  # 放熱のひれ
        k.box((0.05, 0.006, 0.05), (0, 0.18 + i * 0.035, bore), "dark", bevel=0.001)
    k.box((0.002, 0.2, 0.004), (0.0205, 0.27, bore + 0.012), "accent", bevel=0)
    k.box((0.002, 0.2, 0.004), (-0.0205, 0.27, bore + 0.012), "accent", bevel=0)
    k.cyl(0.008, 0.12, (0, 0.44, bore))  # 長い銃身
    k.cyl(0.012, 0.03, (0, 0.5, bore), "body", verts=10)
    k.box((0.022, 0.36, 0.01), (0, 0.11, -0.025), "dark")  # 上のレール
    k.box((0.032, 0.045, 0.1), (0, -0.04, -0.15), "dark", rot=(-16, 0, 0))  # グリップ
    k.box((0.012, 0.06, 0.004), (0, 0.0, -0.11), "steel")
    # 骨組みの銃床（上と下の棒、床尾）
    k.box((0.014, 0.2, 0.014), (0, -0.19, -0.045), "dark")
    k.box((0.014, 0.2, 0.014), (0, -0.19, -0.105), "dark", rot=(-8, 0, 0))
    k.box((0.04, 0.02, 0.1), (0, -0.29, -0.08), "body")
    k.box((0.002, 0.16, 0.005), (0.0075, -0.19, -0.045), "accent", bevel=0)
    k.box((0.028, 0.045, 0.17), (0, 0.11, -0.19), "dark", rot=(-12, 0, 0), group="Magazine")
    k.box((0.03, 0.006, 0.13), (0, 0.135, -0.185), "accent", rot=(-12, 0, 0), group="Magazine", bevel=0)
    k.iron_sights(rear_y=-0.04, rear_base_z=-0.02, front_y=0.3, front_base_z=-0.03)
    k.empty("SightMount", (0, 0.06, 0))
    k.empty("LaserMount", (0.03, 0.27, bore - 0.012))
    k.empty("Muzzle", (0, 0.515, bore))
    k.empty("GripR", (0, -0.035, -0.135))
    k.empty("GripL", (0, 0.25, -0.095))


def build_spinlmg(k: Kit):
    """サイクロン：6 本の銃身が回る LMG。下に大きな円筒の弾倉、上に持ち手。回る束は "Barrels" """
    bore = -0.085
    k.box((0.09, 0.36, 0.13), (0, -0.02, -0.095))  # 機関部
    k.box((0.094, 0.2, 0.02), (0, 0.0, -0.022), "dark")
    k.cyl(0.05, 0.08, (0, 0.2, bore), "body", verts=12)  # モーターの胴
    k.ring(0.05, 0.003, 0.012, (0, 0.17, bore))
    k.ring(0.05, 0.003, 0.012, (0, 0.23, bore))
    # 回る銃身の束（軸は bore の線）
    g = "Barrels"
    for i in range(6):
        a = math.radians(i * 60)
        k.cyl(0.0085, 0.44, (math.cos(a) * 0.027, 0.47, bore + math.sin(a) * 0.027), "steel", verts=10, group=g)
    for y in (0.3, 0.48, 0.66):
        k.cyl(0.04, 0.012, (0, y, bore), "dark", verts=12, group=g, bevel=0)
    k.cyl(0.042, 0.02, (0, 0.69, bore), "accent", verts=12, group=g, bevel=0)
    k.cyl(0.01, 0.46, (0, 0.47, bore), "body", verts=8, group=g)  # 真ん中の軸
    # 持ち手は左の横（のぞく線をふさがない）と、前の握り（下）
    k.box((0.016, 0.18, 0.016), (-0.07, 0.06, -0.05), "dark")
    k.box((0.03, 0.016, 0.016), (-0.055, -0.02, -0.05), "dark")
    k.box((0.03, 0.016, 0.016), (-0.055, 0.14, -0.05), "dark")
    k.box((0.036, 0.04, 0.11), (0, 0.22, -0.17), "dark", rot=(10, 0, 0))
    k.box((0.04, 0.06, 0.12), (0, -0.1, -0.21), "dark", rot=(-14, 0, 0))  # グリップ
    k.box((0.056, 0.2, 0.06), (0, -0.3, -0.11), "dark")  # 短い銃床
    k.box((0.06, 0.03, 0.14), (0, -0.41, -0.12), "body")
    for s_ in (-1, 1):
        k.box((0.002, 0.3, 0.008), (s_ * 0.0455, -0.02, -0.1), "accent", bevel=0)
    # 円筒の弾倉（横向き）
    k.cyl(0.07, 0.1, (0, 0.04, -0.23), "body", axis="X", verts=20, group="Magazine")
    k.cyl(0.072, 0.012, (0, 0.04, -0.23), "accent", axis="X", verts=20, group="Magazine", bevel=0)
    k.iron_sights(rear_y=-0.12, rear_base_z=-0.012, front_y=0.27, front_base_z=-0.05)
    k.empty("SightMount", (0, -0.05, 0))
    k.empty("LaserMount", (0.05, 0.2, bore))
    k.empty("Muzzle", (0, 0.71, bore))
    k.empty("BarrelAxis", (0, 0.47, bore))
    k.empty("GripR", (0, -0.095, -0.19))
    k.empty("GripL", (0, 0.22, -0.15))


def build_autosg(k: Kit):
    """テンペスト：箱型弾倉の全自動ショットガン。太い機関部、穴のあいた放熱カバーの短い銃身"""
    bore = -0.065
    k.box((0.07, 0.3, 0.11), (0, 0.0, -0.08))  # 機関部
    k.box((0.074, 0.16, 0.02), (0, 0.05, -0.02), "paint")
    k.box((0.06, 0.2, 0.07), (0, 0.24, bore - 0.01), "dark")  # 前の握り
    for y in (0.17, 0.21, 0.25, 0.29):
        k.box((0.064, 0.008, 0.074), (0, y, bore - 0.01), "body", bevel=0.001)
    k.cyl(0.028, 0.22, (0, 0.42, bore + 0.01), "paint", verts=8)  # 放熱カバー
    for y in (0.35, 0.4, 0.45, 0.5):
        k.ring(0.028, 0.002, 0.008, (0, y, bore + 0.01))
    k.cyl(0.02, 0.26, (0, 0.42, bore + 0.01), "steel", verts=16)
    k.box((0.05, 0.04, 0.05), (0, 0.55, bore + 0.01), "body")  # 銃口の箱
    k.box((0.034, 0.05, 0.11), (0, -0.06, -0.17), "dark", rot=(-18, 0, 0))  # グリップ
    k.box((0.05, 0.22, 0.08), (0, -0.25, -0.1), "dark")  # 銃床
    k.box((0.056, 0.03, 0.13), (0, -0.37, -0.11), "body")
    k.box((0.002, 0.24, 0.008), (0.0355, 0.0, -0.08), "accent", bevel=0)
    k.box((0.002, 0.24, 0.008), (-0.0355, 0.0, -0.08), "accent", bevel=0)
    k.box((0.022, 0.24, 0.01), (0, 0.0, -0.007), "dark")  # レール
    # 大きな箱型の弾倉
    k.box((0.05, 0.09, 0.14), (0, 0.08, -0.2), "body", rot=(6, 0, 0), group="Magazine")
    k.box((0.052, 0.07, 0.008), (0, 0.08, -0.17), "accent", rot=(6, 0, 0), group="Magazine", bevel=0)
    k.iron_sights(rear_y=-0.06, rear_base_z=-0.003, front_y=0.53, front_base_z=-0.025)
    k.empty("SightMount", (0, 0.0, 0))
    k.empty("LaserMount", (0.035, 0.42, bore))
    k.empty("Muzzle", (0, 0.58, bore + 0.01))
    k.empty("GripR", (0, -0.055, -0.15))
    k.empty("GripL", (0, 0.25, -0.12))


def build_marksman(k: Kit):
    """ファルコン：半自動のマークスマンライフル。長いハンドガード、マズルブレーキ、調整できる頬当て"""
    bore = -0.07
    k.box((0.058, 0.3, 0.085), (0, 0.0, -0.075))  # 機関部
    k.box((0.054, 0.4, 0.06), (0, 0.35, -0.075), "paint")  # 長いハンドガード
    for i in range(5):
        for s_ in (-1, 1):
            k.box((0.002, 0.04, 0.02), (s_ * 0.0275, 0.2 + i * 0.07, -0.075), "dark", bevel=0)
    k.box((0.002, 0.36, 0.005), (0.0275, 0.35, -0.05), "accent", bevel=0)
    k.box((0.002, 0.36, 0.005), (-0.0275, 0.35, -0.05), "accent", bevel=0)
    k.cyl(0.011, 0.2, (0, 0.64, bore))  # 銃身
    k.box((0.036, 0.06, 0.03), (0, 0.76, bore), "body")  # マズルブレーキ
    for y in (0.745, 0.765):
        k.box((0.04, 0.006, 0.012), (0, y, bore + 0.004), "dark", bevel=0)
    k.box((0.024, 0.58, 0.012), (0, 0.22, -0.024), "dark")  # 長いレール
    k.box((0.034, 0.05, 0.11), (0, -0.05, -0.165), "dark", rot=(-18, 0, 0))  # グリップ
    k.box((0.012, 0.06, 0.004), (0, 0.0, -0.12), "steel")
    k.box((0.046, 0.24, 0.07), (0, -0.25, -0.085), "dark")  # 銃床
    k.box((0.034, 0.14, 0.022), (0, -0.24, -0.04), "paint")  # 頬当て
    k.box((0.05, 0.022, 0.12), (0, -0.375, -0.1), "body")
    k.box((0.002, 0.16, 0.006), (0.0235, -0.25, -0.075), "accent", bevel=0)
    k.box((0.03, 0.06, 0.09), (0, 0.07, -0.17), "dark", rot=(10, 0, 0), group="Magazine")
    k.box((0.032, 0.006, 0.07), (0, 0.101, -0.165), "accent", rot=(10, 0, 0), group="Magazine", bevel=0)
    k.iron_sights(rear_y=-0.05, rear_base_z=-0.018, front_y=0.55, front_base_z=-0.044)
    k.empty("SightMount", (0, 0.07, 0))
    k.empty("LaserMount", (0.035, 0.4, -0.09))
    k.empty("Muzzle", (0, 0.79, bore))
    k.empty("GripR", (0, -0.045, -0.15))
    k.empty("GripL", (0, 0.36, -0.11))


def build_revolver(k: Kit):
    """ガベル：大型のリボルバー。上に通気の付いた長い銃身、6 発のシリンダー（"Cylinder"。原点が回る軸）、撃鉄"""
    bore = -0.03
    # フレーム：シリンダーの後ろの塊、上の帯、前の受け（シリンダーが見えるように窓を開ける）
    k.box((0.03, 0.06, 0.05), (0, -0.03, -0.035), "body", bevel=0.003)
    k.box((0.024, 0.06, 0.008), (0, 0.025, -0.008), "body", bevel=0.002)
    k.box((0.024, 0.014, 0.05), (0, 0.055, -0.035), "body", bevel=0.002)
    k.box((0.016, 0.06, 0.012), (0, 0.025, -0.062), "body", bevel=0.002)
    k.cyl(0.011, 0.17, (0, 0.14, bore), "steel", verts=16)  # 銃身
    k.box((0.02, 0.17, 0.012), (0, 0.14, bore + 0.014), "paint", bevel=0.002)  # 上の通気
    for i in range(5):
        k.box((0.022, 0.006, 0.006), (0, 0.075 + i * 0.03, bore + 0.021), "dark", bevel=0)
    k.box((0.016, 0.15, 0.012), (0, 0.13, bore - 0.017), "body", bevel=0.002)  # 銃身の下
    k.box((0.002, 0.14, 0.004), (0.0105, 0.14, bore + 0.014), "accent", bevel=0)
    k.box((0.002, 0.14, 0.004), (-0.0105, 0.14, bore + 0.014), "accent", bevel=0)
    g = "Cylinder"
    k.cyl(0.021, 0.045, (0, 0.025, bore - 0.006), "steel", verts=18, group=g)
    for i in range(6):  # 外側の溝
        a = math.radians(i * 60)
        k.box((0.004, 0.034, 0.004), (math.cos(a) * 0.0205, 0.025, bore - 0.006 + math.sin(a) * 0.0205), "dark", rot=(0, -i * 60, 0), group=g, bevel=0)
    for i in range(6):
        a = math.radians(i * 60 + 30)
        k.cyl(0.0045, 0.047, (math.cos(a) * 0.012, 0.025, bore - 0.006 + math.sin(a) * 0.012), "dark", verts=8, group=g, bevel=0)
    k.cyl(0.0215, 0.005, (0, 0.046, bore - 0.006), "accent", verts=18, group=g, bevel=0)
    k.box((0.008, 0.02, 0.02), (0, -0.055, -0.012), "steel", rot=(-30, 0, 0))  # 撃鉄
    # 用心金・引き金
    k.box((0.02, 0.04, 0.004), (0, 0.01, -0.078), "dark", bevel=0.001)
    k.box((0.02, 0.004, 0.022), (0, 0.03, -0.068), "dark", bevel=0.001)
    k.box((0.004, 0.006, 0.016), (0, 0.003, -0.066), "steel", rot=(15, 0, 0), bevel=0)
    # 握り（丸みのある木の色の板と、金属の芯）
    k.box((0.028, 0.044, 0.1), (0, -0.05, -0.1), "dark", rot=(-22, 0, 0), bevel=0.006)
    for sx in (-1, 1):
        k.box((0.003, 0.034, 0.075), (sx * 0.0145, -0.052, -0.1), "paint", rot=(-22, 0, 0), bevel=0)
    # 照門・照星
    g2 = "IronSights"
    for sx in (-1, 1):
        k.box((0.006, 0.008, 0.008), (sx * 0.0065, -0.04, -0.004), "dark", group=g2, bevel=0.0006)
    k.box((0.004, 0.01, 0.012), (0, 0.215, -0.006), "dark", group=g2, bevel=0.0006)
    k.box((0.0026, 0.0012, 0.0026), (0, 0.21, -0.0015), "accent", group=g2, bevel=0)
    k.empty("SightMount", (0, 0.0, 0))
    k.empty("LaserMount", (0, 0.12, -0.052))
    k.empty("Muzzle", (0, 0.228, bore))
    k.empty("CylinderAxis", (0, 0.025, bore - 0.006))
    k.empty("GripR", (0, -0.05, -0.095))
    k.empty("GripL", (0, -0.03, -0.115))


BUILDERS = {
    "ar": build_ar,
    "lmg": build_lmg,
    "smg": build_smg,
    "shotgun": build_shotgun,
    "sniper": build_sniper,
    "pistol": build_pistol,
    "burst": build_burst,
    "psmg": build_psmg,
    "spinlmg": build_spinlmg,
    "autosg": build_autosg,
    "marksman": build_marksman,
    "revolver": build_revolver,
}


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def render_preview(path, weapon_id):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 48
    scene.cycles.device = "CPU"
    scene.render.resolution_x = 900
    scene.render.resolution_y = 420
    scene.render.film_transparent = False
    world = bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.03, 0.02, 0.06, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
    cam_data = bpy.data.cameras.new("Cam")
    cam_data.lens = 35
    cam = bpy.data.objects.new("Cam", cam_data)
    scene.collection.objects.link(cam)
    # 全部品が収まるよう、外接箱から位置を決める（右側面から少し斜めに見る）
    pts = [o.matrix_world @ Vector(c) for o in scene.objects if o.type == "MESH" for c in o.bound_box]
    lo_ = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi_ = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    center = (lo_ + hi_) / 2
    length = hi_.y - lo_.y
    cam.location = (center.x + length * 1.25, center.y - length * 0.25, center.z + length * 0.18)
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    for loc, energy in (((1.5, -1, 1.5), 300), ((-1.5, 1.2, 0.8), 150)):
        ld = bpy.data.lights.new("L", "AREA")
        ld.energy = energy
        ld.size = 1.5
        lo = bpy.data.objects.new("L", ld)
        lo.location = loc
        lo.rotation_euler = (Vector((0, 0.15, 0)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        scene.collection.objects.link(lo)
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def main():
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    save_blend = "--blend" in args
    preview = "--preview" in args
    only = [a for a in args if not a.startswith("--")]
    os.makedirs(OUT_DIR, exist_ok=True)
    for wid, build in BUILDERS.items():
        if only and wid not in only:
            continue
        reset_scene()
        k = Kit(wid)
        build(k)
        k.join_groups(f"weapon_{wid}")
        out = os.path.join(OUT_DIR, f"{wid}.glb")
        bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_yup=True, export_apply=True)
        print(f"書き出し: {out} ({os.path.getsize(out) // 1024} KB)")
        if save_blend:
            bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, f"{wid}.blend"))
        if preview:
            os.makedirs(os.path.join(HERE, "preview"), exist_ok=True)
            render_preview(os.path.join(HERE, "preview", f"{wid}.png"), wid)


if __name__ == "__main__":
    main()
