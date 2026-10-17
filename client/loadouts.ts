/**
 * ロードアウトの保存（ブラウザの localStorage）。5 枠と、いま使う枠の番号を持つ。
 * 前の版の「キャラクター・装備」の保存（vr.character・vr.loadout）があれば、1 枠目に引き継ぐ。
 */
import type { CharacterId, WeaponId } from '../config';
import { LOADOUT_SLOTS, LOADOUT_VERSION, type Loadout, defaultLoadouts, repairLoadout } from '../shared/loadout';

const KEY = 'vr.loadouts';

interface Saved {
  v: number;
  active: number;
  slots: unknown[];
}

function read(key: string): unknown {
  try {
    const s = localStorage.getItem(key);
    return s === null ? null : JSON.parse(s);
  } catch {
    return null;
  }
}

export class LoadoutStore {
  slots: Loadout[];
  active = 0;
  /** 中身が変わったとき（保存したあと）に呼ぶ */
  onChange: () => void = () => {};

  constructor() {
    const defs = defaultLoadouts();
    const saved = read(KEY) as Saved | null;
    if (saved && Array.isArray(saved.slots)) {
      this.slots = defs.map((d, i) => repairLoadout(saved.slots[i], d));
      this.active = Number.isInteger(saved.active) && saved.active >= 0 && saved.active < LOADOUT_SLOTS ? saved.active : 0;
    } else {
      // 前の版の保存を 1 枠目へ
      this.slots = defs;
      const ch = read('vr.character');
      const lo = read('vr.loadout') as [WeaponId, WeaponId] | null;
      const old = repairLoadout({ name: defs[0].name, character: typeof ch === 'string' ? (ch as CharacterId) : undefined, primary: lo?.[0], secondary: lo?.[1] }, defs[0]);
      this.slots[0] = old;
    }
  }

  get current(): Loadout {
    return this.slots[this.active];
  }

  select(i: number): void {
    if (i < 0 || i >= LOADOUT_SLOTS || i === this.active) return;
    this.active = i;
    this.save();
  }

  /** いま使う枠を書き換える */
  update(next: Loadout): void {
    this.slots[this.active] = repairLoadout(next, this.slots[this.active]);
    this.save();
  }

  /** いま使う枠を最初の状態に戻す */
  reset(): void {
    this.slots[this.active] = defaultLoadouts()[this.active];
    this.save();
  }

  private save(): void {
    try {
      const data: Saved = { v: LOADOUT_VERSION, active: this.active, slots: this.slots };
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch {
      /* 保存できない環境でも、この画面を開いている間は使える */
    }
    this.onChange();
  }
}
