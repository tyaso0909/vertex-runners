/**
 * 武器のカスタマイズ（仕様 7.6）：サイト 1 つと、アタッチメント 2 つまで。
 * 付けられる物は武器ごとに決まっている（config/weapons.json の SIGHTS・ATTACHMENTS）。効き目は config/attachments.json。
 *
 * ゲームのロジックは「カスタマイズを当てはめた武器の数値」（slotDef）だけを見る。
 * 画面にもサーバーにも依らないので、オンラインではサーバーが同じ関数で確かめ、同じ数値で撃ち合いを計算できる。
 */
import {
  ATTACHMENT_IDS,
  type AttachmentId,
  type AttachmentsConfig,
  SIGHT_IDS,
  type SightId,
  type SightKind,
  type WeaponDef,
  type WeaponId,
  type WeaponsConfig,
  attachmentsConfig,
} from '../config';

/** アタッチメントは 2 つまで */
export const MAX_ATTACHMENTS = 2;

export interface WeaponCustom {
  sight: SightId;
  /** 0〜2 個。同じ物は付けられない */
  attachments: AttachmentId[];
}

/** カスタマイズを当てはめた武器の数値（もとの項目＋カスタマイズで増える項目） */
export type CustomWeaponDef = WeaponDef & {
  SIGHT: SightId;
  SIGHT_KIND: SightKind;
  RETICLE: string;
  THREAT: boolean;
  /** 倍率を切り替えられるスコープの、視野角の倍率の段階（なければ空） */
  ZOOMS: number[];
  SUPPRESSED: boolean;
  LASER: boolean;
  /** 動いているときのばらつきの倍率 */
  MOVE_SPREAD_MUL: number;
  CUSTOM_ATTACHMENTS: AttachmentId[];
};

const isSight = (v: unknown): v is SightId => typeof v === 'string' && (SIGHT_IDS as readonly string[]).includes(v);
const isAttachment = (v: unknown): v is AttachmentId => typeof v === 'string' && (ATTACHMENT_IDS as readonly string[]).includes(v);

/** その武器に最初から付いている物（サイトだけ） */
export function defaultCustom(w: WeaponDef): WeaponCustom {
  return { sight: (isSight(w.DEFAULT_SIGHT) ? w.DEFAULT_SIGHT : 'iron') as SightId, attachments: [] };
}

export const allowedSights = (w: WeaponDef): SightId[] => (w.SIGHTS as string[]).filter(isSight);
export const allowedAttachments = (w: WeaponDef): AttachmentId[] => (w.ATTACHMENTS as string[]).filter(isAttachment);

export type CustomCheck = { ok: true; custom: WeaponCustom } | { ok: false; reason: string };

/** 正しいカスタマイズか確かめる（その武器に付けられる物か、数・重なり・同じグループの物が 2 つでないか） */
export function checkCustom(raw: unknown, w: WeaponDef, acfg: AttachmentsConfig = attachmentsConfig): CustomCheck {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'カスタマイズの形が正しくない' };
  const r = raw as Record<string, unknown>;
  if (!isSight(r.sight) || !allowedSights(w).includes(r.sight)) return { ok: false, reason: `${w.NAME}に付けられないサイト：${String(r.sight)}` };
  if (!Array.isArray(r.attachments)) return { ok: false, reason: 'アタッチメントの形が正しくない' };
  if (r.attachments.length > MAX_ATTACHMENTS) return { ok: false, reason: `アタッチメントは ${MAX_ATTACHMENTS} つまで` };
  const allowed = allowedAttachments(w);
  const groups = new Set<string>();
  for (const a of r.attachments) {
    if (!isAttachment(a) || !allowed.includes(a)) return { ok: false, reason: `${w.NAME}に付けられないアタッチメント：${String(a)}` };
    const g = acfg.ATTACHMENTS[a].GROUP;
    if (g) {
      if (groups.has(g)) return { ok: false, reason: '同じ場所に付ける物は 1 つまで' };
      groups.add(g);
    }
  }
  if (new Set(r.attachments).size !== r.attachments.length) return { ok: false, reason: '同じアタッチメントは 2 つ付けられない' };
  return { ok: true, custom: { sight: r.sight, attachments: [...(r.attachments as AttachmentId[])] } };
}

/** 保存してあった（壊れているかもしれない）カスタマイズを、その武器で使える形に直す */
export function repairCustom(raw: unknown, w: WeaponDef, acfg: AttachmentsConfig = attachmentsConfig): WeaponCustom {
  const d = defaultCustom(w);
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const sight = isSight(r.sight) && allowedSights(w).includes(r.sight) ? r.sight : d.sight;
  const out: AttachmentId[] = [];
  const groups = new Set<string>();
  for (const a of Array.isArray(r.attachments) ? r.attachments : []) {
    if (out.length >= MAX_ATTACHMENTS || !isAttachment(a) || !allowedAttachments(w).includes(a) || out.includes(a)) continue;
    const g = acfg.ATTACHMENTS[a].GROUP;
    if (g && groups.has(g)) continue;
    if (g) groups.add(g);
    out.push(a);
  }
  return { sight, attachments: out };
}

/**
 * アタッチメントの枠 index に a を付けたときのカスタマイズ（null なら外す）。
 * もう一方の枠と同じ物・同じグループの物なら、もう一方を外して入れ替える
 */
export function withAttachment(c: WeaponCustom, index: number, a: AttachmentId | null, acfg: AttachmentsConfig = attachmentsConfig): WeaponCustom {
  const slots: Array<AttachmentId | null> = [c.attachments[0] ?? null, c.attachments[1] ?? null];
  if (a) {
    const g = acfg.ATTACHMENTS[a].GROUP;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (i !== index && s && (s === a || (g && acfg.ATTACHMENTS[s].GROUP === g))) slots[i] = null;
    }
  }
  slots[index] = a;
  return { sight: c.sight, attachments: slots.filter((s): s is AttachmentId => !!s) };
}

/**
 * ボット用：その武器に付けられる物から、ランダムにサイトとアタッチメントを選ぶ。
 * サイトは 3 割ほどが最初のまま。アタッチメントは 2 つが多く、ときどき 1 つ（銃口の部品は 1 つまで）。
 * next：0〜1 の乱数（同じ種なら同じ組み合わせになる）
 */
export function randomCustom(w: WeaponDef, next: () => number, acfg: AttachmentsConfig = attachmentsConfig): WeaponCustom {
  const sights = allowedSights(w);
  const def = defaultCustom(w).sight;
  const sight = next() < 0.3 || sights.length === 0 ? def : sights[Math.floor(next() * sights.length) % sights.length];
  const pool = [...allowedAttachments(w)];
  const want = next() < 0.75 ? 2 : 1;
  const out: AttachmentId[] = [];
  const groups = new Set<string>();
  while (out.length < want && pool.length) {
    const a = pool.splice(Math.floor(next() * pool.length) % pool.length, 1)[0];
    const g = acfg.ATTACHMENTS[a].GROUP;
    if (g && groups.has(g)) continue;
    if (g) groups.add(g);
    out.push(a);
  }
  return { sight, attachments: out };
}

export const customKey = (c: WeaponCustom) => `${c.sight}|${c.attachments.join(',')}`;

// ---------------------------------------------------------------------------
// カスタマイズを当てはめた数値
// ---------------------------------------------------------------------------

/** 調整パネルで武器の数値を変えたら上げる（作り置きの数値を作り直す） */
let configVersion = 0;
export function invalidateWeaponDefs(): void {
  configVersion++;
}

interface Cached {
  version: number;
  def: CustomWeaponDef;
}
const cache = new WeakMap<WeaponDef, Map<string, Cached>>();

/** 武器の数値にカスタマイズを当てはめる（同じ組み合わせは作り置きを返す） */
export function customDef(base: WeaponDef, custom: WeaponCustom, acfg: AttachmentsConfig = attachmentsConfig): CustomWeaponDef {
  let m = cache.get(base);
  if (!m) cache.set(base, (m = new Map()));
  const key = customKey(custom);
  const hit = m.get(key);
  if (hit && hit.version === configVersion) return hit.def;
  const def = buildDef(base, custom, acfg);
  m.set(key, { version: configVersion, def });
  return def;
}

function buildDef(base: WeaponDef, custom: WeaponCustom, acfg: AttachmentsConfig): CustomWeaponDef {
  const s = acfg.SIGHTS[custom.sight];
  const d = {
    ...base,
    SIGHT: custom.sight,
    SIGHT_KIND: s.KIND,
    RETICLE: s.RETICLE,
    THREAT: s.THREAT,
    ZOOMS: [...s.ZOOMS],
    SUPPRESSED: false,
    LASER: false,
    MOVE_SPREAD_MUL: 1,
    CUSTOM_ATTACHMENTS: [...custom.attachments],
  } as CustomWeaponDef;
  const rec = d as unknown as Record<string, unknown>;
  // サイト：倍率・のぞく速さ・エイム中のばらつき。画面いっぱいにのぞくのは scope だけ
  if (s.FOV_MUL > 0) d.ADS_FOV_MUL = s.FOV_MUL;
  if (s.ZOOMS.length) d.ADS_FOV_MUL = s.ZOOMS[0];
  d.ADS_TIME *= s.ADS_TIME_MUL;
  d.ADS_SPREAD *= s.ADS_SPREAD_MUL;
  d.SCOPE = s.KIND === 'scope';
  // アタッチメント
  for (const id of custom.attachments) {
    for (const [k, v] of Object.entries(acfg.ATTACHMENTS[id].MODS)) {
      if (k.endsWith('_MUL') && typeof v === 'number' && typeof rec[k.slice(0, -4)] === 'number' && k !== 'MOVE_SPREAD_MUL') {
        rec[k.slice(0, -4)] = (rec[k.slice(0, -4)] as number) * v;
      } else if (k.endsWith('_ADD') && typeof v === 'number' && typeof rec[k.slice(0, -4)] === 'number') {
        rec[k.slice(0, -4)] = (rec[k.slice(0, -4)] as number) + v;
      } else if (k === 'MOVE_SPREAD_MUL' && typeof v === 'number') {
        d.MOVE_SPREAD_MUL *= v;
      } else {
        rec[k] = v;
      }
    }
  }
  // 装弾数は整数。増やす物なら最低 1 発は増やす
  d.MAG_SIZE = Math.max(1, d.MAG_SIZE > base.MAG_SIZE ? Math.max(base.MAG_SIZE + 1, Math.round(d.MAG_SIZE)) : Math.round(d.MAG_SIZE));
  d.ADS_MOVE_MUL = Math.min(1, d.ADS_MOVE_MUL);
  return d;
}

/** 弾倉・武器の持ち物（arsenal の slot）に付いたカスタマイズで、数値を返す */
export function slotDef(cfg: WeaponsConfig, slot: { id: WeaponId; custom?: WeaponCustom }): CustomWeaponDef {
  const base = cfg[slot.id];
  return customDef(base, slot.custom ?? defaultCustom(base));
}

/** エイム時の視野角の倍率を、だいたいの「倍率」（視野角 90° のとき）にする（画面の表示用） */
export function magnification(fovMul: number): number {
  const half = Math.PI / 4;
  return Math.tan(half) / Math.tan(half * fovMul);
}
