/**
 * 当たり判定：プレイヤーは縦長のカプセル、地形は回転できる箱（OBB）の集まり。
 * - カプセル vs 箱の重なり判定と押し出し
 * - 光線（レイ） vs 箱の交差判定（よじ登りや足元の確認に使う）
 */
import {
  type Mat3,
  type Vec3,
  add,
  clamp,
  dot,
  len,
  mat3FromEulerYXZ,
  mat3MulVec,
  mat3TMulVec,
  scale,
  sub,
  v3,
} from './math';

export interface Box {
  id: number;
  center: Vec3;
  half: Vec3;
  rot: Mat3;
  /** ワールド座標での外接 AABB（大まかな絞り込み用） */
  min: Vec3;
  max: Vec3;
  /** 壁走りできない面（低い障害物など） */
  noWallrun: boolean;
  /** 取り除いた箱（当たらない） */
  disabled?: boolean;
  /** 光線は通す（体と押し合うだけの箱。大型兵器・タレットの箱。弾は当たり判定の形に当てる） */
  passRays?: boolean;
}

export interface Contact {
  /** 押し出し方向（地形からプレイヤーへ向く単位ベクトル） */
  normal: Vec3;
  depth: number;
  boxId: number;
  /** 箱の表面上の、カプセルに一番近い点 */
  point: Vec3;
  /** カプセルの芯（線分）上の、箱に一番近い点 */
  segPoint: Vec3;
  /** 箱の面ではなく、辺や角に当たっている */
  onEdge: boolean;
}

export interface RayHit {
  t: number;
  point: Vec3;
  normal: Vec3;
  boxId: number;
}

export function makeBox(
  id: number,
  center: Vec3,
  size: Vec3,
  rotDeg: Vec3 = v3(),
  noWallrun = false,
): Box {
  const half = scale(size, 0.5);
  const rot = mat3FromEulerYXZ(rotDeg.x, rotDeg.y, rotDeg.z);
  // 外接 AABB = |R| * half
  const ex = Math.abs(rot[0]) * half.x + Math.abs(rot[1]) * half.y + Math.abs(rot[2]) * half.z;
  const ey = Math.abs(rot[3]) * half.x + Math.abs(rot[4]) * half.y + Math.abs(rot[5]) * half.z;
  const ez = Math.abs(rot[6]) * half.x + Math.abs(rot[7]) * half.y + Math.abs(rot[8]) * half.z;
  return {
    id,
    center,
    half,
    rot,
    min: v3(center.x - ex, center.y - ey, center.z - ez),
    max: v3(center.x + ex, center.y + ey, center.z + ez),
    noWallrun,
  };
}

/** 線分 a-b 上で点 q に最も近い点 */
function closestOnSegment(a: Vec3, b: Vec3, q: Vec3): Vec3 {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < 1e-12) return a;
  const t = clamp(dot(sub(q, a), ab) / l2, 0, 1);
  return v3(a.x + ab.x * t, a.y + ab.y * t, a.z + ab.z * t);
}

const clampToBox = (p: Vec3, h: Vec3): Vec3 =>
  v3(clamp(p.x, -h.x, h.x), clamp(p.y, -h.y, h.y), clamp(p.z, -h.z, h.z));

/**
 * カプセル（線分 a-b ＋ 半径 r）と箱の重なりを調べる。
 * 重なっていれば押し出し方向と深さを返す。
 */
export function capsuleVsBox(a: Vec3, b: Vec3, r: number, box: Box): Contact | null {
  // 大まかな絞り込み
  const minX = Math.min(a.x, b.x) - r,
    maxX = Math.max(a.x, b.x) + r;
  const minY = Math.min(a.y, b.y) - r,
    maxY = Math.max(a.y, b.y) + r;
  const minZ = Math.min(a.z, b.z) - r,
    maxZ = Math.max(a.z, b.z) + r;
  if (maxX < box.min.x || minX > box.max.x || maxY < box.min.y || minY > box.max.y || maxZ < box.min.z || minZ > box.max.z)
    return null;

  // 箱のローカル座標で計算する
  const la = mat3TMulVec(box.rot, sub(a, box.center));
  const lb = mat3TMulVec(box.rot, sub(b, box.center));
  const h = box.half;

  // 線分と箱（どちらも凸）の最近点を交互射影で求める
  let p = v3((la.x + lb.x) / 2, (la.y + lb.y) / 2, (la.z + lb.z) / 2);
  let q = clampToBox(p, h);
  for (let i = 0; i < 8; i++) {
    p = closestOnSegment(la, lb, q);
    const nq = clampToBox(p, h);
    if (Math.abs(nq.x - q.x) + Math.abs(nq.y - q.y) + Math.abs(nq.z - q.z) < 1e-7) {
      q = nq;
      break;
    }
    q = nq;
  }
  const d = sub(p, q);
  const dist = len(d);
  if (dist > r) return null;

  let localN: Vec3;
  let depth: number;
  if (dist > 1e-6) {
    localN = scale(d, 1 / dist);
    depth = r - dist;
  } else {
    // 線分の芯が箱の中に入っている：一番浅い面から押し出す
    const pens = [
      { n: v3(1, 0, 0), d: h.x - p.x },
      { n: v3(-1, 0, 0), d: h.x + p.x },
      { n: v3(0, 1, 0), d: h.y - p.y },
      { n: v3(0, -1, 0), d: h.y + p.y },
      { n: v3(0, 0, 1), d: h.z - p.z },
      { n: v3(0, 0, -1), d: h.z + p.z },
    ];
    let best = pens[0];
    for (const c of pens) if (c.d < best.d) best = c;
    localN = best.n;
    depth = best.d + r;
  }
  const eps = 1e-5;
  const clampedAxes =
    (Math.abs(q.x) >= h.x - eps ? 1 : 0) + (Math.abs(q.y) >= h.y - eps ? 1 : 0) + (Math.abs(q.z) >= h.z - eps ? 1 : 0);
  return {
    onEdge: dist > 1e-6 && clampedAxes >= 2,
    normal: mat3MulVec(box.rot, localN),
    depth,
    boxId: box.id,
    point: add(mat3MulVec(box.rot, q), box.center),
    segPoint: add(mat3MulVec(box.rot, p), box.center),
  };
}

/** 光線と箱の交差（スラブ法）。maxT 以内で最初に当たった面を返す */
export function rayVsBox(origin: Vec3, dir: Vec3, maxT: number, box: Box): RayHit | null {
  const o = mat3TMulVec(box.rot, sub(origin, box.center));
  const d = mat3TMulVec(box.rot, dir);
  const h = box.half;
  let tMin = 0,
    tMax = maxT;
  let nLocal = v3();
  const axes: Array<'x' | 'y' | 'z'> = ['x', 'y', 'z'];
  for (const ax of axes) {
    if (Math.abs(d[ax]) < 1e-9) {
      if (o[ax] < -h[ax] || o[ax] > h[ax]) return null;
      continue;
    }
    let t1 = (-h[ax] - o[ax]) / d[ax];
    let t2 = (h[ax] - o[ax]) / d[ax];
    let sign = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      sign = 1;
    }
    if (t1 > tMin) {
      tMin = t1;
      nLocal = v3();
      nLocal[ax] = sign;
    }
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  if (tMin <= 0) return null; // 始点が箱の中
  const normal = mat3MulVec(box.rot, nLocal);
  return { t: tMin, point: add(origin, scale(dir, tMin)), normal, boxId: box.id };
}

/** 地形（箱の集まり） */
/**
 * 地形の箱の集まり。
 * 水平方向（x・z）に 8m の格子を作り、各マスに重なる箱の番号を入れておく（調べる箱を絞り込んで速くする）。
 * 結果は、すべての箱を順に調べたときと同じになるようにしている（箱の番号の順に調べる・同じ距離なら番号の小さい方）。
 */
const CELL = 8;
const cellKey = (ix: number, iz: number) => (ix + 4096) * 8192 + (iz + 4096);

export class CollisionWorld {
  readonly boxes: Box[] = [];
  private grid = new Map<number, number[]>();
  private dirty = true;
  /** 同じ箱を2回調べないための印 */
  private stamp = new Int32Array(0);
  private stampId = 0;
  private scratch: number[] = [];

  add(box: Box): void {
    this.boxes.push(box);
    this.dirty = true;
  }

  /** 箱を置き換える（動く箱。番号は同じ） */
  replace(id: number, box: Box): void {
    this.boxes[id] = box;
    this.dirty = true;
  }

  /** 箱を当たらないようにする（タワーディフェンスで壊れたタレット）。番号はそのまま残す */
  disable(id: number): void {
    const b = this.boxes[id];
    if (!b || b.disabled) return;
    b.disabled = true;
    this.dirty = true;
  }

  private build(): void {
    this.grid.clear();
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      if (b.disabled) continue;
      const ix0 = Math.floor(b.min.x / CELL),
        ix1 = Math.floor(b.max.x / CELL);
      const iz0 = Math.floor(b.min.z / CELL),
        iz1 = Math.floor(b.max.z / CELL);
      for (let ix = ix0; ix <= ix1; ix++)
        for (let iz = iz0; iz <= iz1; iz++) {
          const k = cellKey(ix, iz);
          let list = this.grid.get(k);
          if (!list) this.grid.set(k, (list = []));
          list.push(i);
        }
    }
    this.stamp = new Int32Array(this.boxes.length);
    this.stampId = 0;
    this.dirty = false;
  }

  private nextStamp(): number {
    if (++this.stampId > 2_000_000_000) {
      this.stamp.fill(0);
      this.stampId = 1;
    }
    return this.stampId;
  }

  /** 水平の範囲に重なる箱の番号（小さい順） */
  private candidates(minX: number, minZ: number, maxX: number, maxZ: number): number[] {
    if (this.dirty) this.build();
    const out = this.scratch;
    out.length = 0;
    const st = this.nextStamp();
    const ix0 = Math.floor(minX / CELL),
      ix1 = Math.floor(maxX / CELL);
    const iz0 = Math.floor(minZ / CELL),
      iz1 = Math.floor(maxZ / CELL);
    for (let ix = ix0; ix <= ix1; ix++)
      for (let iz = iz0; iz <= iz1; iz++) {
        const list = this.grid.get(cellKey(ix, iz));
        if (!list) continue;
        for (const i of list) {
          if (this.stamp[i] === st) continue;
          this.stamp[i] = st;
          out.push(i);
        }
      }
    if (out.length > 1) out.sort((p, q) => p - q);
    return out;
  }

  /** カプセルと重なっている箱をすべて返す（押し出しはしない） */
  overlaps(a: Vec3, b: Vec3, r: number): Contact[] {
    const out: Contact[] = [];
    const ids = this.candidates(Math.min(a.x, b.x) - r, Math.min(a.z, b.z) - r, Math.max(a.x, b.x) + r, Math.max(a.z, b.z) + r);
    for (const i of ids) {
      const c = capsuleVsBox(a, b, r, this.boxes[i]);
      if (c) out.push(c);
    }
    return out;
  }

  /** 重なりがあるかだけを調べる（立ち上がれるか、よじ登れるかの確認用） */
  blocked(a: Vec3, b: Vec3, r: number, skin = 0.005): boolean {
    const ids = this.candidates(Math.min(a.x, b.x) - r, Math.min(a.z, b.z) - r, Math.max(a.x, b.x) + r, Math.max(a.z, b.z) + r);
    for (const i of ids) {
      const c = capsuleVsBox(a, b, r, this.boxes[i]);
      if (c && c.depth > skin) return true;
    }
    return false;
  }

  /** 光線と箱の交差。格子のマスを光線に沿ってたどり、近い順に調べる */
  raycast(origin: Vec3, dir: Vec3, maxT: number): RayHit | null {
    if (this.dirty) this.build();
    let best: RayHit | null = null;
    const st = this.nextStamp();
    let ix = Math.floor(origin.x / CELL),
      iz = Math.floor(origin.z / CELL);
    const stepX = dir.x > 0 ? 1 : -1,
      stepZ = dir.z > 0 ? 1 : -1;
    const big = Number.POSITIVE_INFINITY;
    const tDeltaX = Math.abs(dir.x) > 1e-12 ? CELL / Math.abs(dir.x) : big;
    const tDeltaZ = Math.abs(dir.z) > 1e-12 ? CELL / Math.abs(dir.z) : big;
    let tMaxX = Math.abs(dir.x) > 1e-12 ? ((dir.x > 0 ? (ix + 1) * CELL : ix * CELL) - origin.x) / dir.x : big;
    let tMaxZ = Math.abs(dir.z) > 1e-12 ? ((dir.z > 0 ? (iz + 1) * CELL : iz * CELL) - origin.z) / dir.z : big;
    let tEnter = 0;
    for (let guard = 0; guard < 4096; guard++) {
      const list = this.grid.get(cellKey(ix, iz));
      if (list) {
        for (const i of list) {
          if (this.stamp[i] === st) continue;
          this.stamp[i] = st;
          const box = this.boxes[i];
          if (box.passRays) continue;
          const h = rayVsBox(origin, dir, best ? best.t : maxT, box);
          if (h && (!best || h.t < best.t || (h.t === best.t && h.boxId < best.boxId))) best = h;
        }
      }
      // 次のマスへ
      const tNext = Math.min(tMaxX, tMaxZ);
      tEnter = tNext;
      if (tEnter > maxT || (best && best.t <= tEnter)) break;
      if (tMaxX < tMaxZ) {
        ix += stepX;
        tMaxX += tDeltaX;
      } else {
        iz += stepZ;
        tMaxZ += tDeltaZ;
      }
    }
    return best;
  }

  getBox(id: number): Box | undefined {
    return this.boxes[id];
  }
}
