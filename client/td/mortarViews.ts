/**
 * 迫撃砲兵の表示（仕様 5.3.3）。
 *
 * - 運んでいる間：背中に迫撃砲（砲身・たたんだ二脚・小さな底板）を背負う（キャラクターの胸の骨に付ける）
 * - 据えた：背中の迫撃砲をはずし、足元の前に据えた迫撃砲（底板・二脚・砲身・弾薬箱）を置く。砲身はコアのほうへ向く
 *   頭の上に「迫撃砲」の札（壁越しにも見える。距離つき）
 * - 撃つ：砲身が沈む・砲口の火と煙・こもった発射音。砲弾は煙の尾を引いて高く飛ぶ
 * - 落ちる所：着弾の少し前から地面に赤い輪（縮んでいく）。落ちる直前に風切り音
 * - 倒されると、据えた迫撃砲はしばらく残ってから沈んで消える
 */
import * as THREE from 'three';
import { tdConfig, tdNum } from '../../config';
import type { Vec3 } from '../../shared/math';
import { TICK_DT } from '../../shared/simulation';
import type { MortarShell, TdEvent, TdMatch } from '../../shared/td/towerDefense';
import { makeRing, ringMaterial } from './dropViews';
import type { Particles } from './particles';
import { V, instantiate, part } from './viewUtil';

export type MortarSound = 'mortarDeploy' | 'mortarLaunch' | 'mortarWhistle';

export interface MortarFx {
  explode(pos: Vec3, radius: number): void;
  shake(pos: Vec3, strength: number): void;
  blast(pos: Vec3, radius: number, strength: number): void;
  smoke: Particles;
  glow: Particles;
  sound(kind: MortarSound, pos: Vec3): void;
}

const SMOKE = new THREE.Color('#8a8680');
const SMOKE_DARK = new THREE.Color('#4a4642');
const FIRE = new THREE.Color('#ffb04a').multiplyScalar(2.4);
const TRAIL = new THREE.Color('#ff9a40').multiplyScalar(2.2);
const RING = new THREE.Color('#ff4a2a').multiplyScalar(2.0);
/** 砲身の向き（モデルの +Y＝three の -Z から 60° 上） */
const TUBE_DIR = new THREE.Vector3(0, Math.sin((60 * Math.PI) / 180), -Math.cos((60 * Math.PI) / 180));
/** 背負った迫撃砲を置く所（キャラクターの骨格の作ったときの形で、足元が原点・正面が +Z。背中は -Z） */
const CARRY_POS = new THREE.Vector3(-0.2, 1.14, -0.27);
const CARRY_ROT = new THREE.Euler(-0.1, 0, 0.3);
const FADE_AFTER = 4;

/** 据えた迫撃砲 1 つ */
class Emplaced {
  readonly root = new THREE.Group();
  readonly tube: THREE.Object3D | null;
  readonly muzzle: THREE.Object3D | null;
  private readonly tubeRest = new THREE.Vector3();
  recoil = 0;
  /** 置いてからの時間（据える動き）・兵が倒れてからの時間 */
  age = 0;
  deadT = -1;
  done = false;
  readonly tag: HTMLElement;
  private tagDist = '';

  constructor(tpl: THREE.Object3D, pos: Vec3, yaw: number, tagLayer: HTMLElement, name: string) {
    const inst = instantiate(tpl);
    for (const n of ['MortarCarry', 'MortarShell']) part(inst.root, n)?.removeFromParent();
    this.root.add(inst.root);
    this.root.position.set(pos.x, pos.y, pos.z);
    this.root.rotation.y = yaw;
    this.tube = part(inst.root, 'MortarTube');
    this.muzzle = part(inst.root, 'Muzzle');
    if (this.tube) this.tubeRest.copy(this.tube.position);
    this.tag = document.createElement('div');
    this.tag.className = 'td-mortar-tag hidden';
    this.tag.innerHTML = `<i></i><b>迫撃砲</b><small>${name}</small><em></em>`;
    tagLayer.appendChild(this.tag);
  }

  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    if (this.muzzle) return this.muzzle.getWorldPosition(out);
    return out.copy(this.root.position).add(new THREE.Vector3(0, 1.1, 0));
  }

  update(dt: number) {
    this.age += dt;
    // 据える：少し上から下ろして、ドスンと止まる
    const k = Math.min(1, this.age / 0.35);
    const drop = (1 - k) * (1 - k) * 0.35;
    this.recoil = Math.max(0, this.recoil - dt * 3.2);
    // 撃った：砲身が軸に沿って沈み、全体が少し跳ねる
    const r = this.recoil;
    const kick = r > 0.8 ? (1 - r) / 0.2 : r / 0.8;
    if (this.tube) this.tube.position.copy(this.tubeRest).addScaledVector(TUBE_DIR, -0.16 * kick);
    const s = this.deadT < FADE_AFTER ? 1 : Math.max(0.001, 1 - (this.deadT - FADE_AFTER) / 0.6);
    this.root.children[0].position.y = drop - (1 - s) * 0.5 + kick * 0.02;
    this.root.children[0].scale.setScalar(s);
    if (this.deadT >= 0) {
      this.deadT += dt;
      if (this.deadT > FADE_AFTER + 0.6) this.done = true;
    }
  }

  setTag(show: boolean, x = 0, y = 0, dist = 0, firing = false) {
    this.tag.classList.toggle('hidden', !show);
    if (!show) return;
    this.tag.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    this.tag.classList.toggle('firing', firing);
    const d = `${Math.round(dist)}m`;
    if (d !== this.tagDist) {
      this.tagDist = d;
      this.tag.querySelector('em')!.textContent = d;
    }
  }

  dispose() {
    this.tag.remove();
    this.root.removeFromParent();
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose();
    });
  }
}

/** 飛んでいる砲弾 1 つと、落ちる所の輪 */
class ShellView {
  readonly mesh: THREE.Object3D;
  readonly ring: THREE.Mesh;
  readonly ringMat: THREE.ShaderMaterial;
  whistled = false;
  private trailT = 0;

  constructor(
    tpl: THREE.Object3D,
    readonly s: MortarShell,
    group: THREE.Group,
    radius: number,
  ) {
    this.mesh = tpl.clone(true);
    this.mesh.position.set(s.pos.x, s.pos.y, s.pos.z);
    group.add(this.mesh);
    this.ringMat = ringMaterial(RING);
    this.ring = makeRing(this.ringMat, radius);
    this.ring.position.set(s.target.x, s.target.y + 0.06, s.target.z);
    group.add(this.ring);
  }

  update(dt: number, now: number, alpha: number, time: number, fx: MortarFx) {
    const s = this.s;
    // シミュレーションの位置から、描く瞬間の位置へ（1 ティックの間をつなぐ）
    const back = (1 - alpha) * TICK_DT;
    const p = this.mesh.position.set(s.pos.x - s.vel.x * back, s.pos.y - s.vel.y * back - 0.5 * s.gravity * back * back, s.pos.z - s.vel.z * back);
    const v = new THREE.Vector3(s.vel.x, s.vel.y, s.vel.z);
    if (v.lengthSq() > 0.01) this.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), v.normalize());
    // 煙の尾と、尾の火
    this.trailT -= dt;
    if (this.trailT <= 0) {
      this.trailT = 0.025;
      fx.smoke.spawn({ pos: p.clone(), vel: new THREE.Vector3((Math.random() - 0.5) * 0.3, 0.2, (Math.random() - 0.5) * 0.3), life: 0.9 + Math.random() * 0.5, size0: 0.35, size1: 1.3, color: SMOKE, alpha: 0.35, drag: 1.5 });
      fx.glow.spawn({ pos: p.clone(), life: 0.12, size0: 0.5, size1: 0.1, color: TRAIL, alpha: 0.9 });
    }
    // 落ちる所の輪：撃ってから少しして出て、着弾が近いほど縮む
    const age = now - s.born + alpha * TICK_DT;
    const left = s.flight - age;
    const k = Math.max(0, Math.min(1, age / Math.max(0.1, s.flight)));
    this.ringMat.uniforms.uProgress.value = Math.pow(k, 1.5);
    this.ringMat.uniforms.uTime.value = time;
    this.ringMat.uniforms.uAlpha.value = Math.min(1, age / 0.8) * (left < 0 ? 0 : 1);
    return left;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.ring.removeFromParent();
    this.ring.geometry.dispose();
    this.ringMat.dispose();
  }
}

export class MortarViews {
  readonly group = new THREE.Group();
  private readonly emplaced = new Map<number, Emplaced>();
  private readonly shells = new Map<number, ShellView>();
  /** 背負った迫撃砲（迫撃砲兵の番号 → 胸の骨に付けた部品） */
  private readonly carried = new Map<number, THREE.Object3D>();
  private readonly baseTpl: THREE.Object3D;
  private readonly carryTpl: THREE.Object3D;
  private readonly shellTpl: THREE.Object3D;
  /** 参加者の人の形（キャラクターの root）。ゲーム側（controller）が渡す */
  actorRoot: (id: number) => THREE.Object3D | null = () => null;
  private time = 0;
  private readonly tmp = new THREE.Vector3();
  private readonly radius = tdNum(tdConfig.ENEMIES.mortar, 'SHELL_RADIUS', 4.5);

  constructor(
    tpl: THREE.Object3D,
    private readonly match: TdMatch,
    private readonly fx: MortarFx,
    private readonly tagLayer: HTMLElement,
  ) {
    this.group.name = 'MortarViews';
    const take = (name: string) => {
      const o = part(tpl, name)?.clone(true) ?? new THREE.Group();
      o.position.set(0, 0, 0);
      const g = new THREE.Group();
      g.add(o);
      return g;
    };
    this.baseTpl = tpl;
    this.carryTpl = take('MortarCarry');
    const shell = take('MortarShell');
    // 砲弾：頭が three の -Z を向くように（モデルは +Y が頭 → glTF で -Z）。遠くからも見えるように少し大きく
    shell.scale.setScalar(1.6);
    shell.traverse((o) => ((o as THREE.Mesh).castShadow = false));
    this.shellTpl = shell;
  }

  /** 背負った迫撃砲を、キャラクターの胸の骨に付ける（骨の向きは、骨格の作ったときの形から求める） */
  private attachCarry(id: number): THREE.Object3D | null {
    const root = this.actorRoot(id);
    if (!root) return null;
    let mesh: THREE.SkinnedMesh | null = null;
    root.traverse((o) => {
      if (!mesh && (o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh;
    });
    const sk = (mesh as THREE.SkinnedMesh | null)?.skeleton;
    if (!sk) return null;
    // （人の形は部品ごとの骨にまとめてある：胸は mesh_chest）
    let idx = sk.bones.findIndex((b) => b.name === 'mesh_chest');
    if (idx < 0) idx = sk.bones.findIndex((b) => b.name === 'chest');
    if (idx < 0) return null;
    const carry = this.carryTpl.clone(true);
    // 骨の位置での置き方 = (作ったときの骨の行列)⁻¹ × (足元から見た置き方)
    const want = new THREE.Matrix4().compose(CARRY_POS, new THREE.Quaternion().setFromEuler(CARRY_ROT), new THREE.Vector3(1, 1, 1));
    const local = sk.boneInverses[idx].clone().multiply(want);
    local.decompose(carry.position, carry.quaternion, carry.scale);
    sk.bones[idx].add(carry);
    return carry;
  }

  onEvents(events: TdEvent[]): void {
    for (const ev of events) {
      if (ev.type === 'mortarDeploy') {
        this.fx.sound('mortarDeploy', ev.pos);
        for (let i = 0; i < 8; i++)
          this.fx.smoke.spawn({ pos: V(ev.pos).add(new THREE.Vector3((Math.random() - 0.5) * 1.2, 0.1, (Math.random() - 0.5) * 1.2)), vel: new THREE.Vector3((Math.random() - 0.5) * 1.5, 0.4, (Math.random() - 0.5) * 1.5), life: 0.8, size0: 0.3, size1: 1.2, color: SMOKE, alpha: 0.3, drag: 3 });
      } else if (ev.type === 'mortarFire') {
        const v = this.emplaced.get(ev.id);
        const from = v ? v.muzzleWorld(this.tmp.clone()) : V(ev.from);
        if (v) v.recoil = 1;
        this.fx.sound('mortarLaunch', ev.from);
        // 砲口の火と、まわりに広がる煙
        const up = V(ev.target).sub(from).setY(0).normalize().multiplyScalar(0.5).add(new THREE.Vector3(0, 1, 0)).normalize();
        this.fx.glow.spawn({ pos: from.clone(), life: 0.12, size0: 1.8, size1: 0.4, color: FIRE, alpha: 1 });
        for (let i = 0; i < 4; i++) this.fx.glow.spawn({ pos: from.clone(), vel: up.clone().multiplyScalar(4 + Math.random() * 4), life: 0.15, size0: 0.6, size1: 0.1, color: FIRE, alpha: 0.9, drag: 4 });
        for (let i = 0; i < 10; i++)
          this.fx.smoke.spawn({ pos: from.clone(), vel: up.clone().multiplyScalar(1 + Math.random() * 2).add(new THREE.Vector3((Math.random() - 0.5) * 2.4, 0, (Math.random() - 0.5) * 2.4)), life: 1.4 + Math.random() * 0.8, size0: 0.5, size1: 2.4, color: i < 3 ? SMOKE_DARK : SMOKE, alpha: 0.45, drag: 2.2, gravity: -0.25 });
      } else if (ev.type === 'mortarExplode') {
        const s = this.shells.get(ev.shellId);
        s?.dispose();
        this.shells.delete(ev.shellId);
        this.fx.blast(ev.pos, ev.radius, 1);
        this.fx.explode(ev.pos, ev.radius);
        this.fx.shake(ev.pos, 1.1);
        for (let i = 0; i < 10; i++)
          this.fx.smoke.spawn({ pos: V(ev.pos), vel: new THREE.Vector3((Math.random() - 0.5) * 6, 3 + Math.random() * 4, (Math.random() - 0.5) * 6), life: 1.6 + Math.random(), size0: 0.8, size1: 3.2, color: SMOKE_DARK, alpha: 0.5, drag: 1.6, gravity: 0.6 });
      }
    }
  }

  update(dt: number, alpha: number, camera: THREE.PerspectiveCamera, width: number, height: number): void {
    this.time += dt;
    const m = this.match;
    const sim = m.sim;
    const camPos = camera.getWorldPosition(new THREE.Vector3());
    // --- 迫撃砲兵：背負う・据える ---
    const seen = new Set<number>();
    for (const r of m.enemies.values()) {
      if (r.type !== 'mortar') continue;
      const e = sim.entities.get(r.id);
      if (!e) continue;
      seen.add(r.id);
      const deployed = !!r.mortar;
      // 背中の迫撃砲：運んでいる間だけ（倒されたら少しして消す）
      const wantCarry = !deployed && !e.dead;
      let c = this.carried.get(r.id);
      if (wantCarry && !c) {
        const a = this.attachCarry(r.id);
        if (a) this.carried.set(r.id, (c = a));
      } else if (!wantCarry && c) {
        c.removeFromParent();
        this.carried.delete(r.id);
      }
      // 据えた迫撃砲：兵の前（コアの向き）
      if (deployed && !this.emplaced.has(r.id) && !e.dead) {
        const p = e.movement.pos;
        const to = V(m.td.core).sub(V(p)).setY(0).normalize();
        const at = { x: p.x + to.x * 0.85, y: p.y, z: p.z + to.z * 0.85 };
        const sp = r.spot !== undefined && r.spot >= 0 ? m.td.mortarSpots[r.spot].name : '';
        const v = new Emplaced(this.baseTpl, at, Math.atan2(-to.x, -to.z), this.tagLayer, sp);
        this.emplaced.set(r.id, v);
        this.group.add(v.root);
      }
      const v = this.emplaced.get(r.id);
      if (v && e.dead && v.deadT < 0) v.deadT = 0;
    }
    // 取り除かれた迫撃砲兵
    for (const [id, c] of this.carried)
      if (!seen.has(id)) {
        c.removeFromParent();
        this.carried.delete(id);
      }
    for (const [id, v] of this.emplaced) {
      if (!seen.has(id) && v.deadT < 0) v.deadT = 0;
      v.update(dt);
      if (v.done) {
        v.dispose();
        this.emplaced.delete(id);
        continue;
      }
      // 札：生きている間（壁越しにも見える。遠いほど小さく）
      const r = m.enemies.get(id);
      const e = sim.entities.get(id);
      let show = v.deadT < 0 && !!e && !e.dead && m.phase === 'wave';
      if (show) {
        const p = this.tmp.copy(v.root.position).add(new THREE.Vector3(0, 2.6, 0));
        const d = p.distanceTo(camPos);
        p.project(camera);
        show = p.z < 1 && Math.abs(p.x) < 1.02 && Math.abs(p.y) < 1.02;
        if (show) v.setTag(true, ((p.x + 1) / 2) * width, ((1 - p.y) / 2) * height, d, !!r?.mortar && r.mortar.setup <= 0 && !r.brain?.busy);
      }
      if (!show) v.setTag(false);
    }
    // --- 砲弾 ---
    for (const s of m.shells.values()) {
      if (this.shells.has(s.id)) continue;
      this.shells.set(s.id, new ShellView(this.shellTpl, s, this.group, this.radius));
    }
    for (const [id, sv] of this.shells) {
      if (!m.shells.has(id)) {
        sv.dispose();
        this.shells.delete(id);
        continue;
      }
      const left = sv.update(dt, sim.time, alpha, this.time, this.fx);
      // 落ちてくる風切り音（着弾の 1.4 秒前。落ちる所で鳴らす）
      if (!sv.whistled && left < 1.4) {
        sv.whistled = true;
        this.fx.sound('mortarWhistle', sv.s.target);
      }
    }
  }

  /** シェーダーの準備用：据えた迫撃砲・背負った迫撃砲・砲弾・落ちる所の輪を 1 つずつ */
  warmObjects(): THREE.Object3D[] {
    const g = new THREE.Group();
    g.position.set(0, -500, 0);
    g.add(instantiate(this.baseTpl).root, this.carryTpl.clone(true), this.shellTpl.clone(true), makeRing(ringMaterial(RING), 3));
    return [g];
  }

  dispose(): void {
    for (const v of this.emplaced.values()) v.dispose();
    for (const s of this.shells.values()) s.dispose();
    for (const c of this.carried.values()) c.removeFromParent();
    this.emplaced.clear();
    this.shells.clear();
    this.carried.clear();
    this.group.removeFromParent();
  }
}
