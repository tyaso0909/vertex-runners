/**
 * 消耗戦の画面表示（仕様 7.3）。
 * - 上：両チームのスコアと残り時間
 * - 右上：キルログ
 * - 真ん中：得点の知らせ（+5 パイロット撃破 など）、試合開始・終了の表示、倒されたときの復活までの時間
 * - Tab：スコアボード
 * - 試合が終わるとリザルト（勝敗・スコア・キル数・タイム・ベスト記録）
 */
import { type CharacterId, type WeaponId, charactersConfig, grenadesConfig, weaponsConfig } from '../../config';
import type { AttritionMatch, KillFeedEntry, MatchResult, PilotStats } from '../../shared/attrition';

const el = (tag: string, cls: string, parent?: HTMLElement, html = '') => {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  parent?.appendChild(e);
  return e;
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export const formatClock = (sec: number) => {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export interface BestAttrition {
  score: number;
  kills: number;
  wins: number;
  matches: number;
}

export interface AttritionResultActions {
  retry(): void;
  menu(): void;
}

export class AttritionHud {
  readonly root: HTMLElement;
  private readonly allyScore: HTMLElement;
  private readonly enemyScore: HTMLElement;
  private readonly allyBar: HTMLElement;
  private readonly enemyBar: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly goal: HTMLElement;
  private readonly feed: HTMLElement;
  private readonly popups: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly death: HTMLElement;
  private readonly board: HTMLElement;
  private readonly result: HTMLElement;
  private readonly invuln: HTMLElement;
  /** 小さな知らせ（ブーストの準備完了・使った・敵のマップハックなど） */
  private readonly notices: HTMLElement;
  private bannerTimer = 0;
  private boardOpen = false;
  private boardTimer = 0;

  constructor(
    private readonly playerTeam: number,
    private readonly playerId: number,
    private readonly actions: AttritionResultActions,
  ) {
    this.root = el('div', 'at-hud', document.body);
    const top = el('div', 'at-top', this.root);
    const ally = el('div', 'at-team ally', top);
    el('span', 'at-team-name', ally, '味方');
    this.allyScore = el('b', 'at-score', ally, '0');
    this.allyBar = el('i', 'at-bar', el('span', 'at-bar-bg', ally));
    const mid = el('div', 'at-mid', top);
    this.clock = el('b', 'at-clock', mid, '10:00');
    this.goal = el('small', 'at-goal', mid, '目標 300');
    const enemy = el('div', 'at-team enemy', top);
    this.enemyScore = el('b', 'at-score', enemy, '0');
    el('span', 'at-team-name', enemy, '敵');
    this.enemyBar = el('i', 'at-bar', el('span', 'at-bar-bg', enemy));
    this.feed = el('ul', 'at-feed', this.root);
    this.popups = el('div', 'at-popups', this.root);
    this.banner = el('div', 'at-banner', this.root);
    this.death = el('div', 'at-death hidden', this.root);
    this.invuln = el('div', 'at-invuln hidden', this.root, '復活直後：無敵');
    this.notices = el('div', 'at-notices', this.root);
    this.board = el('div', 'at-board panel hidden', this.root);
    this.result = el('div', 'at-result panel hidden', this.root);
  }

  show(on: boolean): void {
    this.root.classList.toggle('hidden', !on);
    document.body.classList.toggle('at-mode', on);
  }

  /** 毎フレーム：スコア・時間・倒されている間の表示 */
  update(dt: number, m: AttritionMatch, tabHeld: boolean): void {
    const limit = m.cfg.SCORE_LIMIT;
    const mine = m.scores[this.playerTeam as 0 | 1];
    const theirs = m.scores[(1 - this.playerTeam) as 0 | 1];
    this.allyScore.textContent = String(mine);
    this.enemyScore.textContent = String(theirs);
    this.allyBar.style.transform = `scaleX(${mine / limit})`;
    this.enemyBar.style.transform = `scaleX(${theirs / limit})`;
    this.clock.textContent = formatClock(m.phase === 'intro' ? m.cfg.TIME_LIMIT : m.timeLeft);
    this.clock.classList.toggle('low', m.phase === 'playing' && m.timeLeft < 60);
    this.goal.textContent = `目標 ${limit}`;

    // 試合開始前
    if (m.phase === 'intro') {
      const n = Math.ceil(m.cfg.INTRO_TIME - m.phaseTime);
      this.setBanner(`<small>消耗戦</small><b>${n > 0 ? n : ''}</b><em>先に ${limit} 点・または ${Math.round(m.cfg.TIME_LIMIT / 60)} 分たって多いチームの勝ち</em>`, 'intro', 0.2);
    }
    this.bannerTimer -= dt;
    if (this.bannerTimer <= 0 && m.phase !== 'intro') this.banner.classList.remove('show');

    // 倒されている間：倒した相手と、復活までの時間
    const p = m.player;
    if (p && p.dead && m.phase !== 'ended') {
      this.death.classList.remove('hidden');
      const k = p.killedBy >= 0 ? m.sim.infoOf(p.killedBy) : undefined;
      const who = k ? (k.kind === 'pilot' ? `${esc(k.name)}<small>（${charactersConfig[k.character].NAME}）</small>` : '歩兵') : '';
      this.death.innerHTML = `<small>倒されました</small>${who ? `<b>${who}</b>` : ''}<em>復活まで ${Math.max(0, p.respawnTimer).toFixed(1)} 秒</em>`;
    } else this.death.classList.add('hidden');
    this.invuln.classList.toggle('hidden', !(p && !p.dead && p.invuln > 0));

    // スコアボード（Tab を押している間。更新は 0.25 秒ごと）
    if (tabHeld !== this.boardOpen) {
      this.boardOpen = tabHeld;
      this.board.classList.toggle('hidden', !tabHeld);
      this.boardTimer = 0;
    }
    if (this.boardOpen) {
      this.boardTimer -= dt;
      if (this.boardTimer <= 0) {
        this.boardTimer = 0.25;
        this.board.innerHTML = this.boardHtml(m, m.sortedStats(), false);
      }
    }

    // キルログ・得点の知らせを古いものから消す
    const now = performance.now();
    for (const li of [...this.feed.children] as HTMLElement[]) if (now - Number(li.dataset.t) > 7000) li.remove();
    for (const d of [...this.popups.children] as HTMLElement[]) if (now - Number(d.dataset.t) > 1800) d.remove();
  }

  private setBanner(html: string, cls: string, time: number) {
    if (this.banner.innerHTML !== html) this.banner.innerHTML = html;
    this.banner.className = `at-banner show ${cls}`;
    this.bannerTimer = time;
  }

  /** 小さな知らせ（2.4 秒で消える。同時に 3 つまで） */
  notice(html: string, cls = ''): void {
    const d = el('div', `at-notice ${cls}`, this.notices, html);
    setTimeout(() => d.classList.add('out'), 2200);
    setTimeout(() => d.remove(), 2600);
    while (this.notices.children.length > 3) this.notices.firstElementChild?.remove();
  }

  /** 大きな知らせ（試合開始・残り時間など） */
  announce(title: string, sub: string, cls = '', time = 2.4): void {
    this.setBanner(`<b>${title}</b>${sub ? `<em>${sub}</em>` : ''}`, cls, time);
  }

  killfeed(entry: KillFeedEntry, sim: AttritionMatch['sim']): void {
    // 歩兵どうし・歩兵を倒しただけの記録は出さない（プレイヤーが関わるものは出す）
    const mine = entry.killer?.id === this.playerId || entry.victim.id === this.playerId || entry.assists.includes(this.playerId);
    if (entry.victim.kind === 'grunt' && !mine) return;
    const name = (x: KillFeedEntry['victim'] | null) => {
      if (!x) return '<span class="at-n world">—</span>';
      const cls = x.id === this.playerId ? 'me' : x.team === this.playerTeam ? 'ally' : 'enemy';
      const label = x.kind === 'grunt' ? '歩兵' : esc(x.name);
      const dot = x.character ? `<i style="--char:${charactersConfig[x.character as CharacterId].COLOR}"></i>` : '';
      return `<span class="at-n ${cls}">${dot}${label}</span>`;
    };
    const w = entry.weapon ? weaponsConfig[entry.weapon as WeaponId].SHORT : entry.source === 'grenade' ? grenadesConfig[entry.grenade ?? 'frag'].SHORT : entry.source === 'tick' ? 'TICK' : entry.source === 'melee' ? '格闘' : entry.source === 'turret' ? 'TURRET' : '—';
    const li = el('li', mine ? 'mine' : '', this.feed, `${name(entry.killer)}<span class="at-w">${w}${entry.head ? '<b>HS</b>' : ''}</span>${name(entry.victim)}`);
    li.dataset.t = String(performance.now());
    while (this.feed.children.length > 6) this.feed.firstElementChild?.remove();
    void sim;
  }

  /** プレイヤーが得点した */
  popup(points: number, reason: 'pilot' | 'grunt' | 'assist', victim: string): void {
    const label = reason === 'pilot' ? `パイロット撃破<small>${esc(victim)}</small>` : reason === 'grunt' ? '歩兵撃破' : `アシスト<small>${esc(victim)}</small>`;
    const d = el('div', `at-pop ${reason}`, this.popups, `<b>+${points}</b><span>${label}</span>`);
    d.dataset.t = String(performance.now());
    while (this.popups.children.length > 4) this.popups.firstElementChild?.remove();
  }

  private boardHtml(m: AttritionMatch, stats: PilotStats[], final: boolean): string {
    const team = (t: number) => {
      const rows = stats
        .filter((s) => s.team === t)
        .map((s) => {
          const def = charactersConfig[s.character];
          return `<tr class="${s.isPlayer ? 'me' : ''}"><td class="nm"><i style="--char:${def.COLOR}"></i>${esc(s.name)}</td><td>${def.NAME}</td><td class="num">${s.kills}</td><td class="num">${s.gruntKills}</td><td class="num">${s.assists}</td><td class="num">${s.deaths}</td><td class="num sc">${s.score}</td></tr>`;
        })
        .join('');
      const ally = t === this.playerTeam;
      return `<div class="at-board-team ${ally ? 'ally' : 'enemy'}"><h3>${ally ? '味方' : '敵'}<b>${m.scores[t as 0 | 1]}</b></h3>
        <table><thead><tr><th>パイロット</th><th>キャラクター</th><th>撃破</th><th>歩兵</th><th>アシスト</th><th>倒された</th><th>得点</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    };
    const head = final ? '' : `<div class="at-board-head"><span class="kicker">ATTRITION</span><b>消耗戦</b><span>${m.phase === 'playing' ? `残り ${formatClock(m.timeLeft)}` : ''}</span><small>目標 ${m.cfg.SCORE_LIMIT} 点　パイロット ${m.cfg.PILOT_KILL_SCORE}・歩兵 ${m.cfg.GRUNT_KILL_SCORE}・アシスト ${m.cfg.ASSIST_SCORE}</small></div>`;
    return `${head}${team(this.playerTeam)}${team(1 - this.playerTeam)}`;
  }

  showResult(m: AttritionMatch, r: MatchResult, best: BestAttrition, prevBest: BestAttrition, difficulty: string): void {
    const me = r.stats.find((s) => s.isPlayer);
    const won = r.winner === this.playerTeam;
    const draw = r.winner < 0;
    const title = draw ? '引き分け' : won ? '勝利' : '敗北';
    const reason = r.reason === 'score' ? `${draw ? '' : won ? '味方' : '敵'}が ${m.cfg.SCORE_LIMIT} 点に到達` : '時間切れ';
    const newScore = me && me.score > prevBest.score;
    const newKills = me && me.kills > prevBest.kills;
    this.result.innerHTML = `
      <div class="kicker">ATTRITION — ネオン都市　ボット：${difficulty}</div>
      <h2 class="at-res-title ${draw ? 'draw' : won ? 'win' : 'lose'}">${title}</h2>
      <p class="at-res-reason">${reason}</p>
      <div class="at-res-score"><span class="ally">${r.scores[this.playerTeam as 0 | 1]}</span><small>対</small><span class="enemy">${r.scores[(1 - this.playerTeam) as 0 | 1]}</span></div>
      ${
        me
          ? `<div class="at-res-me">
        <div><small>得点</small><b>${me.score}</b>${newScore ? '<em>ベスト更新</em>' : ''}</div>
        <div><small>パイロット撃破</small><b>${me.kills}</b>${newKills ? '<em>ベスト更新</em>' : ''}</div>
        <div><small>歩兵撃破</small><b>${me.gruntKills}</b></div>
        <div><small>アシスト</small><b>${me.assists}</b></div>
        <div><small>倒された</small><b>${me.deaths}</b></div>
        <div><small>タイム</small><b>${formatClock(r.duration)}</b></div>
      </div>
      <p class="at-res-best">ベスト記録　得点 ${best.score}・パイロット撃破 ${best.kills}　｜　勝利 ${best.wins} / ${best.matches} 試合</p>`
          : ''
      }
      <div class="at-board-final">${this.boardHtml(m, r.stats, true)}</div>
      <div class="ta-res-buttons">
        <button type="button" data-a="retry" class="primary">もう一度</button>
        <button type="button" data-a="menu">メインメニューへ</button>
      </div>`;
    this.result.querySelector('[data-a=retry]')!.addEventListener('click', () => this.actions.retry());
    this.result.querySelector('[data-a=menu]')!.addEventListener('click', () => this.actions.menu());
    this.result.classList.remove('hidden');
    this.root.classList.add('result-open');
  }

  hideResult(): void {
    this.result.classList.add('hidden');
    this.root.classList.remove('result-open');
  }

  get resultVisible(): boolean {
    return !this.result.classList.contains('hidden');
  }

  dispose(): void {
    this.root.remove();
    document.body.classList.remove('at-mode');
  }
}
