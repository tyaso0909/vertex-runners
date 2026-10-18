/**
 * ゲームロジック層。固定時間刻み（TICK_RATE 回/秒）で、全員の入力コマンドを受け取って状態を進める。
 * 描画（client）からは状態を読むだけ。将来はこのクラスをそのままサーバーで動かす想定。
 */
import {
  type CharacterId,
  type CharactersConfig,
  type GrenadeId,
  type GrenadesConfig,
  type MovementConfig,
  type WeaponId,
  type WeaponsConfig,
  abilityNum,
  charactersConfig,
  movementConfig,
  grenadeNum,
  grenadesConfig,
  passiveNum,
  weaponsConfig,
} from '../config';
import {
  type AbilityEvent,
  type AbilityState,
  type ShieldWall,
  applyMoveMods,
  createAbilityState,
  isCloaked,
  isPhased,
  rayVsShield,
  regenParams,
  stepAbility,
} from './abilities';
import { type CollisionWorld, makeBox } from './collision';
import { type BlastHit, type Grenade, blastDamageOf, blastSpec, grenadeCount, grenadePhys, stepGrenadePhysics, targetColliders } from './grenades';
import { type InputCommand, emptyCommand } from './input';
import { type LevelData, buildCollisionWorld } from './level';
import { type Vec3, DEG, add, clone, cross, dot, len, lenH, lookDir, normalize, scale, sub, v3 } from './math';
import { type PlayerMovement, createPlayerMovement, endGrapple, eyeHeightOf, respawn, stepMovement, teleport as teleportMovement } from './movement';
import { type Target, TURRET_MUZZLE_Y, bodyOf, createTarget, damageTarget, updateTarget } from './targets';
import { type Arsenal, type ShootContext, activeSlot, createArsenal, refillArsenal, stepArsenal, weaponSpeedMul } from './weapons';
import { type WeaponCustom, slotDef } from './weaponCustom';
import { type Actor, BODY_RADIUS, type BodyDef, chestOf, rayVsActor } from './hitbox';

export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;

/**
 * 参加者の種類：パイロット（プレイヤー・ボット）と、弱い歩兵。
 * タワーディフェンスでは、敵（爆弾兵・重装兵・ドローン・大型兵器）と、撃たれる建物（タレット・コア・バリケード）、
 * 敵をだます囮（ダミーバルーン・消耗戦のホロパイロット）も参加者にする（弾・爆風・倒したときの記録を、プレイヤーと同じ仕組みで扱うため）
 */
export type EntityKind = 'pilot' | 'grunt' | 'assault' | 'heavy' | 'mortar' | 'drone' | 'boss' | 'turret' | 'core' | 'barricade' | 'decoy' | 'holo';

/** 動かない建物（タレット・コア・バリケード） */
export const isStructure = (e: { kind: EntityKind }): boolean => e.kind === 'turret' || e.kind === 'core' || e.kind === 'barricade';
/** 撃たない物（建物と囮。ホロパイロットは走るが撃たない） */
export const isInert = (e: { kind: EntityKind }): boolean => isStructure(e) || e.kind === 'decoy' || e.kind === 'holo';

export interface Entity {
  id: number;
  name: string;
  /** チーム（0 か 1。練習ステージでは全員 0） */
  team: number;
  kind: EntityKind;
  character: CharacterId;
  movement: PlayerMovement;
  arsenal: Arsenal;
  ability: AbilityState;
  /** このティックのアビリティの出来事 */
  abilityEvents: AbilityEvent[];
  health: number;
  maxHealth: number;
  /** 体力の上の装甲（タワーディフェンスのアーマー）。ダメージは先にここが受ける。自然には戻らない */
  armor: number;
  maxArmor: number;
  /** 最後にダメージを受けてからの時間 */
  sinceDamage: number;
  dead: boolean;
  respawnTimer: number;
  /** 敵（タレット・敵の照準）に狙われている（蘭丸のパッシブ用） */
  aimedAt: boolean;
  /** 敵の参加者の照準の先にいる（数ティックごとに調べる） */
  aimedByEnemy: boolean;
  /** 最後に受け取った入力（向きの保持用） */
  lastCmd: InputCommand;
  /** 復活直後の無敵の残り時間 */
  invuln: number;
  /** 与えるダメージの倍率（歩兵は弱い） */
  damageMul: number;
  /** ワイヤーフックで引き寄せられて、よろめいている残り時間 */
  stagger: number;
  /** アークグレネードの電撃を受けている残り時間（動きが鈍り、狙いが乱れる） */
  shock: number;
  /** グラビティスターに引き寄せられている残り時間 */
  pulled: number;
  /** ソナーで敵チームに壁越しに見えている残り時間（revealDelay の後から数える） */
  revealed: number;
  revealDelay: number;
  /** ダメージを与えてきた相手の番号 → 最後に与えた時刻（アシストの判定） */
  attackers: Map<number, number>;
  /** 倒されたら消える（歩兵）。true なら respawnTimer の後に取り除く */
  removeOnTimer: boolean;
  /** 倒した相手（倒されている間、描画側がカメラを向けるのに使う） */
  killedBy: number;
  /** 部品で決めた当たり判定の形（なければ人の形） */
  body: BodyDef | null;
  /** 体の向き（当たり判定の向き。null なら視線の向き。大型兵器は歩く向きと狙う向きが違う） */
  facing: number | null;
  /** 動きを物理で進めない（ドローン・大型兵器・建物。位置は外から決める） */
  kinematic: boolean;
  /** 体力が自然に回復する（パイロット） */
  regen: boolean;
  /** 移動の速さの倍率（敵の種類ごと） */
  speedMul: number;
  /** 減速フィールドなどによる、このティックの速さの倍率（毎ティック外から決める。1 で普通） */
  slowMul: number;
  /** 目の高さ（足元から。なければ移動の状態から） */
  eyeY: number | null;
  /** 持ち主（タレットを置いた参加者。いなければ -1） */
  ownerId: number;
  /** ダウンしている残り時間（0 ならダウンしていない。タワーディフェンス） */
  downed: number;
  /** ダウンしてからの時間 */
  downTime: number;
  /** 蘇生の進み（秒） */
  reviveProgress: number;
  /** 蘇生している味方（いなければ -1） */
  reviverId: number;
}

/** 参加者を出すときの指定 */
export interface SpawnOptions {
  team?: number;
  kind?: EntityKind;
  pos?: Vec3;
  yaw?: number;
  maxHealth?: number;
  damageMul?: number;
  body?: BodyDef;
  kinematic?: boolean;
  regen?: boolean;
  speedMul?: number;
  eyeY?: number;
  ownerId?: number;
  /** 当たり判定の身長（kinematic の参加者の大まかな高さ） */
  height?: number;
  /** メイン・サブの武器のカスタマイズ（サイト・アタッチメント） */
  custom?: [WeaponCustom?, WeaponCustom?];
  /** グレネードの種類（省くとフラグ） */
  grenade?: GrenadeId;
}

/** モードごとの決まり（消耗戦では復活までの時間・出現地点・無敵が変わる） */
export interface SimRules {
  /** 倒されてから復活するまでの時間。null なら復活せず、少しして取り除く（歩兵） */
  respawnTime(e: Entity): number | null;
  /** 復活する場所と向き（なければ最初の場所） */
  pickSpawn?(e: Entity): { pos: Vec3; yaw: number } | null;
  /** 復活直後の無敵の時間 */
  spawnInvuln: number;
  /** アシストになる、倒される前の時間 */
  assistWindow: number;
  /**
   * 体力が 0 になったとき、倒れる代わりに「ダウン」させるか（タワーディフェンス）。
   * ダウンの間は動けず撃てない。downTime 秒以内に味方が近くで「調べる」を reviveTime 秒押し続けると蘇生する
   */
  downOnLethal?(e: Entity): boolean;
  downTime?: number;
  reviveTime?: number;
  reviveRange?: number;
  /** 蘇生したときの体力の割合 */
  reviveHealth?: number;
  /** 受けるダメージの倍率（タワーディフェンス：タレットの装甲など） */
  damageScale?(victim: Entity, source: DamageSource, attackerId: number): number;
}

export interface AmmoDrop {
  id: number;
  pos: Vec3;
  time: number;
}

export type DamageSource = 'turret' | 'grenade' | 'hazard' | 'shot' | 'melee' | 'tick';

export type SimEvent =
  | { type: 'targetRespawn'; targetId: number }
  | { type: 'ammoRefill'; entityId: number }
  | { type: 'grenadeSpawn'; grenade: Grenade }
  | { type: 'grenadeBounce'; grenadeId: number; pos: Vec3; speed: number }
  | { type: 'explosion'; grenadeId: number; ownerId: number; pos: Vec3; hits: BlastHit[]; kind: GrenadeId; radius: number }
  /** 刺さる種類のグレネードが刺さった（entityId は刺さった参加者。地形なら -1） */
  | { type: 'grenadeStick'; grenadeId: number; kind: GrenadeId; pos: Vec3; normal: Vec3; entityId: number }
  /** 効き始めた（煙が出る・燃え始める・渦が引き寄せ始める） */
  | { type: 'grenadeActivate'; grenadeId: number; kind: GrenadeId; pos: Vec3 }
  /** 爆発せずに消えた（煙・炎が尽きた、サッチェルが消えた） */
  | { type: 'grenadeEnd'; grenadeId: number; kind: GrenadeId; pos: Vec3 }
  /** アークグレネードの電撃を受けた */
  | { type: 'shocked'; entityId: number; time: number; byId: number }
  | { type: 'blastKill'; ownerId: number; targetId: number; ttk: number }
  | { type: 'playerDamaged'; entityId: number; amount: number; from: Vec3; source: DamageSource; attackerId?: number; head?: boolean; /** 装甲が受けた分（あれば） */ armor?: number }
  | { type: 'playerDied'; entityId: number }
  | { type: 'playerRespawn'; entityId: number; pos: Vec3; yaw: number }
  /** 参加者が倒された。killerId は得点する相手（いなければ -1）、assists はアシストした相手 */
  | {
      type: 'kill';
      killerId: number;
      victimId: number;
      victimKind: EntityKind;
      victimTeam: number;
      killerTeam: number;
      assists: number[];
      source: DamageSource;
      weapon?: WeaponId;
      /** グレネードで倒したときの種類 */
      grenade?: GrenadeId;
      head: boolean;
    }
  /** 倒された歩兵を取り除いた */
  | { type: 'entityRemoved'; entityId: number }
  /** ワイヤーフックで敵を引き寄せた */
  | { type: 'actorPulled'; entityId: number; byId: number }
  /** ダウンした（タワーディフェンス） */
  | { type: 'downed'; entityId: number; attackerId: number }
  /** 蘇生された */
  | { type: 'revived'; entityId: number; byId: number }
  | { type: 'turretShot'; targetId: number; from: Vec3; to: Vec3; hit: 'player' | 'shield' | 'world' | 'none'; shieldId?: number }
  | { type: 'ammoDropSpawn'; drop: AmmoDrop }
  | { type: 'ammoDropPickup'; dropId: number; entityId: number }
  | { type: 'ammoDropExpire'; dropId: number };

const AMMO_DROP_LIFETIME = 20;

export class Simulation {
  readonly world: CollisionWorld;
  readonly entities = new Map<number, Entity>();
  readonly targets: Target[];
  readonly grenades: Grenade[] = [];
  /** グレネードの種類ごとの数値（テストで変えられる） */
  gcfg: GrenadesConfig = grenadesConfig;
  /** いまダメージを与えているグレネードの種類（倒した記録に残す） */
  private grenadeCtx: GrenadeId | null = null;
  readonly shields: ShieldWall[] = [];
  readonly ammoDrops: AmmoDrop[] = [];
  tick = 0;
  /** 経過時間（秒） */
  time = 0;
  /** このティックで起きた、参加者に属さない出来事 */
  events: SimEvent[] = [];
  private nextId = 1;
  private nextGrenadeId = 1;
  private nextShieldId = 1;
  private nextDropId = 1;
  /** 取り除いた参加者も含めた、チームと種類（倒した相手の記録用） */
  private readonly registry = new Map<number, { team: number; kind: EntityKind; name: string; character: CharacterId }>();
  /** このティックの、チームごとの「撃てる相手」（敵チームの参加者） */
  private actorById = new Map<number, Actor>();
  private enemyActors = new Map<number, Actor[]>();
  rules: SimRules;
  /**
   * 練習ステージ（全員が同じチーム）では、ほかの人のグレネードも当たる（いままでどおり）。
   * 消耗戦では false にして、味方の爆風が当たらないようにする
   */
  soloTeam = true;

  constructor(
    readonly level: LevelData,
    readonly cfg: MovementConfig = movementConfig,
    readonly wcfg: WeaponsConfig = weaponsConfig,
    readonly ccfg: CharactersConfig = charactersConfig,
  ) {
    this.world = buildCollisionWorld(level);
    this.rules = { respawnTime: () => this.ccfg.COMMON.RESPAWN_TIME, spawnInvuln: 0, assistWindow: 5 };
    this.targets = (level.targets ?? []).map((d, i) =>
      createTarget(i + 1, d, d.kind === 'turret' ? wcfg.COMMON.TURRET_HEALTH : wcfg.COMMON.TARGET_HEALTH),
    );
  }

  spawnPlayer(name: string, loadout: [WeaponId, WeaponId] = ['ar', 'shotgun'], character: CharacterId = 'meia', opts: SpawnOptions = {}): Entity {
    const id = this.nextId++;
    const maxHealth = opts.maxHealth ?? this.ccfg.COMMON.MAX_HEALTH;
    const yaw = opts.yaw ?? this.level.spawnYaw;
    const e: Entity = {
      id,
      name,
      team: opts.team ?? 0,
      kind: opts.kind ?? 'pilot',
      character,
      movement: createPlayerMovement(opts.pos ?? this.level.spawn, yaw, this.cfg),
      arsenal: createArsenal(loadout[0], loadout[1], this.wcfg, 0x9e3779b9 ^ id, opts.custom, opts.grenade),
      ability: createAbilityState(character),
      abilityEvents: [],
      health: maxHealth,
      maxHealth,
      armor: 0,
      maxArmor: 0,
      sinceDamage: 99,
      dead: false,
      respawnTimer: 0,
      aimedAt: false,
      aimedByEnemy: false,
      lastCmd: { ...emptyCommand(), yaw },
      invuln: 0,
      damageMul: opts.damageMul ?? 1,
      stagger: 0,
      shock: 0,
      pulled: 0,
      revealed: 0,
      revealDelay: 0,
      attackers: new Map(),
      removeOnTimer: false,
      killedBy: -1,
      body: opts.body ?? null,
      facing: null,
      kinematic: opts.kinematic ?? false,
      regen: opts.regen ?? (opts.kind ?? 'pilot') === 'pilot',
      speedMul: opts.speedMul ?? 1,
      slowMul: 1,
      eyeY: opts.eyeY ?? null,
      ownerId: opts.ownerId ?? -1,
      downed: 0,
      downTime: 0,
      reviveProgress: 0,
      reviverId: -1,
    };
    if (opts.height !== undefined) e.movement.height = opts.height;
    applyMoveMods(e.movement, e.ability, this.ccfg);
    this.entities.set(id, e);
    this.registry.set(id, { team: e.team, kind: e.kind, name, character });
    return e;
  }

  /** 参加者を取り除く */
  removeEntity(id: number): void {
    const e = this.entities.get(id);
    if (!e) return;
    this.clearAbilityEffects(e);
    this.entities.delete(id);
  }

  /** 取り除いた参加者も含めて、チーム・種類・名前を調べる */
  infoOf(id: number): { team: number; kind: EntityKind; name: string; character: CharacterId } | undefined {
    return this.registry.get(id);
  }

  /** 装備を変える（試合前の準備や、テスト部屋での切り替え用） */
  setLoadout(id: number, loadout: [WeaponId, WeaponId], custom?: [WeaponCustom?, WeaponCustom?], grenade?: GrenadeId): void {
    const e = this.entities.get(id);
    if (!e) return;
    const kind = grenade ?? e.arsenal.grenadeKind;
    if (kind !== e.arsenal.grenadeKind) this.removeGrenadesOf(id, 'satchel');
    e.arsenal = createArsenal(loadout[0], loadout[1], this.wcfg, e.arsenal.rng, custom, kind);
  }

  /** グレネードの種類を変える（所持数は満タンから。置いてあるサッチェルは消える） */
  setGrenade(id: number, kind: GrenadeId): void {
    const e = this.entities.get(id);
    if (!e || e.arsenal.grenadeKind === kind) return;
    this.removeGrenadesOf(id, 'satchel');
    e.arsenal.grenadeKind = kind;
    e.arsenal.cooking = false;
    e.arsenal.grenadeRegen = 0;
    e.arsenal.grenades = grenadeCount(kind, this.wcfg.COMMON);
  }

  /** キャラクターを変える（アビリティは使える状態から） */
  setCharacter(id: number, character: CharacterId): void {
    const e = this.entities.get(id);
    if (!e) return;
    this.clearAbilityEffects(e);
    e.character = character;
    e.ability = createAbilityState(character);
    applyMoveMods(e.movement, e.ability, this.ccfg);
  }

  respawn(id: number): void {
    const e = this.entities.get(id);
    if (!e) return;
    const sp = this.rules.pickSpawn?.(e);
    if (sp) {
      e.movement.spawnPos = clone(sp.pos);
      e.movement.spawnYaw = sp.yaw;
    }
    respawn(e.movement, this.cfg);
    e.lastCmd = { ...e.lastCmd, yaw: e.movement.spawnYaw, pitch: 0 };
    refillArsenal(e.arsenal, this.wcfg);
    this.reviveEntity(e);
    e.invuln = this.rules.spawnInvuln;
  }

  /** 好きな場所へ移す（タイムアタックで、コースから落ちたときにチェックポイントへ戻すなど） */
  teleport(id: number, pos: Vec3): void {
    const e = this.entities.get(id);
    if (!e) return;
    if (e.movement.grapple) endGrapple(e.movement, 'cancel');
    teleportMovement(e.movement, pos, this.cfg);
  }

  private reviveEntity(e: Entity) {
    e.health = e.maxHealth;
    e.dead = false;
    e.downed = 0;
    e.downTime = 0;
    e.reviveProgress = 0;
    e.reviverId = -1;
    e.sinceDamage = 99;
    e.stagger = 0;
    e.shock = 0;
    e.pulled = 0;
    e.attackers.clear();
    e.killedBy = -1;
    this.clearAbilityEffects(e);
    e.ability.cooldown = 0;
  }

  private clearAbilityEffects(e: Entity) {
    const s = e.ability;
    s.cloak = s.inject = s.overdrive = s.phase = s.phaseWindup = 0;
    for (let i = this.shields.length - 1; i >= 0; i--) if (this.shields[i].ownerId === e.id) this.shields.splice(i, 1);
    s.shieldId = -1;
    if (e.movement.grapple) endGrapple(e.movement, 'cancel');
    applyMoveMods(e.movement, s, this.ccfg);
  }

  /** 1ティック進める。commands に入力がない参加者は前回の向きのまま何もしない */
  step(commands: Map<number, InputCommand>): void {
    this.tick++;
    this.time += TICK_DT;
    this.events = [];

    for (const t of this.targets) {
      if (updateTarget(t, TICK_DT, this.wcfg.COMMON.TARGET_REGEN_DELAY)) this.events.push({ type: 'targetRespawn', targetId: t.id });
    }
    this.buildActors();

    for (const e of [...this.entities.values()]) {
      e.abilityEvents = [];
      const raw = commands.get(e.id) ?? { ...emptyCommand(this.tick), yaw: e.lastCmd.yaw, pitch: e.lastCmd.pitch };

      // 倒されている間は動けない。少しして復活する（歩兵は取り除く）
      if (e.dead) {
        e.movement.events = [];
        e.arsenal.events = [];
        e.respawnTimer -= TICK_DT;
        if (e.respawnTimer <= 0) {
          if (e.removeOnTimer) {
            this.removeEntity(e.id);
            this.events.push({ type: 'entityRemoved', entityId: e.id });
            continue;
          }
          this.respawn(e.id);
          this.events.push({ type: 'playerRespawn', entityId: e.id, pos: clone(e.movement.pos), yaw: e.movement.spawnYaw });
        }
        e.lastCmd = raw;
        continue;
      }
      e.invuln = Math.max(0, e.invuln - TICK_DT);
      e.stagger = Math.max(0, e.stagger - TICK_DT);
      if (e.revealDelay > 0) e.revealDelay = Math.max(0, e.revealDelay - TICK_DT);
      else e.revealed = Math.max(0, e.revealed - TICK_DT);

      // ダウンしている間：その場から動けず、撃てない（向きだけ変えられる）。時間が切れると倒れる
      if (e.downed > 0) {
        this.stepDowned(e, raw, commands);
        continue;
      }

      // 撃っている間・エイム中・グレネードを構えている間はダッシュできない（ハンドガンは撃ちながらでもダッシュできる）
      const runGun = slotDef(this.wcfg, activeSlot(e.arsenal)).FIRE_WHILE_SPRINT;
      const cmd = raw.sprintHeld && ((raw.fireHeld && !runGun) || raw.adsHeld || e.arsenal.cooking) ? { ...raw, sprintHeld: false } : raw;
      applyMoveMods(e.movement, e.ability, this.ccfg);
      if (e.stagger > 0) e.movement.mods.speedMul *= 0.45;
      e.shock = Math.max(0, e.shock - TICK_DT);
      e.pulled = Math.max(0, e.pulled - TICK_DT);
      e.movement.mods.speedMul *= e.speedMul * e.slowMul * this.shockMul(e);
      if (e.kinematic) e.movement.events = [];
      else stepMovement(e.movement, cmd, this.world, this.cfg, TICK_DT, this.level.killY, weaponSpeedMul(e.arsenal, this.wcfg));
      if (isInert(e)) {
        // 建物・囮は自分では撃たない（タレットの射撃はモードの処理が行う）
        e.arsenal.events = [];
        e.lastCmd = cmd;
        continue;
      }
      if (e.movement.events.some((ev) => ev.type === 'respawn')) {
        refillArsenal(e.arsenal, this.wcfg);
        this.reviveEntity(e);
      }
      const me = this.actorById.get(e.id);
      if (me) {
        me.pos = e.movement.pos;
        me.height = e.movement.height;
        me.yaw = e.facing ?? cmd.yaw;
      }
      const eye = this.eyeOf(e);
      const enemies = this.enemyActors.get(e.team) ?? [];
      const ctx: ShootContext = {
        world: this.world,
        targets: this.targets,
        time: this.time,
        actors: enemies,
        shields: this.shields.filter((sh) => this.teamOfId(sh.ownerId) !== e.team),
        damageMul: e.damageMul,
      };
      stepArsenal(e.arsenal, e.movement, eye, cmd, this.wcfg, ctx, TICK_DT);
      stepAbility(
        e.ability,
        e.id,
        e.movement,
        e.arsenal,
        eye,
        cmd,
        { world: this.world, targets: this.targets, shields: this.shields, actors: enemies, ccfg: this.ccfg, wcfg: this.wcfg, newShieldId: () => this.nextShieldId++ },
        TICK_DT,
        e.abilityEvents,
      );
      for (const ev of e.arsenal.events) {
        if (ev.type === 'grenadeThrow') {
          const g: Grenade = { id: this.nextGrenadeId++, ownerId: e.id, team: e.team, kind: ev.kind, pos: { ...ev.origin }, vel: { ...ev.vel }, fuse: ev.fuse, resting: false, stuck: null, age: 0 };
          this.grenades.push(g);
          this.events.push({ type: 'grenadeSpawn', grenade: g });
        }
        if (ev.type === 'grenadeDetonate') {
          for (const g of this.grenades) if (g.ownerId === e.id && g.kind === 'satchel') g.detonate = true;
        }
        if (ev.type === 'targetKilled') this.onKill(e, ev.targetId);
        if (ev.type === 'actorHit') {
          const v = this.entities.get(ev.actorId);
          if (v) this.damageEntity(v, ev.damage, eye, ev.source, e.id, ev.head);
        }
        if (ev.type === 'shot') {
          for (const h of ev.hits) {
            if (h.kind !== 'shield' || h.shieldId === undefined) continue;
            const sh = this.shields.find((x) => x.id === h.shieldId);
            if (sh) sh.hits++;
          }
        }
      }
      for (const ev of e.abilityEvents) {
        if (ev.type === 'grappleActor') this.pullActor(e, ev.actorId);
        if (ev.type === 'sonarPulse') {
          const rt = abilityNum(this.ccfg[e.character].ABILITY, 'REVEAL_TIME', 3);
          for (const r of ev.revealedActors) {
            const v = this.entities.get(r.id);
            if (!v) continue;
            v.revealDelay = r.delay;
            v.revealed = rt;
          }
        }
      }
      if (e.kind === 'pilot') {
        this.checkAmmoStations(e);
        this.checkAmmoDrops(e);
      }
      this.checkHazards(e);
      if (e.regen) this.regen(e);
      e.lastCmd = cmd;
    }

    this.separateEntities();
    if (this.tick % 4 === 0) this.updateAimedAt();
    this.stepTurrets();
    this.stepGrenades();
    this.stepAmmoDrops();
  }

  private teamOfId(id: number): number {
    return this.entities.get(id)?.team ?? this.registry.get(id)?.team ?? -1;
  }

  /** このティックの「撃てる相手」の一覧を作る（倒れている・位相のずれた参加者は当たらない） */
  private buildActors() {
    this.actorById.clear();
    this.enemyActors.clear();
    const teams = new Set<number>();
    for (const e of this.entities.values()) {
      teams.add(e.team);
      // 倒れている・位相のずれた・ダウンしている参加者は撃たれない
      if (e.dead || isPhased(e.ability) || e.downed > 0) continue;
      this.actorById.set(e.id, this.actorOf(e));
    }
    for (const t of teams) this.enemyActors.set(t, [...this.actorById.values()].filter((a) => a.team !== t));
  }

  /** ワイヤーフックで敵を引き寄せる（よろめいて、しばらく遅くなる） */
  private pullActor(by: Entity, id: number) {
    const v = this.entities.get(id);
    if (!v || v.dead || isPhased(v.ability)) return;
    // 大きい敵・重い敵・建物は引き寄せられない
    if (v.kinematic || v.kind === 'heavy' || isStructure(v)) return;
    const ab = this.ccfg[by.character].ABILITY;
    const to = sub(by.movement.pos, v.movement.pos);
    const d = lenH(to);
    if (d < 0.5) return;
    const pull = Math.min(abilityNum(ab, 'TARGET_PULL_DIST', 4), Math.max(0, d - 1.6));
    const k = pull * 2.6;
    v.movement.vel = v3((to.x / d) * k, Math.max(v.movement.vel.y, 3.5), (to.z / d) * k);
    if (v.movement.state === 'ground' || v.movement.state === 'slide') v.movement.state = 'air';
    if (v.movement.grapple) endGrapple(v.movement, 'cancel');
    v.stagger = abilityNum(ab, 'TARGET_STAGGER_TIME', 1.2);
    this.events.push({ type: 'actorPulled', entityId: v.id, byId: by.id });
  }

  /** 参加者どうしが重ならないように、少しずつ押し離す（位相のずれた参加者は通り抜ける） */
  private separateEntities() {
    const list = [...this.entities.values()].filter((e) => !e.dead && !isPhased(e.ability) && !e.kinematic);
    const minD = BODY_RADIUS * 2;
    for (let i = 0; i < list.length; i++) {
      const a = list[i].movement;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j].movement;
        const dx = b.pos.x - a.pos.x,
          dz = b.pos.z - a.pos.z;
        if (Math.abs(dx) > minD || Math.abs(dz) > minD) continue;
        if (a.pos.y > b.pos.y + b.height || b.pos.y > a.pos.y + a.height) continue;
        const d = Math.hypot(dx, dz);
        if (d >= minD) continue;
        const nx = d > 1e-4 ? dx / d : 1,
          nz = d > 1e-4 ? dz / d : 0;
        const push = Math.min(0.08, (minD - d) * 0.5);
        this.nudge(a, -nx * push, -nz * push);
        this.nudge(b, nx * push, nz * push);
      }
    }
  }

  private nudge(m: PlayerMovement, dx: number, dz: number) {
    const R = this.cfg.PLAYER_RADIUS;
    const a = v3(m.pos.x + dx, m.pos.y + this.cfg.STEP_HEIGHT + R, m.pos.z + dz);
    const b = v3(m.pos.x + dx, m.pos.y + m.height - R, m.pos.z + dz);
    if (this.world.blocked(a, b, R)) return;
    m.pos = v3(m.pos.x + dx, m.pos.y, m.pos.z + dz);
  }

  /** 敵の照準の先にいるか（蘭丸のパッシブ）。敵の視線の 2.5° 以内で、間に壁がない */
  private updateAimedAt() {
    const list = [...this.entities.values()];
    for (const v of list) {
      if (v.dead || v.kind !== 'pilot') {
        v.aimedByEnemy = false;
        continue;
      }
      let aimed = false;
      const chest = chestOf({ id: v.id, team: v.team, pos: v.movement.pos, height: v.movement.height });
      for (const o of list) {
        if (o.dead || o.team === v.team || o === v || isStructure(o)) continue;
        const eye = this.eyeOf(o);
        const to = sub(chest, eye);
        const d = len(to);
        if (d > 80 || d < 0.5) continue;
        const look = lookDir(o.lastCmd.yaw, o.lastCmd.pitch);
        const cos = dot(look, to) / d;
        if (cos < Math.cos(2.5 * DEG)) continue;
        if (this.world.raycast(eye, scale(to, 1 / d), d - 0.5)) continue;
        aimed = true;
        break;
      }
      v.aimedByEnemy = aimed;
    }
  }

  // ---------------------------------------------------------------------------
  // 体力
  // ---------------------------------------------------------------------------

  /** プレイヤーにダメージを与える。フェイズシフト中は受けない（昔の呼び方。damageEntity と同じ） */
  damagePlayer(e: Entity, amount: number, from: Vec3, source: DamageSource): boolean {
    return this.damageEntity(e, amount, from, source);
  }

  /**
   * 参加者にダメージを与える。フェイズシフト中・復活直後の無敵の間は受けない。
   * attackerId は撃った相手（タレット・ダメージ床なら省く）。味方からのダメージは受けない（自分のグレネードは受ける）
   */
  damageEntity(e: Entity, amount: number, from: Vec3, source: DamageSource, attackerId = -1, head = false): boolean {
    if (e.dead || amount <= 0 || isPhased(e.ability) || e.invuln > 0 || e.downed > 0) return false;
    if (attackerId >= 0 && attackerId !== e.id && this.teamOfId(attackerId) === e.team) return false;
    if (this.rules.damageScale) amount *= this.rules.damageScale(e, source, attackerId);
    if (amount <= 0) return false;
    // 装甲が先に受ける（受けきれなかった分だけ体力が減る）
    let toHealth = amount;
    if (e.armor > 0) {
      const a = Math.min(e.armor, amount);
      e.armor -= a;
      toHealth -= a;
    }
    e.health = Math.max(0, e.health - toHealth);
    e.sinceDamage = 0;
    if (attackerId >= 0 && attackerId !== e.id) e.attackers.set(attackerId, this.time);
    this.events.push({ type: 'playerDamaged', entityId: e.id, amount, from: clone(from), source, attackerId: attackerId >= 0 ? attackerId : undefined, head, armor: amount - toHealth > 0 ? amount - toHealth : undefined });
    if (e.health <= 0) {
      if (this.rules.downOnLethal?.(e)) this.downEntity(e, attackerId);
      else this.killEntity(e, attackerId, source, head);
    }
    return true;
  }

  /** 体力が 0 になったパイロットをダウンさせる（タワーディフェンス） */
  private downEntity(e: Entity, attackerId: number) {
    e.downed = this.rules.downTime ?? 10;
    e.downTime = 0;
    e.reviveProgress = 0;
    e.reviverId = -1;
    e.health = 0;
    this.clearAbilityEffects(e);
    e.arsenal.reloading = false;
    e.arsenal.cooking = false;
    e.arsenal.ads = 0;
    e.movement.vel = v3(0, Math.min(0, e.movement.vel.y), 0);
    this.events.push({ type: 'downed', entityId: e.id, attackerId });
  }

  /** ダウンしている参加者の1ティック：動けない。近くの味方が「調べる」を押し続けると蘇生する */
  private stepDowned(e: Entity, raw: InputCommand, commands: Map<number, InputCommand>) {
    e.abilityEvents = [];
    e.arsenal.events = [];
    const still: InputCommand = { ...emptyCommand(raw.tick), yaw: raw.yaw, pitch: raw.pitch };
    applyMoveMods(e.movement, e.ability, this.ccfg);
    e.movement.mods.speedMul = 0;
    stepMovement(e.movement, still, this.world, this.cfg, TICK_DT, this.level.killY, 1);
    e.downed = Math.max(0, e.downed - TICK_DT);
    e.downTime += TICK_DT;
    // 蘇生：味方が近く（同じくらいの高さ）で「調べる」を押し続けている
    const range = this.rules.reviveRange ?? 2.2;
    let reviver: Entity | null = null;
    for (const o of this.entities.values()) {
      if (o === e || o.team !== e.team || o.dead || o.downed > 0 || o.kind !== 'pilot') continue;
      const c = commands.get(o.id);
      if (!c?.interactHeld) continue;
      const d = sub(o.movement.pos, e.movement.pos);
      if (lenH(d) > range || Math.abs(d.y) > 1.6) continue;
      if (!reviver || o.id === e.reviverId) reviver = o;
    }
    if (reviver) {
      if (e.reviverId !== reviver.id) e.reviveProgress = 0;
      e.reviverId = reviver.id;
      e.reviveProgress += TICK_DT;
      if (e.reviveProgress >= (this.rules.reviveTime ?? 3)) {
        e.downed = 0;
        e.downTime = 0;
        e.reviveProgress = 0;
        e.reviverId = -1;
        e.health = Math.max(1, e.maxHealth * (this.rules.reviveHealth ?? 0.5));
        e.sinceDamage = 0;
        e.invuln = 1;
        this.events.push({ type: 'revived', entityId: e.id, byId: reviver.id });
        e.lastCmd = still;
        return;
      }
    } else {
      e.reviverId = -1;
      e.reviveProgress = 0;
    }
    if (e.downed <= 0) {
      // 時間切れ：倒れる（得点の相手は、ダウンさせた敵）
      e.downTime = 0;
      this.killEntity(e, -1, 'shot', false);
    }
    e.lastCmd = still;
  }

  private killEntity(e: Entity, attackerId: number, source: DamageSource, head: boolean) {
    e.dead = true;
    const rt = this.rules.respawnTime(e);
    e.removeOnTimer = rt === null;
    e.respawnTimer = rt ?? 2.5;
    this.clearAbilityEffects(e);
    e.movement.vel = v3();
    this.events.push({ type: 'playerDied', entityId: e.id });
    // 得点する相手：倒した敵。自分のグレネード・落下などのときは、直前にダメージを与えていた敵
    const win = this.rules.assistWindow;
    const isEnemy = (id: number) => id >= 0 && id !== e.id && this.teamOfId(id) !== e.team && this.teamOfId(id) >= 0;
    let killer = isEnemy(attackerId) ? attackerId : -1;
    if (killer < 0) {
      let bestT = -Infinity;
      for (const [id, t] of e.attackers) if (isEnemy(id) && this.time - t <= win && t > bestT) (bestT = t), (killer = id);
    }
    const assists = [...e.attackers].filter(([id, t]) => id !== killer && isEnemy(id) && this.time - t <= win).map(([id]) => id);
    e.killedBy = killer;
    const ke = killer >= 0 ? this.entities.get(killer) : undefined;
    const weapon = ke && (source === 'shot' || source === 'melee') ? activeSlot(ke.arsenal).id : undefined;
    this.events.push({
      type: 'kill',
      killerId: killer,
      victimId: e.id,
      victimKind: e.kind,
      victimTeam: e.team,
      killerTeam: killer >= 0 ? this.teamOfId(killer) : -1,
      assists,
      source,
      weapon,
      grenade: source === 'grenade' && this.grenadeCtx ? this.grenadeCtx : undefined,
      head,
    });
    // ソラのパッシブ：倒した敵が弾薬を落とす
    if (ke && e.kind !== 'holo' && this.ccfg[ke.character].PASSIVE.AMMO_DROP === true) {
      const drop: AmmoDrop = { id: this.nextDropId++, pos: v3(e.movement.pos.x, e.movement.pos.y + 0.3, e.movement.pos.z), time: AMMO_DROP_LIFETIME };
      this.ammoDrops.push(drop);
      this.events.push({ type: 'ammoDropSpawn', drop });
    }
  }

  private regen(e: Entity) {
    e.sinceDamage += TICK_DT;
    const { delay, rate } = regenParams(e.ability, this.ccfg);
    if (e.health < e.maxHealth && e.sinceDamage >= delay) e.health = Math.min(e.maxHealth, e.health + rate * TICK_DT);
  }

  private checkHazards(e: Entity) {
    for (const h of this.level.hazards ?? []) {
      const p = e.movement.pos;
      if (p.x >= h.min.x && p.x <= h.max.x && p.z >= h.min.z && p.z <= h.max.z && p.y >= h.min.y - 0.1 && p.y <= h.max.y) {
        this.damagePlayer(e, h.dps * TICK_DT, v3(p.x, p.y - 1, p.z), 'hazard');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 訓練用タレット（プレイヤーを撃ってくる。アビリティを試す相手）
  // ---------------------------------------------------------------------------

  private stepTurrets() {
    const c = this.wcfg.COMMON;
    for (const e of this.entities.values()) e.aimedAt = e.aimedByEnemy;
    for (const t of this.targets) {
      if (t.kind !== 'turret' || !t.alive) continue;
      t.fireCooldown = Math.max(0, t.fireCooldown - TICK_DT);
      const muzzle = add(t.pos, v3(0, TURRET_MUZZLE_Y, 0));
      // 一番近く、見えているプレイヤーを狙う
      let best: { e: Entity; d: number; aim: Vec3 } | null = null;
      for (const e of this.entities.values()) {
        if (e.dead || isPhased(e.ability)) continue;
        const aim = add(e.movement.pos, v3(0, e.movement.height * 0.6, 0));
        const to = sub(aim, muzzle);
        const d = len(to);
        if (d > c.TURRET_RANGE) continue;
        if (isCloaked(e.ability) && d > c.TURRET_CLOAK_DETECT_RANGE) continue;
        if (this.world.raycast(muzzle, scale(to, 1 / d), d - 0.4)) continue;
        if (!best || d < best.d) best = { e, d, aim };
      }
      if (!best) {
        t.aimTarget = -1;
        t.aimTime = 0;
        continue;
      }
      if (t.aimTarget !== best.e.id) {
        t.aimTarget = best.e.id;
        t.aimTime = 0;
      }
      t.aimTime += TICK_DT;
      best.e.aimedAt = true;
      // 砲塔を向ける
      const to = sub(best.aim, muzzle);
      const wantYaw = Math.atan2(-to.x, -to.z);
      const wantPitch = Math.atan2(to.y, lenH(to));
      const maxTurn = c.TURRET_TURN_SPEED * DEG * TICK_DT;
      let dy = wantYaw - t.aimYaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      t.aimYaw += Math.max(-maxTurn, Math.min(maxTurn, dy));
      t.aimPitch += Math.max(-maxTurn, Math.min(maxTurn, wantPitch - t.aimPitch));
      if (t.aimTime < c.TURRET_LOCK_TIME || t.fireCooldown > 0 || Math.abs(dy) > 0.25) continue;
      t.fireCooldown = c.TURRET_FIRE_INTERVAL;
      this.turretFire(t, best.e, muzzle, best.aim);
    }
  }

  private turretFire(t: Target, e: Entity, muzzle: Vec3, aim: Vec3) {
    const c = this.wcfg.COMMON;
    // ばらつき（透明な相手は狙いにくい）
    const spreadDeg = c.TURRET_SPREAD * (isCloaked(e.ability) ? c.TURRET_CLOAK_SPREAD_MUL : 1);
    let dir = normalize(sub(aim, muzzle));
    const up = v3(0, 1, 0);
    const right = normalize(cross(dir, up));
    const upv = cross(right, dir);
    const r = Math.tan(spreadDeg * DEG) * Math.sqrt(this.rand());
    const th = this.rand() * Math.PI * 2;
    dir = normalize(add(dir, add(scale(right, Math.cos(th) * r), scale(upv, Math.sin(th) * r))));
    const range = c.TURRET_RANGE + 5;

    let hitT = range;
    let kind: 'player' | 'shield' | 'world' | 'none' = 'none';
    let shieldId: number | undefined;
    const wh = this.world.raycast(muzzle, dir, range);
    if (wh) {
      hitT = wh.t;
      kind = 'world';
    }
    // シールドは敵の弾を止める（タレットはプレイヤー全員の敵）
    for (const sh of this.shields) {
      const st = rayVsShield(muzzle, dir, hitT, sh);
      if (st !== null && st < hitT) {
        hitT = st;
        kind = 'shield';
        shieldId = sh.id;
      }
    }
    // プレイヤーの体（縦長のカプセルを、中心の線分からの距離で近似）
    const m = e.movement;
    const foot = m.pos;
    for (let k = 0.15; k < hitT; k += 0.25) {
      const p = add(muzzle, scale(dir, k));
      if (p.y < foot.y - 0.05 || p.y > foot.y + m.height + 0.05) continue;
      if (Math.hypot(p.x - foot.x, p.z - foot.z) < this.cfg.PLAYER_RADIUS + 0.05) {
        hitT = k;
        kind = 'player';
        break;
      }
    }
    const to = add(muzzle, scale(dir, hitT));
    if (kind === 'shield' && shieldId !== undefined) {
      const sh = this.shields.find((x) => x.id === shieldId);
      if (sh) sh.hits++;
    }
    this.events.push({ type: 'turretShot', targetId: t.id, from: muzzle, to, hit: kind, shieldId });
    if (kind === 'player') this.damagePlayer(e, c.TURRET_DAMAGE, muzzle, 'turret');
  }

  private rngState = 0x2545f491;
  private rand(): number {
    let x = this.rngState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x >>> 0;
    return this.rngState / 4294967296;
  }

  // ---------------------------------------------------------------------------
  // グレネード
  // ---------------------------------------------------------------------------

  private stepGrenades() {
    const c = this.wcfg.COMMON;
    const extra = targetColliders(this.targets);
    for (const e of this.entities.values()) e.arsenal.satchelsOut = 0;
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      const kind = g.kind ?? 'frag';
      const def = this.gcfg[kind];
      g.age = (g.age ?? 0) + TICK_DT;
      const owner = this.entities.get(g.ownerId);
      // サッチェル：置いた人が倒されると消える
      if (kind === 'satchel' && (!owner || owner.dead)) {
        this.endGrenade(i, g);
        continue;
      }
      // 参加者に刺さっている：その体と一緒に動く。倒されたら落ちる
      if (g.stuck && g.stuck.entityId >= 0) {
        const host = this.entities.get(g.stuck.entityId);
        if (!host || host.dead) {
          g.stuck = null;
          g.resting = false;
          g.vel = v3(0, -1, 0);
        } else g.pos = add(host.movement.pos, g.stuck.offset);
      }
      if (!g.stuck) {
        const phys = grenadePhys(kind, c, this.gcfg);
        const before = clone(g.pos);
        const speed = Math.hypot(g.vel.x, g.vel.y, g.vel.z);
        const bounced = stepGrenadePhysics(g, this.world, extra, phys, TICK_DT);
        // 刺さる種類：敵の体に当たれば、その体に刺さる（地形より手前なら）
        if (phys.stick) this.stickToActor(g, before);
        if (g.stuck) this.onGrenadeStick(g);
        else if (bounced) this.events.push({ type: 'grenadeBounce', grenadeId: g.id, pos: { ...g.pos }, speed });
      }
      g.fuse -= TICK_DT;
      if (g.pos.y <= this.level.killY) {
        this.endGrenade(i, g);
        continue;
      }
      // 刺さる種類が刺さらないまま時間が来たら、その場で効き始める
      if (def.STICK && !g.stuck && g.fuse <= 0 && kind !== 'satchel') {
        g.stuck = { normal: v3(0, 1, 0), entityId: -1, offset: v3() };
        this.onGrenadeStick(g);
      }
      switch (kind) {
        case 'frag':
        case 'arc':
          if (g.fuse <= 0) this.explodeGrenade(i, g);
          break;
        case 'smoke': {
          if (g.active === undefined) {
            if (g.fuse <= 0) {
              g.active = 0;
              this.events.push({ type: 'grenadeActivate', grenadeId: g.id, kind, pos: clone(g.pos) });
            }
            break;
          }
          g.active += TICK_DT;
          if (g.active >= grenadeNum(def, 'SMOKE_TIME', 12)) this.endGrenade(i, g);
          break;
        }
        case 'firestar': {
          if (g.active === undefined) break;
          const arm = grenadeNum(def, 'ARM_TIME', 0.2);
          const was = g.active;
          g.active += TICK_DT;
          if (was < arm && g.active >= arm) this.events.push({ type: 'grenadeActivate', grenadeId: g.id, kind, pos: clone(g.pos) });
          if (g.active >= arm) this.burn(g);
          if (g.active >= arm + grenadeNum(def, 'FIRE_TIME', 5)) this.endGrenade(i, g);
          break;
        }
        case 'gravity': {
          if (g.active === undefined) break;
          const arm = grenadeNum(def, 'ARM_TIME', 0.35);
          const was = g.active;
          g.active += TICK_DT;
          if (was < arm && g.active >= arm) this.events.push({ type: 'grenadeActivate', grenadeId: g.id, kind, pos: clone(g.pos) });
          if (g.active >= arm) this.pullTowards(g);
          if (g.active >= arm + grenadeNum(def, 'PULL_TIME', 1.8)) this.explodeGrenade(i, g);
          break;
        }
        case 'satchel': {
          if (owner) owner.arsenal.satchelsOut++;
          if (g.detonate && g.age >= grenadeNum(def, 'ARM_TIME', 0.6)) this.explodeGrenade(i, g);
          else if (g.fuse <= 0) this.endGrenade(i, g);
          break;
        }
      }
    }
  }

  /** 刺さる種類：飛んだ線の上に敵の体があれば、そこに刺さる */
  private stickToActor(g: Grenade, before: Vec3) {
    const seg = sub(g.pos, before);
    const L = len(seg);
    if (L < 1e-5) return;
    const dir = scale(seg, 1 / L);
    const team = g.team ?? this.teamOfId(g.ownerId);
    let best: { e: Entity; t: number; point: Vec3; normal: Vec3 } | null = null;
    for (const e of this.entities.values()) {
      if (e.dead || e.team === team || e.id === g.ownerId || isPhased(e.ability) || e.kind === 'holo') continue;
      if (lenH(sub(e.movement.pos, before)) > L + 4) continue;
      const a = this.actorOf(e);
      const hit = rayVsActor(before, dir, L + 0.1, a);
      if (hit && (!best || hit.t < best.t)) {
        best = { e, t: hit.t, point: hit.point, normal: hit.normal };
        continue;
      }
      // 線が体の中から始まると光線では当たらないので、人の形は点が体の中に入ったかでも確かめる
      if (a.body) continue;
      const r = BODY_RADIUS + 0.06;
      for (let k = 1; k <= 4; k++) {
        const t = (L * k) / 4;
        const q = add(before, scale(dir, t));
        const dx = q.x - a.pos.x,
          dz = q.z - a.pos.z;
        if (dx * dx + dz * dz > r * r || q.y < a.pos.y || q.y > a.pos.y + a.height) continue;
        if (!best || t < best.t) {
          const h = Math.hypot(dx, dz) || 1;
          best = { e, t, point: v3(a.pos.x + (dx / h) * BODY_RADIUS, q.y, a.pos.z + (dz / h) * BODY_RADIUS), normal: v3(dx / h, 0, dz / h) };
        }
        break;
      }
    }
    if (!best) return;
    g.pos = clone(best.point);
    g.vel = v3();
    g.stuck = { normal: clone(best.normal), entityId: best.e.id, offset: sub(best.point, best.e.movement.pos) };
  }

  /** 刺さった瞬間：知らせる。ファイアスターが敵に刺さると、その場でダメージ */
  private onGrenadeStick(g: Grenade) {
    if (!g.stuck || g.active !== undefined) return;
    const kind = g.kind ?? 'frag';
    g.active = 0;
    this.events.push({ type: 'grenadeStick', grenadeId: g.id, kind, pos: clone(g.pos), normal: clone(g.stuck.normal), entityId: g.stuck.entityId });
    if (kind === 'firestar' && g.stuck.entityId >= 0) {
      const v = this.entities.get(g.stuck.entityId);
      if (v) this.grenadeDamage(v, grenadeNum(this.gcfg.firestar, 'IMPACT_DAMAGE', 20), g, kind);
    }
    // ファイアスター：燃える面の高さ。床なら刺さった所、壁・天井なら、その下の地面（なければ 1.2m 下）へ炎が垂れる
    if (kind === 'firestar') {
      if (g.stuck.entityId >= 0 || g.stuck.normal.y > 0.5) g.fireY = g.pos.y;
      else {
        const from = add(g.pos, scale(v3(g.stuck.normal.x, 0, g.stuck.normal.z), 0.3));
        const hit = this.world.raycast(from, v3(0, -1, 0), 4);
        g.fireY = hit ? hit.point.y : g.pos.y - 1.2;
      }
    }
  }

  /** グレネードのダメージ（倒した記録に種類を残す） */
  private grenadeDamage(e: Entity, amount: number, g: Grenade, kind: GrenadeId) {
    const owner = this.entities.get(g.ownerId);
    const self = e.id === g.ownerId;
    const mul = self ? this.ccfg.COMMON.SELF_GRENADE_DAMAGE_MUL : (owner?.damageMul ?? 1);
    this.grenadeCtx = kind;
    const hit = this.damageEntity(e, amount * mul, g.pos, 'grenade', g.ownerId);
    this.grenadeCtx = null;
    return hit;
  }

  /** 爆発せずに消える */
  private endGrenade(i: number, g: Grenade) {
    this.grenades.splice(i, 1);
    this.events.push({ type: 'grenadeEnd', grenadeId: g.id, kind: g.kind ?? 'frag', pos: clone(g.pos) });
  }

  /** 持ち主のグレネードを消す（種類を変えたとき） */
  private removeGrenadesOf(ownerId: number, kind: GrenadeId) {
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      if (g.ownerId === ownerId && g.kind === kind) this.endGrenade(i, g);
    }
  }

  /** 爆発（フラグ・アーク・グラビティスター・サッチェル）。的と敵と自分に当たる（自分は少し弱く。味方には当たらない） */
  private explodeGrenade(i: number, g: Grenade) {
    const c = this.wcfg.COMMON;
    const kind = g.kind ?? 'frag';
    const def = this.gcfg[kind];
    const b = blastSpec(kind, c, this.gcfg);
    this.grenades.splice(i, 1);
    // 刺さった面から少し離した所を爆心にする（壁の中に爆心が入らないように）
    const center = g.stuck ? add(g.pos, scale(g.stuck.normal, 0.12)) : clone(g.pos);
    const hits: BlastHit[] = [];
    for (const t of this.targets) {
      if (!t.alive) continue;
      const dmg = blastDamageOf(center, t.pos, this.world, b, bodyOf(t).centerY);
      if (dmg <= 0) continue;
      const r = damageTarget(t, dmg, this.time, this.respawnTimeOf(t));
      hits.push({ targetId: t.id, damage: dmg, killed: r.killed });
      if (r.killed) {
        this.events.push({ type: 'blastKill', ownerId: g.ownerId, targetId: t.id, ttk: r.ttk });
        const owner = this.entities.get(g.ownerId);
        if (owner) this.onKill(owner, t.id);
      }
    }
    const team = g.team ?? this.teamOfId(g.ownerId);
    for (const e of [...this.entities.values()]) {
      const self = e.id === g.ownerId;
      if (!self && e.team === team && !this.soloTeam) continue;
      if (e.dead) continue;
      let dmg = blastDamageOf(center, e.movement.pos, this.world, b, e.body ? e.body.aim.y : e.movement.height * 0.5);
      // 刺さっていた相手には、まともに当たる
      if (g.stuck && g.stuck.entityId === e.id) dmg = Math.max(dmg, b.max);
      if (dmg <= 0) continue;
      if (kind === 'arc' && e.kind === 'drone') dmg *= grenadeNum(def, 'DRONE_MUL', 3);
      const hurt = this.grenadeDamage(e, dmg, g, kind);
      // アーク：電撃で動きが鈍り、狙いが乱れる（自分は半分）
      if (kind === 'arc' && hurt && !isStructure(e) && !e.dead) {
        const time = grenadeNum(def, 'SHOCK_TIME', 3) * (self ? 0.5 : 1);
        e.shock = Math.max(e.shock, time);
        this.events.push({ type: 'shocked', entityId: e.id, time, byId: g.ownerId });
      }
    }
    this.events.push({ type: 'explosion', grenadeId: g.id, ownerId: g.ownerId, pos: center, hits, kind, radius: b.radius });
  }

  /** アークの電撃で鈍る分（電撃の残りが半分を切ると、だんだん戻る） */
  shockMul(e: Entity): number {
    if (e.shock <= 0) return 1;
    const def = this.gcfg.arc;
    const k = Math.min(1, e.shock / (grenadeNum(def, 'SHOCK_TIME', 3) * 0.5));
    return 1 - grenadeNum(def, 'SHOCK_SLOW', 0.5) * k;
  }

  /** ファイアスター：燃えている所にいる敵を焼く（0.25 秒ごと）。刺さっていた相手はもっと焼ける */
  private burn(g: Grenade) {
    const def = this.gcfg.firestar;
    const period = 0.25;
    // 0.25 秒ごとにまとめて与える（ダメージの知らせが多くなりすぎないように）
    const step = Math.round((g.active ?? 0) / TICK_DT);
    if (step % Math.round(period / TICK_DT) !== 0) return;
    const R = grenadeNum(def, 'FIRE_RADIUS', 2.6);
    const H = grenadeNum(def, 'FIRE_HEIGHT', 1.8);
    const dps = grenadeNum(def, 'FIRE_DPS', 30);
    const team = g.team ?? this.teamOfId(g.ownerId);
    const host = g.stuck && g.stuck.entityId >= 0 ? g.stuck.entityId : -1;
    const from = g.stuck ? add(g.pos, scale(g.stuck.normal, 0.2)) : add(g.pos, v3(0, 0.2, 0));
    // 燃える面の高さ（刺さった敵と一緒に動くときは、その足元の近く）
    const baseY = host >= 0 ? g.pos.y - 1.2 : (g.fireY ?? g.pos.y);
    for (const e of [...this.entities.values()]) {
      if (e.dead || (e.team === team && e.id !== host) || e.id === g.ownerId || isStructure(e) || e.kind === 'holo') continue;
      if (e.id === host) {
        this.grenadeDamage(e, dps * grenadeNum(def, 'STUCK_DPS_MUL', 1.4) * period, g, 'firestar');
        continue;
      }
      const p = e.movement.pos;
      // 壁に刺さったときは、炎は壁から少し前に広がる（見た目と同じ）
      const n = g.stuck?.normal;
      const center = n && n.y <= 0.5 && host < 0 ? add(g.pos, scale(v3(n.x, 0, n.z), 0.6)) : g.pos;
      const d = lenH(sub(p, center));
      if (d > R + BODY_RADIUS || p.y > baseY + H || p.y + e.movement.height < baseY - 0.3) continue;
      const mid = v3(p.x, Math.max(baseY + 0.3, p.y + 0.4), p.z);
      const to = sub(mid, from);
      const L = len(to);
      if (L > 0.3 && this.world.raycast(from, scale(to, 1 / L), L - 0.2)) continue;
      this.grenadeDamage(e, dps * period, g, 'firestar');
    }
  }

  /** グラビティスターの渦の中心（刺さった面から少し浮かせた所） */
  gravityCenter(g: Grenade): Vec3 {
    const n = g.stuck?.normal ?? v3(0, 1, 0);
    return add(add(g.pos, scale(n, 0.6)), v3(0, grenadeNum(this.gcfg.gravity, 'PULL_LIFT', 1.2) * 0.5, 0));
  }

  /** グラビティスター：周りの敵を中心へ引き寄せ、浮かせる（自分で動けなくなる） */
  private pullTowards(g: Grenade) {
    const def = this.gcfg.gravity;
    const R = grenadeNum(def, 'PULL_RADIUS', 8);
    const accel = grenadeNum(def, 'PULL_ACCEL', 30);
    const center = this.gravityCenter(g);
    const team = g.team ?? this.teamOfId(g.ownerId);
    for (const e of this.entities.values()) {
      if (e.dead || e.downed > 0 || e.team === team || e.kinematic || isStructure(e) || e.kind === 'heavy' || isPhased(e.ability)) continue;
      const m = e.movement;
      const mid = v3(m.pos.x, m.pos.y + m.height * 0.5, m.pos.z);
      const to = sub(center, mid);
      const d = len(to);
      if (d > R) continue;
      if (d > 0.4 && this.world.raycast(center, scale(to, -1 / d), d - 0.4)) continue;
      // 中心へ向かう速さ（近いほど遅く、中心で止まる）。重力は打ち消して浮かせる
      const want = d > 0.05 ? scale(to, Math.min(11, d * 3.2) / d) : v3();
      const k = Math.min(1, (accel / 11) * TICK_DT * 3);
      m.vel = add(m.vel, scale(sub(want, m.vel), k));
      m.vel.y += this.cfg.GRAVITY * TICK_DT;
      if (m.state === 'ground' || m.state === 'slide' || m.state === 'wallrun') m.state = 'air';
      if (m.grapple) endGrapple(m, 'cancel');
      e.stagger = Math.max(e.stagger, 0.3);
      e.pulled = 0.3;
    }
  }

  /** スモーク：いま張られている煙の幕（中心と半径・濃さ 0〜1） */
  smokes(): Array<{ id: number; pos: Vec3; radius: number; density: number }> {
    const out: Array<{ id: number; pos: Vec3; radius: number; density: number }> = [];
    const def = this.gcfg.smoke;
    const R = grenadeNum(def, 'SMOKE_RADIUS', 6.5);
    const grow = grenadeNum(def, 'SMOKE_GROW', 1.4);
    const fade = grenadeNum(def, 'SMOKE_FADE', 2);
    const life = grenadeNum(def, 'SMOKE_TIME', 12);
    for (const g of this.grenades) {
      if (g.kind !== 'smoke' || g.active === undefined) continue;
      const a = g.active;
      const k = Math.min(1, a / grow);
      const radius = R * (0.35 + 0.65 * (1 - (1 - k) * (1 - k)));
      const density = Math.min(1, a / (grow * 0.5)) * Math.min(1, Math.max(0, (life - a) / fade));
      out.push({ id: g.id, pos: add(g.pos, v3(0, radius * 0.35, 0)), radius, density });
    }
    return out;
  }

  /** 煙の幕が from から to への見通しをふさいでいるか（ボットの目）。とても近い相手は見える */
  smokeBlocks(from: Vec3, to: Vec3): boolean {
    if (!this.grenades.length) return false;
    const d = sub(to, from);
    const L = len(d);
    if (L < 2.5) return false;
    for (const sm of this.smokes()) {
      if (sm.density < 0.35) continue;
      const r = sm.radius * 0.88;
      // 線分と球の中心のいちばん近い距離
      const t = Math.max(0, Math.min(1, dot(sub(sm.pos, from), d) / (L * L)));
      const q = add(from, scale(d, t));
      if (len(sub(sm.pos, q)) < r) return true;
    }
    return false;
  }

  respawnTimeOf(t: Target): number {
    return t.kind === 'turret' ? this.wcfg.COMMON.TURRET_RESPAWN_TIME : this.wcfg.COMMON.TARGET_RESPAWN_TIME;
  }

  // ---------------------------------------------------------------------------
  // 弾薬（補給所・ソラのパッシブで落ちる弾薬）
  // ---------------------------------------------------------------------------

  private onKill(e: Entity, targetId: number) {
    const t = this.targets.find((x) => x.id === targetId);
    if (!t) return;
    // タレットは倒すと少し長く止まる
    if (t.kind === 'turret') t.respawnTimer = this.wcfg.COMMON.TURRET_RESPAWN_TIME;
    if (this.ccfg[e.character].PASSIVE.AMMO_DROP === true) {
      const drop: AmmoDrop = { id: this.nextDropId++, pos: v3(t.pos.x, t.pos.y + 0.3, t.pos.z), time: AMMO_DROP_LIFETIME };
      this.ammoDrops.push(drop);
      this.events.push({ type: 'ammoDropSpawn', drop });
    }
  }

  private checkAmmoDrops(e: Entity) {
    for (let i = this.ammoDrops.length - 1; i >= 0; i--) {
      const d = this.ammoDrops[i];
      const diff = sub(e.movement.pos, d.pos);
      if (lenH(diff) < 1.5 && Math.abs(diff.y) < 1.8) {
        for (const s of e.arsenal.slots) s.ammo = slotDef(this.wcfg, s).MAG_SIZE;
        e.arsenal.reloading = false;
        this.ammoDrops.splice(i, 1);
        this.events.push({ type: 'ammoDropPickup', dropId: d.id, entityId: e.id });
      }
    }
  }

  private stepAmmoDrops() {
    for (let i = this.ammoDrops.length - 1; i >= 0; i--) {
      const d = this.ammoDrops[i];
      d.time -= TICK_DT;
      if (d.time <= 0) {
        this.ammoDrops.splice(i, 1);
        this.events.push({ type: 'ammoDropExpire', dropId: d.id });
      }
    }
  }

  private checkAmmoStations(e: Entity) {
    for (const st of this.level.ammoStations ?? []) {
      const d = sub(e.movement.pos, st);
      if (lenH(d) < 1.6 && Math.abs(d.y) < 1.5) {
        const a = e.arsenal;
        const reserveFull = this.wcfg.COMMON.INFINITE_RESERVE || a.slots.every((s) => s.reserve >= this.wcfg[s.id].RESERVE);
        const gMax = grenadeCount(a.grenadeKind, this.wcfg.COMMON);
        const full = reserveFull && a.grenades >= gMax;
        if (!full) {
          for (const s of a.slots) s.reserve = this.wcfg[s.id].RESERVE;
          a.grenades = gMax;
          this.events.push({ type: 'ammoRefill', entityId: e.id });
        }
      }
    }
  }

  eyeOf(e: Entity): Vec3 {
    const m = e.movement;
    return v3(m.pos.x, m.pos.y + (e.eyeY ?? eyeHeightOf(m, this.cfg)), m.pos.z);
  }

  /** 参加者の当たり判定（撃てる相手の形） */
  actorOf(e: Entity): Actor {
    return { id: e.id, team: e.team, pos: e.movement.pos, height: e.movement.height, body: e.body ?? undefined, yaw: e.facing ?? e.lastCmd.yaw };
  }

  /** 地形に、動く物の当たり判定の箱を足す（タワーディフェンスのタレット）。番号を返す */
  addDynamicBox(center: Vec3, size: Vec3, yawDeg = 0): number {
    const id = this.world.boxes.length;
    this.world.add({ ...makeBox(id, center, size, v3(0, yawDeg, 0), true), passRays: true });
    return id;
  }

  /** 足した箱を取り除く（当たらないようにする） */
  removeDynamicBox(id: number): void {
    this.world.disable(id);
  }

  /** 足した箱を動かす（大型兵器） */
  moveDynamicBox(id: number, center: Vec3, size: Vec3, yawDeg = 0): void {
    this.world.replace(id, { ...makeBox(id, center, size, v3(0, yawDeg, 0), true), passRays: true });
  }

  /** シールドの壁を足す（ブーストのハードカバー）。番号を返す */
  addShield(sh: Omit<ShieldWall, 'id'>): number {
    const id = this.nextShieldId++;
    this.shields.push({ ...sh, id });
    return id;
  }

  /** 参加者を、倒した記録を残さずにすぐ取り除く（自爆した爆弾兵など） */
  despawn(id: number): void {
    if (!this.entities.has(id)) return;
    this.removeEntity(id);
    this.events.push({ type: 'entityRemoved', entityId: id });
  }

  /** パッシブの足音の大きさ（1 が通常） */
  footstepVolumeOf(e: Entity): number {
    return passiveNum(this.ccfg[e.character].PASSIVE, 'FOOTSTEP_VOLUME', 1);
  }
}

export type { Arsenal, PlayerMovement };
