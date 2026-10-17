/**
 * 射撃の的（人型の標的）。体（箱）と頭（球）の当たり判定を持つ。
 * 将来の敵やボットも、同じ「当たり判定を持つもの」として扱えるようにしておく。
 */
import { type Box, type RayHit, makeBox, rayVsBox } from './collision';
import { type Vec3, DEG, add, clone, dot, len, lerp, scale, sub, v3 } from './math';

export type TargetKind = 'dummy' | 'turret' | 'drone';

export interface TargetDef {
  /** dummy＝人型の的、turret＝プレイヤーを撃ってくる訓練用タレット */
  kind?: TargetKind;
  pos: Vec3;
  /** 正面の向き（度。0 で +Z＝スタート側を向く） */
  yaw: number;
  /** 往復する場合の、もう一方の端 */
  moveTo?: Vec3;
  /** 往復の速さ（m/秒） */
  speed?: number;
  /** 倒しても復活しない（タイムアタックのターゲット） */
  noRespawn?: boolean;
  /** 体力（省略すると種類ごとの標準） */
  health?: number;
  /** 往復の道にレールを描く（見た目だけ） */
  rail?: boolean;
}

export interface Target {
  id: number;
  def: TargetDef;
  pos: Vec3;
  yaw: number;
  health: number;
  maxHealth: number;
  alive: boolean;
  respawnTimer: number;
  /** 最後に弾が当たってからの時間 */
  sinceHit: number;
  /** 倒すまでの時間を測るため、最初に当たった時刻（シミュレーション時刻） */
  firstHitTime: number;
  /** 往復の位置（0〜2 を行き来） */
  phase: number;
  kind: TargetKind;
  /** ソナーで壁越しに見えている残り時間と、ソナーの波が届くまでの時間 */
  revealed: number;
  revealDelay: number;
  /** ワイヤーフックで引き寄せられた量（元の位置からのずれ）と、よろめきの残り時間 */
  pull: Vec3;
  stagger: number;
  /** タレット用：狙いをつけている相手と、狙いをつけてからの時間・次に撃てるまでの時間・向き */
  aimTarget: number;
  aimTime: number;
  fireCooldown: number;
  aimYaw: number;
  aimPitch: number;
  /** ドローンの上下の揺れの位相 */
  bob: number;
}

/** 体の当たり判定（足元からの高さで指定） */
export const TARGET_BODY = { centerY: 0.78, size: v3(0.62, 1.3, 0.34) };
export const TARGET_HEAD = { centerY: 1.6, radius: 0.18 };
export const TARGET_HEIGHT = 1.8;
/** タレットの当たり判定（土台の上の砲塔。頭＝センサー部） */
export const TURRET_BODY = { centerY: 0.75, size: v3(0.7, 1.5, 0.7) };
export const TURRET_HEAD = { centerY: 1.32, radius: 0.24 };
/** タレットの銃口の高さ */
export const TURRET_MUZZLE_Y = 1.25;

/** 浮いているドローンの当たり判定（位置＝機体の中心。頭＝真ん中の光る核） */
export const DRONE_BODY = { centerY: 0, size: v3(0.9, 0.32, 0.9) };
export const DRONE_HEAD = { centerY: 0, radius: 0.24 };

export const bodyOf = (t: { kind: TargetKind }) => (t.kind === 'turret' ? TURRET_BODY : t.kind === 'drone' ? DRONE_BODY : TARGET_BODY);
export const headOf = (t: { kind: TargetKind }) => (t.kind === 'turret' ? TURRET_HEAD : t.kind === 'drone' ? DRONE_HEAD : TARGET_HEAD);

export function createTarget(id: number, def: TargetDef, maxHealth: number): Target {
  return {
    id,
    def,
    pos: clone(def.pos),
    yaw: def.yaw,
    health: def.health ?? maxHealth,
    maxHealth: def.health ?? maxHealth,
    alive: true,
    respawnTimer: 0,
    sinceHit: 999,
    firstHitTime: -1,
    phase: 0,
    kind: def.kind ?? 'dummy',
    revealed: 0,
    revealDelay: 0,
    pull: v3(),
    stagger: 0,
    aimTarget: -1,
    aimTime: 0,
    fireCooldown: 0,
    aimYaw: def.yaw * DEG + Math.PI, // 視線と同じ向きの決め方（0 で -Z）。的の正面（+Z）に合わせる
    aimPitch: 0,
    bob: (id * 1.7) % (Math.PI * 2),
  };
}

/** 往復する的を動かす、倒れた的を復活させる、しばらく撃たれなければ体力を戻す */
export function updateTarget(t: Target, dt: number, regenDelay: number): boolean {
  let respawned = false;
  t.sinceHit += dt;
  if (t.revealDelay > 0) t.revealDelay = Math.max(0, t.revealDelay - dt);
  else t.revealed = Math.max(0, t.revealed - dt);
  t.stagger = Math.max(0, t.stagger - dt);
  // よろめきが終わったら、引き寄せられた分を少しずつ元に戻す
  if (t.stagger <= 0 && (t.pull.x || t.pull.z)) {
    const k = Math.exp(-dt * 2.5);
    t.pull = scale(t.pull, k);
    if (Math.hypot(t.pull.x, t.pull.z) < 0.02) t.pull = v3();
  }
  if (t.def.moveTo && t.def.speed && t.stagger <= 0) {
    const dist = len(sub(t.def.moveTo, t.def.pos));
    if (dist > 1e-3) {
      t.phase = (t.phase + (dt * t.def.speed) / dist) % 2;
      const k = t.phase < 1 ? t.phase : 2 - t.phase;
      // 端でなめらかに折り返す
      const s = k * k * (3 - 2 * k);
      t.pos = add(lerp(t.def.pos, t.def.moveTo, s), t.pull);
    }
  } else if (!t.def.moveTo) {
    t.pos = add(t.def.pos, t.pull);
  }
  // ドローンは浮いて、ゆっくり上下に揺れる
  if (t.kind === 'drone') {
    t.bob += dt * 1.8;
    if (t.alive) t.pos = add(t.pos, v3(0, Math.sin(t.bob) * 0.25, 0));
  }
  if (!t.alive && t.def.noRespawn) return false;
  if (!t.alive) {
    t.respawnTimer -= dt;
    if (t.respawnTimer <= 0) {
      t.alive = true;
      t.health = t.maxHealth;
      t.firstHitTime = -1;
      respawned = true;
    }
  } else if (t.sinceHit > regenDelay && t.health < t.maxHealth) {
    t.health = t.maxHealth;
    t.firstHitTime = -1;
  }
  return respawned;
}

export function bodyBox(t: Target): Box {
  const b = bodyOf(t);
  return makeBox(-1, add(t.pos, v3(0, b.centerY, 0)), b.size, v3(0, t.yaw, 0));
}

export function rayVsSphere(origin: Vec3, dir: Vec3, maxT: number, center: Vec3, r: number): { t: number; point: Vec3; normal: Vec3 } | null {
  const oc = sub(origin, center);
  const b = dot(oc, dir);
  const c = dot(oc, oc) - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  if (t < 0 || t > maxT) return null;
  const point = add(origin, scale(dir, t));
  return { t, point, normal: scale(sub(point, center), 1 / r) };
}

export interface TargetHit extends RayHit {
  head: boolean;
}

/** 光線と的の当たり判定。頭と体の近い方を返す */
export function rayVsTarget(origin: Vec3, dir: Vec3, maxT: number, t: Target): TargetHit | null {
  if (!t.alive) return null;
  const hd = headOf(t);
  const head = rayVsSphere(origin, dir, maxT, add(t.pos, v3(0, hd.centerY, 0)), hd.radius);
  const body = rayVsBox(origin, dir, maxT, bodyBox(t));
  if (head && (!body || head.t <= body.t)) return { ...head, boxId: -1, head: true };
  if (body) return { ...body, head: false };
  return null;
}

/** 的の正面方向 */
export const targetForward = (t: Target) => v3(Math.sin(t.yaw * DEG), 0, Math.cos(t.yaw * DEG));

/**
 * 的にダメージを与える（銃・格闘・グレネードで共通）。倒したら true と、倒すまでにかかった時間を返す。
 */
export function damageTarget(t: Target, amount: number, time: number, respawnTime: number): { killed: boolean; ttk: number } {
  if (!t.alive || amount <= 0) return { killed: false, ttk: 0 };
  if (t.firstHitTime < 0) t.firstHitTime = time;
  t.health -= amount;
  t.sinceHit = 0;
  if (t.health <= 0) {
    t.health = 0;
    t.alive = false;
    t.respawnTimer = respawnTime;
    return { killed: true, ttk: time - t.firstHitTime };
  }
  return { killed: false, ttk: 0 };
}
