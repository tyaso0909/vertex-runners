/** 遊べるステージの一覧 */
import type { LevelData } from '../level';
import { buildNeonCity } from './neonCity';
import { buildTestRoom } from './testRoom';
import { buildFortress } from './fortress';
import { buildTimeAttackLevel } from '../courses/neonCourse';

export const LEVELS = {
  neon: { name: 'ネオン都市', desc: '夕暮れのビル街。中に入れる建物と、壁走りで渡る屋上の道。消耗戦・タイムアタック用のマップ', build: buildNeonCity },
  ta: { name: 'タイムアタック', desc: 'ネオン都市の屋上を駆け抜けるコース。20体のターゲットを壊してゴールまでのタイムを競う', build: buildTimeAttackLevel },
  fortress: { name: '軍事要塞', desc: '晴れた昼の高原の要塞。防壁と見張り塔、左右の建物をつなぐ屋根付きの連絡橋。タワーディフェンス用のマップ', build: buildFortress },
  test: { name: 'テスト部屋', desc: '移動・射撃・アビリティを試すための箱の部屋', build: buildTestRoom },
} satisfies Record<string, { name: string; desc: string; build: () => LevelData }>;

export type LevelId = keyof typeof LEVELS;
export const LEVEL_IDS = Object.keys(LEVELS) as LevelId[];
