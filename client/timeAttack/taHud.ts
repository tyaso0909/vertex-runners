/**
 * タイムアタックの画面表示（仕様 7.3：経過タイム・残りターゲット数・ベスト記録との差）。
 * - 上：経過タイム、残りのターゲット、ベストとの差、次のチェックポイントまでの距離
 * - 真ん中：カウントダウン、チェックポイントの区間タイム、コースから落ちたときの知らせ
 * - 下：R 長押しのやり直しの進み具合
 * - ターゲットの位置の目印（画面の中の、近くの壊していないターゲット）
 * - ゴールしたときのリザルト（タイム・ペナルティ・記録・区間タイム・ベストとの差）
 */
import * as THREE from 'three';
import type { Target } from '../../shared/targets';
import { type TimeAttackResult, type TimeAttackRun, formatDelta, formatTime } from '../../shared/timeAttack';
import type { BestRecord } from './records';

const el = (tag: string, cls: string, parent?: HTMLElement, html = '') => {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  parent?.appendChild(e);
  return e;
};

export interface ResultActions {
  retry(): void;
  toggleGhost(): boolean;
  menu(): void;
}

export class TimeAttackHud {
  readonly root: HTMLElement;
  private readonly time: HTMLElement;
  private readonly targets: HTMLElement;
  private readonly best: HTMLElement;
  private readonly next: HTMLElement;
  private readonly center: HTMLElement;
  private readonly split: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly hold: HTMLElement;
  private readonly holdBar: HTMLElement;
  private readonly result: HTMLElement;
  private readonly marks: HTMLElement[] = [];
  private splitTimer = 0;
  private noticeTimer = 0;
  private centerTimer = 0;
  ghostOn = true;

  constructor(private readonly actions: ResultActions) {
    this.root = el('div', 'ta-hud hidden', document.body);
    const top = el('div', 'ta-top', this.root);
    this.time = el('div', 'ta-time', top, '0:00.00');
    const sub = el('div', 'ta-sub', top);
    this.targets = el('span', 'ta-targets', sub);
    this.best = el('span', 'ta-best', sub);
    this.next = el('div', 'ta-next', top);
    this.center = el('div', 'ta-center', this.root);
    this.split = el('div', 'ta-split', this.root);
    this.notice = el('div', 'ta-notice', this.root);
    this.hold = el('div', 'ta-hold', this.root, '<span>R 長押しでスタートからやり直し</span>');
    this.holdBar = el('i', '', this.hold);
    for (let i = 0; i < 20; i++) this.marks.push(el('div', 'ta-mark', this.root));
    this.result = el('div', 'ta-result panel hidden', this.root);
  }

  show(on: boolean): void {
    this.root.classList.toggle('hidden', !on);
    document.body.classList.toggle('ta-mode', on);
    if (!on) this.hideResult();
  }

  reset(run: TimeAttackRun, best: BestRecord | null): void {
    this.hideResult();
    this.time.textContent = formatTime(0);
    this.targets.textContent = `ターゲット ${run.total - run.destroyed} / ${run.total}`;
    this.best.textContent = best ? `ベスト ${formatTime(best.total)}` : 'ベスト なし';
    this.split.classList.remove('show');
    this.notice.classList.remove('show');
    this.center.textContent = '';
    this.center.className = 'ta-center';
  }

  countdown(n: number): void {
    this.center.textContent = String(n);
    this.center.className = 'ta-center pop';
    void this.center.offsetWidth;
    this.center.className = 'ta-center pop go-anim';
    this.centerTimer = 1.2;
  }

  go(): void {
    this.center.textContent = 'GO!';
    this.center.className = 'ta-center pop go';
    void this.center.offsetWidth;
    this.center.className = 'ta-center pop go go-anim';
    this.centerTimer = 0.9;
  }

  checkpoint(index: number, name: string, time: number, best: BestRecord | null, goal: boolean): void {
    const d = best && best.splits[index] !== undefined ? time - best.splits[index] : null;
    const cls = d === null ? '' : d < 0 ? 'faster' : 'slower';
    this.split.innerHTML = `<small>${goal ? 'ゴール' : `チェックポイント ${index + 1}`}　${name}</small><b>${formatTime(time)}</b>${d === null ? '' : `<em class="${cls}">${formatDelta(d)}</em>`}`;
    this.split.classList.remove('show');
    void this.split.offsetWidth;
    this.split.classList.add('show');
    this.splitTimer = 2.4;
    if (d !== null) {
      this.best.innerHTML = `ベストとの差 <em class="${cls}">${formatDelta(d)}</em>`;
    }
  }

  fallReset(name: string): void {
    this.notice.textContent = `コースから落ちました：${name} に戻ります`;
    this.notice.classList.add('show');
    this.noticeTimer = 2;
  }

  targetsLeft(left: number, total: number): void {
    this.targets.textContent = `ターゲット ${left} / ${total}`;
    this.targets.classList.remove('flash');
    void this.targets.offsetWidth;
    this.targets.classList.add('flash');
  }

  update(dt: number, run: TimeAttackRun, camera: THREE.Camera, playerPos: THREE.Vector3, targets: Target[], holdK: number, width: number, height: number): void {
    this.time.textContent = formatTime(run.time);
    this.time.classList.toggle('waiting', run.phase === 'countdown');
    // 次のチェックポイント
    if (run.phase !== 'finished') {
      const cp = run.course.checkpoints[run.next];
      const dist = Math.hypot(cp.pos.x - playerPos.x, cp.pos.z - playerPos.z);
      const goal = run.next === run.course.checkpoints.length - 1;
      this.next.textContent = `${goal ? 'ゴール' : `次 ${run.next + 1}/${run.course.checkpoints.length - 1}`}：${cp.name.replace('ゴール：', '')}　${Math.round(dist)}m`;
    } else this.next.textContent = '';
    // 消える表示
    this.splitTimer -= dt;
    if (this.splitTimer <= 0) this.split.classList.remove('show');
    this.noticeTimer -= dt;
    if (this.noticeTimer <= 0) this.notice.classList.remove('show');
    this.centerTimer -= dt;
    if (this.centerTimer <= 0 && run.phase !== 'countdown') this.center.textContent = '';
    // やり直しの長押し
    this.hold.classList.toggle('show', holdK > 0);
    this.holdBar.style.transform = `scaleX(${Math.min(1, holdK)})`;

    // ターゲットの目印（画面の中の、70m 以内の壊していないもの）
    const v = new THREE.Vector3();
    let k = 0;
    if (run.phase === 'running') {
      for (let i = 0; i < run.total && k < this.marks.length; i++) {
        const t = targets[i];
        if (!t?.alive) continue;
        v.set(t.pos.x, t.pos.y + (t.kind === 'drone' ? 0.6 : 2.2), t.pos.z);
        const dist = v.distanceTo(playerPos);
        if (dist > 70) continue;
        v.project(camera);
        if (v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) continue;
        const m = this.marks[k++];
        m.style.display = 'block';
        m.style.transform = `translate(${((v.x + 1) / 2) * width}px, ${((1 - v.y) / 2) * height}px) translate(-50%, -50%) rotate(45deg)`;
        m.style.opacity = String(Math.max(0.35, 1 - dist / 80));
      }
    }
    for (; k < this.marks.length; k++) this.marks[k].style.display = 'none';
  }

  showResult(r: TimeAttackResult, prevBest: BestRecord | null, isNew: boolean, courseName: string, cpNames: string[], characterName: string): void {
    const rows = r.splits
      .map((t, i) => {
        const prev = i === 0 ? 0 : r.splits[i - 1];
        const d = prevBest && prevBest.splits[i] !== undefined ? t - prevBest.splits[i] : null;
        return `<tr><td>${i + 1}</td><td>${cpNames[i] ?? ''}</td><td class="num">${formatTime(t - prev)}</td><td class="num">${formatTime(t)}</td><td class="num ${d === null ? '' : d < 0 ? 'faster' : 'slower'}">${d === null ? '—' : formatDelta(d)}</td></tr>`;
      })
      .join('');
    const dBest = prevBest ? r.total - prevBest.total : null;
    this.result.innerHTML = `
      <div class="kicker">TIME ATTACK — ${courseName}</div>
      <h2>${isNew ? '<span class="ta-new">ベスト記録更新！</span>' : 'ゴール！'}</h2>
      <div class="ta-res-main">
        <div><small>走った時間</small><b>${formatTime(r.time)}</b></div>
        <div><small>ターゲット</small><b>${r.destroyed} / ${r.targets}</b><em>${r.missed ? `壊し損ね ${r.missed} 体　+${r.penalty.toFixed(0)} 秒` : 'すべて破壊'}</em></div>
        <div class="ta-res-total"><small>記録</small><b>${formatTime(r.total)}</b><em>${dBest === null ? 'はじめての記録' : `ベスト ${formatTime(isNew ? r.total : prevBest!.total)}　${isNew ? `前のベストより ${formatDelta(dBest)}` : `ベストとの差 ${formatDelta(dBest)}`}`}</em></div>
      </div>
      <table class="ta-splits"><thead><tr><th></th><th>区間</th><th>区間タイム</th><th>通過</th><th>ベストとの差</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="ta-res-note">${characterName} の記録（キャラクターごとに保存）　コースから落ちた回数：${r.resets}</p>
      <div class="ta-res-buttons">
        <button type="button" data-a="retry" class="primary">もう一度（R 長押し）</button>
        <button type="button" data-a="ghost">ゴースト：${this.ghostOn ? 'オン' : 'オフ'}</button>
        <button type="button" data-a="menu">メニューへ（Esc）</button>
      </div>`;
    this.result.querySelector('[data-a=retry]')!.addEventListener('click', () => this.actions.retry());
    const gb = this.result.querySelector('[data-a=ghost]') as HTMLButtonElement;
    gb.addEventListener('click', () => {
      this.ghostOn = this.actions.toggleGhost();
      gb.textContent = `ゴースト：${this.ghostOn ? 'オン' : 'オフ'}`;
    });
    this.result.querySelector('[data-a=menu]')!.addEventListener('click', () => this.actions.menu());
    this.result.classList.remove('hidden');
    this.root.classList.add('result-open');
    this.split.classList.remove('show');
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
    document.body.classList.remove('ta-mode');
  }
}
