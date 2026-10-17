/**
 * ロケット弾（ロケットタレット・大型兵器）。まっすぐ飛び（少しだけ目標へ曲がる）、地形・相手に当たるか、
 * 目標の点に着くと爆発して、範囲の中の相手チームにダメージを与える（壁の陰は守られる）。
 */
import { type Vec3, add, len, normalize, scale, sub, v3 } from '../math';
import { rayVsActor } from '../hitbox';
import { type Entity, type Simulation, TICK_DT } from '../simulation';

export interface Rocket {
  id: number;
  pos: Vec3;
  vel: Vec3;
  /** 撃った側のチーム（このチームには当たらない） */
  team: number;
  /** 撃った参加者（タレット・大型兵器）。倒したときの記録に使う */
  ownerId: number;
  damage: number;
  minDamage: number;
  radius: number;
  /** 目標の点（ここに着いたら爆発） */
  target: Vec3 | null;
  /** 目標へ曲がる強さ（1秒あたりの角度。0 でまっすぐ） */
  homing: number;
  life: number;
  /** 空中の相手（ドローン）にも当たる */
  hitsAir: boolean;
}

export interface RocketBlast {
  rocketId: number;
  pos: Vec3;
  radius: number;
  hits: Array<{ id: number; damage: number }>;
}

/** 爆風のダメージ（中心から半径の 35% までは最大、外へ向かって minDamage まで下がる） */
export function rocketDamageAt(r: Pick<Rocket, 'damage' | 'minDamage' | 'radius'>, d: number): number {
  if (d > r.radius) return 0;
  const inner = r.radius * 0.35;
  if (d <= inner) return r.damage;
  return r.damage + (r.minDamage - r.damage) * ((d - inner) / (r.radius - inner));
}

export class Rockets {
  readonly list: Rocket[] = [];
  private nextId = 1;
  /** このティックで発射・爆発したもの（描画・音用） */
  launched: Rocket[] = [];
  blasts: RocketBlast[] = [];

  launch(r: Omit<Rocket, 'id'>): Rocket {
    const rocket = { ...r, id: this.nextId++ };
    this.list.push(rocket);
    this.launched.push(rocket);
    return rocket;
  }

  /** ティックの始めに、前のティックの発射・爆発の記録を消す */
  beginTick(): void {
    this.launched = [];
    this.blasts = [];
  }

  step(sim: Simulation): void {
    const dt = TICK_DT;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const r = this.list[i];
      r.life -= dt;
      // 目標へ少し曲がる
      if (r.target && r.homing > 0) {
        const speed = len(r.vel);
        const want = normalize(sub(r.target, r.pos));
        const cur = scale(r.vel, 1 / speed);
        const k = Math.min(1, (r.homing * Math.PI) / 180 * dt);
        r.vel = scale(normalize(add(scale(cur, 1 - k), scale(want, k))), speed);
      }
      const step = scale(r.vel, dt);
      const L = len(step);
      const dir = scale(step, 1 / L);
      let hitT = L;
      let boom = false;
      const wh = sim.world.raycast(r.pos, dir, L);
      if (wh) {
        hitT = wh.t;
        boom = true;
      }
      for (const e of sim.entities.values()) {
        if (e.team === r.team || e.dead || e.downed > 0) continue;
        if (!r.hitsAir && e.kind === 'drone') continue;
        const ah = rayVsActor(r.pos, dir, hitT + 0.6, sim.actorOf(e));
        if (ah && ah.t < hitT + 0.6) {
          hitT = Math.min(hitT, ah.t);
          boom = true;
        }
      }
      const next = add(r.pos, scale(dir, hitT));
      if (!boom && r.target && len(sub(r.target, next)) < Math.max(1, L)) boom = true;
      r.pos = next;
      if (boom || r.life <= 0) {
        this.list.splice(i, 1);
        this.explode(sim, r);
      }
    }
  }

  private explode(sim: Simulation, r: Rocket) {
    const hits: Array<{ id: number; damage: number }> = [];
    const center = add(r.pos, v3(0, 0.15, 0));
    for (const e of [...sim.entities.values()]) {
      if (e.team === r.team || e.dead || e.downed > 0) continue;
      if (!r.hitsAir && e.kind === 'drone') continue;
      const aim = closestPointOf(e, center);
      const d = len(sub(aim, center));
      const dmg = rocketDamageAt(r, d);
      if (dmg <= 0) continue;
      // 壁の陰なら守られる
      if (d > 0.5) {
        const dir = normalize(sub(aim, center));
        const block = sim.world.raycast(center, dir, Math.max(0, d - 0.4));
        if (block) continue;
      }
      if (sim.damageEntity(e, dmg, center, 'grenade', r.ownerId)) hits.push({ id: e.id, damage: dmg });
    }
    this.blasts.push({ rocketId: r.id, pos: center, radius: r.radius, hits });
  }

  clear(): void {
    this.list.length = 0;
  }
}

/** 爆心にいちばん近い体の点（大きい相手は胴の高さで、半径の分だけ近くする） */
function closestPointOf(e: Entity, from: Vec3): Vec3 {
  const p = e.movement.pos;
  if (e.body) {
    const c = add(p, v3(0, e.body.centerY, 0));
    const d = sub(from, c);
    const L = len(d);
    // 体の大きさの半分ほど、爆心に寄せる
    const reach = Math.min(L, e.body.radius * 0.55);
    return L > 1e-6 ? add(c, scale(d, reach / L)) : c;
  }
  const y = Math.min(Math.max(from.y, p.y + 0.3), p.y + e.movement.height - 0.2);
  return v3(p.x, y, p.z);
}
