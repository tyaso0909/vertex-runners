/**
 * ボットの頭の共通部分：見る（敵を見つける・覚える）、狙う（照準のずれと振り向きの速さ）、撃つ（指切り射撃）。
 * パイロット（pilotBot.ts）と歩兵（gruntBot.ts）が使う。
 * 結果はプレイヤーと同じ入力コマンド（InputCommand）になる。
 */
import type { MovementConfig, WeaponsConfig } from '../../config';
import { isCloaked, isPhased } from '../abilities';
import { chestOf, headCenter } from '../hitbox';
import type { InputCommand } from '../input';
import { type Vec3, DEG, clamp, len, lookDir, sub, v3 } from '../math';
import type { Entity, SimEvent } from '../simulation';
import { activeSlot } from '../weapons';
import { slotDef } from '../weaponCustom';
import { type BotIntent, CommandWriter, aimAngles, angleDiff, emptyIntent } from './botCommon';
import { type BotWorld, Rng } from './botWorld';
import { Navigator } from './navigator';

/** 狙いの細かさ・反応の速さ（難易度ごと、歩兵用） */
export interface AimSkill {
  REACTION: number;
  AIM_ERROR: number;
  AIM_ERROR_MIN: number;
  AIM_SETTLE: number;
  TURN_SPEED: number;
  BURST: number;
  PAUSE: number;
  VIEW_RANGE: number;
  FOV: number;
  /** 相手が 10m/s で動いているときに、照準のずれが何倍ぶん増えるか（0 なら増えない） */
  AIM_SPEED_PENALTY?: number;
  /** 相手が 50m 先にいるときに、照準のずれが何倍ぶん増えるか（25m より先で増え始める） */
  AIM_RANGE_PENALTY?: number;
}

/** 覚えている敵 */
export interface Contact {
  id: number;
  pos: Vec3;
  /** 最後に見た時刻（見ていなければ -Infinity） */
  lastSeen: number;
  /** 最後に位置がわかった時刻（見た・聞いた・ソナー・撃たれた） */
  lastKnown: number;
  /** 見え始めた時刻（反応の遅れに使う） */
  firstSeen: number;
  visible: boolean;
  pilot: boolean;
  /** 自分を撃ってきた時刻 */
  hurtMe: number;
}

/** 見失ったと考えるまでの時間 */
const FORGET = 12;

export abstract class BotBrain {
  readonly nav: Navigator;
  protected readonly writer = new CommandWriter();
  protected readonly rng: Rng;
  readonly contacts = new Map<number, Contact>();
  target = -1;
  protected aimYaw = 0;
  protected aimPitch = 0;
  private errYaw = 0;
  private errPitch = 0;
  private errGoalYaw = 0;
  private errGoalPitch = 0;
  private errTimer = 0;
  /** 今の相手を狙い続けている時間（照準が落ち着く） */
  protected track = 0;
  private lastTargetAngle: { yaw: number; pitch: number } | null = null;
  private targetAngSpeed = 0;
  private burstLeft = 0;
  private pauseLeft = 0;
  private semiToggle = false;
  private senseTimer: number;
  protected aimHead = false;
  /** 最後にダメージを受けた時刻 */
  protected lastHurt = -99;

  constructor(
    readonly entityId: number,
    protected readonly bw: BotWorld,
    protected readonly cfg: MovementConfig,
    protected readonly wcfg: WeaponsConfig,
    readonly skill: AimSkill,
    seed: number,
  ) {
    this.rng = new Rng(seed);
    this.nav = new Navigator(entityId, bw, cfg);
    // 見る処理を、ボットごとにずらして行う
    this.senseTimer = this.rng.range(0, 0.1);
  }

  protected get time(): number {
    return this.bw.sim.time;
  }

  protected eye(e: Entity): Vec3 {
    return this.bw.sim.eyeOf(e);
  }

  /** シミュレーションの出来事を受け取る（撃たれた方向を知るなど） */
  onEvent(e: Entity, ev: SimEvent): void {
    if (ev.type === 'playerDamaged' && ev.entityId === e.id) {
      this.lastHurt = this.time;
      if (ev.attackerId !== undefined) {
        const a = this.bw.sim.entities.get(ev.attackerId);
        if (a && a.team !== e.team && !a.dead) {
          const c = this.contactOf(a);
          c.pos = { ...a.movement.pos };
          c.lastKnown = this.time;
          c.hurtMe = this.time;
        }
      }
    }
    if (ev.type === 'playerRespawn' && ev.entityId === e.id) this.onRespawn(e);
  }

  protected onRespawn(e: Entity): void {
    this.target = -1;
    this.contacts.clear();
    this.nav.stop();
    this.aimYaw = e.movement.spawnYaw;
    this.aimPitch = 0;
    this.track = 0;
  }

  protected contactOf(o: Entity): Contact {
    let c = this.contacts.get(o.id);
    if (!c) {
      c = { id: o.id, pos: { ...o.movement.pos }, lastSeen: -Infinity, lastKnown: -Infinity, firstSeen: this.time, visible: false, pilot: o.kind === 'pilot' || o.kind === 'decoy' || o.kind === 'holo', hurtMe: -99 };
      this.contacts.set(o.id, c);
    }
    return c;
  }

  /** 敵を見る（0.1 秒ごと）。見えた敵はチームに知らせる */
  protected sense(e: Entity, dt: number): boolean {
    this.senseTimer -= dt;
    if (this.senseTimer > 0) return false;
    this.senseTimer += 0.1;
    const sim = this.bw.sim;
    const eye = this.eye(e);
    const look = lookDir(this.aimYaw, this.aimPitch);
    const cosFov = Math.cos((this.skill.FOV / 2) * DEG);
    for (const o of sim.entities.values()) {
      if (o.team === e.team || o.dead || o.downed > 0) {
        const c = this.contacts.get(o.id);
        if (c && (o.dead || o.downed > 0)) this.contacts.delete(o.id);
        continue;
      }
      const c0 = this.contacts.get(o.id);
      if (isPhased(o.ability)) {
        if (c0) c0.visible = false;
        continue;
      }
      const oa = sim.actorOf(o);
      const chest = chestOf(oa);
      const to = sub(chest, eye);
      const d = len(to);
      const cloaked = isCloaked(o.ability);
      const range = cloaked ? 8 : this.skill.VIEW_RANGE;
      let visible = false;
      if (d < range) {
        const inFov = d < 5 || (to.x * look.x + to.y * look.y + to.z * look.z) / d > cosFov || (c0 && this.time - c0.hurtMe < 1.5);
        if (inFov) {
          const head = headCenter(oa);
          visible = this.lineOfSight(eye, chest) || this.lineOfSight(eye, head);
        }
      }
      // 聞こえる：近くで撃った
      // サプレッサーを付けた武器は、聞こえる距離が 1/3
      const hearRange = slotDef(this.wcfg, activeSlot(o.arsenal)).SUPPRESSED ? 9 : 28;
      const heard = !visible && d < hearRange && o.arsenal.sinceShot < 0.12;
      // ソナーで見えている（味方のソラが使った）
      const revealed = o.revealed > 0 && o.revealDelay <= 0;
      if (!visible && !heard && !revealed && !c0) continue;
      const c = this.contactOf(o);
      if (visible) {
        if (!c.visible && this.time - c.lastSeen > 1.2) c.firstSeen = this.time;
        c.visible = true;
        c.lastSeen = this.time;
        c.lastKnown = this.time;
        c.pos = { ...o.movement.pos };
        this.bw.report(e.team, o);
      } else {
        c.visible = false;
        if (heard || revealed) {
          c.lastKnown = this.time;
          c.pos = { ...o.movement.pos };
          if (revealed) this.bw.report(e.team, o);
        }
      }
    }
    for (const [id, c] of this.contacts) if (this.time - c.lastKnown > FORGET || !sim.entities.has(id)) this.contacts.delete(id);
    return true;
  }

  protected lineOfSight(from: Vec3, to: Vec3): boolean {
    const d = sub(to, from);
    const L = len(d);
    if (L < 0.3) return true;
    if (this.bw.sim.world.raycast(from, v3(d.x / L, d.y / L, d.z / L), L - 0.2)) return false;
    // スモークグレネードの煙の向こうは見えない
    return !this.bw.sim.smokeBlocks(from, to);
  }

  /** 狙う相手を選ぶ（見えている中で近い・自分を撃ってくる・パイロットを優先） */
  protected chooseTarget(e: Entity): void {
    let best = -1,
      bs = Infinity;
    for (const c of this.contacts.values()) {
      if (!c.visible && this.time - c.lastSeen > 0.6) continue;
      const o = this.bw.sim.entities.get(c.id);
      if (!o || o.dead) continue;
      const d = len(sub(o.movement.pos, e.movement.pos));
      let s = d;
      if (c.pilot) s -= 8;
      if (this.time - c.hurtMe < 2) s -= 10;
      if (c.id === this.target) s -= 6;
      if (!c.visible) s += 10;
      if (s < bs) {
        bs = s;
        best = c.id;
      }
    }
    if (best !== this.target) {
      this.target = best;
      this.track = 0;
      this.lastTargetAngle = null;
      this.aimHead = this.rng.next() < this.headChance();
    }
  }

  /** 狙う相手を変える（照準の落ち着きをやり直す） */
  protected setTarget(id: number): void {
    if (id === this.target) return;
    this.target = id;
    this.track = 0;
    this.lastTargetAngle = null;
    this.aimHead = id >= 0 && this.rng.next() < this.headChance();
  }

  protected headChance(): number {
    return 0;
  }

  /** 狙っている相手 */
  protected targetEntity(): Entity | null {
    if (this.target < 0) return null;
    const o = this.bw.sim.entities.get(this.target);
    return o && !o.dead && o.downed <= 0 && !isPhased(o.ability) ? o : null;
  }

  /** 相手の狙う点（胸、ときどき頭） */
  protected aimPoint(o: Entity): Vec3 {
    const a = this.bw.sim.actorOf(o);
    // 盾を持つ相手（重装兵）：盾がこちらを向いていれば、盾の上からのぞく頭を狙う
    if (a.body && a.body.critAim && a.body.parts.some((p) => p.block)) {
      const me = this.bw.sim.entities.get(this.entityId);
      if (me) {
        const yaw = a.yaw ?? 0;
        const dx = me.movement.pos.x - a.pos.x,
          dz = me.movement.pos.z - a.pos.z;
        const L = Math.hypot(dx, dz) || 1;
        const facing = (-Math.sin(yaw) * dx - Math.cos(yaw) * dz) / L;
        if (facing > 0.25) return headCenter(a);
      }
    }
    return this.aimHead ? headCenter(a) : chestOf(a);
  }

  /** 照準のずれの大きさ（度） */
  protected errorDeg(e: Entity, o: Entity): number {
    const s = this.skill;
    const k = clamp(this.track / Math.max(0.05, s.AIM_SETTLE), 0, 1);
    let err = s.AIM_ERROR + (s.AIM_ERROR_MIN - s.AIM_ERROR) * k;
    // 速く横切る相手・自分が空中や壁走り中は狙いにくい
    err *= 1 + Math.min(1.5, this.targetAngSpeed / 60);
    // 速く動く相手ほど先を読みにくい（距離によらない。止まっている相手が撃たれやすく、走り続ける相手は当たりにくい）
    const v = o.movement.vel;
    const speed = Math.hypot(v.x, v.y * 0.5, v.z);
    err *= 1 + (s.AIM_SPEED_PENALTY ?? 0) * Math.min(1.6, speed / 10);
    // 遠い相手は狙いにくい
    const d = Math.hypot(o.movement.pos.x - e.movement.pos.x, o.movement.pos.z - e.movement.pos.z);
    if (d > 25) err *= 1 + (s.AIM_RANGE_PENALTY ?? 0) * Math.min(2, (d - 25) / 25);
    if (e.movement.state === 'air' || e.movement.state === 'wallrun') err *= 1.35;
    if (isCloaked(o.ability)) err *= 2.5;
    return err;
  }

  /** 視線を相手（または向きたい方向）へ動かす */
  protected updateAim(e: Entity, dt: number, want: { yaw: number; pitch: number } | null, o: Entity | null): void {
    if (o && want) {
      // 相手の見かけの動きの速さ（度/秒）
      if (this.lastTargetAngle && dt > 0) {
        const w = Math.hypot(angleDiff(want.yaw, this.lastTargetAngle.yaw), want.pitch - this.lastTargetAngle.pitch) / DEG / dt;
        this.targetAngSpeed += (w - this.targetAngSpeed) * Math.min(1, dt * 6);
      }
      this.lastTargetAngle = { ...want };
      this.track += dt;
      // ずれはゆっくり動く（狙いが揺れる）
      this.errTimer -= dt;
      // アークグレネードの電撃を受けている間は、狙いが大きく乱れる
      const err = this.errorDeg(e, o) * DEG * (e.shock > 0 ? 2.6 : 1);
      if (this.errTimer <= 0) {
        this.errTimer = this.rng.range(0.18, 0.4);
        this.errGoalYaw = this.rng.gauss() * err;
        this.errGoalPitch = this.rng.gauss() * err * 0.6;
      }
      const k = Math.min(1, dt * 5);
      this.errYaw += (this.errGoalYaw - this.errYaw) * k;
      this.errPitch += (this.errGoalPitch - this.errPitch) * k;
      want = { yaw: want.yaw + this.errYaw, pitch: want.pitch + this.errPitch };
    } else {
      this.targetAngSpeed = 0;
      this.lastTargetAngle = null;
    }
    if (!want) return;
    const max = this.skill.TURN_SPEED * DEG * dt * (e.shock > 0 ? 0.45 : 1);
    const dy = angleDiff(want.yaw, this.aimYaw);
    const dp = want.pitch - this.aimPitch;
    // 近いほどゆっくり合わせる（急に止まらない）
    const sy = clamp(dy * Math.min(1, dt * 14), -max, max);
    const sp = clamp(dp * Math.min(1, dt * 14), -max, max);
    this.aimYaw += sy;
    this.aimPitch = clamp(this.aimPitch + sp, -1.4, 1.4);
  }

  /** 撃ってよいか（反応の時間が過ぎ、照準が相手の近くにある） */
  protected canFire(e: Entity, o: Entity, c: Contact | undefined): boolean {
    if (!c || !c.visible) return false;
    if (this.time - c.firstSeen < this.skill.REACTION) return false;
    const want = aimAngles(this.eye(e), this.aimPoint(o));
    const off = Math.hypot(angleDiff(want.yaw, this.aimYaw), want.pitch - this.aimPitch) / DEG;
    const d = len(sub(o.movement.pos, e.movement.pos));
    // 相手の大きさ（見かけの角度）＋照準のずれの分まで
    const tol = Math.atan2(0.9, d) / DEG + this.errorDeg(e, o) * 1.6 + 1.5;
    return off < tol;
  }

  /** 指切り射撃（連射の武器は撃つ・休むをくり返す。単発の武器は押しては離す） */
  protected trigger(e: Entity, dt: number, want: boolean, burstMul = 1): boolean {
    if (!want) {
      this.burstLeft = 0;
      this.pauseLeft = Math.max(0, this.pauseLeft - dt);
      return false;
    }
    const w = slotDef(this.wcfg, activeSlot(e.arsenal));
    if (!w.AUTO) {
      this.semiToggle = !this.semiToggle;
      return this.semiToggle;
    }
    if (this.pauseLeft > 0) {
      this.pauseLeft -= dt;
      if (this.pauseLeft <= 0) this.burstLeft = this.skill.BURST * burstMul * this.rng.range(0.7, 1.3);
      return false;
    }
    if (this.burstLeft <= 0) this.burstLeft = this.skill.BURST * burstMul * this.rng.range(0.7, 1.3);
    this.burstLeft -= dt;
    if (this.burstLeft <= 0) this.pauseLeft = this.skill.PAUSE * this.rng.range(0.7, 1.3);
    return true;
  }

  /** 1ティック分の入力を作る */
  think(e: Entity, dt: number): InputCommand {
    const it = e.dead ? emptyIntent(this.aimYaw, this.aimPitch) : this.decide(e, dt);
    return this.writer.build(this.bw.sim.tick + 1, it);
  }

  /** 何もしない入力（試合開始前など）。視線はそのまま */
  idle(): InputCommand {
    return this.writer.build(this.bw.sim.tick + 1, emptyIntent(this.aimYaw, this.aimPitch));
  }

  protected abstract decide(e: Entity, dt: number): BotIntent;

  /** 外から視線を合わせる（出現したときなど） */
  setAim(yaw: number, pitch: number): void {
    this.aimYaw = yaw;
    this.aimPitch = pitch;
  }

  dispose(): void {
    this.nav.stop();
  }
}
