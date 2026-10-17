/**
 * 購入メニューの設置物の表示と演出（仕様 5.3.5・6.2）。
 * - ダミーバルーン：置くとシューッとふくらむ（弾むように伸びる）。風で揺れ、撃たれるとぶるっと震える。割れるとしぼんで破片が散る
 * - ワイヤートラップ：中央の機雷が落ち、左右の機雷が弧を描いて飛んでいく → 脚が開く → 頭が伸びる → レーザーがつながる
 *   （タイタンフォール2のイオンのトリップワイヤーのように）。横切られると光が強まり、近い機雷から順に爆発する
 * - バリケード：両端の柱が地面から出て、3枚の板が順にせり上がる（土ぼこり）。壊れると爆発して崩れる
 * - ジャンプパッド：置くと弾んで現れる。乗ると板が跳ね、光の柱が上がる
 */
import * as THREE from 'three';
import { type TdDeviceType, tdConfig, tdNum } from '../../config';
import type { DeviceState, TdEvent, TdMatch } from '../../shared/td/towerDefense';
import type { Entity } from '../../shared/simulation';
import type { Vec3 } from '../../shared/math';
import type { TdAssets } from '../assets';
import type { Particles } from './particles';
import { FLASH, type Inst, V, instantiate, part, setFlash } from './viewUtil';

export interface DeviceFx {
  explode(pos: Vec3, radius: number): void;
  shake(pos: Vec3, strength: number): void;
  blast(pos: Vec3, radius: number, strength: number): void;
  smoke: Particles;
  glow: Particles;
  /** 3D の音 */
  sound(kind: DeviceSound, pos: Vec3): void;
}
export type DeviceSound = 'decoyInflate' | 'decoyPop' | 'trapDeploy' | 'trapArm' | 'trapTrigger' | 'jumpPad' | 'barricadeUp' | 'barricadeBreak' | 'padDeploy';

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const easeOut = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
/** 少し行き過ぎて戻る */
const easeBack = (x: number) => {
  const t = clamp01(x) - 1;
  return 1 + t * t * (2.7 * t + 1.7);
};
/** ばねのように弾んで止まる */
const easeElastic = (x: number) => {
  const t = clamp01(x);
  if (t === 0 || t === 1) return t;
  return Math.pow(2, -9 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
};

const LASER = new THREE.Color('#ff3a6a');
const DUST = new THREE.Color('#8a857c');
const SHRED = new THREE.Color('#3d4655');
const PAD_GLOW = new THREE.Color('#3dffc4').multiplyScalar(1.8);
const LASER_GLOW = new THREE.Color('#ff3a6a').multiplyScalar(1.6);

function noShadowCaster(root: THREE.Object3D, cast: boolean) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) m.castShadow = cast;
  });
}

/** 体力の小さな棒（タレットと同じ見た目） */
class Tag {
  readonly el: HTMLElement;
  private shown = false;
  constructor(layer: HTMLElement, cls: string) {
    this.el = document.createElement('div');
    this.el.className = `td-turret-tag ${cls}`;
    this.el.innerHTML = '<s><u></u></s>';
    layer.appendChild(this.el);
  }
  set(show: boolean, x = 0, y = 0, hp = 1) {
    if (show !== this.shown) {
      this.shown = show;
      this.el.style.display = show ? 'block' : 'none';
    }
    if (!show) return;
    this.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    (this.el.firstElementChild!.firstElementChild as HTMLElement).style.transform = `scaleX(${hp.toFixed(3)})`;
    this.el.classList.toggle('low', hp < 0.35);
  }
  dispose() {
    this.el.remove();
  }
}

abstract class DeviceView {
  readonly root = new THREE.Group();
  /** 置いてからの時間（表示の時計） */
  t = 0;
  flash = 0;
  leaving: 'sold' | 'destroyed' | 'used' | null = null;
  leaveT = 0;
  /** 取り除いてよい */
  done = false;
  tag: Tag | null = null;
  constructor(
    readonly d: DeviceState,
    protected readonly fx: DeviceFx,
  ) {
    this.root.position.set(d.pos.x, d.pos.y, d.pos.z);
    this.root.rotation.y = d.yaw;
    this.t = Math.max(0, d.age);
  }
  abstract update(dt: number, e: Entity | undefined, time: number): void;
  onHit(amount: number) {
    this.flash = Math.min(1, this.flash + 0.4 + amount / 60);
  }
  leave(reason: 'sold' | 'destroyed' | 'used') {
    if (this.leaving) return;
    this.leaving = reason;
    this.leaveT = 0;
  }
  /** 体力の表示の高さ */
  tagHeight = 2.2;
  abstract dispose(): void;
}

// ---------------------------------------------------------------------------
// ダミーバルーン
// ---------------------------------------------------------------------------

class DecoyView extends DeviceView {
  private readonly inst: Inst;
  private readonly body: THREE.Object3D | null;
  private readonly glow: THREE.MeshStandardMaterial | null;
  private wob = new THREE.Vector2();
  private wobV = new THREE.Vector2();
  private squash = 0;
  private squashV = 0;
  private popped = false;
  private readonly phase = Math.random() * 10;

  constructor(tpl: THREE.Object3D, d: DeviceState, fx: DeviceFx, layer: HTMLElement) {
    super(d, fx);
    this.inst = instantiate(tpl);
    this.root.add(this.inst.root);
    this.body = part(this.inst.root, 'DecoyBody');
    this.glow = this.inst.byName.get('DGlow') ?? null;
    this.tag = new Tag(layer, 'decoy');
    this.tagHeight = 2.15;
    if (this.t < 0.1) fx.sound('decoyInflate', d.pos);
  }

  override onHit(amount: number) {
    super.onHit(amount);
    // ぶるっと震える（撃たれた量に応じて）
    const k = 0.6 + Math.min(2, amount / 15);
    this.wobV.x += (Math.random() - 0.5) * k * 3;
    this.wobV.y += (Math.random() - 0.5) * k * 3;
    this.squashV -= k * 0.6;
  }

  update(dt: number, e: Entity | undefined, time: number) {
    this.t += dt;
    const b = this.body;
    if (!b) return;
    if (this.leaving === 'destroyed') {
      // 割れる：一瞬ふくらんでから、しぼんで倒れる
      this.leaveT += dt;
      const k = this.leaveT;
      if (!this.popped) {
        this.popped = true;
        const c = this.root.position.clone().add(new THREE.Vector3(0, 1.2, 0));
        for (let i = 0; i < 26; i++) {
          const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 + 0.1, Math.random() - 0.5).normalize();
          this.fx.smoke.spawn({ pos: c.clone().addScaledVector(dir, Math.random() * 0.4), vel: dir.multiplyScalar(3 + Math.random() * 5), life: 0.9 + Math.random() * 0.8, size0: 0.14, size1: 0.1, color: SHRED, alpha: 0.95, drag: 2.2, gravity: 7 });
        }
        for (let i = 0; i < 6; i++) this.fx.smoke.spawn({ pos: c.clone(), vel: new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 1.5, (Math.random() - 0.5) * 2), life: 0.8, size0: 0.4, size1: 1.4, color: new THREE.Color('#c8ccd4'), alpha: 0.35, drag: 3, gravity: -0.2 });
        this.fx.glow.spawn({ pos: c.clone(), life: 0.12, size0: 1.6, size1: 0.3, color: FLASH, alpha: 0.9 });
        this.fx.sound('decoyPop', this.d.pos);
      }
      const s = k < 0.05 ? 1 + k * 3 : Math.max(0.0, 1 - (k - 0.05) * 9);
      b.scale.set(Math.max(0.6, s) * (k < 0.05 ? 1 : 1.3), Math.max(0.04, s), Math.max(0.6, s) * (k < 0.05 ? 1 : 1.3));
      b.visible = k < 0.2;
      // 台は少し残って沈む
      if (k > 1.6) this.root.position.y -= dt * 0.8;
      if (k > 2.2) this.done = true;
      return;
    }
    if (this.leaving) {
      this.leaveT += dt;
      // 売った：しぼむ
      const k = clamp01(1 - this.leaveT / 0.45);
      b.scale.set(0.5 + 0.5 * k, Math.max(0.03, k), 0.5 + 0.5 * k);
      if (this.leaveT > 0.6) this.done = true;
      return;
    }
    // ふくらむ（1 秒。縦にのびて、少し行き過ぎて戻る）
    const inf = this.t / 1.0;
    const sy = inf < 1 ? 0.05 + 0.95 * easeElastic(inf) : 1;
    const sxz = inf < 1 ? 0.45 + 0.55 * easeOut(inf * 1.3) : 1;
    // 揺れ：風の揺れ＋撃たれたときのばね
    const wx = Math.sin(time * 1.3 + this.phase) * 0.025 + Math.sin(time * 2.9 + this.phase * 2) * 0.012;
    const wz = Math.sin(time * 1.1 + this.phase * 1.7) * 0.03;
    this.wobV.x += (-this.wob.x * 60 - this.wobV.x * 5) * dt;
    this.wobV.y += (-this.wob.y * 60 - this.wobV.y * 5) * dt;
    this.wob.x += this.wobV.x * dt;
    this.wob.y += this.wobV.y * dt;
    this.squashV += (-this.squash * 90 - this.squashV * 7) * dt;
    this.squash += this.squashV * dt;
    b.rotation.set(wx + this.wob.x * 0.12, 0, wz + this.wob.y * 0.12);
    const breathe = 1 + Math.sin(time * 2.2 + this.phase) * 0.012;
    b.scale.set(sxz * (1 - this.squash * 0.5) * breathe, sy * (1 + this.squash) * (2 - breathe), sxz * (1 - this.squash * 0.5) * breathe);
    this.flash = Math.max(0, this.flash - dt * 6);
    setFlash(this.inst.flashMats, this.flash, e && e.health < e.maxHealth * 0.3 ? new THREE.Color('#ff6a3a') : FLASH);
    if (this.glow) this.glow.emissiveIntensity = 3 + Math.sin(time * 4 + this.phase) * 1;
  }

  dispose() {
    this.root.removeFromParent();
    for (const m of this.inst.byName.values()) m.dispose();
    this.tag?.dispose();
  }
}

// ---------------------------------------------------------------------------
// ワイヤートラップ
// ---------------------------------------------------------------------------

interface Pod {
  inst: Inst;
  legs: THREE.Object3D[];
  legAxis: THREE.Vector3[];
  legRest: THREE.Quaternion[];
  head: THREE.Object3D | null;
  headRest: THREE.Vector3;
  emitter: THREE.Object3D | null;
  laser: THREE.MeshStandardMaterial | null;
  /** 置く場所（世界の座標） */
  target: THREE.Vector3;
  gone: boolean;
}

/** ワイヤートラップの機雷の形を、開き具合（脚 0〜1・頭 0〜1）に合わせる */
function posePod(p: Pod, legs: number, head: number) {
  const q = new THREE.Quaternion();
  for (let i = 0; i < p.legs.length; i++) {
    q.setFromAxisAngle(p.legAxis[i], (40 * Math.PI) / 180 * easeBack(legs));
    p.legs[i].quaternion.copy(p.legRest[i]).premultiply(q);
  }
  if (p.head) p.head.position.copy(p.headRest).add(new THREE.Vector3(0, 0.22 * easeOut(head), 0));
}

function makePod(tpl: THREE.Object3D): Pod {
  const inst = instantiate(tpl);
  const legs: THREE.Object3D[] = [];
  const legAxis: THREE.Vector3[] = [];
  const legRest: THREE.Quaternion[] = [];
  for (let k = 0; k < 3; k++) {
    const l = part(inst.root, `PodLeg${k}`);
    if (!l) continue;
    legs.push(l);
    legRest.push(l.quaternion.clone());
    // 外向き（Blender の (cos a, sin a) → three の (cos a, 0, -sin a)）へ、脚の先を振り出す軸
    const a = ((90 + k * 120) * Math.PI) / 180;
    const r = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a));
    legAxis.push(new THREE.Vector3(-r.z, 0, r.x).normalize());
  }
  const head = part(inst.root, 'PodHead');
  return {
    inst,
    legs,
    legAxis,
    legRest,
    head,
    headRest: head ? head.position.clone() : new THREE.Vector3(),
    emitter: part(inst.root, 'Emitter'),
    laser: inst.byName.get('WLaser') ?? null,
    target: new THREE.Vector3(),
    gone: false,
  };
}

/** レーザーの線（芯と、まわりのにじみ） */
class Beam {
  readonly core: THREE.Mesh;
  readonly halo: THREE.Mesh;
  constructor(group: THREE.Object3D, coreMat: THREE.Material, haloMat: THREE.Material) {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    this.core = new THREE.Mesh(geo, coreMat);
    this.halo = new THREE.Mesh(geo, haloMat);
    for (const m of [this.core, this.halo]) {
      m.frustumCulled = false;
      m.renderOrder = 6;
      m.visible = false;
      group.add(m);
    }
  }
  set(a: THREE.Vector3, b: THREE.Vector3, on: boolean, width = 1) {
    this.core.visible = this.halo.visible = on;
    if (!on) return;
    const d = b.clone().sub(a);
    const L = d.length();
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    this.core.position.copy(mid);
    this.core.quaternion.copy(q);
    this.core.scale.set(0.009 * width, L, 0.009 * width);
    this.halo.position.copy(mid);
    this.halo.quaternion.copy(q);
    this.halo.scale.set(0.045 * width, L, 0.045 * width);
  }
  dispose() {
    this.core.removeFromParent();
    this.halo.removeFromParent();
  }
}

class WireTrapView extends DeviceView {
  private readonly pods: Pod[] = [];
  private readonly beams: Beam[] = [];
  private readonly coreMat: THREE.MeshBasicMaterial;
  private readonly haloMat: THREE.MeshBasicMaterial;
  private triggered = -1;
  private armedSound = false;
  private readonly beamGroup = new THREE.Group();

  constructor(tpl: THREE.Object3D, d: DeviceState, fx: DeviceFx, group: THREE.Object3D) {
    super(d, fx);
    // 機雷は世界の座標で動かすので、向きは付けない
    this.root.position.set(0, 0, 0);
    this.root.rotation.set(0, 0, 0);
    this.coreMat = new THREE.MeshBasicMaterial({ color: LASER.clone().multiplyScalar(4), toneMapped: false, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.haloMat = new THREE.MeshBasicMaterial({ color: LASER.clone().multiplyScalar(1.2), toneMapped: false, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending });
    for (let i = 0; i < d.nodes.length; i++) {
      const p = makePod(tpl);
      p.target.copy(V(d.nodes[i]));
      p.inst.root.position.copy(p.target);
      p.inst.root.rotation.y = d.yaw;
      posePod(p, 0, 0);
      this.pods.push(p);
      this.root.add(p.inst.root);
    }
    for (let i = 0; i < d.nodes.length - 1; i++) this.beams.push(new Beam(this.beamGroup, this.coreMat, this.haloMat));
    group.add(this.beamGroup);
    if (this.t < 0.1) fx.sound('trapDeploy', d.pos);
  }

  /** 横切られた */
  trigger() {
    if (this.triggered < 0) this.triggered = 0;
    this.fx.sound('trapTrigger', this.d.pos);
  }

  /** 機雷1つの爆発（いちばん近い機雷を消す） */
  blow(pos: Vec3) {
    let best: Pod | null = null,
      bd = Infinity;
    for (const p of this.pods) {
      if (p.gone) continue;
      const dd = p.target.distanceTo(V(pos));
      if (dd < bd) {
        bd = dd;
        best = p;
      }
    }
    if (best) {
      best.gone = true;
      best.inst.root.visible = false;
    }
  }

  update(dt: number, _e: Entity | undefined, time: number) {
    this.t += dt;
    const t = this.t;
    const center = this.pods[1] ?? this.pods[0];
    // --- 展開：中央が落ちる → 左右が弧を描いて飛ぶ → 脚が開く → 頭が伸びる → レーザー ---
    for (let i = 0; i < this.pods.length; i++) {
      const p = this.pods[i];
      if (p.gone) continue;
      const r = p.inst.root;
      if (p === center) {
        const u = clamp01(t / 0.22);
        r.position.copy(p.target).add(new THREE.Vector3(0, (1 - easeOut(u)) * 0.5 - Math.sin(Math.min(1, t / 0.32) * Math.PI) * 0.0, 0));
      } else {
        const u = clamp01((t - 0.08) / 0.34);
        const c = center.target;
        r.position.lerpVectors(c, p.target, easeOut(u));
        r.position.y += Math.sin(u * Math.PI) * 0.7;
        r.rotation.y = this.d.yaw + (1 - easeOut(u)) * (i === 0 ? 6 : -6);
      }
      posePod(p, (t - 0.42) / 0.26, (t - 0.62) / 0.24);
      // 着地の小さな土ぼこり
      if (p !== center && t - dt < 0.42 && t >= 0.42) for (let k = 0; k < 4; k++) this.fx.smoke.spawn({ pos: p.target.clone().add(new THREE.Vector3(0, 0.05, 0)), vel: new THREE.Vector3((Math.random() - 0.5) * 1.5, 0.4, (Math.random() - 0.5) * 1.5), life: 0.6, size0: 0.15, size1: 0.6, color: DUST, alpha: 0.35, drag: 3, gravity: -0.2 });
      // 灯り：作動中は速く点滅
      if (p.laser) p.laser.emissiveIntensity = this.triggered >= 0 ? (Math.sin(time * 60) > 0 ? 14 : 2) : t < 0.9 ? 2 : 5 + Math.sin(time * 3 + i) * 2;
    }
    // --- レーザー ---
    const on = t > 0.86;
    const flick = t < 1.1 ? Math.random() < 0.6 : true;
    if (on && !this.armedSound && t > 1.1) {
      this.armedSound = true;
      this.fx.sound('trapArm', this.d.pos);
    }
    for (let i = 0; i < this.beams.length; i++) {
      const a = this.pods[i],
        b = this.pods[i + 1];
      const show = on && flick && !a.gone && !b.gone && !this.leaving;
      if (!show || !a.emitter || !b.emitter) {
        this.beams[i].set(new THREE.Vector3(), new THREE.Vector3(), false);
        continue;
      }
      const pa = a.emitter.getWorldPosition(new THREE.Vector3());
      const pb = b.emitter.getWorldPosition(new THREE.Vector3());
      this.beams[i].set(pa, pb, true, this.triggered >= 0 ? 2.2 : 1);
    }
    if (this.triggered >= 0) {
      this.triggered += dt;
      this.coreMat.color.copy(LASER).lerp(FLASH, 0.5 + 0.5 * Math.sin(time * 50)).multiplyScalar(5);
      this.haloMat.opacity = 0.5;
    } else {
      this.haloMat.opacity = 0.16 + 0.08 * Math.sin(time * 5);
      // ときどき、光の粒がレーザーを走る
      if (on && Math.random() < dt * 3 && this.pods.length > 1) {
        const k = Math.floor(Math.random() * (this.pods.length - 1));
        const pa = this.pods[k].emitter?.getWorldPosition(new THREE.Vector3());
        const pb = this.pods[k + 1].emitter?.getWorldPosition(new THREE.Vector3());
        if (pa && pb) this.fx.glow.spawn({ pos: pa, vel: pb.sub(pa).multiplyScalar(2.5), life: 0.4, size0: 0.08, size1: 0.03, color: LASER_GLOW, alpha: 0.9 });
      }
    }
    if (this.leaving) {
      this.leaveT += dt;
      if (this.leaving === 'sold') {
        const k = clamp01(1 - this.leaveT / 0.3);
        for (const p of this.pods) p.inst.root.scale.setScalar(Math.max(0.001, k));
        if (this.leaveT > 0.4) this.done = true;
      } else if (this.leaveT > 0.4) this.done = true;
    }
  }

  dispose() {
    this.root.removeFromParent();
    for (const p of this.pods) for (const m of p.inst.byName.values()) m.dispose();
    for (const b of this.beams) b.dispose();
    this.beamGroup.removeFromParent();
    this.coreMat.dispose();
    this.haloMat.dispose();
  }
}

// ---------------------------------------------------------------------------
// バリケード
// ---------------------------------------------------------------------------

class BarricadeView extends DeviceView {
  private readonly inst: Inst;
  private readonly panels: Array<{ o: THREE.Object3D; rest: THREE.Vector3 }> = [];
  private readonly posts: Array<{ o: THREE.Object3D; rest: THREE.Vector3 }> = [];
  private readonly base: THREE.Object3D | null;
  private readonly glow: THREE.MeshStandardMaterial | null;
  private broke = false;
  private readonly H: number;
  private readonly W: number;

  constructor(tpl: THREE.Object3D, d: DeviceState, fx: DeviceFx, layer: HTMLElement) {
    super(d, fx);
    this.inst = instantiate(tpl);
    this.root.add(this.inst.root);
    this.H = tdNum(tdConfig.ITEMS.barricade, 'HEIGHT', 1.25);
    this.W = tdNum(tdConfig.ITEMS.barricade, 'WIDTH', 4.2);
    for (let i = 0; i < 3; i++) {
      const o = part(this.inst.root, `BarPanel${i}`);
      if (o) this.panels.push({ o, rest: o.position.clone() });
    }
    for (const s of ['L', 'R']) {
      const o = part(this.inst.root, `BarPost.${s}`);
      if (o) this.posts.push({ o, rest: o.position.clone() });
    }
    this.base = part(this.inst.root, 'BarBase');
    this.glow = this.inst.byName.get('BarGlow') ?? null;
    this.tag = new Tag(layer, 'barricade');
    this.tagHeight = this.H + 0.6;
    if (this.t < 0.1) {
      fx.sound('barricadeUp', d.pos);
      // 幅いっぱいに土ぼこり
      const right = new THREE.Vector3(Math.cos(d.yaw), 0, -Math.sin(d.yaw));
      for (let i = 0; i < 14; i++) {
        const x = (Math.random() - 0.5) * this.W;
        const p = V(d.pos).addScaledVector(right, x).add(new THREE.Vector3(0, 0.1, 0));
        fx.smoke.spawn({ pos: p, vel: new THREE.Vector3((Math.random() - 0.5) * 2, 0.6 + Math.random(), (Math.random() - 0.5) * 2), life: 1 + Math.random() * 0.6, size0: 0.3, size1: 1.3, color: DUST, alpha: 0.4, drag: 2.5, gravity: -0.2 });
      }
    }
  }

  update(dt: number, e: Entity | undefined, time: number) {
    this.t += dt;
    const t = this.t;
    const H = this.H;
    if (this.base) this.base.scale.set(1, easeOut(t / 0.15), 1);
    this.posts.forEach((p, i) => p.o.position.copy(p.rest).add(new THREE.Vector3(0, -(H + 0.2) * (1 - easeBack((t - i * 0.04) / 0.3)), 0)));
    this.panels.forEach((p, i) => p.o.position.copy(p.rest).add(new THREE.Vector3(0, -(H + 0.1) * (1 - easeBack((t - 0.16 - i * 0.12) / 0.34)), 0)));
    this.flash = Math.max(0, this.flash - dt * 6);
    setFlash(this.inst.flashMats, this.flash, e && e.health < e.maxHealth * 0.3 ? new THREE.Color('#ff6a3a') : FLASH);
    if (this.glow) this.glow.emissiveIntensity = 3 + Math.sin(time * 2.5) * 1;
    // こわれかけ：火花と煙
    if (e && !e.dead && e.health < e.maxHealth * 0.35 && Math.random() < dt * 5) {
      const right = new THREE.Vector3(Math.cos(this.d.yaw), 0, -Math.sin(this.d.yaw));
      const p = this.root.position.clone().addScaledVector(right, (Math.random() - 0.5) * this.W).add(new THREE.Vector3(0, H * (0.4 + Math.random() * 0.6), 0));
      this.fx.smoke.spawn({ pos: p, vel: new THREE.Vector3(0, 1, 0), life: 1.4, size0: 0.3, size1: 1.2, color: new THREE.Color('#3a3836'), alpha: 0.5, drag: 0.8, gravity: -0.4 });
      if (Math.random() < 0.4) this.fx.glow.spawn({ pos: p, vel: new THREE.Vector3((Math.random() - 0.5) * 3, 2, (Math.random() - 0.5) * 3), life: 0.4, size0: 0.08, size1: 0.02, color: new THREE.Color('#ffb04a').multiplyScalar(2), alpha: 1, drag: 1, gravity: 9 });
    }
    if (this.leaving) {
      this.leaveT += dt;
      if (this.leaving === 'destroyed') {
        if (!this.broke) {
          this.broke = true;
          const c = this.root.position.clone().add(new THREE.Vector3(0, H * 0.5, 0));
          this.fx.blast(c, 2.6, 1);
          this.fx.explode(c, 2.2);
          this.fx.shake(c, 0.6);
          this.fx.sound('barricadeBreak', this.d.pos);
        }
        // 板が倒れて沈む
        const k = clamp01(this.leaveT / 0.6);
        this.panels.forEach((p, i) => {
          p.o.rotation.x = (i % 2 ? 1 : -1) * k * 1.2;
          p.o.position.y = p.rest.y - k * k * 0.9;
        });
        this.posts.forEach((p) => (p.o.position.y = p.rest.y - k * (H + 0.3)));
        if (this.leaveT > 1.0) this.done = true;
      } else {
        // 売った：地面へ引っ込む
        const k = clamp01(this.leaveT / 0.4);
        for (const p of [...this.panels, ...this.posts]) p.o.position.y = p.rest.y - k * (H + 0.2);
        if (this.leaveT > 0.5) this.done = true;
      }
    }
  }

  dispose() {
    this.root.removeFromParent();
    for (const m of this.inst.byName.values()) m.dispose();
    this.tag?.dispose();
  }
}

// ---------------------------------------------------------------------------
// ジャンプパッド
// ---------------------------------------------------------------------------

class JumpPadView extends DeviceView {
  private readonly inst: Inst;
  private readonly plate: THREE.Object3D | null;
  private readonly plateRest: THREE.Vector3;
  private readonly ringObj: THREE.Object3D | null;
  private readonly glow: THREE.MeshStandardMaterial | null;
  private kick = 0;
  private kickV = 0;
  private boost = 0;

  constructor(tpl: THREE.Object3D, d: DeviceState, fx: DeviceFx) {
    super(d, fx);
    this.inst = instantiate(tpl);
    this.root.add(this.inst.root);
    noShadowCaster(this.inst.root, false);
    this.plate = part(this.inst.root, 'PadPlate');
    this.plateRest = this.plate ? this.plate.position.clone() : new THREE.Vector3();
    this.ringObj = part(this.inst.root, 'PadRing');
    this.glow = this.inst.byName.get('JGlow') ?? null;
    if (this.t < 0.1) fx.sound('padDeploy', d.pos);
  }

  /** 誰かが跳んだ */
  launch() {
    this.kickV = 7;
    this.boost = 1;
    const c = this.root.position.clone();
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.8;
      this.fx.glow.spawn({ pos: c.clone().add(new THREE.Vector3(Math.cos(a) * r, 0.25, Math.sin(a) * r)), vel: new THREE.Vector3(0, 6 + Math.random() * 8, 0), life: 0.5 + Math.random() * 0.3, size0: 0.14, size1: 0.03, color: PAD_GLOW, alpha: 1, drag: 1.5, gravity: 0 });
    }
    for (let i = 0; i < 6; i++) this.fx.smoke.spawn({ pos: c.clone().add(new THREE.Vector3(0, 0.2, 0)), vel: new THREE.Vector3((Math.random() - 0.5) * 4, 0.3, (Math.random() - 0.5) * 4), life: 0.7, size0: 0.3, size1: 1.2, color: DUST, alpha: 0.3, drag: 3, gravity: -0.1 });
    this.fx.sound('jumpPad', this.d.pos);
  }

  update(dt: number, _e: Entity | undefined, time: number) {
    this.t += dt;
    const s = this.leaving ? clamp01(1 - this.leaveT / 0.3) : easeElastic(this.t / 0.6);
    this.inst.root.scale.set(Math.max(0.001, s), Math.max(0.001, s), Math.max(0.001, s));
    this.kickV += (-this.kick * 220 - this.kickV * 14) * dt;
    this.kick += this.kickV * dt;
    if (this.plate) this.plate.position.copy(this.plateRest).add(new THREE.Vector3(0, Math.max(-0.03, this.kick * 0.05), 0));
    this.boost = Math.max(0, this.boost - dt * 2.5);
    if (this.ringObj) this.ringObj.rotation.y += dt * (0.6 + this.boost * 6);
    if (this.glow) this.glow.emissiveIntensity = 4 + Math.sin(time * 4) * 1.5 + this.boost * 12;
    // 小さな光の粒が上がる（どこにあるか分かるように）
    if (!this.leaving && Math.random() < dt * 4) {
      const a = Math.random() * Math.PI * 2;
      this.fx.glow.spawn({ pos: this.root.position.clone().add(new THREE.Vector3(Math.cos(a) * 0.86, 0.22, Math.sin(a) * 0.86)), vel: new THREE.Vector3(0, 1.2, 0), life: 0.8, size0: 0.06, size1: 0.02, color: PAD_GLOW, alpha: 0.8 });
    }
    if (this.leaving) {
      this.leaveT += dt;
      if (this.leaveT > 0.4) this.done = true;
    }
  }

  dispose() {
    this.root.removeFromParent();
    for (const m of this.inst.byName.values()) m.dispose();
  }
}

// ---------------------------------------------------------------------------
// まとめ
// ---------------------------------------------------------------------------

export class DeviceViews {
  private readonly views = new Map<number, DeviceView>();
  private readonly tmp = new THREE.Vector3();

  constructor(
    private readonly assets: TdAssets,
    private readonly match: TdMatch,
    private readonly fx: DeviceFx,
    private readonly group: THREE.Group,
    private readonly tagLayer: HTMLElement,
  ) {}

  private make(d: DeviceState): DeviceView {
    switch (d.type) {
      case 'decoy':
        return new DecoyView(this.assets.decoy, d, this.fx, this.tagLayer);
      case 'wiretrap':
        return new WireTrapView(this.assets.wiretrap, d, this.fx, this.group);
      case 'barricade':
        return new BarricadeView(this.assets.barricade, d, this.fx, this.tagLayer);
      default:
        return new JumpPadView(this.assets.jumppad, d, this.fx);
    }
  }

  /** ティックごと：増えた設置物の表示を作る（減った物は deviceRemoved の出来事で消し始める） */
  afterTick(): void {
    for (const d of this.match.devices.values()) {
      if (this.views.has(d.id)) continue;
      const v = this.make(d);
      this.views.set(d.id, v);
      this.group.add(v.root);
    }
    for (const [id, v] of this.views) if (!this.match.devices.has(id) && !v.leaving) v.leave('sold');
  }

  onEvents(events: TdEvent[]): void {
    for (const ev of events) {
      if (ev.type === 'deviceRemoved') this.views.get(ev.deviceId)?.leave(ev.reason);
      else if (ev.type === 'trapTriggered') (this.views.get(ev.deviceId) as WireTrapView | undefined)?.trigger();
      else if (ev.type === 'trapExplode') {
        (this.views.get(ev.deviceId) as WireTrapView | undefined)?.blow(ev.pos);
        this.fx.blast(ev.pos, ev.radius * 0.7, 0.9);
        this.fx.explode(ev.pos, ev.radius * 0.6);
        this.fx.shake(ev.pos, 0.7);
      } else if (ev.type === 'jumpPad') (this.views.get(ev.deviceId) as JumpPadView | undefined)?.launch();
    }
  }

  /** 撃たれた（id は参加者の番号） */
  onHit(entityId: number, amount: number): boolean {
    const d = this.match.deviceOfEntity(entityId);
    const v = d ? this.views.get(d.id) : undefined;
    if (!v) return false;
    v.onHit(amount);
    return true;
  }

  update(dt: number, camera: THREE.PerspectiveCamera, camPos: THREE.Vector3, width: number, height: number, time: number): void {
    const sim = this.match.sim;
    for (const [id, v] of this.views) {
      const e = v.d.entityId >= 0 ? sim.entities.get(v.d.entityId) : undefined;
      v.update(dt, e, time);
      if (v.done) {
        v.dispose();
        this.views.delete(id);
        continue;
      }
      if (!v.tag) continue;
      let show = !!e && !e.dead && !v.leaving && e.health < e.maxHealth - 0.5;
      if (show) {
        const p = this.tmp.set(v.root.position.x, v.root.position.y + v.tagHeight, v.root.position.z);
        show = p.distanceTo(camPos) < 60;
        if (show) {
          p.project(camera);
          show = p.z < 1 && Math.abs(p.x) < 1.05 && Math.abs(p.y) < 1.05;
          if (show) v.tag.set(true, ((p.x + 1) / 2) * width, ((1 - p.y) / 2) * height, e!.health / e!.maxHealth);
        }
      }
      if (!show) v.tag.set(false);
    }
  }

  /** シェーダーの準備用：種類ごとに見た目を1つ */
  warmObjects(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const type of ['decoy', 'wiretrap', 'barricade', 'jumppad'] as TdDeviceType[]) {
      const tpl = this.assets[type];
      const inst = instantiate(tpl);
      inst.root.position.set(0, -500, 0);
      out.push(inst.root);
    }
    // レーザーの線
    const g = new THREE.Group();
    g.position.set(0, -500, 0);
    const b = new Beam(g, new THREE.MeshBasicMaterial({ color: LASER, toneMapped: false, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), new THREE.MeshBasicMaterial({ color: LASER, toneMapped: false, transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending }));
    b.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), true);
    out.push(g);
    return out;
  }

  dispose(): void {
    for (const v of this.views.values()) v.dispose();
    this.views.clear();
  }
}

/** ワイヤートラップの機雷を、開いた形で作る（置く前の影に使う） */
export function makeDeployedPod(tpl: THREE.Object3D): THREE.Group {
  const p = makePod(tpl);
  posePod(p, 1, 1);
  return p.inst.root;
}

