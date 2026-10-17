/**
 * タワーディフェンスの表示で共通に使う小さな道具（モデルの複製・部品の検索・撃たれたときの光・なめらかな変化）
 */
import * as THREE from 'three';
import type { Vec3 } from '../../shared/math';

export const damp = (cur: number, target: number, rate: number, dt: number) => target + (cur - target) * Math.exp(-rate * dt);
export const angDiff = (a: number, b: number) => {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
};
export const V = (p: Vec3) => new THREE.Vector3(p.x, p.y, p.z);

/** glTF の書き出しで名前の "." が消えることがあるので、両方で探す */
export function part(root: THREE.Object3D, name: string): THREE.Object3D | null {
  return root.getObjectByName(name) ?? root.getObjectByName(name.replace(/\./g, '')) ?? null;
}

export interface Inst {
  root: THREE.Group;
  /** 光らない部品のマテリアル（撃たれたときに白く光らせる） */
  flashMats: THREE.MeshStandardMaterial[];
  byName: Map<string, THREE.MeshStandardMaterial>;
}

/** モデルを複製する（マテリアルも複製して、1体ごとに色を変えられるようにする） */
export function instantiate(src: THREE.Object3D): Inst {
  const root = src.clone(true) as THREE.Group;
  const copies = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = true;
    m.receiveShadow = true;
    const list = Array.isArray(m.material) ? m.material : [m.material];
    const out = list.map((x) => {
      let c = copies.get(x);
      if (!c) {
        c = (x as THREE.MeshStandardMaterial).clone();
        copies.set(x, c);
      }
      return c;
    });
    m.material = Array.isArray(m.material) ? out : out[0];
  });
  const byName = new Map<string, THREE.MeshStandardMaterial>();
  const flashMats: THREE.MeshStandardMaterial[] = [];
  for (const m of copies.values()) {
    byName.set(m.name, m);
    if (m.emissive.r + m.emissive.g + m.emissive.b < 0.01) flashMats.push(m);
  }
  return { root, flashMats, byName };
}

export const FLASH = new THREE.Color('#ffffff');
export const BLACK = new THREE.Color('#000000');
export function setFlash(mats: THREE.MeshStandardMaterial[], k: number, color = FLASH) {
  for (const m of mats) m.emissive.copy(BLACK).lerp(color, Math.min(1, k) * 0.55);
}


// ---------------------------------------------------------------------------
// 輪郭（自分のタレットを青く縁取る）。キャラクターの味方の縁取り（characters/actorModel.ts）と同じやり方：
// 形を少し外へ膨らませた裏側だけを塗り、本体（ステンシルに印を付ける）の上には描かない
// ---------------------------------------------------------------------------

/** 輪郭用の向き：同じ位置にある頂点の法線を平均したもの（角で輪郭が切れないように）。形ごとに1度だけ作る */
function outlineNormals(g: THREE.BufferGeometry) {
  if (g.attributes.aOutline) return;
  const P = g.attributes.position as THREE.BufferAttribute;
  const N = g.attributes.normal as THREE.BufferAttribute | undefined;
  const n = P.count;
  const out = new Float32Array(n * 3);
  if (!N) {
    g.setAttribute('aOutline', new THREE.BufferAttribute(out, 3));
    return;
  }
  const sum = new Map<string, number[]>();
  const keys: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(P.getX(i) * 2000)}|${Math.round(P.getY(i) * 2000)}|${Math.round(P.getZ(i) * 2000)}`;
    keys[i] = k;
    let s = sum.get(k);
    if (!s) sum.set(k, (s = [0, 0, 0]));
    s[0] += N.getX(i);
    s[1] += N.getY(i);
    s[2] += N.getZ(i);
  }
  for (let i = 0; i < n; i++) {
    const s = sum.get(keys[i])!;
    const L = Math.hypot(s[0], s[1], s[2]) || 1;
    out[i * 3] = s[0] / L;
    out[i * 3 + 1] = s[1] / L;
    out[i * 3 + 2] = s[2] / L;
  }
  g.setAttribute('aOutline', new THREE.BufferAttribute(out, 3));
}

/** 輪郭を付ける本体が、ステンシルに書く値（キャラクターの縁取りと同じ値） */
const STENCIL = 1;
/** 輪郭の太さ（m／m）。カメラからの距離に比例させて、画面の上でほぼ同じ太さ（1080p で約 4px）にする */
const WIDTH = 0.0042;

/** 輪郭の色のマテリアル（uPulse で明るさを少し揺らす） */
export function outlineMaterial(color: THREE.Color, opacity: number): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({ color: color.clone(), side: THREE.BackSide, transparent: true, opacity, depthWrite: false, toneMapped: false, fog: false });
  mat.stencilWrite = true;
  mat.stencilRef = STENCIL;
  mat.stencilFunc = THREE.NotEqualStencilFunc;
  mat.stencilFail = THREE.KeepStencilOp;
  mat.stencilZFail = THREE.KeepStencilOp;
  mat.stencilZPass = THREE.KeepStencilOp;
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 aOutline;').replace(
      '#include <project_vertex>',
      `vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
vec3 olN = normalize(normalMatrix * aOutline);
mvPosition.xyz += olN * ${WIDTH} * clamp(-mvPosition.z, 1.5, 60.0);
gl_Position = projectionMatrix * mvPosition;`,
    );
  };
  mat.customProgramCacheKey = () => 'td-outline';
  return mat;
}

/**
 * root の中の形すべてに輪郭を付ける（本体のマテリアルはステンシルに印を付けるようにする）。
 * すでに付けた形には付けない。透明な形（ガラスなど）には付けない
 */
export function addOutline(root: THREE.Object3D, mat: THREE.Material): void {
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || o.userData.outline || o.userData.hasOutline) return;
    const ms = Array.isArray(m.material) ? m.material : [m.material];
    if (ms.some((x) => x.transparent)) return;
    meshes.push(m);
  });
  for (const m of meshes) {
    for (const x of Array.isArray(m.material) ? m.material : [m.material]) {
      x.stencilWrite = true;
      x.stencilRef = STENCIL;
      x.stencilFunc = THREE.AlwaysStencilFunc;
      x.stencilZPass = THREE.ReplaceStencilOp;
    }
    outlineNormals(m.geometry);
    const o = new THREE.Mesh(m.geometry, mat);
    o.name = 'TdOutline';
    o.userData.outline = true;
    o.castShadow = o.receiveShadow = false;
    o.renderOrder = 2;
    m.userData.hasOutline = true;
    m.add(o);
  }
}
