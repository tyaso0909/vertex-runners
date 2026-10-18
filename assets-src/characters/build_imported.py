"""
取り込んだキャラクターのモデル（Tripo などで作った、テクスチャ付きの1つの形）に、
ゲームと同じ名前・同じ親子関係の骨と、同じアニメーションを付けて書き出すスクリプト。

使い方：
  python assets-src/characters/build_imported.py [名前 ...] [--preview] [--blend]
  （pip install bpy、Python 3.11。blender --background --python でも動く）
入力
  assets-src/characters/models/<id>.glb   元のモデル（T ポーズまたは A ポーズ、正面は -Y）
  assets-src/characters/models/rig.json   骨の位置を決める数字（キャラクターごと。下の bones() を参照）
出力（client/assets/characters/）
  <id>.glb      骨（Rig）・重み・アニメーション（Idle / Run / WallRun / Slide / Jump / Shoot / Ability / Death）
                テクスチャ 2048×2048、およそ 12,000 面
  <id>_lod.glb  遠くに見えるとき用（同じ骨。およそ 3,000 面。アニメーションなし。ゲームでは近く用のテクスチャを使う）
オプション
  --preview  assets-src/characters/preview/<id>_imported.png に確認用の画像（待機・走り・ジャンプ・スライディング）
  --blend    assets-src/characters/<id>_imported.blend も保存する

作り方
  1. 元のモデルを、高さ 1.7m・足元が原点・体の中心が Y=0 になるように置く（UV の切れ目で分かれた頂点はつなぐ）。
  2. 骨を T ポーズ（A ポーズ）のまま置く。骨の名前と親子関係は build_characters.py と同じ。
  3. 重み：細かい部品が多い形にはボーンヒートが直接は効かないので、ボクセルで作り直した閉じた代理の形で
     重みを求め、元の形へ写す。
  4. 重みの手直し：腕・脚の骨から離れた所（垂れた袖・マント・スカーフ・髪の先など）は、腕・脚ではなく
     胸・腰で動かす（腕を下ろしたり脚を振ったりしたときに、布が引き伸ばされないように）。そのあと少しならす。
  5. 腕を下ろした姿勢を「基本の姿勢」にする（ゲームの骨と同じ向き。build_characters.py の動きがそのまま使える）。
  6. 動きは build_characters.py の build_animations() で付ける（全キャラクター共通）。
  7. 面を減らし、テクスチャを縮めて書き出す。
"""

import json
import math
import os
import sys
import tempfile
import time
from types import SimpleNamespace

import bpy  # bmesh より先に読み込む
import bmesh  # noqa: E402
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SRC_DIR = os.path.join(HERE, "models")
OUT_DIR = os.path.join(ROOT, "client", "assets", "characters")
sys.path.insert(0, HERE)
import build_characters as bc  # noqa: E402  動き（build_animations）を使う

HEIGHT = 1.7
TRIS = 12000
LOD_TRIS = 3000
TEX = 2048
LOD_TEX = 128  # ゲームでは近く用のテクスチャを使うので、遠く用の分は小さくてよい
VOXELS = (0.012, 0.015, 0.02, 0.025, 0.03)
# 腕・脚の骨からこの距離（m）より離れた所は、胸・腰で動かす（FADE の幅で少しずつ切り替える）
ARM_R, ARM_FADE = 0.09, 0.07
LEG_R, LEG_FADE = 0.14, 0.08
# 脚の左右の取り違えを直す幅（体の中心から |x| がこれ以上なら、反対側の脚の骨の重みを全部移す）
SIDE_FADE = 0.03
# ゲームの骨（build_characters.BONES）の、腕を下ろした向き
GAME_DIRS = {
    "upperarm": Vector((0.03, 0, -0.27)),
    "forearm": Vector((0.02, -0.01, -0.24)),
    "hand": Vector((0.005, -0.005, -0.09)),
}


def bones(p):
    """骨の位置（体の中心が Y=0 の座標）。p は rig.json の1人分
    y0: 元のモデルでの体の中心線の前後（-Y が前）  hip/knee/ankle: 高さ  legx/kneex/anklex: 左右の位置
    sh: 肩の高さ  shx/el/wr/tip: 肩・ひじ・手首・指先の左右の位置  slope: 腕の傾き  ay: 腕の前後  chest/neck/headb/top: 胴と頭
    （任意）wr_y/tip_y：手首・指先の前後の位置（腕が前へ曲がっているモデル）
    （任意）anims："grunt" なら歩兵の動き（build_grunt.py。待機・走り・射撃・しゃがみ・ジャンプ・倒れる）
    （任意）anims："heavy" なら重装兵の動き（盾を構える）。hand_targets で手を置く位置（骨の座標）を変えられる
    （任意）shield：盾のモデル（file）を腰の骨に付ける。center [x, y]・z0・z1 は骨の座標（拡大する前）。テクスチャは体と1枚にまとめる
    （任意）scale：書き出すときの全体の大きさ（骨格ごと拡大する）
    （任意）team_map：テクスチャの水色の灯りを、ゲームでチームの色に光らせる（マテリアルの名前を "TeamGlowMap" にする）
    （任意）arm_r/arm_fade・leg_r/leg_fade：腕・脚の骨からこの距離より離れた所は胸・腰で動かす（脚の細いキャラクターは小さく）"""
    y0 = 0.0
    ay = p["ay"] - p["y0"]

    def az(x):
        return p["sh"] + p["slope"] * (abs(x) - p["shx"])

    J = {
        "hips": ((0, y0, p["hip"]), (0, y0, p["hip"] + 0.12), None),
        "spine": ((0, y0, p["hip"] + 0.12), (0, y0 + 0.01, p["chest"]), "hips"),
        "chest": ((0, y0 + 0.01, p["chest"]), (0, y0, p["neck"]), "spine"),
        "neck": ((0, y0, p["neck"]), (0, y0 + 0.005, p["headb"]), "chest"),
        "head": ((0, y0 + 0.005, p["headb"]), (0, y0 + 0.005, p["top"]), "neck"),
    }
    for s, k in (("L", 1), ("R", -1)):
        J[f"shoulder.{s}"] = ((k * 0.03, ay, p["sh"] + 0.008), (k * (p["shx"] - 0.005), ay, az(p["shx"])), "chest")
        J[f"upperarm.{s}"] = ((k * p["shx"], ay, az(p["shx"])), (k * p["el"], ay, az(p["el"])), f"shoulder.{s}")
        wy = p["wr_y"] - p["y0"] if "wr_y" in p else ay - 0.005  # 手首・指先の前後（腕が前へ曲がっているモデル用）
        ty = p["tip_y"] - p["y0"] if "tip_y" in p else ay - 0.01
        J[f"forearm.{s}"] = ((k * p["el"], ay, az(p["el"])), (k * p["wr"], wy, az(p["wr"])), f"upperarm.{s}")
        J[f"hand.{s}"] = ((k * p["wr"], wy, az(p["wr"])), (k * p["tip"], ty, az(p["tip"])), f"forearm.{s}")
        J[f"thigh.{s}"] = ((k * p["legx"], y0, p["hip"] - 0.02), (k * p["kneex"], y0 - 0.015, p["knee"]), "hips")
        J[f"shin.{s}"] = ((k * p["kneex"], y0 - 0.015, p["knee"]), (k * p["anklex"], y0 + 0.01, p["ankle"]), f"thigh.{s}")
        J[f"foot.{s}"] = ((k * p["anklex"], y0 + 0.01, p["ankle"]), (k * (p["anklex"] + 0.02), y0 - p["toe"], 0.03), f"shin.{s}")
    return J


# ---------------------------------------------------------------------------
# 読み込み
# ---------------------------------------------------------------------------


def load_model(cid, p):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.path.join(SRC_DIR, f"{cid}.glb"))
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    for o in meshes:
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
    for o in [o for o in bpy.data.objects if o.type != "MESH"]:
        bpy.data.objects.remove(o)
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = cid
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    # 高さ 1.7m、足元が原点、体の中心が Y=0
    vs = [v.co for v in o.data.vertices]
    mn = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs)))
    mx = Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
    k = HEIGHT / (mx.z - mn.z)
    o.data.transform(Matrix.Translation((0, -p["y0"], 0)) @ Matrix.Scale(k, 4) @ Matrix.Translation((-(mn.x + mx.x) / 2, -(mn.y + mx.y) / 2, -mn.z)))
    # UV の切れ目で分かれている頂点をつなぐ（UV は面ごとに持つので崩れない）
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0002)
    bm.to_mesh(o.data)
    bm.free()
    for poly in o.data.polygons:
        poly.use_smooth = True
    return o


def make_rig(p):
    ad = bpy.data.armatures.new("Rig")
    rig = bpy.data.objects.new("Rig", ad)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    eb = {}
    for name, (h, t, parent) in bones(p).items():
        b = ad.edit_bones.new(name)
        b.head = h
        b.tail = t
        b.align_roll(Vector((0, -1, 0)))
        if parent:
            b.parent = eb[parent]
            b.use_connect = False
        eb[name] = b
    bpy.ops.object.mode_set(mode="OBJECT")
    return rig


# ---------------------------------------------------------------------------
# 重み
# ---------------------------------------------------------------------------


def _big_parts(obj, frac=0.03):
    """小さな離れた部品（ボーンヒートを失敗させる）を取り除き、大きな部品だけ残す"""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    seen = set()
    best = []
    for v in bm.verts:
        if v.index in seen:
            continue
        stack, comp = [v], []
        while stack:
            x = stack.pop()
            if x.index in seen:
                continue
            seen.add(x.index)
            comp.append(x)
            for e in x.link_edges:
                y = e.other_vert(x)
                if y.index not in seen:
                    stack.append(y)
        best.append(comp)
    total = sum(len(c) for c in best)
    keep = set(v for c in best if len(c) >= total * frac for v in c)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v not in keep], context="VERTS")
    bm.to_mesh(obj.data)
    bm.free()


def auto_weights(o, rig):
    """閉じた代理の形でボーンヒートの重みを求め、元の形へ写す"""
    for voxel in VOXELS:
        px = o.copy()
        px.data = o.data.copy()
        px.name = "Proxy"
        bpy.context.collection.objects.link(px)
        bpy.context.view_layer.objects.active = px
        r = px.modifiers.new("R", "REMESH")
        r.mode = "VOXEL"
        r.voxel_size = voxel
        bpy.ops.object.modifier_apply(modifier="R")
        _big_parts(px)
        zs = [v.co.z for v in px.data.vertices]
        if not zs or max(zs) - min(zs) < HEIGHT * 0.85:
            bpy.data.objects.remove(px)
            continue
        bpy.ops.object.select_all(action="DESELECT")
        px.select_set(True)
        rig.select_set(True)
        bpy.context.view_layer.objects.active = rig
        bpy.ops.object.parent_set(type="ARMATURE_AUTO")
        ok = sum(1 for v in px.data.vertices if v.groups) > len(px.data.vertices) * 0.95
        if ok:
            break
        bpy.data.objects.remove(px)
    else:
        raise RuntimeError("ボーンヒートの重みが求まらない")
    print(f"  重み：代理の形 {len(px.data.polygons)} 面（ボクセル {voxel}m）")
    o.vertex_groups.clear()
    for g in px.vertex_groups:
        o.vertex_groups.new(name=g.name)
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    dt = o.modifiers.new("DT", "DATA_TRANSFER")
    dt.object = px
    dt.use_vert_data = True
    dt.data_types_verts = {"VGROUP_WEIGHTS"}
    dt.vert_mapping = "POLYINTERP_NEAREST"
    dt.layers_vgroup_select_src = "ALL"
    dt.layers_vgroup_select_dst = "NAME"
    bpy.ops.object.datalayout_transfer(modifier="DT")
    bpy.ops.object.modifier_apply(modifier="DT")
    bpy.data.objects.remove(px)


def _seg_dist(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
    return (a + ab * t - p).length


def _smooth01(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def fix_weights(o, rig, p):
    """腕・脚の骨から離れた所（垂れた布・髪など）は、胸・腰で動かす。そのあと少しならす"""
    seg = {b.name: (b.head_local.copy(), b.tail_local.copy()) for b in rig.data.bones}
    names = {g.index: g.name for g in o.vertex_groups}
    G = {g.name: g for g in o.vertex_groups}
    chains = []
    for s in ("L", "R"):
        chains.append(([f"upperarm.{s}", f"forearm.{s}", f"hand.{s}"], "chest", p.get("arm_r", ARM_R), p.get("arm_fade", ARM_FADE)))
        chains.append(([f"thigh.{s}", f"shin.{s}"], "hips", p.get("leg_r", LEG_R), p.get("leg_fade", LEG_FADE)))
    moved = 0
    for v in o.data.vertices:
        w = {names[g.group]: g.weight for g in v.groups if g.weight > 0}
        changed = False
        # 左右の取り違え：脚が近い（代理の形で左右の脚がくっつく）と、左の脚に右の脚の骨の重みが付く。
        # 体の中心から離れた頂点では、反対側の脚の骨の重みを同じ側の骨へ移す
        side = _smooth01(0.0, SIDE_FADE, abs(v.co.x))
        if side > 0:
            mine, other = ("L", "R") if v.co.x > 0 else ("R", "L")
            for b in ("thigh", "shin", "foot"):
                wo = w.get(f"{b}.{other}", 0.0)
                if wo > 0:
                    m = wo * side
                    w[f"{b}.{other}"] = wo - m
                    w[f"{b}.{mine}"] = w.get(f"{b}.{mine}", 0.0) + m
                    changed = True
        for bones_, target, R, F in chains:
            lw = sum(w.get(b, 0.0) for b in bones_)
            if lw <= 0:
                continue
            d = min(_seg_dist(v.co, *seg[b]) for b in bones_)
            f = _smooth01(R, R + F, d)
            if f <= 0:
                continue
            for b in bones_:
                if b in w:
                    m = w[b] * f
                    w[b] -= m
                    w[target] = w.get(target, 0.0) + m
            changed = True
        if changed:
            moved += 1
            for name, val in w.items():
                G[name].add([v.index], val, "REPLACE")
    print(f"  重みの手直し：{moved} 頂点（腕・脚から離れた布や髪）")
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.mode_set(mode="WEIGHT_PAINT")
    bpy.ops.object.vertex_group_smooth(group_select_mode="ALL", factor=0.5, repeat=2)
    bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
    bpy.ops.object.vertex_group_normalize_all(lock_active=False)
    bpy.ops.object.mode_set(mode="OBJECT")


# ---------------------------------------------------------------------------
# 腕を下ろした姿勢を基本の姿勢にする
# ---------------------------------------------------------------------------


def to_game_rest(o, rig):
    am = o.modifiers.new("Armature", "ARMATURE")
    am.object = rig
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="POSE")
    for s, k in (("L", 1), ("R", -1)):
        for b in ("upperarm", "forearm", "hand"):
            pb = rig.pose.bones[f"{b}.{s}"]
            d = GAME_DIRS[b].copy()
            d.x *= k
            cur = (pb.tail - pb.head).normalized()
            q = cur.rotation_difference(d.normalized())
            h = pb.head.copy()
            pb.matrix = Matrix.Translation(h) @ q.to_matrix().to_4x4() @ Matrix.Translation(-h) @ pb.matrix
            bpy.context.view_layer.update()
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.modifier_apply(modifier="Armature")
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode="EDIT")
    for b in rig.data.edit_bones:
        b.align_roll(Vector((0, -1, 0)))
    bpy.ops.object.mode_set(mode="OBJECT")
    for pb in rig.pose.bones:
        pb.rotation_mode = "XYZ"
    o.parent = rig
    am = o.modifiers.new("Armature", "ARMATURE")
    am.object = rig


# ---------------------------------------------------------------------------
# 面を減らす・テクスチャ
# ---------------------------------------------------------------------------


def decimated_copy(o, tris, name):
    c = o.copy()
    c.data = o.data.copy()
    c.name = name
    bpy.context.collection.objects.link(c)
    n = sum(len(p.vertices) - 2 for p in c.data.polygons)
    if n > tris:
        bpy.context.view_layer.objects.active = c
        d = c.modifiers.new("Dec", "DECIMATE")
        d.ratio = tris / n
        bpy.ops.object.modifier_move_to_index(modifier="Dec", index=0)
        bpy.ops.object.modifier_apply(modifier="Dec")
    return c


def base_image(o):
    for m in o.data.materials:
        if m and m.node_tree:
            for n in m.node_tree.nodes:
                if n.type == "TEX_IMAGE" and n.image:
                    return n.image
    raise RuntimeError("テクスチャが見つからない")


def textured_material(name, src_img, size):
    """元の色のテクスチャを size に縮めて、新しいマテリアルを作る"""
    if size is None:
        im = src_img  # そのまま使う（atlas_material で作った画像）
    else:
        tmp = os.path.join(tempfile.gettempdir(), f"{name}.jpg")
        img = src_img.copy()
        img.scale(size, size)
        img.filepath_raw = tmp
        img.file_format = "JPEG"
        img.save(filepath=tmp, quality=90)  # 色の変換をしない保存（save_render は表示用の色の変換がかかる）
        bpy.data.images.remove(img)
        im = bpy.data.images.load(tmp)
    im.name = name
    im.pack()
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 0.62
    bsdf.inputs["Metallic"].default_value = 0.05
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = im
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    return m


def load_prop(path):
    """小物（盾など）を今のシーンに読み込み、1つの形にまとめて返す"""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH"]
    for o in meshes:
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
    for o in new:
        if o.type != "MESH":
            bpy.data.objects.remove(o)
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0002)
    bm.to_mesh(o.data)
    bm.free()
    return o


def place_shield(o, sp):
    """盾を、骨の座標（拡大する前）の決めた所に置く。sp：center [x, y]・z0・z1（下端と上端の高さ）"""
    vs = [v.co for v in o.data.vertices]
    mn = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs)))
    mx = Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
    k = (sp["z1"] - sp["z0"]) / (mx.z - mn.z)
    o.data.transform(
        Matrix.Translation((sp["center"][0], sp["center"][1], sp["z0"]))
        @ Matrix.Scale(k, 4)
        @ Matrix.Translation((-(mn.x + mx.x) / 2, -(mn.y + mx.y) / 2, -mn.z))
    )
    for poly in o.data.polygons:
        poly.use_smooth = True
    w = (mx.x - mn.x) * k
    print(f"  盾：幅 {w:.3f}・高さ {sp['z1'] - sp['z0']:.3f}・厚さ {(mx.y - mn.y) * k:.3f}（骨の座標）")


def _pixels(img, w, h):
    import numpy as np

    c = img.copy()
    c.scale(w, h)
    a = np.empty(w * h * 4, dtype=np.float32)
    c.pixels.foreach_get(a)
    bpy.data.images.remove(c)
    return a.reshape(h, w, 4)


def atlas_material(name, body_img, prop_img, size):
    """体（上 2/3）と小物（下 1/3）のテクスチャを1枚にまとめる（幅 size・高さ size×1.5）。
    UV は remap_uv で合わせる"""
    import numpy as np

    top = _pixels(body_img, size, size)
    bottom = _pixels(prop_img, size, size // 2)
    arr = np.concatenate([bottom, top], axis=0)  # Blender の画像は下の行から
    im = bpy.data.images.new(name, size, size + size // 2)
    im.pixels.foreach_set(arr.ravel())
    tmp = os.path.join(tempfile.gettempdir(), f"{name}.jpg")
    im.filepath_raw = tmp
    im.file_format = "JPEG"
    im.save(filepath=tmp, quality=90)
    bpy.data.images.remove(im)
    return textured_material(name, bpy.data.images.load(tmp), None)


def remap_uv(obj, v0, v1):
    """UV の縦を [v0, v1] に縮める（まとめたテクスチャの中の、その形の場所）"""
    for layer in obj.data.uv_layers:
        for d in layer.data:
            d.uv = (d.uv[0], v0 + d.uv[1] * (v1 - v0))


def attach_prop(body, prop, bone="hips"):
    """小物を体に1つの形としてまとめ、すべて bone の骨で動かす（体の重みはそのまま）"""
    g = prop.vertex_groups.new(name=bone)
    g.add([v.index for v in prop.data.vertices], 1.0, "REPLACE")
    bpy.ops.object.select_all(action="DESELECT")
    prop.select_set(True)
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()


def set_material(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    for p in obj.data.polygons:
        p.material_index = 0


# ---------------------------------------------------------------------------
# 書き出し・確認用の画像
# ---------------------------------------------------------------------------


def export(objs, path, animations):
    bpy.ops.object.select_all(action="DESELECT")
    for x in objs:
        x.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    kw = dict(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_image_format="JPEG",
        export_jpeg_quality=88,
    )
    if animations:
        kw.update(export_animation_mode="NLA_TRACKS", export_force_sampling=True)
    else:
        kw.update(export_animations=False)
    bpy.ops.export_scene.gltf(**kw)
    print(f"  書き出し: {os.path.relpath(path, ROOT)} ({os.path.getsize(path) // 1024} KB)")


def render_preview(cid, rig, path):
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.samples = 12
    sc.cycles.use_denoising = False
    sc.render.resolution_x, sc.render.resolution_y = 440, 640
    w = bpy.data.worlds.new("W")
    sc.world = w
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs["Color"].default_value = (0.55, 0.57, 0.62, 1)
    cd = bpy.data.cameras.new("C")
    cd.type = "ORTHO"
    k = rig.scale[0]  # 大きいキャラクター（重装兵）は引いて撮る
    cd.ortho_scale = 2.2 * k
    cam = bpy.data.objects.new("C", cd)
    sc.collection.objects.link(cam)
    cam.location = (-3.2, -5.6, 1.1 * k)
    cam.rotation_euler = (math.radians(88), 0, math.radians(-30))
    sc.camera = cam
    for loc, e in (((2, -3, 3), 500), ((-3, -1, 2), 250), ((0, 3, 2), 300)):
        ld = bpy.data.lights.new("L", "AREA")
        ld.energy = e
        ld.size = 3
        lo = bpy.data.objects.new("L", ld)
        lo.location = loc
        lo.rotation_euler = (Vector((0, 0, 1)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        sc.collection.objects.link(lo)
    names = {t.name for t in rig.animation_data.nla_tracks}
    shots = [("Idle", 1), ("Run", 5), ("Run", 14), ("WallRun", 5), ("Jump", 1), ("Slide", 1), ("Crouch", 1), ("Shoot", 3), ("Death", 31)]
    shots = [x for x in shots if x[0] in names][:7]
    files = []
    for i, (tr, f) in enumerate(shots):
        for t in rig.animation_data.nla_tracks:
            t.mute = t.name != tr
        sc.frame_set(f)
        bpy.context.view_layer.update()
        fp = os.path.join(tempfile.gettempdir(), f"{cid}_pv{i}.png")
        sc.render.filepath = fp
        bpy.ops.render.render(write_still=True)
        files.append(fp)
    for t in rig.animation_data.nla_tracks:
        t.mute = False
    # 横に並べて1枚にする
    import numpy as np

    imgs = [bpy.data.images.load(f) for f in files]
    W, H = imgs[0].size
    arrs = []
    for im in imgs:
        a = np.empty(W * H * 4, dtype=np.float32)
        im.pixels.foreach_get(a)
        arrs.append(a.reshape(H, W, 4))
    sheet = np.concatenate(arrs, axis=1)
    out = bpy.data.images.new("sheet", W * len(imgs), H)
    out.pixels.foreach_set(sheet.ravel())
    out.filepath_raw = path
    out.file_format = "PNG"
    out.save()
    print(f"  確認用の画像: {os.path.relpath(path, ROOT)}")


# ---------------------------------------------------------------------------


def build(cid, p, preview=False, blend=False):
    t0 = time.time()
    print(f"[{cid}]")
    o = load_model(cid, p)
    print(f"  元の形：{len(o.data.vertices)} 頂点、{sum(len(q.vertices) - 2 for q in o.data.polygons)} 面")
    src_img = base_image(o)
    rig = make_rig(p)
    auto_weights(o, rig)
    fix_weights(o, rig, p)
    to_game_rest(o, rig)
    # 動き（全キャラクター共通）
    if p.get("anims") in ("grunt", "heavy"):
        import build_grunt

        if "hand_targets" in p:  # 重装兵：盾の取っ手の位置に合わせて手を置く
            build_grunt.HEAVY_HAND_TARGETS = {k: tuple(tuple(x) for x in v) for k, v in p["hand_targets"].items()}
        build_grunt.build_grunt_animations(SimpleNamespace(rig=rig, cid=cid), heavy=p["anims"] == "heavy")
    else:
        bc.build_animations(SimpleNamespace(rig=rig, cid=cid))
    bpy.context.scene.render.fps = bc.FPS
    # 近く用・遠く用
    body = decimated_copy(o, TRIS, f"{cid}_body")
    lod = decimated_copy(o, LOD_TRIS, f"{cid}_lod")
    sp = p.get("shield")
    if sp:
        # 盾：別のモデルを読み込んで置き、腰の骨で動かす。テクスチャは体と1枚にまとめる（マテリアルを1つにするため）
        shield = load_prop(os.path.join(SRC_DIR, sp["file"]))
        shield_img = base_image(shield)
        place_shield(shield, sp)
        parts = []
        for target, tris in ((body, sp.get("tris", 2500)), (lod, sp.get("lod_tris", 500))):
            sh = decimated_copy(shield, tris, f"{cid}_shield")
            remap_uv(target, 1 / 3, 1.0)
            remap_uv(sh, 0.0, 1 / 3)
            set_material(target, bpy.data.materials.new("tmp"))
            set_material(sh, bpy.data.materials.new("tmp"))
            attach_prop(target, sh)
            parts.append(target)
        bpy.data.objects.remove(shield)
        body_mat = atlas_material(f"{cid}_tex", src_img, shield_img, TEX)
        lod_mat = atlas_material(f"{cid}_lodtex", src_img, shield_img, LOD_TEX)
    else:
        body_mat = textured_material(f"{cid}_tex", src_img, TEX)
        lod_mat = textured_material(f"{cid}_lodtex", src_img, LOD_TEX)
    if p.get("team_map"):
        body_mat.name = "TeamGlowMap"  # ゲーム側で、テクスチャの水色の所をチームの色に光らせる印
    set_material(body, body_mat)
    set_material(lod, lod_mat)
    for x in (body, lod):
        x.parent = rig
        for m in list(x.modifiers):
            x.modifiers.remove(m)
        am = x.modifiers.new("Armature", "ARMATURE")
        am.object = rig
    bpy.data.objects.remove(o)
    # 全体の大きさ（骨と動きは 1.7m の体で作り、書き出すときに骨格ごと拡大する。重装兵は大きい）
    rig.scale = (p.get("scale", 1.0),) * 3
    os.makedirs(OUT_DIR, exist_ok=True)
    lod.hide_set(True)
    export([rig, body], os.path.join(OUT_DIR, f"{cid}.glb"), True)
    lod.hide_set(False)
    body.hide_set(True)
    export([rig, lod], os.path.join(OUT_DIR, f"{cid}_lod.glb"), False)
    body.hide_set(False)
    lod.hide_set(True)
    if blend:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, f"{cid}_imported.blend"))
    if preview:
        pdir = os.path.join(HERE, "preview")
        os.makedirs(pdir, exist_ok=True)
        render_preview(cid, rig, os.path.join(pdir, f"{cid}_imported.png"))
    print(f"  {time.time() - t0:.0f} 秒")


def main():
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    only = [a for a in args if not a.startswith("--")]
    with open(os.path.join(SRC_DIR, "rig.json"), encoding="utf-8") as f:
        params = json.load(f)
    for cid, p in params.items():
        if only and cid not in only:
            continue
        build(cid, p, preview="--preview" in args, blend="--blend" in args)


if __name__ == "__main__":
    main()
