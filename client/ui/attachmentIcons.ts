/**
 * アタッチメントの印（白い線の絵。48×48 の SVG）。ロードアウト画面の小さな四角いボタンに出す。
 */
import type { AttachmentId } from '../../config';

const svg = (body: string) =>
  `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ATTACHMENT_ICONS: Record<AttachmentId | 'none', string> = {
  // 長い弾倉と「＋」
  extmag: svg('<path d="M15 6h11l-1 9 4 26H19l-4-26z"/><path d="M17 15h9M20 24h7M21 32h7"/><path d="M36 9v10M31 14h10"/>'),
  // 弾倉と、引き手と、回る矢印
  fastreload: svg('<path d="M12 8h10l-1 8 3 20h-9l-3-20z"/><path d="M14 36v5h6"/><path d="M30 14a10 10 0 1 1-1 14"/><path d="M28 9l2 5-5 1"/>'),
  // 長い筒と溝
  suppressor: svg('<rect x="6" y="17" width="32" height="14" rx="3"/><path d="M38 21h5v6h-5M14 17v14M20 17v14M26 17v14M32 17v14"/>'),
  // 上に穴の開いた銃口と、ガスが抜ける線
  compensator: svg('<path d="M6 22h8M6 26h8"/><rect x="14" y="18" width="22" height="12" rx="1.5"/><path d="M19 18v-5M25 18v-7M31 18v-5"/><path d="M36 24h6"/>'),
  // 銃床
  stock: svg('<path d="M42 16H24l-8 6H6v10h9l9-5h18z"/><path d="M6 22v10"/><path d="M33 16v11"/>'),
  // 箱と、まっすぐ出る光
  laser: svg('<rect x="5" y="17" width="16" height="12" rx="2"/><path d="M21 21h4M21 25h4"/><path d="M27 23h16"/><circle cx="43" cy="23" r="2" fill="currentColor"/>'),
  // 走る向きの矢印と照準
  gunrunner: svg('<circle cx="17" cy="24" r="9"/><path d="M17 12v5M17 31v5M5 24h5M24 24h5"/><path d="M32 16l8 8-8 8M26 16l8 8-8 8"/>'),
  // 長い銃身と、のびる矢印
  longbarrel: svg('<path d="M4 21h14v6H4z"/><path d="M18 22.5h22v3H18z"/><path d="M40 20v8"/><path d="M24 34h16M36 31l4 3-4 3M24 14h16M36 11l4 3-4 3"/>'),
  none: svg('<rect x="9" y="9" width="30" height="30" rx="4" stroke-dasharray="4 4"/><path d="M24 17v14M17 24h14"/>'),
};
