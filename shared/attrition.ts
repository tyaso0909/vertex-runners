/**
 * 消耗戦（仕様 5.1）の試合の進み。描画から切り離して、固定 60Hz のシミュレーションと一緒に進む。
 *
 * - 6 対 6（プレイヤー＋味方ボット5体 vs 敵ボット6体）。先に目標スコア（300）に届くか、10分たって多い方の勝ち
 * - 倒されると5秒後、敵から離れた出現地点に復活。復活直後の2秒は無敵
 * - 両チームの歩兵（各チーム最大12体）が、マップの中央付近に湧き続ける
 * - 得点：敵パイロット 5、敵の歩兵 1、アシスト（倒された敵に直前5秒以内にダメージを与えていた）1
 * - ボットはプレイヤーと同じ入力コマンドで動く（shared/bots）
 * - ブースト（shared/boosts.ts）：得点でゲージがたまり、満タンで X。プレイヤーはロードアウトで選んだもの、ボットはランダム
 */
import { type WeaponCustom, randomCustom } from './weaponCustom';
import {
  type AttritionConfig,
  type BoostId,
  type BotDifficulty,
  type BotsConfig,
  CHARACTER_IDS,
  type CharacterId,
  type CharactersConfig,
  GRENADE_IDS,
  type GrenadeId,
  type MovementConfig,
  type WeaponId,
  type WeaponsConfig,
  attritionConfig,
  botsConfig,
} from '../config';
import { type InputCommand, emptyCommand } from './input';
import { type Vec3, len, sub, v3 } from './math';
import type { NavGraph } from './nav';
import { type Entity, type EntityKind, type SimEvent, Simulation, TICK_DT } from './simulation';
import { BotWorld, Rng } from './bots/botWorld';
import type { BotBrain } from './bots/botBrain';
import { PilotBot } from './bots/pilotBot';
import { GruntBot } from './bots/gruntBot';
import { type BoostEvent, BoostSystem } from './boosts';

export type MatchPhase = 'intro' | 'playing' | 'ended';

export interface PilotStats {
  id: number;
  name: string;
  team: number;
  character: CharacterId;
  isPlayer: boolean;
  /** 倒した敵パイロット */
  kills: number;
  /** 倒した敵の歩兵 */
  gruntKills: number;
  assists: number;
  deaths: number;
  /** チームに入れた得点 */
  score: number;
}

export interface KillFeedEntry {
  killer: { id: number; name: string; team: number; kind: EntityKind; character?: CharacterId } | null;
  victim: { id: number; name: string; team: number; kind: EntityKind; character?: CharacterId };
  weapon?: WeaponId;
  source: string;
  /** グレネードで倒したときの種類 */
  grenade?: GrenadeId;
  head: boolean;
  assists: number[];
}

export type MatchEvent =
  | { type: 'phase'; phase: MatchPhase }
  | { type: 'killfeed'; entry: KillFeedEntry }
  /** プレイヤーが得点した（画面の中央に出す） */
  | { type: 'playerScore'; points: number; reason: 'pilot' | 'grunt' | 'assist'; victimName: string }
  | { type: 'gruntSquad'; team: number; ids: number[] }
  | { type: 'scoreMilestone'; team: number; score: number }
  | { type: 'boost'; ev: BoostEvent };

export interface MatchResult {
  /** 勝ったチーム（引き分けは -1） */
  winner: number;
  scores: [number, number];
  reason: 'score' | 'time';
  /** 試合の長さ（秒） */
  duration: number;
  stats: PilotStats[];
}

export interface AttritionOptions {
  difficulty: BotDifficulty;
  seed?: number;
  playerName?: string;
  playerCharacter?: CharacterId;
  playerLoadout?: [WeaponId, WeaponId];
  /** プレイヤーの武器のカスタマイズ（メイン・サブ） */
  playerCustom?: [WeaponCustom?, WeaponCustom?];
  /** プレイヤーのブースト（ロードアウトで選んだもの） */
  playerBoost?: BoostId;
  /** プレイヤーのグレネードの種類 */
  playerGrenade?: GrenadeId;
  /** false なら、プレイヤーの枠もボットにする（自動テスト・タイトル画面の背景用） */
  humanPlayer?: boolean;
}

/** ボットの名前（コールサイン） */
const BOT_NAMES = ['カゲロウ', 'ハヤテ', 'シグレ', 'ツバメ', 'ライカ', 'ミズチ', 'コガラシ', 'スバル', 'アカツキ', 'イナズマ', 'ホムラ', 'ヤタ', 'ムラサメ', 'ゲッコウ'];

/** ボットの装備（メイン・サブ） */
const BOT_LOADOUTS: Array<[WeaponId, WeaponId]> = [
  ['ar', 'shotgun'],
  ['ar', 'smg'],
  ['lmg', 'smg'],
  ['smg', 'shotgun'],
  ['ar', 'sniper'],
  ['sniper', 'smg'],
  ['lmg', 'shotgun'],
  ['smg', 'ar'],
  ['sniper', 'pistol'],
  ['shotgun', 'pistol'],
  ['lmg', 'pistol'],
  ['burst', 'autosg'],
  ['psmg', 'revolver'],
  ['spinlmg', 'psmg'],
  ['marksman', 'smg'],
  ['autosg', 'revolver'],
  ['burst', 'marksman'],
  ['marksman', 'autosg'],
];

interface Squad {
  team: number;
  ids: number[];
  objective: Vec3;
  timer: number;
}

export class AttritionMatch {
  readonly bw: BotWorld;
  phase: MatchPhase = 'intro';
  /** いまの段階になってからの時間 */
  phaseTime = 0;
  /** 残り時間（秒） */
  timeLeft: number;
  /** 試合が始まってからの時間 */
  elapsed = 0;
  readonly scores: [number, number] = [0, 0];
  readonly stats = new Map<number, PilotStats>();
  readonly brains = new Map<number, BotBrain>();
  readonly player: Entity | null = null;
  readonly boosts: BoostSystem;
  /** ボットのブーストを選ぶ乱数 */
  private readonly boostRng: Rng;
  events: MatchEvent[] = [];
  result: MatchResult | null = null;
  private readonly rng: Rng;
  /** ボットのサイト・アタッチメントを選ぶ乱数 */
  private readonly customRng: Rng;
  private readonly grenadeRng: Rng;
  private readonly squads: Squad[] = [];
  private gruntTimer: [number, number];
  private readonly spawnUsed = new Map<number, number>();
  private gruntSeq = 0;
  private nextMilestone: [number, number] = [100, 100];

  constructor(
    readonly sim: Simulation,
    readonly nav: NavGraph,
    readonly opts: AttritionOptions,
    readonly cfg: AttritionConfig = attritionConfig,
    readonly bots: BotsConfig = botsConfig,
  ) {
    const seed = opts.seed ?? 1234;
    this.rng = new Rng(seed);
    this.customRng = new Rng(seed ^ 0x5eed1c);
    this.grenadeRng = new Rng(seed ^ 0x6e7ade);
    this.timeLeft = cfg.TIME_LIMIT;
    this.gruntTimer = [cfg.GRUNT_FIRST_DELAY, cfg.GRUNT_FIRST_DELAY + 1];
    const center = this.mapCenter();
    this.bw = new BotWorld(sim, nav, seed ^ 0x9e37, center);
    this.boosts = new BoostSystem(sim, this.bw, seed ^ 0xb0057);
    this.boostRng = new Rng(seed ^ 0xb0b0);

    sim.soloTeam = false;
    sim.rules = {
      respawnTime: (e) => (e.kind === 'grunt' || e.kind === 'holo' ? null : cfg.RESPAWN_TIME),
      pickSpawn: (e) => this.pickSpawn(e),
      spawnInvuln: cfg.SPAWN_INVULN,
      assistWindow: cfg.ASSIST_WINDOW,
    };

    // --- パイロットを出す（チームの陣地から） ---
    const human = opts.humanPlayer !== false;
    for (const team of [0, 1]) {
      const starts = this.startSpawns(team, cfg.TEAM_SIZE);
      for (let i = 0; i < cfg.TEAM_SIZE; i++) {
        const sp = starts[i];
        if (team === 0 && i === 0 && human) {
          const p = sim.spawnPlayer(opts.playerName ?? 'あなた', opts.playerLoadout ?? ['ar', 'shotgun'], opts.playerCharacter ?? 'meia', { team: 0, pos: sp.pos, yaw: sp.yaw, custom: opts.playerCustom, grenade: opts.playerGrenade });
          (this as { player: Entity | null }).player = p;
          this.addStats(p, true);
          this.boosts.register(p.id, opts.playerBoost ?? 'maphack');
          continue;
        }
        const name = BOT_NAMES[(team * cfg.TEAM_SIZE + i + seed) % BOT_NAMES.length];
        this.spawnPilotBot(team, name, sp);
      }
    }
  }

  /** 円形広場（マップの中央） */
  private mapCenter(): Vec3 {
    const b = this.sim.level.bounds;
    if (!b) return v3();
    // ネオン都市は円形広場が少し西寄り
    return this.sim.level.name === 'ネオン都市' ? v3(-4, 0, -12) : v3((b.min.x + b.max.x) / 2, 0, (b.min.z + b.max.z) / 2);
  }

  private startSpawns(team: number, n: number): Array<{ pos: Vec3; yaw: number }> {
    const all = this.sim.level.spawns ?? [];
    const base = all.filter((s) => s.team === team && !s.field);
    const extra = all.filter((s) => s.team === team && s.field).sort((a, b) => Math.abs(a.pos.x) > Math.abs(b.pos.x) ? -1 : 1);
    const list = [...base, ...extra];
    const out: Array<{ pos: Vec3; yaw: number }> = [];
    for (let i = 0; i < n; i++) {
      const s = list[i % Math.max(1, list.length)] ?? { pos: this.sim.level.spawn, yaw: this.sim.level.spawnYaw };
      out.push({ pos: { ...s.pos }, yaw: s.yaw });
    }
    return out;
  }

  private addStats(e: Entity, isPlayer: boolean) {
    this.stats.set(e.id, { id: e.id, name: e.name, team: e.team, character: e.character, isPlayer, kills: 0, gruntKills: 0, assists: 0, deaths: 0, score: 0 });
  }

  private spawnPilotBot(team: number, name: string, sp: { pos: Vec3; yaw: number }): Entity {
    // キャラクターは6種からランダム（同じチームの重複は可。何体重なってもよい）
    const character = this.rng.pick(CHARACTER_IDS);
    const loadout = this.rng.pick(BOT_LOADOUTS);
    // サイトとアタッチメントもランダム（ほかの判断の乱数の並びを変えないよう、別の乱数で選ぶ）
    const next = () => this.customRng.next();
    const custom: [WeaponCustom, WeaponCustom] = [randomCustom(this.sim.wcfg[loadout[0]], next), randomCustom(this.sim.wcfg[loadout[1]], next)];
    // グレネードの種類もランダム
    const grenade = this.grenadeRng.pick(GRENADE_IDS);
    const e = this.sim.spawnPlayer(name, loadout, character, { team, pos: sp.pos, yaw: sp.yaw, custom, grenade });
    const skill = this.bots[this.opts.difficulty];
    const brain = new PilotBot(e.id, this.bw, this.sim.cfg, this.sim.wcfg, skill, (this.sim.ccfg as CharactersConfig)[character], (this.opts.seed ?? 1) * 7919 + e.id * 104729);
    brain.setAim(sp.yaw, 0);
    this.brains.set(e.id, brain);
    this.addStats(e, false);
    const boost = this.boosts.randomBoost(() => this.boostRng.next());
    this.boosts.register(e.id, boost);
    brain.boostKind = boost;
    return e;
  }

  // ---------------------------------------------------------------------------
  // 出現地点
  // ---------------------------------------------------------------------------

  /** 敵から離れた出現地点を選ぶ（見られている所・最近使った所は避ける。味方の近く・自分の側を少し好む） */
  pickSpawn(e: Entity): { pos: Vec3; yaw: number } | null {
    const spawns = this.sim.level.spawns ?? [];
    if (!spawns.length) return null;
    const enemies = [...this.sim.entities.values()].filter((o) => o.team !== e.team && !o.dead);
    const allies = [...this.sim.entities.values()].filter((o) => o.team === e.team && !o.dead && o.id !== e.id && o.kind === 'pilot');
    let best = -1,
      bs = -Infinity;
    spawns.forEach((sp, i) => {
      let minD = 80;
      let seen = false;
      for (const o of enemies) {
        const d = len(sub(o.movement.pos, sp.pos)) * (o.kind === 'grunt' ? 1.6 : 1);
        if (d < minD) minD = d;
        if (!seen && o.kind === 'pilot' && d < 55) {
          const eye = this.sim.eyeOf(o);
          const to = sub(v3(sp.pos.x, sp.pos.y + 1.4, sp.pos.z), eye);
          const L = len(to);
          if (!this.sim.world.raycast(eye, v3(to.x / L, to.y / L, to.z / L), L - 0.3)) seen = true;
        }
      }
      let s = Math.min(minD, 60);
      if (minD < this.cfg.SPAWN_ENEMY_AVOID) s -= 30;
      if (seen) s -= 35;
      if (sp.team === e.team) s += 10;
      if (allies.some((a) => len(sub(a.movement.pos, sp.pos)) < 25)) s += 5;
      const used = this.spawnUsed.get(i);
      if (used !== undefined && this.sim.time - used < 4) s -= 25;
      s += this.rng.range(0, 6);
      if (s > bs) {
        bs = s;
        best = i;
      }
    });
    this.spawnUsed.set(best, this.sim.time);
    const sp = spawns[best];
    return { pos: { ...sp.pos }, yaw: sp.yaw };
  }

  // ---------------------------------------------------------------------------
  // 歩兵
  // ---------------------------------------------------------------------------

  gruntCount(team: number): number {
    let n = 0;
    for (const e of this.sim.entities.values()) if (e.kind === 'grunt' && e.team === team && !e.dead) n++;
    return n;
  }

  private spawnGruntSquad(team: number) {
    const cfg = this.cfg;
    const room = cfg.GRUNT_MAX - this.gruntCount(team);
    const n = Math.min(cfg.GRUNT_SQUAD, room);
    if (n <= 0) return;
    const center = this.bw.center;
    // 中央付近の、自分の側の地上の点（敵が近くにいない所）
    const enemies = [...this.sim.entities.values()].filter((o) => o.team !== team && !o.dead);
    const side = team === 0 ? -1 : 1;
    const cands = this.bw.groundPois.filter((id) => {
      const p = this.bw.nav.nodes[id].pos;
      const dx = (p.x - center.x) * side;
      return dx > 12 && dx < 40;
    });
    if (!cands.length) return;
    let best = cands[0],
      bs = -Infinity;
    for (const id of cands) {
      const p = this.bw.nav.nodes[id].pos;
      const minD = Math.min(60, ...enemies.map((o) => len(sub(o.movement.pos, p))));
      const s = minD + this.rng.range(0, 15) - Math.abs(p.z - center.z) * 0.2;
      if (s > bs) {
        bs = s;
        best = id;
      }
    }
    const base = this.bw.nav.nodes[best].pos;
    const ids: number[] = [];
    const gs = this.bots.GRUNT;
    for (let i = 0; i < n; i++) {
      // 分隊の並び（重ならないように少しずつずらす。ぶつかる所は避ける）
      let pos = v3(base.x, base.y + 0.05, base.z);
      for (let k = 0; k < 8; k++) {
        const a = ((i + k * 0.37) / n) * Math.PI * 2;
        const q = v3(base.x + Math.cos(a) * 1.6, base.y + 0.05, base.z + Math.sin(a) * 1.6);
        const free = !this.sim.world.blocked(v3(q.x, q.y + 0.8, q.z), v3(q.x, q.y + 1.4, q.z), this.sim.cfg.PLAYER_RADIUS);
        const g = this.sim.world.raycast(v3(q.x, q.y + 0.5, q.z), v3(0, -1, 0), 1.2);
        if (free && g) {
          pos = q;
          break;
        }
      }
      const yaw = Math.atan2(-(center.x - pos.x), -(center.z - pos.z));
      const e = this.sim.spawnPlayer('歩兵', ['ar', 'smg'], 'pearl', { team, kind: 'grunt', pos, yaw, maxHealth: gs.HEALTH, damageMul: gs.DAMAGE_MUL });
      const brain = new GruntBot(e.id, this.bw, this.sim.cfg, this.sim.wcfg, gs, (this.opts.seed ?? 1) * 31 + e.id * 7717, i);
      brain.setAim(yaw, 0);
      this.brains.set(e.id, brain);
      ids.push(e.id);
    }
    const sq: Squad = { team, ids, objective: this.gruntObjective(team), timer: this.rng.range(18, 30) };
    this.squads.push(sq);
    for (const id of ids) (this.brains.get(id) as GruntBot).objective = sq.objective;
    this.gruntSeq++;
    this.events.push({ type: 'gruntSquad', team, ids });
  }

  /** 歩兵の分隊の目標地点（中央付近の地上。少し敵の側へ） */
  private gruntObjective(team: number): Vec3 {
    const center = this.bw.center;
    const side = team === 0 ? 1 : -1;
    let best: Vec3 | null = null,
      bs = Infinity;
    for (let i = 0; i < 6; i++) {
      const p = this.bw.nav.nodes[this.rng.pick(this.bw.groundPois)].pos;
      const s = Math.hypot(p.x - center.x - side * 8, p.z - center.z) + this.rng.range(0, 18);
      if (s < bs) {
        bs = s;
        best = p;
      }
    }
    return best ? { ...best } : { ...center };
  }

  private stepSquads(dt: number) {
    for (let i = this.squads.length - 1; i >= 0; i--) {
      const sq = this.squads[i];
      sq.ids = sq.ids.filter((id) => this.sim.entities.has(id) && !this.sim.entities.get(id)!.dead);
      if (!sq.ids.length) {
        this.squads.splice(i, 1);
        continue;
      }
      sq.timer -= dt;
      const idle = sq.ids.every((id) => (this.brains.get(id) as GruntBot | undefined)?.idleAtObjective);
      if (sq.timer <= 0 || idle) {
        sq.objective = this.gruntObjective(sq.team);
        sq.timer = this.rng.range(18, 30);
        for (const id of sq.ids) {
          const b = this.brains.get(id) as GruntBot | undefined;
          if (b) b.objective = sq.objective;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 進める
  // ---------------------------------------------------------------------------

  /** 1ティック進める。playerCmd はプレイヤーの入力（プレイヤーがいなければ null） */
  step(playerCmd: InputCommand | null): void {
    const dt = TICK_DT;
    this.events = [];
    this.phaseTime += dt;
    const frozen = this.phase !== 'playing';

    const cmds = new Map<number, InputCommand>();
    for (const [id, brain] of this.brains) {
      const e = this.sim.entities.get(id);
      if (!e) continue;
      if (brain instanceof PilotBot) brain.boostReady = this.boosts.ready(id);
      cmds.set(id, frozen ? brain.idle() : brain.think(e, dt));
    }
    if (this.player && playerCmd) cmds.set(this.player.id, frozen ? this.lookOnly(playerCmd) : playerCmd);
    this.boosts.preStep(cmds, !frozen);
    this.bw.processPaths();
    this.sim.step(cmds);

    // シミュレーションの出来事（ブーストのティックの爆発などで、あとから増える分も順に見る）
    let evIdx = 0;
    const flush = () => {
      while (evIdx < this.sim.events.length) {
        const ev = this.sim.events[evIdx++];
        this.boosts.onSimEvent(ev);
        this.onSimEvent(ev);
      }
    };
    flush();
    this.boosts.postStep();
    flush();
    for (const be of this.boosts.events) this.events.push({ type: 'boost', ev: be });

    if (this.phase === 'intro' && this.phaseTime >= this.cfg.INTRO_TIME) this.setPhase('playing');
    if (this.phase === 'playing') {
      this.elapsed += dt;
      this.timeLeft = Math.max(0, this.timeLeft - dt);
      // 歩兵の分隊が湧く
      for (const team of [0, 1]) {
        this.gruntTimer[team] -= dt;
        if (this.gruntTimer[team] <= 0) {
          this.gruntTimer[team] = this.cfg.GRUNT_SPAWN_INTERVAL;
          if (this.gruntCount(team) <= this.cfg.GRUNT_MAX - Math.min(2, this.cfg.GRUNT_SQUAD)) this.spawnGruntSquad(team);
        }
      }
      this.stepSquads(dt);
      const limit = this.cfg.SCORE_LIMIT;
      if (this.scores[0] >= limit || this.scores[1] >= limit) this.finish('score');
      else if (this.timeLeft <= 0) this.finish('time');
    }
  }

  /** 試合が終わって、リザルトを出してよい */
  get finished(): boolean {
    return this.phase === 'ended' && this.phaseTime >= this.cfg.END_DELAY;
  }

  private lookOnly(c: InputCommand): InputCommand {
    return { ...emptyCommand(c.tick), yaw: c.yaw, pitch: c.pitch };
  }

  private setPhase(p: MatchPhase) {
    this.phase = p;
    this.phaseTime = 0;
    this.events.push({ type: 'phase', phase: p });
  }

  private finish(reason: 'score' | 'time') {
    const [a, b] = this.scores;
    const winner = a === b ? -1 : a > b ? 0 : 1;
    this.result = {
      winner,
      scores: [a, b],
      reason,
      duration: this.elapsed,
      stats: this.sortedStats(),
    };
    this.setPhase('ended');
  }

  /** スコアボードの並び（チームごと、得点の多い順） */
  sortedStats(): PilotStats[] {
    return [...this.stats.values()].sort((p, q) => p.team - q.team || q.score - p.score || q.kills - p.kills);
  }

  private onSimEvent(ev: SimEvent) {
    // 出来事を、関係するボットへ伝える
    if (ev.type === 'playerDamaged' || ev.type === 'playerRespawn') {
      const b = this.brains.get(ev.entityId);
      const e = this.sim.entities.get(ev.entityId);
      if (b && e) b.onEvent(e, ev);
    }
    if (ev.type === 'entityRemoved') {
      this.brains.get(ev.entityId)?.dispose();
      this.brains.delete(ev.entityId);
    }
    if (ev.type !== 'kill') return;
    // ホロパイロットは倒しても得点にならない（撃たれると消えるだけ）
    if (ev.victimKind === 'holo') return;
    if (ev.victimKind === 'pilot') this.boosts.onDeath(ev.victimId);
    if (this.phase === 'ended') return;
    const victim = this.sim.infoOf(ev.victimId);
    if (!victim) return;
    const vs = this.stats.get(ev.victimId);
    if (vs) vs.deaths++;
    const pts = ev.victimKind === 'pilot' ? this.cfg.PILOT_KILL_SCORE : this.cfg.GRUNT_KILL_SCORE;
    const kInfo = ev.killerId >= 0 ? this.sim.infoOf(ev.killerId) : undefined;
    if (ev.killerTeam >= 0 && ev.killerTeam !== ev.victimTeam) {
      this.addScore(ev.killerTeam, pts);
      const ks = this.stats.get(ev.killerId);
      if (ks) {
        if (ev.victimKind === 'pilot') ks.kills++;
        else ks.gruntKills++;
        ks.score += pts;
      }
      this.boosts.addPoints(ev.killerId, pts, ev.victimKind === 'pilot');
      if (this.player && ev.killerId === this.player.id)
        this.events.push({ type: 'playerScore', points: pts, reason: ev.victimKind === 'pilot' ? 'pilot' : 'grunt', victimName: victim.name });
    }
    // アシストは、敵パイロットを倒したときだけ数える（歩兵は弱く、すぐ倒れるため）
    for (const id of ev.victimKind === 'pilot' ? ev.assists : []) {
      const info = this.sim.infoOf(id);
      if (!info || info.team === ev.victimTeam) continue;
      this.addScore(info.team, this.cfg.ASSIST_SCORE);
      const as = this.stats.get(id);
      if (as) {
        as.assists++;
        as.score += this.cfg.ASSIST_SCORE;
      }
      this.boosts.addPoints(id, this.cfg.ASSIST_SCORE, false);
      if (this.player && id === this.player.id) this.events.push({ type: 'playerScore', points: this.cfg.ASSIST_SCORE, reason: 'assist', victimName: victim.name });
    }
    this.events.push({
      type: 'killfeed',
      entry: {
        killer: kInfo ? { id: ev.killerId, name: kInfo.name, team: kInfo.team, kind: kInfo.kind, character: kInfo.kind === 'pilot' ? kInfo.character : undefined } : null,
        victim: { id: ev.victimId, name: victim.name, team: victim.team, kind: victim.kind, character: victim.kind === 'pilot' ? victim.character : undefined },
        weapon: ev.weapon,
        source: ev.source,
        grenade: ev.grenade,
        head: ev.head,
        assists: ev.assists,
      },
    });
  }

  private addScore(team: number, pts: number) {
    const t = team as 0 | 1;
    this.scores[t] = Math.min(this.cfg.SCORE_LIMIT, this.scores[t] + pts);
    while (this.scores[t] >= this.nextMilestone[t] && this.nextMilestone[t] < this.cfg.SCORE_LIMIT) {
      this.events.push({ type: 'scoreMilestone', team: t, score: this.nextMilestone[t] });
      this.nextMilestone[t] += 100;
    }
  }

  /** ボットの頭（確認用：状態の表示） */
  brainOf(id: number): BotBrain | undefined {
    return this.brains.get(id);
  }

  dispose(): void {
    for (const b of this.brains.values()) b.dispose();
    this.brains.clear();
    this.boosts.dispose();
  }
}

/** 消耗戦のシミュレーションを作る（ステージ・経路データ・試合） */
export function createAttritionMatch(
  level: Simulation['level'],
  nav: NavGraph,
  opts: AttritionOptions,
  cfg: MovementConfig,
  wcfg: WeaponsConfig,
  ccfg: CharactersConfig,
): AttritionMatch {
  const sim = new Simulation(level, cfg, wcfg, ccfg);
  return new AttritionMatch(sim, nav, opts);
}
