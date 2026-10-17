/**
 * 一人称の武器表示（ビューモデル）。
 * 武器は専用のシーンとカメラで描き、世界の上に重ねる（壁にめり込んで見えないようにするため）。
 * 構え・エイム・反動・リロード・持ち替え・ダッシュ・揺れの動きをここで付ける。
 */
import * as THREE from 'three';
import type { AbilityType, GrenadeId, SightId, WeaponId } from '../../config';
import type { FpArms } from '../assets';
import type { WeaponCustom } from '../../shared/weaponCustom';
import { type AppliedMods, applyWeaponMods } from './weaponMods';

/** サイトをのぞいたときの、目からサイトの後ろの端までの距離（m）。倍率のあるスコープほど目を近づける */
const EYE_DIST: Record<SightId, number> = { iron: 0, reddot: 0.17, holo: 0.15, x2: 0.072, x3: 0.066, threat: 0.07, sniper: 0.06, variable: 0.06 };

interface PoseDef {
  hip: THREE.Vector3;
  /** エイム時の位置（照準の中心がカメラの正面に来る） */
  ads: THREE.Vector3;
  /** 撃った時に後ろへ下がる量（m）と、銃口が上がる量（ラジアン） */
  kickBack: number;
  kickRot: number;
  flashScale: number;
  flashColor: number;
}

const POSES: Record<WeaponId, PoseDef> = {
  // ads の z は「照準器がカメラから 30cm ほど先に来る」位置
  ar: { hip: new THREE.Vector3(0.175, -0.15, -0.44), ads: new THREE.Vector3(0, 0, -0.25), kickBack: 0.035, kickRot: 0.05, flashScale: 1, flashColor: 0xffc27a },
  lmg: { hip: new THREE.Vector3(0.19, -0.165, -0.41), ads: new THREE.Vector3(0, 0, -0.03), kickBack: 0.03, kickRot: 0.035, flashScale: 1.15, flashColor: 0xffa860 },
  smg: { hip: new THREE.Vector3(0.16, -0.14, -0.38), ads: new THREE.Vector3(0, 0, -0.24), kickBack: 0.025, kickRot: 0.04, flashScale: 0.8, flashColor: 0xffd28a },
  shotgun: { hip: new THREE.Vector3(0.175, -0.155, -0.44), ads: new THREE.Vector3(0, 0, -0.17), kickBack: 0.09, kickRot: 0.16, flashScale: 1.6, flashColor: 0xffb060 },
  sniper: { hip: new THREE.Vector3(0.175, -0.15, -0.42), ads: new THREE.Vector3(0, 0, -0.12), kickBack: 0.1, kickRot: 0.2, flashScale: 1.5, flashColor: 0xffc890 },
  // ハンドガン：腕をのばして前に構える（照門が目から 35cm ほど先）
  pistol: { hip: new THREE.Vector3(0.1, -0.112, -0.38), ads: new THREE.Vector3(0, 0, -0.43), kickBack: 0.03, kickRot: 0.14, flashScale: 0.75, flashColor: 0xffd890 },
  burst: { hip: new THREE.Vector3(0.17, -0.15, -0.4), ads: new THREE.Vector3(0, 0, -0.22), kickBack: 0.03, kickRot: 0.045, flashScale: 0.95, flashColor: 0xd8ff9a },
  psmg: { hip: new THREE.Vector3(0.16, -0.14, -0.36), ads: new THREE.Vector3(0, 0, -0.26), kickBack: 0.02, kickRot: 0.03, flashScale: 0.7, flashColor: 0xffc0b0 },
  // サイクロン：大きいので低く・右に構える
  spinlmg: { hip: new THREE.Vector3(0.2, -0.185, -0.4), ads: new THREE.Vector3(0, 0, -0.08), kickBack: 0.02, kickRot: 0.022, flashScale: 1.2, flashColor: 0xffe08a },
  autosg: { hip: new THREE.Vector3(0.175, -0.155, -0.42), ads: new THREE.Vector3(0, 0, -0.2), kickBack: 0.065, kickRot: 0.11, flashScale: 1.45, flashColor: 0xa8c0ff },
  marksman: { hip: new THREE.Vector3(0.175, -0.15, -0.42), ads: new THREE.Vector3(0, 0, -0.25), kickBack: 0.06, kickRot: 0.1, flashScale: 1.2, flashColor: 0xfff0c8 },
  revolver: { hip: new THREE.Vector3(0.1, -0.115, -0.37), ads: new THREE.Vector3(0, 0, -0.42), kickBack: 0.05, kickRot: 0.26, flashScale: 0.95, flashColor: 0xffc0d0 },
};

/** 銃口の向き（武器のモデルの -Z）の軸 */
const BORE_AXIS = new THREE.Vector3(0, 0, 1);

interface WeaponModel {
  root: THREE.Object3D;
  /** 一人称の腕を付ける位置（右手＝グリップ、左手＝銃身の下） */
  gripR: THREE.Object3D;
  gripL: THREE.Object3D;
  /** 弾倉（ショットガンは先台、リボルバーはシリンダー） */
  part?: THREE.Object3D;
  partRest: THREE.Vector3;
  /** 回転式 LMG の回る銃身の束 */
  barrels?: THREE.Object3D;
  /** 回す前の向き（Blender でまとめた部品は向きを持っているので、それに銃口の向きの回転を重ねる） */
  barrelsRest: THREE.Quaternion;
  partRestQ: THREE.Quaternion;
  muzzle: THREE.Object3D;
  flash: THREE.Group;
  /** サイト・アタッチメント */
  mods: AppliedMods | null;
  /** エイム時の位置（サイトを付けたら、サイトをのぞく位置） */
  ads: THREE.Vector3;
  sight: SightId;
  laserBeam: THREE.Mesh | null;
}

export interface ViewmodelState {
  weapon: WeaponId;
  ads: number;
  /** リロードの進み具合（0〜1）。リロードしていなければ -1 */
  reload: number;
  perShellReload: boolean;
  /** 持ち替えの進み具合（0〜1）。持ち替え中でなければ 1 */
  swap: number;
  sprint: boolean;
  /** 撃った直後（ダッシュしたまま撃てる武器は、撃つ間だけ銃を前に向ける） */
  firing: boolean;
  slide: boolean;
  bobPhase: number;
  bobAmount: number;
  /** カメラの傾き（ラジアン） */
  roll: number;
  /** このフレームの視点の動き（ラジアン） */
  lookDeltaYaw: number;
  lookDeltaPitch: number;
  /** 着地の沈み込み（m） */
  dip: number;
  /** スコープをのぞいている（武器を隠す） */
  scoped: boolean;
  /** グレネードを構えている */
  cooking: boolean;
  /** 光学迷彩の効き具合（0〜1） */
  cloak: number;
  /** フェイズシフトの準備中・最中（武器を下げる） */
  phase: number;
  /** 回転式の銃身の回り具合（0〜1） */
  spin: number;
}

/** アビリティを使ったときの左手の動き */
type Gesture = 'reach' | 'push' | 'ear' | 'inject' | 'phase';
const GESTURE_OF: Record<AbilityType, Gesture> = {
  grapple: 'reach',
  shield: 'push',
  sonar: 'ear',
  overdrive: 'inject',
  phase: 'phase',
  cloak: 'ear',
};
const GESTURE_TIME: Record<Gesture, number> = { reach: 0.45, push: 0.5, ear: 0.55, inject: 0.6, phase: 0.5 };

const ease = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};
const damp = (cur: number, target: number, rate: number, dt: number) => target + (cur - target) * Math.exp(-rate * dt);

function makeFlashTexture(): THREE.CanvasTexture {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,220,160,0.9)');
  grad.addColorStop(1, 'rgba(255,140,40,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  // 星形の筋
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = 'rgba(255,230,180,0.8)';
  g.lineWidth = 6;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    g.beginPath();
    g.moveTo(s / 2, s / 2);
    g.lineTo(s / 2 + Math.cos(a) * s * 0.48, s / 2 + Math.sin(a) * s * 0.48);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Viewmodel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(56, 16 / 9, 0.01, 20);
  private readonly rig = new THREE.Group();
  private readonly models = new Map<WeaponId, WeaponModel>();
  private current: WeaponId;
  private flashTimer = 0;

  // ばね（反動）
  private kickZ = 0;
  private kickZVel = 0;
  private kickRot = 0;
  private kickRotVel = 0;
  // 揺れ
  private swayX = 0;
  private swayY = 0;
  private sprintK = 0;
  private slideK = 0;
  // ショットガンの先台・スナイパーのボルト操作
  private actionTimer = 0;
  private actionDuration = 0;
  private shellBounce = 0;

  // グレネード（手に持つもの）と、投げる・殴る動き
  /** 手に持つグレネード（種類ごとのモデルを入れておき、選んでいる種類だけ見せる） */
  private readonly grenade = new THREE.Group();
  private readonly grenadeModels = new Map<GrenadeId, THREE.Object3D>();
  private grenadeKind: GrenadeId = 'frag';
  private grenadePin: THREE.Object3D | null = null;
  private cookK = 0;
  private throwTimer = 0;
  private meleeTimer = 0;
  private meleeHit = false;
  static readonly THROW_TIME = 0.42;
  static readonly MELEE_TIME = 0.42;

  // 一人称の腕（キャラクターごと）。武器ごとに右手・左手を付け、グレネード用・アビリティ用の左手も持つ
  private readonly armMeshes: THREE.Object3D[] = [];
  private grenadeArm: THREE.Object3D | null = null;
  private gestureArm: THREE.Object3D | null = null;
  private readonly gestureRig = new THREE.Group();
  private syringe: THREE.Object3D | null = null;
  private gesture: Gesture | null = null;
  private gestureTimer = 0;
  private phaseK = 0;
  private barrelAngle = 0;
  private cylAngle = 0;
  private cylTarget = 0;
  // 光学迷彩：元のマテリアルを覚えておき、透明なマテリアルに差し替える
  private cloakOn = false;
  private readonly cloakMat: THREE.ShaderMaterial;
  private readonly savedMats = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();

  constructor(weapons: Record<WeaponId, THREE.Group>, environment: THREE.Texture | null, initial: WeaponId, grenadeModels: Record<GrenadeId, THREE.Object3D>) {
    this.scene.environment = environment;
    this.scene.environmentIntensity = 0.7;
    this.scene.add(new THREE.HemisphereLight('#b59cff', '#20142e', 1.1));
    const key = new THREE.DirectionalLight('#ffd0b0', 2.2);
    key.position.set(-1, 2, 1);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight('#4fd1ff', 1.2);
    rim.position.set(2, 0.5, -1);
    this.scene.add(rim);
    this.scene.add(this.camera);
    this.camera.add(this.rig);

    const flashTex = makeFlashTexture();
    for (const [id, src] of Object.entries(weapons) as Array<[WeaponId, THREE.Group]>) {
      const root = src.clone(true);
      root.visible = false;
      const part = root.getObjectByName('Magazine') ?? root.getObjectByName('Pump') ?? root.getObjectByName('Cylinder') ?? undefined;
      const muzzle = root.getObjectByName('Muzzle') ?? root;
      const gripR = root.getObjectByName('GripR') ?? root;
      // ショットガンは先台を動かすので、左手は先台に付ける
      const gripLSrc = root.getObjectByName('GripL') ?? root;
      let gripL = gripLSrc;
      if (id === 'shotgun' && part) {
        gripL = new THREE.Object3D();
        part.add(gripL);
        gripL.position.copy(gripLSrc.position).sub(part.position);
      }
      root.traverse((o) => {
        o.frustumCulled = false;
      });
      const flash = this.makeFlash(flashTex, POSES[id]);
      muzzle.add(flash);
      this.rig.add(root);
      const barrels = root.getObjectByName('Barrels') ?? undefined;
      this.models.set(id, {
        root,
        gripR,
        gripL,
        part,
        partRest: part ? part.position.clone() : new THREE.Vector3(),
        partRestQ: part ? part.quaternion.clone() : new THREE.Quaternion(),
        barrels,
        barrelsRest: barrels ? barrels.quaternion.clone() : new THREE.Quaternion(),
        muzzle,
        flash,
        mods: null,
        ads: POSES[id].ads.clone(),
        sight: 'iron',
        laserBeam: null,
      });
    }
    this.current = initial;
    this.models.get(initial)!.root.visible = true;

    // グレネードは武器とは別に、画面の左下に持つ（種類ごとのモデルを入れておく）
    for (const [k, src] of Object.entries(grenadeModels) as Array<[GrenadeId, THREE.Object3D]>) {
      const m = src.clone(true);
      m.scale.setScalar(k === 'frag' ? 1.1 : k === 'satchel' ? 0.85 : 1.0);
      // 星は手のひらに立てて持つ
      if (k === 'firestar' || k === 'gravity') m.rotation.set(0.3, 0, 0.5);
      if (k === 'satchel') m.rotation.set(-0.6, 0.4, 0);
      m.visible = k === 'frag';
      m.traverse((o) => (o.frustumCulled = false));
      this.grenade.add(m);
      this.grenadeModels.set(k, m);
    }
    this.grenade.visible = false;
    this.grenadePin = this.grenadeModels.get('frag')?.getObjectByName('Pin') ?? null;
    this.camera.add(this.grenade);
    this.camera.add(this.gestureRig);
    this.gestureRig.visible = false;

    // レーザーの光の筋のシェーダーを、読み込みのときに作っておくための見えない板
    const laserKeeper = new THREE.Mesh(new THREE.PlaneGeometry(0.001, 0.001), this.laserMat);
    laserKeeper.visible = false;
    this.scene.add(laserKeeper);
    this.cloakMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uK: { value: 1 } },
      vertexShader: /* glsl */ `
        varying vec3 vN; varying vec3 vV; varying vec3 vP;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz);
          vP = position;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform float uK;
        varying vec3 vN; varying vec3 vV; varying vec3 vP;
        void main() {
          float rim = pow(1.0 - abs(dot(vN, vV)), 2.2);
          float bands = 0.5 + 0.5 * sin(vP.y * 160.0 + vP.x * 40.0 - uTime * 9.0);
          float a = (rim * 0.55 + bands * 0.05) * uK;
          gl_FragColor = vec4(vec3(0.55, 1.0, 0.75) * a, a);
        }`,
    });
  }

  /** キャラクターの腕に付け替える */
  setArms(arms: FpArms, syringe: THREE.Object3D | null): void {
    this.applyCloak(false); // 迷彩中に付け替えると元のマテリアルに戻せなくなるので、先に戻す
    for (const m of this.armMeshes) m.removeFromParent();
    this.armMeshes.length = 0;
    this.savedMats.clear();
    const mk = (src: THREE.Object3D) => {
      const a = src.clone(true);
      a.traverse((o) => (o.frustumCulled = false));
      this.armMeshes.push(a);
      return a;
    };
    for (const m of this.models.values()) {
      m.gripR.add(mk(arms.right));
      m.gripL.add(mk(arms.left));
    }
    // グレネードを持つ左手（グレネードの下に手のひら）
    this.grenadeArm = mk(arms.left);
    this.grenadeArm.position.set(0.01, -0.03, 0.02);
    this.grenadeArm.rotation.set(0.3, 0.2, 0);
    this.grenade.add(this.grenadeArm);
    // アビリティの動きをする左手
    this.gestureArm = mk(arms.left);
    this.gestureRig.add(this.gestureArm);
    if (syringe && !this.syringe) {
      this.syringe = syringe.clone(true);
      this.syringe.traverse((o) => (o.frustumCulled = false));
    }
    if (this.syringe) {
      this.syringe.removeFromParent();
      this.syringe.position.set(0, 0.0, -0.01);
      this.syringe.rotation.set(-1.2, 0, 0);
      this.gestureArm.add(this.syringe);
    }
  }

  /** アビリティを使ったときの手の動き */
  onAbility(type: AbilityType): void {
    this.gesture = GESTURE_OF[type];
    this.gestureTimer = GESTURE_TIME[this.gesture];
  }

  private applyCloak(on: boolean) {
    if (on === this.cloakOn) return;
    this.cloakOn = on;
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (on) {
        if (!this.savedMats.has(m)) this.savedMats.set(m, m.material);
        m.material = this.cloakMat;
      } else {
        const orig = this.savedMats.get(m);
        if (orig) m.material = orig;
      }
    });
    if (!on) this.savedMats.clear();
  }

  /** グレネードを投げた瞬間 */
  onThrow(): void {
    this.throwTimer = Viewmodel.THROW_TIME;
  }

  /** 手に持つグレネードの種類 */
  setGrenadeKind(kind: GrenadeId): void {
    if (kind === this.grenadeKind) return;
    this.grenadeKind = kind;
    for (const [k, m] of this.grenadeModels) m.visible = k === kind;
    const pinName = kind === 'frag' ? 'Pin' : kind === 'arc' ? 'ArcPin' : kind === 'smoke' ? 'SmokePin' : '';
    this.grenadePin = pinName ? (this.grenadeModels.get(kind)?.getObjectByName(pinName) ?? null) : null;
  }

  /** サッチェルを起爆した（左手で起爆スイッチを押す） */
  onDetonate(): void {
    this.gesture = 'push';
    this.gestureTimer = GESTURE_TIME.push;
  }

  /** 格闘：銃床で殴る */
  onMelee(hit: boolean): void {
    this.meleeTimer = Viewmodel.MELEE_TIME;
    this.meleeHit = hit;
  }

  private makeFlash(tex: THREE.Texture, pose: PoseDef): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      color: new THREE.Color(pose.flashColor).multiplyScalar(3),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    // 正面から見た星形と、横から見える2枚の板
    const front = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.16), mat);
    const side1 = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.24), mat);
    side1.rotation.x = Math.PI / 2;
    side1.position.z = -0.1;
    const side2 = side1.clone();
    side2.rotation.y = Math.PI / 2;
    g.add(front, side1, side2);
    g.scale.setScalar(pose.flashScale);
    g.visible = false;
    return g;
  }

  private parts: THREE.Object3D | null = null;

  /** サイト・アタッチメントのモデル（sights.glb） */
  setParts(parts: THREE.Object3D): void {
    this.parts = parts;
  }

  /** 武器のカスタマイズを見た目に入れる（サイト・銃口・レーザー・弾倉） */
  setCustom(id: WeaponId, custom: WeaponCustom): void {
    const m = this.models.get(id);
    if (!m) return;
    const mods = applyWeaponMods(m.root, id, custom, this.parts);
    m.mods = mods;
    m.sight = custom.sight;
    // マズルフラッシュは銃口の部品の先から。サプレッサーなら小さく
    m.flash.removeFromParent();
    mods.muzzle.add(m.flash);
    m.flash.userData.base = POSES[id].flashScale * (mods.suppressed ? 0.32 : 1);
    m.flash.scale.setScalar(m.flash.userData.base as number);
    m.muzzle = mods.muzzle;
    // のぞく位置：サイトの目の側の端が、目の前 EYE_DIST に来るように
    if (mods.eye && EYE_DIST[custom.sight] > 0) m.ads.set(-mods.eye.x, -mods.eye.y, -EYE_DIST[custom.sight] - mods.eye.z);
    else m.ads.copy(POSES[id].ads);
    // レーザー：短い赤い光の筋（世界に映る点は game が出す）
    if (m.laserBeam) {
      m.laserBeam.removeFromParent();
      m.laserBeam.geometry.dispose();
      m.laserBeam = null;
    }
    if (mods.laser) {
      const len = 0.9;
      const geo = new THREE.CylinderGeometry(0.0011, 0.0011, len, 6, 1, true);
      geo.rotateX(Math.PI / 2);
      geo.translate(0, 0, -len / 2);
      const beam = new THREE.Mesh(geo, this.laserMat);
      beam.frustumCulled = false;
      mods.laser.add(beam);
      m.laserBeam = beam;
    }
  }

  private readonly laserMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `varying float vT; void main() { vT = -position.z / 0.9; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `varying float vT; uniform float uK; void main() { float a = (1.0 - vT) * 0.85 * uK; gl_FragColor = vec4(vec3(1.0, 0.15, 0.2) * a * 2.0, a); }`,
    uniforms: { uK: { value: 1 } },
  });

  setWeapon(id: WeaponId): void {
    if (id === this.current) return;
    this.models.get(this.current)!.root.visible = false;
    this.current = id;
    this.models.get(id)!.root.visible = true;
    this.actionTimer = 0;
  }

  /** 撃った瞬間の動き（反動・マズルフラッシュ） */
  onShot(id: WeaponId): void {
    const p = POSES[id];
    this.kickZVel += p.kickBack * 30;
    this.kickRotVel += p.kickRot * 30;
    this.flashTimer = 0.05;
    const m = this.models.get(id)!;
    m.flash.rotation.z = Math.random() * Math.PI;
    m.flash.scale.setScalar(((m.flash.userData.base as number | undefined) ?? p.flashScale) * (0.85 + Math.random() * 0.4));
    if (id === 'revolver') this.cylTarget += Math.PI / 3;
    if (id === 'shotgun') {
      this.actionDuration = 0.45;
      this.actionTimer = 0.45;
    } else if (id === 'sniper') {
      this.actionDuration = 0.8;
      this.actionTimer = 0.8;
    }
  }

  onShellLoaded(): void {
    this.shellBounce = 1;
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  update(dt: number, s: ViewmodelState): void {
    this.setWeapon(s.weapon);
    const model = this.models.get(s.weapon)!;
    const pose = POSES[s.weapon];

    // 反動のばね
    const k = 260,
      d = 24;
    for (let left = dt; left > 1e-6; left -= 1 / 240) {
      const h = Math.min(left, 1 / 240);
      this.kickZVel += (-k * this.kickZ - d * this.kickZVel) * h;
      this.kickZ += this.kickZVel * h;
      this.kickRotVel += (-k * this.kickRot - d * this.kickRotVel) * h;
      this.kickRot += this.kickRotVel * h;
    }

    // 視点の動きに遅れてついてくる揺れ
    const swayScale = 1 - s.ads * 0.85;
    this.swayX = damp(this.swayX, THREE.MathUtils.clamp(s.lookDeltaYaw * 0.9, -0.03, 0.03) * swayScale, 10, dt);
    this.swayY = damp(this.swayY, THREE.MathUtils.clamp(-s.lookDeltaPitch * 0.9, -0.03, 0.03) * swayScale, 10, dt);
    this.sprintK = damp(this.sprintK, s.sprint && s.ads < 0.1 && s.reload < 0 && !s.firing ? 1 : 0, s.firing ? 22 : 9, dt);
    this.slideK = damp(this.slideK, s.slide ? 1 : 0, 8, dt);
    this.shellBounce = damp(this.shellBounce, 0, 14, dt);
    this.actionTimer = Math.max(0, this.actionTimer - dt);
    this.flashTimer -= dt;
    model.flash.visible = this.flashTimer > 0;

    // 基本の位置：腰だめ ⇔ エイム
    const a = ease(s.ads);
    const pos = pose.hip.clone().lerp(model.ads, a);
    const rot = new THREE.Euler(0.02 * (1 - a), 0.045 * (1 - a), 0, 'YXZ');

    // 走っているときの揺れ
    const bob = s.bobAmount * (1 - a * 0.85);
    pos.x += Math.cos(s.bobPhase) * 0.007 * bob + this.swayX;
    pos.y += -Math.abs(Math.sin(s.bobPhase)) * 0.009 * bob + this.swayY + s.dip * 0.25;

    // ダッシュ中は銃を下げて斜めに構える
    const sp = ease(this.sprintK);
    pos.x += -0.03 * sp;
    pos.y += -0.045 * sp;
    pos.z += 0.03 * sp;
    rot.x += -0.32 * sp;
    rot.y += 0.6 * sp;
    rot.z += 0.22 * sp;

    // スライディング中は少し傾ける
    rot.z += 0.18 * this.slideK * (1 - a);

    // 反動
    pos.z += this.kickZ * (1 - a * 0.5);
    rot.x += this.kickRot * (1 - a * 0.4);

    // ショットガンの先台・スナイパーのボルト操作
    if (this.actionTimer > 0 && this.actionDuration > 0) {
      const t = 1 - this.actionTimer / this.actionDuration;
      const bump = Math.sin(Math.min(1, t * 1.3) * Math.PI);
      if (s.weapon === 'shotgun') {
        if (model.part) model.part.position.z = model.partRest.z + 0.075 * bump;
        rot.x += 0.05 * bump;
      } else if (s.weapon === 'sniper') {
        rot.z += 0.25 * bump * (1 - a);
        pos.y -= 0.02 * bump * (1 - a);
      }
    } else if (model.part && s.weapon === 'shotgun') {
      model.part.position.z = model.partRest.z;
    }

    // 回転式の銃身：回り具合で回す
    if (model.barrels) {
      this.barrelAngle += dt * s.spin * 46;
      // 銃身の軸（銃口の向き＝モデルの Z 軸）のまわりに回す
      model.barrels.quaternion.setFromAxisAngle(BORE_AXIS, this.barrelAngle).multiply(model.barrelsRest);
    }
    // リボルバー：撃つたびにシリンダーが 1 発ぶん回る
    const revolver = s.weapon === 'revolver';
    if (revolver && model.part) {
      this.cylAngle += (this.cylTarget - this.cylAngle) * Math.min(1, dt * 22);
      model.part.quaternion.setFromAxisAngle(BORE_AXIS, -this.cylAngle).multiply(model.partRestQ);
    }

    // リロード
    if (model.part && s.weapon !== 'shotgun') {
      model.part.position.copy(model.partRest);
      model.part.visible = true;
    }
    if (s.reload >= 0) {
      const r = s.reload;
      if (s.perShellReload) {
        // 1発ずつ込める：銃を少し傾けて保ち、込めるたびに小さく揺れる
        const tilt = ease(Math.min(1, r * 8)) ;
        rot.z += 0.45 * tilt;
        rot.x += 0.12 * tilt + 0.05 * this.shellBounce;
        pos.y -= 0.03 * tilt;
      } else {
        const inOut = ease(r / 0.15) * (1 - ease((r - 0.85) / 0.15));
        rot.z += 0.55 * inOut;
        rot.x += 0.28 * inOut;
        pos.y -= 0.04 * inOut;
        pos.x -= 0.02 * inOut;
        if (model.part && revolver) {
          // リボルバー：シリンダーを左へ振り出して回し、戻す
          const out = ease((r - 0.12) / 0.15);
          const back = ease((r - 0.78) / 0.12);
          const swing = out * (1 - back);
          model.part.position.x = model.partRest.x - 0.032 * swing;
          model.part.position.y = model.partRest.y - 0.008 * swing;
          if (r > 0.3 && r < 0.7) this.cylTarget += dt * 9;
          rot.z += 0.25 * swing;
        } else if (model.part) {
          // 弾倉を下へ抜き、新しい弾倉を差し込む
          const out = ease((r - 0.15) / 0.2);
          const back = ease((r - 0.55) / 0.2);
          const drop = out * (1 - back);
          model.part.position.y = model.partRest.y - 0.28 * drop;
          model.part.visible = !(r > 0.38 && r < 0.5);
          if (r > 0.75 && r < 0.82) rot.x += 0.04; // 差し込んだ手ごたえ
        }
      }
    }

    // 持ち替え：下から持ち上げる
    if (s.swap < 1) {
      const up = ease(s.swap);
      pos.y -= 0.32 * (1 - up);
      rot.x -= 0.7 * (1 - up);
    }

    // --- グレネード：構えると銃を右下へ下げ、左手にグレネードを持つ。離すと前へ投げる ---
    this.cookK = damp(this.cookK, s.cooking ? 1 : 0, 16, dt);
    this.throwTimer = Math.max(0, this.throwTimer - dt);
    const throwT = this.throwTimer > 0 ? 1 - this.throwTimer / Viewmodel.THROW_TIME : 1;
    const throwArc = this.throwTimer > 0 ? Math.sin(Math.min(1, throwT) * Math.PI) : 0;
    const lower = Math.max(ease(this.cookK), throwArc);
    pos.x += 0.05 * lower;
    pos.y -= 0.09 * lower;
    rot.x -= 0.35 * lower;
    rot.z -= 0.2 * lower;
    const g = this.grenade;
    if (s.cooking || (this.throwTimer > 0 && throwT < 0.35)) {
      g.visible = true;
      const k = ease(this.cookK);
      if (s.cooking) {
        // 構え：左下から持ち上げ、少し後ろへ引く
        g.position.set(-0.19 + 0.03 * k, -0.27 + 0.1 * k, -0.5 + 0.04 * k);
        g.rotation.set(0.4, 0.6 + 0.3 * k, 0.2);
      } else {
        // 投げ：前へ振り抜く
        const t = throwT / 0.35;
        g.position.set(-0.17 + 0.12 * t, -0.16 + 0.05 * Math.sin(t * Math.PI), -0.37 - 0.35 * t);
        g.rotation.set(0.4 - 2.5 * t, 0.9, 0.2);
      }
      if (this.grenadePin) this.grenadePin.visible = !s.cooking || this.cookK < 0.6;
    } else {
      g.visible = false;
      if (this.grenadePin) this.grenadePin.visible = true;
    }

    // --- 格闘：銃を左へ振って銃床で突く ---
    this.meleeTimer = Math.max(0, this.meleeTimer - dt);
    if (this.meleeTimer > 0) {
      const t = 1 - this.meleeTimer / Viewmodel.MELEE_TIME;
      // 0〜0.35 で振りかぶって突き出し、そこから戻る
      const out = t < 0.35 ? ease(t / 0.35) : 1 - ease((t - 0.35) / 0.65);
      const snap = this.meleeHit && t > 0.3 && t < 0.42 ? 0.015 : 0;
      pos.x -= 0.16 * out;
      pos.y += 0.04 * out;
      pos.z -= 0.12 * out + snap;
      rot.y -= 1.1 * out;
      rot.z += 0.5 * out;
      rot.x += 0.15 * out;
    }

    // --- アビリティの手の動き（左手を銃から離して使う） ---
    this.gestureTimer = Math.max(0, this.gestureTimer - dt);
    const gesturing = this.gesture !== null && this.gestureTimer > 0;
    if (gesturing) this.updateGesture(this.gesture!, 1 - this.gestureTimer / GESTURE_TIME[this.gesture!], pos, rot);
    else this.gesture = null;
    this.gestureRig.visible = gesturing;

    // --- フェイズシフト：武器を下げ、手を前にかざす ---
    this.phaseK = damp(this.phaseK, s.phase > 0 ? 1 : 0, 10, dt);
    if (this.phaseK > 0.01) {
      const p = ease(this.phaseK);
      pos.y -= 0.25 * p;
      rot.x -= 0.6 * p;
    }

    // 左手：グレネードやアビリティで使っている間は銃から離す
    const leftBusy = gesturing || g.visible;
    for (const m of this.models.values()) {
      const left = m.gripL.children[m.gripL.children.length - 1];
      if (left && this.armMeshes.includes(left)) left.visible = !leftBusy;
    }

    model.root.position.copy(pos);
    model.root.rotation.copy(rot);
    model.root.visible = !s.scoped;
    // レーザーの筋は、エイムしていない間だけ
    this.laserMat.uniforms.uK.value = Math.max(0, 1 - a * 1.6);
    this.camera.rotation.set(0, 0, s.roll);

    // 光学迷彩
    // 迷彩の効き具合が半分を超えたら透明な見た目に切り替える（戻すときも半分で元に戻す）
    this.applyCloak(s.cloak > 0.5);
    this.cloakMat.uniforms.uTime.value += dt;
    this.cloakMat.uniforms.uK.value = Math.min(1, (s.cloak - 0.5) * 4 + 0.4);
  }

  /** t は 0〜1 の進み具合。銃の位置（pos・rot）も少し動かす */
  private updateGesture(kind: Gesture, t: number, pos: THREE.Vector3, rot: THREE.Euler) {
    const arm = this.gestureRig;
    // 出して、少し止めて、戻す
    const out = t < 0.35 ? ease(t / 0.35) : t < 0.7 ? 1 : 1 - ease((t - 0.7) / 0.3);
    if (this.syringe) this.syringe.visible = kind === 'inject';
    // 左手を画面の左下の外から持ち上げる
    switch (kind) {
      case 'reach': // ワイヤー：左腕を前へ突き出す
        arm.position.set(-0.16 + 0.04 * out, -0.32 + 0.16 * out, -0.35 - 0.2 * out);
        arm.rotation.set(0.15 * out, 0.15, 0.3 - 0.2 * out);
        pos.x += 0.03 * out;
        break;
      case 'push': // シールド：手のひらを前に押し出す
        arm.position.set(-0.12 + 0.02 * out, -0.34 + 0.2 * out, -0.32 - 0.16 * out);
        arm.rotation.set(0.9 * out, 0, 0.1);
        pos.y -= 0.03 * out;
        break;
      case 'ear': // ソナー・迷彩：左手でヘッドセット（顔の横）に触れる
        arm.position.set(-0.24 + 0.06 * out, -0.36 + 0.3 * out, -0.25 + 0.02 * out);
        arm.rotation.set(0.6 * out, -0.4 * out, 0.9 * out);
        break;
      case 'inject': {
        // 注射器を持ち上げて、太ももへ刺す
        const stab = t < 0.5 ? ease(t / 0.5) : 1;
        const down = t > 0.5 ? ease((t - 0.5) / 0.25) : 0;
        arm.position.set(-0.14, -0.3 + 0.12 * stab - 0.25 * down, -0.38 + 0.05 * down);
        arm.rotation.set(-0.4 + 1.6 * down, 0.2, 0.2);
        pos.y -= 0.05 * out;
        rot.z -= 0.15 * out;
        break;
      }
      case 'phase': // フェイズ：左手を前にかざす
        arm.position.set(-0.1, -0.3 + 0.18 * out, -0.36 - 0.06 * out);
        arm.rotation.set(1.1 * out, 0.1, -0.2);
        break;
    }
  }

  /** 銃口が画面上のどこにあるか（-1〜1 の正規化座標）。弾道の描き始めに使う */
  muzzleNdc(out: THREE.Vector2): THREE.Vector2 {
    const m = this.models.get(this.current)!;
    const p = new THREE.Vector3();
    this.scene.updateMatrixWorld();
    m.muzzle.getWorldPosition(p);
    p.project(this.camera);
    return out.set(p.x, p.y);
  }
}
