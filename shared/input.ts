/**
 * 入力コマンド。
 * プレイヤー（キーボード・マウス）もボットAIも、1ティックごとにこの形のデータを作ってゲームロジックへ渡す。
 * ゲームロジックはキーやマウスを直接見ない。こうしておくと、将来オンライン化したときに
 * このコマンドをそのままサーバーへ送れる。
 */
export interface InputCommand {
  /** 何番目のティックの入力か */
  tick: number;
  /** 前後の移動入力（-1〜1、前が +） */
  moveForward: number;
  /** 左右の移動入力（-1〜1、右が +） */
  moveRight: number;
  /** 水平の向き（ラジアン。0 で -Z 方向、左回りが +） */
  yaw: number;
  /** 上下の向き（ラジアン。上が +） */
  pitch: number;
  /** ジャンプボタンをこのティックで押した */
  jumpPressed: boolean;
  /** ジャンプボタンを押している */
  jumpHeld: boolean;
  /** しゃがみボタンを押している */
  crouchHeld: boolean;
  /** しゃがみボタンをこのティックで押した */
  crouchPressed: boolean;
  /** ダッシュボタンを押している */
  sprintHeld: boolean;
  /** 射撃ボタンを押している */
  fireHeld: boolean;
  /** 射撃ボタンをこのティックで押した（単発の武器用） */
  firePressed: boolean;
  /** エイム（ADS）ボタンを押している */
  adsHeld: boolean;
  /** リロードボタンをこのティックで押した */
  reloadPressed: boolean;
  /** 持ち替え先の武器スロット（0 または 1）。-1 なら持ち替えない */
  switchTo: number;
  /** もう一方の武器へ持ち替える（マウスホイール） */
  switchNext: boolean;
  /** グレネードボタンを押している（押している間はピンを抜いて構え、離すと投げる） */
  grenadeHeld: boolean;
  /** 格闘ボタンをこのティックで押した */
  meleePressed: boolean;
  /** アビリティボタンをこのティックで押した */
  abilityPressed: boolean;
  /** 「調べる」ボタン（E）を押している（蘇生・タレットの設置と売却。タワーディフェンス） */
  interactHeld: boolean;
  /** ブーストのボタン（X）をこのティックで押した（消耗戦） */
  boostPressed: boolean;
}

export const emptyCommand = (tick = 0): InputCommand => ({
  tick,
  moveForward: 0,
  moveRight: 0,
  yaw: 0,
  pitch: 0,
  jumpPressed: false,
  jumpHeld: false,
  crouchHeld: false,
  crouchPressed: false,
  sprintHeld: false,
  fireHeld: false,
  firePressed: false,
  adsHeld: false,
  reloadPressed: false,
  switchTo: -1,
  switchNext: false,
  grenadeHeld: false,
  meleePressed: false,
  abilityPressed: false,
  interactHeld: false,
  boostPressed: false,
});
