/**
 * ロードアウト画面の「性能の棒」。カスタマイズを当てはめた武器の数値を、0〜1 の棒の長さと表示用の文字にする。
 * 棒の長さは、すべての武器・サイト・アタッチメントの組み合わせの中で一番良いものを 1 にする。
 */
import { WEAPON_IDS, type WeaponsConfig } from '../../config';
import { type CustomWeaponDef, allowedAttachments, allowedSights, customDef, magnification } from '../../shared/weaponCustom';
import { sustainedRpm } from '../../shared/weapons';

export interface StatDef {
  key: string;
  label: string;
  /** 大きいほど良い値（小さいほど良い数値は逆数などにする） */
  value: (d: CustomWeaponDef) => number;
  text: (d: CustomWeaponDef) => string;
}

const sec = (v: number) => `${v.toFixed(2).replace(/0$/, '')}秒`;

export const STATS: StatDef[] = [
  { key: 'power', label: '威力', value: (d) => d.DAMAGE * d.PELLETS, text: (d) => (d.PELLETS > 1 ? `${d.DAMAGE}×${d.PELLETS}` : `${Math.round(d.DAMAGE)}`) },
  {
    key: 'rate',
    label: '連射',
    value: (d) => sustainedRpm(d),
    text: (d) => (d.BURST > 1 ? `${d.BURST}点射 ${Math.round(sustainedRpm(d))}/分` : d.SPINUP_TIME > 0 && d.RPM_MIN > 0 ? `${d.RPM_MIN}〜${d.RPM}/分` : `${d.RPM}発/分`),
  },
  { key: 'range', label: '射程', value: (d) => Math.min(d.FALLOFF_END, 120), text: (d) => (d.FALLOFF_END >= 300 ? '減衰なし' : `〜${Math.round(d.FALLOFF_END)}m`) },
  { key: 'mag', label: '装弾数', value: (d) => d.MAG_SIZE, text: (d) => `${d.MAG_SIZE}発` },
  { key: 'ads', label: 'エイム速度', value: (d) => 1 / d.ADS_TIME, text: (d) => sec(d.ADS_TIME) },
  { key: 'hip', label: '腰だめ精度', value: (d) => 1 / Math.max(0.3, d.HIP_SPREAD), text: (d) => `${d.HIP_SPREAD.toFixed(1)}°` },
  { key: 'recoil', label: '反動制御', value: (d) => 1 / Math.max(0.05, d.RECOIL_PITCH), text: (d) => `${d.RECOIL_PITCH.toFixed(2)}` },
  { key: 'reload', label: 'リロード', value: (d) => 1 / Math.max(0.1, d.RELOAD_PER_SHELL ? d.RELOAD_TIME * 4 : d.RELOAD_TIME), text: (d) => (d.RELOAD_PER_SHELL ? `1発 ${sec(d.RELOAD_TIME)}` : sec(d.RELOAD_TIME)) },
  { key: 'zoom', label: '倍率', value: (d) => magnification(d.ZOOMS.length ? d.ZOOMS[d.ZOOMS.length - 1] : d.ADS_FOV_MUL), text: (d) => (d.ZOOMS.length ? d.ZOOMS.map((z) => `${magnification(z).toFixed(0)}`).join('/') + '倍' : `${magnification(d.ADS_FOV_MUL).toFixed(1)}倍`) },
];

let maxima: Record<string, number> | null = null;

/** 棒の長さの基準（一番良い値）。最初に 1 回だけ数える */
function maxOf(cfg: WeaponsConfig): Record<string, number> {
  if (maxima) return maxima;
  const m: Record<string, number> = {};
  for (const s of STATS) m[s.key] = 0;
  for (const w of WEAPON_IDS) {
    const base = cfg[w];
    for (const sight of allowedSights(base)) {
      for (const att of [null, ...allowedAttachments(base)]) {
        const d = customDef(base, { sight, attachments: att ? [att] : [] });
        for (const s of STATS) m[s.key] = Math.max(m[s.key], s.value(d));
      }
    }
  }
  // 拡張マガジン＋α の組み合わせも少し上回るように、少し余裕をもたせる
  for (const k of Object.keys(m)) m[k] *= 1.05;
  maxima = m;
  return m;
}

export function statFraction(cfg: WeaponsConfig, s: StatDef, d: CustomWeaponDef): number {
  return Math.max(0.03, Math.min(1, s.value(d) / maxOf(cfg)[s.key]));
}

/** a → b で変わる項目（値が 0.5% 以上変わったもの） */
export function changedStats(a: CustomWeaponDef, b: CustomWeaponDef): Set<string> {
  const out = new Set<string>();
  for (const s of STATS) {
    const va = s.value(a);
    const vb = s.value(b);
    if (Math.abs(va - vb) > Math.abs(va) * 0.005) out.add(s.key);
  }
  return out;
}
