"""
遠くに見えるキャラクターと、その持つ武器の、面の数を減らしたモデル（LOD）を作る。
書き出し済みのキャラクター（client/assets/characters/<名前>.glb）を読み込み、部品ごとに面を減らして
<名前>_lod.glb に書き出す（骨と部品の名前・親子関係はそのまま。アニメーションは入れない。ゲーム側は元のモデルの骨で動かす）。

使い方：python assets-src/characters/build_lod.py [名前 ...]
"""

import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
OUT_DIR = os.path.join(ROOT, "client", "assets", "characters")
WEAPON_DIR = os.path.join(ROOT, "client", "assets", "weapons")
NAMES = ["meia", "pearl", "miranda", "sora", "alex", "ranmaru", "grunt", "assault", "heavy", "mortar"]
WEAPONS = ["ar", "lmg", "smg", "shotgun", "sniper", "pistol", "burst", "psmg", "spinlmg", "autosg", "marksman", "revolver"]
# 残す面の割合（部品ごと）。小さい部品は形が崩れないように、少し多めに残す
RATIO = 0.3


def tri_count(objs):
    n = 0
    for o in objs:
        me = o.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
        n += sum(len(p.vertices) - 2 for p in me.polygons)
        o.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh_clear()
    return n


def build(name, folder=OUT_DIR):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    src = os.path.join(folder, f"{name}.glb")
    bpy.ops.import_scene.gltf(filepath=src)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    before = tri_count(meshes)
    for o in meshes:
        faces = len(o.data.polygons)
        if faces < 24:
            continue  # とても小さい部品はそのまま
        ratio = RATIO if faces > 200 else 0.5
        mod = o.modifiers.new("Decimate", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = ratio
        mod.use_collapse_triangulate = True
    after = tri_count(meshes)
    # 動きは元のモデルのものを使うので、書き出さない
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)
    out = os.path.join(folder, f"{name}_lod.glb")
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_yup=True, export_apply=True, export_animations=False)
    print(f"書き出し: {out}（三角形 {before} → {after}、{os.path.getsize(out) // 1024} KB）")


def main():
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    for n in args or NAMES + WEAPONS:
        build(n, WEAPON_DIR if n in WEAPONS else OUT_DIR)


if __name__ == "__main__":
    main()
