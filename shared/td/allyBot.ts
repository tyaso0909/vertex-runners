/**
 * タワーディフェンスの味方ボット（仕様 5.3.2）。消耗戦のパイロットのボット（PilotBot）に、
 * タワーディフェンスの役目を足したもの。
 *
 * ボットは「人間のプレイヤーが足りないときの穴埋め」の参加者（将来のオンライン：人間2人＋ボット2体、人間3人＋ボット1体など）。
 * 指示は受けず、人間と同じ入力コマンド・同じ決まり（クレジット・タレット・蘇生・準備完了）で、自分の判断で遊撃する。
 * - ウェーブ中：敵がいちばん押し込んでいる所（コアに近い敵・数の多いルート）へ向かって戦う。
 *   ほかの味方（人間も）がすでにいるルートは少し避けて、守りが手薄な所へ行く
 * - 準備時間：自分のクレジットで、次のウェーブで敵が来るルートのうち、タレットが少ないルートの推奨設置ポイントにタレットを買って置く
 *   （歩いて行って置く）。タレットが足りたら、残りのクレジットで、ルートの道にワイヤートラップ、タレットの強化、
 *   ダミーバルーン、アーマーの順に買う。済んだら準備完了にして、次に敵が来るルートの近くで待つ
 * - ダウンした味方が近くにいれば、安全を確かめて蘇生に向かう（「調べる」を押し続ける）
 * - コアが攻撃されているときはコアの守りを優先する
 * - アビリティ：ミランダはコアの前でシールド、ソラはウェーブの始めにソナー（ほかは消耗戦と同じ使い方）
 */
import type { BotSkill, CharacterDef, MovementConfig, TdDeviceType, TdEnemyType, TdItemType, TdPlaceable, TurretType, WeaponsConfig } from '../../config';
import { abilityNum } from '../../config';
import type { TdRouteDef, TdRouteId } from '../level';
import { type Vec3, add, len, lenH, sub, v3 } from '../math';
import type { Entity } from '../simulation';
import { type BotIntent, aimAngles, emptyIntent } from '../bots/botCommon';
import type { BotWorld } from '../bots/botWorld';
import { PilotBot } from '../bots/pilotBot';

export type TdPhaseName = 'intro' | 'prep' | 'wave' | 'victory' | 'defeat';

export const TD_ROUTE_IDS: readonly TdRouteId[] = ['front', 'left', 'right'];

/** 味方ボットから見たタワーディフェンスの様子（towerDefense.ts が用意する。人間のプレイヤーが画面で見られることと同じ範囲） */
export interface TdBotApi {
  currentPhase(): TdPhaseName;
  route(id: TdRouteId): TdRouteDef;
  /** 敵の数（ルートごと。まだ出ていない敵も含む） */
  enemiesOn(route: TdRouteId): number;
  /** 生きている敵の位置・ルート・種類 */
  enemyList(): Array<{ pos: Vec3; route: TdRouteId; type: TdEnemyType }>;
  /** いまのウェーブ（準備中は次のウェーブ）で敵が来るルート */
  waveRoutes(): TdRouteId[];
  /** 据えた迫撃砲兵（ミニマップ・画面の印で人間にも見えている）。firing：いま砲撃している */
  mortars(): Array<{ id: number; pos: Vec3; route: TdRouteId; firing: boolean }>;
  /** その迫撃砲兵を倒しに行っている、自分以外のボットの数（closerThan を渡すと、それより近くにいるボットだけ） */
  huntersOf(mortarId: number, by: number, closerThan?: number): number;
  /** 迫撃砲兵を倒しに行く（dist：いまの距離。近いボットが優先） */
  claimHunt(mortarId: number, by: number, dist: number): void;
  /** 降りてくる途中の降下ポッド（降りる所・着地までの秒・衝撃の半径。地面の印で人間にも見えている） */
  incomingPods(): Array<{ pos: Vec3; eta: number; radius: number }>;
  /** コアが少し前から攻撃されている */
  coreUnderAttack(): boolean;
  corePos(): Vec3;
  /** チームの参加者（人間・ボット）の位置と、ボットなら向かっているルート */
  teammates(): Array<{ id: number; pos: Vec3; focus: TdRouteId | null; alive: boolean }>;
  /** ダウンしている味方 */
  downedAllies(team: number): Entity[];
  /** その味方を誰かが蘇生しに行っているか（自分以外） */
  reviveClaimed(targetId: number, by: number): boolean;
  claimRevive(targetId: number, by: number): void;
  credits(pid: number): number;
  turretCount(pid: number): number;
  turretLimit(): number;
  turretCost(type: TurretType): number;
  /** その場所に置けるか（クレジット・数・場所）。yaw はバリケード・ワイヤートラップ・バルーンの向き */
  canPlace(pid: number, kind: TdPlaceable, pos: Vec3, yaw?: number): boolean;
  tryPlace(pid: number, kind: TdPlaceable, pos: Vec3, yaw?: number): boolean;
  /** 置いている設置物の数 */
  deviceCount(pid: number, type: TdDeviceType): number;
  /** その近くに（誰かの）その種類の設置物があるか */
  deviceNear(type: TdDeviceType, pos: Vec3, r: number): boolean;
  itemCost(type: TdItemType): number;
  /** 自分のタレット */
  myTurrets(pid: number): Array<{ id: number; type: TurretType; pos: Vec3; level: number }>;
  upgradeCheck(pid: number, turretId: number): { ok: boolean; cost: number };
  tryUpgrade(pid: number, turretId: number): boolean;
  armorCheck(pid: number): { ok: boolean; cost: number };
  buyArmor(pid: number): boolean;
  /** タレット・設置物を置ける範囲（要塞の中） */
  buildArea(): { min: Vec3; max: Vec3 };
  /** ボットがタレットのほかの物（設置物・強化・アーマー）を買ってよいか（確認用に切れる） */
  botItems(): boolean;
  /** そこに（誰かの）タレットがあるか */
  occupied(pos: Vec3, r: number): boolean;
  /** どれかの点の近くにあるチームのタレット（種類ごとの数。同じタレットは1度だけ数える） */
  turretsNearAny(points: Vec3[], r: number): Partial<Record<TurretType, number>>;
  markReady(pid: number): void;
  /** 置きに向かっている場所（ほかのボットと同じ場所へ行かないように） */
  claimBuild(pos: Vec3, by: number): void;
  buildClaimed(pos: Vec3, by: number): boolean;
}

/** ルートごとの、置きたいタレットの組み合わせ（チーム全体で。上から順に足りないものを買う） */
const BUILD_PLAN: Record<TdRouteId, TurretType[]> = {
  front: ['mg', 'rocket', 'mg', 'slow', 'repair', 'rocket', 'mg'],
  left: ['mg', 'mg', 'slow', 'rocket', 'mg', 'repair'],
  right: ['mg', 'rocket', 'mg', 'slow', 'mg', 'repair'],
};

/** 敵の種類ごとの脅威の重み（どこへ戦いに行くかを決める） */
const THREAT: Record<TdEnemyType, number> = { grunt: 1, assault: 2.2, heavy: 2.5, mortar: 1.5, drone: 1.6, boss: 6 };

type Mode = 'fight' | 'build' | 'revive';

export class TdAllyBot extends PilotBot {
  mode: Mode = 'fight';
  /** 向かっている場所（敵が押し込んでいる所・コア・次のルートの近く） */
  guard: Vec3;
  /** いま向かっているルート（ほかの味方が守りの手薄な所を選ぶのに使う） */
  focus: TdRouteId | null = null;
  /** コアを守っている */
  defendingCore = false;
  /** 倒しに行っている迫撃砲兵（いなければ -1） */
  hunting = -1;
  private huntPos: Vec3 | null = null;
  private focusTimer = 0;
  private tdTimer = 0;
  private reviveTarget = -1;
  private buildPoint: Vec3 | null = null;
  private buildType: TdPlaceable | null = null;
  private buildYaw = 0;
  private readonly badPoints = new Set<string>();
  private lastPhase: TdPhaseName = 'intro';
  private readonly offset: Vec3;

  constructor(
    entityId: number,
    bw: BotWorld,
    cfg: MovementConfig,
    wcfg: WeaponsConfig,
    skill: BotSkill,
    cdef: CharacterDef,
    seed: number,
    private readonly api: TdBotApi,
  ) {
    super(entityId, bw, cfg, wcfg, skill, cdef, seed);
    const a = this.rng.range(0, Math.PI * 2);
    this.offset = v3(Math.cos(a) * 3, 0, Math.sin(a) * 3);
    const c = api.corePos();
    this.guard = v3(c.x + this.offset.x * 3, c.y, c.z + 14 + this.offset.z * 2);
  }

  /** ルートの守る場所：入り口から、コアへ向かって 14m 入った所 */
  defensePoint(id: TdRouteId): Vec3 {
    const r = this.api.route(id);
    const core = this.api.corePos();
    const g = r.gate;
    const d = sub(core, g);
    const L = lenH(d) || 1;
    return v3(g.x + (d.x / L) * 14, 0, g.z + (d.z / L) * 14);
  }

  get debugState(): string {
    return `${this.mode}/${this.state}/${this.defendingCore ? 'core' : (this.focus ?? '-')}`;
  }

  /** 巡回の代わりに：向かっている場所の近くを回る */
  protected override pickPatrolGoal(e: Entity): void {
    // 迫撃砲兵を倒しに行く：その場所（屋上・台の上）へまっすぐ
    if (this.huntPos) {
      const goal = this.huntGoal(e);
      if (len(sub(goal, e.movement.pos)) > 1.5) this.nav.goTo(goal, e.movement.pos);
      else this.badHuntNodes.add(this.huntNode); // 着いたのに見えない（壁の向こう）：ほかの点にする
      this.lingerTimer = 0.6;
      return;
    }
    const g = add(this.guard, v3(this.rng.range(-5, 5), 0, this.rng.range(-5, 5)));
    const n = this.bw.nearestConnected(g, 6);
    const goal = n >= 0 ? this.bw.nav.nodes[n].pos : g;
    if (len(sub(goal, e.movement.pos)) > 2.5) this.nav.goTo(goal, e.movement.pos);
    this.lingerTimer = this.rng.range(1.5, 4);
  }

  /** そのルートを、自分以外の味方（人間も）がどれくらい守っているか */
  private coverage(route: TdRouteId, selfPos: Vec3): number {
    const dp = this.defensePoint(route);
    let n = 0;
    for (const t of this.api.teammates()) {
      if (t.id === this.entityId || !t.alive) continue;
      if (t.focus === route) n += 1;
      else if (t.focus === null && lenH(sub(t.pos, dp)) < 26) n += 1; // 人間：近くにいれば守っているとみなす
    }
    void selfPos;
    return n;
  }

  /**
   * コアへ走ってくる突撃兵を止めに行く（コアに近く、まわりに味方がいない突撃兵がいて、自分がいちばん近い味方なら）
   */
  private interceptAssault(e: Entity): boolean {
    const api = this.api;
    const core = api.corePos();
    const pos = e.movement.pos;
    const mates = api.teammates().filter((t) => t.alive && t.id !== this.entityId);
    let best: { pos: Vec3; route: TdRouteId } | null = null,
      bd = Infinity;
    for (const en of api.enemyList()) {
      if (en.type !== 'assault') continue;
      if (lenH(sub(en.pos, core)) > 60) continue;
      if (mates.some((t) => lenH(sub(t.pos, en.pos)) < 18)) continue; // もう誰かが近くにいる
      const d = lenH(sub(en.pos, pos));
      if (d > 50) continue;
      // 自分よりその突撃兵に近い味方がいれば、その味方に任せる
      if (mates.some((t) => lenH(sub(t.pos, en.pos)) < d - 4)) continue;
      if (d < bd) {
        bd = d;
        best = en;
      }
    }
    if (!best) return false;
    // 突撃兵とコアの間に入る
    const to = sub(core, best.pos);
    const L = lenH(to) || 1;
    this.guard = v3(best.pos.x + (to.x / L) * Math.min(6, L * 0.4), 0, best.pos.z + (to.z / L) * Math.min(6, L * 0.4));
    this.focus = best.route;
    this.focusTimer = 1;
    return true;
  }

  /** 迫撃砲兵を追うときの行き先の点（その番号）と、行ったのに見えなかった点 */
  private huntNode = -1;
  private readonly badHuntNodes = new Set<number>();

  /**
   * 迫撃砲兵を追うときの行き先：迫撃砲兵のまわり（7m 以内）の経路の点のうち、そこから迫撃砲兵が見える所（近くて、自分からも近い所）。
   * 壁の向こう側（前哨陣地の中など）に着いて、見えないまま立ち止まらないように
   */
  private huntGoal(e: Entity): Vec3 {
    const hp = this.huntPos!;
    const target = v3(hp.x, hp.y + 1.1, hp.z);
    const nodes = this.bw.nav.nodes;
    let best = -1,
      bs = Infinity;
    for (const id of this.bw.nodesNear(hp, 7)) {
      if (this.badHuntNodes.has(id)) continue;
      const q = nodes[id].pos;
      if (Math.abs(q.y - hp.y) > 3) continue;
      if (!this.lineOfSight(v3(q.x, q.y + 1.5, q.z), target)) continue;
      const s = len(sub(q, hp)) + lenH(sub(q, e.movement.pos)) * 0.15;
      if (s < bs) {
        bs = s;
        best = id;
      }
    }
    if (best < 0) {
      this.badHuntNodes.clear();
      best = this.bw.nearestConnected(hp, 4);
    }
    this.huntNode = best;
    return best >= 0 ? nodes[best].pos : hp;
  }

  /**
   * 据えた迫撃砲兵を倒しに行く（砲撃している迫撃砲兵がいて、まだ誰も向かっていなければ。1体に 1 人、近い所なら 2 人まで）。
   * いま追っている迫撃砲兵がいれば、倒すまで追う
   */
  private huntMortar(e: Entity): boolean {
    const api = this.api;
    const pos = e.movement.pos;
    const ms = api.mortars();
    const mates = api.teammates().filter((t) => t.alive).length;
    // 迫撃砲兵を追うのは、味方のボットの半分まで（ほかはルートを守る）
    const maxHunters = Math.max(1, Math.floor(mates / 2));
    let huntingBots = 0;
    for (const m of ms) huntingBots += api.huntersOf(m.id, this.entityId);
    let best: { id: number; pos: Vec3; route: TdRouteId } | null = null,
      bs = Infinity,
      bd = 0;
    for (const m of ms) {
      const d = lenH(sub(m.pos, pos)) + Math.abs(m.pos.y - pos.y);
      const mine = m.id === this.hunting;
      if (d > 160) continue;
      if (!mine && !m.firing && d > 40) continue;
      // 1体に 1 人（近い所なら 2 人）。自分より近くにいる味方がその数だけ向かっていれば任せる
      const cap = d < 45 ? 2 : 1;
      if (api.huntersOf(m.id, this.entityId, d) >= cap) continue;
      if (!mine && huntingBots >= maxHunters) continue;
      const s = d - (mine ? 40 : 0);
      if (s < bs) {
        bs = s;
        bd = d;
        best = m;
      }
    }
    if (!best) {
      this.hunting = -1;
      this.huntPos = null;
      return false;
    }
    if (best.id !== this.hunting) {
      this.nav.stop();
      this.badHuntNodes.clear();
    }
    this.hunting = best.id;
    api.claimHunt(best.id, this.entityId, bd);
    this.huntPos = best.pos;
    this.guard = best.pos;
    this.focus = best.route;
    this.focusTimer = 1;
    return true;
  }

  /** 遊撃：どのルートへ戦いに行くか（敵の押し込み具合と、味方の手薄さ） */
  private chooseFocus(e: Entity): { route: TdRouteId; point: Vec3 } | null {
    const api = this.api;
    const core = api.corePos();
    const enemies = api.enemyList();
    const score: Record<TdRouteId, number> = { front: 0, left: 0, right: 0 };
    // ルートごとに、いちばんコアに近い敵（押し込まれている所）
    const deepest: Partial<Record<TdRouteId, { pos: Vec3; d: number }>> = {};
    for (const en of enemies) {
      const d = lenH(sub(en.pos, core));
      // コアに近いほど重い（120m 先は 1、コアのそばは 4 倍）
      score[en.route] += THREAT[en.type] * (1 + 3 * Math.max(0, 1 - d / 120)) * (en.type === 'assault' && d < 70 ? 2 : 1);
      const cur = deepest[en.route];
      if (en.type !== 'drone' && (!cur || d < cur.d)) deepest[en.route] = { pos: en.pos, d };
    }
    // まだ出ていない敵も少しだけ数える（次に来る所）
    for (const r of TD_ROUTE_IDS) score[r] += Math.max(0, api.enemiesOn(r) - enemies.filter((x) => x.route === r).length) * 0.25;
    let best: TdRouteId | null = null,
      bs = 0.4;
    for (const r of TD_ROUTE_IDS) {
      if (score[r] <= 0) continue;
      // 味方がもう行っている所は割り引く。いま向かっている所は少しひいき（行ったり来たりしない）
      // 誰も守っていないルートに敵が来ているなら、そこを大きく優先（どのルートも空けないように）
      const cov = this.coverage(r, e.movement.pos);
      const s = (score[r] / (1 + cov * 1.4)) * (cov === 0 ? 2.2 : 1) * (r === this.focus ? 1.3 : 1);
      if (s > bs) {
        bs = s;
        best = r;
      }
    }
    if (!best) return null;
    // 戦う場所：守る場所。敵がそれより奥まで来ていれば、その敵とコアの間
    let point = this.defensePoint(best);
    const dd = deepest[best];
    if (dd && dd.d < lenH(sub(point, core)) + 4) {
      const to = sub(core, dd.pos);
      const L = lenH(to) || 1;
      const k = Math.min(12, L * 0.5);
      point = v3(dd.pos.x + (to.x / L) * k, 0, dd.pos.z + (to.z / L) * k);
    }
    return { route: best, point };
  }

  /**
   * 迫撃砲兵を追っている間は、その迫撃砲兵を最優先で狙う。ほかの敵は、近く（18m）にいるか撃ってくるときだけ相手にする
   * （途中の敵と撃ち合って、いつまでも着かないことがないように）
   */
  protected override chooseTarget(e: Entity): void {
    super.chooseTarget(e);
    if (this.hunting < 0) return;
    const hc = this.contacts.get(this.hunting);
    if (hc && (hc.visible || this.time - hc.lastSeen < 0.6)) {
      this.setTarget(this.hunting);
      return;
    }
    if (this.target < 0) return;
    const o = this.bw.sim.entities.get(this.target);
    const c = this.contacts.get(this.target);
    if (o && c && len(sub(o.movement.pos, e.movement.pos)) > 18 && this.time - c.hurtMe > 2) this.setTarget(-1);
  }

  // ---------------------------------------------------------------------------

  protected override decide(e: Entity, dt: number): BotIntent {
    this.tdTimer -= dt;
    if (this.tdTimer <= 0) {
      this.tdTimer = 0.25;
      this.tdThink(e);
    }
    if (this.mode === 'revive') {
      const it = this.reviveIntent(e, dt);
      if (it) return it;
    }
    if (this.mode === 'build') {
      const it = this.buildIntent(e, dt);
      if (it) return it;
    }
    return this.dodgePods(e, super.decide(e, dt));
  }

  /** 降りてくる降下ポッドの真下にいたら、輪の外へ走って逃げる（着地の 2 秒前から） */
  private dodgePods(e: Entity, it: BotIntent): BotIntent {
    const p = e.movement.pos;
    for (const pod of this.api.incomingPods()) {
      if (pod.eta > 2) continue;
      const d = sub(p, pod.pos);
      const h = lenH(d);
      if (h > pod.radius + 1 || Math.abs(d.y) > 3) continue;
      const away = h > 0.1 ? v3(d.x / h, 0, d.z / h) : v3(1, 0, 0);
      it.move = away;
      it.sprint = true;
      break;
    }
    return it;
  }

  private setMode(m: Mode) {
    if (this.mode === m) return;
    this.mode = m;
    this.nav.stop();
    if (m === 'fight') this.setState('patrol');
  }

  /** 4回/秒の判断 */
  private tdThink(e: Entity) {
    const api = this.api;
    const phase = api.currentPhase();
    const pos = e.movement.pos;
    if (phase !== this.lastPhase) {
      this.lastPhase = phase;
      if (phase === 'prep') this.badPoints.clear();
      // ウェーブの始めにソナー（ソラ）
      if (phase === 'wave' && this.cdef.ABILITY.TYPE === 'sonar') this.sonarTimer = this.rng.range(6, 12);
    }

    // --- 向かう場所（遊撃） ---
    this.focusTimer -= 0.25;
    if (phase === 'wave' && api.coreUnderAttack() && lenH(sub(api.corePos(), pos)) < 60) {
      const c = api.corePos();
      this.defendingCore = true;
      this.hunting = -1;
      this.huntPos = null;
      this.guard = add(c, v3(this.offset.x * 2.6, 0, this.offset.z * 2.6 + 8));
    } else if (phase === 'wave' && this.interceptAssault(e)) {
      this.defendingCore = false;
      this.hunting = -1;
      this.huntPos = null;
    } else if (phase === 'wave' && this.huntMortar(e)) {
      this.defendingCore = false;
    } else if (phase === 'wave' || phase === 'prep') {
      this.defendingCore = false;
      this.hunting = -1;
      this.huntPos = null;
      if (this.focusTimer <= 0 || !this.focus) {
        this.focusTimer = this.rng.range(2.5, 4);
        const f = this.chooseFocus(e);
        if (f) {
          this.focus = f.route;
          this.guard = add(f.point, this.offset);
        } else if (phase === 'prep') {
          // 準備中は、次に敵が来るルートのうち手薄な所の近くで待つ
          const routes = api.waveRoutes();
          let best: TdRouteId | null = null,
            bc = Infinity;
          for (const r of routes) {
            const c = this.coverage(r, pos) + this.rng.range(0, 0.5);
            if (c < bc) {
              bc = c;
              best = r;
            }
          }
          this.focus = best;
          if (best) this.guard = add(this.defensePoint(best), this.offset);
        } else {
          // 敵がいない（次の敵を待っている）：コアの前
          this.focus = null;
          const c = api.corePos();
          this.guard = add(c, v3(this.offset.x * 3, 0, 14 + this.offset.z * 2));
        }
      }
    }

    // --- 蘇生 ---
    if (this.mode === 'revive') {
      const t = this.bw.sim.entities.get(this.reviveTarget);
      if (!t || t.dead || t.downed <= 0) {
        this.reviveTarget = -1;
        this.setMode('fight');
      }
    } else {
      const d = this.findRevive(e);
      if (d) {
        this.reviveTarget = d.id;
        api.claimRevive(d.id, this.entityId);
        this.setMode('revive');
        this.nav.goTo(d.movement.pos, pos);
        return;
      }
    }
    if (this.mode === 'revive') return;

    // --- タレットを買って置く（準備時間中） ---
    if (phase === 'prep') {
      if (this.mode !== 'build') {
        const plan: { type: TdPlaceable; pos: Vec3; yaw?: number } | null = this.nextBuild() ?? (api.botItems() ? this.nextExtra() : null);
        if (plan) {
          this.buildType = plan.type;
          this.buildPoint = plan.pos;
          this.buildYaw = plan.yaw ?? 0;
          this.setMode('build');
          this.nav.goTo(plan.pos, pos);
        } else if (!api.botItems() || !this.spendRest()) api.markReady(this.entityId);
      }
    } else if (this.mode === 'build') {
      this.buildPoint = null;
      this.setMode('fight');
    }

    // --- アビリティ（タワーディフェンスの使い方） ---
    this.tdAbility(e);
  }

  private sonarTimer = -1;

  private tdAbility(e: Entity) {
    if (e.ability.cooldown > 0 || this.abilityCD > 0) return;
    const t = this.cdef.ABILITY.TYPE;
    const api = this.api;
    if (t === 'sonar' && this.sonarTimer > 0) {
      this.sonarTimer -= 0.25;
      if (this.sonarTimer <= 0) {
        // 近くに敵が来ていて、見えていないなら使う
        const R = abilityNum(this.cdef.ABILITY, 'RADIUS', 40);
        const near = [...this.bw.sim.entities.values()].some((o) => o.team !== e.team && !o.dead && len(sub(o.movement.pos, e.movement.pos)) < R);
        if (near) this.useAbility();
        else this.sonarTimer = 2;
      }
    }
    if (t === 'shield' && api.currentPhase() === 'wave' && api.coreUnderAttack()) {
      const c = api.corePos();
      if (lenH(sub(c, e.movement.pos)) < 14) {
        // コアの前で、敵の方へ向けてシールドを張る
        const o = this.targetEntity();
        if (o) {
          const a = aimAngles(this.eye(e), add(o.movement.pos, v3(0, 1.2, 0)));
          this.useAbility({ yaw: a.yaw, pitch: 0 });
        }
      }
    }
  }

  /** 蘇生しに行く味方（近く・間に合う・まわりが安全） */
  private findRevive(e: Entity): Entity | null {
    const pos = e.movement.pos;
    let best: Entity | null = null,
      bs = Infinity;
    for (const d of this.api.downedAllies(e.team)) {
      if (d.id === e.id) continue;
      if (this.api.reviveClaimed(d.id, this.entityId)) continue;
      const dist = len(sub(d.movement.pos, pos));
      if (dist > 40) continue;
      // 間に合うか（走って行って 3 秒押し続ける）
      if (dist / 7 + 3.3 > d.downed) continue;
      // まわりに見えている敵が多ければ行かない（安全の確認）
      let danger = 0;
      for (const c of this.contacts.values()) {
        if (!c.visible) continue;
        if (len(sub(c.pos, d.movement.pos)) < 12) danger++;
      }
      if (danger >= 2 && e.health < e.maxHealth * 0.7) continue;
      if (danger >= 4) continue;
      if (dist < bs) {
        bs = dist;
        best = d;
      }
    }
    return best;
  }

  private reviveIntent(e: Entity, dt: number): BotIntent | null {
    const t = this.bw.sim.entities.get(this.reviveTarget);
    if (!t || t.downed <= 0) return null;
    const it = emptyIntent(this.aimYaw, this.aimPitch);
    const d = lenH(sub(t.movement.pos, e.movement.pos));
    if (d > 1.5) {
      if (!this.nav.hasGoal || this.nav.failed) this.nav.goTo(t.movement.pos, e.movement.pos);
      const nav = this.nav.update(e, dt);
      it.move = nav.dir;
      it.sprint = nav.sprint || d > 4;
      it.jump = nav.jump;
      it.crouch = nav.crouch;
      it.side = nav.sideInput;
      this.updateAim(e, dt, it.move ? { yaw: Math.atan2(-it.move.x, -it.move.z), pitch: -0.1 } : null, null);
      if (nav.lockYaw !== null) this.setAim(nav.lockYaw, 0);
      if (d < 2.0) it.interact = true;
    } else {
      this.nav.stop();
      this.updateAim(e, dt, aimAngles(this.eye(e), add(t.movement.pos, v3(0, 0.4, 0))), null);
      it.interact = true;
      it.crouch = true;
    }
    it.yaw = this.aimYaw;
    it.pitch = this.aimPitch;
    return it;
  }

  /**
   * 次に置くタレットと場所。人間と同じように、次のウェーブで敵が来るルートのうち、
   * チームのタレットが足りないルートを選び、そのルートの組み合わせで足りない種類を、空いている推奨設置ポイントに置く
   */
  private nextBuild(): { type: TurretType; pos: Vec3 } | null {
    const api = this.api;
    const me = this.bw.sim.entities.get(this.entityId);
    const myPos = me ? me.movement.pos : api.corePos();
    if (api.turretCount(this.entityId) >= api.turretLimit()) return null;
    const credits = api.credits(this.entityId);
    const routes = api.waveRoutes();
    const cands: Array<{ route: TdRouteId; type: TurretType; need: number }> = [];
    for (const r of routes) {
      const def = api.route(r);
      // ルートの推奨設置ポイントのまわりにある、チームのタレット（同じタレットを2度数えない）
      const have = api.turretsNearAny(def.turretPoints, 4);
      const plan = BUILD_PLAN[r];
      const count: Partial<Record<TurretType, number>> = {};
      for (let i = 0; i < plan.length; i++) {
        const t = plan[i];
        count[t] = (count[t] ?? 0) + 1;
        if ((have[t] ?? 0) >= count[t]!) continue;
        // 足りないもの。順番が前のものほど大事。ルートの敵が多いほど大事
        // 遠いルートは歩くのに時間がかかるので、近いルートを先に（人間と同じ）
        const far = lenH(sub(this.defensePoint(r), myPos)) / 18;
        cands.push({ route: r, type: t, need: (plan.length - i) * (1 + api.enemiesOn(r) / 20) - far + this.rng.range(0, 1.5) });
      }
    }
    cands.sort((a, b) => b.need - a.need);
    // 推奨設置ポイントがふさがっていれば、そのまわり（3.5m）も探す
    const around = [v3(0, 0, 0), v3(3.5, 0, 0), v3(-3.5, 0, 0), v3(0, 0, 3.5), v3(0, 0, -3.5)];
    for (const c of cands) {
      if (credits < api.turretCost(c.type)) continue;
      for (const o of around)
        for (const base of api.route(c.route).turretPoints) {
          const p = add(base, o);
          const k = `${c.type}:${p.x},${p.z}`;
          if (this.badPoints.has(k)) continue;
          if (api.occupied(p, 2) || api.buildClaimed(p, this.entityId)) continue;
          if (!api.canPlace(this.entityId, c.type, p)) {
            this.badPoints.add(k);
            continue;
          }
          api.claimBuild(p, this.entityId);
          return { type: c.type, pos: p };
        }
    }
    return null;
  }

  /** ルートの道すじのうち、要塞の中でコアから離れた点（ワイヤートラップを置く候補）と、そこでの道の向き */
  private routeTrapPoints(route: TdRouteId): Array<{ pos: Vec3; yaw: number }> {
    const r = this.api.route(route);
    const a = this.api.buildArea();
    const core = this.api.corePos();
    const pts = [r.gate, ...r.path];
    const out: Array<{ pos: Vec3; yaw: number }> = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i],
        q = pts[i + 1];
      const L = lenH(sub(q, p));
      for (let k = 0; k < L; k += 3) {
        const t = k / (L || 1);
        const c = v3(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t, p.z + (q.z - p.z) * t);
        if (c.x < a.min.x + 1 || c.x > a.max.x - 1 || c.z < a.min.z + 1 || c.z > a.max.z - 1) continue;
        if (lenH(sub(c, core)) < 16) continue;
        // 向き：道に沿う（レーザーは道を横切る）
        out.push({ pos: c, yaw: Math.atan2(-(q.x - p.x), -(q.z - p.z)) });
      }
    }
    return out;
  }

  /** タレットのほかに置く物：ワイヤートラップ（ルートに1つ）、ダミーバルーン（タレットの前） */
  private nextExtra(): { type: TdPlaceable; pos: Vec3; yaw?: number } | null {
    const api = this.api;
    const id = this.entityId;
    const credits = api.credits(id);
    const routes = api.waveRoutes();
    if (!routes.length) return null;
    const tryPoints = (type: TdDeviceType, pts: Array<{ pos: Vec3; yaw: number }>) => {
      for (const c of pts) {
        const k = `${type}:${c.pos.x.toFixed(1)},${c.pos.z.toFixed(1)}`;
        if (this.badPoints.has(k)) continue;
        if (api.buildClaimed(c.pos, id)) continue;
        if (!api.canPlace(id, type, c.pos, c.yaw)) {
          this.badPoints.add(k);
          continue;
        }
        api.claimBuild(c.pos, id);
        return { type, pos: c.pos, yaw: c.yaw };
      }
      return null;
    };
    // ワイヤートラップ：まだ（チームの）トラップがないルートの道に
    const trap = api.itemCost('wiretrap');
    if (credits >= trap + 50 && api.deviceCount(id, 'wiretrap') < 2) {
      for (const r of routes) {
        const pts = this.routeTrapPoints(r);
        if (!pts.length) continue;
        // ルートのどこかに誰かのトラップがあれば、そのルートは済み
        if (pts.some((p) => api.deviceNear('wiretrap', p.pos, 4))) continue;
        // 入口に近い所から（敵が早く踏む）。少しずらした所も試す
        const cand = pts.slice(0, 6).map((p) => ({ pos: p.pos, yaw: p.yaw + this.rng.range(-0.15, 0.15) }));
        const got = tryPoints('wiretrap', cand);
        if (got) return got;
      }
    }
    // ダミーバルーン：クレジットに余裕があれば、タレットの前（入口の側）に
    const dec = api.itemCost('decoy');
    if (credits >= dec + 250 && api.deviceCount(id, 'decoy') < 1) {
      const r = routes[Math.floor(this.rng.next() * routes.length) % routes.length];
      const def = api.route(r);
      const g = def.gate;
      const cand = def.turretPoints.map((tp) => {
        const to = sub(g, tp);
        const L = lenH(to) || 1;
        return { pos: v3(tp.x + (to.x / L) * 4, tp.y, tp.z + (to.z / L) * 4), yaw: Math.atan2(-to.x, -to.z) };
      });
      const got = tryPoints('decoy', cand);
      if (got) return got;
    }
    return null;
  }

  /** 歩いて行かなくてよい買い物（タレットの強化・アーマー）。何か買ったら true */
  private spendRest(): boolean {
    const api = this.api;
    const id = this.entityId;
    // 強化：次のウェーブで敵が来るルートの、攻撃するタレットから（レベルの低い順）
    const routes = api.waveRoutes();
    const core = api.corePos();
    const near = (p: Vec3) => routes.some((r) => api.route(r).turretPoints.some((tp) => lenH(sub(tp, p)) < 8)) || lenH(sub(p, core)) < 14;
    const mine = api
      .myTurrets(id)
      .filter((t) => api.upgradeCheck(id, t.id).ok)
      .sort((a, b) => a.level - b.level + (near(b.pos) ? 1 : 0) - (near(a.pos) ? 1 : 0) + ((b.type === 'mg' || b.type === 'rocket' ? 0.5 : 0) - (a.type === 'mg' || a.type === 'rocket' ? 0.5 : 0)));
    if (mine.length && api.tryUpgrade(id, mine[0].id)) return true;
    // アーマー：クレジットに余裕があれば
    const arm = api.armorCheck(id);
    if (arm.ok && api.credits(id) >= arm.cost + 120) return api.buyArmor(id);
    return false;
  }

  private buildIntent(e: Entity, dt: number): BotIntent | null {
    const p = this.buildPoint;
    const type = this.buildType;
    if (!p || !type) {
      this.setMode('fight');
      return null;
    }
    const it = emptyIntent(this.aimYaw, this.aimPitch);
    const d = lenH(sub(p, e.movement.pos));
    if (d > 3.2) {
      if (!this.nav.hasGoal || this.nav.failed) this.nav.goTo(p, e.movement.pos);
      const nav = this.nav.update(e, dt);
      it.move = nav.dir;
      it.sprint = nav.sprint;
      it.jump = nav.jump;
      it.crouch = nav.crouch;
      it.side = nav.sideInput;
      this.updateAim(e, dt, nav.dir ? { yaw: Math.atan2(-nav.dir.x, -nav.dir.z), pitch: -0.1 } : null, null);
      if (nav.lockYaw !== null) this.setAim(nav.lockYaw, 0);
    } else {
      // 置く場所を見て、置く
      this.nav.stop();
      this.updateAim(e, dt, aimAngles(this.eye(e), p), null);
      const ok = this.api.tryPlace(this.entityId, type, p, this.buildYaw);
      if (!ok) this.badPoints.add(`${type}:${p.x},${p.z}`);
      this.buildPoint = null;
      this.setMode('fight');
    }
    it.yaw = this.aimYaw;
    it.pitch = this.aimPitch;
    return it;
  }
}
