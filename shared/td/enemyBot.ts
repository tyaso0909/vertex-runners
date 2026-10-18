/**
 * タワーディフェンスの地上の敵（歩兵・爆弾兵・重装兵）の頭。
 * プレイヤーと同じ入力コマンドで動く（shared/bots の BotBrain をもとにする）。
 *
 * - 侵入ルートの道すじ（TdRouteDef.path）を順にたどり、最後はコアへ向かう（地上の歩けるつながりだけを使う）
 * - 歩兵：近くのプレイヤー・タレットを撃つ。いなければコアを撃つ（仕様 5.3.3）
 * - 爆弾兵：足が速く、コアだけを目指す（撃たない。コアに近づくと自爆する。自爆は towerDefense.ts が行う）
 * - 重装兵：遅いが硬い。タレットを優先して撃つ。正面の盾を、撃つ相手に向ける
 * - 迫撃砲兵：降りたら、決められた少し高い所（屋上・砲撃陣地・防壁の上・テラス）へ上り、そこに据えてコアへ迫撃砲を撃ち続ける
 *   （撃つのは towerDefense.ts。頭は、上る・据える・近づいたパイロットを拳銃で撃つ）。上る途中は撃たれても立ち止まらない
 * - 設置物：ダミーバルーンはパイロットと思って撃つ（爆弾兵は近くのバルーンへ走って自爆する）。
 *   バリケードに道をふさがれたら、足を止めて壊すまで撃つ（爆弾兵はぶつかって自爆する）
 */
import type { MovementConfig, WeaponsConfig } from '../../config';
import type { TdRouteDef } from '../level';
import { type NavGraph, type NavLink, nearestNode } from '../nav';
import { type Vec3, add, len, lenH, sub, v3 } from '../math';
import { type Entity, isStructure } from '../simulation';
import { type BotIntent, aimAngles, emptyIntent } from '../bots/botCommon';
import { type AimSkill, BotBrain, type Contact } from '../bots/botBrain';
import type { BotWorld } from '../bots/botWorld';
import { slotDef } from '../weaponCustom';
import { segDist2D, segParam2D } from './devices';

export type GroundEnemyType = 'grunt' | 'assault' | 'heavy' | 'mortar';

/**
 * 迫撃砲兵の通れるつながり：高さを問わず歩く・飛び降りる（ステージに書いてある特別な飛び降りは除く）に加えて、
 * 低い段（1.6m まで・近い所）へのジャンプ（前哨陣地の屋上へ上る、階段の最後の段など）
 */
export function mortarAllow(nav: NavGraph): (l: NavLink) => boolean {
  const nodes = nav.nodes;
  return (l: NavLink) => {
    if (l.kind === 'walk') return true;
    if (l.from) return false;
    if (l.kind === 'drop') return true;
    if (l.kind !== 'jump') return false;
    const a = nodes[l.a].pos,
      b = nodes[l.b].pos;
    return b.y - a.y < 1.6 && Math.hypot(b.x - a.x, b.z - a.z) < 3.6;
  };
}

/** 迫撃砲兵の数値（towerDefense.ts が渡す） */
export interface MortarOpts {
  /** 据える所（なければ、ルートを進んでコアから MAX_RANGE の 0.75 倍まで来たら据える） */
  spot: Vec3 | null;
  minRange: number;
  maxRange: number;
  /** 据えたあと、この距離まで来たパイロットには砲撃をやめて拳銃で応戦する */
  panicRange: number;
  /** 降りてからこの秒数たっても着かなければ、射程の中ならその場に据える */
  giveUp: number;
}

/** 敵から見た、プレイヤーの設置物（towerDefense.ts が用意する） */
export interface TdEnemyApi {
  /** ダミーバルーン（参加者の番号と位置） */
  lures(): Array<{ id: number; pos: Vec3 }>;
  /** バリケード（参加者の番号と両端） */
  barricades(): Array<{ id: number; a: Vec3; b: Vec3 }>;
}

const yawOf = (d: Vec3) => Math.atan2(-d.x, -d.z);

export class TdEnemyBot extends BotBrain {
  /** いま向かっている道すじの点（path の番号。path.length ならコアへ） */
  waypoint = 0;
  /** 最後のコアの近くの待ち位置に着いた */
  atCore = false;
  private goal: Vec3 | null = null;
  private crouchTimer = 0;
  private crouching = false;
  private holdTimer = 0;
  private readonly coreRing: Vec3;
  /** 爆弾兵が引きつけられている囮（いなければ -1） */
  lureId = -1;
  private lureTimer = 0;
  /** 道をふさいでいるバリケード（いなければ -1） */
  blockedBy = -1;
  /** 高い所（防壁の上・屋上）に降りた敵。下りるまでは立ち止まらずに撃つ */
  private readonly high: boolean;
  /** 迫撃砲兵：据える所など（ほかの敵は null） */
  private mortar: MortarOpts | null = null;
  /** 迫撃砲兵：据えた（もう動かない） */
  deployed = false;
  /** 迫撃砲兵：近くのパイロットと撃ち合っている（砲撃を止める） */
  busy = false;
  private mortarTime = 0;

  constructor(
    entityId: number,
    bw: BotWorld,
    cfg: MovementConfig,
    wcfg: WeaponsConfig,
    skill: AimSkill,
    seed: number,
    readonly type: GroundEnemyType,
    readonly route: TdRouteDef,
    readonly core: Vec3,
    readonly coreId: number,
    /** 撃ち合いを始める距離 */
    private readonly engageRange: number,
    private readonly api: TdEnemyApi | null = null,
    /** 爆弾兵が囮に引きつけられる距離 */
    private readonly lureRange = 14,
    /** 高い所（防壁の上・屋上）に降りた：階段・飛び降りで、高い足場も通れる */
    high = false,
  ) {
    super(entityId, bw, cfg, wcfg, skill, seed);
    this.high = high;
    // 地上の歩ける・飛び降りるつながりだけ（壁走り・ジャンプ・高い足場は使わない）。
    // 高い所に降りた敵は、高さを問わず歩く・飛び降りるつながりを使う（下りてくる）
    const nodes = bw.nav.nodes;
    // （ステージに書いてある特別な飛び降りは、胸壁を乗り越えるパイロット用なので使わない）
    this.nav.allow = high
      ? (l: NavLink) => l.kind === 'walk' || (l.kind === 'drop' && !l.from)
      : (l: NavLink) => (l.kind === 'walk' || l.kind === 'drop') && nodes[l.a].pos.y < 2 && nodes[l.b].pos.y < 2;
    // コアのまわりの待ち位置（敵ごとに角度をずらす）
    const a = this.rng.range(0, Math.PI * 2);
    const r = type === 'assault' ? 0 : type === 'heavy' ? this.rng.range(11, 14) : this.rng.range(8, 13);
    this.coreRing = v3(core.x + Math.cos(a) * r, core.y, core.z + Math.sin(a) * r);
  }

  /** 迫撃砲兵にする（据える所と数値）。上る途中の段差のジャンプも使う */
  setMortar(opts: MortarOpts): void {
    this.mortar = opts;
    this.nav.allow = mortarAllow(this.bw.nav);
    this.goal = null;
  }

  /** 迫撃砲兵の据える所 */
  get mortarSpot(): Vec3 | null {
    return this.mortar?.spot ?? null;
  }

  /** いまの行き先（引っかかりの確認用） */
  get goalPoint(): Vec3 {
    return this.currentGoal();
  }

  /** 見えている相手と撃ち合っている（立ち止まっていても、引っかかりではない） */
  get engaged(): boolean {
    if (this.target < 0) return false;
    const c = this.contacts.get(this.target);
    return !!c && this.time - c.lastSeen < 1.5;
  }

  /** 経路を探し直す（引っかかったとき） */
  repath(): void {
    this.goal = null;
    this.nav.stop();
  }

  /** いまの行き先（道すじの点、またはコアのまわり） */
  private currentGoal(): Vec3 {
    if (this.mortar?.spot) return this.mortar.spot;
    if (this.waypoint < this.route.path.length) return this.route.path[this.waypoint];
    return this.coreRing;
  }

  /** 狙う相手を選ぶ（仕様 5.3.3 の「狙う対象」） */
  protected override chooseTarget(e: Entity): void {
    if (this.type === 'assault') {
      this.target = -1;
      return;
    }
    const sim = this.bw.sim;
    const pos = e.movement.pos;
    let best = -1,
      bs = Infinity;
    let bestPilot = false;
    let core: Contact | null = null;
    for (const c of this.contacts.values()) {
      if (!c.visible && this.time - c.lastSeen > 0.6) continue;
      const o = sim.entities.get(c.id);
      if (!o || o.dead || o.downed > 0) continue;
      if (o.kind === 'core') {
        core = c;
        continue;
      }
      const d = len(sub(o.movement.pos, pos));
      const turret = o.kind === 'turret';
      // 迫撃砲兵：近くのパイロット（囮）だけを拳銃で撃つ（タレット・コアは砲撃する）
      if (this.type === 'mortar' && o.kind !== 'pilot' && o.kind !== 'decoy' && !(o.kind === 'barricade' && c.id === this.blockedBy)) continue;
      // 歩兵：近くのプレイヤー・タレット。重装兵：タレットを優先（遠くても）
      const range = this.type === 'heavy' && turret ? this.engageRange : this.type === 'heavy' ? this.engageRange * 0.6 : this.engageRange;
      if (d > range) continue;
      let s = d;
      if (this.type === 'heavy' && turret) s -= 25;
      // 歩兵は、同じくらいの距離ならタレットよりパイロットを狙う
      if (this.type === 'grunt' && turret) s += 8;
      if (this.time - c.hurtMe < 2) s -= 8;
      if (c.id === this.target) s -= 4;
      if (!c.visible) s += 8;
      // ふくらんだ囮は目立つので、つい狙う
      if (o.kind === 'decoy') s -= 5;
      if (o.kind === 'barricade' && c.id !== this.blockedBy) continue;
      if (s < bs) {
        bs = s;
        best = c.id;
        bestPilot = (o.kind === 'pilot' || o.kind === 'decoy') && d < 12;
      }
    }
    // 道をふさがれている：近くのパイロット（囮）がいなければ、バリケードを壊す
    if (this.blockedBy >= 0 && !bestPilot && this.contacts.has(this.blockedBy)) best = this.blockedBy;
    // ほかに相手がいなければコア（近くまで来ていて、見えている。迫撃砲兵は砲撃するので撃たない）
    if (best < 0 && core && this.type !== 'mortar') {
      const o = sim.entities.get(core.id)!;
      if (lenH(sub(o.movement.pos, pos)) < 36) best = core.id;
    }
    if (best !== this.target) {
      this.target = best;
      this.track = 0;
      this.aimHead = this.rng.next() < 0.1;
    }
  }

  protected decide(e: Entity, dt: number): BotIntent {
    const it = emptyIntent(this.aimYaw, this.aimPitch);
    if (this.sense(e, dt)) this.chooseTarget(e);
    const pos = e.movement.pos;
    const o = this.targetEntity();
    const c = o ? this.contacts.get(o.id) : undefined;
    const visible = !!(o && c && c.visible);

    // --- 爆弾兵：近くの囮へ走る ---
    let lurePos: Vec3 | null = null;
    if (this.type === 'assault' && this.api) {
      this.lureTimer -= dt;
      const cur = this.lureId >= 0 ? this.bw.sim.entities.get(this.lureId) : undefined;
      if (this.lureId >= 0 && (!cur || cur.dead)) this.lureId = -1;
      if (this.lureId < 0 && this.lureTimer <= 0) {
        this.lureTimer = 0.3;
        let bd = this.lureRange;
        for (const l of this.api.lures()) {
          const d = len(sub(l.pos, pos));
          if (d >= bd || Math.abs(l.pos.y - pos.y) > 3) continue;
          if (!this.lineOfSight(this.eye(e), add(l.pos, v3(0, 1.1, 0)))) continue;
          bd = d;
          this.lureId = l.id;
        }
      }
      const lo = this.lureId >= 0 ? this.bw.sim.entities.get(this.lureId) : undefined;
      if (lo) lurePos = lo.movement.pos;
    }

    // --- 道すじを進む ---
    const g = this.currentGoal();
    if (!this.mortar?.spot && this.waypoint < this.route.path.length && lenH(sub(g, pos)) < 4.5) this.waypoint++;
    if (this.mortar) this.mortarTime += dt;
    const g2 = lurePos ?? this.currentGoal();
    if (!this.goal || len(sub(this.goal, g2)) > 0.5 || (this.nav.failed && this.holdTimer <= 0)) {
      this.goal = { ...g2 };
      this.nav.goTo(g2, pos);
      this.holdTimer = 1.5;
    }
    this.holdTimer -= dt;
    const nav = this.nav.update(e, dt);
    let move: Vec3 | null = nav.dir;
    // 囮のすぐ近くでは、まっすぐ囮へ
    if (lurePos && lenH(sub(lurePos, pos)) < 3.5) {
      const to = sub(lurePos, pos);
      const L = lenH(to) || 1;
      move = v3(to.x / L, 0, to.z / L);
    }
    // --- バリケード：進む先をふさがれていれば止まる ---
    this.blockedBy = -1;
    if (this.api && this.type !== 'assault') {
      const ahead = move ?? sub(g2, pos);
      for (const b of this.api.barricades()) {
        const d = segDist2D(pos, b.a, b.b);
        if (d > 2.1 || Math.abs(b.a.y - pos.y) > 1.5) continue;
        const t = segParam2D(pos, b.a, b.b);
        const cx = b.a.x + (b.b.x - b.a.x) * t - pos.x,
          cz = b.a.z + (b.b.z - b.a.z) * t - pos.z;
        if (cx * ahead.x + cz * ahead.z <= 0 && d > 0.9) continue; // 後ろ・横にある
        this.blockedBy = b.id;
        move = null;
        break;
      }
    }
    // --- 迫撃砲兵：据える所に着いたら据える（もう動かない） ---
    if (this.mortar) {
      const mo = this.mortar;
      const spot = mo.spot;
      if (!this.deployed) {
        const dc = lenH(sub(this.core, pos));
        const grounded = e.movement.state === 'ground';
        const inRange = dc > mo.minRange && dc < mo.maxRange;
        const reached = spot ? lenH(sub(spot, pos)) < 1.1 && Math.abs(spot.y - pos.y) < 0.9 : inRange && dc < mo.maxRange * 0.75;
        // 着けない（ふさがれている・ほかの迫撃砲兵がいる）：時間がたてば、射程の中ならその場に
        // （経路の点の近く＝味方が倒しに来られる所に限る。細いすき間などに落ちていれば据えない。動けないままなら、そのうち取り除かれる）
        const giveUp = this.mortarTime > mo.giveUp && inRange && nearestNode(this.bw.nav, pos, 1.8) >= 0;
        if (grounded && (reached || giveUp)) {
          this.deployed = true;
          this.atCore = true;
          this.nav.stop();
        } else if (spot && Math.abs(spot.y - pos.y) < 0.9 && lenH(sub(spot, pos)) < 2.6) {
          // 最後の数メートルは、まっすぐ据える所へ（経路の点は荒い）
          const to = sub(spot, pos);
          const L = lenH(to) || 1;
          move = v3(to.x / L, 0, to.z / L);
        }
      }
      if (this.deployed) move = null;
    }
    const atRing = !this.mortar && !lurePos && this.waypoint >= this.route.path.length && (this.nav.arrived(e, 2) || lenH(sub(this.coreRing, pos)) < 2.5);
    if (atRing) {
      this.atCore = true;
      if (this.type !== 'assault') {
        this.nav.stop();
        move = null;
      }
    }
    if (this.type === 'assault') {
      // コアへまっすぐ（道すじの最後の区間は、コアそのものを目指す）
      it.sprint = !!move;
      this.updateAim(e, dt, move ? { yaw: yawOf(move), pitch: -0.05 } : null, null);
      it.move = move;
      it.yaw = this.aimYaw;
      it.pitch = this.aimPitch;
      return it;
    }

    // --- 撃つ ---
    let fire = false;
    this.busy = false;
    if (o && c && (visible || this.time - c.lastSeen < 0.5)) {
      const d = len(sub(o.movement.pos, pos));
      const want = aimAngles(this.eye(e), visible ? this.aimPoint(o) : add(c.pos, v3(0, 1.3, 0)));
      this.updateAim(e, dt, want, visible ? o : null);
      const structure = isStructure(o);
      // 近い相手・コア・タレットには立ち止まって撃つ（重装兵は少し近づいてから）。遠い相手には歩きながら
      // 迫撃砲兵は据える所へ急ぐ（立ち止まらない）。据えたあと、近くまで来たパイロットには砲撃をやめて応戦する
      const stopAt = this.type === 'mortar' ? 0 : this.type === 'heavy' ? (structure ? 16 : 12) : structure ? 20 : 15;
      if (this.mortar && this.deployed && d < this.mortar.panicRange) this.busy = true;
      // 高い所に降りた敵は、地面へ下りるまで止まらない（防壁の上・屋上に居座らない）
      const descending = this.high && pos.y > 2.5;
      if (visible && d < stopAt && !descending) move = null;
      fire = visible && this.canFire(e, o, c);
      fire = this.trigger(e, dt, fire, this.type === 'heavy' ? 1.6 : 1);
      if (this.type === 'grunt') {
        this.crouchTimer -= dt;
        if (this.crouchTimer <= 0) {
          this.crouchTimer = this.rng.range(1.5, 4);
          this.crouching = !move && this.rng.next() < 0.35;
        }
      }
      if (d < 2 && !structure) it.melee = true;
    } else {
      this.trigger(e, dt, false);
      this.crouching = false;
      const mv = move as Vec3 | null;
      // 据えた迫撃砲兵は、コアのほうを向いて砲を構える（少し上を見る）
      const mortarAim = this.deployed ? { yaw: yawOf(sub(this.core, pos)), pitch: 0.18 } : null;
      this.updateAim(e, dt, mortarAim ?? (mv ? { yaw: yawOf(mv), pitch: -0.05 } : atRing ? aimAngles(this.eye(e), add(this.core, v3(0, 3, 0))) : null), null);
      const slot = e.arsenal.slots[e.arsenal.active];
      if (!e.arsenal.reloading && slot.ammo < slotDef(this.wcfg, slot).MAG_SIZE * 0.4) it.reload = true;
    }
    it.move = move;
    // 迫撃砲兵は、段差へのジャンプも使う（経路の指示どおりに跳ぶ）
    // （つながりが段差へのジャンプのときだけ。動けなくなったときの抜け出しのジャンプで、防壁の胸壁を越えて落ちないように）
    if (this.mortar && move && nav.jump && this.nav.linkKind === 'jump') it.jump = true;
    it.yaw = this.aimYaw;
    it.pitch = this.aimPitch;
    it.fire = fire;
    it.crouch = (this.crouching && !move) || (this.deployed && !this.busy);
    return it;
  }
}
