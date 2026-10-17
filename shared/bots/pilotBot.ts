/**
 * パイロットのボット（プレイヤーと同じ性能。プレイヤーと同じ入力コマンドで動く）。
 *
 * 行動：巡回 → 敵を見つける → 交戦（横へ動きながら撃つ・2段ジャンプ・壁走り・遮蔽物に隠れてリロード）
 *       → 体力が減ると退避（敵から見えない所へ下がって回復を待つ）。見失ったら最後に見た所へ追う。
 * アビリティ：characters.json の BOT の説明どおりの場面で使う。
 * 難易度（易・普・難）で、反応の速さ・照準のずれ・振り向きの速さ・動きの激しさが変わる（config/bots.json）。
 */
import type { BoostId, BotSkill, CharacterDef, MovementConfig, WeaponId, WeaponsConfig } from '../../config';
import { abilityNum, classOf } from '../../config';
import { gStat } from '../grenades';
import { type Vec3, DEG, add, clamp, horiz, len, lenH, normalize, scale, sub, v3 } from '../math';
import type { Entity, SimEvent } from '../simulation';
import { activeSlot } from '../weapons';
import { type BotIntent, aimAngles, emptyIntent } from './botCommon';
import { BotBrain, type Contact } from './botBrain';
import type { BotWorld } from './botWorld';
import { slotDef } from '../weaponCustom';

type PilotState = 'patrol' | 'engage' | 'chase' | 'cover' | 'retreat';

/** 武器ごとの、撃ち合いで保ちたい距離 */
const PREF_RANGE: Record<WeaponId, number> = {
  ar: 18,
  burst: 24,
  smg: 10,
  psmg: 14,
  lmg: 22,
  spinlmg: 18,
  shotgun: 6,
  autosg: 5,
  sniper: 38,
  marksman: 30,
  pistol: 12,
  revolver: 14,
};

/** 距離ごとの武器の向き不向き */
function weaponScore(w: WeaponId, d: number): number {
  switch (w) {
    case 'shotgun':
      return d < 10 ? 3.2 : d < 17 ? 1.4 : -2;
    case 'autosg':
      return d < 8 ? 3.4 : d < 13 ? 1.2 : -2.2;
    case 'smg':
      return d < 14 ? 2.6 : d < 26 ? 1.5 : 0.2;
    case 'psmg':
      return d < 20 ? 2.4 : d < 34 ? 1.7 : 0.6;
    case 'ar':
      return d < 40 ? 2 : 1.5;
    case 'burst':
      return d < 12 ? 1.6 : d < 55 ? 2.2 : 1.7;
    case 'lmg':
      return d < 45 ? 2.1 : 1.7;
    case 'spinlmg':
      return d < 35 ? 2.2 : 1.4;
    case 'sniper':
      return d > 30 ? 3.2 : d > 18 ? 2 : 0.3;
    case 'marksman':
      return d > 22 ? 2.8 : d > 12 ? 2 : 0.9;
    case 'pistol':
      return d < 18 ? 1.8 : d < 32 ? 1.2 : 0.5;
    case 'revolver':
      return d < 22 ? 2 : d < 38 ? 1.3 : 0.5;
  }
}

/** 近づいて戦う武器か（詰めるときにダッシュ・スライディング・ワイヤーフックを使う） */
const closeRange = (w: WeaponId, cfg: WeaponsConfig) => {
  const c = classOf(w, cfg);
  return c === 'shotgun' || c === 'smg';
};

const yawOf = (d: Vec3) => Math.atan2(-d.x, -d.z);

export class PilotBot extends BotBrain {
  /** 調整用：判断の回数を数える（null なら数えない） */
  static dbg: Record<string, number> | null = null;
  private count(k: string) {
    if (PilotBot.dbg) PilotBot.dbg[k] = (PilotBot.dbg[k] ?? 0) + 1;
  }
  state: PilotState = 'patrol';
  protected stateTime = 0;
  private strafeSign = 1;
  private strafeTimer = 0;
  private hopTimer = 2;
  private hopPhase = 0;
  private slideTimer = 0;
  private maneuverCD = 3;
  private wallRun: { along: Vec3; into: Vec3; t: number; phase: 'approach' | 'air' | 'wall' } | null = null;
  protected lingerTimer = 0;
  private lookAroundYaw = 0;
  protected abilityCD = 2;
  private grenadeCD = 4;
  private grenade: { yaw: number; pitch: number; t: number } | null = null;
  private weaponCD = 0;
  private retreatCD = 0;
  private coverCD = 0;
  private engageGoalTime = -99;
  private holdPosition = 0;
  protected noContactTime = 0;
  /** このティックだけ、照準を正確な向きにする（アビリティの狙い） */
  private forcedAim: { yaw: number; pitch: number } | null = null;
  private wantAbility = false;
  /** 持っているブーストと、いま使えるか（消耗戦の試合が毎ティック決める） */
  boostKind: BoostId | null = null;
  boostReady = false;
  private wantBoost = false;
  private boostCD = 3;
  private melee = false;
  private reload = false;
  private switchTo = -1;
  private crouchHold = 0;

  constructor(
    entityId: number,
    bw: BotWorld,
    cfg: MovementConfig,
    wcfg: WeaponsConfig,
    readonly pskill: BotSkill,
    protected readonly cdef: CharacterDef,
    seed: number,
  ) {
    super(entityId, bw, cfg, wcfg, pskill, seed);
    this.strafeSign = this.rng.next() < 0.5 ? 1 : -1;
  }

  protected override headChance(): number {
    // 上手なボットほど頭を狙う
    return clamp((5 - this.pskill.AIM_ERROR_MIN) / 10, 0, 0.45);
  }

  protected override onRespawn(e: Entity): void {
    super.onRespawn(e);
    this.setState('patrol');
    this.wallRun = null;
    this.grenade = null;
    this.holdPosition = 0;
    this.lingerTimer = this.rng.range(0, 0.6);
  }

  override onEvent(e: Entity, ev: SimEvent): void {
    super.onEvent(e, ev);
  }

  protected setState(s: PilotState) {
    if (this.state === s) return;
    this.state = s;
    this.stateTime = 0;
    if (s !== 'engage') this.holdPosition = 0;
  }

  get debugState(): string {
    return this.state;
  }

  // ---------------------------------------------------------------------------

  protected decide(e: Entity, dt: number): BotIntent {
    const it = emptyIntent(this.aimYaw, this.aimPitch);
    this.stateTime += dt;
    for (const k of ['abilityCD', 'grenadeCD', 'weaponCD', 'retreatCD', 'coverCD', 'maneuverCD', 'boostCD'] as const) this[k] = Math.max(0, this[k] - dt);
    this.forcedAim = null;
    this.wantAbility = false;
    this.wantBoost = false;
    this.melee = false;
    this.reload = false;
    this.switchTo = -1;

    if (this.sense(e, dt)) {
      this.chooseTarget(e);
      this.think10(e);
    }

    const o = this.targetEntity();
    const c = o ? this.contacts.get(o.id) : undefined;
    const visible = !!(o && c && c.visible);

    // --- 動き ---
    let move: Vec3 | null = null;
    let sprint = false;
    let jump = false;
    let crouch = false;
    let lockYaw: number | null = null;
    let side = 0;
    const nav = this.nav.update(e, dt);
    const useNav = () => {
      move = nav.dir;
      sprint = nav.sprint;
      jump = nav.jump;
      crouch = nav.crouch;
      lockYaw = nav.lockYaw;
      side = nav.sideInput;
    };

    if (this.state === 'engage' && o && c) {
      const r = this.combatMove(e, o, c, dt, nav);
      move = r.move;
      sprint = r.sprint;
      jump = r.jump;
      crouch = r.crouch;
      lockYaw = r.lockYaw;
      side = r.side;
    } else if (this.state === 'patrol') {
      // 行き先の近くまで来たら、止まらずに次の行き先へ（ときどきだけ少し立ち止まって見回す）
      if (!this.nav.hasGoal || this.nav.failed || this.nav.arrived(e, 3.5)) {
        if (this.nav.hasGoal) this.nav.stop();
        this.lingerTimer -= dt;
        if (this.lingerTimer <= 0) {
          this.pickPatrolGoal(e);
          this.lingerTimer = this.rng.next() < 0.25 ? this.rng.range(0.5, 1.5) : 0;
        }
      } else {
        useNav();
        // 移動の途中で、壁走り・スライディングを混ぜる
        const fl = this.flourish(e, dt, nav);
        if (fl) {
          move = fl.move;
          jump = fl.jump;
          crouch = fl.crouch;
          sprint = true;
          lockYaw = fl.lockYaw;
          side = 0;
        }
      }
    } else if (this.state === 'chase') {
      useNav();
      const fl = this.flourish(e, dt, nav);
      if (fl) {
        move = fl.move;
        jump = fl.jump;
        crouch = fl.crouch;
        sprint = true;
        lockYaw = fl.lockYaw;
        side = 0;
      }
    } else {
      // 追う・隠れる・退避：経路に沿って動く
      useNav();
      if (this.state === 'cover' && this.nav.arrived(e, 1.2)) {
        move = null;
        crouch = this.stateTime % 3 < 2.2;
      }
    }

    // --- 視線 ---
    const eye = this.eye(e);
    let want: { yaw: number; pitch: number } | null = null;
    if (o && c && (visible || this.time - c.lastSeen < 0.5)) {
      want = aimAngles(eye, visible ? this.aimPoint(o) : add(c.pos, v3(0, 1.3, 0)));
      this.updateAim(e, dt, want, visible ? o : null);
    } else {
      // 敵がいそうな方を見る。いなければ進む方向・まわりを見回す
      const known = this.bestKnown(e);
      if (known && this.time - known.lastKnown < 4) want = aimAngles(eye, add(known.pos, v3(0, 1.3, 0)));
      else if (move) {
        const mv = move as Vec3;
        want = { yaw: yawOf(mv), pitch: -0.05 };
      } else {
        if (this.rng.next() < dt * 0.6) this.lookAroundYaw = this.aimYaw + this.rng.range(-1.6, 1.6);
        want = { yaw: this.lookAroundYaw || this.aimYaw, pitch: 0 };
      }
      this.updateAim(e, dt, want, null);
    }

    // --- 撃つ ---
    let fire = false;
    let ads = false;
    const w = activeSlot(e.arsenal).id;
    if (o && c && visible && !this.grenade && lockYaw === null) {
      const d = len(sub(o.movement.pos, e.movement.pos));
      // 中・遠距離ではエイムする（腰だめより弾がまとまる）
      const steady = !this.wallRun && this.hopPhase === 0 && e.movement.state !== 'wallrun';
      const cls = classOf(w, this.wcfg);
      ads = cls === 'sniper' || (steady && (((cls === 'ar' || cls === 'lmg') && d > 14) || (cls === 'smg' && d > 20) || (w === 'revolver' && d > 16)));
      const ready = cls !== 'sniper' || e.arsenal.ads > 0.85;
      fire = ready && this.canFire(e, o, c);
      // 回転式は撃ち続けないと速くならないので、長く撃つ
      fire = this.trigger(e, dt, fire, w === 'spinlmg' ? 2.6 : cls === 'lmg' ? 1.6 : 1);
      if (d < 2.1) this.melee = true;
    } else this.trigger(e, dt, false);

    // --- グレネード ---
    if (this.grenade) {
      this.grenade.t -= dt;
      it.grenade = this.grenade.t > 0;
      this.forcedAim = { yaw: this.grenade.yaw, pitch: this.grenade.pitch };
      if (this.grenade.t <= 0) this.grenade = null;
      fire = false;
    }

    if (this.crouchHold > 0) {
      this.crouchHold -= dt;
      crouch = true;
    }

    const yaw = lockYaw ?? this.forcedAim?.yaw ?? this.aimYaw;
    const pitch = lockYaw !== null ? 0 : (this.forcedAim?.pitch ?? this.aimPitch);
    if (lockYaw !== null) this.aimYaw = lockYaw;
    it.move = move;
    it.side = side;
    it.yaw = yaw;
    it.pitch = pitch;
    it.sprint = sprint && !fire && !ads;
    it.jump = jump;
    it.crouch = crouch;
    it.fire = fire;
    it.ads = ads;
    it.melee = this.melee;
    it.reload = this.reload;
    it.switchTo = this.switchTo;
    it.ability = this.wantAbility;
    it.boost = this.wantBoost;
    return it;
  }

  /** いちばん新しい、見えていない敵の情報 */
  private bestKnown(e: Entity): Contact | null {
    let best: Contact | null = null;
    for (const c of this.contacts.values()) {
      if (!best || c.lastKnown > best.lastKnown) best = c;
    }
    void e;
    return best;
  }

  // ---------------------------------------------------------------------------
  // 0.1 秒ごとの判断
  // ---------------------------------------------------------------------------

  private think10(e: Entity) {
    const o = this.targetEntity();
    const c = o ? this.contacts.get(o.id) : undefined;
    const hp = e.health / e.maxHealth;
    const sk = this.pskill;
    const recentlyHurt = this.time - this.lastHurt < 1.5;
    const pos = e.movement.pos;

    if (o && c && c.visible) this.noContactTime = 0;
    else this.noContactTime += 0.1;

    // --- 状態の切り替え ---
    if (this.state === 'retreat') {
      const close = o && c && c.visible && len(sub(o.movement.pos, pos)) < 9;
      if (hp > 0.85 || this.stateTime > 10 || close || (!this.nav.hasGoal && this.stateTime > 1)) {
        this.retreatCD = 8;
        this.setState(o && c ? 'engage' : 'patrol');
        if ((this.state as PilotState) === 'patrol') this.nav.stop();
      }
    } else if (hp < sk.RETREAT_HEALTH && this.retreatCD <= 0 && recentlyHurt) {
      this.enterRetreat(e);
    } else if (this.state === 'cover') {
      const done = this.stateTime > 4.5 || (!e.arsenal.reloading && hp > 0.6 && this.stateTime > 1.5) || (!this.nav.hasGoal && this.stateTime > 0.6);
      if (done) {
        this.coverCD = 5;
        this.setState(o && c ? 'engage' : 'patrol');
        this.nav.stop();
      }
    } else if (o && c && (c.visible || this.time - c.lastSeen < 0.8)) {
      if (this.state !== 'engage') this.enterEngage(e, o);
      const slot = activeSlot(e.arsenal);
      const d = len(sub(o.movement.pos, pos));
      const needReload = e.arsenal.reloading && slot.ammo === 0 && !slotDef(this.wcfg, slot).RELOAD_PER_SHELL;
      if (this.coverCD <= 0 && d > 7 && ((needReload && this.rng.next() < 0.6) || (hp < 0.55 && recentlyHurt && this.rng.next() < 0.3))) this.enterCover(e);
    } else if (this.state === 'engage' || this.state === 'chase') {
      // 見失った：最後に見た所へ
      const k = this.bestKnown(e);
      if (k && this.time - k.lastKnown < 6) {
        if (this.state !== 'chase') {
          this.setState('chase');
          this.nav.goTo(k.pos, pos);
          this.chaseAbility(e, k);
        } else if (this.nav.arrived(e) || this.nav.failed || !this.nav.hasGoal) {
          if (this.stateTime > 1) {
            this.setState('patrol');
            this.nav.stop();
          }
        }
      } else {
        this.setState('patrol');
        this.nav.stop();
      }
    } else if (this.state === 'patrol') {
      // 撃たれた・聞こえた方へ向かう
      const k = this.bestKnown(e);
      if (k && this.time - k.lastKnown < 1 && this.time - k.lastSeen > 1) {
        this.setState('chase');
        this.nav.goTo(k.pos, pos);
      }
    }

    // --- 武器の持ち替え・リロード ---
    const slot = activeSlot(e.arsenal);
    if (o && c && c.visible) {
      const d = len(sub(o.movement.pos, pos));
      const other = e.arsenal.slots[1 - e.arsenal.active];
      const cur = weaponScore(slot.id, d) - (slot.ammo === 0 ? 3 : 0);
      const alt = weaponScore(other.id, d) - (other.ammo === 0 ? 3 : 0);
      if (this.weaponCD <= 0 && alt > cur + 0.6 && !e.arsenal.cooking) {
        this.switchTo = 1 - e.arsenal.active;
        this.weaponCD = 2.5;
      }
    } else if (this.noContactTime > 1.5 && !e.arsenal.reloading && slot.ammo < slotDef(this.wcfg, slot).MAG_SIZE * 0.6) {
      this.reload = true;
    }

    // --- アビリティ・グレネード ---
    if (this.abilityCD <= 0 && e.ability.cooldown <= 0) this.considerAbility(e, o, c, hp);
    // サッチェルを置いてあれば、敵が近づいたら起爆する
    if (e.arsenal.grenadeKind === 'satchel' && e.arsenal.satchelsOut > 0) this.considerDetonate(e);
    else if (o && c && this.grenadeCD <= 0 && e.arsenal.grenades > 0 && !this.grenade) {
      // スモークは退くときに張る。ほかは撃ち合いの中で投げる
      if (e.arsenal.grenadeKind === 'smoke') this.considerSmoke(e, o, c, hp, recentlyHurt);
      else if (this.state !== 'retreat') this.considerGrenade(e, o, c);
    }
    if (this.boostKind && this.boostReady && this.boostCD <= 0) this.considerBoost(e, o, c, hp);
  }

  /** ブーストを使うか（ゲージが満タンのとき。種類ごとに、効く場面で使う） */
  private considerBoost(e: Entity, o: Entity | null, c: Contact | undefined, hp: number) {
    const visible = !!(o && c && c.visible);
    const d = o ? len(sub(o.movement.pos, e.movement.pos)) : Infinity;
    const hurt = this.time - this.lastHurt < 1.5;
    let use = false;
    let aim: { yaw: number; pitch: number } | null = null;
    switch (this.boostKind) {
      case 'maphack':
        // 敵を見失っている・探しているとき
        use = !visible && this.noContactTime > 2;
        break;
      case 'holopilot':
        use = (visible && d > 10 && d < 45) || (hurt && hp < 0.5);
        break;
      case 'phaserewind':
        use = hp < 0.35 && hurt;
        break;
      case 'hardcover':
        use = visible && ((hp < 0.7 && hurt) || this.state === 'cover');
        if (use && o) aim = { yaw: aimAngles(this.eye(e), o.movement.pos).yaw, pitch: 0 };
        break;
      case 'ticks':
        use = visible && d > 5 && d < 24;
        if (use && o) aim = aimAngles(this.eye(e), o.movement.pos);
        break;
      case 'diceroll':
        use = visible && d < 40;
        break;
    }
    if (!use) return;
    this.wantBoost = true;
    this.boostCD = 2;
    if (aim) this.forcedAim = aim;
  }

  private enterEngage(e: Entity, o: Entity) {
    this.setState('engage');
    this.engageGoalTime = -99;
    this.nav.stop();
    this.holdPosition = 0;
    // 撃ち合いの始まりに使うアビリティ（シールド・オーバードライブ）
    const t = this.cdef.ABILITY.TYPE;
    if (e.ability.cooldown <= 0 && this.rng.next() < this.pskill.ABILITY_CHANCE) {
      const d = len(sub(o.movement.pos, e.movement.pos));
      if (t === 'overdrive') this.useAbility();
      if (t === 'shield' && d > 8 && d < 50) {
        const a = aimAngles(this.eye(e), add(o.movement.pos, v3(0, 1.2, 0)));
        this.useAbility({ yaw: a.yaw, pitch: 0 });
        this.holdPosition = 5;
      }
    }
  }

  private enterCover(e: Entity) {
    const threats = this.threatEyes(e);
    const p = this.bw.findCover(e.movement.pos, threats, 2, 14, false);
    if (!p) {
      this.coverCD = 3;
      return;
    }
    this.setState('cover');
    this.nav.goTo(p, e.movement.pos);
    if (this.cdef.ABILITY.TYPE === 'shield' && e.ability.cooldown <= 0 && this.rng.next() < this.pskill.ABILITY_CHANCE * 0.5) this.useAbility();
  }

  private enterRetreat(e: Entity) {
    const threats = this.threatEyes(e);
    const p = this.bw.findCover(e.movement.pos, threats, 8, 30, true) ?? this.bw.findCover(e.movement.pos, threats, 3, 16, true);
    this.retreatCD = 6;
    if (!p) return;
    this.setState('retreat');
    this.nav.goTo(p, e.movement.pos);
    // 退避に使うアビリティ（光学迷彩・フェイズシフト・オーバードライブ）
    const t = this.cdef.ABILITY.TYPE;
    if (e.ability.cooldown <= 0 && (t === 'cloak' || t === 'phase' || t === 'overdrive') && this.rng.next() < this.pskill.ABILITY_CHANCE) this.useAbility();
  }

  /** 見失った敵を追うとき（ソナー・光学迷彩で回り込む） */
  private chaseAbility(e: Entity, k: Contact) {
    const t = this.cdef.ABILITY.TYPE;
    if (e.ability.cooldown > 0 || this.rng.next() > this.pskill.ABILITY_CHANCE) return;
    const d = len(sub(k.pos, e.movement.pos));
    if (t === 'sonar' && d < abilityNum(this.cdef.ABILITY, 'RADIUS', 40)) this.useAbility();
    if (t === 'cloak' && d > 12) this.useAbility();
  }

  private threatEyes(e: Entity): Vec3[] {
    const out: Vec3[] = [];
    for (const c of this.contacts.values()) {
      if (this.time - c.lastKnown > 3) continue;
      const o = this.bw.sim.entities.get(c.id);
      if (!o || o.dead) continue;
      if (len(sub(o.movement.pos, e.movement.pos)) > 60) continue;
      out.push(this.eye(o));
    }
    return out.slice(0, 4);
  }

  protected useAbility(aim?: { yaw: number; pitch: number }) {
    this.wantAbility = true;
    this.abilityCD = 1;
    if (aim) this.forcedAim = aim;
  }

  private considerAbility(e: Entity, o: Entity | null, c: Contact | undefined, hp: number) {
    const ab = this.cdef.ABILITY;
    const pos = e.movement.pos;
    const chance = this.pskill.ABILITY_CHANCE;
    const visibleEnemies = [...this.contacts.values()].filter((x) => x.visible);
    switch (ab.TYPE) {
      case 'grapple': {
        // 離れた敵へ詰める（近距離の武器のとき）
        const w = activeSlot(e.arsenal).id;
        if (o && c?.visible && closeRange(w, this.wcfg)) {
          const d = len(sub(o.movement.pos, pos));
          if (d > 14 && d < abilityNum(ab, 'RANGE', 38) - 4 && this.rng.next() < chance * 0.4) {
            this.useAbility(aimAngles(this.eye(e), this.aimPoint(o)));
            return;
          }
        }
        // 高い所へ移動するとき：経路の先にある高い点の縁へワイヤーを撃つ
        if ((this.state === 'patrol' || this.state === 'chase') && this.nav.path && this.rng.next() < chance * 0.5) {
          const p = this.grappleTarget(e, abilityNum(ab, 'RANGE', 38));
          if (p) this.useAbility(aimAngles(this.eye(e), p));
        }
        break;
      }
      case 'cloak':
        // 退避・追跡のときに使う（enterRetreat / chaseAbility）
        break;
      case 'shield':
        break;
      case 'sonar':
        if (this.state === 'patrol' && this.noContactTime > 6 && this.bw.recentIntel(e.team, 6).length === 0 && this.rng.next() < chance * 0.15) this.useAbility();
        break;
      case 'overdrive':
        if (hp <= 0.5 && this.time - this.lastHurt < 2 && this.rng.next() < chance) this.useAbility();
        break;
      case 'phase': {
        const near = visibleEnemies.filter((x) => {
          const oe = this.bw.sim.entities.get(x.id);
          return oe && len(sub(oe.movement.pos, pos)) < 15;
        }).length;
        if ((hp <= 0.5 && this.time - this.lastHurt < 0.4) || near >= 3) {
          if (this.rng.next() < chance) {
            this.useAbility();
            if (this.state !== 'retreat') this.enterRetreat(e);
          }
        }
        break;
      }
    }
  }

  /** ワイヤーフックで登る先（経路の先の、4m 以上高い点の縁） */
  private grappleTarget(e: Entity, range: number): Vec3 | null {
    const path = this.nav.path;
    if (!path) return null;
    const eye = this.eye(e);
    const pos = e.movement.pos;
    const nodes = this.bw.nav.nodes;
    for (const id of path.slice(0, 14)) {
      const q = nodes[id].pos;
      if (q.y - pos.y < 3.8) continue;
      const hd = Math.hypot(q.x - pos.x, q.z - pos.z);
      if (hd < 4 || hd > range - 4) continue;
      // 縁（床の少し上）を狙う。当たる所が目的の点の近くなら使う
      const aim = v3(q.x, q.y + 0.3, q.z);
      const d = sub(aim, eye);
      const L = len(d);
      const hit = this.bw.sim.world.raycast(eye, scale(d, 1 / L), range);
      if (hit && len(sub(hit.point, aim)) < 1.8) return aim;
    }
    return null;
  }

  private considerGrenade(e: Entity, o: Entity, c: Contact) {
    const pos = e.movement.pos;
    const kind = e.arsenal.grenadeKind;
    const d = lenH(sub(c.pos, pos));
    const lost = !c.visible && this.time - c.lastSeen > 0.4 && this.time - c.lastSeen < 3;
    // 種類ごとの、投げる距離（刺さる種類はまっすぐ飛ぶので近めでも投げる）
    const [near, far] = kind === 'firestar' ? [5, 20] : kind === 'gravity' ? [6, 20] : kind === 'satchel' ? [6, 16] : kind === 'arc' ? [6, 22] : [8, 24];
    const p = this.pskill.GRENADE_CHANCE * 0.1 * (lost ? 3 : 1) * (kind === 'satchel' ? 1.5 : 1);
    if (d < near || d > far || this.rng.next() > p) return;
    const target = lost ? c.pos : o.movement.pos;
    const sol = this.throwAngles(this.eye(e), target, e);
    if (!sol) return;
    this.grenade = { ...sol, t: 0.35 };
    this.grenadeCD = 6;
  }

  /** スモーク：追い込まれて退くとき、自分と敵の間に煙を張る */
  private considerSmoke(e: Entity, o: Entity, c: Contact, hp: number, hurt: boolean) {
    const pos = e.movement.pos;
    const d = lenH(sub(c.pos, pos));
    const pressed = this.state === 'retreat' || (hp < 0.45 && hurt);
    if (!pressed || d < 5 || d > 35 || this.rng.next() > 0.35) return;
    const dir = normalize(horiz(sub(o.movement.pos, pos)));
    const at = add(pos, scale(dir, Math.min(7, d * 0.45)));
    const sol = this.throwAngles(this.eye(e), at, e);
    if (!sol) return;
    this.grenade = { ...sol, t: 0.25 };
    this.grenadeCD = 8;
  }

  /** サッチェル：置いたサッチェルのそばに敵が来たら起爆する（自分が近すぎるときは待つ） */
  private considerDetonate(e: Entity) {
    if (this.grenade) return;
    const sim = this.bw.sim;
    const R = gStat('satchel', 'RADIUS', this.wcfg.COMMON);
    for (const g of sim.grenades) {
      if (g.ownerId !== e.id || g.kind !== 'satchel' || (g.age ?? 0) < 0.8) continue;
      if (len(sub(g.pos, e.movement.pos)) < R * 0.75) continue;
      // 敵に張り付いた：すぐ起爆
      const host = g.stuck && g.stuck.entityId >= 0 ? sim.entities.get(g.stuck.entityId) : undefined;
      if (host && !host.dead && host.team !== e.team) {
        this.grenade = { yaw: this.aimYaw, pitch: this.aimPitch, t: 0.05 };
        return;
      }
      for (const o of sim.entities.values()) {
        if (o.team === e.team || o.dead || o.kind === 'holo' || o.kind === 'turret' || o.kind === 'core') continue;
        const oc = v3(o.movement.pos.x, o.movement.pos.y + o.movement.height * 0.5, o.movement.pos.z);
        if (len(sub(oc, g.pos)) < R * 0.7) {
          this.grenade = { yaw: this.aimYaw, pitch: this.aimPitch, t: 0.05 };
          return;
        }
      }
    }
  }

  /** グレネードを target へ届かせる向き（低い弾道）。刺さる種類は相手の胸へ */
  private throwAngles(eye: Vec3, target: Vec3, e?: Entity): { yaw: number; pitch: number } | null {
    const c = this.wcfg.COMMON;
    const kind = e?.arsenal.grenadeKind;
    const dx = target.x - eye.x,
      dz = target.z - eye.z;
    const D = Math.hypot(dx, dz);
    const lift = kind === 'firestar' || kind === 'gravity' ? 0.9 : 0.2;
    const h = target.y + lift - eye.y;
    const v = gStat(kind, 'THROW_SPEED', c),
      g = gStat(kind, 'GRAVITY', c);
    const disc = v ** 4 - g * (g * D * D + 2 * h * v * v);
    if (disc < 0) return null;
    const th = Math.atan((v * v - Math.sqrt(disc)) / (g * D));
    return { yaw: Math.atan2(-dx, -dz), pitch: th - c.GRENADE_UP_ANGLE * DEG };
  }

  protected pickPatrolGoal(e: Entity) {
    const pos = e.movement.pos;
    const intel = this.bw.recentIntel(e.team, 10);
    let goal: Vec3 | null = null;
    if (intel.length && this.rng.next() < 0.4) {
      // 味方が見つけた敵の方へ（近いもの、パイロット優先）
      let best: Vec3 | null = null,
        bs = Infinity;
      for (const [, it] of intel) {
        if (len(sub(it.pos, pos)) < 10) continue;
        const s = len(sub(it.pos, pos)) - (it.pilot ? 15 : 0) + this.rng.range(0, 15);
        if (s < bs) {
          bs = s;
          best = it.pos;
        }
      }
      if (best) {
        const n = this.bw.nearestConnected(v3(best.x + this.rng.range(-5, 5), best.y, best.z + this.rng.range(-5, 5)), 8);
        goal = n >= 0 ? this.bw.nav.nodes[n].pos : best;
      }
    }
    if (!goal) {
      const center = this.bw.center;
      let bs = Infinity;
      for (let i = 0; i < 5; i++) {
        const id = this.rng.pick(this.bw.pois);
        const q = this.bw.nav.nodes[id].pos;
        const dme = len(sub(q, pos));
        if (dme < 12) continue;
        const s = Math.hypot(q.x - center.x, q.z - center.z) * 0.25 + Math.abs(dme - 40) * 0.35 + this.rng.range(0, 20);
        if (s < bs) {
          bs = s;
          goal = q;
        }
      }
    }
    if (goal && len(sub(goal, pos)) < 6) goal = null;
    if (!goal) {
      // 見つからなければ、遠くの巡回先のどれか
      for (let i = 0; i < 10 && !goal; i++) {
        const q = this.bw.nav.nodes[this.rng.pick(this.bw.pois)].pos;
        if (len(sub(q, pos)) > 15) goal = q;
      }
    }
    if (goal) this.nav.goTo(goal, pos);
  }

  // ---------------------------------------------------------------------------
  // 撃ち合いの動き
  // ---------------------------------------------------------------------------

  private combatMove(
    e: Entity,
    _o: Entity,
    c: Contact,
    dt: number,
    nav: { dir: Vec3 | null; sprint: boolean; jump: boolean; crouch: boolean; lockYaw: number | null; sideInput: number },
  ): { move: Vec3 | null; sprint: boolean; jump: boolean; crouch: boolean; lockYaw: number | null; side: number } {
    const m = e.movement;
    const pos = m.pos;
    const out = { move: null as Vec3 | null, sprint: false, jump: false, crouch: false, lockYaw: null as number | null, side: 0 };
    const w = activeSlot(e.arsenal).id;
    const pref = PREF_RANGE[w];
    const to = horiz(sub(c.pos, pos));
    const d = len(to);
    const toT = d > 1e-3 ? scale(to, 1 / d) : v3(1, 0, 0);
    const grounded = m.state === 'ground' || m.state === 'slide';

    // 見えない・遠い：経路で近づく（見えていれば撃ちながら）
    if (!c.visible || d > pref + 14 || Math.abs(c.pos.y - pos.y) > 4.5) {
      if (this.time - this.engageGoalTime > 1.5 || !this.nav.hasGoal) {
        this.engageGoalTime = this.time;
        this.nav.goTo(c.pos, pos);
      }
      out.move = nav.dir;
      out.sprint = nav.sprint && !c.visible;
      out.jump = nav.jump;
      out.lockYaw = nav.lockYaw;
      out.side = nav.sideInput;
      return out;
    }
    if (this.nav.hasGoal) this.nav.stop();

    // 壁走りの動き（近くの壁へ寄って跳び、壁を走りながら撃つ）
    if (this.wallRun) {
      const r = this.runWallManeuver(e, this.wallRun, dt, grounded);
      if (r) {
        out.move = r.move;
        out.jump = r.jump;
        return out;
      }
      this.wallRun = null;
      this.maneuverCD = this.rng.range(2.5, 6) / Math.max(0.3, this.pskill.STRAFE);
    }

    // シールドの後ろで構える
    if (this.holdPosition > 0) {
      this.holdPosition -= dt;
      const perp = v3(-toT.z * this.strafeSign, 0, toT.x * this.strafeSign);
      if (this.rng.next() < dt * 0.8) this.strafeSign *= -1;
      out.move = this.safeMove(e, scale(perp, 0.35)) ? scale(perp, 0.35) : null;
      return out;
    }

    // 間合い（近すぎれば下がり、遠ければ詰める）と、横の動き
    const radial = d > pref + 4 ? 1 : d < pref - 4 ? -1 : 0;
    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeTimer = this.rng.range(0.5, 1.8);
      if (this.rng.next() < 0.7) this.strafeSign *= -1;
    }
    const perp = v3(-toT.z * this.strafeSign, 0, toT.x * this.strafeSign);
    let mv = add(scale(toT, radial * 0.8), scale(perp, this.pskill.STRAFE));
    if (len(mv) < 1e-3) mv = perp;
    mv = normalize(mv);
    if (!this.safeMove(e, mv)) {
      this.strafeSign *= -1;
      const alt = normalize(add(scale(toT, radial * 0.8), scale(v3(-toT.z * this.strafeSign, 0, toT.x * this.strafeSign), this.pskill.STRAFE)));
      mv = this.safeMove(e, alt) ? alt : radial > 0 && this.safeMove(e, toT) ? toT : (null as unknown as Vec3);
    }
    out.move = mv;

    // 近距離の武器で詰めるときはダッシュ → スライディング
    if (radial > 0 && closeRange(w, this.wcfg) && grounded && d > pref + 2) {
      out.move = toT;
      out.sprint = true;
      if (lenH(m.vel) > 7 && this.slideTimer <= 0 && this.rng.next() < dt * 2) this.slideTimer = 0.7;
    }
    if (this.slideTimer > 0) {
      this.slideTimer -= dt;
      out.crouch = true;
    }

    // 2段ジャンプで跳ねる（難しいボットほどよく跳ぶ）
    this.hopTimer -= dt;
    if (this.hopPhase === 0 && this.hopTimer <= 0 && grounded) {
      this.hopTimer = this.rng.range(1.5, 4.5) / Math.max(0.3, this.pskill.STRAFE);
      if (this.rng.next() < 0.6 * this.pskill.STRAFE) {
        out.jump = true;
        this.hopPhase = 1;
      }
    } else if (this.hopPhase === 1 && !grounded && m.vel.y < 1.0) {
      if (this.rng.next() < 0.7) out.jump = true;
      this.hopPhase = 2;
    } else if (this.hopPhase > 0 && grounded && m.stateTime > 0.05) this.hopPhase = 0;

    // 近くに壁があれば、壁走りしながら撃つ
    if (this.maneuverCD <= 0 && grounded && this.hopPhase === 0) {
      this.maneuverCD = 0.6;
      this.count('cw:try');
      const wr = this.findCombatWall(e, toT);
      if (wr) this.count('cw:found');
      if (wr && this.rng.next() < 0.6 * this.pskill.STRAFE) this.wallRun = { ...wr, t: 0, phase: 'approach' };
    }
    return out;
  }

  /**
   * 移動の途中の「見せる動き」：経路がまっすぐ続き、横に壁があれば壁走りする。長い直線ではスライディング。
   * 経路から少しずれても、着地した後に経路の続きへ戻る（Navigator がやり直す）
   */
  private flourishState: { kind: 'wall' | 'slide'; along: Vec3; into: Vec3; t: number; phase: 'approach' | 'air' | 'wall' } | null = null;
  private flourishCD = 1;
  private flourish(
    e: Entity,
    dt: number,
    nav: { dir: Vec3 | null; lockYaw: number | null; jump: boolean },
  ): { move: Vec3 | null; jump: boolean; crouch: boolean; lockYaw: number | null } | null {
    const m = e.movement;
    const grounded = m.state === 'ground' || m.state === 'slide';
    this.flourishCD = Math.max(0, this.flourishCD - dt);
    const f = this.flourishState;
    if (f) {
      const yaw = yawOf(f.along);
      if (f.kind === 'slide') {
        f.t += dt;
        if (f.t > 0.75 || !nav.dir) {
          this.flourishState = null;
          this.flourishCD = this.rng.range(1.5, 4) / Math.max(0.3, this.pskill.STRAFE);
          // スライディングの終わりにジャンプして勢いを保つ
          return { move: nav.dir ?? f.along, jump: grounded && this.rng.next() < 0.6, crouch: false, lockYaw: null };
        }
        return { move: nav.dir ?? f.along, jump: false, crouch: true, lockYaw: null };
      }
      const r = this.runWallManeuver(e, f, dt, grounded);
      if (!r) {
        this.flourishState = null;
        this.flourishCD = this.rng.range(1.5, 4.5) / Math.max(0.3, this.pskill.STRAFE);
        return null;
      }
      // 壁走り中、経路が壁から離れる方へ向いたら壁ジャンプ
      let jump = r.jump;
      if (m.state === 'wallrun' && nav.dir) {
        const away = -(nav.dir.x * f.into.x + nav.dir.z * f.into.z);
        if (away > 0.5 && m.stateTime > 0.35) jump = true;
      }
      return { move: r.move, jump, crouch: false, lockYaw: yaw };
    }
    if (this.flourishCD > 0 || !grounded || !nav.dir || nav.lockYaw !== null || nav.jump || this.nav.maneuvering) return null;
    this.count('fl:ready');
    if (lenH(m.vel) < 6) return null;
    this.count('fl:fast');
    this.flourishCD = 0.35;
    const dir = nav.dir;
    // 経路の先がまっすぐ続いているか
    if (!this.pathStraight(e, dir, 7)) return null;
    this.count('fl:straight');
    const p = m.pos;
    for (const sgn of this.rng.next() < 0.5 ? [1, -1] : [-1, 1]) {
      const sideDir = v3(-dir.z * sgn, 0, dir.x * sgn);
      const hit = this.wallHit(p, sideDir, 6);
      if (!hit) continue;
      this.count('fl:wall');
      const n = normalize(horiz(hit.normal));
      if (Math.abs(n.x * dir.x + n.z * dir.z) > 0.35) continue; // 進む向きに沿った壁だけ
      const h2 = this.wallHit(v3(p.x + dir.x * 3.5, p.y, p.z + dir.z * 3.5), sideDir, hit.t + 3);
      if (!h2) continue;
      this.count('fl:long');
      if (this.rng.next() > 1.1 * this.pskill.STRAFE) return null;
      this.flourishState = { kind: 'wall', along: dir, into: sideDir, t: 0, phase: 'approach' };
      return this.flourish(e, 0, nav);
    }
    if (this.rng.next() < 0.15 * this.pskill.STRAFE && m.slideCooldown <= 0) {
      this.flourishState = { kind: 'slide', along: dir, into: v3(), t: 0, phase: 'approach' };
      return this.flourish(e, 0, nav);
    }
    return null;
  }

  /** 経路の先 dist m が、ほぼ dir の向きに続いているか（歩くつながりだけ） */
  private pathStraight(e: Entity, dir: Vec3, dist: number): boolean {
    const path = this.nav.path;
    if (!path) return false;
    const p = e.movement.pos;
    const nodes = this.bw.nav.nodes;
    let far = 0;
    for (let i = this.nav.pathIndex + 1; i < path.length; i++) {
      const q = nodes[path[i]].pos;
      const d = v3(q.x - p.x, 0, q.z - p.z);
      const L = len(d);
      if (L < 1) continue;
      if ((d.x * dir.x + d.z * dir.z) / L < 0.86 || Math.abs(q.y - p.y) > 0.6) {
        if (L < dist) return far >= dist;
        break;
      }
      far = Math.max(far, L);
      if (far >= dist) return true;
    }
    return far >= dist;
  }

  /** その向きへ動いても、足場から落ちない・ぶつからないか */
  private safeMove(e: Entity, dir: Vec3): boolean {
    const p = e.movement.pos;
    const w = this.bw.sim.world;
    const ahead = v3(p.x + dir.x * 1.3, p.y, p.z + dir.z * 1.3);
    const g = w.raycast(v3(ahead.x, p.y + 0.6, ahead.z), v3(0, -1, 0), 2.2);
    if (!g) return false;
    if (w.blocked(v3(ahead.x, p.y + 0.8, ahead.z), v3(ahead.x, p.y + 1.4, ahead.z), this.cfg.PLAYER_RADIUS)) return false;
    return true;
  }

  /** 足元 p から dir の向きの壁（腰・胸・頭の高さのどれかで当たる、縦の面。窓や戸口の穴があっても見つかる） */
  private wallHit(p: Vec3, dir: Vec3, maxDist: number): { t: number; normal: Vec3; boxId: number } | null {
    const w = this.bw.sim.world;
    let best: { t: number; normal: Vec3; boxId: number } | null = null;
    for (const h of [1.1, 1.7, 2.3]) {
      const hit = w.raycast(v3(p.x, p.y + h, p.z), dir, maxDist);
      if (!hit || Math.abs(hit.normal.y) > 0.2 || w.getBox(hit.boxId)?.noWallrun) continue;
      if (!best || hit.t < best.t) best = { t: hit.t, normal: hit.normal, boxId: hit.boxId };
    }
    return best;
  }

  /** 壁までの距離（腰の高さ。into の向きに 6m まで） */
  private wallDist(e: Entity, into: Vec3): number {
    const hit = this.wallHit(e.movement.pos, into, 6);
    return hit ? hit.t : Infinity;
  }

  /**
   * 壁走りの動き（撃ち合い・移動の途中で共通）：壁へ斜めに寄る → 近づいたら跳ぶ → 空中で壁へ押し付ける → 壁を走る。
   * 返り値が null なら終わり
   */
  private runWallManeuver(
    e: Entity,
    wr: { along: Vec3; into: Vec3; t: number; phase: 'approach' | 'air' | 'wall' },
    dt: number,
    grounded: boolean,
  ): { move: Vec3; jump: boolean } | null {
    const m = e.movement;
    wr.t += dt;
    if (wr.phase === 'approach') {
      if (!grounded || wr.t > 2) return null;
      const d = this.wallDist(e, wr.into);
      if (!Number.isFinite(d)) return null;
      const mv = normalize(add(scale(wr.along, 0.55), scale(wr.into, d > 1.6 ? 0.85 : 0.35)));
      if (d < 1.6) {
        wr.phase = 'air';
        wr.t = 0;
        return { move: mv, jump: true };
      }
      if (!this.safeMove(e, mv)) return null;
      return { move: mv, jump: false };
    }
    if (m.state === 'wallrun') wr.phase = 'wall';
    if (wr.phase === 'air') {
      if (grounded && wr.t > 0.2) return null;
      if (wr.t > 1.1) return null;
      return { move: normalize(add(wr.along, scale(wr.into, 0.9))), jump: false };
    }
    // 壁走り中：壁に沿って進む。終わりの方でときどき壁ジャンプ
    if (m.state !== 'wallrun') return wr.t < 0.15 ? { move: wr.along, jump: false } : null;
    const jump = m.stateTime > 0.9 && this.rng.next() < dt * 2.5;
    return { move: wr.along, jump };
  }

  /** 壁走りできる壁（相手と反対側・横に、走る向きに沿った壁） */
  private findCombatWall(e: Entity, toT: Vec3): { along: Vec3; into: Vec3 } | null {
    if (e.movement.state !== 'ground') return null;
    const p = e.movement.pos;
    const dirs = [scale(toT, -1), v3(-toT.z, 0, toT.x), v3(toT.z, 0, -toT.x)];
    for (const dir of dirs) {
      const hit = this.wallHit(p, dir, 9);
      if (!hit) continue;
      this.count('cw:hit');
      const n = normalize(horiz(hit.normal));
      // 壁に沿った向き（相手から離れすぎない方）
      let along = v3(-n.z, 0, n.x);
      const dt0 = along.x * toT.x + along.z * toT.z;
      // 相手から離れる向きには走らない（視線と逆向きに入力すると壁走りが終わってしまう）
      if (dt0 < -0.2 || (Math.abs(dt0) <= 0.2 && this.rng.next() < 0.5)) along = scale(along, -1);
      // 壁が走る向きに 4m 以上続いている
      const ahead = v3(p.x + along.x * 4, p.y, p.z + along.z * 4);
      const h2 = this.wallHit(ahead, scale(n, -1), hit.t + 1.5);
      if (!h2) continue;
      this.count('cw:long');
      if (!this.safeMove(e, along)) continue;
      return { along, into: scale(n, -1) };
    }
    return null;
  }

}
