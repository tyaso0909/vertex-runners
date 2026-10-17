/**
 * グレネードの種類の絵（24×24 の線画。HUD とロードアウト画面で使う）
 */
import type { GrenadeId } from '../../config';

export const GRENADE_ICONS: Record<GrenadeId, string> = {
  // 丸い手榴弾とレバー
  frag: '<circle cx="11" cy="14" r="6.5" /><path d="M9 7.5 v-2.5 h4 v2.5" /><path d="M13 5 l5 3" /><circle cx="17.5" cy="4.5" r="1.6" /><path d="M5 14 h12" />',
  // 筒と稲妻
  arc: '<rect x="7" y="6" width="8" height="15" rx="2" /><path d="M9 4 h4" /><path d="M7 10 h8 M7 17 h8" /><path d="M19 4 l-2 5 h3 l-3 6" />',
  // 4 枚刃の手裏剣と炎
  firestar: '<path d="M12 2 L14 10 L22 12 L14 14 L12 22 L10 14 L2 12 L10 10 Z" /><circle cx="12" cy="12" r="2" fill="currentColor" />',
  // 3 枚刃と、渦
  gravity: '<path d="M12 3 L14.5 10 L20 17 L12 14.5 L4 17 L9.5 10 Z" /><circle cx="12" cy="12" r="2.4" fill="currentColor" /><path d="M3 7 a10 10 0 0 1 4 -3.5 M21 7 a10 10 0 0 0 -4 -3.5" />',
  // 缶と、立ちのぼる煙
  smoke: '<rect x="4" y="11" width="7" height="10" rx="1.5" /><path d="M5.5 11 v-2 h4 v2" /><path d="M13 13 c2 0 2 -3 4 -3 s3 -3 1 -5 M14 18 c3 0 3 -3 6 -3" />',
  // 平たい袋と、電波の出る起爆スイッチ
  satchel: '<rect x="3" y="10" width="15" height="9" rx="2" /><path d="M7 10 v9 M14 10 v9" /><path d="M10.5 10 v-4" /><circle cx="10.5" cy="5" r="1" fill="currentColor" /><path d="M18 5 a4 4 0 0 1 2.5 3 M19.5 2.5 a7 7 0 0 1 3 5" />',
};

export const grenadeSvg = (id: GrenadeId, cls = ''): string =>
  `<svg viewBox="0 0 24 24" class="${cls}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${GRENADE_ICONS[id]}</svg>`;
