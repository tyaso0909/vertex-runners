/**
 * 調整用パラメータの読み込み口。
 * 数値は JSON ファイル（movement.json / camera.json）を書き換えるだけで変えられる。
 * 開発サーバー（npm run dev）中は保存すると自動で反映される。
 * 各項目の意味は config/README.md を参照。
 */
import movementJson from './movement.json';
import cameraJson from './camera.json';

export type MovementConfig = typeof movementJson;
export type CameraConfig = typeof cameraJson;

/** ファイルに書かれた初期値（「初期値に戻す」用に変更しない） */
export const DEFAULT_MOVEMENT: Readonly<MovementConfig> = Object.freeze({ ...movementJson });
export const DEFAULT_CAMERA: Readonly<CameraConfig> = Object.freeze({ ...cameraJson });

/** 実行中に参照する値（調整パネルから書き換えられる） */
export const movementConfig: MovementConfig = { ...movementJson };
export const cameraConfig: CameraConfig = { ...cameraJson };

// ---------------------------------------------------------------------------
// 武器
// ---------------------------------------------------------------------------
import weaponsJson from './weapons.json';

/** 武器（同じ武器種の武器は並べて置く。ロードアウト画面もこの順に出す） */
export const WEAPON_IDS = ['ar', 'burst', 'smg', 'psmg', 'lmg', 'spinlmg', 'shotgun', 'autosg', 'sniper', 'marksman', 'pistol', 'revolver'] as const;
export type WeaponId = (typeof WEAPON_IDS)[number];
export type WeaponDef = (typeof weaponsJson)['ar'];
export type WeaponCommon = (typeof weaponsJson)['COMMON'];
export type WeaponsConfig = { COMMON: WeaponCommon } & Record<WeaponId, WeaponDef>;

/** 武器種（weapons.json の CLASS）。持ち方・音・ボットの使い方の元になる、最初からあった 6 つの武器と同じ名前 */
export const WEAPON_CLASSES = ['ar', 'smg', 'lmg', 'shotgun', 'sniper', 'pistol'] as const;
export type WeaponClass = (typeof WEAPON_CLASSES)[number];
export const WEAPON_CLASS_LABEL: Record<WeaponClass, { name: string; en: string }> = {
  ar: { name: 'アサルトライフル', en: 'ASSAULT RIFLE' },
  smg: { name: 'サブマシンガン', en: 'SMG' },
  lmg: { name: 'ライトマシンガン', en: 'LMG' },
  shotgun: { name: 'ショットガン', en: 'SHOTGUN' },
  sniper: { name: 'スナイパーライフル', en: 'SNIPER' },
  pistol: { name: 'ハンドガン', en: 'PISTOL' },
};
/** 武器の武器種 */
export const classOf = (id: WeaponId, cfg: { [K in WeaponId]: { CLASS: string } } = weaponsJson as unknown as WeaponsConfig): WeaponClass => cfg[id].CLASS as WeaponClass;

const cloneWeapons = (): WeaponsConfig => JSON.parse(JSON.stringify(weaponsJson)) as WeaponsConfig;
export const DEFAULT_WEAPONS: Readonly<WeaponsConfig> = Object.freeze(cloneWeapons());
export const weaponsConfig: WeaponsConfig = cloneWeapons();

// ---------------------------------------------------------------------------
// 武器のカスタマイズ（サイト・アタッチメント）。どの武器に何が付けられるかは weapons.json の SIGHTS・ATTACHMENTS
// ---------------------------------------------------------------------------
import attachmentsJson from './attachments.json';

export const SIGHT_IDS = ['iron', 'reddot', 'holo', 'x2', 'x3', 'threat', 'sniper', 'variable'] as const;
export type SightId = (typeof SIGHT_IDS)[number];
export const ATTACHMENT_IDS = ['extmag', 'fastreload', 'suppressor', 'compensator', 'stock', 'laser', 'gunrunner', 'longbarrel'] as const;
export type AttachmentId = (typeof ATTACHMENT_IDS)[number];
/** iron：照門と照星、dot・holo：等倍に近い光学サイト、optic：倍率のあるスコープ（銃は見えたまま）、scope：画面いっぱいにのぞくスコープ */
export type SightKind = 'iron' | 'dot' | 'holo' | 'optic' | 'scope';
export interface SightDef {
  NAME: string;
  SHORT: string;
  DESC: string;
  KIND: SightKind;
  /** エイム時の視野角の倍率。0 なら武器のもとの値（ADS_FOV_MUL） */
  FOV_MUL: number;
  ADS_TIME_MUL: number;
  ADS_SPREAD_MUL: number;
  /** 照準の形（画面に重ねて描く） */
  RETICLE: string;
  /** 倍率を切り替えられるスコープの、視野角の倍率の段階 */
  ZOOMS: number[];
  /** 視界の中の敵を浮かび上がらせる */
  THREAT: boolean;
}
export interface AttachmentDef {
  NAME: string;
  SHORT: string;
  DESC: string;
  /** 同じグループ（例：銃口に付ける物）は 1 つまで。空なら制限なし */
  GROUP: string;
  /** 効き目：<項目>_MUL は掛け算、<項目>_ADD は足し算、そのほかは値をそのまま入れる */
  MODS: Record<string, number | boolean>;
}
export interface AttachmentsConfig {
  SIGHTS: Record<SightId, SightDef>;
  ATTACHMENTS: Record<AttachmentId, AttachmentDef>;
}
const cloneAttachments = (): AttachmentsConfig => JSON.parse(JSON.stringify(attachmentsJson)) as AttachmentsConfig;
export const attachmentsConfig: AttachmentsConfig = cloneAttachments();

// ---------------------------------------------------------------------------
// キャラクター
// ---------------------------------------------------------------------------
import charactersJson from './characters.json';

export const CHARACTER_IDS = ['meia', 'pearl', 'miranda', 'sora', 'alex', 'ranmaru'] as const;
export type CharacterId = (typeof CHARACTER_IDS)[number];
export type AbilityType = 'grapple' | 'cloak' | 'shield' | 'sonar' | 'overdrive' | 'phase';

/** アビリティの共通項目（種類ごとの数値は同じ場所に入っている） */
export interface AbilityDef {
  TYPE: AbilityType;
  NAME: string;
  DESC: string;
  COOLDOWN: number;
  [key: string]: number | string | boolean;
}
export interface PassiveDef {
  NAME: string;
  DESC: string;
  [key: string]: number | string | boolean;
}
export interface CharacterDef {
  NAME: string;
  ROLE: string;
  COLOR: string;
  ORDER: number;
  ABILITY: AbilityDef;
  PASSIVE: PassiveDef;
  /** ボットがアビリティを使う条件（フェーズ6でボットの AI に使う） */
  BOT: string;
}
export type CharacterCommon = (typeof charactersJson)['COMMON'];
export type CharactersConfig = { COMMON: CharacterCommon } & Record<CharacterId, CharacterDef>;

const cloneCharacters = (): CharactersConfig => JSON.parse(JSON.stringify(charactersJson)) as CharactersConfig;
export const DEFAULT_CHARACTERS: Readonly<CharactersConfig> = Object.freeze(cloneCharacters());
export const charactersConfig: CharactersConfig = cloneCharacters();

/** アビリティの数値を取り出す（ない項目は def の値） */
export const abilityNum = (a: AbilityDef, key: string, def = 0): number => (typeof a[key] === 'number' ? (a[key] as number) : def);
export const passiveNum = (p: PassiveDef, key: string, def = 1): number => (typeof p[key] === 'number' ? (p[key] as number) : def);

// ---------------------------------------------------------------------------
// タイムアタック
// ---------------------------------------------------------------------------
import timeAttackJson from './timeattack.json';

export type TimeAttackConfig = typeof timeAttackJson;
export const DEFAULT_TIME_ATTACK: Readonly<TimeAttackConfig> = Object.freeze({ ...timeAttackJson });
export const timeAttackConfig: TimeAttackConfig = { ...timeAttackJson };

// ---------------------------------------------------------------------------
// 消耗戦・ボット
// ---------------------------------------------------------------------------
import attritionJson from './attrition.json';
import boostsJson from './boosts.json';
import botsJson from './bots.json';

export type AttritionConfig = typeof attritionJson;
export const DEFAULT_ATTRITION: Readonly<AttritionConfig> = Object.freeze({ ...attritionJson });
export const attritionConfig: AttritionConfig = { ...attritionJson };

// ---------------------------------------------------------------------------
// ブースト（消耗戦。タイタンフォール2のブーストにならう）
// ---------------------------------------------------------------------------
export type BoostId = 'maphack' | 'holopilot' | 'phaserewind' | 'hardcover' | 'ticks' | 'diceroll';
export const BOOST_IDS: readonly BoostId[] = ['maphack', 'holopilot', 'phaserewind', 'hardcover', 'ticks', 'diceroll'];
export interface BoostDef {
  NAME: string;
  SHORT: string;
  DESC: string;
  /** ゲージが満タンになるまでの得点（パイロット撃破 5・歩兵 1・アシスト 1） */
  COST: number;
  [key: string]: number | string;
}
export interface BoostsConfig {
  /** 倒されずに続けてパイロットを倒すと、2人目から 1人ごとにゲージのたまり方がこれだけ増える */
  STREAK_BONUS: number;
  STREAK_BONUS_MAX: number;
  BOOSTS: Record<BoostId, BoostDef>;
}
export const boostsConfig: BoostsConfig = JSON.parse(JSON.stringify(boostsJson)) as BoostsConfig;
export const boostNum = (d: BoostDef, key: string, def = 0): number => (typeof d[key] === 'number' ? (d[key] as number) : def);

// ---------------------------------------------------------------------------
// グレネードの種類（ロードアウトで 1 つ選ぶ。タイタンフォール2の「オードナンス」にならう）
// フラグの数値は weapons.json の COMMON.GRENADE_*。ほかの種類は、書いていない値をフラグと同じにする
// ---------------------------------------------------------------------------
import grenadesJson from './grenades.json';

export type GrenadeId = 'frag' | 'arc' | 'firestar' | 'gravity' | 'smoke' | 'satchel';
export const GRENADE_IDS: readonly GrenadeId[] = ['frag', 'arc', 'firestar', 'gravity', 'smoke', 'satchel'];
export const isGrenadeId = (x: unknown): x is GrenadeId => typeof x === 'string' && (GRENADE_IDS as readonly string[]).includes(x);
export interface GrenadeDef {
  NAME: string;
  SHORT: string;
  DESC: string;
  /** 当たった所に刺さる・張り付く */
  STICK: boolean;
  [key: string]: number | string | boolean;
}
export type GrenadesConfig = Record<GrenadeId, GrenadeDef>;
export const grenadesConfig: GrenadesConfig = JSON.parse(JSON.stringify(grenadesJson)) as GrenadesConfig;
export const grenadeNum = (d: GrenadeDef, key: string, def = 0): number => (typeof d[key] === 'number' ? (d[key] as number) : def);

export const BOT_DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
export type BotDifficulty = (typeof BOT_DIFFICULTIES)[number];
export type BotSkill = (typeof botsJson)['normal'];
export type GruntSkill = (typeof botsJson)['GRUNT'];
export type BotsConfig = Record<BotDifficulty, BotSkill> & { GRUNT: GruntSkill };
const cloneBots = (): BotsConfig => JSON.parse(JSON.stringify(botsJson)) as BotsConfig;
export const DEFAULT_BOTS: Readonly<BotsConfig> = Object.freeze(cloneBots());
export const botsConfig: BotsConfig = cloneBots();

// ---------------------------------------------------------------------------
// タワーディフェンス
// ---------------------------------------------------------------------------
import tdJson from './td.json';

export type TdEnemyType = 'grunt' | 'assault' | 'heavy' | 'mortar' | 'drone' | 'boss';
export const TD_ENEMY_TYPES: readonly TdEnemyType[] = ['grunt', 'assault', 'heavy', 'mortar', 'drone', 'boss'];
export type TurretType = 'mg' | 'rocket' | 'slow' | 'repair';
export const TURRET_TYPES: readonly TurretType[] = ['mg', 'rocket', 'slow', 'repair'];
export type TdRoute = 'front' | 'left' | 'right';
/** 購入メニューのアイテム（タレット以外）。armor は買うとすぐ効く。ほかは置く物 */
export type TdItemType = 'decoy' | 'wiretrap' | 'barricade' | 'jumppad' | 'armor';
export const TD_ITEM_TYPES: readonly TdItemType[] = ['decoy', 'wiretrap', 'barricade', 'jumppad', 'armor'];
/** 置く物（設置物） */
export type TdDeviceType = Exclude<TdItemType, 'armor'>;
export const TD_DEVICE_TYPES: readonly TdDeviceType[] = ['decoy', 'wiretrap', 'barricade', 'jumppad'];
/** 置いて使う物（タレットと設置物） */
export type TdPlaceable = TurretType | TdDeviceType;
export const isTurretType = (k: string): k is TurretType => (TURRET_TYPES as readonly string[]).includes(k);

export interface TdGroupDef {
  type: TdEnemyType;
  count: number;
  route: TdRoute;
  /** ウェーブが始まってから湧き始めるまで（秒） */
  delay: number;
  /** 1回に湧く数 */
  squad: number;
  /** 湧く間隔（秒） */
  interval: number;
  /**
   * 降下ポッドの降りる場所（地上の敵だけ）。降下地点の id（'wall_w' など）か、種類（'outer' | 'wall' | 'inner'）。
   * 種類のときは、そのルートの方面の同じ種類の降下地点から、準備時間の始めに1つ選ぶ。なければルートの遠くの草原（join のある外の降下地点）
   */
  drop?: string;
}
export interface TdWaveDef {
  boss?: boolean;
  groups: TdGroupDef[];
}
/** 敵の数値（種類ごとに使う項目が違う） */
export interface TdEnemyDef {
  NAME: string;
  HEALTH: number;
  REWARD: number;
  [key: string]: number | string;
}
export interface TurretDef {
  NAME: string;
  COST: number;
  HEALTH: number;
  [key: string]: number | string | boolean;
}
/** 購入メニューのアイテムの数値（種類ごとに使う項目が違う） */
export interface TdItemDef {
  NAME: string;
  SHORT: string;
  DESC: string;
  COST: number;
  /** 1人が同時に持てる数（アーマーは 1 ラウンドに買える回数） */
  LIMIT: number;
  [key: string]: number | string | boolean;
}
/** タレットの強化（レベル 1〜3。配列はレベルの順） */
export interface TdUpgradeDef {
  MAX_LEVEL: number;
  /** レベル 2・3 へ上げる値段（タレットの値段に掛ける） */
  COST_MUL: number[];
  DAMAGE_MUL: number[];
  HEALTH_MUL: number[];
  RANGE_MUL: number[];
  INTERVAL_MUL: number[];
  BLAST_MUL: number[];
  RADIUS_MUL: number[];
  SLOW: number[];
  REPAIR_MUL: number[];
}
export type TdAimSkill = (typeof tdJson)['ENEMY_AIM']['normal'];
export interface TdConfig extends Omit<typeof tdJson, 'WAVES' | 'ENEMIES' | 'TURRETS' | 'ITEMS' | 'UPGRADE'> {
  WAVES: TdWaveDef[];
  ENEMIES: Record<TdEnemyType, TdEnemyDef>;
  TURRETS: Record<TurretType, TurretDef>;
  ITEMS: Record<TdItemType, TdItemDef>;
  UPGRADE: TdUpgradeDef;
}
const cloneTd = (): TdConfig => JSON.parse(JSON.stringify(tdJson)) as TdConfig;
export const DEFAULT_TD: Readonly<TdConfig> = Object.freeze(cloneTd());
export const tdConfig: TdConfig = cloneTd();
/** 敵・タレットの数値を取り出す（ない項目は def の値） */
export const tdNum = (d: TdEnemyDef | TurretDef | TdItemDef, key: string, def = 0): number => (typeof d[key] === 'number' ? (d[key] as number) : def);
