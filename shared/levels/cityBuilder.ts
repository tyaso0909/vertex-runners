/**
 * 街のマップを組み立てる道具。
 * - 西半分に置いたものを鏡写しにして東半分にも置く（左右対称のマップ用）
 * - 中に入れる建物（外壁・扉や窓の開口・各階の床・屋上・階段の穴）
 * - 立体駐車場（各階の床・スロープ・柱・腰壁）
 * - 橋・ガラスのスカイブリッジ・手すり・コンテナ・空調・木箱・看板・照明などの小物
 */
import { type BoxDef, type DecorDef, LevelBuilder, type NavLinkDef } from '../level';
import type { TargetDef } from '../targets';
import { type Vec3, v3 } from '../math';

export type Side = 'n' | 's' | 'e' | 'w';

/** 外壁の開口（扉・窓）。a〜b は壁に沿った座標（n/s は x、e/w は z） */
export interface Opening {
  side: Side;
  /** 何階か（0 = 1階） */
  floor: number;
  a: number;
  b: number;
  /** 床からの高さ（扉は 0、窓は 0.9 など） */
  sill?: number;
  /** 開口の高さ */
  h?: number;
}

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface ShellOptions {
  name: string;
  /** 各階の床の高さ（最初は 0） */
  floors: number[];
  /** 屋上の高さ */
  roof: number;
  openings: Opening[];
  /** 各階の床にあける穴（階段の上）。holes[i] は floors[i] の床（i ≥ 1）、holes[floors.length] は屋上 */
  holes?: Record<number, Rect[]>;
  /** 壁の厚み */
  wall?: number;
  /** 屋上の縁に手すりをつけるか */
  roofRail?: boolean;
}

/** 長方形から穴をくり抜いた残りを、長方形の集まりで返す */
export function subtractRects(r: Rect, holes: Rect[]): Rect[] {
  let parts: Rect[] = [r];
  for (const h of holes) {
    const next: Rect[] = [];
    for (const p of parts) {
      const ix0 = Math.max(p.x0, h.x0),
        ix1 = Math.min(p.x1, h.x1),
        iz0 = Math.max(p.z0, h.z0),
        iz1 = Math.min(p.z1, h.z1);
      if (ix0 >= ix1 || iz0 >= iz1) {
        next.push(p);
        continue;
      }
      // 上下（z）の帯と、左右（x）の残り
      if (p.z0 < iz0) next.push({ x0: p.x0, z0: p.z0, x1: p.x1, z1: iz0 });
      if (iz1 < p.z1) next.push({ x0: p.x0, z0: iz1, x1: p.x1, z1: p.z1 });
      if (p.x0 < ix0) next.push({ x0: p.x0, z0: iz0, x1: ix0, z1: iz1 });
      if (ix1 < p.x1) next.push({ x0: ix1, z0: iz0, x1: p.x1, z1: iz1 });
    }
    parts = next;
  }
  return parts.filter((p) => p.x1 - p.x0 > 0.05 && p.z1 - p.z0 > 0.05);
}

export class CityBuilder extends LevelBuilder {
  private mark = { boxes: 0, decor: 0, targets: 0, links: 0, spawns: 0, ammo: 0 };

  /** fn の中で置いたものを、東側（x を反転）にも置く */
  mirrored(fn: () => void) {
    this.mark = {
      boxes: this.boxes.length,
      decor: this.decor.length,
      targets: this.targets.length,
      links: this.navLinks.length,
      spawns: this.spawns.length,
      ammo: this.ammoStations.length,
    };
    fn();
    const mx = (p: Vec3) => v3(-p.x, p.y, p.z);
    const mvis = (vis: BoxDef['vis']) => {
      if (!vis) return undefined;
      const m = { ...vis };
      if (m.alt !== undefined) m.style = m.alt;
      // 部屋の範囲（x を反転して入れ替える）
      if (typeof m.rx0 === 'number' && typeof m.rx1 === 'number') {
        const a = -m.rx1,
          bb = -m.rx0;
        m.rx0 = a;
        m.rx1 = bb;
      }
      if (typeof m.name === 'string') m.name = m.name + "'";
      return m;
    };
    for (const b of this.boxes.slice(this.mark.boxes)) {
      const m: BoxDef = { ...b, center: mx(b.center), vis: mvis(b.vis) };
      if (b.rot) m.rot = v3(b.rot.x, -b.rot.y, -b.rot.z);
      this.boxes.push(m);
    }
    for (const d of this.decor.slice(this.mark.decor)) {
      const m: DecorDef = { ...d, pos: mx(d.pos), yaw: -d.yaw, params: d.params ? { ...d.params } : undefined };
      if (m.params?.alt !== undefined) m.params.style = m.params.alt;
      this.decor.push(m);
    }
    for (const t of this.targets.slice(this.mark.targets)) {
      const m: TargetDef = { ...t, pos: mx(t.pos), yaw: -t.yaw, moveTo: t.moveTo ? mx(t.moveTo) : undefined };
      this.targets.push(m);
    }
    for (const l of this.navLinks.slice(this.mark.links)) {
      const m: NavLinkDef = { ...l, from: mx(l.from), to: mx(l.to), via: l.via ? mx(l.via) : undefined, note: l.note ? l.note + '（東）' : undefined };
      this.navLinks.push(m);
    }
    for (const s of this.spawns.slice(this.mark.spawns)) this.spawns.push({ team: 1, pos: mx(s.pos), yaw: -s.yaw });
    for (const a of this.ammoStations.slice(this.mark.ammo)) this.ammoStations.push(mx(a));
  }

  // --- 建物 ---

  /** 中に入れない建物（地面から top まで）。外壁は壁走りできる */
  solid(x0: number, z0: number, x1: number, z1: number, top: number, vis: BoxDef['vis'] = {}) {
    return this.boxRange(x0, -0.5, z0, x1, top, z1, 'platform', { tag: 'building', vis });
  }

  /**
   * 中に入れる建物。外壁（開口つき）・各階の床・屋上を作る。
   * 1つの階の壁は「開口のない部分」「開口の下（腰壁）」「開口の上（まぐさ）」に分けた箱で作る。
   */
  shell(x0: number, z0: number, x1: number, z1: number, o: ShellOptions) {
    const t = o.wall ?? 0.4;
    const slabT = 0.5;
    const room = { name: o.name, rx0: x0 + t, rz0: z0 + t, rx1: x1 - t, rz1: z1 - t };
    const levels = [...o.floors, o.roof];
    const wallBox = (bx0: number, by0: number, bz0: number, bx1: number, by1: number, bz1: number, extra: BoxDef['vis'] = {}) => {
      if (bx1 - bx0 < 0.02 || by1 - by0 < 0.02 || bz1 - bz0 < 0.02) return;
      this.boxRange(bx0, by0, bz0, bx1, by1, bz1, 'wall', { tag: 'shell', vis: { ...room, ...extra } });
    };
    const sides: Array<{ side: Side; lo: number; hi: number; box: (a: number, b: number, y0: number, y1: number, extra?: BoxDef['vis']) => void }> = [
      { side: 'n', lo: x0, hi: x1, box: (a, b, y0, y1, e) => wallBox(a, y0, z0, b, y1, z0 + t, e) },
      { side: 's', lo: x0, hi: x1, box: (a, b, y0, y1, e) => wallBox(a, y0, z1 - t, b, y1, z1, e) },
      { side: 'w', lo: z0 + t, hi: z1 - t, box: (a, b, y0, y1, e) => wallBox(x0, y0, a, x0 + t, y1, b, e) },
      { side: 'e', lo: z0 + t, hi: z1 - t, box: (a, b, y0, y1, e) => wallBox(x1 - t, y0, a, x1, y1, b, e) },
    ];
    for (const sd of sides) {
      for (let f = 0; f < o.floors.length; f++) {
        const y0 = f === 0 ? -0.5 : levels[f];
        const fy = levels[f];
        const y1 = levels[f + 1];
        const ops = o.openings.filter((op) => op.side === sd.side && op.floor === f).sort((p, q) => p.a - q.a);
        let cur = sd.lo;
        for (const op of ops) {
          const a = Math.max(sd.lo, op.a),
            b = Math.min(sd.hi, op.b);
          sd.box(cur, a, y0, y1);
          const sill = op.sill ?? 0;
          const top = Math.min(y1 - 0.3, fy + sill + (op.h ?? 3.2));
          if (sill > 0) sd.box(a, b, y0, fy + sill, { sill: true });
          sd.box(a, b, top, y1, { lintel: true, door: sill === 0 });
          cur = b;
        }
        sd.box(cur, sd.hi, y0, y1);
      }
    }
    // 各階の床（2階より上）と屋上
    const inner: Rect = { x0: x0 + t, z0: z0 + t, x1: x1 - t, z1: z1 - t };
    for (let f = 1; f <= o.floors.length; f++) {
      const y = levels[f];
      const isRoof = f === o.floors.length;
      const area: Rect = isRoof ? { x0, z0, x1, z1 } : inner;
      for (const r of subtractRects(area, o.holes?.[f] ?? [])) {
        this.boxRange(r.x0, y - slabT, r.z0, r.x1, y, r.z1, 'platform', {
          tag: 'slab',
          noWallrun: true,
          vis: { ...room, roof: isRoof, level: f },
        });
      }
    }
    if (o.roofRail) {
      const y = o.roof;
      this.rail(x0 + 0.1, z0 + 0.1, x1 - 0.1, z0 + 0.1, y);
      this.rail(x0 + 0.1, z1 - 0.1, x1 - 0.1, z1 - 0.1, y);
      this.rail(x0 + 0.1, z0 + 0.1, x0 + 0.1, z1 - 0.1, y);
      this.rail(x1 - 0.1, z0 + 0.1, x1 - 0.1, z1 - 0.1, y);
    }
    return this;
  }

  /**
   * 5m 上る階段（20段・長さ 10m）を置き、上の階の床にあける穴（頭がつかえない所から先）を返す。
   * (x, z) は1段目の手前、yaw は上る向き（度。0 で -Z、90 で -X、180 で +Z、-90 で +X）
   */
  flight(x: number, z: number, yaw: number, baseY: number, width = 3): Rect {
    this.stairs(x, z, yaw, 20, 0.25, 0.5, width, baseY);
    const fx = Math.round(-Math.sin((yaw * Math.PI) / 180)),
      fz = Math.round(-Math.cos((yaw * Math.PI) / 180));
    const ax = x + fx * 4,
      az = z + fz * 4;
    const bx = x + fx * 10,
      bz = z + fz * 10;
    const w = width / 2 + 0.2;
    return {
      x0: Math.min(ax, bx) - (fx === 0 ? w : 0),
      x1: Math.max(ax, bx) + (fx === 0 ? w : 0),
      z0: Math.min(az, bz) - (fz === 0 ? w : 0),
      z1: Math.max(az, bz) + (fz === 0 ? w : 0),
    };
  }

  /** 床の板（建物の中の中2階・バルコニー・踊り場など） */
  slab(x0: number, z0: number, x1: number, z1: number, top: number, vis: BoxDef['vis'] = {}) {
    return this.boxRange(x0, top - 0.5, z0, x1, top, z1, 'platform', { tag: 'slab', noWallrun: true, vis });
  }

  /** 橋・通路の床（厚み 0.6m） */
  deck(x0: number, z0: number, x1: number, z1: number, top: number, vis: BoxDef['vis'] = {}) {
    return this.boxRange(x0, top - 0.6, z0, x1, top, z1, 'platform', { tag: 'deck', noWallrun: true, vis });
  }

  /** 手すり（高さ 1.1m）。床の高さ y の上に、(x0,z0)→(x1,z1) の線に沿って置く */
  rail(x0: number, z0: number, x1: number, z1: number, y: number) {
    const dx = x1 - x0,
      dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const yaw = (Math.atan2(dx, dz) * 180) / Math.PI;
    this.boxes.push({
      center: v3((x0 + x1) / 2, y + 0.55, (z0 + z1) / 2),
      size: v3(0.12, 1.1, len),
      rot: v3(0, yaw, 0),
      kind: 'prop',
      noWallrun: true,
      tag: 'rail',
    });
    return this;
  }

  /** 腰壁（高さ h。立体駐車場の各階の縁など） */
  parapet(x0: number, z0: number, x1: number, z1: number, y: number, h = 1.0) {
    return this.boxRange(x0, y, z0, x1, y + h, z1, 'block', { tag: 'wall', noWallrun: true, vis: { parapet: true } });
  }

  /** ガラス張りのスカイブリッジ。axis='x' なら東西に、'z' なら南北に延びる。外側の面は壁走りできる */
  skybridge(x0: number, z0: number, x1: number, z1: number, top: number, axis: 'x' | 'z', vis: BoxDef['vis'] = {}) {
    this.deck(x0, z0, x1, z1, top, { ...vis, bridge: true });
    const H = 3.2;
    const t = 0.25;
    if (axis === 'x') {
      this.boxRange(x0, top, z0, x1, top + H, z0 + t, 'wall', { tag: 'glass' });
      this.boxRange(x0, top, z1 - t, x1, top + H, z1, 'wall', { tag: 'glass' });
    } else {
      this.boxRange(x0, top, z0, x0 + t, top + H, z1, 'wall', { tag: 'glass' });
      this.boxRange(x1 - t, top, z0, x1, top + H, z1, 'wall', { tag: 'glass' });
    }
    this.boxRange(x0, top + H, z0, x1, top + H + 0.35, z1, 'platform', { tag: 'roof', noWallrun: true });
    return this;
  }

  /** 20フィートの貨物コンテナ（6.1 × 2.6 × 2.45）。yaw は度 */
  container(x: number, y: number, z: number, yaw: number, color = 'blue') {
    return this.boxRotY(x, y + 1.3, z, 2.45, 2.6, 6.1, yaw, 'block', { tag: 'container', vis: { color } });
  }

  /** 屋上の空調ユニット */
  ac(x: number, y: number, z: number, w = 2.2, d = 1.8, h = 1.5, yaw = 0) {
    return this.boxRotY(x, y + h / 2, z, w, h, d, yaw, 'block', { tag: 'ac', noWallrun: true });
  }

  /** 立体駐車場の車路（なめらかな坂。見た目も階段にしない） */
  carRamp(from: Vec3, to: Vec3, width: number) {
    this.ramp(from, to, width);
    this.boxes[this.boxes.length - 1].vis = { smooth: true };
    return this;
  }

  /** 駐車している車（4.5 × 1.45 × 1.9。よじ登れる）。yaw 0 で南北を向く */
  car(x: number, y: number, z: number, yaw: number, color = 'white') {
    return this.boxRotY(x, y + 0.725, z, 1.9, 1.45, 4.5, yaw, 'block', { tag: 'car', noWallrun: true, vis: { color } });
  }

  /** 物資の木箱（積み重ね可） */
  crate(x: number, y: number, z: number, s = 1.2, yaw = 0) {
    return this.boxRotY(x, y + s / 2, z, s, s, s, yaw, 'block', { tag: 'crate', noWallrun: true });
  }

  /** 低い壁・遮蔽物 */
  lowWall(x0: number, z0: number, x1: number, z1: number, y: number, h = 1.2) {
    return this.boxRange(x0, y, z0, x1, y + h, z1, 'block', { tag: 'wall', noWallrun: true });
  }

  /** 室内の家具（ゲーム機・棚・カウンター） */
  furniture(kind: 'cabinet' | 'shelf' | 'counter', x: number, y: number, z: number, w: number, d: number, yaw = 0) {
    const h = kind === 'cabinet' ? 1.75 : kind === 'shelf' ? 1.6 : 1.05;
    return this.boxRotY(x, y + h / 2, z, w, h, d, yaw, 'block', { tag: 'furniture', noWallrun: true, vis: { kind } });
  }

  /** 柱 */
  pillar(x: number, z: number, y0: number, y1: number, s = 0.8) {
    return this.boxRange(x - s / 2, y0, z - s / 2, x + s / 2, y1, z + s / 2, 'pillar', { tag: 'pillar', noWallrun: true });
  }

  /** ホログラム看板（壁走りできる） */
  billboard(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, sign: string, alt?: string) {
    return this.boxRange(x0, y0, z0, x1, y1, z1, 'wall', { tag: 'billboard', vis: { style: sign, ...(alt ? { alt } : {}) } });
  }

  sign(type: string, x: number, y: number, z: number, yaw: number, w: number, h: number, params: DecorDef['params'] = {}) {
    this.decor.push({ type, pos: v3(x, y, z), yaw, size: v3(w, h, 0.1), params });
    return this;
  }

  light(x: number, y: number, z: number, color: string, intensity = 30, distance = 26) {
    this.decor.push({ type: 'light', pos: v3(x, y, z), yaw: 0, params: { color, intensity, distance } });
    return this;
  }

  lamp(x: number, y: number, z: number, color = '#4fd1ff') {
    this.decor.push({ type: 'lamp', pos: v3(x, y, z), yaw: 0, params: { color } });
    return this;
  }

  plant(x: number, y: number, z: number, kind: 'palm' | 'shrub' = 'palm') {
    this.decor.push({ type: 'plant', pos: v3(x, y, z), yaw: 0, params: { kind } });
    return this;
  }

  /** 道路の模様（車線・横断歩道）。見た目だけ */
  road(x0: number, z0: number, x1: number, z1: number, axis: 'x' | 'z', crossings: number[] = []) {
    this.decor.push({
      type: 'road',
      pos: v3((x0 + x1) / 2, 0, (z0 + z1) / 2),
      yaw: 0,
      size: v3(x1 - x0, 0, z1 - z0),
      params: { axis, crossings: crossings.join(',') },
    });
    return this;
  }

  /**
   * 正八角形。幅 2r・奥行き（辺の長さ）の帯を 45° ずつ回して 4 本重ねると、ちょうど正八角形になる。
   * 半径 r は中心から辺までの距離
   */
  octagon(x: number, z: number, r: number, y0: number, y1: number, tag: BoxDef['tag'], kind: BoxDef['kind'] = 'platform') {
    const side = 2 * r * Math.tan(Math.PI / 8);
    for (let k = 0; k < 4; k++) {
      this.boxes.push({
        center: v3(x, (y0 + y1) / 2, z),
        size: v3(2 * r, y1 - y0, side),
        rot: v3(0, k * 45, 0),
        kind,
        tag,
        noWallrun: true,
        vis: { octagon: k, r },
      });
    }
    return this;
  }
}
