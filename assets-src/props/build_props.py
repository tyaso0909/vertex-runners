"""
射撃場の小物（人型の的、弾薬補給所、グレネード、自動砲台、弾薬パック、注射器、タイムアタックのドローン）を Blender で作り、glTF（.glb）で書き出すスクリプト。

使い方：
  blender --background --python assets-src/props/build_props.py
  または  python assets-src/props/build_props.py   （pip install bpy、Python 3.11）
オプション：--preview で assets-src/props/preview/ に確認用画像、--blend で .blend も保存

的の大きさは shared/targets.ts の当たり判定に合わせてある
  体：幅 0.62m × 高さ 1.3m × 厚み 0.34m（中心は足元から 0.78m）
  頭：半径 0.18m の球（中心は足元から 1.6m）
原点は足元。正面は Blender の -Y（glTF / three.js では +Z）。
"""

import math
import os
import sys

import bpy
from mathutils import Euler, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT_DIR = os.path.join(ROOT, "client", "assets", "props")


def srgb_to_linear(c):
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)


def mat(name, color, metallic=0.0, roughness=0.5, emission=None, strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*srgb_to_linear(color), 1)
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = roughness
    if emission:
        b.inputs["Emission Color"].default_value = (*srgb_to_linear(emission), 1)
        b.inputs["Emission Strength"].default_value = strength
    return m


class Builder:
    def __init__(self):
        self.groups = {}

    def add(self, obj, group, material, bevel=0.0):
        obj.data.materials.append(material)
        if bevel > 0:
            mod = obj.modifiers.new("Bevel", "BEVEL")
            mod.width = bevel
            mod.segments = 2
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.modifier_apply(modifier=mod.name)
        self.groups.setdefault(group, []).append(obj)
        return obj

    def box(self, size, loc, group, material, rot=(0, 0, 0), bevel=0.01):
        bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=Euler([math.radians(r) for r in rot]))
        o = bpy.context.active_object
        o.scale = size
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        return self.add(o, group, material, min(bevel, min(size) * 0.3))

    def cyl(self, r, depth, loc, group, material, rot=(0, 0, 0), verts=24, bevel=0.0):
        bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth, location=loc, rotation=Euler([math.radians(a) for a in rot]))
        return self.add(bpy.context.active_object, group, material, bevel)

    def sphere(self, r, loc, group, material, subdiv=2):
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdiv, radius=r, location=loc)
        o = bpy.context.active_object
        return self.add(o, group, material)

    def finish(self, root_name, pivots=None):
        """グループごとに1つのメッシュにまとめる。pivots で各グループの原点（回転の中心）を指定できる"""
        root = bpy.data.objects.new(root_name, None)
        bpy.context.collection.objects.link(root)
        for g, objs in self.groups.items():
            bpy.ops.object.select_all(action="DESELECT")
            for o in objs:
                o.select_set(True)
            bpy.context.view_layer.objects.active = objs[0]
            if len(objs) > 1:
                bpy.ops.object.join()
            o = bpy.context.active_object
            o.name = g
            o.data.name = g
            if pivots and g in pivots:
                bpy.context.scene.cursor.location = pivots[g]
                bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
            o.parent = root
        bpy.context.scene.cursor.location = (0, 0, 0)
        return root


def build_target():
    """人型の的。土台（Base）と、倒れる本体（Dummy）に分ける。Dummy は足首の位置を軸に後ろへ倒れる"""
    b = Builder()
    shell = mat("Shell", (0.2, 0.21, 0.26), metallic=0.4, roughness=0.45)
    plate = mat("Plate", (0.42, 0.44, 0.5), metallic=0.6, roughness=0.35)
    dark = mat("Dark", (0.06, 0.06, 0.08), roughness=0.8)
    glow = mat("Glow", (1.0, 0.31, 0.48), emission=(1.0, 0.31, 0.48), strength=1.6)
    head_glow = mat("HeadGlow", (1.0, 0.75, 0.3), emission=(1.0, 0.75, 0.3), strength=1.8)

    # 土台：丸い台座と支柱
    b.cyl(0.42, 0.06, (0, 0, 0.03), "Base", dark, bevel=0.01)
    b.cyl(0.36, 0.012, (0, 0, 0.066), "Base", glow, bevel=0)
    b.cyl(0.05, 0.1, (0, 0, 0.11), "Base", plate)

    # 本体（当たり判定：幅0.62×厚み0.34×高さ1.3、中心0.78）
    D = "Dummy"
    b.box((0.18, 0.2, 0.46), (-0.12, 0, 0.36), D, shell, bevel=0.03)  # 左脚
    b.box((0.18, 0.2, 0.46), (0.12, 0, 0.36), D, shell, bevel=0.03)  # 右脚
    b.box((0.44, 0.26, 0.2), (0, 0, 0.66), D, shell, bevel=0.04)  # 腰
    b.box((0.54, 0.3, 0.52), (0, 0, 1.0), D, shell, bevel=0.05)  # 胴
    b.box((0.4, 0.04, 0.34), (0, -0.155, 1.02), D, plate, bevel=0.015)  # 胸の装甲板
    b.box((0.3, 0.012, 0.02), (0, -0.178, 1.12), D, glow, bevel=0)  # 胸の光る線
    b.box((0.3, 0.012, 0.02), (0, -0.178, 0.92), D, glow, bevel=0)
    b.cyl(0.07, 0.012, (0, -0.178, 1.02), D, glow, rot=(90, 0, 0), bevel=0)  # 胸の的の中心
    for s in (-1, 1):
        b.box((0.09, 0.14, 0.5), (s * 0.31 * 0.86, 0, 0.98), D, shell, rot=(0, s * 6, 0), bevel=0.03)  # 腕
        b.box((0.12, 0.2, 0.12), (s * 0.27, 0, 1.25), D, plate, bevel=0.03)  # 肩
    b.box((0.12, 0.12, 0.2), (0, 0, 1.38), D, dark, bevel=0.02)  # 首
    # 頭（半径0.18、中心1.6）
    b.sphere(0.17, (0, 0, 1.6), D, shell, subdiv=2)
    b.box((0.24, 0.04, 0.06), (0, -0.15, 1.62), D, head_glow, bevel=0.01)  # 目の位置の光る帯
    return b.finish("target", pivots={"Dummy": (0, 0.0, 0.14)})


def build_ammo_station():
    """弾薬補給所。原点は床の中心"""
    b = Builder()
    case = mat("Case", (0.17, 0.18, 0.2), metallic=0.5, roughness=0.4)
    olive = mat("Olive", (0.24, 0.27, 0.18), metallic=0.2, roughness=0.6)
    glow = mat("Glow", (1.0, 0.71, 0.36), emission=(1.0, 0.71, 0.36), strength=2.0)
    b.box((1.2, 0.7, 0.55), (0, 0, 0.275), "Crate", olive, bevel=0.03)
    b.box((1.24, 0.74, 0.08), (0, 0, 0.59), "Crate", case, bevel=0.02)  # ふた
    for x in (-0.45, 0.45):
        b.box((0.08, 0.76, 0.56), (x, 0, 0.28), "Crate", case, bevel=0.015)
    b.box((0.7, 0.01, 0.05), (0, -0.356, 0.36), "Crate", glow, bevel=0)
    b.box((0.7, 0.01, 0.05), (0, 0.356, 0.36), "Crate", glow, bevel=0)
    # ふたの上の弾倉
    for i, x in enumerate((-0.3, -0.1, 0.1, 0.3)):
        b.box((0.06, 0.12, 0.18), (x, 0.0, 0.72), "Crate", case, rot=(0, 0, 8 * (i - 1.5)), bevel=0.01)
        b.box((0.062, 0.02, 0.12), (x, -0.055, 0.72), "Crate", glow, rot=(0, 0, 8 * (i - 1.5)), bevel=0)
    return b.finish("ammo_station")


def build_grenade():
    """破片手榴弾。原点は中心、半径はおよそ 0.045m（当たり判定 GRENADE_SIZE=0.08 より少し小さく見せる）"""
    b = Builder()
    shell = mat("GrenadeShell", (0.2, 0.22, 0.2), metallic=0.5, roughness=0.45)
    band = mat("GrenadeBand", (0.06, 0.06, 0.07), metallic=0.3, roughness=0.6)
    steel = mat("GrenadeSteel", (0.55, 0.57, 0.6), metallic=0.9, roughness=0.3)
    glow = mat("GrenadeGlow", (1.0, 0.3, 0.45), emission=(1.0, 0.3, 0.45), strength=1.4)
    b.sphere(0.042, (0, 0, 0), "Grenade", shell, subdiv=3)
    b.cyl(0.0435, 0.016, (0, 0, 0), "Grenade", band, verts=24)  # 胴の帯
    b.cyl(0.0445, 0.005, (0, 0, 0), "Grenade", glow, verts=24)  # 光る線
    b.cyl(0.018, 0.022, (0, 0, 0.046), "Grenade", steel, verts=16)  # 信管
    b.box((0.012, 0.05, 0.008), (0, -0.018, 0.058), "Grenade", steel, bevel=0.002)  # レバー
    bpy.ops.mesh.primitive_torus_add(major_radius=0.012, minor_radius=0.0018, location=(0.02, 0, 0.06), rotation=(0, math.radians(90), 0))
    b.add(bpy.context.active_object, "Pin", steel)  # ピンの輪（構えると抜ける）
    return b.finish("grenade")


def build_turret():
    """自動砲台。当たり判定（shared/targets.ts）：胴 0.7×1.5×0.7（中心 0.75）、頭 半径 0.24（中心 1.32）。
    土台（TurretBase）は動かない。頭（TurretHead）は原点 (0, 0, 1.25) を中心に左右・上下に回る。正面は -Y"""
    b = Builder()
    dark = mat("TDark", (0.07, 0.07, 0.09), metallic=0.5, roughness=0.5)
    shell = mat("TShell", (0.5, 0.5, 0.54), metallic=0.55, roughness=0.38)
    stripe = mat("TStripe", (1.0, 0.55, 0.12), roughness=0.5, emission=(1.0, 0.5, 0.1), strength=2.0)
    red = mat("TRed", (1.0, 0.12, 0.18), emission=(1.0, 0.12, 0.18), strength=4.0)
    B = "TurretBase"
    # 三脚と台座
    for k in range(3):
        a = math.radians(k * 120 + 90)
        x, y = math.cos(a) * 0.32, math.sin(a) * 0.32
        b.box((0.07, 0.42, 0.05), (x * 0.55, y * 0.55, 0.16), B, dark, rot=(0, 0, math.degrees(a) - 90), bevel=0.01)
        b.box((0.11, 0.11, 0.05), (x * 1.1, y * 1.1, 0.025), B, shell, bevel=0.01)
        b.box((0.05, 0.05, 0.36), (x * 0.95, y * 0.95, 0.2), B, dark, rot=(math.sin(a) * 25, -math.cos(a) * 25, 0), bevel=0.01)
    b.cyl(0.2, 0.18, (0, 0, 0.36), B, shell, verts=10, bevel=0.015)
    b.cyl(0.21, 0.03, (0, 0, 0.43), B, stripe, verts=10)
    b.cyl(0.08, 0.6, (0, 0, 0.75), B, dark, verts=12)  # 柱
    b.cyl(0.14, 0.12, (0, 0, 1.04), B, shell, verts=12, bevel=0.01)  # 回転台
    H = "TurretHead"
    # 頭：丸いセンサーの塊と、左右の装甲、前に伸びる銃身2本
    b.sphere(0.22, (0, 0, 1.3), H, shell, subdiv=2)
    for s in (-1, 1):
        b.box((0.08, 0.36, 0.26), (s * 0.22, 0.0, 1.28), H, dark, bevel=0.025)
        b.box((0.085, 0.2, 0.03), (s * 0.22, -0.05, 1.36), H, stripe, bevel=0.005)
        b.cyl(0.022, 0.42, (s * 0.07, -0.36, 1.24), H, dark, rot=(90, 0, 0), verts=10)  # 銃身
        b.cyl(0.032, 0.07, (s * 0.07, -0.55, 1.24), H, shell, rot=(90, 0, 0), verts=8)  # 消炎器
    b.cyl(0.075, 0.03, (0, -0.205, 1.34), H, dark, rot=(90, 0, 0), verts=16)  # 目のふち
    b.cyl(0.05, 0.03, (0, -0.215, 1.34), H, red, rot=(90, 0, 0), verts=16)  # 赤く光る目
    b.box((0.18, 0.02, 0.012), (0, -0.2, 1.42), H, red, bevel=0)
    root = b.finish("turret", pivots={H: (0, 0, 1.25)})
    m = bpy.data.objects.new("Muzzle", None)
    m.location = (0, -0.59, 1.24)
    bpy.context.collection.objects.link(m)
    return root


def build_drone():
    """タイムアタックの浮いているドローン。当たり判定（shared/targets.ts）：機体 0.9×0.32×0.9（中心が原点）、
    核（頭）半径 0.24。4つのプロペラ（Rotor0〜3）はそれぞれの中心で回す。原点は機体の中心"""
    b = Builder()
    shell = mat("DShell", (0.16, 0.17, 0.21), metallic=0.6, roughness=0.35)
    plate = mat("DPlate", (0.55, 0.57, 0.63), metallic=0.7, roughness=0.3)
    dark = mat("DDark", (0.05, 0.05, 0.07), roughness=0.7)
    core = mat("DCore", (1.0, 0.25, 0.45), emission=(1.0, 0.25, 0.45), strength=5.0)
    ring = mat("DRing", (0.3, 0.85, 1.0), emission=(0.3, 0.85, 1.0), strength=3.0)
    B = "DroneBody"
    # 胴（平たい八角形）と上下のふた
    b.cyl(0.26, 0.16, (0, 0, 0), B, shell, verts=8, bevel=0.02)
    b.cyl(0.2, 0.05, (0, 0, 0.1), B, plate, verts=8, bevel=0.01)
    b.cyl(0.18, 0.05, (0, 0, -0.1), B, plate, verts=8, bevel=0.01)
    # 核（光る目）。正面（-Y）に大きく、上下からも見える
    b.sphere(0.13, (0, -0.2, 0), B, core, subdiv=2)
    b.cyl(0.15, 0.03, (0, -0.215, 0), B, dark, rot=(90, 0, 0), verts=16)
    b.cyl(0.1, 0.02, (0, 0, 0.13), B, core, verts=12)
    # 胴の周りの光る輪
    bpy.ops.mesh.primitive_torus_add(major_radius=0.29, minor_radius=0.012, location=(0, 0, 0))
    b.add(bpy.context.active_object, B, ring)
    pivots = {}
    for k in range(4):
        a = math.radians(45 + k * 90)
        x, y = math.cos(a) * 0.36, math.sin(a) * 0.36
        b.box((0.3, 0.05, 0.035), (x * 0.55, y * 0.55, 0.02), B, dark, rot=(0, 0, math.degrees(a)), bevel=0.008)
        b.cyl(0.05, 0.08, (x, y, 0.03), B, shell, verts=10)  # モーター
        # プロペラの保護枠
        bpy.ops.mesh.primitive_torus_add(major_radius=0.12, minor_radius=0.01, location=(x, y, 0.07))
        b.add(bpy.context.active_object, B, ring if k % 2 == 0 else plate)
        R = f"Rotor{k}"
        b.box((0.22, 0.025, 0.008), (x, y, 0.09), R, plate, bevel=0)
        b.box((0.025, 0.22, 0.008), (x, y, 0.09), R, plate, bevel=0)
        pivots[R] = (x, y, 0.09)
    # 下のセンサーとアンテナ
    b.cyl(0.04, 0.08, (0, 0, -0.15), B, dark, verts=8)
    b.cyl(0.006, 0.12, (0.08, 0.08, 0.17), B, dark, verts=6)
    return b.finish("drone", pivots=pivots)


def build_ammo_drop():
    """ソラのパッシブで敵が落とす弾薬パック。原点は底の中心"""
    b = Builder()
    case = mat("DropCase", (0.16, 0.16, 0.18), metallic=0.5, roughness=0.4)
    yellow = mat("DropYellow", (1.0, 0.82, 0.12), roughness=0.5)
    glow = mat("DropGlow", (0.31, 0.89, 1.0), emission=(0.31, 0.89, 1.0), strength=3.0)
    b.box((0.32, 0.22, 0.14), (0, 0, 0.07), "Drop", case, bevel=0.02)
    b.box((0.33, 0.06, 0.145), (0, 0, 0.072), "Drop", yellow, bevel=0.01)
    b.box((0.2, 0.01, 0.03), (0, -0.112, 0.08), "Drop", glow, bevel=0)
    b.box((0.2, 0.01, 0.03), (0, 0.112, 0.08), "Drop", glow, bevel=0)
    b.box((0.12, 0.04, 0.02), (0, 0, 0.15), "Drop", case, bevel=0.006)  # 取っ手
    return b.finish("ammo_drop")


def build_syringe():
    """アレックスの注射器。原点は握る位置、針は +Y（three.js では -Z）"""
    b = Builder()
    steel = mat("SyrSteel", (0.6, 0.62, 0.66), metallic=0.9, roughness=0.3)
    dark = mat("SyrDark", (0.08, 0.08, 0.1), roughness=0.6)
    fluid = mat("SyrFluid", (0.31, 0.55, 1.0), emission=(0.31, 0.55, 1.0), strength=3.0)
    b.cyl(0.016, 0.1, (0, 0.03, 0), "Syringe", fluid, rot=(90, 0, 0), verts=12)
    b.cyl(0.018, 0.012, (0, -0.025, 0), "Syringe", dark, rot=(90, 0, 0), verts=12)
    b.cyl(0.018, 0.012, (0, 0.085, 0), "Syringe", dark, rot=(90, 0, 0), verts=12)
    b.cyl(0.005, 0.05, (0, -0.055, 0), "Syringe", steel, rot=(90, 0, 0), verts=8)  # 押し棒
    b.cyl(0.014, 0.006, (0, -0.082, 0), "Syringe", dark, rot=(90, 0, 0), verts=12)
    b.cyl(0.0015, 0.04, (0, 0.11, 0), "Syringe", steel, rot=(90, 0, 0), verts=6)  # 針
    return b.finish("syringe")


def render_preview(path):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 48
    scene.render.resolution_x = 600
    scene.render.resolution_y = 600
    world = bpy.data.worlds.new("W")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.03, 0.02, 0.06, 1)
    pts = [o.matrix_world @ Vector(c) for o in scene.objects if o.type == "MESH" for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    center = (lo + hi) / 2
    size = max(hi - lo)
    cd = bpy.data.cameras.new("C")
    cd.lens = 35
    cam = bpy.data.objects.new("C", cd)
    scene.collection.objects.link(cam)
    cam.location = center + Vector((size * 0.9, -size * 1.4, size * 0.4))
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    for loc, e in (((2, -2, 3), 500), ((-2, -1, 1), 200)):
        ld = bpy.data.lights.new("L", "AREA")
        ld.energy = e
        ld.size = 2
        lo_ = bpy.data.objects.new("L", ld)
        lo_.location = loc
        lo_.rotation_euler = (center - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        scene.collection.objects.link(lo_)
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def build_tick():
    """ブーストのティック（クモ型の小さな地雷）。幅 0.45m・高さ 0.16m。正面は Blender の +Y（three.js では -Z。ゲームの向き yaw=0 と同じ）。
    TickBody（胴と赤い目）、TickLeg0〜5（付け根が原点。ゲーム側で振って歩かせる）"""
    b = Builder()
    shell = mat("TkShell", (0.16, 0.17, 0.19), metallic=0.7, roughness=0.35)
    plate = mat("TkPlate", (0.42, 0.44, 0.47), metallic=0.75, roughness=0.3)
    dark = mat("TkDark", (0.05, 0.05, 0.06), roughness=0.7)
    red = mat("TkRed", (1.0, 0.16, 0.12), emission=(1.0, 0.16, 0.12), strength=6.0)
    B = "TickBody"
    bpy.ops.mesh.primitive_uv_sphere_add(segments=20, ring_count=10, radius=1, location=(0, 0, 0.11))
    o = bpy.context.active_object
    o.scale = (0.13, 0.16, 0.075)
    bpy.ops.object.transform_apply(scale=True)
    o.data.polygons.foreach_set("use_smooth", [True] * len(o.data.polygons))
    b.add(o, B, shell)
    b.box((0.17, 0.2, 0.035), (0, -0.01, 0.17), B, plate, bevel=0.012)  # 背中の装甲
    b.box((0.05, 0.12, 0.02), (0, -0.02, 0.192), B, dark, bevel=0.004)
    b.cyl(0.035, 0.03, (0, 0.145, 0.12), B, dark, rot=(90, 0, 0), verts=12)  # 目の縁
    b.sphere(0.026, (0, 0.158, 0.12), B, red, subdiv=2)  # 赤い目
    for s_ in (-1, 1):
        b.box((0.012, 0.09, 0.012), (s_ * 0.105, 0.0, 0.135), B, red, bevel=0)  # 横の灯り
    b.cyl(0.05, 0.03, (0, 0, 0.04), B, dark, verts=12)  # 腹
    pivots = {}
    for k in range(6):
        side = -1 if k < 3 else 1
        row = k % 3  # 前・中・後
        y = 0.07 - row * 0.07
        L = f"TickLeg{k}"
        hx = side * 0.1
        # 上の節：外へ斜め上、下の節：地面へ
        b.box((0.11, 0.022, 0.022), (hx + side * 0.05, y, 0.15), L, plate, rot=(0, side * -30, 0), bevel=0.005)
        b.box((0.02, 0.02, 0.15), (hx + side * 0.115, y, 0.09), L, dark, rot=(0, side * -12, 0), bevel=0.004)
        b.sphere(0.014, (hx + side * 0.13, y, 0.018), L, plate, subdiv=1)
        pivots[L] = (hx, y, 0.13)
    return b.finish("tick", pivots=pivots)


def star_prism(name, points, r_out, r_in, thick, rot_offset=0.0):
    """平たい星形（XZ 平面。厚みは Y 方向）。points 本の角。rot_offset で回す（0 なら角の 1 つが -Z を向く）"""
    verts = []
    n = points * 2
    for k in range(n):
        a = rot_offset - math.pi / 2 + k * math.pi / points
        r = r_out if k % 2 == 0 else r_in
        x, z = math.cos(a) * r, math.sin(a) * r
        verts.append((x, -thick / 2, z))
        verts.append((x, thick / 2, z))
    faces = []
    for k in range(n):
        a0, a1 = k * 2, ((k + 1) % n) * 2
        faces.append((a0, a1, a1 + 1, a0 + 1))
    faces.append(tuple(k * 2 for k in range(n))[::-1])
    faces.append(tuple(k * 2 + 1 for k in range(n)))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    o = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(o)
    bpy.context.view_layer.objects.active = o
    return o


def build_ordnance():
    """グレネードの種類（フラグ以外の 5 つ）を 1 つのファイルに。どれも原点はグレネードの中心。
    刺さる種類（ファイアスター・グラビティスター・サッチェル）は、Blender の +Z（three.js の +Y）を刺さった面の外向きにそろえる。
    光る部品のマテリアル名（ArcGlow・FireGlow・GravGlow・SmokeGlow・SatchelLed）はゲーム側で点滅させる。
    ピン（ArcPin・SmokePin）は構えると抜ける"""
    steel = mat("OrdSteel", (0.55, 0.57, 0.6), metallic=0.9, roughness=0.3)
    dark = mat("OrdDark", (0.07, 0.07, 0.08), metallic=0.4, roughness=0.55)

    # --- アーク：黒い筒に青白い輪。上に信管とピン ---
    b = Builder()
    shell = mat("ArcShell", (0.12, 0.14, 0.17), metallic=0.6, roughness=0.35)
    glow = mat("ArcGlow", (0.35, 0.85, 1.0), emission=(0.35, 0.85, 1.0), strength=6.0)
    b.cyl(0.031, 0.1, (0, 0, 0), "ArcBody", shell, verts=20, bevel=0.004)
    for z in (-0.028, 0.0, 0.028):
        b.cyl(0.0325, 0.006, (0, 0, z), "ArcBody", glow, verts=20)
    b.cyl(0.024, 0.012, (0, 0, -0.054), "ArcBody", dark, verts=16)
    b.cyl(0.016, 0.02, (0, 0, 0.058), "ArcBody", steel, verts=14)
    b.box((0.01, 0.042, 0.007), (0, -0.016, 0.07), "ArcBody", steel, bevel=0.002)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.011, minor_radius=0.0017, location=(0.018, 0, 0.072), rotation=(0, math.radians(90), 0))
    b.add(bpy.context.active_object, "ArcPin", steel)
    b.finish("ArcGrenade")

    # --- ファイアスター：4 枚刃の手裏剣。真ん中に橙に光る芯 ---
    b = Builder()
    blade = mat("FireBlade", (0.32, 0.3, 0.3), metallic=0.85, roughness=0.28)
    fglow = mat("FireGlow", (1.0, 0.45, 0.12), emission=(1.0, 0.42, 0.1), strength=7.0)
    o = star_prism("FirestarBlade", 4, 0.085, 0.024, 0.008)
    b.add(o, "FirestarBody", blade, bevel=0.0015)
    o = star_prism("FirestarIn", 4, 0.05, 0.02, 0.011, rot_offset=math.pi / 4)
    b.add(o, "FirestarBody", dark)
    b.cyl(0.02, 0.016, (0, 0, 0), "FirestarBody", fglow, rot=(90, 0, 0), verts=16)
    b.cyl(0.026, 0.012, (0, 0, 0), "FirestarBody", dark, rot=(90, 0, 0), verts=16)
    b.finish("Firestar")

    # --- グラビティスター：3 枚刃。真ん中に紫に光る大きな球 ---
    b = Builder()
    gblade = mat("GravBlade", (0.18, 0.16, 0.24), metallic=0.8, roughness=0.3)
    gglow = mat("GravGlow", (0.72, 0.4, 1.0), emission=(0.7, 0.38, 1.0), strength=7.0)
    o = star_prism("GravityBlade", 3, 0.08, 0.03, 0.01)
    b.add(o, "GravityBody", gblade, bevel=0.002)
    b.cyl(0.03, 0.018, (0, 0, 0), "GravityBody", dark, rot=(90, 0, 0), verts=20)
    b.sphere(0.021, (0, 0, 0), "GravityBody", gglow, subdiv=2)
    for k in range(3):
        a = -math.pi / 2 + k * 2 * math.pi / 3
        b.box((0.006, 0.013, 0.03), (math.cos(a) * 0.045, 0, math.sin(a) * 0.045), "GravityBody", gglow, rot=(0, -math.degrees(a) + 90, 0), bevel=0)
    b.finish("GravityStar")

    # --- スモーク：灰緑の缶。上に弁とピン、薄く光る帯 ---
    b = Builder()
    can = mat("SmokeCan", (0.34, 0.38, 0.33), metallic=0.45, roughness=0.5)
    sglow = mat("SmokeGlow", (0.75, 1.0, 0.75), emission=(0.7, 1.0, 0.7), strength=3.0)
    b.cyl(0.033, 0.12, (0, 0, 0), "SmokeBody", can, verts=22, bevel=0.005)
    b.cyl(0.0335, 0.012, (0, 0, 0.03), "SmokeBody", sglow, verts=22)
    b.cyl(0.034, 0.006, (0, 0, -0.045), "SmokeBody", dark, verts=22)
    for k in range(6):
        a = k * math.pi / 3
        b.cyl(0.004, 0.004, (math.cos(a) * 0.022, math.sin(a) * 0.022, 0.061), "SmokeBody", dark, verts=8)
    b.cyl(0.014, 0.016, (0, 0, 0.066), "SmokeBody", steel, verts=14)
    b.box((0.01, 0.05, 0.007), (0, -0.02, 0.076), "SmokeBody", steel, bevel=0.002)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.011, minor_radius=0.0017, location=(0.018, 0, 0.078), rotation=(0, math.radians(90), 0))
    b.add(bpy.context.active_object, "SmokePin", steel)
    b.finish("SmokeGrenade")

    # --- サッチェル：平たい袋。帯と留め具、赤く点滅する灯りと短いアンテナ ---
    b = Builder()
    pouch = mat("SatchelPouch", (0.22, 0.2, 0.15), roughness=0.85)
    strap = mat("SatchelStrap", (0.08, 0.08, 0.07), roughness=0.8)
    led = mat("SatchelLed", (1.0, 0.12, 0.1), emission=(1.0, 0.12, 0.1), strength=8.0)
    z0 = -0.02
    b.box((0.17, 0.11, 0.055), (0, 0, z0), "SatchelBody", pouch, bevel=0.012)
    for x in (-0.05, 0.05):
        b.box((0.022, 0.116, 0.06), (x, 0, z0), "SatchelBody", strap, bevel=0.004)
        b.box((0.026, 0.014, 0.008), (x, -0.03, z0 + 0.03), "SatchelBody", steel, bevel=0.002)
    b.box((0.06, 0.045, 0.016), (0, 0.012, z0 + 0.034), "SatchelBody", dark, bevel=0.004)
    b.sphere(0.006, (0.018, 0.012, z0 + 0.044), "SatchelBody", led, subdiv=2)
    b.cyl(0.0022, 0.05, (-0.02, 0.025, z0 + 0.065), "SatchelBody", steel, verts=8)
    b.sphere(0.004, (-0.02, 0.025, z0 + 0.09), "SatchelBody", dark, subdiv=1)
    b.finish("Satchel")


def main():
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    os.makedirs(OUT_DIR, exist_ok=True)
    builds = (
        ("target", build_target),
        ("ammo_station", build_ammo_station),
        ("grenade", build_grenade),
        ("turret", build_turret),
        ("ammo_drop", build_ammo_drop),
        ("syringe", build_syringe),
        ("drone", build_drone),
        ("tick", build_tick),
        ("ordnance", build_ordnance),
    )
    only = [a for a in args if not a.startswith("--")]
    for name, build in builds:
        if only and name not in only:
            continue
        bpy.ops.wm.read_factory_settings(use_empty=True)
        build()
        out = os.path.join(OUT_DIR, f"{name}.glb")
        bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_yup=True, export_apply=True)
        print(f"書き出し: {out} ({os.path.getsize(out) // 1024} KB)")
        if "--blend" in args:
            bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, f"{name}.blend"))
        if "--preview" in args:
            os.makedirs(os.path.join(HERE, "preview"), exist_ok=True)
            if name == "ordnance":
                # 確認用の画像では横に並べる（書き出した後なので、ファイルには影響しない）
                roots = [o for o in bpy.data.objects if o.parent is None and o.type == "EMPTY"]
                for i, o in enumerate(roots):
                    o.location.x = i * 0.22
                    o.rotation_euler = (math.radians(-20), 0, math.radians(25))
                bpy.context.view_layer.update()
            render_preview(os.path.join(HERE, "preview", f"{name}.png"))


if __name__ == "__main__":
    main()
