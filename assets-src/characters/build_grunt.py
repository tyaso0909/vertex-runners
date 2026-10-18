"""
消耗戦の「歩兵」のモデルを Blender で作り、glTF（.glb）で書き出すスクリプト。

使い方：
  python assets-src/characters/build_grunt.py            （pip install bpy、Python 3.11）。歩兵・突撃兵・重装兵・迫撃砲兵の4つ
  python assets-src/characters/build_grunt.py heavy      重装兵だけ
  python assets-src/characters/build_grunt.py --preview  確認用の画像を assets-src/characters/preview/<名前>_*.png に描く
  --legacy  取り込んだモデル（assets-src/characters/models/<名前>.glb）がある兵士（いまは歩兵 grunt）も、昔のモデルを書き出す
  【フェーズ7】歩兵（grunt）は取り込んだモデル（build_imported.py）に差し替えた。ふだんはここでは作らない

書き出すもの：client/assets/characters/grunt.glb・assault.glb・heavy.glb・mortar.glb
  突撃兵（タワーディフェンス）：軽い装備で、胸と背中に光る爆薬。コアに近づくと自爆する
  重装兵（タワーディフェンス）：厚い装甲と、前に構えた大きな盾（左手側）。銃は右の腰だめ。背中の動力パックが弱点
  迫撃砲兵（タワーディフェンス）：砂色の軽装。つばのあるヘルメットと測距儀（光る片眼鏡）、胸に砲弾の帯、
    背中に砲弾を立てて並べた背負い枠。迫撃砲（砲身）はゲーム側で別の部品として背中に付ける（据えるとはずす）
  パイロットと同じ骨格（build_characters.py の Rig）。アニメーション：
  Idle（構えて待機）/ Run（銃を構えて小走り）/ Shoot / Crouch（しゃがんで構える）/ Death / Jump
  チームの色はゲーム側で付ける：マテリアル "TeamGlow"（バイザー・肩・背中の灯り）の発光色を差し替える

見た目：顔を覆うヘルメットとバイザー、厚い胸当てと肩当て、背中の無線機。量産型の兵士なので、
パイロットより無骨で角ばった形・くすんだ色にする（パイロットと見分けやすいように）。
"""

import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402

import build_characters as bc  # noqa: E402
from build_characters import Character, bone_point, mat, pose_merge, run_pose, make_action, solve_arms  # noqa: E402



def build_grunt(c: Character):
    armor = mat("GruntArmor", "#7d8670", metallic=0.3, roughness=0.5)
    armor2 = mat("GruntArmorDark", "#3e4539", metallic=0.3, roughness=0.6)
    cloth = mat("GruntCloth", "#55504a", roughness=0.85)
    rubber = mat("GruntRubber", "#161718", roughness=0.9)
    metal = mat("GunMetal", "#4a4d55", metallic=0.85, roughness=0.35)
    hazard = mat("GruntHazard", "#c8a23a", roughness=0.6)
    glow = mat("TeamGlow", "#ffffff", emission="#ffffff", strength=4.0)
    visor_dark = mat("GruntVisorBase", "#0c0d10", metallic=0.6, roughness=0.15)

    # --- 体（服の上に装甲を重ねる） ---
    bc.base_body(c, cloth, cloth, midriff_skin=False, eye="#000000", leg=cloth, arm=cloth)
    # ヘルメット（顔をすべて覆う）
    c.ball("head", 0.125, (0, 0.012, 1.6), armor, scale=(0.96, 1.05, 1.0), seg=18)
    c.box("head", (0.2, 0.06, 0.07), (0, -0.098, 1.6), visor_dark, bevel=0.02)  # バイザーの台
    c.box("head", (0.17, 0.012, 0.03), (0, -0.13, 1.605), glow, bevel=0.004)  # 光るバイザー
    c.box("head", (0.13, 0.05, 0.05), (0, -0.09, 1.52), armor2, bevel=0.015)  # 口元のマスク
    for s in (-1, 1):
        c.box("head", (0.03, 0.03, 0.03), (s * 0.04, -0.118, 1.515), rubber, bevel=0.006)  # 呼吸フィルター
        c.box("head", (0.03, 0.09, 0.09), (s * 0.12, 0.0, 1.58), armor2, bevel=0.01)  # 耳当て
    c.tube("head", (0.11, 0.03, 1.62), (0.13, 0.05, 1.82), 0.006, 0.003, metal, verts=6)  # アンテナ
    c.ball("head", 0.008, (0.13, 0.05, 1.82), glow, seg=8)
    # 首当て
    c.tube("neck", (0, 0.005, 1.4), (0, 0.005, 1.48), 0.075, 0.065, rubber, verts=12)

    # 胸当て・背中の無線機
    c.box("chest", (0.33, 0.2, 0.24), (0, -0.01, 1.3), armor, bevel=0.03)
    c.box("chest", (0.26, 0.03, 0.12), (0, -0.115, 1.27), armor2, bevel=0.01)
    for i in range(3):
        c.box("chest", (0.06, 0.035, 0.07), (-0.08 + i * 0.08, -0.13, 1.2), cloth, bevel=0.008)  # 弾倉入れ
    c.box("chest", (0.08, 0.01, 0.012), (0.09, -0.123, 1.36), glow, bevel=0.002)  # 胸の灯り
    c.box("chest", (0.22, 0.12, 0.28), (0, 0.15, 1.27), armor2, bevel=0.025)  # 無線機
    c.box("chest", (0.12, 0.02, 0.04), (0, 0.215, 1.33), glow, bevel=0.004)
    c.box("chest", (0.06, 0.02, 0.04), (0.06, 0.215, 1.22), hazard, bevel=0.004)
    c.tube("chest", (-0.08, 0.17, 1.4), (-0.1, 0.19, 1.62), 0.008, 0.004, metal, verts=6)
    # 肩当て
    for s in (-1, 1):
        c.ball("chest", 0.085, (s * 0.2, 0, 1.39), armor, scale=(1.0, 1.1, 0.75), seg=12)
        c.box("chest", (0.03, 0.08, 0.012), (s * 0.255, -0.0, 1.41), glow, rot=(0, s * 35, 0), bevel=0.003)
    # 腹の装甲（パイロットより胴を太く）
    c.box("spine", (0.27, 0.18, 0.17), (0, 0.0, 1.11), armor2, bevel=0.03)
    c.box("spine", (0.2, 0.03, 0.08), (0, -0.095, 1.1), armor, bevel=0.01)
    # 腰・脚
    c.ball("hips", 0.13, (0, 0.012, 0.95), cloth, scale=(1.45, 1.15, 0.8), seg=16)
    c.box("hips", (0.32, 0.2, 0.1), (0, 0.0, 0.93), cloth, bevel=0.03)
    for s, side in ((1, "L"), (-1, "R")):
        c.box("hips", (0.08, 0.05, 0.14), (s * 0.15, -0.02, 0.88), armor, rot=(0, s * -8, 0), bevel=0.012)  # 腰の垂れ
        c.box("shin." + side, (0.09, 0.05, 0.2), Vector(bone_point("shin." + side, 0.35)) + Vector((0, -0.05, 0)), armor, bevel=0.015)  # すね当て
        c.limb("shin." + side, 0.058, 0.05, cloth, 0.0, 0.7)
    bc.belt(c, rubber, metal, pouches=armor2, n=5)
    for s, side in ((1, "L"), (-1, "R")):
        c.limb("thigh." + side, 0.088, 0.07, cloth, 0.0, 0.95)
        c.box("thigh." + side, (0.1, 0.06, 0.18), Vector(bone_point("thigh." + side, 0.35)) + Vector((0, -0.04, 0)), armor, bevel=0.015)
        c.limb("upperarm." + side, 0.052, 0.046, cloth, 0.0, 1.0)
        c.limb("forearm." + side, 0.05, 0.044, armor2, 0.15, 0.85, verts=8, smooth=False)
    bc.knee_pads(c, armor, size=1.2)
    bc.gloves(c, rubber, fingerless=False)
    bc.boots(c, rubber, armor2, mat("GruntSole", "#0c0c0c", roughness=0.9), chunky=1.25)


def build_assault(c: Character):
    """突撃兵：歩兵の体に、軽い装備・ゴーグル・胸と背中の爆薬（赤く光る）"""
    armor = mat("AssaultArmor", "#9a8a68", metallic=0.2, roughness=0.6)
    armor2 = mat("AssaultArmorDark", "#4a4236", metallic=0.2, roughness=0.65)
    cloth = mat("AssaultCloth", "#6a5c48", roughness=0.85)
    rubber = mat("GruntRubber", "#161718", roughness=0.9)
    metal = mat("GunMetal", "#4a4d55", metallic=0.85, roughness=0.35)
    charge = mat("AssaultCharge", "#3a2420", roughness=0.5)
    red = mat("ChargeGlow", "#ff3020", emission="#ff3020", strength=6.0)
    glow = mat("TeamGlow", "#ffffff", emission="#ffffff", strength=4.0)
    bc.base_body(c, cloth, cloth, midriff_skin=False, eye="#000000", leg=cloth, arm=cloth)
    # 頭：布の覆面とゴーグル
    c.ball("head", 0.12, (0, 0.01, 1.6), cloth, scale=(0.95, 1.02, 1.0), seg=16)
    c.box("head", (0.2, 0.05, 0.06), (0, -0.105, 1.62), rubber, bevel=0.02)
    for s in (-1, 1):
        c.ball("head", 0.032, (s * 0.045, -0.125, 1.625), red, seg=10)
    c.box("head", (0.17, 0.012, 0.025), (0, -0.112, 1.665), glow, bevel=0.004)
    # 胴：薄い胸当てと、爆薬の筒（胸に3本・背中に大きいもの）
    c.box("chest", (0.3, 0.17, 0.2), (0, -0.0, 1.31), armor, bevel=0.03)
    for i in range(3):
        x = -0.085 + i * 0.085
        c.tube("chest", (x, -0.12, 1.2), (x, -0.12, 1.4), 0.032, 0.032, charge, verts=10)
        c.box("chest", (0.05, 0.012, 0.02), (x, -0.155, 1.3), red, bevel=0.003)
    c.tube("chest", (0, 0.12, 1.17), (0, 0.12, 1.43), 0.085, 0.085, charge, verts=12)
    c.tube("chest", (0, 0.12, 1.29), (0, 0.12, 1.31), 0.09, 0.09, red, verts=12)
    c.tube("chest", (0.06, 0.08, 1.42), (0.1, -0.08, 1.36), 0.008, 0.008, red, verts=6)  # 導線
    for s in (-1, 1):
        c.ball("chest", 0.07, (s * 0.2, 0, 1.38), armor2, scale=(1.0, 1.0, 0.7), seg=10)
    c.box("spine", (0.25, 0.16, 0.15), (0, 0.0, 1.11), armor2, bevel=0.03)
    c.ball("hips", 0.12, (0, 0.012, 0.95), cloth, scale=(1.4, 1.1, 0.8), seg=14)
    for s, side in ((1, "L"), (-1, "R")):
        c.limb("shin." + side, 0.055, 0.047, cloth, 0.0, 0.7)
        c.box("shin." + side, (0.08, 0.04, 0.18), Vector(bone_point("shin." + side, 0.35)) + Vector((0, -0.045, 0)), armor, bevel=0.012)
        c.limb("thigh." + side, 0.082, 0.066, cloth, 0.0, 0.95)
        c.limb("upperarm." + side, 0.05, 0.044, cloth, 0.0, 1.0)
        c.limb("forearm." + side, 0.047, 0.042, armor2, 0.15, 0.85, verts=8, smooth=False)
    bc.belt(c, rubber, metal, pouches=charge, n=6)
    bc.knee_pads(c, armor2, size=1.0)
    bc.gloves(c, rubber, fingerless=True)
    bc.boots(c, rubber, armor2, mat("GruntSole", "#0c0c0c", roughness=0.9), chunky=1.1)


def build_heavy(c: Character):
    """重装兵：厚い装甲・大きなヘルメット・背中の動力パック（弱点・光る）・前に構えた大きな盾（腰に付けて、体の前の左寄り）"""
    armor = mat("HeavyArmor", "#59604f", metallic=0.45, roughness=0.45)
    armor2 = mat("HeavyArmorDark", "#2c3029", metallic=0.45, roughness=0.5)
    cloth = mat("GruntCloth", "#45423d", roughness=0.85)
    rubber = mat("GruntRubber", "#161718", roughness=0.9)
    metal = mat("GunMetal", "#4a4d55", metallic=0.85, roughness=0.35)
    shield = mat("HeavyShield", "#6c7066", metallic=0.6, roughness=0.4)
    shield_glass = mat("HeavyShieldGlass", "#20303a", metallic=0.5, roughness=0.15)
    hazard = mat("GruntHazard", "#c8a23a", roughness=0.6)
    core = mat("HeavyCore", "#ff6020", emission="#ff6020", strength=6.0)
    glow = mat("TeamGlow", "#ffffff", emission="#ffffff", strength=4.0)
    visor_dark = mat("GruntVisorBase", "#0c0d10", metallic=0.6, roughness=0.15)
    bc.base_body(c, cloth, cloth, midriff_skin=False, eye="#000000", leg=cloth, arm=cloth)
    # 頭：大きな角ばったヘルメットと横長のバイザー
    c.box("head", (0.27, 0.28, 0.26), (0, 0.0, 1.62), armor, bevel=0.05)
    c.box("head", (0.24, 0.05, 0.07), (0, -0.14, 1.62), visor_dark, bevel=0.015)
    c.box("head", (0.2, 0.012, 0.03), (0, -0.168, 1.625), glow, bevel=0.004)
    c.box("head", (0.18, 0.06, 0.08), (0, -0.12, 1.51), armor2, bevel=0.02)
    c.tube("neck", (0, 0.005, 1.38), (0, 0.005, 1.5), 0.09, 0.08, rubber, verts=12)
    # 胴：厚い胸当て・大きな肩当て
    c.box("chest", (0.4, 0.26, 0.3), (0, -0.01, 1.3), armor, bevel=0.04)
    c.box("chest", (0.32, 0.03, 0.16), (0, -0.14, 1.28), armor2, bevel=0.012)
    c.box("chest", (0.1, 0.012, 0.03), (0.1, -0.157, 1.38), glow, bevel=0.003)
    for s in (-1, 1):
        c.box("chest", (0.18, 0.24, 0.16), (s * 0.27, 0, 1.42), armor, rot=(0, s * 20, 0), bevel=0.03)
        c.box("chest", (0.03, 0.12, 0.012), (s * 0.33, 0, 1.47), glow, rot=(0, s * 20, 0), bevel=0.003)
    # 背中の動力パック（弱点。オレンジに光る）
    c.box("chest", (0.3, 0.16, 0.34), (0, 0.19, 1.28), armor2, bevel=0.03)
    c.tube("chest", (0, 0.28, 1.2), (0, 0.28, 1.38), 0.07, 0.07, core, verts=12)
    for s in (-1, 1):
        c.box("chest", (0.04, 0.05, 0.3), (s * 0.11, 0.28, 1.28), hazard, bevel=0.006)
    c.box("spine", (0.34, 0.24, 0.2), (0, 0.0, 1.1), armor2, bevel=0.04)
    c.ball("hips", 0.15, (0, 0.012, 0.95), cloth, scale=(1.45, 1.2, 0.8), seg=16)
    c.box("hips", (0.38, 0.24, 0.12), (0, 0.0, 0.93), armor2, bevel=0.03)
    for s, side in ((1, "L"), (-1, "R")):
        c.box("shin." + side, (0.12, 0.08, 0.26), Vector(bone_point("shin." + side, 0.35)) + Vector((0, -0.05, 0)), armor, bevel=0.02)
        c.limb("shin." + side, 0.07, 0.06, cloth, 0.0, 0.7)
        c.limb("thigh." + side, 0.1, 0.085, cloth, 0.0, 0.95)
        c.box("thigh." + side, (0.14, 0.1, 0.22), Vector(bone_point("thigh." + side, 0.35)) + Vector((0, -0.05, 0)), armor, bevel=0.02)
        c.limb("upperarm." + side, 0.065, 0.058, armor2, 0.0, 1.0)
        c.limb("forearm." + side, 0.062, 0.056, armor, 0.1, 0.9, verts=8, smooth=False)
    bc.belt(c, rubber, metal, pouches=armor2, n=4)
    bc.knee_pads(c, armor, size=1.5)
    bc.gloves(c, rubber, fingerless=False)
    bc.boots(c, rubber, armor2, mat("GruntSole", "#0c0c0c", roughness=0.9), chunky=1.45)
    # 盾（腰に付ける＝体の向きといっしょに動く）。当たり判定（shared/td/units.ts HEAVY_BODY）に合わせる：
    #   体の前 0.66m、左寄り（中心 x=+0.22・幅 1.04m）、高さ 0.15〜1.75m
    SX, SY = 0.22, -0.66
    c.box("hips", (1.0, 0.07, 1.56), (SX, SY, 0.95), shield, bevel=0.03)
    c.box("hips", (0.86, 0.03, 1.4), (SX, SY - 0.04, 0.95), armor2, bevel=0.01)
    c.box("hips", (0.5, 0.02, 0.14), (SX - 0.1, SY - 0.06, 1.5), shield_glass, bevel=0.005)  # のぞき窓
    for z in (0.35, 0.75, 1.15):
        c.box("hips", (0.9, 0.02, 0.03), (SX, SY - 0.07, z), hazard, bevel=0.003)
    c.box("hips", (0.08, 0.06, 0.4), (SX, SY + 0.07, 1.05), metal, bevel=0.01)  # 取っ手


def build_mortar(c: Character):
    """迫撃砲兵：砂色の軽装・つばのあるヘルメットと測距儀・胸の砲弾の帯・背中の砲弾の背負い枠"""
    armor = mat("MortarArmor", "#93835e", metallic=0.2, roughness=0.6)
    armor2 = mat("MortarArmorDark", "#4d4536", metallic=0.25, roughness=0.65)
    cloth = mat("MortarCloth", "#5a5242", roughness=0.85)
    rubber = mat("GruntRubber", "#161718", roughness=0.9)
    metal = mat("GunMetal", "#4a4d55", metallic=0.85, roughness=0.35)
    shell = mat("MortarShellBody", "#5f6452", metallic=0.5, roughness=0.45)
    band = mat("GruntHazard", "#c8a23a", roughness=0.6)
    lens = mat("MortarLens", "#ff8a2a", emission="#ff8a2a", strength=6.0)
    glow = mat("TeamGlow", "#ffffff", emission="#ffffff", strength=4.0)
    bc.base_body(c, cloth, cloth, midriff_skin=False, eye="#000000", leg=cloth, arm=cloth)
    # 頭：覆面・つばのある丸いヘルメット・額のゴーグル・右目の測距儀（光るレンズ）・ヘッドセット
    c.ball("head", 0.118, (0, 0.01, 1.6), cloth, scale=(0.95, 1.02, 1.0), seg=16)
    c.ball("head", 0.134, (0, 0.01, 1.64), armor, scale=(1.0, 1.06, 0.82), seg=18)
    c.tube("head", (0, 0.01, 1.588), (0, 0.01, 1.602), 0.17, 0.165, armor2, verts=20)  # つば
    c.box("head", (0.2, 0.03, 0.035), (0, -0.115, 1.665), rubber, bevel=0.01)  # ゴーグルのバンド
    for sx in (-1, 1):
        c.tube("head", (sx * 0.045, -0.12, 1.668), (sx * 0.045, -0.145, 1.668), 0.026, 0.024, rubber, verts=10)
    c.box("head", (0.16, 0.012, 0.025), (0, -0.112, 1.62), glow, bevel=0.004)  # 目もとの灯り
    c.tube("head", (-0.05, -0.1, 1.6), (-0.05, -0.15, 1.6), 0.024, 0.022, metal, verts=10)  # 測距儀
    c.tube("head", (-0.05, -0.15, 1.6), (-0.05, -0.158, 1.6), 0.02, 0.02, lens, verts=10)
    c.box("head", (0.03, 0.05, 0.05), (-0.03, -0.075, 1.6), metal, bevel=0.008)
    for sx in (-1, 1):
        c.box("head", (0.03, 0.08, 0.08), (sx * 0.118, 0.0, 1.57), armor2, bevel=0.01)  # 耳当て
    c.tube("head", (0.12, -0.02, 1.54), (0.06, -0.1, 1.5), 0.006, 0.005, rubber, verts=6)  # マイク
    c.tube("neck", (0, 0.005, 1.4), (0, 0.005, 1.48), 0.07, 0.062, cloth, verts=12)
    # 胴：軽いベスト・斜めの砲弾の帯（4 発）
    c.box("chest", (0.31, 0.18, 0.22), (0, -0.01, 1.3), armor, bevel=0.03)
    c.box("chest", (0.22, 0.025, 0.1), (0, -0.105, 1.26), armor2, bevel=0.01)
    a, b = Vector((0.15, -0.115, 1.42)), Vector((-0.13, -0.12, 1.14))
    c.tube("chest", a, b, 0.02, 0.02, rubber, verts=6, scale_xy=(1.6, 0.6))
    for i in range(4):
        t = 0.18 + i * 0.2
        p = a.lerp(b, t) + Vector((0, -0.03, 0))
        c.tube("chest", p + Vector((0, 0, -0.07)), p + Vector((0, 0, 0.06)), 0.026, 0.026, shell, verts=10)
        c.tube("chest", p + Vector((0, 0, 0.06)), p + Vector((0, 0, 0.1)), 0.026, 0.008, shell, verts=10)
        c.tube("chest", p + Vector((0, 0, 0.0)), p + Vector((0, 0, 0.02)), 0.028, 0.028, band, verts=10)
    for sx in (-1, 1):
        c.ball("chest", 0.07, (sx * 0.19, 0, 1.38), armor2, scale=(1.0, 1.05, 0.7), seg=10)
    # 背中：砲弾を立てて並べた背負い枠（2 列 × 3 発。頭が黄色の帯）
    c.box("chest", (0.3, 0.04, 0.42), (0, 0.12, 1.22), armor2, bevel=0.012)  # 背板
    for sx in (-1, 1):
        for yy in (0.13, 0.29):
            c.tube("chest", (sx * 0.165, yy, 0.97), (sx * 0.165, yy, 1.44), 0.011, 0.011, metal, verts=6)  # 枠の柱
        for zz in (1.06, 1.3):
            c.tube("chest", (sx * 0.165, 0.13, zz), (sx * 0.165, 0.29, zz), 0.009, 0.009, metal, verts=6)  # 枠の横棒
    c.box("chest", (0.34, 0.2, 0.06), (0, 0.21, 0.98), metal, bevel=0.01)  # 底の受け
    for row in range(2):
        for i in range(3):
            x = -0.09 + i * 0.09
            y = 0.17 + row * 0.08
            c.tube("chest", (x, y, 1.01), (x, y, 1.27), 0.03, 0.03, shell, verts=10)
            c.tube("chest", (x, y, 1.27), (x, y, 1.33), 0.03, 0.01, shell, verts=10)
            c.tube("chest", (x, y, 1.22), (x, y, 1.245), 0.032, 0.032, band, verts=10)
    c.box("chest", (0.3, 0.012, 0.02), (0, 0.3, 1.18), glow, bevel=0.003)  # 背中の灯り
    c.box("spine", (0.25, 0.16, 0.15), (0, 0.0, 1.11), armor2, bevel=0.03)
    c.ball("hips", 0.12, (0, 0.012, 0.95), cloth, scale=(1.4, 1.1, 0.8), seg=14)
    for s_, side in ((1, "L"), (-1, "R")):
        c.limb("shin." + side, 0.056, 0.048, cloth, 0.0, 0.7)
        c.box("shin." + side, (0.08, 0.04, 0.18), Vector(bone_point("shin." + side, 0.35)) + Vector((0, -0.045, 0)), armor, bevel=0.012)
        c.limb("thigh." + side, 0.084, 0.068, cloth, 0.0, 0.95)
        c.box("thigh." + side, (0.06, 0.1, 0.14), Vector(bone_point("thigh." + side, 0.4)) + Vector((s_ * 0.07, 0, 0)), armor2, bevel=0.01)  # 脚のポーチ
        c.limb("upperarm." + side, 0.05, 0.044, cloth, 0.0, 1.0)
        c.limb("forearm." + side, 0.047, 0.042, armor2, 0.15, 0.85, verts=8, smooth=False)
    bc.belt(c, rubber, metal, pouches=armor2, n=5)
    bc.knee_pads(c, armor2, size=1.1)
    bc.gloves(c, rubber, fingerless=True)
    bc.boots(c, rubber, armor2, mat("GruntSole", "#0c0c0c", roughness=0.9), chunky=1.1)


HEAVY_HAND_TARGETS = {
    # 右手：腰だめの銃（盾の右の外）
    "R": ((-0.36, -0.24, 1.0), (-0.7, 0.2, 0.85)),
    # 左手：盾の取っ手
    "L": ((0.24, -0.5, 1.08), (0.6, 0.0, 0.8)),
}
HEAVY_HAND_DIRS = {
    "R": ((0.05, -0.75, -0.65), (-1, 0, 0)),
    "L": ((0.0, -0.3, -1.0), (1, 0, 0)),
}


def build_grunt_animations(c: Character, heavy=False):
    if heavy:
        arms = solve_arms(c, {"spine": (2, 0, 0), "neck": (0, 0, 0)}, HEAVY_HAND_TARGETS, HEAVY_HAND_DIRS)
        hold = pose_merge({"spine": (2, 0, 0)}, arms)
        stance = {"thigh.L": (4, 0, 8), "thigh.R": (-4, 0, -8), "shin.L": (-10, 0, 0), "shin.R": (-8, 0, 0), "foot.L": (5, 0, 0), "foot.R": (5, 0, 0)}
        idle0 = pose_merge(hold, stance, {"@hips_z": -0.02})
        idle1 = pose_merge(hold, stance, {"chest": (-1.5, 0, 0), "head": (2, 0, 0), "@hips_z": -0.026})
        make_action(c, "Idle", [(1, idle0), (36, idle1), (71, idle0)])
        n = 28
        make_action(c, "Run", [(1 + i, run_pose(hold, i / n, stride=0.55, lean=4)) for i in range(n + 1)])
        kick = pose_merge(hold, {"chest": (-2, 0, 0)})
        make_action(c, "Shoot", [(1, hold), (3, kick), (7, hold)])
        crouch = pose_merge(hold, {"thigh.L": (40, 0, 8), "shin.L": (-70, 0, 0), "foot.L": (25, 0, 0), "thigh.R": (40, 0, -8), "shin.R": (-70, 0, 0), "foot.R": (25, 0, 0)})
        low = bc.lowest_point(c, crouch)
        crouch["@hips_z"] = -(low - 0.03)
        make_action(c, "Crouch", [(1, crouch), (31, crouch)])
        make_action(c, "Jump", [(1, hold), (31, hold)])
        bc.make_death(c, hold)
        return
    arms = solve_arms(c, bc.TORSO_HOLD, bc.HAND_TARGETS, bc.HAND_DIRS)
    hold = pose_merge(bc.TORSO_HOLD, arms)
    stance = {"thigh.L": (4, 0, 6), "thigh.R": (-4, 0, -6), "shin.L": (-10, 0, 0), "shin.R": (-6, 0, 0), "foot.L": (4, 0, 0), "foot.R": (4, 0, 0)}
    idle0 = pose_merge(hold, stance, {"@hips_z": -0.015})
    idle1 = pose_merge(hold, stance, {"chest": (-1.5, 0, 0), "head": (2, 0, 0), "@hips_z": -0.02})
    make_action(c, "Idle", [(1, idle0), (36, idle1), (71, idle0)])
    # 銃を構えた小走り（パイロットより歩幅が小さく、前かがみ）
    n = 22
    make_action(c, "Run", [(1 + i, run_pose(hold, i / n, stride=0.72, lean=8)) for i in range(n + 1)])
    # しゃがんで構える
    crouch = pose_merge(
        hold,
        {"thigh.L": (70, 0, 6), "shin.L": (-100, 0, 0), "foot.L": (28, 0, 0), "thigh.R": (-10, 0, -8), "shin.R": (-120, 0, 0), "foot.R": (50, 0, 0), "spine": (8, 0, 0)},
    )
    low = bc.lowest_point(c, crouch)
    crouch["@hips_z"] = -(low - 0.03)
    make_action(c, "Crouch", [(1, crouch), (31, pose_merge(crouch, {"chest": (-1.5, 0, 0)})), (61, crouch)])
    kick = pose_merge(hold, {"chest": (-4, 0, 0), "head": (2, 0, 0)})
    make_action(c, "Shoot", [(1, hold), (3, kick), (7, hold)])
    jump = pose_merge(hold, {"thigh.L": (40, 0, 4), "shin.L": (-60, 0, 0), "thigh.R": (20, 0, -4), "shin.R": (-45, 0, 0)})
    make_action(c, "Jump", [(1, jump), (31, jump)])
    bc.make_death(c, hold)


VARIANTS = {
    "grunt": (build_grunt, False),
    "assault": (build_assault, False),
    "heavy": (build_heavy, True),
    "mortar": (build_mortar, False),
}


def main():
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    only = [a for a in args if not a.startswith("--")]
    for name, (build, heavy) in VARIANTS.items():
        if only and name not in only:
            continue
        if os.path.exists(os.path.join(HERE, "models", f"{name}.glb")) and "--legacy" not in args:
            print(f"{name}：取り込んだモデルを使う（build_imported.py）。ここでは作らない")
            continue
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bc._mats.clear()
        c = Character(name)
        build(c)
        c.join_by_bone()
        build_grunt_animations(c, heavy=heavy)
        bpy.context.scene.render.fps = bc.FPS
        out = os.path.join(bc.OUT_DIR, f"{name}.glb")
        bpy.ops.export_scene.gltf(
            filepath=out,
            export_format="GLB",
            export_yup=True,
            export_apply=True,
            export_animation_mode="NLA_TRACKS",
            export_force_sampling=True,
        )
        print(f"書き出し: {out} ({os.path.getsize(out) // 1024} KB)")
        if "--preview" in args:
            pdir = os.path.join(HERE, "preview")
            os.makedirs(pdir, exist_ok=True)
            bc.render_preview(c, os.path.join(pdir, f"{name}_front.png"))
            bc.render_turnaround(c, os.path.join(pdir, f"{name}_side.png"), "Idle", 1, 70)
            bc.render_turnaround(c, os.path.join(pdir, f"{name}_back.png"), "Idle", 1, 180)
            bc.render_turnaround(c, os.path.join(pdir, f"{name}_run.png"), "Run", 6, 60)
            bc.render_turnaround(c, os.path.join(pdir, f"{name}_death.png"), "Death", 31, 70)


if __name__ == "__main__":
    main()
