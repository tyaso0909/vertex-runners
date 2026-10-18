/**
 * ミニマップ（消耗戦・タワーディフェンス共通。仕様 7.3）。
 * - 画面の左上の円。自分を真ん中に、向いている方向が上になるように回る。M で広い範囲に切り替える
 * - 地形：ステージの箱を上から見て描いた絵（高い所ほど明るい）を、はじめに1回だけ作っておく
 * - 範囲の中の味方の位置（パイロットは向きの分かる矢印、歩兵は小さな点）。ダウンした味方は赤い印
 * - 銃を撃った敵は、撃った場所に赤い点が少しの間（2.5 秒）出て、だんだん消える（ソナーで見えている敵は、見えている間ずっと）
 * - ソラのパッシブで映っている敵：赤い点を、ソラの色（黄色）の照準の輪で囲む。動きに合わせて動き、切れる前の 1 秒で薄くなる
 * - タワーディフェンス：コア（範囲の外なら縁に）、タレット、大型兵器、次の・いまのウェーブの侵入ルート（赤い線と、縁の矢印）
 */
import type { BoxDef, LevelData } from '../../shared/level';
import { type Vec3, mat3FromEulerYXZ, mat3MulVec, v3 } from '../../shared/math';

export type MarkerKind = 'ally' | 'allyGrunt' | 'allyDowned' | 'enemy' | 'enemyMarked' | 'core' | 'turret' | 'turretMine' | 'boss' | 'device' | 'deviceMine' | 'pod' | 'dropZone' | 'mortar';

export interface MinimapMarker {
  x: number;
  z: number;
  kind: MarkerKind;
  /** 向き（矢印の向き。ゲームの yaw） */
  yaw?: number;
  /** 濃さ（0〜1。撃った敵の印が消えていく） */
  alpha?: number;
  /** 範囲の外でも縁に出す */
  pin?: boolean;
  /** 半径（m。降下予定地点の輪） */
  r?: number;
  /** 進み（0〜1。降下ポッドが着地するまで） */
  t?: number;
  /** 色（降下ポッド・降下予定地点の種類） */
  color?: string;
}

export interface MinimapRoute {
  points: Vec3[];
  /** 濃さ（0〜1） */
  alpha: number;
}

/** ソラのパッシブで映っている敵の輪の色（ソラの色） */
const MARK_COLOR = '#ffd21f';

/** 撃った敵の印が出ている時間 */
export const SHOT_MARK_TIME = 2.5;

const PX_PER_M = 4;

export class Minimap {
  readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly base: HTMLCanvasElement;
  private readonly origin: { x: number; z: number };
  private size = 200;
  private radius = 60;
  private large = false;
  private dpr = 1;
  /** 撃った敵：最後に撃った場所と時刻 */
  private readonly shots = new Map<number, { x: number; z: number; t: number }>();
  /** 最後に描いた時刻（描くのは 1 秒に 20 回まで） */
  private lastDraw = -1;

  constructor(
    level: LevelData,
    parent: HTMLElement,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'minimap';
    this.canvas = document.createElement('canvas');
    this.root.appendChild(this.canvas);
    const key = document.createElement('small');
    key.className = 'mm-key';
    key.innerHTML = '<kbd>M</kbd> 広さ';
    this.root.appendChild(key);
    parent.appendChild(this.root);
    this.ctx = this.canvas.getContext('2d')!;
    const r = renderBase(level);
    this.base = r.canvas;
    this.origin = r.origin;
    this.applySize();
  }

  /** 広い範囲 ⇄ ふつう */
  toggleLarge(): void {
    this.large = !this.large;
    this.lastDraw = -1;
    this.applySize();
  }

  /** 大きくしたときに映す範囲（m） */
  largeRadius = 140;

  private applySize() {
    this.size = this.large ? 330 : 200;
    this.radius = this.large ? this.largeRadius : 60;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.size * this.dpr);
    this.canvas.height = Math.round(this.size * this.dpr);
    this.canvas.style.width = `${this.size}px`;
    this.canvas.style.height = `${this.size}px`;
    this.root.classList.toggle('large', this.large);
  }

  /** 描き直す時刻か（印を集める前に確かめて、むだな計算をしない） */
  due(time: number): boolean {
    return this.lastDraw < 0 || time < this.lastDraw || time - this.lastDraw >= 0.05;
  }

  /** 敵が撃った（その場所に少しの間、印を出す） */
  noteShot(id: number, pos: Vec3, time: number): void {
    this.shots.set(id, { x: pos.x, z: pos.z, t: time });
  }

  /** 撃った敵の印（消えたもの・いなくなった敵は片付ける） */
  shotMarkers(time: number, alive: (id: number) => boolean): MinimapMarker[] {
    const out: MinimapMarker[] = [];
    for (const [id, s] of this.shots) {
      const age = time - s.t;
      if (age > SHOT_MARK_TIME || !alive(id)) {
        if (age > SHOT_MARK_TIME) this.shots.delete(id);
        continue;
      }
      out.push({ x: s.x, z: s.z, kind: 'enemy', alpha: 1 - (age / SHOT_MARK_TIME) ** 1.5 });
    }
    return out;
  }

  /** 描く。center は自分の位置、yaw は自分の向き */
  draw(center: Vec3, yaw: number, markers: MinimapMarker[], routes: MinimapRoute[] = [], time = 0): void {
    if (this.lastDraw >= 0 && time >= this.lastDraw && time - this.lastDraw < 0.05) return;
    this.lastDraw = time;
    const ctx = this.ctx;
    const S = this.size;
    const R = S / 2;
    const k = (R - 4) / this.radius; // 1m あたりの画素
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, S, S);
    // 円の中だけに描く
    ctx.save();
    ctx.beginPath();
    ctx.arc(R, R, R - 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(10, 8, 22, 0.78)';
    ctx.fillRect(0, 0, S, S);
    // 地形（自分を真ん中に、向きに合わせて回す）
    ctx.save();
    ctx.translate(R, R);
    ctx.rotate(yaw);
    ctx.scale(k / PX_PER_M, k / PX_PER_M);
    ctx.globalAlpha = 0.95;
    ctx.drawImage(this.base, -(center.x - this.origin.x) * PX_PER_M, -(center.z - this.origin.z) * PX_PER_M);
    ctx.restore();
    // 侵入ルート
    for (const rt of routes) {
      if (rt.alpha <= 0.01 || rt.points.length < 2) continue;
      ctx.save();
      ctx.globalAlpha = rt.alpha;
      ctx.strokeStyle = '#ff5a3a';
      ctx.lineWidth = this.large ? 2 : 2.5;
      ctx.setLineDash([6, 5]);
      ctx.lineDashOffset = -time * 14;
      ctx.beginPath();
      rt.points.forEach((p, i) => {
        const s = this.toScreen(p.x, p.z, center, yaw, k, R);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      ctx.stroke();
      ctx.restore();
    }
    // 距離の目安の輪
    ctx.strokeStyle = 'rgba(160, 130, 255, 0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(R, R, (R - 4) / 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // 侵入ルートの入り口が範囲の外なら、縁に矢印
    for (const rt of routes) {
      if (rt.alpha <= 0.01 || !rt.points.length) continue;
      const s = this.toScreen(rt.points[0].x, rt.points[0].z, center, yaw, k, R);
      const dx = s.x - R,
        dy = s.y - R;
      const L = Math.hypot(dx, dy);
      if (L < R - 8) continue;
      const ux = dx / L,
        uy = dy / L;
      const ex = R + ux * (R - 9),
        ey = R + uy * (R - 9);
      ctx.save();
      ctx.globalAlpha = rt.alpha;
      ctx.translate(ex, ey);
      ctx.rotate(Math.atan2(uy, ux));
      ctx.fillStyle = '#ff5a3a';
      ctx.beginPath();
      ctx.moveTo(6, 0);
      ctx.lineTo(-4, -5);
      ctx.lineTo(-1.5, 0);
      ctx.lineTo(-4, 5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // 印（下から：タレット → 敵 → 味方 → コア）
    const order: MarkerKind[] = ['dropZone', 'device', 'deviceMine', 'turret', 'turretMine', 'boss', 'enemy', 'mortar', 'pod', 'allyGrunt', 'ally', 'allyDowned', 'core'];
    const sorted = [...markers].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    for (const m of sorted) {
      let s = this.toScreen(m.x, m.z, center, yaw, k, R);
      const dx = s.x - R,
        dy = s.y - R;
      const L = Math.hypot(dx, dy);
      const edge = R - 8;
      if (L > edge) {
        if (!m.pin) continue;
        s = { x: R + (dx / L) * edge, y: R + (dy / L) * edge };
      }
      this.drawMarker(m, s.x, s.y, yaw, time, k);
    }

    // 自分（真ん中の矢印。いつも上を向く）
    ctx.save();
    ctx.translate(R, R);
    ctx.fillStyle = '#ffd166';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(6, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-6, 6);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    ctx.restore();

    // 北の印（円の縁を回る）
    const n = this.toScreenDir(0, -1, yaw);
    ctx.save();
    ctx.font = '700 11px Rajdhani, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(242, 236, 255, 0.85)';
    ctx.fillText('N', R + n.x * (R - 10), R + n.y * (R - 10));
    ctx.restore();
    // 縁
    ctx.strokeStyle = 'rgba(160, 130, 255, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(R, R, R - 1.5, 0, Math.PI * 2);
    ctx.stroke();
  }

  private toScreen(x: number, z: number, c: Vec3, yaw: number, k: number, R: number) {
    const dx = (x - c.x) * k,
      dz = (z - c.z) * k;
    const co = Math.cos(yaw),
      si = Math.sin(yaw);
    return { x: R + dx * co - dz * si, y: R + dx * si + dz * co };
  }

  private toScreenDir(x: number, z: number, yaw: number) {
    const co = Math.cos(yaw),
      si = Math.sin(yaw);
    return { x: x * co - z * si, y: x * si + z * co };
  }

  private drawMarker(m: MinimapMarker, x: number, y: number, yaw: number, time: number, k = 1) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = m.alpha ?? 1;
    ctx.translate(x, y);
    switch (m.kind) {
      case 'dropZone': {
        // 降下予定地点：回る点線の輪
        const r = Math.max(5, (m.r ?? 6) * k);
        ctx.strokeStyle = m.color ?? '#ff5a3a';
        ctx.lineWidth = 1.8;
        ctx.setLineDash([4, 3]);
        ctx.lineDashOffset = -time * 8;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = m.color ?? '#ff5a3a';
        ctx.globalAlpha *= 0.18;
        ctx.fill();
        break;
      }
      case 'pod': {
        // 降りてくる降下ポッド：縮んでいく輪と、真ん中の印（着地が近いほど速く点滅）
        const t = m.t ?? 0;
        const c = m.color ?? '#ff5a3a';
        ctx.strokeStyle = c;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, 4 + (1 - t) * 9, 0, Math.PI * 2);
        ctx.stroke();
        const blink = Math.sin(time * (8 + t * 16)) > -0.2 ? 1 : 0.35;
        ctx.globalAlpha *= blink;
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.moveTo(0, 4.5);
        ctx.lineTo(-4, -2.5);
        ctx.lineTo(4, -2.5);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.lineWidth = 1;
        ctx.stroke();
        break;
      }
      case 'mortar': {
        // 据え付けた迫撃砲兵：点滅する四角と、撃つたびに広がる輪（t = 撃ってからの時間 0..1）
        const c = m.color ?? '#ff9a3a';
        const t = m.t ?? 1;
        if (t < 1) {
          ctx.save();
          ctx.globalAlpha *= 1 - t;
          ctx.strokeStyle = c;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.arc(0, 0, 5 + t * 10, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
        ctx.globalAlpha *= Math.sin(time * 6) > -0.4 ? 1 : 0.5;
        ctx.fillStyle = c;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.rect(-4.5, -4.5, 9, 9);
        ctx.fill();
        ctx.stroke();
        // 中の砲身（斜めの線）
        ctx.strokeStyle = 'rgba(20, 8, 0, 0.9)';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(-2.5, 2.5);
        ctx.lineTo(2.5, -2.5);
        ctx.stroke();
        break;
      }
      case 'ally': {
        // 向きの分かる矢印
        const d = this.toScreenDir(-Math.sin(m.yaw ?? 0), -Math.cos(m.yaw ?? 0), yaw);
        ctx.rotate(Math.atan2(d.y, d.x) + Math.PI / 2);
        ctx.fillStyle = '#3fb6ff';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(0, -6.5);
        ctx.lineTo(5, 5);
        ctx.lineTo(0, 2.5);
        ctx.lineTo(-5, 5);
        ctx.closePath();
        ctx.stroke();
        ctx.fill();
        break;
      }
      case 'allyGrunt':
        ctx.fillStyle = 'rgba(63, 182, 255, 0.8)';
        ctx.beginPath();
        ctx.arc(0, 0, 2.2, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'allyDowned': {
        const p = 0.6 + 0.4 * Math.sin(time * 8);
        ctx.fillStyle = `rgba(255, 70, 50, ${p})`;
        ctx.beginPath();
        ctx.arc(0, 0, 6.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillRect(-1.2, -4, 2.4, 8);
        ctx.fillRect(-4, -1.2, 8, 2.4);
        break;
      }
      case 'enemyMarked': {
        // ソラのパッシブ：照準の輪（少し回る）と、4 つの刻み
        ctx.save();
        ctx.rotate(time * 1.5);
        ctx.strokeStyle = MARK_COLOR;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(0, 0, 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        for (let i = 0; i < 4; i++) {
          const a = (i * Math.PI) / 2;
          ctx.moveTo(Math.cos(a) * 7, Math.sin(a) * 7);
          ctx.lineTo(Math.cos(a) * 10, Math.sin(a) * 10);
        }
        ctx.stroke();
        ctx.restore();
        ctx.fillStyle = '#ff3b3b';
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(0, 0, 3.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        break;
      }
      case 'enemy':
        ctx.fillStyle = 'rgba(255, 59, 59, 0.35)';
        ctx.beginPath();
        ctx.arc(0, 0, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ff3b3b';
        ctx.beginPath();
        ctx.arc(0, 0, 3.6, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'boss':
        ctx.fillStyle = '#ff3b3b';
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.rect(-6, -6, 12, 12);
        ctx.fill();
        ctx.stroke();
        break;
      case 'core': {
        const p = 0.75 + 0.25 * Math.sin(time * 4);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = `rgba(84, 216, 255, ${0.35 * p})`;
        ctx.strokeStyle = '#54d8ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.rect(-5, -5, 10, 10);
        ctx.fill();
        ctx.stroke();
        break;
      }
      case 'device':
      case 'deviceMine':
        // 設置物（バルーン・トラップ・バリケード・ジャンプパッド）：小さなひし形
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = m.kind === 'deviceMine' ? 'rgba(143, 240, 176, 0.95)' : 'rgba(143, 240, 176, 0.55)';
        ctx.fillRect(-2, -2, 4, 4);
        break;
      case 'turret':
      case 'turretMine':
        ctx.fillStyle = m.kind === 'turretMine' ? '#9fe8ff' : 'rgba(79, 160, 220, 0.8)';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(-2.8, -2.8, 5.6, 5.6);
        ctx.fill();
        ctx.stroke();
        break;
    }
    ctx.restore();
  }

  dispose(): void {
    this.root.remove();
  }
}

// ---------------------------------------------------------------------------
// 地形の絵（上から見たステージ）
// ---------------------------------------------------------------------------

/** 頭の上を覆うもの（橋・屋根）は、下が透けるように薄く描く */
const OVERHEAD = new Set(['bridgedeck', 'canopy', 'deck', 'roof']);

const cache = new Map<string, { canvas: HTMLCanvasElement; origin: { x: number; z: number } }>();

function renderBase(level: LevelData): { canvas: HTMLCanvasElement; origin: { x: number; z: number } } {
  const key = `${level.name}:${level.boxes.length}`;
  const c = cache.get(key);
  if (c) return c;
  // 範囲：境界の箱を除いた箱の広がり（少し余白）
  const solids = level.boxes.filter((b) => b.kind !== 'boundary');
  let minX = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxZ = -Infinity;
  const corners = solids.map((b) => {
    const cs = footprint(b);
    for (const p of cs) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    return cs;
  });
  minX = Math.max(minX - 10, -400);
  minZ = Math.max(minZ - 10, -400);
  maxX = Math.min(maxX + 10, 400);
  maxZ = Math.min(maxZ + 10, 400);
  const W = Math.ceil((maxX - minX) * PX_PER_M);
  const H = Math.ceil((maxZ - minZ) * PX_PER_M);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  // 地面の高さの基準（いちばん広い床の上面）
  const floors = solids.filter((b) => b.kind === 'floor');
  const groundY = floors.length ? Math.max(...floors.map((b) => b.center.y + b.size.y / 2)) : 0;
  const order = solids.map((b, i) => ({ b, i, top: b.center.y + (b.size.y / 2) * Math.abs(Math.cos(((b.rot?.x ?? 0) * Math.PI) / 180)) })).sort((a, b) => a.top - b.top);
  for (const { b, i, top } of order) {
    const cs = corners[i];
    const h = top - groundY;
    let fill: string;
    if (b.kind === 'floor') fill = h < -1 ? 'rgba(40, 46, 60, 0.9)' : 'rgba(58, 64, 82, 0.9)';
    else {
      // 高いほど明るく（0m〜16m）
      const t = Math.max(0, Math.min(1, (h + 1) / 17));
      const l = 34 + t * 46;
      fill = `hsla(${225 - t * 25}, ${18 + t * 10}%, ${l}%, ${OVERHEAD.has(b.tag ?? '') ? 0.35 : 0.95})`;
    }
    ctx.fillStyle = fill;
    ctx.beginPath();
    cs.forEach((p, k) => {
      const x = (p.x - minX) * PX_PER_M,
        y = (p.z - minZ) * PX_PER_M;
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
    if (b.kind !== 'floor' && (b.size.x > 1.2 || b.size.z > 1.2)) {
      ctx.strokeStyle = 'rgba(10, 8, 22, 0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  const out = { canvas, origin: { x: minX, z: minZ } };
  cache.set(key, out);
  return out;
}

/** 箱を上から見た四隅 */
function footprint(b: BoxDef): Vec3[] {
  const r = b.rot ?? v3();
  const m = mat3FromEulerYXZ(r.x, r.y, r.z);
  const hx = b.size.x / 2,
    hz = b.size.z / 2;
  return [v3(-hx, 0, -hz), v3(hx, 0, -hz), v3(hx, 0, hz), v3(-hx, 0, hz)].map((p) => {
    const q = mat3MulVec(m, p);
    return v3(b.center.x + q.x, b.center.y + q.y, b.center.z + q.z);
  });
}
