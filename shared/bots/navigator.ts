/**
 * ボットの経路に沿った移動。
 * 経路の点の列をたどり、つながりの種類（歩く・飛び降りる・跳ぶ・壁走り）に合わせて、
 * 進む向き・ダッシュ・ジャンプ・しゃがみを決める。向きは世界の向き（ボットの視線とは別）で返す。
 * 跳ぶ・壁走りの途中は、視線を進む向きに固定する（lockYaw）。よじ登り・壁走りの入りは視線の向きで決まるため。
 */
import type { MovementConfig } from '../../config';
import type { NavLink } from '../nav';
import { type Vec3, horiz, len, lenH, normalize, sub, v3 } from '../math';
import type { Entity } from '../simulation';
import type { BotWorld, PathRequester } from './botWorld';

export interface NavOut {
  /** 進みたい向き（水平・長さ 1）。止まるときは null */
  dir: Vec3 | null;
  sprint: boolean;
  jump: boolean;
  crouch: boolean;
  /** 視線をこの向きにしてほしい（跳ぶ・壁走りの途中） */
  lockYaw: number | null;
  /** 視線に対して横へ入力してほしい量（壁走りの入りで、壁の方へ寄る） */
  sideInput: number;
}

const yawOf = (d: Vec3) => Math.atan2(-d.x, -d.z);

/** 跳ぶ・壁走りの助走を始める場所（つながりごとに一度だけ探す） */
const runupCache = new WeakMap<NavLink, Vec3>();

export class Navigator implements PathRequester {
  pathFrom: Vec3 = v3();
  pathTo: Vec3 = v3();
  private baseAllow?: (l: NavLink) => boolean;
  /** 何度も失敗したつながり（しばらく経路に使わない。つながり → 使わない時刻まで） */
  private readonly badLinks = new Map<NavLink, number>();
  path: number[] | null = null;
  private idx = 0;
  private goal: Vec3 | null = null;
  pending = false;
  /** 経路が見つからなかった */
  failed = false;
  // 跳ぶ・壁走りの段階
  private phase: 'none' | 'runup' | 'go' | 'air' = 'none';
  private jumpedOnce = false;
  private doubled = false;
  private wallran = false;
  private maneuverTime = 0;
  // 動けなくなったときの判定
  private bestDist = Infinity;
  private stuckTime = 0;
  private stuckLevel = 0;
  private unstickDir: Vec3 | null = null;
  private unstickTime = 0;
  /** 経路を作り直した回数（何度も失敗したら、行き先をあきらめる） */
  repaths = 0;

  constructor(
    readonly entityId: number,
    private readonly bw: BotWorld,
    private readonly cfg: MovementConfig,
  ) {}

  /** 経路に使ってよいつながり（ボットごとの制限）。失敗したつながりは、しばらく除く */
  get allow(): ((l: NavLink) => boolean) | undefined {
    if (!this.badLinks.size) return this.baseAllow;
    const now = this.bw.sim.time;
    for (const [l, t] of this.badLinks) if (t <= now) this.badLinks.delete(l);
    if (!this.badLinks.size) return this.baseAllow;
    const base = this.baseAllow;
    const bad = this.badLinks;
    return (l: NavLink) => !bad.has(l) && (!base || base(l));
  }
  set allow(f: ((l: NavLink) => boolean) | undefined) {
    this.baseAllow = f;
  }

  /** いまのつながりを、しばらく使わないことにする（跳び損ねた・何度も引っかかった） */
  private markBad() {
    if (!this.path || this.idx >= this.path.length - 1) return;
    const l = this.linkBetween(this.path[this.idx], this.path[this.idx + 1]);
    if (l) this.badLinks.set(l, this.bw.sim.time + 25);
  }

  /** 行き先を決めて、経路探しを頼む */
  goTo(pos: Vec3, from: Vec3): void {
    this.goal = { ...pos };
    this.pathTo = { ...pos };
    this.pathFrom = { ...from };
    this.pending = true;
    this.failed = false;
    this.repaths = 0;
    this.bw.requestPath(this);
  }

  stop(): void {
    this.goal = null;
    this.path = null;
    this.pending = false;
    this.bw.cancelPath(this);
    this.resetManeuver();
  }

  get hasGoal(): boolean {
    return !!this.goal;
  }

  get goalPos(): Vec3 | null {
    return this.goal;
  }

  /** 経路のうち、いま向かっている点の番号（path の中の位置） */
  get pathIndex(): number {
    return this.idx;
  }

  /** いま通っているつながりの種類（経路がなければ null） */
  get linkKind(): NavLink['kind'] | null {
    if (!this.path || this.idx >= this.path.length - 1) return null;
    return this.linkBetween(this.path[this.idx], this.path[this.idx + 1])?.kind ?? 'walk';
  }

  /** 今のつながりが、跳ぶ・壁走りの途中か（撃つのを控える） */
  get maneuvering(): boolean {
    return this.phase !== 'none';
  }

  onPath(path: number[] | null): void {
    this.pending = false;
    if (!path) {
      this.failed = true;
      this.path = null;
      return;
    }
    this.path = path;
    this.idx = 0;
    this.resetManeuver();
    this.resetStuck();
  }

  /** ゴールに着いた（経路の最後の点の近く） */
  arrived(e: Entity, dist = 1.6): boolean {
    if (!this.goal) return true;
    const p = e.movement.pos;
    return Math.hypot(p.x - this.goal.x, p.z - this.goal.z) < dist && Math.abs(p.y - this.goal.y) < 2;
  }

  private resetManeuver() {
    this.phase = 'none';
    this.jumpedOnce = false;
    this.doubled = false;
    this.wallran = false;
    this.maneuverTime = 0;
  }

  private resetStuck() {
    this.bestDist = Infinity;
    this.stuckTime = 0;
    this.stuckLevel = 0;
    this.unstickDir = null;
  }

  private linkBetween(a: number, b: number): NavLink | null {
    for (const li of this.bw.nav.out[a]) {
      const l = this.bw.nav.links[li];
      if (l.b === b) return l;
    }
    return null;
  }

  private repath(e: Entity) {
    if (!this.goal) return;
    this.repaths++;
    this.path = null;
    this.resetManeuver();
    this.resetStuck();
    if (this.repaths > 4) {
      this.failed = true;
      this.goal = null;
      return;
    }
    this.pathFrom = { ...e.movement.pos };
    this.pending = true;
    this.bw.requestPath(this);
  }

  /** 目の前（進む向き dist 先）の足元に床があるか */
  private groundAhead(p: Vec3, dir: Vec3, dist: number): boolean {
    const o = v3(p.x + dir.x * dist, p.y + 0.5, p.z + dir.z * dist);
    return !!this.bw.sim.world.raycast(o, v3(0, -1, 0), 1.6);
  }

  /** 跳ぶ・壁走りの助走の開始点（最大 7m 手前。立てる場所） */
  private runupPoint(l: NavLink, from: Vec3, to: Vec3): Vec3 {
    const c = runupCache.get(l);
    if (c) return c;
    const d = sub(to, from);
    const L = lenH(d) || 1;
    const fx = d.x / L,
      fz = d.z / L;
    const w = this.bw.sim.world;
    let best = v3(from.x, from.y, from.z);
    for (let k = 7; k >= 1.5; k -= 0.5) {
      const p = v3(from.x - fx * k, from.y + 0.05, from.z - fz * k);
      const g = w.raycast(v3(p.x, p.y + 1, p.z), v3(0, -1, 0), 1.5);
      if (!g || Math.abs(g.point.y - from.y) > 0.25) continue;
      // 助走の道がふさがっていない
      let free = true;
      for (let s = 0; s <= k; s += 0.75) {
        const q = v3(from.x - fx * s, from.y, from.z - fz * s);
        if (w.blocked(v3(q.x, q.y + 0.8, q.z), v3(q.x, q.y + 1.4, q.z), this.cfg.PLAYER_RADIUS + 0.05)) {
          free = false;
          break;
        }
      }
      if (free) {
        best = v3(p.x, from.y, p.z);
        break;
      }
    }
    runupCache.set(l, best);
    return best;
  }

  update(e: Entity, dt: number): NavOut {
    const out: NavOut = { dir: null, sprint: false, jump: false, crouch: false, lockYaw: null, sideInput: 0 };
    const m = e.movement;
    const p = m.pos;
    const nodes = this.bw.nav.nodes;
    const grounded = m.state === 'ground' || m.state === 'slide';

    // 動けなくなったときの抜け出し（横へ少し動く）
    if (this.unstickTime > 0) {
      this.unstickTime -= dt;
      out.dir = this.unstickDir;
      out.jump = this.unstickTime < 0.25 && grounded;
      return out;
    }

    if (!this.path || this.pending) {
      // 経路を待っている間：ゴールの方へゆっくり
      if (this.goal && this.pending && lenH(sub(this.goal, p)) > 2) out.dir = normalize(horiz(sub(this.goal, p)));
      return out;
    }
    if (this.idx >= this.path.length - 1) {
      // 最後の点からゴールの位置まで
      if (this.goal) {
        const d = horiz(sub(this.goal, p));
        if (len(d) > 0.6) {
          out.dir = normalize(d);
          out.sprint = len(d) > 4;
        }
      }
      return out;
    }

    const A = nodes[this.path[this.idx]].pos;
    const B = nodes[this.path[this.idx + 1]].pos;
    const link = this.linkBetween(this.path[this.idx], this.path[this.idx + 1]);
    const kind = link?.kind ?? 'walk';
    const toB = sub(B, p);
    const hB = lenH(toB);

    // --- 次の点に着いたか ---
    let reached = false;
    if (kind === 'walk') {
      const nextLink = this.idx + 2 < this.path.length ? this.linkBetween(this.path[this.idx + 1], this.path[this.idx + 2]) : null;
      const r = nextLink && nextLink.kind === 'walk' ? 1.5 : 0.8;
      // 次が平らなつながりなら、同じ高さまで来てから次へ（坂の途中で曲がると、横の高い床の縁に引っかかる）
      const flatNext = !!nextLink && nextLink.kind === 'walk' && Math.abs(nodes[this.path[this.idx + 2]].pos.y - B.y) < 0.3;
      reached = hB < r && Math.abs(toB.y) < (flatNext ? 0.3 : 1.3);
    } else if (kind === 'drop') {
      reached = hB < 1.6 && Math.abs(toB.y) < 1.0 && grounded;
    } else if (kind === 'jump') {
      reached = hB < 1.8 && Math.abs(toB.y) < 0.7 && (grounded || m.state === 'mantle' ? grounded : false);
    } else if (kind === 'wallrun') {
      const to = link?.to ?? B;
      reached = grounded && Math.abs(p.y - B.y) < 1.0 && (lenH(sub(to, p)) < 3.2 || hB < 3);
    }
    if (reached) {
      this.idx++;
      this.resetManeuver();
      this.resetStuck();
      return this.update(e, 0);
    }

    // --- 経路から外れた（落ちた・跳び損ねた） ---
    if (grounded && kind !== 'drop' && p.y < Math.min(A.y, B.y) - 1.6) {
      this.repath(e);
      return out;
    }
    // 坂・階段の横から落ちた（歩くつながりの、その場所の高さより 0.9m 以上低い床に立っている）
    if (grounded && kind === 'walk' && Math.abs(B.y - A.y) > 0.3) {
      const abx = B.x - A.x,
        abz = B.z - A.z;
      const L2 = abx * abx + abz * abz;
      const t = L2 > 0.01 ? Math.max(0, Math.min(1, ((p.x - A.x) * abx + (p.z - A.z) * abz) / L2)) : 1;
      if (p.y < A.y + (B.y - A.y) * t - 0.9) {
        this.repath(e);
        return out;
      }
    }
    if (grounded && (kind === 'jump' || kind === 'wallrun') && this.jumpedOnce && this.maneuverTime > 0.4) {
      // 跳んで着地したのに着いていない
      if (Math.abs(p.y - B.y) > 0.8 || hB > 4) {
        this.markBad();
        this.repath(e);
        return out;
      }
    }

    // 跳ぶ・壁走りの助走が長すぎる（入れなかった）
    if (this.maneuverTime > 6) {
      this.markBad();
      this.repath(e);
      return out;
    }
    // --- 動けなくなったか（次の点に近づいていない。助走で離れる間は数えない） ---
    if (m.state !== 'mantle' && m.state !== 'wallrun' && this.phase === 'none') {
      const d3 = hB + Math.abs(toB.y) * 0.5;
      if (d3 < this.bestDist - 0.3) {
        this.bestDist = d3;
        this.stuckTime = 0;
      } else {
        this.stuckTime += dt;
        if (this.stuckTime > 1.1) {
          this.stuckTime = 0;
          this.stuckLevel++;
          if (this.stuckLevel === 1) out.jump = grounded;
          else if (this.stuckLevel === 2) {
            const side = (e.id + this.idx) % 2 ? 1 : -1;
            const f = normalize(horiz(toB));
            this.unstickDir = v3(-f.z * side, 0, f.x * side);
            this.unstickTime = 0.55;
          } else {
            this.markBad();
            this.repath(e);
            return out;
          }
        }
      }
    }

    // --- 移動 ---
    if (kind === 'walk' || kind === 'drop') {
      let target = B;
      // 角を少し早めに曲がる
      if (kind === 'walk' && hB < 2.2 && this.idx + 2 < this.path.length) {
        const C = nodes[this.path[this.idx + 2]].pos;
        const nl = this.linkBetween(this.path[this.idx + 1], this.path[this.idx + 2]);
        if (nl?.kind === 'walk') target = v3((B.x + C.x) / 2, B.y, (B.z + C.z) / 2);
      }
      const d = horiz(sub(target, p));
      out.dir = len(d) > 1e-3 ? normalize(d) : normalize(horiz(toB));
      out.sprint = true;
      return out;
    }

    this.maneuverTime += dt;
    if (kind === 'jump') {
      const from = link?.from ?? A;
      const to = link?.to ?? B;
      const dy = to.y - from.y;
      const dist = lenH(sub(to, from));
      const dir = normalize(horiz(sub(to, from)));
      const longJump = dist > 5;
      if (this.phase === 'none') this.phase = longJump && dy < 0.6 ? 'runup' : 'go';
      if (this.phase === 'runup') {
        const R = this.runupPoint(link!, from, to);
        const dR = horiz(sub(R, p));
        // 助走の開始点に着いた（または、もう跳ぶ向きに十分走っている）
        const along = (p.x - from.x) * dir.x + (p.z - from.z) * dir.z;
        if (lenH(dR) < 0.9 || (along > -0.5 && along < 0.5 && lenH(m.vel) > 6.5 && grounded)) this.phase = 'go';
        else {
          out.dir = normalize(dR);
          out.sprint = true;
          return out;
        }
      }
      out.lockYaw = yawOf(dir);
      out.dir = normalize(horiz(sub(to, p)));
      if (!longJump || this.jumpedOnce) out.dir = lenH(sub(to, p)) > 0.4 ? normalize(horiz(sub(to, p))) : dir;
      else out.dir = dir;
      out.sprint = true;
      if (dy > 0.3) {
        // よじ登り：近くで跳び、高ければ頂点で2段ジャンプ
        // （手前の胸壁・段に当たって近づけないときは、そこから跳ぶ）
        const hTo = lenH(sub(to, p));
        const blocked = hTo < 4 && lenH(m.vel) < 1.5 && this.maneuverTime > 0.35;
        if (grounded && (hTo < 2.4 || blocked) && !this.jumpedOnce) {
          out.jump = true;
          this.jumpedOnce = true;
        } else if (!grounded && this.jumpedOnce && !this.doubled && m.vel.y < 1.2 && p.y < to.y + 0.2 && dy > 1.1) {
          out.jump = true;
          this.doubled = true;
        }
      } else {
        // 隙間を跳ぶ：縁で跳び、落ち始めたら2段ジャンプ
        if (grounded && !this.jumpedOnce && !this.groundAhead(p, dir, 0.9)) {
          out.jump = true;
          this.jumpedOnce = true;
        } else if (!grounded && this.jumpedOnce && !this.doubled && m.vel.y < 0.6 && lenH(sub(to, p)) > 1.4) {
          out.jump = true;
          this.doubled = true;
        } else if (!grounded && !this.jumpedOnce && !this.doubled && m.vel.y < -1 && lenH(sub(to, p)) > 1.5 && p.y < to.y + 1) {
          // 走ったまま落ちてしまった
          out.jump = true;
          this.jumpedOnce = this.doubled = true;
        }
      }
      return out;
    }

    // 壁走り
    const from = link?.from ?? A;
    const to = link?.to ?? B;
    const via = link?.via ?? v3((from.x + to.x) / 2, from.y + 1, (from.z + to.z) / 2);
    const dir = normalize(horiz(sub(to, from)));
    if (this.phase === 'none') this.phase = 'runup';
    if (this.phase === 'runup') {
      const R = this.runupPoint(link!, from, to);
      const dR = horiz(sub(R, p));
      if (lenH(dR) < 0.9) this.phase = 'go';
      else {
        out.dir = normalize(dR);
        out.sprint = true;
        if (lenH(dR) < 2.5) out.lockYaw = yawOf(normalize(dR));
        return out;
      }
    }
    const yaw = yawOf(dir);
    out.lockYaw = yaw;
    out.sprint = true;
    const rx = Math.cos(yaw),
      rz = -Math.sin(yaw);
    const side = Math.sign((via.x - from.x) * rx + (via.z - from.z) * rz) || 1;
    if (m.state === 'wallrun') this.wallran = true;
    if (this.phase === 'go') {
      out.dir = dir;
      if (grounded && !this.groundAhead(p, dir, 1.2)) {
        out.jump = true;
        this.jumpedOnce = true;
        this.phase = 'air';
      } else if (!grounded && m.state !== 'wallrun') {
        this.phase = 'air';
        this.jumpedOnce = true;
      }
      return out;
    }
    // 空中：壁走りが始まるまでは壁の方へ寄る。壁走りの後は目的地へ
    if (!this.wallran) {
      out.dir = dir;
      out.sideInput = side;
    } else {
      const d = horiz(sub(to, p));
      out.dir = len(d) > 0.5 ? normalize(d) : dir;
      // 届かなさそうなら2段ジャンプ
      if (m.state === 'air' && !this.doubled && p.y < to.y + 0.3 && lenH(d) > 2.5 && m.vel.y < 0) {
        out.jump = true;
        this.doubled = true;
      }
    }
    return out;
  }
}
