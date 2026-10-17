/**
 * ロードアウト（仕様 7.6）：試合の前に決めておく「キャラクター 1 人＋メイン武器＋サブ武器＋グレネード＋ブースト」の組み合わせ。
 * 名前を付けて 5 枠まで保存しておき、試合を始めるときに 1 つ選んで持っていく。
 *
 * キャラクターや武器の定義と同じく「データ」として扱う。画面（client）にも、試合のロジックにも依らないので、
 * オンラインにしたときは、サーバーが同じ関数で「正しい組み合わせか」を確かめられる。
 * 武器のカスタマイズ（サイト 1 つ・アタッチメント 2 つまで。shared/weaponCustom.ts）は武器ごとに持つ。
 * メイン武器を替えて、あとで元の武器に戻したときは、前のカスタマイズに戻る。
 */
import { BOOST_IDS, type BoostId, CHARACTER_IDS, type CharacterId, type GrenadeId, WEAPON_IDS, type WeaponId, type WeaponsConfig, isGrenadeId, weaponsConfig } from '../config';
import { type WeaponCustom, checkCustom, defaultCustom, repairCustom } from './weaponCustom';

export const LOADOUT_SLOTS = 5;
/** 名前の長さの上限（文字数） */
export const LOADOUT_NAME_MAX = 12;
/** 保存の形の版（項目を足したら上げる） */
export const LOADOUT_VERSION = 4;

export interface Loadout {
  name: string;
  character: CharacterId;
  primary: WeaponId;
  secondary: WeaponId;
  /** 武器ごとのカスタマイズ（ない武器は、最初から付いているサイトだけ） */
  custom: Partial<Record<WeaponId, WeaponCustom>>;
  /** ブースト（消耗戦。得点でゲージがたまり、X で使う） */
  boost: BoostId;
  /** グレネードの種類（G で投げる） */
  grenade: GrenadeId;
}

/** その武器のカスタマイズ（なければ最初の状態） */
export function customOf(l: Loadout, w: WeaponId, cfg: WeaponsConfig = weaponsConfig): WeaponCustom {
  const c = l.custom[w];
  return c ? repairCustom(c, cfg[w]) : defaultCustom(cfg[w]);
}

/** 試合に渡すカスタマイズ（メイン・サブ） */
export function loadoutCustoms(l: Loadout, cfg: WeaponsConfig = weaponsConfig): [WeaponCustom, WeaponCustom] {
  return [customOf(l, l.primary, cfg), customOf(l, l.secondary, cfg)];
}

/** 武器のカスタマイズを変える */
export function withCustom(l: Loadout, w: WeaponId, c: WeaponCustom): Loadout {
  return { ...l, custom: { ...l.custom, [w]: { sight: c.sight, attachments: [...c.attachments] } } };
}

const isCharacter = (v: unknown): v is CharacterId => typeof v === 'string' && (CHARACTER_IDS as readonly string[]).includes(v);
const isWeapon = (v: unknown): v is WeaponId => typeof v === 'string' && (WEAPON_IDS as readonly string[]).includes(v);
const isBoost = (v: unknown): v is BoostId => typeof v === 'string' && (BOOST_IDS as readonly string[]).includes(v);

/** 名前を整える：前後の空白と改行・制御文字を取り、長すぎれば切る。空なら fallback */
export function cleanLoadoutName(raw: unknown, fallback: string): string {
  const s = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  const chars = [...s];
  return chars.length ? chars.slice(0, LOADOUT_NAME_MAX).join('') : fallback;
}

export type LoadoutCheck = { ok: true; loadout: Loadout } | { ok: false; reason: string };

/**
 * 正しいロードアウトか確かめる（オンラインではサーバーがマッチングのときに使う）。
 * 存在するキャラクター・武器か、メインとサブが同じ武器でないか、名前が決まりどおりか。
 */
export function checkLoadout(raw: unknown): LoadoutCheck {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'ロードアウトの形が正しくない' };
  const r = raw as Record<string, unknown>;
  if (!isCharacter(r.character)) return { ok: false, reason: `存在しないキャラクター：${String(r.character)}` };
  if (!isWeapon(r.primary)) return { ok: false, reason: `存在しない武器（メイン）：${String(r.primary)}` };
  if (!isWeapon(r.secondary)) return { ok: false, reason: `存在しない武器（サブ）：${String(r.secondary)}` };
  if (r.primary === r.secondary) return { ok: false, reason: 'メインとサブに同じ武器は選べない' };
  if (typeof r.name !== 'string' || cleanLoadoutName(r.name, '') !== r.name) return { ok: false, reason: '名前が正しくない' };
  if (r.boost !== undefined && !isBoost(r.boost)) return { ok: false, reason: `存在しないブースト：${String(r.boost)}` };
  if (r.grenade !== undefined && !isGrenadeId(r.grenade)) return { ok: false, reason: `存在しないグレネード：${String(r.grenade)}` };
  const custom: Partial<Record<WeaponId, WeaponCustom>> = {};
  if (r.custom !== undefined) {
    if (!r.custom || typeof r.custom !== 'object') return { ok: false, reason: 'カスタマイズの形が正しくない' };
    for (const [w, c] of Object.entries(r.custom as Record<string, unknown>)) {
      if (!isWeapon(w)) return { ok: false, reason: `存在しない武器のカスタマイズ：${w}` };
      const ch = checkCustom(c, weaponsConfig[w]);
      if (!ch.ok) return ch;
      custom[w] = ch.custom;
    }
  }
  return { ok: true, loadout: { name: r.name, character: r.character, primary: r.primary, secondary: r.secondary, custom, boost: isBoost(r.boost) ? r.boost : 'maphack', grenade: isGrenadeId(r.grenade) ? r.grenade : 'frag' } };
}

/** 最初から入っている 5 つ（役割の違う組み合わせ） */
export function defaultLoadouts(): Loadout[] {
  return [
    {
      name: '突撃',
      character: 'meia',
      primary: 'ar',
      secondary: 'shotgun',
      custom: { ar: { sight: 'holo', attachments: ['compensator', 'stock'] }, shotgun: { sight: 'reddot', attachments: ['gunrunner'] } },
      boost: 'phaserewind',
      grenade: 'frag',
    },
    {
      name: '狙撃',
      character: 'pearl',
      primary: 'sniper',
      secondary: 'smg',
      custom: { sniper: { sight: 'variable', attachments: ['suppressor', 'extmag'] }, smg: { sight: 'reddot', attachments: ['laser'] } },
      boost: 'holopilot',
      grenade: 'smoke',
    },
    {
      name: '防衛',
      character: 'miranda',
      primary: 'lmg',
      secondary: 'shotgun',
      custom: { lmg: { sight: 'x2', attachments: ['extmag', 'compensator'] }, shotgun: { sight: 'iron', attachments: ['laser'] } },
      boost: 'hardcover',
      grenade: 'satchel',
    },
    {
      name: '索敵',
      character: 'sora',
      primary: 'ar',
      secondary: 'smg',
      custom: { ar: { sight: 'threat', attachments: ['longbarrel'] }, smg: { sight: 'holo', attachments: ['suppressor', 'fastreload'] } },
      boost: 'maphack',
      grenade: 'arc',
    },
    {
      name: '奇襲',
      character: 'ranmaru',
      primary: 'smg',
      secondary: 'shotgun',
      custom: { smg: { sight: 'reddot', attachments: ['suppressor', 'gunrunner'] }, shotgun: { sight: 'holo', attachments: ['stock', 'laser'] } },
      boost: 'ticks',
      grenade: 'gravity',
    },
  ];
}

/**
 * 保存してあった（壊れているかもしれない）ロードアウトを、使える形に直す。
 * 直せない所は fallback の値を使う（武器が重なっていたらサブを別の武器にする）。
 */
export function repairLoadout(raw: unknown, fallback: Loadout): Loadout {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const character = isCharacter(r.character) ? r.character : fallback.character;
  const primary = isWeapon(r.primary) ? r.primary : fallback.primary;
  let secondary = isWeapon(r.secondary) ? r.secondary : fallback.secondary;
  if (secondary === primary) secondary = fallback.secondary !== primary ? fallback.secondary : WEAPON_IDS.find((w) => w !== primary)!;
  // カスタマイズ：保存がなければ（前の版の保存など）、fallback のものを使う
  const src: Record<string, unknown> = r.custom && typeof r.custom === 'object' ? (r.custom as Record<string, unknown>) : fallback.custom;
  const custom: Partial<Record<WeaponId, WeaponCustom>> = {};
  for (const w of WEAPON_IDS) {
    const c = src[w];
    if (c) custom[w] = repairCustom(c, weaponsConfig[w]);
  }
  const boost = isBoost(r.boost) ? r.boost : fallback.boost;
  const grenade = isGrenadeId(r.grenade) ? r.grenade : fallback.grenade;
  return { name: cleanLoadoutName(r.name, fallback.name), character, primary, secondary, custom, boost, grenade };
}

/** 武器を選んだとき：もう一方と同じ武器を選んだら、入れ替える（同じ武器は 2 つ持てない） */
export function withWeapon(l: Loadout, slot: 'primary' | 'secondary', w: WeaponId): Loadout {
  const other = slot === 'primary' ? 'secondary' : 'primary';
  if (l[other] === w) return { ...l, [slot]: w, [other]: l[slot] };
  return { ...l, [slot]: w };
}
