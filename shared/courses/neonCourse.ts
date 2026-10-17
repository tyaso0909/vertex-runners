/**
 * タイムアタックのコース「ネオン・ラン」（ネオン都市の中）。仕様 5.2。
 *
 * 西の駅の屋上をスタートし、屋上・看板の壁走り・大通り・空中デッキ・高架道路・オフィス・立体駐車場を通って、
 * 東のホテルの屋上でゴールする。ターゲットは 20 体（立っている的 8・レールの上を動く的 5・浮いているドローン 7）。
 *
 * 区間（チェックポイント）
 *   スタート 駅の屋上（10m）
 *   1 ゲームセンターの屋上 …… 8m の隙間を 2段ジャンプで跳ぶ
 *   2 パチンコ店の屋上 …… 西の大通りの看板を壁走り（12m）
 *   3 空中デッキ（西） …… 大通りへ飛び降り、階段を駆け上がる
 *   4 高架道路 …… 空中デッキを回って、北の階段を上る
 *   5 高架道路（東） …… 道をふさぐ壁を、横のパネルの壁走り → 壁ジャンプ・2段ジャンプでよける
 *   6 オフィスの屋上 …… 低いゲートをスライディングでくぐり、8m の隙間を跳ぶ
 *   7 駐車場の3階 …… 東の大通りの看板を壁走り
 *   ゴール ホテルの屋上 …… 車路で駐車場の屋上へ上がり、ホテルの屋上へ跳び降りる
 *
 * 近道（上級者向け）
 *   A. 5→6：高架道路から北の通りの看板を壁走りしてカフェの屋上へ降り、オフィスの屋上へ跳ぶ（ゲートと高架道路の東を通らない）
 *   B. 7→ゴール：駐車場の3階の東の端から、ホテルの屋上へ直接跳ぶ（車路と屋上を通らない。屋上のターゲットは遠くから撃つ）
 *   どちらも、通らない所のターゲットを壊し損ねると 5秒ずつ足される。メイアのワイヤーフック、アレックスの加速でも近道できる。
 */
import { timeAttackConfig } from '../../config';
import type { BoxDef, LevelData } from '../level';
import { v3 } from '../math';
import type { TargetDef } from '../targets';
import type { CourseDef } from '../timeAttack';
import { buildNeonCity } from '../levels/neonCity';

const EAST = -Math.PI / 2;
const WEST = Math.PI / 2;
/** (dx, dz) の方向を向く視線の yaw */
const face = (dx: number, dz: number) => Math.atan2(-dx, -dz);

function holo(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, kind: 'wall' | 'panel' | 'gate' | 'platform'): BoxDef {
  return {
    center: v3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2),
    size: v3(x1 - x0, y1 - y0, z1 - z0),
    kind: kind === 'platform' ? 'platform' : 'wall',
    tag: 'course',
    noWallrun: kind !== 'panel',
    vis: { kind },
  };
}

/** コースの名前（記録の保存に使う） */
export const NEON_COURSE_ID = 'neon_run';

export function neonCourse(): CourseDef {
  const H = timeAttackConfig.TARGET_HEALTH;
  const D = timeAttackConfig.DRONE_HEALTH;
  const stat = (x: number, y: number, z: number, yaw: number): TargetDef => ({ kind: 'dummy', pos: v3(x, y, z), yaw, noRespawn: true, health: H });
  const moving = (x: number, y: number, z: number, x2: number, z2: number, yaw: number, speed = 2.2): TargetDef => ({
    kind: 'dummy',
    pos: v3(x, y, z),
    moveTo: v3(x2, y, z2),
    speed,
    yaw,
    noRespawn: true,
    health: H,
    rail: true,
  });
  const drone = (x: number, y: number, z: number, x2?: number, z2?: number): TargetDef => ({
    kind: 'drone',
    pos: v3(x, y, z),
    moveTo: x2 !== undefined ? v3(x2, y, z2!) : undefined,
    speed: x2 !== undefined ? 1.6 : undefined,
    yaw: 0,
    noRespawn: true,
    health: D,
  });

  return {
    id: NEON_COURSE_ID,
    name: 'ネオン・ラン',
    start: { pos: v3(-77, 10.05, -11), yaw: EAST, minY: 9 },
    checkpoints: [
      { name: 'ゲームセンターの屋上', pos: v3(-48, 10, -12), respawn: v3(-50, 10.05, -13), respawnYaw: face(1, 0.3), minY: 9 },
      { name: 'パチンコ店の屋上', pos: v3(-40, 10, 9), respawn: v3(-42, 10.05, 9), respawnYaw: face(0.4, -1), minY: -1 },
      { name: '空中デッキ（西）', pos: v3(-23, 5, -8), respawn: v3(-23, 5.05, -8), respawnYaw: 0, minY: 4 },
      { name: '高架道路', pos: v3(-4, 10, -47), respawn: v3(-4, 10.05, -47), respawnYaw: EAST, minY: 9 },
      { name: '高架道路（東）', pos: v3(22, 10, -47), respawn: v3(22, 10.05, -47), respawnYaw: EAST, minY: 9 },
      { name: 'オフィスの屋上', pos: v3(47, 10, -18), respawn: v3(47, 10.05, -18), respawnYaw: face(8.3, 4), minY: 9 },
      { name: '駐車場の3階', pos: v3(54, 10, 4), respawn: v3(53, 10.05, 3), respawnYaw: WEST, minY: 9 },
      { name: 'ゴール：ホテルの屋上', pos: v3(69, 10, 12), radius: 4.5, respawn: v3(69, 10.05, 12), respawnYaw: WEST, minY: 9 },
    ],
    targets: [
      // スタート → ゲームセンター
      stat(-44, 10, -26, -90),
      drone(-60, 15, -20, -60, -4),
      // ゲームセンター → 看板 → パチンコ店
      stat(-53, 10, -10, 90),
      drone(-34, 12.5, -2),
      moving(-52, 10, 13, -44, 13, 0),
      // パチンコ店 → 大通り → 空中デッキ
      moving(-48, 0, -6, -48, 2, -90, 2.5),
      drone(-31, 7, -14),
      stat(-17, 5, 2, -45),
      // 空中デッキ → 高架道路
      moving(-12, 5, -31, 2, -31, 180, 3),
      drone(-4, 11, -12),
      stat(-4, 1, -21, 180),
      // 高架道路 → 壁走りのパネル
      stat(6, 10, -45, -90),
      drone(12, 16, -52, 18, -48),
      // 高架道路（東）→ オフィスの屋上
      moving(31, 10, -50, 31, -44, -90, 2.4),
      stat(54, 10, -43.5, -90),
      drone(52, 14, -36),
      // オフィスの屋上 → 看板 → 駐車場
      stat(40, 10, -15, 90),
      drone(60, 12.5, -6),
      // 駐車場の屋上 → ゴール
      moving(42, 15, 19, 54, 19, 0, 3),
      stat(76, 10, 3, 90),
    ],
    boxes: [
      // 高架道路をふさぐ壁（北側だけ、壁走りのパネルの横を抜けられる）
      holo(18.8, 9.4, -52, 19.2, 18, -39, 'wall'),
      // 壁走りのパネル（高架道路の北、屋台の上）
      holo(3, 9.6, -55.6, 25, 15, -55.2, 'panel'),
      // スライディングでくぐるゲート（床から 1.15m の高さより上をふさぐ）
      holo(26.85, 11.15, -51, 27.15, 14, -43, 'gate'),
    ],
    notes: [
      '近道A：高架道路（東）から、北の通りの看板を壁走りしてカフェの屋上へ。そこからオフィスの屋上へ跳ぶ',
      '近道B：駐車場の3階の東の端から、ホテルの屋上へ直接跳ぶ',
      'メイアのワイヤーフック、アレックスの加速でも近道できる',
    ],
  };
}

/** タイムアタック用のステージ：ネオン都市に、コースの足場・ターゲット・スタート地点を足す */
export function buildTimeAttackLevel(): LevelData {
  const base = buildNeonCity();
  const course = neonCourse();
  return {
    ...base,
    name: 'タイムアタック：' + course.name,
    boxes: [...base.boxes, ...course.boxes],
    targets: course.targets,
    ammoStations: [],
    spawn: course.start.pos,
    spawnYaw: course.start.yaw,
    course,
  };
}
