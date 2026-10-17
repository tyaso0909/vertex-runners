/**
 * タワーディフェンスの、人の形でないものの表示（仕様 5.3・6.2）。
 * - タレット（機銃・ロケット・減速・修理）：砲塔が左右・上下に向く。置いたときは組み上がる。壊れると爆発する
 * - コア：体力で光の色が変わる（青 → 黄 → 赤）。輪が回る
 * - 敵のドローン：回転翼が回り、進む向きへ傾く。倒すと煙を吹いて落ちて爆発する
 * - 大型兵器（ボス）：二本足で歩く（足の動きは歩いた距離から作る）。倒すと連鎖して爆発し、崩れ落ちる
 * - ロケット弾と煙の尾、爆発の煙
 * - 減速フィールド・修理の光、次のウェーブの侵入ルートの案内線、タレット・設置物を置く前の影
 * - タレットの強化：レベル 2 で装甲板と金の山形、レベル 3 で四隅の柱と灯りが付く（組み上がる演出）
 * - 自分が置いたタレットは、輪郭を青く縁取る（どれが自分のものか分かるように）
 * - 設置物（バルーン・ワイヤートラップ・バリケード・ジャンプパッド）は deviceViews.ts
 * 突撃兵・重装兵・歩兵・味方のパイロットは ActorViews（attrition/actorViews.ts）が表示する
 */
import * as THREE from 'three';
import { type TdPlaceable, type TdRoute, type TurretType, isTurretType, tdConfig, tdNum } from '../../config';
import type { TdAssets } from '../assets';
import type { TdEvent, TdMatch, TurretState } from '../../shared/td/towerDefense';
import type { Entity } from '../../shared/simulation';
import type { Vec3 } from '../../shared/math';
import { Particles } from './particles';
import { type DeviceSound, DeviceViews, makeDeployedPod } from './deviceViews';
import { type DropSound, DropViews } from './dropViews';
import { type MortarSound, MortarViews } from './mortarViews';
import { FLASH, type Inst, V, addOutline, angDiff, damp, instantiate, outlineMaterial, part, setFlash } from './viewUtil';

export interface TdFxHost {
  /** 爆発の火の玉（グレネードと同じ見た目） */
  explode(pos: Vec3, radius: number): void;
  /** 爆発が近いとき画面を揺らす */
  shake(pos: Vec3, strength: number): void;
  /** 設置物・降下ポッド・ジャンプパッドの音（3D） */
  sound?(kind: DeviceSound | DropSound | MortarSound, pos: Vec3): void;
}


// ---------------------------------------------------------------------------
// タレット
// ---------------------------------------------------------------------------

class TurretView {
  readonly inst: Inst;
  readonly head: THREE.Object3D | null;
  readonly gun: THREE.Object3D | null;
  readonly spin: THREE.Object3D | null;
  readonly muzzle: THREE.Object3D | null;
  private readonly gunRest: THREE.Vector3;
  readonly placeYaw: number;
  build = 0;
  flash = 0;
  recoil = 0;
  ring: THREE.Mesh | null = null;
  private ringT = 1;
  field: THREE.Mesh | null = null;
  private fieldMat: THREE.ShaderMaterial | null = null;
  glow: THREE.MeshStandardMaterial | null = null;
  /** 売った（縮んで消える）・壊れた */
  leaving: 'sold' | 'destroyed' | null = null;
  leaveT = 0;
  readonly tag: HTMLElement;
  private tagShown = false;
  /** 強化のレベルと、付けた強化パーツ */
  level = 1;
  private upParts: THREE.Object3D[] = [];
  private upT = 1;
  /** 自分のタレットの輪郭（自分のものでなければ null） */
  private outline: THREE.MeshBasicMaterial | null = null;

  constructor(
    tpl: THREE.Object3D,
    readonly id: number,
    readonly type: TurretType,
    pos: Vec3,
    yaw: number,
    tagLayer: HTMLElement,
    mine = false,
  ) {
    this.inst = instantiate(tpl);
    const r = this.inst.root;
    r.position.set(pos.x, pos.y, pos.z);
    r.rotation.y = yaw;
    this.placeYaw = yaw;
    r.updateMatrixWorld(true);
    this.head = part(r, 'TurretHead');
    this.gun = part(r, 'TurretGun');
    this.spin = part(r, 'Spin');
    if (this.head && this.gun) this.head.attach(this.gun);
    this.muzzle = part(r, 'Muzzle');
    this.gunRest = this.gun ? this.gun.position.clone() : new THREE.Vector3();
    this.glow = this.inst.byName.get(type === 'slow' ? 'TViolet' : type === 'repair' ? 'TGreen' : 'TGlow') ?? null;
    r.scale.setScalar(0.01);
    // 減速・修理：効く範囲を地面に描く
    if (type === 'slow' || type === 'repair') {
      const R = tdNum(tdConfig.TURRETS[type], 'RADIUS', 9);
      const col = new THREE.Color(type === 'slow' ? '#9a6bff' : '#4dff9a');
      this.fieldMat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: col }, uTime: { value: 0 }, uPulse: { value: 0 }, uKind: { value: type === 'slow' ? 0 : 1 } },
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `uniform vec3 uColor; uniform float uTime; uniform float uPulse; uniform float uKind; varying vec2 vUv;
          void main(){
            // 円筒の壁：下が濃く、上へ消える。縦の筋がゆっくり流れる
            float h = vUv.y;
            float stripes = 0.6 + 0.4 * sin(vUv.x * 160.0 + uTime * (uKind < 0.5 ? -2.0 : 3.0));
            float a = pow(1.0 - h, 2.2) * (0.16 + 0.34 * uPulse) * stripes;
            gl_FragColor = vec4(uColor * 1.6, a);
          }`,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      });
      const wall = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 1.6, 64, 1, true), this.fieldMat);
      wall.position.y = 0.8;
      wall.renderOrder = 4;
      wall.frustumCulled = false;
      this.field = wall;
      const ringGeo = new THREE.RingGeometry(R - 0.12, R, 96);
      ringGeo.rotateX(-Math.PI / 2);
      const ringMat = new THREE.MeshBasicMaterial({ color: col.clone().multiplyScalar(1.8), transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending });
      const edge = new THREE.Mesh(ringGeo, ringMat);
      edge.position.y = 0.06;
      wall.add(edge);
      // 置いた向きで回らないように、外の箱に付ける
      const holder = new THREE.Group();
      holder.add(wall);
      wall.userData.holder = holder;
    }
    // 置いたときの光の輪
    const rg = new THREE.RingGeometry(0.2, 0.45, 48);
    rg.rotateX(-Math.PI / 2);
    this.ring = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ color: new THREE.Color('#4fd1ff').multiplyScalar(2.5), transparent: true, opacity: 0, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending }));
    this.ring.position.y = 0.05;
    this.pulseRing();
    // 自分のタレット：輪郭を青く
    if (mine) {
      this.outline = outlineMaterial(MINE_OUTLINE, 0.9);
      addOutline(r, this.outline);
    }
    this.tag = document.createElement('div');
    this.tag.className = `td-turret-tag ${type}`;
    this.tag.innerHTML = '<s><u></u></s>';
    tagLayer.appendChild(this.tag);
  }

  /** 光の輪を広げる（置いた・修理した） */
  pulseRing() {
    this.ringT = 0;
  }

  /** 強化のレベルに合わせて、強化パーツを付ける（anim なら組み上がる演出） */
  setLevel(level: number, upTpl: THREE.Object3D | null, anim: boolean) {
    if (level === this.level) return;
    this.level = level;
    for (const o of this.upParts) o.removeFromParent();
    this.upParts = [];
    if (upTpl) {
      for (let l = 2; l <= level; l++) {
        const src = part(upTpl, `Up${l}`);
        if (!src) continue;
        const o = src.clone(true);
        o.traverse((x) => {
          const m = x as THREE.Mesh;
          if (m.isMesh) m.castShadow = true;
        });
        this.inst.root.add(o);
        this.upParts.push(o);
        if (this.outline) addOutline(o, this.outline);
      }
    }
    this.tag.dataset.level = String(level);
    if (anim) {
      this.upT = 0;
      this.ringT = 0;
    }
  }

  update(dt: number, t: TurretState | undefined, e: Entity | undefined, time: number, group: THREE.Group) {
    const r = this.inst.root;
    if (this.field && !this.field.userData.holder.parent) {
      const h = this.field.userData.holder as THREE.Group;
      h.position.copy(r.position);
      group.add(h);
    }
    if (this.ring && !this.ring.parent) {
      this.ring.position.set(r.position.x, r.position.y + 0.05, r.position.z);
      group.add(this.ring);
    }
    // 組み上がる（はじめの 0.45 秒。少し大きくなってから戻る）
    if (!this.leaving) {
      this.build = Math.min(1, this.build + dt / 0.45);
      const b = this.build;
      const s = b < 1 ? 1 - Math.pow(1 - b, 3) + Math.sin(b * Math.PI) * 0.12 : 1;
      r.scale.set(s, Math.min(1, b * 1.6) * s, s);
    } else {
      this.leaveT += dt;
      const k = Math.max(0, 1 - this.leaveT / (this.leaving === 'sold' ? 0.3 : 0.15));
      r.scale.setScalar(Math.max(0.001, k));
    }
    // 強化パーツが組み上がる（下からせり上がって、少し大きくなってから戻る）
    if (this.upT < 1) {
      this.upT = Math.min(1, this.upT + dt / 0.6);
      const k = this.upT;
      const last = this.upParts[this.upParts.length - 1];
      if (last) {
        last.position.y = -0.6 * Math.pow(1 - k, 3);
        last.scale.setScalar(1 + Math.sin(k * Math.PI) * 0.08);
      }
      if (!this.leaving) r.scale.setScalar(1 + Math.sin(k * Math.PI) * 0.06);
    }
    if (t) {
      if (this.head) this.head.rotation.y = angDiff(t.yaw, this.placeYaw);
      if (this.gun) this.gun.rotation.x = t.pitch;
    }
    this.recoil = damp(this.recoil, 0, 18, dt);
    if (this.gun) this.gun.position.copy(this.gunRest).add(new THREE.Vector3(0, 0, this.recoil * 0.12));
    const pulse = t?.pulse ?? 0;
    if (this.spin) this.spin.rotation.y += dt * (this.type === 'slow' ? 1.2 + pulse * 3 : 0.8 + pulse * 2);
    if (this.glow) this.glow.emissiveIntensity = (this.type === 'mg' || this.type === 'rocket' ? 4 : 5) * (0.8 + 0.2 * Math.sin(time * 3 + this.id) + pulse * 0.6);
    if (this.fieldMat && t) {
      // 強化で範囲が広がる
      const R0 = tdNum(tdConfig.TURRETS[this.type], 'RADIUS', 9);
      const mul = tdConfig.UPGRADE.RADIUS_MUL[Math.max(0, t.level - 1)] ?? 1;
      const h = this.field!.userData.holder as THREE.Group;
      h.scale.x = damp(h.scale.x, mul, 4, dt);
      h.scale.z = h.scale.x;
      void R0;
    }
    if (this.fieldMat) {
      this.fieldMat.uniforms.uTime.value = time;
      this.fieldMat.uniforms.uPulse.value = damp(this.fieldMat.uniforms.uPulse.value, this.type === 'slow' ? pulse : pulse > 0.5 ? 1 : 0, 4, dt);
      (this.field!.userData.holder as THREE.Group).visible = !this.leaving;
    }
    this.flash = Math.max(0, this.flash - dt * 6);
    setFlash(this.inst.flashMats, this.flash, e && e.health < e.maxHealth * 0.3 ? new THREE.Color('#ff6a3a') : FLASH);
    // 輪郭：ゆっくり明るさが揺れる。壊れる・売るときは消す
    if (this.outline) this.outline.opacity = this.leaving ? 0 : 0.75 + 0.2 * Math.sin(time * 2.2 + this.id);
    if (this.ring) {
      this.ringT = Math.min(1, this.ringT + dt / 0.7);
      const k = this.ringT;
      this.ring.scale.setScalar(1 + k * (this.type === 'repair' && this.upT >= 1 ? 26 : 5));
      (this.ring.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.85;
      (this.ring.material as THREE.MeshBasicMaterial).color.set(this.upT < 1 ? '#ffc14a' : '#4fd1ff').multiplyScalar(2.5);
      this.ring.visible = k < 1;
    }
  }

  setTag(show: boolean, x: number, y: number, hp: number) {
    if (show !== this.tagShown) {
      this.tagShown = show;
      this.tag.style.display = show ? 'block' : 'none';
    }
    if (!show) return;
    this.tag.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    (this.tag.firstElementChild!.firstElementChild as HTMLElement).style.transform = `scaleX(${hp.toFixed(3)})`;
    this.tag.classList.toggle('low', hp < 0.35);
  }

  dispose() {
    this.inst.root.removeFromParent();
    (this.field?.userData.holder as THREE.Group | undefined)?.removeFromParent();
    this.ring?.removeFromParent();
    this.fieldMat?.dispose();
    this.outline?.dispose();
    for (const m of this.inst.byName.values()) m.dispose();
    this.tag.remove();
  }
}

// ---------------------------------------------------------------------------
// コア
// ---------------------------------------------------------------------------

const CORE_OK = new THREE.Color('#54d8ff');
const CORE_MID = new THREE.Color('#ffc14a');
const CORE_LOW = new THREE.Color('#ff3b2a');

class CoreView {
  readonly inst: Inst;
  private readonly rings: THREE.Object3D[];
  private readonly energy: THREE.MeshStandardMaterial | null;
  private readonly glass: THREE.Object3D | null;
  flash = 0;
  private spin = 1;
  destroyedT = -1;
  private readonly color = new THREE.Color();

  constructor(tpl: THREE.Object3D, pos: Vec3) {
    this.inst = instantiate(tpl);
    const r = this.inst.root;
    r.position.set(pos.x, pos.y, pos.z);
    this.rings = [0, 1, 2].map((k) => part(r, `CoreRing${k}`)).filter((x): x is THREE.Object3D => !!x);
    this.energy = this.inst.byName.get('CEnergy') ?? null;
    this.glass = part(r, 'CoreGlass');
    if (this.glass) {
      this.glass.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m) {
          m.transparent = true;
          m.opacity = 0.12;
          m.color.set('#5fb8d8');
          m.depthWrite = false;
          m.roughness = 0.05;
          m.metalness = 0.2;
        }
        (o as THREE.Mesh).castShadow = false;
      });
    }
  }

  update(dt: number, e: Entity, time: number) {
    const k = Math.max(0, e.health / e.maxHealth);
    // 体力で色が変わる。低いと脈打つ
    if (k > 0.6) this.color.copy(CORE_OK);
    else if (k > 0.3) this.color.copy(CORE_MID).lerp(CORE_OK, (k - 0.3) / 0.3);
    else this.color.copy(CORE_LOW).lerp(CORE_MID, k / 0.3);
    const beat = k < 0.3 ? 0.65 + 0.35 * Math.sin(time * 9) : 1;
    this.flash = Math.max(0, this.flash - dt * 4);
    if (this.destroyedT >= 0) {
      this.destroyedT += dt;
      const fade = Math.max(0, 1 - this.destroyedT / 1.5);
      if (this.energy) {
        this.energy.emissive.copy(CORE_LOW);
        this.energy.emissiveIntensity = 8 * fade * (0.5 + 0.5 * Math.sin(time * 30));
      }
      this.spin = damp(this.spin, 0, 1.5, dt);
      if (this.glass) this.glass.visible = this.destroyedT < 0.2;
    } else {
      if (this.energy) {
        this.energy.emissive.copy(this.color);
        this.energy.color.copy(this.color);
        this.energy.emissiveIntensity = (6 + this.flash * 10) * beat;
      }
      this.spin = damp(this.spin, 1 + this.flash * 3, 3, dt);
    }
    this.rings.forEach((r, i) => (r.rotation.y += dt * this.spin * (i === 1 ? -0.9 : 0.6 + i * 0.2)));
    setFlash(this.inst.flashMats, this.flash * 0.5, CORE_LOW);
  }

  dispose() {
    this.inst.root.removeFromParent();
    for (const m of this.inst.byName.values()) m.dispose();
  }
}

// ---------------------------------------------------------------------------
// ドローン
// ---------------------------------------------------------------------------

class DroneView {
  readonly inst: Inst;
  readonly rotors: THREE.Object3D[];
  readonly eye: THREE.MeshStandardMaterial | null;
  readonly muzzle: THREE.Object3D | null;
  readonly prev = new THREE.Vector3();
  readonly cur = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  roll = 0;
  flash = 0;
  /** 倒された：落ちる */
  dying = -1;
  fallVel = new THREE.Vector3();
  groundY = -100;
  exploded = false;
  smokeAcc = 0;

  constructor(tpl: THREE.Object3D, e: Entity) {
    this.inst = instantiate(tpl);
    this.rotors = [0, 1, 2, 3].map((k) => part(this.inst.root, `Rotor${k}`)).filter((x): x is THREE.Object3D => !!x);
    this.eye = this.inst.byName.get('ERed') ?? null;
    this.muzzle = part(this.inst.root, 'Muzzle');
    this.prev.set(e.movement.pos.x, e.movement.pos.y, e.movement.pos.z);
    this.cur.copy(this.prev);
    this.yaw = e.facing ?? 0;
    this.inst.root.position.copy(this.cur);
  }

  dispose() {
    this.inst.root.removeFromParent();
    for (const m of this.inst.byName.values()) m.dispose();
  }
}

// ---------------------------------------------------------------------------
// 大型兵器
// ---------------------------------------------------------------------------

class BossView {
  readonly inst: Inst;
  readonly prev = new THREE.Vector3();
  readonly cur = new THREE.Vector3();
  yawPrev = 0;
  yawCur = 0;
  readonly hip: THREE.Object3D | null;
  readonly torso: THREE.Object3D | null;
  readonly thigh: Array<THREE.Object3D | null>;
  readonly shin: Array<THREE.Object3D | null>;
  readonly foot: Array<THREE.Object3D | null>;
  readonly gun: THREE.Object3D | null;
  readonly pods: Array<THREE.Object3D | null>;
  readonly muzzle: THREE.Object3D | null;
  private readonly hipRest: THREE.Vector3;
  private readonly podRest: THREE.Vector3[];
  readonly reactor: THREE.MeshStandardMaterial | null;
  readonly eye: THREE.MeshStandardMaterial | null;
  stride = 0;
  strideShown = 0;
  flash = 0;
  podKick = [0, 0];
  gunKick = 0;
  dying = -1;

  constructor(tpl: THREE.Object3D, e: Entity) {
    this.inst = instantiate(tpl);
    const r = this.inst.root;
    r.updateMatrixWorld(true);
    this.hip = part(r, 'BossHip');
    this.torso = part(r, 'BossTorso');
    this.thigh = ['L', 'R'].map((s) => part(r, `BossThigh.${s}`));
    this.shin = ['L', 'R'].map((s) => part(r, `BossShin.${s}`));
    this.foot = ['L', 'R'].map((s) => part(r, `BossFoot.${s}`));
    this.gun = part(r, 'BossGun');
    this.pods = [part(r, 'BossPodL'), part(r, 'BossPodR')];
    // 部品の親子関係を作る（Blender からは全部が平らに並んで出てくる）
    const eye = part(r, 'BossEye');
    const reactor = part(r, 'BossReactor');
    if (this.hip) {
      if (this.torso) this.hip.attach(this.torso);
      for (const t of this.thigh) if (t) this.hip.attach(t);
    }
    for (let i = 0; i < 2; i++) {
      if (this.thigh[i] && this.shin[i]) this.thigh[i]!.attach(this.shin[i]!);
      if (this.shin[i] && this.foot[i]) this.shin[i]!.attach(this.foot[i]!);
    }
    if (this.torso) for (const o of [this.gun, eye, reactor, ...this.pods]) if (o) this.torso.attach(o);
    this.muzzle = part(r, 'MuzzleGun');
    this.hipRest = this.hip ? this.hip.position.clone() : new THREE.Vector3();
    this.podRest = this.pods.map((p) => (p ? p.position.clone() : new THREE.Vector3()));
    this.reactor = this.inst.byName.get('BCore') ?? null;
    this.eye = this.inst.byName.get('BRed') ?? null;
    this.prev.set(e.movement.pos.x, e.movement.pos.y, e.movement.pos.z);
    this.cur.copy(this.prev);
    this.yawPrev = this.yawCur = e.facing ?? 0;
  }

  /** 歩く動き（歩いた距離から、足の振り・ひざの曲げ・腰の上下を作る） */
  pose(dt: number, aimYaw: number, aimPitch: number, time: number) {
    this.strideShown += (this.stride - this.strideShown) * Math.min(1, dt * 12);
    const ph = (this.strideShown / 5.2) * Math.PI * 2;
    for (let i = 0; i < 2; i++) {
      const p = ph + (i === 0 ? 0 : Math.PI);
      const swing = Math.sin(p) * 0.32;
      // 足を前へ運ぶ間（cos が正）はひざを曲げて持ち上げる
      const lift = Math.max(0, Math.cos(p)) * 0.55;
      if (this.thigh[i]) this.thigh[i]!.rotation.x = swing + lift * 0.35;
      if (this.shin[i]) this.shin[i]!.rotation.x = -lift;
      if (this.foot[i]) this.foot[i]!.rotation.x = -(swing + lift * 0.35) + lift * 0.9 - 0.02;
    }
    if (this.hip) {
      this.hip.position.copy(this.hipRest);
      this.hip.position.y += -Math.abs(Math.sin(ph)) * 0.18 + 0.06;
      this.hip.rotation.z = Math.sin(ph) * 0.03;
    }
    if (this.torso) {
      const tw = THREE.MathUtils.clamp(angDiff(aimYaw, this.yawCur), -0.6, 0.6);
      this.torso.rotation.y = damp(this.torso.rotation.y, tw * 0.45, 3, dt);
      this.torso.rotation.x = Math.sin(ph * 2) * 0.012;
    }
    if (this.gun) {
      const tw = THREE.MathUtils.clamp(angDiff(aimYaw, this.yawCur), -1.2, 1.2);
      this.gun.rotation.y = damp(this.gun.rotation.y, tw * 0.55, 8, dt);
      this.gun.rotation.x = damp(this.gun.rotation.x, THREE.MathUtils.clamp(aimPitch, -0.6, 0.4), 8, dt);
      this.gunKick = damp(this.gunKick, 0, 20, dt);
    }
    for (let i = 0; i < 2; i++) {
      this.podKick[i] = damp(this.podKick[i], 0, 6, dt);
      const p = this.pods[i];
      if (p) {
        p.position.copy(this.podRest[i]).add(new THREE.Vector3(0, 0, this.podKick[i] * 0.35));
        p.rotation.x = this.podKick[i] * 0.12;
      }
    }
    // 弱点の光（脈打つ）
    if (this.reactor) this.reactor.emissiveIntensity = 7 + Math.sin(time * 4) * 2.5;
    if (this.eye) this.eye.emissiveIntensity = 6 + Math.sin(time * 7) * 1.5;
  }

  dispose() {
    this.inst.root.removeFromParent();
    for (const m of this.inst.byName.values()) m.dispose();
  }
}

// ---------------------------------------------------------------------------
// ロケット弾
// ---------------------------------------------------------------------------

interface RocketView {
  mesh: THREE.Group;
  prev: THREE.Vector3;
  cur: THREE.Vector3;
  vel: THREE.Vector3;
  boss: boolean;
  trailAcc: number;
  last: THREE.Vector3;
  seen: boolean;
}

// ---------------------------------------------------------------------------
// まとめ
// ---------------------------------------------------------------------------

const SMOKE_GREY = new THREE.Color('#8c8c88');
/** 自分のタレットの輪郭の色 */
const MINE_OUTLINE = new THREE.Color('#2f9dff').multiplyScalar(2.2);
const SMOKE_DARK = new THREE.Color('#3a3836');
const FIRE = new THREE.Color('#ffb04a').multiplyScalar(1.6);
const ROUTE_COLOR = new THREE.Color('#ff5a3a');

export class TdViews {
  readonly group = new THREE.Group();
  readonly smoke = new Particles(1100, 'smoke');
  readonly glow = new Particles(600, 'glow');
  private readonly turrets = new Map<number, TurretView>();
  private readonly drones = new Map<number, DroneView>();
  private readonly bosses = new Map<number, BossView>();
  private readonly rockets = new Map<number, RocketView>();
  readonly core: CoreView;
  private readonly tagLayer: HTMLElement;
  private readonly coreTag: HTMLElement;
  private readonly rocketTpl: THREE.Group;
  private readonly guides = new Map<TdRoute, { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; want: number; cur: number }>();
  private ghost: { type: TdPlaceable; root: THREE.Object3D; ring: THREE.Mesh | null; pods: THREE.Object3D[]; beams: THREE.Mesh[] } | null = null;
  readonly devices: DeviceViews;
  /** 降下ポッド・降下予定地点 */
  readonly drops: DropViews;
  /** 迫撃砲兵の迫撃砲（背負った形・据えた形）・砲弾・落ちる所の輪 */
  readonly mortars: MortarViews;
  /** 強化メニューで選んでいるタレットの目印 */
  private highlight: THREE.Mesh;
  private highlightId = -1;
  private readonly ghostOk = new THREE.MeshBasicMaterial({ color: new THREE.Color('#4fd1ff').multiplyScalar(1.4), transparent: true, opacity: 0.38, depthWrite: false, toneMapped: false });
  private readonly ghostBad = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff3b3b').multiplyScalar(1.4), transparent: true, opacity: 0.38, depthWrite: false, toneMapped: false });
  private time = 0;
  private readonly tmp = new THREE.Vector3();

  constructor(
    private readonly assets: TdAssets,
    private readonly match: TdMatch,
    private readonly fx: TdFxHost,
  ) {
    this.group.name = 'TdViews';
    this.group.add(this.smoke.points, this.glow.points);
    this.core = new CoreView(assets.core, match.core.movement.pos);
    this.group.add(this.core.inst.root);
    this.tagLayer = document.createElement('div');
    this.tagLayer.className = 'actor-tags td-tags';
    document.getElementById('hud')!.appendChild(this.tagLayer);
    this.coreTag = document.createElement('div');
    this.coreTag.className = 'td-core-tag';
    this.coreTag.innerHTML = '<i></i><b>コア</b><em></em>';
    this.tagLayer.appendChild(this.coreTag);
    this.rocketTpl = this.makeRocket();
    for (const r of match.td.routes) this.makeGuide(r.id, r.path, r.spawn.center);
    this.devices = new DeviceViews(
      assets,
      match,
      {
        explode: (p, r) => fx.explode(p, r),
        shake: (p, s) => fx.shake(p, s),
        blast: (p, r, k) => this.blast(p, r, k),
        smoke: this.smoke,
        glow: this.glow,
        sound: (k, p) => fx.sound?.(k, p),
      },
      this.group,
      this.tagLayer,
    );
    this.drops = new DropViews(
      assets.pod,
      match,
      {
        explode: (p, r) => fx.explode(p, r),
        shake: (p, s) => fx.shake(p, s),
        blast: (p, r, k) => this.blast(p, r, k),
        smoke: this.smoke,
        glow: this.glow,
        sound: (k, p) => fx.sound?.(k, p),
      },
    );
    this.group.add(this.drops.group);
    this.mortars = new MortarViews(
      assets.mortarProp,
      match,
      {
        explode: (p, r) => fx.explode(p, r),
        shake: (p, s) => fx.shake(p, s),
        blast: (p, r, k) => this.blast(p, r, k),
        smoke: this.smoke,
        glow: this.glow,
        sound: (k, p) => fx.sound?.(k, p),
      },
      this.tagLayer,
    );
    this.group.add(this.mortars.group);
    const hg = new THREE.RingGeometry(1.25, 1.45, 48);
    hg.rotateX(-Math.PI / 2);
    this.highlight = new THREE.Mesh(hg, new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffc14a').multiplyScalar(2), transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending }));
    this.highlight.renderOrder = 7;
    this.highlight.visible = false;
    this.group.add(this.highlight);
  }

  /** 強化メニューで選んでいる（マウスを乗せた）タレットに、金の輪を出す（-1 で消す） */
  setHighlight(turretId: number): void {
    this.highlightId = turretId;
  }

  /** シェーダーの準備用：タレットの種類ごとに見た目を1つ作って渡す（減速・修理の範囲の表示も） */
  warmObjects(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const type of ['mg', 'rocket', 'slow', 'repair'] as TurretType[]) {
      const v = new TurretView(this.assets[type], -1, type, { x: 0, y: -500, z: 0 }, 0, this.tagLayer, true);
      v.tag.remove();
      v.inst.root.scale.setScalar(1);
      out.push(v.inst.root);
      if (v.field) out.push((v.field.userData.holder as THREE.Object3D | undefined) ?? v.field);
      if (v.ring) out.push(v.ring);
      v.setLevel(3, this.assets.upgrade, false);
    }
    out.push(...this.devices.warmObjects());
    out.push(...this.drops.warmObjects());
    out.push(...this.mortars.warmObjects());
    return out;
  }


  private makeRocket(): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.55, 8), new THREE.MeshStandardMaterial({ color: '#3a3d42', metalness: 0.6, roughness: 0.4 }));
    body.rotation.x = Math.PI / 2;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.18, 8), new THREE.MeshStandardMaterial({ color: '#c8302a', roughness: 0.5 }));
    nose.rotation.x = -Math.PI / 2;
    nose.position.z = -0.36;
    const flame = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffb04a').multiplyScalar(4), toneMapped: false }));
    flame.scale.set(1, 1, 2.2);
    flame.position.z = 0.4;
    g.add(body, nose, flame);
    return g;
  }

  /** 侵入ルートの案内線（地面の上の、流れる矢印の帯） */
  private makeGuide(id: TdRoute, path: Vec3[], spawn: Vec3) {
    const pts = [V(spawn), ...path.map(V)];
    // 帯の形：点の間を細かく分けて、左右に幅を付ける
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    let dist = 0;
    const W = 0.75;
    const world = this.match.sim.world;
    const ground = (p: THREE.Vector3) => {
      const h = world.raycast({ x: p.x, y: p.y + 2.5, z: p.z }, { x: 0, y: -1, z: 0 }, 6);
      return h ? h.point.y : p.y;
    };
    const samples: THREE.Vector3[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i],
        b = pts[i + 1];
      const L = a.distanceTo(b);
      const n = Math.max(1, Math.ceil(L / 1.5));
      for (let k = 0; k < n; k++) samples.push(a.clone().lerp(b, k / n));
    }
    samples.push(pts[pts.length - 1].clone());
    for (const s of samples) s.y = ground(s) + 0.07;
    for (let i = 0; i < samples.length; i++) {
      const p = samples[i];
      const q = samples[Math.min(samples.length - 1, i + 1)];
      const o = samples[Math.max(0, i - 1)];
      const dir = q.clone().sub(o).setY(0).normalize();
      const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(W);
      if (i > 0) dist += p.distanceTo(samples[i - 1]);
      pos.push(p.x - side.x, p.y, p.z - side.z, p.x + side.x, p.y, p.z + side.z);
      uv.push(0, dist, 1, dist);
      if (i > 0) {
        const b = (i - 1) * 2;
        idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: ROUTE_COLOR }, uTime: { value: 0 }, uAlpha: { value: 0 }, uLen: { value: dist } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 uColor; uniform float uTime; uniform float uAlpha; uniform float uLen; varying vec2 vUv;
        void main(){
          // 進む向きへ流れる「く」の字の矢印
          float x = abs(vUv.x - 0.5) * 2.0;
          float s = fract((vUv.y - x * 0.9) / 3.2 - uTime * 0.55);
          float chev = smoothstep(0.0, 0.08, s) * (1.0 - smoothstep(0.32, 0.42, s));
          float edge = smoothstep(1.0, 0.82, x);
          float a = (0.1 + chev * 0.55) * edge * uAlpha;
          // コアに近い端は細く消す
          a *= smoothstep(uLen, uLen - 6.0, vUv.y);
          gl_FragColor = vec4(uColor * (0.9 + chev * 1.1), a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 3;
    mesh.frustumCulled = false;
    mesh.visible = false;
    this.group.add(mesh);
    this.guides.set(id, { mesh, mat, want: 0, cur: 0 });
  }

  /** 案内線を出すルート（strength 0〜1） */
  setGuides(routes: TdRoute[], strength: number): void {
    for (const [id, g] of this.guides) g.want = routes.includes(id) ? strength : 0;
  }

  /** 置く前の影（null で消す）。nodes はワイヤートラップの3つの機雷の位置 */
  setGhost(type: TdPlaceable | null, pos: Vec3 | null, ok: boolean, yaw: number, nodes?: Vec3[]): void {
    if (!type || !pos) {
      if (this.ghost) {
        this.ghost.root.visible = false;
        if (this.ghost.ring) this.ghost.ring.visible = false;
      }
      return;
    }
    const mat = ok ? this.ghostOk : this.ghostBad;
    if (!this.ghost || this.ghost.type !== type) {
      if (this.ghost) {
        this.ghost.root.removeFromParent();
        this.ghost.ring?.removeFromParent();
      }
      const root = new THREE.Group();
      const pods: THREE.Object3D[] = [];
      const beams: THREE.Mesh[] = [];
      if (type === 'wiretrap') {
        for (let i = 0; i < 3; i++) {
          const p = makeDeployedPod(this.assets.wiretrap);
          pods.push(p);
          root.add(p);
        }
        for (let i = 0; i < 2; i++) {
          const m = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 1, 6, 1, true), mat);
          m.renderOrder = 7;
          beams.push(m);
          root.add(m);
        }
      } else {
        root.add(instantiate(this.assets[type]).root);
      }
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = m.receiveShadow = false;
          m.renderOrder = 7;
        }
      });
      // 範囲の輪：タレットは射程・範囲、バルーンは突撃兵を引きつける距離
      let R = 0;
      if (isTurretType(type)) {
        const def = tdConfig.TURRETS[type];
        R = type === 'mg' || type === 'rocket' ? tdNum(def, 'RANGE', 30) : tdNum(def, 'RADIUS', 9);
      } else if (type === 'decoy') R = tdNum(tdConfig.ITEMS.decoy, 'ASSAULT_LURE', 14);
      let ring: THREE.Mesh | null = null;
      if (R > 0) {
        const rg = new THREE.RingGeometry(R - 0.15, R, 128);
        rg.rotateX(-Math.PI / 2);
        ring = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ color: new THREE.Color('#4fd1ff').multiplyScalar(1.6), transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false }));
        ring.renderOrder = 7;
        this.group.add(ring);
      }
      this.ghost = { type, root, ring, pods, beams };
      this.group.add(root);
    }
    const g = this.ghost;
    g.root.visible = true;
    if (type === 'wiretrap' && nodes && nodes.length === 3) {
      g.root.position.set(0, 0, 0);
      g.root.rotation.y = 0;
      for (let i = 0; i < 3; i++) {
        g.pods[i].position.set(nodes[i].x, nodes[i].y, nodes[i].z);
        g.pods[i].rotation.y = yaw;
      }
      const bh = tdNum(tdConfig.ITEMS.wiretrap, 'BEAM_HEIGHT', 0.62);
      for (let i = 0; i < 2; i++) {
        const a = V(nodes[i]).add(new THREE.Vector3(0, bh, 0));
        const b = V(nodes[i + 1]).add(new THREE.Vector3(0, bh, 0));
        const d = b.clone().sub(a);
        g.beams[i].position.copy(a).add(b).multiplyScalar(0.5);
        g.beams[i].quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
        g.beams[i].scale.set(1, d.length(), 1);
      }
    } else {
      g.root.position.set(pos.x, pos.y, pos.z);
      g.root.rotation.y = yaw;
    }
    g.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.material = mat;
    });
    if (g.ring) {
      g.ring.visible = true;
      g.ring.position.set(pos.x, pos.y + 0.1, pos.z);
      (g.ring.material as THREE.MeshBasicMaterial).color.set(ok ? '#4fd1ff' : '#ff3b3b').multiplyScalar(1.6);
    }
  }

  /** 1ティックごと：増えた・減ったものの表示を合わせ、位置を記録する */
  afterTick(): void {
    const m = this.match;
    const sim = m.sim;
    // タレット
    for (const t of m.turrets.values()) {
      if (this.turrets.has(t.id)) continue;
      const v = new TurretView(this.assets[t.type], t.id, t.type, t.pos, t.yaw, this.tagLayer, t.ownerId === (m.player?.id ?? -1));
      this.turrets.set(t.id, v);
      this.group.add(v.inst.root);
    }
    for (const [id, v] of this.turrets) if (!m.turrets.has(id) && !v.leaving) v.leaving = 'sold'; // 壊れたときは onEvents で 'destroyed' にする
    for (const t of m.turrets.values()) {
      const v = this.turrets.get(t.id);
      if (v && v.level !== t.level) v.setLevel(t.level, this.assets.upgrade, v.build >= 1);
    }
    this.devices.afterTick();
    this.drops.afterTick();
    // 敵（ドローン・大型兵器）
    for (const r of m.enemies.values()) {
      const e = sim.entities.get(r.id);
      if (!e) continue;
      if (r.type === 'drone' && !this.drones.has(r.id)) {
        const v = new DroneView(this.assets.drone, e);
        this.drones.set(r.id, v);
        this.group.add(v.inst.root);
      }
      if (r.type === 'boss' && !this.bosses.has(r.id)) {
        const v = new BossView(this.assets.boss, e);
        this.bosses.set(r.id, v);
        this.group.add(v.inst.root);
      }
    }
    for (const [id, v] of this.drones) {
      const e = sim.entities.get(id);
      if (v.dying >= 0) continue;
      if (!e || e.dead) {
        this.startDroneDeath(v);
        continue;
      }
      v.prev.copy(v.cur);
      v.cur.set(e.movement.pos.x, e.movement.pos.y, e.movement.pos.z);
    }
    for (const [id, v] of this.bosses) {
      const e = sim.entities.get(id);
      if (v.dying >= 0) continue;
      if (!e || e.dead) {
        v.dying = 0;
        continue;
      }
      v.prev.copy(v.cur);
      v.cur.set(e.movement.pos.x, e.movement.pos.y, e.movement.pos.z);
      v.yawPrev = v.yawCur;
      v.yawCur = e.facing ?? v.yawCur;
      const ctl = m.enemies.get(id)?.boss;
      if (ctl) v.stride = ctl.stride;
    }
    // ロケット
    for (const rv of this.rockets.values()) rv.seen = false;
    for (const r of m.rockets.list) {
      let rv = this.rockets.get(r.id);
      if (!rv) {
        const mesh = this.rocketTpl.clone(true);
        if (r.ownerId >= 0 && m.enemies.has(r.ownerId)) mesh.scale.setScalar(1.6);
        rv = { mesh, prev: V(r.pos), cur: V(r.pos), vel: V(r.vel), boss: m.enemies.has(r.ownerId), trailAcc: 0, last: V(r.pos), seen: true };
        this.rockets.set(r.id, rv);
        this.group.add(mesh);
      }
      rv.seen = true;
      rv.prev.copy(rv.cur);
      rv.cur.set(r.pos.x, r.pos.y, r.pos.z);
      rv.vel.set(r.vel.x, r.vel.y, r.vel.z);
    }
    for (const [id, rv] of this.rockets) {
      if (rv.seen) continue;
      rv.mesh.removeFromParent();
      this.rockets.delete(id);
    }
  }

  /** モードの出来事に合わせた見た目 */
  onEvents(events: TdEvent[]): void {
    this.devices.onEvents(events);
    this.drops.onEvents(events);
    this.mortars.onEvents(events);
    for (const ev of events) {
      switch (ev.type) {
        case 'turretDestroyed': {
          const v = this.turrets.get(ev.turretId);
          if (v) {
            v.leaving = 'destroyed';
            const p = v.inst.root.position;
            this.blast({ x: p.x, y: p.y + 1, z: p.z }, 3, 1);
            this.fx.explode({ x: p.x, y: p.y + 0.9, z: p.z }, 3);
          }
          break;
        }
        case 'turretFire': {
          const v = this.turrets.get(ev.turretId);
          if (v) v.recoil = 1;
          break;
        }
        case 'repairPulse':
          this.turrets.get(ev.turretId)?.pulseRing();
          break;
        case 'rocketExplode':
          this.blast(ev.pos, ev.radius, ev.radius > 4.2 ? 1 : 0.8);
          this.fx.explode(ev.pos, ev.radius);
          this.fx.shake(ev.pos, ev.radius / 4);
          break;
        case 'assaultExplode':
          this.blast(ev.pos, 5.5, 1.3);
          this.fx.explode(ev.pos, 5.5);
          this.fx.shake(ev.pos, 1.4);
          break;
        case 'rocketLaunch': {
          // 大型兵器の発射筒をはね上げる
          if (ev.boss)
            for (const b of this.bosses.values()) {
              if (b.cur.distanceTo(V(ev.from)) > 9) continue;
              const local = b.inst.root.worldToLocal(V(ev.from));
              b.podKick[local.x < 0 ? 0 : 1] = 1;
            }
          for (let i = 0; i < 6; i++)
            this.smoke.spawn({ pos: V(ev.from), vel: new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 1.5, (Math.random() - 0.5) * 2).sub(V(ev.vel).multiplyScalar(0.05)), life: 0.9 + Math.random() * 0.6, size0: 0.5, size1: 1.8, color: SMOKE_GREY, alpha: 0.5, drag: 2, gravity: -0.3 });
          break;
        }
        case 'coreDamaged':
          this.core.flash = Math.min(1, this.core.flash + 0.25 + ev.amount / 200);
          break;
        case 'phase':
          if (ev.phase === 'defeat' && this.core.destroyedT < 0) {
            this.core.destroyedT = 0;
            const c = this.match.core.movement.pos;
            for (let i = 0; i < 4; i++) {
              const p = { x: c.x + (Math.random() - 0.5) * 3, y: c.y + 1 + i * 1.4, z: c.z + (Math.random() - 0.5) * 3 };
              this.blast(p, 5, 1.6);
              this.fx.explode(p, 5);
            }
            this.fx.shake(c, 2.5);
          }
          break;
      }
    }
  }

  /** 撃たれたときに光らせる */
  onHit(id: number, amount: number): void {
    if (this.devices.onHit(id, amount)) return;
    const t = this.turrets.get(id);
    if (t) t.flash = Math.min(1, t.flash + 0.4 + amount / 60);
    const d = this.drones.get(id);
    if (d) d.flash = Math.min(1, d.flash + 0.6);
    const b = this.bosses.get(id);
    if (b) b.flash = Math.min(1, b.flash + 0.15 + amount / 300);
  }

  /** 爆発の煙と火の粉 */
  blast(p: Vec3, radius: number, strength: number): void {
    const c = V(p);
    // 煙は数を抑え、そのぶん少し大きくする（重ねて描く量を減らす）
    const n = Math.round(5 + radius * 1.6 * strength);
    for (let i = 0; i < n; i++) {
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 + 0.1, Math.random() - 0.5).normalize();
      this.smoke.spawn({
        pos: c.clone().addScaledVector(dir, Math.random() * radius * 0.3),
        vel: dir.clone().multiplyScalar(2 + Math.random() * radius * 1.2),
        life: 1.6 + Math.random() * 1.8 * strength,
        size0: radius * 0.4,
        size1: radius * (1.1 + Math.random() * 0.6),
        color: Math.random() < 0.5 ? SMOKE_DARK : SMOKE_GREY,
        alpha: 0.75,
        drag: 2.6,
        gravity: -0.6,
      });
    }
    for (let i = 0; i < n * 1.4; i++) {
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 + 0.2, Math.random() - 0.5).normalize();
      this.glow.spawn({ pos: c.clone(), vel: dir.multiplyScalar(6 + Math.random() * 10 * strength), life: 0.4 + Math.random() * 0.6, size0: 0.22, size1: 0.05, color: FIRE, alpha: 1, drag: 1.5, gravity: 9 });
    }
  }

  private startDroneDeath(v: DroneView) {
    v.dying = 0;
    v.fallVel.copy(v.cur).sub(v.prev).multiplyScalar(60);
    v.fallVel.y = Math.max(v.fallVel.y, 0) + 1.5;
    const hit = this.match.sim.world.raycast({ x: v.cur.x, y: v.cur.y, z: v.cur.z }, { x: 0, y: -1, z: 0 }, 80);
    v.groundY = hit ? hit.point.y + 0.4 : v.cur.y - 30;
    this.glow.spawn({ pos: v.cur.clone(), life: 0.25, size0: 2.5, size1: 0.5, color: FIRE, alpha: 1 });
  }

  /** 銃口の位置（表示上）。タレット・ドローン・大型兵器 */
  muzzleOf(id: number, out: THREE.Vector3): THREE.Vector3 | null {
    const t = this.turrets.get(id);
    if (t?.muzzle) return t.muzzle.getWorldPosition(out);
    const d = this.drones.get(id);
    if (d?.muzzle) return d.muzzle.getWorldPosition(out);
    const b = this.bosses.get(id);
    if (b?.muzzle) {
      b.gunKick = 1;
      return b.muzzle.getWorldPosition(out);
    }
    return null;
  }

  has(id: number): boolean {
    return this.turrets.has(id) || this.drones.has(id) || this.bosses.has(id);
  }

  /** 生きている大型兵器（体力の表示用） */
  bossEntities(): Entity[] {
    const out: Entity[] = [];
    for (const id of this.bosses.keys()) {
      const e = this.match.sim.entities.get(id);
      if (e && !e.dead) out.push(e);
    }
    return out;
  }

  update(dt: number, alpha: number, camera: THREE.PerspectiveCamera, width: number, height: number): void {
    this.time += dt;
    const time = this.time;
    const m = this.match;
    const sim = m.sim;
    this.smoke.setView(camera, height);
    this.glow.setView(camera, height);
    const camPos = camera.getWorldPosition(new THREE.Vector3());

    // タレット
    for (const [id, v] of this.turrets) {
      const t = m.turrets.get(id);
      const e = sim.entities.get(id);
      v.update(dt, t, e, time, this.group);
      if (v.leaving && v.leaveT > 0.5) {
        v.dispose();
        this.turrets.delete(id);
        continue;
      }
      // 体力（減っているとき・近いときだけ）
      let show = !!e && !e.dead && !v.leaving && e.health < e.maxHealth - 0.5;
      if (show) {
        const p = this.tmp.set(v.inst.root.position.x, v.inst.root.position.y + 2.3, v.inst.root.position.z);
        show = p.distanceTo(camPos) < 70;
        if (show) {
          p.project(camera);
          show = p.z < 1 && Math.abs(p.x) < 1.05 && Math.abs(p.y) < 1.05;
          if (show) v.setTag(true, ((p.x + 1) / 2) * width, ((1 - p.y) / 2) * height, e!.health / e!.maxHealth);
        }
      }
      if (!show) v.setTag(false, 0, 0, 0);
      // こわれかけ：煙を出す
      if (e && !e.dead && e.health < e.maxHealth * 0.4 && Math.random() < dt * 6) {
        const p = v.inst.root.position;
        this.smoke.spawn({ pos: new THREE.Vector3(p.x + (Math.random() - 0.5) * 0.6, p.y + 1.5, p.z + (Math.random() - 0.5) * 0.6), vel: new THREE.Vector3(0, 1.2, 0), life: 1.8, size0: 0.4, size1: 1.6, color: SMOKE_DARK, alpha: 0.6, drag: 0.6, gravity: -0.4 });
      }
    }

    // 設置物
    this.devices.update(dt, camera, camPos, width, height, time);
    this.drops.update(dt, camera);
    this.mortars.update(dt, alpha, camera, width, height);
    // 強化メニューで選んでいるタレット
    const ht = this.highlightId >= 0 ? this.turrets.get(this.highlightId) : undefined;
    this.highlight.visible = !!ht && !ht.leaving;
    if (ht) {
      const p = ht.inst.root.position;
      this.highlight.position.set(p.x, p.y + 0.06, p.z);
      this.highlight.rotation.y = time * 0.8;
      this.highlight.scale.setScalar(1 + Math.sin(time * 6) * 0.05);
    }
    // コア
    this.core.update(dt, m.core, time);
    this.updateCoreTag(camera, camPos, width, height);

    // ドローン
    for (const [id, v] of this.drones) {
      const r = v.inst.root;
      if (v.dying >= 0) {
        v.dying += dt;
        v.fallVel.y -= 14 * dt;
        r.position.addScaledVector(v.fallVel, dt);
        r.rotation.y += dt * 9;
        r.rotation.z += dt * 2.5;
        v.smokeAcc += dt;
        while (v.smokeAcc > 0.03) {
          v.smokeAcc -= 0.03;
          this.smoke.spawn({ pos: r.position.clone(), vel: new THREE.Vector3(0, 0.6, 0), life: 1.4, size0: 0.4, size1: 1.4, color: SMOKE_DARK, alpha: 0.7, drag: 1, gravity: -0.3 });
        }
        if (!v.exploded && (r.position.y <= v.groundY || v.dying > 2.4)) {
          v.exploded = true;
          const p = { x: r.position.x, y: r.position.y, z: r.position.z };
          this.blast(p, 2.6, 0.9);
          this.fx.explode(p, 2.6);
          this.fx.shake(p, 0.5);
          r.visible = false;
        }
        if (v.exploded && v.dying > 2.8) {
          v.dispose();
          this.drones.delete(id);
        }
        continue;
      }
      const e = sim.entities.get(id);
      r.position.lerpVectors(v.prev, v.cur, alpha);
      // 向き：狙う向き。進む向きへ前に傾き、曲がる向きへ横に傾く
      const vel = v.cur.clone().sub(v.prev).multiplyScalar(60);
      const want = e?.facing ?? v.yaw;
      v.yaw += angDiff(want, v.yaw) * Math.min(1, dt * 8);
      const fwd = new THREE.Vector3(-Math.sin(v.yaw), 0, -Math.cos(v.yaw));
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      v.pitch = damp(v.pitch, -THREE.MathUtils.clamp(vel.dot(fwd) * 0.035, -0.35, 0.35), 5, dt);
      v.roll = damp(v.roll, -THREE.MathUtils.clamp(vel.dot(right) * 0.035, -0.35, 0.35), 5, dt);
      r.rotation.set(v.pitch, v.yaw, v.roll, 'YXZ');
      for (let i = 0; i < v.rotors.length; i++) v.rotors[i].rotation.y += dt * (i % 2 ? -38 : 38);
      v.flash = Math.max(0, v.flash - dt * 7);
      setFlash(v.inst.flashMats, v.flash);
      if (v.eye) v.eye.emissiveIntensity = 5 + Math.sin(time * 10 + id) * 2 + (e && e.arsenal.sinceShot < 0.1 ? 6 : 0);
    }

    // 大型兵器
    for (const [id, v] of this.bosses) {
      const r = v.inst.root;
      const e = sim.entities.get(id);
      if (v.dying >= 0) {
        this.updateBossDeath(v, dt, id);
        continue;
      }
      r.position.lerpVectors(v.prev, v.cur, alpha);
      r.rotation.y = v.yawPrev + angDiff(v.yawCur, v.yawPrev) * alpha;
      v.pose(dt, e?.lastCmd.yaw ?? v.yawCur, e?.lastCmd.pitch ?? 0, time);
      v.flash = Math.max(0, v.flash - dt * 6);
      setFlash(v.inst.flashMats, v.flash);
      // こわれかけ：煙
      if (e && e.health < e.maxHealth * 0.5 && Math.random() < dt * 10) {
        const p = r.localToWorld(new THREE.Vector3((Math.random() - 0.5) * 3, 5 + Math.random() * 1.5, (Math.random() - 0.5) * 2));
        this.smoke.spawn({ pos: p, vel: new THREE.Vector3(0, 2, 0), life: 2.2, size0: 0.8, size1: 2.8, color: SMOKE_DARK, alpha: 0.6, drag: 0.8, gravity: -0.5 });
      }
    }

    // ロケット：位置と、煙の尾
    for (const rv of this.rockets.values()) {
      const p = this.tmp.lerpVectors(rv.prev, rv.cur, alpha);
      rv.mesh.position.copy(p);
      if (rv.vel.lengthSq() > 0.01) rv.mesh.lookAt(p.clone().sub(rv.vel));
      const step = rv.boss ? 0.6 : 0.8;
      const d = rv.last.distanceTo(p);
      if (d > step) {
        const n = Math.min(12, Math.floor(d / step));
        for (let i = 1; i <= n; i++) {
          const q = rv.last.clone().lerp(p, i / n);
          this.smoke.spawn({ pos: q, vel: new THREE.Vector3((Math.random() - 0.5) * 0.5, 0.3, (Math.random() - 0.5) * 0.5), life: rv.boss ? 1.8 : 1.2, size0: rv.boss ? 0.45 : 0.3, size1: rv.boss ? 2.2 : 1.4, color: SMOKE_GREY, alpha: 0.42, drag: 1.2, gravity: -0.2 });
        }
        this.glow.spawn({ pos: p.clone(), life: 0.12, size0: rv.boss ? 0.9 : 0.6, size1: 0.2, color: FIRE, alpha: 0.9 });
        rv.last.copy(p);
      }
    }

    // 案内線
    for (const g of this.guides.values()) {
      g.cur = damp(g.cur, g.want, 4, dt);
      g.mesh.visible = g.cur > 0.01;
      g.mat.uniforms.uAlpha.value = g.cur;
      g.mat.uniforms.uTime.value = time;
    }
    this.smoke.update(dt);
    this.glow.update(dt);
  }

  private updateBossDeath(v: BossView, dt: number, id: number) {
    const r = v.inst.root;
    const t0 = v.dying;
    v.dying += dt;
    const t = v.dying;
    // 2.6 秒の間、体のあちこちで爆発が続く → 大きな爆発 → 前へ傾いて沈む
    if (t < 2.6) {
      if (t - t0 > 0 && Math.floor(t / 0.22) !== Math.floor(t0 / 0.22)) {
        const p = r.localToWorld(new THREE.Vector3((Math.random() - 0.5) * 4.4, 2 + Math.random() * 5, (Math.random() - 0.5) * 3));
        this.blast(p, 2.4, 0.8);
        this.fx.explode(p, 2.4);
      }
      v.pose(dt, v.yawCur, 0, this.time);
      r.position.x = v.cur.x + (Math.random() - 0.5) * 0.08;
      r.position.z = v.cur.z + (Math.random() - 0.5) * 0.08;
    } else {
      if (t0 < 2.6) {
        const p = r.localToWorld(new THREE.Vector3(0, 5, 0));
        this.blast(p, 7, 1.8);
        this.fx.explode(p, 7);
        this.fx.shake(p, 3);
      }
      const k = Math.min(1, (t - 2.6) / 1.6);
      r.rotation.x = -k * k * 0.32;
      r.position.y = v.cur.y - k * k * 1.2 - Math.max(0, t - 4.2) * 1.6;
      if (v.thigh[0]) v.thigh[0].rotation.x = 0.4 * k;
      if (v.thigh[1]) v.thigh[1].rotation.x = -0.3 * k;
      if (v.shin[0]) v.shin[0].rotation.x = -0.9 * k;
      if (v.shin[1]) v.shin[1].rotation.x = -0.7 * k;
      if (Math.random() < dt * 14) {
        const p = r.localToWorld(new THREE.Vector3((Math.random() - 0.5) * 4, 3 + Math.random() * 3, (Math.random() - 0.5) * 3));
        this.smoke.spawn({ pos: p, vel: new THREE.Vector3(0, 2.5, 0), life: 3, size0: 1.2, size1: 4, color: SMOKE_DARK, alpha: 0.7, drag: 0.6, gravity: -0.4 });
      }
    }
    if (v.reactor) v.reactor.emissiveIntensity = Math.max(0, 8 * (1 - t / 2.8)) * (0.6 + 0.4 * Math.sin(t * 40));
    if (v.eye) v.eye.emissiveIntensity = Math.max(0, 6 * (1 - t / 2.6));
    setFlash(v.inst.flashMats, t < 2.6 ? 0.25 + 0.25 * Math.sin(t * 25) : 0, new THREE.Color('#ff7a3a'));
    if (t > 7) {
      v.dispose();
      this.bosses.delete(id);
    }
  }

  /** コアの目印：いつも見える（画面の外なら端に寄せる） */
  private updateCoreTag(camera: THREE.PerspectiveCamera, camPos: THREE.Vector3, width: number, height: number) {
    const c = this.match.core;
    const p = this.tmp.set(c.movement.pos.x, c.movement.pos.y + 7.4, c.movement.pos.z);
    const dist = p.distanceTo(camPos);
    p.project(camera);
    let x = p.x,
      y = p.y;
    const behind = p.z > 1;
    if (behind) {
      x = -x;
      y = -y;
    }
    // 画面の外なら、端（ほかの表示と重ならない範囲）に寄せる
    const mx = 0.86,
      yTop = 0.62,
      yBot = -0.5;
    const off = behind || Math.abs(x) > mx || y > yTop || y < yBot;
    if (off) {
      if (behind) {
        // 後ろ：左右どちらかの端の、少し下
        x = x < 0 ? -mx : mx;
        y = THREE.MathUtils.clamp(y, yBot, yTop) * 0.5;
      } else {
        const kx = Math.abs(x) > mx ? mx / Math.abs(x) : 1;
        const ky = y > yTop ? yTop / y : y < yBot ? yBot / y : 1;
        const k = Math.min(kx, ky);
        x *= k;
        y *= k;
      }
      // 右の端では、チームの表示（右の真ん中）と重ならないように上へ
      if (x > mx * 0.85 && y < 0.28) y = 0.28;
    }
    const hp = Math.max(0, c.health / c.maxHealth);
    const px = ((x + 1) / 2) * width;
    const py = ((1 - y) / 2) * height;
    this.coreTag.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) translate(-50%, -100%)`;
    this.coreTag.classList.toggle('edge', off);
    this.coreTag.classList.toggle('alert', this.match.coreUnderAttack());
    this.coreTag.classList.toggle('low', hp < 0.3);
    (this.coreTag.lastElementChild as HTMLElement).textContent = `${Math.ceil(hp * 100)}%${off || dist > 30 ? `　${Math.round(dist)}m` : ''}`;
    // 画面の外のときはミニマップの縁に出すので、ここでは出さない
    this.coreTag.style.display = c.dead || off ? 'none' : 'flex';
  }

  setTagsVisible(on: boolean): void {
    this.tagLayer.style.display = on ? '' : 'none';
  }

  dispose(): void {
    this.devices.dispose();
    this.drops.dispose();
    this.mortars.dispose();
    for (const v of this.turrets.values()) v.dispose();
    for (const v of this.drones.values()) v.dispose();
    for (const v of this.bosses.values()) v.dispose();
    this.turrets.clear();
    this.drones.clear();
    this.bosses.clear();
    this.core.dispose();
    this.smoke.dispose();
    this.glow.dispose();
    this.tagLayer.remove();
    this.group.removeFromParent();
  }
}
