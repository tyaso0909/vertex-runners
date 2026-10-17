/**
 * ロードアウト画面（仕様 7.6）。タイタンフォール 2 のロードアウト画面にならった作り：
 *   ・左：保存した 5 つの組み合わせ（押した枠が「使用中」）
 *   ・中：その組み合わせの中身を、ボタンの板で並べる
 *       キャラクター ／ メイン武器［武器］［サイト］［アタッチメント 1］［アタッチメント 2］／ サブ武器（同じ）／ ブースト
 *   ・右：キャラクターの 3D 表示と能力
 * 板を押すと、その中身を選ぶ画面に入れ替わる（選ぶ物の一覧と、右に 3D の武器・説明・性能の棒）。
 * 選ぶ物にカーソルを合わせると、付けたときの性能の変化（増える所は緑、減る所は赤）と見た目が出る。押すと決まり、元の画面に戻る。
 *
 * 試合の前の画面・練習の一時停止画面には、枠の列と中身の要約（LoadoutSummary）を出し、「編集」でこの画面を開く。
 */
import {
  type AttachmentId,
  type AttachmentsConfig,
  BOOST_IDS,
  type BoostId,
  boostNum,
  boostsConfig,
  type CharactersConfig,
  GRENADE_IDS,
  type GrenadeId,
  grenadeNum,
  grenadesConfig,
  type SightId,
  WEAPON_CLASS_LABEL,
  WEAPON_IDS,
  type WeaponClass,
  classOf,
  type WeaponId,
  type WeaponsConfig,
} from '../../config';
import { LOADOUT_NAME_MAX, type Loadout, customOf, withCustom, withWeapon } from '../../shared/loadout';
import {
  type CustomWeaponDef,
  type WeaponCustom,
  allowedAttachments,
  allowedSights,
  customDef,
  customKey,
  magnification,
  withAttachment,
} from '../../shared/weaponCustom';
import type { LoadoutStore } from '../loadouts';
import { ATTACHMENT_ICONS } from './attachmentIcons';
import { boostSvg } from './boostIcons';
import { grenadeSvg } from './grenadeIcons';
import { GRENADE_COLORS } from '../weapons/grenadeView';
import { grenadeCount, grenadeRegenTime } from '../../shared/grenades';
import type { CharacterSelect } from './characterSelect';
import { PORTRAITS } from './portraits';
import { STATS, changedStats, statFraction } from './weaponStats';
import type { WeaponPreview } from './weaponPreview';

type Slot = 'primary' | 'secondary';
type Pick = { kind: 'character' } | { kind: 'boost' } | { kind: 'grenade' } | { kind: 'weapon'; slot: Slot } | { kind: 'sight'; slot: Slot } | { kind: 'att'; slot: Slot; index: number };

/** ブーストの数値の説明（ロードアウト画面の右に出す） */
function boostFacts(id: BoostId): string[] {
  const d = boostsConfig.BOOSTS[id];
  const n = (k: string, def = 0) => boostNum(d, k, def);
  const out = [`ゲージ：${d.COST} 点で満タン（パイロット撃破 5・歩兵 1・アシスト 1）`];
  if (id === 'maphack') out.push(`${n('DURATION')} 秒間、${n('PULSE')} 秒ごとに敵の位置を映す`);
  if (id === 'holopilot') out.push(`${n('COUNT')} 体・約 ${n('DURATION')} 秒・撃たれると消える`);
  if (id === 'phaserewind') out.push(`${n('REWIND')} 秒前の場所へ ${n('TRAVEL')} 秒で戻る`);
  if (id === 'hardcover') out.push(`幅 ${n('WIDTH')}m・高さ ${n('HEIGHT')}m・${n('DURATION')} 秒`);
  if (id === 'ticks') out.push(`${n('COUNT')} 個・爆発 ${n('DAMAGE')}（範囲 ${n('RADIUS')}m）・${n('SEEK_RANGE')}m 以内の敵を追う`);
  if (id === 'diceroll') out.push('一番早くたまる。使うまで何が出るか分からない');
  out.push('倒されてもゲージは減らない。倒されずに続けて倒すと、たまり方が増える');
  return out;
}

/** グレネードの数値の説明 */
function grenadeFacts(id: GrenadeId, wcfg: WeaponsConfig): string[] {
  const c = wcfg.COMMON;
  const d = grenadesConfig[id];
  const n = (k: string, def = 0) => grenadeNum(d, k, def);
  const out: string[] = [];
  if (id === 'frag') out.push(`爆発 ${c.GRENADE_MAX_DAMAGE}〜${c.GRENADE_MIN_DAMAGE}（範囲 ${c.GRENADE_BLAST_RADIUS}m）・投げて ${c.GRENADE_FUSE} 秒で爆発`);
  if (id === 'arc') out.push(`放電 ${n('MAX_DAMAGE')}〜${n('MIN_DAMAGE')}（範囲 ${n('RADIUS')}m）・${n('FUSE')} 秒で放電`, `電撃 ${n('SHOCK_TIME')} 秒：動きが最大 ${Math.round(n('SHOCK_SLOW') * 100)}% 鈍り、狙いが乱れる`, `ドローンには ${n('DRONE_MUL')} 倍のダメージ`);
  if (id === 'firestar') out.push(`当たった所に刺さり、${n('FIRE_TIME')} 秒燃える（半径 ${n('FIRE_RADIUS')}m・毎秒 ${n('FIRE_DPS')}）`, `敵に刺されば ${n('IMPACT_DAMAGE')} ダメージ＋その敵ごと燃える`);
  if (id === 'gravity') out.push(`刺さると ${n('PULL_TIME')} 秒、${n('PULL_RADIUS')}m 以内の敵を引き寄せて浮かせる`, `そのあと爆発 ${n('MAX_DAMAGE')}〜${n('MIN_DAMAGE')}（範囲 ${n('RADIUS')}m）`);
  if (id === 'smoke') out.push(`${n('FUSE')} 秒で煙を噴き、半径 ${n('SMOKE_RADIUS')}m の煙の幕を ${n('SMOKE_TIME')} 秒張る`, '煙の向こうは見えない（ボットも）');
  if (id === 'satchel') out.push('張り付いて待つ。置いてあるときに G を押すと、まとめて起爆', `爆発 ${n('MAX_DAMAGE')}〜${n('MIN_DAMAGE')}（範囲 ${n('RADIUS')}m）・置いた人が倒されると消える`);
  out.push(`${grenadeCount(id, c)} 個持てる・${grenadeRegenTime(id, c)} 秒で 1 つ回復`);
  return out;
}

const SLOT_LABEL: Record<Slot, string> = { primary: 'メイン武器', secondary: 'サブ武器' };
const SLOT_EN: Record<Slot, string> = { primary: 'PRIMARY', secondary: 'SECONDARY' };

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', parent?: HTMLElement, text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent?.appendChild(e);
  return e;
};

/** 2D のキャンバスを写す（同じキャンバスは 1 か所にしか置けないため） */
function copyCanvas(src: HTMLCanvasElement, cls = ''): HTMLCanvasElement {
  const c = document.createElement('canvas');
  if (cls) c.className = cls;
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d')?.drawImage(src, 0, 0);
  return c;
}

/** 照門・照星の印（3D のサイトがないので絵で描く） */
const IRON_ICON =
  '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"><path d="M8 34h32"/><path d="M11 34V20h9v14M14 24h3"/><path d="M33 34V22M30 34v-8M36 34v-8"/><circle cx="33" cy="20" r="1.6" fill="currentColor"/></svg>';

/** 武器・サイトの絵を作り置きする（ロードアウト画面と要約で共通） */
class Thumbs {
  private readonly cache = new Map<string, HTMLCanvasElement>();
  constructor(private preview: WeaponPreview | null) {}
  setPreview(p: WeaponPreview) {
    this.preview = p;
    this.cache.clear();
  }
  weapon(id: WeaponId, c: WeaponCustom): HTMLCanvasElement | null {
    if (!this.preview) return null;
    const k = `w:${id}:${customKey(c)}`;
    let v = this.cache.get(k);
    if (!v) this.cache.set(k, (v = this.preview.thumb(id, c)));
    return v;
  }
  sight(id: SightId): HTMLCanvasElement | null {
    if (!this.preview || id === 'iron') return null;
    const k = `s:${id}`;
    let v = this.cache.get(k);
    if (!v) this.cache.set(k, (v = this.preview.sightThumb(id)));
    return v;
  }
  grenade(id: GrenadeId): HTMLCanvasElement | null {
    if (!this.preview) return null;
    const k = `g:${id}`;
    let v = this.cache.get(k);
    if (!v) this.cache.set(k, (v = this.preview.grenadeThumb(id)));
    return v;
  }
}

const thumbs = new Thumbs(null);

/** 読み込みが終わったら、武器の 3D 表示の描き手で絵を作れるようにする */
export function setThumbRenderer(p: WeaponPreview): void {
  thumbs.setPreview(p);
}

// ---------------------------------------------------------------------------
// 保存した 5 つの枠の列（ロードアウト画面・試合の前の画面・一時停止画面で付け替えて使う）
// ---------------------------------------------------------------------------
export class SlotList {
  readonly el: HTMLElement;
  constructor(
    private readonly store: LoadoutStore,
    private readonly ccfg: CharactersConfig,
    private readonly wcfg: WeaponsConfig,
  ) {
    this.el = h('div', 'lo-slots');
    this.refresh();
  }

  refresh(): void {
    const s = this.store;
    this.el.innerHTML = '';
    s.slots.forEach((l, i) => {
      const b = h('button', `lo-slot ${i === s.active ? 'selected' : ''}`, this.el);
      b.type = 'button';
      b.style.setProperty('--char', this.ccfg[l.character].COLOR);
      b.addEventListener('click', () => s.select(i));
      const img = h('img', '', b);
      img.src = PORTRAITS[l.character];
      img.alt = '';
      img.draggable = false;
      h('span', 'lo-num', b, String(i + 1));
      const t = h('span', 'lo-text', b);
      h('b', '', t, l.name);
      h('small', '', t, this.ccfg[l.character].NAME);
      h('span', 'lo-wpn', t, `${this.wcfg[l.primary].SHORT} ＋ ${this.wcfg[l.secondary].SHORT}`);
      if (i === s.active) h('i', 'lo-active', b, '使用中');
    });
  }
}

// ---------------------------------------------------------------------------
// ロードアウト画面
// ---------------------------------------------------------------------------
export class LoadoutScreen {
  readonly el: HTMLElement;
  /** 戻る（前の画面へ）。main.ts が決める */
  onBack: () => void = () => {};
  private readonly crumb: HTMLElement;
  private readonly slotsHost: HTMLElement;
  private readonly overview: HTMLElement;
  private readonly pickEl: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly charHost: HTMLElement;
  private readonly nameInput: HTMLInputElement;
  private readonly tiles: HTMLElement;
  private readonly infoEl: HTMLElement;
  private readonly previewHost: HTMLElement;
  private pick: Pick | null = null;
  private readonly thumbs = thumbs;
  private preview: WeaponPreview | null = null;
  private heldKey = '';

  constructor(
    private readonly store: LoadoutStore,
    private readonly slots: SlotList,
    private readonly charSelect: CharacterSelect,
    private readonly ccfg: CharactersConfig,
    private readonly wcfg: WeaponsConfig,
    private readonly acfg: AttachmentsConfig,
  ) {
    this.el = h('div', 'lo-screen');
    const head = h('header', 'lo-head', this.el);
    const back = h('button', 'back', head, '← 戻る');
    back.type = 'button';
    back.addEventListener('click', () => this.back());
    const title = h('div', 'lo-title', head);
    h('div', 'kicker', title, 'LOADOUT');
    h('h2', '', title, 'ロードアウト');
    this.crumb = h('div', 'lo-crumb', head);
    h('div', 'lo-keys', head, 'クリック：選ぶ　Esc：戻る');

    const body = h('div', 'lo-body', this.el);
    const left = h('aside', 'lo-col-slots', body);
    h('div', 'lo-label', left, '保存した組み合わせ');
    this.slotsHost = h('div', '', left);
    h('p', 'lo-note', left, '押した枠が「使用中」になり、試合はその組み合わせで出撃する。変えた内容はすぐ保存される。');

    const center = h('section', 'lo-center', body);
    this.overview = h('div', 'lo-overview', center);
    const nameRow = h('label', 'lo-name', this.overview);
    h('span', 'lo-label', nameRow, '名前');
    this.nameInput = h('input', '', nameRow);
    this.nameInput.type = 'text';
    this.nameInput.maxLength = LOADOUT_NAME_MAX;
    this.nameInput.spellcheck = false;
    this.nameInput.addEventListener('input', () => store.update({ ...store.current, name: this.nameInput.value }));
    this.nameInput.addEventListener('change', () => this.refresh());
    this.nameInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') this.nameInput.blur();
    });
    const reset = h('button', 'small-btn lo-reset', nameRow, '最初の組み合わせに戻す');
    reset.type = 'button';
    reset.addEventListener('click', () => store.reset());
    this.tiles = h('div', 'lo-tiles', this.overview);
    this.pickEl = h('div', 'lo-pick hidden', center);

    this.detail = h('aside', 'lo-detail', body);
    this.charHost = h('div', 'lo-char-host', this.detail);
    this.previewHost = h('div', 'lo-preview-host hidden', this.detail);
    this.infoEl = h('div', 'lo-info hidden', this.detail);
  }

  /** 読み込みが終わったら、武器の 3D 表示を付ける */
  setPreview(p: WeaponPreview): void {
    this.preview = p;
    this.previewHost.appendChild(p.canvas);
    this.refresh();
  }

  /** 開く（いつも中身の一覧から） */
  open(): void {
    this.pick = null;
    this.slotsHost.appendChild(this.slots.el);
    this.refresh();
  }

  /** Esc：選ぶ画面なら一覧へ、一覧なら前の画面へ */
  back(): void {
    if (this.pick) {
      this.pick = null;
      this.refresh();
    } else this.onBack();
  }

  refresh(): void {
    const l = this.store.current;
    this.slots.refresh();
    if (document.activeElement !== this.nameInput) this.nameInput.value = l.name;
    this.el.style.setProperty('--char', this.ccfg[l.character].COLOR);
    const p = this.pick;
    this.crumb.textContent = `${this.store.active + 1}　${l.name}` + (p ? `　／　${this.pickTitle(p)}` : '');
    this.overview.classList.toggle('hidden', !!p);
    this.pickEl.classList.toggle('hidden', !p);
    this.el.dataset.view = p ? p.kind : 'overview';
    if (!p) {
      this.renderOverview(l);
      // 右：キャラクターの 3D 表示（選ぶ一覧は出さない）
      this.charSelect.mount(this.charHost);
      this.charHost.classList.remove('hidden');
      this.previewHost.classList.add('hidden');
      this.infoEl.classList.add('hidden');
    } else if (p.kind === 'character') {
      // キャラクターを選ぶ：中央に一覧と 3D 表示をまとめて出す
      this.pickEl.innerHTML = '';
      const hd = h('div', 'lo-pick-head', this.pickEl);
      h('h3', '', hd, 'キャラクター');
      h('p', '', hd, 'カードを押すと、そのキャラクターになる（すぐ保存される）。アビリティ（Q）とパッシブの説明、3D の姿を見て選べる。');
      const done = h('button', 'primary lo-done', hd, '決定');
      const host = h('div', 'lo-char-pick', this.pickEl);
      this.charSelect.mount(host);
      done.type = 'button';
      done.addEventListener('click', () => this.back());
      this.detail.classList.add('hidden');
    } else if (p.kind === 'boost') {
      this.renderBoostPick(l);
    } else if (p.kind === 'grenade') {
      this.renderGrenadePick(l);
    } else {
      this.renderPick(l, p);
    }
    if (!p || p.kind !== 'character') this.detail.classList.remove('hidden');
  }

  private pickTitle(p: Pick): string {
    if (p.kind === 'character') return 'キャラクター';
    if (p.kind === 'boost') return 'ブースト';
    if (p.kind === 'grenade') return 'グレネード';
    if (p.kind === 'weapon') return SLOT_LABEL[p.slot];
    if (p.kind === 'sight') return `${SLOT_LABEL[p.slot]}のサイト`;
    return `${SLOT_LABEL[p.slot]}のアタッチメント ${p.index + 1}`;
  }

  // --- 中身の一覧 ---
  private renderOverview(l: Loadout) {
    this.tiles.innerHTML = '';
    // キャラクター
    const def = this.ccfg[l.character];
    const row = h('div', 'lo-row', this.tiles);
    h('div', 'lo-row-label', row, 'CHARACTER　キャラクター');
    const ct = h('button', 'lo-tile lo-tile-char', row);
    ct.type = 'button';
    ct.style.setProperty('--char', def.COLOR);
    const img = h('img', '', ct);
    img.src = PORTRAITS[l.character];
    img.alt = '';
    img.draggable = false;
    const ctx = h('span', 'lo-tile-text', ct);
    h('b', '', ctx, def.NAME);
    h('small', '', ctx, def.ROLE);
    h('span', 'lo-ab', ctx, `Q ${def.ABILITY.NAME}　／　${def.PASSIVE.NAME}`);
    ct.addEventListener('click', () => this.go({ kind: 'character' }));
    // 武器（メイン・サブ）
    for (const slot of ['primary', 'secondary'] as const) {
      const w = l[slot];
      const c = customOf(l, w);
      const d = customDef(this.wcfg[w], c);
      const r = h('div', 'lo-row', this.tiles);
      const lab = h('div', 'lo-row-label', r, `${SLOT_EN[slot]}　${SLOT_LABEL[slot]}`);
      h('kbd', '', lab, slot === 'primary' ? '1' : '2');
      const wr = h('div', 'lo-wrow', r);
      const wt = h('button', 'lo-tile lo-tile-weapon', wr);
      wt.type = 'button';
      const th = this.thumbs.weapon(w, c);
      const pic = h('span', 'lo-pic', wt);
      if (th) pic.appendChild(copyCanvas(th));
      const wtx = h('span', 'lo-tile-text', wt);
      h('b', '', wtx, this.wcfg[w].NAME);
      h('small', '', wtx, `${WEAPON_CLASS_LABEL[classOf(w, this.wcfg)].name}　装弾 ${d.MAG_SIZE}`);
      h('span', 'lo-brief', wtx, this.wcfg[w].BRIEF);
      wt.addEventListener('click', () => this.go({ kind: 'weapon', slot }));
      // サイト
      const st = this.modTile(wr, 'SIGHT', this.acfg.SIGHTS[c.sight].NAME, this.sightIcon(c.sight));
      st.addEventListener('click', () => this.go({ kind: 'sight', slot }));
      // アタッチメント 2 つ
      for (let i = 0; i < 2; i++) {
        const a = c.attachments[i] as AttachmentId | undefined;
        const at = this.modTile(wr, `ATTACH ${i + 1}`, a ? this.acfg.ATTACHMENTS[a].NAME : 'なし', this.attIcon(a ?? null), !a);
        at.addEventListener('click', () => this.go({ kind: 'att', slot, index: i }));
      }
    }
    // グレネード
    const gr = h('div', 'lo-row', this.tiles);
    const glab = h('div', 'lo-row-label', gr, 'ORDNANCE　グレネード');
    h('kbd', '', glab, 'G');
    const gd = grenadesConfig[l.grenade];
    const gt = h('button', 'lo-tile lo-tile-gren', gr);
    gt.type = 'button';
    gt.style.setProperty('--gcol', GRENADE_COLORS[l.grenade]);
    const gic = h('span', 'lo-gren-pic', gt);
    const gth = this.thumbs.grenade(l.grenade);
    if (gth) gic.appendChild(copyCanvas(gth));
    else gic.innerHTML = grenadeSvg(l.grenade);
    const gtx = h('span', 'lo-tile-text', gt);
    const gname = h('b', '', gtx);
    gname.innerHTML = `${grenadeSvg(l.grenade, 'lo-gren-mini')}${gd.NAME}`;
    h('small', '', gtx, `${gd.SHORT}　${grenadeCount(l.grenade, this.wcfg.COMMON)} 個・${grenadeRegenTime(l.grenade, this.wcfg.COMMON)} 秒で回復`);
    gt.addEventListener('click', () => this.go({ kind: 'grenade' }));
    // ブースト（消耗戦）
    const br = h('div', 'lo-row', this.tiles);
    const blab = h('div', 'lo-row-label', br, 'BOOST　ブースト');
    h('kbd', '', blab, 'X');
    const bd = boostsConfig.BOOSTS[l.boost];
    const bt = h('button', 'lo-tile lo-tile-boost', br);
    bt.type = 'button';
    const bic = h('span', 'lo-boost-icon', bt);
    bic.innerHTML = boostSvg(l.boost);
    const btx = h('span', 'lo-tile-text', bt);
    h('b', '', btx, bd.NAME);
    h('small', '', btx, `${bd.SHORT}　ゲージ ${bd.COST} 点　消耗戦で使える`);
    bt.addEventListener('click', () => this.go({ kind: 'boost' }));
    h('p', 'lo-hint', this.tiles, '板を押すと選ぶ画面になる。武器ごとにサイト 1 つと、アタッチメントを 2 つまで付けられる（銃口に付ける物は 1 つまで）。グレネードは G で投げる（種類ごとに効き目が違う）。ブーストは消耗戦で、得点でゲージがたまると X で使える。');
    // 右の 3D のキャラクターに、メイン武器（サイト・アタッチメント付き）を持たせる
    const held = `${l.primary}|${customKey(customOf(l, l.primary))}`;
    if (held !== this.heldKey) {
      this.heldKey = held;
      this.charSelect.setWeapon(l.primary, customOf(l, l.primary));
    }
  }

  private modTile(parent: HTMLElement, label: string, name: string, icon: HTMLElement, empty = false): HTMLButtonElement {
    const b = h('button', `lo-tile lo-tile-mod ${empty ? 'empty' : ''}`, parent);
    b.type = 'button';
    h('span', 'lo-mod-label', b, label);
    const ic = h('span', 'lo-mod-icon', b);
    ic.appendChild(icon);
    h('span', 'lo-mod-name', b, name);
    return b;
  }

  private sightIcon(id: SightId): HTMLElement {
    const th = this.thumbs.sight(id);
    if (th) return copyCanvas(th);
    const s = h('span', 'lo-svg');
    s.innerHTML = IRON_ICON;
    return s;
  }

  private attIcon(id: AttachmentId | null): HTMLElement {
    const s = h('span', 'lo-svg');
    s.innerHTML = ATTACHMENT_ICONS[id ?? 'none'];
    return s;
  }

  private go(p: Pick) {
    this.pick = p;
    this.refresh();
  }

  // --- ブーストを選ぶ ---
  private renderBoostPick(l: Loadout) {
    this.pickEl.innerHTML = '';
    const hd = h('div', 'lo-pick-head', this.pickEl);
    h('h3', '', hd, 'ブースト');
    h('p', '', hd, '消耗戦で、得点するとゲージがたまり、満タンになったら X で使える（タイタンフォール 2 のブースト）。使うとゲージは 0 に戻り、またためられる。');
    const grid = h('div', 'lo-grid lo-grid-boost', this.pickEl);
    const show = (id: BoostId) => {
      const el = this.infoEl;
      el.innerHTML = '';
      const big = h('div', 'lo-boost-big', el);
      big.innerHTML = boostSvg(id);
      h('h4', '', el, boostsConfig.BOOSTS[id].NAME);
      h('p', 'lo-info-desc', el, boostsConfig.BOOSTS[id].DESC);
      const ul = h('ul', 'lo-notes', el);
      for (const f of boostFacts(id)) h('li', '', ul, f);
      for (const b of grid.children) b.classList.toggle('focus', (b as HTMLElement).dataset.key === id);
    };
    for (const id of BOOST_IDS) {
      const d = boostsConfig.BOOSTS[id];
      const b = h('button', `lo-tile lo-opt ${id === l.boost ? 'equipped' : ''}`, grid);
      b.type = 'button';
      b.dataset.key = id;
      const ic = h('span', 'lo-opt-icon lo-boost-icon', b);
      ic.innerHTML = boostSvg(id);
      const tx = h('span', 'lo-tile-text', b);
      h('b', '', tx, d.NAME);
      h('small', '', tx, `${d.SHORT}　ゲージ ${d.COST} 点`);
      if (id === l.boost) h('i', 'lo-eq', b, '装備中');
      b.addEventListener('pointerenter', () => show(id));
      b.addEventListener('focus', () => show(id));
      b.addEventListener('click', () => {
        this.store.update({ ...l, boost: id });
        this.pick = null;
        this.refresh();
      });
    }
    this.charHost.classList.add('hidden');
    this.previewHost.classList.add('hidden');
    this.infoEl.classList.remove('hidden');
    show(l.boost);
  }

  // --- グレネードを選ぶ ---
  private renderGrenadePick(l: Loadout) {
    this.pickEl.innerHTML = '';
    const hd = h('div', 'lo-pick-head', this.pickEl);
    h('h3', '', hd, 'グレネード');
    h('p', '', hd, 'G を押している間は構えて軌道が出て、離すと投げる（タイタンフォール 2 のオードナンス）。種類ごとに飛び方・効き目・持てる数が違う。');
    const grid = h('div', 'lo-grid lo-grid-gren', this.pickEl);
    const show = (id: GrenadeId) => {
      const el = this.infoEl;
      el.innerHTML = '';
      el.style.setProperty('--gcol', GRENADE_COLORS[id]);
      const big = h('div', 'lo-gren-big', el);
      const th = this.thumbs.grenade(id);
      if (th) big.appendChild(copyCanvas(th));
      else big.innerHTML = grenadeSvg(id);
      const title = h('h4', '', el);
      title.innerHTML = `${grenadeSvg(id, 'lo-gren-mini')}${grenadesConfig[id].NAME}`;
      h('p', 'lo-info-desc', el, grenadesConfig[id].DESC);
      const ul = h('ul', 'lo-notes', el);
      for (const f of grenadeFacts(id, this.wcfg)) h('li', '', ul, f);
      for (const b of grid.children) b.classList.toggle('focus', (b as HTMLElement).dataset.key === id);
    };
    for (const id of GRENADE_IDS) {
      const d = grenadesConfig[id];
      const b = h('button', `lo-tile lo-opt ${id === l.grenade ? 'equipped' : ''}`, grid);
      b.type = 'button';
      b.dataset.key = id;
      b.style.setProperty('--gcol', GRENADE_COLORS[id]);
      const ic = h('span', 'lo-opt-icon lo-gren-pic', b);
      const th = this.thumbs.grenade(id);
      if (th) ic.appendChild(copyCanvas(th));
      else ic.innerHTML = grenadeSvg(id);
      const tx = h('span', 'lo-tile-text', b);
      const nm = h('b', '', tx);
      nm.innerHTML = `${grenadeSvg(id, 'lo-gren-mini')}${d.NAME}`;
      h('small', '', tx, `${d.SHORT}　${d.STICK ? '刺さる' : '跳ねる'}・${grenadeCount(id, this.wcfg.COMMON)} 個`);
      if (id === l.grenade) h('i', 'lo-eq', b, '装備中');
      b.addEventListener('pointerenter', () => show(id));
      b.addEventListener('focus', () => show(id));
      b.addEventListener('click', () => {
        this.store.update({ ...l, grenade: id });
        this.pick = null;
        this.refresh();
      });
    }
    this.charHost.classList.add('hidden');
    this.previewHost.classList.add('hidden');
    this.infoEl.classList.remove('hidden');
    show(l.grenade);
  }

  // --- 選ぶ画面 ---
  private renderPick(l: Loadout, p: Exclude<Pick, { kind: 'character' } | { kind: 'boost' } | { kind: 'grenade' }>) {
    this.pickEl.innerHTML = '';
    const slot = p.slot;
    const w = l[slot];
    const cur = customOf(l, w);
    const hd = h('div', 'lo-pick-head', this.pickEl);
    h('h3', '', hd, this.pickTitle(p));
    h(
      'p',
      '',
      hd,
      p.kind === 'weapon'
        ? 'メインとサブに同じ武器は選べない（もう一方の武器を選ぶと入れ替わる）。サイトとアタッチメントは武器ごとに覚えている。'
        : p.kind === 'sight'
          ? `${this.wcfg[w].NAME}に付けられるサイト。倍率が高いほど遠くを狙いやすいが、のぞくのが遅く、視界はせまくなる。`
          : `${this.wcfg[w].NAME}に付けられるアタッチメント。2 つまで付けられる。もう一方の枠と同じ物や、同じ銃口の部品を選ぶと入れ替わる。`,
    );
    const grid = h('div', `lo-grid lo-grid-${p.kind}`, this.pickEl);
    const nowDef = customDef(this.wcfg[w], cur);

    type Opt = {
      key: string;
      name: string;
      sub: string;
      icon: HTMLElement;
      equipped: boolean;
      tag?: string;
      apply: () => Loadout;
      preview: () => { id: WeaponId; c: WeaponCustom };
      desc: string;
      /** 武器の一言の説明 */
      brief?: string;
      /** この前に武器種の見出しを入れる */
      head?: string;
    };
    const opts: Opt[] = [];
    if (p.kind === 'weapon') {
      const other = l[slot === 'primary' ? 'secondary' : 'primary'];
      let lastClass = '';
      for (const id of WEAPON_IDS) {
        const c = customOf(l, id);
        const th = this.thumbs.weapon(id, c);
        const icon = h('span', 'lo-pic');
        if (th) icon.appendChild(copyCanvas(th));
        const cls = classOf(id, this.wcfg);
        const head = cls !== lastClass ? `${WEAPON_CLASS_LABEL[cls].en}　${WEAPON_CLASS_LABEL[cls].name}` : undefined;
        lastClass = cls;
        opts.push({
          key: id,
          name: this.wcfg[id].NAME,
          sub: `${this.wcfg[id].SHORT}　有効距離 ${this.wcfg[id].RANGE}`,
          brief: this.wcfg[id].BRIEF,
          head,
          icon,
          equipped: id === w,
          tag: id === other ? `${slot === 'primary' ? 'サブ' : 'メイン'}と入れ替え` : undefined,
          apply: () => withWeapon(l, slot, id),
          preview: () => ({ id, c }),
          desc: this.wcfg[id].DESC,
        });
      }
    } else if (p.kind === 'sight') {
      for (const sid of allowedSights(this.wcfg[w])) {
        const sd = this.acfg.SIGHTS[sid];
        const c = { sight: sid, attachments: cur.attachments };
        const d = customDef(this.wcfg[w], c);
        const mag = d.ZOOMS.length ? d.ZOOMS.map((z) => magnification(z).toFixed(0)).join('/') : magnification(d.ADS_FOV_MUL).toFixed(1);
        opts.push({
          key: sid,
          name: sd.NAME,
          sub: `${sd.SHORT}　${mag}倍`,
          icon: this.sightIcon(sid),
          equipped: sid === cur.sight,
          apply: () => withCustom(l, w, c),
          preview: () => ({ id: w, c }),
          desc: sd.DESC,
        });
      }
    } else {
      const otherIdx = p.index === 0 ? 1 : 0;
      const mine = cur.attachments[p.index] ?? null;
      const other = cur.attachments[otherIdx] ?? null;
      const none = withAttachment(cur, p.index, null);
      opts.push({
        key: 'none',
        name: 'なし',
        sub: 'この枠に付けない',
        icon: this.attIcon(null),
        equipped: !mine,
        apply: () => withCustom(l, w, none),
        preview: () => ({ id: w, c: none }),
        desc: 'この枠には何も付けない。',
      });
      for (const aid of allowedAttachments(this.wcfg[w])) {
        const ad = this.acfg.ATTACHMENTS[aid];
        const c = withAttachment(cur, p.index, aid);
        const sameGroup = !!other && other !== aid && !!ad.GROUP && this.acfg.ATTACHMENTS[other].GROUP === ad.GROUP;
        opts.push({
          key: aid,
          name: ad.NAME,
          sub: ad.SHORT,
          icon: this.attIcon(aid),
          equipped: aid === mine,
          tag: aid === other ? `枠 ${otherIdx + 1} から移す` : sameGroup ? `枠 ${otherIdx + 1} と入れ替え（銃口）` : undefined,
          apply: () => withCustom(l, w, c),
          preview: () => ({ id: w, c }),
          desc: ad.DESC,
        });
      }
    }

    const showDetail = (o: Opt) => {
      const pv = o.preview();
      this.preview?.show(pv.id, pv.c);
      const next = customDef(this.wcfg[pv.id], pv.c);
      this.renderInfo(o.name, o.desc, nowDef, next, p.kind === 'weapon', o.brief);
      for (const b of grid.children) b.classList.toggle('focus', (b as HTMLElement).dataset.key === o.key);
    };
    for (const o of opts) {
      if (o.head) h('div', 'lo-grid-head', grid, o.head);
      const b = h('button', `lo-tile lo-opt ${o.equipped ? 'equipped' : ''}`, grid);
      b.type = 'button';
      b.dataset.key = o.key;
      const ic = h('span', 'lo-opt-icon', b);
      ic.appendChild(o.icon);
      const tx = h('span', 'lo-tile-text', b);
      h('b', '', tx, o.name);
      h('small', '', tx, o.sub);
      if (o.brief) h('span', 'lo-brief', tx, o.brief);
      if (o.equipped) h('i', 'lo-eq', b, '装備中');
      else if (o.tag) h('i', 'lo-tag', b, o.tag);
      b.addEventListener('pointerenter', () => showDetail(o));
      b.addEventListener('focus', () => showDetail(o));
      b.addEventListener('click', () => {
        this.store.update(o.apply());
        this.pick = null;
        this.refresh();
      });
    }
    // 右：3D の武器・説明・性能
    this.charHost.classList.add('hidden');
    this.previewHost.classList.remove('hidden');
    this.infoEl.classList.remove('hidden');
    showDetail(opts.find((o) => o.equipped) ?? opts[0]);
  }

  /** 説明と性能の棒。a：いまの数値、b：選ぼうとしている物を付けた数値 */
  private renderInfo(name: string, desc: string, a: CustomWeaponDef, b: CustomWeaponDef, weaponPick: boolean, brief?: string) {
    const el = this.infoEl;
    el.innerHTML = '';
    h('h4', '', el, name);
    if (weaponPick) h('p', 'lo-info-class', el, `${WEAPON_CLASS_LABEL[b.CLASS as WeaponClass].name}　${b.SHORT}`);
    if (brief) h('p', 'lo-info-brief', el, brief);
    h('p', 'lo-info-desc', el, desc);
    const changed = changedStats(a, b);
    const bars = h('div', 'lo-statbars', el);
    for (const s of STATS) {
      const fa = statFraction(this.wcfg, s, a);
      const fb = statFraction(this.wcfg, s, b);
      const row = h('div', `lo-stat ${changed.has(s.key) ? 'changed' : ''}`, bars);
      h('span', 'lo-stat-label', row, s.label);
      const track = h('i', 'lo-stat-track', row);
      const base = h('u', 'lo-stat-base', track);
      base.style.width = `${(Math.min(fa, fb) * 100).toFixed(1)}%`;
      if (fb > fa + 0.002) {
        const up = h('u', 'lo-stat-up', track);
        up.style.left = `${(fa * 100).toFixed(1)}%`;
        up.style.width = `${((fb - fa) * 100).toFixed(1)}%`;
      } else if (fa > fb + 0.002) {
        const dn = h('u', 'lo-stat-down', track);
        dn.style.left = `${(fb * 100).toFixed(1)}%`;
        dn.style.width = `${((fa - fb) * 100).toFixed(1)}%`;
      }
      const ta = s.text(a);
      const tb = s.text(b);
      const val = h('em', `lo-stat-val ${fb > fa + 0.002 ? 'up' : fa > fb + 0.002 ? 'down' : ''}`, row);
      val.textContent = ta === tb ? tb : `${ta} → ${tb}`;
    }
    // 数字に出ない効き目
    const notes: string[] = [];
    if (b.SUPPRESSED && !a.SUPPRESSED) notes.push('撃っても敵のミニマップに映らない・聞こえる距離が 1/3');
    if (b.THREAT && !a.THREAT) notes.push('のぞくと、見えている敵が赤く浮かび上がる');
    if (b.LASER && !a.LASER) notes.push('腰だめの間、狙っている所に赤い点');
    if (b.MOVE_SPREAD_MUL < a.MOVE_SPREAD_MUL) notes.push('動きながら撃ったときのばらつきが半分');
    if (b.FIRE_WHILE_SPRINT && !a.FIRE_WHILE_SPRINT) notes.push('走りながらでも撃てる（撃ってもダッシュが止まらない）');
    if (b.ADS_MOVE_MUL > a.ADS_MOVE_MUL + 1e-3) notes.push(`エイム中の移動の速さ ${Math.round(a.ADS_MOVE_MUL * 100)}% → ${Math.round(b.ADS_MOVE_MUL * 100)}%`);
    if (b.SCOPE && !a.SCOPE) notes.push('画面いっぱいにのぞくスコープ');
    if (b.ZOOMS.length > 1 && a.ZOOMS.length <= 1) notes.push('のぞいている間にホイールで倍率を切り替え');
    if (weaponPick) notes.push(`いま：${a.NAME}`);
    if (notes.length) {
      const ul = h('ul', 'lo-notes', el);
      for (const n of notes) h('li', '', ul, n);
    }
  }
}

// ---------------------------------------------------------------------------
// 試合の前・一時停止の画面の要約
// ---------------------------------------------------------------------------
export class LoadoutSummary {
  readonly el: HTMLElement;
  onEdit: () => void = () => {};
  private readonly slotsHost: HTMLElement;
  private readonly rows: HTMLElement;
  private readonly thumbs = thumbs;

  constructor(
    private readonly store: LoadoutStore,
    private readonly slots: SlotList,
    private readonly ccfg: CharactersConfig,
    private readonly wcfg: WeaponsConfig,
    private readonly acfg: AttachmentsConfig,
  ) {
    this.el = h('div', 'lo-summary');
    const top = h('div', 'lo-sum-top', this.el);
    h('div', 'prep-label', top, 'ロードアウト');
    const edit = h('button', 'lo-edit', top, 'ロードアウトを編集');
    edit.type = 'button';
    edit.addEventListener('click', () => this.onEdit());
    this.slotsHost = h('div', '', this.el);
    this.rows = h('div', 'lo-sum-rows', this.el);
  }

  /** 表示する（枠の列をこちらに付け替える） */
  mount(parent: HTMLElement): void {
    parent.appendChild(this.el);
    this.slotsHost.appendChild(this.slots.el);
    this.refresh();
  }

  refresh(): void {
    const l = this.store.current;
    this.slots.refresh();
    this.rows.innerHTML = '';
    for (const slot of ['primary', 'secondary'] as const) {
      const w = l[slot];
      const c = customOf(l, w);
      const r = h('button', 'lo-sum-row', this.rows);
      r.type = 'button';
      r.addEventListener('click', () => this.onEdit());
      h('span', 'lo-sum-slot', r, slot === 'primary' ? 'メイン' : 'サブ');
      const pic = h('span', 'lo-pic', r);
      const th = this.thumbs.weapon(w, c);
      if (th) pic.appendChild(copyCanvas(th));
      const t = h('span', 'lo-sum-text', r);
      h('b', '', t, this.wcfg[w].NAME);
      const chips = h('span', 'lo-chips', t);
      h('i', 'chip sight', chips, this.acfg.SIGHTS[c.sight].NAME);
      for (const a of c.attachments) h('i', 'chip', chips, this.acfg.ATTACHMENTS[a].NAME);
      if (!c.attachments.length) h('i', 'chip empty', chips, 'アタッチメントなし');
    }
    // グレネード
    const gr = h('button', 'lo-sum-row lo-sum-gren', this.rows);
    gr.type = 'button';
    gr.addEventListener('click', () => this.onEdit());
    gr.style.setProperty('--gcol', GRENADE_COLORS[l.grenade]);
    h('span', 'lo-sum-slot', gr, 'グレネード');
    const gi = h('span', 'lo-gren-icon', gr);
    gi.innerHTML = grenadeSvg(l.grenade);
    const gtt = h('span', 'lo-sum-text', gr);
    h('b', '', gtt, grenadesConfig[l.grenade].NAME);
    h('span', 'lo-chips', gtt).innerHTML = `<i class="chip">G で投げる</i>`;
    // ブースト
    const br = h('button', 'lo-sum-row lo-sum-boost', this.rows);
    br.type = 'button';
    br.addEventListener('click', () => this.onEdit());
    h('span', 'lo-sum-slot', br, 'ブースト');
    const bi = h('span', 'lo-boost-icon', br);
    bi.innerHTML = boostSvg(l.boost);
    const bt = h('span', 'lo-sum-text', br);
    h('b', '', bt, boostsConfig.BOOSTS[l.boost].NAME);
    h('span', 'lo-chips', bt).innerHTML = `<i class="chip">X で使う（消耗戦）</i>`;
    this.el.style.setProperty('--char', this.ccfg[l.character].COLOR);
  }
}
