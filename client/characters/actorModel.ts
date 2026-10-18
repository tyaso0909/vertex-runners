/**
 * 試合に出るキャラクター（ボット・歩兵）の軽い表示用モデル。
 *
 * Blender で作ったモデルは、部品ごと（骨ごと・色ごと）に分かれていて、1体で数十回の描画になる。
 * 12体のパイロットと24体の歩兵を出すと重いので、読み込んだときに
 *  - 全部の部品を1つの「スキンメッシュ」（骨で動く1つの形）にまとめ、
 *  - 色・発光・金属っぽさ・ざらつきを頂点の情報に入れて、マテリアルを1つにする
 * （半透明の部品だけは別にもう1つ）。これで1体あたり 1〜2 回の描画になる。
 *
 * マテリアルには、消耗戦の演出（倒れたときに消えていく・光学迷彩・フェイズシフト・被弾の光・チームの色の縁取り）を入れる。
 *
 * 取り込んだモデル（build_imported.py。テクスチャ付きの1枚の皮が骨で曲がる形）は、すでに1つのスキンメッシュなので
 * そのまま使い、演出に要る頂点の情報（色は白・発光なし）と輪郭用の向きを足して、テクスチャを貼ったマテリアルにする。
 */
import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { CharacterModel } from '../assets';

/** 1体ごとの演出の値（シェーダーに渡す） */
export interface ActorFx {
  /** 消えていく度合い（0〜1） */
  dissolve: { value: number };
  /** 光学迷彩（0〜1。1 でほぼ見えない） */
  cloak: { value: number };
  /** フェイズシフト（0〜1） */
  phase: { value: number };
  /** 被弾したときの白い光（0〜1） */
  hit: { value: number };
  /** 縁取りの強さ */
  rim: { value: number };
  /** チームの色（縁取り・歩兵の灯り・消えるときの縁） */
  team: { value: THREE.Color };
}

export const makeFx = (team: THREE.Color): ActorFx => ({
  dissolve: { value: 0 },
  cloak: { value: 0 },
  phase: { value: 0 },
  hit: { value: 0 },
  rim: { value: 0.35 },
  team: { value: team.clone() },
});

/** モデルの部品を1つの形にまとめたもの（1種類のキャラクターにつき1つ作り、体ごとに複製する） */
export class ActorTemplate {
  readonly root: THREE.Object3D;
  readonly animations: THREE.AnimationClip[];
  /** 取り込んだモデルのテクスチャ（userData に入れると複製のときに壊れるので、ここに持つ） */
  private readonly map: THREE.Texture | null = null;
  /** テクスチャの水色の灯りを、チームの色に光らせる（歩兵。マテリアルの名前が "TeamGlowMap"） */
  private readonly teamMap: boolean = false;
  /** テクスチャの赤い灯り（目など）を光らせる（爆弾兵。マテリアルの名前が "GlowRedMap"） */
  private readonly redGlow: boolean = false;

  /** lod：遠くに見えるとき用の、面を減らしたモデル（骨の名前は model と同じ。build_lod.py で作る） */
  constructor(model: CharacterModel, lod?: CharacterModel) {
    this.animations = model.animations;
    const skinned = findSkinned(model.scene);
    if (skinned) {
      this.map = (skinned.material as THREE.MeshStandardMaterial).map ?? null;
      this.teamMap = (skinned.material as THREE.Material).name === 'TeamGlowMap';
      this.redGlow = (skinned.material as THREE.Material).name === 'GlowRedMap';
      this.root = skinnedRoot(model, lod);
      return;
    }
    const root = model.scene.clone(true);
    root.updateMatrixWorld(true);
    const rootInv = root.matrixWorld.clone().invert();
    // 骨（部品の親になっている節）。部品のメッシュ自身は骨にしない
    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    const bones: THREE.Object3D[] = [];
    const boneIndex = new Map<THREE.Object3D, number>();
    const boneOf = (m: THREE.Object3D): number => {
      let p = m.parent;
      while (p && p !== root && (p as THREE.Mesh).isMesh) p = p.parent;
      const b = p ?? root;
      let i = boneIndex.get(b);
      if (i === undefined) {
        i = bones.length;
        bones.push(b);
        boneIndex.set(b, i);
      }
      return i;
    };

    const parts: { opaque: Part[]; clear: Part[] } = { opaque: [], clear: [] };
    for (const mesh of meshes) {
      const bi = boneOf(mesh);
      const geo = mesh.geometry as THREE.BufferGeometry;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const m = new THREE.Matrix4().multiplyMatrices(rootInv, mesh.matrixWorld);
      const nm = new THREE.Matrix3().getNormalMatrix(m);
      const groups = geo.groups.length ? geo.groups : [{ start: 0, count: geo.index ? geo.index.count : geo.attributes.position.count, materialIndex: 0 }];
      for (const g of groups) {
        const mat = mats[g.materialIndex ?? 0] as THREE.MeshStandardMaterial;
        const clear = mat.transparent || mat.opacity < 0.99;
        (clear ? parts.clear : parts.opaque).push({ geo, start: g.start, count: g.count, mat, matrix: m, normalMatrix: nm, bone: bi });
      }
    }

    // 遠く用のモデル：部品の親の骨を名前で探して、同じ骨で動かす（半透明の部品は遠くでは省く）
    const lodParts: Part[] = [];
    if (lod) {
      const lroot = lod.scene.clone(true);
      lroot.updateMatrixWorld(true);
      const linv = lroot.matrixWorld.clone().invert();
      lroot.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        let p = mesh.parent;
        while (p && p !== lroot && (p as THREE.Mesh).isMesh) p = p.parent;
        const bone = p && p !== lroot ? (root.getObjectByName(p.name) ?? root) : root;
        let bi = boneIndex.get(bone);
        if (bi === undefined) {
          bi = bones.length;
          bones.push(bone);
          boneIndex.set(bone, bi);
        }
        const geo = mesh.geometry as THREE.BufferGeometry;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const m = new THREE.Matrix4().multiplyMatrices(linv, mesh.matrixWorld);
        const nm = new THREE.Matrix3().getNormalMatrix(m);
        const groups = geo.groups.length ? geo.groups : [{ start: 0, count: geo.index ? geo.index.count : geo.attributes.position.count, materialIndex: 0 }];
        for (const g of groups) {
          const mat = mats[g.materialIndex ?? 0] as THREE.MeshStandardMaterial;
          if (mat.transparent || mat.opacity < 0.99) continue;
          lodParts.push({ geo, start: g.start, count: g.count, mat, matrix: m, normalMatrix: nm, bone: bi });
        }
      });
    }

    // 元の部品を取り除き、まとめた形を置く
    for (const mesh of meshes) mesh.removeFromParent();
    const skeletonBones = bones as unknown as THREE.Bone[];
    for (const [key, list] of [
      ['opaque', parts.opaque],
      ['clear', parts.clear],
      ['lod', lodParts],
    ] as const) {
      if (!list.length) continue;
      const geo = mergeParts(list);
      if (key !== 'clear') addOutlineNormals(geo);
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, transparent: key === 'clear', depthWrite: key !== 'clear' });
      const sm = new THREE.SkinnedMesh(geo, mat);
      sm.name = key === 'opaque' ? 'ActorBody' : key === 'clear' ? 'ActorClear' : 'ActorBodyLod';
      sm.castShadow = key === 'opaque';
      sm.receiveShadow = key !== 'clear';
      if (key === 'lod') sm.visible = false;
      if (key === 'clear') sm.renderOrder = 2;
      root.add(sm);
      root.updateMatrixWorld(true);
      sm.bind(new THREE.Skeleton(skeletonBones), sm.matrixWorld);
    }
    this.root = root;
  }

  /** 1体分を複製する。演出の値 fx を持つマテリアルを付ける */
  instantiate(fx: ActorFx): { root: THREE.Object3D; materials: THREE.Material[] } {
    const root = SkeletonUtils.clone(this.root);
    const materials: THREE.Material[] = [];
    // 近く用と遠く用の体は、同じマテリアルを使う（演出の値も同じ）
    let body: THREE.Material | null = null;
    root.traverse((o) => {
      const sm = o as THREE.SkinnedMesh;
      if (!sm.isSkinnedMesh) return;
      const clear = sm.name === 'ActorClear';
      if (!clear && body) {
        sm.material = body;
      } else {
        const mat = actorMaterial(fx, clear, clear ? null : this.map, this.teamMap, this.redGlow);
        sm.material = mat;
        materials.push(mat);
        if (!clear) body = mat;
      }
      sm.frustumCulled = true;
    });
    return { root, materials };
  }
}

function findSkinned(root: THREE.Object3D): THREE.SkinnedMesh | null {
  let found: THREE.SkinnedMesh | null = null;
  root.traverse((o) => {
    if (!found && (o as THREE.SkinnedMesh).isSkinnedMesh) found = o as THREE.SkinnedMesh;
  });
  return found;
}

/** テクスチャ付きの皮の形に、演出用の頂点の情報（色・発光・金属とざらつき）と輪郭用の向きを足す */
function skinnedGeometry(src: THREE.BufferGeometry, mat: THREE.MeshStandardMaterial): THREE.BufferGeometry {
  const g = src.clone();
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 4).fill(1);
  const pbr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pbr[i * 3] = mat.metalness ?? 0.05;
    pbr[i * 3 + 1] = mat.roughness ?? 0.6;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 4));
  g.setAttribute('aEmissive', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('aPbr', new THREE.BufferAttribute(pbr, 3));
  addOutlineNormals(g);
  g.computeBoundingSphere();
  if (g.boundingSphere) g.boundingSphere.radius += 0.6;
  return g;
}

/**
 * 取り込んだモデル（1枚の皮・テクスチャ付き）の体を作る。遠く用のモデル（同じ骨）は、骨の名前で
 * 近く用の骨格の番号に付け替えて、同じ骨格で動かす。
 */
function skinnedRoot(model: CharacterModel, lod?: CharacterModel): THREE.Object3D {
  const root = SkeletonUtils.clone(model.scene);
  root.updateMatrixWorld(true);
  const body = findSkinned(root)!;
  const mat = body.material as THREE.MeshStandardMaterial;
  body.geometry = skinnedGeometry(body.geometry, mat);
  body.name = 'ActorBody';
  body.castShadow = true;
  body.receiveShadow = true;
  if (lod) {
    const lsrc = findSkinned(lod.scene);
    if (lsrc) {
      const geo = skinnedGeometry(lsrc.geometry, mat);
      // 遠く用の骨の番号 → 近く用の骨の番号（名前で対応させる）
      const map = lsrc.skeleton.bones.map((b) => Math.max(0, body.skeleton.bones.findIndex((x) => x.name === b.name)));
      const si = geo.attributes.skinIndex;
      for (let i = 0; i < si.count; i++) for (let k = 0; k < 4; k++) si.setComponent(i, k, map[si.getComponent(i, k)] ?? 0);
      const lm = new THREE.SkinnedMesh(geo, body.material);
      lm.name = 'ActorBodyLod';
      lm.visible = false;
      lm.position.copy(body.position);
      lm.quaternion.copy(body.quaternion);
      lm.scale.copy(body.scale);
      body.parent!.add(lm);
      lm.updateMatrixWorld(true);
      lm.bind(body.skeleton, body.bindMatrix);
    }
  }
  return root;
}

interface Part {
  geo: THREE.BufferGeometry;
  start: number;
  count: number;
  mat: THREE.MeshStandardMaterial;
  matrix: THREE.Matrix4;
  normalMatrix: THREE.Matrix3;
  bone: number;
}

/** 部品を1つの形にまとめる。色・発光・金属・ざらつき・チームの灯りを頂点に入れる */
function mergeParts(parts: Part[]): THREE.BufferGeometry {
  let n = 0;
  for (const p of parts) n += p.count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const col = new Float32Array(n * 4);
  const em = new Float32Array(n * 3);
  const pbr = new Float32Array(n * 3);
  const si = new Uint16Array(n * 4);
  const sw = new Float32Array(n * 4);
  const v = new THREE.Vector3();
  let k = 0;
  for (const p of parts) {
    const P = p.geo.attributes.position;
    const N = p.geo.attributes.normal;
    const idx = p.geo.index;
    const c = p.mat.color;
    const e = p.mat.emissive.clone().multiplyScalar(p.mat.emissiveIntensity ?? 1);
    const team = p.mat.name === 'TeamGlow' ? 1 : 0;
    for (let i = 0; i < p.count; i++) {
      const vi = idx ? idx.getX(p.start + i) : p.start + i;
      v.fromBufferAttribute(P, vi).applyMatrix4(p.matrix);
      pos.set([v.x, v.y, v.z], k * 3);
      if (N) {
        v.fromBufferAttribute(N, vi).applyMatrix3(p.normalMatrix).normalize();
        nor.set([v.x, v.y, v.z], k * 3);
      }
      col.set([c.r, c.g, c.b, p.mat.opacity], k * 4);
      em.set(team ? [0, 0, 0] : [e.r, e.g, e.b], k * 3);
      pbr.set([p.mat.metalness, p.mat.roughness, team], k * 3);
      si[k * 4] = p.bone;
      sw[k * 4] = 1;
      k++;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 4));
  g.setAttribute('aEmissive', new THREE.BufferAttribute(em, 3));
  g.setAttribute('aPbr', new THREE.BufferAttribute(pbr, 3));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  g.computeBoundingSphere();
  if (g.boundingSphere) g.boundingSphere.radius += 0.6;
  return g;
}

/**
 * 輪郭用の向き：同じ位置（同じ骨）にある頂点の法線を平均したもの。
 * 部品は角ごとに頂点が分かれているので、そのままの法線で外へ膨らませると角で輪郭が切れる。
 */
function addOutlineNormals(g: THREE.BufferGeometry) {
  const P = g.attributes.position as THREE.BufferAttribute;
  const N = g.attributes.normal as THREE.BufferAttribute;
  const S = g.attributes.skinIndex as THREE.BufferAttribute;
  const n = P.count;
  const sum = new Map<string, number[]>();
  const keys: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const k = `${S.getX(i)}|${Math.round(P.getX(i) * 2000)}|${Math.round(P.getY(i) * 2000)}|${Math.round(P.getZ(i) * 2000)}`;
    keys[i] = k;
    let s = sum.get(k);
    if (!s) sum.set(k, (s = [0, 0, 0]));
    s[0] += N.getX(i);
    s[1] += N.getY(i);
    s[2] += N.getZ(i);
  }
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const s = sum.get(keys[i])!;
    const L = Math.hypot(s[0], s[1], s[2]) || 1;
    out[i * 3] = s[0] / L;
    out[i * 3 + 1] = s[1] / L;
    out[i * 3 + 2] = s[2] / L;
  }
  g.setAttribute('aOutline', new THREE.BufferAttribute(out, 3));
}

/** 輪郭を付ける体が、ステンシルに書く値 */
export const OUTLINE_STENCIL = 1;

/** 体のマテリアルを、ステンシルに印を付けるようにする（輪郭を体の上に描かないため） */
export function markOutlineStencil(mat: THREE.Material) {
  mat.stencilWrite = true;
  mat.stencilRef = OUTLINE_STENCIL;
  mat.stencilFunc = THREE.AlwaysStencilFunc;
  mat.stencilZPass = THREE.ReplaceStencilOp;
}

/** 輪郭の太さ（m／m）。カメラからの距離に比例させて、画面の上でほぼ同じ太さ（1080p で約 2px）にする */
const OUTLINE_WIDTH = 0.0019;

/**
 * 味方の輪郭：体を少し外へ膨らませた形の裏側だけをチームの色で塗る（体の後ろにはみ出した所だけが見える）。
 * 倒れて消えていくとき・光学迷彩・フェイズシフトでは薄くなる。
 */
export function outlineMaterial(fx: ActorFx, color: THREE.Color, opacity: number): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({ color: color.clone(), side: THREE.BackSide, transparent: true, opacity, depthWrite: false, toneMapped: false, fog: false });
  // 体（ステンシル 1 を書く）の上には描かない：体の外側にはみ出した所だけが輪郭になる（体の内側の線を出さない）
  mat.stencilWrite = true;
  mat.stencilRef = OUTLINE_STENCIL;
  mat.stencilFunc = THREE.NotEqualStencilFunc;
  mat.stencilFail = THREE.KeepStencilOp;
  mat.stencilZFail = THREE.KeepStencilOp;
  mat.stencilZPass = THREE.KeepStencilOp;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uDissolve = fx.dissolve;
    sh.uniforms.uCloak = fx.cloak;
    sh.uniforms.uPhase = fx.phase;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aOutline;')
      .replace(
        '#include <project_vertex>',
        `vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
vec3 olN = aOutline;
#ifdef USE_SKINNING
olN = (skinMatrix * vec4(olN, 0.0)).xyz;
#endif
olN = normalize(normalMatrix * olN);
mvPosition.xyz += olN * ${OUTLINE_WIDTH} * clamp(-mvPosition.z, 1.5, 60.0);
gl_Position = projectionMatrix * mvPosition;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uDissolve;\nuniform float uCloak;\nuniform float uPhase;')
      .replace(
        '#include <opaque_fragment>',
        `diffuseColor.a *= (1.0 - smoothstep(0.0, 0.25, uDissolve)) * (1.0 - uCloak * 0.75) * (1.0 - uPhase * 0.6);
if (diffuseColor.a < 0.01) discard;
#include <opaque_fragment>`,
      );
  };
  mat.customProgramCacheKey = () => 'actor-outline';
  return mat;
}

/** 取り込んだモデル（テクスチャ付き）の、縁の光の強さの倍率 */
export const RIM_K_TEXTURED = 0.3;

const FX_HEAD = /* glsl */ `
uniform float uDissolve;
uniform float uCloak;
uniform float uPhase;
uniform float uHit;
uniform float uRim;
uniform vec3 uTeam;
varying vec3 vFxPos;
varying vec3 vEm;
varying vec3 vPbr;
float fxHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float fxNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(fxHash(i), fxHash(i + vec3(1, 0, 0)), f.x), mix(fxHash(i + vec3(0, 1, 0)), fxHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(fxHash(i + vec3(0, 0, 1)), fxHash(i + vec3(1, 0, 1)), f.x), mix(fxHash(i + vec3(0, 1, 1)), fxHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
`;

/** 1体ごとのマテリアル（頂点の色・発光を使い、演出を足す）。map：取り込んだモデルのテクスチャ */
function actorMaterial(fx: ActorFx, clear: boolean, map: THREE.Texture | null = null, teamMap = false, redGlow = false): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, transparent: clear, depthWrite: !clear, map });
  // 取り込んだモデルは面が細かく、縁の光が体じゅうに出て白っぽく見えるので、縁の光を弱める
  mat.defines = { ACTOR_RIM_K: map ? String(RIM_K_TEXTURED) : '1.0' };
  if (teamMap) mat.defines.ACTOR_TEAM_MAP = '';
  if (redGlow) mat.defines.ACTOR_RED_GLOW = '';
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uDissolve = fx.dissolve;
    sh.uniforms.uCloak = fx.cloak;
    sh.uniforms.uPhase = fx.phase;
    sh.uniforms.uHit = fx.hit;
    sh.uniforms.uRim = fx.rim;
    sh.uniforms.uTeam = fx.team;
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec3 aEmissive;
attribute vec3 aPbr;
varying vec3 vFxPos;
varying vec3 vEm;
varying vec3 vPbr;`,
      )
      .replace(
        '#include <skinning_vertex>',
        `#include <skinning_vertex>
vFxPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vEm = aEmissive;
vPbr = aPbr;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${FX_HEAD}`)
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
// 消えていく模様は、消えている間だけ計算する（ふだんは計算しない）
float fxN = 1.0;
float fxTh = uDissolve * 1.2 - 0.1;
if (uDissolve > 0.0) {
  fxN = fxNoise(vFxPos * 7.0) * 0.6 + fxNoise(vFxPos * 19.0) * 0.4;
  if (fxN < fxTh) discard;
}
float fxDither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
if (uCloak > 0.0 && fxDither < uCloak * 0.94) discard;
if (uPhase > 0.0 && fxDither < uPhase * 0.55) discard;`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vPbr.y;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vPbr.x;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
#ifdef ACTOR_TEAM_MAP
// テクスチャの水色の灯り（緑と青が強く、赤が弱い所）を、暗い下地にしてチームの色で光らせる
float fxTeamMask = smoothstep(0.12, 0.3, min(diffuseColor.g, diffuseColor.b) - diffuseColor.r);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03), fxTeamMask);
#else
float fxTeamMask = 0.0;
#endif
#ifdef ACTOR_RED_GLOW
// テクスチャの赤い灯り（赤が強く、緑と青が弱い所）を、その色で光らせる
float fxRedMask = smoothstep(0.38, 0.55, diffuseColor.r - max(diffuseColor.g, diffuseColor.b));
#else
float fxRedMask = 0.0;
#endif
float fxRim = pow(1.0 - clamp(abs(dot(normalize(normal), normalize(vViewPosition))), 0.0, 1.0), 3.5);
float fxEdge = uDissolve > 0.0 ? 1.0 - smoothstep(0.0, 0.09, fxN - fxTh) : 0.0;
// 暗い所でも見分けやすいよう、元の色を少しだけ自分で光らせる（弱い補助光の代わり）
totalEmissiveRadiance = vEm + diffuseColor.rgb * 0.07 + uTeam * (vPbr.z + fxTeamMask) * 4.0 + uTeam * fxRim * uRim * ACTOR_RIM_K + uTeam * fxEdge * 7.0
  + vec3(1.0, 0.92, 0.85) * uHit * 0.9 + vec3(0.55, 0.3, 1.0) * uPhase * (0.6 + fxRim * 2.0)
  + vec3(0.6, 0.9, 1.0) * uCloak * fxRim * 1.5 + diffuseColor.rgb * fxRedMask * 6.0;`,
      );
  };
  // 同じ作りのシェーダーを使い回す
  mat.customProgramCacheKey = () => (clear ? 'actor-clear' : teamMap ? 'actor-tex-team' : redGlow ? 'actor-tex-red' : map ? 'actor-tex' : 'actor');
  return mat;
}

/** 武器のモデルを1つの形・1つのマテリアルにまとめる（銃口・グリップの位置の節は残す） */
/** 武器のモデルの部品を1つの形にまとめる（root の座標で） */
function weaponGeometry(root: THREE.Object3D, remove: boolean): THREE.BufferGeometry {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const parts: Part[] = [];
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshes.push(mesh);
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    // 隠した部品（サイトを付けたときの照門・照星）と、半透明のレンズは入れない
    if (!mesh.visible || mats.some((x) => x.transparent)) return;
    const m = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
    const geo = mesh.geometry as THREE.BufferGeometry;
    const groups = geo.groups.length ? geo.groups : [{ start: 0, count: geo.index ? geo.index.count : geo.attributes.position.count, materialIndex: 0 }];
    for (const g of groups) parts.push({ geo, start: g.start, count: g.count, mat: mats[g.materialIndex ?? 0] as THREE.MeshStandardMaterial, matrix: m, normalMatrix: new THREE.Matrix3().getNormalMatrix(m), bone: 0 });
  });
  if (remove) for (const mesh of meshes) mesh.removeFromParent();
  const geo = mergeParts(parts);
  geo.deleteAttribute('skinIndex');
  geo.deleteAttribute('skinWeight');
  return geo;
}

/** 三人称で持たせる武器（1つの形・1つのマテリアルにまとめる）。lod：遠くに見えるとき用の、面を減らしたモデル */
export function mergeWeapon(model: THREE.Object3D, lod?: THREE.Object3D): THREE.Object3D {
  const root = model.clone(true);
  const geo = weaponGeometry(root, true);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aEmissive;\nattribute vec3 aPbr;\nvarying vec3 vEm;\nvarying vec3 vPbr;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEm = aEmissive;\nvPbr = aPbr;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vEm;\nvarying vec3 vPbr;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vPbr.y;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vPbr.x;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = vEm;');
  };
  mat.customProgramCacheKey = () => 'actor-weapon';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'WeaponBody';
  mesh.castShadow = true;
  root.add(mesh);
  if (lod) {
    const lm = new THREE.Mesh(weaponGeometry(lod.clone(true), false), mat);
    lm.name = 'WeaponBodyLod';
    lm.visible = false;
    root.add(lm);
  }
  return root;
}
