/**
 * 参加者（パイロット・歩兵）の当たり判定。
 * 体は縦長のカプセル、頭は球。しゃがむと背が低くなり、頭の位置も下がる。
 *
 * タワーディフェンスの敵・タレット・コアは、形を「部品」の集まりで決める（BodyDef）：
 *  - 箱・球・縦のカプセルを、足元からの位置で並べる（向き yaw で回す）
 *  - crit：弱点（当たると頭と同じ扱い。重装兵の背中・ボスの炉心）
 *  - block：盾（弾を止める。ダメージは入らない。重装兵の前面の盾）
 */
import { type Vec3, add, normalize, scale, sub, v3 } from './math';

/** 形の部品。位置 c は足元からの位置（向き 0 のとき。-Z が正面） */
export interface HitPart {
  kind: 'box' | 'sphere' | 'capsule';
  c: Vec3;
  /** 箱の半分の大きさ */
  half?: Vec3;
  /** 球・カプセルの半径 */
  r?: number;
  /** カプセルの上下の長さ（中心の線分の半分。縦向き） */
  hh?: number;
  /** 弱点（頭と同じ扱い） */
  crit?: boolean;
  /** 盾（弾を止める） */
  block?: boolean;
}

export interface BodyDef {
  parts: HitPart[];
  /** 狙う点（足元から。向き 0 のとき） */
  aim: Vec3;
  /** 弱点の位置（狙う「頭」。なければ aim） */
  critAim?: Vec3;
  /** 全体を囲む球の半径（大まかな判定） */
  radius: number;
  /** 囲む球の中心の高さ */
  centerY: number;
}

/** 撃たれる側の情報（ゲームロジックの Entity から作る） */
export interface Actor {
  id: number;
  team: number;
  /** 足元 */
  pos: Vec3;
  /** いまの身長 */
  height: number;
  /** 部品で決めた形（なければ人の形） */
  body?: BodyDef;
  /** 形の向き（body があるとき） */
  yaw?: number;
}

export const BODY_RADIUS = 0.38;
export const HEAD_RADIUS = 0.24;

/** 向き yaw で回した、足元からの位置 */
function rotY(p: Vec3, yaw: number): Vec3 {
  // yaw 0 で -Z が正面。x' = x cos + z sin, z' = -x sin + z cos
  const c = Math.cos(yaw),
    s = Math.sin(yaw);
  return v3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
}
/** 世界の向きを、形の向きの座標へ戻す */
function unrotY(p: Vec3, yaw: number): Vec3 {
  return rotY(p, -yaw);
}

/** 部品の位置を世界の位置にする */
export function partWorld(a: Actor, local: Vec3): Vec3 {
  return add(a.pos, rotY(local, a.yaw ?? 0));
}

/** 頭の中心（身長の上端から少し下）。形のある相手は弱点 */
export const headCenter = (a: Actor): Vec3 =>
  a.body ? partWorld(a, a.body.critAim ?? a.body.aim) : v3(a.pos.x, a.pos.y + a.height - HEAD_RADIUS - 0.02, a.pos.z);
/** 胸のあたり（狙う点・グレネードの距離の基準） */
export const chestOf = (a: Actor): Vec3 => (a.body ? partWorld(a, a.body.aim) : v3(a.pos.x, a.pos.y + a.height * 0.62, a.pos.z));

export interface ActorHit {
  t: number;
  point: Vec3;
  normal: Vec3;
  head: boolean;
  /** 盾に当たった（ダメージなし） */
  blocked?: boolean;
}

/** 光線と球。当たった距離（なければ null） */
function raySphere(o: Vec3, d: Vec3, maxT: number, c: Vec3, r: number): number | null {
  const ox = o.x - c.x,
    oy = o.y - c.y,
    oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  let t = -b - s;
  if (t < 0) t = -b + s;
  if (t < 0 || t > maxT) return null;
  return t;
}

/** 光線と、軸に沿った箱（中心 c・半分の大きさ h）。当たった距離と面の向き */
function rayAabb(o: Vec3, d: Vec3, maxT: number, c: Vec3, h: Vec3): { t: number; n: Vec3 } | null {
  let tMin = 0,
    tMax = maxT;
  let n = v3();
  const axes: Array<'x' | 'y' | 'z'> = ['x', 'y', 'z'];
  for (const ax of axes) {
    const lo = c[ax] - h[ax],
      hi = c[ax] + h[ax];
    if (Math.abs(d[ax]) < 1e-9) {
      if (o[ax] < lo || o[ax] > hi) return null;
      continue;
    }
    let t1 = (lo - o[ax]) / d[ax],
      t2 = (hi - o[ax]) / d[ax];
    let sign = -1;
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      sign = 1;
    }
    if (t1 > tMin) {
      tMin = t1;
      n = v3(ax === 'x' ? sign : 0, ax === 'y' ? sign : 0, ax === 'z' ? sign : 0);
    }
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  return { t: tMin, n };
}

/** 光線と、縦向きのカプセル（中心の線分 y0〜y1、半径 r）。当たった距離 */
export function rayVsVerticalCapsule(o: Vec3, d: Vec3, maxT: number, cx: number, cz: number, y0: number, y1: number, r: number): number | null {
  let best: number | null = null;
  // 筒の部分（水平面で円と交わる）
  const a = d.x * d.x + d.z * d.z;
  const ox = o.x - cx,
    oz = o.z - cz;
  if (a > 1e-9) {
    const b = ox * d.x + oz * d.z;
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      for (const t of [(-b - s) / a, (-b + s) / a]) {
        if (t < 0 || t > maxT) continue;
        const y = o.y + d.y * t;
        if (y >= y0 && y <= y1) {
          best = t;
          break;
        }
      }
    }
  }
  // 上下の丸い部分
  for (const y of [y0, y1]) {
    const t = raySphere(o, d, best ?? maxT, v3(cx, y, cz), r);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}

/** 光線と、部品で決めた形 */
function rayVsBody(o: Vec3, d: Vec3, maxT: number, a: Actor, body: BodyDef): ActorHit | null {
  const yaw = a.yaw ?? 0;
  // 形の座標に直す（足元が原点、向き 0）
  const lo = unrotY(sub(o, a.pos), yaw);
  const ld = unrotY(d, yaw);
  if (raySphere(lo, ld, maxT, v3(0, body.centerY, 0), body.radius) === null) return null;
  let best: { t: number; n: Vec3; part: HitPart } | null = null;
  for (const p of body.parts) {
    const lim = best ? best.t : maxT;
    if (p.kind === 'box') {
      const h = rayAabb(lo, ld, lim, p.c, p.half!);
      if (h && (!best || h.t < best.t)) best = { t: h.t, n: h.n, part: p };
    } else if (p.kind === 'sphere') {
      const t = raySphere(lo, ld, lim, p.c, p.r!);
      if (t !== null && (!best || t < best.t)) best = { t, n: normalize(sub(add(lo, scale(ld, t)), p.c)), part: p };
    } else {
      const hh = p.hh ?? 0;
      const t = rayVsVerticalCapsule(lo, ld, lim, p.c.x, p.c.z, p.c.y - hh, p.c.y + hh, p.r!);
      if (t !== null && (!best || t < best.t)) {
        const q = add(lo, scale(ld, t));
        best = { t, n: normalize(v3(q.x - p.c.x, 0, q.z - p.c.z)), part: p };
      }
    }
  }
  if (!best) return null;
  const point = add(o, scale(d, best.t));
  return { t: best.t, point, normal: rotY(best.n, yaw), head: !!best.part.crit, blocked: !!best.part.block };
}

/** 光線と参加者。頭に当たったかも返す */
export function rayVsActor(o: Vec3, d: Vec3, maxT: number, a: Actor): ActorHit | null {
  if (a.body) return rayVsBody(o, d, maxT, a, a.body);
  // 遠い相手は先に大まかに外す（足元から頭までを囲む球）
  const mid = v3(a.pos.x, a.pos.y + a.height / 2, a.pos.z);
  if (raySphere(o, d, maxT, mid, a.height / 2 + 0.3) === null) return null;
  const hc = headCenter(a);
  const th = raySphere(o, d, maxT, hc, HEAD_RADIUS);
  const y0 = a.pos.y + BODY_RADIUS;
  const y1 = Math.max(y0, a.pos.y + a.height - HEAD_RADIUS * 2 - 0.05);
  const tb = rayVsVerticalCapsule(o, d, maxT, a.pos.x, a.pos.z, y0, y1, BODY_RADIUS);
  if (th === null && tb === null) return null;
  const head = th !== null && (tb === null || th <= tb + 0.02);
  const t = head ? th! : tb!;
  const point = add(o, scale(d, t));
  const normal = head ? normalize(sub(point, hc)) : normalize(v3(point.x - a.pos.x, 0, point.z - a.pos.z));
  return { t, point, normal, head };
}
