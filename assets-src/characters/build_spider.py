"""
6本脚のクモ型の爆弾ロボット（assets-src/characters/models/spider.glb。Tripo で作成）から、
タワーディフェンスの「爆弾兵」と、消耗戦のブースト「ティック」のモデルを作るスクリプト。

使い方：
  python assets-src/characters/build_spider.py [bomber] [tick] [--preview]
  （pip install bpy、Python 3.11。blender --background --python でも動く）
出力
  client/assets/characters/assault.glb      爆弾兵（敵の種類 assault）。高さ 0.8m（普通の兵士の約半分）。
                                            骨：hips（胴）と leg0〜leg5（脚。付け根で回る）。動き：Idle / Run / Jump / Death
                                            マテリアルの名前 "GlowRedMap"：ゲームでテクスチャの赤い灯り（目など）を光らせる
  client/assets/characters/assault_lod.glb  遠く用（同じ骨。面を減らす）
  client/assets/props/tick.glb              ティック（高さ 0.8m。爆弾兵と同じ大きさ）。部品に分ける：TickBody（胴と赤い目。目のマテリアルは "TkRed"）と
                                            TickLeg0〜5（付け根が原点。ゲーム側 boostViews.ts で振って歩かせる）。正面は Blender の +Y

作り方
  1. 元のモデルを、足元が原点・体の中心が X=Y=0 に置く。UV の切れ目で分かれた頂点はつなぐ。
  2. つながった部品ごとに、胴か脚かを分ける：中心から離れていて（水平の距離 > LEG_R）低い（高さ < LEG_Z）部品が脚。
     脚は、6本の脚の向き（いちばん外の大きな部品の向き）のうち近いものに割り当てる。
  3. 脚の付け根（回る中心）は、その脚のいちばん内側の点。
  4. 爆弾兵：胴を hips、脚を legK の骨で動かす（1つの部品は1つの骨だけ）。動きは下の make_bomber_actions。
     ティック：胴・脚ごとに別の形に分け、胴の赤い灯りの面を "TkRed" のマテリアルにする（ゲームで点滅させる）。
"""

import math
import os
import sys
import tempfile

import bpy  # bmesh より先に読み込む
import bmesh  # noqa: E402
from mathutils import Matrix, Quaternion, Vector  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SRC = os.path.join(HERE, "models", "spider.glb")
CHAR_DIR = os.path.join(ROOT, "client", "assets", "characters")
PROP_DIR = os.path.join(ROOT, "client", "assets", "props")
FPS = 30

BOMBER_HEIGHT = 0.8  # 普通の兵士（1.7m）の約半分
# 胴と脚の分け方（元のモデルの大きさで。元は高さ 0.64・幅 1.0）
LEG_R = 0.17
LEG_Z = 0.30
# 赤い灯りとみなすテクスチャの色（赤 − 緑と青の大きい方。sRGB）
RED_MIN = 0.42


# ---------------------------------------------------------------------------
# 読み込みと、胴・脚への分け方
# ---------------------------------------------------------------------------


def load(scale_to=None, width_to=None, flip=False):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=SRC)
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
    o.name = "spider"
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    vs = [v.co for v in o.data.vertices]
    mn = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs)))
    mx = Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
    o.data.transform(Matrix.Translation((-(mn.x + mx.x) / 2, -(mn.y + mx.y) / 2, -mn.z)))
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0002)
    bm.to_mesh(o.data)
    bm.free()
    for poly in o.data.polygons:
        poly.use_smooth = True
    # 分け方は元の大きさで決めるので、拡大は分けたあと（ここでは倍率だけ返す）
    if scale_to:
        k = scale_to / (mx.z - mn.z)
    elif width_to:
        k = width_to / (mx.x - mn.x)
    else:
        k = 1.0
    return o, k


def parts_of(o):
    """つながった部品（頂点の番号のリスト）と、部品ごとの面"""
    me = o.data
    parent = list(range(len(me.vertices)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for e in me.edges:
        a, b = find(e.vertices[0]), find(e.vertices[1])
        if a != b:
            parent[a] = b
    comps = {}
    for i in range(len(me.vertices)):
        comps.setdefault(find(i), []).append(i)
    return list(comps.values())


def classify(o):
    """頂点ごとに、胴（-1）か脚（0〜5）かを決める。脚の付け根の位置も返す。
    脚の番号：本人の右（-X）の前・中・後が 0・1・2、左（+X）の前・中・後が 3・4・5（前は -Y）"""
    me = o.data
    co = [v.co.copy() for v in me.vertices]
    comps = parts_of(o)
    info = []
    for c in comps:
        cx = sum(co[i].x for i in c) / len(c)
        cy = sum(co[i].y for i in c) / len(c)
        cz = sum(co[i].z for i in c) / len(c)
        info.append((c, Vector((cx, cy, cz))))
    legs = [(c, m) for c, m in info if math.hypot(m.x, m.y) > LEG_R and m.z < LEG_Z]
    # 脚の向き：いちばん外の大きな部品 6 つ
    outer = sorted([(c, m) for c, m in legs if math.hypot(m.x, m.y) > 0.3], key=lambda x: -len(x[0]))[:6]
    if len(outer) != 6:
        raise RuntimeError(f"脚が 6 本見つからない（{len(outer)}）")
    dirs = [math.atan2(m.y, m.x) for _, m in outer]
    # 番号：右（x<0）を前から、次に左を前から
    order = sorted(range(6), key=lambda i: (math.cos(dirs[i]) > 0, math.sin(dirs[i])))
    dirs = [dirs[i] for i in order]
    owner = [-1] * len(co)
    for c, m in legs:
        a = math.atan2(m.y, m.x)
        k = min(range(6), key=lambda i: abs(math.remainder(a - dirs[i], 2 * math.pi)))
        for i in c:
            owner[i] = k
    pivots = []
    for k in range(6):
        idx = [i for i in range(len(co)) if owner[i] == k]
        rs = sorted(idx, key=lambda i: math.hypot(co[i].x, co[i].y))
        inner = rs[: max(3, len(rs) // 30)]
        r0 = sum(math.hypot(co[i].x, co[i].y) for i in inner) / len(inner)
        z0 = sum(co[i].z for i in inner) / len(inner)
        pivots.append(Vector((math.cos(dirs[k]) * r0, math.sin(dirs[k]) * r0, z0)))
    print(f"  部品 {len(comps)}・脚の部品 {len(legs)}・脚の向き {[round(math.degrees(d)) for d in dirs]}")
    return owner, pivots, dirs


def scale_all(o, pivots, k, flip=False):
    m = Matrix.Scale(k, 4)
    if flip:
        m = Matrix.Rotation(math.pi, 4, "Z") @ m
    o.data.transform(m)
    return [m @ p for p in pivots]


# ---------------------------------------------------------------------------
# テクスチャ
# ---------------------------------------------------------------------------


def base_image(o):
    for m in o.data.materials:
        if m and m.node_tree:
            for n in m.node_tree.nodes:
                if n.type == "TEX_IMAGE" and n.image:
                    return n.image
    raise RuntimeError("テクスチャが見つからない")


def scaled_image(src, name, size):
    tmp = os.path.join(tempfile.gettempdir(), f"{name}.jpg")
    img = src.copy()
    img.scale(size, size)
    img.filepath_raw = tmp
    img.file_format = "JPEG"
    img.save(filepath=tmp, quality=90)
    bpy.data.images.remove(img)
    im = bpy.data.images.load(tmp)
    im.name = name
    im.pack()
    return im


def tex_material(name, img, emission=None, strength=0.0, rough=0.55, metal=0.3):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    t = nt.nodes.new("ShaderNodeTexImage")
    t.image = img
    nt.links.new(t.outputs["Color"], b.inputs["Base Color"])
    if emission:
        b.inputs["Emission Color"].default_value = (*emission, 1)
        b.inputs["Emission Strength"].default_value = strength
    return m


def red_faces(o, img):
    """テクスチャの赤い灯りが貼られている面（面の UV の中心の色で決める）"""
    import numpy as np

    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)
    uv = o.data.uv_layers.active.data
    out = set()
    for p in o.data.polygons:
        u = sum(uv[li].uv[0] for li in p.loop_indices) / p.loop_total
        v = sum(uv[li].uv[1] for li in p.loop_indices) / p.loop_total
        c = px[min(h - 1, max(0, int(v * h))), min(w - 1, max(0, int(u * w)))]
        # Blender の画像の色は線形なので、sRGB に戻して比べる
        s = [x ** (1 / 2.2) for x in c[:3]]
        if s[0] - max(s[1], s[2]) > RED_MIN:
            out.add(p.index)
    return out


# ---------------------------------------------------------------------------
# 爆弾兵（骨と動き）
# ---------------------------------------------------------------------------


def make_rig(pivots, body_z):
    ad = bpy.data.armatures.new("Rig")
    rig = bpy.data.objects.new("Rig", ad)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    hips = ad.edit_bones.new("hips")
    hips.head = (0, 0, body_z)
    hips.tail = (0, 0, body_z + 0.1)
    for k, p in enumerate(pivots):
        b = ad.edit_bones.new(f"leg{k}")
        b.head = p
        b.tail = p + Vector((0, 0, 0.06))
        b.parent = hips
        b.use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")
    for pb in rig.pose.bones:
        pb.rotation_mode = "QUATERNION"
    return rig


def bind(o, rig, owner):
    o.vertex_groups.clear()
    g = {"hips": o.vertex_groups.new(name="hips")}
    for k in range(6):
        g[k] = o.vertex_groups.new(name=f"leg{k}")
    body = [i for i, k in enumerate(owner) if k < 0]
    g["hips"].add(body, 1.0, "REPLACE")
    for k in range(6):
        g[k].add([i for i, kk in enumerate(owner) if kk == k], 1.0, "REPLACE")
    o.parent = rig
    am = o.modifiers.new("Armature", "ARMATURE")
    am.object = rig


def pose(rig, dirs, pivots, body_z, legs, hips_dz=0.0, hips_tilt=0.0):
    """legs[k] = (振り, 上げ)（ラジアン）。振り：前へ +（水平に回す）、上げ：先を上げる +"""
    hp = rig.pose.bones["hips"]
    hp.location = (0, 0, 0)
    hp.rotation_quaternion = (1, 0, 0, 0)
    bpy.context.view_layer.update()
    # 胴：上下と前後の傾き（ボーンの Y が上向き。上下は local の Y）
    hp.location = (0, hips_dz, 0)
    hp.rotation_quaternion = Quaternion((1, 0, 0), hips_tilt)
    bpy.context.view_layer.update()
    hm = hp.matrix @ rig.data.bones["hips"].matrix_local.inverted()  # 胴が動いた分（骨格の座標）
    for k in range(6):
        pb = rig.pose.bones[f"leg{k}"]
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.location = (0, 0, 0)
    bpy.context.view_layer.update()
    for k in range(6):
        swing, lift = legs[k]
        a = dirs[k]
        p = pivots[k]
        # 前（-Y）へ動かす向きの回転：先の動く向き（-sin a, cos a）の Y が負になるように
        fw = -1.0 if math.cos(a) > 0 else 1.0
        r_swing = Matrix.Rotation(swing * fw, 4, "Z")
        tangent = Vector((-math.sin(a), math.cos(a), 0))
        r_lift = Matrix.Rotation(-lift, 4, tangent)  # 接線のまわりに負に回すと、先が上がる
        rest = rig.data.bones[f"leg{k}"].matrix_local
        want = hm @ Matrix.Translation(p) @ r_swing @ r_lift @ Matrix.Translation(-p) @ rest
        pb = rig.pose.bones[f"leg{k}"]
        pb.matrix = want
        bpy.context.view_layer.update()


def key_all(rig, frame):
    for pb in rig.pose.bones:
        pb.keyframe_insert("rotation_quaternion", frame=frame)
        pb.keyframe_insert("location", frame=frame)


def action(rig, name, frames):
    rig.animation_data_create()
    act = bpy.data.actions.new(name)
    rig.animation_data.action = act
    for f, fn in frames:
        fn()
        key_all(rig, f)
    act.use_fake_user = True
    tr = rig.animation_data.nla_tracks.new()
    tr.name = name
    tr.strips.new(name, int(frames[0][0]), act)
    rig.animation_data.action = None


def make_bomber_actions(rig, dirs, pivots, body_z):
    # 3本ずつ交互に（隣どうしは逆の組）：右の前・後と左の中 / 右の中と左の前・後
    group = [0, 1, 0, 1, 0, 1]
    group = [0 if k in (0, 2, 4) else 1 for k in range(6)]
    P = lambda legs, dz=0.0, tilt=0.0: (lambda: pose(rig, dirs, pivots, body_z, legs, dz, tilt))  # noqa: E731
    still = [(0.0, 0.0)] * 6
    # 待機：胴がゆっくり上下（2秒）
    action(rig, "Idle", [(1, P(still)), (31, P(still, -0.012)), (61, P(still))])
    # 走り（0.4秒で1周。3本ずつ交互に、上げて前へ・下ろして後ろへ）
    n = 12
    frames = []
    for i in range(n + 1):
        ph = i / n
        legs = []
        for k in range(6):
            u = 2 * math.pi * (ph + 0.5 * group[k])
            fwd = -math.cos(u)
            lift = max(0.0, math.sin(u))
            legs.append((0.32 * fwd, 0.45 * lift))
        dz = 0.012 * abs(math.cos(4 * math.pi * ph))
        frames.append((1 + i, P(legs, dz, 0.05)))
    action(rig, "Run", frames)
    # ジャンプ（空中）：脚を上げてたたむ
    tuck = [(0.0, 0.55)] * 6
    action(rig, "Jump", [(1, P(tuck)), (31, P(tuck))])
    # 倒れる：脚が開いて胴が地面に落ち、少し前に傾く（1秒）
    drop = -(body_z - 0.17 * (BOMBER_HEIGHT / 0.8))
    splay = [(0.15 * (1 if k % 2 else -1), 0.75) for k in range(6)]
    action(rig, "Death", [(1, P(still)), (5, P([(0.0, 0.3)] * 6, 0.05)), (14, P(splay, drop, 0.22)), (31, P(splay, drop, 0.25))])


def decimated(o, tris, name):
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


def export(objs, path, animations):
    bpy.ops.object.select_all(action="DESELECT")
    for x in objs:
        x.hide_set(False)
        x.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    kw = dict(filepath=path, export_format="GLB", use_selection=True, export_yup=True, export_apply=True, export_image_format="JPEG", export_jpeg_quality=88)
    if animations:
        kw.update(export_animation_mode="NLA_TRACKS", export_force_sampling=True)
    else:
        kw.update(export_animations=False)
    bpy.ops.export_scene.gltf(**kw)
    print(f"  書き出し: {os.path.relpath(path, ROOT)} ({os.path.getsize(path) // 1024} KB)")


def build_bomber(preview=False):
    print("[爆弾兵]")
    o, k = load(scale_to=BOMBER_HEIGHT)
    src_img = base_image(o)
    owner, pivots, dirs = classify(o)
    pivots = scale_all(o, pivots, k)
    zs = [v.co.z for v, w in zip(o.data.vertices, owner) if w < 0]
    body_z = (min(zs) + max(zs)) / 2
    rig = make_rig(pivots, body_z)
    bind(o, rig, owner)
    make_bomber_actions(rig, dirs, pivots, body_z)
    bpy.context.scene.render.fps = FPS
    img = scaled_image(src_img, "assault_tex", 2048)
    mat = tex_material("GlowRedMap", img)  # ゲーム側：テクスチャの赤い灯りを光らせる印
    for x in (o,):
        x.data.materials.clear()
        x.data.materials.append(mat)
    lod = decimated(o, 1800, "assault_lod")
    lod.data.materials.clear()
    lod.data.materials.append(tex_material("assault_lodtex", scaled_image(src_img, "assault_lodtex", 128)))
    lod.parent = rig
    for m in list(lod.modifiers):
        lod.modifiers.remove(m)
    am = lod.modifiers.new("Armature", "ARMATURE")
    am.object = rig
    print(f"  面：{sum(len(p.vertices) - 2 for p in o.data.polygons)}（遠く用 {sum(len(p.vertices) - 2 for p in lod.data.polygons)}）")
    lod.hide_set(True)
    export([rig, o], os.path.join(CHAR_DIR, "assault.glb"), True)
    o.hide_set(True)
    export([rig, lod], os.path.join(CHAR_DIR, "assault_lod.glb"), False)
    o.hide_set(False)
    lod.hide_set(True)
    if preview:
        render_bomber_preview(rig, os.path.join(HERE, "preview", "assault_spider.png"))


def render_bomber_preview(rig, path):
    import numpy as np

    sc = bpy.context.scene
    setup_render(sc, 1.5, 0.35)
    shots = [("Idle", 1), ("Run", 1), ("Run", 4), ("Run", 7), ("Jump", 1), ("Death", 31)]
    files = []
    for i, (tr, f) in enumerate(shots):
        for t in rig.animation_data.nla_tracks:
            t.mute = t.name != tr
        sc.frame_set(f)
        bpy.context.view_layer.update()
        fp = os.path.join(tempfile.gettempdir(), f"spider_pv{i}.png")
        sc.render.filepath = fp
        bpy.ops.render.render(write_still=True)
        files.append(fp)
    save_sheet(files, path)


def setup_render(sc, ortho, cz):
    sc.render.engine = "CYCLES"
    sc.cycles.samples = 12
    sc.cycles.use_denoising = False
    sc.render.resolution_x, sc.render.resolution_y = 480, 400
    w = bpy.data.worlds.new("W")
    sc.world = w
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs["Color"].default_value = (0.55, 0.57, 0.62, 1)
    cd = bpy.data.cameras.new("C")
    cd.type = "ORTHO"
    cd.ortho_scale = ortho
    cam = bpy.data.objects.new("C", cd)
    sc.collection.objects.link(cam)
    cam.location = (-2.6, -4.5, 2.2 + cz)
    cam.rotation_euler = (math.radians(68), 0, math.radians(-30))
    sc.camera = cam
    for loc, e in (((2, -3, 3), 500), ((-3, -1, 2), 250), ((0, 3, 2), 300)):
        ld = bpy.data.lights.new("L", "AREA")
        ld.energy = e
        ld.size = 3
        lo = bpy.data.objects.new("L", ld)
        lo.location = loc
        lo.rotation_euler = (Vector((0, 0, 0.3)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        sc.collection.objects.link(lo)


def save_sheet(files, path):
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
    os.makedirs(os.path.dirname(path), exist_ok=True)
    out.filepath_raw = path
    out.file_format = "PNG"
    out.save()
    print(f"  確認用の画像: {os.path.relpath(path, ROOT)}")


# ---------------------------------------------------------------------------
# ティック（部品に分ける）
# ---------------------------------------------------------------------------


def build_tick(preview=False):
    print("[ティック]")
    # ティックは爆弾兵と同じ大きさ（消耗戦で撃って壊せる、爆弾兵と同じ当たり判定）
    o, k = load(scale_to=BOMBER_HEIGHT)
    src_img = base_image(o)
    owner, pivots, dirs = classify(o)
    # ティックは正面が +Y（ゲームの向き yaw=0）。元のモデルは -Y が正面なので 180° 回す。
    # 脚の番号も前後・左右が入れ替わるので、付け直す（0〜2：-X の前・中・後、3〜5：+X の前・中・後。前は +Y）
    pivots = scale_all(o, pivots, k, flip=True)
    remap = {0: 5, 1: 4, 2: 3, 3: 2, 4: 1, 5: 0}
    owner = [remap[w] if w >= 0 else -1 for w in owner]
    pivots = [pivots[[i for i in range(6) if remap[i] == j][0]] for j in range(6)]
    img = scaled_image(src_img, "tick_tex", 1024)
    shell = tex_material("TkShell", img, rough=0.5, metal=0.35)
    red = tex_material("TkRed", img, emission=(1.0, 0.16, 0.12), strength=6.0)
    reds = red_faces(o, src_img)
    o.data.materials.clear()
    o.data.materials.append(shell)
    o.data.materials.append(red)
    me = o.data
    for p in me.polygons:
        w = owner[p.vertices[0]]
        p.material_index = 1 if (w < 0 and p.index in reds) else 0
    # 部品ごとに分ける
    root = bpy.data.objects.new("tick", None)
    bpy.context.collection.objects.link(root)
    groups = {-1: "TickBody", **{i: f"TickLeg{i}" for i in range(6)}}
    for w, name in groups.items():
        c = o.copy()
        c.data = o.data.copy()
        c.name = name
        c.data.name = name
        bpy.context.collection.objects.link(c)
        bm = bmesh.new()
        bm.from_mesh(c.data)
        bm.verts.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if owner[v.index] != w], context="VERTS")
        bm.to_mesh(c.data)
        bm.free()
        if w >= 0:
            bpy.context.scene.cursor.location = pivots[w]
            bpy.ops.object.select_all(action="DESELECT")
            c.select_set(True)
            bpy.context.view_layer.objects.active = c
            bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
        c.parent = root
    bpy.context.scene.cursor.location = (0, 0, 0)
    bpy.data.objects.remove(o)
    n = sum(len(p.vertices) - 2 for x in root.children for p in x.data.polygons)
    print(f"  面：{n}・赤い灯りの面：{len(reds)}")
    export([root, *root.children], os.path.join(PROP_DIR, "tick.glb"), False)
    if preview:
        sc = bpy.context.scene
        setup_render(sc, 1.5, 0.35)
        fp = os.path.join(HERE, "preview", "tick_spider.png")
        sc.render.filepath = fp
        bpy.ops.render.render(write_still=True)
        print(f"  確認用の画像: {os.path.relpath(fp, ROOT)}")


def main():
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    only = [a for a in args if not a.startswith("--")]
    if not only or "bomber" in only:
        build_bomber("--preview" in args)
    if not only or "tick" in only:
        build_tick("--preview" in args)


if __name__ == "__main__":
    main()
