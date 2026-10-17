/**
 * 降下ポッドの表示（仕様 5.3.3）。
 *
 * 降下ポッド
 * - 着地の数秒前：降りる場所の地面に赤い輪（だんだん縮む）と、空へ伸びる光の柱。ミニマップと画面の上にも出る
 * - 最後の 1.5 秒：空の高い所から、火の尾を引いて斜めに落ちてくる。地面の近くで逆噴射して減速する
 * - 着地：土ぼこりの輪・火花・画面の揺れ。底の耐熱板が赤く焼けていて、ゆっくり冷める
 * - 扉が外へ倒れて開き、中から分隊が出てくる。しばらくすると扉を閉じ、噴射して空へ戻っていく
 * 準備時間中は、次のウェーブの降下予定地点に、回る点線の輪と薄い光の柱を出す
 */
import * as THREE from 'three';
import { tdConfig } from '../../config';
import type { TdDropKind, TdDropZone } from '../../shared/level';
import type { Vec3 } from '../../shared/math';
import type { PodState, TdEvent, TdMatch } from '../../shared/td/towerDefense';
import type { Particles } from './particles';
import { type Inst, V, instantiate, part } from './viewUtil';

export type DropSound = 'podFall' | 'podImpact' | 'podOpen' | 'podLift';

export interface DropFx {
  explode(pos: Vec3, radius: number): void;
  shake(pos: Vec3, strength: number): void;
  blast(pos: Vec3, radius: number, strength: number): void;
  smoke: Particles;
  glow: Particles;
  sound(kind: DropSound, pos: Vec3): void;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const easeOut = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
const easeInOut = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

/** 落ちてくるのが見える時間（着地の何秒前から）・落ち始めの高さ */
const FALL_TIME = 1.5;
/** 逆噴射の時間・その前の速さ・着地の速さ */
const RETRO_TIME = 0.22;
const FALL_SPEED = 150;
const TOUCH_SPEED = 10;
const RETRO_H = ((FALL_SPEED + TOUCH_SPEED) / 2) * RETRO_TIME;
/** 斜めに降りてくる傾き（高さ 1m あたりの横のずれ） */
const SLANT = 0.22;
/** 飛び去る時間 */
const LIFT_TIME = 2.8;
/** 扉が開く角度 */
const DOOR_OPEN = (104 * Math.PI) / 180;

/** 着地までの残り時間 τ（秒）での、地面からの高さ */
function fallHeight(tau: number): number {
  if (tau <= 0) return 0;
  if (tau <= RETRO_TIME) return TOUCH_SPEED * tau + ((FALL_SPEED - TOUCH_SPEED) / (2 * RETRO_TIME)) * tau * tau;
  return RETRO_H + (tau - RETRO_TIME) * FALL_SPEED;
}

const KIND_COLOR: Record<TdDropKind, THREE.Color> = {
  outer: new THREE.Color('#ff4a32').multiplyScalar(1.8),
  wall: new THREE.Color('#ff8a2a').multiplyScalar(1.9),
  inner: new THREE.Color('#ff3a7a').multiplyScalar(1.9),
};
const FIRE = new THREE.Color('#ffb04a').multiplyScalar(2.2);
const JET = new THREE.Color('#ffd27a').multiplyScalar(2.6);
const SMOKE = new THREE.Color('#7c7872');
const SMOKE_DARK = new THREE.Color('#403c38');
const DUST = new THREE.Color('#9a8c72');

// ---------------------------------------------------------------------------
// 地面の輪・光の柱（シェーダー）
// ---------------------------------------------------------------------------

/** 地面の輪：外側の縁・中の点線・縮んでいく輪（uProgress 0→1 で着地） */
export function ringMaterial(color: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color.clone() }, uTime: { value: 0 }, uProgress: { value: 0 }, uAlpha: { value: 1 }, uDash: { value: 0 } },
    vertexShader: `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 uColor; uniform float uTime; uniform float uProgress; uniform float uAlpha; uniform float uDash; varying vec2 vP;
      void main(){
        float r = length(vP);
        float ang = atan(vP.y, vP.x);
        // 外の縁（r = 1）
        float edge = smoothstep(0.9, 0.97, r) * (1.0 - smoothstep(0.985, 1.0, r));
        // 点線（回る）：降下予定地点の印
        float dash = step(0.5, fract(ang * 6.0 / 3.14159 + uTime * 0.25));
        edge *= mix(1.0, dash, uDash);
        // 縮んでいく輪（着地が近いほど内側へ）
        float rr = mix(2.6, 0.95, uProgress);
        float closing = (1.0 - smoothstep(0.0, 0.05, abs(r - rr))) * (1.0 - uDash);
        // 中の薄い面と、着地の直前の点滅
        float fill = (1.0 - smoothstep(0.0, 1.0, r)) * (0.12 + 0.18 * uProgress) * (0.7 + 0.3 * sin(uTime * (6.0 + uProgress * 14.0))) * (1.0 - uDash * 0.6);
        float cross = (1.0 - smoothstep(0.0, 0.035, min(abs(vP.x), abs(vP.y)))) * step(r, 0.55) * 0.6 * (1.0 - uDash);
        float a = (edge * 0.9 + closing * 0.85 + fill + cross) * uAlpha;
        if (r > 2.7 || a < 0.003) discard;
        gl_FragColor = vec4(uColor, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
  });
}

/** 空へ伸びる光の柱（上ほど薄い） */
function beamMaterial(color: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color.clone() }, uAlpha: { value: 1 }, uTime: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 uColor; uniform float uAlpha; uniform float uTime; varying vec2 vUv;
      void main(){
        float fade = pow(1.0 - vUv.y, 1.6);
        float side = 1.0 - abs(vUv.x * 2.0 - 1.0);
        float flow = 0.75 + 0.25 * sin(vUv.y * 60.0 - uTime * 9.0);
        float a = fade * side * flow * uAlpha * 0.4;
        if (a < 0.003) discard;
        gl_FragColor = vec4(uColor, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
}

/** 輪のメッシュ（半径 r。position.xy が -2.7〜2.7 になるよう、平面を r 倍する） */
export function makeRing(mat: THREE.ShaderMaterial, r: number): THREE.Mesh {
  const g = new THREE.PlaneGeometry(5.4, 5.4);
  const m = new THREE.Mesh(g, mat);
  m.rotation.x = -Math.PI / 2;
  m.scale.setScalar(r);
  m.renderOrder = 6;
  m.frustumCulled = false;
  return m;
}

function makeBeam(mat: THREE.ShaderMaterial, radius: number, height: number): THREE.Mesh {
  const g = new THREE.CylinderGeometry(radius, radius * 1.6, height, 12, 1, true);
  g.translate(0, height / 2, 0);
  const m = new THREE.Mesh(g, mat);
  m.renderOrder = 6;
  m.frustumCulled = false;
  return m;
}

// ---------------------------------------------------------------------------
// 降下ポッド 1 つ
// ---------------------------------------------------------------------------

class PodView {
  readonly root = new THREE.Group();
  private readonly inst: Inst;
  private readonly body: THREE.Group;
  private readonly doors: Array<{ obj: THREE.Object3D; rest: THREE.Quaternion; axis: THREE.Vector3 }> = [];
  private readonly jets: THREE.Object3D[] = [];
  private readonly hot: THREE.MeshStandardMaterial | null;
  private readonly beacon: THREE.MeshStandardMaterial | null;
  private readonly marker = new THREE.Group();
  private readonly ringMat: THREE.ShaderMaterial;
  private readonly beamMat: THREE.ShaderMaterial;
  private readonly beam: THREE.Mesh;
  private readonly ground: THREE.Vector3;
  /** 降りてくる向き（横のずれ。外から斜めに入ってくる） */
  private readonly slant: THREE.Vector3;
  private landedFx = false;
  private fallSound = false;
  private openT = -1;
  private heat = 0;
  /** 飛び去り始めてからの時間（-1：まだ） */
  liftT = -1;
  done = false;
  private trailAcc = 0;
  private readonly flame: THREE.Mesh[] = [];

  constructor(
    tpl: THREE.Object3D,
    readonly pod: PodState,
    match: TdMatch,
    private readonly fx: DropFx,
  ) {
    this.ground = V(pod.pos);
    this.inst = instantiate(tpl);
    this.body = new THREE.Group();
    this.body.add(this.inst.root);
    this.root.add(this.body, this.marker);
    this.hot = this.inst.byName.get('PHot') ?? null;
    this.beacon = this.inst.byName.get('PBeacon') ?? null;
    for (let k = 0; k < 4; k++) {
      const d = part(this.inst.root, `PodDoor${k}`);
      if (!d) continue;
      // 扉 k の外向き：Blender の角度 k×90°（0 で +X）→ three では (cos, 0, -sin)。蝶番の軸は接線
      const a = (k * Math.PI) / 2;
      this.doors.push({ obj: d, rest: d.quaternion.clone(), axis: new THREE.Vector3(-Math.sin(a), 0, -Math.cos(a)) });
    }
    for (let k = 0; k < 4; k++) {
      const j = part(this.inst.root, `PodJet${k}`);
      if (j) this.jets.push(j);
    }
    // 逆噴射・飛び去るときの炎（噴射口ごとに小さな円すい）
    const fm = new THREE.MeshBasicMaterial({ color: JET, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    for (const j of this.jets) {
      // 先が噴射口、下へ広がる炎
      const g = new THREE.ConeGeometry(0.2, 1.6, 10, 1, true);
      g.translate(0, -0.8, 0);
      const f = new THREE.Mesh(g, fm);
      f.visible = false;
      j.add(f);
      this.flame.push(f);
    }
    // 降りる場所の印
    const color = KIND_COLOR[pod.zone.kind];
    this.ringMat = ringMaterial(color);
    this.beamMat = beamMaterial(color);
    const R = tdConfig.POD.IMPACT_RADIUS;
    const ring = makeRing(this.ringMat, R);
    ring.position.set(this.ground.x, this.ground.y + 0.06, this.ground.z);
    const beam = makeBeam(this.beamMat, 0.16, 90);
    beam.position.copy(this.ground);
    this.beam = beam;
    this.marker.add(ring, beam);
    // 外から斜めに入ってくる（コアから外へ向かう向きの逆から）
    const core = match.td.core;
    const out = new THREE.Vector3(this.ground.x - core.x, 0, this.ground.z - core.z);
    if (out.lengthSq() < 1) out.set(1, 0, 0);
    out.normalize();
    // 少しだけ向きをばらつかせる
    const jitter = ((pod.id * 2654435761) % 1000) / 1000 - 0.5;
    out.applyAxisAngle(new THREE.Vector3(0, 1, 0), jitter * 0.9);
    this.slant = out.multiplyScalar(SLANT);
    this.body.visible = false;
    this.inst.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.castShadow = m.receiveShadow = true;
    });
  }

  /** 着地の演出（1回だけ） */
  private impact() {
    this.landedFx = true;
    this.heat = 1;
    const c = this.ground.clone();
    const fx = this.fx;
    // 土ぼこりの輪
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + Math.random() * 0.2;
      const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      fx.smoke.spawn({
        pos: c.clone().addScaledVector(dir, 1.1).add(new THREE.Vector3(0, 0.3, 0)),
        vel: dir.clone().multiplyScalar(7 + Math.random() * 6).add(new THREE.Vector3(0, 0.6 + Math.random(), 0)),
        life: 1.4 + Math.random() * 1.2,
        size0: 0.9,
        size1: 3.2 + Math.random() * 1.5,
        color: Math.random() < 0.5 ? DUST : SMOKE,
        alpha: 0.55,
        drag: 2.4,
        gravity: -0.15,
      });
    }
    // 火花
    for (let i = 0; i < 28; i++) {
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.7 + 0.2, Math.random() - 0.5).normalize();
      fx.glow.spawn({ pos: c.clone().add(new THREE.Vector3(0, 0.3, 0)), vel: dir.multiplyScalar(6 + Math.random() * 9), life: 0.35 + Math.random() * 0.5, size0: 0.16, size1: 0.04, color: FIRE, alpha: 1, drag: 1.2, gravity: 12 });
    }
    fx.shake(this.pod.pos, 1.3);
    fx.sound('podImpact', this.pod.pos);
  }

  /** 扉が開き始めた */
  open() {
    if (this.openT >= 0) return;
    this.openT = 0;
    // 扉のすき間から吹き出す蒸気
    for (let k = 0; k < this.doors.length; k++) {
      const a = (k * Math.PI) / 2;
      const dir = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a));
      for (let i = 0; i < 4; i++)
        this.fx.smoke.spawn({
          pos: this.ground.clone().addScaledVector(dir, 1.0).add(new THREE.Vector3(0, 0.6 + Math.random() * 1.6, 0)),
          vel: dir.clone().multiplyScalar(2.5 + Math.random() * 2).add(new THREE.Vector3(0, 0.8, 0)),
          life: 0.9 + Math.random() * 0.5,
          size0: 0.4,
          size1: 1.6,
          color: new THREE.Color('#d8dcdf'),
          alpha: 0.35,
          drag: 2.5,
          gravity: -0.4,
        });
    }
    this.fx.sound('podOpen', this.pod.pos);
  }

  /** 飛び去り始めた（試合の側ではもう消えている） */
  lift() {
    if (this.liftT >= 0) return;
    this.liftT = 0;
    this.fx.sound('podLift', this.pod.pos);
  }

  update(dt: number, now: number, time: number, cam: THREE.Vector3) {
    const p = this.pod;
    const tau = p.landAt - now;
    // 光の柱は、すぐ近くでは薄く（視界をふさがない）
    const near = clamp01((Math.hypot(cam.x - this.ground.x, cam.z - this.ground.z) - 4) / 22);
    // --- 降りる場所の印（着地まで。着地したら薄れて消える） ---
    const warnTotal = Math.max(0.1, p.landAt - p.warnAt);
    const prog = clamp01(1 - tau / warnTotal);
    this.ringMat.uniforms.uTime.value = time;
    this.ringMat.uniforms.uProgress.value = prog;
    this.beamMat.uniforms.uTime.value = time;
    const markA = tau > 0 ? Math.min(1, (warnTotal - tau) / 0.25) : clamp01(1 + tau / 0.5);
    this.ringMat.uniforms.uAlpha.value = markA;
    this.beamMat.uniforms.uAlpha.value = markA * (tau > 0 ? 1 : 0.5) * (0.25 + 0.75 * near);
    this.beam.visible = markA > 0.01;
    this.marker.visible = markA > 0.01;

    // --- ポッドの位置 ---
    let h = 0;
    let lift = 0;
    if (this.liftT >= 0) {
      this.liftT += dt;
      // 扉を閉じてから（0.4 秒）、噴射して上がる
      const t = Math.max(0, this.liftT - 0.45);
      lift = 0.5 * 26 * t * t + 2 * t;
      if (this.liftT > LIFT_TIME) this.done = true;
    } else if (tau > 0) h = fallHeight(tau);
    const visible = this.liftT >= 0 ? true : tau < FALL_TIME;
    this.body.visible = visible;
    if (!visible) return;
    this.body.position.set(this.ground.x + this.slant.x * h, this.ground.y + h + lift, this.ground.z + this.slant.z * h);
    // 落ちている間は進む向きに少し傾く（斜めの軌道に沿う）
    const tilt = tau > 0 && this.liftT < 0 ? Math.min(1, h / 20) : 0;
    this.body.rotation.set(0, 0, 0);
    if (tilt > 0) {
      const ax = new THREE.Vector3(-this.slant.z, 0, this.slant.x).normalize();
      this.body.quaternion.setFromAxisAngle(ax, -Math.atan(SLANT) * tilt);
    }
    this.body.rotateY(p.id * 1.7);
    if (tau > 0 && !this.fallSound && tau < FALL_TIME - 0.1) {
      this.fallSound = true;
      this.fx.sound('podFall', p.pos);
    }

    // --- 落ちてくる間：火の尾・煙。地面の近くで逆噴射 ---
    const falling = tau > 0 && this.liftT < 0;
    const retro = falling && tau < RETRO_TIME + 0.12;
    const lifting = this.liftT > 0.45;
    for (const f of this.flame) {
      f.visible = retro || lifting;
      if (f.visible) f.scale.set(1, (retro ? 1.4 : 1.0) * (0.85 + Math.random() * 0.3) * (lifting ? 1.3 : 1), 1);
    }
    if (falling || lifting) {
      this.trailAcc += dt * (falling ? 45 : 30);
      const base = this.body.position.clone();
      while (this.trailAcc >= 1) {
        this.trailAcc -= 1;
        if (falling) {
          const back = this.slant.clone().multiplyScalar(-1).add(new THREE.Vector3(0, 1, 0)).normalize();
          const at = base.clone().addScaledVector(back, Math.random() * 3);
          this.fx.glow.spawn({ pos: at, vel: new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 2, (Math.random() - 0.5) * 2), life: 0.2 + Math.random() * 0.2, size0: 0.65, size1: 0.15, color: FIRE, alpha: 0.6 });
          if (Math.random() < 0.5) this.fx.smoke.spawn({ pos: at.clone().addScaledVector(back, 2), vel: new THREE.Vector3((Math.random() - 0.5) * 1.5, 0.5, (Math.random() - 0.5) * 1.5), life: 1.6 + Math.random(), size0: 1.2, size1: 3.6, color: Math.random() < 0.5 ? SMOKE_DARK : SMOKE, alpha: 0.45, drag: 0.8, gravity: -0.2 });
        } else {
          this.fx.smoke.spawn({ pos: base.clone().add(new THREE.Vector3((Math.random() - 0.5) * 1.5, 3.4, (Math.random() - 0.5) * 1.5)), vel: new THREE.Vector3((Math.random() - 0.5) * 3, -2 - Math.random() * 2, (Math.random() - 0.5) * 3), life: 1.2, size0: 0.8, size1: 2.8, color: SMOKE, alpha: 0.4, drag: 1.8, gravity: -0.1 });
        }
      }
    }
    if (!falling && !this.landedFx && this.liftT < 0) this.impact();

    // --- 底の焼けた縁が冷める・灯りが点滅する ---
    if (this.hot) this.hot.emissiveIntensity = falling ? 9 : 0.4 + this.heat * 8;
    this.heat = Math.max(0, this.heat - dt / 7);
    if (this.beacon) this.beacon.emissiveIntensity = Math.sin(time * 9 + p.id) > 0.2 ? 9 : 1.5;

    // --- 扉 ---
    let open = 0;
    if (this.openT >= 0) {
      this.openT += dt;
      open = easeOut(this.openT / 0.55);
    }
    if (this.liftT >= 0) open *= 1 - easeInOut(this.liftT / 0.4);
    for (const d of this.doors) d.obj.quaternion.setFromAxisAngle(d.axis, open * DOOR_OPEN).multiply(d.rest);
  }

  dispose() {
    this.root.removeFromParent();
    this.ringMat.dispose();
    this.beamMat.dispose();
    for (const m of this.inst.byName.values()) m.dispose();
    for (const f of this.flame) f.geometry.dispose();
    (this.flame[0]?.material as THREE.Material | undefined)?.dispose();
    this.marker.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
  }
}

// ---------------------------------------------------------------------------
// 降下予定地点の印（準備時間中）
// ---------------------------------------------------------------------------

class PlannedMark {
  readonly root = new THREE.Group();
  private readonly ringMat: THREE.ShaderMaterial;
  private readonly beamMat: THREE.ShaderMaterial;
  alpha = 0;
  want = 0;

  constructor(readonly zone: TdDropZone) {
    const color = KIND_COLOR[zone.kind];
    this.ringMat = ringMaterial(color);
    this.ringMat.uniforms.uDash.value = 1;
    this.ringMat.uniforms.uProgress.value = 0;
    this.beamMat = beamMaterial(color);
    const ring = makeRing(this.ringMat, zone.radius + 0.8);
    ring.position.set(zone.center.x, zone.center.y + 0.08, zone.center.z);
    const beam = makeBeam(this.beamMat, 0.3, 60);
    beam.position.set(zone.center.x, zone.center.y, zone.center.z);
    this.root.add(ring, beam);
    this.root.visible = false;
  }

  update(dt: number, time: number, cam: THREE.Vector3) {
    this.alpha += (this.want - this.alpha) * Math.min(1, dt * 4);
    this.root.visible = this.alpha > 0.01;
    const c = this.zone.center;
    const near = clamp01((Math.hypot(cam.x - c.x, cam.z - c.z) - this.zone.radius) / 20);
    this.ringMat.uniforms.uTime.value = time;
    this.ringMat.uniforms.uAlpha.value = this.alpha * 0.8;
    this.beamMat.uniforms.uTime.value = time;
    this.beamMat.uniforms.uAlpha.value = this.alpha * 0.4 * (0.2 + 0.8 * near);
  }

  dispose() {
    this.root.removeFromParent();
    this.ringMat.dispose();
    this.beamMat.dispose();
    this.root.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
  }
}

// ---------------------------------------------------------------------------
// まとめ
// ---------------------------------------------------------------------------

export class DropViews {
  readonly group = new THREE.Group();
  private readonly pods = new Map<number, PodView>();
  private readonly planned = new Map<string, PlannedMark>();
  private time = 0;

  constructor(
    private readonly podTpl: THREE.Object3D,
    private readonly match: TdMatch,
    private readonly fx: DropFx,
  ) {
    this.group.name = 'DropViews';
    for (const z of match.td.dropZones) {
      const pm = new PlannedMark(z);
      this.planned.set(z.id, pm);
      this.group.add(pm.root);
    }
  }

  /** ティックごと：増えたポッドの表示を作る。なくなったポッドは飛び去らせる */
  afterTick(): void {
    for (const p of this.match.pods.values()) {
      if (this.pods.has(p.id)) continue;
      const v = new PodView(this.podTpl, p, this.match, this.fx);
      this.pods.set(p.id, v);
      this.group.add(v.root);
    }
    for (const [id, v] of this.pods) if (!this.match.pods.has(id)) v.lift();
  }

  onEvents(events: TdEvent[]): void {
    for (const ev of events) {
      if (ev.type === 'podOpen') this.pods.get(ev.podId)?.open();
    }
  }

  update(dt: number, camera: THREE.PerspectiveCamera): void {
    this.time += dt;
    const m = this.match;
    const now = m.sim.time;
    const camPos = camera.getWorldPosition(new THREE.Vector3());
    for (const [id, v] of this.pods) {
      v.update(dt, now, this.time, camPos);
      if (v.done) {
        v.dispose();
        this.pods.delete(id);
      }
    }
    // 降下予定地点：準備時間中（ウェーブが始まると消えていく。そこからは降りてくるポッドの印）
    const zones = new Set(m.phase === 'prep' ? m.plannedDrops().map((p) => p.zone.id) : []);
    for (const [id, pm] of this.planned) {
      pm.want = zones.has(id) ? 1 : 0;
      pm.update(dt, this.time, camPos);
    }
  }

  /** シェーダーの準備用：ポッドと印を1つずつ */
  warmObjects(): THREE.Object3D[] {
    const g = new THREE.Group();
    g.position.set(0, -500, 0);
    const inst = instantiate(this.podTpl);
    g.add(inst.root);
    const r = makeRing(ringMaterial(KIND_COLOR.wall), 3);
    const b = makeBeam(beamMaterial(KIND_COLOR.wall), 0.3, 10);
    g.add(r, b);
    const fm = new THREE.MeshBasicMaterial({ color: JET, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    g.add(new THREE.Mesh(new THREE.ConeGeometry(0.1, 1, 6), fm));
    return [g];
  }

  dispose(): void {
    for (const v of this.pods.values()) v.dispose();
    for (const v of this.planned.values()) v.dispose();
    this.pods.clear();
    this.planned.clear();
    this.group.removeFromParent();
  }
}
