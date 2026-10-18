/**
 * タワーディフェンスの敵・タレット・コアの形（当たり判定）と大きさ。
 * 位置は足元から、向き 0（-Z が正面）のときの値。
 */
import type { TurretType } from '../../config';
import type { BodyDef } from '../hitbox';
import { v3 } from '../math';

/** 重装兵：胴と頭、正面に大きな盾（弾を止める）、背中の弱点（動力パック） */
export const HEAVY_BODY: BodyDef = {
  parts: [
    { kind: 'box', c: v3(-0.22, 0.95, -0.45), half: v3(0.41, 0.8, 0.09), block: true }, // 盾（足元〜1.75m・左寄り・幅 0.82m。銃は右の外。モデルの盾に合わせる）
    { kind: 'capsule', c: v3(0, 1.0, 0), r: 0.48, hh: 0.42 }, // 胴（上端 1.9m。頭は上にのぞく）
    { kind: 'sphere', c: v3(0, 1.96, -0.05), r: 0.27, crit: true }, // 頭（盾の上からのぞく）
    { kind: 'box', c: v3(0, 1.3, 0.42), half: v3(0.36, 0.36, 0.14), crit: true }, // 背中の動力パック（弱点）
  ],
  aim: v3(0, 1.2, 0),
  critAim: v3(0, 1.96, -0.05),
  radius: 1.5,
  centerY: 1.1,
};
export const HEAVY_HEIGHT = 2.25;

/** ドローン：丸い胴・4本の腕と回転翼・正面の目（弱点） */
export const DRONE_BODY: BodyDef = {
  parts: [
    { kind: 'sphere', c: v3(0, 0, 0), r: 0.62 },
    { kind: 'box', c: v3(0, 0.2, 0), half: v3(1.05, 0.1, 1.05) },
    { kind: 'sphere', c: v3(0, -0.05, -0.55), r: 0.22, crit: true },
  ],
  aim: v3(0, 0, 0),
  critAim: v3(0, -0.05, -0.55),
  radius: 1.7,
  centerY: 0,
};
/** ドローンの位置は胴の中心（足元ではない） */
export const DRONE_HEIGHT = 0.8;

/**
 * 大型兵器（ボス）：二本足の歩行兵器。高さ約 7.5m。
 * 弱点は背中の炉心（光る球）と、操縦席の正面のセンサー
 */
export const BOSS_BODY: BodyDef = {
  parts: [
    { kind: 'box', c: v3(-1.7, 1.9, 0), half: v3(0.55, 1.9, 0.7) }, // 左足
    { kind: 'box', c: v3(1.7, 1.9, 0), half: v3(0.55, 1.9, 0.7) }, // 右足
    { kind: 'box', c: v3(0, 4.1, 0), half: v3(2.1, 0.55, 1.3) }, // 腰
    { kind: 'box', c: v3(0, 5.5, -0.1), half: v3(1.9, 1.0, 1.7) }, // 胴
    { kind: 'box', c: v3(0, 6.7, -1.3), half: v3(0.9, 0.55, 0.75) }, // 操縦席
    { kind: 'box', c: v3(-2.6, 5.9, -0.3), half: v3(0.65, 0.65, 1.1) }, // ロケットの発射筒（左）
    { kind: 'box', c: v3(2.6, 5.9, -0.3), half: v3(0.65, 0.65, 1.1) }, // ロケットの発射筒（右）
    { kind: 'sphere', c: v3(0, 5.4, 1.85), r: 0.85, crit: true }, // 背中の炉心（弱点）
    { kind: 'sphere', c: v3(0, 6.7, -2.08), r: 0.36, crit: true }, // 操縦席のセンサー（弱点）
  ],
  aim: v3(0, 5.0, 0),
  critAim: v3(0, 5.4, 1.85),
  radius: 5.2,
  centerY: 4,
};
export const BOSS_HEIGHT = 7.5;
/** 大型兵器の、プレイヤーとぶつかる箱（足元から） */
export const BOSS_COLLIDER = v3(4.4, 7.2, 3.4);

/** タレットの形（機銃・ロケットは台と砲塔、減速・修理は柱） */
export function turretBody(type: TurretType): BodyDef {
  if (type === 'mg' || type === 'rocket')
    return {
      parts: [
        { kind: 'box', c: v3(0, 0.5, 0), half: v3(0.75, 0.52, 0.75) },
        { kind: 'box', c: v3(0, 1.32, 0), half: v3(0.6, 0.36, 0.7) },
      ],
      aim: v3(0, 1.0, 0),
      radius: 1.6,
      centerY: 0.9,
    };
  return {
    parts: [
      { kind: 'box', c: v3(0, 0.8, 0), half: v3(0.68, 0.82, 0.68) },
      { kind: 'sphere', c: v3(0, 1.85, 0), r: 0.38 },
    ],
    aim: v3(0, 1.0, 0),
    radius: 1.5,
    centerY: 1.0,
  };
}
export const TURRET_HEIGHT = 1.7;
/** タレットの、ぶつかる箱の大きさ（台の部分。砲口より低くして、自分の箱に弾が当たらないようにする） */
export const TURRET_COLLIDER = v3(1.4, 1.15, 1.4);
/** 砲口の高さ */
export const TURRET_MUZZLE_Y = 1.35;

/** コア：台座の上の炉（地形の箱より少しだけ大きくして、弾が先にコアに当たるようにする） */
export const CORE_BODY: BodyDef = {
  parts: [{ kind: 'box', c: v3(0, 3.25, 0), half: v3(2.12, 3.0, 2.12) }],
  aim: v3(0, 3.0, 0),
  radius: 4.2,
  centerY: 3.2,
};
export const CORE_HEIGHT = 6.2;

/** バリケード：横に長い装甲の壁（向きの横方向が幅。厚み 0.36m） */
export function barricadeBody(width: number, height: number): BodyDef {
  return {
    parts: [{ kind: 'box', c: v3(0, height / 2, 0), half: v3(width / 2, height / 2, 0.18) }],
    aim: v3(0, height * 0.6, 0),
    radius: width / 2 + 0.3,
    centerY: height / 2,
  };
}
export const BARRICADE_THICK = 0.36;
