/**
 * タワーディフェンスの購入メニュー（ARMORY。仕様 5.3.5・7.3）。B で開き、マウスで選んで買う。
 * - 左：分類（タレット／設置物／強化／装備）。真ん中：カード（絵・名前・値段・持っている数）。右：マウスを乗せた物の説明と数値
 * - 置く物（タレット・設置物）は、カードを押すとメニューが閉じて、置く場所を選ぶ（controller.ts）
 * - 強化：自分のタレットの一覧。押すと次のレベルへ上がる（マウスを乗せたタレットは、世界の中に金の輪が出る）
 * - アーマー：押すとすぐに付く。ウェーブ中も買える（ほかは準備時間中だけ）
 */
import { type TdItemType, type TdPlaceable, type TurretType, TD_DEVICE_TYPES, TURRET_TYPES, isTurretType, tdConfig, tdNum } from '../../config';
import type { TdMatch, TurretState } from '../../shared/td/towerDefense';
import { lenH, sub } from '../../shared/math';
import type { TdThumbs, ThumbKey } from './tdThumbs';
import { ROUTE_NAMES } from './tdHud';

export type BuyId = TdPlaceable | 'armor';

export interface BuyMenuActions {
  /** カードを押した（置く物なら置く場所を選び始める・アーマーならすぐ買う） */
  buy(id: BuyId): void;
  upgrade(turretId: number): void;
  close(): void;
  /** 強化の一覧でマウスを乗せたタレット（-1 で外れた） */
  hoverTurret(id: number): void;
}

type CatId = 'turret' | 'device' | 'upgrade' | 'gear';
const CATS: Array<{ id: CatId; name: string; en: string }> = [
  { id: 'turret', name: 'タレット', en: 'TURRETS' },
  { id: 'device', name: '設置物', en: 'DEPLOYABLES' },
  { id: 'upgrade', name: '強化', en: 'UPGRADES' },
  { id: 'gear', name: '装備', en: 'GEAR' },
];

const el = (tag: string, cls: string, parent?: HTMLElement, html = '') => {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  parent?.appendChild(e);
  return e;
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const pct = (k: number) => `${k >= 1 ? '+' : ''}${Math.round((k - 1) * 100)}%`;

/** アーマーの絵（3D のモデルがないので線画） */
const ARMOR_SVG =
  '<svg viewBox="0 0 64 64" class="td-armor-ico"><path d="M32 6 L54 14 V30 C54 45 44 54 32 58 C20 54 10 45 10 30 V14 Z" class="o"/><path d="M32 13 L47 18.5 V30 C47 40.5 40.5 47 32 50.5 C23.5 47 17 40.5 17 30 V18.5 Z" class="i"/><path d="M24 31 l6 6 l11 -13" class="c"/></svg>';

export interface ItemInfo {
  name: string;
  short: string;
  desc: string;
  cost: number;
  stats: Array<[string, string]>;
}

/** カード・説明に出す情報 */
export function itemInfo(id: BuyId): ItemInfo {
  if (isTurretType(id)) {
    const d = tdConfig.TURRETS[id];
    const stats: Array<[string, string]> = [['体力', `${d.HEALTH}`]];
    if (id === 'mg') stats.push(['射程', `${tdNum(d, 'RANGE', 30)}m`], ['威力', `${tdNum(d, 'DAMAGE', 8)} × ${Math.round(60 / tdNum(d, 'FIRE_INTERVAL', 0.14))}発/分`], ['空の敵', '撃てる']);
    if (id === 'rocket') stats.push(['射程', `${tdNum(d, 'RANGE', 44)}m`], ['威力', `${tdNum(d, 'DAMAGE', 120)}（範囲 ${tdNum(d, 'RADIUS', 4)}m）`], ['間隔', `${tdNum(d, 'FIRE_INTERVAL', 3)}秒`], ['空の敵', '撃てない']);
    if (id === 'slow') stats.push(['範囲', `${tdNum(d, 'RADIUS', 9)}m`], ['動きの速さ', `${Math.round(tdNum(d, 'SLOW', 0.5) * 100)}%`]);
    if (id === 'repair') stats.push(['範囲', `${tdNum(d, 'RADIUS', 12)}m`], ['タレット', `毎秒 ${tdNum(d, 'TURRET_RATE', 18)}`], ['コア', `毎秒 ${tdNum(d, 'CORE_RATE', 10)}`]);
    return { name: d.NAME, short: 'TURRET', desc: String(d.DESC ?? ''), cost: d.COST, stats };
  }
  const d = tdConfig.ITEMS[id as TdItemType];
  const stats: Array<[string, string]> = [];
  if (id === 'decoy') stats.push(['体力', `${tdNum(d, 'HEALTH', 320)}`], ['突撃兵を引きつける', `${tdNum(d, 'ASSAULT_LURE', 14)}m`], ['持てる数', `${d.LIMIT}`]);
  if (id === 'wiretrap') stats.push(['爆発', `${tdNum(d, 'DAMAGE', 130)} × 3（範囲 ${tdNum(d, 'RADIUS', 4.2)}m）`], ['レーザーの幅', `最大 ${(tdNum(d, 'SPAN', 3.6) * 2).toFixed(1)}m`], ['使える回数', '1回'], ['持てる数', `${d.LIMIT}`]);
  if (id === 'barricade') stats.push(['体力', `${tdNum(d, 'HEALTH', 1200)}`], ['幅・高さ', `${tdNum(d, 'WIDTH', 4.2)}m・${tdNum(d, 'HEIGHT', 1.25)}m`], ['銃弾', `${Math.round(tdNum(d, 'ARMOR', 0.5) * 100)}% だけ受ける`], ['持てる数', `${d.LIMIT}`]);
  if (id === 'jumppad') {
    const v = tdNum(d, 'LAUNCH_UP', 14.5);
    stats.push(['跳ぶ高さ', `約 ${(v * v / (2 * 18)).toFixed(1)}m`], ['持てる数', `${d.LIMIT}`]);
  }
  if (id === 'armor') stats.push(['装甲', `+${tdNum(d, 'AMOUNT', 50)}`], ['効く間', 'このラウンドだけ'], ['買える時', '準備中・ウェーブ中']);
  return { name: d.NAME, short: d.SHORT, desc: d.DESC, cost: d.COST, stats };
}

/** 買えるか（場所を除く）：値段・持っている数・時間 */
export function buyState(m: TdMatch, pid: number, id: BuyId): { ok: boolean; reason: string; owned: number; limit: number; cost: number } {
  const me = m.participantOf(pid);
  const credits = me?.credits ?? 0;
  if (id === 'armor') {
    const c = m.armorCheck(pid);
    return { ok: c.ok, reason: c.reason ?? '', owned: me && me.armorWave === m.wave ? 1 : 0, limit: 1, cost: c.cost };
  }
  const turret = isTurretType(id);
  const cost = turret ? tdConfig.TURRETS[id].COST : tdConfig.ITEMS[id].COST;
  const owned = turret ? m.turretCount(pid) : m.deviceCount(pid, id);
  const limit = turret ? m.turretLimit() : tdConfig.ITEMS[id].LIMIT;
  let reason = '';
  if (m.phase !== 'prep') reason = '準備時間中だけ';
  else if (owned >= limit) reason = turret ? `タレットは ${limit} 基まで` : `${limit} つまで`;
  else if (credits < cost) reason = 'クレジットが足りない';
  return { ok: !reason, reason, owned, limit, cost };
}

/** タレットのある場所の名前（近いルート、またはコアの近く） */
export function turretPlaceName(m: TdMatch, t: TurretState): string {
  if (lenH(sub(t.pos, m.td.core)) < 16) return 'コアの近く';
  let best = '',
    bd = Infinity;
  for (const r of m.td.routes) {
    for (const p of [r.gate, ...r.turretPoints, ...r.path]) {
      const d = lenH(sub(p, t.pos));
      if (d < bd) {
        bd = d;
        best = ROUTE_NAMES[r.id];
      }
    }
  }
  return best || '要塞の中';
}

/** 強化の説明（いまのレベル → 次のレベルの数値） */
export function upgradeStats(m: TdMatch, t: TurretState): Array<[string, string, string]> {
  const nx = { ...t, level: t.level + 1 };
  const out: Array<[string, string, string]> = [];
  const hp = (x: TurretState) => Math.round(m.turretStat(x, 'HEALTH', 600));
  out.push(['体力', `${hp(t)}`, `${hp(nx)}`]);
  if (t.type === 'mg' || t.type === 'rocket') {
    out.push(['威力', `${Math.round(m.turretStat(t, 'DAMAGE'))}`, `${Math.round(m.turretStat(nx, 'DAMAGE'))}`]);
    out.push(['射程', `${Math.round(m.turretStat(t, 'RANGE'))}m`, `${Math.round(m.turretStat(nx, 'RANGE'))}m`]);
    out.push(['連射', `${(1 / m.turretStat(t, 'FIRE_INTERVAL', 1)).toFixed(t.type === 'mg' ? 1 : 2)}/秒`, `${(1 / m.turretStat(nx, 'FIRE_INTERVAL', 1)).toFixed(t.type === 'mg' ? 1 : 2)}/秒`]);
    if (t.type === 'rocket') out.push(['爆発の範囲', `${m.turretStat(t, 'RADIUS').toFixed(1)}m`, `${m.turretStat(nx, 'RADIUS').toFixed(1)}m`]);
  } else if (t.type === 'slow') {
    out.push(['範囲', `${m.turretStat(t, 'RADIUS').toFixed(1)}m`, `${m.turretStat(nx, 'RADIUS').toFixed(1)}m`]);
    out.push(['動きの速さ', `${Math.round(m.turretStat(t, 'SLOW') * 100)}%`, `${Math.round(m.turretStat(nx, 'SLOW') * 100)}%`]);
  } else {
    out.push(['範囲', `${m.turretStat(t, 'RADIUS').toFixed(1)}m`, `${m.turretStat(nx, 'RADIUS').toFixed(1)}m`]);
    out.push(['直す速さ', `毎秒 ${Math.round(m.turretStat(t, 'TURRET_RATE'))}`, `毎秒 ${Math.round(m.turretStat(nx, 'TURRET_RATE'))}`]);
  }
  return out;
}

const pips = (lv: number, max: number) => `<span class="td-pips">${Array.from({ length: max }, (_, i) => `<i class="${i < lv ? 'on' : ''}"></i>`).join('')}</span>`;

export class BuyMenu {
  readonly root: HTMLElement;
  private readonly dim: HTMLElement;
  private readonly credits: HTMLElement;
  private readonly timer: HTMLElement;
  private readonly tabs = new Map<CatId, HTMLElement>();
  private readonly grid: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly foot: HTMLElement;
  private readonly cards = new Map<BuyId, HTMLElement>();
  private readonly upRows = new Map<number, HTMLElement>();
  private cat: CatId = 'turret';
  private hover: BuyId | null = null;
  private hoverTurret = -1;
  private open = false;
  private refreshTimer = 0;
  private upKey = '';
  private detailKey = '';

  constructor(
    parent: HTMLElement,
    private readonly playerId: number,
    private readonly actions: BuyMenuActions,
    private readonly thumbs: TdThumbs | null,
  ) {
    this.dim = el('div', 'td-arm-dim hidden', parent);
    this.root = el('div', 'td-armory hidden', parent);
    const head = el('div', 'td-arm-head', this.root);
    el('div', 'td-arm-title', head, '<span class="kicker">ARMORY</span><b>購入メニュー</b>');
    this.timer = el('div', 'td-arm-timer', head);
    const cr = el('div', 'td-arm-credits', head, '<small>クレジット</small>');
    this.credits = el('b', '', cr, '0');
    const close = el('button', 'td-arm-close', head, '<kbd>B</kbd> 閉じる') as HTMLButtonElement;
    close.type = 'button';
    close.addEventListener('click', () => this.actions.close());
    const body = el('div', 'td-arm-body', this.root);
    const side = el('div', 'td-arm-cats', body);
    for (const c of CATS) {
      const b = el('button', 'td-arm-cat', side, `<small>${c.en}</small><b>${c.name}</b><em></em>`) as HTMLButtonElement;
      b.type = 'button';
      b.addEventListener('click', () => this.setCat(c.id));
      this.tabs.set(c.id, b);
    }
    this.grid = el('div', 'td-arm-grid', body);
    this.detail = el('div', 'td-arm-detail', body);
    this.foot = el('div', 'td-arm-foot', this.root);
    for (const id of [...TURRET_TYPES, ...TD_DEVICE_TYPES, 'armor'] as BuyId[]) this.makeCard(id);
    this.setCat('turret');
  }

  private makeCard(id: BuyId) {
    const info = itemInfo(id);
    const c = el('button', `td-arm-card ${id}`, undefined) as HTMLButtonElement;
    c.type = 'button';
    const pic = el('div', 'td-arm-pic', c);
    if (id === 'armor') pic.innerHTML = ARMOR_SVG;
    else if (this.thumbs) pic.appendChild(this.thumbs.get(id as ThumbKey));
    const ti = TURRET_TYPES.indexOf(id as TurretType);
    el('div', 'td-arm-card-text', c, `<b>${esc(info.name)}</b><span class="td-arm-cost">${info.cost}</span><span class="td-arm-own"></span>${ti >= 0 ? `<kbd>${ti + 1}</kbd>` : ''}`);
    el('div', 'td-arm-why', c);
    c.addEventListener('mouseenter', () => {
      this.hover = id;
      this.renderDetail(true);
    });
    c.addEventListener('focus', () => {
      this.hover = id;
      this.renderDetail(true);
    });
    c.addEventListener('click', () => this.actions.buy(id));
    this.cards.set(id, c);
  }

  setCat(c: CatId): void {
    this.cat = c;
    for (const [id, t] of this.tabs) t.classList.toggle('on', id === c);
    this.grid.innerHTML = '';
    this.grid.className = `td-arm-grid ${c}`;
    this.upKey = '';
    this.upRows.clear();
    const list: BuyId[] = c === 'turret' ? [...TURRET_TYPES] : c === 'device' ? [...TD_DEVICE_TYPES] : c === 'gear' ? ['armor'] : [];
    for (const id of list) this.grid.appendChild(this.cards.get(id)!);
    this.hover = list[0] ?? null;
    this.hoverTurret = -1;
    this.actions.hoverTurret(-1);
    this.detailKey = '';
    this.refreshTimer = 0;
  }

  setOpen(open: boolean, m: TdMatch): void {
    if (open === this.open) return;
    this.open = open;
    this.root.classList.toggle('hidden', !open);
    this.dim.classList.toggle('hidden', !open);
    if (open) {
      // ウェーブ中は装備（アーマー）から
      this.setCat(m.phase === 'wave' ? 'gear' : this.cat === 'gear' && m.phase === 'prep' ? 'turret' : this.cat);
      this.update(0, m);
    } else this.actions.hoverTurret(-1);
  }

  get isOpen(): boolean {
    return this.open;
  }

  update(dt: number, m: TdMatch): void {
    if (!this.open) return;
    this.refreshTimer -= dt;
    if (this.refreshTimer > 0) return;
    this.refreshTimer = 0.1;
    const pid = this.playerId;
    const me = m.participantOf(pid);
    this.credits.textContent = String(me?.credits ?? 0);
    const t = m.phase === 'prep' ? `準備 <b>${Math.floor(m.prepLeft / 60)}:${String(Math.floor(m.prepLeft % 60)).padStart(2, '0')}</b>` : m.phase === 'wave' ? `<span class="warn">WAVE ${m.wave} 侵攻中</span>　ウェーブ中は装備だけ買える` : '';
    if (this.timer.innerHTML !== t) this.timer.innerHTML = t;
    // 分類の横の数
    const counts: Record<CatId, string> = {
      turret: `${m.turretCount(pid)}/${m.turretLimit()}`,
      device: `${TD_DEVICE_TYPES.reduce((s, d) => s + m.deviceCount(pid, d), 0)}`,
      upgrade: `${m.myTurrets(pid).filter((x) => m.upgradeCheck(pid, x.id).ok).length || ''}`,
      gear: me && me.armorWave === m.wave ? '装備中' : '',
    };
    for (const [id, b] of this.tabs) {
      const em = b.querySelector('em')!;
      if (em.textContent !== counts[id]) em.textContent = counts[id];
      b.classList.toggle('dim', id !== 'gear' && m.phase !== 'prep');
    }
    // カード
    for (const [id, c] of this.cards) {
      if (!c.isConnected) continue;
      const s = buyState(m, pid, id);
      c.classList.toggle('off', !s.ok);
      c.classList.toggle('poor', !s.ok && s.reason === 'クレジットが足りない');
      const own = c.querySelector('.td-arm-own') as HTMLElement;
      const ot = id === 'armor' ? (s.owned ? '装備中' : '') : `${s.owned}/${s.limit}`;
      if (own.textContent !== ot) own.textContent = ot;
      const why = c.querySelector('.td-arm-why') as HTMLElement;
      if (why.textContent !== s.reason) why.textContent = s.reason;
    }
    if (this.cat === 'upgrade') this.renderUpgrades(m);
    this.renderDetail(false, m);
    const foot =
      this.cat === 'upgrade'
        ? '自分のタレットを、レベル 3 まで強化できる（威力・体力・射程・範囲が上がり、見た目も変わる）。売ると、強化に使った分も半分戻る'
        : this.cat === 'gear'
          ? 'アーマーは押すとすぐに付く。ダメージは先に装甲が受け、このラウンドが終わるとなくなる'
          : '押すと置く場所を選ぶ：<kbd>左クリック</kbd>/<kbd>E</kbd> 置く　<kbd>R</kbd>/<kbd>ホイール</kbd> 向きを回す　<kbd>右クリック</kbd> メニューへ戻る　｜　置いた物は、見て <kbd>E</kbd> 長押しで売れる（半額）';
    if (this.foot.innerHTML !== foot) this.foot.innerHTML = foot;
  }

  private renderUpgrades(m: TdMatch) {
    const pid = this.playerId;
    const mine = m.myTurrets(pid).sort((a, b) => a.id - b.id);
    const key = mine.map((t) => `${t.id}:${t.level}`).join(',');
    if (key !== this.upKey) {
      this.upKey = key;
      this.grid.innerHTML = '';
      this.upRows.clear();
      if (!mine.length) el('div', 'td-arm-empty', this.grid, 'タレットを置くと、ここで強化できる');
      for (const t of mine) {
        const row = el('div', 'td-arm-up', this.grid);
        const pic = el('div', 'td-arm-pic', row);
        if (this.thumbs) pic.appendChild(this.thumbs.get(t.type === 'mg' && t.level > 1 ? (`mg${t.level}` as ThumbKey) : (t.type as ThumbKey)));
        el('div', 'td-arm-up-text', row, `<b>${esc(tdConfig.TURRETS[t.type].NAME)}</b>${pips(t.level, tdConfig.UPGRADE.MAX_LEVEL)}<small>${esc(turretPlaceName(m, t))}</small><s><u></u></s>`);
        const btn = el('button', 'td-arm-up-btn', row) as HTMLButtonElement;
        btn.type = 'button';
        btn.addEventListener('click', () => this.actions.upgrade(t.id));
        row.addEventListener('mouseenter', () => {
          this.hoverTurret = t.id;
          this.actions.hoverTurret(t.id);
          this.renderDetail(true, m);
        });
        row.addEventListener('mouseleave', () => {
          this.actions.hoverTurret(-1);
        });
        this.upRows.set(t.id, row);
      }
      if (!mine.some((t) => t.id === this.hoverTurret)) this.hoverTurret = mine[0]?.id ?? -1;
    }
    for (const [id, row] of this.upRows) {
      const t = m.turrets.get(id);
      const e = m.sim.entities.get(id);
      if (!t) continue;
      const chk = m.upgradeCheck(pid, id);
      const max = t.level >= tdConfig.UPGRADE.MAX_LEVEL;
      const btn = row.querySelector('.td-arm-up-btn') as HTMLButtonElement;
      const html = max ? '<b>最大</b>' : `<small>Lv${t.level + 1} へ</small><b class="td-arm-cost">${chk.cost}</b>`;
      if (btn.innerHTML !== html) btn.innerHTML = html;
      btn.classList.toggle('off', !chk.ok);
      btn.title = chk.reason ?? '';
      row.classList.toggle('sel', id === this.hoverTurret);
      const u = row.querySelector('u') as HTMLElement;
      if (e) u.style.transform = `scaleX(${Math.max(0, e.health / e.maxHealth).toFixed(3)})`;
    }
  }

  private renderDetail(force: boolean, m?: TdMatch) {
    if (this.cat === 'upgrade') {
      if (!m) return;
      const t = m.turrets.get(this.hoverTurret);
      const key = t ? `u${t.id}:${t.level}:${m.upgradeCheck(this.playerId, t.id).reason ?? ''}` : 'u-';
      if (!force && key === this.detailKey) return;
      this.detailKey = key;
      if (!t) {
        this.detail.innerHTML = '<div class="td-arm-d-name"><b>強化</b></div><p class="td-arm-d-desc">準備時間中に、自分のタレットのレベルを上げられる（最大 3）。</p>';
        return;
      }
      const max = t.level >= tdConfig.UPGRADE.MAX_LEVEL;
      const chk = m.upgradeCheck(this.playerId, t.id);
      const rows = max ? [] : upgradeStats(m, t);
      this.detail.innerHTML = `<div class="td-arm-d-name"><small>UPGRADE</small><b>${esc(tdConfig.TURRETS[t.type].NAME)}</b>${pips(t.level, tdConfig.UPGRADE.MAX_LEVEL)}</div>
        <p class="td-arm-d-desc">${max ? 'もう最大のレベル。' : `レベル ${t.level} → <b>${t.level + 1}</b>。${t.level + 1 === 2 ? '側面に装甲板が付く。' : '四隅に柱と灯りが付く。'}`}</p>
        ${rows.length ? `<table class="td-arm-d-up">${rows.map(([k, a, b]) => `<tr><th>${k}</th><td>${a}</td><td class="to">→ ${b}</td></tr>`).join('')}</table>` : ''}
        <div class="td-arm-d-buy">${max ? '' : `<span class="td-arm-cost">${chk.cost}</span>`}<em class="${chk.ok ? 'ok' : 'bad'}">${chk.ok ? '押すと強化' : esc(chk.reason ?? '')}</em></div>`;
      return;
    }
    const id = this.hover;
    if (!id) return;
    const s = m ? buyState(m, this.playerId, id) : null;
    const key = `${id}:${s?.reason ?? ''}`;
    if (!force && key === this.detailKey) return;
    this.detailKey = key;
    const info = itemInfo(id);
    const mul = isTurretType(id) ? tdConfig.UPGRADE.DAMAGE_MUL : null;
    this.detail.innerHTML = `<div class="td-arm-d-pic"></div>
      <div class="td-arm-d-name"><small>${esc(info.short)}</small><b>${esc(info.name)}</b></div>
      <p class="td-arm-d-desc">${esc(info.desc)}</p>
      <table class="td-arm-d-stats">${info.stats.map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join('')}${mul ? `<tr><th>強化</th><td>レベル 3 まで（威力 ${pct(mul[mul.length - 1])}）</td></tr>` : ''}</table>
      <div class="td-arm-d-buy"><span class="td-arm-cost">${info.cost}</span>${s ? `<em class="${s.ok ? 'ok' : 'bad'}">${s.ok ? (id === 'armor' ? '押すとすぐに付く' : '押して置く場所を選ぶ') : esc(s.reason)}</em>` : ''}</div>`;
    const pic = this.detail.querySelector('.td-arm-d-pic') as HTMLElement;
    if (id === 'armor') pic.innerHTML = ARMOR_SVG;
    else if (this.thumbs) pic.appendChild(this.thumbs.get(id as ThumbKey));
  }

  dispose(): void {
    this.root.remove();
    this.dim.remove();
  }
}
