/**
 * ステージ（地形）のデータ形式。
 * 同じデータから、ゲームロジック用の当たり判定（shared）と見た目（client）の両方を作る。
 */
import { CollisionWorld, makeBox } from './collision';
import type { TargetDef } from './targets';
import type { CourseDef } from './timeAttack';
import { type Vec3, DEG, dot, len, lenH, mat3FromEulerYXZ, mat3MulVec, sub, v3 } from './math';

export type SurfaceKind = 'floor' | 'wall' | 'platform' | 'ramp' | 'block' | 'pillar' | 'boundary' | 'prop';

/**
 * 見た目の種類（マップの見た目を Blender で作るときの手がかり）。
 * テスト部屋では使わない（kind の色で描く）。
 */
export type BoxTag =
  | 'building' // 中に入れない建物（屋上が足場）
  | 'deck' // 橋・通路の床
  | 'glass' // スカイブリッジのガラスの壁（外側で壁走りできる）
  | 'roof' // スカイブリッジの屋根
  | 'billboard' // ホログラム看板（壁走りできる面）
  | 'rail' // 手すり
  | 'stairs' // 階段の1段
  | 'ramp' // 坂（見た目は階段にする）
  | 'container' // 貨物コンテナ
  | 'ac' // 空調ユニット
  | 'crate' // 木箱・物資
  | 'planter' // 植え込み・桜の台座
  | 'trunk' // 桜の幹
  | 'kiosk' // 小さな建物（売店）
  | 'plaza' // 中央の円形広場
  | 'wall' // 低い壁・遮蔽物
  | 'tower' // 飾りの高層部分（上には行けない）
  | 'barrier' // 見えない壁（マップの外へ出ないように）
  | 'ground' // 地面（道路・歩道）
  | 'shell' // 中に入れる建物の外壁（開口つき）
  | 'slab' // 建物の中の床・屋上の板
  | 'furniture' // 室内の家具（ゲーム機・棚・カウンター）
  | 'pillar' // 柱
  | 'car' // 駐車している車
  | 'course' // タイムアタックのコース用の足場・壁（ホログラムで描く）
  // --- 軍事要塞 ---
  | 'fortwall' // 要塞の防壁（上を歩ける）
  | 'parapet' // 防壁・塔・屋上の縁の胸壁
  | 'watchtower' // 見張り塔の本体
  | 'cabin' // 見張り塔の上の小屋（屋根・柱）
  | 'hangar' // 格納庫・建物（コンクリート）
  | 'truck' // 軍用トラック
  | 'apc' // 装甲車
  | 'barrier' // コンクリートの障害物（ジャージー壁）
  | 'sandbag' // 土のう
  | 'fueltank' // 燃料タンク
  | 'canopy' // 搬入口のひさし
  | 'dock' // 荷物の積み降ろし台
  | 'cliff' // 崖（擁壁）
  | 'rock' // 岩
  | 'corepad' // コアの台座
  | 'core' // コア（エネルギー炉）
  | 'bridgedeck' // 屋根付きの空中連絡橋の床・屋根
  | 'pier' // 連絡橋の橋脚
  | 'ruin'; // 崩れたコンクリートの壁（要塞の外。壁走りの足場）

export interface BoxDef {
  center: Vec3;
  size: Vec3;
  /** 回転（度、Y→X→Z の順） */
  rot?: Vec3;
  kind: SurfaceKind;
  /** 壁走りできない面にする */
  noWallrun?: boolean;
  /** 見た目の種類 */
  tag?: BoxTag;
  /** 見た目の細かい指定（色・看板の番号など） */
  vis?: Record<string, string | number | boolean>;
}

/** 当たり判定のない飾り（看板・照明・木など）。見た目だけに使う */
export interface DecorDef {
  type: string;
  pos: Vec3;
  /** 向き（度。0 で +Z を向く） */
  yaw: number;
  size?: Vec3;
  params?: Record<string, string | number | boolean>;
}

/** チームの出現地点。yaw は視線の向き（ラジアン。0 で -Z を向く） */
export interface SpawnDef {
  team: 0 | 1;
  pos: Vec3;
  yaw: number;
  /**
   * 試合の途中の復活に使う、マップの中の出現地点（true）。
   * false・なしは試合開始の出現地点（チームの陣地）。消耗戦では、敵から離れた地点を全部の中から選ぶ
   */
  field?: boolean;
}

/**
 * ボット用の経路のうち、自動では見つけられない特別な移動（壁走り・飛び移り・飛び降り）。
 * 歩いて行ける経路は、地形から自動で作る（shared/nav.ts）。
 */
export type NavLinkKind = 'walk' | 'jump' | 'drop' | 'wallrun';
export interface NavLinkDef {
  kind: NavLinkKind;
  from: Vec3;
  to: Vec3;
  /** 壁走りで使う壁の面上の点（壁走りのとき） */
  via?: Vec3;
  /** 逆向きにも通れる */
  both?: boolean;
  note?: string;
}

export interface HazardDef {
  min: Vec3;
  max: Vec3;
  /** 1秒あたりのダメージ */
  dps: number;
}

export interface LabelDef {
  text: string;
  sub?: string;
  pos: Vec3;
  /** 看板の向き（度。0 で +Z 方向＝スタート地点側を向く） */
  yaw: number;
  color?: string;
}

/** タワーディフェンスの侵入ルート（仕様 5.3.3：正面ゲート・左の坂道・右の搬入口） */
export type TdRouteId = 'front' | 'left' | 'right';

/**
 * from から to へ放物線で飛ばすための初速（重力 g。迫撃砲の弾など）。
 * 頂点は高い方の端より apex だけ上。飛んでいる時間も返す
 */
export function ballisticLaunch(from: Vec3, to: Vec3, apex: number, g: number): { vel: Vec3; time: number } {
  const top = Math.max(from.y, to.y) + apex;
  const up = Math.sqrt(2 * g * (top - from.y));
  const t1 = up / g;
  const t2 = Math.sqrt((2 * (top - to.y)) / g);
  const time = t1 + t2;
  const dx = to.x - from.x,
    dz = to.z - from.z;
  return { vel: v3(dx / time, up, dz / time), time };
}

export interface TdRouteDef {
  id: TdRouteId;
  name: string;
  /** 敵が湧く範囲（中心と半径。地面の高さは中心の y） */
  spawn: { center: Vec3; radius: number };
  /** 湧いた所からコアまでの道すじ（地上の敵はこの順に通る。最後はコアの近く） */
  path: Vec3[];
  /** 要塞への入り口（HUD・地図の目印） */
  gate: Vec3;
  /** ボットがタレットを置く候補地点（推奨設置ポイント。仕様 6.2：各ルート5〜6か所） */
  turretPoints: Vec3[];
  /** ドローンが飛ぶ高さ（要塞の外から壁を越えてくる） */
  droneAltitude: number;
  /** ボス（大型兵器）が通れるか（道が広い） */
  bossOk: boolean;
}

/**
 * 降下ポッドの降りる場所の種類（仕様 5.3.3）
 *   outer … 要塞の外の草原・岩場（遠い。歩いて門から入ってくる）
 *   wall  … 防壁の上・建物の屋上（高い所から飛び降りて中へ入ってくる）
 *   inner … 要塞の中（コアから離れた中庭・資材置き場など）
 */
export type TdDropKind = 'outer' | 'wall' | 'inner';

/** 降下ポッドの降りる場所 */
export interface TdDropZone {
  id: string;
  /** 画面に出す名前（「西の防壁」など） */
  name: string;
  /** どのルートの方面か（味方ボットの持ち場・案内の色分けに使う） */
  sector: TdRouteId;
  kind: TdDropKind;
  /** 中心（y は降りる床の高さ） */
  center: Vec3;
  /** この半径の中の、同じ高さの床に降りる */
  radius: number;
  /** 降りた敵が合流する、その方面のルートの道すじの点の番号（なければ、まっすぐコアへ向かう） */
  join?: number;
  /** 合流するまでに通る点（北の草原から台地を回り込む、など） */
  via?: Vec3[];
}

/** 迫撃砲兵が上って砲撃する所（少し高い所） */
export interface TdMortarSpot {
  /** 立つ所（床の上） */
  pos: Vec3;
  /** outer：要塞の外（外に降りた迫撃砲兵が使う）。inner：要塞の中・防壁の上（防壁の上・中に降りた迫撃砲兵が使う） */
  area: 'outer' | 'inner';
  /** 画面に出す名前 */
  name: string;
}

/** タワーディフェンス用のマップの情報 */
export interface TdLevelDef {
  /** コア（エネルギー炉）の足元の中心 */
  core: Vec3;
  routes: TdRouteDef[];
  /** タレットを置ける範囲（要塞の中） */
  buildArea: { min: Vec3; max: Vec3 };
  /** ドローンがコアを撃つときに浮かぶ場所（コアのまわりの、上が開けた所） */
  droneHover: Vec3[];
  /** 降下ポッドの降りる場所（歩兵・爆弾兵・重装兵・迫撃砲兵はポッドで降りてくる） */
  dropZones: TdDropZone[];
  /** 迫撃砲兵が砲撃する所 */
  mortarSpots: TdMortarSpot[];
}

export interface LevelData {
  name: string;
  boxes: BoxDef[];
  labels: LabelDef[];
  /** 射撃の的 */
  targets?: TargetDef[];
  /** 弾薬補給所（触れると弾薬が満タンになる） */
  ammoStations?: Vec3[];
  /** ダメージ床（上にいる間ダメージを受ける。体力の回復を試す用） */
  hazards?: HazardDef[];
  spawn: Vec3;
  spawnYaw: number;
  killY: number;
  /** 見た目の作り方。testroom＝箱を色分けして描く、neon・fortress＝Blender で作ったマップの見た目を読み込む */
  style?: 'testroom' | 'neon' | 'fortress';
  /** 見た目のモデルの名前（client/assets/maps/<visual>.glb） */
  visual?: string;
  decor?: DecorDef[];
  spawns?: SpawnDef[];
  navLinks?: NavLinkDef[];
  /** プレイできる範囲（ボットの経路づくりなどに使う） */
  bounds?: { min: Vec3; max: Vec3 };
  /** タイムアタックのコース（タイムアタックのときだけ） */
  course?: CourseDef;
  /** タワーディフェンスの情報（軍事要塞） */
  td?: TdLevelDef;
}

export function buildCollisionWorld(level: LevelData): CollisionWorld {
  const world = new CollisionWorld();
  level.boxes.forEach((b, i) => world.add(makeBox(i, b.center, b.size, b.rot ?? v3(), b.noWallrun ?? false)));
  return world;
}

// ---------------------------------------------------------------------------
// ステージを組み立てるための小道具
// ---------------------------------------------------------------------------

export class LevelBuilder {
  boxes: BoxDef[] = [];
  labels: LabelDef[] = [];
  targets: TargetDef[] = [];
  ammoStations: Vec3[] = [];
  hazards: HazardDef[] = [];
  decor: DecorDef[] = [];
  spawns: SpawnDef[] = [];
  navLinks: NavLinkDef[] = [];

  target(x: number, y: number, z: number, yaw = 0, moveTo?: Vec3, speed?: number) {
    this.targets.push({ pos: v3(x, y, z), yaw, moveTo, speed });
    return this;
  }

  /** プレイヤーを撃ってくる訓練用タレット */
  turret(x: number, y: number, z: number, yaw = 0) {
    this.targets.push({ kind: 'turret', pos: v3(x, y, z), yaw });
    return this;
  }

  /** 上面の中心と大きさで箱を置く（床・台の配置がわかりやすいように「上面の高さ」で指定する） */
  boxTop(x: number, topY: number, z: number, sx: number, sy: number, sz: number, kind: SurfaceKind, extra: Partial<BoxDef> = {}) {
    this.boxes.push({ center: v3(x, topY - sy / 2, z), size: v3(sx, sy, sz), kind, ...extra });
    return this;
  }

  /** 範囲（最小・最大座標）で箱を置く */
  boxRange(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, kind: SurfaceKind, extra: Partial<BoxDef> = {}) {
    this.boxes.push({
      center: v3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2),
      size: v3(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)),
      kind,
      ...extra,
    });
    return this;
  }

  /** 中心・大きさ・水平の回転角で箱を置く（斜めの壁など） */
  boxRotY(x: number, y: number, z: number, sx: number, sy: number, sz: number, yawDeg: number, kind: SurfaceKind, extra: Partial<BoxDef> = {}) {
    this.boxes.push({ center: v3(x, y, z), size: v3(sx, sy, sz), rot: v3(0, yawDeg, 0), kind, ...extra });
    return this;
  }

  /** from から to へ上る坂（上面が from と to を通る）。厚み thick、幅 width */
  ramp(from: Vec3, to: Vec3, width: number, thick = 0.6, kind: SurfaceKind = 'ramp') {
    const d = sub(to, from);
    const h = lenH(d);
    const yaw = Math.atan2(-d.x, -d.z) / DEG;
    const pitch = Math.atan2(d.y, h) / DEG;
    const length = len(d);
    const rot = mat3FromEulerYXZ(pitch, yaw, 0);
    const n = mat3MulVec(rot, v3(0, 1, 0));
    const mid = v3((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
    this.boxes.push({
      center: v3(mid.x - (n.x * thick) / 2, mid.y - (n.y * thick) / 2, mid.z - (n.z * thick) / 2),
      size: v3(width, thick, length),
      rot: v3(pitch, yaw, 0),
      kind,
      noWallrun: true,
      tag: 'ramp',
    });
    // 坂の上面の法線が上を向いていることを確認（組み立てミスの検出用）
    if (dot(n, v3(0, 1, 0)) <= 0) throw new Error('ramp normal points down');
    return this;
  }

  /** 階段。from（1段目の手前の床）から dir 方向へ steps 段 */
  stairs(x: number, z: number, dirYawDeg: number, steps: number, rise: number, run: number, width: number, baseY = 0) {
    const fx = -Math.sin(dirYawDeg * DEG),
      fz = -Math.cos(dirYawDeg * DEG);
    for (let i = 0; i < steps; i++) {
      const top = baseY + rise * (i + 1);
      const cx = x + fx * run * (i + 0.5),
        cz = z + fz * run * (i + 0.5);
      this.boxes.push({
        center: v3(cx, (baseY + top) / 2 - 0.5, cz),
        size: v3(width, top - baseY + 1, run),
        rot: v3(0, dirYawDeg, 0),
        kind: 'platform',
        noWallrun: true,
        tag: 'stairs',
        vis: { step: i, steps, rise, run },
      });
    }
    return this;
  }

  label(text: string, x: number, y: number, z: number, yaw: number, sub?: string, color?: string) {
    this.labels.push({ text, sub, pos: v3(x, y, z), yaw, color });
    return this;
  }
}
