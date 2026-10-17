/**
 * 物理で動かさない敵（ドローン・大型兵器）の動き。毎ティック位置を決め、撃つための入力コマンドを作る
 * （撃つ処理はプレイヤーと同じ武器の仕組みを使う）。
 *
 * - ドローン：要塞の外から、壁より高い所を飛んで来て、コアのまわりの上が開けた所まで降り、コアを撃つ（仕様 5.3.3）
 * - 大型兵器：侵入ルートの道すじを歩いてコアへ向かい、タレット（いなければコア）をロケットで撃つ。近くのプレイヤーは機銃で撃つ
 */
import { type InputCommand, emptyCommand } from '../input';
import { type Vec3, DEG, add, clamp, len, lenH, scale, sub, v3 } from '../math';
import { type Entity, type Simulation, TICK_DT, isStructure } from '../simulation';
import { chestOf } from '../hitbox';
import type { TdRouteDef } from '../level';
import { Rng } from '../bots/botWorld';

const yawOf = (d: Vec3) => Math.atan2(-d.x, -d.z);
const angDiff = (a: number, b: number) => {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
};
const aimAt = (from: Vec3, to: Vec3) => {
  const d = sub(to, from);
  return { yaw: Math.atan2(-d.x, -d.z), pitch: Math.atan2(d.y, lenH(d)) };
};

function lineOfSight(sim: Simulation, from: Vec3, to: Vec3): boolean {
  const d = sub(to, from);
  const L = len(d);
  if (L < 0.3) return true;
  return !sim.world.raycast(from, scale(d, 1 / L), L - 0.4);
}

// ---------------------------------------------------------------------------
// ドローン
// ---------------------------------------------------------------------------

export class DroneCtl {
  /** 'transit'：壁を越えて飛ぶ、'descend'：降りる、'hover'：浮かんで撃つ */
  phase: 'transit' | 'descend' | 'hover' = 'transit';
  private leg = 0;
  private readonly legs: Vec3[];
  private hoverIndex: number;
  private vel = v3();
  private readonly rng: Rng;
  private orbit = 0;
  private burst = 0;
  private pause = 0;
  private blocked = 0;
  private aimYaw = 0;
  private aimPitch = 0;

  constructor(
    readonly entityId: number,
    readonly route: TdRouteDef,
    readonly core: Vec3,
    readonly coreId: number,
    private readonly hover: Vec3[],
    private readonly speed: number,
    private readonly fireRange: number,
    seed: number,
  ) {
    this.rng = new Rng(seed);
    const A = route.droneAltitude + this.rng.range(-1.5, 1.5);
    // 入り口の上（高い所）→ 浮かぶ場所の上
    this.hoverIndex = this.pickHover(route.gate);
    const hp = hover[this.hoverIndex];
    this.legs = [v3(route.gate.x, A, route.gate.z), v3(hp.x, A, hp.z)];
    this.orbit = this.rng.range(0, Math.PI * 2);
  }

  /** 入ってくる側に近い、浮かぶ場所を選ぶ（少しばらす） */
  private pickHover(from: Vec3): number {
    let best = 0,
      bs = Infinity;
    this.hover.forEach((h, i) => {
      const s = lenH(sub(h, from)) + this.rng.range(0, 14);
      if (s < bs) {
        bs = s;
        best = i;
      }
    });
    return best;
  }

  step(e: Entity, sim: Simulation, others: Entity[]): InputCommand {
    const dt = TICK_DT;
    const m = e.movement;
    const pos = m.pos;
    const hp = this.hover[this.hoverIndex];
    let target: Vec3;
    if (this.phase === 'transit') {
      target = this.legs[this.leg];
      if (lenH(sub(target, pos)) < 3) {
        this.leg++;
        if (this.leg >= this.legs.length) this.phase = 'descend';
      }
      target = this.legs[Math.min(this.leg, this.legs.length - 1)];
    } else {
      this.orbit += dt * 0.5;
      target = v3(hp.x + Math.cos(this.orbit) * 1.6, hp.y + Math.sin(this.orbit * 1.7) * 0.4, hp.z + Math.sin(this.orbit) * 1.6);
      if (this.phase === 'descend' && Math.abs(pos.y - hp.y) < 1) this.phase = 'hover';
    }
    // 目標へ向かう速さ（近づくと遅く）
    const to = sub(target, pos);
    const d = len(to);
    const maxSpeed = this.speed * e.slowMul * sim.shockMul(e);
    const want = d > 1e-3 ? scale(to, Math.min(maxSpeed, d * 1.2) / d) : v3();
    // ほかのドローンとぶつからないように離れる
    for (const o of others) {
      if (o === e || o.kind !== 'drone' || o.dead) continue;
      const dd = sub(pos, o.movement.pos);
      const L = len(dd);
      if (L < 3 && L > 1e-3) {
        const k = (3 - L) * 1.5;
        want.x += (dd.x / L) * k;
        want.y += (dd.y / L) * k * 0.5;
        want.z += (dd.z / L) * k;
      }
    }
    const acc = 10 * dt;
    this.vel = v3(this.vel.x + clamp(want.x - this.vel.x, -acc, acc), this.vel.y + clamp(want.y - this.vel.y, -acc, acc), this.vel.z + clamp(want.z - this.vel.z, -acc, acc));
    // 前に何かあれば上へよける
    const sp = len(this.vel);
    if (sp > 0.5) {
      const ahead = sim.world.raycast(pos, scale(this.vel, 1 / sp), Math.max(2.5, sp * 0.6));
      if (ahead && this.phase === 'transit') this.vel.y = Math.max(this.vel.y, 4);
    }
    m.pos = add(pos, scale(this.vel, dt));
    m.vel = { ...this.vel };

    // --- 撃つ：浮かんでいる・近いときにコアを ---
    const cmd = emptyCommand(sim.tick + 1);
    const core = sim.entities.get(this.coreId);
    const eye = sim.eyeOf(e);
    let fire = false;
    if (core && !core.dead) {
      const aim = add(chestOf(sim.actorOf(core)), v3(this.rng.range(-1.2, 1.2), this.rng.range(-1.5, 1.5), this.rng.range(-1.2, 1.2)));
      const dist = len(sub(aim, eye));
      if (dist < this.fireRange && this.phase !== 'transit') {
        const a = aimAt(eye, aim);
        this.aimYaw += angDiff(a.yaw, this.aimYaw) * Math.min(1, dt * 6);
        this.aimPitch += (a.pitch - this.aimPitch) * Math.min(1, dt * 6);
        const los = lineOfSight(sim, eye, chestOf(sim.actorOf(core)));
        if (!los) {
          this.blocked += dt;
          // 見えない場所なら、別の場所へ移る
          if (this.blocked > 2.5) {
            this.blocked = 0;
            this.hoverIndex = (this.hoverIndex + 1 + Math.floor(this.rng.next() * (this.hover.length - 1))) % this.hover.length;
            this.phase = 'descend';
          }
        } else {
          this.blocked = 0;
          if (this.pause > 0) this.pause -= dt;
          else {
            if (this.burst <= 0) this.burst = this.rng.range(0.8, 1.4);
            this.burst -= dt;
            fire = true;
            if (this.burst <= 0) this.pause = this.rng.range(0.7, 1.2);
          }
        }
      } else {
        this.aimYaw += angDiff(yawOf(this.vel.x || this.vel.z ? this.vel : v3(0, 0, -1)), this.aimYaw) * Math.min(1, dt * 3);
        this.aimPitch *= 0.95;
      }
    }
    cmd.yaw = this.aimYaw;
    cmd.pitch = this.aimPitch;
    cmd.fireHeld = fire;
    cmd.firePressed = fire;
    e.facing = this.aimYaw;
    return cmd;
  }
}

// ---------------------------------------------------------------------------
// 大型兵器（ボス）
// ---------------------------------------------------------------------------

export interface BossFire {
  /** 発射筒の位置 */
  from: Vec3;
  /** 狙う点 */
  to: Vec3;
  targetId: number;
}

export class BossCtl {
  private wp = 0;
  /** 体の向き（歩く向き） */
  facing: number;
  private aimYaw: number;
  private aimPitch = 0;
  private rocketTimer: number;
  private mgTarget = -1;
  private mgTimer = 0;
  private burst = 0;
  private pause = 0;
  private readonly rng: Rng;
  /** 歩いた距離（足音・足の動きの位相） */
  stride = 0;
  /** 止まって撃っている */
  halted = false;
  /** このティックで、ロケットを撃つ（towerDefense.ts が弾を作る） */
  volley: BossFire[] = [];
  /** 足が地面に着いた（描画で揺らす） */
  stepped = false;
  private jitter = v3();
  private jitterTimer = 0;

  constructor(
    readonly entityId: number,
    readonly route: TdRouteDef,
    readonly core: Vec3,
    readonly coreId: number,
    private readonly cfg: {
      SPEED: number;
      STOP_DIST: number;
      ROCKET_INTERVAL: number;
      ROCKET_COUNT: number;
      ROCKET_RANGE: number;
      MG_RANGE: number;
    },
    yaw: number,
    seed: number,
  ) {
    this.facing = yaw;
    this.aimYaw = yaw;
    this.rng = new Rng(seed);
    this.rocketTimer = cfg.ROCKET_INTERVAL;
  }

  step(e: Entity, sim: Simulation): InputCommand {
    const dt = TICK_DT;
    const m = e.movement;
    const pos = m.pos;
    this.volley = [];
    this.stepped = false;
    // --- 歩く ---
    const toCore = lenH(sub(this.core, pos));
    this.halted = toCore <= this.cfg.STOP_DIST;
    const path = this.route.path;
    while (this.wp < path.length && lenH(sub(path[this.wp], pos)) < 3) this.wp++;
    const goal = this.wp < path.length ? path[this.wp] : this.core;
    let speed = 0;
    if (!this.halted) {
      const d = sub(goal, pos);
      const want = yawOf(d);
      const turn = angDiff(want, this.facing);
      this.facing += clamp(turn, -30 * DEG * dt, 30 * DEG * dt);
      if (Math.abs(turn) < 25 * DEG) speed = this.cfg.SPEED * e.slowMul * sim.shockMul(e);
    } else {
      // コアの方へ向く
      const want = yawOf(sub(this.core, pos));
      this.facing += clamp(angDiff(want, this.facing), -20 * DEG * dt, 20 * DEG * dt);
    }
    const fwd = v3(-Math.sin(this.facing), 0, -Math.cos(this.facing));
    const prevStride = this.stride;
    this.stride += speed * dt;
    // 歩幅 2.6m ごとに足が着く
    if (Math.floor(this.stride / 2.6) !== Math.floor(prevStride / 2.6)) this.stepped = true;
    // 高さは道すじの点の高さをなぞる（要塞のルートは平ら）
    const y = this.wp < path.length ? path[this.wp].y : this.core.y;
    m.pos = v3(pos.x + fwd.x * speed * dt, pos.y + (y - pos.y) * Math.min(1, dt * 2), pos.z + fwd.z * speed * dt);
    m.vel = v3(fwd.x * speed, 0, fwd.z * speed);
    e.facing = this.facing;

    // --- ロケット：タレット → コア ---
    this.rocketTimer -= dt;
    const pods = [-2.6, 2.6].map((x) => add(m.pos, rotY(v3(x, 6.4, -0.8), this.facing)));
    if (this.rocketTimer <= 0) {
      const target = this.pickRocketTarget(e, sim, pods[0]);
      if (target) {
        this.rocketTimer = this.cfg.ROCKET_INTERVAL * this.rng.range(0.85, 1.15);
        const tp = chestOf(sim.actorOf(target));
        for (let i = 0; i < this.cfg.ROCKET_COUNT; i++) {
          const from = pods[i % 2];
          const spread = target.kind === 'core' ? 1.6 : 2.2;
          this.volley.push({ from, to: add(tp, v3(this.rng.range(-spread, spread), this.rng.range(-0.6, 0.6), this.rng.range(-spread, spread))), targetId: target.id });
        }
      } else this.rocketTimer = 0.5;
    }

    // --- 機銃：近くのプレイヤー・タレット ---
    const cmd = emptyCommand(sim.tick + 1);
    const eye = sim.eyeOf(e);
    this.mgTimer -= dt;
    if (this.mgTimer <= 0) {
      this.mgTimer = 0.3;
      this.mgTarget = -1;
      let bs = Infinity;
      for (const o of sim.entities.values()) {
        if (o.team === e.team || o.dead || o.downed > 0 || o.kind === 'core') continue;
        const c = chestOf(sim.actorOf(o));
        const d = len(sub(c, eye));
        if (d > this.cfg.MG_RANGE || d >= bs) continue;
        if (!lineOfSight(sim, eye, c)) continue;
        bs = d;
        this.mgTarget = o.id;
      }
    }
    const t = this.mgTarget >= 0 ? sim.entities.get(this.mgTarget) : undefined;
    let fire = false;
    if (t && !t.dead) {
      // 狙いはおおまか（大きな機銃を振り回すので、遠いほどずれる）
      const tp = chestOf(sim.actorOf(t));
      this.jitterTimer -= dt;
      if (this.jitterTimer <= 0) {
        this.jitterTimer = 0.25;
        const k = 0.9 + len(sub(tp, eye)) * 0.07;
        this.jitter = v3(this.rng.range(-k, k), this.rng.range(-k * 0.6, k * 0.6), this.rng.range(-k, k));
      }
      const a = aimAt(eye, add(tp, this.jitter));
      this.aimYaw += clamp(angDiff(a.yaw, this.aimYaw), -90 * DEG * dt, 90 * DEG * dt);
      this.aimPitch += clamp(a.pitch - this.aimPitch, -90 * DEG * dt, 90 * DEG * dt);
      if (Math.abs(angDiff(a.yaw, this.aimYaw)) < 6 * DEG) {
        if (this.pause > 0) this.pause -= dt;
        else {
          if (this.burst <= 0) this.burst = this.rng.range(0.6, 1.1);
          this.burst -= dt;
          fire = true;
          if (this.burst <= 0) this.pause = this.rng.range(0.8, 1.4);
        }
      }
    } else {
      this.aimYaw += clamp(angDiff(this.facing, this.aimYaw), -60 * DEG * dt, 60 * DEG * dt);
      this.aimPitch *= 0.95;
    }
    cmd.yaw = this.aimYaw;
    cmd.pitch = this.aimPitch;
    cmd.fireHeld = fire;
    cmd.firePressed = fire;
    return cmd;
  }

  /** ロケットの目標：射程の中のタレット（近い順）、なければコア */
  private pickRocketTarget(e: Entity, sim: Simulation, from: Vec3): Entity | null {
    let best: Entity | null = null,
      bs = Infinity;
    for (const o of sim.entities.values()) {
      if (o.team === e.team || o.dead || o.kind !== 'turret') continue;
      const d = len(sub(o.movement.pos, e.movement.pos));
      if (d > this.cfg.ROCKET_RANGE || d >= bs) continue;
      if (!lineOfSight(sim, from, chestOf(sim.actorOf(o)))) continue;
      bs = d;
      best = o;
    }
    if (best) return best;
    const core = sim.entities.get(this.coreId);
    if (core && !core.dead && len(sub(core.movement.pos, e.movement.pos)) < this.cfg.ROCKET_RANGE) return core;
    // コアが遠ければ、近くのプレイヤー
    for (const o of sim.entities.values()) {
      if (o.team === e.team || o.dead || o.downed > 0 || isStructure(o)) continue;
      const d = len(sub(o.movement.pos, e.movement.pos));
      if (d < this.cfg.ROCKET_RANGE * 0.6 && d < bs && lineOfSight(sim, from, chestOf(sim.actorOf(o)))) {
        bs = d;
        best = o;
      }
    }
    return best;
  }
}

/** 向き yaw で回す（-Z が正面） */
export function rotY(p: Vec3, yaw: number): Vec3 {
  const c = Math.cos(yaw),
    s = Math.sin(yaw);
  return v3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
}
