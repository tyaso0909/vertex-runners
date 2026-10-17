/**
 * キーボードとマウスの入力を集め、ティックごとに InputCommand を作る。
 * ゲームロジックはこのファイルが作るコマンドしか見ない。
 */
import { cameraConfig } from '../config';
import { type InputCommand, emptyCommand } from '../shared/input';

const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'KeyC', 'KeyT', 'KeyH', 'Tab',
  'KeyR', 'Digit1', 'Digit2', 'KeyG', 'KeyV', 'KeyQ', 'KeyE', 'KeyB', 'KeyF', 'KeyM', 'Digit3', 'Digit4', 'KeyX',
]);
/** 押した瞬間を数えておくキー（モードごとの操作。consumePress で取り出す） */
const PRESS_KEYS = new Set(['KeyE', 'KeyB', 'KeyF', 'KeyM', 'Digit1', 'Digit2', 'Digit3', 'Digit4']);

export class InputManager {
  yaw = 0;
  pitch = 0;
  private keys = new Set<string>();
  private jumpPresses = 0;
  private crouchPresses = 0;
  private respawnRequested = false;
  private firePresses = 0;
  private reloadPresses = 0;
  private meleePresses = 0;
  private abilityPresses = 0;
  private boostPresses = 0;
  private switchTo = -1;
  private switchNext = false;
  /** true の間、ホイールは倍率の切り替えに使う（ゲームが毎フレーム決める） */
  zoomWheel = false;
  private zoomSteps = 0;
  /** ホイールで倍率を何段変えたか（読むと 0 に戻る。上に回すと +） */
  consumeZoomSteps(): number {
    const n = this.zoomSteps;
    this.zoomSteps = 0;
    return n;
  }
  private mouseLeft = false;
  private mouseRight = false;
  /** エイム中などでマウス感度を下げる倍率（視野角に合わせて、見た目の動きの速さをそろえる） */
  sensitivityScale = 1;
  // 反動：これから加える量と、撃ち終わった後に戻す量
  private recoilPending = { pitch: 0, yaw: 0 };
  private recoilAccum = 0;
  private recoilRecoverDelay = 0;
  /** このフレームの視点の動き（武器の揺れに使う） */
  lookDeltaYaw = 0;
  lookDeltaPitch = 0;
  private helpToggleRequested = false;
  private presses = new Set<string>();
  /** ポインターロック（マウスを画面内に閉じ込める）が使えない環境では、ドラッグで視点を動かす */
  dragLook = false;
  private dragging = false;
  locked = false;
  onLockChange: (locked: boolean) => void = () => {};
  /**
   * カーソルで画面を操作している（タワーディフェンスの購入メニュー）。マウスの固定は外すが、一時停止にはしない。
   * キーボードの操作（移動など）はそのまま効き、マウスは視点を動かさず、撃たない
   */
  cursorMode = false;
  /** カーソルで操作している間に、画面（メニューの外）をクリックした回数 */
  private cursorClicks = 0;
  private relocking = false;

  constructor(private readonly element: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('pointerlockerror', () => {
      if (this.relocking) {
        // メニューを閉じて固定し直すのに失敗した：一時停止にする（クリックで戻れる）
        this.relocking = false;
        this.setLocked(false);
        return;
      }
      this.dragLook = true;
      this.setLocked(true);
    });
    element.addEventListener('mousedown', (e) => {
      if (this.cursorMode) {
        if (e.button === 0) this.cursorClicks++;
        return;
      }
      if (this.dragLook) {
        this.dragging = true;
        e.preventDefault();
      }
      if (!this.locked) return;
      if (e.button === 0) {
        this.mouseLeft = true;
        this.firePresses++;
      } else if (e.button === 2) {
        this.mouseRight = true;
      }
    });
    window.addEventListener('mouseup', (e) => {
      this.dragging = false;
      if (e.button === 0) this.mouseLeft = false;
      if (e.button === 2) this.mouseRight = false;
    });
    element.addEventListener(
      'wheel',
      (e) => {
        if (!this.locked || this.cursorMode) return;
        e.preventDefault();
        // 倍率を切り替えられるスコープをのぞいている間は、ホイールで倍率を変える（持ち替えない）
        if (Math.abs(e.deltaY) > 0) {
          if (this.zoomWheel) this.zoomSteps += e.deltaY < 0 ? 1 : -1;
          else this.switchNext = true;
        }
      },
      { passive: false },
    );
    element.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** マウスを画面に閉じ込めて操作を始める */
  async requestLock(fullscreen = false): Promise<void> {
    if (fullscreen && document.documentElement.requestFullscreen) {
      try {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
        // 全画面中は Ctrl+W などのブラウザのショートカットを奪えるので、Ctrl でのしゃがみも安全になる
        const kb = (navigator as Navigator & { keyboard?: { lock?: (codes?: string[]) => Promise<void> } }).keyboard;
        await kb?.lock?.();
      } catch {
        /* 全画面にできなくても続ける */
      }
    }
    if (this.dragLook) {
      this.setLocked(true);
      return;
    }
    try {
      const req = this.element.requestPointerLock() as unknown as Promise<void> | undefined;
      if (req && typeof req.then === 'function') await req;
    } catch {
      this.dragLook = true;
      this.setLocked(true);
    }
  }

  releaseLock(): void {
    this.cursorMode = false;
    if (document.pointerLockElement) document.exitPointerLock();
    this.setLocked(false);
  }

  /** カーソルで操作し始める（マウスの固定を外す。一時停止にはしない） */
  enterCursor(): void {
    if (this.cursorMode || !this.locked) return;
    this.cursorMode = true;
    this.cursorClicks = 0;
    this.mouseLeft = this.mouseRight = false;
    this.dragging = false;
    if (!this.dragLook && document.pointerLockElement) document.exitPointerLock();
  }

  /** カーソルの操作をやめて、マウスを固定し直す（クリック・キーを押した直後に呼ぶ） */
  exitCursor(): void {
    if (!this.cursorMode) return;
    this.cursorMode = false;
    this.mouseLeft = this.mouseRight = false;
    this.skipNextMove = true;
    if (this.dragLook || document.pointerLockElement === this.element) return;
    this.relocking = true;
    try {
      const req = this.element.requestPointerLock() as unknown as Promise<void> | undefined;
      if (req && typeof req.then === 'function')
        req.then(
          () => (this.relocking = false),
          () => {
            if (!this.relocking) return;
            this.relocking = false;
            this.setLocked(false);
          },
        );
    } catch {
      this.relocking = false;
      this.setLocked(false);
    }
  }

  /** カーソルの操作中に、メニューの外をクリックした（読むと 0 に戻る） */
  consumeCursorClick(): boolean {
    const n = this.cursorClicks;
    this.cursorClicks = 0;
    return n > 0;
  }

  private setLocked(v: boolean) {
    if (!v) this.cursorMode = false;
    if (this.locked === v) return;
    this.locked = v;
    this.skipNextMove = v;
    if (!v) {
      this.keys.clear();
      this.presses.clear();
      this.mouseLeft = this.mouseRight = false;
    }
    this.onLockChange(v);
  }

  private onPointerLockChange = () => {
    if (this.dragLook) return;
    const on = document.pointerLockElement === this.element;
    if (on) this.relocking = false;
    // カーソルの操作のために外した：固定はしていないが、遊んでいる途中のまま
    if (!on && this.cursorMode) return;
    this.setLocked(on);
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.locked) return;
    // カーソルの操作中の Esc：メニューを閉じて一時停止（Esc ではマウスを固定し直せない）
    if (this.cursorMode && e.code === 'Escape') {
      e.preventDefault();
      this.setLocked(false);
      return;
    }
    if (this.dragLook && e.code === 'Escape') {
      this.setLocked(false);
      return;
    }
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    this.keys.add(e.code);
    if (e.code === 'Space') this.jumpPresses++;
    if (e.code === 'ControlLeft' || e.code === 'ControlRight' || e.code === 'KeyC') this.crouchPresses++;
    if (e.code === 'KeyT') this.respawnRequested = true;
    if (e.code === 'KeyR') this.reloadPresses++;
    if (e.code === 'KeyV') this.meleePresses++;
    if (e.code === 'KeyQ') this.abilityPresses++;
    if (e.code === 'KeyX') this.boostPresses++;
    if (e.code === 'Digit1') this.switchTo = 0;
    if (e.code === 'Digit2') this.switchTo = 1;
    if (e.code === 'KeyH') this.helpToggleRequested = true;
    if (PRESS_KEYS.has(e.code)) this.presses.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private skipNextMove = false;

  private onMouseMove = (e: MouseEvent) => {
    if (!this.locked || this.cursorMode) return;
    if (this.dragLook && !this.dragging) return;
    // 画面に固定した直後の1回目と、ブラウザが時々出す異常に大きな移動量は無視する（視点が飛ぶのを防ぐ）
    if (this.skipNextMove) {
      this.skipNextMove = false;
      return;
    }
    if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
    const s = cameraConfig.MOUSE_SENSITIVITY * this.sensitivityScale;
    const dy = -e.movementX * s;
    const dp = -e.movementY * s * (cameraConfig.INVERT_Y ? -1 : 1);
    this.yaw += dy;
    this.pitch += dp;
    this.lookDeltaYaw += dy;
    this.lookDeltaPitch += dp;
    // 反動を自分で押さえた分は、あとで戻す量から引く
    if (dp < 0) this.recoilAccum = Math.max(0, this.recoilAccum + dp);
    const lim = (89 * Math.PI) / 180;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
  };

  private down(...codes: string[]) {
    return codes.some((c) => this.keys.has(c));
  }

  /** 1ティック分の入力コマンドを作る（押した瞬間の入力はここで消費される） */
  buildCommand(tick: number): InputCommand {
    const cmd = emptyCommand(tick);
    cmd.moveForward = (this.down('KeyW') ? 1 : 0) - (this.down('KeyS') ? 1 : 0);
    cmd.moveRight = (this.down('KeyD') ? 1 : 0) - (this.down('KeyA') ? 1 : 0);
    cmd.yaw = this.yaw;
    cmd.pitch = this.pitch;
    cmd.jumpHeld = this.down('Space');
    cmd.jumpPressed = this.jumpPresses > 0;
    cmd.crouchHeld = this.down('ControlLeft', 'ControlRight', 'KeyC');
    cmd.crouchPressed = this.crouchPresses > 0;
    cmd.sprintHeld = cameraConfig.AUTO_SPRINT || this.down('ShiftLeft', 'ShiftRight');
    cmd.fireHeld = this.mouseLeft;
    cmd.firePressed = this.firePresses > 0;
    cmd.adsHeld = this.mouseRight;
    cmd.reloadPressed = this.reloadPresses > 0;
    cmd.switchTo = this.switchTo;
    cmd.switchNext = this.switchNext;
    cmd.grenadeHeld = this.down('KeyG');
    cmd.meleePressed = this.meleePresses > 0;
    cmd.abilityPressed = this.abilityPresses > 0;
    cmd.interactHeld = this.down('KeyE');
    cmd.boostPressed = this.boostPresses > 0;
    this.boostPresses = 0;
    this.meleePresses = 0;
    this.abilityPresses = 0;
    this.jumpPresses = 0;
    this.crouchPresses = 0;
    this.firePresses = 0;
    this.reloadPresses = 0;
    this.switchTo = -1;
    this.switchNext = false;
    return cmd;
  }

  /** 撃った反動で視点を跳ね上げる（度）。recovery は撃ち終わったあとに自動で戻す割合 */
  addRecoil(pitchDeg: number, yawDeg: number): void {
    this.recoilPending.pitch += (pitchDeg * Math.PI) / 180;
    this.recoilPending.yaw += (yawDeg * Math.PI) / 180;
    this.recoilRecoverDelay = 0.12;
  }

  /** 毎フレーム呼ぶ：反動を少しずつ視点に加え、撃ち終わったら一部を戻す */
  update(dt: number, recovery: number): void {
    const k = 1 - Math.exp(-dt * 40);
    const dp = this.recoilPending.pitch * k;
    const dy = this.recoilPending.yaw * k;
    this.recoilPending.pitch -= dp;
    this.recoilPending.yaw -= dy;
    this.pitch += dp;
    this.yaw += dy;
    this.recoilAccum += dp * recovery;
    this.recoilRecoverDelay -= dt;
    if (this.recoilRecoverDelay <= 0 && this.recoilAccum > 0) {
      const back = Math.min(this.recoilAccum, this.recoilAccum * (1 - Math.exp(-dt * 7)) + dt * 0.002);
      this.pitch -= back;
      this.recoilAccum -= back;
    }
    const lim = (89 * Math.PI) / 180;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
  }

  /** 武器の揺れ用に、このフレームの視点の動きを取り出す */
  consumeLookDelta(): { yaw: number; pitch: number } {
    const r = { yaw: this.lookDeltaYaw, pitch: this.lookDeltaPitch };
    this.lookDeltaYaw = this.lookDeltaPitch = 0;
    return r;
  }

  resetRecoil(): void {
    this.recoilPending.pitch = this.recoilPending.yaw = 0;
    this.recoilAccum = 0;
  }

  consumeRespawn(): boolean {
    const r = this.respawnRequested;
    this.respawnRequested = false;
    return r;
  }

  consumeHelpToggle(): boolean {
    const r = this.helpToggleRequested;
    this.helpToggleRequested = false;
    return r;
  }

  /** そのキーを押したか（押した瞬間を1回だけ返す） */
  consumePress(code: string): boolean {
    return this.presses.delete(code);
  }

  /** 押した瞬間の記録を捨てる（モードを変えたときなど） */
  clearPresses(): void {
    this.presses.clear();
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }
}
