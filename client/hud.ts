/**
 * HUD（画面に重ねて出す情報）。フェーズ1 では移動の確認に必要なものだけ出す。
 * - 中央：照準
 * - 下中央：速さと今の状態
 * - 左下：2段ジャンプ・スライディング加速・壁走りの残り時間
 * - 右下：直前の動きの記録
 * 武器まわりの表示は weaponHud.ts
 */
import type { MovementConfig } from '../config';
import { type MoveEvent, type PlayerMovement, STATE_LABEL } from '../shared/movement';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const EVENT_LABEL: Partial<Record<MoveEvent['type'], string>> = {
  jump: 'ジャンプ',
  doubleJump: '2段ジャンプ',
  wallrunStart: '壁走り',
  wallJump: '壁ジャンプ',
  mantle: 'よじ登り',
  respawn: 'スタート地点へ',
};

export class Hud {
  private speedValue = $('speed-value');
  private stateChip = $('state-chip');
  private doubleDot = $('ind-double');
  private slideBar = $('ind-slide-bar');
  private wallBar = $('ind-wall-bar');
  private wallRow = $('ind-wall');
  private log = $('action-log');
  private fpsEl = $('fps');
  private speedLines = $('speedlines');
  private help = $('help');
  private frames = 0;
  private fpsTime = 0;
  private lastState = '';

  constructor(private readonly cfg: MovementConfig) {}

  onEvents(events: MoveEvent[]): void {
    for (const e of events) {
      let text = EVENT_LABEL[e.type];
      if (e.type === 'slideStart') text = e.boosted ? 'スライディング＋加速' : 'スライディング';
      if (e.type === 'land' && e.impactSpeed > 12) text = '着地（高所）';
      if (e.type === 'wallrunEnd' && e.reason === 'timeout') text = '壁走り（時間切れ）';
      if (!text) continue;
      this.logText(text, e.type);
    }
  }

  /** 右下の記録に1行出す */
  logText(text: string, kind: string): void {
    const li = document.createElement('li');
    li.textContent = text;
    li.dataset.kind = kind;
    this.log.prepend(li);
    while (this.log.children.length > 6) this.log.lastElementChild?.remove();
    setTimeout(() => li.classList.add('fade'), 1800);
    setTimeout(() => li.remove(), 2600);
  }

  toggleHelp(): void {
    this.help.classList.toggle('hidden');
  }

  setHelpVisible(on: boolean): void {
    this.help.classList.toggle('hidden', !on);
  }

  update(dt: number, m: PlayerMovement, displaySpeed: number, speedFactor: number): void {
    this.speedValue.textContent = displaySpeed.toFixed(1);
    if (m.state !== this.lastState) {
      this.stateChip.textContent = STATE_LABEL[m.state];
      this.stateChip.dataset.state = m.state;
      this.lastState = m.state;
    }
    this.doubleDot.classList.toggle('ready', m.doubleJumpReady);
    const slideReady = 1 - m.slideCooldown / this.cfg.SLIDE_COOLDOWN;
    this.slideBar.style.transform = `scaleX(${Math.max(0, Math.min(1, slideReady))})`;
    this.slideBar.classList.toggle('ready', m.slideCooldown <= 0);
    const wall = m.state === 'wallrun';
    this.wallRow.classList.toggle('active', wall);
    this.wallBar.style.transform = `scaleX(${wall ? Math.max(0, 1 - m.stateTime / (this.cfg.WALLRUN_MAX_TIME * m.mods.wallrunTimeMul)) : 0})`;
    this.speedLines.style.opacity = (speedFactor * 0.9).toFixed(3);
    this.speedLines.style.setProperty('--spin', `${(performance.now() / 23) % 360}deg`);

    this.frames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 0.5) {
      this.fpsEl.textContent = `${Math.round(this.frames / this.fpsTime)} fps`;
      this.frames = 0;
      this.fpsTime = 0;
    }
  }
}
