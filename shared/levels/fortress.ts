/**
 * 軍事要塞（仕様 6.2）。タワーディフェンス用のマップ。
 *
 * 晴れた昼の高原。灰色のコンクリートの要塞を厚い防壁が囲み、四隅に見張り塔が立つ。
 * 左右（西・東）の建物群が、中央の「屋根付きの空中連絡橋」でつながる。その橋の下の広場にコアを置く。
 * 敵は要塞の外の3つの侵入ルートから来る：
 *   正面ゲート（南）  … 南の草原から。道が広く、ボス（大型兵器）も通る
 *   左の坂道（西）    … 一段低い西の岩場から、長い坂道を上って西門へ
 *   右の搬入口（東）  … 東の草原から、ひさしのある搬入口をくぐって荷役場へ
 *
 * 高さ
 *   -6m  西の岩場（低地）
 *    0m  要塞の中・南と東の草原
 *    5m  建物の前のテラス（坂で上る）
 *    7m  防壁の上（歩ける。胸壁つき）
 *   10m  連絡橋・橋のたもとの別棟の屋上
 *   11m  見張り塔・ゲートの塔の上
 *   12m  格納庫の屋上
 *
 * 上から見た配置（-Z が北）
 *
 *   [塔]━━━━━━━━━━━━━━━━ 北の防壁 ━━━━━━━━━━━━━━━━━━[塔]
 *    ┃ [格納庫・西 12]  [指令塔]   車両置き場   [レーダー塔] [格納庫・東 12] ┃
 *    ┃ [テラス 5][別棟10]═══════ 連絡橋 10（下にコア）═══════[別棟10][テラス 5] ┃
 *    ┃  ＼坂                       中央広場                       坂／  ┃
 *  西門   西の資材置き場（コンテナ）          ║          東の荷役場（積み降ろし台）  搬入口
 *    ┃                                    ║                                 ┃
 *   [塔]━━━━━━━━━━━━━[塔]  正面ゲート  [塔]━━━━━━━━━━━━━━━━━━━[塔]
 *                          南の草原（敵が来る）
 *  西の岩場（-6m）から坂道で西門へ
 */
import type { LevelData, NavLinkDef, TdDropZone, TdMortarSpot, TdRouteDef } from '../level';
import { type Vec3, v3 } from '../math';
import { CityBuilder, type ShellOptions } from './cityBuilder';

// --- 主な寸法 ---
/** 防壁の外側の面（x は ±WALL_X、z は北 WALL_N・南 WALL_S） */
const WALL_X = 62;
const WALL_N = -50;
const WALL_S = 40;
const WALL_T = 3;
const WALL_H = 7;
/** 正面ゲートの幅の半分 */
const GATE_HALF = 8;
/** 西門・搬入口（z の範囲） */
const WEST_GATE = [14, 26] as const;
const DOCK_GATE = [10, 24] as const;
/** 西の岩場の高さ・崖の位置 */
const LOW_Y = -6;
const CLIFF_X = -76;
/** 連絡橋 */
const BRIDGE_Z = [-24, -16] as const;
const BRIDGE_Y = 10;
/** コアの足元 */
const CORE = v3(0, 0, -20);
/** プレイできる範囲（外周の見えない壁の内側）。要塞のまわりの草原・岩場を広く取る */
const PLAY_X = [-132, 132] as const;
const PLAY_Z = [-92, 116] as const;

class FortressBuilder extends CityBuilder {
  /** 防壁の一区間（上は歩ける。外側に胸壁）。outer は外側の向き（'n' | 's' | 'e' | 'w'） */
  fortWall(x0: number, z0: number, x1: number, z1: number, outer: 'n' | 's' | 'e' | 'w') {
    this.boxRange(x0, -0.5, z0, x1, WALL_H, z1, 'wall', { tag: 'fortwall', vis: { outer } });
    const t = 0.6;
    const h = 1.2;
    const y = WALL_H;
    if (outer === 'n') this.boxRange(x0, y, z0, x1, y + h, z0 + t, 'block', { tag: 'parapet', noWallrun: true, vis: { outer } });
    if (outer === 's') this.boxRange(x0, y, z1 - t, x1, y + h, z1, 'block', { tag: 'parapet', noWallrun: true, vis: { outer } });
    if (outer === 'w') this.boxRange(x0, y, z0, x0 + t, y + h, z1, 'block', { tag: 'parapet', noWallrun: true, vis: { outer } });
    if (outer === 'e') this.boxRange(x1 - t, y, z0, x1, y + h, z1, 'block', { tag: 'parapet', noWallrun: true, vis: { outer } });
    return this;
  }

  /** 屋上・塔の上の縁をぐるりと囲む胸壁（open は開けておく辺） */
  rimParapet(x0: number, z0: number, x1: number, z1: number, y: number, open: Array<'n' | 's' | 'e' | 'w'> = [], h = 1.1) {
    const t = 0.5;
    if (!open.includes('n')) this.boxRange(x0, y, z0, x1, y + h, z0 + t, 'block', { tag: 'parapet', noWallrun: true });
    if (!open.includes('s')) this.boxRange(x0, y, z1 - t, x1, y + h, z1, 'block', { tag: 'parapet', noWallrun: true });
    if (!open.includes('w')) this.boxRange(x0, y, z0 + t, x0 + t, y + h, z1 - t, 'block', { tag: 'parapet', noWallrun: true });
    if (!open.includes('e')) this.boxRange(x1 - t, y, z0 + t, x1, y + h, z1 - t, 'block', { tag: 'parapet', noWallrun: true });
    return this;
  }

  /**
   * 見張り塔（本体の上 11m・上に小屋）。(cx, cz) が中心、s が一辺。
   * 小屋は四隅の柱と屋根（14.4m）。上は胸壁で囲み、open の辺から階段で上る
   */
  watchtower(cx: number, cz: number, s: number, open: 'n' | 's' | 'e' | 'w', name: string) {
    const x0 = cx - s / 2,
      x1 = cx + s / 2,
      z0 = cz - s / 2,
      z1 = cz + s / 2;
    const top = 11;
    this.boxRange(x0, -0.5, z0, x1, top, z1, 'wall', { tag: 'watchtower', vis: { name } });
    this.rimParapet(x0, z0, x1, z1, top, [open]);
    // 小屋：四隅の柱と屋根（屋根の上にも乗れる）
    const p = 0.5;
    for (const [px, pz] of [
      [x0 + 0.8, z0 + 0.8],
      [x1 - 0.8, z0 + 0.8],
      [x0 + 0.8, z1 - 0.8],
      [x1 - 0.8, z1 - 0.8],
    ])
      this.boxRange(px - p / 2, top, pz - p / 2, px + p / 2, top + 3, pz + p / 2, 'pillar', { tag: 'cabin', noWallrun: true });
    this.boxRange(x0 - 0.4, top + 3, z0 - 0.4, x1 + 0.4, top + 3.4, z1 + 0.4, 'platform', { tag: 'cabin', noWallrun: true, vis: { roof: true } });
    this.decor.push({ type: 'antenna', pos: v3(cx + s / 2 - 1.2, top + 3.4, cz - s / 2 + 1.2), yaw: 0, params: { h: 4 } });
    this.decor.push({ type: 'searchlight', pos: v3(cx, top + 3.4, cz), yaw: 0 });
    return this;
  }

  /** 軍用トラック（8 × 3.2 × 2.5）。yaw は度（0 で南北に向く） */
  truck(x: number, z: number, yaw: number, kind: 'cargo' | 'tanker' = 'cargo', y = 0) {
    return this.boxRotY(x, y + 1.6, z, 2.5, 3.2, 8, yaw, 'block', { tag: 'truck', noWallrun: false, vis: { kind } });
  }

  /** 装甲車（6.5 × 2.6 × 2.8） */
  apc(x: number, z: number, yaw: number, y = 0) {
    return this.boxRotY(x, y + 1.3, z, 2.8, 2.6, 6.5, yaw, 'block', { tag: 'apc', noWallrun: true });
  }

  /** コンクリートの障害物（ジャージー壁 2.6 × 1.1 × 0.8） */
  barrier(x: number, z: number, yaw: number, y = 0) {
    return this.boxRotY(x, y + 0.55, z, 0.8, 1.1, 2.6, yaw, 'block', { tag: 'barrier', noWallrun: true });
  }

  /** 障害物を一列に並べる */
  barrierRow(x0: number, z0: number, x1: number, z1: number, n: number) {
    const yaw = (Math.atan2(x1 - x0, z1 - z0) * 180) / Math.PI;
    for (let i = 0; i < n; i++) {
      const k = n === 1 ? 0.5 : i / (n - 1);
      this.barrier(x0 + (x1 - x0) * k, z0 + (z1 - z0) * k, yaw);
    }
    return this;
  }

  /** 土のう（半円の陣地。高さ 1.0） */
  sandbags(x: number, z: number, yaw: number, w = 4, y = 0) {
    return this.boxRotY(x, y + 0.5, z, w, 1.0, 1.0, yaw, 'block', { tag: 'sandbag', noWallrun: true });
  }

  /**
   * 砲撃陣地（迫撃砲兵が上る、高さ 2.4m のコンクリートの台）。ramp の向き（'n' | 's' | 'e' | 'w'）に坂が付き、
   * 上の縁に土のうを積む（坂の側は空けておく）
   */
  emplacement(cx: number, cz: number, ramp: 'n' | 's' | 'e' | 'w') {
    const h = 2.4,
      r = 3.5;
    this.boxRange(cx - r, -0.5, cz - r, cx + r, h, cz + r, 'block', { tag: 'dock', noWallrun: true });
    const L = 7.5;
    if (ramp === 'n') this.ramp(v3(cx, 0, cz - r - L), v3(cx, h, cz - r), 4, 1.2);
    if (ramp === 's') this.ramp(v3(cx, 0, cz + r + L), v3(cx, h, cz + r), 4, 1.2);
    if (ramp === 'w') this.ramp(v3(cx - r - L, 0, cz), v3(cx - r, h, cz), 4, 1.2);
    if (ramp === 'e') this.ramp(v3(cx + r + L, 0, cz), v3(cx + r, h, cz), 4, 1.2);
    const e = r - 0.5;
    if (ramp !== 'n') this.sandbags(cx, cz - e, 0, 6, h);
    if (ramp !== 's') this.sandbags(cx, cz + e, 0, 6, h);
    if (ramp !== 'w') this.sandbags(cx - e, cz, 90, 6, h);
    if (ramp !== 'e') this.sandbags(cx + e, cz, 90, 6, h);
    return this;
  }

  /** 燃料タンク（円筒を八角形で近似） */
  fuelTank(x: number, z: number, r: number, h: number) {
    return this.octagon(x, z, r, -0.2, h, 'fueltank', 'block');
  }

  /** 緑の貨物コンテナ（軍用） */
  milContainer(x: number, y: number, z: number, yaw: number, color = 'olive') {
    return this.container(x, y, z, yaw, color);
  }

  /** 岩（見た目は Blender で崩した形にする。当たり判定は箱） */
  rock(x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw: number) {
    return this.boxRotY(x, y + sy / 2 - 0.3, z, sx, sy, sz, yaw, 'block', { tag: 'rock', noWallrun: true, vis: { seed: Math.round(x * 7 + z * 13) } });
  }

  /** 照明柱（見た目だけ） */
  lightPole(x: number, z: number, y = 0) {
    this.decor.push({ type: 'lightpole', pos: v3(x, y, z), yaw: 0 });
    return this;
  }

  /**
   * 前哨陣地（要塞の外の小さなトーチカ）。中に入れて、屋上（3.5m）へは外の階段で上る。
   * doors は出入り口の辺（幅 2.2m）、slits は銃眼のある辺。stair は屋上へ上る階段のある辺
   */
  outpost(x0: number, z0: number, x1: number, z1: number, name: string, doors: Array<'n' | 's' | 'e' | 'w'>, stair: 'n' | 's' | 'e' | 'w') {
    const y = 0;
    const roof = y + 3.5;
    const cx = (x0 + x1) / 2,
      cz = (z0 + z1) / 2;
    const openings: ShellOptions['openings'] = [];
    for (const s of doors) {
      const c = s === 'n' || s === 's' ? cx : cz;
      openings.push({ side: s, floor: 0, a: c - 1.1, b: c + 1.1, h: 2.4 });
    }
    // 銃眼（腰の高さから 0.5m の細い窓）：出入り口のない辺に 2 つずつ
    for (const s of ['n', 's', 'e', 'w'] as const) {
      if (doors.includes(s) || s === stair) continue;
      const lo = s === 'n' || s === 's' ? x0 : z0;
      const hi = s === 'n' || s === 's' ? x1 : z1;
      for (const k of [0.3, 0.7]) {
        const c = lo + (hi - lo) * k;
        openings.push({ side: s, floor: 0, a: c - 0.9, b: c + 0.9, sill: 1.3, h: 0.5 });
      }
    }
    this.shell(x0, z0, x1, z1, { name, floors: [y], roof, wall: 0.5, openings });
    this.rimParapet(x0, z0, x1, z1, roof, [stair]);
    // 屋上へ上る階段（14段・3.5m）：stair の辺の外側を、辺に沿って上る
    const n = 14;
    // （壁にぴったり付ける：すき間があると、階段から屋上へ歩いて入れない）。
    // 経路の点（2.5m 間隔）が上から 2 段目に乗るように、階段を少しずらす（屋上より 0.35m 以上低い段からは、屋上へ歩いて入れない）
    const G = 2.5;
    if (stair === 'e' || stair === 'w') {
      const end0 = z1 + 0.2 - n * 0.5;
      const shift = Math.round((end0 + 0.7) / G) * G - 0.7 - end0;
      this.stairs(stair === 'e' ? x1 + 0.8 : x0 - 0.8, z1 + 0.2 + shift, 0, n, 0.25, 0.5, 1.6, y);
    } else {
      const end0 = x0 - 0.2 + n * 0.5;
      const shift = Math.round((end0 - 0.7) / G) * G + 0.7 - end0;
      this.stairs(x0 - 0.2 + shift, stair === 's' ? z1 + 0.8 : z0 - 0.8, -90, n, 0.25, 0.5, 1.6, y);
    }
    this.decor.push({ type: 'antenna', pos: v3(x1 - 1, roof, z0 + 1), yaw: 0, params: { h: 4 } });
    return this;
  }

  /**
   * 崩れたコンクリートの壁（壁走りの足場）。長さ 1.5〜3.5m ごとに高さの違う箱に分ける（崩れた形）。
   * 見た目は、それぞれの箱の上の縁をさらに細かく崩す
   */
  ruin(x0: number, z0: number, x1: number, z1: number, h: number, y = 0) {
    const alongX = x1 - x0 >= z1 - z0;
    const L = alongX ? x1 - x0 : z1 - z0;
    let seed = Math.round(Math.abs(x0 * 31 + z0 * 17 + h * 7)) + 1;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    let u = 0;
    let i = 0;
    while (u < L - 0.01) {
      const w = Math.min(L - u, 1.5 + rnd() * 2);
      const last = u + w >= L - 0.01;
      // 両端は低く、真ん中ほど高い（ときどき大きく崩れている）
      const k = i === 0 || last ? 0.5 + rnd() * 0.25 : rnd() < 0.2 ? 0.45 + rnd() * 0.2 : 0.75 + rnd() * 0.25;
      const top = y + Math.max(1.4, h * k);
      if (alongX) this.boxRange(x0 + u, y - 0.5, z0, x0 + u + w, top, z1, 'wall', { tag: 'ruin', vis: { seed: seed % 9973 } });
      else this.boxRange(x0, y - 0.5, z0 + u, x1, top, z0 + u + w, 'wall', { tag: 'ruin', vis: { seed: seed % 9973 } });
      u += w;
      i++;
    }
    return this;
  }

  /**
   * 外の見張り台（小屋のない四角い塔。高さ 9m）。西の面に、1段・2段・3段に積んだコンテナの階段があり、
   * パイロットは2段ジャンプとよじ登りで上れる（いちばん上のコンテナ 7.8m → 塔の上 9m。西の胸壁は開けてある）
   */
  lookout(cx: number, cz: number, s: number, h: number, name: string, y = 0) {
    const x0 = cx - s / 2,
      x1 = cx + s / 2,
      z0 = cz - s / 2,
      z1 = cz + s / 2;
    this.boxRange(x0, y - 0.5, z0, x1, y + h, z1, 'wall', { tag: 'watchtower', vis: { name } });
    this.rimParapet(x0, z0, x1, z1, y + h, ['w']);
    this.stack(x0 - 1.25, cz, 0, 3, ['olive', 'tan', 'olive'], y);
    this.stack(x0 - 3.7, cz + 1.2, 0, 2, ['tan', 'olive'], y);
    this.stack(x0 - 6.15, cz + 2.4, 0, 1, ['olive'], y);
    this.decor.push({ type: 'searchlight', pos: v3(cx + s / 2 - 0.9, y + h + 1.1, cz - s / 2 + 0.9), yaw: 0 });
    this.decor.push({ type: 'antenna', pos: v3(cx - s / 2 + 0.9, y + h + 1.1, cz - s / 2 + 0.9), yaw: 0, params: { h: 5 } });
    return this;
  }

  /** 草原の土の地面（見た目だけ） */
  dirt(x: number, z: number, r: number, y = 0) {
    this.decor.push({ type: 'dirtpatch', pos: v3(x, y, z), yaw: 0, params: { r } });
    return this;
  }

  /** 砲弾の跡（見た目だけ） */
  crater(x: number, z: number, r: number, y = 0) {
    this.decor.push({ type: 'crater', pos: v3(x, y, z), yaw: 0, params: { r } });
    return this;
  }

  /** コンテナを積む（下から順に。yaw は度） */
  stack(x: number, z: number, yaw: number, n: number, colors: string[] = ['olive', 'tan', 'olive'], y = 0) {
    for (let i = 0; i < n; i++) this.milContainer(x, y + i * 2.6, z, yaw, colors[i % colors.length]);
    return this;
  }
}

export function buildFortress(): LevelData {
  const b = new FortressBuilder();
  const NORTH = 0; // 視線の向き（ラジアン。0 で -Z）
  const SOUTH = Math.PI;

  // =====================================================================
  // 地面（要塞の中・南と東の草原）と、西の岩場（一段低い）
  // =====================================================================
  const [PX0, PX1] = PLAY_X;
  const [PZ0, PZ1] = PLAY_Z;
  b.boxRange(CLIFF_X, -1.5, PZ0, PX1, 0, PZ1, 'floor', { tag: 'ground', noWallrun: true });
  b.boxRange(PX0, LOW_Y - 1.5, PZ0, CLIFF_X, LOW_Y, PZ1, 'floor', { tag: 'ground', noWallrun: true, vis: { low: true } });
  // 崖（擁壁）。西の岩場から台地へは坂道でしか上れない（パイロットは壁走り・よじ登りで上れる）
  b.boxRange(CLIFF_X - 1.2, LOW_Y - 0.5, PZ0, CLIFF_X, 0, PZ1, 'wall', { tag: 'cliff' });
  // 左の坂道（西の岩場 → 西門の前）。下は土手で埋める
  b.ramp(v3(-99, LOW_Y, 20), v3(CLIFF_X - 1.2, 0, 20), 11, 7.5);
  b.boxes[b.boxes.length - 1].vis = { smooth: true, road: true };
  // 坂の両側の縁石（下の端のすぐ上から、上まで。歩いて坂へ入るのは下の端から。パイロットは縁石を跳び越えられる）
  const rampY = (x: number) => LOW_Y + ((x + 99) / (99 + CLIFF_X - 1.2)) * (0 - LOW_Y);
  for (const z of [14.2, 25.8]) {
    b.ramp(v3(-97.5, rampY(-97.5) + 0.7, z), v3(CLIFF_X - 1.2, 0.7, z), 0.6, 0.7);
    b.boxes[b.boxes.length - 1].tag = 'barrier';
  }

  // マップの外へ出ないための見えない壁（外周）
  const barrierWall = (x0: number, z0: number, x1: number, z1: number) => b.boxRange(x0, -10, z0, x1, 40, z1, 'boundary', { tag: 'barrier', noWallrun: true, vis: { invisible: true } });
  barrierWall(PX0 - 2, PZ0 - 2, PX1 + 2, PZ0);
  barrierWall(PX0 - 2, PZ1, PX1 + 2, PZ1 + 2);
  barrierWall(PX0 - 2, PZ0 - 2, PX0, PZ1 + 2);
  barrierWall(PX1, PZ0 - 2, PX1 + 2, PZ1 + 2);

  // =====================================================================
  // 防壁（厚さ 3m・高さ 7m。上を歩ける）と見張り塔
  // =====================================================================
  const xi = WALL_X - WALL_T; // 内側の面
  const zn = WALL_N + WALL_T;
  const zs = WALL_S - WALL_T;
  // 北
  b.fortWall(-WALL_X, WALL_N, WALL_X, zn, 'n');
  // 南（正面ゲートの左右）
  b.fortWall(-WALL_X, zs, -GATE_HALF - 6, WALL_S, 's');
  b.fortWall(GATE_HALF + 6, zs, WALL_X, WALL_S, 's');
  // 西（西門の上下）
  b.fortWall(-WALL_X, zn, -xi, WEST_GATE[0], 'w');
  b.fortWall(-WALL_X, WEST_GATE[1], -xi, zs, 'w');
  // 東（搬入口の上下）
  b.fortWall(xi, zn, WALL_X, DOCK_GATE[0], 'e');
  b.fortWall(xi, DOCK_GATE[1], WALL_X, zs, 'e');

  // 四隅の見張り塔（防壁の上から階段で上る）
  b.watchtower(-WALL_X + 2, WALL_N + 2, 10, 's', 'nw');
  b.watchtower(WALL_X - 2, WALL_N + 2, 10, 's', 'ne');
  b.watchtower(-WALL_X + 2, WALL_S - 2, 10, 'e', 'sw');
  b.watchtower(WALL_X - 2, WALL_S - 2, 10, 'w', 'se');
  // 塔へ上る階段（防壁の上 7m → 11m。16段）
  b.stairs(-WALL_X + 1.8, WALL_N + 15, 0, 16, 0.25, 0.5, 2.0, WALL_H); // 北西：西の防壁の上を北へ
  b.stairs(WALL_X - 1.8, WALL_N + 15, 0, 16, 0.25, 0.5, 2.0, WALL_H); // 北東：東の防壁の上を北へ
  b.stairs(-WALL_X + 15, WALL_S - 1.8, 90, 16, 0.25, 0.5, 2.0, WALL_H); // 南西：南の防壁の上を西へ
  b.stairs(WALL_X - 15, WALL_S - 1.8, -90, 16, 0.25, 0.5, 2.0, WALL_H); // 南東：南の防壁の上を東へ

  // 正面ゲートの左右の塔（上 11m）
  for (const s of [-1, 1]) {
    const cx = s * (GATE_HALF + 3);
    b.boxRange(cx - 3, -0.5, WALL_S - 6, cx + 3, 11, WALL_S + 3, 'wall', { tag: 'watchtower', vis: { name: s < 0 ? 'gate_w' : 'gate_e', gate: true } });
    b.rimParapet(cx - 3, WALL_S - 6, cx + 3, WALL_S + 3, 11, [s < 0 ? 'w' : 'e']);
    // 防壁の上（7m）から塔の上へ（16段）。防壁の上を、ゲートに向かって上る
    b.stairs(s * (GATE_HALF + 14), WALL_S - 1.8, s < 0 ? -90 : 90, 16, 0.25, 0.5, 2.0, WALL_H);
    b.decor.push({ type: 'antenna', pos: v3(cx + s * 2, 11, WALL_S + 1.5), yaw: 0, params: { h: 5 } });
    b.lightPole(cx, WALL_S + 6);
  }
  b.decor.push({ type: 'gatesign', pos: v3(0, 9.2, WALL_S + 0.1), yaw: 0, size: v3(10, 1.6, 0.1), params: { text: 'FORT AEGIS', sub: '第7防衛拠点' } });

  // 防壁の上へ上る階段（地面 0m → 7m。28段・14m）。壁の内側の面に沿って
  const wallStairs: Array<[number, number, number]> = [
    [-30, zs - 1.4, -90], // 南の防壁（西）：東へ上る
    [30, zs - 1.4, 90], // 南の防壁（東）：西へ上る
    [-xi + 1.4, -6, 180], // 西の防壁：南へ上る
    [xi - 1.4, -6, 180], // 東の防壁：南へ上る
    [-6, zn + 1.4, -90], // 北の防壁：東へ上る
  ];
  for (const [x, z, yaw] of wallStairs) b.stairs(x, z, yaw, 28, 0.25, 0.5, 2.6, 0);

  // =====================================================================
  // 西の建物群：格納庫（12m）・テラス（5m）・橋のたもとの別棟（10m）・指令塔
  // =====================================================================
  // 格納庫（中に入れる。東の面に大型車両用のゲート）
  b.shell(-58, -46, -30, -26, {
    name: 'hangar_w',
    floors: [0],
    roof: 12,
    wall: 0.6,
    openings: [
      { side: 'e', floor: 0, a: -38, b: -28, h: 7 }, // 大型車両用のゲート
      { side: 's', floor: 0, a: -54, b: -51, h: 3 }, // テラスの下の通用口
      { side: 'n', floor: 0, a: -40, b: -37, h: 3 },
    ],
  });
  b.rimParapet(-58, -46, -30, -26, 12, ['s']);
  // 格納庫の中：装甲車・木箱・中2階のキャットウォーク（6m）
  b.apc(-45, -38, 90);
  b.truck(-50, -31, 90, 'cargo');
  for (const [x, z, y] of [
    [-55, -43, 0],
    [-53.7, -43, 0],
    [-54.4, -43, 1.2],
    [-34, -44, 0],
  ])
    b.crate(x, y, z, 1.2, 0);
  b.deck(-57.4, -45.4, -53.7, -30, 6, { catwalk: true });
  b.stairs(-52.6, -28, 0, 24, 0.25, 0.5, 2.2, 0); // 中2階へ（6m。上りきった所から西へ渡る）
  b.decor.push({ type: 'hangarlight', pos: v3(-44, 11.4, -36), yaw: 0, size: v3(20, 0, 14) });

  // テラス（5m。下は兵舎）と、テラスへ上る坂（中央広場側から）
  b.solid(-58, -26, -36, -10, 5, { name: 'barracks_w', style: 'barracks' });
  b.rimParapet(-58, -26, -36, -10, 5, ['n', 'e', 's']);
  // （幅 6.2m：広場側の縁に経路の点が来ないように。歩く敵が坂の横から落ちない）
  b.ramp(v3(-36, 0, -6.9), v3(-56, 5, -6.9), 6.2, 1.2);
  // 坂に面したテラスの縁の胸壁（坂の上の端 2m と、広場へ飛び降りる東の端は開けておく）。坂の途中から横のテラスへは入れない
  b.boxRange(-54, 5, -10.5, -40.5, 6.1, -10, 'block', { tag: 'parapet', noWallrun: true });
  // 格納庫・兵舎と西・東の防壁の間の幅 1m のすき間を埋める（防壁の上から落ちると出られない細い路地になっていた。
  // 防壁の上の通路が、そこだけ 1m 広くなる）
  for (const s of [-1, 1]) {
    const x0 = s > 0 ? WALL_X - WALL_T - 1 : -(WALL_X - WALL_T),
      x1 = x0 + 1;
    b.boxRange(x0, -0.5, WALL_N + WALL_T, x1, WALL_H, -10, 'wall', { tag: 'fortwall', vis: { outer: s > 0 ? 'e' : 'w' } });
  }
  // 別棟（橋のたもと。上 10m）と、テラスからの階段
  b.solid(-36, -26, -24, -10, BRIDGE_Y, { name: 'annex_w', style: 'annex' });
  b.rimParapet(-36, -26, -24, -10, BRIDGE_Y, ['e', 'w']);
  b.flight(-46, -12, -90, 5, 2.6); // テラス 5m → 別棟 10m（東へ上る）
  // 指令塔（上には行けない飾りの高い塔。根元は格納庫の東）
  b.solid(-30, -47, -20, -39, 22, { name: 'command_tower', style: 'tower' });
  b.decor.push({ type: 'radar', pos: v3(-25, 22, -43), yaw: 0, params: { r: 3 } });
  b.decor.push({ type: 'antenna', pos: v3(-22, 22, -45.5), yaw: 0, params: { h: 9 } });
  b.decor.push({ type: 'antenna', pos: v3(-28.5, 22, -40.5), yaw: 0, params: { h: 6 } });
  b.decor.push({ type: 'banner', pos: v3(-25, 15, -38.9), yaw: 0, size: v3(4, 7, 0.1), params: { emblem: 'wing' } });

  // =====================================================================
  // 東の建物群（西と同じ形を基本に、レーダー塔・荷役場で変える）
  // =====================================================================
  b.shell(30, -46, 58, -26, {
    name: 'hangar_e',
    floors: [0],
    roof: 12,
    wall: 0.6,
    openings: [
      { side: 'w', floor: 0, a: -38, b: -28, h: 7 },
      { side: 's', floor: 0, a: 51, b: 54, h: 3 },
      { side: 'n', floor: 0, a: 37, b: 40, h: 3 },
    ],
  });
  b.rimParapet(30, -46, 58, -26, 12, ['s']);
  b.truck(45, -37, 90, 'tanker');
  b.apc(50, -31, -90);
  for (const [x, z, y] of [
    [55, -43, 0],
    [53.7, -43, 0],
    [55, -41.7, 0],
    [54.4, -42.4, 1.2],
  ])
    b.crate(x, y, z, 1.2, 0);
  b.deck(53.7, -45.4, 57.4, -30, 6, { catwalk: true });
  b.stairs(52.6, -28, 0, 24, 0.25, 0.5, 2.2, 0);
  b.decor.push({ type: 'hangarlight', pos: v3(44, 11.4, -36), yaw: 0, size: v3(20, 0, 14) });

  b.solid(36, -26, 58, -10, 5, { name: 'barracks_e', style: 'barracks' });
  b.rimParapet(36, -26, 58, -10, 5, ['n', 'w', 's']);
  b.ramp(v3(36, 0, -6.9), v3(56, 5, -6.9), 6.2, 1.2);
  b.boxRange(40.5, 5, -10.5, 54, 6.1, -10, 'block', { tag: 'parapet', noWallrun: true });
  b.solid(24, -26, 36, -10, BRIDGE_Y, { name: 'annex_e', style: 'annex' });
  b.rimParapet(24, -26, 36, -10, BRIDGE_Y, ['e', 'w']);
  b.flight(46, -12, 90, 5, 2.6); // テラス 5m → 別棟 10m（西へ上る）
  // レーダー塔（東。指令塔より低く太い）
  b.solid(20, -47, 30, -39, 18, { name: 'radar_tower', style: 'tower' });
  b.decor.push({ type: 'radar', pos: v3(25, 18, -43), yaw: 0, params: { r: 4.5, dish: true } });
  b.decor.push({ type: 'antenna', pos: v3(28.5, 18, -45.5), yaw: 0, params: { h: 7 } });
  b.decor.push({ type: 'banner', pos: v3(25, 12, -38.9), yaw: 0, size: v3(4, 7, 0.1), params: { emblem: 'wing' } });
  // 格納庫の屋上の飾り
  for (const s of [-1, 1]) {
    b.ac(s * 50, 12, -42, 2.6, 2, 1.6);
    b.ac(s * 46, 12, -42, 2.6, 2, 1.6);
    b.decor.push({ type: 'antenna', pos: v3(s * 36, 12, -30), yaw: 0, params: { h: 5 } });
  }

  // =====================================================================
  // 屋根付きの空中連絡橋（10m）。両側は腰壁と柱、上に屋根。下にコア
  // =====================================================================
  const [bz0, bz1] = BRIDGE_Z;
  b.boxRange(-24, BRIDGE_Y - 0.8, bz0, 24, BRIDGE_Y, bz1, 'platform', { tag: 'bridgedeck', noWallrun: true });
  for (const z of [bz0, bz1 - 0.5]) b.boxRange(-24, BRIDGE_Y, z, 24, BRIDGE_Y + 1.1, z + 0.5, 'wall', { tag: 'parapet', vis: { bridge: true } });
  for (let x = -24; x <= 24; x += 8) {
    for (const z of [bz0 + 0.25, bz1 - 0.25]) b.boxRange(x - 0.3, BRIDGE_Y + 1.1, z - 0.25, x + 0.3, BRIDGE_Y + 3.6, z + 0.25, 'pillar', { tag: 'pier', noWallrun: true });
  }
  b.boxRange(-24.5, BRIDGE_Y + 3.6, bz0 - 0.6, 24.5, BRIDGE_Y + 4.1, bz1 + 0.6, 'platform', { tag: 'bridgedeck', noWallrun: true, vis: { roof: true } });
  // 橋脚（2本。コアの左右）
  for (const s of [-1, 1]) b.boxRange(s * 12 - 1.2, -0.5, -21.2, s * 12 + 1.2, BRIDGE_Y - 0.8, -18.8, 'pillar', { tag: 'pier' });

  // コア（エネルギー炉）と台座
  b.boxRange(CORE.x - 5, 0, CORE.z - 5, CORE.x + 5, 0.3, CORE.z + 5, 'platform', { tag: 'corepad', noWallrun: true });
  b.boxRange(CORE.x - 2, 0.3, CORE.z - 2, CORE.x + 2, 6.2, CORE.z + 2, 'block', { tag: 'core', noWallrun: true });

  // =====================================================================
  // 中央広場：コアのまわりの陣地、正面ゲートからの道、車両
  // =====================================================================
  // コアのまわりの土のう（四方。間は通れる）
  b.sandbags(-7.5, -12, 0, 4);
  b.sandbags(7.5, -12, 0, 4);
  b.sandbags(-7.5, -28, 0, 4);
  b.sandbags(7.5, -28, 0, 4);
  // 正面ゲートから広場への道の両わき：障害物・木箱・コンテナ（道の中央 x -5〜5 は空けておく。ボスが通る）
  b.barrierRow(-9, 32, -9, 24, 4);
  b.barrierRow(9, 32, 9, 24, 4);
  b.milContainer(-17, 0, 18, 0, 'olive');
  b.milContainer(-17, 2.6, 18, 0, 'olive');
  b.milContainer(17, 0, 12, 0, 'olive');
  b.crate(15, 0, 20, 1.2, 8);
  b.crate(16.3, 0, 20.4, 1.2, -6);
  b.crate(15.6, 1.2, 20.2, 1.2, 20);
  b.apc(-12, 6, 15);
  b.truck(13, -2, -10, 'cargo');
  b.barrierRow(-12, -4, -6, -4, 3);
  b.barrierRow(6, 10, 12, 10, 3);
  for (const [x, z] of [
    [-20, 30],
    [20, 30],
    [-20, -2],
    [20, -2],
    [0, 12],
  ])
    b.lightPole(x, z);
  // 道路の模様（黄色の線）
  b.decor.push({ type: 'marking', pos: v3(0, 0, 9), yaw: 0, size: v3(10, 0, 58), params: { style: 'road' } });
  b.decor.push({ type: 'marking', pos: v3(-37, 0, 18), yaw: 90, size: v3(8, 0, 44), params: { style: 'road' } });
  b.decor.push({ type: 'marking', pos: v3(37, 0, 17), yaw: 90, size: v3(8, 0, 44), params: { style: 'road' } });
  b.decor.push({ type: 'marking', pos: v3(0, 0, -38), yaw: 90, size: v3(40, 0, 12), params: { style: 'parking' } });
  b.decor.push({ type: 'marking', pos: v3(0, 0, -20), yaw: 0, size: v3(14, 0, 14), params: { style: 'hazard' } });

  // 北の車両置き場（両格納庫のあいだ）
  b.truck(-12, -40, 90, 'cargo');
  b.truck(-2, -42, 90, 'cargo');
  b.truck(10, -40, 90, 'tanker');
  b.apc(-14, -33, 90);
  b.apc(14, -32, -90);
  b.barrierRow(-18, -30, -18, -26, 2);
  b.barrierRow(18, -30, 18, -26, 2);
  b.lightPole(0, -32);

  // =====================================================================
  // 西の資材置き場（西門の内側）：コンテナの壁（壁走り）・燃料タンク
  // =====================================================================
  b.milContainer(-50, 0, 4, 90, 'olive');
  b.milContainer(-50, 2.6, 4, 90, 'olive');
  b.milContainer(-43.5, 0, 4, 90, 'tan');
  b.milContainer(-30, 0, 30, 0, 'olive');
  b.milContainer(-27.4, 0, 30, 0, 'olive');
  b.milContainer(-30, 2.6, 30, 0, 'tan');
  b.milContainer(-45, 0, 33, 90, 'olive');
  b.fuelTank(-52, 31, 2.6, 5);
  b.fuelTank(-52, 25.5, 2.6, 5);
  b.sandbags(-50, 14, 90, 3.5);
  b.sandbags(-50, 26, 90, 3.5);
  b.barrierRow(-40, 12, -40, 20, 4);
  b.crate(-34, 0, 10, 1.2, 10);
  b.crate(-35.3, 0, 10.4, 1.2, 0);
  b.crate(-34.6, 1.2, 10.2, 1.2, 25);
  b.truck(-24, 16, 0, 'cargo');
  b.lightPole(-44, 22);
  b.lightPole(-30, 4);

  // 西門の外：台地（防壁と崖のあいだ。北の草原から西門へ回り込む細い道でもある）
  b.rock(-70, 0, -30, 3, 2.2, 2.6, 20);
  b.rock(-72, 0, 2, 2.4, 1.6, 2, -30);
  b.rock(-70, 0, 66, 3, 2, 2.4, 40);
  b.barrier(-68, 10, 0);
  b.barrier(-68, 30, 0);
  b.sandbags(-69, -60, 90, 3.5);
  b.lightPole(-68, 20);
  b.lightPole(-68, -40);
  // 西の岩場（低地）：岩・崩れた壁（壁走りの足場）・コンテナ
  for (const [x, z, s, h, yaw] of [
    [-92, -40, 4, 3, 10],
    [-100, -18, 3, 2, 40],
    [-86, -6, 2.6, 1.8, -20],
    [-96, 40, 4, 2.8, 60],
    [-86, 52, 3, 2, 15],
    [-100, 64, 5, 3.4, -35],
    [-84, 34, 2.2, 1.4, 80],
    [-126, -12, 4, 3, 25],
    [-118, 92, 4.4, 3.2, -15],
    [-104, 104, 3, 2, 50],
    [-86, 84, 3.4, 2.4, 0],
    [-126, -72, 5, 3.6, 30],
    [-100, -84, 3.6, 2.4, -40],
    [-114, -58, 2.8, 1.8, 10],
  ])
    b.rock(x, LOW_Y, z, s, h, s * 0.8, yaw);
  b.ruin(-100, 32, -88, 33, 4, LOW_Y);
  b.ruin(-122, 0, -121, 14, 5, LOW_Y);
  b.ruin(-114, -40, -100, -39, 5, LOW_Y);
  b.ruin(-96, -70, -95, -56, 4, LOW_Y);
  b.ruin(-110, 80, -98, 81, 4.5, LOW_Y);
  b.stack(-112, 56, 0, 2, ['olive', 'tan'], LOW_Y);
  b.milContainer(-104, LOW_Y, 72, 90, 'tan');

  // =====================================================================
  // 東の荷役場（搬入口の内側）：積み降ろし台・トラック・コンテナ
  // =====================================================================
  // 積み降ろし台（1.4m。西の坂で上る。縁はよじ登れる）
  b.boxRange(46, -0.5, 26, 58, 1.4, 36, 'block', { tag: 'dock', noWallrun: true });
  b.ramp(v3(40, 0, 31), v3(46, 1.4, 31), 3.5, 0.6);
  b.truck(50, 20, 90, 'cargo');
  b.truck(44, 4, 0, 'cargo');
  b.milContainer(30, 0, 29, 90, 'olive');
  b.milContainer(36.5, 0, 29, 90, 'olive');
  b.milContainer(30, 2.6, 29, 90, 'tan');
  b.milContainer(54, 1.4, 31, 90, 'olive');
  b.barrierRow(34, 12, 34, 22, 5);
  b.sandbags(52, 8, 0, 3.5);
  b.crate(38, 0, -2, 1.2, 0);
  b.crate(39.3, 0, -2.3, 1.2, 15);
  b.lightPole(44, 14);
  b.lightPole(30, -2);
  // 搬入口のひさし（防壁の外にはみ出す屋根。上に乗れる）
  b.boxRange(WALL_X - 4, 6.4, DOCK_GATE[0] - 1, WALL_X + 9, 7, DOCK_GATE[1] + 1, 'platform', { tag: 'canopy', noWallrun: true });
  for (const z of [DOCK_GATE[0] - 0.6, DOCK_GATE[1] + 0.6]) b.boxRange(WALL_X + 8, -0.5, z - 0.3, WALL_X + 8.6, 6.4, z + 0.3, 'pillar', { tag: 'pier', noWallrun: true });
  b.decor.push({ type: 'gatesign', pos: v3(WALL_X + 9.1, 5.6, (DOCK_GATE[0] + DOCK_GATE[1]) / 2), yaw: 90, size: v3(8, 1.1, 0.1), params: { text: 'LOADING BAY 3', sub: '搬入口' } });

  // =====================================================================
  // 要塞の外：南の草原（正面ゲートへの道）・東の草原・北の草原
  // 敵の降下ポッドが降りてくる。前哨陣地・コンテナ置き場・見張り台が、壁走りの足場と遮蔽物になる
  // =====================================================================
  // 南：道の両わきの岩・古い障害物（道の中央 x -5〜5 は空けておく。大型兵器が通る）
  for (const [x, z, s, h, yaw] of [
    [-34, 58, 4, 2.4, 30],
    [-46, 70, 3, 2, -10],
    [-20, 76, 3.4, 2.2, 50],
    [26, 62, 4.4, 2.8, -25],
    [52, 66, 3, 1.8, 10],
    [62, 56, 3.6, 2.4, 70],
    [-62, 62, 3, 2.2, 0],
    [-58, 98, 4, 2.6, 20],
    [-30, 110, 3.4, 2.2, -30],
    [30, 110, 4, 2.8, 15],
    [92, 104, 3.6, 2.4, 60],
    [110, 86, 3, 2, -10],
    [-66, 86, 3.2, 2.2, 45],
  ])
    b.rock(x, 0, z, s, h, s * 0.8, yaw);
  b.barrierRow(-14, 52, -8, 52, 3);
  b.barrierRow(8, 60, 14, 60, 3);
  b.barrierRow(10, 104, 20, 104, 4);
  b.barrierRow(-20, 108, -10, 108, 4);
  b.decor.push({ type: 'marking', pos: v3(0, 0, 78), yaw: 0, size: v3(10, 0, 76), params: { style: 'dirtroad' } });
  // 南西の前哨陣地（中に入れる。屋上へは東の階段）と、まわりのコンテナの壁
  b.outpost(-40, 70, -28, 78, 'outpost_sw', ['s', 'n'], 'e');
  b.sandbags(-34, 82, 0, 4);
  b.sandbags(-34, 66, 0, 4);
  b.stack(-52, 64, 0, 2);
  b.stack(-58, 70, 0, 1, ['tan']);
  b.lightPole(-24, 70);
  // 通信塔（高いアンテナ）
  b.boxRange(-24, -0.5, 98, -20, 1.2, 102, 'block', { tag: 'dock', noWallrun: true });
  b.decor.push({ type: 'antenna', pos: v3(-22, 1.2, 100), yaw: 0, params: { h: 18 } });
  // 壊れた車両（遮蔽物）
  b.apc(-15, 72, 25);
  b.truck(16, 92, -35, 'tanker');
  b.truck(-12, 90, 160, 'cargo');
  // 南東のコンテナ置き場（2段に積んだ列のあいだが路地になる。壁走りで抜けられる）
  b.stack(31, 72, 90, 2);
  b.stack(37.3, 72, 90, 1, ['tan']);
  b.stack(34, 80, 90, 1);
  b.stack(40.3, 80, 90, 2, ['tan', 'olive']);
  b.stack(31, 88, 90, 1, ['tan']);
  b.stack(37.3, 88, 90, 2);
  b.stack(43.6, 88, 90, 1);
  b.stack(36, 96, 90, 1, ['tan']);
  b.lightPole(48, 80);
  // 南東の見張り台（9m。西の面のコンテナの階段から上る）
  b.lookout(74, 102, 6, 9, 'out_se');

  // 東：搬入口へ続く道・前哨陣地・燃料の集積所・コンテナ置き場
  for (const [x, z, s, h, yaw] of [
    [84, -20, 3.4, 2.2, 15],
    [92, 44, 4, 2.6, -40],
    [78, 50, 2.6, 1.6, 30],
    [88, -40, 4.6, 3, 5],
    [124, -84, 4, 3, 20],
    [120, 96, 4, 2.6, 30],
    [128, 40, 3, 2, -20],
  ])
    b.rock(x, 0, z, s, h, s * 0.8, yaw);
  b.barrierRow(76, 8, 76, 14, 3);
  b.barrierRow(96, 24, 96, 30, 3);
  b.decor.push({ type: 'marking', pos: v3(97, 0, 17), yaw: 90, size: v3(8, 0, 70), params: { style: 'dirtroad' } });
  b.outpost(100, -12, 112, -4, 'outpost_e', ['w', 's'], 'n');
  b.sandbags(96, -2, 90, 3.5);
  b.fuelTank(100, -48, 3.2, 6);
  b.fuelTank(108, -40, 3.2, 6);
  b.fuelTank(98, -36, 2.6, 5);
  b.sandbags(94, -46, 90, 4);
  b.lightPole(104, -30);
  b.stack(96, 54, 0, 2);
  b.stack(102, 58, 0, 1, ['tan']);
  b.stack(108, 50, 0, 2, ['tan', 'olive']);
  b.milContainer(102, 0, 44, 90, 'olive');
  b.truck(86, 30, 20, 'cargo');
  b.lookout(118, -64, 6, 9, 'out_ne');

  // 北：防壁の外の草原（北の草原に降りた敵は、西の台地か東の草原を回って門へ来る）
  for (const [x, z, s, h, yaw] of [
    [-40, -58, 3, 2, 20],
    [10, -57, 3.6, 2.2, -15],
    [48, -58, 2.6, 1.6, 40],
    [-60, -82, 4, 2.6, 30],
    [-10, -88, 3, 2, 10],
    [80, -86, 4, 2.8, -20],
    [30, -64, 2.6, 1.6, 0],
    [72, -60, 3, 2, 50],
  ])
    b.rock(x, 0, z, s, h, s * 0.8, yaw);
  // 草原の土の地面と、砲弾の跡（見た目だけ）
  for (const [x, z, r] of [
    [-34, 74, 9],
    [37, 84, 13],
    [-52, 66, 6],
    [106, -8, 8],
    [102, -42, 10],
    [102, 52, 9],
    [15, -78, 8],
    [-30, -74, 7],
    [54, -72, 6],
    [74, 102, 6],
    [118, -64, 6],
    [0, 104, 9],
    [124, 14, 8],
  ])
    b.dirt(x, z, r);
  for (const [x, z, r] of [
    [-26, 88, 2.4],
    [-8, 70, 1.8],
    [22, 54, 2.2],
    [54, 100, 2.6],
    [-50, 104, 2],
    [84, 30, 2.4],
    [116, -20, 2],
    [88, -64, 2.6],
    [-14, -76, 2.2],
    [40, -60, 1.8],
    [-56, -66, 2.4],
  ])
    b.crater(x, z, r);
  for (const [x, z, r] of [
    [-110, 40, 8],
    [-118, -24, 9],
    [-104, 76, 6],
    [-122, 68, 7],
  ])
    b.dirt(x, z, r, LOW_Y);
  b.crater(-96, 2, 2.4, LOW_Y);
  b.crater(-112, -52, 2, LOW_Y);

  // 砲撃陣地（迫撃砲兵が上って、コアへ砲撃する台。坂で上れる）
  // （坂の中心を経路の点の並び（2.5m 間隔）に合わせる：坂の端に点があると、歩く敵が坂から落ちる）
  b.emplacement(55, 47.5, 'w');
  b.emplacement(92.5, -15, 'w');
  b.emplacement(-70, 45, 'n');
  b.emplacement(-67.5, -70, 'e');

  // 北の通信所（前哨陣地。屋上にレーダー）
  b.outpost(8, -82, 22, -74, 'outpost_n', ['s', 'w'], 'e');
  b.decor.push({ type: 'radar', pos: v3(13, 3.5, -78), yaw: 0, params: { r: 2.2 } });
  b.stack(-30, -70, 90, 2);
  b.stack(-23.7, -70, 90, 1, ['tan']);
  b.stack(-34, -84, 0, 1);
  b.stack(52, -76, 0, 2, ['tan', 'olive']);
  b.stack(58, -68, 90, 1);
  b.lightPole(0, -66);

  // =====================================================================
  // 出現地点（プレイヤー・味方。要塞の中で復活する）
  // =====================================================================
  for (const [x, z, yaw] of [
    [-6, -6, SOUTH],
    [6, -6, SOUTH],
    [-6, -34, NORTH],
    [6, -34, NORTH],
    [-16, -14, SOUTH],
    [16, -14, SOUTH],
    [-18, -30, NORTH],
    [18, -30, NORTH],
  ])
    b.spawns.push({ team: 0, pos: v3(x, 0.05, z), yaw });

  // =====================================================================
  // ボット用の特別な移動（壁走り・飛び降り）
  // =====================================================================
  const links: NavLinkDef[] = [
    // 防壁の上から外へ・中へ飛び降りる（7m）
    { kind: 'drop', from: v3(-20, WALL_H, WALL_S - 1.5), to: v3(-20, 0, WALL_S - 5), note: '南の防壁 → 中' },
    { kind: 'drop', from: v3(20, WALL_H, WALL_S - 1.5), to: v3(20, 0, WALL_S - 5), note: '南の防壁 → 中' },
    // 連絡橋から広場へ（10m）
    { kind: 'drop', from: v3(-6, BRIDGE_Y, bz1 - 1.5), to: v3(-6, 0, bz1 + 3), note: '橋 → 広場' },
    { kind: 'drop', from: v3(6, BRIDGE_Y, bz0 + 1.5), to: v3(6, 0, bz0 - 3), note: '橋 → 北' },
    // テラスから広場へ（5m）
    { kind: 'drop', from: v3(-38, 5, -11), to: v3(-38, 0, -2), note: 'テラス → 広場' },
    { kind: 'drop', from: v3(38, 5, -11), to: v3(38, 0, -2), note: 'テラス → 広場' },
  ];
  b.navLinks.push(...links);

  // =====================================================================
  // タワーディフェンスの情報：侵入ルート・推奨設置ポイント
  // =====================================================================
  const routes: TdRouteDef[] = [
    {
      id: 'front',
      name: '正面ゲート',
      spawn: { center: v3(0, 0, 106), radius: 7 },
      path: [v3(0, 0, 94), v3(0, 0, 80), v3(0, 0, 66), v3(0, 0, 48), v3(0, 0, 34), v3(0, 0, 14), v3(0, 0, -6)],
      gate: v3(0, 0, WALL_S),
      turretPoints: [v3(-12, 0, 30), v3(12, 0, 30), v3(-8, 0, 15), v3(8, 0, 16), v3(-21, 0, 24), v3(21, 0, 22)],
      droneAltitude: 18,
      bossOk: true,
    },
    {
      id: 'left',
      name: '左の坂道',
      spawn: { center: v3(-124, LOW_Y, 66), radius: 5 },
      path: [v3(-120, LOW_Y, 48), v3(-110, LOW_Y, 28), v3(-103, LOW_Y, 20), v3(-90, -3.6, 20), v3(-80, -0.8, 20), v3(-66, 0, 20), v3(-54, 0, 20), v3(-38, 0, 24), v3(-22, 0, 4), v3(-6, 0, -8)],
      gate: v3(-WALL_X, 0, (WEST_GATE[0] + WEST_GATE[1]) / 2),
      turretPoints: [v3(-46, 0, 14), v3(-46, 0, 27), v3(-36, 0, 26), v3(-28, 0, 22), v3(-30, 0, 10), v3(-40, 0, 2)],
      droneAltitude: 20,
      bossOk: false,
    },
    {
      id: 'right',
      name: '右の搬入口',
      spawn: { center: v3(124, 0, 12), radius: 6 },
      path: [v3(112, 0, 17), v3(86, 0, 17), v3(70, 0, 17), v3(56, 0, 17), v3(42, 0, 16), v3(24, 0, 6), v3(6, 0, -8)],
      gate: v3(WALL_X, 0, (DOCK_GATE[0] + DOCK_GATE[1]) / 2),
      turretPoints: [v3(48, 0, 12), v3(40, 0, 22), v3(30, 0, 20), v3(28, 0, 8), v3(40, 0, 6), v3(50, 1.4, 30)],
      droneAltitude: 19,
      bossOk: true,
    },
  ];

  // =====================================================================
  // 降下ポッドの降りる場所（仕様 5.3.3）
  //   外（outer）：要塞の外の草原・岩場。join があれば、その方面のルートの道すじに合流する
  //   高い所（wall）：防壁の上・屋上・テラス。飛び降りて中へ入ってくる
  //   中（inner）：要塞の中の、コアから離れた所（中庭・資材置き場・荷役場）
  // =====================================================================
  const dropZones: TdDropZone[] = [
    // 正面（南）
    { id: 'south_far', name: '南の草原', sector: 'front', kind: 'outer', center: v3(0, 0, 104), radius: 8, join: 0 },
    { id: 'south_west', name: '南西の草原', sector: 'front', kind: 'outer', center: v3(-44, 0, 92), radius: 7, via: [v3(-20, 0, 70)], join: 4 },
    { id: 'south_east', name: '南東の草原', sector: 'front', kind: 'outer', center: v3(60, 0, 88), radius: 7, via: [v3(22, 0, 62)], join: 4 },
    { id: 'wall_sw', name: '南の防壁（西）', sector: 'front', kind: 'wall', center: v3(-34, WALL_H, 38.2), radius: 6 },
    { id: 'wall_se', name: '南の防壁（東）', sector: 'front', kind: 'wall', center: v3(34, WALL_H, 38.2), radius: 6 },
    { id: 'yard_sw', name: '正面ゲートの内側（西）', sector: 'front', kind: 'inner', center: v3(-22, 0, 28), radius: 4 },
    { id: 'yard_se', name: '正面ゲートの内側（東）', sector: 'front', kind: 'inner', center: v3(25, 0, 22), radius: 4 },
    // 左（西）
    { id: 'west_far', name: '西の岩場', sector: 'left', kind: 'outer', center: v3(-122, LOW_Y, 68), radius: 7, join: 0 },
    { id: 'west_low_n', name: '北西の岩場', sector: 'left', kind: 'outer', center: v3(-110, LOW_Y, -24), radius: 8, via: [v3(-108, LOW_Y, 6)], join: 3 },
    { id: 'north_west', name: '北の草原（西）', sector: 'left', kind: 'outer', center: v3(-46, 0, -76), radius: 7, via: [v3(-68, 0, -62), v3(-69, 0, -20), v3(-68, 0, 8)], join: 5 },
    { id: 'wall_w', name: '西の防壁', sector: 'left', kind: 'wall', center: v3(-60.2, WALL_H, -4), radius: 6 },
    { id: 'wall_nw', name: '北の防壁（西）', sector: 'left', kind: 'wall', center: v3(-12, WALL_H, -48.2), radius: 5 },
    { id: 'roof_w', name: '西の格納庫の屋上', sector: 'left', kind: 'wall', center: v3(-44, 12, -36), radius: 6 },
    { id: 'terrace_w', name: '西のテラス', sector: 'left', kind: 'wall', center: v3(-47, 5, -18), radius: 4 },
    { id: 'yard_w', name: '西の資材置き場', sector: 'left', kind: 'inner', center: v3(-36, 0, 18), radius: 4 },
    // 右（東）
    { id: 'east_far', name: '東の草原', sector: 'right', kind: 'outer', center: v3(124, 0, 14), radius: 7, join: 0 },
    { id: 'east_north', name: '北東の草原', sector: 'right', kind: 'outer', center: v3(104, 0, -72), radius: 7, via: [v3(90, 0, -20)], join: 2 },
    { id: 'east_south', name: '南東の草原（東）', sector: 'right', kind: 'outer', center: v3(104, 0, 74), radius: 7, via: [v3(92, 0, 40)], join: 2 },
    { id: 'north_east', name: '北の草原（東）', sector: 'right', kind: 'outer', center: v3(38, 0, -80), radius: 7, via: [v3(72, 0, -66), v3(80, 0, -24)], join: 2 },
    { id: 'wall_e', name: '東の防壁', sector: 'right', kind: 'wall', center: v3(60.2, WALL_H, -4), radius: 6 },
    { id: 'wall_ne', name: '北の防壁（東）', sector: 'right', kind: 'wall', center: v3(12, WALL_H, -48.2), radius: 5 },
    { id: 'roof_e', name: '東の格納庫の屋上', sector: 'right', kind: 'wall', center: v3(44, 12, -36), radius: 6 },
    { id: 'terrace_e', name: '東のテラス', sector: 'right', kind: 'wall', center: v3(47, 5, -18), radius: 4 },
    { id: 'dock', name: '東の荷役場', sector: 'right', kind: 'inner', center: v3(42, 0, 16), radius: 4 },
  ];

  // =====================================================================
  // 迫撃砲兵が上って砲撃する所（少し高い所。外：前哨陣地の屋上・砲撃陣地、中：テラス・防壁の上・荷役場の台）
  // =====================================================================
  const spot = (x: number, y: number, z: number, area: 'outer' | 'inner', name: string): TdMortarSpot => ({ pos: v3(x, y, z), area, name });
  const mortarSpots: TdMortarSpot[] = [
    spot(-37, 3.5, 73.5, 'outer', '南西の前哨陣地'),
    spot(-31, 3.5, 75.5, 'outer', '南西の前哨陣地'),
    spot(54.2, 2.4, 46.7, 'outer', '南東の砲撃陣地'),
    spot(55.8, 2.4, 48.3, 'outer', '南東の砲撃陣地'),
    spot(103, 3.5, -8, 'outer', '東の前哨陣地'),
    spot(109, 3.5, -8, 'outer', '東の前哨陣地'),
    spot(91.7, 2.4, -15.8, 'outer', '東の砲撃陣地'),
    spot(93.3, 2.4, -14.2, 'outer', '東の砲撃陣地'),
    spot(17, 3.5, -76, 'outer', '北の通信所'),
    spot(20, 3.5, -79.5, 'outer', '北の通信所'),
    spot(-70.8, 2.4, 44.2, 'outer', '西の砲撃陣地'),
    spot(-69.2, 2.4, 45.8, 'outer', '西の砲撃陣地'),
    spot(-68.3, 2.4, -70.8, 'outer', '北西の砲撃陣地'),
    spot(-66.7, 2.4, -69.2, 'outer', '北西の砲撃陣地'),
    spot(-49, 5, -20, 'inner', '西のテラス'),
    spot(-44, 5, -14, 'inner', '西のテラス'),
    spot(49, 5, -20, 'inner', '東のテラス'),
    spot(44, 5, -14, 'inner', '東のテラス'),
    spot(-38, WALL_H, 38.2, 'inner', '南の防壁（西）'),
    spot(38, WALL_H, 38.2, 'inner', '南の防壁（東）'),
    spot(-60.2, WALL_H, -20, 'inner', '西の防壁'),
    spot(60.2, WALL_H, -20, 'inner', '東の防壁'),
    spot(49, 1.4, 34.5, 'inner', '東の荷役場の台'),
  ];

  return {
    name: '軍事要塞',
    boxes: b.boxes,
    labels: b.labels,
    targets: [],
    // 要塞の中のほか、外の前哨陣地の中にも弾薬補給所がある
    ammoStations: [v3(-10, 0, -12), v3(10, 0, -28), v3(-44, 0, 18), v3(44, 0, 12), v3(-10, 0, 26), v3(-34, 0, 74), v3(106, 0, -8), v3(15, 0, -78)],
    spawn: v3(0, 0.05, -8),
    spawnYaw: SOUTH,
    killY: -30,
    style: 'fortress',
    visual: 'fortress',
    decor: b.decor,
    spawns: b.spawns,
    navLinks: b.navLinks,
    bounds: { min: v3(PX0, LOW_Y - 6, PZ0), max: v3(PX1, 25, PZ1) },
    td: {
      core: CORE,
      routes,
      buildArea: { min: v3(-WALL_X + WALL_T, -1, WALL_N + WALL_T), max: v3(WALL_X - WALL_T, 13, WALL_S - WALL_T) },
      droneHover: [v3(0, 4.5, -8), v3(-8, 5, -9), v3(8, 5, -9), v3(0, 4.5, -32), v3(-8, 5, -31), v3(8, 5, -31)],
      dropZones,
      mortarSpots,
    },
  };
}

/** コアの位置（ほかのファイルから使う） */
export const FORTRESS_CORE: Vec3 = CORE;
