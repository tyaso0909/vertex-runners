/**
 * タワーディフェンス（仕様 5.3）の試合の進み。描画から切り離して、固定 60Hz のシミュレーションと一緒に進む。
 *
 * - 4人チーム（プレイヤー＋味方ボット3体）で、要塞の中央のコアを、10 ウェーブの敵から守る（第5・第10ウェーブはボス）
 * - 各ウェーブの前に 30 秒の準備時間（全員が「準備完了」なら飛ばす）。準備時間中だけタレットを買って置ける・売れる
 * - 敵を倒すとクレジット（倒した参加者に入る。タレットが倒したら、置いた参加者に入る）。ウェーブを守りきると全員にボーナス
 * - 倒されるとダウン。10 秒以内に味方が近くで「調べる」を 3 秒押し続けると蘇生。間に合わなければ、ダウンから 15 秒で要塞の中に復活
 * - 敵は3つの侵入ルート（正面ゲート・左の坂道・右の搬入口）から来る。次のウェーブのルートは準備時間中にわかる
 * - 味方ボットは「人間が足りないときの穴埋めの参加者」として、クレジット・タレット・蘇生・準備完了の決まりをプレイヤーと同じにする（仕様 5.3.4）。
 *   指示は受けず、自分で遊撃する
 * - 購入メニュー（仕様 5.3.5）：タレットのほかに、設置物（ダミーバルーン・ワイヤートラップ・バリケード・ジャンプパッド）、
 *   タレットの強化（レベル 3 まで）、アーマー（そのラウンドだけ。ウェーブ中も買える）を買える
 */
import { type WeaponCustom, randomCustom } from '../weaponCustom';
import {
  type BotDifficulty,
  type BotsConfig,
  CHARACTER_IDS,
  type CharacterId,
  type CharactersConfig,
  GRENADE_IDS,
  type GrenadeId,
  type MovementConfig,
  type TdConfig,
  type TdEnemyType,
  type TdGroupDef,
  type TdRoute,
  type TdDeviceType,
  type TdItemType,
  type TdPlaceable,
  type TurretType,
  TURRET_TYPES,
  isTurretType,
  type WeaponId,
  type WeaponsConfig,
  botsConfig,
  tdConfig,
  tdNum,
} from '../../config';
import { type InputCommand, emptyCommand } from '../input';
import { launch } from '../movement';
import { type TdDropKind, type TdDropZone, type TdLevelDef, type TdRouteDef, ballisticLaunch } from '../level';
import { type Vec3, DEG, add, clone, len, lenH, normalize, scale, sub, v3 } from '../math';
import { type NavGraph, findPath, nearestNode } from '../nav';
import { type Entity, type SimEvent, Simulation, TICK_DT, isStructure } from '../simulation';
import { BotWorld, Rng } from '../bots/botWorld';
import { chestOf, headCenter, rayVsActor } from '../hitbox';
import { TdEnemyBot, mortarAllow } from './enemyBot';
import { BossCtl, DroneCtl, rotY } from './flyers';
import { type RocketBlast, Rockets } from './rockets';
import { type TdBotApi, TdAllyBot, type TdPhaseName } from './allyBot';
import { BARRICADE_THICK, BOSS_BODY, BOSS_COLLIDER, BOSS_HEIGHT, CORE_BODY, CORE_HEIGHT, DRONE_BODY, DRONE_HEIGHT, HEAVY_BODY, TURRET_COLLIDER, TURRET_HEIGHT, TURRET_MUZZLE_Y, barricadeBody, turretBody } from './units';
import { DECOY_HEIGHT, DEVICE_HEIGHT, type Footprint, barricadeEnds, footprintOf, footprintsOverlap, forwardOf, segDist2D, segParam2D, trapNodes } from './devices';
import type { TdEnemyApi } from './enemyBot';

export type TdPhase = TdPhaseName;
export const ROUTE_IDS: readonly TdRoute[] = ['front', 'left', 'right'];

export interface TdParticipant {
  id: number;
  name: string;
  character: CharacterId;
  isPlayer: boolean;
  credits: number;
  /** これまでに得たクレジット */
  earned: number;
  /** 倒した敵の数（タレットが倒した分も含む） */
  kills: number;
  /** そのうちタレットが倒した数 */
  turretKills: number;
  bossKills: number;
  downs: number;
  revives: number;
  turretsBuilt: number;
  /** 買った設置物・強化・アーマーの数 */
  itemsBought: number;
  /** アーマーを買ったウェーブ（そのウェーブが終わるまで効く。買っていなければ 0） */
  armorWave: number;
  ready: boolean;
}

export interface TurretState {
  id: number;
  type: TurretType;
  ownerId: number;
  pos: Vec3;
  /** 砲塔の向き */
  yaw: number;
  pitch: number;
  cooldown: number;
  targetId: number;
  retarget: number;
  boxId: number;
  kills: number;
  /** 修理・減速の効き（描画用。0〜1） */
  pulse: number;
  /** 強化のレベル（1〜3） */
  level: number;
  /** 強化に使ったクレジット（売るときに半分戻る） */
  spent: number;
}

/** 置いた設置物（ダミーバルーン・ワイヤートラップ・バリケード・ジャンプパッド） */
export interface DeviceState {
  /** 設置物の番号（参加者の番号とは別。100000 から） */
  id: number;
  type: TdDeviceType;
  ownerId: number;
  /** 地面の上の中心 */
  pos: Vec3;
  yaw: number;
  /** 撃たれる物（バルーン・バリケード）の参加者の番号。ほかは -1 */
  entityId: number;
  /** バリケードの当たり判定の箱（ほかは -1） */
  boxId: number;
  /** 置いてからの時間 */
  age: number;
  /** バリケードの両端・ワイヤートラップの左右の機雷（地面の上） */
  ends: [Vec3, Vec3] | null;
  /** ワイヤートラップ：3つの機雷（左・中央・右） */
  nodes: Vec3[];
  /** ワイヤートラップ：作動してからの時間（-1：まだ）と、爆発した機雷の数・爆発する順（nodes の番号） */
  fired: number;
  blown: number;
  chain: number[];
  /** ジャンプパッド：参加者ごとの、最後に跳ばした時刻 */
  lastLaunch: Map<number, number>;
}

export interface EnemyRec {
  id: number;
  type: TdEnemyType;
  route: TdRoute;
  /** 進んでいるかの確認（引っかかって動けない敵を見つける）：いまの行き先までの一番近づいた距離と、その時刻 */
  bestDist?: number;
  checkTime?: number;
  checkWp?: number;
  brain?: TdEnemyBot;
  drone?: DroneCtl;
  boss?: BossCtl;
  boxId?: number;
  /** 降下ポッドで降りてきた場所（降下地点の id） */
  zone?: string;
  /** 迫撃砲兵：据える所（TdLevelDef.mortarSpots の番号。なければ -1） */
  spot?: number;
  /** 迫撃砲兵：据えてからの様子（据える前は undefined） */
  mortar?: { setup: number; timer: number; shots: number };
}

/**
 * 迫撃砲の砲弾（仕様 5.3.3）。迫撃砲兵が据えた所からコアへ、高い放物線で飛ぶ。
 * 地面・建物に当たるか、狙った高さより下まで落ちると爆発する（コアの近くならコアにダメージ。まわりの味方にも）
 */
export interface MortarShell {
  id: number;
  ownerId: number;
  pos: Vec3;
  vel: Vec3;
  /** 撃った所・狙った所（落ちる所）・重力・撃った時刻・飛ぶ時間 */
  from: Vec3;
  target: Vec3;
  gravity: number;
  born: number;
  flight: number;
}

/**
 * 降下ポッド（仕様 5.3.3）。地上の敵は、分隊ごとにポッドで降りてくる。
 * 着地の WARN 秒前に降りる場所がわかり（地面の印・ミニマップ・通知）、着地すると近くを吹き飛ばし、扉が開いて分隊が出てくる。
 * しばらくすると、ポッドは空へ戻っていく
 */
export interface PodState {
  id: number;
  zone: TdDropZone;
  /** 着地点（床の上） */
  pos: Vec3;
  type: TdEnemyType;
  /** 乗っている敵の数 */
  count: number;
  /** 降りてくるのが分かった時刻・着地・扉が開く・飛び去る時刻（sim.time） */
  warnAt: number;
  landAt: number;
  openAt: number;
  leaveAt: number;
  landed: boolean;
  opened: boolean;
  /** 着地してから飛び去るまでの当たり判定の箱（ほかは -1） */
  boxId: number;
  /** 出てきた敵の番号 */
  spawned: number[];
}

/** ポッドの当たり判定（幅・高さ） */
export const POD_SIZE = v3(1.9, 3.1, 1.9);

/** 準備時間に分かる、次のウェーブの降下地点（グループごと） */
export interface PlannedDrop {
  zone: TdDropZone;
  type: TdEnemyType;
  count: number;
}

export type TdEvent =
  | { type: 'phase'; phase: TdPhase; wave: number }
  | { type: 'waveStart'; wave: number; routes: TdRoute[]; boss: boolean }
  | { type: 'waveClear'; wave: number; bonus: number }
  | { type: 'credits'; pid: number; amount: number; reason: 'kill' | 'turretKill' | 'bonus' | 'sell'; enemy?: TdEnemyType }
  | { type: 'devicePlaced'; deviceId: number; device: TdDeviceType; ownerId: number; pos: Vec3; yaw: number }
  | { type: 'deviceRemoved'; deviceId: number; device: TdDeviceType; ownerId: number; reason: 'sold' | 'destroyed' | 'used' }
  | { type: 'trapTriggered'; deviceId: number }
  | { type: 'trapExplode'; deviceId: number; pos: Vec3; radius: number }
  | { type: 'jumpPad'; deviceId: number; entityId: number }
  | { type: 'turretUpgraded'; turretId: number; ownerId: number; level: number }
  | { type: 'armorBought'; pid: number; amount: number }
  | { type: 'enemySpawn'; id: number; enemy: TdEnemyType; route: TdRoute }
  | { type: 'enemyKilled'; id: number; enemy: TdEnemyType; killerId: number; ownerId: number; head: boolean }
  | { type: 'turretPlaced'; turretId: number; turret: TurretType; ownerId: number; pos: Vec3; yaw: number }
  | { type: 'turretSold'; turretId: number; ownerId: number; refund: number }
  | { type: 'turretDestroyed'; turretId: number; ownerId: number }
  | { type: 'turretFire'; turretId: number; turret: TurretType; from: Vec3; to: Vec3; hit: 'actor' | 'world' | 'none' }
  | { type: 'rocketLaunch'; rocketId: number; from: Vec3; vel: Vec3; boss: boolean }
  | { type: 'rocketExplode'; rocketId: number; pos: Vec3; radius: number }
  | { type: 'assaultExplode'; pos: Vec3 }
  | { type: 'mortarDeploy'; id: number; pos: Vec3; spotName: string; sector: TdRoute }
  | { type: 'mortarFire'; id: number; shellId: number; from: Vec3; target: Vec3; flight: number }
  | { type: 'mortarExplode'; shellId: number; pos: Vec3; radius: number; core: boolean }
  | { type: 'repairPulse'; turretId: number }
  | { type: 'coreDamaged'; amount: number; health: number }
  | { type: 'coreAlert' }
  | { type: 'downed'; entityId: number }
  | { type: 'revived'; entityId: number; byId: number }
  | { type: 'bleedout'; entityId: number }
  | { type: 'bossStep'; id: number; pos: Vec3 }
  | { type: 'podIncoming'; podId: number; pos: Vec3; zone: string; zoneName: string; kind: TdDropKind; sector: TdRoute; eta: number; enemy: TdEnemyType; count: number }
  | { type: 'podLand'; podId: number; pos: Vec3 }
  | { type: 'podOpen'; podId: number; pos: Vec3 }
  | { type: 'podLeave'; podId: number; pos: Vec3 };

export interface TdResult {
  victory: boolean;
  /** 守りきったウェーブの数 */
  wavesCleared: number;
  totalWaves: number;
  coreHealth: number;
  coreMax: number;
  duration: number;
  participants: TdParticipant[];
  enemiesKilled: number;
  difficulty: BotDifficulty;
}

export interface TdOptions {
  difficulty: BotDifficulty;
  seed?: number;
  playerName?: string;
  playerCharacter?: CharacterId;
  playerLoadout?: [WeaponId, WeaponId];
  /** プレイヤーの武器のカスタマイズ（メイン・サブ） */
  playerCustom?: [WeaponCustom?, WeaponCustom?];
  /** プレイヤーのグレネードの種類 */
  playerGrenade?: GrenadeId;
  /** false なら、プレイヤーの枠もボットにする（自動テスト・確認用） */
  humanPlayer?: boolean;
  /** 参加人数（敵の量の倍率に使う。いまは常に4。将来のオンライン用） */
  players?: number;
  /** このウェーブから始める（確認用。1 から） */
  startWave?: number;
  /** false なら、味方ボットはタレットしか買わない（確認用） */
  botItems?: boolean;
}

export interface PlaceCheck {
  ok: boolean;
  /** 置けない理由（画面に出す） */
  reason?: string;
  /** 地面に合わせた位置 */
  pos?: Vec3;
  /** 置く向き（タレットはコアの外向き） */
  yaw?: number;
  /** バリケードの両端・ワイヤートラップの左右の機雷 */
  ends?: [Vec3, Vec3];
  /** ワイヤートラップの3つの機雷 */
  nodes?: Vec3[];
}

/** 買えるか（アーマー・強化） */
export interface BuyCheck {
  ok: boolean;
  reason?: string;
  cost: number;
}

const ALLY_NAMES = ['ハヤテ', 'シグレ', 'ツバメ', 'ライカ', 'スバル', 'アカツキ', 'カゲロウ', 'ミズチ'];
/** 味方ボットの装備（タワーディフェンス向き：数の多い敵をさばく） */
const ALLY_LOADOUTS: Array<[WeaponId, WeaponId]> = [
  ['ar', 'shotgun'],
  ['lmg', 'smg'],
  ['ar', 'sniper'],
  ['lmg', 'shotgun'],
  ['smg', 'ar'],
  ['sniper', 'pistol'],
  ['spinlmg', 'autosg'],
  ['burst', 'psmg'],
  ['marksman', 'autosg'],
  ['spinlmg', 'revolver'],
];

interface GroupRun {
  def: TdGroupDef;
  remaining: number;
  timer: number;
  /** 降下ポッドの降りる場所（地上の敵。ドローン・大型兵器は null） */
  zone: TdDropZone | null;
}

const GROUND_TYPES: readonly TdEnemyType[] = ['grunt', 'assault', 'heavy', 'mortar'];
/** 経路のデータごとの、降下地点 → 迫撃砲兵が行ける据える所（調べるのに 0.3 秒ほどかかるので、試合をまたいで使い回す） */
const SPOT_REACH = new WeakMap<NavGraph, Map<string, Set<number>>>();
const DROP_KINDS: readonly string[] = ['outer', 'wall', 'inner'];

export class TdMatch implements TdBotApi {
  readonly bw: BotWorld;
  readonly td: TdLevelDef;
  phase: TdPhase = 'intro';
  phaseTime = 0;
  /** いまのウェーブ（1〜。準備中は次のウェーブ） */
  wave = 1;
  /** 準備時間の残り */
  prepLeft = 0;
  elapsed = 0;
  readonly core: Entity;
  readonly player: Entity | null = null;
  readonly participants = new Map<number, TdParticipant>();
  readonly allies = new Map<number, TdAllyBot>();
  readonly enemies = new Map<number, EnemyRec>();
  readonly turrets = new Map<number, TurretState>();
  readonly devices = new Map<number, DeviceState>();
  /** 撃たれる設置物の参加者の番号 → 設置物の番号 */
  private readonly deviceByEntity = new Map<number, number>();
  private nextDeviceId = 100000;
  readonly rockets = new Rockets();
  /** 降りてきている・降りた降下ポッド */
  readonly pods = new Map<number, PodState>();
  /** 飛んでいる迫撃砲の砲弾 */
  readonly shells = new Map<number, MortarShell>();
  private nextShellId = 1;
  /** これまでに出た迫撃砲兵（倒されたあとに落ちた砲弾も、迫撃砲のダメージと分かるように） */
  private readonly mortarIds = new Set<number>();
  /** 降下地点ごとの、迫撃砲兵が歩いて行ける据える所（番号の集まり。経路のデータごとに 1 度だけ、試合を作るときに調べる） */
  private readonly spotReach: Map<string, Set<number>>;
  /** 迫撃砲兵を倒しに行っている味方のボット（迫撃砲兵の番号 → ボットの番号 → 時刻） */
  private readonly huntClaims = new Map<number, Map<number, { t: number; d: number }>>();
  private nextPodId = 1;
  /** 次のウェーブのグループごとの降下地点（準備時間の始めに決める） */
  private planned: Array<TdDropZone | null> = [];
  private plannedWave = -1;
  events: TdEvent[] = [];
  result: TdResult | null = null;
  enemiesKilled = 0;
  /** 長い間動けなくなって取り除いた敵の数（ふつうは 0。確認用） */
  stuckRemoved = 0;
  private stuckTimer = 0;
  private readonly rng: Rng;
  private groups: GroupRun[] = [];
  private lastCoreHit = -99;
  private lastCoreAlert = -99;
  private readonly reviveClaims = new Map<number, number>();
  private readonly buildClaims = new Map<number, { pos: Vec3; time: number }>();
  private repairTimer = 0;
  private readonly countScale: number;
  private readonly healthScale: number;

  constructor(
    readonly sim: Simulation,
    readonly nav: NavGraph,
    readonly opts: TdOptions,
    readonly cfg: TdConfig = tdConfig,
    readonly bots: BotsConfig = botsConfig,
  ) {
    const td = sim.level.td;
    if (!td) throw new Error('このステージにはタワーディフェンスの情報がない');
    this.td = td;
    const seed = opts.seed ?? 2026;
    this.rng = new Rng(seed);
    this.bw = new BotWorld(sim, nav, seed ^ 0x7d1, td.core);
    this.bw.pathsPerTick = 5;
    // 迫撃砲兵の据える所へ行けるか（降下地点ごと）を先に調べておく（試合の途中で調べると、その瞬間が重くなる）
    let reach = SPOT_REACH.get(nav);
    if (!reach) SPOT_REACH.set(nav, (reach = new Map()));
    this.spotReach = reach;
    for (const z of td.dropZones ?? []) this.reachableSpots(z);
    const ps = cfg.PLAYER_SCALE[String(Math.max(1, Math.min(4, opts.players ?? 4))) as '4'];
    const diff = cfg.DIFFICULTY[opts.difficulty];
    this.countScale = ps.COUNT * diff.ENEMY_COUNT;
    this.healthScale = ps.HEALTH * diff.ENEMY_HEALTH;

    sim.soloTeam = false;
    sim.rules = {
      // パイロットはダウンから 15 秒で復活（ダウンの 10 秒＋倒れてから 5 秒）。敵・タレットは復活しない
      respawnTime: (e) => (e.kind === 'pilot' && e.team === 0 ? Math.max(0.5, cfg.RESPAWN_TIME - cfg.DOWN_TIME) : null),
      pickSpawn: (e) => this.pickSpawn(e),
      spawnInvuln: 2,
      assistWindow: 5,
      downOnLethal: (e) => e.kind === 'pilot' && e.team === 0,
      downTime: cfg.DOWN_TIME,
      reviveTime: cfg.REVIVE_TIME,
      reviveRange: cfg.REVIVE_RANGE,
      reviveHealth: cfg.REVIVE_HEALTH,
      // タレット・バリケードは装甲で、銃弾のダメージを減らす（爆発はそのまま）
      damageScale: (v, source) => (source !== 'shot' ? 1 : v.kind === 'turret' ? cfg.TURRET_ARMOR : v.kind === 'barricade' ? tdNum(cfg.ITEMS.barricade, 'ARMOR', 0.5) : 1),
    };

    // コア
    this.core = sim.spawnPlayer('コア', ['ar', 'smg'], 'meia', {
      team: 0,
      kind: 'core',
      pos: clone(td.core),
      yaw: 0,
      maxHealth: cfg.CORE_HEALTH,
      body: CORE_BODY,
      kinematic: true,
      regen: false,
      height: CORE_HEIGHT,
    });

    // 参加者（プレイヤー＋味方ボット3体。ボットのキャラクターはプレイヤーと重ならない）
    const human = opts.humanPlayer !== false;
    const spawns = (sim.level.spawns ?? []).filter((s) => s.team === 0);
    const sp = (i: number) => spawns[i % Math.max(1, spawns.length)] ?? { pos: sim.level.spawn, yaw: sim.level.spawnYaw };
    const used = new Set<CharacterId>();
    let slot = 0;
    if (human) {
      const s0 = sp(0);
      const ch = opts.playerCharacter ?? 'meia';
      const p = sim.spawnPlayer(opts.playerName ?? 'あなた', opts.playerLoadout ?? ['ar', 'shotgun'], ch, { team: 0, pos: s0.pos, yaw: s0.yaw, custom: opts.playerCustom, grenade: opts.playerGrenade });
      (this as { player: Entity | null }).player = p;
      used.add(ch);
      this.addParticipant(p, true);
      slot++;
    }
    // 人間が足りない枠を、ボットで埋める
    while (slot < 4) {
      const free = CHARACTER_IDS.filter((c) => !used.has(c));
      const ch = this.rng.pick(free.length ? free : CHARACTER_IDS);
      used.add(ch);
      const s = sp(slot);
      const name = ALLY_NAMES[(seed + slot * 3) % ALLY_NAMES.length];
      const lo = this.rng.pick(ALLY_LOADOUTS);
      // サイトとアタッチメントもランダム（ほかの判断の乱数の並びを変えないよう、別の乱数で選ぶ）
      const cr = new Rng((seed ^ 0x5eed1c) + slot * 7919);
      const next = () => cr.next();
      const custom: [WeaponCustom, WeaponCustom] = [randomCustom(sim.wcfg[lo[0]], next), randomCustom(sim.wcfg[lo[1]], next)];
      const grenade = GRENADE_IDS[Math.floor(cr.next() * GRENADE_IDS.length) % GRENADE_IDS.length];
      const e = sim.spawnPlayer(name, lo, ch, { team: 0, pos: s.pos, yaw: s.yaw, custom, grenade });
      const brain = new TdAllyBot(e.id, this.bw, sim.cfg, sim.wcfg, bots.normal, (sim.ccfg as CharactersConfig)[ch], seed * 977 + e.id * 31337, this);
      brain.setAim(s.yaw, 0);
      this.allies.set(e.id, brain);
      this.addParticipant(e, false);
      slot++;
    }
    if (opts.startWave) this.wave = Math.max(1, Math.min(this.totalWaves, opts.startWave));
  }

  get totalWaves(): number {
    return this.cfg.WAVES.length;
  }

  private addParticipant(e: Entity, isPlayer: boolean) {
    this.participants.set(e.id, {
      id: e.id,
      name: e.name,
      character: e.character,
      isPlayer,
      credits: this.cfg.START_CREDITS,
      earned: 0,
      kills: 0,
      turretKills: 0,
      bossKills: 0,
      downs: 0,
      revives: 0,
      turretsBuilt: 0,
      itemsBought: 0,
      armorWave: 0,
      ready: false,
    });
  }

  // ---------------------------------------------------------------------------
  // 味方ボットから見た様子（TdBotApi）
  // ---------------------------------------------------------------------------

  currentPhase(): TdPhase {
    return this.phase;
  }
  route(id: TdRoute): TdRouteDef {
    return this.td.routes.find((r) => r.id === id)!;
  }
  enemiesOn(route: TdRoute): number {
    let n = 0;
    for (const r of this.enemies.values()) if (r.route === route) n++;
    for (const g of this.groups) if (g.def.route === route) n += g.remaining;
    for (const p of this.pods.values()) if (!p.opened && p.zone.sector === route) n += p.count;
    return n;
  }
  /** いまのウェーブ（準備中は次のウェーブ）で敵が来るルート */
  waveRoutes(): TdRoute[] {
    const w = this.cfg.WAVES[this.wave - 1];
    if (!w) return [];
    return ROUTE_IDS.filter((r) => w.groups.some((g) => g.route === r));
  }
  incomingPods(): Array<{ pos: Vec3; eta: number; radius: number }> {
    const out: Array<{ pos: Vec3; eta: number; radius: number }> = [];
    for (const p of this.pods.values()) if (!p.landed) out.push({ pos: p.pos, eta: p.landAt - this.sim.time, radius: this.cfg.POD.IMPACT_RADIUS });
    return out;
  }
  /** いまのウェーブにボスが出るか */
  waveHasBoss(): boolean {
    return !!this.cfg.WAVES[this.wave - 1]?.groups.some((g) => g.type === 'boss');
  }
  coreUnderAttack(): boolean {
    return this.sim.time - this.lastCoreHit < this.cfg.CORE_ALERT_TIME;
  }
  corePos(): Vec3 {
    return this.td.core;
  }
  downedAllies(team: number): Entity[] {
    const out: Entity[] = [];
    for (const e of this.sim.entities.values()) if (e.team === team && e.kind === 'pilot' && e.downed > 0) out.push(e);
    return out;
  }
  reviveClaimed(targetId: number, by: number): boolean {
    const c = this.reviveClaims.get(targetId);
    if (c === undefined || c === by) return false;
    const b = this.sim.entities.get(c);
    const brain = this.allies.get(c);
    return !!b && !b.dead && b.downed <= 0 && brain?.mode === 'revive';
  }
  claimRevive(targetId: number, by: number): void {
    this.reviveClaims.set(targetId, by);
  }
  credits(pid: number): number {
    return this.participants.get(pid)?.credits ?? 0;
  }
  turretCount(pid: number): number {
    let n = 0;
    for (const t of this.turrets.values()) if (t.ownerId === pid) n++;
    return n;
  }
  turretLimit(): number {
    return this.cfg.TURRET_LIMIT;
  }
  turretCost(type: TurretType): number {
    return this.cfg.TURRETS[type].COST;
  }
  canPlace(pid: number, kind: TdPlaceable, pos: Vec3, yaw = 0): boolean {
    return this.placeCheck(pid, kind, pos, yaw).ok;
  }
  occupied(pos: Vec3, r: number): boolean {
    for (const t of this.turrets.values()) if (lenH(sub(t.pos, pos)) < r) return true;
    for (const d of this.devices.values()) if (segDist2D(pos, d.ends ? d.ends[0] : d.pos, d.ends ? d.ends[1] : d.pos) < r) return true;
    return false;
  }
  deviceNear(type: TdDeviceType, pos: Vec3, r: number): boolean {
    for (const d of this.devices.values()) if (d.type === type && lenH(sub(d.pos, pos)) < r) return true;
    return false;
  }
  myTurrets(pid: number): TurretState[] {
    return [...this.turrets.values()].filter((t) => t.ownerId === pid);
  }
  buildArea(): { min: Vec3; max: Vec3 } {
    return this.td.buildArea;
  }
  botItems(): boolean {
    return this.opts.botItems !== false;
  }
  markReady(pid: number): void {
    const p = this.participants.get(pid);
    if (p && this.phase === 'prep') p.ready = true;
  }
  enemyList(): Array<{ pos: Vec3; route: TdRoute; type: TdEnemyType }> {
    const out: Array<{ pos: Vec3; route: TdRoute; type: TdEnemyType }> = [];
    for (const r of this.enemies.values()) {
      const e = this.sim.entities.get(r.id);
      if (e && !e.dead) out.push({ pos: e.movement.pos, route: r.route, type: r.type });
    }
    // 降りてくる途中の降下ポッドの中の敵も、降りる所にいるとみなす（味方のボットが先に駆けつけられるように）
    for (const p of this.pods.values()) if (!p.opened) for (let i = 0; i < p.count; i++) out.push({ pos: p.pos, route: p.zone.sector, type: p.type });
    return out;
  }
  /** 据えた迫撃砲兵（位置・ルート。ミニマップと画面の印で人間にも見えている） */
  mortars(): Array<{ id: number; pos: Vec3; route: TdRoute; firing: boolean }> {
    const out: Array<{ id: number; pos: Vec3; route: TdRoute; firing: boolean }> = [];
    for (const r of this.enemies.values()) {
      if (r.type !== 'mortar' || !r.mortar) continue;
      const e = this.sim.entities.get(r.id);
      if (e && !e.dead) out.push({ id: r.id, pos: e.movement.pos, route: r.route, firing: r.mortar.setup <= 0 && !r.brain?.busy });
    }
    return out;
  }
  /** その迫撃砲兵を倒しに行っている、自分以外の味方のボットの数（closerThan を渡すと、それより近くにいるボットだけ数える） */
  huntersOf(mortarId: number, by: number, closerThan = Infinity): number {
    const m = this.huntClaims.get(mortarId);
    if (!m) return 0;
    let n = 0;
    for (const [id, c] of m) if (id !== by && this.sim.time - c.t < 1.5 && c.d < closerThan) n++;
    return n;
  }
  claimHunt(mortarId: number, by: number, dist: number): void {
    let m = this.huntClaims.get(mortarId);
    if (!m) this.huntClaims.set(mortarId, (m = new Map()));
    // ほかの迫撃砲兵への申し込みは取り消す（1人 1体）
    for (const [id, o] of this.huntClaims) if (id !== mortarId) o.delete(by);
    m.set(by, { t: this.sim.time, d: dist });
  }
  teammates(): Array<{ id: number; pos: Vec3; focus: TdRoute | null; alive: boolean }> {
    const out: Array<{ id: number; pos: Vec3; focus: TdRoute | null; alive: boolean }> = [];
    for (const p of this.participants.values()) {
      const e = this.sim.entities.get(p.id);
      if (!e) continue;
      const b = this.allies.get(p.id);
      out.push({ id: p.id, pos: e.movement.pos, focus: b ? (b.defendingCore ? null : b.focus) : null, alive: !e.dead && e.downed <= 0 });
    }
    return out;
  }
  claimBuild(pos: Vec3, by: number): void {
    this.buildClaims.set(by, { pos: clone(pos), time: this.sim.time });
  }
  buildClaimed(pos: Vec3, by: number): boolean {
    for (const [id, c] of this.buildClaims) if (id !== by && this.sim.time - c.time < 12 && lenH(sub(c.pos, pos)) < this.cfg.PLACE_GAP + 0.5) return true;
    return false;
  }
  turretsNearAny(points: Vec3[], r: number): Partial<Record<TurretType, number>> {
    const out: Partial<Record<TurretType, number>> = {};
    for (const t of this.turrets.values()) if (points.some((p) => lenH(sub(t.pos, p)) < r)) out[t.type] = (out[t.type] ?? 0) + 1;
    return out;
  }

  // ---------------------------------------------------------------------------
  // プレイヤーの操作（将来はサーバーへ送る指示）
  // ---------------------------------------------------------------------------

  /** 準備完了（全員そろうと準備時間を飛ばす） */
  setReady(pid: number): void {
    this.markReady(pid);
  }

  /** 置けるか（場所を地面に合わせて返す）。yaw はバリケード・ワイヤートラップ・バルーンの向き（タレットはコアの外向きに決まる） */
  placeCheck(pid: number, kind: TdPlaceable, at: Vec3, yaw = 0): PlaceCheck {
    const p = this.participants.get(pid);
    const turret = isTurretType(kind);
    const def = turret ? this.cfg.TURRETS[kind] : this.cfg.ITEMS[kind];
    if (!p || !def) return { ok: false, reason: '置けない' };
    if (this.phase !== 'prep') return { ok: false, reason: '準備時間中だけ置ける' };
    if (turret) {
      if (this.turretCount(pid) >= this.cfg.TURRET_LIMIT) return { ok: false, reason: `タレットは1人 ${this.cfg.TURRET_LIMIT} 基まで` };
    } else {
      const lim = this.cfg.ITEMS[kind as TdDeviceType].LIMIT;
      if (this.deviceCount(pid, kind as TdDeviceType) >= lim) return { ok: false, reason: `${def.NAME}は1人 ${lim} つまで` };
    }
    if (p.credits < def.COST) return { ok: false, reason: 'クレジットが足りない' };
    const a = this.td.buildArea;
    if (at.x < a.min.x || at.x > a.max.x || at.z < a.min.z || at.z > a.max.z || at.y < a.min.y || at.y > a.max.y) return { ok: false, reason: '要塞の中に置く' };
    const world = this.sim.world;
    const g = world.raycast(v3(at.x, at.y + 1.2, at.z), v3(0, -1, 0), 3);
    if (!g || g.normal.y < 0.95) return { ok: false, reason: '平らな地面に置く' };
    const y = g.point.y;
    const pos = v3(at.x, y, at.z);
    // 平らか（まわりの地面の高さがそろっている）
    const flat = (pts: Array<[number, number]>, tol: number) => {
      for (const [dx, dz] of pts) {
        const h = world.raycast(v3(pos.x + dx, y + 0.6, pos.z + dz), v3(0, -1, 0), 1.2);
        if (!h || Math.abs(h.point.y - y) > tol) return false;
      }
      return true;
    };
    const ring = (r: number): Array<[number, number]> => [
      [r, r],
      [-r, r],
      [r, -r],
      [-r, -r],
    ];
    let ends: [Vec3, Vec3] | undefined;
    let nodes: Vec3[] | undefined;
    let outYaw = yaw;
    if (turret) {
      if (!flat(ring(0.65), 0.12)) return { ok: false, reason: '平らな地面に置く' };
      if (world.blocked(v3(pos.x, y + 0.75, pos.z), v3(pos.x, y + 1.5, pos.z), 0.72, 0.02)) return { ok: false, reason: '狭すぎる' };
      const out = sub(pos, this.td.core);
      outYaw = Math.atan2(-out.x, -out.z);
    } else if (kind === 'barricade') {
      ends = barricadeEnds(pos, yaw, tdNum(def, 'WIDTH', 4.2));
      // 幅いっぱいに地面があって、ほぼ平ら。壁にめり込まない
      const n = 6;
      for (let i = 0; i <= n; i++) {
        const q = v3(ends[0].x + ((ends[1].x - ends[0].x) * i) / n, y, ends[0].z + ((ends[1].z - ends[0].z) * i) / n);
        const h = world.raycast(v3(q.x, y + 0.6, q.z), v3(0, -1, 0), 1.2);
        if (!h || Math.abs(h.point.y - y) > 0.2) return { ok: false, reason: '平らな地面に置く' };
        if (world.blocked(v3(q.x, y + 0.45, q.z), v3(q.x, y + 1.0, q.z), 0.2, 0.02)) return { ok: false, reason: '壁に近すぎる' };
      }
    } else if (kind === 'wiretrap') {
      const tn = trapNodes(world, pos, yaw, tdNum(def, 'SPAN', 3.6), tdNum(def, 'BEAM_HEIGHT', 0.62));
      if (!tn) return { ok: false, reason: '左右が狭すぎる' };
      nodes = tn;
      ends = [tn[0], tn[2]];
    } else {
      const r = kind === 'jumppad' ? 0.75 : 0.35;
      if (!flat(ring(r), 0.12)) return { ok: false, reason: '平らな地面に置く' };
      // 上が空いているか（カプセルの下の端が地面に触れない高さから）
      const lo = y + r + 0.08;
      if (world.blocked(v3(pos.x, lo, pos.z), v3(pos.x, Math.max(lo + 0.1, y + DEVICE_HEIGHT[kind as TdDeviceType]), pos.z), r * 0.9, 0.02)) return { ok: false, reason: '狭すぎる' };
    }
    if (lenH(sub(pos, this.td.core)) < (kind === 'jumppad' ? 4.5 : 6.5)) return { ok: false, reason: 'コアに近すぎる' };
    // ほかのタレット・設置物と重ならない
    const mine = footprintOf(kind, pos, outYaw, ends);
    for (const t of this.turrets.values()) {
      if (Math.abs(t.pos.y - pos.y) > 2) continue;
      if (footprintsOverlap(mine, footprintOf(t.type, t.pos, t.yaw), turret ? 0 : 0)) return { ok: false, reason: 'ほかのタレットに近すぎる' };
    }
    for (const d of this.devices.values()) {
      if (Math.abs(d.pos.y - pos.y) > 2) continue;
      if (footprintsOverlap(mine, this.footprintOfDevice(d))) return { ok: false, reason: 'ほかの設置物に近すぎる' };
    }
    // 人の上には置けない（ジャンプパッド・ワイヤートラップは足元に置ける）
    if (kind !== 'jumppad' && kind !== 'wiretrap') {
      for (const e of this.sim.entities.values()) {
        if (e.dead || isStructure(e) || e.kind === 'decoy') continue;
        const dy = e.movement.pos.y - pos.y;
        if (dy < -1.5 || dy > 2) continue;
        const dist = ends ? segDist2D(e.movement.pos, ends[0], ends[1]) : lenH(sub(e.movement.pos, pos));
        if (dist < (turret ? 1.3 : 0.8)) return { ok: false, reason: '人がいる' };
      }
    }
    for (const s of this.sim.level.spawns ?? []) {
      const dist = ends ? segDist2D(s.pos, ends[0], ends[1]) : lenH(sub(s.pos, pos));
      if (dist < 2) return { ok: false, reason: '出現地点の上には置けない' };
    }
    return { ok: true, pos, yaw: outYaw, ends, nodes };
  }

  private footprintOfDevice(d: DeviceState): Footprint {
    return footprintOf(d.type, d.pos, d.yaw, d.ends ?? undefined);
  }

  /** 置く（置く人の近くでなければ置けない） */
  tryPlace(pid: number, kind: TdPlaceable, at: Vec3, yaw = 0): boolean {
    const chk = this.placeCheck(pid, kind, at, yaw);
    const who = this.sim.entities.get(pid);
    if (!chk.ok || !chk.pos || !who || who.dead || who.downed > 0) return false;
    if (lenH(sub(chk.pos, who.movement.pos)) > this.cfg.PLACE_RANGE + 0.5) return false;
    if (isTurretType(kind)) this.placeTurret(pid, kind, chk.pos);
    else this.placeDevice(pid, kind, chk);
    this.buildClaims.delete(pid);
    return true;
  }

  private placeTurret(pid: number, type: TurretType, pos: Vec3) {
    const def = this.cfg.TURRETS[type];
    const out = sub(pos, this.td.core);
    const yaw = Math.atan2(-out.x, -out.z);
    const e = this.sim.spawnPlayer(def.NAME, ['ar', 'smg'], 'meia', {
      team: 0,
      kind: 'turret',
      pos,
      yaw,
      maxHealth: def.HEALTH,
      body: turretBody(type),
      kinematic: true,
      regen: false,
      ownerId: pid,
      height: TURRET_HEIGHT,
    });
    e.facing = 0;
    const boxId = this.sim.addDynamicBox(v3(pos.x, pos.y + TURRET_COLLIDER.y / 2, pos.z), TURRET_COLLIDER);
    this.turrets.set(e.id, { id: e.id, type, ownerId: pid, pos, yaw, pitch: 0, cooldown: 0.5, targetId: -1, retarget: 0, boxId, kills: 0, pulse: 0, level: 1, spent: 0 });
    const p = this.participants.get(pid)!;
    p.credits -= def.COST;
    p.turretsBuilt++;
    this.events.push({ type: 'turretPlaced', turretId: e.id, turret: type, ownerId: pid, pos: clone(pos), yaw });
  }

  private placeDevice(pid: number, type: TdDeviceType, chk: PlaceCheck) {
    const def = this.cfg.ITEMS[type];
    const pos = chk.pos!;
    const yaw = chk.yaw ?? 0;
    const d: DeviceState = {
      id: this.nextDeviceId++,
      type,
      ownerId: pid,
      pos: clone(pos),
      yaw,
      entityId: -1,
      boxId: -1,
      age: 0,
      ends: chk.ends ? [clone(chk.ends[0]), clone(chk.ends[1])] : null,
      nodes: chk.nodes ? chk.nodes.map(clone) : [],
      fired: -1,
      blown: 0,
      chain: [],
      lastLaunch: new Map(),
    };
    const owner = this.sim.entities.get(pid);
    if (type === 'decoy') {
      // 囮：パイロットと同じ大きさの、撃たれる参加者（動かない・撃たない）
      const e = this.sim.spawnPlayer(def.NAME, ['ar', 'smg'], owner?.character ?? 'meia', {
        team: 0,
        kind: 'decoy',
        pos,
        yaw,
        maxHealth: tdNum(def, 'HEALTH', 320),
        kinematic: true,
        regen: false,
        ownerId: pid,
        height: DECOY_HEIGHT,
        eyeY: 1.6,
      });
      e.facing = yaw;
      d.entityId = e.id;
    } else if (type === 'barricade') {
      const W = tdNum(def, 'WIDTH', 4.2);
      const H = tdNum(def, 'HEIGHT', 1.25);
      const e = this.sim.spawnPlayer(def.NAME, ['ar', 'smg'], 'meia', {
        team: 0,
        kind: 'barricade',
        pos,
        yaw,
        maxHealth: tdNum(def, 'HEALTH', 1200),
        body: barricadeBody(W, H),
        kinematic: true,
        regen: false,
        ownerId: pid,
        height: H,
      });
      e.facing = yaw;
      d.entityId = e.id;
      d.boxId = this.sim.addDynamicBox(v3(pos.x, pos.y + H / 2, pos.z), v3(W, H, BARRICADE_THICK), (yaw * 180) / Math.PI);
    }
    if (d.entityId >= 0) this.deviceByEntity.set(d.entityId, d.id);
    this.devices.set(d.id, d);
    const p = this.participants.get(pid)!;
    p.credits -= def.COST;
    p.itemsBought++;
    this.events.push({ type: 'devicePlaced', deviceId: d.id, device: type, ownerId: pid, pos: clone(pos), yaw });
  }

  /** 売る（準備時間中・自分のもの。使ったクレジットの半分が戻る）。id はタレット（参加者の番号）か設置物の番号 */
  trySell(pid: number, id: number): boolean {
    if (this.phase !== 'prep') return false;
    const t = this.turrets.get(id);
    if (t) {
      if (t.ownerId !== pid) return false;
      const refund = this.refundOf(t.id);
      this.removeTurret(t);
      this.sim.despawn(t.id);
      const p = this.participants.get(pid);
      if (p) p.credits += refund;
      this.events.push({ type: 'turretSold', turretId: id, ownerId: pid, refund });
      this.events.push({ type: 'credits', pid, amount: refund, reason: 'sell' });
      return true;
    }
    const d = this.devices.get(id);
    if (!d || d.ownerId !== pid || d.fired >= 0) return false;
    const refund = this.refundOf(d.id);
    this.removeDevice(d, 'sold');
    const p = this.participants.get(pid);
    if (p) p.credits += refund;
    this.events.push({ type: 'credits', pid, amount: refund, reason: 'sell' });
    return true;
  }

  /** 売ったときに戻るクレジット */
  refundOf(id: number): number {
    const t = this.turrets.get(id);
    if (t) return Math.floor((this.cfg.TURRETS[t.type].COST + t.spent) * this.cfg.SELL_REFUND);
    const d = this.devices.get(id);
    if (d) return Math.floor(this.cfg.ITEMS[d.type].COST * this.cfg.SELL_REFUND);
    return 0;
  }

  private removeTurret(t: TurretState) {
    this.turrets.delete(t.id);
    this.sim.removeDynamicBox(t.boxId);
  }

  /** 設置物を取り除く（売った・壊された・使い終わった） */
  private removeDevice(d: DeviceState, reason: 'sold' | 'destroyed' | 'used') {
    if (!this.devices.has(d.id)) return;
    this.devices.delete(d.id);
    if (d.boxId >= 0) this.sim.removeDynamicBox(d.boxId);
    if (d.entityId >= 0) {
      this.deviceByEntity.delete(d.entityId);
      const e = this.sim.entities.get(d.entityId);
      if (e && !e.dead) this.sim.despawn(d.entityId);
    }
    this.events.push({ type: 'deviceRemoved', deviceId: d.id, device: d.type, ownerId: d.ownerId, reason });
  }

  /** 撃たれる設置物（バルーン・バリケード）の参加者の番号から、設置物を探す */
  deviceOfEntity(entityId: number): DeviceState | undefined {
    const id = this.deviceByEntity.get(entityId);
    return id === undefined ? undefined : this.devices.get(id);
  }

  deviceCount(pid: number, type: TdDeviceType): number {
    let n = 0;
    for (const d of this.devices.values()) if (d.ownerId === pid && d.type === type) n++;
    return n;
  }

  itemCost(type: TdItemType): number {
    return this.cfg.ITEMS[type].COST;
  }

  // --- タレットの強化 ---

  /** 強化のレベルの倍率（配列はレベルの順） */
  private lv(t: TurretState, arr: number[]): number {
    return arr[Math.max(0, Math.min(arr.length - 1, t.level - 1))] ?? 1;
  }

  /** 強化したタレットの数値（射程・威力・間隔・範囲など） */
  turretStat(t: TurretState, key: string, def = 0): number {
    const u = this.cfg.UPGRADE;
    const base = tdNum(this.cfg.TURRETS[t.type], key, def);
    switch (key) {
      case 'RANGE':
        return base * this.lv(t, u.RANGE_MUL);
      case 'DAMAGE':
      case 'MIN_DAMAGE':
        return base * this.lv(t, u.DAMAGE_MUL);
      case 'FIRE_INTERVAL':
        return base * this.lv(t, u.INTERVAL_MUL);
      case 'RADIUS':
        return t.type === 'rocket' ? base * this.lv(t, u.BLAST_MUL) : base * this.lv(t, u.RADIUS_MUL);
      case 'SLOW':
        return this.lv(t, u.SLOW);
      case 'TURRET_RATE':
      case 'CORE_RATE':
        return base * this.lv(t, u.REPAIR_MUL);
      case 'HEALTH':
        return base * this.lv(t, u.HEALTH_MUL);
    }
    return base;
  }

  /** 次のレベルへの強化の値段（もう上げられなければ null） */
  upgradeCost(turretId: number): number | null {
    const t = this.turrets.get(turretId);
    if (!t || t.level >= this.cfg.UPGRADE.MAX_LEVEL) return null;
    const k = this.cfg.UPGRADE.COST_MUL[t.level - 1] ?? 1;
    return Math.round((this.cfg.TURRETS[t.type].COST * k) / 10) * 10;
  }

  upgradeCheck(pid: number, turretId: number): BuyCheck {
    const t = this.turrets.get(turretId);
    const cost = this.upgradeCost(turretId);
    if (!t || t.ownerId !== pid) return { ok: false, reason: '自分のタレットだけ強化できる', cost: 0 };
    if (cost === null) return { ok: false, reason: '最大レベル', cost: 0 };
    if (this.phase !== 'prep') return { ok: false, reason: '準備時間中だけ強化できる', cost };
    const e = this.sim.entities.get(turretId);
    if (!e || e.dead) return { ok: false, reason: '壊れている', cost };
    if (this.credits(pid) < cost) return { ok: false, reason: 'クレジットが足りない', cost };
    return { ok: true, cost };
  }

  /** タレットを強化する（準備時間中・自分のタレット。威力・体力・射程などが上がり、体力も増えた分だけ回復する） */
  tryUpgrade(pid: number, turretId: number): boolean {
    const chk = this.upgradeCheck(pid, turretId);
    if (!chk.ok) return false;
    const t = this.turrets.get(turretId)!;
    const e = this.sim.entities.get(turretId)!;
    const before = e.maxHealth;
    t.level++;
    t.spent += chk.cost;
    e.maxHealth = Math.round(this.turretStat(t, 'HEALTH', 600));
    e.health = Math.min(e.maxHealth, e.health + (e.maxHealth - before));
    const p = this.participants.get(pid)!;
    p.credits -= chk.cost;
    p.itemsBought++;
    this.events.push({ type: 'turretUpgraded', turretId, ownerId: pid, level: t.level });
    return true;
  }

  // --- アーマー ---

  armorCheck(pid: number): BuyCheck {
    const def = this.cfg.ITEMS.armor;
    const p = this.participants.get(pid);
    const e = this.sim.entities.get(pid);
    if (!p || !e) return { ok: false, reason: '買えない', cost: def.COST };
    if (this.phase !== 'prep' && this.phase !== 'wave') return { ok: false, reason: 'いまは買えない', cost: def.COST };
    if (p.armorWave === this.wave) return { ok: false, reason: 'このラウンドは買った', cost: def.COST };
    if (e.dead || e.downed > 0) return { ok: false, reason: '倒れている間は買えない', cost: def.COST };
    if (p.credits < def.COST) return { ok: false, reason: 'クレジットが足りない', cost: def.COST };
    return { ok: true, cost: def.COST };
  }

  /** アーマーを買う（すぐに効く。いまのウェーブ（準備中なら次のウェーブ）が終わるまで） */
  buyArmor(pid: number): boolean {
    const chk = this.armorCheck(pid);
    if (!chk.ok) return false;
    const p = this.participants.get(pid)!;
    const e = this.sim.entities.get(pid)!;
    const amount = tdNum(this.cfg.ITEMS.armor, 'AMOUNT', 50);
    p.credits -= chk.cost;
    p.itemsBought++;
    p.armorWave = this.wave;
    e.maxArmor = amount;
    e.armor = amount;
    this.events.push({ type: 'armorBought', pid, amount });
    return true;
  }

  /** 敵から見た設置物（囮とバリケード。enemyBot が使う） */
  readonly enemyApi: TdEnemyApi = {
    lures: () => {
      const out: Array<{ id: number; pos: Vec3 }> = [];
      for (const d of this.devices.values()) {
        if (d.type !== 'decoy') continue;
        const e = this.sim.entities.get(d.entityId);
        if (e && !e.dead && d.age > 0.6) out.push({ id: e.id, pos: e.movement.pos });
      }
      return out;
    },
    barricades: () => {
      const out: Array<{ id: number; a: Vec3; b: Vec3 }> = [];
      for (const d of this.devices.values()) {
        if (d.type !== 'barricade' || !d.ends) continue;
        const e = this.sim.entities.get(d.entityId);
        if (e && !e.dead) out.push({ id: e.id, a: d.ends[0], b: d.ends[1] });
      }
      return out;
    },
  };

  // ---------------------------------------------------------------------------
  // 出現
  // ---------------------------------------------------------------------------

  private pickSpawn(e: Entity): { pos: Vec3; yaw: number } | null {
    const spawns = (this.sim.level.spawns ?? []).filter((s) => s.team === e.team);
    if (!spawns.length) return null;
    let best = spawns[0],
      bs = -Infinity;
    for (const s of spawns) {
      let minD = 80;
      for (const o of this.sim.entities.values()) if (o.team !== e.team && !o.dead) minD = Math.min(minD, len(sub(o.movement.pos, s.pos)));
      const sc = minD + this.rng.range(0, 6);
      if (sc > bs) {
        bs = sc;
        best = s;
      }
    }
    return { pos: clone(best.pos), yaw: best.yaw };
  }

  private enemyHealth(type: TdEnemyType): number {
    const base = this.cfg.ENEMIES[type].HEALTH;
    return Math.round(base * this.healthScale * (1 + this.cfg.HEALTH_PER_WAVE * (this.wave - 1)));
  }

  private enemyDamageMul(): number {
    return this.cfg.DIFFICULTY[this.opts.difficulty].ENEMY_DAMAGE;
  }

  /**
   * 敵を1体出す。at があればその場所に（降下ポッドから出てきた敵。zone の方面のルートの道すじに合流するか、まっすぐコアへ）、
   * なければルートの湧く範囲に
   */
  spawnEnemy(type: TdEnemyType, routeId: TdRoute, at?: { pos: Vec3; zone: TdDropZone }): Entity | null {
    const base = this.route(routeId);
    if (!base) return null;
    const route: TdRouteDef = at ? { ...base, path: [...(at.zone.via ?? []), ...(at.zone.join !== undefined ? base.path.slice(at.zone.join) : [])] } : base;
    // 高い所（防壁の上・屋上）に降りた敵は、階段・飛び降りで下りられる
    const high = !!at && at.zone.center.y > 2;
    const def = this.cfg.ENEMIES[type];
    const sim = this.sim;
    const c = route.spawn.center;
    // 湧く場所：範囲の中の、地面の上の空いている所
    let pos = at ? v3(at.pos.x, at.pos.y + 0.05, at.pos.z) : v3(c.x, c.y + 0.05, c.z);
    for (let k = 0; k < 10 && !at; k++) {
      const a = this.rng.range(0, Math.PI * 2);
      const r = Math.sqrt(this.rng.next()) * route.spawn.radius;
      const q = v3(c.x + Math.cos(a) * r, c.y + 3, c.z + Math.sin(a) * r);
      const g = sim.world.raycast(q, v3(0, -1, 0), 8);
      if (!g) continue;
      const p = v3(q.x, g.point.y + 0.05, q.z);
      if (sim.world.blocked(v3(p.x, p.y + 0.8, p.z), v3(p.x, p.y + 1.4, p.z), 0.45)) continue;
      pos = p;
      break;
    }
    const first = route.path[0] ?? this.td.core;
    const toFirst = sub(first, pos);
    const yaw = Math.atan2(-toFirst.x, -toFirst.z);
    const hp = this.enemyHealth(type);
    const dmg = this.enemyDamageMul();
    const aim = this.cfg.ENEMY_AIM[this.opts.difficulty];
    const seed = (this.opts.seed ?? 1) * 131 + sim.tick * 7 + this.enemies.size * 17;
    let e: Entity;
    const rec: Partial<EnemyRec> = { type, route: routeId };
    if (type === 'grunt' || type === 'assault' || type === 'heavy' || type === 'mortar') {
      e = sim.spawnPlayer(def.NAME, type === 'heavy' ? ['lmg', 'ar'] : type === 'mortar' ? ['pistol', 'smg'] : ['ar', 'smg'], 'pearl', {
        team: 1,
        kind: type,
        pos,
        yaw,
        maxHealth: hp,
        damageMul: tdNum(def, 'DAMAGE_MUL', 0.3) * dmg,
        speedMul: tdNum(def, 'SPEED_MUL', 1),
        regen: false,
        body: type === 'heavy' ? HEAVY_BODY : undefined,
      });
      const brain = new TdEnemyBot(e.id, this.bw, sim.cfg, sim.wcfg, aim, seed, type, route, this.td.core, this.core.id, tdNum(def, 'ENGAGE_RANGE', 24), this.enemyApi, tdNum(this.cfg.ITEMS.decoy, 'ASSAULT_LURE', 14), high);
      brain.setAim(yaw, 0);
      rec.brain = brain;
      if (type === 'mortar') {
        // 据える所を決める（外に降りたら外の、防壁の上・中に降りたら中の、歩いて行ける空いている所）
        const si = this.assignSpot(at?.zone ?? null, pos);
        rec.spot = si;
        this.mortarIds.add(e.id);
        brain.setMortar({
          spot: si >= 0 ? clone(this.td.mortarSpots[si].pos) : null,
          minRange: tdNum(def, 'MIN_RANGE', 25),
          maxRange: tdNum(def, 'MAX_RANGE', 125),
          panicRange: tdNum(def, 'PANIC_RANGE', 11),
          giveUp: tdNum(def, 'GIVE_UP', 50),
        });
      }
    } else if (type === 'drone') {
      const p = v3(pos.x, pos.y + 6 + this.rng.range(0, 3), pos.z);
      e = sim.spawnPlayer(def.NAME, ['smg', 'ar'], 'pearl', {
        team: 1,
        kind: 'drone',
        pos: p,
        yaw,
        maxHealth: hp,
        damageMul: tdNum(def, 'DAMAGE_MUL', 0.4) * dmg,
        regen: false,
        kinematic: true,
        body: DRONE_BODY,
        eyeY: 0,
        height: DRONE_HEIGHT,
      });
      rec.drone = new DroneCtl(e.id, route, this.td.core, this.core.id, this.td.droneHover, tdNum(def, 'SPEED', 9), tdNum(def, 'FIRE_RANGE', 28), seed);
    } else {
      e = sim.spawnPlayer(def.NAME, ['lmg', 'ar'], 'pearl', {
        team: 1,
        kind: 'boss',
        pos,
        yaw,
        maxHealth: hp,
        damageMul: tdNum(def, 'MG_DAMAGE_MUL', 0.45) * dmg,
        regen: false,
        kinematic: true,
        body: BOSS_BODY,
        eyeY: 6.7,
        height: BOSS_HEIGHT,
      });
      e.facing = yaw;
      rec.boss = new BossCtl(
        e.id,
        route,
        this.td.core,
        this.core.id,
        {
          SPEED: tdNum(def, 'SPEED', 1.9),
          STOP_DIST: tdNum(def, 'STOP_DIST', 24),
          ROCKET_INTERVAL: tdNum(def, 'ROCKET_INTERVAL', 3.4),
          ROCKET_COUNT: tdNum(def, 'ROCKET_COUNT', 4),
          ROCKET_RANGE: tdNum(def, 'ROCKET_RANGE', 55),
          MG_RANGE: tdNum(def, 'MG_RANGE', 32),
        },
        yaw,
        seed,
      );
      rec.boxId = sim.addDynamicBox(add(pos, v3(0, BOSS_COLLIDER.y / 2, 0)), BOSS_COLLIDER);
    }
    rec.id = e.id;
    if (at) rec.zone = at.zone.id;
    this.enemies.set(e.id, rec as EnemyRec);
    this.events.push({ type: 'enemySpawn', id: e.id, enemy: type, route: routeId });
    return e;
  }

  /** 迫撃砲兵の据える所を選ぶ（その降下地点から歩いて行ける所のうち、近くて空いている所。なければ -1） */
  private assignSpot(zone: TdDropZone | null, from: Vec3): number {
    const spots = this.td.mortarSpots ?? [];
    if (!spots.length) return -1;
    const area = !zone || zone.kind === 'outer' ? 'outer' : 'inner';
    const reach = zone ? this.reachableSpots(zone) : null;
    // 使われている数（据える所へ向かっている・据えている迫撃砲兵）
    const used = new Map<number, number>();
    for (const r of this.enemies.values()) {
      if (r.type !== 'mortar' || r.spot === undefined || r.spot < 0) continue;
      const e = this.sim.entities.get(r.id);
      if (e && !e.dead) used.set(r.spot, (used.get(r.spot) ?? 0) + 1);
    }
    let best = -1,
      bs = Infinity;
    spots.forEach((sp, i) => {
      if (sp.area !== area) return;
      if (reach && !reach.has(i)) return;
      const s = lenH(sub(sp.pos, from)) + (used.get(i) ?? 0) * 80 + this.rng.range(0, 12);
      if (s < bs) {
        bs = s;
        best = i;
      }
    });
    return best;
  }

  /** その降下地点から、迫撃砲兵が歩いて（段差は跳んで）行ける据える所 */
  private reachableSpots(zone: TdDropZone): Set<number> {
    let set = this.spotReach.get(zone.id);
    if (set) return set;
    set = new Set<number>();
    const nav = this.nav;
    const allow = mortarAllow(nav);
    const a = nearestNode(nav, zone.center, 6);
    const area = zone.kind === 'outer' ? 'outer' : 'inner';
    (this.td.mortarSpots ?? []).forEach((sp, i) => {
      if (sp.area !== area || a < 0) return;
      const b = nearestNode(nav, sp.pos, 2.5);
      if (b >= 0 && findPath(nav, a, b, allow, 60000)) set!.add(i);
    });
    this.spotReach.set(zone.id, set);
    return set;
  }

  get aliveEnemies(): number {
    let n = 0;
    for (const r of this.enemies.values()) {
      const e = this.sim.entities.get(r.id);
      if (e && !e.dead) n++;
    }
    return n;
  }

  /** このウェーブで、まだ出ていない敵の数（降りてきている降下ポッドの中の敵も含む） */
  get pendingEnemies(): number {
    let n = this.groups.reduce((s, g) => s + g.remaining, 0);
    for (const p of this.pods.values()) if (!p.opened) n += p.count;
    return n;
  }

  // ---------------------------------------------------------------------------
  // 降下ポッド
  // ---------------------------------------------------------------------------

  /** id の降下地点 */
  dropZone(id: string): TdDropZone | undefined {
    return this.td.dropZones.find((z) => z.id === id);
  }

  /** そのルートの方面の、遠くの草原（ルートの道すじに合流する外の降下地点） */
  private farZone(route: TdRoute): TdDropZone | null {
    const zs = this.td.dropZones.filter((z) => z.sector === route && z.kind === 'outer');
    return zs.find((z) => z.join !== undefined) ?? zs[0] ?? null;
  }

  /** グループの降りる場所を決める（地上の敵だけ。used：同じウェーブで選んだ場所。なるべく重ならないように） */
  private resolveZone(g: TdGroupDef, used: Set<string>): TdDropZone | null {
    if (!GROUND_TYPES.includes(g.type)) return null;
    const d = g.drop;
    if (d && !DROP_KINDS.includes(d)) return this.dropZone(d) ?? this.farZone(g.route);
    if (!d) return this.farZone(g.route);
    const cands = this.td.dropZones.filter((z) => z.sector === g.route && z.kind === d);
    if (!cands.length) return this.farZone(g.route);
    const fresh = cands.filter((z) => !used.has(z.id));
    return this.rng.pick(fresh.length ? fresh : cands);
  }

  /** 次のウェーブの降下地点を決める（準備時間の始め。画面に予告する） */
  private planDrops() {
    const w = this.cfg.WAVES[this.wave - 1];
    const used = new Set<string>();
    this.planned = (w?.groups ?? []).map((g) => {
      const z = this.resolveZone(g, used);
      if (z) used.add(z.id);
      return z;
    });
    this.plannedWave = this.wave;
  }

  /** 次の（ウェーブ中はいまの）ウェーブの、グループごとの降下地点 */
  plannedDrops(): PlannedDrop[] {
    if (this.plannedWave !== this.wave) this.planDrops();
    const w = this.cfg.WAVES[this.wave - 1];
    const out: PlannedDrop[] = [];
    (w?.groups ?? []).forEach((g, i) => {
      const z = this.planned[i];
      if (z) out.push({ zone: z, type: g.type, count: g.count });
    });
    return out;
  }

  /** 降りてくる・降りている敵がいる降下地点の種類（ウェーブの予告用） */
  waveDropKinds(): TdDropKind[] {
    const kinds = new Set(this.plannedDrops().map((p) => p.zone.kind));
    return (['outer', 'wall', 'inner'] as TdDropKind[]).filter((k) => kinds.has(k));
  }

  /** ポッドの降りる所を選ぶ（降下地点の中の、上が開けた平らな床。タレット・設置物・ほかのポッドから離す） */
  private pickLanding(zone: TdDropZone): Vec3 {
    const sim = this.sim;
    const world = sim.world;
    const clr = this.cfg.POD.CLEARANCE;
    const c = zone.center;
    // どこも空いていなければ、タレット・設置物からいちばん離れた所
    let fallback: Vec3 | null = null;
    let fbScore = -Infinity;
    for (let k = 0; k < 36; k++) {
      const a = this.rng.range(0, Math.PI * 2);
      // 半分より先は、降下地点の少し外まで探す（真ん中にタレットを置かれても、まわりに降りる）
      const R = k < 24 ? zone.radius : zone.radius * 1.5;
      const r = k === 0 ? this.rng.range(0, zone.radius * 0.5) : Math.sqrt(this.rng.next()) * R;
      const x = c.x + Math.cos(a) * r,
        z = c.z + Math.sin(a) * r;
      // 真上から：空が開けていて、その高さの床に当たる
      const g = world.raycast(v3(x, c.y + 70, z), v3(0, -1, 0), 90);
      if (!g || g.normal.y < 0.9 || Math.abs(g.point.y - c.y) > 0.6) continue;
      const p = v3(x, g.point.y, z);
      // 平ら・まわりに壁がない
      let flat = true;
      for (const [dx, dz] of [
        [0.8, 0],
        [-0.8, 0],
        [0, 0.8],
        [0, -0.8],
      ]) {
        const h = world.raycast(v3(p.x + dx, p.y + 0.8, p.z + dz), v3(0, -1, 0), 1.6);
        if (!h || Math.abs(h.point.y - p.y) > 0.25) flat = false;
      }
      if (!flat || world.blocked(v3(p.x, p.y + 1.0, p.z), v3(p.x, p.y + 2.6, p.z), 0.75, 0.02)) continue;
      // まわりの物までの近さ（足りない分だけ点を引く）
      let short = 0;
      for (const t of this.turrets.values()) if (Math.abs(t.pos.y - p.y) < 3) short = Math.max(short, clr - lenH(sub(t.pos, p)));
      for (const d of this.devices.values()) if (Math.abs(d.pos.y - p.y) < 3) short = Math.max(short, clr - 1 - segDist2D(p, d.ends ? d.ends[0] : d.pos, d.ends ? d.ends[1] : d.pos));
      for (const o of this.pods.values()) if (Math.abs(o.pos.y - p.y) < 3) short = Math.max(short, 3.4 - lenH(sub(o.pos, p)));
      for (const s of this.sim.level.spawns ?? []) short = Math.max(short, 3 - lenH(sub(s.pos, p)));
      if (short <= 0) return p;
      if (-short > fbScore) {
        fbScore = -short;
        fallback = p;
      }
    }
    return fallback ?? v3(c.x, c.y, c.z);
  }

  /** ポッドを1つ降ろす（WARN 秒後に着地する） */
  private dropPod(zone: TdDropZone, type: TdEnemyType, count: number): PodState {
    const P = this.cfg.POD;
    const now = this.sim.time;
    const pod: PodState = {
      id: this.nextPodId++,
      zone,
      pos: this.pickLanding(zone),
      type,
      count,
      warnAt: now,
      landAt: now + P.WARN,
      openAt: now + P.WARN + P.OPEN,
      leaveAt: now + P.WARN + P.LEAVE,
      landed: false,
      opened: false,
      boxId: -1,
      spawned: [],
    };
    this.pods.set(pod.id, pod);
    this.events.push({ type: 'podIncoming', podId: pod.id, pos: clone(pod.pos), zone: zone.id, zoneName: zone.name, kind: zone.kind, sector: zone.sector, eta: P.WARN, enemy: type, count });
    return pod;
  }

  /** 降下ポッドの1ティック：着地（まわりを吹き飛ばす）・扉が開く（分隊が出てくる）・飛び去る */
  private stepPods() {
    const sim = this.sim;
    const now = sim.time;
    for (const pod of [...this.pods.values()]) {
      if (!pod.landed && now >= pod.landAt) {
        pod.landed = true;
        pod.boxId = sim.addDynamicBox(v3(pod.pos.x, pod.pos.y + POD_SIZE.y / 2, pod.pos.z), POD_SIZE);
        this.podImpact(pod);
        this.events.push({ type: 'podLand', podId: pod.id, pos: clone(pod.pos) });
      }
      if (pod.landed && !pod.opened && now >= pod.openAt) {
        pod.opened = true;
        for (const p of this.exitPoints(pod)) {
          const e = this.spawnEnemy(pod.type, pod.zone.sector, { pos: p, zone: pod.zone });
          if (e) {
            pod.spawned.push(e.id);
            // ポッドから外へ向いて出てくる
            const out = sub(p, pod.pos);
            this.enemies.get(e.id)?.brain?.setAim(Math.atan2(-out.x, -out.z), 0);
          }
        }
        this.events.push({ type: 'podOpen', podId: pod.id, pos: clone(pod.pos) });
      }
      if (now >= pod.leaveAt) {
        if (pod.boxId >= 0) sim.removeDynamicBox(pod.boxId);
        pod.boxId = -1;
        this.pods.delete(pod.id);
        this.events.push({ type: 'podLeave', podId: pod.id, pos: clone(pod.pos) });
      }
    }
  }

  /** 着地の衝撃：まわりの味方（パイロット・囮）にダメージと、外への吹き飛ばし */
  private podImpact(pod: PodState) {
    const sim = this.sim;
    const P = this.cfg.POD;
    const R = P.IMPACT_RADIUS;
    for (const o of [...sim.entities.values()]) {
      if (o.team !== 0 || o.dead || o.kind === 'core' || o.kind === 'turret' || o.kind === 'barricade') continue;
      const d = sub(o.movement.pos, pod.pos);
      const h = lenH(d);
      if (h > R || d.y < -1.5 || d.y > 3.5) continue;
      sim.damageEntity(o, P.IMPACT_DAMAGE * this.enemyDamageMul() * (1 - (h / R) * 0.5), v3(pod.pos.x, pod.pos.y + 1, pod.pos.z), 'grenade', -1);
      if (o.kind === 'pilot' && !o.dead && o.downed <= 0) {
        const dir = h > 0.1 ? v3(d.x / h, 0, d.z / h) : v3(1, 0, 0);
        launch(o.movement, v3(dir.x * P.IMPACT_PUSH, 5.5, dir.z * P.IMPACT_PUSH));
      }
    }
  }

  /** 扉から出てくる敵の立つ所（ポッドのまわりの、同じ高さの床の空いている所） */
  private exitPoints(pod: PodState): Vec3[] {
    const world = this.sim.world;
    const out: Vec3[] = [];
    const a0 = this.rng.range(0, Math.PI * 2);
    for (const r of [1.75, 2.4, 3.1, 3.8]) {
      for (let k = 0; k < 12 && out.length < pod.count; k++) {
        const a = a0 + (k * Math.PI * 2) / 12 + (r > 2 ? 0.26 : 0);
        const x = pod.pos.x + Math.cos(a) * r,
          z = pod.pos.z + Math.sin(a) * r;
        const g = world.raycast(v3(x, pod.pos.y + 1.2, z), v3(0, -1, 0), 2.4);
        if (!g || Math.abs(g.point.y - pod.pos.y) > 0.6) continue;
        const p = v3(x, g.point.y, z);
        if (world.blocked(v3(p.x, p.y + 0.8, p.z), v3(p.x, p.y + 1.5, p.z), 0.45, 0.02)) continue;
        if (out.some((q) => lenH(sub(q, p)) < 1.0)) continue;
        out.push(p);
      }
    }
    // 場所が足りなければ、ポッドの横に重ねて出す（少しずつずらす）
    while (out.length < pod.count) out.push(v3(pod.pos.x + 1.75 + out.length * 0.3, pod.pos.y, pod.pos.z));
    return out;
  }


  // ---------------------------------------------------------------------------
  // 進める
  // ---------------------------------------------------------------------------

  /** 1ティック進める。playerCmd はプレイヤーの入力（プレイヤーがいなければ null） */
  step(playerCmd: InputCommand | null): void {
    const dt = TICK_DT;
    const sim = this.sim;
    this.events = [];
    this.rockets.beginTick();
    this.phaseTime += dt;
    const over = this.phase === 'victory' || this.phase === 'defeat';
    if (!over) this.elapsed += dt;

    // --- 減速フィールド ---
    for (const r of this.enemies.values()) {
      const e = sim.entities.get(r.id);
      if (e) e.slowMul = 1;
    }
    for (const t of this.turrets.values()) {
      if (t.type !== 'slow') continue;
      const R = this.turretStat(t, 'RADIUS', 9);
      const k = this.turretStat(t, 'SLOW', 0.5);
      let any = false;
      for (const r of this.enemies.values()) {
        const e = sim.entities.get(r.id);
        if (!e || e.dead) continue;
        const d = sub(e.movement.pos, t.pos);
        if (lenH(d) < R && d.y > -3 && d.y < 8) {
          e.slowMul = Math.min(e.slowMul, k);
          any = true;
        }
      }
      t.pulse = Math.max(0, t.pulse - dt) + (any ? dt * 2 : 0);
      t.pulse = Math.min(1, t.pulse);
    }

    // --- 入力 ---
    const cmds = new Map<number, InputCommand>();
    for (const [id, brain] of this.allies) {
      const e = sim.entities.get(id);
      if (!e) continue;
      cmds.set(id, over ? brain.idle() : brain.think(e, dt));
    }
    const others = [...sim.entities.values()];
    for (const r of this.enemies.values()) {
      const e = sim.entities.get(r.id);
      if (!e) continue;
      if (e.dead) continue;
      if (r.brain) cmds.set(r.id, over ? r.brain.idle() : r.brain.think(e, dt));
      else if (r.drone) cmds.set(r.id, over ? emptyCommand(sim.tick + 1) : r.drone.step(e, sim, others));
      else if (r.boss) {
        cmds.set(r.id, over ? emptyCommand(sim.tick + 1) : r.boss.step(e, sim));
        if (r.boxId !== undefined) sim.moveDynamicBox(r.boxId, add(e.movement.pos, v3(0, BOSS_COLLIDER.y / 2, 0)), BOSS_COLLIDER, (r.boss.facing * 180) / Math.PI);
        if (r.boss.stepped) this.events.push({ type: 'bossStep', id: r.id, pos: clone(e.movement.pos) });
      }
    }
    if (this.player && playerCmd) cmds.set(this.player.id, playerCmd);
    if (!over) this.stepJumpPads();
    this.bw.processPaths();
    sim.step(cmds);
    // シミュレーションの出来事（タレット・ロケット・自爆で、あとから増える分も順に見る）
    let evIdx = 0;
    const flush = () => {
      while (evIdx < sim.events.length) this.onSimEvent(sim.events[evIdx++]);
    };
    flush();

    if (!over) {
      this.stepTurrets(dt);
      flush();
      // 大型兵器のロケット
      for (const r of this.enemies.values()) {
        if (!r.boss || !r.boss.volley.length) continue;
        const def = this.cfg.ENEMIES.boss;
        const e = sim.entities.get(r.id);
        if (!e || e.dead) continue;
        for (const v of r.boss.volley) {
          const dir = normalize(sub(v.to, v.from));
          const speed = tdNum(def, 'ROCKET_SPEED', 26);
          // 少し上へ撃ち出して、目標へ曲がって落ちる
          const vel = scale(normalize(add(dir, v3(0, 0.35, 0))), speed);
          const rk = this.rockets.launch({
            pos: clone(v.from),
            vel,
            team: 1,
            ownerId: r.id,
            damage: tdNum(def, 'ROCKET_DAMAGE', 70) * this.enemyDamageMul(),
            minDamage: tdNum(def, 'ROCKET_DAMAGE', 70) * 0.3 * this.enemyDamageMul(),
            radius: tdNum(def, 'ROCKET_RADIUS', 4.5),
            target: clone(v.to),
            homing: 70,
            life: 5,
            hitsAir: false,
          });
          this.events.push({ type: 'rocketLaunch', rocketId: rk.id, from: clone(v.from), vel: clone(vel), boss: true });
        }
      }
      this.rockets.step(sim);
      for (const b of this.rockets.blasts) this.onBlast(b);
      flush();
      this.stepAssaults();
      flush();
      this.stepMortars(dt);
      flush();
      this.stepDevices(dt);
      flush();
      this.stepPods();
      flush();
      this.stepRepair(dt);
      this.checkStuck(dt);
    }
    this.stepPhase(dt);
  }

  /** 試合が終わって、リザルトを出してよい */
  get finished(): boolean {
    return (this.phase === 'victory' || this.phase === 'defeat') && this.phaseTime >= this.cfg.END_DELAY;
  }

  private setPhase(p: TdPhase) {
    this.phase = p;
    this.phaseTime = 0;
    this.events.push({ type: 'phase', phase: p, wave: this.wave });
  }

  private stepPhase(dt: number) {
    // コアが壊れていれば負け（出来事を見逃したときのため）
    if ((this.core.dead || this.core.health <= 0) && this.phase !== 'victory' && this.phase !== 'defeat') {
      this.finish(false);
      return;
    }
    if (this.phase === 'intro') {
      if (this.phaseTime >= this.cfg.INTRO_TIME) this.startPrep();
      return;
    }
    if (this.phase === 'prep') {
      this.prepLeft = Math.max(0, this.prepLeft - dt);
      const allReady = [...this.participants.values()].every((p) => p.ready);
      if (this.prepLeft <= 0 || allReady) this.startWave();
      return;
    }
    if (this.phase === 'wave') {
      // 敵を出す
      for (const g of this.groups) {
        if (g.remaining <= 0) continue;
        g.timer -= dt;
        if (g.timer > 0) continue;
        // 降りてきている途中のポッドの中の敵も、生きている数に入れる
        let flying = 0;
        for (const p of this.pods.values()) if (!p.opened) flying += p.count;
        const room = this.cfg.MAX_ALIVE - this.aliveEnemies - flying;
        const n = Math.min(g.def.squad, g.remaining, Math.max(0, room));
        if (n <= 0) {
          g.timer = 1;
          continue;
        }
        if (g.zone) {
          // 地上の敵：分隊（1つのポッドに POD.SIZE 人まで）ごとに降下ポッドで降ろす
          for (let left = n; left > 0; ) {
            const k = Math.min(left, this.cfg.POD.SIZE);
            this.dropPod(g.zone, g.def.type, k);
            left -= k;
          }
        } else for (let i = 0; i < n; i++) this.spawnEnemy(g.def.type, g.def.route);
        g.remaining -= n;
        g.timer = g.def.interval;
      }
      if (this.pendingEnemies === 0 && this.aliveEnemies === 0) this.clearWave();
    }
  }

  private startPrep() {
    this.prepLeft = this.cfg.PREP_TIME;
    for (const p of this.participants.values()) p.ready = false;
    this.planDrops();
    this.setPhase('prep');
  }

  private startWave() {
    const w = this.cfg.WAVES[this.wave - 1];
    if (this.plannedWave !== this.wave) this.planDrops();
    this.groups = w.groups.map((g, i) => ({ def: g, remaining: Math.max(1, Math.round(g.count * (g.type === 'boss' ? 1 : this.countScale))), timer: g.delay, zone: this.planned[i] ?? null }));
    this.setPhase('wave');
    this.events.push({ type: 'waveStart', wave: this.wave, routes: this.waveRoutes(), boss: this.waveHasBoss() });
  }

  private clearWave() {
    const bonus = this.cfg.WAVE_BONUS + this.cfg.WAVE_BONUS_PER_WAVE * (this.wave - 1);
    for (const p of this.participants.values()) {
      p.credits += bonus;
      p.earned += bonus;
      this.events.push({ type: 'credits', pid: p.id, amount: bonus, reason: 'bonus' });
    }
    this.events.push({ type: 'waveClear', wave: this.wave, bonus });
    // アーマーは、買ったラウンドが終わるとなくなる
    for (const p of this.participants.values()) {
      const e = this.sim.entities.get(p.id);
      if (e) e.armor = e.maxArmor = 0;
    }
    // 倒れたままの敵の記録を片付ける
    for (const [id, r] of this.enemies) if (!this.sim.entities.has(id)) this.enemies.delete(r.id);
    if (this.wave >= this.totalWaves) {
      this.finish(true);
      return;
    }
    this.wave++;
    this.startPrep();
  }

  private finish(victory: boolean) {
    this.result = {
      victory,
      wavesCleared: victory ? this.totalWaves : this.wave - 1,
      totalWaves: this.totalWaves,
      coreHealth: Math.max(0, this.core.health),
      coreMax: this.core.maxHealth,
      duration: this.elapsed,
      participants: [...this.participants.values()].sort((a, b) => (b.isPlayer ? 1 : 0) - (a.isPlayer ? 1 : 0) || b.kills - a.kills),
      enemiesKilled: this.enemiesKilled,
      difficulty: this.opts.difficulty,
    };
    this.groups = [];
    for (const p of this.pods.values()) if (p.boxId >= 0) this.sim.removeDynamicBox(p.boxId);
    this.pods.clear();
    this.shells.clear();
    this.setPhase(victory ? 'victory' : 'defeat');
  }

  // ---------------------------------------------------------------------------
  // 出来事
  // ---------------------------------------------------------------------------

  /** 倒した相手から、クレジットを受け取る参加者（タレットなら置いた参加者） */
  private creditOwner(killerId: number): number {
    if (killerId < 0) return -1;
    const t = this.turrets.get(killerId);
    if (t) return t.ownerId;
    if (this.participants.has(killerId)) return killerId;
    // 取り除いたタレット（記録だけ残っている）
    return -1;
  }

  private onSimEvent(ev: SimEvent) {
    const sim = this.sim;
    if (ev.type === 'playerDamaged' || ev.type === 'playerRespawn') {
      const b = this.allies.get(ev.entityId) ?? this.enemies.get(ev.entityId)?.brain;
      const e = sim.entities.get(ev.entityId);
      if (b && e) b.onEvent(e, ev);
      if (ev.type === 'playerDamaged' && ev.entityId === this.core.id) {
        // 迫撃砲の砲撃は「コアが攻撃されている（コアのそばに敵がいる）」に数えない（砲撃している所へ倒しに行く）
        const shelled = ev.attackerId !== undefined && this.mortarIds.has(ev.attackerId);
        if (!shelled) this.lastCoreHit = sim.time;
        this.events.push({ type: 'coreDamaged', amount: ev.amount, health: this.core.health });
        if (!shelled && sim.time - this.lastCoreAlert > 6) {
          this.lastCoreAlert = sim.time;
          this.events.push({ type: 'coreAlert' });
        }
      }
    }
    if (ev.type === 'downed') {
      const p = this.participants.get(ev.entityId);
      if (p) p.downs++;
      this.events.push({ type: 'downed', entityId: ev.entityId });
    }
    if (ev.type === 'revived') {
      const p = this.participants.get(ev.byId);
      if (p) p.revives++;
      this.reviveClaims.delete(ev.entityId);
      this.events.push({ type: 'revived', entityId: ev.entityId, byId: ev.byId });
    }
    if (ev.type === 'entityRemoved') {
      const r = this.enemies.get(ev.entityId);
      if (r) {
        r.brain?.dispose();
        this.enemies.delete(ev.entityId);
      }
    }
    if (ev.type !== 'kill') return;
    // --- 倒された ---
    if (ev.victimId === this.core.id) {
      if (this.phase !== 'victory' && this.phase !== 'defeat') this.finish(false);
      return;
    }
    const t = this.turrets.get(ev.victimId);
    if (t) {
      this.removeTurret(t);
      this.events.push({ type: 'turretDestroyed', turretId: t.id, ownerId: t.ownerId });
      return;
    }
    const dv = this.deviceOfEntity(ev.victimId);
    if (dv) {
      this.removeDevice(dv, 'destroyed');
      return;
    }
    if (ev.victimTeam === 0 && ev.victimKind === 'pilot') {
      this.reviveClaims.delete(ev.victimId);
      this.events.push({ type: 'bleedout', entityId: ev.victimId });
      return;
    }
    const rec = this.enemies.get(ev.victimId);
    if (!rec) return;
    this.enemiesKilled++;
    if (rec.boxId !== undefined) sim.removeDynamicBox(rec.boxId);
    const owner = this.creditOwner(ev.killerId);
    const reward = this.cfg.ENEMIES[rec.type].REWARD;
    const p = this.participants.get(owner);
    if (p) {
      p.credits += reward;
      p.earned += reward;
      p.kills++;
      if (rec.type === 'boss') p.bossKills++;
      const byTurret = this.turrets.has(ev.killerId);
      if (byTurret) {
        p.turretKills++;
        this.turrets.get(ev.killerId)!.kills++;
      }
      this.events.push({ type: 'credits', pid: owner, amount: reward, reason: byTurret ? 'turretKill' : 'kill', enemy: rec.type });
    }
    this.events.push({ type: 'enemyKilled', id: ev.victimId, enemy: rec.type, killerId: ev.killerId, ownerId: owner, head: ev.head });
  }

  private onBlast(b: RocketBlast) {
    this.events.push({ type: 'rocketExplode', rocketId: b.rocketId, pos: clone(b.pos), radius: b.radius });
  }

  // ---------------------------------------------------------------------------
  // タレット
  // ---------------------------------------------------------------------------

  private stepTurrets(dt: number) {
    const sim = this.sim;
    for (const t of this.turrets.values()) {
      const e = sim.entities.get(t.id);
      if (!e || e.dead) continue;
      if (t.type !== 'mg' && t.type !== 'rocket') continue;
      const def = this.cfg.TURRETS[t.type];
      const range = this.turretStat(t, 'RANGE', 30);
      const air = def.AIR === true;
      const muzzle = v3(t.pos.x, t.pos.y + TURRET_MUZZLE_Y, t.pos.z);
      t.cooldown = Math.max(0, t.cooldown - dt);
      t.retarget -= dt;
      let target = t.targetId >= 0 ? sim.entities.get(t.targetId) : undefined;
      if (target && (target.dead || len(sub(target.movement.pos, t.pos)) > range + 2)) target = undefined;
      if (t.retarget <= 0 || !target) {
        t.retarget = 0.25;
        let best: Entity | undefined,
          bs = Infinity;
        for (const r of this.enemies.values()) {
          const o = sim.entities.get(r.id);
          if (!o || o.dead) continue;
          if (!air && o.kind === 'drone') continue;
          const c = chestOf(sim.actorOf(o));
          const d = len(sub(c, muzzle));
          if (d > range) continue;
          // 近い・ボス（大きい）を少し優先
          const s = d - (o.kind === 'boss' ? 6 : 0) - (o.id === t.targetId ? 3 : 0);
          if (s >= bs) continue;
          if (!this.los(muzzle, c)) continue;
          bs = s;
          best = o;
        }
        target = best;
        t.targetId = best ? best.id : -1;
      }
      if (!target) {
        t.pitch *= 0.96;
        continue;
      }
      const ta = sim.actorOf(target);
      let aimPt = chestOf(ta);
      // 盾を向けている重装兵は、盾の上の頭を狙う
      if (t.type === 'mg' && ta.body?.parts.some((p) => p.block)) {
        const yaw = ta.yaw ?? 0;
        const dx = t.pos.x - ta.pos.x,
          dz = t.pos.z - ta.pos.z;
        if ((-Math.sin(yaw) * dx - Math.cos(yaw) * dz) / (Math.hypot(dx, dz) || 1) > 0.25) aimPt = headCenter(ta);
      }
      let aimAt = aimPt;
      if (t.type === 'rocket') {
        // 動く相手の先を狙う
        const speed = tdNum(def, 'ROCKET_SPEED', 38);
        const tt = len(sub(aimPt, muzzle)) / speed;
        aimAt = add(aimPt, scale(target.movement.vel, tt * 0.9));
        aimAt.y = target.movement.pos.y + 0.5;
      }
      const to = sub(aimAt, muzzle);
      const wantYaw = Math.atan2(-to.x, -to.z);
      const wantPitch = Math.atan2(to.y, lenH(to));
      const maxTurn = tdNum(def, 'TURN_SPEED', 200) * DEG * dt;
      let dy = wantYaw - t.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      t.yaw += Math.max(-maxTurn, Math.min(maxTurn, dy));
      t.pitch += Math.max(-maxTurn, Math.min(maxTurn, wantPitch - t.pitch));
      if (t.cooldown > 0 || Math.abs(dy) > 8 * DEG) continue;
      t.cooldown = this.turretStat(t, 'FIRE_INTERVAL', 0.12);
      if (t.type === 'mg') this.mgFire(t, e, muzzle, aimPt, def);
      else {
        const speed = tdNum(def, 'ROCKET_SPEED', 38);
        const dir = normalize(sub(aimAt, muzzle));
        const from = add(muzzle, scale(dir, 0.9));
        const rk = this.rockets.launch({
          pos: from,
          vel: scale(dir, speed),
          team: 0,
          ownerId: t.id,
          damage: this.turretStat(t, 'DAMAGE', 170),
          minDamage: this.turretStat(t, 'MIN_DAMAGE', 40),
          radius: this.turretStat(t, 'RADIUS', 4.5),
          target: aimAt,
          homing: 30,
          life: 3,
          hitsAir: false,
        });
        this.events.push({ type: 'rocketLaunch', rocketId: rk.id, from: clone(from), vel: clone(rk.vel), boss: false });
        this.events.push({ type: 'turretFire', turretId: t.id, turret: 'rocket', from: clone(from), to: clone(aimAt), hit: 'none' });
      }
    }
  }

  private mgFire(t: TurretState, self: Entity, muzzle: Vec3, aim: Vec3, def: TdConfig['TURRETS']['mg']) {
    const sim = this.sim;
    const spread = tdNum(def, 'SPREAD', 2.2) * DEG;
    let dir = normalize(sub(aim, muzzle));
    const right = normalize(v3(-dir.z, 0, dir.x));
    const up = v3(0, 1, 0);
    const r = Math.tan(spread) * Math.sqrt(this.rng.next());
    const th = this.rng.next() * Math.PI * 2;
    dir = normalize(add(dir, add(scale(right, Math.cos(th) * r), scale(up, Math.sin(th) * r))));
    const range = this.turretStat(t, 'RANGE', 32) + 6;
    let hitT = range;
    let kind: 'actor' | 'world' | 'none' = 'none';
    const wh = sim.world.raycast(muzzle, dir, range);
    if (wh) {
      hitT = wh.t;
      kind = 'world';
    }
    let victim: Entity | null = null;
    let head = false;
    for (const rr of this.enemies.values()) {
      const o = sim.entities.get(rr.id);
      if (!o || o.dead) continue;
      const ah = rayVsActor(muzzle, dir, hitT, sim.actorOf(o));
      if (ah && ah.t < hitT) {
        hitT = ah.t;
        kind = ah.blocked ? 'world' : 'actor';
        victim = ah.blocked ? null : o;
        head = ah.head;
      }
    }
    const to = add(muzzle, scale(dir, hitT));
    if (victim) sim.damageEntity(victim, this.turretStat(t, 'DAMAGE', 13) * (head ? 1.25 : 1), muzzle, 'turret', t.id, head);
    this.events.push({ type: 'turretFire', turretId: t.id, turret: 'mg', from: muzzle, to, hit: kind });
    void self;
  }

  private los(from: Vec3, to: Vec3): boolean {
    const d = sub(to, from);
    const L = len(d);
    if (L < 0.3) return true;
    return !this.sim.world.raycast(from, scale(d, 1 / L), L - 0.5);
  }

  /** 修理ステーション：近くのタレットとコアを少しずつ回復する */
  private stepRepair(dt: number) {
    this.repairTimer -= dt;
    if (this.repairTimer > 0) return;
    this.repairTimer = 0.5;
    for (const t of this.turrets.values()) {
      if (t.type !== 'repair') continue;
      const R = this.turretStat(t, 'RADIUS', 12);
      const self = this.sim.entities.get(t.id);
      if (!self || self.dead) continue;
      let healed = false;
      for (const o of this.turrets.values()) {
        const e = this.sim.entities.get(o.id);
        if (!e || e.dead || e.health >= e.maxHealth) continue;
        if (len(sub(o.pos, t.pos)) > R) continue;
        e.health = Math.min(e.maxHealth, e.health + this.turretStat(t, 'TURRET_RATE', 14) * 0.5);
        healed = true;
      }
      // バリケードも直す
      for (const d of this.devices.values()) {
        if (d.type !== 'barricade' || !d.ends) continue;
        const e = this.sim.entities.get(d.entityId);
        if (!e || e.dead || e.health >= e.maxHealth) continue;
        if (segDist2D(t.pos, d.ends[0], d.ends[1]) > R) continue;
        e.health = Math.min(e.maxHealth, e.health + this.turretStat(t, 'TURRET_RATE', 14) * 0.5);
        healed = true;
      }
      const core = this.core;
      if (!core.dead && core.health < core.maxHealth && lenH(sub(core.movement.pos, t.pos)) - 2.1 < R) {
        core.health = Math.min(core.maxHealth, core.health + this.turretStat(t, 'CORE_RATE', 10) * 0.5);
        healed = true;
      }
      t.pulse = healed ? 1 : Math.max(0, t.pulse - 0.5);
      if (healed) this.events.push({ type: 'repairPulse', turretId: t.id });
    }
  }

  /**
   * 地上の敵が長い間（30秒）ほとんど進んでいなければ、経路を探し直させる。それでも 75 秒動けなければ取り除く
   * （地形に引っかかった敵のせいで、ウェーブが終わらなくならないように）
   */
  private checkStuck(dt: number) {
    this.stuckTimer -= dt;
    if (this.stuckTimer > 0) return;
    this.stuckTimer = 1;
    const now = this.sim.time;
    for (const r of [...this.enemies.values()]) {
      if (!r.brain) continue;
      const e = this.sim.entities.get(r.id);
      if (!e || e.dead) continue;
      if (r.brain.atCore || r.brain.blockedBy >= 0 || r.brain.engaged) {
        // コアに着いた・バリケードに止められている・撃ち合っている：引っかかりではない
        r.bestDist = undefined;
        continue;
      }
      // 行き先（道すじの点・コアのまわり）へ 1.5m 以上近づいていれば進んでいる（行ったり来たりは数えない）
      const d = lenH(sub(r.brain.goalPoint, e.movement.pos));
      if (r.bestDist === undefined || r.checkWp !== r.brain.waypoint || d < r.bestDist - 1.5) {
        r.bestDist = d;
        r.checkWp = r.brain.waypoint;
        r.checkTime = now;
        continue;
      }
      const stuck = now - (r.checkTime ?? now);
      if (stuck > 75) {
        this.stuckRemoved++;
        r.brain.dispose();
        this.enemies.delete(r.id);
        this.sim.despawn(r.id);
      } else if (stuck > 30 && Math.round(stuck) % 10 === 0) r.brain.repath();
    }
  }

  // ---------------------------------------------------------------------------
  // 突撃兵の自爆
  // ---------------------------------------------------------------------------

  private stepAssaults() {
    const sim = this.sim;
    const def = this.cfg.ENEMIES.assault;
    const range = tdNum(def, 'EXPLODE_RANGE', 4.2);
    for (const r of [...this.enemies.values()]) {
      if (r.type !== 'assault') continue;
      const e = sim.entities.get(r.id);
      if (!e || e.dead) continue;
      const toCore = lenH(sub(e.movement.pos, this.td.core)) - 2.1;
      // コアのほか、引きつけられた囮・ぶつかったバリケードでも自爆する（そのときコアは無事）
      let atCore = toCore <= range;
      let here = atCore;
      if (!here) {
        const lure = r.brain?.lureId ?? -1;
        const o = lure >= 0 ? sim.entities.get(lure) : undefined;
        if (o && !o.dead && len(sub(o.movement.pos, e.movement.pos)) < 2.6) here = true;
      }
      if (!here) {
        for (const d of this.devices.values()) {
          if (d.type !== 'barricade' || !d.ends) continue;
          if (segDist2D(e.movement.pos, d.ends[0], d.ends[1]) < 1.6 && Math.abs(d.pos.y - e.movement.pos.y) < 1.5) {
            here = true;
            break;
          }
        }
      }
      if (!here) continue;
      atCore = atCore || toCore <= range + 1.5;
      // 自爆：コアに大きなダメージ（コアで自爆したときだけ）、まわりのパイロット・タレット・設置物にも
      const pos = add(e.movement.pos, v3(0, 1, 0));
      if (atCore) sim.damageEntity(this.core, tdNum(def, 'EXPLODE_CORE_DAMAGE', 220) * this.enemyDamageMul(), pos, 'grenade', e.id);
      const R = tdNum(def, 'EXPLODE_RADIUS', 5.5);
      const barMul = tdNum(this.cfg.ITEMS.barricade, 'ASSAULT_MUL', 2.5);
      for (const o of [...sim.entities.values()]) {
        if (o.team === e.team || o.dead || o.kind === 'core') continue;
        const c = o.kind === 'barricade' ? this.barricadeNearest(o.id, pos) : chestOf(sim.actorOf(o));
        const d = len(sub(c, pos));
        if (d > R) continue;
        const dmg = tdNum(def, 'EXPLODE_DAMAGE', 70) * this.enemyDamageMul() * (1 - (d / R) * 0.6) * (o.kind === 'barricade' ? barMul : 1);
        if (o.kind !== 'barricade' && !this.los(pos, c)) continue;
        sim.damageEntity(o, dmg, pos, 'grenade', e.id);
      }
      this.events.push({ type: 'assaultExplode', pos: clone(pos) });
      r.brain?.dispose();
      this.enemies.delete(r.id);
      sim.despawn(r.id);
    }
  }

  // ---------------------------------------------------------------------------
  // 迫撃砲兵の砲撃
  // ---------------------------------------------------------------------------

  /** 据えた迫撃砲兵が撃つ（据えてから SETUP_TIME 後、FIRE_INTERVAL ごと）。飛んでいる砲弾を進める */
  private stepMortars(dt: number) {
    const sim = this.sim;
    const def = this.cfg.ENEMIES.mortar;
    for (const r of this.enemies.values()) {
      if (r.type !== 'mortar' || !r.brain?.deployed) continue;
      const e = sim.entities.get(r.id);
      if (!e || e.dead) continue;
      if (!r.mortar) {
        r.mortar = { setup: tdNum(def, 'SETUP_TIME', 3), timer: 0, shots: 0 };
        const sp = r.spot !== undefined && r.spot >= 0 ? this.td.mortarSpots[r.spot] : null;
        this.events.push({ type: 'mortarDeploy', id: r.id, pos: clone(e.movement.pos), spotName: sp?.name ?? this.route(r.route).name, sector: r.route });
      }
      const mo = r.mortar;
      if (mo.setup > 0) {
        mo.setup -= dt;
        continue;
      }
      // 近くのパイロットと撃ち合っている間は撃たない
      if (r.brain.busy) continue;
      mo.timer -= dt;
      if (mo.timer > 0) continue;
      mo.timer = tdNum(def, 'FIRE_INTERVAL', 6.5) * this.rng.range(0.85, 1.15);
      this.fireMortar(r, e);
    }
    this.stepShells(dt);
  }

  /** 砲弾を1発撃つ（コアのまわりの、距離に応じてばらつく所へ） */
  private fireMortar(r: EnemyRec, e: Entity) {
    const def = this.cfg.ENEMIES.mortar;
    const core = this.td.core;
    const pos = e.movement.pos;
    const to = sub(core, pos);
    const L = lenH(to) || 1;
    const fwd = v3(to.x / L, 0, to.z / L);
    const from = v3(pos.x + fwd.x * 0.75, pos.y + 0.75, pos.z + fwd.z * 0.75);
    // コアの真上は空中連絡橋の屋根なので、屋根のない南・北の脇（撃つ所に近い側）を狙う。距離が遠いほどばらつく
    const side = Math.abs(pos.z - core.z) > 1 ? Math.sign(pos.z - core.z) : this.rng.next() < 0.5 ? -1 : 1;
    const aim = v3(core.x, core.y, core.z + side * tdNum(def, 'AIM_SIDE', 6.5));
    const spread = tdNum(def, 'SPREAD', 1.5) + tdNum(def, 'SPREAD_PER_M', 0.02) * L;
    const a = this.rng.range(0, Math.PI * 2);
    const rr = Math.sqrt(this.rng.next()) * spread;
    const target = v3(aim.x + Math.cos(a) * rr, aim.y, aim.z + Math.sin(a) * rr);
    const g = tdNum(def, 'SHELL_GRAVITY', 18);
    const apex = tdNum(def, 'SHELL_APEX', 14) + tdNum(def, 'SHELL_APEX_PER_M', 0.18) * L;
    const { vel, time } = ballisticLaunch(from, target, apex, g);
    const sh: MortarShell = { id: this.nextShellId++, ownerId: r.id, pos: clone(from), vel, from: clone(from), target, gravity: g, born: this.sim.time, flight: time };
    this.shells.set(sh.id, sh);
    r.mortar!.shots++;
    this.events.push({ type: 'mortarFire', id: r.id, shellId: sh.id, from: clone(from), target: clone(target), flight: time });
  }

  /** 飛んでいる砲弾を進める（当たったら爆発） */
  private stepShells(dt: number) {
    const world = this.sim.world;
    for (const sh of [...this.shells.values()]) {
      const prev = clone(sh.pos);
      sh.vel.y -= sh.gravity * dt;
      sh.pos = add(sh.pos, scale(sh.vel, dt));
      const age = this.sim.time - sh.born;
      let hit: Vec3 | null = null;
      if (age > 0.12) {
        const seg = sub(sh.pos, prev);
        const L = len(seg);
        const h = L > 1e-4 ? world.raycast(prev, scale(seg, 1 / L), L) : null;
        if (h) hit = h.point;
      }
      if (!hit && sh.vel.y < 0 && sh.pos.y <= sh.target.y) hit = v3(sh.pos.x, sh.target.y, sh.pos.z);
      if (!hit && age > sh.flight + 3) hit = sh.pos;
      if (hit) this.shellExplode(sh, hit);
    }
  }

  /** 砲弾の爆発：コアの近くならコアに、まわりの味方（パイロット・タレット・設置物）にもダメージ */
  private shellExplode(sh: MortarShell, at: Vec3) {
    const sim = this.sim;
    const def = this.cfg.ENEMIES.mortar;
    const R = tdNum(def, 'SHELL_RADIUS', 4.5);
    const mul = this.enemyDamageMul();
    this.shells.delete(sh.id);
    const pos = v3(at.x, at.y + 0.3, at.z);
    const owner = sim.entities.has(sh.ownerId) ? sh.ownerId : -1;
    // コア：中心から CORE_REACH まで（5m より遠いと減る）。コアより高い所（連絡橋の屋根の上）での爆発は届かない
    const core = this.td.core;
    const dc = lenH(sub(pos, core));
    const reach = tdNum(def, 'CORE_REACH', 7.5);
    let coreHit = false;
    if (dc < reach && pos.y < core.y + CORE_HEIGHT + 1 && !this.core.dead) {
      const k = dc < 5 ? 1 : 1 - (0.5 * (dc - 5)) / Math.max(0.1, reach - 5);
      sim.damageEntity(this.core, tdNum(def, 'SHELL_CORE_DAMAGE', 40) * mul * k, pos, 'grenade', sh.ownerId);
      coreHit = true;
    }
    const tMul = tdNum(def, 'SHELL_TURRET_MUL', 0.5);
    for (const o of [...sim.entities.values()]) {
      if (o.team !== 0 || o.dead || o.kind === 'core') continue;
      const c = o.kind === 'barricade' ? this.barricadeNearest(o.id, pos) : chestOf(sim.actorOf(o));
      const d = len(sub(c, pos));
      if (d > R) continue;
      if (o.kind !== 'barricade' && !this.los(pos, c)) continue;
      const k = o.kind === 'turret' || o.kind === 'barricade' ? tMul : 1;
      sim.damageEntity(o, tdNum(def, 'SHELL_DAMAGE', 45) * mul * k * (1 - (d / R) * 0.6), pos, 'grenade', owner);
    }
    this.events.push({ type: 'mortarExplode', shellId: sh.id, pos, radius: R, core: coreHit });
  }

  /** バリケードの、点 p にいちばん近い所（高さは半分） */
  private barricadeNearest(entityId: number, p: Vec3): Vec3 {
    const d = this.deviceOfEntity(entityId);
    const e = this.sim.entities.get(entityId)!;
    if (!d || !d.ends) return chestOf(this.sim.actorOf(e));
    const t = segParam2D(p, d.ends[0], d.ends[1]);
    return v3(d.ends[0].x + (d.ends[1].x - d.ends[0].x) * t, d.pos.y + e.movement.height * 0.5, d.ends[0].z + (d.ends[1].z - d.ends[0].z) * t);
  }

  // ---------------------------------------------------------------------------
  // 設置物
  // ---------------------------------------------------------------------------

  /** ジャンプパッド：味方のパイロットが乗ったら打ち上げる（シミュレーションを進める前） */
  private stepJumpPads() {
    const sim = this.sim;
    const def = this.cfg.ITEMS.jumppad;
    const R = tdNum(def, 'RADIUS', 1.05);
    const up = tdNum(def, 'LAUNCH_UP', 14.5);
    const fwd = tdNum(def, 'LAUNCH_FORWARD', 4.5);
    const cd = tdNum(def, 'COOLDOWN', 0.8);
    for (const d of this.devices.values()) {
      if (d.type !== 'jumppad' || d.age < 0.4) continue;
      for (const e of sim.entities.values()) {
        if (e.team !== 0 || e.kind !== 'pilot' || e.dead || e.downed > 0) continue;
        const m = e.movement;
        if (m.state !== 'ground' && m.state !== 'slide') continue;
        const dy = m.pos.y - d.pos.y;
        if (dy < -0.3 || dy > 0.6 || lenH(sub(m.pos, d.pos)) > R) continue;
        if (sim.time - (d.lastLaunch.get(e.id) ?? -99) < cd) continue;
        d.lastLaunch.set(e.id, sim.time);
        // 進んでいる向きへ勢いを足す（止まっていれば見ている向きへ少し）
        const hv = v3(m.vel.x, 0, m.vel.z);
        const hs = lenH(hv);
        const dir = hs > 1 ? scale(hv, 1 / hs) : forwardOf(e.lastCmd.yaw);
        const keep = Math.min(hs, 9);
        launch(m, v3(dir.x * (keep + fwd), up, dir.z * (keep + fwd)));
        this.events.push({ type: 'jumpPad', deviceId: d.id, entityId: e.id });
      }
    }
  }

  /** 設置物の1ティック：ワイヤートラップ（作動・連鎖爆発）、大型兵器がバリケードを踏みつぶす */
  private stepDevices(dt: number) {
    const sim = this.sim;
    const tdef = this.cfg.ITEMS.wiretrap;
    for (const d of [...this.devices.values()]) {
      d.age += dt;
      // 撃たれる設置物が倒れていたら取り除く（出来事を見逃したときのため）
      if (d.entityId >= 0) {
        const e = sim.entities.get(d.entityId);
        if (!e || e.dead) {
          this.removeDevice(d, 'destroyed');
          continue;
        }
      }
      if (d.type === 'wiretrap') {
        if (d.fired < 0) {
          if (d.age < tdNum(tdef, 'ARM_TIME', 1.1) || this.phase !== 'wave') continue;
          const hit = this.beamCrossed(d);
          if (hit >= 0) {
            d.fired = 0;
            // 横切った所に近い機雷から順に爆発する
            const ep = sim.entities.get(hit)!.movement.pos;
            d.chain = d.nodes.map((_, i) => i).sort((a, b) => lenH(sub(d.nodes[a], ep)) - lenH(sub(d.nodes[b], ep)));
            this.events.push({ type: 'trapTriggered', deviceId: d.id });
          }
          continue;
        }
        d.fired += dt;
        const delay = tdNum(tdef, 'CHAIN_DELAY', 0.16);
        while (d.blown < d.nodes.length && d.fired >= 0.12 + d.blown * delay) {
          this.trapBlast(d, d.nodes[d.chain[d.blown] ?? d.blown]);
          d.blown++;
        }
        if (d.blown >= d.nodes.length) this.removeDevice(d, 'used');
      } else if (d.type === 'barricade' && d.ends) {
        // 大型兵器は止まらない：踏みつぶす
        for (const r of this.enemies.values()) {
          if (!r.boss) continue;
          const b = sim.entities.get(r.id);
          if (!b || b.dead) continue;
          if (segDist2D(b.movement.pos, d.ends[0], d.ends[1]) < 3.4) {
            const e = sim.entities.get(d.entityId);
            if (e && !e.dead) sim.damageEntity(e, e.health + 1, b.movement.pos, 'grenade', b.id);
            break;
          }
        }
      }
    }
  }

  /** レーザーを横切った地上の敵（いなければ -1） */
  private beamCrossed(d: DeviceState): number {
    const sim = this.sim;
    const bh = tdNum(this.cfg.ITEMS.wiretrap, 'BEAM_HEIGHT', 0.62);
    for (const r of this.enemies.values()) {
      if (r.drone) continue;
      const e = sim.entities.get(r.id);
      if (!e || e.dead) continue;
      const p = e.movement.pos;
      const rad = r.boss ? 2.2 : r.type === 'heavy' ? 0.55 : 0.4;
      for (let i = 0; i < d.nodes.length - 1; i++) {
        const a = d.nodes[i],
          b = d.nodes[i + 1];
        if (segDist2D(p, a, b) > rad) continue;
        const t = segParam2D(p, a, b);
        const y = a.y + (b.y - a.y) * t + bh;
        if (y >= p.y - 0.1 && y <= p.y + e.movement.height) return e.id;
      }
    }
    return -1;
  }

  /** ワイヤートラップの機雷1つの爆発（地上の敵だけにダメージ。倒したら置いた参加者のもの） */
  private trapBlast(d: DeviceState, node: Vec3) {
    const sim = this.sim;
    const def = this.cfg.ITEMS.wiretrap;
    const R = tdNum(def, 'RADIUS', 4.2);
    const dmg = tdNum(def, 'DAMAGE', 130);
    const minD = tdNum(def, 'MIN_DAMAGE', 35);
    const pos = v3(node.x, node.y + 0.5, node.z);
    // 置いた参加者がいなくなっていたら、誰のものでもない
    const owner = sim.entities.has(d.ownerId) ? d.ownerId : -1;
    for (const r of [...this.enemies.values()]) {
      if (r.drone) continue;
      const e = sim.entities.get(r.id);
      if (!e || e.dead) continue;
      const c = chestOf(sim.actorOf(e));
      const dist = r.boss ? Math.max(0, lenH(sub(e.movement.pos, pos)) - 2) : len(sub(c, pos));
      if (dist > R) continue;
      if (!r.boss && !this.los(pos, c)) continue;
      sim.damageEntity(e, minD + (dmg - minD) * (1 - dist / R), pos, 'grenade', owner);
    }
    this.events.push({ type: 'trapExplode', deviceId: d.id, pos, radius: R });
  }

  // ---------------------------------------------------------------------------

  /** 操作している参加者の情報 */
  participantOf(id: number): TdParticipant | undefined {
    return this.participants.get(id);
  }

  /** そのタレットの、体の向きを含めた砲口（描画用） */
  turretMuzzle(t: TurretState): Vec3 {
    return add(v3(t.pos.x, t.pos.y + TURRET_MUZZLE_Y, t.pos.z), rotY(v3(0, 0, -0.9), t.yaw));
  }

  dispose(): void {
    for (const b of this.allies.values()) b.dispose();
    for (const r of this.enemies.values()) r.brain?.dispose();
    this.allies.clear();
    this.enemies.clear();
  }
}

/** タワーディフェンスのシミュレーションを作る（ステージ・経路データ・試合） */
export function createTdMatch(level: Simulation['level'], nav: NavGraph, opts: TdOptions, cfg: MovementConfig, wcfg: WeaponsConfig, ccfg: CharactersConfig): TdMatch {
  const sim = new Simulation(level, cfg, wcfg, ccfg);
  return new TdMatch(sim, nav, opts);
}

export { TURRET_TYPES };
