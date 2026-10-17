/**
 * タワーディフェンスの進行（描画側）。ゲームロジックの TdMatch を持ち、
 * 味方・敵・タレット・コアの表示、射撃と爆発の演出、3D の音、画面表示、
 * タレットの購入と設置・売却、蘇生、リザルトと記録の保存をつなぐ。
 *
 * 操作（仕様 3.1・5.3）：
 *   B：購入メニュー（マウスのカーソルが出る。準備時間中はすべて、ウェーブ中はアーマーだけ買える）。
 *      カードを押すと、置く物は置く場所を選ぶ：見ている先に影が出て、左クリック・E で置く、R・ホイールで向きを回す、
 *      右クリックでメニューへ戻る、B でやめる。置くとメニューに戻る。メニューの外をクリック・B で閉じる
 *   E 長押し：ダウンした味方の蘇生（3 秒）／ 準備時間中に自分のタレット・設置物を見て押し続けると売る（半額が戻る）
 *   F：準備完了（全員がそろうと準備時間を飛ばす）
 */
import type { WeaponCustom } from '../../shared/weaponCustom';
import * as THREE from 'three';
import { type BotDifficulty, type CharacterId, type GrenadeId, type TdEnemyType, type TdPlaceable, type WeaponId, TURRET_TYPES, charactersConfig, isTurretType, movementConfig, tdConfig, weaponsConfig } from '../../config';
import type { InputCommand } from '../../shared/input';
import type { LevelData, TdDropKind } from '../../shared/level';
import { type Vec3, lenH, sub } from '../../shared/math';
import { segDist2D } from '../../shared/td/devices';
import { Simulation, TICK_DT } from '../../shared/simulation';
import { TdMatch } from '../../shared/td/towerDefense';
import type { Assets, TdAssets } from '../assets';
import type { Sfx } from '../audio';
import type { ShotEffects } from '../weapons/effects';
import type { WeaponHud } from '../weaponHud';
import type { SonarWaves } from '../abilities/abilityFx';
import type { InputManager } from '../input';
import { ActorViews, ALLY_COLOR, ENEMY_COLOR } from '../attrition/actorViews';
import { navFor } from '../attrition/controller';
import { type BestTd, DIFF_NAMES, type PromptState, ROUTE_NAMES, TdHud } from './tdHud';
import { TdViews } from './tdViews';
import { TdThumbs } from './tdThumbs';
import { type BuyId, buyState } from './buyMenu';
import { Minimap, type MinimapMarker, type MinimapRoute } from '../ui/minimap';

export interface TdHost {
  readonly assets: Assets;
  readonly tdAssets: TdAssets;
  readonly sfx: Sfx;
  readonly effects: ShotEffects;
  readonly weaponHud: WeaponHud;
  readonly sonar: SonarWaves;
  readonly input: InputManager;
  readonly group: THREE.Group;
  readonly camera: THREE.PerspectiveCamera;
  size(): { width: number; height: number };
  tabHeld(): boolean;
  restart(): void;
  toMenu(): void;
  onResult(): void;
  /** 爆発の火の玉 */
  explode(pos: Vec3, radius: number): void;
  /** 画面を揺らす（0〜） */
  shake(amount: number): void;
}

export interface TdSetup {
  difficulty: BotDifficulty;
  character: CharacterId;
  loadout: [WeaponId, WeaponId];
  /** 武器のカスタマイズ（メイン・サブ） */
  custom?: [WeaponCustom, WeaponCustom];
  /** グレネードの種類 */
  grenade?: GrenadeId;
  seed?: number;
  /** 確認用：このウェーブから始める */
  startWave?: number;
}

const BEST_KEY = 'vr.td.best';
export function loadTdBest(): BestTd {
  try {
    const v = JSON.parse(localStorage.getItem(BEST_KEY) ?? 'null');
    if (v && typeof v.matches === 'number') return { waves: v.waves ?? {}, fastest: v.fastest ?? {}, wins: v.wins ?? 0, matches: v.matches };
  } catch {
    /* 保存できない環境 */
  }
  return { waves: {}, fastest: {}, wins: 0, matches: 0 };
}
function saveTdBest(b: BestTd) {
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(b));
  } catch {
    /* 保存できなくても続ける */
  }
}

const TRACER_ALLY = new THREE.Color('#7fd8ff');
const TRACER_ENEMY = new THREE.Color('#ff7a5a');
const TRACER_TURRET = new THREE.Color('#9fe6ff');
const WORLD_SPARK = new THREE.Color('#ffb45c');
const ACTOR_SPARK = new THREE.Color('#ff5a8a');
const SHIELD_SPARK = new THREE.Color('#ffa04a');
const ENEMY_LABEL: Record<TdEnemyType, string> = { grunt: '歩兵', assault: '突撃兵', heavy: '重装兵', mortar: '迫撃砲兵', drone: 'ドローン', boss: '大型兵器' };
/** 降下ポッドの降りる場所の種類ごとの色（ミニマップ・知らせ） */
export const DROP_COLOR: Record<TdDropKind, string> = { outer: '#ff5a3a', wall: '#ffa040', inner: '#ff4a8a' };

/** 購入メニューのカードの絵（モデルごとに 1 度だけ描く） */
const thumbCache = new WeakMap<TdAssets, TdThumbs>();
function thumbsFor(a: TdAssets): TdThumbs {
  let t = thumbCache.get(a);
  if (!t) thumbCache.set(a, (t = new TdThumbs(a)));
  return t;
}
const nameOf = (k: TdPlaceable) => (isTurretType(k) ? tdConfig.TURRETS[k].NAME : tdConfig.ITEMS[k].NAME);

export class TdController {
  readonly match: TdMatch;
  readonly views: ActorViews;
  readonly td: TdViews;
  readonly hud: TdHud;
  readonly minimap: Minimap;
  private resultShown = false;
  private stepDist = new Map<number, number>();
  private readonly tmp = new THREE.Vector3();
  // --- 購入・設置 ---
  private menuOpen = false;
  private placing: TdPlaceable | null = null;
  /** 置く向き（見ている向きから、R・ホイールで 45° ずつ回す） */
  private placeTurn = 0;
  private place: { pos: Vec3 | null; ok: boolean; reason: string; yaw: number; nodes?: Vec3[] } = { pos: null, ok: false, reason: '', yaw: 0 };
  private adsWas = false;
  private lastArmor = 0;
  // --- E を押し続ける操作 ---
  private sellHold = 0;
  private sellTarget = -1;
  private sellBlock = false;
  private reviveTarget = -1;
  private lastReviveTick = 0;
  private prompt: PromptState = { text: '', progress: -1, progressLabel: '' };
  private noteTimer = 0;
  private lastDroneBeep = 0;
  /** 迫撃砲兵が最後に撃った時刻（ミニマップの輪）・最後に「陣取った」を知らせた時刻 */
  private readonly mortarFired = new Map<number, number>();
  private lastMortarNote = -99;
  /** 降下ポッドの警告を最後に鳴らした時刻（降下地点ごと） */
  private readonly podAlerts = new Map<string, number>();

  constructor(
    private readonly host: TdHost,
    level: LevelData,
    readonly setup: TdSetup,
  ) {
    const sim = new Simulation(level, movementConfig, weaponsConfig, charactersConfig);
    this.match = new TdMatch(sim, navFor(level), {
      difficulty: setup.difficulty,
      seed: setup.seed ?? (Date.now() & 0xffff),
      playerCharacter: setup.character,
      playerLoadout: setup.loadout,
      playerCustom: setup.custom,
      playerGrenade: setup.grenade,
      startWave: setup.startWave,
    });
    const player = this.match.player!;
    this.views = new ActorViews(host.assets, player.team, { td: host.tdAssets });
    host.group.add(this.views.group);
    this.views.sync(sim, player.id);
    this.td = new TdViews(host.tdAssets, this.match, {
      explode: (p, r) => host.explode(p, r),
      shake: (p, s) => {
        const d = host.camera.position.distanceTo(new THREE.Vector3(p.x, p.y, p.z));
        host.shake(Math.max(0, s * (1 - d / 60)) * 0.6);
      },
      sound: (k, p) => host.sfx.deviceAt(k, p, host.camera.position.distanceTo(new THREE.Vector3(p.x, p.y, p.z))),
    });
    host.group.add(this.td.group);
    // 迫撃砲兵が背負う迫撃砲は、キャラクターの胸の骨に付ける
    this.td.mortars.actorRoot = (id) => this.views.get(id)?.view.root ?? null;
    this.hud = new TdHud(
      player.id,
      { retry: () => host.restart(), menu: () => host.toMenu() },
      {
        buy: (id) => this.select(id),
        upgrade: (id) => this.upgrade(id),
        close: () => this.closeMenu(),
        hoverTurret: (id) => this.td.setHighlight(id),
      },
      thumbsFor(host.tdAssets),
    );
    this.hud.show(true);
    this.minimap = new Minimap(level, this.hud.root);
    // 広いマップなので、大きくしたミニマップは要塞のまわりの草原まで映す
    this.minimap.largeRadius = 175;
    host.input.clearPresses();
  }

  get sim(): Simulation {
    return this.match.sim;
  }

  private get pid(): number {
    return this.match.player!.id;
  }

  // ---------------------------------------------------------------------------
  // 入力（ティックごと）
  // ---------------------------------------------------------------------------

  /** 購入メニューを開く（マウスのカーソルを出す） */
  private openMenu() {
    if (this.menuOpen) return;
    this.menuOpen = true;
    this.host.input.enterCursor();
    this.host.sfx.uiTick();
  }

  /** 購入メニューを閉じる（マウスを固定し直す） */
  private closeMenu() {
    if (!this.menuOpen) return;
    this.menuOpen = false;
    this.host.input.exitCursor();
    this.td.setHighlight(-1);
  }

  /** メニューのカードを押した：置く物は置く場所を選び始める。アーマーはすぐ買う */
  private select(id: BuyId) {
    const m = this.match;
    if (id === 'armor') {
      if (m.buyArmor(this.pid)) {
        this.host.sfx.purchase();
        this.host.sfx.armor(true);
      } else {
        this.note(m.armorCheck(this.pid).reason ?? '買えない');
        this.host.sfx.abilityNotReady();
      }
      return;
    }
    const st = buyState(m, this.pid, id);
    if (!st.ok) {
      this.note(st.reason);
      this.host.sfx.abilityNotReady();
      return;
    }
    this.placing = id;
    this.placeTurn = 0;
    this.host.sfx.uiTick();
    this.closeMenu();
  }

  private upgrade(turretId: number) {
    const m = this.match;
    if (m.tryUpgrade(this.pid, turretId)) {
      this.host.sfx.purchase();
      this.host.sfx.upgrade(m.turrets.get(turretId)?.level ?? 2);
    } else {
      this.note(m.upgradeCheck(this.pid, turretId).reason ?? '強化できない');
      this.host.sfx.abilityNotReady();
    }
  }

  /** プレイヤーの入力に、タワーディフェンスの操作を重ねる（購入・設置・売る・準備完了） */
  filterCommand(cmd: InputCommand): InputCommand {
    const m = this.match;
    const input = this.host.input;
    const p = m.player!;
    const alive = !p.dead && p.downed <= 0;
    const prep = m.phase === 'prep';
    const canMenu = alive && (prep || m.phase === 'wave');
    const c = { ...cmd };

    // Esc などでカーソルの操作が終わっていたら、メニューも閉じた扱い
    if (this.menuOpen && !input.cursorMode) {
      this.menuOpen = false;
      this.td.setHighlight(-1);
    }
    if (!canMenu) this.closeMenu();
    if (!prep || !alive) this.placing = null;

    // 購入メニュー（B）
    if (input.consumePress('KeyB')) {
      if (!canMenu) this.note('いまは購入できない');
      else if (this.placing) {
        this.placing = null;
        this.host.sfx.uiTick();
      } else if (this.menuOpen) this.closeMenu();
      else this.openMenu();
    }
    // メニューの外をクリックしたら閉じる
    if (this.menuOpen && input.consumeCursorClick()) this.closeMenu();
    // 1〜4：タレットを選ぶ（メニューを開いている間）
    for (let i = 0; i < TURRET_TYPES.length; i++) if (input.consumePress(`Digit${i + 1}`) && this.menuOpen) this.select(TURRET_TYPES[i]);
    if (this.menuOpen) {
      c.switchTo = -1;
      c.switchNext = false;
      c.fireHeld = c.firePressed = false;
      c.adsHeld = false;
      c.meleePressed = false;
      c.grenadeHeld = false;
    }

    // 置く場所を選んでいる間：左クリック・E で置く、R・ホイールで回す、右クリックでメニューへ戻る
    const ePressed = input.consumePress('KeyE');
    if (this.placing) {
      if (cmd.reloadPressed || cmd.switchNext) {
        this.placeTurn += Math.PI / 4;
        if (this.placing === 'barricade' || this.placing === 'wiretrap' || this.placing === 'decoy') this.host.sfx.uiTick();
      }
      this.updatePlacement();
      const confirm = cmd.firePressed || ePressed;
      if (confirm) {
        const kind = this.placing;
        if (this.place.ok && this.place.pos && m.tryPlace(this.pid, kind, this.place.pos, this.place.yaw)) {
          this.host.sfx.turretPlace();
          this.placing = null;
          this.sellBlock = true; // 置いたときの E のまま、すぐ売らないように
          this.openMenu(); // 次の買い物へ
        } else {
          this.host.sfx.abilityNotReady();
          this.note(this.place.reason || '置けない');
        }
      }
      if (cmd.adsHeld && !this.adsWas) {
        this.placing = null;
        this.openMenu();
      }
      c.fireHeld = false;
      c.firePressed = false;
      c.adsHeld = false;
      c.interactHeld = false;
      c.grenadeHeld = false;
      c.meleePressed = false;
      c.reloadPressed = false;
      c.switchNext = false;
      c.switchTo = -1;
    }
    this.adsWas = cmd.adsHeld;

    // 準備完了（F）
    if (input.consumePress('KeyF')) {
      if (prep) {
        const me = m.participantOf(this.pid)!;
        if (!me.ready) {
          m.setReady(this.pid);
          this.host.sfx.readyChime();
        }
      } else this.note('準備完了は準備時間中だけ');
    }
    // E 長押し：蘇生（近くにダウンした味方がいれば、そちらを先に）／売る
    this.reviveTarget = alive ? this.nearbyDowned() : -1;
    this.sellTarget = -1;
    if (alive && prep && this.reviveTarget < 0 && !this.placing && !this.menuOpen) this.sellTarget = this.lookedOwned();
    if (!cmd.interactHeld) this.sellBlock = false;
    if (this.sellTarget >= 0 && cmd.interactHeld && !this.sellBlock) {
      this.sellHold += TICK_DT;
      if (this.sellHold >= m.cfg.SELL_HOLD) {
        if (m.trySell(this.pid, this.sellTarget)) this.host.sfx.turretGone(false);
        this.sellHold = 0;
        this.sellTarget = -1;
      }
    } else this.sellHold = 0;
    if (this.sellTarget >= 0) c.interactHeld = false; // 売るときは蘇生の入力にしない
    return c;
  }

  /** 置く場所（見ている先の地面。置ける範囲まで） */
  private updatePlacement() {
    const m = this.match;
    const sim = this.sim;
    const p = m.player!;
    const eye = sim.eyeOf(p);
    const yaw = p.lastCmd.yaw,
      pitch = p.lastCmd.pitch;
    const dir = { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) };
    const range = m.cfg.PLACE_RANGE;
    const hit = sim.world.raycast(eye, dir, range + 1);
    let at: Vec3;
    if (hit && hit.normal.y > 0.7) at = { ...hit.point };
    else {
      // 壁に当たった・何もない：その手前から下へ地面を探す
      const L = hit ? Math.max(0.5, hit.t - 0.8) : range;
      const end = { x: eye.x + dir.x * L, y: eye.y + dir.y * L, z: eye.z + dir.z * L };
      const g = sim.world.raycast(end, { x: 0, y: -1, z: 0 }, 6);
      at = g ? { ...g.point } : { ...p.movement.pos };
    }
    // 近すぎる（自分と重なる）ときは、見ている向きへ少し離す
    const near = lenH(sub(at, p.movement.pos));
    if (near < 2.2) {
      const fx = -Math.sin(yaw),
        fz = -Math.cos(yaw);
      at = { x: p.movement.pos.x + fx * 2.2, y: at.y, z: p.movement.pos.z + fz * 2.2 };
      const g = sim.world.raycast({ x: at.x, y: p.movement.pos.y + 1.2, z: at.z }, { x: 0, y: -1, z: 0 }, 4);
      if (g) at.y = g.point.y;
    }
    // 置ける距離まで寄せる
    const d = lenH(sub(at, p.movement.pos));
    if (d > range) {
      const k = range / d;
      at = { x: p.movement.pos.x + (at.x - p.movement.pos.x) * k, y: at.y, z: p.movement.pos.z + (at.z - p.movement.pos.z) * k };
      const g = sim.world.raycast({ x: at.x, y: at.y + 2, z: at.z }, { x: 0, y: -1, z: 0 }, 5);
      if (g) at.y = g.point.y;
    }
    const kind = this.placing!;
    const want = yaw + this.placeTurn;
    const chk = m.placeCheck(this.pid, kind, at, want);
    const cost = isTurretType(kind) ? tdConfig.TURRETS[kind].COST : tdConfig.ITEMS[kind].COST;
    this.place = { pos: chk.pos ?? at, ok: chk.ok, reason: chk.ok ? `${cost} クレジット` : chk.reason ?? '置けない', yaw: chk.yaw ?? want, nodes: chk.nodes };
  }

  /** 近くの、ダウンした味方 */
  private nearbyDowned(): number {
    const m = this.match;
    const p = m.player!;
    let best = -1,
      bd = Infinity;
    for (const e of m.downedAllies(p.team)) {
      const d = sub(e.movement.pos, p.movement.pos);
      const h = lenH(d);
      if (h > m.cfg.REVIVE_RANGE || Math.abs(d.y) > 1.6 || h >= bd) continue;
      bd = h;
      best = e.id;
    }
    return best;
  }

  /** 見ている自分のタレット・設置物（近いものだけ）。タレットは参加者の番号、設置物は設置物の番号 */
  private lookedOwned(): number {
    const m = this.match;
    const p = m.player!;
    const eye = this.sim.eyeOf(p);
    const yaw = p.lastCmd.yaw,
      pitch = p.lastCmd.pitch;
    const dir = new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    const o = new THREE.Vector3(eye.x, eye.y, eye.z);
    let best = -1,
      bs = Infinity;
    const consider = (id: number, c: THREE.Vector3, r: number) => {
      const to = c.clone().sub(o);
      const along = to.dot(dir);
      if (along < 0 || along > 5.5) return;
      const off = to.clone().sub(dir.clone().multiplyScalar(along)).length();
      if (off > r || along >= bs) return;
      bs = along;
      best = id;
    };
    for (const t of m.turrets.values()) if (t.ownerId === this.pid) consider(t.id, new THREE.Vector3(t.pos.x, t.pos.y + 1.0, t.pos.z), 1.0);
    for (const d of m.devices.values()) {
      if (d.ownerId !== this.pid || d.fired >= 0) continue;
      if (d.type === 'barricade' && d.ends) {
        // 見ている線に近い、壁の上の点
        const a = d.ends[0],
          b = d.ends[1];
        let bp = new THREE.Vector3(),
          bd = Infinity;
        for (let k = 0; k <= 8; k++) {
          const q = new THREE.Vector3(a.x + ((b.x - a.x) * k) / 8, d.pos.y + 0.7, a.z + ((b.z - a.z) * k) / 8);
          const to = q.clone().sub(o);
          const off = to.clone().sub(dir.clone().multiplyScalar(to.dot(dir))).length();
          if (off < bd) {
            bd = off;
            bp = q;
          }
        }
        consider(d.id, bp, 0.9);
      } else {
        const h = d.type === 'decoy' ? 1.0 : d.type === 'wiretrap' ? 0.45 : 0.2;
        consider(d.id, new THREE.Vector3(d.pos.x, d.pos.y + h, d.pos.z), d.type === 'jumppad' ? 1.1 : 0.8);
      }
    }
    void segDist2D;
    return best;
  }

  private note(text: string) {
    this.hud.orderNote(text);
    this.noteTimer = 1.8;
  }

  // ---------------------------------------------------------------------------

  /** 1ティック進める */
  step(cmd: InputCommand): void {
    this.match.step(cmd);
  }

  /** ティックの後：表示と、出来事の演出 */
  afterTick(listener: THREE.Vector3): void {
    const m = this.match;
    const sim = m.sim;
    const pid = this.pid;
    this.views.sync(sim, pid);
    this.views.afterTick(sim);
    this.td.afterTick();
    this.td.onEvents(m.events);
    const h = this.host;
    const dist = (p: { x: number; y: number; z: number }) => Math.hypot(p.x - listener.x, p.y - listener.y, p.z - listener.z);

    for (const e of sim.entities.values()) {
      if (e.id === pid) continue;
      const ally = e.team === m.player!.team;
      for (const ev of e.arsenal.events) {
        if (ev.type === 'spinUp' || ev.type === 'spinDown') h.sfx.spinAt(ev.type === 'spinUp', e.movement.pos, dist(e.movement.pos));
        if (ev.type !== 'shot') continue;
        // サプレッサーを付けた銃声は、ミニマップに映らない
        if (!ally && !ev.suppressed) this.minimap.noteShot(e.id, e.movement.pos, sim.time);
        const from = this.views.muzzleOf(e.id, this.tmp.clone()) ?? this.td.muzzleOf(e.id, this.tmp.clone()) ?? new THREE.Vector3(ev.origin.x, ev.origin.y, ev.origin.z);
        h.effects.muzzleFlash(from, e.kind === 'boss' ? 1.6 : ev.hits.length > 1 ? 1.2 : 0.8);
        const w = weaponsConfig[ev.weapon];
        ev.hits.forEach((hit, i) => {
          const to = new THREE.Vector3(hit.point.x, hit.point.y, hit.point.z);
          if (hit.kind === 'actor' && hit.actorId === pid) {
            const d = to.clone().sub(from);
            to.copy(from).add(d.multiplyScalar(Math.max(0, 1 - 1.2 / Math.max(1.2, d.length()))));
          }
          if (w.PELLETS === 1 || i % 3 === 0) h.effects.tracer(from, to, ally ? TRACER_ALLY : TRACER_ENEMY);
          const n = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
          if (hit.kind === 'world') h.effects.impact(to, n, WORLD_SPARK, 0.45);
          else if (hit.kind === 'shield') h.effects.impact(to, n, SHIELD_SPARK, 0.6);
          else if (hit.kind === 'actor' && hit.actorId !== pid) h.effects.impact(to, n, ACTOR_SPARK, 0.5);
        });
        const d = dist(ev.origin);
        h.sfx.shotAt(ev.weapon, ev.origin, d, ev.suppressed);
        if (!ally && d > 4 && ev.hits.length) {
          const a = new THREE.Vector3(ev.origin.x, ev.origin.y, ev.origin.z);
          const b = new THREE.Vector3(ev.hits[0].point.x, ev.hits[0].point.y, ev.hits[0].point.z);
          const near = new THREE.Line3(a, b).closestPointToPoint(listener, true, new THREE.Vector3()).distanceTo(listener);
          if (near < 1.6) h.sfx.bulletWhiz();
        }
      }
      for (const ev of e.abilityEvents) {
        if (ev.type === 'abilityUsed') h.sfx.abilityAt(ev.ability, e.movement.pos, dist(e.movement.pos));
        if (ev.type === 'sonarPulse') {
          const g = sim.world.raycast(ev.origin, { x: 0, y: -1, z: 0 }, 4);
          h.sonar.spawn(ev.origin, ev.radius, 60, g ? g.point.y : e.movement.pos.y);
        }
      }
      for (const ev of e.movement.events) if (ev.type === 'land' && ev.impactSpeed > 6) h.sfx.landingAt(e.movement.pos, dist(e.movement.pos), sim.footstepVolumeOf(e), ev.impactSpeed);
    }

    for (const ev of sim.events) {
      if (ev.type === 'playerDamaged') {
        this.td.onHit(ev.entityId, ev.amount);
        if (ev.attackerId === pid && ev.entityId !== pid) {
          const v = sim.entities.get(ev.entityId);
          if (v && v.team !== m.player!.team) {
            const top = v.kind === 'drone' ? 0.8 : v.movement.height + 0.1;
            const p = new THREE.Vector3(v.movement.pos.x, v.movement.pos.y + top, v.movement.pos.z);
            const killed = sim.events.some((x) => x.type === 'kill' && x.victimId === v.id);
            h.weaponHud.damageNumber(p, ev.amount, !!ev.head);
            h.weaponHud.hit(!!ev.head, killed);
            if (!killed) h.sfx.hit(!!ev.head);
          }
        }
      }
      if (ev.type === 'kill') {
        const v = this.views.get(ev.victimId);
        if (v && ev.victimKind !== 'pilot') {
          h.sfx.deathAt(v.outer.position, dist(v.outer.position), false);
          const c = v.outer.position.clone().add(new THREE.Vector3(0, 1.1, 0));
          h.effects.impact(c, new THREE.Vector3(0, 1, 0), v.ally ? ALLY_COLOR : ENEMY_COLOR, 1.1);
        }
        if (ev.killerId === pid) {
          if (ev.victimKind === 'boss') h.sfx.pilotKill();
          else h.sfx.kill();
        }
      }
    }

    const pName = (id: number) => {
      const e = sim.entities.get(id);
      if (!e) return '';
      const def = charactersConfig[e.character];
      return `<span class="at-n ${id === pid ? 'me' : 'ally'}"><i style="--char:${def.COLOR}"></i>${id === pid ? 'あなた' : e.name}</span>`;
    };
    for (const ev of m.events) {
      switch (ev.type) {
        case 'phase':
          if (ev.phase === 'prep') {
            const routes = m.waveRoutes().map((r) => ROUTE_NAMES[r]).join('・');
            // 防壁の上・要塞の中に降りてくる所（あれば）
            const inside = [...new Set(m.plannedDrops().filter((d) => d.zone.kind !== 'outer').map((d) => d.zone.name))];
            const drops = inside.length ? `<br><span class="drop">降下予定：${inside.join('・')}</span>` : '';
            this.hud.announce(`WAVE ${ev.wave} の準備`, `侵入ルート：${routes}${m.waveHasBoss() ? '　<b class="boss">大型兵器が来る</b>' : ''}${drops}<br><small>B 購入メニュー　F 準備完了</small>`, 'ally', 4, 'PREPARE');
            h.sfx.alertBeep();
          }
          if (ev.phase === 'victory') {
            this.hud.announce('防衛成功', `全 ${m.totalWaves} ウェーブを守りきった`, 'win', 9);
            h.sfx.matchEnd(true);
          }
          if (ev.phase === 'defeat') {
            this.hud.announce('防衛失敗', 'コアが破壊された', 'lose', 9);
            h.sfx.matchEnd(false);
          }
          break;
        case 'waveStart':
          this.hud.announce(`WAVE ${ev.wave}`, `${ev.routes.map((r) => ROUTE_NAMES[r]).join('・')} から侵攻${ev.boss ? '　<b class="boss">大型兵器 接近</b>' : ''}`, ev.boss ? 'enemy' : 'warn', 3, ev.boss ? 'WARNING' : 'INCOMING');
          h.sfx.waveStart(ev.boss);
          break;
        case 'waveClear':
          if (ev.wave < m.totalWaves) {
            this.hud.announce(`WAVE ${ev.wave} クリア`, `全員に +${ev.bonus} クレジット`, 'go', 3, 'CLEAR');
            h.sfx.waveClear();
          }
          break;
        case 'credits':
          if (ev.pid === pid && ev.reason !== 'sell') {
            const label = ev.reason === 'bonus' ? 'ウェーブ ボーナス' : ev.reason === 'turretKill' ? `タレットが撃破<small>${ENEMY_LABEL[ev.enemy!]}</small>` : `${ENEMY_LABEL[ev.enemy!] ?? ''}撃破`;
            this.hud.popup(ev.amount, label, ev.reason === 'bonus' || ev.enemy === 'boss');
            h.sfx.credits(ev.amount >= 100);
          }
          break;
        case 'enemyKilled':
          if (ev.enemy === 'mortar' && m.enemies.get(ev.id)?.mortar) {
            this.hud.log(`${ev.ownerId >= 0 ? pName(ev.ownerId) : '<span class="at-n ally">チーム</span>'}<span class="at-w">撃破</span><span class="at-n enemy">迫撃砲兵</span>`, ev.ownerId === pid);
          }
          if (ev.enemy === 'boss') {
            this.hud.log(`${ev.ownerId >= 0 ? pName(ev.ownerId) : '<span class="at-n ally">チーム</span>'}<span class="at-w">撃破</span><span class="at-n enemy">大型兵器</span>`, ev.ownerId === pid);
            this.hud.announce('大型兵器を撃破', '', 'go', 2.6, 'DESTROYED');
          }
          break;
        case 'turretPlaced':
          if (ev.ownerId !== pid) h.sfx.landingAt(ev.pos, dist(ev.pos), 0.6, 8);
          break;
        case 'turretDestroyed':
          this.hud.log(`<span class="at-n enemy">敵</span><span class="at-w">破壊</span>${pName(ev.ownerId)}<span class="at-n">のタレット</span>`, ev.ownerId === pid);
          if (ev.ownerId === pid) h.sfx.turretGone(true);
          break;
        case 'turretSold':
          break;
        case 'devicePlaced':
          if (ev.ownerId !== pid) h.sfx.landingAt(ev.pos, dist(ev.pos), 0.5, 7);
          break;
        case 'deviceRemoved':
          if (ev.reason === 'destroyed' && ev.ownerId === pid) this.hud.log(`<span class="at-n enemy">敵</span><span class="at-w">破壊</span>${pName(ev.ownerId)}<span class="at-n">の${nameOf(ev.device)}</span>`, true);
          break;
        case 'turretUpgraded':
          if (ev.ownerId !== pid) {
            const t = m.turrets.get(ev.turretId);
            if (t) h.sfx.repairAt(t.pos, dist(t.pos));
          }
          break;
        case 'turretFire': {
          if (ev.turret !== 'mg') break;
          const from = this.td.muzzleOf(ev.turretId, this.tmp.clone()) ?? new THREE.Vector3(ev.from.x, ev.from.y, ev.from.z);
          const to = new THREE.Vector3(ev.to.x, ev.to.y, ev.to.z);
          h.effects.muzzleFlash(from, 0.8);
          h.effects.tracer(from, to, TRACER_TURRET);
          const n = from.clone().sub(to).normalize();
          if (ev.hit === 'world') h.effects.impact(to, n, WORLD_SPARK, 0.4);
          else if (ev.hit === 'actor') h.effects.impact(to, n, ACTOR_SPARK, 0.45);
          h.sfx.mgTurretAt(ev.from, dist(ev.from));
          break;
        }
        case 'rocketLaunch':
          h.sfx.rocketLaunchAt(ev.from, dist(ev.from), ev.boss);
          break;
        case 'rocketExplode':
          h.sfx.explosionAt(ev.pos, dist(ev.pos));
          break;
        case 'assaultExplode':
          h.sfx.explosionAt(ev.pos, dist(ev.pos));
          break;
        case 'mortarExplode':
          h.sfx.explosionAt(ev.pos, dist(ev.pos));
          break;
        case 'mortarFire':
          this.mortarFired.set(ev.id, sim.time);
          break;
        case 'mortarDeploy':
          // 迫撃砲兵が陣取った：知らせ（続けては出さない）と、キルログ
          this.hud.log(`<span class="at-n enemy">迫撃砲兵</span><span class="at-w">陣取った</span><span class="at-n">${ev.spotName}</span>`, false);
          if (sim.time - this.lastMortarNote > 10) {
            this.lastMortarNote = sim.time;
            this.hud.announce('迫撃砲兵が陣取った', `${ev.spotName}<br><small>コアを砲撃してくる。近づいて倒せ</small>`, 'warn', 2.4, 'MORTAR');
            h.sfx.podWarning(false);
          }
          break;
        case 'repairPulse': {
          const t = m.turrets.get(ev.turretId);
          if (t) h.sfx.repairAt(t.pos, dist(t.pos));
          break;
        }
        case 'coreAlert':
          this.hud.announce('コアが攻撃されている', '', 'warn alert', 1.8, 'ALERT');
          h.sfx.coreAlarm();
          break;
        case 'downed':
          this.hud.log(`${pName(ev.entityId)}<span class="at-w">ダウン</span>`, ev.entityId === pid);
          if (ev.entityId === pid) {
            h.sfx.downed();
            this.closeMenu();
            this.placing = null;
          }
          break;
        case 'revived':
          this.hud.log(`${pName(ev.byId)}<span class="at-w">蘇生</span>${pName(ev.entityId)}`, ev.entityId === pid || ev.byId === pid);
          if (ev.entityId === pid || ev.byId === pid) h.sfx.revived();
          break;
        case 'bleedout':
          this.hud.log(`${pName(ev.entityId)}<span class="at-w">倒れた</span>`, ev.entityId === pid);
          if (ev.entityId === pid) h.sfx.death();
          break;
        case 'bossStep': {
          const d = dist(ev.pos);
          h.sfx.bossStepAt(ev.pos, d);
          if (d < 50) h.shake(0.25 * (1 - d / 50));
          break;
        }
        case 'podIncoming':
          // 防壁の上・要塞の中に降りてくる：知らせと警告音（同じ場所は続けて鳴らさない）
          if (ev.kind !== 'outer' && sim.time - (this.podAlerts.get(ev.zone) ?? -99) > 5) {
            this.podAlerts.set(ev.zone, sim.time);
            h.sfx.podWarning(ev.kind === 'inner');
          }
          break;
        case 'enemySpawn':
          if (ev.enemy === 'drone' && m.sim.time - this.lastDroneBeep > 4) {
            this.lastDroneBeep = m.sim.time;
            const e = sim.entities.get(ev.id);
            if (e) h.sfx.droneBeepAt(e.movement.pos, dist(e.movement.pos));
          }
          break;
      }
    }
    // アーマーが割れた
    const ar = m.player!.armor;
    if (this.lastArmor > 0 && ar <= 0 && sim.events.some((x) => x.type === 'playerDamaged' && x.entityId === pid && !!x.armor)) h.sfx.armor(false);
    this.lastArmor = ar;
    // 自分の蘇生の進み：押している間は小さな音
    const t = this.reviveTarget >= 0 ? sim.entities.get(this.reviveTarget) : undefined;
    if (t && t.reviverId === pid && t.reviveProgress > 0 && sim.time - this.lastReviveTick > 0.25) {
      this.lastReviveTick = sim.time;
      h.sfx.reviveTick(t.reviveProgress / m.cfg.REVIVE_TIME);
    }
  }

  /** 毎フレーム */
  update(dt: number, alpha: number, listener: THREE.Vector3, paused: boolean): void {
    const m = this.match;
    const { width, height } = this.host.size();
    this.views.update(dt, alpha, m.sim, this.host.camera, width, height);
    // 案内線：準備中は次のウェーブのルート、ウェーブの始めは強く、あとは薄く
    const routes = m.waveRoutes();
    const g = m.phase === 'prep' ? 1 : m.phase === 'wave' ? (m.phaseTime < 12 ? 1 : 0.22) : 0;
    this.td.setGuides(routes, g);
    if (this.placing && this.place.pos) this.td.setGhost(this.placing, this.place.pos, this.place.ok, this.place.yaw, this.place.nodes);
    else this.td.setGhost(null, null, false, 0);
    this.td.update(dt, alpha, this.host.camera, width, height);
    this.updatePrompt();
    this.drawMinimap(g);
    this.hud.update(dt, m, this.host.tabHeld() && !paused, { open: this.menuOpen, placing: this.placing, reason: this.place.reason, ok: this.place.ok }, this.prompt);
    this.noteTimer -= dt;
    if (this.noteTimer <= 0) this.hud.hideOrderNote();
    if (!paused) this.updateFootsteps(dt, listener);
    if (m.finished && !this.resultShown) {
      this.resultShown = true;
      this.finishMatch();
    }
  }

  /** ミニマップ：味方・ダウンした味方・撃った敵・コア・タレット・大型兵器・侵入ルート */
  private drawMinimap(routeAlpha: number) {
    const m = this.match;
    const sim = m.sim;
    const p = m.player!;
    if (!this.minimap.due(sim.time)) return;
    const marks: MinimapMarker[] = [];
    for (const e of sim.entities.values()) {
      if (e.id === p.id || e.dead) continue;
      const pos = e.movement.pos;
      if (e.team === p.team) {
        if (e.kind === 'pilot') marks.push(e.downed > 0 ? { x: pos.x, z: pos.z, kind: 'allyDowned', pin: true } : { x: pos.x, z: pos.z, kind: 'ally', yaw: e.lastCmd.yaw });
        else if (e.kind === 'core') marks.push({ x: pos.x, z: pos.z, kind: 'core', pin: true });
        else if (e.kind === 'turret') marks.push({ x: pos.x, z: pos.z, kind: e.ownerId === p.id ? 'turretMine' : 'turret' });
      } else if (e.kind === 'boss') marks.push({ x: pos.x, z: pos.z, kind: 'boss' });
      else if (e.kind === 'mortar' && m.enemies.get(e.id)?.mortar) {
        // 据えた迫撃砲兵：いつも出す（範囲の外でも縁に）。撃つたびに輪が広がる
        const t = Math.min(1, (sim.time - (this.mortarFired.get(e.id) ?? -99)) / 1.2);
        marks.push({ x: pos.x, z: pos.z, kind: 'mortar', pin: true, t });
      }
      else if (e.revealed > 0 && e.revealDelay <= 0) marks.push({ x: pos.x, z: pos.z, kind: 'enemy' });
    }
    for (const d of m.devices.values()) marks.push({ x: d.pos.x, z: d.pos.z, kind: d.ownerId === p.id ? 'deviceMine' : 'device' });
    // 降下予定地点（準備時間中）と、降りてくる降下ポッド（要塞の中・防壁の上に降りるものは、範囲の外でも縁に出す）
    if (m.phase === 'prep') for (const pl of m.plannedDrops()) marks.push({ x: pl.zone.center.x, z: pl.zone.center.z, kind: 'dropZone', r: pl.zone.radius + 1, color: DROP_COLOR[pl.zone.kind], pin: pl.zone.kind !== 'outer', alpha: 0.9 });
    for (const pod of m.pods.values()) {
      if (pod.landed) continue;
      const t = Math.max(0, Math.min(1, (sim.time - pod.warnAt) / Math.max(0.1, pod.landAt - pod.warnAt)));
      marks.push({ x: pod.pos.x, z: pod.pos.z, kind: 'pod', t, color: DROP_COLOR[pod.zone.kind], pin: pod.zone.kind !== 'outer' });
    }
    marks.push(...this.minimap.shotMarkers(sim.time, (id) => !!sim.entities.get(id) && !sim.entities.get(id)!.dead));
    const routes: MinimapRoute[] = m.waveRoutes().map((id) => {
      const r = m.route(id);
      return { points: [r.spawn.center, ...r.path], alpha: Math.max(routeAlpha, m.phase === 'wave' ? 0.3 : 0) };
    });
    this.minimap.draw(p.movement.pos, p.lastCmd.yaw, marks, m.phase === 'victory' || m.phase === 'defeat' ? [] : routes, sim.time);
  }

  /** 下の案内（その場でできること） */
  private updatePrompt() {
    const m = this.match;
    const p = m.player!;
    const sim = m.sim;
    let text = '';
    let progress = -1;
    let label = '';
    const alive = !p.dead && p.downed <= 0;
    if (alive && this.reviveTarget >= 0) {
      const t = sim.entities.get(this.reviveTarget);
      if (t) {
        text = `<kbd>E</kbd> 長押し　<b>${t.name}</b> を蘇生`;
        if (t.reviverId === p.id && t.reviveProgress > 0) {
          progress = t.reviveProgress / m.cfg.REVIVE_TIME;
          label = `${t.name} を蘇生中`;
        }
      }
    } else if (alive && this.sellTarget >= 0) {
      const t = m.turrets.get(this.sellTarget);
      const d = m.devices.get(this.sellTarget);
      const kind: TdPlaceable | null = t ? t.type : d ? d.type : null;
      if (kind) {
        const refund = m.refundOf(this.sellTarget);
        const lv = t && t.level > 1 ? `<small class="lv">Lv${t.level}</small>` : '';
        text = `<kbd>E</kbd> 長押し　${nameOf(kind)}${lv} を売る（+${refund}）${t ? '　<kbd>B</kbd> メニューで強化' : ''}`;
        if (this.sellHold > 0) {
          progress = this.sellHold / m.cfg.SELL_HOLD;
          label = '売却中';
        }
      }
    } else if (alive && m.phase === 'prep' && !this.menuOpen && !this.placing) {
      const me = m.participantOf(p.id)!;
      text = `<kbd>B</kbd> 購入メニュー　${me.ready ? '<span class="ok">準備完了</span>' : '<kbd>F</kbd> 準備完了'}`;
    }
    this.prompt = { text, progress, progressLabel: label };
  }

  /** ほかの参加者の足音 */
  private updateFootsteps(dt: number, listener: THREE.Vector3) {
    const sim = this.match.sim;
    for (const e of sim.entities.values()) {
      if (e.id === this.pid || e.dead || e.kinematic) continue;
      const mv = e.movement;
      const d = Math.hypot(mv.pos.x - listener.x, mv.pos.y - listener.y, mv.pos.z - listener.z);
      if (d > 28 || (mv.state !== 'ground' && mv.state !== 'wallrun')) continue;
      const sp = lenH(mv.vel);
      if (sp < 1) continue;
      const acc = (this.stepDist.get(e.id) ?? 0) + sp * dt;
      const stride = mv.state === 'wallrun' ? 2 : sp > 6 ? 2.2 : 1.6;
      if (acc >= stride) {
        this.stepDist.set(e.id, acc - stride);
        this.host.sfx.footstepAt(mv.pos, d, sim.footstepVolumeOf(e) * (e.kind === 'pilot' ? 1 : e.kind === 'heavy' ? 1.1 : 0.8), sp > 6 || e.kind === 'heavy', mv.state === 'wallrun');
      } else this.stepDist.set(e.id, acc);
    }
  }

  private finishMatch() {
    const m = this.match;
    const r = m.result!;
    const prev = loadTdBest();
    const d = r.difficulty;
    const best: BestTd = {
      waves: { ...prev.waves, [d]: Math.max(prev.waves[d] ?? 0, r.wavesCleared) },
      fastest: { ...prev.fastest },
      wins: prev.wins + (r.victory ? 1 : 0),
      matches: prev.matches + 1,
    };
    if (r.victory && (prev.fastest[d] === undefined || r.duration < prev.fastest[d]!)) best.fastest[d] = r.duration;
    saveTdBest(best);
    this.host.onResult();
    this.hud.showResult(m, r, best, prev);
  }

  get resultVisible(): boolean {
    return this.hud.resultVisible;
  }

  /** ダウン・倒されている（視点を下げる量） */
  get viewDrop(): number {
    const p = this.match.player!;
    return p.dead ? 1.05 : p.downed > 0 ? 0.95 : 0;
  }

  setOverlayVisible(on: boolean): void {
    this.views.setTagsVisible(on);
    this.td.setTagsVisible(on);
    this.hud.root.classList.toggle('menu-hidden', !on);
  }

  dispose(): void {
    this.match.dispose();
    this.views.dispose();
    this.td.dispose();
    this.minimap.dispose();
    this.hud.dispose();
  }
}

export { DIFF_NAMES };
