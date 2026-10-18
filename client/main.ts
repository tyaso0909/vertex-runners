/**
 * 画面の流れ（仕様 2.1・2.2）。
 *   タイトル → メインメニュー ─┬→ 消耗戦 ─────→ キャラ・装備選択（ボットの難易度） → ゲーム → リザルト
 *                             ├→ タイムアタック → キャラ・装備選択 → ゲーム → リザルト
 *                             ├→ タワーディフェンス → キャラ・装備選択（難易度） → ゲーム → リザルト
 *                             ├→ ロードアウト（キャラクターと武器の組み合わせを 5 つ保存。試合の前の画面でも選べる）
 *                             ├→ 練習（ネオン都市・テスト部屋）
 *                             └→ 設定
 *   ゲーム中の Esc → 一時停止（再開・設定・メニューへ戻る）
 * タイトル・メニューの後ろでは、ネオン都市の上をカメラがゆっくり回る。
 */
import {
  attachmentsConfig,
  BOT_DIFFICULTIES,
  type BotDifficulty,
  DEFAULT_CAMERA,
  botsConfig,
  cameraConfig,
  charactersConfig,
  weaponsConfig,
} from '../config';
import { Game } from './game';
import { createTuningPanel } from './tuning';
import { QUALITY_LABELS, type QualitySetting } from './quality';
import { loadBest } from './timeAttack/records';
import { NEON_COURSE_ID, neonCourse } from '../shared/courses/neonCourse';
import { formatTime } from '../shared/timeAttack';
import { CharacterSelect } from './ui/characterSelect';
import { LEVELS, type LevelId } from '../shared/levels';
import { loadAttritionBest } from './attrition/controller';
import { loadTdBest } from './td/controller';
import { DIFF_NAMES } from './td/tdHud';
import { LoadoutStore } from './loadouts';
import { loadoutCustoms } from '../shared/loadout';
import { LoadoutScreen, LoadoutSummary, SlotList, setThumbRenderer } from './ui/loadoutScreen';
import { WeaponPreview } from './ui/weaponPreview';
import './style.css';
// タイトル・メニューの音楽（魔王魂「cyber38」。クレジットはタイトル画面の下）
import menuMusicUrl from './assets/audio/maou_bgm_cyber38.mp3?url';

type Mode = 'attrition' | 'timeattack' | 'td' | 'practice';
type Screen = 'title' | 'main' | 'prepare' | 'loadouts' | 'settings' | 'pause' | 'playing' | 'result';

const $ = (id: string) => document.getElementById(id)!;
const container = $('game');
const screens: Record<string, HTMLElement> = { title: $('title'), main: $('mainmenu'), prepare: $('prepare'), loadouts: $('loadouts'), settings: $('settings'), pause: $('pause') };
const dragHint = $('drag-hint');

// ---------------------------------------------------------------------------
// 保存してある選択（キャラクター・装備・難易度・練習のステージ・設定）
// ---------------------------------------------------------------------------
const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, v: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* 保存できない環境 */
    }
  },
};

interface Settings {
  sens: number;
  fov: number;
  volume: number;
}
const DEFAULT_SETTINGS: Settings = { sens: 1, fov: DEFAULT_CAMERA.FOV, volume: 60 };
let settings: Settings = { ...DEFAULT_SETTINGS, ...store.get<Partial<Settings>>('vr.settings', {}) };

let game: Game;
try {
  game = new Game(container, 'neon');
} catch (err) {
  $('webgl-error').classList.remove('hidden');
  throw err;
}

const applySettings = () => {
  cameraConfig.MOUSE_SENSITIVITY = DEFAULT_CAMERA.MOUSE_SENSITIVITY * settings.sens;
  cameraConfig.FOV = settings.fov;
  game.sfx.setVolume((settings.volume / 100) * 1.0);
  game.resize();
};
applySettings();

createTuningPanel($('tuning'), {
  respawn: () => game.respawn(),
  nav: (on) => game.setNavVisible(on),
  bloom: (v) => game.setBloom(v),
  exposure: (v) => game.setExposureMul(v),
});

// ---------------------------------------------------------------------------
// 画面の切り替え
// ---------------------------------------------------------------------------
let screen: Screen = 'title';
let mode: Mode = 'attrition';
let settingsReturn: Screen = 'main';
let ready = false;
let practiceStage: LevelId = store.get<LevelId>('vr.practiceStage', 'neon') === 'test' ? 'test' : 'neon';
let difficulty: BotDifficulty = (BOT_DIFFICULTIES as readonly string[]).includes(store.get('vr.botDifficulty', 'normal')) ? store.get('vr.botDifficulty', 'normal') : 'normal';

function show(s: Screen) {
  screen = s;
  for (const [k, el] of Object.entries(screens)) el.classList.toggle('hidden', k !== s);
  const menu = s === 'title' || s === 'main' || s === 'prepare' || s === 'loadouts' || (s === 'settings' && settingsReturn !== 'pause');
  game.menuOrbit = menu;
  document.body.classList.toggle('in-menu', menu);
  document.body.classList.toggle('menu-open', s !== 'playing');
  document.body.classList.toggle('show-result', s === 'result');
  // 音楽はタイトル・メニューの間だけ（試合・一時停止・結果の画面では止める）
  game.sfx.music(menu);
  game.at?.setOverlayVisible(!menu);
  game.td?.setOverlayVisible(!menu);
  if (s === 'main') refreshMain();
  if (s === 'prepare') placePrepare();
  if (s === 'loadouts') placeLoadouts();
  if (s === 'pause') placePause();
}

// --- タイトル：何かキーを押すとメインメニュー ---
const leaveTitle = () => {
  if (screen !== 'title' || !ready) return;
  game.sfx.unlock(); // 効果音はクリックなどの操作のあとでないと鳴らせない
  show('main');
};
window.addEventListener('keydown', (e) => {
  if (screen === 'title') leaveTitle();
  else if (e.code === 'Escape' && screen === 'main') show('title');
  else if (e.code === 'Escape' && screen === 'prepare') show('main');
  else if (e.code === 'Escape' && screen === 'loadouts') loScreen.back();
  else if (e.code === 'Escape' && screen === 'settings') show(settingsReturn);
});
screens.title.addEventListener('pointerdown', leaveTitle);

// --- メインメニュー ---
const refreshMain = () => {
  const best = loadBest(NEON_COURSE_ID, game.character);
  $('mm-ta-best').textContent = best
    ? `ベスト ${formatTime(best.total)}（${charactersConfig[game.character].NAME}）　屋上のコースを駆け抜け、20体のターゲットを壊す`
    : '屋上のコースを駆け抜け、20体のターゲットを壊してゴールまでのタイムを競う';
  const tb = loadTdBest();
  const tdBest = (['hard', 'normal', 'easy'] as const).find((d) => tb.waves[d] !== undefined);
  $('mm-td-best').textContent = tdBest
    ? `ベスト（${DIFF_NAMES[tdBest]}）ウェーブ ${tb.waves[tdBest]} / 10　味方のボット3体と、軍事要塞のコアを守る協力戦`
    : '味方のボット3体と、軍事要塞のコアを 10 ウェーブ守る協力戦';
  const l = loadouts.current;
  $('mm-lo-cur').textContent = `使用中：${loadouts.active + 1}「${l.name}」${charactersConfig[l.character].NAME}／${weaponsConfig[l.primary].SHORT}＋${weaponsConfig[l.secondary].SHORT}　組み合わせを 5 つまで保存`;
};
for (const b of $('mm-list').querySelectorAll<HTMLButtonElement>('.mm-item')) {
  b.addEventListener('click', () => {
    const go = b.dataset.go!;
    if (go === 'settings') {
      settingsReturn = 'main';
      show('settings');
      refreshSettings();
      return;
    }
    if (go === 'loadouts') {
      openLoadouts('main');
      return;
    }
    if (go === 'attrition' || go === 'timeattack' || go === 'td' || go === 'practice') {
      mode = go;
      show('prepare');
    }
  });
}

// ---------------------------------------------------------------------------
// ロードアウト（キャラクター＋メイン武器＋サブ武器。5 枠を保存し、使用中の枠で出撃する）
// ---------------------------------------------------------------------------
const loadouts = new LoadoutStore();
const charSelect = new CharacterSelect(charactersConfig, loadouts.current.character);
const slotList = new SlotList(loadouts, charactersConfig, weaponsConfig);
const loScreen = new LoadoutScreen(loadouts, slotList, charSelect, charactersConfig, weaponsConfig, attachmentsConfig);
const loSummary = new LoadoutSummary(loadouts, slotList, charactersConfig, weaponsConfig, attachmentsConfig);
$('loadouts').appendChild(loScreen.el);
/** ロードアウト画面を閉じたときに戻る画面 */
let loadoutReturn: Screen = 'main';
const openLoadouts = (from: Screen) => {
  loadoutReturn = from;
  show('loadouts');
};
loScreen.onBack = () => show(loadoutReturn);
loSummary.onEdit = () => openLoadouts(screen);
/** 使用中のロードアウトを、ゲームと画面に反映する */
const applyLoadout = () => {
  const l = loadouts.current;
  if (game.character !== l.character) game.setCharacter(l.character);
  if (charSelect.value !== l.character) charSelect.select(l.character, false);
  const customs = loadoutCustoms(l);
  if (game.loadout[0] !== l.primary || game.loadout[1] !== l.secondary || JSON.stringify(game.custom) !== JSON.stringify(customs)) game.setLoadout(l.primary, l.secondary, customs);
  charSelect.setWeapon(l.primary, customs[0]);
  if (game.grenade !== l.grenade) game.setGrenade(l.grenade);
  // 消耗戦の途中なら、ブーストも替える（ゲージはそのまま）
  const at = game.at;
  if (at?.match.player) at.match.boosts.setBoost(at.match.player.id, l.boost);
};
applyLoadout();
let lastLoadoutKey = JSON.stringify(loadouts.current);
loadouts.onChange = () => {
  const before = JSON.parse(lastLoadoutKey) as typeof loadouts.current;
  lastLoadoutKey = JSON.stringify(loadouts.current);
  applyLoadout();
  if (screen === 'loadouts') loScreen.refresh();
  else loSummary.refresh();
  refreshPrepareOptions();
  if (screen === 'main') refreshMain();
  const l = loadouts.current;
  if (screen === 'pause' && (before.character !== l.character || before.primary !== l.primary || before.secondary !== l.secondary)) {
    toast(`${charactersConfig[l.character].NAME}／${weaponsConfig[l.primary].NAME}＋${weaponsConfig[l.secondary].NAME}`);
  }
};
charSelect.onChange = (id) => loadouts.update({ ...loadouts.current, character: id });

function placeLoadouts() {
  loScreen.open();
}

// ---------------------------------------------------------------------------
// 試合の前の画面（モードごとの選択肢）
// ---------------------------------------------------------------------------
const MODE_INFO: Record<Mode, { kicker: string; title: string; desc: string; start: string }> = {
  attrition: {
    kicker: 'ATTRITION ― 6 VS 6',
    title: '消耗戦',
    desc: 'プレイヤー＋味方のボット5体で、敵のボット6体と戦う。敵のパイロットを倒すと 5 点、歩兵 1 点、アシスト 1 点。先に 300 点、または 10 分たって点の多いチームの勝ち。倒されると 5 秒後に、敵から離れた所で復活する（直後の 2 秒は無敵）。',
    start: '出撃',
  },
  td: {
    kicker: 'TOWER DEFENSE ― 4 PLAYERS CO-OP',
    title: 'タワーディフェンス',
    desc: 'プレイヤー＋味方のボット3体で、軍事要塞の中央のコアを 10 ウェーブの敵から守る（第5・第10ウェーブは大型兵器）。ウェーブの前の 30 秒の準備時間に、敵を倒して得たクレジットでタレットを買って置く。倒されるとダウンし、10 秒以内に味方が E 長押しで蘇生できる。',
    start: '出撃',
  },
  timeattack: {
    kicker: 'TIME ATTACK',
    title: 'タイムアタック',
    desc: '',
    start: 'スタート',
  },
  practice: {
    kicker: 'FREE RUN',
    title: '練習',
    desc: '敵のいないステージを自由に走る。ネオン都市には射撃場、テスト部屋にはアビリティの訓練場がある。一時停止画面の調整パネルで、移動や武器の数値をその場で変えられる。',
    start: '開始',
  },
};

const options = $('prep-options');
function refreshPrepareOptions() {
  if (screen !== 'prepare') return;
  options.innerHTML = '';
  if (mode === 'td') {
    const box = document.createElement('div');
    box.className = 'prep-group';
    box.innerHTML = '<div class="prep-label">難易度（敵の強さ・数）</div>';
    const row = document.createElement('div');
    row.className = 'diffsel';
    const descs: Record<BotDifficulty, string> = {
      easy: '敵が少なく、もろい。狙いもあまい',
      normal: 'ふつう。タレットの置き方と蘇生が大切',
      hard: '敵が多く、硬く、よく当ててくる',
    };
    for (const d of BOT_DIFFICULTIES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `diff ${d === difficulty ? 'selected' : ''}`;
      b.innerHTML = `<b>${DIFF_NAMES[d]}</b><small>${descs[d]}</small>`;
      b.addEventListener('click', () => {
        difficulty = d;
        store.set('vr.botDifficulty', d);
        refreshPrepareOptions();
      });
      row.appendChild(b);
    }
    box.appendChild(row);
    const best = loadTdBest();
    const info = document.createElement('p');
    info.className = 'prep-best';
    const w = best.waves[difficulty];
    const f = best.fastest[difficulty];
    info.textContent = best.matches
      ? `これまで ${best.matches} 回・防衛成功 ${best.wins} 回　ベスト（${DIFF_NAMES[difficulty]}）：${w !== undefined ? `ウェーブ ${w} / 10` : '記録なし'}${f !== undefined ? `・最速クリア ${Math.floor(f / 60)}:${String(Math.floor(f % 60)).padStart(2, '0')}` : ''}`
      : 'はじめての防衛戦';
    box.appendChild(info);
    const keys = document.createElement('p');
    keys.className = 'prep-keys';
    keys.innerHTML = '<kbd>B</kbd> 購入メニュー（準備時間中）　<kbd>1</kbd>〜<kbd>4</kbd> タレットを選ぶ　<kbd>E</kbd> 置く・蘇生（長押し）・売る（長押し）　<kbd>F</kbd> 準備完了　<kbd>Tab</kbd> 成績';
    box.appendChild(keys);
    options.appendChild(box);
  } else if (mode === 'attrition') {
    const box = document.createElement('div');
    box.className = 'prep-group';
    box.innerHTML = '<div class="prep-label">ボットの難易度</div>';
    const row = document.createElement('div');
    row.className = 'diffsel';
    const descs: Record<BotDifficulty, string> = {
      easy: '反応が遅く、狙いがよくずれる',
      normal: 'ふつう。撃ち合い・壁走り・アビリティを使いこなす',
      hard: '反応が速く、狙いが正確。頭も狙ってくる',
    };
    for (const d of BOT_DIFFICULTIES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `diff ${d === difficulty ? 'selected' : ''}`;
      b.innerHTML = `<b>${botsConfig[d].NAME}</b><small>${descs[d]}</small>`;
      b.addEventListener('click', () => {
        difficulty = d;
        store.set('vr.botDifficulty', d);
        refreshPrepareOptions();
      });
      row.appendChild(b);
    }
    box.appendChild(row);
    const best = loadAttritionBest();
    const info = document.createElement('p');
    info.className = 'prep-best';
    info.textContent = best.matches ? `これまで ${best.matches} 試合・${best.wins} 勝　ベスト：得点 ${best.score}・パイロット撃破 ${best.kills}` : 'はじめての試合';
    box.appendChild(info);
    options.appendChild(box);
  } else if (mode === 'timeattack') {
    const c = neonCourse();
    const best = loadBest(NEON_COURSE_ID, game.character);
    const box = document.createElement('div');
    box.className = 'prep-group ta-info';
    box.innerHTML = `<b>コース「${c.name}」</b>　ターゲット ${c.targets.length} 体・チェックポイント ${c.checkpoints.length - 1} か所＋ゴール。壊し損ねると 1 体 +5 秒。コースから落ちると直前のチェックポイントへ戻る（タイマーは止まらない）。<br>R 長押し：スタートからやり直し　T：直前のチェックポイントへ<br><span class="best">${best ? `ベスト ${formatTime(best.total)}（${charactersConfig[game.character].NAME}）` : `記録なし（${charactersConfig[game.character].NAME}）`}</span><br><small>${c.notes.join('<br>')}</small>`;
    options.appendChild(box);
  } else {
    const box = document.createElement('div');
    box.className = 'prep-group';
    box.innerHTML = '<div class="prep-label">ステージ</div>';
    const row = document.createElement('div');
    row.className = 'mapsel';
    for (const id of ['neon', 'test'] as const) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `mapsel-card ${id === practiceStage ? 'selected' : ''}`;
      b.innerHTML = `<b>${LEVELS[id].name}</b><small>${LEVELS[id].desc}</small>`;
      b.addEventListener('click', () => {
        practiceStage = id;
        store.set('vr.practiceStage', id);
        refreshPrepareOptions();
      });
      row.appendChild(b);
    }
    box.appendChild(row);
    options.appendChild(box);
  }
}
function placePrepare() {
  const info = MODE_INFO[mode];
  $('prep-kicker').textContent = info.kicker;
  $('prep-title').textContent = info.title;
  $('prep-desc').textContent = mode === 'timeattack' ? '西の駅の屋上から東のホテルの屋上まで。壁走り・2段ジャンプ・スライディングを使って、20体のターゲットを壊しながらゴールを目指す。ベスト記録の走りはゴーストになって一緒に走る。' : info.desc;
  $('btn-fullscreen').textContent = `全画面で${info.start}`;
  $('btn-start').textContent = `このまま${info.start}`;
  loSummary.mount($('lo-sum-prep'));
  charSelect.mount($('charsel-prep'));
  charSelect.setWeapon(loadouts.current.primary, loadoutCustoms(loadouts.current)[0]);
  refreshPrepareOptions();
}
$('prep-back').addEventListener('click', () => show('main'));

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------
const sens = $('set-sens') as HTMLInputElement;
const fov = $('set-fov') as HTMLInputElement;
const vol = $('set-vol') as HTMLInputElement;
const qualBox = document.createElement('div');
qualBox.className = 'qualsel';
const qualButtons = new Map<QualitySetting, HTMLButtonElement>();
for (const q of ['auto', 'high', 'medium', 'low'] as const) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = QUALITY_LABELS[q];
  b.addEventListener('click', () => {
    game.setQuality(q);
    refreshQuality();
  });
  qualBox.appendChild(b);
  qualButtons.set(q, b);
}
const qualNow = document.createElement('small');
qualBox.appendChild(qualNow);
$('qual-slot').appendChild(qualBox);
const refreshQuality = () => {
  for (const [q, b] of qualButtons) b.classList.toggle('selected', q === game.qualitySetting);
  qualNow.textContent = game.qualitySetting === 'auto' ? `いま：${QUALITY_LABELS[game.quality]}${game.renderScale < 1 ? `（解像度 ${Math.round(game.renderScale * 100)}%）` : ''}` : '';
};
game.onQualityChange = () => refreshQuality();
function refreshSettings() {
  sens.value = String(settings.sens);
  fov.value = String(settings.fov);
  vol.value = String(settings.volume);
  $('set-sens-v').textContent = `×${settings.sens.toFixed(2)}`;
  $('set-fov-v').textContent = `${settings.fov}°`;
  $('set-vol-v').textContent = `${settings.volume}%`;
  refreshQuality();
}
const onSetting = () => {
  settings = { sens: Number(sens.value), fov: Number(fov.value), volume: Number(vol.value) };
  store.set('vr.settings', settings);
  applySettings();
  refreshSettings();
};
for (const el of [sens, fov, vol]) el.addEventListener('input', onSetting);
vol.addEventListener('change', () => {
  game.sfx.unlock();
  game.sfx.hit(false);
});
$('set-reset').addEventListener('click', () => {
  settings = { ...DEFAULT_SETTINGS };
  store.set('vr.settings', settings);
  applySettings();
  refreshSettings();
});
$('settings-back').addEventListener('click', () => show(settingsReturn));
refreshSettings();

// ---------------------------------------------------------------------------
// 一時停止
// ---------------------------------------------------------------------------
function placePause() {
  const practice = mode === 'practice';
  $('pause-practice').classList.toggle('hidden', !practice);
  $('tuning').classList.toggle('hidden', !practice);
  $('btn-respawn').classList.toggle('hidden', mode === 'attrition' || mode === 'td');
  $('btn-respawn').textContent = mode === 'timeattack' ? 'スタートからやり直す' : 'スタート地点から再開';
  if (practice) {
    loSummary.mount($('lo-sum-pause'));
  }
}
$('btn-resume').addEventListener('click', () => begin(false));
$('btn-respawn').addEventListener('click', () => {
  if (game.ta) game.ta.restart();
  else game.respawn();
  begin(false);
});
$('btn-pause-settings').addEventListener('click', () => {
  settingsReturn = 'pause';
  show('settings');
  refreshSettings();
});
$('btn-to-menu').addEventListener('click', () => void toMainMenu());

// ---------------------------------------------------------------------------
// 開始・終了
// ---------------------------------------------------------------------------
const busy = $('busy');
async function withBusy(sub: string, fn: () => Promise<void>) {
  $('busy-sub').textContent = sub;
  busy.classList.remove('hidden');
  // 表示を出してから重い処理を始める
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
  try {
    await fn();
  } finally {
    busy.classList.add('hidden');
  }
}

async function startMode(fullscreen: boolean) {
  game.sfx.unlock();
  // 全画面とマウスの固定は、クリックの直後でないとできないので先に頼む
  const lock = game.input.requestLock(fullscreen);
  await withBusy(mode === 'attrition' || mode === 'td' ? 'ボットと経路を準備しています' : 'ステージを読み込んでいます', async () => {
    // 使用中のロードアウトを持って出撃する（オンラインでは、ここでサーバーへ送って確かめてもらう）
    const lo = loadouts.current;
    if (mode === 'attrition') await game.startAttrition({ difficulty, character: lo.character, loadout: [lo.primary, lo.secondary], custom: loadoutCustoms(lo), boost: lo.boost, grenade: lo.grenade });
    else if (mode === 'td') await game.startTd({ difficulty, character: lo.character, loadout: [lo.primary, lo.secondary], custom: loadoutCustoms(lo), grenade: lo.grenade });
    else if (mode === 'timeattack') await game.setLevel('ta');
    else await game.setLevel(practiceStage);
  });
  topbarMap();
  show('playing');
  await lock;
  if (!game.input.locked) void game.input.requestLock(false);
}

async function toMainMenu() {
  await withBusy('', async () => {
    game.stopAttrition();
    game.stopTd();
    if (game.levelId !== 'neon') await game.setLevel('neon');
  });
  topbarMap();
  if (game.input.locked) game.input.releaseLock();
  show('main');
}

game.onResult = () => {
  show('result');
  if (game.input.locked) game.input.releaseLock();
};
game.onAttritionRestart = () => {
  void (async () => {
    const lock = game.input.requestLock(false);
    await withBusy('ボットと経路を準備しています', () => game.restartMatch());
    show('playing');
    await lock;
  })();
};
game.onAttritionMenu = () => void toMainMenu();
// タイムアタックのリザルトの「メニューへ」「もう一度」
game.onOpenMenu = () => void toMainMenu();
game.onRetry = () => {
  show('playing');
  begin(false);
};

const topbarMap = () => {
  $('topbar-map').textContent = game.at ? '消耗戦' : game.td ? 'タワーディフェンス' : LEVELS[game.levelId].name;
};

const begin = (fullscreen: boolean) => {
  game.sfx.unlock();
  void game.input.requestLock(fullscreen);
};
$('btn-start').addEventListener('click', () => void startMode(false));
$('btn-fullscreen').addEventListener('click', () => void startMode(true));

game.input.onLockChange = (locked) => {
  game.paused = !locked;
  dragHint.classList.toggle('hidden', !(locked && game.input.dragLook));
  if (locked) {
    if (screen !== 'playing') show('playing');
    game.renderer.domElement.focus();
    return;
  }
  // ゲーム中にマウスの固定が外れた（Esc）→ 一時停止。リザルトを出しているときはそのまま
  if (screen === 'playing') {
    if (game.at?.resultVisible || game.ta?.resultVisible || game.td?.resultVisible) show('result');
    else show('pause');
  }
};
game.renderer.domElement.addEventListener('click', () => {
  if (screen === 'playing' && !game.input.locked) begin(false);
});

const toastEl = $('toast');
let toastTimer = 0;
function toast(text: string) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 1600);
}

// 音楽：ブラウザの決まりで、ふつうは最初のクリック・キー操作のあとでないと音を出せない。
// 操作なしで音を出してよいブラウザでは、タイトルの間から流す
game.sfx.setMusic(menuMusicUrl);
const nav = navigator as Navigator & { getAutoplayPolicy?: (type: 'audiocontext') => string };
if (nav.getAutoplayPolicy?.('audiocontext') === 'allowed') game.sfx.unlock();
const firstInput = () => {
  game.sfx.unlock();
  window.removeEventListener('pointerdown', firstInput, true);
  window.removeEventListener('keydown', firstInput, true);
};
window.addEventListener('pointerdown', firstInput, true);
window.addEventListener('keydown', firstInput, true);

// シェーダーの準備が終わるまでタイトルから進めない
const loading = $('loading');
show('title');
game.start();
void game.warmup().then((assets) => {
  charSelect.setAssets(assets);
  charSelect.setWeapon(loadouts.current.primary, loadoutCustoms(loadouts.current)[0]);
  // 武器の 3D 表示（ロードアウト画面）と、カードに出す武器・サイトの絵
  const preview = new WeaponPreview(assets.weapons, assets.weaponParts, assets.grenades);
  setThumbRenderer(preview);
  loScreen.setPreview(preview);
  loSummary.refresh();
  loading.classList.add('hidden');
  $('title-press').classList.add('ready');
  ready = true;
  document.body.dataset.ready = '1';
});

// 開発用：コンソールから状態を見られるようにする
(window as unknown as { game: Game }).game = game;
