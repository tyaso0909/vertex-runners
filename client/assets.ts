/**
 * Blender で作った 3D モデル（.glb）の読み込み。
 * モデルの元データと作り方は assets-src/ にある。
 */
import * as THREE from 'three';
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CHARACTER_IDS, type CharacterId, type GrenadeId, type WeaponId } from '../config';
import arUrl from './assets/weapons/ar.glb?url';
import lmgUrl from './assets/weapons/lmg.glb?url';
import smgUrl from './assets/weapons/smg.glb?url';
import shotgunUrl from './assets/weapons/shotgun.glb?url';
import sniperUrl from './assets/weapons/sniper.glb?url';
import pistolUrl from './assets/weapons/pistol.glb?url';
import sightsUrl from './assets/weapons/sights.glb?url';
import arLodUrl from './assets/weapons/ar_lod.glb?url';
import lmgLodUrl from './assets/weapons/lmg_lod.glb?url';
import smgLodUrl from './assets/weapons/smg_lod.glb?url';
import shotgunLodUrl from './assets/weapons/shotgun_lod.glb?url';
import sniperLodUrl from './assets/weapons/sniper_lod.glb?url';
import pistolLodUrl from './assets/weapons/pistol_lod.glb?url';
import burstUrl from './assets/weapons/burst.glb?url';
import burstLodUrl from './assets/weapons/burst_lod.glb?url';
import psmgUrl from './assets/weapons/psmg.glb?url';
import psmgLodUrl from './assets/weapons/psmg_lod.glb?url';
import spinlmgUrl from './assets/weapons/spinlmg.glb?url';
import spinlmgLodUrl from './assets/weapons/spinlmg_lod.glb?url';
import autosgUrl from './assets/weapons/autosg.glb?url';
import autosgLodUrl from './assets/weapons/autosg_lod.glb?url';
import marksmanUrl from './assets/weapons/marksman.glb?url';
import marksmanLodUrl from './assets/weapons/marksman_lod.glb?url';
import revolverUrl from './assets/weapons/revolver.glb?url';
import revolverLodUrl from './assets/weapons/revolver_lod.glb?url';
import targetUrl from './assets/props/target.glb?url';
import ammoUrl from './assets/props/ammo_station.glb?url';
import grenadeUrl from './assets/props/grenade.glb?url';
import tickUrl from './assets/props/tick.glb?url';
import ordnanceUrl from './assets/props/ordnance.glb?url';
import turretUrl from './assets/props/turret.glb?url';
import ammoDropUrl from './assets/props/ammo_drop.glb?url';
import syringeUrl from './assets/props/syringe.glb?url';
import droneUrl from './assets/props/drone.glb?url';
import meiaUrl from './assets/characters/meia.glb?url';
import pearlUrl from './assets/characters/pearl.glb?url';
import mirandaUrl from './assets/characters/miranda.glb?url';
import soraUrl from './assets/characters/sora.glb?url';
import alexUrl from './assets/characters/alex.glb?url';
import ranmaruUrl from './assets/characters/ranmaru.glb?url';
import gruntUrl from './assets/characters/grunt.glb?url';
import meiaLodUrl from './assets/characters/meia_lod.glb?url';
import pearlLodUrl from './assets/characters/pearl_lod.glb?url';
import mirandaLodUrl from './assets/characters/miranda_lod.glb?url';
import soraLodUrl from './assets/characters/sora_lod.glb?url';
import alexLodUrl from './assets/characters/alex_lod.glb?url';
import ranmaruLodUrl from './assets/characters/ranmaru_lod.glb?url';
import gruntLodUrl from './assets/characters/grunt_lod.glb?url';
import assaultLodUrl from './assets/characters/assault_lod.glb?url';
import heavyLodUrl from './assets/characters/heavy_lod.glb?url';
import assaultUrl from './assets/characters/assault.glb?url';
import heavyUrl from './assets/characters/heavy.glb?url';
import tdMgUrl from './assets/props/td_mg.glb?url';
import tdRocketUrl from './assets/props/td_rocket.glb?url';
import tdSlowUrl from './assets/props/td_slow.glb?url';
import tdRepairUrl from './assets/props/td_repair.glb?url';
import tdCoreUrl from './assets/props/td_core.glb?url';
import tdDroneUrl from './assets/props/td_drone.glb?url';
import tdBossUrl from './assets/props/td_boss.glb?url';
import tdDecoyUrl from './assets/props/td_decoy.glb?url';
import tdWiretrapUrl from './assets/props/td_wiretrap.glb?url';
import tdBarricadeUrl from './assets/props/td_barricade.glb?url';
import tdJumppadUrl from './assets/props/td_jumppad.glb?url';
import tdUpgradeUrl from './assets/props/td_upgrade.glb?url';
import tdPodUrl from './assets/props/td_pod.glb?url';
import tdMortarUrl from './assets/props/td_mortar.glb?url';
import mortarUrl from './assets/characters/mortar.glb?url';
import mortarLodUrl from './assets/characters/mortar_lod.glb?url';
import fpMeiaUrl from './assets/characters/fp_meia.glb?url';
import fpPearlUrl from './assets/characters/fp_pearl.glb?url';
import fpMirandaUrl from './assets/characters/fp_miranda.glb?url';
import fpSoraUrl from './assets/characters/fp_sora.glb?url';
import fpAlexUrl from './assets/characters/fp_alex.glb?url';
import fpRanmaruUrl from './assets/characters/fp_ranmaru.glb?url';

const WEAPON_URLS: Record<WeaponId, string> = {
  ar: arUrl,
  lmg: lmgUrl,
  smg: smgUrl,
  shotgun: shotgunUrl,
  sniper: sniperUrl,
  pistol: pistolUrl,
  burst: burstUrl,
  psmg: psmgUrl,
  spinlmg: spinlmgUrl,
  autosg: autosgUrl,
  marksman: marksmanUrl,
  revolver: revolverUrl,
};
/** 遠くに見えるとき用の、面を減らした武器（三人称で持たせるときだけ使う） */
const WEAPON_LOD_URLS: Record<WeaponId, string> = {
  ar: arLodUrl,
  lmg: lmgLodUrl,
  smg: smgLodUrl,
  shotgun: shotgunLodUrl,
  sniper: sniperLodUrl,
  pistol: pistolLodUrl,
  burst: burstLodUrl,
  psmg: psmgLodUrl,
  spinlmg: spinlmgLodUrl,
  autosg: autosgLodUrl,
  marksman: marksmanLodUrl,
  revolver: revolverLodUrl,
};
const CHARACTER_URLS: Record<CharacterId, string> = { meia: meiaUrl, pearl: pearlUrl, miranda: mirandaUrl, sora: soraUrl, alex: alexUrl, ranmaru: ranmaruUrl };
/** 遠くに見えるとき用の、面を減らしたモデル（assets-src/characters/build_lod.py） */
const CHARACTER_LOD_URLS: Record<CharacterId, string> = { meia: meiaLodUrl, pearl: pearlLodUrl, miranda: mirandaLodUrl, sora: soraLodUrl, alex: alexLodUrl, ranmaru: ranmaruLodUrl };
const FP_ARM_URLS: Record<CharacterId, string> = {
  meia: fpMeiaUrl,
  pearl: fpPearlUrl,
  miranda: fpMirandaUrl,
  sora: fpSoraUrl,
  alex: fpAlexUrl,
  ranmaru: fpRanmaruUrl,
};

/**
 * glTF を読む。公開ページ用のビルドでは、モデルは base64 の文字のファイル（*.glb.txt）になっている
 * （公開ページは .glb を置けず、埋め込んだデータ（data: URL）も読めないため）。そのときは文字を読んで、バイナリに戻してから解釈する
 */
export async function loadGltfFrom(loader: GLTFLoader, url: string): Promise<GLTF> {
  if (!url.endsWith('.txt')) return loader.loadAsync(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`モデルを読めない: ${url}（${res.status}）`);
  const text = (await res.text()).trim();
  const bin = atob(text);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return loader.parseAsync(bytes.buffer, '');
}

/** 三人称の全身モデル（骨格とアニメーション付き） */
export interface CharacterModel {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

/** 一人称の腕（原点は手のひら） */
export interface FpArms {
  right: THREE.Object3D;
  left: THREE.Object3D;
}

export interface Assets {
  weapons: Record<WeaponId, THREE.Group>;
  weaponLods: Record<WeaponId, THREE.Group>;
  target: THREE.Group;
  ammoStation: THREE.Group;
  grenade: THREE.Group;
  /** グレネードの種類ごとのモデル（frag は grenade と同じ） */
  grenades: Record<GrenadeId, THREE.Object3D>;
  turret: THREE.Group;
  ammoDrop: THREE.Group;
  syringe: THREE.Group;
  /** タイムアタックの浮いているドローン */
  drone: THREE.Group;
  /** ブーストのティック（クモ型の地雷） */
  tick: THREE.Group;
  /** サイトとアタッチメントのモデル（Sight_<id>・Att_<id> という名前の子） */
  weaponParts: THREE.Group;
  characters: Record<CharacterId, CharacterModel>;
  /** 遠くに見えるとき用の、面を減らしたモデル（骨は characters と同じ。アニメーションはない） */
  characterLods: Record<CharacterId, CharacterModel>;
  /** 消耗戦の歩兵（パイロットと同じ骨格。マテリアル "TeamGlow" をチームの色にする） */
  grunt: CharacterModel;
  gruntLod: CharacterModel;
  fpArms: Record<CharacterId, FpArms>;
}

/** 照準のガラスは、向こうがよく見えるようにほぼ透明にする */
function tuneMaterials(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const sm = m as THREE.MeshStandardMaterial;
      if (sm.name === 'Glass') {
        sm.transparent = true;
        sm.opacity = 0.1;
        sm.depthWrite = false;
        sm.emissiveIntensity = 0.15;
        sm.roughness = 0.05;
      }
      // サイトのレンズ：のぞいたときに向こうがうっすら色づいて見える程度
      if (sm.name === 'SGlass' || sm.name === 'SGlassRed' || sm.name === 'SCoat') {
        sm.transparent = true;
        sm.opacity = sm.name === 'SCoat' ? 0.22 : sm.name === 'SGlassRed' ? 0.14 : 0.08;
        sm.depthWrite = false;
        sm.side = THREE.DoubleSide;
        sm.emissiveIntensity = 0.2;
        sm.roughness = 0.05;
      }
    }
  });
}

/** タワーディフェンスのモデル（タワーディフェンスを始めるときに1度だけ読み込む） */
export interface TdAssets {
  /** 突撃兵・重装兵（歩兵と同じ骨格） */
  assault: CharacterModel;
  heavy: CharacterModel;
  assaultLod: CharacterModel;
  heavyLod: CharacterModel;
  mg: THREE.Group;
  rocket: THREE.Group;
  slow: THREE.Group;
  repair: THREE.Group;
  core: THREE.Group;
  drone: THREE.Group;
  boss: THREE.Group;
  /** 購入メニューの設置物と、タレットの強化パーツ（Up2・Up3） */
  decoy: THREE.Group;
  wiretrap: THREE.Group;
  barricade: THREE.Group;
  jumppad: THREE.Group;
  upgrade: THREE.Group;
  /** 敵の降下ポッド */
  pod: THREE.Group;
  /** 迫撃砲兵（歩兵と同じ骨格）と、迫撃砲（据えた形・背負った形・砲弾。部品の名前は build_td.py） */
  mortar: CharacterModel;
  mortarLod: CharacterModel;
  mortarProp: THREE.Group;
}

let tdAssets: Promise<TdAssets> | null = null;
export function loadTdAssets(): Promise<TdAssets> {
  if (tdAssets) return tdAssets;
  const loader = new GLTFLoader();
  tdAssets = (async () => {
    const [assault, heavy, mg, rocket, slow, repair, core, drone, boss, assaultLod, heavyLod, decoy, wiretrap, barricade, jumppad, upgrade, pod, mortar, mortarLod, mortarProp] = await Promise.all(
      [assaultUrl, heavyUrl, tdMgUrl, tdRocketUrl, tdSlowUrl, tdRepairUrl, tdCoreUrl, tdDroneUrl, tdBossUrl, assaultLodUrl, heavyLodUrl, tdDecoyUrl, tdWiretrapUrl, tdBarricadeUrl, tdJumppadUrl, tdUpgradeUrl, tdPodUrl, mortarUrl, mortarLodUrl, tdMortarUrl].map((u) =>
        loadGltfFrom(loader, u),
      ),
    );
    return {
      assault: { scene: assault.scene, animations: assault.animations },
      heavy: { scene: heavy.scene, animations: heavy.animations },
      assaultLod: { scene: assaultLod.scene, animations: [] },
      heavyLod: { scene: heavyLod.scene, animations: [] },
      mg: mg.scene,
      rocket: rocket.scene,
      slow: slow.scene,
      repair: repair.scene,
      core: core.scene,
      drone: drone.scene,
      boss: boss.scene,
      decoy: decoy.scene,
      wiretrap: wiretrap.scene,
      barricade: barricade.scene,
      jumppad: jumppad.scene,
      upgrade: upgrade.scene,
      pod: pod.scene,
      mortar: { scene: mortar.scene, animations: mortar.animations },
      mortarLod: { scene: mortarLod.scene, animations: [] },
      mortarProp: mortarProp.scene,
    };
  })();
  tdAssets.catch(() => (tdAssets = null));
  return tdAssets;
}

export async function loadAssets(): Promise<Assets> {
  const loader = new GLTFLoader();
  const loadGltf = async (url: string) => {
    const gltf = await loadGltfFrom(loader, url);
    tuneMaterials(gltf.scene);
    return gltf;
  };
  const load = async (url: string) => (await loadGltf(url)).scene;
  const ids = Object.keys(WEAPON_URLS) as WeaponId[];
  const [weaponScenes, weaponLodScenes, weaponParts, target, ammoStation, grenade, turret, ammoDrop, syringe, drone, chars, arms, gruntGltf, lods, gruntLodGltf, tick, ordnance] = await Promise.all([
    Promise.all(ids.map((id) => load(WEAPON_URLS[id]))),
    Promise.all(ids.map((id) => load(WEAPON_LOD_URLS[id]))),
    load(sightsUrl),
    load(targetUrl),
    load(ammoUrl),
    load(grenadeUrl),
    load(turretUrl),
    load(ammoDropUrl),
    load(syringeUrl),
    load(droneUrl),
    Promise.all(CHARACTER_IDS.map((id) => loadGltf(CHARACTER_URLS[id]))),
    Promise.all(CHARACTER_IDS.map((id) => load(FP_ARM_URLS[id]))),
    loadGltf(gruntUrl),
    Promise.all(CHARACTER_IDS.map((id) => load(CHARACTER_LOD_URLS[id]))),
    load(gruntLodUrl),
    load(tickUrl),
    load(ordnanceUrl),
  ]);
  // グレネードの種類：1 つのファイルから名前で取り出す（Blender のルートの名前）
  const ORD_NAMES: Record<Exclude<GrenadeId, 'frag'>, string> = { arc: 'ArcGrenade', firestar: 'Firestar', gravity: 'GravityStar', smoke: 'SmokeGrenade', satchel: 'Satchel' };
  const grenades: Partial<Record<GrenadeId, THREE.Object3D>> = { frag: grenade };
  for (const [k, name] of Object.entries(ORD_NAMES) as Array<[Exclude<GrenadeId, 'frag'>, string]>) {
    const o = ordnance.getObjectByName(name) ?? new THREE.Group();
    o.removeFromParent();
    o.position.set(0, 0, 0);
    o.rotation.set(0, 0, 0);
    grenades[k] = o;
  }
  const weapons = {} as Record<WeaponId, THREE.Group>;
  const weaponLods = {} as Record<WeaponId, THREE.Group>;
  ids.forEach((id, i) => {
    weapons[id] = weaponScenes[i];
    weaponLods[id] = weaponLodScenes[i];
  });
  const characters = {} as Record<CharacterId, CharacterModel>;
  const characterLods = {} as Record<CharacterId, CharacterModel>;
  const fpArms = {} as Record<CharacterId, FpArms>;
  CHARACTER_IDS.forEach((id, i) => {
    characters[id] = { scene: chars[i].scene, animations: chars[i].animations };
    characterLods[id] = { scene: lods[i], animations: [] };
    const right = arms[i].getObjectByName('ArmR')!;
    const left = arms[i].getObjectByName('ArmL')!;
    right.position.set(0, 0, 0);
    left.position.set(0, 0, 0);
    fpArms[id] = { right, left };
  });
  const grunt = { scene: gruntGltf.scene, animations: gruntGltf.animations };
  const gruntLod = { scene: gruntLodGltf, animations: [] };
  return { weapons, weaponLods, weaponParts, target, ammoStation, grenade, grenades: grenades as Record<GrenadeId, THREE.Object3D>, turret, ammoDrop, syringe, drone, tick, characters, characterLods, grunt, gruntLod, fpArms };
}
