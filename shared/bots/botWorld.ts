/**
 * ボットが共有するもの：経路データ、巡回先の候補、チームで共有する敵の情報、経路探しの順番待ち、
 * 遮蔽物（敵から見えない場所）の探し方。
 */
import type { NavGraph, NavLink } from '../nav';
import { findPath, nearestNode, reachable } from '../nav';
import { type Vec3, len, sub, v3 } from '../math';
import type { Entity, Simulation } from '../simulation';

/** 0〜1 の乱数（mulberry32） */
export class Rng {
  constructor(private s: number) {
    this.s = s >>> 0 || 1;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.next() * list.length) % list.length];
  }
  /** 平均 0・ばらつき 1 の正規乱数 */
  gauss(): number {
    const u = Math.max(1e-9, this.next());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }
}

/** 経路を待っている側 */
export interface PathRequester {
  readonly entityId: number;
  pathFrom: Vec3;
  pathTo: Vec3;
  allow?: (l: NavLink) => boolean;
  onPath(path: number[] | null): void;
}

export interface Intel {
  pos: Vec3;
  time: number;
  /** パイロットか */
  pilot: boolean;
}

export class BotWorld {
  readonly rng: Rng;
  /** 巡回先の候補（経路の点の番号。全部つながっている所） */
  readonly pois: number[] = [];
  /** 歩兵が行く、地上の中央付近の点 */
  readonly groundPois: number[] = [];
  /** チームごとの、最近見つけた敵の位置（味方のボットが見たもの・ソナーで見えたもの） */
  readonly intel = new Map<number, Map<number, Intel>>();
  private readonly queue: PathRequester[] = [];
  private readonly cells = new Map<string, number[]>();
  readonly connected: Set<number>;
  /** 1ティックで探す経路の数（重くならないように） */
  pathsPerTick = 2;

  constructor(
    readonly sim: Simulation,
    readonly nav: NavGraph,
    seed: number,
    readonly center: Vec3,
  ) {
    this.rng = new Rng(seed);
    for (const n of nav.nodes) {
      const k = `${Math.floor(n.pos.x / 8)},${Math.floor(n.pos.z / 8)}`;
      let l = this.cells.get(k);
      if (!l) this.cells.set(k, (l = []));
      l.push(n.id);
    }
    // 陣地からつながっている点だけを使う
    const sp = sim.level.spawns?.find((s) => s.team === 0)?.pos ?? sim.level.spawn;
    const start = nearestNode(nav, sp, 8);
    this.connected = start >= 0 ? reachable(nav, start) : new Set(nav.nodes.map((n) => n.id));
    // 巡回先：12m 以上離れた点を散らして選ぶ
    const rng = new Rng(seed ^ 0x51ed);
    const ids = [...this.connected];
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    for (const id of ids) {
      const p = nav.nodes[id].pos;
      if (this.pois.length < 90 && this.pois.every((o) => len(sub(nav.nodes[o].pos, p)) > 12)) this.pois.push(id);
      const dc = Math.hypot(p.x - center.x, p.z - center.z);
      if (p.y < 0.6 && dc < 46 && this.groundPois.length < 60 && this.groundPois.every((o) => len(sub(nav.nodes[o].pos, p)) > 6)) this.groundPois.push(id);
    }
  }

  /** p の近く（半径 r）の点 */
  nodesNear(p: Vec3, r: number): number[] {
    const out: number[] = [];
    const c = Math.ceil(r / 8);
    const cx = Math.floor(p.x / 8),
      cz = Math.floor(p.z / 8);
    for (let x = cx - c; x <= cx + c; x++)
      for (let z = cz - c; z <= cz + c; z++)
        for (const id of this.cells.get(`${x},${z}`) ?? []) {
          const q = this.nav.nodes[id].pos;
          if (Math.hypot(q.x - p.x, q.z - p.z) <= r && Math.abs(q.y - p.y) < 8 && this.connected.has(id)) out.push(id);
        }
    return out;
  }

  /** 経路探しを頼む（順番に、1ティックに数本ずつ探す） */
  requestPath(r: PathRequester): void {
    if (!this.queue.includes(r)) this.queue.push(r);
  }

  cancelPath(r: PathRequester): void {
    const i = this.queue.indexOf(r);
    if (i >= 0) this.queue.splice(i, 1);
  }

  processPaths(): void {
    for (let n = 0; n < this.pathsPerTick && this.queue.length; n++) {
      const r = this.queue.shift()!;
      if (!this.sim.entities.has(r.entityId)) continue;
      const a = this.nearestConnected(r.pathFrom);
      const b = this.nearestConnected(r.pathTo);
      if (a < 0 || b < 0) {
        r.onPath(null);
        continue;
      }
      r.onPath(a === b ? [a] : findPath(this.nav, a, b, r.allow, 6000));
    }
  }

  /** つながっている点のうち、いちばん近いもの */
  nearestConnected(p: Vec3, maxD = 7): number {
    let best = -1,
      bd = maxD;
    for (const id of this.nodesNear(p, maxD)) {
      const q = this.nav.nodes[id].pos;
      const d = Math.hypot(q.x - p.x, (q.y - p.y) * 1.6, q.z - p.z);
      if (d < bd) {
        bd = d;
        best = id;
      }
    }
    if (best < 0) {
      const n = nearestNode(this.nav, p, 14);
      return this.connected.has(n) ? n : -1;
    }
    return best;
  }

  /** 点 p（立った人の胸の高さ）が、どの目からも見えないか */
  hiddenFrom(p: Vec3, eyes: Vec3[]): boolean {
    const chest = v3(p.x, p.y + 1.2, p.z);
    for (const e of eyes) {
      const d = sub(chest, e);
      const L = len(d);
      if (L < 0.5) return false;
      if (!this.sim.world.raycast(e, v3(d.x / L, d.y / L, d.z / L), L - 0.3)) return false;
    }
    return true;
  }

  /**
   * 遮蔽物を探す：from から minD〜maxD の範囲で、敵の目（threats）から見えない点。
   * away が true なら、敵から遠い所を好む（退避）
   */
  findCover(from: Vec3, threats: Vec3[], minD: number, maxD: number, away: boolean): Vec3 | null {
    const cand = this.nodesNear(from, maxD);
    let tested = 0;
    // 近い順に調べる（光線を飛ばす回数を抑える）
    const scored = cand
      .map((id) => {
        const p = this.nav.nodes[id].pos;
        const d = Math.hypot(p.x - from.x, p.z - from.z);
        let s = d + Math.abs(p.y - from.y) * 0.8;
        if (away && threats.length) {
          const td = Math.min(...threats.map((t) => Math.hypot(t.x - p.x, t.z - p.z)));
          s -= td * 0.8;
        }
        return { p, d, s };
      })
      .filter((c) => c.d >= minD)
      .sort((a, b) => a.s - b.s);
    for (const c of scored) {
      if (tested++ > 28) break;
      if (this.hiddenFrom(c.p, threats)) return c.p;
    }
    return null;
  }

  /** チームで共有する、敵の位置 */
  report(team: number, enemy: Entity): void {
    // ティックはチームに知らせない（小さく、すぐ爆発する）
    if (enemy.kind === 'tick') return;
    let m = this.intel.get(team);
    if (!m) this.intel.set(team, (m = new Map()));
    m.set(enemy.id, { pos: { ...enemy.movement.pos }, time: this.sim.time, pilot: enemy.kind === 'pilot' || enemy.kind === 'decoy' || enemy.kind === 'holo' });
  }

  /** 最近の敵の情報（古いものは消す） */
  recentIntel(team: number, maxAge: number): Array<[number, Intel]> {
    const m = this.intel.get(team);
    if (!m) return [];
    const out: Array<[number, Intel]> = [];
    for (const [id, it] of m) {
      if (this.sim.time - it.time > maxAge || !this.sim.entities.get(id) || this.sim.entities.get(id)!.dead) {
        if (this.sim.time - it.time > 30) m.delete(id);
        continue;
      }
      out.push([id, it]);
    }
    return out;
  }
}
