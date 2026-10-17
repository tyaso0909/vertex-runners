/**
 * ボット用の経路データ（ナビゲーショングラフ）。
 *
 * 地形の箱から、立てる場所に「点」を並べ、歩いて行ける隣の点・飛び降りられる下の点・
 * 跳び移れる向こう側の点を自動で「つながり」にする。壁走りなど、自動では見つけにくい移動は
 * ステージのデータ（LevelData.navLinks）に書いておき、近くの点どうしをつなぐ。
 *
 * 使い方（フェーズ6のボット）：findPath(graph, 今いる点, 行きたい点) で点の列が返る。
 * つながりの種類（walk / drop / jump / wallrun）を見て、ボットは入力（ダッシュ・ジャンプ）を決める。
 */
import type { MovementConfig } from '../config';
import { type Box, capsuleVsBox, makeBox } from './collision';
import type { LevelData, NavLinkKind } from './level';
import { type Mat3, type Vec3, mat3TMulVec, sub, v3 } from './math';

export interface NavNode {
  id: number;
  /** 立っている床の上の点 */
  pos: Vec3;
}

export interface NavLink {
  a: number;
  b: number;
  kind: NavLinkKind;
  /** 移動にかかるおおよその時間（秒）。経路探しの重み */
  cost: number;
  /** 壁走りで使う壁の点 */
  via?: Vec3;
  /** ステージに書いてある特別な移動の、始まりと終わりの位置（壁走り・跳び移り） */
  from?: Vec3;
  to?: Vec3;
}

export interface NavGraph {
  nodes: NavNode[];
  links: NavLink[];
  /** 点ごとの、出ていくつながりの番号 */
  out: number[][];
  spacing: number;
}

const SPACING = 2.5;

/** 箱を大まかな格子に入れて、近くの箱だけを調べられるようにする */
class BoxIndex {
  private cells = new Map<string, Box[]>();
  constructor(
    readonly boxes: Box[],
    private readonly cell = 8,
  ) {
    for (const b of boxes) {
      for (let x = Math.floor(b.min.x / cell); x <= Math.floor(b.max.x / cell); x++)
        for (let z = Math.floor(b.min.z / cell); z <= Math.floor(b.max.z / cell); z++) {
          const k = `${x},${z}`;
          let list = this.cells.get(k);
          if (!list) this.cells.set(k, (list = []));
          list.push(b);
        }
    }
  }
  near(x0: number, z0: number, x1: number, z1: number): Box[] {
    const c = this.cell;
    const seen = new Set<Box>();
    for (let x = Math.floor(Math.min(x0, x1) / c); x <= Math.floor(Math.max(x0, x1) / c); x++)
      for (let z = Math.floor(Math.min(z0, z1) / c); z <= Math.floor(Math.max(z0, z1) / c); z++)
        for (const b of this.cells.get(`${x},${z}`) ?? []) seen.add(b);
    return [...seen];
  }
}

/** 箱の上面のうち、点 (x, z) の真上・真下にある高さ（上面が上を向いていなければ null） */
function topAt(b: Box, x: number, z: number): number | null {
  const rot: Mat3 = b.rot;
  // 上面の法線（箱のローカル +Y）
  const ny = rot[4];
  if (ny < 0.64) return null; // 傾きが 50° を超える面は立てない
  const nx = rot[1],
    nz = rot[7];
  // 上面の中心
  const cx = b.center.x + nx * b.half.y,
    cy = b.center.y + ny * b.half.y,
    cz = b.center.z + nz * b.half.y;
  // 平面の上で (x, z) の高さを求める
  const y = cy - (nx * (x - cx) + nz * (z - cz)) / ny;
  // その点が上面の範囲内か（ローカル座標で調べる）
  const l = mat3TMulVec(rot, sub(v3(x, y, z), b.center));
  if (Math.abs(l.x) > b.half.x + 1e-4 || Math.abs(l.z) > b.half.z + 1e-4) return null;
  return y;
}

export function buildNavGraph(level: LevelData, cfg: MovementConfig): NavGraph {
  const boxes = level.boxes.map((d, i) => makeBox(i, d.center, d.size, d.rot ?? v3(), d.noWallrun ?? false));
  const idx = new BoxIndex(boxes);
  const R = cfg.PLAYER_RADIUS;
  const H = cfg.STAND_HEIGHT;
  const bounds = level.bounds ?? { min: v3(-200, -100, -200), max: v3(200, 200, 200) };
  // 見えない壁・手すりなどの上には点を置かない
  // （高層部分の屋上・スカイブリッジの屋根・売店の屋根・看板の上など、普通は行かない所も除く）
  const NO_STAND = new Set(['barrier', 'rail', 'trunk', 'tower', 'roof', 'kiosk', 'billboard', 'glass']);
  const noStand = new Set(level.boxes.map((d, i) => (d.tag && NO_STAND.has(d.tag) ? i : -1)).filter((i) => i >= 0));

  /** その場所に立てるか（段差の高さより上の体が、どの箱とも重ならない） */
  const clear = (p: Vec3, near: Box[]) => {
    const a = v3(p.x, p.y + cfg.STEP_HEIGHT + R, p.z);
    const b = v3(p.x, p.y + H - R, p.z);
    const y0 = p.y + cfg.STEP_HEIGHT,
      y1 = p.y + H;
    for (const box of near) {
      // 体の入る範囲（四角）と重ならない箱は調べない
      if (box.max.x < p.x - R || box.min.x > p.x + R || box.max.z < p.z - R || box.min.z > p.z + R || box.max.y < y0 || box.min.y > y1) continue;
      const c = capsuleVsBox(a, b, R, box);
      if (c && c.depth > 0.01) return false;
    }
    return true;
  };

  /** (x, z) で、高さ y の近く（下 down・上 up の範囲）にある立てる床の高さ */
  const groundNear = (x: number, z: number, y: number, down: number, up: number, near: Box[]): number | null => {
    let best: number | null = null;
    for (const b of near) {
      if (noStand.has(b.id)) continue;
      const t = topAt(b, x, z);
      if (t === null || t < y - down || t > y + up) continue;
      if (best === null || t > best) best = t;
    }
    return best;
  };

  /** 縁ぎりぎりではない（少しずらしても同じ高さの床がある） */
  const ok = (x: number, z: number, t: number, near: Box[]) =>
    [
      [0.35, 0],
      [-0.35, 0],
      [0, 0.35],
      [0, -0.35],
    ].every(([dx, dz]) => groundNear(x + dx, z + dz, t, 0.4, 0.4, near) !== null);
  const NUDGE = [
    [0, 0],
    [0.6, 0],
    [-0.6, 0],
    [0, 0.6],
    [0, -0.6],
    [0.6, 0.6],
    [-0.6, 0.6],
    [0.6, -0.6],
    [-0.6, -0.6],
  ];

  // --- 1. 点を置く ---
  const nodes: NavNode[] = [];
  const grid = new Map<string, number[]>();
  const key = (ix: number, iz: number) => `${ix},${iz}`;
  const ix0 = Math.ceil(bounds.min.x / SPACING),
    ix1 = Math.floor(bounds.max.x / SPACING);
  const iz0 = Math.ceil(bounds.min.z / SPACING),
    iz1 = Math.floor(bounds.max.z / SPACING);
  for (let ix = ix0; ix <= ix1; ix++) {
    for (let iz = iz0; iz <= iz1; iz++) {
      const x = ix * SPACING,
        z = iz * SPACING;
      const near = idx.near(x - 1.5, z - 1.5, x + 1.5, z + 1.5);
      const tops: number[] = [];
      for (const b of near) {
        if (noStand.has(b.id)) continue;
        const t = topAt(b, x, z);
        if (t === null || t < bounds.min.y + 5 || t > bounds.max.y) continue;
        if (NUDGE.some(([dx, dz]) => ok(x + dx, z + dz, t, near))) tops.push(t);
      }
      // 近い高さの面（階段の段の境目など）は、高い方だけにする
      tops.sort((p, q) => q - p);
      for (let i = tops.length - 1; i > 0; i--) if (tops[i - 1] - tops[i] < 0.5) tops.splice(i, 1);
      for (const t of tops) {
        // 壁や手すりのすぐ横で立てないときは、少しずらした所を試す（室内・階段の脇など）
        let p: Vec3 | null = null;
        for (const [dx, dz] of NUDGE) {
          const q = v3(x + dx, t, z + dz);
          if (!ok(q.x, q.z, t, near)) continue;
          if (dx !== 0 || dz !== 0) q.y = groundNear(q.x, q.z, t, 0.4, 0.4, near) ?? t;
          if (clear(q, near)) {
            p = q;
            break;
          }
        }
        if (!p) continue;
        const id = nodes.length;
        nodes.push({ id, pos: p });
        const k = key(ix, iz);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k)!.push(id);
      }
    }
  }

  const links: NavLink[] = [];
  const out: number[][] = nodes.map(() => []);
  const linked = new Set<string>();
  const addLink = (a: number, b: number, kind: NavLinkKind, cost: number, via?: Vec3, from?: Vec3, to?: Vec3) => {
    const k = `${a}>${b}`;
    if (linked.has(k)) {
      // 特別な移動は、自動で見つけた移動より優先する（壁走りの入り方がわかるように）
      if (from) {
        const l = links.find((x) => x.a === a && x.b === b);
        if (l) Object.assign(l, { kind, cost: Math.min(l.cost, cost), via, from, to });
      }
      return;
    }
    linked.add(k);
    out[a].push(links.length);
    links.push({ a, b, kind, cost, via, from, to });
  };

  /** a から b へ歩いて行けるか（途中の床が続いていて、ぶつかるものがない） */
  const walkable = (pa: Vec3, pb: Vec3) => {
    const near = idx.near(pa.x - 1, pa.z - 1, pb.x + 1, pb.z + 1);
    const dist = Math.hypot(pb.x - pa.x, pb.z - pa.z);
    const dy = pb.y - pa.y;
    // 坂・階段でも 50° まで
    if (Math.abs(dy) > dist * Math.tan((cfg.WALKABLE_SLOPE_DEG * Math.PI) / 180) + cfg.STEP_HEIGHT) return false;
    // 0.35m ごとに調べる（段差を見落とさないように。最後に行き先の点そのものとの段差も見る）
    const steps = Math.max(6, Math.ceil(dist / 0.35));
    let prevY = pa.y;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = pa.x + (pb.x - pa.x) * t,
        z = pa.z + (pb.z - pa.z) * t;
      const y = groundNear(x, z, pa.y + dy * t, 0.7, 0.7, near);
      if (y === null) return false;
      // 段差：坂の傾きの分（このつながりの高さの差の 1/steps）を超えて段になっていれば歩けない（坂の横から高い床へ、など）
      if (Math.abs(y - prevY) > cfg.STEP_HEIGHT + Math.abs(dy) / steps + 0.08) return false;
      if (!clear(v3(x, y, z), near)) return false;
      prevY = y;
    }
    return Math.abs(pb.y - prevY) <= cfg.STEP_HEIGHT + Math.abs(dy) / steps + 0.08;
  };

  // --- 2. 歩いて行ける隣の点 ---
  const dirs = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  for (const n of nodes) {
    const ix = Math.round(n.pos.x / SPACING),
      iz = Math.round(n.pos.z / SPACING);
    for (const [dx, dz] of dirs) {
      for (const m of grid.get(key(ix + dx, iz + dz)) ?? []) {
        const o = nodes[m];
        if (Math.abs(o.pos.y - n.pos.y) > 2) continue;
        if (!walkable(n.pos, o.pos)) continue;
        const d = Math.hypot(o.pos.x - n.pos.x, o.pos.y - n.pos.y, o.pos.z - n.pos.z);
        addLink(n.id, m, 'walk', d / cfg.SPRINT_SPEED);
        addLink(m, n.id, 'walk', d / cfg.SPRINT_SPEED);
      }
    }
  }

  // --- 3. 飛び降り・跳び移り・よじ登り（隣に歩いて行けない方向だけ調べる） ---
  const dirs8 = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  const hasWalkTo = (a: number, ix: number, iz: number) =>
    (grid.get(key(ix, iz)) ?? []).some((m) => linked.has(`${a}>${m}`) && Math.abs(nodes[m].pos.y - nodes[a].pos.y) < 1);
  for (const n of nodes) {
    const ix = Math.round(n.pos.x / SPACING),
      iz = Math.round(n.pos.z / SPACING);
    for (const [dx, dz] of dirs8) {
      if (hasWalkTo(n.id, ix + dx, iz + dz)) continue;
      // 縁の外へ向かって、1〜3マス先まで探す（飛び降りは一番近い所だけ。跳び移り・よじ登りが見つかったら終わり）
      let dropK = -1;
      for (let k = 1; k <= 3; k++) {
        const cand = grid.get(key(ix + dx * k, iz + dz * k)) ?? [];
        let found = false;
        for (const m of cand) {
          const o = nodes[m];
          const dy = o.pos.y - n.pos.y;
          const dist = Math.hypot(o.pos.x - n.pos.x, o.pos.z - n.pos.z);
          // どれかの移動になりそうなときだけ、上の通り道を調べる（重い）
          const maybeDrop = dy < -0.8 && dy > -12.5 && dist <= SPACING * 3 + 0.1;
          const maybeClimb = dy > cfg.MANTLE_MIN_HEIGHT && dy <= 2.8 && dist <= SPACING * 1.5;
          const maybeGap = Math.abs(dy) <= 0.8 && k >= 2 && dist <= 6.5;
          if (!maybeDrop && !maybeClimb && !maybeGap) continue;
          if (maybeDrop && dropK >= 0 && dropK !== k) continue;
          if (!pathClearAbove(n.pos, o.pos, Math.max(n.pos.y, o.pos.y), idx, clear)) continue;
          if (dy < -0.8 && dy > -12.5 && dist <= SPACING * 3 + 0.1) {
            if (dropK >= 0 && dropK !== k) continue;
            // 下りる先の真上に屋根や床がないこと
            const dn = idx.near(o.pos.x - 1, o.pos.z - 1, o.pos.x + 1, o.pos.z + 1);
            let open = true;
            for (let y = o.pos.y + 1; y < n.pos.y; y += 1) if (!clear(v3(o.pos.x, y, o.pos.z), dn)) open = false;
            if (!open) continue;
            // 飛び降り（片道）
            addLink(n.id, m, 'drop', dist / cfg.SPRINT_SPEED + Math.sqrt((2 * -dy) / cfg.GRAVITY));
            dropK = k;
          } else if (dy > cfg.MANTLE_MIN_HEIGHT && dy <= cfg.MANTLE_MAX_HEIGHT - 0.05 && dist <= SPACING * 1.5) {
            // よじ登り
            addLink(n.id, m, 'jump', dist / cfg.WALK_SPEED + cfg.MANTLE_TIME + 0.3);
            found = true;
          } else if (dy > cfg.MANTLE_MAX_HEIGHT - 0.05 && dy <= 2.8 && dist <= SPACING * 1.5) {
            // 2段ジャンプしてからよじ登る（コンテナの上など）
            addLink(n.id, m, 'jump', dist / cfg.WALK_SPEED + cfg.MANTLE_TIME + 0.8);
            found = true;
          } else if (Math.abs(dy) <= 0.8 && k >= 2 && dist <= 6.5) {
            // 隙間を跳び越える（上を通る道に、ぶつかるものがないことは確かめてある）
            addLink(n.id, m, 'jump', dist / cfg.SPRINT_SPEED + 0.4);
            found = true;
          }
        }
        if (found) break;
      }
    }
  }

  // --- 4. ステージに書いてある特別な移動（壁走りなど） ---
  const nearest = (p: Vec3, maxD = 3.5) => {
    let best = -1,
      bd = maxD;
    for (const n of nodes) {
      const d = Math.hypot(n.pos.x - p.x, (n.pos.y - p.y) * 2, n.pos.z - p.z);
      if (d < bd) {
        bd = d;
        best = n.id;
      }
    }
    return best;
  };
  for (const l of level.navLinks ?? []) {
    const a = nearest(l.from),
      b = nearest(l.to);
    if (a < 0 || b < 0) continue;
    const d = Math.hypot(l.to.x - l.from.x, l.to.z - l.from.z);
    const speed = l.kind === 'wallrun' ? cfg.WALLRUN_SPEED : cfg.SPRINT_SPEED;
    // 壁走り・跳び移りは近道なので、少し安く見積もる（ボットが使いやすいように）
    const cost = (d / speed) * 0.8 + 0.25;
    addLink(a, b, l.kind, cost, l.via, l.from, l.to);
    if (l.both) addLink(b, a, l.kind, cost, l.via, l.to, l.from);
  }

  return { nodes, links, out, spacing: SPACING };
}

/** 2点の間を、高い方の高さで水平に動いたときにぶつかるものがないか */
function pathClearAbove(pa: Vec3, pb: Vec3, y: number, idx: BoxIndex, clear: (p: Vec3, near: Box[]) => boolean): boolean {
  const near = idx.near(pa.x - 1, pa.z - 1, pb.x + 1, pb.z + 1);
  // 細い胸壁・手すり（厚さ 0.5m）を飛び越えないよう、0.35m ごとに調べる
  const n = Math.max(5, Math.ceil(Math.hypot(pb.x - pa.x, pb.z - pa.z) / 0.35));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const p = v3(pa.x + (pb.x - pa.x) * t, y + 0.05, pa.z + (pb.z - pa.z) * t);
    if (!clear(p, near)) return false;
  }
  return true;
}

/** 点を 8m のマスに分けた索引（近い点をすばやく探す） */
const nodeIndex = new WeakMap<NavGraph, Map<string, number[]>>();
function cellsOf(g: NavGraph): Map<string, number[]> {
  let m = nodeIndex.get(g);
  if (!m) {
    m = new Map();
    for (const n of g.nodes) {
      const k = `${Math.floor(n.pos.x / 8)},${Math.floor(n.pos.z / 8)}`;
      let l = m.get(k);
      if (!l) m.set(k, (l = []));
      l.push(n.id);
    }
    nodeIndex.set(g, m);
  }
  return m;
}

/** いちばん近い点 */
export function nearestNode(g: NavGraph, p: Vec3, maxDist = 6): number {
  let best = -1,
    bd = maxDist;
  if (maxDist <= 8) {
    const cells = cellsOf(g);
    const cx = Math.floor(p.x / 8),
      cz = Math.floor(p.z / 8);
    for (let x = cx - 1; x <= cx + 1; x++)
      for (let z = cz - 1; z <= cz + 1; z++)
        for (const id of cells.get(`${x},${z}`) ?? []) {
          const n = g.nodes[id];
          const d = Math.hypot(n.pos.x - p.x, (n.pos.y - p.y) * 1.5, n.pos.z - p.z);
          if (d < bd) {
            bd = d;
            best = id;
          }
        }
    return best;
  }
  for (const n of g.nodes) {
    const d = Math.hypot(n.pos.x - p.x, (n.pos.y - p.y) * 1.5, n.pos.z - p.z);
    if (d < bd) {
      bd = d;
      best = n.id;
    }
  }
  return best;
}

/** 経路探しの作業用の配列（グラフごとに使い回す） */
interface Scratch {
  g: Float64Array;
  came: Int32Array;
  stamp: Uint32Array;
  closed: Uint32Array;
  gen: number;
  heapF: Float64Array;
  heapI: Int32Array;
}
const scratchOf = new WeakMap<NavGraph, Scratch>();

/** A* で a から b への経路（点の番号の列）。行けなければ null。allow でつながりを絞れる。maxExpand は調べる点の上限 */
export function findPath(g: NavGraph, a: number, b: number, allow?: (l: NavLink) => boolean, maxExpand = 20000): number[] | null {
  const N = g.nodes.length;
  let sc = scratchOf.get(g);
  if (!sc) {
    sc = {
      g: new Float64Array(N),
      came: new Int32Array(N),
      stamp: new Uint32Array(N),
      closed: new Uint32Array(N),
      gen: 0,
      heapF: new Float64Array(g.links.length + N + 16),
      heapI: new Int32Array(g.links.length + N + 16),
    };
    scratchOf.set(g, sc);
  }
  const gen = ++sc.gen;
  const { g: gs, came, stamp, closed, heapF, heapI } = sc;
  const goal = g.nodes[b].pos;
  const gx = goal.x,
    gy = goal.y,
    gz = goal.z;
  // 残りの距離を、壁走りの速さ（いちばん速い移動）で割った時間（実際より短めに見積もる）
  const hcost = (i: number) => {
    const p = g.nodes[i].pos;
    const dx = p.x - gx,
      dy = p.y - gy,
      dz = p.z - gz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) / 9.5;
  };
  let hn = 0;
  const push = (f: number, i: number) => {
    let c = hn++;
    heapF[c] = f;
    heapI[c] = i;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heapF[p] <= heapF[c]) break;
      const tf = heapF[p],
        ti = heapI[p];
      heapF[p] = heapF[c];
      heapI[p] = heapI[c];
      heapF[c] = tf;
      heapI[c] = ti;
      c = p;
    }
  };
  const pop = (): number => {
    const top = heapI[0];
    hn--;
    if (hn > 0) {
      heapF[0] = heapF[hn];
      heapI[0] = heapI[hn];
      let c = 0;
      for (;;) {
        const l = c * 2 + 1,
          r = l + 1;
        let m = c;
        if (l < hn && heapF[l] < heapF[m]) m = l;
        if (r < hn && heapF[r] < heapF[m]) m = r;
        if (m === c) break;
        const tf = heapF[m],
          ti = heapI[m];
        heapF[m] = heapF[c];
        heapI[m] = heapI[c];
        heapF[c] = tf;
        heapI[c] = ti;
        c = m;
      }
    }
    return top;
  };
  stamp[a] = gen;
  gs[a] = 0;
  came[a] = -1;
  push(hcost(a), a);
  let expanded = 0;
  while (hn > 0) {
    const cur = pop();
    if (cur === b) {
      const path = [cur];
      let c = cur;
      while (came[c] >= 0) {
        c = came[c];
        path.push(c);
      }
      return path.reverse();
    }
    if (closed[cur] === gen) continue;
    closed[cur] = gen;
    if (++expanded > maxExpand) return null;
    const gc = gs[cur];
    for (const li of g.out[cur]) {
      const l = g.links[li];
      if (allow && !allow(l)) continue;
      const ng = gc + l.cost;
      const nb = l.b;
      if (stamp[nb] !== gen || ng < gs[nb]) {
        stamp[nb] = gen;
        gs[nb] = ng;
        came[nb] = cur;
        if (hn >= heapF.length) return null;
        push(ng + hcost(nb), nb);
      }
    }
  }
  return null;
}

/** a から行ける点の集まり */
export function reachable(g: NavGraph, a: number): Set<number> {
  const seen = new Set([a]);
  const stack = [a];
  while (stack.length) {
    const c = stack.pop()!;
    for (const li of g.out[c]) {
      const n = g.links[li].b;
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return seen;
}
