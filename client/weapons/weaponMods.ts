/**
 * 武器のモデルに、サイトとアタッチメントのモデルを付ける（一人称の武器・ロードアウト画面の武器の絵で共通）。
 * 武器のモデルの "SightMount"・"Muzzle"・"LaserMount"・"Magazine"・"IronSights" を使う（build_weapons.py）。
 * サイト・アタッチメントのモデルは sights.glb（build_sights.py）。
 */
import * as THREE from 'three';
import type { WeaponId } from '../../config';
import type { WeaponCustom } from '../../shared/weaponCustom';

/** 銃口の部品の大きさ（銃身の太さに合わせる） */
const MUZZLE_SCALE: Record<WeaponId, number> = { ar: 1, burst: 1, smg: 1, psmg: 0.85, lmg: 1.12, spinlmg: 1.3, shotgun: 1.25, autosg: 1.35, sniper: 1.4, marksman: 1.15, pistol: 0.8, revolver: 0.95 };

export interface AppliedMods {
  /** サイトの目の側の端（武器の root の座標）。照門・照星なら null */
  eye: THREE.Vector3 | null;
  /** マズルフラッシュを出す所（銃口の部品を付けたら、その先） */
  muzzle: THREE.Object3D;
  /** レーザーの出る所（付けていなければ null） */
  laser: THREE.Object3D | null;
  suppressed: boolean;
}

/** 名前がこれで始まる子を探す（Blender で同じ名前の空のオブジェクトが Eye.001 のようになるため） */
function findPrefix(root: THREE.Object3D, name: string): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (!found && o !== root && o.name.startsWith(name)) found = o;
  });
  return found;
}

function prepare(src: THREE.Object3D): THREE.Object3D {
  const o = src.clone(true);
  o.userData.weaponMod = true;
  o.traverse((x) => {
    x.frustumCulled = false;
    const m = x as THREE.Mesh;
    if (m.isMesh) m.castShadow = false;
  });
  return o;
}

/**
 * root（武器のモデルの複製）にカスタマイズの見た目を付ける。前に付けた物は外してから付ける。
 * parts：sights.glb の場面
 */
export function applyWeaponMods(root: THREE.Object3D, weapon: WeaponId, custom: WeaponCustom, parts: THREE.Object3D | null): AppliedMods {
  // 前に付けた物を外し、変えた所を戻す
  const old: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o.userData.weaponMod) old.push(o);
  });
  for (const o of old) o.removeFromParent();
  const iron = root.getObjectByName('IronSights');
  const mag = root.getObjectByName('Magazine');
  if (mag) {
    if (!mag.userData.restScale) mag.userData.restScale = mag.scale.clone();
    mag.scale.copy(mag.userData.restScale as THREE.Vector3);
  }
  const muzzle0 = root.getObjectByName('Muzzle') ?? root;
  const out: AppliedMods = { eye: null, muzzle: muzzle0, laser: null, suppressed: custom.attachments.includes('suppressor') };
  if (iron) iron.visible = true;
  if (!parts) return out;
  const part = (name: string) => {
    const p = parts.getObjectByName(name);
    return p ? prepare(p) : null;
  };

  // --- サイト：付けたら照門・照星は隠す ---
  const mount = root.getObjectByName('SightMount');
  if (custom.sight !== 'iron' && mount) {
    const s = part(`Sight_${custom.sight}`);
    if (s) {
      s.position.set(0, 0, 0);
      s.rotation.set(0, 0, 0);
      mount.add(s);
      if (iron) iron.visible = false;
      root.updateMatrixWorld(true);
      const eye = findPrefix(s, 'Eye');
      if (eye) out.eye = root.worldToLocal(eye.getWorldPosition(new THREE.Vector3()));
    }
  }

  // --- 銃口：ロングバレル → その先にサプレッサーかコンペンセイター ---
  let tipParent: THREE.Object3D = muzzle0;
  const k = MUZZLE_SCALE[weapon];
  const addAtTip = (name: string) => {
    const p = part(name);
    if (!p) return;
    p.scale.setScalar(k);
    tipParent.add(p);
    const tip = findPrefix(p, 'Tip');
    if (tip) tipParent = tip;
  };
  if (custom.attachments.includes('longbarrel')) addAtTip('Att_longbarrel');
  if (custom.attachments.includes('suppressor')) addAtTip('Att_suppressor');
  if (custom.attachments.includes('compensator')) addAtTip('Att_compensator');
  out.muzzle = tipParent;

  // --- レーザーサイト（銃身の右側） ---
  const lm = root.getObjectByName('LaserMount');
  if (custom.attachments.includes('laser') && lm) {
    const p = part('Att_laser');
    if (p) {
      lm.add(p);
      out.laser = findPrefix(p, 'Emitter') ?? p;
    }
  }

  // --- 弾倉：拡張マガジンは長く、クイックリロードは底に引き手 ---
  if (mag) {
    const rest = mag.userData.restScale as THREE.Vector3;
    if (custom.attachments.includes('extmag')) mag.scale.set(rest.x * 1.04, rest.y * 1.32, rest.z * 1.04);
    if (custom.attachments.includes('fastreload')) {
      const p = part('Att_magpull');
      if (p) {
        // 弾倉の底（弾倉の座標で）
        const box = new THREE.Box3();
        const mesh = mag as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry.computeBoundingBox();
          box.copy(mesh.geometry.boundingBox!);
        } else box.setFromObject(mag);
        p.position.set((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
        // 弾倉を伸ばしても、引き手は伸ばさない
        p.scale.set(1 / mag.scale.x, 1 / mag.scale.y, 1 / mag.scale.z);
        mag.add(p);
      }
    }
  }
  root.updateMatrixWorld(true);
  return out;
}
