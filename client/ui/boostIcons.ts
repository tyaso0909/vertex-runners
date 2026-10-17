/**
 * ブーストの絵（24×24 の線画。HUD のゲージとロードアウト画面で使う）
 */
import type { BoostId } from '../../config';

export const BOOST_ICONS: Record<BoostId, string> = {
  // 地図と、広がる電波
  maphack: '<path d="M3 6 l6 -2 l6 2 l6 -2 v14 l-6 2 l-6 -2 l-6 2 Z" /><path d="M9 4 v14 M15 6 v14" /><circle cx="15" cy="11" r="1.6" fill="currentColor" />',
  // 人の形が 3 つ（後ろの 2 つは点線）
  holopilot:
    '<circle cx="12" cy="6" r="2.4" /><path d="M8 21 v-6 l1.5 -4.5 h5 L16 15 v6" /><circle cx="5" cy="8" r="1.8" stroke-dasharray="1.5 1.5" /><path d="M2.5 20 v-4.5 l1 -3 h3" stroke-dasharray="1.5 1.5" /><circle cx="19" cy="8" r="1.8" stroke-dasharray="1.5 1.5" /><path d="M21.5 20 v-4.5 l-1 -3 h-3" stroke-dasharray="1.5 1.5" />',
  // 左回りの矢印と時計
  phaserewind: '<path d="M4 12 a8 8 0 1 0 2.5 -5.8" /><path d="M3.5 3.5 v4 h4" /><path d="M12 8 v4.5 l3 2" />',
  // 大きな盾の壁
  hardcover: '<path d="M2 19 v-12 h20 v12" /><path d="M2 19 h20" /><path d="M7 7 v12 M12 7 v12 M17 7 v12" /><path d="M2 12 h20" />',
  // クモ型の地雷
  ticks: '<ellipse cx="12" cy="12" rx="4.5" ry="3.5" /><circle cx="12" cy="9.5" r="1" fill="currentColor" /><path d="M7.5 11 L3 8 L2 5 M7.5 13 L3 14 L2 17 M16.5 11 L21 8 L22 5 M16.5 13 L21 14 L22 17 M9 15 L7 19 M15 15 L17 19" />',
  // さいころ
  diceroll: '<rect x="4" y="4" width="16" height="16" rx="3" /><circle cx="8.5" cy="8.5" r="1.3" fill="currentColor" /><circle cx="15.5" cy="15.5" r="1.3" fill="currentColor" /><circle cx="12" cy="12" r="1.3" fill="currentColor" /><circle cx="15.5" cy="8.5" r="1.3" fill="currentColor" /><circle cx="8.5" cy="15.5" r="1.3" fill="currentColor" />',
};

export const boostSvg = (id: BoostId, cls = ''): string => `<svg viewBox="0 0 24 24" class="${cls}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${BOOST_ICONS[id]}</svg>`;
