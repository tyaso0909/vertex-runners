/**
 * 歩兵のボット。地上だけを歩き（ダッシュ・ジャンプ・壁走りはしない）、近くの敵を撃つ。命中精度は低い。
 * 分隊ごとに中央付近の目標地点へ向かい、着いたら少し留まって次の地点へ。
 */
import type { MovementConfig, WeaponsConfig } from '../../config';
import type { NavLink } from '../nav';
import { type Vec3, add, len, sub, v3 } from '../math';
import type { Entity } from '../simulation';
import { type BotIntent, aimAngles, emptyIntent } from './botCommon';
import { type AimSkill, BotBrain } from './botBrain';
import type { BotWorld } from './botWorld';
import { slotDef } from '../weaponCustom';

const yawOf = (d: Vec3) => Math.atan2(-d.x, -d.z);

export class GruntBot extends BotBrain {
  /** 分隊の目標地点（attrition.ts が決める） */
  objective: Vec3 | null = null;
  /** 分隊の中での位置のずれ */
  offset: Vec3;
  private lingerTimer = 0;
  private crouchTimer = 0;
  private crouching = false;
  private goalSet: Vec3 | null = null;

  constructor(entityId: number, bw: BotWorld, cfg: MovementConfig, wcfg: WeaponsConfig, skill: AimSkill, seed: number, slot: number) {
    super(entityId, bw, cfg, wcfg, skill, seed);
    // 歩兵は敵のティックに気づかない（近づいてきても撃たない・逃げない）
    this.tickSightRange = 0;
    const a = (slot / 4) * Math.PI * 2 + this.rng.range(-0.4, 0.4);
    this.offset = v3(Math.cos(a) * 2.5, 0, Math.sin(a) * 2.5);
    // 地上（低い所）の歩けるつながりだけを使う
    const nodes = bw.nav.nodes;
    this.nav.allow = (l: NavLink) => l.kind === 'walk' && nodes[l.a].pos.y < 1.2 && nodes[l.b].pos.y < 1.2;
  }

  /** 目標地点に着いて、少し留まった */
  get idleAtObjective(): boolean {
    return !this.nav.hasGoal && this.lingerTimer <= 0 && this.goalSet !== null;
  }

  protected decide(e: Entity, dt: number): BotIntent {
    const it = emptyIntent(this.aimYaw, this.aimPitch);
    if (this.sense(e, dt)) this.chooseTarget(e);
    const o = this.targetEntity();
    const c = o ? this.contacts.get(o.id) : undefined;
    const visible = !!(o && c && c.visible);
    const pos = e.movement.pos;

    // 目標地点へ
    if (this.objective && (!this.goalSet || len(sub(this.goalSet, this.objective)) > 0.5)) {
      this.goalSet = { ...this.objective };
      const g = add(this.objective, this.offset);
      this.nav.goTo(g, pos);
      this.lingerTimer = this.rng.range(3, 8);
    }
    const nav = this.nav.update(e, dt);
    let move: Vec3 | null = nav.dir;
    if (this.nav.hasGoal && (this.nav.arrived(e, 1.4) || this.nav.failed)) this.nav.stop();
    if (!this.nav.hasGoal) {
      move = null;
      this.lingerTimer -= dt;
    }

    // 撃ち合い：近ければ立ち止まって撃つ（ときどきしゃがむ）。遠ければ歩きながら
    let fire = false;
    if (o && c && (visible || this.time - c.lastSeen < 0.5)) {
      const d = len(sub(o.movement.pos, pos));
      const want = aimAngles(this.eye(e), visible ? this.aimPoint(o) : add(c.pos, v3(0, 1.3, 0)));
      this.updateAim(e, dt, want, visible ? o : null);
      if (visible && d < 28) move = null;
      fire = visible && this.canFire(e, o, c);
      fire = this.trigger(e, dt, fire);
      this.crouchTimer -= dt;
      if (this.crouchTimer <= 0) {
        this.crouchTimer = this.rng.range(1.5, 4);
        this.crouching = !move && this.rng.next() < 0.4;
      }
      if (d < 2) it.melee = true;
    } else {
      this.trigger(e, dt, false);
      this.crouching = false;
      const mv = move as Vec3 | null;
      this.updateAim(e, dt, mv ? { yaw: yawOf(mv), pitch: -0.05 } : null, null);
      const slot = e.arsenal.slots[e.arsenal.active];
      if (!e.arsenal.reloading && slot.ammo < slotDef(this.wcfg, slot).MAG_SIZE * 0.4) it.reload = true;
    }

    it.move = move;
    it.yaw = this.aimYaw;
    it.pitch = this.aimPitch;
    it.fire = fire;
    it.crouch = this.crouching && !move;
    return it;
  }
}
