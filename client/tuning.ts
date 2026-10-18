/**
 * 調整パネル。一時停止中に画面右に出し、移動やカメラの数値をその場で変えて試せるようにする。
 * 変えた値は「JSONをコピー」で config/*.json に貼り付ければ保存できる。
 */
import { invalidateWeaponDefs } from '../shared/weaponCustom';
import GUI from 'lil-gui';
import {
  CHARACTER_IDS,
  DEFAULT_CAMERA,
  DEFAULT_CHARACTERS,
  DEFAULT_MOVEMENT,
  DEFAULT_WEAPONS,
  WEAPON_IDS,
  cameraConfig,
  charactersConfig,
  movementConfig,
  weaponsConfig,
} from '../config';

/** キャラクターの数値の日本語名（config/characters.json のキー） */
const CHAR_NAMES: Record<string, string> = {
  COOLDOWN: 'クールダウン（秒）',
  RANGE: '届く距離（m）',
  PULL_ACCEL: '引き寄せの加速',
  PULL_MAX_SPEED: '引き寄せの最高速',
  MAX_TIME: '最長の時間（秒）',
  RELEASE_DIST: '離す距離（m）',
  TARGET_PULL_DIST: '的を引き寄せる距離',
  TARGET_STAGGER_TIME: '的がよろめく時間',
  DURATION: '効果時間（秒）',
  WIDTH: '幅（m）',
  HEIGHT: '高さ（m）',
  DISTANCE: '出す距離（m）',
  RADIUS: '半径（m）',
  REVEAL_TIME: '見える時間（秒）',
  WAVE_SPEED: '波の速さ（m/秒）',
  SPEED_MUL: '移動速度の倍率',
  REGEN_MUL: '回復速度の倍率',
  INJECT_TIME: '注射の時間（秒）',
  WINDUP: '準備の時間（秒）',
  WALLRUN_TIME_MUL: '壁走り時間の倍率',
  FOOTSTEP_VOLUME: '足音の大きさ',
  REGEN_DELAY: '回復が始まるまで（秒）',
  REGEN_RATE_MUL: '回復速度の倍率',
  MARK_TIME: 'マップに映す時間（秒）',
  REGEN_RATE: '回復の速さ（/秒）',
  RESPAWN_TIME: '復活までの時間（秒）',
  SELF_GRENADE_DAMAGE_MUL: '自分のグレネードのダメージ倍率',
};

type Range = [number, number, number];

const MOVEMENT_GROUPS: Array<[string, Record<string, Range>]> = [
  [
    '地上',
    {
      WALK_SPEED: [1, 12, 0.1],
      SPRINT_SPEED: [3, 16, 0.1],
      CROUCH_SPEED: [0.5, 6, 0.1],
      GROUND_ACCEL: [5, 150, 1],
      GROUND_DECEL: [5, 150, 1],
      OVERSPEED_FRICTION: [0, 40, 0.5],
      OVERSPEED_STEER: [0, 20, 0.5],
      LANDING_GRACE: [0, 0.5, 0.01],
      MAX_HORIZONTAL_SPEED: [10, 50, 1],
    },
  ],
  [
    'ジャンプ・空中',
    {
      JUMP_VELOCITY: [2, 14, 0.1],
      DOUBLE_JUMP_VELOCITY: [2, 14, 0.1],
      DOUBLE_JUMP_REDIRECT: [0, 1, 0.05],
      DOUBLE_JUMP_MIN_HSPEED: [0, 10, 0.1],
      COYOTE_TIME: [0, 0.4, 0.01],
      JUMP_BUFFER: [0, 0.4, 0.01],
      GRAVITY: [5, 40, 0.5],
      AIR_CONTROL: [0, 1, 0.01],
      AIR_STEER_RATE: [1, 30, 0.5],
      AIR_MIN_SPEED: [0, 12, 0.1],
    },
  ],
  [
    'スライディング',
    {
      SLIDE_BOOST: [0, 10, 0.1],
      SLIDE_FRICTION: [0, 20, 0.1],
      SLIDE_COOLDOWN: [0, 5, 0.05],
      SLIDE_MIN_SPEED: [2, 12, 0.1],
      SLIDE_END_SPEED: [0.5, 8, 0.1],
      SLIDE_STEER: [0, 10, 0.1],
      SLIDE_GRAVITY_SCALE: [0, 4, 0.05],
    },
  ],
  [
    '壁走り',
    {
      WALLRUN_MIN_SPEED: [0, 12, 0.1],
      WALLRUN_ENTRY_MIN_SPEED: [0, 12, 0.1],
      WALLRUN_SPEED: [3, 20, 0.1],
      WALLRUN_ACCEL: [0, 30, 0.5],
      WALLRUN_MAX_TIME: [0.3, 5, 0.05],
      WALLRUN_HOLD_TIME: [0, 3, 0.05],
      WALLRUN_GRAVITY_SCALE: [0, 1, 0.01],
      WALLRUN_GRAVITY_RAMP: [0, 12, 0.1],
      WALLRUN_MAX_ANGLE: [10, 90, 1],
      WALLRUN_ENTRY_SPEED_KEEP: [0, 1, 0.05],
      WALLRUN_ATTACH_DIST: [0, 1, 0.01],
      WALLRUN_MIN_HEIGHT: [0, 3, 0.05],
      WALLJUMP_VELOCITY: [2, 16, 0.1],
      WALLJUMP_UP_ANGLE: [0, 85, 1],
      WALLJUMP_LOOK_INFLUENCE: [0, 1, 0.05],
      CAMERA_TILT_WALLRUN: [0, 30, 0.5],
    },
  ],
  [
    'よじ登り・体',
    {
      MANTLE_MAX_HEIGHT: [0.5, 3, 0.05],
      MANTLE_TIME: [0.05, 1, 0.01],
      STEP_HEIGHT: [0, 0.39, 0.01],
      CROUCH_HEIGHT: [0.8, 1.6, 0.01],
    },
  ],
];

const CAMERA_RANGES: Record<string, Range> = {
  FOV: [70, 110, 1],
  FOV_SPEED_KICK: [0, 25, 0.5],
  MOUSE_SENSITIVITY: [0.0005, 0.008, 0.0001],
  HEAD_BOB: [0, 0.1, 0.005],
  LANDING_DIP_MAX: [0, 0.5, 0.01],
};

const NAMES: Record<string, string> = {
  WALK_SPEED: '歩き速度',
  SPRINT_SPEED: 'ダッシュ速度',
  CROUCH_SPEED: 'しゃがみ速度',
  GROUND_ACCEL: '加速',
  GROUND_DECEL: '停止の速さ',
  OVERSPEED_FRICTION: '勢いの減衰',
  OVERSPEED_STEER: '勢い中の曲がりやすさ',
  LANDING_GRACE: '着地後の猶予',
  MAX_HORIZONTAL_SPEED: '速度上限',
  JUMP_VELOCITY: 'ジャンプ初速',
  DOUBLE_JUMP_VELOCITY: '2段ジャンプ初速',
  DOUBLE_JUMP_REDIRECT: '2段ジャンプの方向転換',
  DOUBLE_JUMP_MIN_HSPEED: '2段ジャンプの最低水平速度',
  COYOTE_TIME: '足場を外れた後の猶予',
  JUMP_BUFFER: 'ジャンプ先行入力',
  GRAVITY: '重力',
  AIR_CONTROL: '空中制御',
  AIR_STEER_RATE: '空中制御の基準',
  AIR_MIN_SPEED: '空中の最低速度',
  SLIDE_BOOST: '開始時の加速',
  SLIDE_FRICTION: '減速',
  SLIDE_COOLDOWN: '加速の再使用待ち',
  SLIDE_MIN_SPEED: '開始に必要な速度',
  SLIDE_END_SPEED: '終了する速度',
  SLIDE_STEER: '曲がりやすさ',
  SLIDE_GRAVITY_SCALE: '坂の効き',
  WALLRUN_MIN_SPEED: '開始に必要な速度',
  WALLRUN_ENTRY_MIN_SPEED: '開始時の最低速度',
  WALLRUN_SPEED: '壁走り速度',
  WALLRUN_ACCEL: '加速',
  WALLRUN_MAX_TIME: '最大時間',
  WALLRUN_HOLD_TIME: '落ち始めるまでの時間',
  WALLRUN_GRAVITY_SCALE: '重力倍率',
  WALLRUN_GRAVITY_RAMP: '落ち始めの強さ',
  WALLRUN_MAX_ANGLE: '入れる最大角度',
  WALLRUN_ENTRY_SPEED_KEEP: '速度の引き継ぎ',
  WALLRUN_ATTACH_DIST: '張り付く距離',
  WALLRUN_MIN_HEIGHT: '必要な高さ',
  WALLJUMP_VELOCITY: '壁ジャンプ速度',
  WALLJUMP_UP_ANGLE: '壁ジャンプ角度',
  WALLJUMP_LOOK_INFLUENCE: '視線の影響',
  CAMERA_TILT_WALLRUN: 'カメラの傾き',
  MANTLE_MAX_HEIGHT: 'よじ登れる高さ',
  MANTLE_TIME: 'よじ登り時間',
  STEP_HEIGHT: '自動で越える段差',
  CROUCH_HEIGHT: 'しゃがみの身長',
  FOV: '視野角',
  FOV_SPEED_KICK: '速度で広がる視野角',
  MOUSE_SENSITIVITY: 'マウス感度',
  HEAD_BOB: '視点の揺れ',
  LANDING_DIP_MAX: '着地の沈み込み',
};

export function createTuningPanel(container: HTMLElement, actions: { respawn(): void; nav(on: boolean): void; bloom(v: number): void; exposure(v: number): void }): GUI {
  const gui = new GUI({ container, title: '調整パネル（変更はすぐ反映）', width: 330 });
  const mv = movementConfig as unknown as Record<string, number>;
  for (const [title, params] of MOVEMENT_GROUPS) {
    const f = gui.addFolder(title);
    for (const [key, [min, max, step]] of Object.entries(params)) f.add(mv, key, min, max, step).name(NAMES[key] ?? key);
    if (title !== '壁走り') f.close();
  }
  const cam = gui.addFolder('カメラ・操作');
  const cv = cameraConfig as unknown as Record<string, number | boolean>;
  for (const [key, [min, max, step]] of Object.entries(CAMERA_RANGES)) cam.add(cv, key, min, max, step).name(NAMES[key] ?? key);
  cam.add(cv, 'INVERT_Y').name('上下反転');
  cam.add(cv, 'AUTO_SPRINT').name('常にダッシュ');
  cam.close();

  // 武器（主な値だけ。すべての値は config/weapons.json）
  const wf = gui.addFolder('武器');
  const WEAPON_RANGES: Record<string, Range> = {
    DAMAGE: [1, 200, 1],
    RPM: [20, 1500, 5],
    BURST_DELAY: [0, 1.5, 0.01],
    RPM_MIN: [0, 1500, 5],
    SPINUP_TIME: [0, 4, 0.05],
    MAG_SIZE: [1, 150, 1],
    RELOAD_TIME: [0.1, 6, 0.05],
    HIP_SPREAD: [0, 15, 0.05],
    ADS_SPREAD: [0, 6, 0.05],
    SPREAD_PER_SHOT: [0, 2, 0.01],
    RECOIL_PITCH: [0, 6, 0.05],
    RECOIL_YAW: [0, 3, 0.05],
    FALLOFF_START: [0, 200, 1],
    FALLOFF_END: [1, 300, 1],
    FALLOFF_MIN_MUL: [0, 1, 0.05],
    ADS_TIME: [0.05, 1, 0.01],
    ADS_FOV_MUL: [0.15, 1, 0.01],
    MOVE_SPEED_MUL: [0.5, 1.5, 0.01],
  };
  const WEAPON_NAMES: Record<string, string> = {
    DAMAGE: 'ダメージ（1粒）',
    RPM: '連射速度（発/分）',
    BURST_DELAY: '点射のあとの待ち（秒。3点射の武器）',
    RPM_MIN: '撃ち始めの連射速度（回転式）',
    SPINUP_TIME: '一番速くなるまでの時間（回転式）',
    MAG_SIZE: '装弾数',
    RELOAD_TIME: 'リロード（秒）',
    HIP_SPREAD: '腰だめのばらつき（度）',
    ADS_SPREAD: 'エイム時のばらつき（度）',
    SPREAD_PER_SHOT: '1発ごとの広がり',
    RECOIL_PITCH: '反動（縦）',
    RECOIL_YAW: '反動（横）',
    FALLOFF_START: '減衰が始まる距離',
    FALLOFF_END: '減衰が最大の距離',
    FALLOFF_MIN_MUL: '最大減衰時の倍率',
    ADS_TIME: 'エイムにかかる時間',
    ADS_FOV_MUL: 'エイム時のズーム',
    MOVE_SPEED_MUL: '移動速度の倍率',
  };
  const common = weaponsConfig.COMMON as unknown as Record<string, number | boolean>;
  wf.add(common, 'INFINITE_RESERVE').name('予備弾を無限にする');
  const gf = wf.addFolder('グレネード');
  const G: Record<string, [string, number, number, number]> = {
    GRENADE_COUNT: ['所持数', 0, 6, 1],
    GRENADE_REGEN_TIME: ['1つ回復する時間（0で回復なし）', 0, 30, 0.5],
    GRENADE_FUSE: ['爆発までの時間', 0.5, 6, 0.1],
    GRENADE_THROW_SPEED: ['投げる速さ', 5, 40, 0.5],
    GRENADE_BOUNCE: ['跳ね返り', 0, 0.9, 0.01],
    GRENADE_BLAST_RADIUS: ['爆風の半径', 1, 15, 0.1],
    GRENADE_MAX_DAMAGE: ['中心のダメージ', 0, 300, 1],
    GRENADE_MIN_DAMAGE: ['外周のダメージ', 0, 200, 1],
  };
  for (const [k, [n, min, max, st]] of Object.entries(G)) gf.add(common, k, min, max, st).name(n);
  gf.close();
  const mf = wf.addFolder('格闘');
  const M: Record<string, [string, number, number, number]> = {
    MELEE_DAMAGE: ['ダメージ', 0, 200, 1],
    MELEE_RANGE: ['届く距離', 0.5, 4, 0.05],
    MELEE_LUNGE_RANGE: ['踏み込める距離', 0, 8, 0.1],
    MELEE_LUNGE_SPEED: ['踏み込みの速さ', 0, 20, 0.5],
    MELEE_ANGLE: ['当たる角度', 5, 90, 1],
    MELEE_COOLDOWN: ['再使用までの時間', 0.1, 3, 0.05],
  };
  for (const [k, [n, min, max, st]] of Object.entries(M)) mf.add(common, k, min, max, st).name(n);
  mf.close();
  for (const id of WEAPON_IDS) {
    const f = wf.addFolder(weaponsConfig[id].NAME);
    const obj = weaponsConfig[id] as unknown as Record<string, number>;
    // カスタマイズを当てはめた数値は作り置きしているので、変えたら作り直す
    for (const [key, [min, max, step]] of Object.entries(WEAPON_RANGES)) f.add(obj, key, min, max, step).name(WEAPON_NAMES[key]).onChange(() => invalidateWeaponDefs());
    f.close();
  }
  wf.close();

  // キャラクター（アビリティとパッシブの数値）
  const cf = gui.addFolder('キャラクター');
  const cc = charactersConfig.COMMON as unknown as Record<string, number>;
  const CC: Record<string, Range> = { REGEN_DELAY: [0, 15, 0.1], REGEN_RATE: [0, 60, 1], RESPAWN_TIME: [0, 10, 0.1], SELF_GRENADE_DAMAGE_MUL: [0, 1, 0.05] };
  for (const [k, [min, max, st]] of Object.entries(CC)) cf.add(cc, k, min, max, st).name(CHAR_NAMES[k] ?? k);
  for (const id of CHARACTER_IDS) {
    const def = charactersConfig[id];
    const f = cf.addFolder(`${def.NAME}：${def.ABILITY.NAME}`);
    const addNums = (obj: Record<string, unknown>, prefix: string) => {
      for (const [k, val] of Object.entries(obj)) {
        if (typeof val !== 'number') continue;
        const max = Math.max(1, Math.ceil(val * 3));
        const step = val < 3 ? 0.05 : val < 20 ? 0.1 : 1;
        f.add(obj, k, 0, max, step).name(`${prefix}${CHAR_NAMES[k] ?? k}`);
      }
    };
    addNums(def.ABILITY as unknown as Record<string, unknown>, '');
    addNums(def.PASSIVE as unknown as Record<string, unknown>, 'パッシブ：');
    f.close();
  }
  const tf = cf.addFolder('訓練用タレット');
  const T: Record<string, [string, number, number, number]> = {
    TURRET_HEALTH: ['体力', 10, 600, 5],
    TURRET_RANGE: ['射程（m）', 5, 80, 1],
    TURRET_LOCK_TIME: ['狙いを定める時間（秒）', 0, 3, 0.05],
    TURRET_FIRE_INTERVAL: ['撃つ間隔（秒）', 0.05, 2, 0.01],
    TURRET_DAMAGE: ['1発のダメージ', 0, 50, 1],
    TURRET_SPREAD: ['ばらつき（度）', 0, 10, 0.1],
    TURRET_TURN_SPEED: ['回る速さ（度/秒）', 10, 720, 5],
    TURRET_CLOAK_DETECT_RANGE: ['迷彩を見破る距離', 0, 40, 0.5],
    TURRET_RESPAWN_TIME: ['壊れてから直るまで', 0.5, 30, 0.5],
  };
  for (const [k, [n, min, max, st]] of Object.entries(T)) tf.add(common, k, min, max, st).name(n);
  tf.close();
  cf.close();

  // 画面・確認用
  const view = { nav: false, bloom: 0.7, exposure: 1 };
  const vf = gui.addFolder('画面・確認用');
  vf.add(view, 'nav').name('ボット用の経路を表示').onChange((v: boolean) => actions.nav(v));
  vf.add(view, 'bloom', 0, 2, 0.05).name('光のにじみ（ブルーム）').onChange((v: number) => actions.bloom(v));
  vf.add(view, 'exposure', 0.5, 2, 0.05).name('明るさ').onChange((v: number) => actions.exposure(v));
  vf.close();

  const copy = async (obj: object, label: string) => {
    const text = JSON.stringify(obj, null, 2) + '\n';
    try {
      await navigator.clipboard.writeText(text);
      flash(`${label} をコピーしました`);
    } catch {
      // クリップボードが使えない環境ではダウンロードにする
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = label;
      a.click();
      flash(`${label} を保存しました`);
    }
  };
  const tools = {
    copyMovement: () => copy(movementConfig, 'movement.json'),
    copyCamera: () => copy(cameraConfig, 'camera.json'),
    copyWeapons: () => copy(weaponsConfig, 'weapons.json'),
    copyCharacters: () => copy(charactersConfig, 'characters.json'),
    reset: () => {
      Object.assign(movementConfig, DEFAULT_MOVEMENT);
      Object.assign(cameraConfig, DEFAULT_CAMERA);
      for (const id of [...WEAPON_IDS, 'COMMON'] as const) Object.assign(weaponsConfig[id], DEFAULT_WEAPONS[id]);
      invalidateWeaponDefs();
      Object.assign(charactersConfig.COMMON, DEFAULT_CHARACTERS.COMMON);
      for (const id of CHARACTER_IDS) {
        // 入れ子の値は、初期値の入れ物を共有しないように中身だけ写す
        Object.assign(charactersConfig[id].ABILITY, JSON.parse(JSON.stringify(DEFAULT_CHARACTERS[id].ABILITY)));
        Object.assign(charactersConfig[id].PASSIVE, JSON.parse(JSON.stringify(DEFAULT_CHARACTERS[id].PASSIVE)));
      }
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
      flash('初期値に戻しました');
    },
    respawn: () => actions.respawn(),
  };
  gui.add(tools, 'copyMovement').name('movement.json をコピー');
  gui.add(tools, 'copyCamera').name('camera.json をコピー');
  gui.add(tools, 'copyWeapons').name('weapons.json をコピー');
  gui.add(tools, 'copyCharacters').name('characters.json をコピー');
  gui.add(tools, 'reset').name('初期値に戻す');
  gui.add(tools, 'respawn').name('スタート地点に戻る');
  return gui;
}

function flash(text: string) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = text;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1600);
}
