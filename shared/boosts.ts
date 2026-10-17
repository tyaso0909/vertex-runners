/**
 * ブースト（消耗戦。タイタンフォール2のブーストにならう）。
 *
 * - ロードアウトで 1 つ選んで持っていく（ボットはランダム）
 * - 得点（パイロット撃破 5・歩兵 1・アシスト 1）でゲージがたまる。倒されても減らない。
 *   倒されずに続けてパイロットを倒すと、2 人目から 1 人ごとにたまり方が増える（STREAK_BONUS）
 * - 満タンになったら X で使う。使うとゲージは 0 に戻り、またためられる
 *
 * ブースト：マップハック・ホロパイロット・フェイズリワインド・ハードカバー・ティック・ダイスロール（ほかの 5 つのどれか）。
 * どれもゲームロジック側で計算し、描画側は出来事（events）と状態（holos・ticks・mapHack）を見て演出するだけ。
 */
import { BOOST_IDS, type BoostId, type BoostsConfig, boostNum, boostsConfig } from '../config';
import { endGrapple, launch } from './movement';
import type { InputCommand } from './input';
import { type Vec3, add, clone, len, lenH, lookDir, normalize, scale, sub, v3 } from './math';
import { type Entity, type SimEvent, type Simulation, TICK_DT } from './simulation';
import { chestOf } from './hitbox';
import { type BotWorld, Rng } from './bots/botWorld';

export interface BoostState {
  boost: BoostId;
  /** たまった得点（COST で満タン） */
  points: number;
  /** 倒されずに続けて倒したパイロットの数 */
  streak: number;
  /** 使った回数 */
  used: number;
}

/** 走っているホロパイロット */
export interface HoloRun {
  entityId: number;
  ownerId: number;
  yaw: number;
  life: number;
  turnTimer: number;
  jumpCD: number;
}

/** 投げたティック（クモ型の地雷） */
export interface TickBot {
  id: number;
  ownerId: number;
  team: number;
  pos: Vec3;
  vel: Vec3;
  /** fly：飛んでいる・落ちている、crawl：地面を這っている */
  state: 'fly' | 'crawl';
  targetId: number;
  life: number;
  /** 向き（描画用） */
  yaw: number;
  /** 地面を這った距離（脚の動きの描画用） */
  stride: number;
  /** 高い壁に沿って回り込む向き（+1 / -1。0 は回り込んでいない） */
  slide?: number;
  /** 相手へ近づけていない時間（秒） */
  stuck?: number;
  /** 近づけなかったので、しばらく狙わない相手 */
  ignoreId?: number;
  ignoreT?: number;
}

export type BoostEvent =
  | { type: 'boostReady'; pid: number; boost: BoostId }
  | { type: 'boostUsed'; pid: number; team: number; boost: BoostId; rolled?: BoostId }
  | { type: 'holoGone'; entityId: number; pos: Vec3; shot: boolean }
  | { type: 'tickThrow'; tickId: number; pos: Vec3 }
  | { type: 'tickLand'; tickId: number; pos: Vec3 }
  | { type: 'tickExplode'; tickId: number; pos: Vec3; radius: number }
  | { type: 'rewindStart'; pid: number; from: Vec3; to: Vec3 }
  | { type: 'rewindEnd'; pid: number; pos: Vec3 }
  | { type: 'mapHackPulse'; team: number; ids: number[] };

interface Rewind {
  path: Vec3[];
  t: number;
  total: number;
}

const GRAVITY = 18;

export class BoostSystem {
  readonly states = new Map<number, BoostState>();
  readonly holos = new Map<number, HoloRun>();
  readonly ticks: TickBot[] = [];
  /** チームごとのマップハックの残り時間 */
  readonly mapHack: [number, number] = [0, 0];
  private readonly pulseTimer: [number, number] = [0, 0];
  private readonly history = new Map<number, Vec3[]>();
  private readonly rewinds = new Map<number, Rewind>();
  private nextTickId = 1;
  events: BoostEvent[] = [];
  private readonly rng: Rng;

  constructor(
    readonly sim: Simulation,
    readonly bw: BotWorld | null,
    seed: number,
    readonly cfg: BoostsConfig = boostsConfig,
  ) {
    this.rng = new Rng(seed);
  }

  /** パイロットにブーストを持たせる */
  register(pid: number, boost: BoostId): void {
    this.states.set(pid, { boost, points: 0, streak: 0, used: 0 });
  }

  /** 試合の途中でブーストを替える（一時停止の画面でロードアウトを変えたとき）。ゲージはそのまま */
  setBoost(pid: number, boost: BoostId): void {
    const s = this.states.get(pid);
    if (!s || s.boost === boost) return;
    s.boost = boost;
    s.points = Math.min(s.points, this.cfg.BOOSTS[boost].COST);
  }

  /** ボット用：ランダムなブースト */
  randomBoost(next: () => number): BoostId {
    return BOOST_IDS[Math.floor(next() * BOOST_IDS.length) % BOOST_IDS.length];
  }

  cost(pid: number): number {
    const s = this.states.get(pid);
    return s ? this.cfg.BOOSTS[s.boost].COST : 0;
  }

  /** ゲージの割合（0〜1） */
  fraction(pid: number): number {
    const s = this.states.get(pid);
    return s ? Math.min(1, s.points / this.cfg.BOOSTS[s.boost].COST) : 0;
  }

  ready(pid: number): boolean {
    const s = this.states.get(pid);
    return !!s && s.points >= this.cfg.BOOSTS[s.boost].COST;
  }

  /** フェイズリワインドで戻っている途中 */
  rewinding(pid: number): boolean {
    return this.rewinds.has(pid);
  }

  /** 得点した（ゲージがたまる）。pilotKill：パイロットを倒した（続けて倒した数を数える） */
  addPoints(pid: number, pts: number, pilotKill: boolean): void {
    const s = this.states.get(pid);
    if (!s || pts <= 0) return;
    if (pilotKill) s.streak++;
    const bonus = Math.min(this.cfg.STREAK_BONUS_MAX, this.cfg.STREAK_BONUS * Math.max(0, s.streak - 1));
    const cost = this.cfg.BOOSTS[s.boost].COST;
    const was = s.points >= cost;
    s.points = Math.min(cost, s.points + pts * (1 + bonus));
    if (!was && s.points >= cost) this.events.push({ type: 'boostReady', pid, boost: s.boost });
  }

  /** 倒された（続けて倒した数は 0 に。ゲージはそのまま） */
  onDeath(pid: number): void {
    const s = this.states.get(pid);
    if (s) s.streak = 0;
    this.history.delete(pid);
    this.stopRewind(pid);
  }

  // ---------------------------------------------------------------------------
  // 進める
  // ---------------------------------------------------------------------------

  /** シミュレーションを進める前：ブーストを使う・ホロパイロットを走らせる・戻っている人を動かす */
  preStep(cmds: Map<number, InputCommand>, allowUse: boolean): void {
    const sim = this.sim;
    this.events = [];
    if (allowUse) {
      for (const [pid, cmd] of cmds) {
        if (!cmd.boostPressed || !this.ready(pid)) continue;
        const e = sim.entities.get(pid);
        if (!e || e.dead || e.downed > 0 || this.rewinds.has(pid)) continue;
        this.use(e, cmd);
      }
    }
    // ホロパイロット：前へ走る。ぶつかったら跳ぶか曲がる
    for (const h of this.holos.values()) {
      const e = sim.entities.get(h.entityId);
      if (!e) continue;
      cmds.set(h.entityId, this.holoCommand(e, h));
    }
    // フェイズリワインド：通ってきた道を逆にたどる
    for (const [pid, r] of this.rewinds) {
      const e = sim.entities.get(pid);
      if (!e || e.dead) {
        this.stopRewind(pid);
        continue;
      }
      r.t += TICK_DT;
      const k = Math.min(1, r.t / r.total);
      // はじめと終わりをなめらかに
      const u = k * k * (3 - 2 * k);
      const f = u * (r.path.length - 1);
      const i = Math.min(r.path.length - 2, Math.floor(f));
      const a = r.path[i],
        b = r.path[i + 1] ?? a;
      const t = f - i;
      const m = e.movement;
      m.pos.x = a.x + (b.x - a.x) * t;
      m.pos.y = a.y + (b.y - a.y) * t;
      m.pos.z = a.z + (b.z - a.z) * t;
      m.vel = v3();
      if (k >= 1) this.stopRewind(pid);
    }
  }

  /** シミュレーションを進めた後：ティック・ホロパイロットの寿命・マップハック・位置の記録 */
  postStep(): void {
    const sim = this.sim;
    const dt = TICK_DT;
    // 位置の記録（フェイズリワインド用。戻っている間は記録しない）
    const keep = Math.round(boostNum(this.cfg.BOOSTS.phaserewind, 'REWIND', 5) / dt) + 1;
    for (const [pid, s] of this.states) {
      if (s.boost !== 'phaserewind' && s.boost !== 'diceroll') continue;
      const e = sim.entities.get(pid);
      if (!e || e.dead || this.rewinds.has(pid)) continue;
      if (e.movement.events.some((x) => x.type === 'respawn')) this.history.delete(pid);
      let hst = this.history.get(pid);
      if (!hst) this.history.set(pid, (hst = []));
      hst.push(clone(e.movement.pos));
      if (hst.length > keep) hst.splice(0, hst.length - keep);
    }
    // ホロパイロットの寿命
    for (const [id, h] of [...this.holos]) {
      const e = sim.entities.get(id);
      h.life -= dt;
      if (!e) {
        this.holos.delete(id);
        continue;
      }
      if (h.life <= 0 || e.dead || e.movement.events.some((x) => x.type === 'respawn')) this.removeHolo(id, false);
    }
    // マップハック：一定の間隔で、敵の位置をチームに知らせる
    for (const team of [0, 1]) {
      if (this.mapHack[team] <= 0) continue;
      this.mapHack[team] = Math.max(0, this.mapHack[team] - dt);
      this.pulseTimer[team] -= dt;
      if (this.pulseTimer[team] > 0) continue;
      this.pulseTimer[team] = boostNum(this.cfg.BOOSTS.maphack, 'PULSE', 1.5);
      const ids: number[] = [];
      for (const o of sim.entities.values()) {
        if (o.team === team || o.dead || (o.kind !== 'pilot' && o.kind !== 'grunt' && o.kind !== 'holo')) continue;
        ids.push(o.id);
        this.bw?.report(team, o);
      }
      this.events.push({ type: 'mapHackPulse', team, ids });
    }
    this.stepTicks(dt);
  }

  /** シミュレーションの出来事：撃たれたホロパイロットは消える */
  onSimEvent(ev: SimEvent): void {
    if (ev.type === 'playerDamaged' && this.holos.has(ev.entityId)) this.removeHolo(ev.entityId, true);
  }

  // ---------------------------------------------------------------------------
  // 使う
  // ---------------------------------------------------------------------------

  private use(e: Entity, cmd: InputCommand) {
    const s = this.states.get(e.id)!;
    let kind = s.boost;
    let rolled: BoostId | undefined;
    if (kind === 'diceroll') {
      const pool = BOOST_IDS.filter((b) => b !== 'diceroll');
      kind = rolled = pool[Math.floor(this.rng.next() * pool.length) % pool.length];
    }
    s.points = 0;
    s.used++;
    this.events.push({ type: 'boostUsed', pid: e.id, team: e.team, boost: s.boost, rolled });
    switch (kind) {
      case 'maphack':
        this.mapHack[e.team as 0 | 1] = boostNum(this.cfg.BOOSTS.maphack, 'DURATION', 15);
        this.pulseTimer[e.team as 0 | 1] = 0;
        break;
      case 'holopilot':
        this.spawnHolos(e, cmd);
        break;
      case 'phaserewind':
        this.startRewind(e);
        break;
      case 'hardcover':
        this.placeHardCover(e, cmd);
        break;
      case 'ticks':
        this.throwTicks(e, cmd);
        break;
    }
  }

  // --- ホロパイロット ---

  private spawnHolos(owner: Entity, cmd: InputCommand) {
    const def = this.cfg.BOOSTS.holopilot;
    const n = boostNum(def, 'COUNT', 5);
    const spread = (boostNum(def, 'SPREAD', 80) * Math.PI) / 180;
    const sim = this.sim;
    const a = owner.arsenal;
    const loadout: [typeof a.slots[0]['id'], typeof a.slots[0]['id']] = [a.slots[0].id, a.slots[1].id];
    for (let i = 0; i < n; i++) {
      const yaw = cmd.yaw + (n > 1 ? (i / (n - 1) - 0.5) * spread : 0);
      // 自分の体から、少しずつ横へずらして出す
      const side = (i - (n - 1) / 2) * 0.35;
      const right = v3(Math.cos(cmd.yaw), 0, -Math.sin(cmd.yaw));
      let pos = add(owner.movement.pos, scale(right, side));
      if (sim.world.blocked(v3(pos.x, pos.y + 0.6, pos.z), v3(pos.x, pos.y + 1.4, pos.z), sim.cfg.PLAYER_RADIUS * 0.9)) pos = clone(owner.movement.pos);
      const h = sim.spawnPlayer(owner.name, loadout, owner.character, {
        team: owner.team,
        kind: 'holo',
        pos,
        yaw,
        maxHealth: 1,
        regen: false,
        ownerId: owner.id,
        custom: [a.slots[0].custom, a.slots[1].custom],
      });
      h.arsenal.active = a.active;
      h.movement.vel = v3(owner.movement.vel.x, Math.max(0, owner.movement.vel.y), owner.movement.vel.z);
      h.movement.state = owner.movement.state === 'ground' ? 'ground' : 'air';
      h.lastCmd = { ...cmd, yaw, boostPressed: false };
      this.holos.set(h.id, { entityId: h.id, ownerId: owner.id, yaw, life: boostNum(def, 'DURATION', 9) * (0.9 + this.rng.next() * 0.2), turnTimer: 0.6 + this.rng.next(), jumpCD: 0 });
    }
  }

  private holoCommand(e: Entity, h: HoloRun): InputCommand {
    const sim = this.sim;
    const c: InputCommand = { ...e.lastCmd, tick: sim.tick + 1, boostPressed: false, fireHeld: false, firePressed: false, adsHeld: false, jumpPressed: false, jumpHeld: false, crouchHeld: false, crouchPressed: false, abilityPressed: false, meleePressed: false, reloadPressed: false, grenadeHeld: false, interactHeld: false, switchTo: -1, switchNext: false };
    h.jumpCD = Math.max(0, h.jumpCD - TICK_DT);
    h.turnTimer -= TICK_DT;
    // ときどき少し向きを変える（まっすぐすぎると見破られる）
    if (h.turnTimer <= 0) {
      h.turnTimer = 0.8 + this.rng.next() * 1.4;
      h.yaw += (this.rng.next() - 0.5) * 0.7;
    }
    const m = e.movement;
    const fwd = lookDir(h.yaw, 0);
    const chest = v3(m.pos.x, m.pos.y + 1.0, m.pos.z);
    const hit = sim.world.raycast(chest, fwd, 1.4);
    if (hit) {
      // 低い所は跳び越える。高い壁は曲がる
      const knee = sim.world.raycast(v3(m.pos.x, m.pos.y + 2.2, m.pos.z), fwd, 1.6);
      if (!knee && h.jumpCD <= 0 && m.state === 'ground') {
        c.jumpPressed = c.jumpHeld = true;
        h.jumpCD = 0.6;
      } else {
        h.yaw += (this.rng.next() < 0.5 ? -1 : 1) * (0.9 + this.rng.next() * 0.9);
      }
    }
    c.yaw = h.yaw;
    c.pitch = 0;
    c.moveForward = 1;
    c.moveRight = 0;
    c.sprintHeld = true;
    return c;
  }

  private removeHolo(id: number, shot: boolean) {
    const e = this.sim.entities.get(id);
    this.holos.delete(id);
    if (!e) return;
    this.events.push({ type: 'holoGone', entityId: id, pos: clone(e.movement.pos), shot });
    this.sim.despawn(id);
  }

  // --- フェイズリワインド ---

  private startRewind(e: Entity) {
    const def = this.cfg.BOOSTS.phaserewind;
    const hst = this.history.get(e.id) ?? [];
    const now = clone(e.movement.pos);
    // 今から古い方へ（最初の点が今の位置）
    const path = [now, ...[...hst].reverse()];
    if (path.length < 2) path.push(clone(now));
    const m = e.movement;
    if (m.grapple) endGrapple(m, 'cancel');
    const travel = boostNum(def, 'TRAVEL', 0.6);
    e.kinematic = true;
    e.ability.phase = Math.max(e.ability.phase, travel + 0.1);
    e.arsenal.reloading = false;
    e.arsenal.cooking = false;
    this.rewinds.set(e.id, { path, t: 0, total: travel });
    this.history.delete(e.id);
    this.events.push({ type: 'rewindStart', pid: e.id, from: now, to: clone(path[path.length - 1]) });
  }

  private stopRewind(pid: number) {
    if (!this.rewinds.has(pid)) return;
    this.rewinds.delete(pid);
    const e = this.sim.entities.get(pid);
    if (!e) return;
    e.kinematic = false;
    // 空中で止まった状態から、また動き出す（二段ジャンプ・壁走りは使える）
    launch(e.movement, v3());
    this.events.push({ type: 'rewindEnd', pid, pos: clone(e.movement.pos) });
  }

  // --- ハードカバー ---

  private placeHardCover(e: Entity, cmd: InputCommand) {
    const def = this.cfg.BOOSTS.hardcover;
    const sim = this.sim;
    const fwd = lookDir(cmd.yaw, 0);
    const dist = boostNum(def, 'DISTANCE', 2.2);
    const h = boostNum(def, 'HEIGHT', 2.8);
    // 壁にめり込まないよう、前が壁ならその手前に
    const eye = sim.eyeOf(e);
    const wall = sim.world.raycast(v3(eye.x, e.movement.pos.y + 1.0, eye.z), fwd, dist + 0.4);
    const d = wall ? Math.max(0.6, wall.t - 0.4) : dist;
    const base = add(e.movement.pos, scale(fwd, d));
    const ground = sim.world.raycast(add(base, v3(0, 1.2, 0)), v3(0, -1, 0), 3);
    const y = ground ? ground.point.y : e.movement.pos.y;
    const time = boostNum(def, 'DURATION', 20);
    sim.addShield({ ownerId: e.id, center: v3(base.x, y + h / 2, base.z), yaw: cmd.yaw, width: boostNum(def, 'WIDTH', 6), height: h, time, hits: 0, duration: time, kind: 'hardcover' });
  }

  // --- ティック ---

  private throwTicks(e: Entity, cmd: InputCommand) {
    const def = this.cfg.BOOSTS.ticks;
    const sim = this.sim;
    const n = boostNum(def, 'COUNT', 2);
    const speed = boostNum(def, 'THROW_SPEED', 13);
    const eye = sim.eyeOf(e);
    for (let i = 0; i < n; i++) {
      const yaw = cmd.yaw + (n > 1 ? (i / (n - 1) - 0.5) * 0.28 : 0);
      const dir = lookDir(yaw, Math.min(1.2, cmd.pitch + 0.22));
      const start = add(eye, scale(dir, 0.5));
      const tk: TickBot = {
        id: this.nextTickId++,
        ownerId: e.id,
        team: e.team,
        pos: start,
        vel: add(scale(dir, speed), v3(e.movement.vel.x * 0.5, 0, e.movement.vel.z * 0.5)),
        state: 'fly',
        targetId: -1,
        life: boostNum(def, 'LIFE', 12),
        yaw,
        stride: 0,
      };
      this.ticks.push(tk);
      this.events.push({ type: 'tickThrow', tickId: tk.id, pos: clone(start) });
    }
  }

  private stepTicks(dt: number) {
    const sim = this.sim;
    const def = this.cfg.BOOSTS.ticks;
    const seek = boostNum(def, 'SEEK_RANGE', 28);
    const trig = boostNum(def, 'TRIGGER', 2.2);
    const speed = boostNum(def, 'SPEED', 7.5);
    const world = sim.world;
    for (let i = this.ticks.length - 1; i >= 0; i--) {
      const t = this.ticks[i];
      t.life -= dt;
      if (t.ignoreT !== undefined && (t.ignoreT -= dt) <= 0) {
        t.ignoreT = undefined;
        t.ignoreId = undefined;
      }
      // 狙う相手（0.25 秒ごとに見直す。見えているいちばん近い敵）
      if (t.state === 'crawl' && (t.targetId < 0 || Math.floor((t.life + dt) * 4) !== Math.floor(t.life * 4))) t.targetId = this.tickTarget(t, seek);
      const target = t.targetId >= 0 ? sim.entities.get(t.targetId) : undefined;
      if (target && (target.dead || target.downed > 0)) t.targetId = -1;
      // 近くに敵がいれば爆発
      let boom = t.life <= 0;
      for (const o of sim.entities.values()) {
        if (boom) break;
        if (o.team === t.team || o.dead || !this.tickCanHit(o)) continue;
        if (len(sub(chestOf(sim.actorOf(o)), t.pos)) < (t.state === 'fly' ? 1.2 : trig)) boom = true;
      }
      if (boom) {
        this.explodeTick(t);
        this.ticks.splice(i, 1);
        continue;
      }
      if (t.state === 'fly') {
        t.vel.y -= GRAVITY * dt;
        const step = scale(t.vel, dt);
        const L = len(step);
        if (L > 1e-5) {
          const hit = world.raycast(t.pos, scale(step, 1 / L), L + 0.12);
          if (hit) {
            if (hit.normal.y > 0.6) {
              t.pos = add(hit.point, v3(0, 0.02, 0));
              t.state = 'crawl';
              t.vel = v3();
              this.events.push({ type: 'tickLand', tickId: t.id, pos: clone(t.pos) });
            } else {
              // 壁ではね返る
              const n = hit.normal;
              const d = t.vel.x * n.x + t.vel.y * n.y + t.vel.z * n.z;
              t.vel = scale(sub(t.vel, scale(n, 2 * d)), 0.4);
              t.pos = add(hit.point, scale(n, 0.1));
            }
          } else t.pos = add(t.pos, step);
        }
        if (t.pos.y < (sim.level.killY ?? -50)) {
          this.ticks.splice(i, 1);
          continue;
        }
        continue;
      }
      // 地面を這う：狙う相手へ。いなければその場で待つ
      let dir: Vec3 | null = null;
      if (target) {
        const to = sub(target.movement.pos, t.pos);
        const Lh = lenH(to);
        if (Lh > 0.05) dir = v3(to.x / Lh, 0, to.z / Lh);
      }
      if (!dir) continue;
      const stepLen = speed * dt;
      const goal = dir;
      // 前に段差・壁があるか
      const wall = world.raycast(add(t.pos, v3(0, 0.2, 0)), dir, stepLen + 0.3);
      if (wall && wall.normal.y < 0.6) {
        // 低い段差（1.1m まで）なら跳ねて越える
        const over = add(wall.point, add(scale(dir, 0.35), v3(0, 1.5, 0)));
        const top = world.raycast(over, v3(0, -1, 0), 1.5);
        const clear = !world.raycast(add(t.pos, v3(0, 1.3, 0)), dir, 0.8);
        if (top && top.normal.y > 0.6 && top.point.y - t.pos.y < 1.15 && clear) {
          t.state = 'fly';
          t.vel = v3(dir.x * 2.2, 7, dir.z * 2.2);
          t.slide = 0;
          continue;
        }
        // 高い壁：壁に沿って回り込む（向きは一度決めたら保つ）
        const n = wall.normal;
        const tan = v3(-n.z, 0, n.x);
        const tl = lenH(tan) || 1;
        if (!t.slide) t.slide = tan.x * goal.x + tan.z * goal.z >= 0 ? 1 : -1;
        dir = v3((tan.x / tl) * t.slide, 0, (tan.z / tl) * t.slide);
        // 回り込んだ先も壁なら、向きを変える
        if (world.raycast(add(t.pos, v3(0, 0.2, 0)), dir, stepLen + 0.3)) {
          t.slide = -t.slide;
          dir = scale(dir, -1);
        }
      } else if (t.slide) {
        // 壁の端まで来た：相手のほうへ戻る
        t.slide = 0;
      }
      // 近づけていなければ、その相手はしばらく狙わない
      if (wall && wall.normal.y < 0.6) t.stuck = (t.stuck ?? 0) + dt;
      else t.stuck = Math.max(0, (t.stuck ?? 0) - dt * 0.5);
      if ((t.stuck ?? 0) > 2.5 && target) {
        t.ignoreId = target.id;
        t.ignoreT = 4;
        t.targetId = -1;
        t.stuck = 0;
        t.slide = 0;
        continue;
      }
      t.yaw = Math.atan2(-dir.x, -dir.z);
      const next = add(t.pos, scale(dir, stepLen));
      const g = world.raycast(add(next, v3(0, 0.6, 0)), v3(0, -1, 0), 1.3);
      if (g && g.normal.y > 0.5) {
        t.pos = v3(next.x, g.point.y + 0.02, next.z);
        t.stride += stepLen;
      } else {
        // 足場が切れた：落ちる
        t.pos = next;
        t.state = 'fly';
        t.vel = v3(dir.x * speed, 0, dir.z * speed);
      }
    }
  }

  private tickCanHit(o: Entity): boolean {
    return o.kind === 'pilot' || o.kind === 'grunt' || o.kind === 'holo';
  }

  /** 狙う相手：見えているいちばん近い敵。いなければ、近く（12m）の敵（見えていなくても音で気づく） */
  private tickTarget(t: TickBot, range: number): number {
    const sim = this.sim;
    let best = -1,
      bd = range;
    let near = -1,
      nd = Math.min(12, range);
    const from = add(t.pos, v3(0, 0.6, 0));
    for (const o of sim.entities.values()) {
      if (o.team === t.team || o.dead || !this.tickCanHit(o) || o.id === t.ignoreId) continue;
      const c = chestOf(sim.actorOf(o));
      const d = len(sub(c, from));
      if (d < nd) {
        nd = d;
        near = o.id;
      }
      if (d >= bd) continue;
      const dir = normalize(sub(c, from));
      if (sim.world.raycast(from, dir, d - 0.3)) continue;
      bd = d;
      best = o.id;
    }
    return best >= 0 ? best : near;
  }

  private explodeTick(t: TickBot) {
    const sim = this.sim;
    const def = this.cfg.BOOSTS.ticks;
    const R = boostNum(def, 'RADIUS', 4);
    const dmg = boostNum(def, 'DAMAGE', 110);
    const minD = boostNum(def, 'MIN_DAMAGE', 30);
    const pos = add(t.pos, v3(0, 0.4, 0));
    const owner = sim.entities.has(t.ownerId) ? t.ownerId : -1;
    for (const o of [...sim.entities.values()]) {
      if (o.team === t.team || o.dead) continue;
      const c = chestOf(sim.actorOf(o));
      const d = len(sub(c, pos));
      if (d > R) continue;
      const dir = normalize(sub(c, pos));
      if (d > 0.3 && sim.world.raycast(pos, dir, d - 0.2)) continue;
      sim.damageEntity(o, minD + (dmg - minD) * (1 - d / R), pos, 'tick', owner);
    }
    this.events.push({ type: 'tickExplode', tickId: t.id, pos, radius: R });
  }

  dispose(): void {
    this.holos.clear();
    this.ticks.length = 0;
    this.rewinds.clear();
    this.history.clear();
  }
}
