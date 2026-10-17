/**
 * ブーストの見た目（消耗戦）。
 * - ティック：投げると転がって飛び、着地すると 6 本の脚で這う（脚は這った距離で動かす）。赤い目は、狙う相手がいると速く点滅する
 * - ホロパイロットが消えるとき：青白い光の粒がはじける（ActorViews がちらついて消す）
 * - フェイズリワインド：出た所と着いた所に、紫の光の粒
 * ホロパイロットの体そのものは ActorViews（味方には半分透けた立体映像に見える）、ハードカバーは ShieldViews が描く
 */
import * as THREE from 'three';
import type { BoostEvent, BoostSystem, TickBot } from '../../shared/boosts';
import type { ShotEffects } from '../weapons/effects';

const HOLO_SPARK = new THREE.Color('#7fe3ff');
const REWIND_SPARK = new THREE.Color('#b48aff');
const TICK_SPARK = new THREE.Color('#ff5a3a');

interface TickView {
  root: THREE.Object3D;
  legs: THREE.Object3D[];
  legRest: THREE.Euler[];
  eye: THREE.MeshStandardMaterial | null;
  prev: THREE.Vector3;
  cur: THREE.Vector3;
  yaw: number;
  spin: number;
  seen: boolean;
}

export class BoostViews {
  readonly group = new THREE.Group();
  private readonly ticks = new Map<number, TickView>();
  private time = 0;

  constructor(
    private readonly tickTpl: THREE.Object3D,
    private readonly boosts: BoostSystem,
    private readonly effects: ShotEffects,
    private readonly fx: { explode(pos: THREE.Vector3, radius: number): void; shake(pos: THREE.Vector3, k: number): void },
  ) {
    this.group.name = 'BoostViews';
  }

  /** シェーダーの準備用 */
  warmObjects(): THREE.Object3D[] {
    const v = this.make({ id: -1, ownerId: -1, team: 0, pos: { x: 0, y: -500, z: 0 }, vel: { x: 0, y: 0, z: 0 }, state: 'fly', targetId: -1, life: 1, yaw: 0, stride: 0 });
    return [v.root];
  }

  private make(t: TickBot): TickView {
    const root = this.tickTpl.clone(true);
    let eye: THREE.MeshStandardMaterial | null = null;
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      const copy = (x: THREE.Material) => {
        const c = (x as THREE.MeshStandardMaterial).clone();
        if (c.name === 'TkRed') eye = c;
        return c;
      };
      m.material = Array.isArray(m.material) ? m.material.map(copy) : copy(m.material);
    });
    const legs: THREE.Object3D[] = [];
    for (let k = 0; k < 6; k++) {
      const l = root.getObjectByName(`TickLeg${k}`);
      if (l) legs.push(l);
    }
    const p = new THREE.Vector3(t.pos.x, t.pos.y, t.pos.z);
    root.position.copy(p);
    return { root, legs, legRest: legs.map((l) => l.rotation.clone()), eye, prev: p.clone(), cur: p.clone(), yaw: t.yaw, spin: 0, seen: true };
  }

  /** ティックごと：ティックの位置を記録する */
  afterTick(): void {
    for (const v of this.ticks.values()) v.seen = false;
    for (const t of this.boosts.ticks) {
      let v = this.ticks.get(t.id);
      if (!v) {
        v = this.make(t);
        this.ticks.set(t.id, v);
        this.group.add(v.root);
      }
      v.seen = true;
      v.prev.copy(v.cur);
      v.cur.set(t.pos.x, t.pos.y, t.pos.z);
    }
    for (const [id, v] of this.ticks) {
      if (v.seen) continue;
      v.root.removeFromParent();
      this.ticks.delete(id);
    }
  }

  onEvents(events: BoostEvent[]): void {
    for (const ev of events) {
      if (ev.type === 'tickExplode') {
        const p = new THREE.Vector3(ev.pos.x, ev.pos.y, ev.pos.z);
        this.fx.explode(p, ev.radius * 0.7);
        this.fx.shake(p, 0.5);
        this.effects.impact(p, new THREE.Vector3(0, 1, 0), TICK_SPARK, 1.2);
      } else if (ev.type === 'holoGone') {
        const p = new THREE.Vector3(ev.pos.x, ev.pos.y + 1.0, ev.pos.z);
        this.effects.impact(p, new THREE.Vector3(0, 1, 0), HOLO_SPARK, ev.shot ? 1.3 : 0.9);
        this.effects.impact(p.add(new THREE.Vector3(0, 0.5, 0)), new THREE.Vector3(0, 1, 0), new THREE.Color('#ffffff'), 0.6);
      } else if (ev.type === 'rewindStart' || ev.type === 'rewindEnd') {
        const q = ev.type === 'rewindStart' ? ev.from : ev.pos;
        this.effects.impact(new THREE.Vector3(q.x, q.y + 1.0, q.z), new THREE.Vector3(0, 1, 0), REWIND_SPARK, 1.1);
      }
    }
  }

  update(dt: number, alpha: number): void {
    this.time += dt;
    const ticks = new Map(this.boosts.ticks.map((t) => [t.id, t]));
    for (const [id, v] of this.ticks) {
      const t = ticks.get(id);
      if (!t) continue;
      v.root.position.lerpVectors(v.prev, v.cur, alpha);
      // 向き：這う向きへ回す。飛んでいる間は転がる
      let d = t.yaw - v.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      v.yaw += d * Math.min(1, dt * 12);
      if (t.state === 'fly') v.spin += dt * 9;
      else v.spin *= Math.exp(-dt * 12);
      v.root.rotation.set(v.spin, v.yaw, 0, 'YXZ');
      // 脚：這った距離で、左右の 3 本ずつを交互に振る
      const ph = t.stride * 9;
      for (let k = 0; k < v.legs.length; k++) {
        const leg = v.legs[k];
        const rest = v.legRest[k];
        const group = (k + (k >= 3 ? 1 : 0)) % 2;
        const sw = t.state === 'crawl' ? Math.sin(ph + group * Math.PI) : 0;
        const fold = t.state === 'fly' ? 0.6 : 0;
        leg.rotation.set(rest.x + Math.max(0, sw) * 0.25, rest.y + sw * 0.35, rest.z + (k < 3 ? fold : -fold));
      }
      // 目：狙う相手がいると速く点滅
      if (v.eye) v.eye.emissiveIntensity = t.targetId >= 0 ? (Math.sin(this.time * 30) > 0 ? 9 : 2) : 4 + Math.sin(this.time * 6) * 2;
    }
  }

  dispose(): void {
    for (const v of this.ticks.values()) v.root.removeFromParent();
    this.ticks.clear();
    this.group.removeFromParent();
  }
}
