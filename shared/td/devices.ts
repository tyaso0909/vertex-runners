/**
 * タワーディフェンスの設置物（ダミーバルーン・ワイヤートラップ・バリケード・ジャンプパッド）の形と、置き場所の計算。
 * 描画にもサーバーにも依らない（オンラインではサーバーが同じ計算で確かめる）。
 *
 * 向き yaw は視線と同じ決め方（-Z が正面）。バリケードとワイヤートラップは、向きに直角な横の線に広がる
 * （プレイヤーが敵の来る方を見て置くと、道をふさぐ・横切る向きになる）。
 */
import type { TdDeviceType, TdPlaceable } from '../../config';
import type { CollisionWorld } from '../collision';
import { type Vec3, v3 } from '../math';

/** 正面（-Z が yaw 0） */
export const forwardOf = (yaw: number): Vec3 => v3(-Math.sin(yaw), 0, -Math.cos(yaw));
/** 右（正面を見たときの右手） */
export const rightOf = (yaw: number): Vec3 => v3(Math.cos(yaw), 0, -Math.sin(yaw));

/** 水平面での、点 p と線分 ab の距離 */
export function segDist2D(p: Vec3, a: Vec3, b: Vec3): number {
  const abx = b.x - a.x,
    abz = b.z - a.z;
  const L2 = abx * abx + abz * abz;
  let t = L2 > 1e-9 ? ((p.x - a.x) * abx + (p.z - a.z) * abz) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + abx * t), p.z - (a.z + abz * t));
}

/** 線分 ab の上で、点 p にいちばん近い点の割合（0〜1。水平面） */
export function segParam2D(p: Vec3, a: Vec3, b: Vec3): number {
  const abx = b.x - a.x,
    abz = b.z - a.z;
  const L2 = abx * abx + abz * abz;
  const t = L2 > 1e-9 ? ((p.x - a.x) * abx + (p.z - a.z) * abz) / L2 : 0;
  return Math.max(0, Math.min(1, t));
}

/** 水平面での、線分 ab と線分 cd の距離 */
export function segSegDist2D(a: Vec3, b: Vec3, c: Vec3, d: Vec3): number {
  const cross = (o: Vec3, p: Vec3, q: Vec3) => (p.x - o.x) * (q.z - o.z) - (p.z - o.z) * (q.x - o.x);
  const d1 = cross(a, b, c),
    d2 = cross(a, b, d),
    d3 = cross(c, d, a),
    d4 = cross(c, d, b);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(segDist2D(a, c, d), segDist2D(b, c, d), segDist2D(c, a, b), segDist2D(d, a, b));
}

/** 地面の上での広がり（ほかの物と重ならないかを調べる形）。点（a = b）か線分に、太さ r を付けたもの */
export interface Footprint {
  a: Vec3;
  b: Vec3;
  r: number;
}

/** 種類ごとの太さ（タレット・設置物どうしの間をこれだけ空ける） */
const FOOT_R: Record<TdPlaceable, number> = { mg: 1.2, rocket: 1.2, slow: 1.2, repair: 1.2, decoy: 0.7, wiretrap: 0.45, barricade: 0.55, jumppad: 1.15 };

export function footprintOf(kind: TdPlaceable, pos: Vec3, _yaw: number, ends?: [Vec3, Vec3]): Footprint {
  const r = FOOT_R[kind];
  if (ends) return { a: ends[0], b: ends[1], r };
  return { a: pos, b: pos, r };
}

export const footprintsOverlap = (f: Footprint, g: Footprint, extra = 0): boolean => segSegDist2D(f.a, f.b, g.a, g.b) < f.r + g.r + extra;

/** バリケードの両端（地面の高さ。中心から横へ width/2 ずつ） */
export function barricadeEnds(pos: Vec3, yaw: number, width: number): [Vec3, Vec3] {
  const r = rightOf(yaw);
  const h = width / 2;
  return [v3(pos.x - r.x * h, pos.y, pos.z - r.z * h), v3(pos.x + r.x * h, pos.y, pos.z + r.z * h)];
}

/**
 * ワイヤートラップの3つの機雷の位置（左・中央・右。それぞれの地面の上）。
 * 中央から左右へ span まで広がる。壁があればその手前で止まり、足場が切れていれば手前へ寄る。
 * どちらかが minSpan より短くなるなら null（狭すぎて置けない）
 */
export function trapNodes(world: CollisionWorld, pos: Vec3, yaw: number, span: number, beamH: number, minSpan = 1.2): Vec3[] | null {
  const r = rightOf(yaw);
  const out: Vec3[] = [];
  for (const s of [-1, 1]) {
    const dir = v3(r.x * s, 0, r.z * s);
    const from = v3(pos.x, pos.y + beamH, pos.z);
    const hit = world.raycast(from, dir, span + 0.4);
    let d = hit ? Math.min(span, hit.t - 0.4) : span;
    let node: Vec3 | null = null;
    while (d >= minSpan) {
      const q = v3(pos.x + dir.x * d, pos.y + 1.2, pos.z + dir.z * d);
      const g = world.raycast(q, v3(0, -1, 0), 2.6);
      if (g && g.normal.y > 0.85 && Math.abs(g.point.y - pos.y) < 0.7) {
        node = v3(q.x, g.point.y, q.z);
        break;
      }
      d -= 0.35;
    }
    if (!node) return null;
    out.push(node);
  }
  return [out[0], { ...pos }, out[1]];
}

/** 置く物の高さ（人がいる・狭すぎるの確かめに使う） */
export const DEVICE_HEIGHT: Record<TdDeviceType, number> = { decoy: 1.85, wiretrap: 0.9, barricade: 1.25, jumppad: 0.25 };

/** ダミーバルーンの身長（当たり判定。パイロットと同じくらい） */
export const DECOY_HEIGHT = 1.8;
