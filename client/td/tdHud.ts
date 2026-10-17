/**
 * タワーディフェンスの画面表示（仕様 7.3）。
 * - 上：ウェーブ（何番目 / 全部）・準備時間の残り、コアの体力、残りの敵の数、大型兵器の体力
 * - 左上：ミニマップ（ui/minimap.ts。侵入ルートの線も描く）と、その下に次の・いまのウェーブの侵入ルートと敵の種類
 * - 右上：クレジットと、置いたタレットの数
 * - 左：チームの4人（キャラクター・体力・ダウン中の残り時間）
 * - 下：その場でできる操作の案内（購入・準備完了・蘇生・売る）と、蘇生の進み
 * - B：購入メニュー（buyMenu.ts。マウスで選ぶ）。置く場所を選んでいる間は、下に案内の帯
 * - 真ん中：ウェーブの開始・クリア・コアへの攻撃などの知らせ、クレジットの知らせ、ダウン中の表示
 * - Tab：チームの成績。試合が終わるとリザルト
 */
import { type BotDifficulty, type TdEnemyType, type TdPlaceable, type TdRoute, botsConfig, charactersConfig, isTurretType, tdConfig } from '../../config';
import { BuyMenu, type BuyMenuActions } from './buyMenu';
import type { TdThumbs } from './tdThumbs';
import type { TdMatch, TdParticipant, TdResult } from '../../shared/td/towerDefense';
import { formatClock } from '../attrition/attritionHud';

const el = (tag: string, cls: string, parent?: HTMLElement, html = '') => {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  parent?.appendChild(e);
  return e;
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export const ROUTE_NAMES: Record<TdRoute, string> = { front: '正面ゲート', left: '左の坂道', right: '右の搬入口' };
export const DIFF_NAMES: Record<BotDifficulty, string> = { easy: botsConfig.easy.NAME, normal: botsConfig.normal.NAME, hard: botsConfig.hard.NAME };

export interface TdResultActions {
  retry(): void;
  menu(): void;
}

export interface BestTd {
  /** 守りきった一番多いウェーブ（難易度ごと） */
  waves: Partial<Record<BotDifficulty, number>>;
  /** 勝ったときの一番短い時間（秒） */
  fastest: Partial<Record<BotDifficulty, number>>;
  wins: number;
  matches: number;
}

export interface BuyMenuState {
  open: boolean;
  /** 選んでいる（置こうとしている）タレット・設置物 */
  placing: TdPlaceable | null;
  /** 置けない理由 */
  reason: string;
  ok: boolean;
}

export interface PromptState {
  /** 下の案内 */
  text: string;
  /** 押し続けている進み（0〜1。蘇生・売る）。負なら出さない */
  progress: number;
  progressLabel: string;
}

export class TdHud {
  readonly root: HTMLElement;
  private readonly waveNum: HTMLElement;
  private readonly waveState: HTMLElement;
  private readonly coreBar: HTMLElement;
  private readonly coreNum: HTMLElement;
  private readonly coreBox: HTMLElement;
  private readonly enemiesNum: HTMLElement;
  private readonly bossBox: HTMLElement;
  private readonly bossBar: HTMLElement;
  private readonly routes: HTMLElement;
  private readonly routeTitle: HTMLElement;
  private readonly routeList: HTMLElement;
  /** 降りてくる降下ポッドの知らせ（防壁の上・要塞の中） */
  private readonly alerts: HTMLElement;
  private alertKey = '';
  /** 据えた迫撃砲兵の一覧（降下ポッドの知らせの下） */
  private readonly mortarList: HTMLElement;
  private mortarKey = '';
  private readonly credits: HTMLElement;
  private readonly turretCount: HTMLElement;
  private readonly team: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly progressBar: HTMLElement;
  private readonly progressLabel: HTMLElement;
  private readonly buy: HTMLElement;
  readonly menu: BuyMenu;
  private readonly armorTag: HTMLElement;
  private readonly feed: HTMLElement;
  private readonly popups: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly down: HTMLElement;
  private readonly board: HTMLElement;
  private readonly result: HTMLElement;
  private readonly order: HTMLElement;
  private bannerTimer = 0;
  private boardOpen = false;
  private boardTimer = 0;
  private teamTimer = 0;
  private creditsShown = -1;
  private routeKey = '';

  constructor(
    private readonly playerId: number,
    private readonly actions: TdResultActions,
    buyActions: BuyMenuActions,
    thumbs: TdThumbs | null,
  ) {
    this.root = el('div', 'at-hud td-hud', document.body);
    // 上：ウェーブ・コア・残りの敵
    const top = el('div', 'td-top', this.root);
    const wave = el('div', 'td-wave', top);
    el('small', '', wave, 'WAVE');
    this.waveNum = el('b', '', wave, '1 / 10');
    this.waveState = el('em', '', wave, '');
    this.coreBox = el('div', 'td-core', top);
    el('span', 'td-core-name', this.coreBox, 'コア');
    this.coreNum = el('b', 'td-core-num', this.coreBox, '');
    this.coreBar = el('i', 'td-core-bar', el('span', 'td-core-bg', this.coreBox));
    const en = el('div', 'td-enemies', top);
    el('small', '', en, '残りの敵');
    this.enemiesNum = el('b', '', en, '0');
    this.bossBox = el('div', 'td-boss hidden', this.root, '<span>大型兵器</span>');
    this.bossBar = el('i', '', el('span', 'td-boss-bg', this.bossBox));
    // 左上：侵入ルート
    this.routes = el('div', 'td-routes', this.root);
    this.routeTitle = el('div', 'td-routes-title', this.routes, '次のウェーブ');
    this.routeList = el('div', 'td-routes-list', this.routes);
    this.alerts = el('div', 'td-alerts', this.root);
    // 侵入ルートの欄の下：据えた迫撃砲兵
    this.mortarList = el('div', 'td-mortars', this.routes);
    // 右上：クレジット
    const cr = el('div', 'td-credits', this.root);
    el('small', '', cr, 'クレジット');
    this.credits = el('b', '', cr, '0');
    this.turretCount = el('span', 'td-turrets', cr, '');
    this.armorTag = el('span', 'td-armor-tag hidden', cr, 'アーマー装備中');
    // 左：チーム
    this.team = el('div', 'td-team', this.root);
    // 下：案内・押し続ける進み
    this.prompt = el('div', 'td-prompt', this.root);
    this.progress = el('div', 'td-progress hidden', this.root);
    this.progressLabel = el('span', '', this.progress, '');
    this.progressBar = el('i', '', el('s', '', this.progress));
    this.order = el('div', 'td-order hidden', this.root);
    // 購入メニュー（マウスで選ぶ）と、置く場所を選んでいる間の案内の帯
    this.menu = new BuyMenu(this.root, playerId, buyActions, thumbs);
    this.buy = el('div', 'td-place hidden', this.root);
    // 知らせ（消耗戦と同じ見た目）
    this.feed = el('ul', 'at-feed td-feed', this.root);
    this.popups = el('div', 'at-popups td-popups', this.root);
    this.banner = el('div', 'at-banner', this.root);
    this.down = el('div', 'at-death td-down hidden', this.root);
    this.board = el('div', 'at-board panel hidden', this.root);
    this.result = el('div', 'at-result td-result panel hidden', this.root);
  }

  show(on: boolean): void {
    this.root.classList.toggle('hidden', !on);
    document.body.classList.toggle('at-mode', on);
    document.body.classList.toggle('td-mode', on);
  }

  update(dt: number, m: TdMatch, tabHeld: boolean, buy: BuyMenuState, prompt: PromptState): void {
    const me = m.participantOf(this.playerId);
    // --- ウェーブ ---
    this.waveNum.innerHTML = `${m.wave}<small> / ${m.totalWaves}</small>`;
    let state = '';
    if (m.phase === 'intro') state = 'まもなく準備開始';
    else if (m.phase === 'prep') {
      const ready = [...m.participants.values()].filter((p) => p.ready).length;
      state = `準備 <b>${formatClock(m.prepLeft)}</b>　<span>準備完了 ${ready}/${m.participants.size}</span>`;
    } else if (m.phase === 'wave') state = m.waveHasBoss() ? '<span class="boss">大型兵器 接近中</span>' : '侵攻中';
    else if (m.phase === 'victory') state = '防衛成功';
    else state = '防衛失敗';
    if (this.waveState.innerHTML !== state) this.waveState.innerHTML = state;
    this.waveState.classList.toggle('prep', m.phase === 'prep');
    this.waveState.classList.toggle('low', m.phase === 'prep' && m.prepLeft < 6);
    // --- コア ---
    const k = Math.max(0, m.core.health / m.core.maxHealth);
    this.coreBar.style.transform = `scaleX(${k.toFixed(4)})`;
    this.coreNum.textContent = `${Math.ceil(Math.max(0, m.core.health))} / ${m.core.maxHealth}`;
    this.coreBox.classList.toggle('mid', k < 0.6 && k >= 0.3);
    this.coreBox.classList.toggle('low', k < 0.3);
    this.coreBox.classList.toggle('alert', m.coreUnderAttack());
    // --- 敵 ---
    this.enemiesNum.textContent = String(m.phase === 'wave' ? m.aliveEnemies + m.pendingEnemies : 0);
    // 大型兵器の体力
    let bossH = 0,
      bossMax = 0;
    for (const r of m.enemies.values()) {
      if (r.type !== 'boss') continue;
      const e = m.sim.entities.get(r.id);
      if (e && !e.dead) {
        bossH += e.health;
        bossMax += e.maxHealth;
      }
    }
    this.bossBox.classList.toggle('hidden', bossMax <= 0);
    if (bossMax > 0) this.bossBar.style.transform = `scaleX(${(bossH / bossMax).toFixed(4)})`;
    // --- ルート ---
    const routes = m.waveRoutes();
    const showRoutes = m.phase === 'prep' || m.phase === 'wave' || m.phase === 'intro';
    // 降下ポッドの降りる所（ルートの遠くの草原は除く。そこはルートの入り口と同じ）
    // （ウェーブ中は出さない：降りてくるポッドは画面の上の知らせでわかる。迫撃砲兵の欄のために短くする）
    const drops = showRoutes && m.phase !== 'wave' ? m.plannedDrops().filter((d) => d.zone.join !== 0) : [];
    const dropKey = drops.map((d) => d.zone.id).join(',');
    const key = `${m.phase}|${m.wave}|${routes.join(',')}|${m.waveHasBoss()}|${dropKey}`;
    if (key !== this.routeKey) {
      this.routeKey = key;
      this.routes.classList.toggle('hidden', !showRoutes);
      this.routeTitle.innerHTML = m.phase === 'wave' ? `<b>WAVE ${m.wave}</b> 侵攻ルート` : `<b>WAVE ${m.wave}</b> 次の侵入ルート`;
      const w = tdConfig.WAVES[m.wave - 1];
      const types = new Set<TdEnemyType>(w ? w.groups.map((g) => g.type) : []);
      const names = [...types].map((t) => `<span class="en ${t}">${esc(tdConfig.ENEMIES[t].NAME)}</span>`).join('');
      const zones = new Map<string, { name: string; kind: string }>();
      for (const d of drops) zones.set(d.zone.id, { name: d.zone.name, kind: d.zone.kind });
      const dropHtml = zones.size ? `<div class="td-dropzones"><small>降下ポッド</small>${[...zones.values()].map((z) => `<span class="dz ${z.kind}">${esc(z.name)}</span>`).join('')}</div>` : '';
      this.routeList.innerHTML = `${routes.map((r) => `<span class="rn">${ROUTE_NAMES[r]}</span>`).join('')}${m.waveHasBoss() ? '<span class="rn boss">大型兵器</span>' : ''}${dropHtml}<div class="td-types">${names}</div>`;
    }
    // --- 降りてくる降下ポッド（防壁の上・要塞の中）：場所ごとに、着地までの秒数 ---
    const incoming = new Map<string, { name: string; kind: string; eta: number; n: number }>();
    for (const pod of m.pods.values()) {
      if (pod.landed || pod.zone.kind === 'outer') continue;
      const eta = pod.landAt - m.sim.time;
      const cur = incoming.get(pod.zone.id);
      if (cur) {
        cur.eta = Math.min(cur.eta, eta);
        cur.n += pod.count;
      } else incoming.set(pod.zone.id, { name: pod.zone.name, kind: pod.zone.kind, eta, n: pod.count });
    }
    const list = [...incoming.entries()].sort((a, b) => a[1].eta - b[1].eta).slice(0, 3);
    // 並び（場所）が変わったときだけ作り直す（毎回作り直すと、出てくる動きが繰り返されてしまう）
    const ak = list.map(([id, a]) => `${id}:${a.n}`).join('|');
    if (ak !== this.alertKey) {
      this.alertKey = ak;
      this.alerts.innerHTML = list
        .map(([id, a]) => `<div class="td-alert ${a.kind}" data-z="${esc(id)}"><i></i><small>降下ポッド</small><b>${esc(a.name)}</b><em>${a.n} 体</em><span></span></div>`)
        .join('');
    }
    list.forEach(([, a], i) => {
      const sp = this.alerts.children[i]?.querySelector('span');
      const txt = Math.max(0, a.eta).toFixed(1);
      if (sp && sp.textContent !== txt) sp.textContent = txt;
    });
    // --- 据えた迫撃砲兵：場所・距離・砲撃中か（近い順に 3 つまで） ---
    const pp = m.player?.movement.pos;
    const ms = m.phase === 'wave' ? m.mortars() : [];
    const rows = ms
      .map((x) => {
        const r = m.enemies.get(x.id);
        const sp = r?.spot !== undefined && r.spot >= 0 ? m.td.mortarSpots[r.spot].name : '';
        return { id: x.id, name: sp, d: pp ? Math.hypot(x.pos.x - pp.x, x.pos.z - pp.z) : 0, firing: x.firing };
      })
      .sort((a, b) => a.d - b.d);
    const shown = rows.slice(0, 3);
    const mk = shown.map((x) => x.id).join(',') + `|${rows.length}`;
    if (mk !== this.mortarKey) {
      this.mortarKey = mk;
      this.mortarList.innerHTML =
        (shown.length ? '<small class="td-mortars-title">迫撃砲兵</small>' : '') +
        shown.map((x) => `<div class="td-mortar"><i></i><b>${esc(x.name)}</b><em></em><span></span></div>`).join('') +
        (rows.length > 3 ? `<div class="td-mortar more">ほかに ${rows.length - 3} 体</div>` : '');
    }
    shown.forEach((x, i) => {
      const row = this.mortarList.children[i + 1] as HTMLElement | undefined;
      if (!row) return;
      row.classList.toggle('firing', x.firing);
      const em = row.querySelector('em')!;
      const st = x.firing ? '砲撃中' : '応戦中';
      if (em.textContent !== st) em.textContent = st;
      const sp = row.querySelector('span')!;
      const txt = `${Math.round(x.d)}m`;
      if (sp.textContent !== txt) sp.textContent = txt;
    });
    // --- クレジット ---
    if (me) {
      if (me.credits !== this.creditsShown) {
        if (this.creditsShown >= 0 && me.credits > this.creditsShown) {
          this.credits.classList.remove('bump');
          void this.credits.offsetWidth;
          this.credits.classList.add('bump');
        }
        this.creditsShown = me.credits;
        this.credits.textContent = String(me.credits);
      }
      this.turretCount.textContent = `タレット ${m.turretCount(this.playerId)} / ${m.turretLimit()}`;
    }
    // --- チーム（0.1 秒ごと） ---
    this.teamTimer -= dt;
    if (this.teamTimer <= 0) {
      this.teamTimer = 0.1;
      this.team.innerHTML = [...m.participants.values()].map((p) => this.teamRow(m, p)).join('');
    }
    // --- 案内・押し続ける進み ---
    if (this.prompt.innerHTML !== prompt.text) this.prompt.innerHTML = prompt.text;
    this.progress.classList.toggle('hidden', prompt.progress < 0);
    if (prompt.progress >= 0) {
      this.progressBar.style.transform = `scaleX(${Math.min(1, prompt.progress).toFixed(3)})`;
      if (this.progressLabel.textContent !== prompt.progressLabel) this.progressLabel.textContent = prompt.progressLabel;
    }
    // --- 購入メニュー・置く場所の案内 ---
    this.menu.setOpen(buy.open, m);
    this.menu.update(dt, m);
    this.buy.classList.toggle('hidden', !buy.placing);
    if (buy.placing) {
      const name = isTurretType(buy.placing) ? tdConfig.TURRETS[buy.placing].NAME : tdConfig.ITEMS[buy.placing].NAME;
      const turns = buy.placing === 'barricade' || buy.placing === 'wiretrap' || buy.placing === 'decoy';
      const html = `<b>${esc(String(name))}</b> を置く場所を選ぶ　<kbd>左クリック</kbd>/<kbd>E</kbd> 置く${turns ? '　<kbd>R</kbd>/<kbd>ホイール</kbd> 回す' : ''}　<kbd>右クリック</kbd> メニューへ　<kbd>B</kbd> やめる${buy.reason ? `<span class="${buy.ok ? 'ok' : 'bad'}">${esc(buy.reason)}</span>` : ''}`;
      if (this.buy.innerHTML !== html) this.buy.innerHTML = html;
    }
    if (me) this.armorTag.classList.toggle('hidden', !(m.player && m.player.armor > 0 && me.armorWave === m.wave));

    // --- 開始前 ---
    if (m.phase === 'intro') {
      const n = Math.ceil(m.cfg.INTRO_TIME - m.phaseTime);
      this.setBanner(`<small>TOWER DEFENSE ― 軍事要塞</small><b>${n > 0 ? n : ''}</b><em>コアを ${m.totalWaves} ウェーブ守りきれ。第5・第10ウェーブには大型兵器が来る</em>`, 'intro', 0.2);
    }
    this.bannerTimer -= dt;
    if (this.bannerTimer <= 0 && m.phase !== 'intro') this.banner.classList.remove('show');

    // --- ダウン中・倒れている間 ---
    const p = m.player;
    if (p && (p.downed > 0 || p.dead) && m.phase !== 'victory' && m.phase !== 'defeat') {
      this.down.classList.remove('hidden');
      let html: string;
      if (p.downed > 0) {
        const reviver = p.reviverId >= 0 && p.reviveProgress > 0 ? m.sim.entities.get(p.reviverId) : undefined;
        html = reviver
          ? `<small>ダウン</small><b>${esc(reviver.name)} が蘇生中</b><em>${Math.round((p.reviveProgress / m.cfg.REVIVE_TIME) * 100)}%</em>`
          : `<small>ダウン</small><b>味方の蘇生を待つ</b><em>あと ${p.downed.toFixed(1)} 秒で倒れる</em>`;
      } else html = `<small>倒されました</small><b>要塞の中で復活</b><em>復活まで ${Math.max(0, p.respawnTimer).toFixed(1)} 秒</em>`;
      if (this.down.innerHTML !== html) this.down.innerHTML = html;
      this.down.classList.toggle('reviving', p.downed > 0 && p.reviveProgress > 0);
    } else this.down.classList.add('hidden');

    // --- 成績（Tab） ---
    if (tabHeld !== this.boardOpen) {
      this.boardOpen = tabHeld;
      this.board.classList.toggle('hidden', !tabHeld);
      this.boardTimer = 0;
    }
    if (this.boardOpen) {
      this.boardTimer -= dt;
      if (this.boardTimer <= 0) {
        this.boardTimer = 0.25;
        this.board.innerHTML = this.boardHtml(m, [...m.participants.values()], false);
      }
    }
    // 古い知らせを消す
    const now = performance.now();
    for (const li of [...this.feed.children] as HTMLElement[]) if (now - Number(li.dataset.t) > 7000) li.remove();
    for (const d of [...this.popups.children] as HTMLElement[]) if (now - Number(d.dataset.t) > 1800) d.remove();
  }

  private teamRow(m: TdMatch, p: TdParticipant): string {
    const e = m.sim.entities.get(p.id);
    const def = charactersConfig[p.character];
    let state = '';
    let cls = '';
    if (e) {
      if (e.downed > 0) {
        cls = 'downed';
        state = e.reviveProgress > 0 ? '<em class="rv">蘇生中</em>' : `<em class="dn">ダウン ${e.downed.toFixed(1)}</em>`;
      } else if (e.dead) {
        cls = 'dead';
        state = `<em class="dd">復活 ${Math.max(0, e.respawnTimer).toFixed(0)}</em>`;
      } else if (!p.isPlayer) {
        const b = m.allies.get(p.id);
        const what = !b ? '' : b.mode === 'build' ? 'タレット設置' : b.mode === 'revive' ? '蘇生へ' : b.defendingCore ? 'コアを防衛' : b.focus ? `${ROUTE_NAMES[b.focus]}へ` : '遊撃';
        state = `<em>${what}</em>`;
      }
    }
    const hp = e && !e.dead ? Math.max(0, e.health / e.maxHealth) : 0;
    const ready = m.phase === 'prep' && p.ready ? '<span class="rd">準備完了</span>' : '';
    return `<div class="td-mate ${p.isPlayer ? 'me' : ''} ${cls}"><i style="--char:${def.COLOR}"></i><b>${esc(p.name)}</b><small>${def.NAME}${p.isPlayer ? '' : '<span class="bot">BOT</span>'}</small>${ready}${state}<s><u style="transform:scaleX(${hp.toFixed(3)})"></u></s></div>`;
  }

  private setBanner(html: string, cls: string, time: number) {
    if (this.banner.innerHTML !== html) this.banner.innerHTML = html;
    this.banner.className = `at-banner show ${cls}`;
    this.bannerTimer = time;
  }

  /** 大きな知らせ */
  announce(title: string, sub: string, cls = '', time = 2.6, kicker = ''): void {
    this.setBanner(`${kicker ? `<small>${kicker}</small>` : ''}<b>${title}</b>${sub ? `<em>${sub}</em>` : ''}`, cls, time);
  }

  /** 右上の記録（ダウン・蘇生・タレットの破壊・大型兵器の撃破など） */
  log(html: string, mine = false): void {
    const li = el('li', mine ? 'mine' : '', this.feed, html);
    li.dataset.t = String(performance.now());
    while (this.feed.children.length > 6) this.feed.firstElementChild?.remove();
  }

  /** クレジットを得た */
  popup(amount: number, label: string, big = false): void {
    const d = el('div', `at-pop td-pop ${big ? 'big' : ''}`, this.popups, `<b>+${amount}</b><span>${label}</span>`);
    d.dataset.t = String(performance.now());
    while (this.popups.children.length > 4) this.popups.firstElementChild?.remove();
  }

  /** 小さな知らせ（できない操作など） */
  orderNote(text: string): void {
    this.order.textContent = text;
    this.order.classList.remove('hidden');
    this.order.classList.remove('flash');
    void this.order.offsetWidth;
    this.order.classList.add('flash');
  }
  hideOrderNote(): void {
    this.order.classList.add('hidden');
  }

  private boardHtml(m: TdMatch, list: TdParticipant[], final: boolean): string {
    const rows = list
      .map((s) => {
        const def = charactersConfig[s.character];
        return `<tr class="${s.isPlayer ? 'me' : ''}"><td class="nm"><i style="--char:${def.COLOR}"></i>${esc(s.name)}</td><td>${def.NAME}</td><td class="num">${s.kills}</td><td class="num">${s.turretKills}</td><td class="num">${s.bossKills}</td><td class="num">${s.revives}</td><td class="num">${s.downs}</td><td class="num">${s.turretsBuilt}</td><td class="num sc">${s.earned}</td></tr>`;
      })
      .join('');
    const head = final ? '' : `<div class="at-board-head"><span class="kicker">TOWER DEFENSE</span><b>タワーディフェンス</b><span>WAVE ${m.wave} / ${m.totalWaves}</span><small>コア ${Math.ceil(Math.max(0, m.core.health))} / ${m.core.maxHealth}　倒した敵 ${m.enemiesKilled}</small></div>`;
    return `${head}<div class="at-board-team ally"><h3>チーム<b>${m.enemiesKilled}</b></h3>
      <table><thead><tr><th>パイロット</th><th>キャラクター</th><th>撃破</th><th>タレット</th><th>ボス</th><th>蘇生</th><th>ダウン</th><th>設置</th><th>獲得</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  showResult(m: TdMatch, r: TdResult, best: BestTd, prev: BestTd): void {
    const me = r.participants.find((p) => p.isPlayer);
    const d = r.difficulty;
    const newWaves = r.wavesCleared > (prev.waves[d] ?? 0);
    const newFast = r.victory && (prev.fastest[d] === undefined || r.duration < prev.fastest[d]!);
    const bw = best.waves[d] ?? 0;
    const bf = best.fastest[d];
    this.result.innerHTML = `
      <div class="kicker">TOWER DEFENSE — 軍事要塞　難易度：${DIFF_NAMES[d]}</div>
      <h2 class="at-res-title ${r.victory ? 'win' : 'lose'}">${r.victory ? '防衛成功' : '防衛失敗'}</h2>
      <p class="at-res-reason">${r.victory ? `全 ${r.totalWaves} ウェーブを守りきった` : `第 ${r.wavesCleared + 1} ウェーブでコアが破壊された`}</p>
      <div class="td-res-core"><span>コアの残り</span><s><u style="transform:scaleX(${(r.coreHealth / r.coreMax).toFixed(3)})"></u></s><b>${Math.ceil(r.coreHealth)} / ${r.coreMax}</b></div>
      <div class="at-res-me">
        <div><small>守りきったウェーブ</small><b>${r.wavesCleared} / ${r.totalWaves}</b>${newWaves ? '<em>ベスト更新</em>' : ''}</div>
        <div><small>タイム</small><b>${formatClock(r.duration)}</b>${newFast ? '<em>ベスト更新</em>' : ''}</div>
        <div><small>チームで倒した敵</small><b>${r.enemiesKilled}</b></div>
        ${me ? `<div><small>あなたの撃破</small><b>${me.kills}</b></div><div><small>獲得クレジット</small><b>${me.earned}</b></div><div><small>蘇生</small><b>${me.revives}</b></div>` : ''}
      </div>
      <p class="at-res-best">ベスト記録（${DIFF_NAMES[d]}）　ウェーブ ${bw} / ${r.totalWaves}${bf !== undefined ? `・最速クリア ${formatClock(bf)}` : ''}　｜　防衛成功 ${best.wins} / ${best.matches} 回</p>
      <div class="at-board-final">${this.boardHtml(m, r.participants, true)}</div>
      <div class="ta-res-buttons">
        <button type="button" data-a="retry" class="primary">もう一度</button>
        <button type="button" data-a="menu">メインメニューへ</button>
      </div>`;
    this.result.querySelector('[data-a=retry]')!.addEventListener('click', () => this.actions.retry());
    this.result.querySelector('[data-a=menu]')!.addEventListener('click', () => this.actions.menu());
    this.result.classList.remove('hidden');
    this.root.classList.add('result-open');
  }

  get resultVisible(): boolean {
    return !this.result.classList.contains('hidden');
  }

  dispose(): void {
    this.menu.dispose();
    this.root.remove();
    document.body.classList.remove('at-mode', 'td-mode');
  }
}
