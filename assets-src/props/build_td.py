"""
タワーディフェンスのモデル（タレット4種・コア・敵のドローン・大型兵器・購入メニューの設置物・タレットの強化パーツ）を
Blender で作り、glTF（.glb）で書き出すスクリプト。

使い方：
  python assets-src/props/build_td.py              すべて
  python assets-src/props/build_td.py boss core    名前を指定
  --preview  assets-src/props/preview/td_<名前>.png に確認用の画像を描く

書き出すもの：client/assets/props/td_<名前>.glb
  原点は足元（ドローンだけ胴の中心）。正面は Blender の +Y（glTF / three.js では -Z。ゲームの向き yaw=0 と同じ）。
  当たり判定（shared/td/units.ts）の形に合わせてある。
  動かす部品は名前で探す（ゲーム側 client/td/tdViews.ts）：
    タレット：TurretHead（左右に回る。原点が回転の中心）、TurretGun（上下に向く）、Spin（回る飾り）、Muzzle（砲口の空の点）
    コア：CoreEnergy（光る柱。色を変える）、CoreRing0〜2（回る輪）
    ドローン：Rotor0〜3（回る）、DroneEye（光る目）
    大型兵器：BossHip・BossTorso・BossThigh/Shin/Foot.L/R・BossGun・BossReactor・BossEye・BossPodL/R
    ダミーバルーン：DecoyBase（空気入れの台）、DecoyBody（ふくらむ人形。原点は足元。ふくらむ・揺れる）
    ワイヤートラップの機雷（1つ分）：PodBody、PodLeg0〜2（付け根が原点。開く）、PodHead（伸びる。Emitter がレーザーの出る所）
    バリケード：BarBase、BarPost.L/R、BarPanel0〜2（下が原点。地面からせり上がる）
    ジャンプパッド：PadBase、PadPlate（跳ねる板）、PadRing（光る輪）
    強化パーツ：Up2（レベル 2 の装甲板）、Up3（レベル 3 の柱と灯り）。タレットの台に重ねる
    降下ポッド：PodBody、PodDoor0〜3（下の外側の縁が原点。外へ倒れて開く）、PodHot（底の焼けた縁）、PodBeacon、PodJet0〜3（噴射口）
    迫撃砲：MortarBase（底板・二脚・照準器・弾薬箱。据えた形）、MortarTube（砲身。原点は底の受け口。撃つと砲身の向きに沈む）、
      Muzzle（砲口の空の点）、MortarCarry（背負った形：砲身・たたんだ二脚・小さな底板。原点は背中に当てる所）、
      MortarShell（砲弾。原点は真ん中、頭が +Y）。背負った形・砲弾は横に離して置いてあるので、ゲーム側で取り出して位置を 0 に戻す
"""

import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_props as bp  # noqa: E402
from build_props import Builder, mat  # noqa: E402

OUT_DIR = bp.OUT_DIR


def hexc(h):
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) / 255 for i in (0, 2, 4))


def M(name, color, metallic=0.0, roughness=0.5, emission=None, strength=0.0):
    return mat(name, hexc(color), metallic, roughness, hexc(emission) if emission else None, strength)


def empty(name, loc, parent=None):
    """空の点（砲口など）。parent の部品といっしょに動く"""
    o = bpy.data.objects.new(name, None)
    o.location = loc
    bpy.context.collection.objects.link(o)
    if parent:
        p = bpy.data.objects[parent]
        bpy.context.view_layer.update()
        o.parent = p
        o.matrix_parent_inverse = p.matrix_world.inverted()
    return o


def smooth_spheres():
    """球（ico）をなめらかに見せる（面の数がそこそこある形だけ）"""
    _orig = Builder.sphere

    def sphere(self, r, loc, group, material, subdiv=2):
        o = _orig(self, r, loc, group, material, subdiv)
        o.data.polygons.foreach_set("use_smooth", [True] * len(o.data.polygons))
        return o

    Builder.sphere = sphere


smooth_spheres()


# ---------------------------------------------------------------------------
# タレット（味方：灰色の鋼と、青い灯り）
# 当たり判定：台 1.5×1.04×1.5（中心 0.5）、砲塔 1.2×0.72×1.4（中心 1.32）。減速・修理は柱 1.36×1.64×1.36＋球（1.85）
# ---------------------------------------------------------------------------


def turret_mats():
    return dict(
        steel=M("TSteel", "#7d838b", 0.7, 0.4),
        dark=M("TDark", "#2a2d33", 0.6, 0.5),
        plate=M("TPlate", "#a3a8ae", 0.6, 0.35),
        hazard=M("THazard", "#d6a52a", 0.0, 0.6),
        glow=M("TGlow", "#4fd1ff", 0, 0.5, "#4fd1ff", 4.0),
        base=M("TBase", "#6a6a66", 0.1, 0.8),
    )


def turret_base(b, m):
    B = "TurretBase"
    b.box((1.5, 1.5, 0.22), (0, 0, 0.11), B, m["base"], bevel=0.04)
    b.box((1.3, 1.3, 0.62), (0, 0, 0.53), B, m["steel"], bevel=0.05)
    for s in (-1, 1):
        b.box((1.32, 0.04, 0.08), (0, s * 0.62, 0.62), B, m["hazard"], bevel=0.005)
        b.box((0.04, 1.32, 0.08), (s * 0.62, 0, 0.62), B, m["hazard"], bevel=0.005)
    for sx in (-1, 1):
        for sy in (-1, 1):
            b.box((0.18, 0.18, 0.3), (sx * 0.62, sy * 0.62, 0.24), B, m["dark"], bevel=0.02)  # 足の金具
    b.cyl(0.42, 0.12, (0, 0, 0.9), B, m["dark"], verts=16, bevel=0.01)
    b.cyl(0.44, 0.025, (0, 0, 0.84), B, m["glow"], verts=16)


def build_mg():
    b = Builder()
    m = turret_mats()
    turret_base(b, m)
    H = "TurretHead"
    b.box((1.1, 1.1, 0.5), (0, -0.05, 1.22), H, m["plate"], bevel=0.06)
    b.box((1.0, 0.5, 0.25), (0, -0.4, 1.5), H, m["steel"], rot=(18, 0, 0), bevel=0.03)
    b.box((0.7, 0.02, 0.06), (0, 0.5, 1.3), H, m["glow"], bevel=0)
    for s in (-1, 1):
        b.box((0.18, 0.9, 0.42), (s * 0.58, 0.0, 1.25), H, m["dark"], bevel=0.03)  # 弾倉
        b.box((0.02, 0.5, 0.04), (s * 0.68, 0.0, 1.32), H, m["glow"], bevel=0)
    b.cyl(0.12, 0.08, (0, 0.45, 1.58), H, m["dark"], verts=12)  # センサー
    b.cyl(0.06, 0.02, (0, 0.5, 1.6), H, m["glow"], rot=(90, 0, 0), verts=12)
    G = "TurretGun"
    for s in (-1, 1):
        b.cyl(0.085, 0.5, (s * 0.2, 0.55, 1.33), G, m["dark"], rot=(90, 0, 0), verts=10)
        b.cyl(0.04, 0.75, (s * 0.2, 1.1, 1.33), G, m["steel"], rot=(90, 0, 0), verts=8)  # 銃身
        b.cyl(0.06, 0.12, (s * 0.2, 1.45, 1.33), G, m["dark"], rot=(90, 0, 0), verts=8)  # 消炎器
    root = b.finish("td_mg", pivots={H: (0, 0, 1.0), G: (0, 0.45, 1.33)})
    empty("Muzzle", (0, 1.52, 1.33), "TurretGun")
    return root


def build_rocket():
    b = Builder()
    m = turret_mats()
    turret_base(b, m)
    H = "TurretHead"
    b.box((0.7, 0.8, 0.5), (0, 0, 1.2), H, m["plate"], bevel=0.05)
    b.cyl(0.2, 1.2, (0, 0, 1.35), H, m["dark"], rot=(0, 90, 0), verts=12)  # 軸
    G = "TurretGun"
    for s in (-1, 1):
        x = s * 0.55
        b.box((0.42, 1.1, 0.5), (x, 0.05, 1.35), G, m["steel"], bevel=0.04)
        b.box((0.43, 0.04, 0.1), (x, 0.6, 1.58), G, m["hazard"], bevel=0.005)
        for ix in (-1, 1):
            for iz in (-1, 0, 1):
                b.cyl(0.07, 0.04, (x + ix * 0.1, 0.62, 1.35 + iz * 0.14), G, m["dark"], rot=(90, 0, 0), verts=10)
                b.cyl(0.04, 0.02, (x + ix * 0.1, 0.64, 1.35 + iz * 0.14), G, m["glow"], rot=(90, 0, 0), verts=8)
    root = b.finish("td_rocket", pivots={H: (0, 0, 1.0), G: (0, 0, 1.35)})
    empty("Muzzle", (0.55, 0.7, 1.35), "TurretGun")
    return root


def pylon(b, m, glow):
    B = "TurretBase"
    b.box((1.36, 1.36, 0.25), (0, 0, 0.125), B, m["base"], bevel=0.04)
    b.box((1.0, 1.0, 1.2), (0, 0, 0.85), B, m["steel"], bevel=0.06)
    b.box((1.2, 1.2, 0.18), (0, 0, 1.52), B, m["dark"], bevel=0.03)
    for s in (-1, 1):
        b.box((0.06, 1.02, 0.8), (s * 0.5, 0, 0.85), B, m["dark"], bevel=0.01)
        b.box((0.02, 0.6, 0.06), (s * 0.53, 0, 1.1), B, glow, bevel=0)
        b.box((1.02, 0.06, 0.8), (0, s * 0.5, 0.85), B, m["dark"], bevel=0.01)
        b.box((0.6, 0.02, 0.06), (0, s * 0.53, 1.1), B, glow, bevel=0)


def build_slow():
    """減速フィールドの発生装置：柱の上の球と、回る輪（紫）"""
    b = Builder()
    m = turret_mats()
    violet = M("TViolet", "#9a6bff", 0, 0.4, "#9a6bff", 5.0)
    pylon(b, m, violet)
    b.sphere(0.34, (0, 0, 1.85), "TurretBase", violet, subdiv=3)
    b.cyl(0.12, 0.3, (0, 0, 1.65), "TurretBase", m["dark"], verts=10)
    S = "Spin"
    for k in range(3):
        bpy.ops.mesh.primitive_torus_add(major_radius=0.5 + k * 0.08, minor_radius=0.022, location=(0, 0, 1.85), rotation=(math.radians(60 * k), math.radians(30), 0))
        b.add(bpy.context.active_object, S, violet if k == 1 else m["plate"])
    return b.finish("td_slow", pivots={S: (0, 0, 1.85)})


def build_repair():
    """修理ステーション：柱の上の緑の灯りと十字、2本の腕（先から修理の光を出す）"""
    b = Builder()
    m = turret_mats()
    green = M("TGreen", "#4dff9a", 0, 0.4, "#4dff9a", 5.0)
    white = M("TWhite", "#e8ece8", 0.0, 0.5)
    pylon(b, m, green)
    b.sphere(0.3, (0, 0, 1.85), "TurretBase", green, subdiv=3)
    for s in (-1, 1):
        b.box((0.42, 0.04, 0.12), (0, s * 0.62, 0.95), "TurretBase", white, bevel=0.005)
        b.box((0.12, 0.04, 0.42), (0, s * 0.62, 0.95), "TurretBase", white, bevel=0.005)
    S = "Spin"
    for s in (-1, 1):
        b.box((0.9, 0.12, 0.12), (s * 0.45, 0, 1.75), S, m["steel"], bevel=0.02)
        b.cyl(0.08, 0.16, (s * 0.9, 0, 1.68), S, m["dark"], verts=10)
        b.sphere(0.06, (s * 0.9, 0, 1.58), S, green, subdiv=2)
    return b.finish("td_repair", pivots={S: (0, 0, 1.75)})


# ---------------------------------------------------------------------------
# コア（エネルギー炉）。当たり判定：4.24×6×4.24（中心 3.25）。台座（0.3m）の上に立つ
# ---------------------------------------------------------------------------


def build_core():
    b = Builder()
    steel = M("CSteel", "#8f949b", 0.75, 0.35)
    dark = M("CDark", "#2b2e34", 0.6, 0.5)
    plate = M("CPlate", "#c4c7ca", 0.5, 0.4)
    hazard = M("CHazard", "#d6a52a", 0.0, 0.6)
    glass = M("CGlass", "#9fe8ff", 0.0, 0.05)
    energy = M("CEnergy", "#54d8ff", 0, 0.3, "#54d8ff", 8.0)
    B = "CoreBody"
    z0 = 0.3
    # 土台（八角）と、上の冷却部
    b.cyl(2.1, 0.7, (0, 0, z0 + 0.35), B, steel, verts=8, bevel=0.05)
    b.cyl(2.12, 0.08, (0, 0, z0 + 0.72), B, hazard, verts=8)
    b.cyl(1.9, 0.6, (0, 0, z0 + 5.4), B, steel, verts=8, bevel=0.05)
    b.cyl(1.5, 0.3, (0, 0, z0 + 5.85), B, dark, verts=8, bevel=0.03)
    for k in range(8):
        a = math.radians(22.5 + k * 45)
        b.box((0.08, 0.7, 0.5), (math.cos(a) * 1.75, math.sin(a) * 1.75, z0 + 5.95), B, plate, rot=(0, 0, math.degrees(a) + 90), bevel=0.01)  # 冷却ひれ
    # 4本の柱
    for k in range(4):
        a = math.radians(45 + k * 90)
        x, y = math.cos(a) * 1.75, math.sin(a) * 1.75
        b.box((0.42, 0.42, 4.6), (x, y, z0 + 3.0), B, plate, rot=(0, 0, 45 + k * 90), bevel=0.04)
        b.box((0.1, 0.44, 3.6), (x * 0.92, y * 0.92, z0 + 3.0), B, dark, rot=(0, 0, 45 + k * 90), bevel=0.01)
    # ガラスの筒と、中の光る柱
    bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=1.05, depth=4.4, location=(0, 0, z0 + 3.0))
    gl = b.add(bpy.context.active_object, "CoreGlass", glass)
    gl.data.polygons.foreach_set("use_smooth", [True] * len(gl.data.polygons))
    E = "CoreEnergy"
    b.cyl(0.42, 4.6, (0, 0, z0 + 3.0), E, energy, verts=16)
    b.sphere(0.62, (0, 0, z0 + 3.0), E, energy, subdiv=2)
    # 回る輪（3つ）
    pivots = {}
    for k, (zz, r) in enumerate(((z0 + 1.6, 1.38), (z0 + 3.0, 1.45), (z0 + 4.4, 1.38))):
        R = f"CoreRing{k}"
        bpy.ops.mesh.primitive_torus_add(major_radius=r, minor_radius=0.07, major_segments=36, location=(0, 0, zz))
        b.add(bpy.context.active_object, R, steel)
        for j in range(4):
            a = math.radians(j * 90)
            b.box((0.16, 0.16, 0.16), (math.cos(a) * r, math.sin(a) * r, zz), R, energy, bevel=0.02)
        pivots[R] = (0, 0, zz)
    # 太いケーブル（地面へ）
    for k in range(4):
        a = math.radians(k * 90)
        b.box((0.5, 1.0, 0.24), (math.cos(a) * 2.35, math.sin(a) * 2.35, z0 + 0.12), B, dark, rot=(0, 0, k * 90 + 90), bevel=0.04)
        b.box((0.3, 1.02, 0.06), (math.cos(a) * 2.35, math.sin(a) * 2.35, z0 + 0.25), B, energy, rot=(0, 0, k * 90 + 90), bevel=0)
    return b.finish("td_core", pivots=pivots)


# ---------------------------------------------------------------------------
# 敵のドローン（暗い灰色の機体・赤い目・下に銃）。当たり判定：胴 半径 0.62、腕と回転翼 2.1×0.2×2.1（中心 +0.2）
# 原点は胴の中心
# ---------------------------------------------------------------------------


def build_td_drone():
    b = Builder()
    shell = M("EShell", "#33363b", 0.6, 0.4)
    plate = M("EPlate", "#5a5e65", 0.65, 0.35)
    dark = M("EDark", "#141518", 0.4, 0.6)
    red = M("ERed", "#ff2a2a", 0, 0.4, "#ff2a2a", 6.0)
    hazard = M("EHazard", "#c8302a", 0.0, 0.6)
    B = "DroneBody"
    b.sphere(0.58, (0, 0, 0), B, shell, subdiv=3)
    b.cyl(0.62, 0.16, (0, 0, 0.05), B, plate, verts=12, bevel=0.02)
    b.cyl(0.4, 0.12, (0, 0, -0.42), B, dark, verts=10, bevel=0.02)
    b.box((0.3, 0.6, 0.18), (0, 0.2, -0.52), B, dark, bevel=0.03)  # 銃の台
    b.cyl(0.05, 0.6, (0, 0.6, -0.55), B, plate, rot=(90, 0, 0), verts=8)  # 銃身
    E = "DroneEye"
    b.sphere(0.2, (0, 0.5, -0.05), E, red, subdiv=2)
    b.cyl(0.24, 0.05, (0, 0.47, -0.05), B, dark, rot=(90, 0, 0), verts=16)
    pivots = {}
    for k in range(4):
        a = math.radians(45 + k * 90)
        x, y = math.cos(a) * 0.82, math.sin(a) * 0.82
        b.box((0.62, 0.1, 0.07), (x * 0.6, y * 0.6, 0.2), B, plate, rot=(0, 0, math.degrees(a)), bevel=0.01)
        b.cyl(0.08, 0.14, (x, y, 0.2), B, dark, verts=10)
        bpy.ops.mesh.primitive_torus_add(major_radius=0.3, minor_radius=0.022, location=(x, y, 0.22))
        b.add(bpy.context.active_object, B, hazard if k % 2 == 0 else plate)
        R = f"Rotor{k}"
        b.box((0.52, 0.05, 0.01), (x, y, 0.28), R, plate, bevel=0)
        b.box((0.05, 0.52, 0.01), (x, y, 0.28), R, plate, bevel=0)
        pivots[R] = (x, y, 0.28)
    b.box((0.5, 0.02, 0.04), (0, -0.55, 0.05), B, red, bevel=0)  # 後ろの灯り
    root = b.finish("td_drone", pivots=pivots)
    empty("Muzzle", (0, 0.92, -0.55), "DroneBody")
    return root


# ---------------------------------------------------------------------------
# 大型兵器（ボス）：二本足の歩行兵器。高さ 7.5m。当たり判定は shared/td/units.ts の BOSS_BODY
#  three の座標（-Z が正面）→ Blender：(x, y, z)_three = (x, -y_b...) なので、three の z = -Blender の y
# ---------------------------------------------------------------------------


def build_boss():
    b = Builder()
    armor = M("BArmor", "#4a4f45", 0.55, 0.45)
    armor2 = M("BArmorDark", "#262924", 0.55, 0.5)
    steel = M("BSteel", "#7b8088", 0.8, 0.35)
    hazard = M("BHazard", "#c8a23a", 0.0, 0.6)
    red = M("BRed", "#ff2a20", 0, 0.4, "#ff2a20", 7.0)
    core = M("BCore", "#ff7a20", 0, 0.4, "#ff7a20", 8.0)
    glass = M("BGlass", "#1b2632", 0.6, 0.1)
    pivots = {}
    # 腰（上半身の土台）
    HIP = "BossHip"
    b.box((4.0, 2.4, 1.0), (0, 0, 4.1), HIP, armor2, bevel=0.1)
    b.cyl(0.55, 4.6, (0, 0, 4.0), HIP, steel, rot=(0, 90, 0), verts=12)  # 股関節の軸
    pivots[HIP] = (0, 0, 4.1)
    # 胴（前に操縦席、背中に炉心、左右にロケットの発射筒）
    T = "BossTorso"
    b.box((3.7, 3.2, 1.9), (0, 0.1, 5.5), T, armor, bevel=0.15)
    b.box((3.2, 2.6, 0.3), (0, 0.1, 6.5), T, armor2, bevel=0.06)
    b.box((3.75, 0.1, 0.25), (0, 1.72, 5.0), T, hazard, bevel=0.01)
    b.box((1.7, 1.5, 1.05), (0, 1.3, 6.7), T, armor, bevel=0.1)  # 操縦席
    b.box((1.4, 0.06, 0.32), (0, 2.06, 6.8), T, glass, bevel=0.02)
    E = "BossEye"
    b.sphere(0.3, (0, 2.08, 6.55), E, red, subdiv=2)  # センサー（弱点）
    b.cyl(0.36, 0.08, (0, 2.06, 6.55), T, armor2, rot=(90, 0, 0), verts=16)
    RC = "BossReactor"
    b.sphere(0.8, (0, -1.85, 5.4), RC, core, subdiv=2)  # 背中の炉心（弱点）
    for k in range(4):
        a = math.radians(45 + k * 90)
        b.box((0.25, 0.4, 1.9), (math.cos(a) * 0.95, -1.75 + math.sin(a) * 0.3, 5.4), T, armor2, rot=(0, math.degrees(a), 0), bevel=0.03)
    b.box((2.2, 0.5, 0.4), (0, -1.6, 6.45), T, armor2, bevel=0.05)
    b.box((2.2, 0.5, 0.4), (0, -1.6, 4.35), T, armor2, bevel=0.05)
    for s, P in ((-1, "BossPodR"), (1, "BossPodL")):
        # three の右（+x）は Blender の +x。PodL は左（-x）
        x = -s * 2.6
        b.box((1.3, 2.2, 1.3), (x, 0.3, 5.9), P, armor2, bevel=0.08)
        for ix in (-1, 0, 1):
            for iz in (-1, 0, 1):
                b.cyl(0.13, 0.08, (x + ix * 0.35, 1.42, 5.9 + iz * 0.35), P, steel, rot=(90, 0, 0), verts=10)
                b.cyl(0.08, 0.04, (x + ix * 0.35, 1.47, 5.9 + iz * 0.35), P, red, rot=(90, 0, 0), verts=8)
        b.box((1.32, 0.12, 0.2), (x, -0.6, 6.5), P, hazard, bevel=0.01)
        pivots[P] = (x, 0.3, 5.9)
    # 機銃（操縦席の下。左右・上下に向く）
    G = "BossGun"
    b.box((0.6, 0.8, 0.5), (0, 1.9, 5.6), G, armor2, bevel=0.06)
    for s in (-1, 1):
        b.cyl(0.09, 1.6, (s * 0.16, 2.9, 5.6), G, steel, rot=(90, 0, 0), verts=10)
    pivots[G] = (0, 1.8, 5.6)
    # 脚（太もも → すね → 足）。three の左右 = Blender の左右
    for side, sx in (("L", -1.7), ("R", 1.7)):
        TH = f"BossThigh.{side}"
        b.box((1.0, 1.25, 2.1), (sx, 0.2, 3.0), TH, armor, rot=(-12, 0, 0), bevel=0.1)
        b.box((1.05, 0.1, 1.2), (sx, 0.85, 3.0), TH, hazard, rot=(-12, 0, 0), bevel=0.01)
        b.sphere(0.55, (sx, 0, 3.95), TH, steel, subdiv=2)
        pivots[TH] = (sx, 0, 3.95)
        SH = f"BossShin.{side}"
        b.sphere(0.48, (sx, 0.42, 2.0), SH, steel, subdiv=2)  # ひざ
        b.box((0.85, 1.0, 1.9), (sx, 0.2, 1.15), SH, armor2, rot=(10, 0, 0), bevel=0.08)
        b.box((0.6, 0.12, 1.2), (sx, 0.72, 1.3), SH, armor, rot=(10, 0, 0), bevel=0.02)
        pivots[SH] = (sx, 0.42, 2.0)
        FT = f"BossFoot.{side}"
        b.box((1.15, 2.2, 0.45), (sx, 0.25, 0.22), FT, armor, bevel=0.08)
        for fx in (-0.35, 0.35):
            b.box((0.3, 0.6, 0.3), (sx + fx, 1.35, 0.15), FT, armor2, bevel=0.04)  # つま先
        b.box((0.5, 0.5, 0.3), (sx, -0.95, 0.15), FT, armor2, bevel=0.04)  # かかと
        pivots[FT] = (sx, 0.2, 0.3)
    root = b.finish("td_boss", pivots=pivots)
    empty("MuzzleGun", (0, 3.7, 5.6), "BossGun")
    return root


# ---------------------------------------------------------------------------
# 購入メニューの設置物（味方：灰色の鋼と、青・水色の灯り）
# ---------------------------------------------------------------------------


def metaball_mesh(name, elems, resolution=0.03, decimate=0.55, rscale=1.45):
    """メタボールで、ふくらんだ形を作ってメッシュにする。elems：(種類, 位置, 半径, 大きさ(x,y,z), 回転(度))"""
    mb = bpy.data.metaballs.new(name)
    mb.resolution = resolution
    mb.render_resolution = resolution
    mb.threshold = 0.6
    obj = bpy.data.objects.new(name, mb)
    bpy.context.collection.objects.link(obj)
    for kind, loc, r, size, rot in elems:
        e = mb.elements.new()
        e.type = kind
        e.co = loc
        e.radius = r * rscale
        e.stiffness = 2.0
        if kind in ("ELLIPSOID", "CAPSULE", "CUBE"):
            e.size_x, e.size_y, e.size_z = size
        from mathutils import Euler as _E

        e.rotation = _E([math.radians(a) for a in rot]).to_quaternion()
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.convert(target="MESH")
    m = bpy.context.active_object
    if decimate < 1:
        d = m.modifiers.new("Dec", "DECIMATE")
        d.ratio = decimate
        bpy.ops.object.modifier_apply(modifier=d.name)
    m.data.polygons.foreach_set("use_smooth", [True] * len(m.data.polygons))
    return m


def build_decoy():
    """ダミーバルーン：パイロットの形にふくらむ囮（身長 1.8m）。正面は +Y。足元の台（空気入れ）から管でつながる"""
    b = Builder()
    vinyl = M("DVinyl", "#6f7f96", 0.0, 0.2)
    vinyl2 = M("DVinylLight", "#aab3bf", 0.0, 0.25)
    seam = M("DSeam", "#1b1f26", 0.0, 0.6)
    glow = M("DGlow", "#4fd1ff", 0, 0.4, "#4fd1ff", 4.0)
    steel = M("DSteel", "#7d838b", 0.7, 0.4)
    dark = M("DDark", "#25282d", 0.6, 0.5)
    hazard = M("DHazard", "#d6a52a", 0.0, 0.6)
    # --- 台（空気入れ）：低い円筒、足の金具、ゲージの灯り ---
    B = "DecoyBase"
    b.cyl(0.34, 0.08, (0, 0, 0.04), B, dark, verts=16, bevel=0.01)
    b.cyl(0.26, 0.12, (0, 0, 0.14), B, steel, verts=16, bevel=0.015)
    b.cyl(0.27, 0.02, (0, 0, 0.11), B, hazard, verts=16)
    b.cyl(0.18, 0.04, (0, 0, 0.22), B, dark, verts=16)
    for k in range(3):
        a = math.radians(30 + k * 120)
        b.box((0.16, 0.05, 0.05), (math.cos(a) * 0.38, math.sin(a) * 0.38, 0.03), B, steel, rot=(0, 0, math.degrees(a)), bevel=0.01)
    b.box((0.08, 0.02, 0.04), (0, -0.265, 0.15), B, glow, bevel=0)  # 後ろのゲージ
    b.cyl(0.035, 0.24, (0.2, -0.12, 0.3), B, dark, rot=(0, 25, 0), verts=8)  # 管
    # --- 人形（メタボール）：ふくらんだパイロット。ライフルを構えた形 ---
    E = []
    for s in (-1, 1):
        x = s * 0.11
        E.append(("CAPSULE", (x, 0.02, 0.34), 0.11, (0.17, 0.1, 0.1), (0, 90, 0)))  # すね
        E.append(("CAPSULE", (x, 0.0, 0.72), 0.13, (0.16, 0.1, 0.1), (0, 90, 0)))  # もも
        E.append(("ELLIPSOID", (x, 0.07, 0.24), 0.1, (0.9, 1.4, 0.7), (0, 0, 0)))  # 足
    E.append(("ELLIPSOID", (0, 0.0, 0.95), 0.2, (1.25, 0.8, 0.7), (0, 0, 0)))  # 腰
    E.append(("ELLIPSOID", (0, 0.0, 1.22), 0.26, (1.05, 0.72, 1.0), (0, 0, 0)))  # 胴
    E.append(("ELLIPSOID", (0, -0.12, 1.28), 0.18, (1.1, 0.6, 1.0), (0, 0, 0)))  # 背中の装備
    E.append(("ELLIPSOID", (0, 0.0, 1.47), 0.1, (1, 1, 0.9), (0, 0, 0)))  # 首
    E.append(("ELLIPSOID", (0, 0.01, 1.62), 0.15, (1.0, 1.08, 1.0), (0, 0, 0)))  # 頭（ヘルメット）
    for s in (-1, 1):
        E.append(("ELLIPSOID", (s * 0.27, 0.0, 1.38), 0.11, (1, 1, 1), (0, 0, 0)))  # 肩
    # 右腕（前へ）・左腕（銃を支える）
    E.append(("CAPSULE", (0.3, 0.1, 1.22), 0.075, (0.13, 0.1, 0.1), (0, 70, 70)))
    E.append(("CAPSULE", (0.18, 0.3, 1.17), 0.07, (0.12, 0.1, 0.1), (0, 0, 120)))
    E.append(("CAPSULE", (-0.28, 0.12, 1.22), 0.075, (0.13, 0.1, 0.1), (0, 70, 110)))
    E.append(("CAPSULE", (-0.12, 0.36, 1.2), 0.07, (0.13, 0.1, 0.1), (0, 0, 60)))
    body = metaball_mesh("DecoyBodyMB", E)
    b.add(body, "DecoyBody", vinyl)
    # ふくらんだライフル（別の色）
    G = metaball_mesh(
        "DecoyGunMB",
        [
            ("CAPSULE", (0.04, 0.42, 1.2), 0.06, (0.26, 0.1, 0.1), (0, 0, 90)),
            ("ELLIPSOID", (0.04, 0.25, 1.14), 0.07, (0.7, 1.2, 1.2), (0, 0, 0)),
            ("CAPSULE", (0.04, 0.12, 1.2), 0.05, (0.08, 0.1, 0.1), (0, 0, 90)),
        ],
        resolution=0.025,
        decimate=0.6,
    )
    b.add(G, "DecoyBody", vinyl2)
    # 目の帯（バイザー）・胸の灯り・つなぎ目
    D = "DecoyBody"
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=0.155, location=(0, 0.02, 1.63))
    v = bpy.context.active_object
    v.scale = (0.95, 1.06, 0.38)
    bpy.ops.object.transform_apply(scale=True)
    v.data.polygons.foreach_set("use_smooth", [True] * len(v.data.polygons))
    b.add(v, D, glow)
    b.box((0.22, 0.03, 0.03), (0, 0.19, 1.3), D, glow, bevel=0)
    for z, r in ((0.95, 0.27), (1.47, 0.11)):
        bpy.ops.mesh.primitive_torus_add(major_radius=r, minor_radius=0.012, major_segments=24, location=(0, 0, z))
        t = bpy.context.active_object
        t.scale = (1.0, 0.68, 1.0)
        bpy.ops.object.transform_apply(scale=True)
        b.add(t, D, seam)
    b.cyl(0.035, 0.06, (0, -0.24, 1.3), D, dark, rot=(90, 0, 0), verts=10)  # 背中の弁
    return b.finish("td_decoy", pivots={"DecoyBody": (0, 0, 0.18)})


def build_wiretrap():
    """ワイヤートラップの機雷（1つ分）。たたんだ形で作る：脚は体に沿って上を向き、頭は縮んでいる。
    ゲーム側で、脚を開き（付け根で回す）、頭を 0.26m 伸ばすと、レーザーの高さ（0.62m）になる"""
    b = Builder()
    gun = M("WGun", "#3a3e45", 0.75, 0.35)
    dark = M("WDark", "#1c1e22", 0.5, 0.55)
    plate = M("WPlate", "#8a9098", 0.7, 0.35)
    hazard = M("WHazard", "#d6a52a", 0.0, 0.6)
    laser = M("WLaser", "#ff3a6a", 0, 0.3, "#ff3a6a", 7.0)
    B = "PodBody"
    # 六角の胴（0.06〜0.34）
    b.cyl(0.13, 0.26, (0, 0, 0.2), B, gun, verts=6, bevel=0.012)
    b.cyl(0.145, 0.05, (0, 0, 0.1), B, dark, verts=6, bevel=0.01)
    b.cyl(0.14, 0.03, (0, 0, 0.25), B, hazard, verts=6)
    b.cyl(0.1, 0.06, (0, 0, 0.35), B, plate, verts=12, bevel=0.01)
    b.cyl(0.06, 0.05, (0, 0, 0.05), B, dark, verts=10)
    for k in range(3):
        a = math.radians(90 + k * 120)
        b.box((0.012, 0.05, 0.12), (math.cos(a) * 0.125, math.sin(a) * 0.125, 0.2), B, laser, rot=(0, 0, math.degrees(a)), bevel=0)  # 横の灯り
        b.box((0.06, 0.06, 0.05), (math.cos(a) * 0.13, math.sin(a) * 0.13, 0.3), B, dark, rot=(0, 0, math.degrees(a)), bevel=0.01)  # 脚の付け根
    pivots = {}
    for k in range(3):
        a = math.radians(90 + k * 120)
        L = f"PodLeg{k}"
        cx, cy = math.cos(a) * 0.15, math.sin(a) * 0.15
        # たたんだ脚：付け根（0.3）から下へ、胴に沿う
        b.box((0.035, 0.03, 0.26), (cx, cy, 0.17), L, plate, rot=(0, 0, math.degrees(a) + 90), bevel=0.006)
        b.box((0.05, 0.05, 0.04), (cx * 1.02, cy * 1.02, 0.045), L, dark, rot=(0, 0, math.degrees(a) + 90), bevel=0.008)
        pivots[L] = (cx, cy, 0.3)
    H = "PodHead"
    b.cyl(0.035, 0.3, (0, 0, 0.24), H, plate, verts=8)  # 伸びる柱（胴の中に隠れている）
    b.cyl(0.075, 0.07, (0, 0, 0.4), H, gun, verts=8, bevel=0.01)
    b.sphere(0.042, (0, 0, 0.4), H, laser, subdiv=2)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.07, minor_radius=0.012, major_segments=16, location=(0, 0, 0.4), rotation=(math.radians(90), 0, 0))
    b.add(bpy.context.active_object, H, dark)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.07, minor_radius=0.012, major_segments=16, location=(0, 0, 0.4), rotation=(0, math.radians(90), 0))
    b.add(bpy.context.active_object, H, dark)
    b.cyl(0.02, 0.06, (0, 0, 0.46), H, laser, verts=8)  # 上のアンテナ
    pivots[H] = (0, 0, 0.36)
    root = b.finish("td_wiretrap", pivots=pivots)
    empty("Emitter", (0, 0, 0.4), "PodHead")
    return root


def build_barricade():
    """バリケード：幅 4.2m・高さ 1.25m・厚み 0.36m の装甲の壁。3枚の板が地面からせり上がる。幅は X、正面は +Y"""
    b = Builder()
    steel = M("BarSteel", "#7d838b", 0.7, 0.4)
    dark = M("BarDark", "#2a2d33", 0.6, 0.5)
    plate = M("BarPlate", "#9ba1a8", 0.55, 0.42)
    hazard = M("BarHazard", "#d6a52a", 0.0, 0.6)
    glow = M("BarGlow", "#4fd1ff", 0, 0.5, "#4fd1ff", 4.0)
    W, H, T = 4.2, 1.25, 0.36
    B = "BarBase"
    b.box((W + 0.1, T + 0.24, 0.1), (0, 0, 0.05), B, dark, bevel=0.02)  # 地面のレール
    for x in (-W / 2 + 0.2, 0, W / 2 - 0.2):
        b.box((0.3, T + 0.5, 0.08), (x, 0, 0.04), B, steel, bevel=0.015)  # 足
    for s in (-1, 1):
        b.box((W - 0.4, 0.02, 0.025), (0, s * (T / 2 + 0.12), 0.1), B, glow, bevel=0)
    pivots = {}
    pw = (W - 0.36) / 3
    for i in range(3):
        P = f"BarPanel{i}"
        x = -W / 2 + 0.18 + pw * (i + 0.5)
        b.box((pw - 0.04, T - 0.08, H - 0.16), (x, 0, 0.1 + (H - 0.16) / 2), P, plate, bevel=0.03)
        # 正面・背面の装甲（斜めの板と、黄色い帯）
        for s in (-1, 1):
            b.box((pw - 0.16, 0.05, H * 0.42), (x, s * (T / 2 - 0.02), 0.62), P, steel, rot=(s * 8, 0, 0), bevel=0.012)
            b.box((pw - 0.16, 0.03, 0.07), (x, s * (T / 2 + 0.005), H - 0.17), P, hazard, bevel=0.005)
            b.box((0.24, 0.02, 0.04), (x, s * (T / 2 + 0.02), 0.27), P, glow, bevel=0)
            for k in range(3):  # 斜めの縞
                b.box((0.05, 0.02, 0.22), (x - 0.3 + k * 0.3, s * (T / 2 + 0.02), 1.0), P, dark, rot=(0, 30, 0), bevel=0)
        b.box((pw - 0.04, T - 0.04, 0.06), (x, 0, H - 0.05), P, dark, bevel=0.015)  # 上の縁
        pivots[P] = (x, 0, 0.0)
    for side, s in (("L", -1), ("R", 1)):
        Pn = f"BarPost.{side}"
        x = s * (W / 2 - 0.09)
        b.box((0.18, T + 0.06, H + 0.08), (x, 0, (H + 0.08) / 2), Pn, dark, bevel=0.03)
        b.box((0.2, T + 0.1, 0.1), (x, 0, H + 0.06), Pn, steel, bevel=0.02)
        b.cyl(0.04, 0.05, (x, 0, H + 0.13), Pn, glow, verts=10)
        for sy in (-1, 1):
            b.box((0.02, 0.025, 0.6), (x, sy * (T / 2 + 0.035), 0.62), Pn, glow, bevel=0)
        pivots[Pn] = (x, 0, 0.0)
    return b.finish("td_barricade", pivots=pivots)


def build_jumppad():
    """ジャンプパッド：直径 2.1m の八角の台。上の板が跳ね、輪が光る。矢印は正面（+Y）"""
    b = Builder()
    steel = M("JSteel", "#7d838b", 0.7, 0.4)
    dark = M("JDark", "#25282d", 0.6, 0.5)
    hazard = M("JHazard", "#d6a52a", 0.0, 0.6)
    glow = M("JGlow", "#3dffc4", 0, 0.4, "#3dffc4", 5.0)
    B = "PadBase"
    b.cyl(1.05, 0.1, (0, 0, 0.05), B, dark, verts=8, bevel=0.02)
    b.cyl(1.07, 0.03, (0, 0, 0.1), B, hazard, verts=8)
    b.cyl(0.95, 0.06, (0, 0, 0.14), B, steel, verts=8, bevel=0.015)
    for k in range(8):
        a = math.radians(22.5 + k * 45)
        b.box((0.3, 0.12, 0.08), (math.cos(a) * 0.98, math.sin(a) * 0.98, 0.12), B, steel, rot=(0, 0, math.degrees(a) + 90), bevel=0.01)  # 留め金
        b.box((0.12, 0.03, 0.03), (math.cos(a) * 1.06, math.sin(a) * 1.06, 0.08), B, glow, rot=(0, 0, math.degrees(a) + 90), bevel=0)
    P = "PadPlate"
    b.cyl(0.78, 0.06, (0, 0, 0.19), P, steel, verts=24, bevel=0.015)
    b.cyl(0.5, 0.02, (0, 0, 0.225), P, dark, verts=24)
    for k in range(3):  # 正面への矢印
        y = -0.25 + k * 0.25
        for s in (-1, 1):
            b.box((0.26, 0.05, 0.015), (s * 0.09, y + 0.06, 0.235), P, glow, rot=(0, 0, s * -40), bevel=0)
    R = "PadRing"
    bpy.ops.mesh.primitive_torus_add(major_radius=0.86, minor_radius=0.03, major_segments=40, location=(0, 0, 0.2))
    b.add(bpy.context.active_object, R, glow)
    return b.finish("td_jumppad", pivots={P: (0, 0, 0.16), R: (0, 0, 0.2)})


def build_upgrade():
    """タレットの強化パーツ。台（1.5m 四方）のまわりに重ねる。Up2：側面の装甲板と金の山形、Up3：四隅の柱と灯り"""
    b = Builder()
    steel = M("USteel", "#8c9299", 0.75, 0.35)
    dark = M("UDark", "#2a2d33", 0.6, 0.5)
    gold = M("UGold", "#ffc14a", 0, 0.4, "#ffc14a", 5.0)
    hot = M("UHot", "#ff6ad5", 0, 0.4, "#ff6ad5", 6.0)
    U2 = "Up2"
    for k in range(4):
        a = k * 90
        rad = math.radians(a)
        cx, cy = math.cos(rad) * 0.79, math.sin(rad) * 0.79
        b.box((0.06, 1.1, 0.42), (cx, cy, 0.42), U2, steel, rot=(0, 0, a), bevel=0.015)
        b.box((0.03, 0.9, 0.06), (cx * 1.04, cy * 1.04, 0.64), U2, dark, rot=(0, 0, a), bevel=0.005)
        # 山形（レベル 2 は 2 本）
        for j in range(2):
            for s in (-1, 1):
                ox, oy = -math.sin(rad) * s * 0.07, math.cos(rad) * s * 0.07
                b.box((0.02, 0.17, 0.03), (cx * 1.05 + ox, cy * 1.05 + oy, 0.32 + j * 0.1), U2, gold, rot=(s * 35 * (1 if k % 2 == 0 else 1), 0, a), bevel=0)
    U3 = "Up3"
    for k in range(4):
        rad = math.radians(45 + k * 90)
        cx, cy = math.cos(rad) * 1.04, math.sin(rad) * 1.04
        b.box((0.16, 0.16, 0.95), (cx, cy, 0.48), U3, dark, rot=(0, 0, 45 + k * 90), bevel=0.02)
        b.box((0.2, 0.2, 0.08), (cx, cy, 0.97), U3, steel, rot=(0, 0, 45 + k * 90), bevel=0.015)
        b.cyl(0.045, 0.08, (cx, cy, 1.05), U3, hot, verts=10)
        b.box((0.025, 0.025, 0.55), (cx * 1.07, cy * 1.07, 0.5), U3, hot, rot=(0, 0, 45 + k * 90), bevel=0)
    for k in range(4):  # 3 本目の山形
        rad = math.radians(k * 90)
        cx, cy = math.cos(rad) * 0.83, math.sin(rad) * 0.83
        for s in (-1, 1):
            ox, oy = -math.sin(rad) * s * 0.07, math.cos(rad) * s * 0.07
            b.box((0.02, 0.17, 0.03), (cx + ox, cy + oy, 0.52), U3, gold, rot=(s * 35, 0, k * 90), bevel=0)
    return b.finish("td_upgrade")


def arc_shell(a0, a1, r_out, r_in, z0, z1, taper=1.0, n=10):
    """円筒の一部の殻（扉の板）。a0〜a1 は角度（度）、taper は上の半径の倍率"""
    import bmesh

    me = bpy.data.meshes.new("arc")
    bm = bmesh.new()
    rows = []
    for i in range(n + 1):
        a = math.radians(a0 + (a1 - a0) * i / n)
        c, s_ = math.cos(a), math.sin(a)
        ring = []
        for r, z in ((r_out, z0), (r_out * taper, z1), (r_in * taper, z1), (r_in, z0)):
            ring.append(bm.verts.new((c * r, s_ * r, z)))
        rows.append(ring)
    for i in range(n):
        a, b2 = rows[i], rows[i + 1]
        for k in range(4):
            k2 = (k + 1) % 4
            bm.faces.new((a[k], b2[k], b2[k2], a[k2]))
    bm.faces.new(tuple(reversed(rows[0])))
    bm.faces.new(tuple(rows[-1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new("arc", me)
    bpy.context.collection.objects.link(o)
    for f in me.polygons:
        f.use_smooth = True
    return o


def build_pod():
    """
    降下ポッド（敵の分隊を運ぶ）。高さ 3.6m・直径 1.9m。底は焼けた耐熱板、上は円すいの頭と安定板・逆噴射の噴射口。
    扉 4 枚（PodDoor0〜3）は下の外側の縁が原点（蝶番）。外へ倒れて開く。扉 k の向きは Blender の角度 k×90°（0 で +X）
    PodHot：底の焼けた縁（光らせて冷ます）、PodBeacon：頭の赤い灯り、PodJet0〜3：脚の付け根の下向きの噴射口の空の点（炎を出す所）
    """
    b = Builder()
    armor = M("PArmor", "#3d4148", 0.6, 0.42)
    plate = M("PPlate", "#5c616a", 0.65, 0.38)
    steel = M("PSteel", "#80868e", 0.75, 0.32)
    charred = M("PCharred", "#221f1d", 0.3, 0.85)
    inner = M("PInner", "#131417", 0.4, 0.7)
    hazard = M("PHazard", "#d6a52a", 0.0, 0.6)
    red = M("PRed", "#ff3a2a", 0, 0.4, "#ff3a2a", 2.6)
    hot = M("PHot", "#ff6a1a", 0, 0.5, "#ff6a1a", 6.0)
    beacon = M("PBeacon", "#ff2a1a", 0, 0.3, "#ff2a1a", 8.0)
    B = "PodBody"
    # 底：耐熱板（低い円すい台）と着地の脚
    bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=1.06, radius2=0.96, depth=0.36, location=(0, 0, 0.18))
    b.add(bpy.context.active_object, B, charred, bevel=0.02)
    b.cyl(0.62, 0.06, (0, 0, 0.39), B, plate, verts=24)
    H = "PodHot"
    bpy.ops.mesh.primitive_torus_add(major_radius=1.0, minor_radius=0.06, major_segments=32, minor_segments=6, location=(0, 0, 0.05))
    b.add(bpy.context.active_object, H, hot)
    for k in range(4):
        a = math.radians(45 + k * 90)
        c, s_ = math.cos(a), math.sin(a)
        # 斜めの脚（外へ張り出す）と足の板
        b.box((0.14, 0.14, 0.7), (c * 1.02, s_ * 1.02, 0.32), B, steel, rot=(0, -28, math.degrees(a)), bevel=0.02)
        b.box((0.36, 0.36, 0.06), (c * 1.2, s_ * 1.2, 0.03), B, charred, rot=(0, 0, math.degrees(a)), bevel=0.01)
    # 柱（扉と扉のあいだ）・中の座席・中の赤い灯り
    b.cyl(0.42, 2.3, (0, 0, 1.5), B, inner, verts=16)
    for k in range(4):
        a = math.radians(45 + k * 90)
        c, s_ = math.cos(a), math.sin(a)
        b.box((0.2, 0.22, 2.4), (c * 0.93, s_ * 0.93, 1.5), B, steel, rot=(0, 0, math.degrees(a)), bevel=0.02)
        b.box((0.05, 0.06, 1.6), (c * 1.04, s_ * 1.04, 1.45), B, red, rot=(0, 0, math.degrees(a)), bevel=0)
        # 座席（扉の内側。扉が開くと見える）
        a2 = math.radians(k * 90)
        c2, s2 = math.cos(a2), math.sin(a2)
        b.box((0.32, 0.5, 0.08), (c2 * 0.6, s2 * 0.6, 0.85), B, inner, rot=(0, 0, math.degrees(a2)), bevel=0.01)
        b.box((0.08, 0.5, 0.9), (c2 * 0.48, s2 * 0.48, 1.3), B, plate, rot=(0, 0, math.degrees(a2)), bevel=0.01)
        b.box((0.03, 0.18, 0.04), (c2 * 0.46, s2 * 0.46, 2.3), B, red, rot=(0, 0, math.degrees(a2)), bevel=0)
    # 上の輪・円すいの頭・安定板・噴射口・灯り
    b.cyl(0.98, 0.16, (0, 0, 2.7), B, steel, verts=24, bevel=0.02)
    bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=0.96, radius2=0.36, depth=0.62, location=(0, 0, 3.09))
    b.add(bpy.context.active_object, B, armor, bevel=0.02)
    b.cyl(0.38, 0.1, (0, 0, 2.86), B, red, verts=24)
    b.cyl(0.36, 0.16, (0, 0, 3.48), B, plate, verts=16, bevel=0.02)
    b.cyl(0.03, 0.5, (0.18, 0, 3.8), B, steel, verts=6)
    L = "PodBeacon"
    b.sphere(0.08, (0, 0, 3.62), L, beacon, subdiv=2)
    jets = []
    for k in range(4):
        a = math.radians(45 + k * 90)
        c, s_ = math.cos(a), math.sin(a)
        # 安定板（頭から外へ張り出す、後退翼の板）と先端の灯り
        fin = b.box((0.5, 0.05, 0.85), (c * 1.0, s_ * 1.0, 2.98), B, armor, rot=(0, 0, 0), bevel=0.012)
        bpy.ops.object.select_all(action="DESELECT")
        fin.select_set(True)
        bpy.context.view_layer.objects.active = fin
        # 外側ほど下がる形：板の中心を軸に、接線のまわりへ傾ける
        fin.matrix_world = Matrix.Translation(fin.location.copy()) @ Matrix.Rotation(a, 4, "Z") @ Matrix.Rotation(math.radians(-24), 4, "Y")
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
        b.sphere(0.035, (c * 1.24, s_ * 1.24, 2.86), B, red, subdiv=1)
        # 逆噴射の噴射口（脚の付け根。下向き。降りる直前と、飛び去るときに火を噴く）
        b.cyl(0.13, 0.22, (c * 1.12, s_ * 1.12, 0.52), B, charred, verts=10)
        b.cyl(0.16, 0.08, (c * 1.12, s_ * 1.12, 0.66), B, steel, verts=10)
        jets.append((f"PodJet{k}", (c * 1.12, s_ * 1.12, 0.4)))
    # 扉 4 枚（外へ倒れる）。赤い帯・黄色の縞・番号の板
    pivots = {}
    for k in range(4):
        a = k * 90
        D = f"PodDoor{k}"
        o = arc_shell(a - 40, a + 40, 0.96, 0.86, 0.38, 2.62, taper=0.99)
        b.add(o, D, armor)
        ar = math.radians(a)
        c, s_ = math.cos(ar), math.sin(ar)
        # 扉の補強の帯（横 2 本）と、細い赤い帯
        for zb in (1.05, 2.0):
            o2 = arc_shell(a - 38, a + 38, 0.995, 0.955, zb - 0.07, zb + 0.07, n=8)
            b.add(o2, D, plate)
        b.box((0.04, 0.1, 0.78), (c * 0.975, s_ * 0.975, 1.52), D, red, rot=(0, 0, a), bevel=0)
        for j in range(3):
            b.box((0.04, 0.14, 0.08), (c * 0.97 - s_ * (j - 1) * 0.3, s_ * 0.97 + c * (j - 1) * 0.3, 0.52), D, hazard, rot=(0, 0, a), bevel=0)
        b.box((0.04, 0.5, 0.36), (c * 0.97, s_ * 0.97, 2.32), D, plate, rot=(0, 0, a), bevel=0.01)
        # 開くための取っ手（左右）
        for sd in (-1, 1):
            b.box((0.06, 0.06, 0.4), (c * 0.98 - s_ * sd * 0.5, s_ * 0.98 + c * sd * 0.5, 1.6), D, steel, rot=(0, 0, a), bevel=0.01)
        pivots[D] = (c * 0.96, s_ * 0.96, 0.38)
    root = b.finish("td_pod", pivots=pivots)
    for name, loc in jets:
        empty(name, loc, "PodBody")
    return root


def build_mortar():
    """
    迫撃砲（迫撃砲兵が背負って運び、高い所に据えてコアを撃つ）。正面（+Y）へ 60° 上を向いた砲身。
    据えた形（MortarBase＋MortarTube）・背負った形（MortarCarry）・砲弾（MortarShell）を 1 つのファイルに入れる
    """
    b = Builder()
    steel = M("MSteel", "#4c5243", 0.55, 0.45)
    dark = M("MDark", "#24271f", 0.55, 0.55)
    metal = M("MMetal", "#6f747a", 0.8, 0.32)
    wood = M("MCase", "#5a4a32", 0.0, 0.8)
    shellm = M("MShell", "#5f6452", 0.5, 0.45)
    band = M("MBand", "#d9a62c", 0.0, 0.6)
    glow = M("MGlow", "#ff8a2a", 0, 0.4, "#ff8a2a", 6.0)
    el = math.radians(60)
    d = Vector((0, math.cos(el), math.sin(el)))  # 砲身の向き
    sock = Vector((0, -0.05, 0.1))  # 底の受け口
    L = 1.15
    # --- 底板（丸い板・スペード・取っ手） ---
    B = "MortarBase"
    b.cyl(0.34, 0.06, (0, 0, 0.03), B, steel, verts=20, bevel=0.012)
    b.cyl(0.24, 0.03, (0, 0, 0.075), B, dark, verts=20)
    for k in range(4):
        a = math.radians(45 + k * 90)
        b.box((0.06, 0.24, 0.05), (math.cos(a) * 0.2, math.sin(a) * 0.2, 0.08), B, steel, rot=(0, 0, math.degrees(a) + 90), bevel=0.01)  # 補強
    for sx in (-1, 1):
        b.box((0.16, 0.03, 0.03), (sx * 0.3, -0.22, 0.09), B, metal, rot=(0, 0, sx * 35), bevel=0.006)  # 取っ手
    b.sphere(0.075, tuple(sock), B, dark, subdiv=2)  # 受け口
    # --- 二脚（砲身の 6 割の所を支える） ---
    clamp = sock + d * (L * 0.6)
    b.cyl(0.075, 0.12, tuple(clamp), B, metal, rot=(90 - 60, 0, 0), verts=12, bevel=0.01)  # 砲身を締める輪
    for sx in (-1, 1):
        foot = Vector((sx * 0.32, clamp.y + 0.16, 0.02))
        mid = (clamp + foot) / 2
        v = foot - clamp
        ln = v.length
        o = b.cyl(0.022, ln, tuple(mid), B, steel, verts=8)
        o.rotation_mode = "QUATERNION"
        o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(v.normalized())
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.select_all(action="DESELECT")
        o.select_set(True)
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
        b.box((0.1, 0.12, 0.03), tuple(foot), B, dark, bevel=0.008)  # 足
    b.box((0.5, 0.035, 0.035), (0, clamp.y + 0.1, clamp.z * 0.42), B, metal, bevel=0.006)  # 脚のつなぎ
    # 仰角の歯車・ハンドル・照準器（光るレンズ）
    b.box((0.09, 0.09, 0.22), (0, clamp.y + 0.06, clamp.z - 0.2), B, dark, rot=(-20, 0, 0), bevel=0.01)
    b.cyl(0.06, 0.02, (0.09, clamp.y + 0.04, clamp.z - 0.24), B, metal, rot=(0, 90, 0), verts=10)
    b.box((0.07, 0.12, 0.08), (-0.12, clamp.y - 0.02, clamp.z + 0.05), B, dark, bevel=0.01)
    b.cyl(0.022, 0.02, (-0.12, clamp.y - 0.085, clamp.z + 0.06), B, glow, rot=(90, 0, 0), verts=10)
    # 弾薬箱（ふたが開いて、砲弾が 3 発見える）
    cx, cy = 0.5, -0.32
    b.box((0.36, 0.5, 0.2), (cx, cy, 0.1), B, wood, rot=(0, 0, 12), bevel=0.01)
    b.box((0.36, 0.5, 0.03), (cx + 0.2, cy - 0.04, 0.22), B, wood, rot=(0, -70, 12), bevel=0.006)
    for i in range(3):
        x = cx - 0.1 + i * 0.1
        b.cyl(0.035, 0.36, (x - 0.02 * i, cy + 0.02 * i, 0.22), B, shellm, rot=(90, 0, 12), verts=10)
        b.cyl(0.037, 0.03, (x - 0.02 * i + 0.01, cy + 0.02 * i - 0.08, 0.22), B, band, rot=(90, 0, 12), verts=10)
    # --- 砲身（原点は受け口。撃つと砲身の向きに沈む） ---
    T = "MortarTube"
    mid = sock + d * (L / 2)
    o = b.cyl(0.058, L, tuple(mid), T, steel, rot=(-30, 0, 0), verts=16, bevel=0.0)
    end = sock + d * L
    b.cyl(0.072, 0.07, tuple(end - d * 0.035), T, metal, rot=(-30, 0, 0), verts=16, bevel=0.008)  # 砲口の輪
    b.cyl(0.07, 0.12, tuple(sock + d * 0.08), T, dark, rot=(-30, 0, 0), verts=16, bevel=0.01)  # 尾栓
    for t in (0.35, 0.8):
        b.cyl(0.064, 0.025, tuple(sock + d * (L * t)), T, band if t == 0.8 else metal, rot=(-30, 0, 0), verts=16)
    # --- 背負った形（砲身・たたんだ二脚・小さな底板）。原点は背中に当てる所、砲身は上（+Z）へ少し傾く ---
    C = "MortarCarry"
    cx0 = Vector((2.0, 0, 0))  # 作る場所（あとで原点を移す）
    b.cyl(0.05, 1.0, tuple(cx0 + Vector((0, 0, 0.2))), C, steel, verts=14)
    b.cyl(0.062, 0.06, tuple(cx0 + Vector((0, 0, 0.68))), C, metal, verts=14)
    b.cyl(0.06, 0.1, tuple(cx0 + Vector((0, 0, -0.27))), C, dark, verts=14)
    b.cyl(0.055, 0.02, tuple(cx0 + Vector((0, 0, 0.45))), C, band, verts=14)
    for sx in (-1, 1):
        b.cyl(0.018, 0.7, tuple(cx0 + Vector((sx * 0.07, 0.04, 0.05))), C, steel, verts=6)
    b.cyl(0.2, 0.04, tuple(cx0 + Vector((0, 0.08, -0.05))), C, steel, rot=(90, 0, 0), verts=16, bevel=0.008)  # 背中の底板
    b.box((0.26, 0.03, 0.04), tuple(cx0 + Vector((0, 0.06, 0.3))), C, dark, bevel=0.006)  # 背負いひもの金具
    # --- 砲弾（原点は真ん中、頭が +Y） ---
    S = "MortarShell"
    sx0 = Vector((-2.0, 0, 0))
    b.cyl(0.045, 0.2, tuple(sx0), S, shellm, rot=(90, 0, 0), verts=12)
    bpy.ops.mesh.primitive_cone_add(vertices=12, radius1=0.045, radius2=0.012, depth=0.12, location=tuple(sx0 + Vector((0, 0.16, 0))), rotation=(math.radians(-90), 0, 0))
    b.add(bpy.context.active_object, S, shellm)
    b.cyl(0.047, 0.03, tuple(sx0 + Vector((0, 0.06, 0))), S, band, rot=(90, 0, 0), verts=12)
    b.cyl(0.018, 0.12, tuple(sx0 + Vector((0, -0.15, 0))), S, dark, rot=(90, 0, 0), verts=8)
    for k in range(4):
        a = k * 90
        b.box((0.006, 0.07, 0.08), tuple(sx0 + Vector((0, -0.18, 0))), S, dark, rot=(0, a, 0), bevel=0)
    pivots = {T: tuple(sock), C: tuple(cx0), S: tuple(sx0)}
    root = b.finish("td_mortar", pivots=pivots)
    empty("Muzzle", tuple(end), T)
    # 背負った形・砲弾は、据えた形から離して置いてある（原点はそれぞれの中心。ゲーム側で取り出して位置を 0 に戻す）
    return root


BUILDS = {
    "mg": build_mg,
    "rocket": build_rocket,
    "slow": build_slow,
    "repair": build_repair,
    "core": build_core,
    "drone": build_td_drone,
    "boss": build_boss,
    "decoy": build_decoy,
    "wiretrap": build_wiretrap,
    "barricade": build_barricade,
    "jumppad": build_jumppad,
    "upgrade": build_upgrade,
    "pod": build_pod,
    "mortar": build_mortar,
}


def main():
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    only = [a for a in args if not a.startswith("--")]
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, build in BUILDS.items():
        if only and name not in only:
            continue
        bpy.ops.wm.read_factory_settings(use_empty=True)
        build()
        out = os.path.join(OUT_DIR, f"td_{name}.glb")
        bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_yup=True, export_apply=True)
        print(f"書き出し: {out} ({os.path.getsize(out) // 1024} KB)")
        if "--preview" in args:
            pdir = os.path.join(HERE, "preview")
            os.makedirs(pdir, exist_ok=True)
            # 正面（Blender の +Y）が見えるように、確認用に向きを変えてから描く
            for o in bpy.context.scene.objects:
                if o.parent is None and o.type == "EMPTY":
                    o.rotation_euler.z = math.radians(200)
            bp.render_preview(os.path.join(pdir, f"td_{name}.png"))


if __name__ == "__main__":
    main()
